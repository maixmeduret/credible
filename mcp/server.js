#!/usr/bin/env node
/**
 * The Credible MCP server — an AI assistant's hands on a Credible instance.
 *
 * It speaks the Model Context Protocol over stdio: newline-delimited JSON-RPC
 * 2.0 messages on stdin/stdout, implemented from scratch on node:readline. No
 * SDK, no dependencies — the same rule as the rest of Credible.
 *
 * The point of it: a human should never have to click through the dashboard to
 * get started. `credible_provision` turns a bare instance into an account, a
 * site, an API key and an install snippet in one call; the assistant then edits
 * the website's code, calls `credible_verify_install` to confirm events are
 * arriving, and answers questions about the traffic with the stats tools.
 *
 *   CREDIBLE_URL      base URL of the instance   (default http://localhost:8000)
 *   CREDIBLE_API_KEY  API key used by every tool (optional — provision returns one)
 *
 * Every tool also accepts `instance_url` and `api_key` arguments that override
 * the environment for that single call.
 *
 * PROTOCOL INVARIANT: stdout carries JSON-RPC messages and nothing else. All
 * diagnostics go to stderr.
 */
import readline from 'node:readline';
import crypto from 'node:crypto';
import process from 'node:process';

const SERVER_NAME = 'credible';
const SERVER_VERSION = '0.1.0';

/** The protocol revision this server implements. */
const PROTOCOL_VERSION = '2025-06-18';
/** Revisions we can also speak: when a client asks for one, we echo it back. */
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const DEFAULT_URL = 'http://localhost:8000';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A User-Agent for server-side events. The ingest pipeline drops anything that
 * does not look like a real browser (bots must never reach the counters), so an
 * event posted by an agent needs one. Callers who know the visitor's real
 * User-Agent should pass it — device and OS attribution depend on it.
 */
const SERVER_SIDE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// --------------------------------------------------------------- session --

/**
 * Everything the server remembers between calls. `keys` is filled in by
 * credible_provision so the rest of the session works without the caller
 * having to carry the API key around; it is keyed by instance so pointing a
 * later call at a different instance never reuses the wrong credential.
 */
const session = {
  defaultUrl: normalizeBase(process.env.CREDIBLE_URL || DEFAULT_URL),
  envKey: String(process.env.CREDIBLE_API_KEY || '').trim(),
  keys: new Map(),
};

/** 'localhost:8000/' -> 'http://localhost:8000' */
function normalizeBase(input) {
  let value = String(input || '').trim().replace(/\/+$/, '');
  if (!value) return DEFAULT_URL;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

const baseUrl = (args = {}) => normalizeBase(args.instance_url || session.defaultUrl);

/** The API key for this call: explicit argument, then session, then env. */
function keyFor(args = {}) {
  const explicit = String(args.api_key || '').trim();
  if (explicit) return explicit;
  return session.keys.get(baseUrl(args)) || session.envKey || '';
}

function requireKey(args) {
  const key = keyFor(args);
  if (!key) {
    throw new ToolError(
      'no API key available. Set CREDIBLE_API_KEY, pass `api_key`, or call credible_provision first — ' +
        'it creates the account and returns a key that the rest of this session reuses automatically.',
    );
  }
  return key;
}

// ------------------------------------------------------------- transport --

/** A failure the model should read and act on, not a protocol error. */
class ToolError extends Error {}

/** A JSON-RPC level failure (bad method, bad params). */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * One HTTP call against a Credible instance. Never throws on a non-2xx status —
 * it returns it, so callers can branch (a 404 on /api/v1/provision means "older
 * instance", not "broken"). Network-level failures become readable ToolErrors.
 *
 * @returns {Promise<{ok: boolean, status: number, json: any, text: string, headers: Headers, url: string}>}
 */
async function request(method, path, opts = {}) {
  const base = baseUrl(opts);
  const url = `${base}${path}${queryString(opts.query)}`;

  const headers = { accept: 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;

  let body;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError(err, method, url, base);
  }

  const text = await response.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: response.ok, status: response.status, json, text, headers: response.headers, url };
}

/** Same as request(), but a non-2xx status throws a readable ToolError. */
async function api(method, path, opts = {}) {
  const result = await request(method, path, opts);
  if (!result.ok) throw httpError(result, method);
  return result.json ?? {};
}

/**
 * Turn a fetch/DNS/socket failure into something a model can act on. Anything
 * that never produced an HTTP response means the instance is not answering, so
 * the advice is the same in every case: the underlying reason is appended for
 * diagnosis rather than used to pick a different message.
 */
function networkError(err, method, url, base) {
  const cause = err?.cause;
  const code = cause?.code || err?.code || cause?.errors?.find((e) => e?.code)?.code || '';

  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new ToolError(
      `${method} ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s — ${base} accepted the connection but never answered.`,
    );
  }
  const detail = code || cause?.message || err?.message || 'connection failed';
  return new ToolError(
    `no Credible instance is running at ${base} — start one with \`node bin/credible.js serve\`, ` +
      "or point CREDIBLE_URL (or this call's `instance_url`) at the instance you meant " +
      `(${method} ${url}: ${detail}).`,
  );
}

