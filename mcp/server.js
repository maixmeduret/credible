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
 * Everything the dashboard can do is reachable from here — saved segments,
 * graph annotations, path exploration, the all-sites rollup, the traffic
 * shields — because a feature an assistant cannot reach is, for this product,
 * a feature that does not exist. `credible_help` is the map.
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

/**
 * GET an endpoint that only newer instances have.
 *
 * Credible keeps growing, and an assistant will meet instances of several ages.
 * A 404 from one of these is a fact about the instance, not a mistake the model
 * made — and the generic 404 hint ("check the spelling of the domain") would
 * send it hunting for a typo that is not there. The router answers a missing
 * route with exactly `Not found`, while a missing site says `Site not found`,
 * so the two cases stay tellable apart.
 */
async function getOptional(path, opts, { feature, instead = '' }) {
  const result = await request('GET', path, opts);
  if (result.ok) return result.json ?? {};
  if (result.status === 404 && /^not found\.?$/i.test(String(result.json?.error || ''))) {
    throw new ToolError(
      `this Credible instance does not provide ${feature} — GET ${result.url} answered 404 Not found, ` +
        'which means the endpoint is not built into the version running here rather than that anything is wrong ' +
        `with the request. Upgrade the instance to use it.${instead ? ` ${instead}` : ''}`,
    );
  }
  throw httpError(result, 'GET');
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

/**
 * 'YYYY-MM-DD' for an instant, read in the site's own timezone.
 *
 * A period's boundaries come back as the unix seconds of local midnight, so
 * rendering them in UTC names the wrong day for every site that is not on UTC:
 * "today" in Europe/Paris starts at 22:00 UTC the day before. An unusable
 * timezone falls back to UTC rather than throwing.
 */
function localDate(unixSeconds, timeZone = 'UTC') {
  const at = new Date(Number(unixSeconds) * 1000);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

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
 * A fixed-width table. Every row is an array of cells; the caller supplies the
 * header row. The last column is never padded, so nothing trails whitespace.
 */
function table(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, String(cell).length);
    });
  }
  return rows
    .map((row) =>
      row.map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index] + 2))).join(''),
    )
    .join('\n');
}

const OPERATOR_WORDS = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  contains_not: 'does not contain',
  matches: 'matches',
  matches_not: 'does not match',
};

/** True for a list of filters, as opposed to a single one: [[…], […]]. */
const isFilterList = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => Array.isArray(item));

/**
 * One filter as prose: ["is","visit:country",["FR","BE"]] reads
 * "visit:country is FR or BE".
 *
 * Combinators nest another filter where a dimension name would be, and are
 * expanded recursively. Anything whose shape this does not recognise is printed
 * as JSON rather than guessed at: a confidently wrong description of a filter
 * is worse for the reader than the raw thing.
 */
function describeFilter(entry) {
  if (!Array.isArray(entry) || entry.length < 2) return JSON.stringify(entry);
  const [operator, key, values] = entry;

  if (Array.isArray(key)) {
    const inner = isFilterList(key) ? key : [key];
    const parts = inner.map(describeFilter);
    if (operator === 'and') return `(${parts.join(' AND ')})`;
    if (operator === 'or') return `(${parts.join(' OR ')})`;
    if (operator === 'not') return `NOT (${parts.join(' AND ')})`;
    if (operator === 'has_done') return `has at some point: ${parts.join(' AND ')}`;
    if (operator === 'has_not_done') return `has never: ${parts.join(' AND ')}`;
    return JSON.stringify(entry);
  }
  if (typeof key !== 'string') return JSON.stringify(entry);

  const word = OPERATOR_WORDS[operator] || operator;
  const list = (Array.isArray(values) ? values : [values]).map((value) => String(value ?? '')).join(' or ');
  return `${key} ${word} ${list}`.trimEnd();
}

/** Every filter of a segment, one indented line each. */
const describeFilters = (filters, indent = '  ') =>
  (Array.isArray(filters) ? filters : []).map((filter) => `${indent}${describeFilter(filter)}`).join('\n');

/**
 * The list inside a response, under whichever key it arrived.
 *
 * Journeys, the consolidated rollup and imports are being built by other hands
 * while this file is written, so their envelopes are read tolerantly. Returns
 * null — distinct from an empty list — when nothing array-shaped was found, so
 * "the endpoint answered something else" never gets reported as "there is
 * nothing to show".
 */
function pickList(data, keys) {
  return [...keys.map((key) => data?.[key]), data].find(Array.isArray) ?? null;
}

/**
 * A journey tree, level by level.
 *
 * The endpoint returns `steps` as one array per level, each node carrying the
 * parent it came from — so the tree is rebuilt here by grouping a level on
 * `from`, in the order the nodes arrive, which is already the parent's own rank
 * order. Two parents sharing a name therefore stay apart.
 */
function journeyTree(data, requested) {
  const root = data.root || {};
  const backward = data.direction === 'backward';
  const anchor = root.name || (backward ? 'every exit page' : 'every entry page');
  const lines = [
    `${backward ? 'Arriving at' : 'Starting from'} ${anchor} — ${count(root.visitors ?? data.total_visits ?? 0, 'visitor')}`,
  ];

  const levels = data.steps || [];
  if (!levels.some((level) => level.length)) {
    lines.push('', `  (nobody went any further than ${anchor} in this period)`);
    return lines.join('\n');
  }

  levels.forEach((level, index) => {
    if (!Array.isArray(level) || !level.length) return;
    lines.push('', `Step ${index + 1}${backward ? ' back' : ''}`);
    let parent = null;
    for (const node of level) {
      if (node.from !== undefined && node.from !== parent) {
        parent = node.from;
        if (parent) lines.push(`  ${backward ? 'before' : 'after'} ${parent}`);
      }
      const detail = [
        count(node.visitors ?? 0, 'visitor'),
        node.share == null ? '' : `${node.share}%`,
        node.dropoff ? `${node.dropoff}% stopped here` : '',
      ].filter(Boolean);
      lines.push(`    ${node.name}${node.terminal ? ' (end of visit)' : ''} — ${detail.join(', ')}`);
    }
  });

  if (levels.length < requested) {
    lines.push('', `Only ${levels.length} step${levels.length === 1 ? '' : 's'} of the ${requested} asked for had anywhere left to go.`);
  }
  return lines.join('\n');
}

/** Said out loud when a response's shape is not one this tool can read. */
const unrecognised = (header, data) =>
  [
    header,
    '',
    '  This instance answered with a shape this tool does not know how to read, so nothing is',
    '  summarised below rather than something wrong. The raw response starts:',
    '',
    `  ${JSON.stringify(data).slice(0, 400)}`,
  ].join('\n');

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

/** Everything credible_configure_site may write, in the order it reads best. */
const SETTING_FIELDS = [
  'timezone',
  'currency',
  'excluded_paths',
  'excluded_ips',
  'excluded_countries',
  'allowed_hostnames',
  'bot_filtering',
];

