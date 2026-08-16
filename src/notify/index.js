/**
 * Where a report or an alert goes.
 *
 * Credible could only ever deliver these by email, which quietly assumed
 * everybody running it has an SMTP relay. The person this project is written
 * for — one machine, at home, no ops budget — does not, and getting an app
 * password from a mail provider in order to read one's own visitor numbers is
 * a strange toll to pay. A push topic or a webhook URL needs nothing: no
 * account, no relay, no credentials, no deliverability.
 *
 * This module is the seam. `src/reports.js` decides *what* is owed and renders
 * it with `src/mail/render.js`; `deliver()` takes that rendered
 * `{ subject, text, html }` and the row it belongs to, and puts it wherever
 * the row's `channel` column says. Nothing above this file knows that ntfy
 * exists, and nothing below it knows what a weekly report is.
 *
 * The `text` part carries the whole message on purpose — render.js writes it
 * as a message in its own right, not as a fallback — which is exactly what a
 * push notification needs and why no HTML is ever sent down these channels.
 *
 * Environment:
 *
 *   CREDIBLE_NTFY_TOKEN      bearer token, for a protected ntfy topic.
 *   CREDIBLE_WEBHOOK_SECRET  HMAC key; when set, every webhook POST is signed
 *                            (see src/notify/webhook.js for verification).
 *
 * Both are read per call rather than snapshotted at import, matching
 * src/mail/index.js: these are settings a self-hoster adds after the fact, and
 * adding one should not need a restart.
 */
import { HttpError } from '../util/http.js';
import { log } from '../util/log.js';
import { mailConfigured, send } from '../mail/index.js';
import { normalizeTopic, sendNtfy } from './ntfy.js';
import { parseWebhookTarget, sendWebhook } from './webhook.js';

export const CHANNELS = ['email', 'ntfy', 'webhook'];

/**
 * How much of the message a push notification carries.
 *
 * Chosen, not guessed: ntfy stores a message larger than 4096 *bytes* as a
 * file attachment instead of a notification, and UTF-8 is at most 4 bytes per
 * character, so 1024 characters cannot trip that limit whatever the site's
 * page titles are made of. It is also about fifteen lines — roughly what an
 * expanded notification shows on a phone, which is the real constraint. A
 * weekly digest with four metrics and two top-five tables fits; a monster one
 * loses its tail rather than becoming a download.
 */
export const PUSH_BODY_LIMIT = 1024;

/**
 * Tone per kind of message.
 *
 * Only one of these means something is broken. A traffic drop is usually a
 * tracker that stopped loading — it should interrupt. A spike is worth
 * knowing now but nothing is on fire. A digest is a digest: `low` delivers it
 * without a sound, which is the difference between a useful notification and
 * one that gets muted after a fortnight. Nothing here is ever `urgent`:
 * analytics does not justify overriding a do-not-disturb at 3am.
 */
const TONE = {
  report: { priority: 'low', tags: ['bar_chart'] },
  weekly: { priority: 'low', tags: ['bar_chart'] },
  monthly: { priority: 'low', tags: ['bar_chart'] },
  spike: { priority: 'default', tags: ['chart_with_upwards_trend'] },
  drop: { priority: 'high', tags: ['chart_with_downwards_trend', 'warning'] },
};

const env = (key) => String(process.env[key] ?? '').trim();

const channelOf = (row) => String(row?.channel || 'email').trim().toLowerCase() || 'email';

