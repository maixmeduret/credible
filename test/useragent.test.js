/**
 * User-Agent parser tests.
 *
 * Every string below is a real (or historically real) User-Agent header, kept
 * verbatim so the ordering rules stay honest: the forks that impersonate Chrome
 * must win over Chrome, and Chrome must win over Safari.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUserAgent, screenSizeBucket } from '../src/ingest/useragent.js';

/** Shorthand for the expected shape. */
function expect(browser, browserVersion, os, osVersion, device) {
  return { browser, browserVersion, os, osVersion, device };
}

const CASES = [
  // --- Chrome ------------------------------------------------------------
  [
    'Chrome on Windows 10/11',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    expect('Chrome', '126', 'Windows', '10', 'Desktop'),
  ],
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    expect('Chrome', '125', 'macOS', '10.15', 'Desktop'),
  ],
  [
    'Chrome on Linux',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    expect('Chrome', '124', 'Linux', '', 'Desktop'),
  ],
  [
    'Chrome on Chrome OS',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    expect('Chrome', '119', 'Chrome OS', '14541.0', 'Desktop'),
  ],
  [
    'Chrome on an Android phone',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
    expect('Chrome', '126', 'Android', '14', 'Mobile'),
  ],
  [
    'Chrome on an Android tablet (no Mobile token)',
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.179 Safari/537.36',
    expect('Chrome', '124', 'Android', '13', 'Tablet'),
  ],
  [
    'Chrome on iOS (CriOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
    expect('Chrome', '126', 'iOS', '17.5', 'Mobile'),
  ],
  [
    'Amazon Silk reports itself as Chrome on an Android tablet',
    'Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/117.1.36 like Chrome/117.0.5938.60 Safari/537.36',
    expect('Chrome', '117', 'Android', '9', 'Tablet'),
  ],

  // --- Safari ------------------------------------------------------------
  [
    'Safari on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    expect('Safari', '17', 'macOS', '10.15', 'Desktop'),
  ],
  [
    'Safari on iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    expect('Safari', '17', 'iOS', '17.4', 'Mobile'),
  ],
  [
    'Safari on iPad (classic iPadOS UA)',
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    expect('Safari', '16', 'iOS', '16.6', 'Tablet'),
  ],
  [
    'Safari on iPadOS 13+ desktop-class UA is indistinguishable from a Mac',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    expect('Safari', '17', 'macOS', '10.15', 'Desktop'),
  ],

  // --- Firefox -----------------------------------------------------------
  [
    'Firefox on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    expect('Firefox', '127', 'Windows', '10', 'Desktop'),
  ],
  [
    'Firefox on macOS (dotted Mac version)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
    expect('Firefox', '127', 'macOS', '14.5', 'Desktop'),
  ],
  [
    'Firefox on Ubuntu',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
    expect('Firefox', '126', 'Ubuntu', '', 'Desktop'),
  ],
  [
    'Firefox on Fedora',
    'Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    expect('Firefox', '125', 'Fedora', '', 'Desktop'),
  ],
  [
    'Firefox on FreeBSD',
    'Mozilla/5.0 (X11; FreeBSD amd64; rv:121.0) Gecko/20100101 Firefox/121.0',
    expect('Firefox', '121', 'FreeBSD', '', 'Desktop'),
  ],
  [
    'Firefox on an Android phone',
    'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
    expect('Firefox', '127', 'Android', '14', 'Mobile'),
  ],
  [
    'Firefox on an Android tablet',
    'Mozilla/5.0 (Android 13; Tablet; rv:109.0) Gecko/115.0 Firefox/115.0',
    expect('Firefox', '115', 'Android', '13', 'Tablet'),
  ],
  [
    'Firefox on iOS (FxiOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15',
    expect('Firefox', '126', 'iOS', '17.4', 'Mobile'),
  ],

  // --- Edge (must beat Chrome) -------------------------------------------
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68',
    expect('Edge', '126', 'Windows', '10', 'Desktop'),
  ],
  [
    'Edge on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.51',
    expect('Edge', '125', 'macOS', '10.15', 'Desktop'),
  ],
  [
    'Edge on Android (EdgA)',
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.179 Mobile Safari/537.36 EdgA/124.0.2478.104',
    expect('Edge', '124', 'Android', '13', 'Mobile'),
  ],
  [
    'Edge on iOS (EdgiOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 EdgiOS/125.0.2535.60 Mobile/15E148 Safari/604.1',
    expect('Edge', '125', 'iOS', '17.4', 'Mobile'),
  ],
  [
    'Legacy EdgeHTML',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763',
    expect('Edge', '18', 'Windows', '10', 'Desktop'),
  ],

  // --- Other Chromium forks ----------------------------------------------
  [
    'Opera desktop (OPR)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0',
    expect('Opera', '111', 'Windows', '10', 'Desktop'),
  ],
  [
    'Opera on Android',
    'Mozilla/5.0 (Linux; Android 10; VOG-L29) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 OPR/76.2.4027.73374',
    expect('Opera', '76', 'Android', '10', 'Mobile'),
  ],
  [
    'Opera Presto (version hides in Version/)',
    'Opera/9.80 (Windows NT 6.1; U; en) Presto/2.10.229 Version/11.62',
    expect('Opera', '11', 'Windows', '7', 'Desktop'),
  ],
  [
    'Opera Mini',
    'Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS; Opera Mobi/23.348; U; en) Presto/2.5.25 Version/10.54',
    expect('Opera', '9', '', '', 'Mobile'),
  ],
  [
    'Samsung Internet',
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    expect('Samsung Internet', '25', 'Android', '13', 'Mobile'),
  ],
  [
    'Brave (only the builds that advertise themselves)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Brave/126.1.67.116',
    expect('Brave', '126', 'macOS', '10.15', 'Desktop'),
  ],
  [
    'Vivaldi',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Vivaldi/6.7.3329.31',
    expect('Vivaldi', '6', 'Windows', '10', 'Desktop'),
  ],
  [
    'Yandex Browser',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 YaBrowser/24.4.0.0 Safari/537.36',
    expect('Yandex Browser', '24', 'Windows', '10', 'Desktop'),
  ],
  [
    'UC Browser on Android',
    'Mozilla/5.0 (Linux; U; Android 9; en-US; Redmi Note 8 Build/PKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
    expect('UC Browser', '13', 'Android', '9', 'Mobile'),
  ],

  // --- Internet Explorer --------------------------------------------------
  [
    'Internet Explorer 11 (no MSIE token)',
    'Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko',
    expect('Internet Explorer', '11', 'Windows', '7', 'Desktop'),
  ],
  [
    'Internet Explorer 9',
    'Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)',
    expect('Internet Explorer', '9', 'Windows', '7', 'Desktop'),
  ],
  [
    'Internet Explorer 8 on Windows XP',
    'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 5.1; Trident/4.0)',
    expect('Internet Explorer', '8', 'Windows', 'XP', 'Desktop'),
  ],
  [
    'Chrome on Windows 8.1',
    'Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    expect('Chrome', '109', 'Windows', '8.1', 'Desktop'),
  ],

  // --- Webviews and in-app browsers ---------------------------------------
  [
    'Android WebView (wv token)',
    'Mozilla/5.0 (Linux; Android 12; SM-A515F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36',
    expect('Chrome Webview', '116', 'Android', '12', 'Mobile'),
  ],
  [
    'Pre-Lollipop Android WebView (no Chrome token)',
    'Mozilla/5.0 (Linux; U; Android 4.4.2; en-us; SM-G900F Build/KOT49H) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    expect('Chrome Webview', '4', 'Android', '4.4', 'Mobile'),
  ],
  [
    'iOS in-app browser (Facebook)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone13,2;FBMD/iPhone]',
    expect('Safari (in-app)', '', 'iOS', '16.6', 'Mobile'),
  ],

  [
    'Safari on an iPod touch',
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
    expect('Safari', '12', 'iOS', '12.5', 'Mobile'),
  ],
  [
    'Windows 10 Mobile spoofs an Android token and must not win',
    'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15254',
    expect('Edge', '15', 'Windows', '10', 'Mobile'),
  ],

  // --- Consoles ------------------------------------------------------------
  [
    'PlayStation 5 browser',
    'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
    expect('Safari', '13', 'Playstation', '5', 'Desktop'),
  ],
  [
    'PlayStation Vita browser (a console, so still Desktop)',
    'Mozilla/5.0 (PlayStation Vita 3.61) AppleWebKit/537.73 (KHTML, like Gecko) Silk/3.2 Safari/537.73',
    expect('Safari', '', 'Playstation', '3', 'Desktop'),
  ],
  [
    'Xbox Series X browser (Windows UA with an Xbox token)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.82 Safari/537.36 Edge/20.02',
    expect('Edge', '20', 'Xbox', '', 'Desktop'),
  ],

  // --- Non-browser clients --------------------------------------------------
  [
    'Googlebot',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    expect('', '', '', '', 'Desktop'),
  ],
  [
    'curl',
    'curl/8.6.0',
    expect('', '', '', '', 'Desktop'),
  ],
];

