/**
 * The mail subsystem: the SMTP conversation, the MIME encoding, and the words.
 *
 * Every SMTP test runs against a throwaway server built on node:net in this
 * file, which speaks just enough of RFC 5321 to record what the client did.
 * Nothing here touches the network.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import './helpers.js';

import net from 'node:net';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SmtpError,
  buildMessage,
  encodeHeaderText,
  encodeQuotedPrintable,
  rfc5322Date,
  sendMail,
  verify,
} from '../src/mail/smtp.js';
import {
  formatDelta,
  formatDuration,
  formatPeriod,
  renderDropAlert,
  renderInvitation,
  renderMonthlyReport,
  renderPasswordReset,
  renderSpikeAlert,
  renderWeeklyReport,
  safeUrl,
} from '../src/mail/render.js';
import { mailConfigured, mailSettings, send, verifyConnection } from '../src/mail/index.js';

// ------------------------------------------------------- a fake SMTP relay --

/**
 * Minimal SMTP server for the tests.
 *
 * Records the exact command lines it received and the raw DATA payload (still
 * dot-stuffed, so the stuffing itself can be asserted on).
 */
const relays = new Set();

function startRelay(options = {}) {
  const {
    capabilities = ['SIZE 10485760', '8BITMIME', 'AUTH PLAIN LOGIN', 'HELP'],
    silent = false, // accept the connection, then say nothing at all
    rejectRcpt = '',
    rejectAuth = false,
    dribble = false, // write replies one byte at a time
    startTlsReply = '220 2.0.0 Ready to start TLS',
    esmtp = true, // false: a relay old enough to reject EHLO outright
  } = options;

  const sessions = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    const session = { commands: [], raw: '', user: '', pass: '', mechanism: '' };
    sessions.push(session);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (silent) return;

    const say = (line) => {
      const payload = `${line}\r\n`;
      if (!dribble) {
        socket.write(payload);
        return;
      }
      for (const byte of Buffer.from(payload)) socket.write(Buffer.from([byte]));
    };

    let buffer = '';
    let mode = 'command';

    const handle = (line) => {
      // After agreeing to STARTTLS this server goes deaf: it speaks no TLS, so
      // the client's handshake gets no answer, which is the deterministic way
      // to exercise the upgrade path without shipping a certificate.
      if (mode === 'deaf') return;
      if (mode === 'data') {
        if (line === '.') {
          mode = 'command';
          say('250 2.0.0 Ok: queued as ABC123');
          return;
        }
        session.raw += `${line}\r\n`;
        return;
      }
      if (mode === 'auth-user') {
        session.user = Buffer.from(line, 'base64').toString('utf8');
        mode = 'auth-pass';
        say('334 UGFzc3dvcmQ6');
        return;
      }
      if (mode === 'auth-pass') {
        session.pass = Buffer.from(line, 'base64').toString('utf8');
        mode = 'command';
        say(rejectAuth ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
        return;
      }

      session.commands.push(line);
      const [verb, ...rest] = line.split(' ');
      const upper = verb.toUpperCase();

      if (upper === 'EHLO') {
        if (!esmtp) return say('500 5.5.1 Command unrecognized: "EHLO"');
        if (!capabilities.length) {
          say('250 fake.smtp');
          return;
        }
        say(`250-fake.smtp greets ${rest.join(' ')}`);
        capabilities.forEach((cap, index) => say(`${index === capabilities.length - 1 ? '250 ' : '250-'}${cap}`));
        return;
      }
      if (upper === 'HELO') return say('250 fake.smtp');
      if (upper === 'STARTTLS') {
        say(startTlsReply);
        if (startTlsReply.startsWith('220')) mode = 'deaf';
        return;
      }
      if (upper === 'AUTH') {
        const mechanism = (rest[0] || '').toUpperCase();
        session.mechanism = mechanism;
        if (mechanism === 'PLAIN') {
          const decoded = Buffer.from(rest[1] || '', 'base64').toString('utf8').split('\0');
          session.user = decoded[1] || '';
          session.pass = decoded[2] || '';
          return say(rejectAuth ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
        }
        if (mechanism === 'LOGIN') {
          mode = 'auth-user';
          return say('334 VXNlcm5hbWU6');
        }
        return say('504 5.5.4 Unrecognized authentication type');
      }
      if (upper === 'MAIL') return say('250 2.1.0 Ok');
      if (upper === 'RCPT') return say(rejectRcpt || '250 2.1.5 Ok');
      if (upper === 'DATA') {
        mode = 'data';
        return say('354 End data with <CR><LF>.<CR><LF>');
      }
      if (upper === 'RSET') return say('250 2.0.0 Ok');
      if (upper === 'QUIT') {
        say('221 2.0.0 Bye');
        socket.end();
        return;
      }
      say('500 5.5.2 Command unrecognized');
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        handle(line);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      /* the client hangs up abruptly in the failure tests */
    });

    say('220 fake.smtp ESMTP Credible test');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const relay = {
        port: server.address().port,
        host: '127.0.0.1',
        sessions,
        session: () => sessions[sessions.length - 1],
        close() {
          relays.delete(relay);
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      };
      // A failing assertion skips the rest of its test, so every relay is
      // registered for cleanup rather than trusted to close itself. A leaked
      // listening socket would otherwise keep the test runner alive forever.
      relays.add(relay);
      resolve(relay);
    });
  });
}

after(async () => {
  await Promise.all([...relays].map((relay) => relay.close()));
});

// ------------------------------------------------------------- decoding --

function decodeQuotedPrintable(text) {
  const bytes = text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, 'binary').toString('utf8');
}

/** Undo RFC 2047 encoded words, including the fold between adjacent ones. */
function decodeHeader(value) {
  return value
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
}

