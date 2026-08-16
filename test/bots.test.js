/**
 * Bot detection tests: the User-Agent layer, the datacenter range file, and the
 * combined classifier.
 *
 * Every User-Agent below is a real string and every address is a real address,
 * checked against the committed data-files/datacenter-ranges.json. Made-up
 * fixtures would let a broken heuristic pass, which is the one thing this file
 * exists to stop.
 *
 * test/referrer.test.js keeps the original isBot() expectations from before
 * classifyTraffic() existed. Those tests are unchanged and must keep passing;
 * the isBot() block at the end of this file restates the load-bearing ones so a
 * regression is obvious from either side.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isBot,
  classifyTraffic,
  BOT_PATTERNS,
  PREVIEW_BOTS,
  SIGNAL_NAMES,
} from '../src/ingest/bots.js';

import {
  isDatacenterIp,
  loadRanges,
  rangeCount,
  ipv4ToNumber,
  ipv6ToBigInt,
} from '../src/ingest/datacenters.js';

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_100 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';
const CHROME_80 = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const CUBOT = 'Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36';
const NOTION_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Notion/2.3.2 Chrome/120.0.6099.291 Electron/28.2.1 Safari/537.36';

// Residential eyeballs: Comcast, Orange France, Free.fr v6, Deutsche Telekom v6.
const HOME_V4 = '24.6.44.1';
const HOME_V4_FR = '81.185.0.1';
const HOME_V6 = '2a01:e0a::1';
const HOME_V6_DE = '2a02:8109::1';

// Verified against the committed range file.
const AWS_V4 = '3.5.140.1';
const AWS_V6 = '2600:1f01:4822::1';
const HETZNER_V6 = '2a01:4f8::1';
const GCP_V4 = '34.35.0.1';
const AZURE_V4 = '20.36.0.1';
const DIGITALOCEAN_V4 = '165.227.0.1';
const CLOUDFLARE_V4 = '104.16.0.1';

/** What a real Chrome beacon carries once TLS is terminated by a proxy. */
const BROWSER_HEADERS = Object.freeze({
  'accept-language': 'en-GB,en;q=0.9',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-dest': 'empty',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'x-forwarded-proto': 'https',
  'user-agent': CHROME,
});

/** BROWSER_HEADERS without the named keys. */
const without = (...names) => {
  const copy = { ...BROWSER_HEADERS };
  for (const name of names) delete copy[name];
  return copy;
};

const SEC_FETCH = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

/* ------------------------------------------------------------------ *
 * Datacenter ranges                                                   *
 * ------------------------------------------------------------------ */

test('the committed range file loads and covers a serious amount of space', () => {
  assert.equal(loadRanges(), true);
  const counted = rangeCount();
  assert.ok(
    counted.v4 + counted.v6 > 5000,
    `expected more than 5000 merged ranges, got ${counted.v4} IPv4 + ${counted.v6} IPv6`,
  );
  assert.ok(counted.v4 > 1000, `IPv4 ranges: ${counted.v4}`);
  assert.ok(counted.v6 > 1000, `IPv6 ranges: ${counted.v6}`);
});

test('addresses inside published cloud ranges are recognised', () => {
  for (const ip of [AWS_V4, GCP_V4, AZURE_V4, DIGITALOCEAN_V4, CLOUDFLARE_V4, '5.9.0.1', '51.68.0.1', '163.172.0.1']) {
    assert.equal(isDatacenterIp(ip), true, ip);
  }
  for (const ip of [AWS_V6, HETZNER_V6, '2606:4700::1', '2600:3c00::1', '2001:41d0::1']) {
    assert.equal(isDatacenterIp(ip), true, ip);
  }
});

test('consumer ISP addresses are not datacenter addresses', () => {
  for (const ip of [HOME_V4, HOME_V4_FR, HOME_V6, HOME_V6_DE, '8.8.8.8', '1.1.1.1']) {
    assert.equal(isDatacenterIp(ip), false, ip);
  }
});

