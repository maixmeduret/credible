/**
 * Webhook delivery — POST a report or an alert as JSON to a URL.
 *
 * The URL people paste here is, nine times out of ten, a Slack or a Discord
 * incoming webhook, which do not accept an arbitrary JSON document: Slack wants
 * `{"text": …}` and Discord wants `{"content": …}`. Detecting those two and
 * shaping the body accordingly is the difference between "it works" and a 400
 * that nobody can read. Anything else gets a documented generic envelope.
 *
 * SIGNING
 * With `secret` set, the request carries
 *
 *   X-Credible-Signature: sha256=<hex hmac of the exact request body bytes>
 *
 * Verify against the *raw* body, before any JSON parsing — re-serialising the
 * parsed object reorders keys and changes whitespace, and the signature will
 * not match:
 *
 *   import { createHmac, timingSafeEqual } from 'node:crypto';
 *
 *   app.post('/hooks/credible', express.raw({ type: 'application/json' }), (req, res) => {
 *     const expected = `sha256=${createHmac('sha256', process.env.CREDIBLE_WEBHOOK_SECRET)
 *       .update(req.body)                      // req.body is a Buffer here
 *       .digest('hex')}`;
 *     const got = Buffer.from(req.get('x-credible-signature') || '');
 *     const want = Buffer.from(expected);
 *     if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);
 *     const payload = JSON.parse(req.body.toString('utf8'));
 *     res.sendStatus(204);
 *   });
 *
 * Slack and Discord ignore the header, which is fine: their URL is the secret.
 *
 * SSRF, AND WHY THE TEXTBOOK ANSWER IS WRONG HERE
 * The textbook rule for "POST to a user-supplied URL" is to refuse every
 * private, loopback and link-local destination. Applied to Credible it would
 * break the main use case: this is software that runs on a box at home, and
 * the webhook receiver is usually *on that box or on that LAN* — a Home
 * Assistant at 192.168.1.10, a Gotify at 127.0.0.1:8080, a Tailscale address
 * at 100.x. Refusing those would leave the feature working only for people who
 * already pay somebody else to run something, which is the opposite of the
 * point.
 *
 * The reason the textbook rule exists is that the URL is usually attacker-
 * supplied. Here it is typed by an authenticated operator into their own
 * instance's settings — and an operator who wants to POST to their own LAN is
 * expressing intent, not being exploited. So the line drawn is:
 *
 *   • an address the operator typed literally (127.0.0.1, 192.168.x, 10.x,
 *     100.64/10, fc00::/7, ::1) is allowed — they meant that machine;
 *   • `localhost`, `*.local`, `*.lan`, `*.internal`, `*.home.arpa` and
 *     single-label names are allowed for the same reason: nobody types
 *     `nas.lan` by accident;
 *   • a public-looking hostname that *resolves* to loopback is refused. There
 *     is no honest reason for `something.example.com` to be 127.0.0.1, and
 *     that is exactly the shape of a DNS-rebinding attempt on an instance with
 *     open registration, where the person adding the webhook is not
 *     necessarily the person who owns the server;
 *   • link-local (169.254.0.0/16, fe80::/10) is refused however it is spelled.
 *     No webhook receiver lives there, and 169.254.169.254 is the cloud
 *     metadata endpoint — the one address where a blind POST has real
 *     consequences.
 *
 * The pre-flight lookup is honestly best-effort: fetch resolves the name again
 * when it connects, so a hostile resolver could answer differently the second
 * time. Closing that gap needs the socket pinned to the address we checked,
 * which needs a custom dispatcher, which needs a dependency this project does
 * not have. It raises the cost of the disguise without claiming to be a
 * boundary — the real boundary is that only an authenticated operator can set
 * the target.
 *
 * Environment:
 *
 *   CREDIBLE_WEBHOOK_SECRET   read by src/notify/index.js and passed in here.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';

const DEFAULT_TIMEOUT = 10_000;

/** Discord rejects a message over 2000 characters outright. */
const DISCORD_LIMIT = 2000;

/** Slack's `text` field tolerates far more; this keeps a digest sane. */
const SLACK_LIMIT = 12_000;