/** Undo the transport encoding a DATA payload went through. */
const unstuff = (raw) =>
  raw
    .split('\r\n')
    .map((line) => (line.startsWith('..') ? line.slice(1) : line))
    .join('\r\n');

function parseMessage(raw) {
  const body = unstuff(raw);
  const split = body.indexOf('\r\n\r\n');
  const headerBlock = body.slice(0, split);
  const headers = new Map();
  // Unfold, then split: a folded header continues on a line starting with WSP.
  for (const line of headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: body.slice(split + 4), headerBlock, raw };
}

function parseParts(message) {
  const boundary = /boundary="([^"]+)"/.exec(message.headers.get('content-type'))?.[1];
  assert.ok(boundary, 'the message declares a multipart boundary');
  return message.body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const trimmed = chunk.replace(/^\r\n/, '');
      const split = trimmed.indexOf('\r\n\r\n');
      const headers = new Map();
      for (const line of trimmed.slice(0, split).split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      return { headers, content: trimmed.slice(split + 4).replace(/\r\n$/, '') };
    });
}

const BASE = {
  from: 'Credible <reports@stats.example>',
  to: 'owner@example.com',
  subject: 'Hello',
  text: 'Plain body.',
  html: '<p>Plain body.</p>',
  timeout: 4000,
};

// --------------------------------------------------------------- the wire --