/** Split a recipients column into addresses, dropping anything that is not one. */
export function parseRecipients(value) {
  return String(value || '')
    .split(/[\n,;]/)
    .map((v) => v.trim())
    .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

/**
 * The mail text, made fit for a channel that is not mail.
 *
 * Two things are dropped. The footer — everything after the `--` separator —
 * is an email footer: it explains why a message landed in an inbox and how to
 * unsubscribe, neither of which means anything on a phone topic the operator
 * subscribed to themselves and can unsubscribe from in one tap. And the
 * "Open the dashboard: <url>" line, because the URL travels as the
 * notification's click action instead, where tapping the notification opens
 * it — repeating it as text wastes the few lines a notification gets.
 *
 * @param {string} text
 * @param {{limit?: number}} [options]
 */
export function pushBody(text, { limit = Infinity } = {}) {
  const body = String(text ?? '')
    .split(/\n--\n/)[0]
    .split('\n')
    .filter((line) => !/^Open the dashboard:\s*https?:\/\//i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (body.length <= limit) return body;
  // Cut on a line boundary when one is close enough, so the message never ends
  // halfway through a number — and never between the halves of an emoji, which
  // would leave a lone surrogate to be encoded as U+FFFD.
  let end = limit - 1;
  const code = body.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const cut = body.slice(0, end);
  const boundary = cut.lastIndexOf('\n');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * A human sentence naming where a row delivers, for the settings UI and the CLI.
 *
 *   'ntfy → pillr-stats on ntfy.sh'
 *   'webhook → Slack (hooks.slack.com)'
 *   'email → you@example.com, ops@example.com'
 *
 * Never throws: it is called to render a row, including a row somebody has
 * just broken, and a settings page that explodes on bad input is worse than
 * one that says the input is bad.
 */
export function channelDescription(row = {}) {
  const channel = channelOf(row);
  const target = String(row.target || '').trim();

  if (channel === 'ntfy') {
    try {
      const { url, topic } = normalizeTopic(target);
      return `ntfy → ${topic} on ${new URL(url).host}`;
    } catch {
      return `ntfy → ${target || 'no topic'} (unusable)`;
    }
  }

  if (channel === 'webhook') {
    try {
      const { url, flavour } = parseWebhookTarget(target);
      const name = flavour === 'slack' ? 'Slack' : flavour === 'discord' ? 'Discord' : `POST ${url.pathname}`;
      return `webhook → ${name} (${url.host})`;
    } catch {
      return `webhook → ${target || 'no URL'} (unusable)`;
    }
  }

  const list = parseRecipients(row.recipients);
  if (!list.length) return 'email → nobody';
  const shown = list.slice(0, 2).join(', ');
  return `email → ${shown}${list.length > 2 ? `, +${list.length - 2} more` : ''}`;
}

/**
 * Check a channel and its destination before writing the row.
 *
 * @param {{channel?: string, target?: string, recipients?: string}} input
 * @returns {{channel: string, target: string, recipients: string}} normalized —
 *          the field the channel does not use comes back empty, so the row
 *          that gets stored cannot describe two destinations at once.
 * @throws {HttpError} 422 with a message meant for the person typing.
 */
export function validateChannel({ channel = 'email', target = '', recipients = '' } = {}) {
  const name = String(channel || 'email').trim().toLowerCase() || 'email';
  if (!CHANNELS.includes(name)) {
    throw new HttpError(422, `channel must be one of ${CHANNELS.join(', ')}`);
  }

  if (name === 'email') {
    const list = parseRecipients(recipients);
    if (!list.length) throw new HttpError(422, 'Add at least one valid email address');
    return { channel: 'email', target: '', recipients: list.join(',') };
  }

  const value = String(target || '').trim();
  if (!value) {
    throw new HttpError(
      422,
      name === 'ntfy'
        ? 'Add an ntfy topic — a name like "my-stats", or the URL of your own server'
        : 'Add the webhook URL to post to',
    );
  }

  try {
    if (name === 'ntfy') {
      const { url } = normalizeTopic(value);
      return { channel: 'ntfy', target: url, recipients: '' };
    }
    const { url } = parseWebhookTarget(value);
    return { channel: 'webhook', target: url.toString(), recipients: '' };
  } catch (err) {
    // The channel modules throw plain Errors written for a human; this is the
    // one place that knows those words are about to be shown in a form.
    throw new HttpError(422, err.message);
  }
}

/**
 * Deliver a rendered report or alert down whichever channel the row asks for.
 *
 * Throws on failure — the caller decides whether that stops anything, and
 * src/reports.js already logs and stamps the row so a broken destination can
 * never wedge the scheduler.
 *
 * @param {object} row        an `email_reports` or `alerts` row: channel, target, recipients
 * @param {object} message    `{ subject, text, html }` from src/mail/render.js
 * @param {object} [context]  `{ dashboardUrl, kind: 'report'|'spike'|'drop', site }`
 * @returns {Promise<object>} `{ channel, ok, … }` — the transport's own result
 */
export async function deliver(row = {}, message = {}, context = {}) {
  const channel = channelOf(row);
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown delivery channel "${channel}" — expected one of ${CHANNELS.join(', ')}.`);
  }

  const { subject = '', text = '', html = '' } = message;
  const { dashboardUrl = '', kind = 'report', site = '' } = context;
  const tone = TONE[String(kind).toLowerCase()] || TONE.report;

  if (channel === 'email') {
    if (!mailConfigured()) {
      throw new Error(
        'Email is not configured: set CREDIBLE_SMTP_HOST, or switch this to the ntfy or webhook channel, which need no mail server.',
      );
    }
    const to = parseRecipients(row.recipients);
    if (!to.length) throw new Error('No valid recipient on this row.');
    const result = await send({ to, subject, text, html, unsubscribeUrl: context.unsubscribeUrl });
    return { channel: 'email', ok: true, recipients: result.accepted };
  }

  if (channel === 'ntfy') {
    const result = await sendNtfy({
      target: row.target,
      title: subject,
      body: pushBody(text, { limit: PUSH_BODY_LIMIT }),
      priority: tone.priority,
      tags: tone.tags,
      clickUrl: dashboardUrl,
      token: env('CREDIBLE_NTFY_TOKEN'),
    });
    log.info(`notify: ${channelDescription(row)} — ${subject}`);
    return { channel: 'ntfy', ...result };
  }

  const result = await sendWebhook({
    target: row.target,
    title: subject,
    // No limit: a webhook receiver is a program, not a lock screen. Slack and
    // Discord shapes cap themselves at what those services accept.
    body: pushBody(text),
    payload: { kind, site: site || '', subject },
    clickUrl: dashboardUrl,
    secret: env('CREDIBLE_WEBHOOK_SECRET'),
  });
  log.info(`notify: ${channelDescription(row)} — ${subject}`);
  return { channel: 'webhook', ...result };
}