/** Turn a non-2xx response into a message that names the URL, the status and the fix. */
function httpError(result, method) {
  const raw = result.json?.error || result.text.split('\n')[0].slice(0, 200) || 'no response body';
  const reported = String(raw).replace(/\.\s*$/, '');
  const hints = {
    401: ' The API key was missing or rejected — pass `api_key`, set CREDIBLE_API_KEY, or run credible_provision to mint one.',
    403: ' This instance is locked down (CREDIBLE_OPEN_REGISTRATION=false). Supply an `api_key` for an existing account.',
    404: ' Check the domain is spelled exactly as it was added (no protocol, no www) and that this key can see it — credible_list_sites shows what it can.',
    409: ' Something with that name already exists on this instance.',
    422: ' One of the arguments was rejected as invalid — the message above says which.',
    429: ' Rate limited by the instance. Wait a minute and retry.',
  };
  return new ToolError(`${method} ${result.url} returned ${result.status}: ${reported}.${hints[result.status] || ''}`);
}

// ------------------------------------------------------------ formatting --

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/** '1 visitor' / '4 visitors' — the plural of every metric in here is a plain -s. */
const count = (n, word) => `${fmt(n)} ${word}${Number(n) === 1 ? '' : 's'}`;

const money = (amount, currency = '') => `${Number(amount || 0).toFixed(2)}${currency ? ` ${currency}` : ''}`;

/** 134 -> '2m 14s' */
function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Unix seconds -> '3 minutes ago' */
function timeAgo(unixSeconds) {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSeconds || 0));
  if (delta < 60) return `${delta} second${delta === 1 ? '' : 's'} ago`;
  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
  ];
  let label = 'minute';
  let size = 60;
  for (const [name, secs] of units) {
    if (delta >= secs) {
      label = name;
      size = secs;
    }
  }
  const value = Math.floor(delta / size);
  return `${value} ${label}${value === 1 ? '' : 's'} ago`;
}

const isoStamp = (unixSeconds) =>
  unixSeconds ? new Date(Number(unixSeconds) * 1000).toISOString().replace('.000', '').replace('T', ' ').slice(0, 19) + ' UTC' : '';

/** '+12%' / '-4%' / 'no change' */
function changeLabel(value) {
  if (value === null || value === undefined) return '';
  if (value === 0) return 'no change';
  return `${value > 0 ? '+' : ''}${value}%`;
}

/** Two aligned columns. Rows that are falsy are dropped. */
function block(rows) {
  const kept = rows.filter((row) => Array.isArray(row) && row[1] !== '' && row[1] !== null && row[1] !== undefined);
  if (!kept.length) return '';
  const width = Math.max(...kept.map(([label]) => String(label).length)) + 2;
  return kept.map(([label, value]) => `${String(label).padEnd(width)}${value}`).join('\n');
}

/**
 * One line of a breakdown. The stats API returns four different row shapes
 * (dimensions, pages, custom properties, goals); this reads whichever columns
 * are present so every ranking is formatted by the same code.
 */
function breakdownLine(row, index, currency) {
  const rank = `  ${String(index + 1).padStart(2)}.`;
  const name = row.name === '' || row.name === null || row.name === undefined ? '(none)' : row.name;

  if (row.uniques !== undefined) {
    // Goal row: conversions, not visitors.
    const parts = [count(row.uniques, 'converting visitor'), `${row.cr ?? 0}% of visitors`];
    if (row.total && row.total !== row.uniques) parts.push(`${fmt(row.total)} total conversions`);
    if (row.revenue) parts.push(`${money(row.revenue, currency)} revenue`);
    return `${rank} ${name} — ${parts.join(', ')}`;
  }

  const parts = [count(row.visitors ?? 0, 'visitor')];
  if (row.pageviews !== undefined) parts.push(count(row.pageviews, 'pageview'));
  else if (row.events !== undefined) parts.push(count(row.events, 'event'));
  if (row.revenue) parts.push(`${money(row.revenue, currency)} revenue`);
  return `${rank} ${name} — ${parts.join(', ')}`;
}

/** A numbered ranking from a breakdown `results` array. */
function ranked(results, { empty = 'nothing yet', limit = 10, currency = '' } = {}) {
  if (!Array.isArray(results) || !results.length) return `  (${empty})`;
  return results
    .slice(0, limit)
    .map((row, index) => breakdownLine(row, index, currency))
    .join('\n');
}

const section = (title, body) => `${title}\n${body}`;

function snippetFor(base, domain) {
  return `<script defer data-domain="${domain}" src="${base}/js/cr.js"></script>`;
}

const INSTALL_NOTE = (base, domain) =>
  [
    'Where it goes: inside <head>, on every page of the site (a shared layout/template is the right place).',
    'It must be the real deployed site — a page served from localhost only reports if this Credible instance',
    `is reachable from that browser (${base}).`,
    `Keep data-domain exactly "${domain}": no protocol, no www, no trailing slash.`,
    `Then load a page and call credible_verify_install with domain "${domain}".`,
  ].join('\n');

// -------------------------------------------------------- argument access --

function requiredString(args, name, hint = '') {
  const value = args?.[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`\`${name}\` is required and must be a non-empty string.${hint ? ` ${hint}` : ''}`);
  }
  return value.trim();
}