describe('sendMail', () => {
  it('refuses to send when no host is configured', async () => {
    await assert.rejects(
      () => sendMail({ ...BASE, host: '' }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.equal(err.stage, 'config');
        assert.match(err.message, /not configured/i);
        assert.match(err.message, /CREDIBLE_SMTP_HOST/);
        return true;
      },
    );
  });

  it('walks the whole conversation and authenticates with PLAIN', async () => {
    const relay = await startRelay();
    const result = await sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'postmaster', pass: 's3cret' });

    const session = relay.session();
    const verbs = session.commands.map((line) => line.split(':')[0].split(' ').slice(0, 2).join(' '));
    assert.deepEqual(verbs, [
      'EHLO stats.example',
      'AUTH PLAIN',
      'MAIL FROM',
      'RCPT TO',
      'DATA',
      'QUIT',
    ]);

    assert.equal(session.mechanism, 'PLAIN');
    assert.equal(session.user, 'postmaster');
    assert.equal(session.pass, 's3cret');

    // The envelope carries bare addresses, never the display name.
    assert.ok(session.commands.includes('MAIL FROM:<reports@stats.example>'));
    assert.ok(session.commands.includes('RCPT TO:<owner@example.com>'));

    assert.deepEqual(result.accepted, ['owner@example.com']);
    assert.match(result.response, /^250 /);
    assert.match(result.messageId, /^<[^>]+@stats\.example>$/);

    await relay.close();
  });

  it('falls back to AUTH LOGIN when that is all the server offers', async () => {
    const relay = await startRelay({ capabilities: ['AUTH LOGIN'] });
    await sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'user@example.com', pass: 'påssord' });

    const session = relay.session();
    assert.equal(session.mechanism, 'LOGIN');
    assert.equal(session.user, 'user@example.com');
    assert.equal(session.pass, 'påssord', 'the password round-trips through base64 as UTF-8');
    // The credentials are sent as bare base64 lines, not as AUTH arguments.
    assert.ok(session.commands.includes('AUTH LOGIN'));

    await relay.close();
  });

  it('reads the pre-standard AUTH=LOGIN capability spelling', async () => {
    const relay = await startRelay({ capabilities: ['AUTH=LOGIN'] });
    await sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'legacy', pass: 'pw' });
    assert.equal(relay.session().mechanism, 'LOGIN');
    await relay.close();
  });

  it('skips AUTH entirely when no username is given', async () => {
    const relay = await startRelay();
    await sendMail({ ...BASE, host: relay.host, port: relay.port });
    assert.ok(!relay.session().commands.some((line) => line.startsWith('AUTH')));
    await relay.close();
  });

  it('reassembles multi-line replies split across TCP chunks', async () => {
    const relay = await startRelay({ dribble: true });
    const result = await sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'u', pass: 'p' });
    assert.deepEqual(result.accepted, ['owner@example.com']);
    assert.equal(relay.session().mechanism, 'PLAIN', 'the capability list survived byte-by-byte delivery');
    await relay.close();
  });

  it('dot-stuffs a body line that is a single dot', async () => {
    const relay = await startRelay();
    const text = ['before', '.', 'after', '..still two dots'].join('\n');
    await sendMail({ ...BASE, host: relay.host, port: relay.port, text, html: '<p>x</p>' });

    const raw = relay.session().raw;
    assert.ok(raw.includes('\r\n..\r\n'), 'the lone dot was doubled on the wire');
    assert.ok(raw.includes('\r\n...still two dots\r\n'), 'a line already starting with a dot gained one more');
    assert.ok(!/\r\n\.\r\n/.test(raw), 'no bare dot line survived inside the payload');

    const [plain] = parseParts(parseMessage(raw));
    assert.equal(decodeQuotedPrintable(plain.content), 'before\r\n.\r\nafter\r\n..still two dots');

    await relay.close();
  });

  it('encodes a UTF-8 subject so it arrives readable', async () => {
    const relay = await startRelay();
    const subject = 'Rapport hebdomadaire — monsite.fr';
    await sendMail({ ...BASE, host: relay.host, port: relay.port, subject });

    const message = parseMessage(relay.session().raw);
    const encoded = message.headers.get('subject');
    assert.match(encoded, /^=\?UTF-8\?B\?/, 'a non-ASCII subject is sent as an RFC 2047 encoded word');
    assert.ok(!/[^\x00-\x7f]/.test(message.headerBlock), 'no raw 8-bit byte leaks into the header block');
    assert.equal(decodeHeader(encoded), subject);

    await relay.close();
  });

  it('splits a long UTF-8 subject into several encoded words', async () => {
    const relay = await startRelay();
    const subject = `Rapport hebdomadaire — ${'très détaillé '.repeat(8)}fin`;
    await sendMail({ ...BASE, host: relay.host, port: relay.port, subject });

    const message = parseMessage(relay.session().raw);
    const rawSubject = /^Subject: (.*(?:\r\n[ \t].*)*)$/m.exec(message.raw.replace(/^\.\./gm, '.'))?.[1] || '';
    for (const line of rawSubject.split('\r\n')) {
      assert.ok(line.trim().length <= 76, `header line stays short: ${line.trim().length}`);
    }
    assert.ok(rawSubject.split('=?UTF-8?B?').length > 2, 'it took more than one encoded word');
    assert.equal(decodeHeader(message.headers.get('subject')), subject.trim());

    await relay.close();
  });

  it('leaves a plain ASCII subject alone', async () => {
    const relay = await startRelay();
    await sendMail({ ...BASE, host: relay.host, port: relay.port, subject: 'Weekly report for example.com' });
    assert.equal(parseMessage(relay.session().raw).headers.get('subject'), 'Weekly report for example.com');
    await relay.close();
  });

  it('builds a multipart/alternative message with the text part first', async () => {
    const relay = await startRelay();
    const text = 'Visitors: 1 204\nBounce rate: 42%';
    const html = '<p>Visitors: 1&nbsp;204 — 42% bounce</p>';
    await sendMail({ ...BASE, host: relay.host, port: relay.port, text, html, subject: 'Structure' });

    const message = parseMessage(relay.session().raw);
    assert.match(message.headers.get('content-type'), /^multipart\/alternative; boundary="/);
    assert.equal(message.headers.get('mime-version'), '1.0');
    assert.equal(message.headers.get('from'), 'Credible <reports@stats.example>');
    assert.equal(message.headers.get('to'), 'owner@example.com');
    assert.equal(message.headers.get('auto-submitted'), 'auto-generated');
    assert.match(message.headers.get('date'), /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);

    const parts = parseParts(message);
    assert.equal(parts.length, 2);
    assert.match(parts[0].headers.get('content-type'), /^text\/plain; charset=utf-8$/);
    assert.equal(parts[0].headers.get('content-transfer-encoding'), 'quoted-printable');
    assert.match(parts[1].headers.get('content-type'), /^text\/html; charset=utf-8$/);
    assert.equal(decodeQuotedPrintable(parts[0].content), text.replace(/\n/g, '\r\n'));
    assert.equal(decodeQuotedPrintable(parts[1].content), html);

    await relay.close();
  });

  it('sends to several recipients and lists them all', async () => {
    const relay = await startRelay();
    const result = await sendMail({
      ...BASE,
      host: relay.host,
      port: relay.port,
      to: ['one@example.com', 'Two <two@example.com>'],
    });

    const rcpt = relay.session().commands.filter((line) => line.startsWith('RCPT TO'));
    assert.deepEqual(rcpt, ['RCPT TO:<one@example.com>', 'RCPT TO:<two@example.com>']);
    assert.equal(result.accepted.length, 2);
    assert.equal(parseMessage(relay.session().raw).headers.get('to'), 'one@example.com, Two <two@example.com>');

    await relay.close();
  });

  it('never lets a header value inject another header', async () => {
    const relay = await startRelay();
    await sendMail({
      ...BASE,
      host: relay.host,
      port: relay.port,
      subject: 'Weekly\r\nBcc: attacker@example.net',
    });

    const message = parseMessage(relay.session().raw);
    assert.equal(message.headers.has('bcc'), false);
    assert.equal(message.headers.get('subject'), 'Weekly Bcc: attacker@example.net');

    await relay.close();
  });

  it('turns a rejected recipient into a typed error naming the stage', async () => {
    const relay = await startRelay({ rejectRcpt: '550 5.1.1 <owner@example.com>: Recipient address rejected' });
    await assert.rejects(
      () => sendMail({ ...BASE, host: relay.host, port: relay.port }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.equal(err.stage, 'RCPT TO');
        assert.equal(err.code, 550);
        assert.match(err.reply, /Recipient address rejected/);
        assert.match(err.message, /^SMTP RCPT TO failed: 550 /);
        return true;
      },
    );
    // It stopped before DATA rather than sending a message nobody will get.
    assert.ok(!relay.session().commands.includes('DATA'));
    await relay.close();
  });

  it('reports a refused authentication with the server’s own words', async () => {
    const relay = await startRelay({ rejectAuth: true });
    await assert.rejects(
      () => sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'u', pass: 'wrong' }),
      (err) => {
        assert.equal(err.stage, 'AUTH');
        assert.equal(err.code, 535);
        assert.match(err.message, /Authentication credentials invalid/);
        return true;
      },
    );
    await relay.close();
  });

  it('enforces the timeout when the relay accepts the connection and goes quiet', async () => {
    const relay = await startRelay({ silent: true });
    const started = Date.now();
    await assert.rejects(
      () => sendMail({ ...BASE, host: relay.host, port: relay.port, timeout: 200 }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.equal(err.stage, 'greeting');
        assert.match(err.message, /no reply from the server within 200 ms/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 190 && elapsed < 3000, `waited ${elapsed} ms, which is the configured timeout and no longer`);
    await relay.close();
  });

  it('upgrades with STARTTLS before sending credentials', async () => {
    const relay = await startRelay({ capabilities: ['STARTTLS', 'AUTH PLAIN'] });
    // The relay answers 220 and then speaks no TLS at all, so the handshake
    // stalls and the client's own deadline is what ends it.
    await assert.rejects(
      () => sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'u', pass: 'p', timeout: 300 }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.equal(err.stage, 'STARTTLS');
        assert.match(err.message, /TLS handshake did not complete within 300 ms/);
        return true;
      },
    );

    const commands = relay.session().commands;
    assert.deepEqual(commands, ['EHLO stats.example', 'STARTTLS']);
    assert.ok(!commands.some((line) => line.startsWith('AUTH')), 'credentials never travel before the upgrade');
    await relay.close();
  });

  it('reports a refused STARTTLS rather than carrying on in the clear', async () => {
    const relay = await startRelay({
      capabilities: ['STARTTLS', 'AUTH PLAIN'],
      startTlsReply: '454 4.7.0 TLS not available due to temporary reason',
    });
    await assert.rejects(
      () => sendMail({ ...BASE, host: relay.host, port: relay.port, user: 'u', pass: 'p', timeout: 2000 }),
      (err) => {
        assert.equal(err.stage, 'STARTTLS');
        assert.equal(err.code, 454);
        return true;
      },
    );
    assert.ok(!relay.session().commands.some((line) => line.startsWith('AUTH')));
    await relay.close();
  });

  it('falls back to HELO for a server that does not speak ESMTP', async () => {
    const relay = await startRelay({ esmtp: false });
    const result = await sendMail({ ...BASE, host: relay.host, port: relay.port });
    assert.deepEqual(result.accepted, ['owner@example.com']);
    assert.deepEqual(relay.session().commands.slice(0, 2), ['EHLO stats.example', 'HELO stats.example']);
    await relay.close();
  });

  it('sends a message unchanged when the server advertises no capabilities', async () => {
    const relay = await startRelay({ capabilities: [] });
    const result = await sendMail({ ...BASE, host: relay.host, port: relay.port });
    assert.deepEqual(result.accepted, ['owner@example.com']);
    await relay.close();
  });

  /**
   * A line break in an address is the dangerous case, and it is dangerous in a
   * way that sanitizing does not fix: strip the break out of
   * `victim@example.com\r\nRCPT TO:<attacker@example.net>` and what is left
   * still contains angle brackets, so `addressOf` resolves it to the attacker
   * and the message is delivered to them alone, with nothing saying so.
   * Rejecting before the socket is opened is the only safe answer.
   */
  it('refuses an address containing a line break instead of quietly redirecting it', async () => {
    const relay = await startRelay();

    for (const [what, message] of [
      ['recipient', { ...BASE, to: 'victim@example.com\r\nRCPT TO:<attacker@example.net>' }],
      ['recipient', { ...BASE, to: 'victim@example.com\r\nBcc: attacker@example.net' }],
      ['recipient', { ...BASE, to: ['ok@example.com', 'Name\r\nBcc: attacker@example.net <v@example.com>'] }],
      ['sender', { ...BASE, from: 'reports@stats.example\r\nBcc: attacker@example.net' }],
      ['recipient', { ...BASE, to: 'victim@example.com\0attacker@example.net' }],
    ]) {
      await assert.rejects(
        () => sendMail({ ...message, host: relay.host, port: relay.port }),
        (err) => {
          assert.ok(err instanceof SmtpError);
          assert.equal(err.stage, 'config');
          assert.match(err.message, new RegExp(`the ${what} address .* contains a line break or NUL`));
          return true;
        },
      );
    }

    assert.equal(relay.sessions.length, 0, 'no connection was opened for any of them');
    await relay.close();
  });

  it('refuses a Bcc header, which would leak the address without delivering to it', async () => {
    const relay = await startRelay();
    await sendMail({
      ...BASE,
      host: relay.host,
      port: relay.port,
      headers: { Bcc: 'attacker@example.net', 'X-Credible-Report': 'weekly' },
    });

    const message = parseMessage(relay.session().raw);
    assert.equal(message.headers.has('bcc'), false);
    assert.equal(message.headers.get('x-credible-report'), 'weekly');
    assert.deepEqual(
      relay.session().commands.filter((line) => line.startsWith('RCPT TO')),
      ['RCPT TO:<owner@example.com>'],
    );

    await relay.close();
  });

  /**
   * A relay that accepts the connection and then streams bytes with no line
   * ending used to be bounded only by the timeout, and since each chunk was
   * concatenated onto the last the cost was quadratic — 44 MB of input moved
   * RSS by 3.9 GB before the read gave up.
   */
  it('gives up on a reply line long before it can exhaust memory', async () => {
    const flood = net.createServer((socket) => {
      socket.write('220 flood.smtp ESMTP\r\n');
      socket.on('error', () => {});
      const pump = () => {
        // 1 MB at a time, not a single line feed anywhere in it.
        while (socket.writable && socket.write(Buffer.alloc(1024 * 1024, 0x41))) { /* until backpressure */ }
        if (socket.writable) socket.once('drain', pump);
      };
      socket.on('data', () => setTimeout(pump, 10));
    });
    await new Promise((resolve) => flood.listen(0, '127.0.0.1', resolve));

    const before = process.memoryUsage().rss;
    await assert.rejects(
      () => verify({ host: '127.0.0.1', port: flood.address().port, from: 'reports@stats.example', timeout: 4000 }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.match(err.message, /without ending a line/);
        return true;
      },
    );
    const grew = (process.memoryUsage().rss - before) / (1024 * 1024);
    assert.ok(grew < 200, `resident memory grew by ${grew.toFixed(0)} MB`);

    await new Promise((resolve) => flood.close(resolve));
  });

  it('gives up on a reply with an absurd number of continuation lines', async () => {
    const chatty = net.createServer((socket) => {
      socket.write('220 chatty.smtp ESMTP\r\n');
      socket.on('error', () => {});
      socket.on('data', () => {
        // 250- forever: a continuation line never completes the reply.
        for (let i = 0; i < 5000; i += 1) socket.write(`250-KEYWORD-${i}\r\n`);
      });
    });
    await new Promise((resolve) => chatty.listen(0, '127.0.0.1', resolve));

    await assert.rejects(
      () => verify({ host: '127.0.0.1', port: chatty.address().port, from: 'reports@stats.example', timeout: 4000 }),
      (err) => {
        assert.ok(err instanceof SmtpError);
        assert.match(err.message, /continuation lines/);
        return true;
      },
    );

    await new Promise((resolve) => chatty.close(resolve));
  });
});