test('parseUserAgent recognises real-world User-Agent strings', () => {
  assert.ok(CASES.length >= 25, 'coverage should stay broad');
  for (const [name, ua, want] of CASES) {
    assert.deepStrictEqual(parseUserAgent(ua), want, name);
  }
});

test('parseUserAgent never throws on missing or garbage input', () => {
  const empty = { browser: '', browserVersion: '', os: '', osVersion: '', device: 'Desktop' };
  for (const input of [undefined, null, '', '   ', 0, 42, true, {}, [], NaN, Symbol.iterator]) {
    assert.deepStrictEqual(parseUserAgent(input), empty, String(String(input)));
  }
  assert.deepStrictEqual(parseUserAgent('%%%% <script>'), empty);
});

test('parseUserAgent tolerates absurdly long headers', () => {
  const padded = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ${'x'.repeat(50_000)}`;
  const started = Date.now();
  assert.deepStrictEqual(parseUserAgent(padded), {
    browser: 'Chrome',
    browserVersion: '126',
    os: 'Windows',
    osVersion: '10',
    device: 'Desktop',
  });
  assert.ok(Date.now() - started < 1000, 'parsing must stay linear');
});

test('parseUserAgent always returns the full shape', () => {
  const keys = ['browser', 'browserVersion', 'os', 'osVersion', 'device'];
  for (const [, ua] of CASES) {
    const result = parseUserAgent(ua);
    assert.deepStrictEqual(Object.keys(result).sort(), [...keys].sort());
    for (const key of keys) assert.equal(typeof result[key], 'string');
    assert.ok(['Desktop', 'Mobile', 'Tablet'].includes(result.device));
    if (result.browserVersion) assert.match(result.browserVersion, /^\d+$/, ua);
  }
});

test('parseUserAgent only ever returns known browser and OS names', () => {
  const browsers = new Set([
    '', 'Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Samsung Internet', 'Brave',
    'Vivaldi', 'Yandex Browser', 'UC Browser', 'Internet Explorer', 'Chrome Webview',
    'Safari (in-app)',
  ]);
  const systems = new Set([
    '', 'Windows', 'macOS', 'iOS', 'Android', 'Linux', 'Chrome OS', 'Ubuntu', 'Fedora',
    'FreeBSD', 'Playstation', 'Xbox',
  ]);
  for (const [, ua] of CASES) {
    const { browser, os } = parseUserAgent(ua);
    assert.ok(browsers.has(browser), `unexpected browser: ${browser}`);
    assert.ok(systems.has(os), `unexpected os: ${os}`);
  }
});

test('screenSizeBucket buckets viewport widths', () => {
  assert.equal(screenSizeBucket(1), 'Mobile');
  assert.equal(screenSizeBucket(320), 'Mobile');
  assert.equal(screenSizeBucket(575), 'Mobile');
  assert.equal(screenSizeBucket(575.9), 'Mobile');
  assert.equal(screenSizeBucket(576), 'Tablet');
  assert.equal(screenSizeBucket(768), 'Tablet');
  assert.equal(screenSizeBucket(991), 'Tablet');
  assert.equal(screenSizeBucket(992), 'Laptop');
  assert.equal(screenSizeBucket(1280), 'Laptop');
  assert.equal(screenSizeBucket(1439), 'Laptop');
  assert.equal(screenSizeBucket(1440), 'Desktop');
  assert.equal(screenSizeBucket(3840), 'Desktop');
});

test('screenSizeBucket accepts numeric strings from the tracker', () => {
  assert.equal(screenSizeBucket('375'), 'Mobile');
  assert.equal(screenSizeBucket('1200'), 'Laptop');
  assert.equal(screenSizeBucket(' 1600 '), 'Desktop');
});

test('screenSizeBucket returns "" for missing or invalid widths', () => {
  for (const input of [undefined, null, '', '   ', 'abc', NaN, Infinity, -Infinity, 0, -1, false, true, {}, []]) {
    assert.equal(screenSizeBucket(input), '', String(String(input)));
  }
});