const error = (message, extra = {}) => Object.assign(new Error(message), { channel: 'webhook', ...extra });

const stripBrackets = (host) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/**
 * Cut at `index`, never between the two halves of an emoji — a lone surrogate
 * would be encoded as U+FFFD and Discord rejects a body it cannot decode.
 * Kept local so this transport depends on nothing but node built-ins.
 */
function cutAt(text, index) {
  if (text.length <= index) return text;
  let end = Math.max(0, index);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Classify an IP literal.
 *
 * @returns {'loopback'|'link-local'|'private'|'unspecified'|'public'}
 */
export function classifyAddress(value) {
  const address = stripBrackets(String(value || '').trim()).toLowerCase();
  const version = net.isIP(address);
  if (version === 4) return classifyIPv4(address);
  if (version === 6) return classifyIPv6(address);
  return 'public';
}

function classifyIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT, which is also Tailscale's range — extremely common on
  // exactly the home servers this feature is for.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  return 'public';
}

function classifyIPv6(address) {
  // ::ffff:127.0.0.1 and ::ffff:7f00:1 are both IPv4 wearing a hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return classifyIPv4(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return classifyIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (address === '::') return 'unspecified';
  if (address === '::1') return 'loopback';
  if (/^fe[89ab]/.test(address)) return 'link-local';
  if (/^f[cd]/.test(address)) return 'private';
  return 'public';
}

/** Names that can only mean "this machine or my own network". */
function isExplicitlyLocalName(host) {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/\.(local|lan|internal|intranet|home|home\.arpa)$/.test(name)) return true;
  return !name.includes('.'); // a single-label host is a LAN name by definition
}

/**
 * Which service is on the other end of this URL.
 *
 * Discord also exposes a Slack-compatible endpoint at `<webhook>/slack`, and a
 * URL ending that way wants Slack's shape even though the host says Discord.
 *
 * @returns {'slack'|'discord'|'generic'}
 */
export function detectFlavour(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  const discord = host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com');
  if (discord && /\/api\/webhooks\//.test(path)) {
    if (/\/slack\/?$/.test(path)) return 'slack';
    if (/\/github\/?$/.test(path)) return 'generic'; // GitHub's shape, not ours
    return 'discord';
  }
  if (host === 'hooks.slack.com' || host.endsWith('.slack.com')) return 'slack';
  return 'generic';
}

/**
 * Parse and vet a webhook target without sending anything.
 *
 * @param {string} target
 * @returns {{ url: URL, flavour: 'slack'|'discord'|'generic' }}
 */
export function parseWebhookTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) throw error('webhook: no URL configured.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw error(`webhook: "${raw}" is not a URL. It must start with http:// or https://.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw error(`webhook: ${url.protocol}// is not supported — a webhook URL must be http:// or https://.`);
  }
  if (!url.hostname) throw error(`webhook: "${raw}" has no host.`);

  return { url, flavour: detectFlavour(url) };
}

/** The address policy described at the top of this file. */
async function assertReachable(url) {
  const host = stripBrackets(url.hostname);

  if (net.isIP(host)) {
    const verdict = classifyAddress(host);
    if (verdict === 'link-local' || verdict === 'unspecified') {
      throw error(`webhook: refusing to post to ${verdict} address ${host} — nothing that answers a webhook lives there.`);
    }
    return; // typed literally: loopback and LAN addresses are the point.
  }

  if (isExplicitlyLocalName(host)) return;

  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    // Resolution failed. Let fetch report the real DNS error rather than
    // dressing it up as a refusal.
    return;
  }
  for (const { address } of addresses) {
    const verdict = classifyAddress(address);
    if (verdict === 'loopback' || verdict === 'link-local' || verdict === 'unspecified') {
      throw error(
        `webhook: ${host} resolves to ${address} (${verdict}) — refusing. If you meant this machine, use the address itself.`,
      );
    }
  }
}

/** `sha256=<hex>` over the exact bytes that go on the wire. */
export function signBody(bytes, secret) {
  return `sha256=${createHmac('sha256', String(secret)).update(bytes).digest('hex')}`;
}