test('private, loopback and reserved space never matches', () => {
  // A provider file that ever listed one of these would silently blackhole
  // every LAN visit, so the builder drops reserved ranges on the way in.
  for (const ip of ['10.0.0.7', '192.168.1.10', '172.16.4.4', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fc00::1']) {
    assert.equal(isDatacenterIp(ip), false, ip);
  }
});

test('socket address decorations are understood', () => {
  // node:http reports an IPv4 client on a dual-stack socket this way.
  assert.equal(isDatacenterIp(`::ffff:${AWS_V4}`), true);
  assert.equal(isDatacenterIp(`::ffff:${HOME_V4}`), false);
  assert.equal(isDatacenterIp(`[${HETZNER_V6}]`), true);
  assert.equal(isDatacenterIp(`${HETZNER_V6}%eth0`), true);
  assert.equal(isDatacenterIp(`  ${AWS_V4}  `), true);
});

test('malformed addresses are false, never a throw', () => {
  const junk = [
    '', '   ', null, undefined, 42, {}, [],
    'nope', 'localhost', 'example.com',
    '999.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.', '.1.2.3', '1.2.3.-4',
    '01.2.3.4', // ambiguous octal-looking octet: refuse rather than guess
    '3.5.140.1/24', '3.5.140.1:8080',
    '::gggg', '1:2:3:4:5:6:7:8:9', ':::', '2600::1::2', '[2a01:4f8::1',
  ];
  for (const value of junk) assert.equal(isDatacenterIp(value), false, JSON.stringify(value));
});

test('address parsers are strict', () => {
  assert.equal(ipv4ToNumber('0.0.0.0'), 0);
  assert.equal(ipv4ToNumber('255.255.255.255'), 4294967295);
  assert.equal(ipv4ToNumber('192.0.2.33'), 0xc0000221);
  assert.equal(ipv4ToNumber('192.0.02.33'), null);
  assert.equal(ipv4ToNumber('192.0.2.256'), null);
  assert.equal(ipv4ToNumber('192.0.2'), null);
  assert.equal(ipv4ToNumber(''), null);
  assert.equal(ipv4ToNumber(null), null);

  assert.equal(ipv6ToBigInt('::'), 0n);
  assert.equal(ipv6ToBigInt('::1'), 1n);
  assert.equal(ipv6ToBigInt('2001:db8::1'), 0x20010db8000000000000000000000001n);
  assert.equal(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001'), 0x20010db8000000000000000000000001n);
  // Embedded IPv4, the form node:http produces for dual-stack sockets.
  assert.equal(ipv6ToBigInt('::ffff:192.0.2.33'), 0xffffc0000221n);
  assert.equal(ipv6ToBigInt('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(ipv6ToBigInt('1::2::3'), null);
  assert.equal(ipv6ToBigInt('12345::'), null);
  assert.equal(ipv6ToBigInt('::ffff:999.1.1.1'), null);
});

/* ------------------------------------------------------------------ *
 * classifyTraffic — each signal in isolation                          *
 * ------------------------------------------------------------------ */

test('ua_missing: no User-Agent at all', () => {
  for (const userAgent of ['', '   ', undefined, null, 123]) {
    assert.deepEqual(classifyTraffic({ userAgent, ip: HOME_V4, headers: BROWSER_HEADERS }), {
      bot: true,
      reason: 'ua_missing',
      confidence: 'certain',
    });
  }
  assert.equal(classifyTraffic().reason, 'ua_missing');
  assert.equal(classifyTraffic({}).reason, 'ua_missing');
});

test('headless_ua: automation runtimes', () => {
  const drivers = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Puppeteer',
    'Mozilla/5.0 (Windows NT 10.0) Playwright/1.44',
    'PhantomJS/2.1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Chrome-Lighthouse',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/24.0.0',
  ];
  for (const userAgent of drivers) {
    const out = classifyTraffic({ userAgent, ip: HOME_V4, headers: BROWSER_HEADERS });
    assert.deepEqual(out, { bot: true, reason: 'headless_ua', confidence: 'certain' }, userAgent);
  }
});

test('Electron is not a headless signature — desktop apps carry real people', () => {
  const out = classifyTraffic({
    userAgent: NOTION_DESKTOP,
    ip: HOME_V4,
    headers: { ...BROWSER_HEADERS, 'user-agent': NOTION_DESKTOP },
  });
  assert.deepEqual(out, { bot: false, reason: '', confidence: 'likely' });
});

test('preview_bot: unfurl fetchers get their own reason, not the generic one', () => {
  const previews = [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
  ];
  for (const userAgent of previews) {
    const out = classifyTraffic({ userAgent, ip: HOME_V4, headers: BROWSER_HEADERS });
    assert.deepEqual(out, { bot: true, reason: 'preview_bot', confidence: 'certain' }, userAgent);
    // The generic layer already caught these; the point is the better reason.
    assert.equal(isBot(userAgent), true, userAgent);
  }
});

test('PREVIEW_BOTS names every fetcher it matches', () => {
  assert.ok(PREVIEW_BOTS.length >= 5);
  const names = new Set(PREVIEW_BOTS.map((preview) => preview.name));
  for (const expected of ['Slack', 'Discord', 'WhatsApp', 'Telegram', 'Facebook']) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
  for (const { token, name } of PREVIEW_BOTS) {
    assert.equal(token, token.toLowerCase(), token);
    assert.ok(name.length > 0, token);
  }
});

test('ua_pattern: the User-Agent layer still carries the bulk of the work', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'curl/8.4.0',
    'python-requests/2.32.3',
    'Go-http-client/2.0',
    'MyInternalScript 1.0',
  ];
  for (const userAgent of bots) {
    const out = classifyTraffic({ userAgent, ip: HOME_V4, headers: BROWSER_HEADERS });
    assert.deepEqual(out, { bot: true, reason: 'ua_pattern', confidence: 'certain' }, userAgent);
  }
});

test('probe_path: a scanner replaying the beacon against the site', () => {
  const paths = [
    '/.git/config',
    '/.env',
    '/wp-config.php',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/etc/passwd',
    '/index.php?x=${jndi:ldap://x/a}',
    '/search?q=<script>alert(1)</script>',
    '/../../../../etc/hosts',
    '/download?file=..%2f..%2fsecret',
  ];
  for (const pathname of paths) {
    const out = classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: BROWSER_HEADERS, pathname });
    assert.deepEqual(out, { bot: true, reason: 'probe_path', confidence: 'likely' }, pathname);
  }
});