describe('verify', () => {
  it('greets, authenticates and hangs up without composing anything', async () => {
    const relay = await startRelay();
    const result = await verify({
      host: relay.host,
      port: relay.port,
      user: 'postmaster',
      pass: 'pw',
      from: 'reports@stats.example',
      timeout: 4000,
    });

    assert.equal(result.authenticated, true);
    assert.equal(result.esmtp, true);
    assert.ok(result.capabilities.includes('AUTH'));
    assert.match(result.greeting, /^220 /);

    const verbs = relay.session().commands.map((line) => line.split(' ').slice(0, 2).join(' '));
    assert.deepEqual(verbs, ['EHLO stats.example', 'AUTH PLAIN', 'QUIT']);
    assert.equal(relay.session().raw, '', 'no DATA was ever sent');
    assert.ok(!relay.session().commands.some((line) => line.startsWith('RCPT')), 'no recipient was ever touched');

    await relay.close();
  });
});

// -------------------------------------------------------------- encoding --

describe('MIME encoding', () => {
  it('encodes quoted-printable within 76 characters per line', () => {
    const encoded = encodeQuotedPrintable(`${'a'.repeat(200)}\nrésumé\ttrailing \nx`);
    for (const line of encoded.split('\r\n')) {
      assert.ok(line.length <= 76, `line of ${line.length} characters`);
    }
    assert.ok(encoded.includes('=C3=A9'), 'é is escaped as its two UTF-8 bytes');
    assert.ok(/=20\r\n/.test(encoded), 'a trailing space is escaped so relays cannot strip it');
    assert.equal(decodeQuotedPrintable(encoded), `${'a'.repeat(200)}\r\nrésumé\ttrailing \r\nx`);
  });

  it('escapes the equals sign and leaves ordinary ASCII alone', () => {
    assert.equal(encodeQuotedPrintable('a=b'), 'a=3Db');
    assert.equal(encodeQuotedPrintable('plain text'), 'plain text');
  });

  it('leaves ASCII header text unencoded', () => {
    assert.equal(encodeHeaderText('Weekly report'), 'Weekly report');
    assert.equal(encodeHeaderText(''), '');
  });

  it('formats an RFC 5322 date in UTC', () => {
    assert.equal(rfc5322Date(new Date('2026-08-16T09:05:03Z')), 'Sun, 16 Aug 2026 09:05:03 +0000');
  });

  it('refuses to build a message with no body at all', () => {
    assert.throws(
      () => buildMessage({ from: 'a@b.test', to: 'c@d.test', subject: 'x' }),
      /Refusing to send an empty message/,
    );
  });

  it('folds a long recipient list into valid continuation lines', () => {
    const recipients = Array.from({ length: 8 }, (_, i) => `owner.number.${i}@a-fairly-long-domain.example`);
    const message = buildMessage({ from: 'a@b.test', to: recipients, subject: 'x', text: 'body' });

    const raw = /^To: (.*(?:\r\n[ \t].*)*)/m.exec(message.raw)[0];
    const lines = raw.split('\r\n');
    assert.ok(lines.length > 1, 'the list really did need folding');
    for (const line of lines) assert.ok(line.length <= 78, `line of ${line.length} characters`);
    for (const line of lines.slice(1)) assert.match(line, /^[ \t]/, 'a continuation line starts with whitespace');

    // Unfolded, it is still exactly the list that went in.
    const unfolded = raw.replace(/\r\n[ \t]+/g, ' ').slice('To: '.length);
    assert.deepEqual(unfolded.split(', '), recipients);
  });

  it('sends a single part when only one body is given', () => {
    const message = buildMessage({ from: 'a@b.test', to: 'c@d.test', subject: 'x', text: 'body' });
    assert.match(message.raw, /Content-Type: text\/plain; charset=utf-8/);
    assert.equal(message.boundary, '');
  });
});