/** The settings that hold a list, and so may also arrive as an actual array. */
const LIST_SETTINGS = new Set(['excluded_paths', 'excluded_ips', 'excluded_countries', 'allowed_hostnames']);

/**
 * Read one credible_configure_site field.
 *
 * An empty string is a real value here — it is how a shield is cleared — so
 * presence is what is tested, never truthiness.
 *
 * A list-shaped setting is accepted as an actual array too, the way `filters`
 * is: a model just told "two-letter codes, comma separated" reaches for
 * ["RU","CN"] about as readily as for "RU, CN", and both mean the same thing.
 *
 * Anything else is refused by name rather than dropped. That is the whole
 * point of this function: a value of the wrong type used to fall through the
 * `typeof === 'string'` test silently, so asking to shield two countries got
 * back a cheerful "current settings" listing with no shield set and no error —
 * the one failure mode where the caller is actively misled into believing the
 * traffic is now being filtered.
 */
function settingArg(args, field) {
  const value = args?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim();

  if (Array.isArray(value) && LIST_SETTINGS.has(field)) {
    return value
      .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .join(', ');
  }

  const kind = Array.isArray(value) ? 'an array' : `${/^[aeiou]/.test(typeof value) ? 'an' : 'a'} ${typeof value}`;
  throw new ToolError(
    `\`${field}\` must be a string, not ${kind}.` +
      (LIST_SETTINGS.has(field)
        ? ' Give the list comma separated ("RU, CN") or as an array of strings (["RU","CN"]).'
        : '') +
      (field === 'bot_filtering' ? ' Use "off", "standard" or "strict".' : ''),
  );
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

/**
 * Read and validate a period argument. `name`/`from`/`to` are parameters so the
 * second period of credible_compare_periods is checked by the same code, and
 * complains under its own argument names.
 */
function periodArg(args, { name = 'period', from = 'from', to = 'to', fallback = '7d' } = {}) {
  const period = optionalString(args, name) || fallback;
  if (!PERIODS.includes(period)) {
    throw new ToolError(`unknown ${name} "${period}". Use one of: ${PERIODS.join(', ')}.`);
  }
  if (period === 'custom' && !(args[from] && args[to])) {
    throw new ToolError(`${name} "custom" needs both \`${from}\` and \`${to}\` as YYYY-MM-DD dates.`);
  }
  return period;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function dateArg(args, name) {
  const value = requiredString(args, name, 'Example: "2026-08-16".');
  if (!YMD.test(value)) throw new ToolError(`\`${name}\` must be a date in YYYY-MM-DD form, e.g. "2026-08-16".`);
  return value;
}

/**
 * The `filters` argument, forwarded byte for byte.
 *
 * A model writes filters either as the JSON wire format already encoded, or as
 * the array that format describes; both are accepted and exactly one
 * JSON.stringify separates them. Nothing here inspects operators or dimensions.
 * That is deliberate: filter forms this server has never heard of — nested
 * and/or/not, has_done — must reach the instance intact, so a newer instance
 * can honour them and an older one can answer 422 in its own words instead of
 * this file silently dropping something the user asked for.
 */
function filterArg(args, name = 'filters') {
  const value = args?.[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  return JSON.stringify(value);
}

/**
 * Resolve a `segment` argument to the id the stats endpoints want.
 *
 * An id passes straight through. A name costs one extra request and is worth
 * it: a model that has just read "Mobile France" off a list should not have to
 * go and look its number up before it can use it.
 */
async function segmentRef(args, domain, shared, { required = false } = {}) {
  const raw = args?.segment;
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ToolError('`segment` is required — the id or the exact name of a saved segment. credible_list_segments shows them.');
    return undefined;
  }

  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return value;

  const data = await api('GET', `/api/sites/${encodeURIComponent(domain)}/segments`, shared);
  const segments = data.segments || [];
  const found = segments.find((segment) => String(segment.name).toLowerCase() === value.toLowerCase());
  if (found) return String(found.id);

  throw new ToolError(
    `no segment named "${value}" on ${domain}. ` +
      (segments.length
        ? `Saved segments: ${segments.map((segment) => `"${segment.name}" (id ${segment.id})`).join(', ')}.`
        : 'This site has no saved segments yet — create one with credible_create_segment.'),
  );
}

/** The applied segment, out of the list every dashboard payload carries. */
const segmentFrom = (data, id) => (data.segments || []).find((segment) => String(segment.id) === String(id)) || null;

/** The query parameters every stats endpoint understands. */
const statsQuery = (args, period) => ({
  period,
  date: optionalString(args, 'date'),
  from: optionalString(args, 'from'),
  to: optionalString(args, 'to'),
  filters: filterArg(args),
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
  if (data.api_key) {
    // Remembered under both the URL we dialled and the origin the instance
    // reports for itself: behind a reverse proxy (CREDIBLE_BASE_URL) they
    // differ, and later calls dial the first one.
    session.keys.set(base, data.api_key);
    session.keys.set(instanceUrl, data.api_key);
  }

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

  // The legacy endpoints never report the instance's own origin, but the
  // snippet they build carries it — and behind a reverse proxy it is not the
  // URL we dialled. Follow the snippet, so the origin in the reply, the
  // dashboard link and the script tag can never disagree with each other. This
  // is what /api/v1/provision does for itself with `instance_url`.
  const origin = originOfSnippet(snippet) || base;

  return {
    user,
    password: createdUser && !suppliedPassword ? password : null,
    api_key: apiKey,
    site,
    snippet,
    instance_url: origin,
    dashboard_url: site ? `${origin}/${site.domain}` : null,
    created: { user: createdUser, site: Boolean(site) },
  };
}

/** The origin a returned snippet loads the tracker from, or '' if unreadable. */
function originOfSnippet(snippet) {
  const match = /\bsrc="(https?:\/\/[^"]+)\/js\/cr\.js"/i.exec(String(snippet || ''));
  return match ? normalizeBase(match[1]) : '';
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
    'Time range to report on. "day" is today, "7d"/"28d"/"30d"/"91d" are trailing windows, "month"/"last_month"/"year" are calendar periods, "all" is everything ever recorded, "custom" requires from and to. "realtime" is the live window — credible_get_stats switches to the who-is-on-the-site-now view (last 5 minutes), credible_breakdown ranks the last 30 minutes. Defaults to 7d.',
};

/**
 * The filters argument, written once because it is the hardest thing in this
 * schema to get right from memory — and because the syntax people expect (the
 * Plausible one) is the syntax Credible rejects.
 */
const FILTERS_PROP = {
  type: 'string',
  description:
    'Narrow every number to a subset of traffic. A JSON string (an actual array is accepted too) holding [operator, dimension, values] triples, e.g. ' +
    '[["is","visit:country",["FR","BE"]],["contains","event:page",["/blog"]]] — entries are ANDed together, values inside one entry are ORed. ' +
    'Operators: is, is_not, contains, contains_not, matches, matches_not (matches is a glob: * and ?, not a regex). ' +
    'Dimensions are the same names credible_breakdown groups by, plus event:goal. ' +
    'A triple can be replaced by a branch: ["and",[<node>,<node>]], ["or",[<node>,<node>]], ["not",<node>], ' +
    '["has_done",<node>] for visitors who matched it at any point in the period rather than on the event being counted, and ["has_not_done",<node>] for those who never did. ' +
    '"Visitors from France who saw pricing but never signed up" is [["is","visit:country",["FR"]],["has_done",["is","event:page",["/pricing"]]],["has_not_done",["is","event:goal",["Signup"]]]]. ' +
    'Whatever you pass is forwarded to the instance untouched, so an older instance that does not know a form says so with a 422 rather than quietly ignoring it. ' +
    'Plausible\'s string syntax ("visit:country==FR;visit:source!=Google") is NOT accepted and returns "filters must be valid JSON".',
};

const SEGMENT_PROP = {
  type: 'string',
  description:
    'Apply a saved segment on top of any filters above — its id, or its exact name. credible_list_segments shows both. Optional.',
};

const RANGE_PROPS = {
  from: { type: 'string', description: 'Start date (YYYY-MM-DD). Only used when period is "custom".' },
  to: { type: 'string', description: 'End date, inclusive (YYYY-MM-DD). Only used when period is "custom".' },
  date: { type: 'string', description: 'Anchor date (YYYY-MM-DD) that the period is measured from. Defaults to today.' },
  filters: FILTERS_PROP,
  segment: SEGMENT_PROP,
};

const schema = (properties, required = []) => ({
  type: 'object',
  properties: { ...properties, ...CONNECTION_PROPS },
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: 'credible_help',
    description:
      'A one-call map of everything this server can do, grouped by the question you are trying to answer, plus which instance it is pointed at and whether it has a credential yet. Call it when you have just been given this server mid-conversation and need to know what is on offer, when you are unsure which tool fits a request, or before telling someone that Credible cannot do something. It makes no network request, so it answers even when the instance is down.',
    inputSchema: schema({}),
    run: (args) => {
      const base = baseUrl(args);
      const key = keyFor(args);
      return [
        'Credible — self-hosted, privacy-first web analytics. This server drives an instance end to end:',
        'set it up, install it, verify it, and read and explain the numbers.',
        '',
        block([
          ['Instance', base],
          ['Credential', key ? `${key.slice(0, 12)}… (in use for every call)` : 'none yet — call credible_provision, or set CREDIBLE_API_KEY'],
        ]),
        '',
        section(
          'Set it up',
          block([
            ['  credible_provision', 'fresh instance -> account, site, API key, <script> snippet. Start here.'],
            ['  credible_list_sites', 'what this key can already see'],
            ['  credible_add_site', 'another domain on an instance already set up'],
            ['  credible_get_snippet', 'the exact <script> tag for a site'],
            ['  credible_verify_install', 'is data arriving yet? Call it after editing the site'],
            ['  credible_configure_site', 'timezone, excluded paths/IPs/countries, hostname allow-list, bot filtering'],
            ['  credible_import_status', 'historical imports and how far along they are'],
          ]),
        ),
        '',
        section(
          'Read the numbers',
          block([
            ['  credible_get_stats', 'headline metrics plus top sources, pages and countries'],
            ['  credible_compare_periods', 'the same question over two periods, side by side'],
            ['  credible_breakdown', 'rank one dimension: source, page, country, device, goal, custom property'],
            ['  credible_realtime', 'who is on the site right now'],
            ['  credible_journey', 'the paths visitors take from page to page'],
            ['  credible_consolidated', 'every site on the instance in one rollup'],
          ]),
        ),
        '',
        section(
          'Narrow and explain them',
          block([
            ['  filters', 'on any stats tool: [["is","visit:country",["FR"]]] — see the argument description'],
            ['  credible_list_segments', 'filter sets somebody already named and saved'],
            ['  credible_create_segment', 'name a filter set so it can be reused'],
            ['  credible_apply_segment', 'run the dashboard through a saved segment'],
            ['  credible_list_annotations', 'dated notes explaining what happened on the graph'],
            ['  credible_add_annotation', 'record one: "we shipped X on this day"'],
          ]),
        ),
        '',
        section(
          'Measure and share',
          block([
            ['  credible_create_goal', 'count a signup, a purchase, a page reached'],
            ['  credible_create_funnel', '2-8 goals in order, to see where people drop out'],
            ['  credible_track_event', 'record a conversion server-side, with props and revenue'],
            ['  credible_share_dashboard', 'a public, optionally password-protected link'],
          ]),
        ),
        '',
        `Periods: ${PERIODS.join(' ')} (custom needs from and to).`,
        'Every tool also takes instance_url and api_key, which override the environment for that one call —',
        'that is how one registered server answers questions about staging and production in the same conversation.',
        '',
        'Knowing nothing about a site, this is usually the order: credible_list_sites, credible_get_stats,',
        'then credible_breakdown on whatever looked surprising.',
      ].join('\n');
    },
  },

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
        `${count(site.current_visitors || 0, 'visitor')} right now · ${site.timezone} · ${site.currency}${site.public ? ' · public dashboard' : ''}`,
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
    name: 'credible_configure_site',
    description:
      "Read or change a site's settings and its traffic shields. Call it with only `domain` to see how the site is configured; pass any other argument to change that one thing and leave the rest alone. " +
      'Reach for it when the numbers are wrong for a reason that is not the tracker: your own team inflating them (excluded_ips), an admin area nobody should measure (excluded_paths), ' +
      'a staging copy or a scraper mirror sending events under your data-domain (allowed_hostnames — an allow-list, so setting it rejects every hostname not on it), ' +
      'a country sending nothing but junk (excluded_countries), or bots still getting through (bot_filtering: "strict" also drops headless and unknown clients). ' +
      'Shields drop traffic at ingestion and are not retroactive — data already counted stays counted. Changing the timezone re-buckets every report from that point on. ' +
      'To clear a setting, pass it as an empty string. This tool cannot make a dashboard public: use credible_share_dashboard for a read-only link.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        timezone: {
          type: 'string',
          description: 'IANA timezone the reports are bucketed in, e.g. "Europe/Paris". Days start and end in this zone.',
        },
        currency: { type: 'string', description: 'Three-letter currency for revenue goals, e.g. "USD".' },
        excluded_paths: {
          type: 'string',
          description:
            'Paths never to record, comma or newline separated (an actual array of strings is accepted too). "*" matches within one segment and "**" across them, e.g. "/admin/**, /preview/*".',
        },
        excluded_ips: {
          type: 'string',
          description:
            'IP addresses never to record, comma separated (an actual array of strings is accepted too) — your office and your own machine, e.g. "203.0.113.7, 198.51.100.4".',
        },
        excluded_countries: {
          type: 'string',
          description:
            'Two-letter country codes to drop on arrival, comma separated (an actual array of strings is accepted too), e.g. "RU, CN". Traffic with no known country is never dropped by this.',
        },
        allowed_hostnames: {
          type: 'string',
          description:
            'Hostname allow-list, comma separated (an actual array of strings is accepted too), e.g. "example.com, *.example.com". When set, events from any other hostname are dropped — leave it empty to accept all.',
        },
        bot_filtering: {
          type: 'string',
          enum: ['off', 'standard', 'strict'],
          description: '"standard" is the default User-Agent based filtering, "strict" also drops headless and unrecognised clients, "off" counts everything.',
        },
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };

      const patch = {};
      for (const field of SETTING_FIELDS) {
        const value = settingArg(args, field);
        if (value !== undefined) patch[field] = value;
      }
      if (patch.bot_filtering !== undefined && !['off', 'standard', 'strict'].includes(patch.bot_filtering)) {
        throw new ToolError('`bot_filtering` must be "off", "standard" or "strict".');
      }

      if (Object.keys(patch).length) {
        await api('PATCH', `/api/sites/${encodeURIComponent(domain)}`, { ...shared, body: patch });
      }

      const detail = await api('GET', `/api/sites/${encodeURIComponent(domain)}`, shared);
      const current = { ...(detail.settings || {}), ...(detail.site || {}) };

      // Older instances do not report every shield back. Never present a value
      // as confirmed when it was only accepted: say which is which.
      const unconfirmed = [];
      const value = (field) => {
        if (current[field] !== undefined && current[field] !== null) return String(current[field]) || '(none)';
        if (patch[field] !== undefined) {
          unconfirmed.push(field);
          return `${patch[field] || '(none)'}  (applied)`;
        }
        return null;
      };

      const lines = [
        `${domain} — ${Object.keys(patch).length ? `${Object.keys(patch).length} setting${Object.keys(patch).length === 1 ? '' : 's'} updated` : 'current settings'}`,
        '',
        block([
          ['Timezone', value('timezone')],
          ['Currency', value('currency')],
          ['Excluded paths', value('excluded_paths')],
          ['Excluded IPs', value('excluded_ips')],
          ['Excluded countries', value('excluded_countries')],
          ['Allowed hostnames', value('allowed_hostnames')],
          ['Bot filtering', value('bot_filtering')],
          ['Public dashboard', current.public ? 'yes — anyone with the URL can read it' : 'no'],
        ]),
      ];

      const silent = SETTING_FIELDS.filter((field) => current[field] === undefined || current[field] === null);
      if (silent.length) {
        lines.push(
          '',
          `This instance does not report ${silent.join(', ')} back in its site payload, so ${unconfirmed.length ? 'the values marked "(applied)" were accepted by the update but cannot be read back to confirm, and ' : ''}` +
            'any value already set for them is not shown above.',
        );
      }
      if (patch.timezone) {
        lines.push('', `Reports for ${domain} are now bucketed in ${patch.timezone}. Past days are re-cut to that zone, so yesterday's totals may shift slightly.`);
      }
      return lines.join('\n');
    },
  },

  {
    name: 'credible_import_status',
    description:
      'List the historical data imports for a site and how far each has got. Use it to answer "is my old analytics data in yet?", to explain a sudden wall of history in the graph, or to check whether a period is complete before drawing conclusions from it — a range that is still importing is not a range you should compare against anything.',
    inputSchema: schema({ domain: DOMAIN_PROP }, ['domain']),
    run: async (args) => {
      const domain = domainArg(args);
      const data = await getOptional(
        `/api/sites/${encodeURIComponent(domain)}/imports`,
        { instance_url: args.instance_url, apiKey: requireKey(args) },
        {
          feature: 'historical imports',
          instead: 'Until then, every number for this site comes from events it recorded itself.',
        },
      );

      const imports = pickList(data, ['imports', 'results']);
      if (!imports) return unrecognised(`Imports on ${domain}`, data);
      if (!imports.length) {
        return `No imports on ${domain}. Every number for this site comes from events it recorded itself.`;
      }

      const rows = imports.map((entry, index) => {
        const label = `${entry.id ? `#${entry.id} ` : ''}${entry.source || entry.provider || 'import'}`;
        const status = entry.status || entry.state || 'unknown status';
        const from = entry.from_date || entry.from;
        const written = entry.events_written ?? entry.events ?? entry.rows;
        const parts = [
          entry.error ? `${status}: ${entry.error}` : status,
          from ? `${from} to ${entry.to_date || entry.to || 'now'}` : '',
          written == null ? '' : count(written, 'event'),
          entry.aggregates_written ? `${fmt(entry.aggregates_written)} daily rollup rows` : '',
          entry.rows_read == null ? '' : `${fmt(entry.rows_read)} rows read`,
          entry.finished_at ? `finished ${isoStamp(entry.finished_at)}` : entry.started_at ? `started ${isoStamp(entry.started_at)}` : '',
        ];
        return `  ${String(index + 1).padStart(2)}. ${label} — ${parts.filter(Boolean).join(', ')}`;
      });

      const lines = [`${imports.length} import${imports.length === 1 ? '' : 's'} on ${domain}`, '', rows.join('\n')];
      const running = imports.filter((entry) => String(entry.status || '').toLowerCase() === 'running');
      if (running.length) {
        lines.push(
          '',
          `${running.length} import${running.length === 1 ? ' is' : 's are'} still running. Any period it covers is incomplete — the numbers there will keep moving, so do not compare against them yet.`,
        );
      }
      const failed = imports.filter((entry) => String(entry.status || '').toLowerCase() === 'failed');
      if (failed.length) {
        lines.push('', `${failed.length} failed. A failed import leaves a gap in the history, not a wrong number: the range it covers is simply missing.`);
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

      const segment = await segmentRef(args, domain, shared);
      const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/dashboard`, {
        ...shared,
        query: { ...statsQuery(args, period), segment },
      });

      const notes = [];
      const filters = filterArg(args);
      if (filters) notes.push(`Filtered by: ${filters}`);
      if (segment) {
        const applied = segmentFrom(data, segment);
        notes.push(`Segment applied: ${applied ? `"${applied.name}" (${describeFilters(applied.filters, '').replace(/\n/g, '; ')})` : `#${segment}`}`);
      }

      return dashboardReport({ domain, period, data, base: baseUrl(args), notes });
    },
  },

  {
    name: 'credible_compare_periods',
    description:
      'Run the same question over two periods and lay the answers side by side, with the change on every metric. This is the tool for "how does this month compare with last month?", "are we better off than a year ago?", "did the redesign help?" — anything where the interesting number is a difference rather than a level. ' +
      'Both periods can be anything, including two custom ranges, so it also answers "the fortnight after launch against the fortnight before". Filters and a segment apply to both sides, which is what makes a fair comparison. ' +
      'For the simple "against the period immediately before" case, credible_get_stats with comparison=previous_period is one call instead of two.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        period: PERIOD_PROP,
        compare_period: {
          type: 'string',
          enum: PERIODS.filter((period) => period !== 'realtime'),
          description: 'The period to compare against, e.g. "last_month" or "custom" with compare_from and compare_to. Required.',
        },
        compare_from: { type: 'string', description: 'Start date (YYYY-MM-DD) of the comparison period. Only used when compare_period is "custom".' },
        compare_to: { type: 'string', description: 'End date, inclusive (YYYY-MM-DD) of the comparison period. Only used when compare_period is "custom".' },
        compare_date: { type: 'string', description: 'Anchor date (YYYY-MM-DD) the comparison period is measured from. Defaults to today.' },
        ...RANGE_PROPS,
      },
      ['domain', 'compare_period'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const period = periodArg(args);
      if (!optionalString(args, 'compare_period')) {
        throw new ToolError(
          '`compare_period` is required — the period to compare against, e.g. "last_month". ' +
            'For the period immediately before this one, credible_get_stats with comparison=previous_period does it in a single call.',
        );
      }
      const against = periodArg(args, { name: 'compare_period', from: 'compare_from', to: 'compare_to', fallback: '' });
      if (period === 'realtime' || against === 'realtime') {
        throw new ToolError('"realtime" is a live window, not a range, so there is nothing to compare it with. Use credible_realtime for who is on the site now.');
      }

      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };
      const segment = await segmentRef(args, domain, shared);
      const query = { ...statsQuery(args, period), segment, comparison: undefined };
      const path = `/api/stats/${encodeURIComponent(domain)}/dashboard`;

      const [left, right] = await Promise.all([
        api('GET', path, { ...shared, query }),
        api('GET', path, {
          ...shared,
          query: {
            ...query,
            period: against,
            date: optionalString(args, 'compare_date'),
            from: optionalString(args, 'compare_from'),
            to: optionalString(args, 'compare_to'),
          },
        }),
      ]);

      const a = left.metrics || {};
      const b = right.metrics || {};
      const currency = left.site?.currency || '';
      const rows = [['', period, against, 'Change']];
      for (const [key, label, render] of COMPARED_METRICS) {
        rows.push([label, render(a[key], currency), render(b[key], currency), delta(key, a[key], b[key])]);
      }
      if (a.revenue || b.revenue) {
        rows.push(['Revenue', money(a.revenue, currency), money(b.revenue, currency), delta('revenue', a.revenue, b.revenue)]);
      }

      const notes = [];
      const filters = filterArg(args);
      if (filters) notes.push(`Both sides filtered by: ${filters}`);
      if (segment) {
        const applied = segmentFrom(left, segment);
        notes.push(`Both sides through segment ${applied ? `"${applied.name}"` : `#${segment}`}`);
      }

      return [
        `${domain} — ${period} compared with ${against}`,
        '',
        visitorSentence(a.visitors, period, b.visitors, against),
        '',
        table(rows),
        '',
        block([
          [period, rangeLabel(left.period)],
          [against, rangeLabel(right.period)],
        ]),
        ...(notes.length ? ['', notes.join('\n')] : []),
        '',
        `Change reads ${period} against ${against}. Full dashboard: ${baseUrl(args)}/${domain}`,
      ].join('\n');
    },
  },

  {
    name: 'credible_breakdown',
    description:
      'Group traffic by one dimension and rank it — the tool for "where do my visitors come from?", "which pages are most read?", "which countries?", "how are my goals converting?". Returns the ranked list with visitors, visits and pageviews for each entry. ' +
      'Reach for it after credible_get_stats whenever a headline number needs explaining: the totals say what happened, a breakdown says who or what it happened through. Narrow it with filters or a segment to ask the same question of one slice of the traffic.',
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
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };

      const segment = await segmentRef(args, domain, shared);
      const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/breakdown`, {
        ...shared,
        query: { ...statsQuery(args, period), dimension, limit, segment },
      });

      const filters = filterArg(args);
      const narrowed = [filters ? `filtered: ${filters}` : '', segment ? `segment: ${segment}` : ''].filter(Boolean).join(', ');
      const results = data.results || [];
      const lines = [
        `${domain} — ${dimension} over ${period}${narrowed ? ` (${narrowed})` : ''}`,
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
    name: 'credible_journey',
    description:
      'Path exploration: the routes visitors actually take through the site, ranked by how many took each one. Use it for "what do people do after landing on the blog?", "how do the ones who convert get there?", "where do people go instead of the pricing page?" — questions about sequence, which a page ranking cannot answer because it counts each page in isolation. ' +
      'Anchor it with start_page to follow visitors forward from a page, end_page to trace backwards from a destination, or both to see the routes between them; with neither, it returns the most common journeys on the site. ' +
      'Journeys are within a single visit only — Credible keeps nothing that could link one visitor across days, so there is no cross-session path and never will be.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        start_page: { type: 'string', description: 'Only journeys that begin at this path, e.g. "/blog/launch". Optional.' },
        end_page: { type: 'string', description: 'Only journeys that reach this path, e.g. "/signup". Optional; combine with start_page for the routes between two pages.' },
        steps: {
          type: 'integer',
          minimum: 2,
          maximum: 10,
          description: 'How many pages deep each journey goes. Defaults to 3 — more steps means longer, rarer paths with smaller counts.',
        },
        group_directories: {
          type: 'boolean',
          description: 'Fold pages under a shared directory together, so /blog/a and /blog/b both count as /blog/*. Use it on sites with many URLs, where every path would otherwise be unique and every journey a count of one.',
        },
        period: PERIOD_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many branches to keep per step, and how many whole paths to rank. Defaults to 10.' },
        ...RANGE_PROPS,
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const period = periodArg(args);
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };
      const steps = Number.isInteger(args.steps) ? Math.min(Math.max(args.steps, 2), 10) : 3;
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 10;

      const data = await getOptional(
        `/api/stats/${encodeURIComponent(domain)}/journey`,
        {
          ...shared,
          query: {
            ...statsQuery(args, period),
            segment: await segmentRef(args, domain, shared),
            start_page: optionalString(args, 'start_page'),
            end_page: optionalString(args, 'end_page'),
            steps,
            limit,
            // Only sent when asked for: an explicit `false` in the query string
            // would read like a decision the model made rather than a default.
            group_directories: args.group_directories === true ? 'true' : undefined,
          },
        },
        {
          feature: 'path exploration',
          instead:
            'In the meantime, credible_breakdown on visit:entry_page and visit:exit_page shows where visits start and end, which answers some of the same questions one step at a time.',
        },
      );

      const anchors = [
        optionalString(args, 'start_page') ? `from ${optionalString(args, 'start_page')}` : '',
        optionalString(args, 'end_page') ? `to ${optionalString(args, 'end_page')}` : '',
      ].filter(Boolean).join(' ');
      const header = `${domain} — journeys over ${period}${anchors ? ` ${anchors}` : ''} (${steps} steps)`;

      // Two answers are possible and both are useful: a tree of what happened
      // after (or before) one page, and a flat ranking of whole paths. Render
      // whichever arrived, and both when the endpoint sends both.
      const parts = [header];
      const tree = Array.isArray(data.steps) && data.steps.every(Array.isArray) ? data : null;
      const paths = pickList(data, ['paths', 'journeys', 'results']);
      if (!tree && !paths) return unrecognised(header, data);

      if (tree) parts.push('', journeyTree(tree, steps));
      if (paths?.length) {
        parts.push(
          '',
          section(
            'Most travelled paths',
            paths
              .slice(0, limit)
              .map((path, index) => {
                const walked = Array.isArray(path.steps)
                  ? path.steps.map((step) => (typeof step === 'string' ? step : step?.name ?? JSON.stringify(step))).join(' -> ')
                  : path.path || path.name || JSON.stringify(path);
                const detail = [
                  path.visitors == null ? '' : count(path.visitors, 'visitor'),
                  path.share == null ? '' : `${path.share}%`,
                  path.converted ? 'converted' : '',
                ].filter(Boolean);
                return `  ${String(index + 1).padStart(2)}. ${walked}${detail.length ? ` — ${detail.join(', ')}` : ''}`;
              })
              .join('\n'),
          ),
        );
      }
      if (!tree && !paths.length) {
        parts.push('', `  (no journey reached ${steps} steps in this period — try fewer steps, a longer period, or drop the anchors)`);
      }
      if (data.truncated) {
        parts.push('', 'Too many visits to follow all of them: this is the shape of a sample, not every path.');
      }

      parts.push('', `Full dashboard: ${baseUrl(args)}/${domain}`);
      return parts.join('\n');
    },
  },

  {
    name: 'credible_consolidated',
    description:
      'One rollup across every site on the instance, ranked, with the totals. Use it when the question is about the whole account rather than one domain — "how is everything doing this month?", "which of my sites is growing?", "where did the traffic go?" — and as the first call when you do not yet know which site matters. It saves calling credible_get_stats once per domain, and unlike credible_list_sites it reports a period rather than only who is on each site this second.',
    // No `segment` here: a segment belongs to one site, so there is nothing it
    // could mean across all of them. Declaring it would be inviting the model to
    // pass something this tool then quietly ignores.
    inputSchema: schema({
      period: PERIOD_PROP,
      from: RANGE_PROPS.from,
      to: RANGE_PROPS.to,
      date: RANGE_PROPS.date,
      filters: FILTERS_PROP,
    }),
    run: async (args) => {
      const period = periodArg(args);
      const base = baseUrl(args);
      const data = await getOptional(
        '/api/stats/consolidated',
        { instance_url: args.instance_url, apiKey: requireKey(args), query: statsQuery(args, period) },
        {
          feature: 'the consolidated all-sites view',
          instead: 'In the meantime, credible_list_sites gives the site list and credible_get_stats gives each one its numbers.',
        },
      );

      const sites = pickList(data, ['sites', 'results']);
      if (!sites) return unrecognised(`All sites on ${base} — ${period}`, data);
      if (!sites.length) return `No sites to roll up on ${base}. Add one with credible_add_site.`;

      const rows = sites.map((site, index) => {
        const name = site.domain || site.name || '(unnamed)';
        const parts = [count(site.visitors ?? 0, 'visitor')];
        if (site.pageviews !== undefined) parts.push(count(site.pageviews, 'pageview'));
        if (site.bounce_rate !== undefined) parts.push(`${site.bounce_rate}% bounce`);
        if (site.change != null) parts.push(changeLabel(site.change));
        if (site.current_visitors) parts.push(`${fmt(site.current_visitors)} on site now`);
        if (site.revenue) parts.push(`${money(site.revenue, data.currency || '')} revenue`);
        return `  ${String(index + 1).padStart(2)}. ${name} — ${parts.join(', ')}`;
      });

      const totals = data.totals || data.metrics || null;
      const lines = [`All sites on ${base} — ${period}`, '', rows.join('\n')];

      if (totals) {
        lines.push(
          '',
          block([
            ['Total visitors', fmt(totals.visitors)],
            ['Total visits', totals.visits === undefined ? null : fmt(totals.visits)],
            ['Total pageviews', totals.pageviews === undefined ? null : fmt(totals.pageviews)],
            ['Bounce rate', totals.bounce_rate === undefined ? null : `${totals.bounce_rate}%`],
            ['Visit duration', totals.visit_duration === undefined ? null : humanDuration(totals.visit_duration)],
            ['Total revenue', totals.revenue ? money(totals.revenue, data.currency || '') : null],
            ['On site now', totals.current_visitors === undefined ? null : fmt(totals.current_visitors)],
            ['Sites', fmt(sites.length)],
          ]),
        );
      } else {
        lines.push('', `${sites.length} site${sites.length === 1 ? '' : 's'}.`);
      }

      if (data.top_pages?.length) {
        lines.push(
          '',
          section(
            'Top pages across every site',
            data.top_pages
              .slice(0, 10)
              .map((page, index) => `  ${String(index + 1).padStart(2)}. ${page.name}${page.site ? ` (${page.site})` : ''} — ${count(page.visitors ?? 0, 'visitor')}`)
              .join('\n'),
          ),
        );
      }
      if (data.top_sources?.length) {
        lines.push('', section('Top sources across every site', ranked(data.top_sources)));
      }

      // A rollup is the one view whose caveats change the meaning of the
      // numbers — mixed timezones, and a person counted once per site. The
      // instance writes them; passing them on is not optional.
      const notes = Array.isArray(data.notes) && data.notes.length
        ? data.notes
        : [data.timezone_note, data.visitors_note].filter(Boolean);
      if (notes.length) {
        lines.push('', section('Read these numbers with:', notes.map((note) => `  ${note}`).join('\n')));
      }
      return lines.join('\n');
    },
  },

  {
    name: 'credible_list_segments',
    description:
      'List the saved segments on a site — filter sets somebody has already named, like "Mobile France" or "Came from Hacker News". Call it before building filters by hand: if the segment already exists, applying it asks exactly the question the site owner considers meaningful, and the name is what they will recognise in your answer. Also the way to find the id or name that credible_apply_segment needs. Segments are either site-wide (everyone sees them) or personal to whoever saved them.',
    inputSchema: schema({ domain: DOMAIN_PROP }, ['domain']),
    run: async (args) => {
      const domain = domainArg(args);
      const data = await api('GET', `/api/sites/${encodeURIComponent(domain)}/segments`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
      });

      const segments = data.segments || [];
      if (!segments.length) {
        return `No saved segments on ${domain}. Create one with credible_create_segment, or filter ad hoc with the \`filters\` argument on credible_get_stats.`;
      }

      const blocks = segments.map((segment) => {
        const owner = segment.scope === 'site' ? 'site-wide' : `personal to ${segment.owner_email || 'its owner'}`;
        return [`  #${segment.id}  "${segment.name}"  (${owner})`, describeFilters(segment.filters, '        ')].join('\n');
      });

      return [
        `${segments.length} saved segment${segments.length === 1 ? '' : 's'} on ${domain}`,
        '',
        blocks.join('\n\n'),
        '',
        'Apply one with credible_apply_segment, or pass its id or name as `segment` to credible_get_stats, credible_breakdown or credible_compare_periods.',
      ].join('\n');
    },
  },

  {
    name: 'credible_create_segment',
    description:
      'Save a set of filters under a name so it can be reused in one argument instead of rebuilt every time. Use it when you have just worked out a filter combination that answers a question the owner will ask again — "paying customers from the newsletter", "everyone who reached checkout" — or when they describe an audience in words and you want that definition written down where the dashboard can see it too. ' +
      'scope "site" shares it with everyone who can see the site; "personal" (the default) keeps it to the account this API key belongs to. The filters are validated on the way in, so a segment can never be the thing that breaks a query later.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        name: { type: 'string', description: 'What this audience is called, in the owner\'s words, e.g. "Mobile visitors from France". Up to 120 characters.' },
        filters: {
          type: 'array',
          items: { type: 'array' },
          description:
            'The filters this segment stands for, as [operator, dimension, values] triples: [["is","visit:country",["FR"]],["is","visit:device",["Mobile"]]]. At least one is required. Same operators and dimensions as the filters argument elsewhere.',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'site'],
          description: '"site" makes it visible to everyone with access to the site; "personal" (default) keeps it to this account.',
        },
      },
      ['domain', 'name', 'filters'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const name = requiredString(args, 'name');
      const scope = optionalString(args, 'scope') || 'personal';
      if (!['personal', 'site'].includes(scope)) throw new ToolError('`scope` must be "personal" or "site".');

      const filters = filterArg(args);
      if (!filters) {
        throw new ToolError(
          'a segment needs `filters` — at least one [operator, dimension, values] triple, e.g. [["is","visit:country",["FR"]]]. A segment with no filters would just be the whole site.',
        );
      }

      const data = await api('POST', `/api/sites/${encodeURIComponent(domain)}/segments`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        // The filters go over the wire in the same JSON the query string uses,
        // so a form this server does not recognise is the instance's to judge.
        body: { name, filters, scope },
      });

      const segment = data.segment || {};
      return [
        `Segment #${segment.id} "${segment.name || name}" saved on ${domain} (${segment.scope === 'site' ? 'site-wide' : 'personal to this account'}).`,
        '',
        describeFilters(segment.filters, '  '),
        '',
        `Apply it with credible_apply_segment, or pass segment: ${segment.id} to credible_get_stats, credible_breakdown or credible_compare_periods.`,
      ].join('\n');
    },
  },

  {
    name: 'credible_apply_segment',
    description:
      'Run the dashboard through a saved segment and summarise what that audience did: the headline metrics plus their top sources, pages and countries. Use it whenever the question is about a named group rather than everybody — "how are our French mobile visitors doing?" — and after credible_create_segment to show what you just defined. ' +
      'The segment stacks on top of any filters you also pass, so you can narrow a saved audience further without editing it. Give the segment by id or by its exact name; credible_list_segments has both.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        period: PERIOD_PROP,
        ...RANGE_PROPS,
        // After the spread: here the segment is the whole point, not an option.
        segment: {
          type: 'string',
          description: 'The saved segment to apply: its id, or its exact name. Required. credible_list_segments shows what exists.',
        },
      },
      ['domain', 'segment'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const period = periodArg(args);
      if (period === 'realtime') {
        throw new ToolError('the live view is not segmented — use credible_realtime for who is on the site now, or pick a period like "day" or "7d".');
      }

      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };
      const id = await segmentRef(args, domain, shared, { required: true });
      const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/dashboard`, {
        ...shared,
        query: { ...statsQuery(args, period), segment: id },
      });

      const applied = segmentFrom(data, id);
      const prefix = [
        `Through segment ${applied ? `"${applied.name}" (#${applied.id}, ${applied.scope === 'site' ? 'site-wide' : 'personal'})` : `#${id}`}:`,
        applied ? describeFilters(applied.filters, '  ') : '  (this account cannot see the segment definition, only its effect)',
      ];
      const filters = filterArg(args);
      return dashboardReport({
        domain,
        period,
        data,
        base: baseUrl(args),
        prefix,
        notes: filters ? [`Narrowed further by: ${filters}`] : [],
      });
    },
  },

  {
    name: 'credible_list_annotations',
    description:
      'Read the dated notes recorded against a site — deploys, launches, campaigns, outages. Call it before explaining any spike, dip or trend: an annotation turns "traffic tripled on the 14th" into "traffic tripled when we hit the front page of Hacker News", and guessing at a cause that is already written down is the easiest mistake to avoid here. With no period or dates it returns every annotation the site has.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        period: {
          type: 'string',
          enum: PERIODS,
          description: 'Only annotations inside this period, resolved in the site\'s own timezone. Leave it out, with from and to, to get every annotation.',
        },
        from: { type: 'string', description: 'Earliest date to include (YYYY-MM-DD). Can be used without a period.' },
        to: { type: 'string', description: 'Latest date to include, inclusive (YYYY-MM-DD). Can be used without a period.' },
      },
      ['domain'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const shared = { instance_url: args.instance_url, apiKey: requireKey(args) };
      const from = optionalString(args, 'from');
      const to = optionalString(args, 'to');
      const period = optionalString(args, 'period');
      if (period && !PERIODS.includes(period)) {
        throw new ToolError(`unknown period "${period}". Use one of: ${PERIODS.join(', ')}.`);
      }

      let annotations;
      let scopeLabel;
      if (!from && !to && period && period !== 'all') {
        // A period only means anything once it has been resolved in the site's
        // timezone, and the dashboard endpoint does exactly that resolution
        // before clipping the annotations to it. Asking it is one request and
        // cannot disagree with the graph the notes are drawn on.
        const data = await api('GET', `/api/stats/${encodeURIComponent(domain)}/dashboard`, {
          ...shared,
          query: { period },
        });
        annotations = data.annotations || [];
        scopeLabel = `${period}, ${rangeLabel(data.period)}`;
      } else {
        const data = await api('GET', `/api/sites/${encodeURIComponent(domain)}/annotations`, {
          ...shared,
          query: { from, to },
        });
        annotations = data.annotations || [];
        scopeLabel = from || to ? `${from || 'the beginning'} to ${to || 'today'}` : 'all time';
      }

      if (!annotations.length) {
        return `No annotations on ${domain} for ${scopeLabel}. Record one with credible_add_annotation so the next person reading this graph knows what happened.`;
      }
      return [
        `${annotations.length} annotation${annotations.length === 1 ? '' : 's'} on ${domain} — ${scopeLabel}`,
        '',
        block(annotations.map((note) => [note.date, `${note.text}${note.author_email ? `  — ${note.author_email}` : ''}`])),
      ].join('\n');
    },
  },

  {
    name: 'credible_add_annotation',
    description:
      'Record a dated note on a site\'s graph: "shipped the new pricing page", "Hacker News front page", "CDN outage", "ad campaign started". Use it the moment you do something that could move the numbers — right after you deploy a change, launch a campaign, or fix an outage — so that next month\'s spike still has its explanation attached instead of being re-investigated from scratch. Notes are visible to everyone who can see the site.',
    inputSchema: schema(
      {
        domain: DOMAIN_PROP,
        date: { type: 'string', description: 'The day it happened, YYYY-MM-DD, in the site\'s timezone, e.g. "2026-08-16".' },
        text: { type: 'string', description: 'What happened, in one line someone will understand in six months, e.g. "Shipped the redesigned pricing page". Up to 500 characters.' },
      },
      ['domain', 'date', 'text'],
    ),
    run: async (args) => {
      const domain = domainArg(args);
      const date = dateArg(args, 'date');
      const text = requiredString(args, 'text', 'Example: "Shipped the redesigned pricing page".');

      const data = await api('POST', `/api/sites/${encodeURIComponent(domain)}/annotations`, {
        instance_url: args.instance_url,
        apiKey: requireKey(args),
        body: { date, text },
      });

      const note = data.annotation || {};
      return [
        `Noted on ${domain} for ${note.date || date}: "${note.text || text}"`,
        '',
        `It is drawn on the graph for any period covering that day, and credible_list_annotations returns it (annotation #${note.id}).`,
      ].join('\n');
    },
  },

  {
    name: 'credible_create_goal',
    description:
      'Create a conversion goal so signups, purchases or key page visits are counted. Two kinds: an "event" goal fires when the site sends a custom event of that name, a "page" goal fires when a visitor reaches a path. Returns the goal id, which credible_create_funnel needs. ' +
      'Use it as soon as someone says what success looks like on their site — "I want to know how many people sign up" is a goal, and until one exists nothing is measuring it. A page goal starts counting immediately, including against traffic already recorded; an event goal only counts events the site sends from then on.',
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
        // No .filter() here: block() always renders the Type row, and the empty
        // string above is the deliberate blank line before the advice.
      ].join('\n');
    },
  },

  {
    name: 'credible_create_funnel',
    description:
      'Build a funnel from existing goals to see where people drop off between steps. Needs between two and eight goal ids, in order — create the goals first with credible_create_goal, which returns their ids. ' +
      'Use it when the question is not "how many converted?" but "where do we lose them?": a checkout, a signup flow, an onboarding sequence. Steps must be reached in order by the same visitor within one period, so list them the way a visitor actually walks them.',
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
      'Create a public link to a site\'s dashboard so someone without an account can see the numbers. Optionally password protect it. Returns the URL to hand out. ' +
      'Use it when someone needs to be shown the stats rather than told them — a client, an investor, a teammate without a login — and prefer it to making the site public, since a link can be revoked and named. ' +
      'It publishes real traffic data to anyone holding the URL, so only call it when that is what was actually asked for.',
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

/** '2026-08-09 to 2026-08-15 (Europe/Paris)' for a resolved period. */
const rangeLabel = (range = {}) => {
  const zone = range.timezone || 'UTC';
  return range.start ? `${localDate(range.start, zone)} to ${localDate(range.end - 1, zone)} (${zone})` : 'range not reported';
};

/**
 * The dashboard payload, rendered.
 *
 * Shared by credible_get_stats and credible_apply_segment so a segmented view
 * reads exactly like an unsegmented one — the only difference is the lines
 * naming the segment, which is the point: the model should not have to learn a
 * second layout to read the same numbers.
 *
 * @param {string[]} prefix lines placed under the header, before the metrics
 * @param {string[]} notes  lines placed after the panels, before the URL
 */
function dashboardReport({ domain, period, data, base, prefix = [], notes = [] }) {
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
  const zone = range.timezone || 'UTC';

  const parts = [
    `${domain} — ${period}${range.start ? ` (${localDate(range.start, zone)} to ${localDate(range.end - 1, zone)}, ${zone})` : ''}`,
    ...(prefix.length ? ['', ...prefix] : []),
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
  // Annotations explain the shape of the graph, so they belong with the numbers
  // rather than in a tool the model has to know to call separately.
  if (Array.isArray(data.annotations) && data.annotations.length) {
    parts.push('', section('What happened in this period', block(data.annotations.map((note) => [`  ${note.date}`, note.text]))));
  }
  if (notes.length) parts.push('', notes.join('\n'));
  parts.push('', `Full dashboard: ${base}/${domain}`);
  return parts.join('\n');
}

/** The metrics credible_compare_periods puts side by side, in reading order. */
const COMPARED_METRICS = [
  ['visitors', 'Visitors', (value) => fmt(value)],
  ['visits', 'Visits', (value) => fmt(value)],
  ['pageviews', 'Pageviews', (value) => fmt(value)],
  ['views_per_visit', 'Views / visit', (value) => String(value ?? 0)],
  ['bounce_rate', 'Bounce rate', (value) => `${value ?? 0}%`],
  ['visit_duration', 'Visit duration', (value) => humanDuration(value)],
];

/** How the first period compares with the second, one metric at a time. */
function delta(metric, current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  // A bounce rate is already a percentage: the honest difference is in points.
  if (metric === 'bounce_rate') {
    const diff = Math.round(now - before);
    return diff === 0 ? 'no change' : `${diff > 0 ? '+' : ''}${diff} pts`;
  }
  if (!before) return now > 0 ? 'new' : 'no change';
  return changeLabel(Math.round(((now - before) / before) * 100));
}

/** The comparison in one sentence, written to be read out loud. */
function visitorSentence(current, currentLabel, previous, previousLabel) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before) {
    return `${count(now, 'visitor')} over ${currentLabel}. ${previousLabel} had none, so there is no percentage worth quoting.`;
  }
  const percent = Math.round(((now - before) / before) * 100);
  const direction = percent === 0 ? 'level with' : percent > 0 ? `up ${percent}% on` : `down ${Math.abs(percent)}% on`;
  return `${count(now, 'visitor')} over ${currentLabel}, ${direction} the ${count(before, 'visitor')} over ${previousLabel}.`;
}

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
      'answer questions about the traffic. credible_help lists everything else in one call — comparisons, ' +
      'journeys, saved segments, annotations, the all-sites rollup and the traffic shields.',
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