test('probe_path does not fire on ordinary pages that merely look alarming', () => {
  const paths = ['/', '/docs/.env-example', '/blog/how-we-read-etc-passwd-safely', '/git/config', '/environment'];
  for (const pathname of paths) {
    const out = classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: BROWSER_HEADERS, pathname });
    assert.equal(out.bot, false, pathname);
  }
});

test('datacenter_ip: a browser User-Agent from cloud space with nothing to back it up', () => {
  const headers = { 'accept-language': 'en-US,en;q=0.9', 'x-forwarded-proto': 'https' };
  for (const ip of [AWS_V4, GCP_V4, AZURE_V4, DIGITALOCEAN_V4, AWS_V6, HETZNER_V6]) {
    const out = classifyTraffic({ userAgent: CHROME, ip, headers });
    assert.deepEqual(out, { bot: true, reason: 'datacenter_ip', confidence: 'likely' }, ip);
  }
});

test('no_accept_language: every browser sends it, no HTTP library does', () => {
  const out = classifyTraffic({
    userAgent: CHROME,
    ip: HOME_V4,
    headers: without('accept-language'),
  });
  assert.deepEqual(out, { bot: true, reason: 'no_accept_language', confidence: 'likely' });
});

test('no_sec_fetch: a modern Chrome claim with no Fetch Metadata behind it', () => {
  const out = classifyTraffic({
    userAgent: CHROME,
    ip: HOME_V4,
    headers: without(...SEC_FETCH),
  });
  assert.deepEqual(out, { bot: true, reason: 'no_sec_fetch', confidence: 'likely' });

  // Chrome 80 predates the header, so its absence proves nothing.
  const old = classifyTraffic({
    userAgent: CHROME_80,
    ip: HOME_V4,
    headers: without(...SEC_FETCH, 'sec-ch-ua'),
  });
  assert.equal(old.bot, false);
});

