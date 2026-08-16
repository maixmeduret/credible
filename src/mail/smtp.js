/**
 * A minimal SMTP client, built on node:net and node:tls.
 *
 * Credible ships with zero dependencies, so there is no nodemailer here. This
 * module speaks enough of RFC 5321 (transport), RFC 5322 (headers), RFC 2045
 * (MIME) and RFC 2047 (encoded words) to hand a multipart message to any relay
 * a self-hoster is likely to have: Postfix on the same box, Fastmail, Migadu,
 * Postmark, SES.
 *
 * The parts that are easy to get subtly wrong, and are therefore explicit:
 *   • multi-line replies (the `250-` continuation form) must be joined before
 *     the status code is trusted, otherwise a capability line reads as a final
 *     status and the conversation desynchronises by one reply;
 *   • every await is bounded, because the classic outbound-mail failure is a
 *     relay that accepts the TCP connection and then says nothing at all. An
 *     unbounded read there would wedge the report scheduler forever;
 *   • a line consisting of a single "." terminates DATA, so every body line
 *     starting with "." is doubled on the wire (RFC 5321 §4.5.2);
 *   • a non-ASCII Subject must be RFC 2047 encoded or it arrives as mojibake.
 *
 * Credentials are sent in the clear on a plain connection. We upgrade with
 * STARTTLS whenever the server advertises it, which covers every real relay;
 * the plaintext path remains reachable only for a relay on localhost that
 * offers no TLS at all.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';

const CRLF = '\r\n';

/**
 * Ceilings on what a reply is allowed to cost us.
 *
 * RFC 5321 §4.5.3.1.5 caps a reply line at 512 bytes; these are far above any
 * real relay and exist only so that a server which never sends a line ending —
 * broken, or hostile — cannot make this process grow without bound. Without
 * them the read buffer is limited only by the timeout, and because each chunk
 * is concatenated onto the last, the cost is quadratic: measured here, 44 MB
 * of line-feed-free input pushed RSS up by 3.9 GB before the timeout fired.
 */
const MAX_LINE_BYTES = 64 * 1024;
const MAX_REPLY_LINES = 256; // a multi-line 250- reply; real EHLOs use ~10
const MAX_QUEUED_REPLIES = 64; // replies we never asked for

/** Errors carry the protocol stage and the server's own words — both are what an operator needs. */
export class SmtpError extends Error {
  /**
   * @param {string} stage  'config' | 'connect' | 'greeting' | 'EHLO' | 'STARTTLS' | 'AUTH' | 'MAIL FROM' | 'RCPT TO' | 'DATA' | 'QUIT'
   * @param {string} message
   * @param {{code?: number, reply?: string}} [detail]
   */
  constructor(stage, message, detail = {}) {
    super(message);
    this.name = 'SmtpError';
    this.stage = stage;
    this.code = detail.code || 0;
    this.reply = detail.reply || '';
  }
}

const rejected = (stage, reply) =>
  new SmtpError(stage, `SMTP ${stage} failed: ${reply.raw}`, { code: reply.code, reply: reply.raw });

// ------------------------------------------------------------------ wire --

/**
 * Line-oriented SMTP reply reader over a socket.
 *
 * Chunks are buffered as bytes rather than decoded strings: the same socket is
 * later handed to `tls.connect()` for a STARTTLS upgrade, and a socket left in
 * string-decoding mode would corrupt the TLS handshake.
 */