// ------------------------------------------------------- the configuration --

describe('mail configuration', () => {
  const SAVED = { ...process.env };

  const setEnv = (values) => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CREDIBLE_SMTP_')) delete process.env[key];
    }
    Object.assign(process.env, values);
  };

  beforeEach(() => setEnv({}));

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CREDIBLE_SMTP_')) delete process.env[key];
    }
    for (const [key, value] of Object.entries(SAVED)) {
      if (key.startsWith('CREDIBLE_SMTP_')) process.env[key] = value;
    }
  });

  it('reports email as off when no host is set', () => {
    assert.equal(mailConfigured(), false);
    assert.equal(mailSettings().configured, false);
  });

  it('defaults the port to 587 and starts in the clear', () => {
    setEnv({ CREDIBLE_SMTP_HOST: 'smtp.example', CREDIBLE_SMTP_USER: 'me@example.com' });
    const settings = mailSettings();
    assert.equal(mailConfigured(), true);
    assert.deepEqual(settings, {
      host: 'smtp.example',
      port: 587,
      secure: false,
      user: 'me@example.com',
      from: 'me@example.com',
      configured: true,
    });
    assert.ok(!('pass' in settings), 'the password is never part of the reported settings');
  });

  it('treats port 465 as implicit TLS without being told', () => {
    setEnv({ CREDIBLE_SMTP_HOST: 'smtp.example', CREDIBLE_SMTP_PORT: '465' });
    assert.equal(mailSettings().secure, true);
  });

  it('lets CREDIBLE_SMTP_SECURE override the port default in both directions', () => {
    setEnv({ CREDIBLE_SMTP_HOST: 'smtp.example', CREDIBLE_SMTP_PORT: '465', CREDIBLE_SMTP_SECURE: 'false' });
    assert.equal(mailSettings().secure, false);
    setEnv({ CREDIBLE_SMTP_HOST: 'smtp.example', CREDIBLE_SMTP_SECURE: 'true' });
    assert.equal(mailSettings().port, 465);
    assert.equal(mailSettings().secure, true);
  });

  it('prefers CREDIBLE_SMTP_FROM over the username', () => {
    setEnv({
      CREDIBLE_SMTP_HOST: 'smtp.example',
      CREDIBLE_SMTP_USER: 'apikey',
      CREDIBLE_SMTP_FROM: 'Credible <stats@monsite.fr>',
    });
    assert.equal(mailSettings().from, 'Credible <stats@monsite.fr>');
  });

  it('sends through the configured relay', async () => {
    const relay = await startRelay();
    setEnv({
      CREDIBLE_SMTP_HOST: relay.host,
      CREDIBLE_SMTP_PORT: String(relay.port),
      CREDIBLE_SMTP_USER: 'postmaster',
      CREDIBLE_SMTP_PASS: 'pw',
      CREDIBLE_SMTP_FROM: 'Credible <reports@stats.example>',
      CREDIBLE_SMTP_TIMEOUT: '4000',
    });

    const result = await send({
      to: 'owner@example.com',
      subject: 'Weekly report for monsite.fr — 4 – 10 August 2026',
      text: 'plain',
      html: '<p>rich</p>',
      unsubscribeUrl: 'https://stats.example/settings/email',
    });

    assert.deepEqual(result.accepted, ['owner@example.com']);
    const message = parseMessage(relay.session().raw);
    assert.equal(message.headers.get('list-unsubscribe'), '<https://stats.example/settings/email>');
    assert.equal(decodeHeader(message.headers.get('subject')), 'Weekly report for monsite.fr — 4 – 10 August 2026');

    await relay.close();
  });

  it('verifies a live relay for `credible doctor`', async () => {
    const relay = await startRelay();
    setEnv({
      CREDIBLE_SMTP_HOST: relay.host,
      CREDIBLE_SMTP_PORT: String(relay.port),
      CREDIBLE_SMTP_USER: 'postmaster',
      CREDIBLE_SMTP_PASS: 'pw',
      CREDIBLE_SMTP_TIMEOUT: '4000',
    });

    const result = await verifyConnection();
    assert.equal(result.ok, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.error, '');
    assert.ok(result.capabilities.includes('AUTH'));
    assert.equal(relay.session().raw, '');

    await relay.close();
  });

  it('reports a verification failure instead of throwing', async () => {
    setEnv({});
    const missing = await verifyConnection();
    assert.equal(missing.ok, false);
    assert.equal(missing.stage, 'config');
    assert.match(missing.error, /not configured/i);

    // Port 1 is privileged and nothing listens there.
    setEnv({ CREDIBLE_SMTP_HOST: '127.0.0.1', CREDIBLE_SMTP_PORT: '1', CREDIBLE_SMTP_TIMEOUT: '1500' });
    const dead = await verifyConnection();
    assert.equal(dead.ok, false);
    assert.equal(dead.stage, 'connect');
    assert.match(dead.error, /could not connect/);
  });
});