test('no_sec_ch_ua: Chrome 120+ that forgot its own client hint', () => {
  const out = classifyTraffic({
    userAgent: CHROME,
    ip: HOME_V4,
    headers: without('sec-ch-ua'),
  });
  assert.deepEqual(out, { bot: true, reason: 'no_sec_ch_ua', confidence: 'likely' });

  // Below the threshold, and browsers that never send the hint at all.
  for (const userAgent of [CHROME_100, SAFARI, FIREFOX, IPHONE]) {
    const ok = classifyTraffic({ userAgent, ip: HOME_V4, headers: without('sec-ch-ua') });
    assert.equal(ok.bot, false, userAgent);
  }
});

/* ------------------------------------------------------------------ *
 * classifyTraffic — the combinations that decide real traffic         *
 * ------------------------------------------------------------------ */

test('a normal Chrome visitor on a home connection passes cleanly', () => {
  for (const ip of [HOME_V4, HOME_V4_FR, HOME_V6, HOME_V6_DE]) {
    assert.deepEqual(
      classifyTraffic({ userAgent: CHROME, ip, headers: BROWSER_HEADERS, pathname: '/pricing' }),
      { bot: false, reason: '', confidence: 'likely' },
      ip,
    );
  }
  // Chromium sends the client hint, WebKit and Gecko never have.
  for (const userAgent of [ANDROID, CUBOT]) {
    const headers = { ...BROWSER_HEADERS, 'user-agent': userAgent };
    assert.equal(classifyTraffic({ userAgent, ip: HOME_V4, headers }).bot, false, userAgent);
  }
  for (const userAgent of [SAFARI, FIREFOX, IPHONE]) {
    const headers = without('sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform');
    headers['user-agent'] = userAgent;
    assert.equal(classifyTraffic({ userAgent, ip: HOME_V4, headers }).bot, false, userAgent);
  }
});

test('a real browser behind a corporate VPN in cloud space is NOT dropped', () => {
  // Zscaler, Netskope, Cloudflare WARP and any site fronted by Cloudflare all
  // put genuine visitors on these addresses. The full browser header set is
  // what buys them the benefit of the doubt.
  for (const ip of [AWS_V4, AZURE_V4, GCP_V4, CLOUDFLARE_V4, AWS_V6, HETZNER_V6]) {
    assert.deepEqual(
      classifyTraffic({ userAgent: CHROME, ip, headers: BROWSER_HEADERS, pathname: '/' }),
      { bot: false, reason: '', confidence: 'likely' },
      ip,
    );
  }
});

test('the same User-Agent from the same AWS address without Sec-Fetch is dropped', () => {
  const out = classifyTraffic({
    userAgent: CHROME,
    ip: AWS_V4,
    headers: without(...SEC_FETCH, 'sec-ch-ua'),
    pathname: '/',
  });
  assert.deepEqual(out, { bot: true, reason: 'datacenter_ip', confidence: 'likely' });

  // Same story over IPv6.
  const v6 = classifyTraffic({
    userAgent: CHROME,
    ip: AWS_V6,
    headers: without(...SEC_FETCH, 'sec-ch-ua'),
  });
  assert.deepEqual(v6, { bot: true, reason: 'datacenter_ip', confidence: 'likely' });
});