function createChannel(socket, timeout, stage) {
  let pending = Buffer.alloc(0); // bytes not yet forming a whole line
  let partial = []; // raw lines of the reply being assembled
  const queue = []; // complete replies not yet consumed
  let waiter = null; // { resolve, reject, timer }
  let broken = null; // first fatal error, sticky

  const fail = (err) => {
    if (!broken) broken = err;
    if (waiter) {
      clearTimeout(waiter.timer);
      const { reject } = waiter;
      waiter = null;
      reject(broken);
    }
  };

  /** Stop reading and drop what we buffered: the session is over either way. */
  const abort = (message) => {
    pending = Buffer.alloc(0);
    partial = [];
    queue.length = 0;
    fail(new SmtpError(stage.current, message));
    socket.destroy();
  };

  const deliver = (reply) => {
    if (!waiter) {
      if (queue.length >= MAX_QUEUED_REPLIES) {
        abort(`the server sent more than ${MAX_QUEUED_REPLIES} replies that were never requested`);
        return;
      }
      queue.push(reply);
      return;
    }
    clearTimeout(waiter.timer);
    const { resolve } = waiter;
    waiter = null;
    resolve(reply);
  };

  const onData = (chunk) => {
    if (broken) return; // sticky: stop accumulating once the session is doomed
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (pending.length > MAX_LINE_BYTES) {
      abort(`the server sent more than ${MAX_LINE_BYTES} bytes without ending a line`);
      return;
    }
    let index = pending.indexOf(0x0a);
    while (index >= 0) {
      const line = pending.subarray(0, index).toString('utf8').replace(/\r$/, '');
      pending = pending.subarray(index + 1);
      const match = /^(\d{3})([ -]?)(.*)$/s.exec(line);
      if (!match) {
        fail(new SmtpError(stage.current, `unreadable reply from the server: ${JSON.stringify(line)}`, { reply: line }));
        return;
      }
      partial.push(line);
      if (partial.length > MAX_REPLY_LINES) {
        abort(`the server sent a reply of more than ${MAX_REPLY_LINES} continuation lines`);
        return;
      }
      if (match[2] !== '-') {
        const raw = partial.join(' ');
        const lines = partial.map((entry) => entry.slice(4));
        partial = [];
        deliver({ code: Number(match[1]), lines, raw });
      }
      index = pending.indexOf(0x0a);
    }
  };

  const onError = (err) => fail(new SmtpError(stage.current, `connection error: ${err.message}`));
  const onClose = () => fail(new SmtpError(stage.current, 'the server closed the connection unexpectedly'));

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    stage,

    /** Next complete reply, or a typed timeout naming the current stage. */
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (broken) return Promise.reject(broken);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          // The socket's state is unknown from here on; do not reuse it.
          socket.destroy();
          reject(new SmtpError(stage.current, `no reply from the server within ${timeout} ms`));
        }, timeout);
        waiter = { resolve, reject, timer };
      });
    },

    /** Write raw bytes, bounded by the same timeout as a read. */
    write(text) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new SmtpError(stage.current, `the server stopped reading after ${timeout} ms`));
        }, timeout);
        socket.write(text, (err) => {
          clearTimeout(timer);
          if (err) reject(new SmtpError(stage.current, `write failed: ${err.message}`));
          else resolve();
        });
      });
    },

    /**
     * Release the socket before a TLS upgrade. Returns any bytes the server
     * sent early — see the injection note at the call site.
     */
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      // Removing the 'data' listener does not leave flowing mode, and data
      // read while nothing is listening is discarded.
      socket.pause();
      return pending.length + queue.length + partial.length;
    },
  };
}

/**
 * SNI carries a hostname and nothing else — Node throws outright on an IP
 * literal, which is exactly what `CREDIBLE_SMTP_HOST=127.0.0.1` gives you when
 * the relay runs on the same box.
 */
const sni = (host) => (net.isIP(host) ? {} : { servername: host });

function connectSocket({ host, port, secure, timeout, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, ...sni(host), ...tlsOptions })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError('connect', `could not reach ${host}:${port} within ${timeout} ms`));
    }, timeout);

    const onError = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new SmtpError('connect', `could not connect to ${host}:${port}: ${err.message}`));
    };

    socket.once('error', onError);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

async function upgradeToTls({ socket, channel, host, timeout, tlsOptions, stage }) {
  const early = channel.detach();
  // RFC 3207 §6: bytes received before the handshake are unauthenticated, and
  // a server that pipelines them is either broken or an attacker splicing
  // commands into what the client will believe is the protected session.
  if (early) throw new SmtpError('STARTTLS', 'the server sent data before the TLS handshake; refusing to continue');

  const secured = await new Promise((resolve, reject) => {
    const upgraded = tls.connect({ socket, ...sni(host), ...tlsOptions });
    const timer = setTimeout(() => {
      upgraded.destroy();
      reject(new SmtpError('STARTTLS', `the TLS handshake did not complete within ${timeout} ms`));
    }, timeout);
    const onError = (err) => {
      clearTimeout(timer);
      upgraded.destroy();
      reject(new SmtpError('STARTTLS', `the TLS handshake failed: ${err.message}`));
    };
    upgraded.once('error', onError);
    upgraded.once('secureConnect', () => {
      clearTimeout(timer);
      upgraded.off('error', onError);
      resolve(upgraded);
    });
  });

  return { socket: secured, channel: createChannel(secured, timeout, stage) };
}