// ---------------------------------------------------------------- the words --

const PERIOD = { start: '2026-08-03', end: '2026-08-09' };
const METRICS = { visitors: 12480, pageviews: 31204, bounce_rate: 42, visit_duration: 134 };
const PREVIOUS = { visitors: 10576, pageviews: 27860, bounce_rate: 45, visit_duration: 123 };
const TOP_PAGES = [
  { name: '/', visitors: 4120, pageviews: 9882 },
  { name: '/pricing', visitors: 1877, pageviews: 2310 },
];
const TOP_SOURCES = [
  { name: 'Google', visitors: 3004 },
  { name: 'news.ycombinator.com', visitors: 1290 },
];
const GOALS = [{ name: 'Signup', uniques: 412, cr: 3.3 }];

const REPORT = {
  site: { domain: 'monsite.fr' },
  period: PERIOD,
  metrics: METRICS,
  comparison: PREVIOUS,
  topPages: TOP_PAGES,
  topSources: TOP_SOURCES,
  goals: GOALS,
  dashboardUrl: 'https://stats.monsite.fr/monsite.fr',
  unsubscribeUrl: 'https://stats.monsite.fr/settings/email?token=abc',
  instanceUrl: 'https://stats.monsite.fr',
};

/** Every message, whatever it says, has to satisfy these. */
function assertHouseRules(message) {
  const { subject, text, html } = message;

  assert.ok(subject && subject.length < 120, 'the subject is present and short enough to survive a phone');
  assert.ok(!/[\r\n]/.test(subject), 'the subject is a single line');

  assert.ok(text.includes('Sent by Credible'), 'the text part names the product');
  assert.match(text, /No tracking pixel/);
  assert.ok(text.split('\n').every((line) => line.length <= 100), 'the text part stays inside a narrow terminal');

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /max-width:600px/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /color-scheme/);
  assert.ok(html.includes('<table role="presentation"'), 'the layout is a table, for Outlook');
  assert.ok(!/<script/i.test(html), 'no JavaScript');
  assert.ok(!/<img/i.test(html), 'no images at all, which also means no tracking pixel');
  assert.ok(!/@font-face|fonts\.googleapis/i.test(html), 'no web fonts');
  assert.ok(!/(src|href)="(?!https?:\/\/|#)/i.test(html), 'no external asset references');
  assert.match(html, /No tracking pixel/);
  // Dark mode has to be able to beat the inline light defaults.
  assert.ok(html.includes('!important'), 'the dark-mode block overrides the inline colours');

  // A double quote inside an inline style ends the attribute early and drops
  // every declaration after it — invisible in the source, fatal in a client.
  for (const [, value, next] of html.matchAll(/style="([^"]*)"(.?)/g)) {
    assert.ok(
      next === '' || /[\s>/]/.test(next),
      `an inline style attribute is cut short before "${next}": …${value.slice(-48)}`,
    );
  }
}