test('an instance served over plain HTTP keeps its visitors', () => {
  // Browsers only attach Sec-Fetch-* and Sec-CH-UA to trustworthy URLs, so on
  // an http:// instance nobody sends them. Reading that as evidence would empty
  // the dashboard, so the two signals stand down and the datacenter rule has to
  // settle for Accept-Language.
  const plain = { 'accept-language': 'en-US,en;q=0.9', 'x-forwarded-proto': 'http' };
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: plain }).bot, false);
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: AWS_V4, headers: plain }).bot, false);

  // Nothing at all to tell us the scheme: same benefit of the doubt.
  const unknown = { 'accept-language': 'en-US,en;q=0.9' };
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: AWS_V4, headers: unknown }).bot, false);

  // …unless the caller states the hop was secure, and then it is evidence again.
  assert.deepEqual(classifyTraffic({ userAgent: CHROME, ip: AWS_V4, headers: unknown, secure: true }), {
    bot: true,
    reason: 'datacenter_ip',
    confidence: 'likely',
  });
});

test('every way a proxy announces TLS is understood', () => {
  const bare = without(...SEC_FETCH, 'sec-ch-ua', 'x-forwarded-proto');
  const announcements = [
    { 'x-forwarded-proto': 'https' },
    { 'x-forwarded-proto': 'https, http' },
    { 'x-forwarded-scheme': 'https' },
    { 'x-url-scheme': 'https' },
    { 'x-forwarded-ssl': 'on' },
    { 'front-end-https': 'on' },
    { 'cf-visitor': '{"scheme":"https"}' },
  ];
  for (const extra of announcements) {
    const out = classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: { ...bare, ...extra } });
    assert.deepEqual(out, { bot: true, reason: 'no_sec_fetch', confidence: 'likely' }, JSON.stringify(extra));
  }
});

test('callers that pass no headers get no header-based verdicts', () => {
  // The demo seeder and the events import call in this way. Inferring from a
  // missing argument would manufacture bots out of nothing.
  for (const headers of [undefined, null, {}, 'nope']) {
    assert.deepEqual(classifyTraffic({ userAgent: CHROME, ip: AWS_V4, headers }), {
      bot: false,
      reason: '',
      confidence: 'likely',
    }, JSON.stringify(headers));
  }
  // The User-Agent and path layers still apply.
  assert.equal(classifyTraffic({ userAgent: 'curl/8.4.0' }).reason, 'ua_pattern');
  assert.equal(classifyTraffic({ userAgent: CHROME, pathname: '/.git/config' }).reason, 'probe_path');
});

test('headers arrive in whatever shape the caller has', () => {
  const wireCased = {
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Forwarded-Proto': 'https',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-CH-UA': '"Google Chrome";v="130"',
  };
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: wireCased }).bot, false);

  const fetchHeaders = new Headers(BROWSER_HEADERS);
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: fetchHeaders }).bot, false);
  fetchHeaders.delete('accept-language');
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: fetchHeaders }).reason, 'no_accept_language');

  // Node repeats some headers as an array.
  const repeated = { ...BROWSER_HEADERS, 'accept-language': ['fr-FR,fr;q=0.9', 'en;q=0.5'] };
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: HOME_V4, headers: repeated }).bot, false);
});

test('the most certain reason wins, so the reason stays actionable', () => {
  // Every signal fires at once: headless beats the generic pattern, which beats
  // the address, which beats the headers.
  const worst = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.0.0 Safari/537.36',
    ip: AWS_V4,
    headers: { 'x-forwarded-proto': 'https' },
    pathname: '/.git/config',
  };
  assert.equal(classifyTraffic(worst).reason, 'headless_ua');
  assert.equal(classifyTraffic({ ...worst, userAgent: 'Slackbot-LinkExpanding 1.0' }).reason, 'preview_bot');
  assert.equal(classifyTraffic({ ...worst, userAgent: 'curl/8.4.0' }).reason, 'ua_pattern');
  assert.equal(classifyTraffic({ ...worst, userAgent: CHROME }).reason, 'probe_path');
  assert.equal(classifyTraffic({ ...worst, userAgent: CHROME, pathname: '/' }).reason, 'datacenter_ip');
  assert.equal(classifyTraffic({ ...worst, userAgent: CHROME, pathname: '/', ip: HOME_V4 }).reason, 'no_accept_language');
});