const optionalString = (args, name) => {
  const value = args?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/** Domains are accepted in any shape a human might type and normalized here. */
function domainArg(args) {
  const raw = requiredString(args, 'domain', 'Example: "example.com".');
  return raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/^www\./i, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

const PERIODS = [
  'realtime',
  'day',
  'yesterday',
  '7d',
  '28d',
  '30d',
  '91d',
  'month',
  'last_month',
  '6mo',
  '12mo',
  'year',
  'all',
  'custom',
];

function periodArg(args) {
  const period = optionalString(args, 'period') || '7d';
  if (!PERIODS.includes(period)) {
    throw new ToolError(`unknown period "${period}". Use one of: ${PERIODS.join(', ')}.`);
  }
  if (period === 'custom' && !(args.from && args.to)) {
    throw new ToolError('period "custom" needs both `from` and `to` as YYYY-MM-DD dates.');
  }
  return period;
}

/** The query parameters every stats endpoint understands. */
const statsQuery = (args, period) => ({
  period,
  date: optionalString(args, 'date'),
  from: optionalString(args, 'from'),
  to: optionalString(args, 'to'),
  filters: optionalString(args, 'filters'),
  comparison: optionalString(args, 'comparison'),
});

// ------------------------------------------------------------ provisioning --

const generatePassword = () => crypto.randomBytes(18).toString('base64url');

const cookieFrom = (result) => {
  const [raw] = result.headers.getSetCookie?.() || [];
  return raw ? raw.split(';')[0] : '';
};

/**
 * Set an instance up in one call.
 *
 * The happy path is POST /api/v1/provision. Instances older than that endpoint
 * answer 404, and we fall back to composing the primitives the dashboard itself
 * uses (register or log in, mint an API key, create the site) so the tool still
 * does its job against any Credible.
 */
async function provision(args) {
  const email = requiredString(args, 'email');
  const base = baseUrl(args);
  const existingKey = keyFor(args);

  const body = { email };
  for (const field of ['password', 'name', 'domain', 'timezone', 'currency']) {
    const value = optionalString(args, field);
    if (value) body[field] = value;
  }

  const attempt = await request('POST', '/api/v1/provision', {
    instance_url: args.instance_url,
    apiKey: existingKey || undefined,
    body,
  });

  let data;
  if (attempt.ok) {
    data = attempt.json || {};
  } else if (attempt.status === 404) {
    data = await provisionByHand(args, base, existingKey);
  } else {
    throw httpError(attempt, 'POST');
  }

  const domain = data.site?.domain || optionalString(args, 'domain') || '';
  const instanceUrl = normalizeBase(data.instance_url || base);
  if (data.api_key) session.keys.set(instanceUrl, data.api_key);

  const created = data.created || {};
  const lines = [
    `Credible is ready at ${instanceUrl}`,
    '',
    block([
      ['Account', `${data.user?.email || email}${created.user === false ? ' (already existed)' : ' (created)'}`],
      ['Password', data.password ? `${data.password}   <- generated, shown once, save it now` : null],
      ['API key', data.api_key ? `${data.api_key}   <- shown once; remembered for the rest of this session` : null],
      ['Site', domain ? `${domain} (${data.site?.timezone || 'UTC'}, ${data.site?.currency || 'EUR'})` : 'none yet — call credible_add_site'],
      ['Dashboard', domain ? data.dashboard_url || `${instanceUrl}/${domain}` : null],
    ]),
  ];

  const snippet = data.snippet || (domain ? snippetFor(instanceUrl, domain) : '');
  if (snippet) {
    lines.push('', 'Install this snippet in the site you are tracking:', '', snippet, '', INSTALL_NOTE(instanceUrl, domain));
  } else {
    lines.push('', 'No domain was given, so nothing is being tracked yet. Call credible_add_site with a domain to get a snippet.');
  }

  if (Array.isArray(data.next_steps) && data.next_steps.length) {
    lines.push('', section('Next steps', data.next_steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')));
  }

  return lines.join('\n');
}

/** Compose provisioning out of the classic endpoints (pre-/api/v1/provision instances). */
async function provisionByHand(args, base, existingKey) {
  const email = requiredString(args, 'email');
  const domain = optionalString(args, 'domain');
  const suppliedPassword = optionalString(args, 'password');
  const password = suppliedPassword || generatePassword();
  const shared = { instance_url: args.instance_url };

  let cookie = '';
  let apiKey = '';
  let user = null;
  let createdUser = false;

  if (existingKey) {
    // A key was supplied: use the account it belongs to rather than making one.
    const me = await api('GET', '/api/auth/me', { ...shared, apiKey: existingKey });
    if (!me.user) throw new ToolError(`the API key supplied is not valid on ${base}.`);
    apiKey = existingKey;
    user = me.user;
  } else {
    const registered = await request('POST', '/api/auth/register', {
      ...shared,
      body: { email, password, name: optionalString(args, 'name') || '' },
    });

    if (registered.ok) {
      createdUser = true;
      cookie = cookieFrom(registered);
      user = registered.json?.user || null;
    } else if (registered.status === 409 || registered.status === 403) {
      if (!suppliedPassword) {
        throw httpError(registered, 'POST');
      }
      const loggedIn = await request('POST', '/api/auth/login', { ...shared, body: { email, password } });
      if (!loggedIn.ok) throw httpError(loggedIn, 'POST');
      cookie = cookieFrom(loggedIn);
      user = loggedIn.json?.user || null;
    } else {
      throw httpError(registered, 'POST');
    }

    const minted = await api('POST', '/api/keys', { ...shared, cookie, body: { name: 'MCP (AI assistant)' } });
    apiKey = minted.key || '';
  }

  let site = null;
  let snippet = '';
  if (domain) {
    const auth = cookie ? { cookie } : { apiKey };
    const response = await request('POST', '/api/sites', {
      ...shared,
      ...auth,
      body: {
        domain,
        timezone: optionalString(args, 'timezone') || 'UTC',
        currency: optionalString(args, 'currency') || 'EUR',
      },
    });
    if (!response.ok) throw httpError(response, 'POST');
    site = response.json?.site || null;
    snippet = response.json?.snippet || snippetFor(base, domain);
  }

  return {
    user,
    password: createdUser && !suppliedPassword ? password : null,
    api_key: apiKey,
    site,
    snippet,
    instance_url: base,
    dashboard_url: site ? `${base}/${site.domain}` : null,
    created: { user: createdUser, site: Boolean(site) },
  };
}

// ------------------------------------------------------------------ tools --

/** Argument fragments every tool shares. */
const CONNECTION_PROPS = {
  instance_url: {
    type: 'string',
    description:
      'Base URL of the Credible instance, e.g. "https://analytics.example.com". Defaults to the CREDIBLE_URL environment variable, or http://localhost:8000.',
  },
  api_key: {
    type: 'string',
    description:
      'Credible API key (starts with "cred_"). Defaults to CREDIBLE_API_KEY, or the key credible_provision returned earlier in this session. Only pass it to override those.',
  },
};

const DOMAIN_PROP = {
  type: 'string',
  description: 'Domain of the site, exactly as it was added — no protocol, no www, e.g. "example.com".',
};

const PERIOD_PROP = {
  type: 'string',
  enum: PERIODS,
  description:
    'Time range to report on. "day" is today, "7d"/"28d"/"30d"/"91d" are trailing windows, "month"/"last_month"/"year" are calendar periods, "all" is everything ever recorded, "realtime" is the last 30 minutes, "custom" requires from and to. Defaults to 7d.',
};

const RANGE_PROPS = {
  from: { type: 'string', description: 'Start date (YYYY-MM-DD). Only used when period is "custom".' },
  to: { type: 'string', description: 'End date, inclusive (YYYY-MM-DD). Only used when period is "custom".' },
  date: { type: 'string', description: 'Anchor date (YYYY-MM-DD) that the period is measured from. Defaults to today.' },
  filters: {
    type: 'string',
    description:
      'Optional filter expression applied to every number, e.g. "visit:country==FR", "event:page==/pricing", "visit:source!=Google". Combine with ";".',
  },
};

const schema = (properties, required = []) => ({
  type: 'object',
  properties: { ...properties, ...CONNECTION_PROPS },
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: 'credible_provision',
    description:
      'FIRST CALL ON A FRESH INSTANCE. Sets Credible up from nothing in one step: creates the account if the instance has none, creates the site, and returns the API key plus the exact <script> snippet to install. Use it at the start of any "set up analytics for me" task — you do not need an API key to call it. Pass an existing api_key instead to add another site to an account that already exists. Returns the account, the generated password (shown once), the API key (remembered for the rest of this session, so later tools need no credentials), the dashboard URL and the snippet.',
    inputSchema: schema(
      {
        email: { type: 'string', description: 'Email address for the account, e.g. "you@example.com". Used as the login.' },
        domain: {
          type: 'string',
          description:
            'Domain to start tracking, e.g. "example.com". Optional, but pass it — without a domain there is no snippet to install.',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone the reports are bucketed in, e.g. "Europe/Paris". Defaults to UTC.',
        },
        currency: { type: 'string', description: 'Three-letter currency for revenue goals, e.g. "EUR" or "USD". Defaults to EUR.' },
        password: {
          type: 'string',
          description:
            'Password for the account, at least 8 characters. Leave it out and a strong one is generated and returned once. Pass the existing password to add a site to an account that already exists.',
        },
        name: { type: 'string', description: 'Display name for the account owner. Optional.' },
      },
      ['email'],
    ),
    run: provision,
  },

  {
    name: 'credible_list_sites',
    description:
      'List every site this API key can see, with how many visitors are on each of them right now. Use it to discover what is already being tracked before adding anything, or to find the exact spelling of a domain.',
    inputSchema: schema({}),
    run: async (args) => {
      const data = await api('GET', '/api/sites', { instance_url: args.instance_url, apiKey: requireKey(args) });
      const sites = data.sites || [];
      if (!sites.length) {
        return `No sites yet on ${baseUrl(args)}. Call credible_add_site with a domain to start tracking one.`;
      }
      const rows = sites.map((site) => [
        site.domain,
        `${fmt(site.current_visitors || 0)} visitors right now · ${site.timezone} · ${site.currency}${site.public ? ' · public dashboard' : ''}`,
      ]);
      return `${sites.length} site${sites.length === 1 ? '' : 's'} on ${baseUrl(args)}\n\n${block(rows)}`;
    },
  },

  {
    name: 'credible_add_site',
    description:
      'Start tracking a new domain on an instance that is already set up, and get the <script> snippet to install. Use this when the account exists (you have an API key) and you just need another site. On a brand new instance use credible_provision instead.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        timezone: { type: 'string', description: 'IANA timezone for this site\'s reports, e.g. "America/New_York". Defaults to UTC.' },
        currency: { type: 'string', description: 'Three-letter currency for revenue goals, e.g. "USD". Defaults to EUR.' },
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const base = baseUrl(args);
      const data = await api('POST', '/api/sites', {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body: {
          domain,
          timezone: optionalString(args, 'timezone') || 'UTC',
          currency: optionalString(args, 'currency') || 'EUR',
        },
      });
      const snippet = data.snippet || snippetFor(base, domain);
      return [
        `Now tracking ${data.site?.domain || domain} (${data.site?.timezone || 'UTC'}, ${data.site?.currency || 'EUR'}).`,
        `Dashboard: ${base}/${data.site?.domain || domain}`,
        '',
        'Install this snippet:',
        '',
        snippet,
        '',
        INSTALL_NOTE(base, data.site?.domain || domain),
      ].join('\n');
    },
  },

  {
    name: 'credible_get_snippet',
    description:
      'Get the exact <script> tag to install for a site that is already being tracked, with where it goes and how to verify it. Use this when you are about to edit a website\'s code and need the markup, or when someone asks "what do I paste?".',
    inputSchema: schema({ domain: DOMAIN_PROP }, ['domain']),
    run: async (args) => {
      const domain = domainArg(args);
      const base = baseUrl(args);
      const data = await api('GET', `/api/sites/${encodeURIComponent(domain)}`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
      });
      const snippet = data.snippet || snippetFor(base, domain);
      const range = data.data_range || {};
      return [
        `Snippet for ${domain}:`,
        '',
        snippet,
        '',
        INSTALL_NOTE(base, domain),
        '',
        range.first
          ? `This site has been receiving data since ${isoStamp(range.first)} — reinstalling is only needed if you moved or rebuilt the site.`
          : 'This site has never received an event, so the snippet is not live yet.',
      ].join('\n');
    },
  },

  {
    name: 'credible_verify_install',
    description:
      'Answer "is this site receiving data yet?" — call it right after editing a website\'s code and deploying, to confirm the snippet works. Checks live visitors and the recorded history, and reports when the first event arrived. When nothing has arrived it returns a checklist of the usual causes, so call it before telling anyone the setup is done.',
    inputSchema: schema({ domain: DOMAIN_PROP }, ['domain']),
    run: async (args) => {
      const domain = domainArg(args);
      const base = baseUrl(args);
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };

      const realtime = await api('GET', `/api/stats/${encodeURIComponent(domain)}/realtime`, shared);
      const dashboard = await api('GET', `/api/stats/${encodeURIComponent(domain)}/dashboard`, {
        ...shared,
        query: { period: 'day' },
      });

      // The site detail carries the first/last event timestamps. It needs
      // ownership rather than mere read access, so treat it as best-effort.
      let range = {};
      try {
        const detail = await api('GET', `/api/sites/${encodeURIComponent(domain)}`, shared);
        range = detail.data_range || {};
      } catch {
        range = {};
      }

      const live = Number(realtime.visitors || 0);
      const today = dashboard.metrics || {};
      const receiving = Boolean(range.first) || live > 0 || Number(today.pageviews || 0) > 0;

      if (!receiving) {
        return [
          `NOT YET — ${domain} has not received a single event on ${base}.`,
          '',
          'Check, in this order:',
          `  1. The snippet is in <head> of the page you loaded: ${snippetFor(base, domain)}`,
          `  2. data-domain is exactly "${domain}" — no https://, no www., no trailing slash.`,
          `  3. The change is deployed. Editing a local file is not enough unless you loaded that local page.`,
          `  4. The browser can reach ${base}. A localhost instance is invisible to visitors elsewhere.`,
          '  5. The page was loaded by a real browser — requests with a bot or empty User-Agent are dropped on purpose.',
          '  6. No ad blocker on the browser you tested with, and the request to /api/event returned 204.',
          '',
          'Fix, reload a page, then call credible_verify_install again.',
        ].join('\n');
      }

      const lines = [
        `YES — ${domain} is receiving data.`,
        '',
        block([
          ['First event', range.first ? `${isoStamp(range.first)} (${timeAgo(range.first)})` : 'just now (first events still arriving)'],
          ['Latest event', range.last ? `${isoStamp(range.last)} (${timeAgo(range.last)})` : null],
          ['Right now', `${count(live, 'visitor')} on the site`],
          ['Today', `${count(today.visitors, 'visitor')}, ${count(today.pageviews, 'pageview')}`],
          ['Dashboard', `${base}/${domain}`],
        ]),
      ];
      if (Array.isArray(realtime.pages) && realtime.pages.length) {
        lines.push('', section('Pages being viewed right now', ranked(realtime.pages, { limit: 5 })));
      }
      return lines.join('\n');
    },
  },

  {
    name: 'credible_get_stats',
    description:
      'The headline numbers for a site over a period: visitors, visits, pageviews, views per visit, bounce rate, visit duration, revenue, plus the top sources, pages and countries. This is the tool for "how is my site doing?" style questions. Pass comparison to get period-over-period change.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        period: PERIOD_PROP,
        ...RANGE_PROPS,
        comparison: {
          type: 'string',
          enum: ['previous_period', 'year_over_year', 'off'],
          description: 'Compare against an earlier range and report the percentage change for every metric. Off by default.',
        },
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const period = periodArg(args);
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };

      if (period === 'realtime') {
        return realtimeReport(domain, shared, baseUrl(args));
      }

      const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/dashboard`, {
        ...shared,
        query: statsQuery(args, period),
      });

      const m = data.metrics || {};
      const changes = data.changes || {};
      const currency = data.site?.currency || '';
      // Bounce rate is a percentage already, so its change is in points.
      const withChange = (key, value) => {
        if (changes[key] == null) return `${value}`;
        const label = key === 'bounce_rate' && changes[key] !== 0 ? `${changes[key] > 0 ? '+' : ''}${changes[key]} pts` : changeLabel(changes[key]);
        return `${value}   (${label})`;
      };
      const range = data.period || {};
      const panels = data.panels || {};

      const header = `${domain} — ${period}${range.start ? ` (${isoStamp(range.start).slice(0, 10)} to ${isoStamp(range.end - 1).slice(0, 10)}, ${range.timezone || 'UTC'})` : ''}`;

      const parts = [
        header,
        '',
        block([
          ['Visitors', withChange('visitors', fmt(m.visitors))],
          ['Visits', withChange('visits', fmt(m.visits))],
          ['Pageviews', withChange('pageviews', fmt(m.pageviews))],
          ['Views / visit', withChange('views_per_visit', m.views_per_visit ?? 0)],
          ['Bounce rate', withChange('bounce_rate', `${m.bounce_rate ?? 0}%`)],
          ['Visit duration', withChange('visit_duration', humanDuration(m.visit_duration))],
          ['Revenue', m.revenue ? money(m.revenue, currency) : null],
          ['On site now', fmt(data.current_visitors)],
        ]),
        '',
        section('Top sources', ranked(panels.sources?.results, { currency })),
        '',
        section('Top pages', ranked(panels.pages?.results, { currency })),
        '',
        section('Top countries', ranked(panels.countries?.results, { currency })),
      ];

      if (data.has_goals && panels.goals?.results?.length) {
        parts.push('', section('Goals', ranked(panels.goals.results, { empty: 'no conversions yet', currency })));
      }
      if (optionalString(args, 'filters')) parts.push('', `Filtered by: ${optionalString(args, 'filters')}`);
      parts.push('', `Full dashboard: ${baseUrl(args)}/${domain}`);
      return parts.join('\n');
    },
  },

  {
    name: 'credible_breakdown',
    description:
      'Group traffic by one dimension and rank it — the tool for "where do my visitors come from?", "which pages are most read?", "which countries?", "how are my goals converting?". Returns the ranked list with visitors, visits and pageviews for each entry.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        dimension: {
          type: 'string',
          description:
            'What to group by. Acquisition: visit:source, visit:channel, visit:referrer, visit:utm_source, visit:utm_medium, visit:utm_campaign. Content: event:page, visit:entry_page, visit:exit_page. Location: visit:country, visit:region, visit:city. Tech: visit:browser, visit:os, visit:device, visit:screen_size. Conversions: event:goal. Custom properties: event:props:<name>.',
        },
        period: PERIOD_PROP,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'How many entries to return, most visitors first. Defaults to 10.',
        },
        ...RANGE_PROPS,
      },
      ['domain', 'dimension'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const dimension = requiredString(args, 'dimension', 'Example: "visit:source".');
      const period = periodArg(args);
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 500) : 10;

      const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/breakdown`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        query: { ...statsQuery(args, period), dimension, limit },
      });

      const results = data.results || [];
      const lines = [
        `${domain} — ${dimension} over ${period}${optionalString(args, 'filters') ? ` (filtered: ${optionalString(args, 'filters')})` : ''}`,
        '',
        ranked(results, { limit, empty: 'no data for this dimension in this period' }),
      ];
      if (data.hasMore) lines.push('', `More entries exist — raise \`limit\` (currently ${limit}) to see them.`);
      return lines.join('\n');
    },
  },

  {
    name: 'credible_realtime',
    description:
      'Who is on the site right this second, and which pages they are looking at. Use it for "is anyone on my site now?" and as a fast sanity check that tracking is live after a deploy.',
    inputSchema: schema({ domain: DOMAIN_PROP }, ['domain']),
    run: (args) =>
      realtimeReport(domainArg(args), { instance_url: args.instance_url, apiKey: requireKey(args) }, baseUrl(args)),
  },

  {
    name: 'credible_create_goal',
    description:
      'Create a conversion goal so signups, purchases or key page visits are counted. Two kinds: an "event" goal fires when the site sends a custom event of that name, a "page" goal fires when a visitor reaches a path. Returns the goal id, which credible_create_funnel needs.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        type: {
          type: 'string',
          enum: ['event', 'page'],
          description: 'Use "event" for a custom event sent by the site (needs event_name), "page" for reaching a URL path (needs page_path).',
        },
        event_name: {
          type: 'string',
          description: 'Name of the custom event, e.g. "Signup". Required when type is "event"; must match what the site sends exactly.',
        },
        page_path: {
          type: 'string',
          description: 'Path that counts as a conversion, starting with "/", e.g. "/thank-you". Required when type is "page".',
        },
        display_name: { type: 'string', description: 'Human-friendly label shown in the dashboard. Optional.' },
      },
      ['domain', 'type'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const type = requiredString(args, 'type');
      if (!['event', 'page'].includes(type)) throw new ToolError('`type` must be "event" or "page".');
      if (type === 'event' && !optionalString(args, 'event_name')) {
        throw new ToolError('an event goal needs `event_name` — the exact name the site sends, e.g. "Signup".');
      }
      if (type === 'page' && !String(optionalString(args, 'page_path') || '').startsWith('/')) {
        throw new ToolError('a page goal needs `page_path` starting with "/", e.g. "/thank-you".');
      }

      const data = await api('POST', `/api/sites/${encodeURIComponent(domain)}/goals`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body: {
          type,
          event_name: optionalString(args, 'event_name') || '',
          page_path: optionalString(args, 'page_path') || '',
          display_name: optionalString(args, 'display_name') || '',
        },
      });

      const goal = data.goal || {};
      return [
        `Goal #${goal.id} created on ${domain}: ${goal.display_name || goal.event_name || goal.page_path}`,
        block([
          ['Type', goal.type],
          ['Event name', goal.event_name || null],
          ['Page path', goal.page_path || null],
        ]),
        '',
        type === 'event'
          ? `The site must send this event for it to convert: credible_track_event, or in the browser \`window.credible('${goal.event_name}')\`.`
          : 'It converts automatically whenever a visitor reaches that path.',
        `Use goal id ${goal.id} when building a funnel.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },

  {
    name: 'credible_create_funnel',
    description:
      'Build a funnel from existing goals to see where people drop off between steps. Needs between two and eight goal ids, in order — create the goals first with credible_create_goal, which returns their ids.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        name: { type: 'string', description: 'Name of the funnel, e.g. "Signup flow".' },
        goals: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 2,
          maxItems: 8,
          description: 'Goal ids in the order visitors are expected to hit them. Between 2 and 8, from credible_create_goal.',
        },
      },
      ['domain', 'name', 'goals'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const name = requiredString(args, 'name');
      const goals = Array.isArray(args.goals) ? args.goals.map(Number).filter(Number.isFinite) : [];
      if (goals.length < 2) throw new ToolError('`goals` needs at least two goal ids, in the order visitors hit them.');
      if (goals.length > 8) throw new ToolError('`goals` accepts at most eight steps.');

      const data = await api('POST', `/api/sites/${encodeURIComponent(domain)}/funnels`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body: { name, goals },
      });
      const funnel = data.funnel || {};
      const steps = (funnel.steps || []).map((step, index) => `  ${index + 1}. ${step.display_name || step.event_name || step.page_path}`);
      return [
        `Funnel #${funnel.id} "${funnel.name || name}" created on ${domain} with ${steps.length || goals.length} steps.`,
        ...(steps.length ? ['', ...steps] : []),
        '',
        `See the drop-off at ${baseUrl(args)}/${domain}`,
      ].join('\n');
    },
  },

  {
    name: 'credible_share_dashboard',
    description:
      'Create a public link to a site\'s dashboard so someone without an account can see the numbers. Optionally password protect it. Returns the URL to hand out.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        name: { type: 'string', description: 'Label for the link so you can tell shared links apart later, e.g. "Client". Optional.' },
        password: {
          type: 'string',
          description: 'Require this password before the dashboard is shown. Optional — without it, anyone with the link can read the stats.',
        },
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const password = optionalString(args, 'password');
      const data = await api('POST', `/api/sites/${encodeURIComponent(domain)}/shared-links`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body: { name: optionalString(args, 'name') || '', password: password || '' },
      });
      return [
        `Shared dashboard for ${domain}:`,
        '',
        data.url || `${baseUrl(args)}/share/${domain}?auth=${data.slug}`,
        '',
        password
          ? 'Password protected — whoever opens it must type the password you set.'
          : 'Anyone with this link can read the stats. It exposes no personal data, but it is public: treat the URL as the secret.',
      ].join('\n');
    },
  },

  {
    name: 'credible_track_event',
    description:
      'Record an event on a site from the server side, without a browser — use it to log a conversion you just completed (a signup, a payment, a booking) so it shows up against a goal. The event needs the page URL it belongs to; attach props for segmentation and revenue for money. For ordinary page tracking, install the snippet instead.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        name: {
          type: 'string',
          description: 'Event name. Use "pageview" for a page view, or the exact name of a goal event, e.g. "Signup".',
        },
        url: {
          type: 'string',
          description: 'Absolute URL the event happened on, e.g. "https://example.com/checkout/success". The path is what the dashboard groups by.',
        },
        props: {
          type: 'object',
          description: 'Custom properties for segmentation, e.g. {"plan": "pro", "method": "card"}. String, number or boolean values.',
          additionalProperties: true,
        },
        revenue: {
          type: 'object',
          description: 'Money attached to this conversion, e.g. {"amount": 49.90, "currency": "EUR"}. Currency defaults to the site\'s.',
          properties: {
            amount: { type: 'number', description: 'Amount in major units, e.g. 49.90 for €49.90.' },
            currency: { type: 'string', description: 'Three-letter code, e.g. "EUR". Defaults to the site currency.' },
          },
          required: ['amount'],
          additionalProperties: false,
        },
        user_agent: {
          type: 'string',
          description:
            'The visitor\'s real User-Agent, if you have it — it is what browser/OS/device attribution is derived from. Defaults to a generic desktop browser (events with a bot-like User-Agent are dropped on purpose).',
        },
        ip: {
          type: 'string',
          description: 'The visitor\'s IP, if you have it. Used only to derive a country and a rotating anonymous id; never stored.',
        },
      },
      ['domain', 'name', 'url'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const name = requiredString(args, 'name');
      const url = requiredString(args, 'url');
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError('`url` must be an absolute http(s) URL, e.g. "https://example.com/checkout/success".');
      }

      const body = {
        name,
        url,
        domain,
        user_agent: optionalString(args, 'user_agent') || SERVER_SIDE_UA,
      };
      if (args.props && typeof args.props === 'object' && !Array.isArray(args.props)) body.props = args.props;
      if (optionalString(args, 'ip')) body.ip = optionalString(args, 'ip');
      if (args.revenue !== undefined && args.revenue !== null) {
        const revenue = typeof args.revenue === 'object' ? args.revenue : { amount: Number(args.revenue) };
        if (!Number.isFinite(Number(revenue.amount))) {
          throw new ToolError('`revenue.amount` must be a number, e.g. {"amount": 49.90, "currency": "EUR"}.');
        }
        body.revenue = { amount: Number(revenue.amount), ...(revenue.currency ? { currency: revenue.currency } : {}) };
      }

      const data = await api('POST', '/api/v1/events', {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body,
      });

      if (data.status !== 'ok') {
        throw new ToolError(
          `the instance ignored the event (${data.reason || 'unknown reason'}). ` +
            `Check that "${domain}" is tracked here (credible_list_sites) and that the URL is absolute.`,
        );
      }
      return [
        `Recorded "${name}" on ${domain} (${new URL(url).pathname}).`,
        body.revenue ? `Revenue: ${body.revenue.amount} ${body.revenue.currency || '(site currency)'}` : null,
        body.props ? `Props: ${JSON.stringify(body.props)}` : null,
        '',
        `It counts towards a goal only if a goal with this exact name exists — create one with credible_create_goal.`,
      ]
        .filter((line) => line !== null)
        .join('\n');
    },
  },
];

