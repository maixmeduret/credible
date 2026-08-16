/**
 * Delivery channels that are not email: ntfy and webhooks.
 *
 * Every request in this file goes to a throwaway node:http server bound to
 * 127.0.0.1 that records exactly what arrived. Nothing here touches ntfy.sh,
 * Slack or Discord — the only thing a real service could tell us that a fake
 * one cannot is that their API changed, and a test suite that pushes
 * notifications to a stranger's phone when CI runs is not worth that.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import './helpers.js';

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encodeHeaderValue, normalizeTopic, sendNtfy } from '../src/notify/ntfy.js';
import { classifyAddress, detectFlavour, parseWebhookTarget, sendWebhook, signBody } from '../src/notify/webhook.js';
import {
  CHANNELS,
  PUSH_BODY_LIMIT,
  channelDescription,
  deliver,
  parseRecipients,
  pushBody,
  validateChannel,
} from '../src/notify/index.js';
import { renderDropAlert, renderWeeklyReport } from '../src/mail/render.js';
import { HttpError } from '../src/util/http.js';

// Email is off unless a test says otherwise: the machine running the suite may
// well have a relay configured, and no test here may ever try to use it.
delete process.env.CREDIBLE_SMTP_HOST;
delete process.env.CREDIBLE_NTFY_TOKEN;
delete process.env.CREDIBLE_WEBHOOK_SECRET;

// ------------------------------------------------------- a fake receiver --

/**
 * Stands in for an ntfy server and for a webhook endpoint alike: it records
 * the method, path, headers and raw bytes of everything it is sent, and
 * answers whatever the current test told it to.
 */
