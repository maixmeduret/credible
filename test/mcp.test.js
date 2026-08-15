/**
 * The MCP server, driven the way a real client drives it: a child process,
 * newline-delimited JSON-RPC over stdin/stdout.
 *
 * Two things are under test here. The protocol itself — handshake, notification
 * semantics, tool discovery, error codes — and the tools, against a real
 * Credible booted on a free port in this process. Nothing is mocked: the
 * provisioning test creates a genuine account in a throwaway database and then
 * uses the API key it was handed to prove the account works.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { closeDatabase, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server.js';

const SERVER_PATH = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

const EMAIL = 'agent@example.com';
const DOMAIN = 'example.com';

/** Every tool the server is expected to expose. */
const EXPECTED_TOOLS = [
  'credible_provision',
  'credible_list_sites',
  'credible_add_site',
  'credible_get_snippet',
  'credible_verify_install',
  'credible_get_stats',
  'credible_breakdown',
  'credible_realtime',
  'credible_create_goal',
  'credible_create_funnel',
  'credible_share_dashboard',
  'credible_track_event',
];

// ------------------------------------------------------------- MCP client --

/**
 * A minimal MCP client over a spawned server process.
 *
 * Responses are matched by JSON-RPC id, and anything nobody asked for stays in
 * `inbox` — which is what makes "a notification produces no response" testable.
 */
function startClient(env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const inbox = [];
  const waiters = [];
  let stderr = '';
  let counter = 0;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const deliver = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      const index = inbox.findIndex(waiter.match);
      if (index === -1) continue;
      const [message] = inbox.splice(index, 1);
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  };

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    inbox.push(JSON.parse(line)); // a non-JSON line on stdout is a protocol bug: let it throw
    deliver();
  });

  const waitFor = (match, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for a message. inbox=${JSON.stringify(inbox)} stderr=${stderr}`));
        }, ms),
      };
      waiters.push(waiter);
      deliver();
    });

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  return {
    child,
    inbox,
    get stderr() {
      return stderr;
    },
    request(method, params = {}) {
      const id = (counter += 1);
      write({ jsonrpc: '2.0', id, method, params });
      return waitFor((message) => message.id === id);
    },
    notify(method, params = {}) {
      write({ jsonrpc: '2.0', method, params });
    },
    /** Push a raw string down stdin — used for the malformed-JSON case. */
    raw(text) {
      child.stdin.write(text);
    },
    waitFor,
    async call(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      assert.ok(response.result, `tools/call ${name} returned an error: ${JSON.stringify(response.error)}`);
      return { text: response.result.content?.[0]?.text ?? '', isError: response.result.isError === true };
    },
    stop() {
      lines.close();
      child.kill();
    },
  };
}

/** A port nothing is listening on: bound to find a free one, then released. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// ------------------------------------------------------------------ setup --

let credible; // a real Credible instance
let origin;
let client;

before(async () => {
  await withDatabase('mcp');
  credible = createServer();
  await new Promise((resolve) => credible.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${credible.address().port}`;
  client = startClient({ CREDIBLE_URL: origin, CREDIBLE_API_KEY: '' });
});

after(async () => {
  client?.stop();
  credible.closeAllConnections?.();
  await new Promise((resolve) => credible.close(resolve));
  await closeDatabase();
});

// -------------------------------------------------------------- protocol --

describe('MCP protocol', () => {
  it('answers initialize with the server identity and its capabilities', async () => {
    const response = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.error, undefined);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.serverInfo, { name: 'credible', version: '0.1.0' });
    assert.deepEqual(response.result.capabilities, { tools: {} });
    assert.equal(typeof response.result.instructions, 'string');
  });

  it('echoes back an older protocol revision it also speaks', async () => {
    const response = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(response.result.protocolVersion, '2024-11-05');
  });

  it('falls back to its own revision when the client asks for one it does not know', async () => {
    const response = await client.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(response.result.protocolVersion, '2025-06-18');
  });

  it('never answers a notification', async () => {
    client.notify('notifications/initialized');

    // A request sent straight after: its response proves the server kept
    // reading, and an empty inbox proves the notification drew no reply.
    const pong = await client.request('ping');
    assert.deepEqual(pong.result, {});
    assert.deepEqual(client.inbox, [], 'the notification must not produce a response');
  });

  it('rejects an unknown method with -32601', async () => {
    const response = await client.request('resources/list');
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /method not found/i);
  });

  it('rejects malformed JSON with -32700 and keeps running', async () => {
    client.raw('{ not json at all\n');
    const parseError = await client.waitFor((message) => message.error?.code === -32700);
    assert.equal(parseError.jsonrpc, '2.0');
    assert.equal(parseError.id, null);

    const pong = await client.request('ping');
    assert.deepEqual(pong.result, {});
  });

  it('rejects an unknown tool with -32602', async () => {
    const response = await client.request('tools/call', { name: 'credible_nope', arguments: {} });
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /unknown tool/i);
  });
});