/** Shared by credible_realtime and credible_get_stats(period=realtime). */
async function realtimeReport(domain, shared, base) {
  const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/realtime`, shared);
  const visitors = Number(data.visitors || 0);
  if (!visitors) {
    return `Nobody is on ${domain} right now (no events in the last 5 minutes).\nDashboard: ${base}/${domain}`;
  }
  return [
    `${count(visitors, 'visitor')} on ${domain} right now.`,
    '',
    section('Pages they are on', ranked(data.pages, { empty: 'no pageviews in the window' })),
    '',
    `Dashboard: ${base}/${domain}`,
  ].join('\n');
}

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ------------------------------------------------------------- JSON-RPC --

/** Sentinel: this message is a notification, produce no response at all. */
const NO_REPLY = Symbol('no-reply');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const logStderr = (...parts) => process.stderr.write(`[credible-mcp] ${parts.join(' ')}\n`);

function initialize(params) {
  const requested = String(params?.protocolVersion || '');
  return {
    protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      'Credible is self-hosted, privacy-first web analytics. On a fresh instance call credible_provision first: ' +
      'it creates the account and the site and returns an API key (remembered for the session) plus the <script> ' +
      'snippet to install in the site\'s <head>. After editing the website code, call credible_verify_install to ' +
      'confirm events are arriving, then use credible_get_stats, credible_breakdown and credible_realtime to ' +
      'answer questions about the traffic.',
  };
}

async function callTool(params) {
  const name = params?.name;
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    throw new RpcError(-32602, `Unknown tool: ${name}. Call tools/list for the tools this server provides.`);
  }
  const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {};

  try {
    const text = await tool.run(args);
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    // A tool that fails reports it *inside* the result, so the model can read
    // the reason and correct itself, rather than as a JSON-RPC error.
    const message = err instanceof ToolError ? err.message : err?.message || 'unknown error';
    return { content: [{ type: 'text', text: `${tool.name} failed: ${message}` }], isError: true };
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return initialize(params);
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case 'tools/call':
      return callTool(params);
    default:
      // Notifications we do not act on are still legal — swallow them silently.
      if (typeof method === 'string' && method.startsWith('notifications/')) return NO_REPLY;
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: message was not valid JSON' } });
    return;
  }

  if (Array.isArray(message)) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: JSON-RPC batching is not supported by MCP' },
    });
    return;
  }
  if (!message || typeof message !== 'object') {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } });
    return;
  }

  const { id, method, params } = message;
  // A response to something we sent (it has no method): nothing to do.
  if (typeof method !== 'string') return;

  // No id means notification: it must never be answered, not even on failure.
  const isNotification = id === undefined || id === null;

  try {
    const result = await dispatch(method, params || {});
    if (isNotification || result === NO_REPLY) return;
    send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (isNotification) {
      logStderr(`notification ${method} failed:`, err?.message || err);
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: err instanceof RpcError ? err.code : -32603,
        message: err?.message || 'Internal error',
      },
    });
  }
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    // stderr, never stdout: stdout is the protocol transport.
    process.stderr.write(
      [
        'Credible MCP server — stdio transport, JSON-RPC 2.0.',
        '',
        'It is started by an MCP client, not by hand:',
        '  claude mcp add credible --env CREDIBLE_URL=http://localhost:8000 -- node mcp/server.js',
        '',
        'Environment:',
        '  CREDIBLE_URL       instance base URL (default http://localhost:8000)',
        '  CREDIBLE_API_KEY   API key; optional, credible_provision creates one',
        '',
        `Tools: ${TOOLS.map((tool) => tool.name).join(', ')}`,
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  // A client that closes its end mid-write must not crash the server.
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
  });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    // Messages are handled concurrently — JSON-RPC matches responses by id, and
    // a slow tool call must not hold up a ping.
    handleLine(line).catch((err) => logStderr('handler crashed:', err?.stack || err));
  });
  rl.on('close', () => process.exit(0));

  logStderr(`ready — instance ${session.defaultUrl}${session.envKey ? ' (API key from environment)' : ' (no API key yet)'}`);
}

main();