test('SIGNAL_NAMES is the complete, stable set of reasons', () => {
  assert.deepEqual([...SIGNAL_NAMES], [
    'ua_missing',
    'headless_ua',
    'preview_bot',
    'ua_pattern',
    'probe_path',
    'datacenter_ip',
    'no_accept_language',
    'no_sec_fetch',
    'no_sec_ch_ua',
  ]);
  assert.ok(Object.isFrozen(SIGNAL_NAMES));
  assert.equal(new Set(SIGNAL_NAMES).size, SIGNAL_NAMES.length);
});

test('every verdict is well formed and every reason is a declared signal', () => {
  const samples = [
    {}, { userAgent: CHROME }, { userAgent: CHROME, ip: AWS_V4 },
    { userAgent: CHROME, ip: AWS_V4, headers: BROWSER_HEADERS },
    { userAgent: CHROME, ip: HOME_V4, headers: without('accept-language') },
    { userAgent: CHROME, ip: HOME_V6, headers: without(...SEC_FETCH) },
    { userAgent: 'curl/8.4.0', ip: HOME_V4, headers: BROWSER_HEADERS },
    { userAgent: SAFARI, ip: 'garbage', headers: BROWSER_HEADERS, pathname: '/x' },
    { userAgent: FIREFOX, ip: '', headers: BROWSER_HEADERS, pathname: '/.env' },
  ];
  for (const signals of samples) {
    const out = classifyTraffic(signals);
    assert.equal(typeof out.bot, 'boolean');
    assert.ok(out.confidence === 'certain' || out.confidence === 'likely', out.confidence);
    if (out.bot) assert.ok(SIGNAL_NAMES.includes(out.reason), `undeclared reason ${out.reason}`);
    else assert.equal(out.reason, '');
  }
});

test('classifyTraffic agrees with isBot whenever isBot says bot', () => {
  // classifyTraffic may drop more, never less: isBot is the floor.
  const strings = [
    CHROME, SAFARI, FIREFOX, IPHONE, ANDROID, CUBOT, NOTION_DESKTOP,
    'curl/8.4.0', 'Googlebot/2.1', '', 'x', 'Wget/1.21.4', 'Slackbot 1.0',
  ];
  for (const userAgent of strings) {
    if (!isBot(userAgent)) continue;
    assert.equal(
      classifyTraffic({ userAgent, ip: HOME_V4, headers: BROWSER_HEADERS }).bot,
      true,
      userAgent,
    );
  }
});

/* ------------------------------------------------------------------ *
 * isBot() — unchanged behaviour                                       *
 * ------------------------------------------------------------------ */

test('isBot: real browsers are not bots', () => {
  for (const ua of [CHROME, IPHONE, FIREFOX, ANDROID, CUBOT, SAFARI, NOTION_DESKTOP]) {
    assert.equal(isBot(ua), false, ua);
  }
  assert.equal(
    isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'),
    false,
  );
  assert.equal(isBot('Opera/9.80 (Windows NT 6.0) Presto/2.12.388 Version/12.14'), false);
});

test('isBot: missing or empty user agents are treated as bots', () => {
  assert.equal(isBot(''), true);
  assert.equal(isBot('   '), true);
  assert.equal(isBot(undefined), true);
  assert.equal(isBot(null), true);
  assert.equal(isBot(123), true);
});

test('isBot: crawlers, monitors and preview fetchers are bots', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0)',
    'Mozilla/5.0 (compatible; Yahoo! Slurp)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Screaming Frog SEO Spider/19.2',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.0.0 Safari/537.36',
    'PhantomJS/2.1.1',
    'Pingdom.com_bot_version_1.4',
    'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.23.20.0 A',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'curl/8.4.0',
    'Wget/1.21.4',
    'python-requests/2.32.3',
    'Go-http-client/2.0',
    'Java/17.0.9',
    'PostmanRuntime/7.39.0',
    'Scrapy/2.11 (+https://scrapy.org)',
  ];
  for (const ua of bots) assert.equal(isBot(ua), true, ua);
});

test('isBot: unrecognised non-browser strings are rejected', () => {
  assert.equal(isBot('x'), true);
  assert.equal(isBot('MyInternalScript 1.0'), true);
  assert.equal(isBot('-'), true);
});