describe('renderWeeklyReport', () => {
  const message = renderWeeklyReport(REPORT);

  it('obeys the house rules', () => assertHouseRules(message));

  it('says what it is in the subject', () => {
    assert.equal(message.subject, 'Weekly report for monsite.fr — 3 – 9 August 2026');
  });

  it('reads as a real message with no HTML at all', () => {
    assert.match(message.text, /^Weekly report for monsite\.fr\n3 – 9 August 2026\n/);
    assert.match(message.text, /Unique visitors\s+12,480\s+\+18% vs the previous week/);
    assert.match(message.text, /Bounce rate\s+42%\s+−3 pts vs the previous week/);
    assert.match(message.text, /Visit duration\s+2m 14s/);
    assert.match(message.text, /Top pages\n\s+1\. \/\s+4,120 visitors/);
    assert.match(message.text, /2\. news\.ycombinator\.com\s+1,290 visitors/);
    assert.match(message.text, /1\. Signup\s+412 conversions\s+3\.3% CR/);
    assert.match(message.text, /Open the dashboard: https:\/\/stats\.monsite\.fr\/monsite\.fr/);
    assert.match(message.text, /Stop these emails: https:\/\/stats\.monsite\.fr\/settings\/email\?token=abc/);
    assert.ok(!message.text.includes('<'), 'the text part contains no markup');
  });

  it('puts the same numbers in the HTML', () => {
    assert.ok(message.html.includes('12,480'));
    assert.ok(message.html.includes('+18%'));
    assert.ok(message.html.includes('−3 pts'));
    assert.ok(message.html.includes('Top sources'));
    assert.ok(message.html.includes('href="https://stats.monsite.fr/monsite.fr"'));
    assert.ok(message.html.includes('Open the dashboard'));
  });

  it('colours a rise in bounce rate as bad and a rise in visitors as good', () => {
    const worse = renderWeeklyReport({ ...REPORT, comparison: { ...PREVIOUS, bounce_rate: 30 } });
    assert.ok(worse.html.includes('class="cr-down"'), 'a climbing bounce rate is shown as a regression');
    assert.ok(message.html.includes('class="cr-up"'), 'more visitors is shown as an improvement');
  });

  it('says so plainly when nothing was recorded', () => {
    const empty = renderWeeklyReport({
      ...REPORT,
      metrics: { visitors: 0, pageviews: 0, bounce_rate: 0, visit_duration: 0 },
      comparison: null,
      topPages: [],
      topSources: [],
      goals: [],
    });
    assert.match(empty.text, /No visitors were recorded/);
    assert.match(empty.text, /credible doctor/);
    assert.match(empty.html, /No visitors were recorded/);
    assertHouseRules(empty);
  });

  it('escapes anything that came from the outside world', () => {
    const hostile = renderWeeklyReport({
      ...REPORT,
      site: { domain: 'monsite.fr' },
      topPages: [{ name: '/<script>alert(1)</script>', visitors: 3, pageviews: 3 }],
    });
    assert.ok(!hostile.html.includes('<script>'), 'a page path cannot inject markup');
    assert.ok(hostile.html.includes('&lt;script&gt;'));
  });

  it('works with no comparison and no dashboard link', () => {
    const bare = renderWeeklyReport({ site: 'monsite.fr', period: PERIOD, metrics: METRICS });
    assert.ok(!bare.text.includes('vs the previous week'));
    assert.ok(!bare.html.includes('Open the dashboard'));
    assert.match(bare.text, /you are not subscribed to anything/);
  });
});

describe('renderMonthlyReport', () => {
  const message = renderMonthlyReport({
    ...REPORT,
    period: { start: '2026-07-01', end: '2026-07-31' },
  });

  it('obeys the house rules', () => assertHouseRules(message));

  it('frames the period as a month and compares against the month before', () => {
    assert.equal(message.subject, 'Monthly report for monsite.fr — July 2026');
    assert.match(message.text, /\+18% vs the previous month/);
    assert.ok(message.html.includes('monthly report'));
  });
});

describe('renderSpikeAlert', () => {
  const message = renderSpikeAlert({
    site: 'monsite.fr',
    current: 4210,
    threshold: 1000,
    dashboardUrl: 'https://stats.monsite.fr/monsite.fr',
    unsubscribeUrl: 'https://stats.monsite.fr/settings/alerts',
    instanceUrl: 'https://stats.monsite.fr',
  });

  it('obeys the house rules', () => assertHouseRules(message));

  it('leads with both numbers', () => {
    assert.equal(message.subject, 'Traffic spike on monsite.fr — 4,210 visitors');
    assert.match(message.text, /4,210 visitors in the last hour, above the 1,000 you set/);
    assert.match(message.text, /Alert threshold\s+1,000/);
    assert.ok(message.html.includes('4,210'));
    assert.ok(message.html.includes('1,000'));
    assert.match(message.text, /Stop these emails: https:\/\/stats\.monsite\.fr\/settings\/alerts/);
  });
});

describe('renderDropAlert', () => {
  const message = renderDropAlert({
    site: { domain: 'monsite.fr' },
    current: 180,
    expected: 1500,
    dashboardUrl: 'https://stats.monsite.fr/monsite.fr',
    unsubscribeUrl: 'https://stats.monsite.fr/settings/alerts',
    instanceUrl: 'https://stats.monsite.fr',
  });

  it('obeys the house rules', () => assertHouseRules(message));

  it('states the shortfall and points at the likely cause', () => {
    assert.equal(message.subject, 'Traffic drop on monsite.fr — 180 visitors');
    assert.match(message.text, /180 visitors in the last 24 hours, against 1,500 expected — 12% of normal/);
    assert.match(message.text, /more often a broken tracker than a lost audience/);
    assert.match(message.text, /credible doctor --domain monsite\.fr/);
    assert.ok(message.html.includes('&lt;head&gt;'), 'the advice mentions <head> without emitting a tag');
  });
});