function startReceiver() {
  const requests = [];
  const sockets = new Set();
  let behaviour = { status: 200, body: '', hang: false };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({ method: req.method, path: req.url, headers: req.headers, raw, text: raw.toString('utf8') });

      // Accept the request and then say nothing at all, so the client's own
      // timeout is the only thing that can end the call.
      if (behaviour.hang) return;

      const topic = req.url.split('/').filter(Boolean).pop() || '';
      const body =
        behaviour.body !== ''
          ? behaviour.body
          : JSON.stringify({ id: 'bUhbhgmmbeW0', time: 1755300000, event: 'message', topic });
      res.writeHead(behaviour.status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    requests,
    last: () => requests[requests.length - 1],
    reply: (options = {}) => {
      behaviour = { status: 200, body: '', hang: false, ...options };
    },
    reset: () => {
      requests.length = 0;
      behaviour = { status: 200, body: '', hang: false };
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let receiver;
let origin;

before(async () => {
  receiver = startReceiver();
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${receiver.server.address().port}`;
});

after(async () => {
  await receiver.stop();
});

afterEach(() => {
  receiver.reset();
});

/** Undo RFC 2047: adjacent encoded words are joined and the space dropped. */
function decodeHeader(value) {
  return String(value)
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_, chunk) => Buffer.from(chunk, 'base64').toString('utf8'));
}

// ------------------------------------------------------------ the target --

describe('normalizeTopic', () => {
  it('sends a bare topic name to ntfy.sh', () => {
    assert.deepEqual(normalizeTopic('pillr-stats'), { url: 'https://ntfy.sh/pillr-stats', topic: 'pillr-stats' });
  });

  it('accepts host/topic without a scheme and assumes https on the public internet', () => {
    assert.deepEqual(normalizeTopic('ntfy.sh/pillr-stats'), { url: 'https://ntfy.sh/pillr-stats', topic: 'pillr-stats' });
  });

  it('accepts a full URL to a self-hosted server', () => {
    assert.deepEqual(normalizeTopic('https://ntfy.example/pillr-stats'), {
      url: 'https://ntfy.example/pillr-stats',
      topic: 'pillr-stats',
    });
  });

  it('never forces https on a LAN address', () => {
    assert.deepEqual(normalizeTopic('http://192.168.1.20:8080/home-alerts'), {
      url: 'http://192.168.1.20:8080/home-alerts',
      topic: 'home-alerts',
    });
    // Scheme-less, and the host can only be a local one: https would fail on a
    // certificate nobody can issue for it.
    assert.equal(normalizeTopic('192.168.1.20:8080/home-alerts').url, 'http://192.168.1.20:8080/home-alerts');
    assert.equal(normalizeTopic('nas.lan/stats').url, 'http://nas.lan/stats');
    assert.equal(normalizeTopic('localhost:8080/stats').url, 'http://localhost:8080/stats');
  });

  it('keeps the path prefix of a server behind a reverse proxy', () => {
    assert.deepEqual(normalizeTopic('https://example.com/ntfy/pillr-stats'), {
      url: 'https://example.com/ntfy/pillr-stats',
      topic: 'pillr-stats',
    });
  });

  it('drops a query string and a fragment', () => {
    assert.equal(normalizeTopic('https://ntfy.sh/pillr-stats?auth=xyz#frag').url, 'https://ntfy.sh/pillr-stats');
  });

  it('rejects nonsense with a message that says what to type', () => {
    assert.throws(() => normalizeTopic(''), /no topic configured/);
    assert.throws(() => normalizeTopic('   '), /no topic configured/);
    assert.throws(() => normalizeTopic('my topic'), /contains a space/);
    assert.throws(() => normalizeTopic('https://ntfy.sh'), /no usable topic/);
    assert.throws(() => normalizeTopic('https://ntfy.sh/'), /no usable topic/);
    assert.throws(() => normalizeTopic('ftp://ntfy.sh/topic'), /ftp:\/\/ is not supported/);
    assert.throws(() => normalizeTopic('https://ntfy.sh/über'), /no usable topic/);
    assert.throws(() => normalizeTopic(`https://ntfy.sh/${'a'.repeat(65)}`), /no usable topic/);
    assert.throws(() => normalizeTopic('https://me:secret@ntfy.sh/topic'), /CREDIBLE_NTFY_TOKEN/);
  });
});

// -------------------------------------------------------------- publishing --

describe('sendNtfy', () => {
  it('posts the body as text to the topic URL', async () => {
    const result = await sendNtfy({
      target: `${origin}/pillr-stats`,
      title: 'Weekly report',
      body: 'Visitors  1,204\nPageviews 3,410',
    });

    const request = receiver.last();
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/pillr-stats');
    assert.equal(request.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(request.text, 'Visitors  1,204\nPageviews 3,410');
    assert.match(request.headers['user-agent'], /^Credible\//);
    assert.deepEqual(result, { ok: true, status: 200, id: 'bUhbhgmmbeW0' });
  });

  it('encodes a title with an accent and an emoji as RFC 2047, and nothing else', async () => {
    const title = 'Rapport hebdomadaire — crédible 📈';
    await sendNtfy({ target: `${origin}/pillr-stats`, title, body: 'ok' });

    const header = receiver.last().headers['x-title'];
    // Whatever we send has to survive a header, which is not UTF-8 territory.
    assert.match(header, /^[\x20-\x7e]+$/, `X-Title must be plain ASCII, got ${header}`);
    assert.match(header, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/);
    for (const word of header.split(' ')) assert.ok(word.length <= 75, `encoded word too long: ${word}`);
    assert.equal(decodeHeader(header), title);
  });

  it('leaves a plain ASCII title alone', async () => {
    await sendNtfy({ target: `${origin}/pillr-stats`, title: 'Weekly report for example.com', body: 'ok' });
    assert.equal(receiver.last().headers['x-title'], 'Weekly report for example.com');
  });

  it('sets priority, tags, click and bearer token the way ntfy reads them', async () => {
    await sendNtfy({
      target: `${origin}/pillr-stats`,
      title: 'Traffic drop',
      body: 'ok',
      priority: 'high',
      tags: ['chart_with_downwards_trend', 'warning'],
      clickUrl: 'https://stats.example/example.com',
      token: 'tk_secret',
    });

    const { headers } = receiver.last();
    assert.equal(headers['x-priority'], 'high');
    assert.equal(headers['x-tags'], 'chart_with_downwards_trend,warning');
    assert.equal(headers['x-click'], 'https://stats.example/example.com');
    assert.equal(headers.authorization, 'Bearer tk_secret');
    // Markdown is off unless asked for: the text part is laid out in columns.
    assert.equal(headers['x-markdown'], undefined);
  });

  it('drops a tag that would corrupt the comma-separated list, and a javascript: click', async () => {
    await sendNtfy({
      target: `${origin}/pillr-stats`,
      title: 't',
      body: 'ok',
      tags: ['bar_chart', 'two, tags', '📈', ''],
      clickUrl: 'javascript:alert(1)',
      priority: 'nonsense',
    });

    const { headers } = receiver.last();
    assert.equal(headers['x-tags'], 'bar_chart');
    assert.equal(headers['x-click'], undefined);
    assert.equal(headers['x-priority'], undefined);
  });

  it('asks for markdown only when told to', async () => {
    await sendNtfy({ target: `${origin}/pillr-stats`, title: 't', body: 'ok', markdown: true });
    assert.equal(receiver.last().headers['x-markdown'], 'yes');
  });

  it('turns a non-2xx into an error naming the topic, the host and the status', async () => {
    receiver.reply({ status: 403, body: JSON.stringify({ code: 40301, http: 403, error: 'forbidden' }) });

    await assert.rejects(
      () => sendNtfy({ target: `${origin}/pillr-stats`, title: 't', body: 'ok' }),
      (err) => {
        assert.match(err.message, /^ntfy: topic "pillr-stats" on 127\.0\.0\.1:\d+ rejected the message \(HTTP 403: forbidden\)$/);
        assert.equal(err.status, 403);
        assert.equal(err.channel, 'ntfy');
        return true;
      },
    );
  });

  it('gives up on a server that never answers', async () => {
    receiver.reply({ hang: true });

    await assert.rejects(
      () => sendNtfy({ target: `${origin}/pillr-stats`, title: 't', body: 'ok', timeout: 150 }),
      /ntfy: topic "pillr-stats" on 127\.0\.0\.1:\d+ did not answer within 150ms/,
    );
    // The request did leave — this is a timeout, not a refusal to send.
    assert.equal(receiver.requests.length, 1);
  });

  it('shortens an over-long title without cutting an emoji in half', async () => {
    // The 200-character limit lands exactly between the two code units of 📈.
    const title = `${'a'.repeat(199)}📈 and more`;
    await sendNtfy({ target: `${origin}/pillr-stats`, title, body: 'ok' });

    const decoded = decodeHeader(receiver.last().headers['x-title']);
    assert.equal(decoded, 'a'.repeat(199));
    assert.doesNotMatch(decoded, /�/);
  });

  it('encodes only what needs encoding', () => {
    assert.equal(encodeHeaderValue('plain ascii'), 'plain ascii');
    assert.equal(decodeHeader(encodeHeaderValue('a'.repeat(200) + 'é')), 'a'.repeat(200) + 'é');
    assert.equal(encodeHeaderValue('two\nlines'), 'two lines');
  });
});

// --------------------------------------------------------------- webhooks --

describe('webhook targets', () => {
  it('recognises Slack, Discord and everything else', () => {
    assert.equal(detectFlavour(new URL('https://hooks.slack.com/services/T00/B00/xxx')), 'slack');
    assert.equal(detectFlavour(new URL('https://discord.com/api/webhooks/123/abc')), 'discord');
    assert.equal(detectFlavour(new URL('https://discordapp.com/api/webhooks/123/abc')), 'discord');
    // Discord's Slack-compatible endpoint wants Slack's shape.
    assert.equal(detectFlavour(new URL('https://discord.com/api/webhooks/123/abc/slack')), 'slack');
    assert.equal(detectFlavour(new URL('https://example.com/hooks/credible')), 'generic');
  });

  it('refuses anything that is not http(s)', () => {
    assert.throws(() => parseWebhookTarget('ftp://example.com/hook'), /must be http:\/\/ or https:\/\//);
    assert.throws(() => parseWebhookTarget('file:///etc/passwd'), /must be http:\/\/ or https:\/\//);
    assert.throws(() => parseWebhookTarget('not a url'), /is not a URL/);
    assert.throws(() => parseWebhookTarget(''), /no URL configured/);
  });

  it('classifies addresses the way the SSRF policy needs', () => {
    assert.equal(classifyAddress('127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('::1'), 'loopback');
    assert.equal(classifyAddress('169.254.169.254'), 'link-local');
    assert.equal(classifyAddress('fe80::1'), 'link-local');
    assert.equal(classifyAddress('192.168.1.10'), 'private');
    assert.equal(classifyAddress('10.0.0.4'), 'private');
    assert.equal(classifyAddress('172.20.1.1'), 'private');
    assert.equal(classifyAddress('100.101.102.103'), 'private'); // Tailscale
    assert.equal(classifyAddress('fd00::5'), 'private');
    assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
    assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('93.184.216.34'), 'public');
  });

  it('refuses link-local however it is spelled, and allows the LAN the operator typed', async () => {
    await assert.rejects(
      () => sendWebhook({ target: 'http://169.254.169.254/latest/meta-data/', title: 't', body: 'b' }),
      /refusing to post to link-local address/,
    );
    // 127.0.0.1 is the fake receiver, and it is allowed on purpose: a webhook
    // on the same box is the normal case for a home server.
    const result = await sendWebhook({ target: `${origin}/hook`, title: 't', body: 'b' });
    assert.equal(result.ok, true);
  });
});

describe('sendWebhook', () => {
  it('gives Slack the text field it demands, escaped and fenced', async () => {
    await sendWebhook({
      target: `${origin}/hook`,
      flavour: 'slack',
      title: 'Traffic drop on example.com',
      body: 'the Credible snippet is still in <head> on every page\n& nothing else',
      clickUrl: 'https://stats.example/example.com',
    });

    const payload = JSON.parse(receiver.last().text);
    assert.deepEqual(Object.keys(payload), ['text']);
    assert.match(payload.text, /^\*Traffic drop on example\.com\*\n```\n/);
    // Slack reads <…> as markup, so the drop alert's <head> has to be escaped.
    assert.match(payload.text, /&lt;head&gt;/);
    assert.match(payload.text, /&amp; nothing else/);
    assert.match(payload.text, /```\n<https:\/\/stats\.example\/example\.com\|Open the dashboard>$/);
  });

  it('gives Discord the content field, within its 2000 character limit', async () => {
    await sendWebhook({
      target: `${origin}/hook`,
      flavour: 'discord',
      title: 'Weekly report',
      body: Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'),
      clickUrl: 'https://stats.example/example.com',
    });

    const payload = JSON.parse(receiver.last().text);
    assert.deepEqual(Object.keys(payload), ['content']);
    assert.ok(payload.content.length <= 2000, `content is ${payload.content.length} characters`);
    assert.match(payload.content, /^\*\*Weekly report\*\*\n```\n/);
    assert.match(payload.content, /…\n```\nOpen the dashboard: https:\/\/stats\.example\/example\.com$/);
  });

  it('gives everything else a documented envelope with the caller fields merged in', async () => {
    await sendWebhook({
      target: `${origin}/hook`,
      title: 'Weekly report for example.com',
      body: 'Visitors 1,204',
      clickUrl: 'https://stats.example/example.com',
      payload: { kind: 'report', site: 'example.com' },
    });

    const payload = JSON.parse(receiver.last().text);
    assert.equal(receiver.last().headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(payload.source, 'credible');
    assert.equal(payload.version, 1);
    assert.equal(payload.title, 'Weekly report for example.com');
    assert.equal(payload.text, 'Visitors 1,204');
    assert.equal(payload.url, 'https://stats.example/example.com');
    assert.equal(payload.kind, 'report');
    assert.equal(payload.site, 'example.com');
    assert.equal(typeof payload.sent_at, 'number');
  });

  it('signs the exact bytes it sent, verifiably', async () => {
    const secret = 'hunter2-but-longer';
    await sendWebhook({ target: `${origin}/hook`, title: 'Signed', body: 'accented — é 📈', secret });

    const { raw, headers } = receiver.last();
    const signature = headers['x-credible-signature'];
    assert.match(signature, /^sha256=[0-9a-f]{64}$/);

    // The receiving end verifies over the raw body, before parsing anything.
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const got = Buffer.from(signature);
    const want = Buffer.from(expected);
    assert.equal(got.length, want.length);
    assert.ok(timingSafeEqual(got, want));

    // Re-serialising the parsed body is the mistake the header comment warns
    // about; it must not be what verification is done against by accident.
    assert.equal(signBody(raw, secret), expected);
    assert.notEqual(signBody(Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2)), secret), expected);
  });

  it('does not sign when there is no secret', async () => {
    await sendWebhook({ target: `${origin}/hook`, title: 't', body: 'b' });
    assert.equal(receiver.last().headers['x-credible-signature'], undefined);
  });

  it('turns a non-2xx into an error naming the host and the status', async () => {
    receiver.reply({ status: 400, body: 'invalid_payload' });
    await assert.rejects(
      () => sendWebhook({ target: `${origin}/hook`, title: 't', body: 'b' }),
      /^Error: webhook: 127\.0\.0\.1:\d+ rejected the message \(HTTP 400: invalid_payload\)$/,
    );
  });

  it('gives up on a server that never answers', async () => {
    receiver.reply({ hang: true });
    await assert.rejects(
      () => sendWebhook({ target: `${origin}/hook`, title: 't', body: 'b', timeout: 150 }),
      /webhook: 127\.0\.0\.1:\d+ did not answer within 150ms/,
    );
  });
});

// ---------------------------------------------------------------- routing --

const weekly = () =>
  renderWeeklyReport({
    site: 'example.com',
    period: { start: '2026-08-03', end: '2026-08-09' },
    metrics: { visitors: 1204, pageviews: 3410, bounce_rate: 42, visit_duration: 134 },
    comparison: { visitors: 940, pageviews: 2800, bounce_rate: 46, visit_duration: 120 },
    topPages: [{ name: '/', visitors: 800, pageviews: 1200 }],
    topSources: [{ name: 'Google', visitors: 410 }],
    dashboardUrl: 'https://stats.example/example.com',
    instanceUrl: 'https://stats.example',
  });

describe('pushBody', () => {
  it('drops the email footer and the dashboard line, and keeps the numbers', () => {
    const body = pushBody(weekly().text);
    assert.match(body, /Weekly report for example\.com/);
    assert.match(body, /Top pages/);
    assert.doesNotMatch(body, /Sent by Credible/);
    assert.doesNotMatch(body, /No tracking pixel/);
    assert.doesNotMatch(body, /Open the dashboard/);
    assert.doesNotMatch(body, /<[a-z]/); // never the HTML part
  });

  it('cuts an oversized message on a line boundary rather than mid-number', () => {
    const long = Array.from({ length: 60 }, (_, i) => `  ${i}. /a-fairly-long-page-name-${i}`).join('\n');
    const body = pushBody(long, { limit: 200 });
    assert.ok(body.length <= 200, `got ${body.length}`);
    assert.match(body, /…$/);
    // The last line is a whole line: the cut fell on a newline, not inside one.
    assert.match(body, /\n {2}\d+\. \/a-fairly-long-page-name-\d+…$/);
  });

  it('never cuts an emoji in half', () => {
    // One long line, so the boundary search cannot rescue the cut: the limit
    // falls between the two code units of 📈.
    const body = pushBody(`${'a'.repeat(19)}📈${'b'.repeat(40)}`, { limit: 21 });
    assert.equal(body, `${'a'.repeat(19)}…`);
    assert.doesNotMatch(body, /�/);
  });
});

describe('deliver', () => {
  it('lists the channels it knows', () => {
    assert.deepEqual(CHANNELS, ['email', 'ntfy', 'webhook']);
  });

  it('sends a report to ntfy as text, with the dashboard as the click action', async () => {
    const message = weekly();
    const result = await deliver(
      { channel: 'ntfy', target: `${origin}/pillr-stats` },
      message,
      { kind: 'report', site: 'example.com', dashboardUrl: 'https://stats.example/example.com' },
    );

    const request = receiver.last();
    assert.equal(decodeHeader(request.headers['x-title']), message.subject);
    assert.equal(request.headers['x-click'], 'https://stats.example/example.com');
    assert.equal(request.headers['x-tags'], 'bar_chart');
    // A digest arrives quietly; see TONE in src/notify/index.js.
    assert.equal(request.headers['x-priority'], 'low');
    assert.doesNotMatch(request.text, /<html|<table|Sent by Credible/);
    assert.match(request.text, /Top pages/);
    assert.ok(request.text.length <= PUSH_BODY_LIMIT);
    assert.equal(result.channel, 'ntfy');
    assert.equal(result.ok, true);
  });

  it('shouts louder about a drop than about a digest', async () => {
    const message = renderDropAlert({
      site: 'example.com',
      current: 3,
      expected: 180,
      dashboardUrl: 'https://stats.example/example.com',
      instanceUrl: 'https://stats.example',
    });
    await deliver({ channel: 'ntfy', target: `${origin}/pillr-stats` }, message, {
      kind: 'drop',
      site: 'example.com',
      dashboardUrl: 'https://stats.example/example.com',
    });

    const { headers, text } = receiver.last();
    assert.equal(headers['x-priority'], 'high');
    assert.equal(headers['x-tags'], 'chart_with_downwards_trend,warning');
    assert.match(text, /more often a broken tracker/);
  });

  it('never lets a long report become an ntfy attachment', async () => {
    const message = renderWeeklyReport({
      site: 'example.com',
      period: { start: '2026-08-03', end: '2026-08-09' },
      metrics: { visitors: 1204, pageviews: 3410, bounce_rate: 42, visit_duration: 134 },
      topPages: Array.from({ length: 5 }, (_, i) => ({ name: `/${'section'.repeat(5)}/${i}`, visitors: 900 - i })),
      topSources: Array.from({ length: 5 }, (_, i) => ({ name: `a-very-long-referrer-name-${i}.example`, visitors: 90 - i })),
      goals: Array.from({ length: 5 }, (_, i) => ({ name: `Signup step number ${i}`, uniques: 40 - i, cr: 3.5 })),
      dashboardUrl: 'https://stats.example/example.com',
      instanceUrl: 'https://stats.example',
    });
    assert.ok(message.text.length > PUSH_BODY_LIMIT, 'the fixture must be long enough to be cut');

    await deliver({ channel: 'ntfy', target: `${origin}/pillr-stats` }, message, { kind: 'report' });

    const { text } = receiver.last();
    assert.ok(Buffer.byteLength(text, 'utf8') < 4096, 'over 4096 bytes ntfy stores the message as a file');
    assert.match(text, /…$/);
  });

  it('passes the bearer token through when the topic is protected', async () => {
    process.env.CREDIBLE_NTFY_TOKEN = 'tk_from_the_environment';
    try {
      await deliver({ channel: 'ntfy', target: `${origin}/pillr-stats` }, weekly(), { kind: 'report' });
      assert.equal(receiver.last().headers.authorization, 'Bearer tk_from_the_environment');
    } finally {
      delete process.env.CREDIBLE_NTFY_TOKEN;
    }
  });

  it('sends an alert to a webhook as structured JSON, signed when a secret is set', async () => {
    process.env.CREDIBLE_WEBHOOK_SECRET = 'a-shared-secret';
    try {
      const message = renderDropAlert({
        site: 'example.com',
        current: 3,
        expected: 180,
        dashboardUrl: 'https://stats.example/example.com',
        instanceUrl: 'https://stats.example',
      });
      const result = await deliver({ channel: 'webhook', target: `${origin}/hooks/credible` }, message, {
        kind: 'drop',
        site: 'example.com',
        dashboardUrl: 'https://stats.example/example.com',
      });

      const { raw, headers, text } = receiver.last();
      const payload = JSON.parse(text);
      assert.equal(payload.kind, 'drop');
      assert.equal(payload.site, 'example.com');
      assert.equal(payload.title, message.subject);
      assert.match(payload.text, /Traffic drop on example\.com/);
      assert.doesNotMatch(payload.text, /Sent by Credible/);
      assert.equal(
        headers['x-credible-signature'],
        `sha256=${createHmac('sha256', 'a-shared-secret').update(raw).digest('hex')}`,
      );
      assert.deepEqual(result, { channel: 'webhook', ok: true, status: 200, flavour: 'generic' });
    } finally {
      delete process.env.CREDIBLE_WEBHOOK_SECRET;
    }
  });

  it('defaults to email, and says what to do when there is no relay', async () => {
    await assert.rejects(
      () => deliver({ recipients: 'you@example.com' }, weekly(), { kind: 'report' }),
      /CREDIBLE_SMTP_HOST.*ntfy or webhook channel/s,
    );
  });

  it('refuses a channel it does not know', async () => {
    await assert.rejects(
      () => deliver({ channel: 'pigeon', target: 'x' }, weekly(), {}),
      /Unknown delivery channel "pigeon"/,
    );
  });
});

// ------------------------------------------------------------- validation --

describe('validateChannel', () => {
  it('rejects an ntfy channel with no target', () => {
    assert.throws(
      () => validateChannel({ channel: 'ntfy', target: '' }),
      (err) => err instanceof HttpError && err.status === 422 && /ntfy topic/.test(err.message),
    );
  });

  it('rejects an email channel with no usable recipient', () => {
    assert.throws(
      () => validateChannel({ channel: 'email', recipients: '' }),
      (err) => err instanceof HttpError && err.status === 422,
    );
    assert.throws(
      () => validateChannel({ channel: 'email', recipients: 'not-an-address' }),
      (err) => err instanceof HttpError && err.status === 422,
    );
  });

  it('rejects a webhook channel with a URL that is not one, as a 422', () => {
    assert.throws(
      () => validateChannel({ channel: 'webhook', target: 'ftp://example.com/hook' }),
      (err) => err instanceof HttpError && err.status === 422 && /http/.test(err.message),
    );
    assert.throws(
      () => validateChannel({ channel: 'webhook', target: '' }),
      (err) => err instanceof HttpError && err.status === 422,
    );
  });

  it('rejects a channel nobody implements', () => {
    assert.throws(
      () => validateChannel({ channel: 'carrier-pigeon', target: 'x' }),
      (err) => err instanceof HttpError && err.status === 422 && /email, ntfy, webhook/.test(err.message),
    );
  });

  it('normalizes what it accepts, so the stored row has one destination', () => {
    assert.deepEqual(validateChannel({ channel: 'ntfy', target: 'pillr-stats', recipients: 'you@example.com' }), {
      channel: 'ntfy',
      target: 'https://ntfy.sh/pillr-stats',
      recipients: '',
    });
    assert.deepEqual(validateChannel({ channel: 'email', recipients: 'you@example.com, junk, ops@example.com' }), {
      channel: 'email',
      target: '',
      recipients: 'you@example.com,ops@example.com',
    });
    // An unspecified channel is email, and an email row still needs somebody.
    assert.throws(() => validateChannel({}), (err) => err instanceof HttpError && err.status === 422);
  });

  it('reads a recipients column the way the database stores it', () => {
    assert.deepEqual(parseRecipients('a@b.com, c@d.com\ne@f.com;junk'), ['a@b.com', 'c@d.com', 'e@f.com']);
  });
});

describe('channelDescription', () => {
  it('says where a row delivers, in words', () => {
    assert.equal(channelDescription({ channel: 'ntfy', target: 'pillr-stats' }), 'ntfy → pillr-stats on ntfy.sh');
    assert.equal(
      channelDescription({ channel: 'ntfy', target: 'http://192.168.1.20:8080/home-alerts' }),
      'ntfy → home-alerts on 192.168.1.20:8080',
    );
    assert.equal(
      channelDescription({ channel: 'webhook', target: 'https://hooks.slack.com/services/T00/B00/xxx' }),
      'webhook → Slack (hooks.slack.com)',
    );
    assert.equal(
      channelDescription({ channel: 'webhook', target: 'https://discord.com/api/webhooks/1/abc' }),
      'webhook → Discord (discord.com)',
    );
    assert.equal(
      channelDescription({ channel: 'email', recipients: 'a@b.com,c@d.com,e@f.com' }),
      'email → a@b.com, c@d.com, +1 more',
    );
    assert.equal(channelDescription({}), 'email → nobody');
  });

  it('describes a broken row instead of throwing at it', () => {
    assert.equal(channelDescription({ channel: 'ntfy', target: 'no topic here' }), 'ntfy → no topic here (unusable)');
    assert.equal(channelDescription({ channel: 'webhook', target: '' }), 'webhook → no URL (unusable)');
  });
});