async function command(channel, stage, line, expect) {
  channel.stage.current = stage;
  await channel.write(line + CRLF);
  const reply = await channel.read();
  if (!expect.includes(reply.code)) throw rejected(stage, reply);
  return reply;
}

/** EHLO, falling back to HELO for the handful of relays that predate ESMTP. */
async function greet(channel, clientName) {
  channel.stage.current = 'EHLO';
  await channel.write(`EHLO ${clientName}${CRLF}`);
  const reply = await channel.read();
  if (reply.code === 250) return { reply, esmtp: true };

  channel.stage.current = 'HELO';
  await channel.write(`HELO ${clientName}${CRLF}`);
  const fallback = await channel.read();
  if (fallback.code !== 250) throw rejected('HELO', fallback);
  return { reply: fallback, esmtp: false };
}

/**
 * EHLO keywords. The first line is the server's own domain, not a capability.
 * `AUTH=LOGIN PLAIN` is the pre-standard spelling still emitted by old
 * Sendmail builds, and is folded into the AUTH list.
 */
function parseCapabilities(reply) {
  const caps = new Map();
  if (!reply) return caps;
  for (const line of reply.lines.slice(1)) {
    const [keyword, ...args] = line.trim().split(/\s+/);
    if (!keyword) continue;
    const upper = keyword.toUpperCase();
    if (upper.startsWith('AUTH=')) {
      const existing = caps.get('AUTH') || [];
      caps.set('AUTH', [...existing, upper.slice(5), ...args.map((a) => a.toUpperCase())]);
      continue;
    }
    const values = args.map((a) => a.toUpperCase());
    caps.set(upper, upper === 'AUTH' ? [...(caps.get('AUTH') || []), ...values] : values);
  }
  return caps;
}