/** Slack reads `&`, `<` and `>` as markup — and our drop alert says `<head>`. */
const escapeSlack = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A stray fence in the body would end the code block early. */
const defuseFences = (text) => String(text).replace(/```/g, "''`");

function clip(text, limit) {
  if (limit <= 1) return '';
  if (text.length <= limit) return text;
  const cut = cutAt(text, limit - 1);
  const boundary = cut.lastIndexOf('\n');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * The chat services get the text in a code block: the report lays its numbers
 * out in padded columns, and columns only line up in a monospace font. The
 * dashboard link goes outside the block, where it stays clickable.
 */
function chatBody({ flavour, title, body, clickUrl, limit }) {
  const bold = flavour === 'discord' ? '**' : '*';
  const link = clickUrl
    ? flavour === 'slack'
      ? `\n<${clickUrl}|Open the dashboard>`
      : `\nOpen the dashboard: ${clickUrl}`
    : '';

  const heading = flavour === 'slack' ? escapeSlack(title) : title;
  const text = flavour === 'slack' ? escapeSlack(body) : body;
  const frame = `${bold}${heading}${bold}\n\`\`\`\n\n\`\`\`${link}`;
  return `${bold}${heading}${bold}\n\`\`\`\n${clip(defuseFences(text), Math.max(0, limit - frame.length))}\n\`\`\`${link}`;
}

function buildBody({ flavour, title, body, clickUrl, payload }) {
  if (flavour === 'slack') {
    return { text: chatBody({ flavour: 'slack', title, body, clickUrl, limit: SLACK_LIMIT }) };
  }
  if (flavour === 'discord') {
    return { content: chatBody({ flavour: 'discord', title, body, clickUrl, limit: DISCORD_LIMIT }) };
  }
  // The generic envelope. Extra fields from the caller are merged in first, so
  // the reserved keys below always mean what this file says they mean.
  return {
    ...(payload && typeof payload === 'object' ? payload : {}),
    source: 'credible',
    version: 1,
    title,
    text: body,
    url: clickUrl || '',
    sent_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * POST a JSON body to an arbitrary URL.
 *
 * @param {object} message
 * @param {string} message.target
 * @param {string} message.title
 * @param {string} message.body           plain text, already formatted
 * @param {object} [message.payload]      structured fields for the generic shape
 * @param {string} [message.clickUrl]
 * @param {string} [message.secret]       HMAC key for X-Credible-Signature
 * @param {'slack'|'discord'|'generic'} [message.flavour]  force the body shape,
 *        for a Slack-compatible endpoint on a host we cannot recognise
 *        (Mattermost, Rocket.Chat) — detection is by hostname otherwise.
 * @param {number} [message.timeout]      milliseconds, default 10000
 * @returns {Promise<{ ok: boolean, status: number, flavour: 'slack'|'discord'|'generic' }>}
 */
export async function sendWebhook(message = {}) {
  const {
    target,
    title = '',
    body = '',
    payload = null,
    clickUrl = '',
    secret = '',
    flavour: forced = '',
    timeout = DEFAULT_TIMEOUT,
  } = message;

  const { url, flavour: detected } = parseWebhookTarget(target);
  const flavour = ['slack', 'discord', 'generic'].includes(forced) ? forced : detected;
  await assertReachable(url);

  const bytes = Buffer.from(JSON.stringify(buildBody({ flavour, title, body, clickUrl, payload })), 'utf8');

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': `Credible/${config.version}`,
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };
  if (secret) headers['X-Credible-Signature'] = signBody(bytes, secret);

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';
    const reason = aborted
      ? `did not answer within ${timeout}ms`
      : `could not be reached (${err?.cause?.code || err?.cause?.message || err?.message})`;
    throw error(`webhook: ${url.host} ${reason}`, { host: url.host, flavour, cause: err });
  }

  // Slack answers a bad payload with a plain-text line ("invalid_payload"),
  // Discord with JSON. Either way the first line is the useful part.
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const detail = text.trim().split('\n')[0].slice(0, 200);
    throw error(`webhook: ${url.host} rejected the message (HTTP ${response.status}${detail ? `: ${detail}` : ''})`, {
      host: url.host,
      flavour,
      status: response.status,
    });
  }

  return { ok: true, status: response.status, flavour };
}