// ----------------------------------------------------------------- tools --

describe('tools/list', () => {
  it('advertises every tool with a usable JSON Schema', async () => {
    const { result } = await client.request('tools/list');
    const tools = result.tools;

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...EXPECTED_TOOLS].sort(),
      'the advertised tools must match the documented set',
    );

    for (const tool of tools) {
      const where = `tool ${tool.name}`;
      assert.equal(typeof tool.description, 'string', `${where} needs a description`);
      assert.ok(tool.description.length > 60, `${where} needs a description written for a model to read`);

      const schema = tool.inputSchema;
      assert.equal(schema.type, 'object', `${where} schema must be an object schema`);
      assert.equal(typeof schema.properties, 'object', `${where} schema needs properties`);
      assert.ok(Array.isArray(schema.required), `${where} schema needs a required array`);

      for (const [name, property] of Object.entries(schema.properties)) {
        assert.equal(typeof property.type, 'string', `${where}.${name} needs a type`);
        assert.ok(property.description?.length > 10, `${where}.${name} needs a real description`);
      }
      for (const name of schema.required) {
        assert.ok(name in schema.properties, `${where} requires "${name}" but never declares it`);
      }

      // Overriding the target instance and the credential must always be possible.
      assert.ok('instance_url' in schema.properties, `${where} must accept instance_url`);
      assert.ok('api_key' in schema.properties, `${where} must accept api_key`);
    }
  });

  it('describes credible_provision as the first call on a fresh instance', async () => {
    const { result } = await client.request('tools/list');
    const provision = result.tools.find((tool) => tool.name === 'credible_provision');
    assert.match(provision.description, /first call/i);
    assert.deepEqual(provision.inputSchema.required, ['email']);
  });
});

