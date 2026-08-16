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
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server.js';
import { findSiteByDomain } from '../src/sites.js';

const SERVER_PATH = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

const EMAIL = 'agent@example.com';
const DOMAIN = 'example.com';

/** Every tool the server is expected to expose. */
const EXPECTED_TOOLS = [
  'credible_help',
  'credible_provision',
  'credible_list_sites',
  'credible_add_site',
  'credible_get_snippet',
  'credible_verify_install',
  'credible_configure_site',
  'credible_import_status',
  'credible_get_stats',
  'credible_compare_periods',
  'credible_breakdown',
  'credible_realtime',
  'credible_journey',
  'credible_consolidated',
  'credible_list_segments',
  'credible_create_segment',
  'credible_apply_segment',
  'credible_list_annotations',
  'credible_add_annotation',
  'credible_create_goal',
  'credible_create_funnel',
  'credible_share_dashboard',
  'credible_track_event',
];

/**
 * Endpoints this wave of the product needs but the instance does not serve yet.
 * Each tool must say so in words rather than crash, and this list is what the
 * integrator has to wire up — when one of these starts answering, its assertion
 * here fails loudly instead of quietly passing on the wrong reason.
 */
const TOOLS_AWAITING_AN_ENDPOINT = [
  ['credible_journey', 'journey', { domain: DOMAIN }],
  ['credible_consolidated', 'consolidated', {}],
  ['credible_import_status', 'imports', { domain: DOMAIN }],
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
      // The description is the only documentation a model ever gets, and it has
      // to say when to reach for the tool and not just what it does. That does
      // not fit in a sentence, so the floor is set where a sentence ends.
      assert.ok(tool.description.length > 150, `${where} needs a description that says when to use it, not only what it does`);

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

  it('never lets the shared argument fragments overwrite a deliberate description', async () => {
    // RANGE_PROPS carries an optional `segment`. Spreading it after a tool's own
    // properties would silently replace "Required" with "Optional" — cheap to
    // get wrong, invisible at runtime, and only a model would ever suffer for it.
    const { result } = await client.request('tools/list');
    const apply = result.tools.find((tool) => tool.name === 'credible_apply_segment');
    assert.deepEqual(apply.inputSchema.required, ['domain', 'segment']);
    assert.match(apply.inputSchema.properties.segment.description, /Required/);

    // And nothing may advertise an argument it goes on to ignore: a segment
    // belongs to one site, so the all-sites rollup must not offer one.
    const consolidated = result.tools.find((tool) => tool.name === 'credible_consolidated');
    assert.ok(!('segment' in consolidated.inputSchema.properties), 'a rollup across every site cannot take a per-site segment');
    assert.ok(!('domain' in consolidated.inputSchema.properties), 'and it is not a question about one site');
  });

  it('teaches the filter syntax the instance actually accepts', async () => {
    // Plausible's string syntax is the one people reach for and the one Credible
    // rejects. A description that recommended it would produce a 422 every time.
    const { result } = await client.request('tools/list');
    for (const name of ['credible_get_stats', 'credible_breakdown']) {
      const { description } = result.tools.find((tool) => tool.name === name).inputSchema.properties.filters;
      assert.match(description, /\[\["is","visit:country"/, `${name} must show the JSON wire format`);
      assert.match(description, /has_done/, `${name} must mention the newer filter forms it forwards`);
      assert.match(description, /NOT accepted/, `${name} must warn off the Plausible string syntax`);
      assert.doesNotMatch(description, /e\.g\. "visit:country==FR"/, `${name} must not recommend a syntax that 422s`);
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

    // One visitor is "1 visitor", never "1 visitors".
    const sites = await client.call('credible_list_sites');
    assert.equal(sites.isError, false, sites.text);
    assert.match(sites.text, /1 visitor right now/);
  });

  it('names the reported range in the site timezone, not in UTC', async () => {
    // The API returns a period as the unix seconds of local midnight. Rendering
    // those in UTC names the day before for any site east of Greenwich — this
    // site is Europe/Paris, where "today" starts at 22:00 UTC yesterday.
    const { text, isError } = await client.call('credible_get_stats', { domain: DOMAIN, period: 'day' });
    assert.equal(isError, false, text);

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    assert.ok(
      text.startsWith(`${DOMAIN} — day (${today} to ${today}, Europe/Paris)`),
      `the header must name one Paris day, got: ${text.split('\n')[0]}`,
    );
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
    assert.match(signup.text, /Event name\s+Signup\n\nThe site must send/, 'the detail block and the advice must stay apart');

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

// ------------------------------------------------------------ orientation --

describe('credible_help', () => {
  it('maps the whole server in one call', async () => {
    const { text, isError } = await client.call('credible_help');
    assert.equal(isError, false, text);

    for (const name of EXPECTED_TOOLS) {
      if (name === 'credible_help') continue;
      assert.ok(text.includes(name), `credible_help must mention ${name} — it is the only map the model gets`);
    }
    assert.match(text, new RegExp(origin), 'it must name the instance it is pointed at');
    assert.match(text, /filters/, 'and how to narrow a query, which is not a tool of its own');
  });

  it('answers even when no instance is reachable', async () => {
    // Orientation must never depend on the thing it is orienting you around.
    const port = await closedPort();
    const { text, isError } = await client.call('credible_help', { instance_url: `http://127.0.0.1:${port}` });
    assert.equal(isError, false, text);
    assert.match(text, /credible_provision/);
  });
});

// ---------------------------------------------------------------- filters --

describe('filters', () => {
  it('accepts the JSON wire format and narrows every number', async () => {
    const matching = await client.call('credible_get_stats', {
      domain: DOMAIN,
      period: 'day',
      filters: '[["contains","event:page",["/pricing"]]]',
    });
    assert.equal(matching.isError, false, matching.text);
    assert.match(matching.text, /Visitors\s+1/);
    assert.match(matching.text, /Filtered by:/, 'a filtered answer must say it was filtered');

    const missing = await client.call('credible_get_stats', {
      domain: DOMAIN,
      period: 'day',
      filters: '[["is","event:page",["/nothing-here"]]]',
    });
    assert.equal(missing.isError, false, missing.text);
    assert.match(missing.text, /Visitors\s+0/);
  });

  it('accepts the same filter written as an array', async () => {
    const { text, isError } = await client.call('credible_breakdown', {
      domain: DOMAIN,
      dimension: 'event:page',
      period: 'day',
      filters: [['contains', 'event:page', ['/pricing']]],
    });
    assert.equal(isError, false, text);
    assert.match(text, /\/pricing/);
  });

  it('forwards a behavioural filter whether or not this server understands it', async () => {
    // has_done and the and/or/not branches are the instance's to implement, not
    // this server's to validate. Either it honours the filter or it refuses it
    // by name — what must never happen is the filter being dropped on the way
    // out and an unfiltered answer passed off as the one that was asked for.
    const { text, isError } = await client.call('credible_get_stats', {
      domain: DOMAIN,
      period: 'day',
      filters: [['has_done', ['is', 'event:goal', ['Signup']]]],
    });

    if (isError) {
      assert.match(text, /has_done/, 'the filter must reach the instance verbatim');
      assert.match(text, /42[02]/, 'and be refused with a status, never silently ignored');
    } else {
      // Nothing has ever sent a Signup event, so an instance that honours this
      // must come back empty rather than with the unfiltered total.
      assert.match(text, /Visitors\s+0/, 'an honoured behavioural filter has to actually filter');
    }
  });

  it('forwards a nested branch the same way', async () => {
    const { text, isError } = await client.call('credible_get_stats', {
      domain: DOMAIN,
      period: 'day',
      filters: [['or', [['is', 'event:page', ['/pricing']], ['is', 'event:page', ['/never-visited']]]]],
    });

    if (isError) {
      assert.match(text, /%22or%22|"or"/, 'the branch must reach the instance verbatim');
    } else {
      assert.match(text, /Visitors\s+1/, 'one of the two branches matches, so the visitor is kept');
    }
  });
});

// ---------------------------------------------------- segments and notes --

describe('segments', () => {
  let segmentId;

  it('reports a site that has none', async () => {
    const { text, isError } = await client.call('credible_list_segments', { domain: DOMAIN });
    assert.equal(isError, false, text);
    assert.match(text, /No saved segments/);
    assert.match(text, /credible_create_segment/, 'and says how to make one');
  });

  it('names a set of filters and reads it back as prose', async () => {
    const created = await client.call('credible_create_segment', {
      domain: DOMAIN,
      name: 'Pricing readers',
      filters: [['contains', 'event:page', ['/pricing']]],
      scope: 'site',
    });
    assert.equal(created.isError, false, created.text);
    assert.match(created.text, /Segment #\d+ "Pricing readers"/);
    assert.match(created.text, /event:page contains \/pricing/, 'a saved filter must be readable, not JSON');
    [, segmentId] = created.text.match(/Segment #(\d+)/);

    const listed = await client.call('credible_list_segments', { domain: DOMAIN });
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, /Pricing readers/);
    assert.match(listed.text, /site-wide/);
  });

  it('saves a nested filter and still reads it back as prose', async () => {
    const created = await client.call('credible_create_segment', {
      domain: DOMAIN,
      name: 'Pricing or docs',
      filters: [['or', [['is', 'event:page', ['/pricing']], ['is', 'event:page', ['/docs']]]]],
      scope: 'site',
    });
    assert.equal(created.isError, false, created.text);
    assert.match(created.text, /\(event:page is \/pricing OR event:page is \/docs\)/);

    const applied = await client.call('credible_apply_segment', { domain: DOMAIN, segment: 'Pricing or docs', period: 'day' });
    assert.equal(applied.isError, false, applied.text);
    assert.match(applied.text, /Visitors\s+1/, 'the branch has to reach the query, not just the description');
  });

  it('applies one by id and summarises that audience', async () => {
    const { text, isError } = await client.call('credible_apply_segment', {
      domain: DOMAIN,
      segment: Number(segmentId),
      period: 'day',
    });
    assert.equal(isError, false, text);
    assert.match(text, /Through segment "Pricing readers"/);
    assert.match(text, /Visitors\s+1/);
    assert.match(text, /Top pages/, 'it must read like the ordinary dashboard, not a second layout');
  });

  it('applies one by name, so the id never has to be looked up first', async () => {
    const { text, isError } = await client.call('credible_apply_segment', {
      domain: DOMAIN,
      segment: 'pricing readers',
      period: 'day',
    });
    assert.equal(isError, false, text);
    assert.match(text, /Visitors\s+1/);
  });

  it('really narrows the numbers rather than decorating them', async () => {
    const created = await client.call('credible_create_segment', {
      domain: DOMAIN,
      name: 'Nobody at all',
      filters: [['is', 'visit:country', ['AQ']]],
      scope: 'site',
    });
    assert.equal(created.isError, false, created.text);

    const { text, isError } = await client.call('credible_apply_segment', {
      domain: DOMAIN,
      segment: 'Nobody at all',
      period: 'day',
    });
    assert.equal(isError, false, text);
    assert.match(text, /Visitors\s+0/);
  });

  it('lists what does exist when the name is wrong', async () => {
    const { text, isError } = await client.call('credible_apply_segment', { domain: DOMAIN, segment: 'Martians' });
    assert.equal(isError, true);
    assert.match(text, /no segment named "Martians"/);
    assert.match(text, /Pricing readers/, 'a wrong name must be answered with the right ones');
  });

  it('composes with the ordinary stats tools', async () => {
    const stats = await client.call('credible_get_stats', { domain: DOMAIN, period: 'day', segment: segmentId });
    assert.equal(stats.isError, false, stats.text);
    assert.match(stats.text, /Segment applied: "Pricing readers"/);
    assert.match(stats.text, /Visitors\s+1/);

    const breakdown = await client.call('credible_breakdown', {
      domain: DOMAIN,
      dimension: 'event:page',
      period: 'day',
      segment: 'Nobody at all',
    });
    assert.equal(breakdown.isError, false, breakdown.text);
    assert.match(breakdown.text, /no data for this dimension/);
  });

  it('refuses a segment with no filters', async () => {
    const { text, isError } = await client.call('credible_create_segment', { domain: DOMAIN, name: 'Everyone', filters: [] });
    assert.equal(isError, true);
    assert.match(text, /at least one/);
  });
});

describe('annotations', () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  it('refuses a date it could not place on the graph', async () => {
    const { text, isError } = await client.call('credible_add_annotation', {
      domain: DOMAIN,
      date: '16 August',
      text: 'Shipped something',
    });
    assert.equal(isError, true);
    assert.match(text, /YYYY-MM-DD/);
  });

  it('records a note and reads it back for the period it falls in', async () => {
    const added = await client.call('credible_add_annotation', {
      domain: DOMAIN,
      date: today,
      text: 'Shipped the redesigned pricing page',
    });
    assert.equal(added.isError, false, added.text);
    assert.match(added.text, /Shipped the redesigned pricing page/);
    assert.match(added.text, /annotation #\d+/);

    const listed = await client.call('credible_list_annotations', { domain: DOMAIN, period: 'day' });
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, new RegExp(today), 'the day is resolved in the site timezone, not in UTC');
    assert.match(listed.text, /Shipped the redesigned pricing page/);

    const everything = await client.call('credible_list_annotations', { domain: DOMAIN });
    assert.equal(everything.isError, false, everything.text);
    assert.match(everything.text, /all time/);
    assert.match(everything.text, /Shipped the redesigned pricing page/);
  });

  it('carries them into the stats report, so a spike is never explained blind', async () => {
    const { text, isError } = await client.call('credible_get_stats', { domain: DOMAIN, period: 'day' });
    assert.equal(isError, false, text);
    assert.match(text, /What happened in this period/);
    assert.match(text, /Shipped the redesigned pricing page/);
  });

  it('says so when a range has none', async () => {
    const { text, isError } = await client.call('credible_list_annotations', {
      domain: DOMAIN,
      from: '2001-01-01',
      to: '2001-12-31',
    });
    assert.equal(isError, false, text);
    assert.match(text, /No annotations/);
  });
});

// ------------------------------------------------------ settings and shields --

describe('credible_configure_site', () => {
  it('reads the settings back without changing anything', async () => {
    const { text, isError } = await client.call('credible_configure_site', { domain: DOMAIN });
    assert.equal(isError, false, text);
    assert.match(text, /current settings/);
    assert.match(text, /Timezone\s+Europe\/Paris/);
  });

  it('sets the shields and reads them back', async () => {
    const { text, isError } = await client.call('credible_configure_site', {
      domain: DOMAIN,
      excluded_paths: '/admin/**',
      excluded_countries: 'RU, CN',
      allowed_hostnames: 'example.com, *.example.com',
      bot_filtering: 'strict',
    });
    assert.equal(isError, false, text);
    assert.match(text, /4 settings updated/);
    assert.match(text, /Excluded paths\s+\/admin\/\*\*/);
    assert.match(text, /Excluded countries\s+RU, CN/);
    // The site payload now returns the shields, so the tool reports what the
    // server holds rather than repeating what it was told. The "(applied)"
    // caveat it used to print is gone, and must not come back.
    assert.doesNotMatch(text, /\(applied\)/);
    assert.doesNotMatch(text, /does not report/);
    assert.match(text, /strict/);
  });

  it('really wrote them, rather than echoing the arguments back', () => {
    const site = findSiteByDomain(DOMAIN);
    assert.equal(site.excluded_paths, '/admin/**');
    assert.equal(site.excluded_countries, 'RU, CN');
    assert.equal(site.allowed_hostnames, 'example.com, *.example.com');
    assert.equal(site.bot_filtering, 'strict');
  });

  it('clears a shield when it is given an empty string', async () => {
    const { text, isError } = await client.call('credible_configure_site', {
      domain: DOMAIN,
      excluded_countries: '',
      allowed_hostnames: '',
      bot_filtering: 'standard',
    });
    assert.equal(isError, false, text);

    const site = findSiteByDomain(DOMAIN);
    assert.equal(site.excluded_countries, '');
    assert.equal(site.allowed_hostnames, '');
    assert.equal(site.bot_filtering, 'standard');
  });

  it('rejects a bot filtering level that does not exist, before making a request', async () => {
    const { text, isError } = await client.call('credible_configure_site', { domain: DOMAIN, bot_filtering: 'paranoid' });
    assert.equal(isError, true);
    assert.match(text, /"off", "standard" or "strict"/);
  });

  it('takes a list setting as an array as readily as comma separated', async () => {
    // The schema says "comma separated", but a model handed a list reaches for
    // a list about as often, and both plainly mean the same thing.
    const { text, isError } = await client.call('credible_configure_site', {
      domain: DOMAIN,
      excluded_paths: ['/admin/**', '  /preview/*  ', ''],
    });
    assert.equal(isError, false, text);
    assert.match(text, /1 setting updated/);

    // Joined into the wire format, blanks dropped and entries trimmed.
    assert.equal(findSiteByDomain(DOMAIN).excluded_paths, '/admin/**, /preview/*');

    // Put it back, so the shield the later tests inherit is the one they had.
    await client.call('credible_configure_site', { domain: DOMAIN, excluded_paths: '/admin/**' });
    assert.equal(findSiteByDomain(DOMAIN).excluded_paths, '/admin/**');
  });

  it('refuses a setting of the wrong type instead of silently dropping it', async () => {
    // The failure this guards against is not a crash, it is a lie: a value that
    // is not a string used to fall straight through the patch loop, so the tool
    // answered "current settings" with the shield unset and no error, and the
    // caller walked away believing the traffic was being filtered.
    const before = findSiteByDomain(DOMAIN);

    for (const [field, value, expected] of [
      ['bot_filtering', true, /`bot_filtering` must be a string, not a boolean.*"off", "standard" or "strict"/s],
      ['excluded_countries', 42, /`excluded_countries` must be a string, not a number.*array of strings/s],
      ['timezone', ['Europe/Paris'], /`timezone` must be a string, not an array/],
      ['excluded_ips', { ip: '203.0.113.7' }, /`excluded_ips` must be a string, not an object/],
    ]) {
      const { text, isError } = await client.call('credible_configure_site', { domain: DOMAIN, [field]: value });
      assert.equal(isError, true, `${field} was accepted: ${text}`);
      assert.match(text, expected);
      assert.doesNotMatch(text, /settings? updated|current settings/, `${field} reported settings instead of refusing`);
    }

    // And it refused before writing: nothing on the site moved.
    const after = findSiteByDomain(DOMAIN);
    for (const field of ['timezone', 'excluded_paths', 'excluded_ips', 'excluded_countries', 'allowed_hostnames', 'bot_filtering']) {
      assert.equal(after[field], before[field], field);
    }
  });
});

// ------------------------------------------------------------ comparisons --

describe('credible_compare_periods', () => {
  it('lays the same query side by side and says the change out loud', async () => {
    const { text, isError } = await client.call('credible_compare_periods', {
      domain: DOMAIN,
      period: 'day',
      compare_period: 'yesterday',
    });
    assert.equal(isError, false, text);
    assert.match(text, new RegExp(`${DOMAIN} — day compared with yesterday`));
    assert.match(text, /1 visitor over day/, 'the headline must be a sentence, not a table');
    assert.match(text, /Visitors\s+1\s+0\s+new/);
    assert.match(text, /Bounce rate/);
    assert.match(text, /Europe\/Paris/, 'both ranges must be named in the site timezone');
    assert.match(text, /Change reads day against yesterday/, 'the direction of the comparison must never be ambiguous');
  });

  it('requires the period to compare against', async () => {
    const { text, isError } = await client.call('credible_compare_periods', { domain: DOMAIN, period: 'day' });
    assert.equal(isError, true);
    assert.match(text, /`compare_period` is required/);
    assert.match(text, /previous_period/, 'and points at the one-call alternative');
  });

  it('refuses realtime, which is a live window rather than a range', async () => {
    const { text, isError } = await client.call('credible_compare_periods', {
      domain: DOMAIN,
      period: 'realtime',
      compare_period: 'day',
    });
    assert.equal(isError, true);
    assert.match(text, /credible_realtime/);
  });

  it('checks the comparison range under its own argument names', async () => {
    const { text, isError } = await client.call('credible_compare_periods', {
      domain: DOMAIN,
      period: 'day',
      compare_period: 'custom',
    });
    assert.equal(isError, true);
    assert.match(text, /compare_from/);
    assert.match(text, /compare_to/);
  });
});

// ------------------------------------------------ endpoints wired since v0.1 --

/**
 * These three tools were written against endpoints that did not exist yet, and
 * the suite used to assert they said so politely. The endpoints landed, so the
 * assertions inverted: what matters now is that each one actually answers, and
 * that the "this instance is too old" path is still reachable for anyone
 * pointing a current MCP server at an older instance.
 */
describe('tools whose endpoint landed', () => {
  it('credible_journey walks forward from every entry page', async () => {
    const { text, isError } = await client.call('credible_journey', { domain: DOMAIN, steps: 3 });
    assert.ok(!isError, `expected a journey, got: ${text}`);
    assert.doesNotMatch(text, /does not provide/i);
    assert.doesNotMatch(text, /404/);
  });

  it('credible_journey walks backward from a named page', async () => {
    const { text, isError } = await client.call('credible_journey', {
      domain: DOMAIN,
      end_page: '/pricing',
      steps: 3,
    });
    assert.ok(!isError, `expected a backward journey, got: ${text}`);
  });

  it('credible_consolidated rolls every site into one answer', async () => {
    const { text, isError } = await client.call('credible_consolidated', {});
    assert.ok(!isError, `expected a rollup, got: ${text}`);
    assert.match(text, new RegExp(DOMAIN), 'the site it can see must appear in the rollup');
  });

  it('credible_import_status reports an empty history without complaining', async () => {
    const { text, isError } = await client.call('credible_import_status', { domain: DOMAIN });
    assert.ok(!isError, `expected an import list, got: ${text}`);
    assert.doesNotMatch(text, /404/);
  });

  it('still explains an endpoint an older instance does not serve', async () => {
    // Point the tool at a URL that answers nothing, which is what talking to a
    // pre-journey instance looks like from here.
    const { text, isError } = await client.call('credible_journey', {
      domain: DOMAIN,
      instance_url: 'http://127.0.0.1:1',
    });
    assert.equal(isError, true);
    assert.doesNotMatch(text, /at .*\n\s+at /, 'a stack trace must never reach the model');
  });
});

/**
 * A stand-in for a Credible newer than this one: it answers the three endpoints
 * that do not exist yet, so the code that renders them is exercised before the
 * real thing lands rather than after somebody trusts it.
 *
 * The shapes below are the ones these tools read. An instance that answers with
 * a different one is reported as unreadable instead of summarised wrongly —
 * which the last test in this block is here to prove.
 */
function startFutureInstance() {
  let lastQuery = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    lastQuery = Object.fromEntries(url.searchParams.entries());

    const reply = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // The shapes below are the ones src/stats/journeys.js, src/stats/consolidated.js
    // and src/import.js document as their return values.
    if (url.pathname.endsWith('/journey')) {
      if (url.searchParams.get('start_page') === '/unreadable') {
        reply({ nodes: 'a shape nobody agreed on' });
        return;
      }
      reply({
        direction: 'forward',
        root: { name: '/', visitors: 420 },
        steps: [
          [
            { name: '/pricing', visitors: 240, share: 57, dropoff: 0, terminal: false, from: '' },
            { name: '/docs', visitors: 90, share: 21, dropoff: 60, terminal: true, from: '' },
          ],
          [{ name: '/signup', visitors: 120, share: 50, dropoff: 0, terminal: false, from: '/pricing' }],
        ],
        total_visits: 420,
        truncated: false,
        paths: [
          { steps: ['/', '/pricing', '/signup'], visitors: 84, share: 20, converted: true },
          { steps: ['/', '/pricing'], visitors: 61, share: 14, converted: false },
        ],
      });
      return;
    }
    if (url.pathname === '/api/stats/consolidated') {
      reply({
        sites: [
          { domain: 'acme.dev', timezone: 'Europe/Paris', visitors: 1461, pageviews: 3440, bounce_rate: 68, change: 28, current_visitors: 2 },
          { domain: 'blog.acme.dev', timezone: 'UTC', visitors: 210, pageviews: 500, bounce_rate: 71, change: -4, current_visitors: 0 },
        ],
        totals: { visitors: 1671, visits: 2100, pageviews: 3940, bounce_rate: 68, visit_duration: 228, current_visitors: 2 },
        top_pages: [{ name: '/', site: 'acme.dev', visitors: 856 }],
        top_sources: [{ name: 'Google', visitors: 340 }],
        timezone_note: 'Sites span two timezones, so the graph is bucketed in UTC.',
        visitors_note: 'A person visiting two sites is counted once per site.',
      });
      return;
    }
    if (url.pathname.endsWith('/imports')) {
      reply({
        imports: [
          {
            id: 3,
            source: 'plausible-csv',
            status: 'complete',
            from_date: '2024-01-01',
            to_date: '2025-12-31',
            rows_read: 150000,
            events_written: 148203,
            aggregates_written: 730,
            error: '',
            started_at: 1755000000,
            finished_at: 1755000600,
          },
          { id: 2, source: 'generic-csv', status: 'failed', error: 'row 12 has no timestamp', started_at: 1754900000 },
          { id: 1, source: 'credible-csv', status: 'running', from_date: '2026-01-01', started_at: 1755100000 },
        ],
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  return { server, query: () => lastQuery };
}

describe('rendering the endpoints that are still being built', () => {
  let stub;
  let stubOrigin;
  const at = (args) => ({ instance_url: stubOrigin, api_key: 'cred_stub', ...args });

  before(async () => {
    stub = startFutureInstance();
    await new Promise((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    stubOrigin = `http://127.0.0.1:${stub.server.address().port}`;
  });

  after(async () => {
    stub.server.closeAllConnections?.();
    await new Promise((resolve) => stub.server.close(resolve));
  });

  it('walks the journey tree level by level and keeps each branch under its parent', async () => {
    const { text, isError } = await client.call('credible_journey', at({ domain: DOMAIN, start_page: '/', steps: 3 }));
    assert.equal(isError, false, text);
    assert.match(text, /journeys over 7d from \/ \(3 steps\)/);
    assert.match(text, /Starting from \/ — 420 visitors/);
    assert.match(text, /Step 1\n\s+\/pricing — 240 visitors, 57%/);
    assert.match(text, /\/docs \(end of visit\) — 90 visitors, 21%, 60% stopped here/);
    assert.match(text, /Step 2\n\s+after \/pricing\n\s+\/signup — 120 visitors/);
    // The flat ranking arrives in the same payload and is worth showing too.
    assert.match(text, /Most travelled paths/);
    assert.match(text, /1\. \/ -> \/pricing -> \/signup — 84 visitors, 20%, converted/);

    const query = stub.query();
    assert.equal(query.start_page, '/', 'the anchor must reach the instance');
    assert.equal(query.steps, '3');
    assert.equal(query.period, '7d');
  });

  it('rolls every site up with its totals, and repeats the caveats that change their meaning', async () => {
    const { text, isError } = await client.call('credible_consolidated', at({ period: '30d' }));
    assert.equal(isError, false, text);
    assert.match(text, /All sites on .* — 30d/);
    assert.match(text, /1\. acme\.dev — 1,461 visitors, 3,440 pageviews, 68% bounce, \+28%, 2 on site now/);
    assert.match(text, /2\. blog\.acme\.dev — 210 visitors, 500 pageviews, 71% bounce, -4%/);
    assert.match(text, /Total visitors\s+1,671/);
    assert.match(text, /Visit duration\s+3m 48s/);
    assert.match(text, /Sites\s+2/);
    assert.match(text, /Top pages across every site/);
    assert.match(text, /\/ \(acme\.dev\) — 856 visitors/);
    // A rollup that hides "counted once per site" is a rollup that misleads.
    assert.match(text, /counted once per site/);
    assert.match(text, /bucketed in UTC/);
  });

  it('reports each import with its status, and flags the ones that change the answer', async () => {
    const { text, isError } = await client.call('credible_import_status', at({ domain: DOMAIN }));
    assert.equal(isError, false, text);
    assert.match(text, /3 imports on/);
    assert.match(text, /#3 plausible-csv — complete, 2024-01-01 to 2025-12-31, 148,203 events, 730 daily rollup rows, 150,000 rows read/);
    assert.match(text, /#2 generic-csv — failed: row 12 has no timestamp/);
    assert.match(text, /1 import is still running/, 'an incomplete range must not be compared against');
    assert.match(text, /1 failed/);
  });

  it('says a response is unreadable rather than calling it empty', async () => {
    // The difference matters: "no journeys in this period" is an answer about
    // the site, and it would be a lie about an envelope this tool cannot parse.
    const { text, isError } = await client.call('credible_journey', at({ domain: DOMAIN, start_page: '/unreadable' }));
    assert.equal(isError, false, text);
    assert.match(text, /does not know how to read/);
    assert.match(text, /a shape nobody agreed on/, 'and shows the raw answer so somebody can fix it');
    assert.doesNotMatch(text, /no journey reached/);
  });
});

// ------------------------------------------------------- legacy instances --

/**
 * A stand-in for a Credible older than `/api/v1/provision`: that one route
 * 404s, everything else is forwarded to the real instance. The upstream sees
 * its own Host, so it reports its own origin — which is also what a reverse
 * proxy without CREDIBLE_BASE_URL looks like.
 */
function startLegacyProxy(upstream) {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/v1/provision')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];

    const response = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    });

    const out = {};
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'set-cookie'].includes(key)) out[key] = value;
    });
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return server;
}

describe('an instance older than /api/v1/provision', () => {
  let proxy;
  let legacyOrigin;

  before(async () => {
    proxy = startLegacyProxy(origin);
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    legacyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  });

  after(async () => {
    proxy.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
  });

  it('provisions anyway, by composing register + key + site', async () => {
    const { text, isError } = await client.call('credible_provision', {
      instance_url: legacyOrigin,
      email: 'legacy@example.com',
      domain: 'legacy.example',
      timezone: 'Europe/Paris',
    });

    assert.equal(isError, false, text);
    assert.match(text, /cred_[A-Za-z0-9_-]+/, 'the composed path must still mint a key');
    assert.match(text, /legacy\.example \(Europe\/Paris, EUR\)/);
    const [, key] = text.match(/(cred_[A-Za-z0-9_-]+)/);

    // Really provisioned: the key opens the account, and the site is there.
    const response = await fetch(`${origin}/api/sites`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.sites.map((site) => site.domain),
      ['legacy.example'],
    );
  });

  it('never contradicts itself about where the instance lives', async () => {
    // This upstream reports its own origin rather than the proxy's, so the
    // snippet, the dashboard link and the header must all follow the snippet
    // rather than each picking a different one.
    const { text, isError } = await client.call('credible_provision', {
      instance_url: legacyOrigin,
      email: 'legacy2@example.com',
      domain: 'legacy2.example',
    });
    assert.equal(isError, false, text);

    const [, snippetOrigin] = text.match(/src="(https?:\/\/[^"]+)\/js\/cr\.js"/);
    assert.ok(text.includes(`Credible is ready at ${snippetOrigin}`), `header must name ${snippetOrigin}: ${text}`);
    assert.ok(text.includes(`${snippetOrigin}/legacy2.example`), `dashboard link must name ${snippetOrigin}: ${text}`);
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
