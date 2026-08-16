/**
 * ntfy delivery — a push notification on a phone, with no mail server anywhere.
 *
 * This is the channel for the person self-hosting Credible on a mini PC in a
 * cupboard: they have no SMTP relay, they do not want to run one, and getting
 * an app password from a mail provider just to read their own visitor numbers
 * is an absurd amount of ceremony. A topic name is enough — install the ntfy
 * app, subscribe to `whatever-you-typed`, done.
 *
 * WHY HEADERS AND NOT THE JSON BODY FORM
 * ntfy accepts a message in two shapes. The one used here is
 * `POST <server>/<topic>` with the message as the raw request body and every
 * option as an `X-…` header. The other is `POST <server>/` — the *root* of the
 * server, no topic in the path — with a JSON document that carries the topic
 * inside it as `{"topic": "...", "message": "..."}`. The JSON form therefore
 * needs a different endpoint *and* a different notion of where the topic
 * lives, which means `normalizeTopic()` would have to hand back a base URL and
 * a topic that get recombined differently per request, and a self-hosted
 * instance behind a path prefix (`https://example.com/ntfy/mytopic`) becomes
 * ambiguous — is `/ntfy` part of the prefix or the topic? The header form
 * keeps one URL, exactly the one the operator pasted, and it is the form every
 * ntfy example on the internet uses, so a broken configuration can be debugged
 * with the `curl` line from the docs. The message body also travels as UTF-8
 * bytes rather than as a header value, which is where all the encoding pain
 * would otherwise be.
 *
 * Headers ntfy understands and this module sets: `X-Title`, `X-Priority`,
 * `X-Tags`, `X-Click`, `X-Markdown` and `Authorization`.
 *
 * HTTP header values are not UTF-8 territory — a title with an accent, and
 * certainly one with an emoji, either arrives as `?????` or is rejected by the
 * client library before it leaves. ntfy documents the way out: encode the
 * header as RFC 2047 (`=?UTF-8?B?…?=`), the same encoded-word format email
 * subjects use, and its server decodes it. `encodeHeaderValue()` below does
 * that, and only when the value is not already plain ASCII.
 *
 * Environment:
 *
 *   CREDIBLE_NTFY_TOKEN   bearer token for a protected topic (`tk_…`). Read on
 *                         every call, like the SMTP settings and for the same
 *                         reason: it is the kind of thing a self-hoster adds
 *                         after the fact, and it must not need a restart.
 */
import { config } from '../config.js';

/** ntfy.sh is where a bare topic name lives; a self-hoster types a full URL. */
const DEFAULT_SERVER = 'https://ntfy.sh';

/** ntfy's own topic rule: letters, digits, underscore and dash, up to 64. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** ntfy truncates long titles anyway, and a header is not a place for prose. */
const MAX_TITLE = 200;

const DEFAULT_TIMEOUT = 10_000;

/** The five levels, plus the aliases ntfy accepts for them. */
const PRIORITIES = new Map([
  ['min', 'min'],
  ['low', 'low'],
  ['default', 'default'],
  ['high', 'high'],
  ['urgent', 'urgent'],
  ['max', 'urgent'],
  ['1', 'min'],
  ['2', 'low'],
  ['3', 'default'],
  ['4', 'high'],
  ['5', 'urgent'],
]);

/** Emoji shortcodes and plain words. A comma would split one tag into two. */
const TAG_PATTERN = /^[A-Za-z0-9_+-]+$/;

const error = (message, extra = {}) => Object.assign(new Error(message), { channel: 'ntfy', ...extra });

/**
 * Cut at `index`, never between the two halves of an emoji: half a surrogate
 * pair becomes U+FFFD once the header is encoded, which is a worse ending than
 * one character less.
 */