describe('tools/call against a real instance', () => {
  let apiKey = '';

  it('provisions an account, a site and a snippet from nothing', async () => {
    const { text, isError } = await client.call('credible_provision', {
      email: EMAIL,
      domain: DOMAIN,
      timezone: 'Europe/Paris',
      currency: 'EUR',
    });

    assert.equal(isError, false, text);
    assert.match(text, /cred_[A-Za-z0-9_-]+/, 'the API key must be returned, it is shown only once');
    assert.match(
      text,
      new RegExp(`<script defer data-domain="${DOMAIN}" src="${origin}/js/cr\\.js"></script>`),
      'the install snippet must be returned verbatim',
    );
    assert.match(text, /<head>/, 'the reply must say where the snippet goes');
    assert.match(text, new RegExp(`${origin}/${DOMAIN}`), 'the dashboard URL must be returned');

    [, apiKey] = text.match(/(cred_[A-Za-z0-9_-]+)/);

    // The account is real: its key opens the management API.
    const response = await fetch(`${origin}/api/sites`, { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.sites.map((site) => site.domain),
      [DOMAIN],
    );
  });

  it('remembers the API key for the rest of the session', async () => {
    // No api_key argument, and the environment has none: only the key learned
    // during provisioning can make this work.
    const { text, isError } = await client.call('credible_list_sites');
    assert.equal(isError, false, text);
    assert.match(text, new RegExp(DOMAIN));
  });

  it('reports a site with no data as not yet installed', async () => {
    const { text, isError } = await client.call('credible_verify_install', { domain: DOMAIN });
    assert.equal(isError, false, text);
    assert.match(text, /NOT YET/);
    assert.match(text, /data-domain/, 'a failed verification must include the checklist');
  });

  it('records a server-side event and then sees it', async () => {
    const tracked = await client.call('credible_track_event', {
      domain: DOMAIN,
      name: 'pageview',
      url: `https://${DOMAIN}/pricing`,
    });
    assert.equal(tracked.isError, false, tracked.text);

    const verified = await client.call('credible_verify_install', { domain: DOMAIN });
    assert.equal(verified.isError, false, verified.text);
    assert.match(verified.text, /^YES/m);
    assert.match(verified.text, /First event/);

    const stats = await client.call('credible_get_stats', { domain: DOMAIN, period: 'day' });
    assert.equal(stats.isError, false, stats.text);
    assert.match(stats.text, /Visitors\s+1/);

    const breakdown = await client.call('credible_breakdown', { domain: DOMAIN, dimension: 'event:page' });
    assert.equal(breakdown.isError, false, breakdown.text);
    assert.match(breakdown.text, /\/pricing/);
  });

  it('normalizes a domain typed as a URL', async () => {
    const { text, isError } = await client.call('credible_get_snippet', { domain: `https://www.${DOMAIN}/pricing` });
    assert.equal(isError, false, text);
    assert.match(text, new RegExp(`data-domain="${DOMAIN}"`));
  });

  it('creates goals and wires them into a funnel', async () => {
    const signup = await client.call('credible_create_goal', {
      domain: DOMAIN,
      type: 'event',
      event_name: 'Signup',
    });
    assert.equal(signup.isError, false, signup.text);
    const [, firstId] = signup.text.match(/Goal #(\d+)/);

    const thanks = await client.call('credible_create_goal', {
      domain: DOMAIN,
      type: 'page',
      page_path: '/thank-you',
    });
    assert.equal(thanks.isError, false, thanks.text);
    const [, secondId] = thanks.text.match(/Goal #(\d+)/);

    const funnel = await client.call('credible_create_funnel', {
      domain: DOMAIN,
      name: 'Signup flow',
      goals: [Number(firstId), Number(secondId)],
    });
    assert.equal(funnel.isError, false, funnel.text);
    assert.match(funnel.text, /Signup flow/);
  });

  it('shares a dashboard as a public URL', async () => {
    const { text, isError } = await client.call('credible_share_dashboard', { domain: DOMAIN, name: 'Client' });
    assert.equal(isError, false, text);
    assert.match(text, new RegExp(`${origin}/share/${DOMAIN}\\?auth=`));
  });
});

// ---------------------------------------------------------------- failure --

describe('failure reporting', () => {
  it('reports an unreachable instance as a tool error, not a protocol error', async () => {
    const port = await closedPort();
    const { text, isError } = await client.call('credible_list_sites', {
      instance_url: `http://127.0.0.1:${port}`,
      api_key: 'cred_whatever',
    });

    assert.equal(isError, true, 'a failing tool reports isError so the model can read why');
    assert.match(text, /no Credible instance is running at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(text, /node bin\/credible\.js serve/, 'it must say how to start one');
    assert.doesNotMatch(text, /at .*\n\s+at /, 'a stack trace must never reach the model');
  });

  it('reports a missing API key as a tool error naming the fix', async () => {
    const { text, isError } = await client.call('credible_get_stats', {
      domain: DOMAIN,
      instance_url: origin,
      api_key: 'cred_not_a_real_key',
    });
    assert.equal(isError, true);
    assert.match(text, /401/);
    assert.match(text, /credible_provision|CREDIBLE_API_KEY/);
  });

  it('reports an unknown site with the status and the URL that failed', async () => {
    const { text, isError } = await client.call('credible_realtime', { domain: 'not-tracked.example.org' });
    assert.equal(isError, true);
    assert.match(text, /404/);
    assert.match(text, new RegExp(`${origin}/api/stats/not-tracked\\.example\\.org/realtime`));
  });

  it('rejects invalid arguments before making a request', async () => {
    const period = await client.call('credible_get_stats', { domain: DOMAIN, period: 'weekly' });
    assert.equal(period.isError, true);
    assert.match(period.text, /unknown period "weekly"/);

    const goal = await client.call('credible_create_goal', { domain: DOMAIN, type: 'event' });
    assert.equal(goal.isError, true);
    assert.match(goal.text, /event_name/);

    const missing = await client.call('credible_get_snippet', {});
    assert.equal(missing.isError, true);
    assert.match(missing.text, /`domain` is required/);
  });
});