async function authenticate(channel, user, pass, mechanisms) {
  const b64 = (value) => Buffer.from(String(value ?? ''), 'utf8').toString('base64');

  // Prefer PLAIN: one round trip, and it is what every modern relay wants.
  // An empty list means the server advertised no AUTH at all — try PLAIN
  // anyway so the failure comes back as the server's own refusal rather than
  // a guess on our side.
  if (mechanisms.includes('PLAIN') || mechanisms.length === 0) {
    await command(channel, 'AUTH', `AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
    return 'PLAIN';
  }
  if (mechanisms.includes('LOGIN')) {
    await command(channel, 'AUTH', 'AUTH LOGIN', [334]);
    await command(channel, 'AUTH', b64(user), [334]);
    await command(channel, 'AUTH', b64(pass), [235]);
    return 'LOGIN';
  }
  throw new SmtpError(
    'AUTH',
    `the server offers no authentication method this client supports (it advertises: ${mechanisms.join(', ')})`,
  );
}

// --------------------------------------------------------------- session --

async function openSession({ host, port, secure, user, pass, timeout, tlsOptions, clientName }) {
  const stage = { current: 'connect' };
  let socket = await connectSocket({ host, port, secure, timeout, tlsOptions });
  let channel = createChannel(socket, timeout, stage);
  let encrypted = secure;

  try {
    stage.current = 'greeting';
    const greeting = await channel.read();
    if (greeting.code !== 220) throw rejected('greeting', greeting);

    let hello = await greet(channel, clientName);
    let caps = parseCapabilities(hello.esmtp ? hello.reply : null);

    if (!encrypted && caps.has('STARTTLS')) {
      await command(channel, 'STARTTLS', 'STARTTLS', [220]);
      ({ socket, channel } = await upgradeToTls({ socket, channel, host, timeout, tlsOptions, stage }));
      encrypted = true;
      // Capabilities before and after the upgrade are allowed to differ, and
      // usually do: AUTH commonly only appears once the channel is protected.
      hello = await greet(channel, clientName);
      caps = parseCapabilities(hello.esmtp ? hello.reply : null);
    }

    let authenticated = false;
    if (user) {
      await authenticate(channel, user, pass, caps.get('AUTH') || []);
      authenticated = true;
    }

    return {
      greeting: greeting.raw,
      capabilities: [...caps.keys()],
      authenticated,
      encrypted,
      esmtp: hello.esmtp,
      command: (name, line, expect) => command(channel, name, line, expect),
      write: (text) => channel.write(text),
      read: () => channel.read(),
      setStage: (name) => {
        stage.current = name;
      },
      /** Polite close. A relay that mishandles QUIT has still accepted the mail. */
      async quit() {
        try {
          await command(channel, 'QUIT', 'QUIT', [221]);
        } catch {
          /* the message was already accepted at this point */
        }
        socket.destroy();
      },
      close: () => socket.destroy(),
    };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

// ------------------------------------------------------------------ MIME --

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date, always in UTC: the sender's local zone tells the reader nothing. */
export function rfc5322Date(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * RFC 2047 encoded words for header text that is not plain ASCII.
 *
 * Base64 rather than Q-encoding: accented Latin text is mostly non-ASCII once
 * you hit a subject like "Rapport hebdomadaire — monsite.fr", where Q would
 * escape more than half the bytes anyway. Chunks are split on code points, so
 * a multi-byte character is never cut in half, and each encoded word stays
 * under the 75-character limit.
 */
export function encodeHeaderText(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(text)) return text;

  const MAX_BYTES = 45; // 45 bytes -> 60 base64 chars -> 72 with the =?UTF-8?B?…?= wrapper
  const chunks = [];
  let piece = '';
  for (const char of text) {
    if (Buffer.byteLength(piece + char, 'utf8') > MAX_BYTES) {
      chunks.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece) chunks.push(piece);

  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** The bare address out of `Name <a@b>` or `a@b`. */
export function addressOf(input) {
  const value = String(input ?? '').trim();
  const angle = /<([^>]*)>/.exec(value);
  return (angle ? angle[1] : value).trim();
}

/** `Name <a@b>` with the display name encoded and quoted as needed. */
export function formatAddress(input) {
  const value = String(input ?? '').trim();
  const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(value);
  if (!match || !match[1]) return addressOf(value);
  const name = encodeHeaderText(match[1].replace(/^"|"$/g, ''));
  // An encoded word must not be quoted; a raw name containing specials must be.
  const needsQuotes = !name.startsWith('=?') && /[",;:<>@[\]\\().]/.test(name);
  return `${needsQuotes ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name} <${addressOf(value)}>`;
}

/**
 * Quoted-printable (RFC 2045 §6.7).
 *
 * Chosen over base64 for both parts so the message stays legible on the wire —
 * which is also what makes dot-stuffing observable rather than accidental.
 */
export function encodeQuotedPrintable(input) {
  const bytes = Buffer.from(String(input ?? '').replace(/\r\n?/g, '\n'), 'utf8');
  let out = '';
  let lineLength = 0;

  const put = (token) => {
    // 75 + the trailing "=" of a soft break keeps every line within 76.
    if (lineLength + token.length > 75) {
      out += `=${CRLF}`;
      lineLength = 0;
    }
    out += token;
    lineLength += token.length;
  };

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      out += CRLF;
      lineLength = 0;
      continue;
    }
    const lastOnLine = i + 1 >= bytes.length || bytes[i + 1] === 0x0a;
    if ((byte === 0x20 || byte === 0x09) && !lastOnLine) {
      // Trailing whitespace is stripped by many relays, so only interior
      // spaces and tabs may travel literally.
      put(String.fromCharCode(byte));
      continue;
    }
    if (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) {
      put(String.fromCharCode(byte));
      continue;
    }
    put(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
  }

  return out;
}

/** Header values are never allowed to carry a line break — that is header injection. */
const headerValue = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * An address carrying a CR, an LF or a NUL is rejected outright rather than
 * cleaned up, because there is no safe way to clean it up.
 *
 * Stripping the break turns `victim@example.com\r\nRCPT TO:<attacker@evil>`
 * into a single line that still contains angle brackets, and `addressOf` then
 * resolves it to the attacker — the message is delivered to them and not to
 * the victim, with nothing anywhere saying so. Left in place, the same value
 * appends a `Bcc:` of the attacker's choosing to the message, or a command of
 * their choosing to the session. A loud configuration error is the only
 * outcome that is not a silent compromise.
 */
function assertAddressSafe(what, value) {
  if (!/[\r\n\0]/.test(String(value ?? ''))) return;
  const shown = JSON.stringify(String(value).slice(0, 60));
  throw new SmtpError('config', `Refusing to send: the ${what} address ${shown} contains a line break or NUL`);
}

/**
 * Fold a long header at its commas. Only address lists are folded — an encoded
 * Subject folds itself between encoded words — and every continuation line
 * starts with a space, without which the receiver reads it as a new header.
 */
function foldHeader(name, value) {
  // Belt and braces. Every caller either sanitizes its value with
  // `headerValue`, validates it with `assertAddressSafe`, or generates it —
  // so a bare line break reaching here means a new caller did none of those.
  // A CRLF followed by a space or tab is a legal continuation, which is how
  // `encodeHeaderText` folds a long Subject between encoded words: drop those
  // first, then any line break still standing is an injected header.
  if (/[\r\n]/.test(String(value).replace(/\r\n[ \t]/g, ' '))) {
    throw new SmtpError('config', `Refusing to send: the ${name} header contains a line break`);
  }
  const single = `${name}: ${value}`;
  if (single.length <= 78 || !value.includes(', ')) return single;

  const lines = [];
  let current = `${name}:`;
  let empty = true;
  for (const part of value.split(', ')) {
    const piece = ` ${part},`;
    if (!empty && current.length + piece.length > 78) {
      lines.push(current);
      current = piece;
    } else {
      current += piece;
    }
    empty = false;
  }
  lines.push(current);
  return lines.join(CRLF).replace(/,$/, '');
}

const RESERVED_HEADERS = new Set([
  'date',
  'from',
  'to',
  'subject',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  // Delivery is driven by the envelope (RCPT TO), which this module builds
  // from `to` alone — so a `Bcc` header would deliver to nobody while showing
  // the address to every recipient, the one thing Bcc must never do. Blind
  // copying is done by adding the address to `to`, not by asking for it here.
  'bcc',
]);

/**
 * Build the RFC 5322 message.
 *
 * multipart/alternative with the plain text part first: that ordering is what
 * tells a client the HTML is the richer rendering of the same content, and
 * text-only clients show the part they can actually read.
 *
 * @returns {{ raw: string, messageId: string, boundary: string }}
 */
export function buildMessage({ from, to, subject, text, html, headers = {}, date = new Date(), messageId }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  assertAddressSafe('sender', from);
  for (const recipient of recipients) assertAddressSafe('recipient', recipient);
  const sender = addressOf(from);
  const domain = sender.split('@')[1] || os.hostname() || 'localhost';
  const id = messageId || `<${Date.now().toString(36)}.${crypto.randomBytes(12).toString('hex')}@${domain}>`;

  const hasText = text != null && String(text) !== '';
  const hasHtml = html != null && String(html) !== '';
  if (!hasText && !hasHtml) throw new SmtpError('config', 'Refusing to send an empty message: give it a text or html body');

  const lines = [
    foldHeader('Date', rfc5322Date(date)),
    foldHeader('From', formatAddress(from)),
    foldHeader('To', recipients.map(formatAddress).join(', ')),
    foldHeader('Subject', encodeHeaderText(subject)),
    foldHeader('Message-ID', headerValue(id)),
    'MIME-Version: 1.0',
    // RFC 3834: every message this subsystem sends is machine generated, and
    // saying so keeps vacation responders from answering a weekly digest.
    'Auto-Submitted: auto-generated',
  ];

  for (const [name, value] of Object.entries(headers)) {
    if (value == null || value === '') continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    lines.push(foldHeader(headerValue(name), headerValue(value)));
  }

  let body;
  let boundary = '';
  if (hasText && hasHtml) {
    boundary = uniqueBoundary(`${text}\n${html}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(html),
      `--${boundary}--`,
      '',
    ].join(CRLF);
  } else {
    lines.push(`Content-Type: text/${hasHtml ? 'html' : 'plain'}; charset=utf-8`);
    lines.push('Content-Transfer-Encoding: quoted-printable');
    body = `${encodeQuotedPrintable(hasHtml ? html : text)}${CRLF}`;
  }

  return { raw: `${lines.join(CRLF)}${CRLF}${CRLF}${body}`, messageId: id, boundary };
}