function cutAt(text, index) {
  if (text.length <= index) return text;
  let end = Math.max(0, index);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Which scheme to assume when the operator typed a host without one.
 *
 * https everywhere is the right default on the public internet and the wrong
 * one on a LAN: `192.168.1.20:8080` has no certificate anybody can validate,
 * and forcing https there turns "it does not work" into an hour of confusion.
 * So: literal addresses, localhost, a single-label host (`nas:8080`) and the
 * usual home-network suffixes default to http; everything else to https. An
 * explicit `http://` or `https://` in the target always wins over this guess.
 */
function schemeFor(authority) {
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  if (!host || host.startsWith('[')) return 'http'; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'http';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'http';
  if (/\.(local|lan|internal|intranet|home|home\.arpa)$/.test(host)) return 'http';
  if (!host.includes('.')) return 'http';
  return 'https';
}

/**
 * Turn whatever the operator typed into the URL to publish to.
 *
 * Accepts, in the order people actually write them:
 *   'mytopic'                        → https://ntfy.sh/mytopic
 *   'ntfy.sh/mytopic'                → https://ntfy.sh/mytopic
 *   'https://ntfy.example/mytopic'   → unchanged
 *   'http://192.168.1.20:8080/home'  → unchanged, http and port preserved
 *   'ntfy.example/proxy/mytopic'     → a server mounted under a path prefix:
 *                                      the last segment is the topic, the rest
 *                                      is where ntfy is reverse-proxied.
 *
 * Query strings and fragments are dropped — ntfy takes no query parameters on
 * publish, and keeping them would only smuggle junk into the request.
 *
 * @param {string} target
 * @returns {{ url: string, topic: string }}
 */
export function normalizeTopic(target) {
  const raw = String(target ?? '').trim();
  if (!raw) {
    throw error(
      'ntfy: no topic configured. Use a topic name ("my-stats"), or the full URL of a self-hosted server ("https://ntfy.example/my-stats").',
    );
  }
  if (/\s/.test(raw)) throw error(`ntfy: "${raw}" is not a usable topic or URL — it contains a space.`);

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw error(`ntfy: ${scheme[1]}:// is not supported — use http:// or https://, or just the topic name.`);
  }

  let candidate;
  if (scheme) candidate = raw;
  else if (raw.includes('/')) candidate = `${schemeFor(raw.split('/')[0])}://${raw}`;
  else candidate = `${DEFAULT_SERVER}/${raw}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw error(`ntfy: "${raw}" is not a usable topic or URL.`);
  }

  // Credentials in the URL would be silently dropped by `url.origin` below and
  // the result would be an unexplainable 403. Say so instead.
  if (url.username || url.password) {
    throw error('ntfy: put the credentials in CREDIBLE_NTFY_TOKEN, not in the topic URL.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const topic = segments.pop() || '';
  if (!TOPIC_PATTERN.test(topic)) {
    throw error(
      `ntfy: "${raw}" has no usable topic — a topic is 1 to 64 letters, digits, underscores or dashes (got "${topic}").`,
    );
  }

  const prefix = segments.length ? `/${segments.join('/')}` : '';
  return { url: `${url.origin}${prefix}/${topic}`, topic };
}

/**
 * RFC 2047 encoded-words, as ntfy's docs prescribe for non-ASCII headers.
 *
 * Chunked at 45 bytes so no encoded word exceeds the 75-character limit, and
 * joined with a single space — never a CRLF fold, which is legal in an email
 * header and illegal in an HTTP one. A decoder joins adjacent encoded words
 * and drops the whitespace between them, so the title survives intact.
 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(text)) return text;

  const chunks = [];
  let piece = '';
  for (const char of text) {
    // Split on characters, never on bytes: half a code point is not decodable.
    if (Buffer.byteLength(piece + char, 'utf8') > 45) {
      chunks.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece) chunks.push(piece);

  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join(' ');
}

const parseJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

/**
 * Publish one notification.
 *
 * @param {object} message
 * @param {string} message.target      'mytopic', 'ntfy.sh/mytopic' or 'https://ntfy.example/mytopic'
 * @param {string} message.title
 * @param {string} message.body        plain text, already formatted
 * @param {string} [message.priority]  'min'|'low'|'default'|'high'|'urgent'
 * @param {string[]} [message.tags]    ntfy emoji shortcodes, e.g. ['chart_with_upwards_trend']
 * @param {string} [message.clickUrl]  the dashboard link the notification opens
 * @param {string} [message.token]     a bearer token for a protected topic
 * @param {boolean} [message.markdown] ask supporting clients to render markdown
 * @param {number} [message.timeout]   milliseconds, default 10000
 * @returns {Promise<{ ok: boolean, status: number, id: string }>}
 */
export async function sendNtfy(message = {}) {
  const {
    target,
    title = '',
    body = '',
    priority = '',
    tags = [],
    clickUrl = '',
    token = '',
    markdown = false,
    timeout = DEFAULT_TIMEOUT,
  } = message;

  const { url, topic } = normalizeTopic(target);
  const host = new URL(url).host;

  const headers = {
    // The body is the message. Declaring the charset is what keeps an accent
    // in a page title from arriving as mojibake.
    'content-type': 'text/plain; charset=utf-8',
    'user-agent': `Credible/${config.version}`,
  };

  const heading = cutAt(String(title || ''), MAX_TITLE);
  if (heading) headers['X-Title'] = encodeHeaderValue(heading);

  const level = PRIORITIES.get(String(priority || '').trim().toLowerCase());
  if (level) headers['X-Priority'] = level;

  // Tags are comma-separated, so a tag containing a comma — or an emoji
  // character, which cannot survive a header at all — is dropped rather than
  // silently splitting or corrupting the list. Pass shortcodes, not emoji.
  const shortcodes = (Array.isArray(tags) ? tags : [tags])
    .map((tag) => String(tag ?? '').trim())
    .filter((tag) => TAG_PATTERN.test(tag));
  if (shortcodes.length) headers['X-Tags'] = shortcodes.join(',');

  // ntfy also accepts mailto:, geo: and ntfy:// here. Only a web link is ever
  // useful to us, and restricting it means a malformed dashboard URL cannot
  // turn into some other kind of action on the phone.
  if (/^https?:\/\//i.test(clickUrl)) headers['X-Click'] = String(clickUrl);

  // Off by default: the text part is laid out with padded columns that a
  // markdown renderer would collapse into one grey paragraph, and only some
  // ntfy clients render markdown at all.
  if (markdown) headers['X-Markdown'] = 'yes';

  if (token) headers.Authorization = `Bearer ${String(token).trim()}`;

  // ntfy rejects an empty message; fall back to the title so a caller with
  // nothing to say still gets a notification rather than a 400.
  const payload = String(body || '').trim() ? String(body) : heading || 'Credible';

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // The only abort this code arms is the timeout, so either name means the
    // clock ran out; anything else is a connection failure worth naming.
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';
    const reason = aborted
      ? `did not answer within ${timeout}ms`
      : `could not be reached (${err?.cause?.code || err?.cause?.message || err?.message})`;
    throw error(`ntfy: topic "${topic}" on ${host} ${reason}`, { topic, host, cause: err });
  }

  const text = await response.text().catch(() => '');
  const parsed = parseJson(text);

  if (!response.ok) {
    const detail = parsed?.error || text.trim().split('\n')[0].slice(0, 200);
    throw error(
      `ntfy: topic "${topic}" on ${host} rejected the message (HTTP ${response.status}${detail ? `: ${detail}` : ''})`,
      { topic, host, status: response.status },
    );
  }

  // A successful publish echoes the stored message back as JSON, `id` included.
  // A reverse proxy that rewrites the body is not worth failing over, so the
  // id is best-effort.
  return { ok: true, status: response.status, id: String(parsed?.id || '') };
}