test('isBot: stable across repeated calls (cache)', () => {
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot('curl/8.4.0'), true);
  assert.equal(isBot('curl/8.4.0'), true);
});

test('BOT_PATTERNS is a non-empty list of strings and regexes', () => {
  assert.ok(Array.isArray(BOT_PATTERNS));
  assert.ok(BOT_PATTERNS.length > 50);
  for (const pattern of BOT_PATTERNS) {
    const ok = typeof pattern === 'string' ? pattern === pattern.toLowerCase() : pattern instanceof RegExp;
    assert.ok(ok, `invalid pattern: ${pattern}`);
  }
});

/* ------------------------------------------------------------------ *
 * Loader failure, last: it deliberately leaves the module unloaded    *
 * ------------------------------------------------------------------ */

test('a missing or corrupt range file disables the signal instead of guessing', (t) => {
  t.after(() => {
    assert.equal(loadRanges(), true); // put the module back for anything after
  });

  // A request the address signal alone was catching a moment ago.
  const thin = { 'accept-language': 'en-US,en;q=0.9', 'x-forwarded-proto': 'https' };
  const caught = { userAgent: SAFARI, ip: AWS_V4, headers: thin };
  assert.equal(classifyTraffic(caught).reason, 'datacenter_ip');

  assert.equal(loadRanges('/nonexistent/datacenter-ranges.json'), false);
  assert.deepEqual(rangeCount(), { v4: 0, v6: 0 });
  assert.equal(isDatacenterIp(AWS_V4), false);

  // The signal is simply gone; nothing else misfires in its place.
  assert.deepEqual(classifyTraffic(caught), { bot: false, reason: '', confidence: 'likely' });
  assert.equal(classifyTraffic({ userAgent: 'curl/8.4.0', ip: AWS_V4, headers: thin }).reason, 'ua_pattern');
  assert.equal(classifyTraffic({ userAgent: CHROME, ip: AWS_V4, headers: BROWSER_HEADERS }).bot, false);
});

test('a bad range count is refused instead of being allocated', (t) => {
  t.after(() => {
    assert.equal(loadRanges(), true);
  });

  // Both decoders size their arrays from `counts` before reading a token, so
  // the count is an allocation request. These files are ~90 bytes each; the
  // ranges they claim would be 16 GB of typed array, or a negative length that
  // throws RangeError out of the lazy load — i.e. out of the first lookup of a
  // live request, not out of boot.
  const file = join(tmpdir(), `credible-ranges-${process.pid}.json`);
  t.after(() => rmSync(file, { force: true }));

  const bad = [
    ['far more ranges than the payload holds', { v4: 4e9, v6: 0 }],
    ['a negative count', { v4: -1, v6: 0 }],
    ['a fractional count', { v4: 3.5, v6: 0 }],
    ['a non-numeric count', { v4: 'many', v6: 0 }],
    ['the same on the v6 side', { v4: 0, v6: 4e9 }],
  ];
  for (const [label, counts] of bad) {
    writeFileSync(file, JSON.stringify({ counts, v4: '0,0', v6: '0,0' }));
    assert.equal(loadRanges(file), false, label);
    assert.deepEqual(rangeCount(), { v4: 0, v6: 0 }, label);
    assert.equal(isDatacenterIp(AWS_V4), false, label);
  }

  // The bound is the payload, not a magic number: a count the text can account
  // for still loads. "0,0,1,0" is two adjacent single-address ranges.
  writeFileSync(file, JSON.stringify({ counts: { v4: 2, v6: 0 }, v4: '0,0,1,0', v6: '' }));
  assert.equal(loadRanges(file), true);
  assert.deepEqual(rangeCount(), { v4: 2, v6: 0 });
  assert.equal(isDatacenterIp('0.0.0.0'), true);
  assert.equal(isDatacenterIp('0.0.0.2'), true);
  assert.equal(isDatacenterIp('0.0.0.3'), false);
});