describe('renderInvitation', () => {
  const message = renderInvitation({
    site: 'monsite.fr',
    inviter: 'Maxime',
    acceptUrl: 'https://stats.monsite.fr/invitations/xyz',
    instanceUrl: 'https://stats.monsite.fr',
  });

  it('obeys the house rules', () => assertHouseRules(message));

  it('names the inviter, the site, and what happens next', () => {
    assert.equal(message.subject, 'Maxime invited you to monsite.fr on Credible');
    assert.match(message.text, /Maxime invited you to see the analytics for monsite\.fr\./);
    assert.match(message.text, /https:\/\/stats\.monsite\.fr\/invitations\/xyz/);
    assert.match(message.text, /If you were not expecting this, ignore it/);
    assert.ok(message.html.includes('href="https://stats.monsite.fr/invitations/xyz"'));
  });

  it('tells a transactional recipient there is nothing to unsubscribe from', () => {
    assert.match(message.text, /you are not subscribed to anything/);
    assert.ok(!message.text.includes('Stop these emails'));
  });

  it('drops a link that is not http(s)', () => {
    const hostile = renderInvitation({
      site: 'monsite.fr',
      inviter: 'Mallory',
      acceptUrl: 'javascript:alert(1)',
      instanceUrl: 'https://stats.monsite.fr',
    });
    assert.ok(!hostile.html.includes('javascript:'));
    assert.ok(!hostile.text.includes('javascript:'));
  });
});

describe('renderPasswordReset', () => {
  const message = renderPasswordReset({
    user: { name: 'Maxime Duret', email: 'maxime@example.com' },
    resetUrl: 'https://stats.monsite.fr/reset/abc123',
    expiresInMinutes: 60,
    instanceUrl: 'https://stats.monsite.fr',
  });

  it('obeys the house rules', () => assertHouseRules(message));

  it('says how long the link lives and what to do if it was not you', () => {
    assert.equal(message.subject, 'Reset your Credible password');
    assert.match(message.text, /^Reset your Credible password\n\nHi Maxime,/);
    assert.match(message.text, /expires in 60 minutes/);
    assert.match(message.text, /https:\/\/stats\.monsite\.fr\/reset\/abc123/);
    assert.match(message.text, /If you did not ask for this, nothing has changed/);
    assert.ok(message.html.includes('href="https://stats.monsite.fr/reset/abc123"'));
  });

  it('rounds a long expiry into hours and copes with no name', () => {
    const long = renderPasswordReset({
      user: 'someone@example.com',
      resetUrl: 'https://stats.monsite.fr/reset/x',
      expiresInMinutes: 180,
    });
    assert.match(long.text, /expires in 3 hours/);
    assert.match(long.text, /Hi someone@example\.com,/);
  });
});

// ------------------------------------------------------------ small parts --

describe('formatting helpers', () => {
  it('names a whole month, a week inside one month, and a week that straddles two', () => {
    assert.equal(formatPeriod({ start: '2026-07-01', end: '2026-07-31' }), 'July 2026');
    assert.equal(formatPeriod({ start: '2026-08-03', end: '2026-08-09' }), '3 – 9 August 2026');
    assert.equal(formatPeriod({ start: '2026-07-27', end: '2026-08-02' }), '27 July – 2 August 2026');
    assert.equal(formatPeriod({ start: '2025-12-29', end: '2026-01-04' }), '29 December 2025 – 4 January 2026');
    assert.equal(formatPeriod({ label: 'Last 7 days' }), 'Last 7 days');
    assert.equal(formatPeriod({}), '');
  });

  it('reads a date the same way whatever the machine timezone is', () => {
    // A literal 'YYYY-MM-DD' is never re-interpreted as an instant, which is
    // what would otherwise shift the label by a day west of Greenwich.
    assert.equal(formatPeriod({ start: '2026-02-01', end: '2026-02-28' }), 'February 2026');
    assert.equal(formatPeriod({ start: 1767225600, end: 1767225600 }), '1 – 1 January 2026');
  });

  it('compares rates in points and everything else in percent', () => {
    assert.deepEqual(formatDelta(120, 100), { label: '+20%', direction: 'up' });
    assert.deepEqual(formatDelta(80, 100), { label: '−20%', direction: 'down' });
    assert.deepEqual(formatDelta(100, 100), { label: 'no change', direction: 'flat' });
    assert.deepEqual(formatDelta(42, 45, { points: true }), { label: '−3 pts', direction: 'down' });
    assert.deepEqual(formatDelta(5, 0), { label: 'new', direction: 'up' });
    assert.deepEqual(formatDelta(0, 0), { label: 'no change', direction: 'flat' });
    assert.equal(formatDelta(5, undefined).label, '');
  });

  it('formats durations the way the dashboard does', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(59), '59s');
    assert.equal(formatDuration(134), '2m 14s');
    assert.equal(formatDuration(3720), '1h 2m');
  });

  it('passes http(s) URLs and drops everything else', () => {
    assert.equal(safeUrl('https://stats.example/x?a=1'), 'https://stats.example/x?a=1');
    assert.equal(safeUrl('http://localhost:8000/'), 'http://localhost:8000/');
    assert.equal(safeUrl('javascript:alert(1)'), '');
    assert.equal(safeUrl('data:text/html,<b>'), '');
    assert.equal(safeUrl('not a url'), '');
    assert.equal(safeUrl(''), '');
  });
});