/** A boundary that cannot occur in the content it delimits. */
function uniqueBoundary(content) {
  for (;;) {
    const candidate = `--=_credible_${crypto.randomBytes(16).toString('hex')}`;
    if (!content.includes(candidate)) return candidate;
  }
}

/** RFC 5321 §4.5.2 — a body line starting with "." is doubled on the wire. */
export function dotStuff(message) {
  return message
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

// -------------------------------------------------------------- public API --

function resolveOptions({ host, port, secure, user, pass, from, timeout = 20000, tls: tlsOptions = {} }) {
  if (!host) {
    throw new SmtpError(
      'config',
      'Email is not configured: set CREDIBLE_SMTP_HOST (and CREDIBLE_SMTP_USER / CREDIBLE_SMTP_PASS if the relay needs them)',
    );
  }
  const resolvedPort = Number(port) || 587;
  // Port 465 is implicit TLS from the first byte; 25/587 start in the clear
  // and are upgraded with STARTTLS when the server advertises it.
  const resolvedSecure = secure === undefined || secure === null ? resolvedPort === 465 : Boolean(secure);
  return {
    host: String(host),
    port: resolvedPort,
    secure: resolvedSecure,
    user: user ? String(user) : '',
    pass: pass == null ? '' : String(pass),
    timeout: Number(timeout) > 0 ? Number(timeout) : 20000,
    tlsOptions,
    clientName: clientNameFor(from),
  };
}

/**
 * EHLO must name a domain, not a hostname with spaces or accents in it. The
 * sender's own domain is both valid and the value a relay's SPF check expects
 * to see; a bracketed literal is the RFC-blessed last resort.
 */
function clientNameFor(from) {
  const domain = addressOf(from).split('@')[1];
  const candidate = domain || os.hostname();
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(candidate || '') ? candidate : '[127.0.0.1]';
}

function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : String(to ?? '').split(',');
  return list.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

/**
 * Send one message.
 *
 * @param {object} input
 * @param {string} input.host      relay hostname; omitting it is a configuration error
 * @param {number} [input.port]    defaults to 587
 * @param {boolean} [input.secure] implicit TLS; defaults to true on port 465
 * @param {string} [input.user]    when empty, no AUTH is attempted
 * @param {string} [input.pass]
 * @param {string} input.from      `a@b` or `Name <a@b>`
 * @param {string|string[]} input.to
 * @param {string} input.subject
 * @param {string} [input.text]
 * @param {string} [input.html]
 * @param {object} [input.headers] extra headers, e.g. List-Unsubscribe
 * @param {number} [input.timeout] milliseconds, applied to every read and write
 * @param {object} [input.tls]     options forwarded to node:tls
 * @returns {Promise<{accepted: string[], response: string, messageId: string}>}
 */
export async function sendMail(input) {
  const options = resolveOptions(input);
  const { from, subject, text, html, headers } = input;

  const recipients = normalizeRecipients(input.to);
  if (!recipients.length) throw new SmtpError('config', 'Refusing to send: no recipient');
  if (!addressOf(from).includes('@')) throw new SmtpError('config', `Refusing to send: "${from}" is not a usable sender address`);

  const message = buildMessage({ from, to: recipients, subject, text, html, headers });

  const session = await openSession(options);
  try {
    await session.command('MAIL FROM', `MAIL FROM:<${addressOf(from)}>`, [250]);
    for (const recipient of recipients) {
      await session.command('RCPT TO', `RCPT TO:<${addressOf(recipient)}>`, [250, 251]);
    }
    await session.command('DATA', 'DATA', [354]);

    session.setStage('DATA');
    const stuffed = dotStuff(message.raw);
    await session.write(`${stuffed.endsWith(CRLF) ? stuffed : stuffed + CRLF}.${CRLF}`);
    const reply = await session.read();
    if (reply.code !== 250) throw rejected('DATA', reply);

    await session.quit();
    return { accepted: recipients, response: reply.raw, messageId: message.messageId };
  } catch (err) {
    session.close();
    throw err;
  }
}

/**
 * Connect, greet, authenticate, hang up. Nothing is sent and no recipient is
 * touched, so this is safe to run from `credible doctor` against production.
 *
 * @returns {Promise<{greeting: string, capabilities: string[], authenticated: boolean, encrypted: boolean, esmtp: boolean}>}
 */
export async function verify(input) {
  const options = resolveOptions(input);
  const session = await openSession(options);
  const { greeting, capabilities, authenticated, encrypted, esmtp } = session;
  await session.quit();
  return { greeting, capabilities, authenticated, encrypted, esmtp };
}
