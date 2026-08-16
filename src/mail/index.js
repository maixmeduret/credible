/**
 * The mail subsystem's public surface.
 *
 * Everything the rest of Credible needs is here: is email set up, what is it
 * set up as, send this, and does the relay actually answer. `src/mail/smtp.js`
 * owns the protocol, `src/mail/render.js` owns the words.
 *
 * Environment:
 *
 *   CREDIBLE_SMTP_HOST     relay hostname. Unset means email is simply off —
 *                          reports and alerts are skipped, nothing errors.
 *   CREDIBLE_SMTP_PORT     default 587 (465 when CREDIBLE_SMTP_SECURE is on).
 *   CREDIBLE_SMTP_USER     username. Empty means no AUTH is attempted, which
 *                          is the normal case for a relay on localhost.
 *   CREDIBLE_SMTP_PASS     password for that username.
 *   CREDIBLE_SMTP_SECURE   1/true/yes/on → implicit TLS from the first byte.
 *                          Defaults to on for port 465, off otherwise, where
 *                          the connection is upgraded with STARTTLS instead.
 *   CREDIBLE_SMTP_FROM     sender, `a@b` or `Name <a@b>`. Defaults to the
 *                          username when that looks like an address, and then
 *                          to credible@<hostname>.
 *   CREDIBLE_SMTP_TIMEOUT  milliseconds per read and per write, default 20000.
 *   CREDIBLE_SMTP_TLS_INSECURE  accept a certificate that does not validate.
 *                          Only for an internal relay with a self-signed cert;
 *                          it disables the protection TLS is there to provide.
 *
 * The environment is read on every call instead of being snapshotted at import
 * time (which is what src/config.js does) because SMTP credentials are the one
 * setting a self-hoster tends to add after the fact — a systemd drop-in, `fly
 * secrets set`, a wrapper sourcing an env file — and `credible doctor` has to
 * report on what the process would use right now, not at boot.
 */
import os from 'node:os';
import { sendMail, verify, SmtpError } from './smtp.js';
import { log } from '../util/log.js';

export { SmtpError };

const env = (key) => {
  const value = process.env[key];
  return value === undefined ? '' : String(value).trim();
};

const envBool = (key) => /^(1|true|yes|on)$/i.test(env(key));
const envSet = (key) => env(key) !== '';

/** True when this instance can send mail at all. */
export function mailConfigured() {
  return envSet('CREDIBLE_SMTP_HOST');
}

/**
 * The effective SMTP configuration.
 *
 * The password is deliberately absent: this is the object `credible doctor`
 * prints and the settings API returns, and a secret has no business in either.
 *
 * @returns {{host: string, port: number, secure: boolean, user: string, from: string, configured: boolean}}
 */
export function mailSettings() {
  const host = env('CREDIBLE_SMTP_HOST');
  const secure = envSet('CREDIBLE_SMTP_SECURE') ? envBool('CREDIBLE_SMTP_SECURE') : null;
  const port = Number.parseInt(env('CREDIBLE_SMTP_PORT'), 10) || (secure ? 465 : 587);
  const user = env('CREDIBLE_SMTP_USER');
  return {
    host,
    port,
    // Implicit TLS is the default on 465 and only there; everything else
    // starts in the clear and is upgraded with STARTTLS when offered.
    secure: secure === null ? port === 465 : secure,
    user,
    from: defaultFrom(user),
    configured: Boolean(host),
  };
}

function defaultFrom(user) {
  const explicit = env('CREDIBLE_SMTP_FROM');
  if (explicit) return explicit;
  if (user.includes('@')) return user;
  // Deliverable only from a relay that accepts it, but it is a valid address
  // and it makes the misconfiguration obvious in the bounce rather than here.
  return `credible@${os.hostname() || 'localhost'}`;
}

function transport() {
  const settings = mailSettings();
  const tls = envBool('CREDIBLE_SMTP_TLS_INSECURE') ? { rejectUnauthorized: false } : {};
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    pass: process.env.CREDIBLE_SMTP_PASS || '',
    from: settings.from,
    timeout: Number.parseInt(env('CREDIBLE_SMTP_TIMEOUT'), 10) || 20000,
    tls,
  };
}

/**
 * Send one message through the configured relay.
 *
 * Throws rather than failing quietly: a caller that wants "send if possible"
 * should ask `mailConfigured()` first, so that a genuine relay failure is
 * never mistaken for email being switched off.
 *
 * @param {object} message
 * @param {string|string[]} message.to
 * @param {string} message.subject
 * @param {string} [message.text]
 * @param {string} [message.html]
 * @param {string} [message.from]            overrides CREDIBLE_SMTP_FROM
 * @param {string} [message.replyTo]
 * @param {string} [message.unsubscribeUrl]  becomes a List-Unsubscribe header
 * @param {number} [message.timeout]
 * @returns {Promise<{accepted: string[], response: string, messageId: string}>}
 */
export async function send(message) {
  const { to, subject, text, html, from, replyTo, unsubscribeUrl, timeout } = message || {};
  const options = transport();

  const headers = {};
  // RFC 8058's one-click variant is deliberately not advertised: it would
  // promise a POST endpoint that this module does not own.
  if (unsubscribeUrl) headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
  if (replyTo) headers['Reply-To'] = replyTo;

  const result = await sendMail({
    ...options,
    from: from || options.from,
    to,
    subject,
    text,
    html,
    headers,
    timeout: timeout || options.timeout,
  });

  log.info(`mail: sent "${subject}" to ${result.accepted.join(', ')} (${result.messageId})`);
  return result;
}

/**
 * Connect, EHLO, authenticate, QUIT. No message is composed and no recipient
 * is touched, so this is safe against a production relay.
 *
 * Returns a result instead of throwing, because its only caller is a
 * diagnostic — `credible doctor` wants a line to print, not an exception.
 *
 * @returns {Promise<{ok: boolean, host: string, port: number, secure: boolean, encrypted: boolean, authenticated: boolean, greeting: string, capabilities: string[], stage: string, error: string}>}
 */
export async function verifyConnection() {
  const settings = mailSettings();
  const base = {
    ok: false,
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    encrypted: false,
    authenticated: false,
    greeting: '',
    capabilities: [],
    stage: '',
    error: '',
  };

  if (!settings.configured) {
    return { ...base, stage: 'config', error: 'Email is not configured: CREDIBLE_SMTP_HOST is unset' };
  }

  try {
    const result = await verify(transport());
    return {
      ...base,
      ok: true,
      encrypted: result.encrypted,
      authenticated: result.authenticated,
      greeting: result.greeting,
      capabilities: result.capabilities,
    };
  } catch (err) {
    if (!(err instanceof SmtpError)) throw err;
    log.debug(`mail: verify failed at ${err.stage}: ${err.message}`);
    return { ...base, stage: err.stage, error: err.message };
  }
}
