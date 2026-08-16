/**
 * Bot detection.
 *
 * Analytics numbers are only credible if crawlers, uptime monitors and link
 * preview fetchers never reach the counters. Two layers do that work here:
 *
 *  1. isBot(userAgent) matches the User-Agent against known automation
 *     markers. It is the one signal every client sends, it costs nothing to
 *     check, and it needs no personal data — in line with the rest of
 *     Credible, the UA is inspected and thrown away, never persisted.
 *
 *  2. classifyTraffic(signals) weighs that verdict together with the client
 *     address and the request headers, because the crawlers that actually
 *     distort a small site's numbers are the ones sending a perfectly ordinary
 *     Chrome User-Agent. Nothing extra is stored either: the address is read
 *     from memory, matched against published cloud ranges, and dropped.
 *
 * Both layers are deliberately strict about the User-Agent — a visit only
 * counts as human when it matches none of the known automation markers *and*
 * looks like a real browser build string, because under-counting a rare exotic
 * client is far less damaging than inflating every chart with crawlers. The
 * address and header signals lean the other way. They never claim more than
 * 'likely' and each one is written to fail open, because a false positive there
 * silently deletes a real visitor and nobody ever finds out.
 */
import { isDatacenterIp } from './datacenters.js';

/**
 * Markers of automated clients. Strings are matched as substrings against the
 * lowercased User-Agent; regular expressions are tested against it directly.
 */
export const BOT_PATTERNS = [
  // Generic markers — a terminator keeps 'bot' from matching inside a word.
  /(?:^|[^a-z])bot(?:[^a-z]|$)/,
  /bot[/;,)\s]/,
  /[a-z0-9](?:crawler|crawl|spider|scraper)(?:[^a-z]|$)/,
  /(?:^|[^a-z])(?:crawler|crawl|spider|scraper|fetcher|indexer)(?:[^a-z]|$)/,
  'slurp',
  'headless',
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress.io',
  // NOTE: 'Electron/' is deliberately NOT here. Slack, Discord, Notion, VS Code
  // and every other desktop app with an embedded browser identify that way, and
  // the people clicking links inside them are real visitors.

  // Search, social and AI crawlers.
  'googlebot',
  'google-inspectiontool',
  'googleother',
  'google-extended',
  'google web preview',
  'adsbot-google',
  'mediapartners-google',
  'feedfetcher-google',
  'apis-google',
  'storebot-google',
  'bingbot',
  'bingpreview',
  'msnbot',
  'adidxbot',
  'duckduckbot',
  'duckassistbot',
  'baiduspider',
  'yandexbot',
  'yandeximages',
  'yandexaccessibilitybot',
  'sogou',
  'exabot',
  'seznambot',
  'petalbot',
  'coccocbot',
  'naverbot',
  'yeti/',
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-web',
  'claude-user',
  'claude-searchbot',
  'anthropic-ai',
  'perplexitybot',
  'perplexity-user',
  'bytespider',
  'amazonbot',
  'applebot',
  'ccbot',
  'cohere-ai',
  'diffbot',
  'meta-externalagent',
  'meta-externalfetcher',
  'imagesiftbot',
  'omgili',
  'timpibot',
  'youbot',
  'ia_archiver',
  'archive.org_bot',
  'wayback',
  'nutch',
  'heritrix',

  // SEO and site-audit suites.
  'ahrefs',
  'semrush',
  'screaming frog',
  'majestic',
  'mj12bot',
  'dotbot',
  'rogerbot',
  'blexbot',
  'dataforseo',
  'sistrix',
  'seokicks',
  'serpstat',
  'linkdex',
  'sitebulb',
  'oncrawl',
  'netcraftsurveyagent',
  'zoominfobot',

  // Uptime, performance and security monitoring.
  'pingdom',
  'uptime',
  'statuscake',
  'site24x7',
  'newrelicpinger',
  'datadog',
  'monitoring',
  'monitis',
  'nagios',
  'zabbix',
  'gtmetrix',
  'webpagetest',
  'sitespeed',
  'lighthouse',
  'pagespeed',
  'chrome-lighthouse',
  'w3c_validator',
  'validator.nu',
  'zgrab',
  'masscan',
  'nmap',
  'nikto',
  'sqlmap',
  'wpscan',
  'censys',
  'shodan',
  'internet-measurement',
  'expanseinc',

  // Link preview and unfurl fetchers.
  'facebookexternalhit',
  'facebookcatalog',
  'whatsapp',
  'telegrambot',
  'discordbot',
  'slackbot',
  'slack-imgproxy',
  'twitterbot',
  'linkedinbot',
  'redditbot',
  'pinterestbot',
  'skypeuripreview',
  'vkshare',
  'embedly',
  'quora link preview',
  'outbrain',
  'nuzzel',
  'preview',
  'unfurl',
  'iframely',
  'snapchat ads',

  // Feed readers.
  'feedly',
  'feedburner',
  'feedfetcher',
  'inoreader',
  'newsblur',
  'netvibes',
  'theoldreader',

  // HTTP libraries and command line clients.
  'curl',
  'wget',
  'libwww-perl',
  'python-requests',
  'python-urllib',
  'python-httpx',
  'aiohttp',
  'scrapy',
  'mechanize',
  'httrack',
  'axios',
  'node-fetch',
  'undici',
  'got (',
  'okhttp',
  'apache-httpclient',
  'guzzlehttp',
  'symfony httpclient',
  'php/',
  'wordpress/',
  'drupal',
  'ruby/',
  'faraday',
  'rest-client',
  'go-http-client',
  'go-resty',
  'dart:io',
  'lua-resty-http',
  'powershell',
  'winhttp',
  'httpie',
  'postmanruntime',
  'insomnia',
  'restsharp',
  'jakarta',
  'httpunit',
  /(?:^|[^a-z])java\//,
  /(?:^|[^a-z])http_request/,
];

/**
 * Substrings that would otherwise trip the generic 'bot' rule. They are removed
 * from the User-Agent before matching. CUBOT is an Android phone brand and its
 * model names appear verbatim in the UA of real devices.
 */
export const BOT_FALSE_POSITIVES = ['cubot', 'abbot', 'talkbot', 'botswana'];

/**
 * Tokens present in every mainstream browser build string. A User-Agent with
 * none of them is not a browser, whether or not we recognise the tool.
 */
const BROWSER_MARKERS = ['mozilla/', 'opera/', 'applewebkit', 'webkit/', 'gecko/', 'trident/', 'msie '];

// Ingest is a hot path and User-Agents repeat heavily, so results are memoised.
// The cache is bounded: a flood of unique UAs resets it instead of growing.
const CACHE_LIMIT = 4096;
const cache = new Map();

/**
 * True when the User-Agent belongs to a crawler, monitor, preview fetcher or
 * script rather than a human visitor. A missing or empty User-Agent is treated
 * as a bot.
 *
 * @param {string} userAgent
 * @returns {boolean}
 */
export function isBot(userAgent) {
  if (typeof userAgent !== 'string') return true;
  const raw = userAgent.trim();
  if (!raw) return true;

  const cached = cache.get(raw);
  if (cached !== undefined) return cached;

  let ua = raw.toLowerCase();
  for (const token of BOT_FALSE_POSITIVES) {
    if (ua.includes(token)) ua = ua.split(token).join(' ');
  }

  let bot = false;
  for (const pattern of BOT_PATTERNS) {
    if (typeof pattern === 'string' ? ua.includes(pattern) : pattern.test(ua)) {
      bot = true;
      break;
    }
  }

  // Nothing matched: accept it only if it still looks like a browser.
  if (!bot) bot = !BROWSER_MARKERS.some((marker) => ua.includes(marker));

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(raw, bot);
  return bot;
}

/* ------------------------------------------------------------------ *
 * Behavioural classification                                          *
 * ------------------------------------------------------------------ */

/**
 * Every reason classifyTraffic() can give, in the order it tests them.
 * SIGNAL_NAMES below is derived from this object, so the two can never drift.
 */
const SIGNAL = Object.freeze({
  UA_MISSING: 'ua_missing',
  HEADLESS_UA: 'headless_ua',
  PREVIEW_BOT: 'preview_bot',
  UA_PATTERN: 'ua_pattern',
  PROBE_PATH: 'probe_path',
  DATACENTER_IP: 'datacenter_ip',
  NO_ACCEPT_LANGUAGE: 'no_accept_language',
  NO_SEC_FETCH: 'no_sec_fetch',
  NO_SEC_CH_UA: 'no_sec_ch_ua',
});

/**
 * Stable ids for each reason, for counting. Seed a dashboard counter from this
 * list and the keys will survive a reordering of the checks. Traffic that
 * passes carries an empty reason and is deliberately not in here.
 */
export const SIGNAL_NAMES = Object.freeze(Object.values(SIGNAL));

/**
 * Headless and automation runtimes. These are drivers, not browsers: whatever
 * they render, no human is looking at.
 *
 * 'Electron/' is deliberately absent, for the reason spelled out inside
 * BOT_PATTERNS — Slack, Discord, Notion and VS Code all identify that way, and
 * the people clicking links inside them are real visitors.
 */
const HEADLESS_MARKERS = [
  'headlesschrome',
  'headless', // HeadlessFirefox and the generic marker other stacks adopted
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress.io',
  'chrome-lighthouse',
  'jsdom',
  'htmlunit',
];

/**
 * Link preview and unfurl fetchers that execute the page rather than just
 * reading its <head>. They are the ones that can fire the tracker and put a
 * phantom pageview on the chart every time somebody pastes a link in a chat,
 * so they get their own reason instead of hiding inside 'ua_pattern'.
 */
export const PREVIEW_BOTS = Object.freeze([
  { token: 'slackbot', name: 'Slack' },
  { token: 'slack-imgproxy', name: 'Slack' },
  { token: 'discordbot', name: 'Discord' },
  { token: 'whatsapp', name: 'WhatsApp' },
  { token: 'telegrambot', name: 'Telegram' },
  { token: 'facebookexternalhit', name: 'Facebook' },
  { token: 'facebookcatalog', name: 'Facebook' },
  { token: 'meta-externalfetcher', name: 'Meta' },
  { token: 'twitterbot', name: 'X (Twitter)' },
  { token: 'linkedinbot', name: 'LinkedIn' },
  { token: 'skypeuripreview', name: 'Skype' },
  { token: 'pinterestbot', name: 'Pinterest' },
  { token: 'embedly', name: 'Embedly' },
  { token: 'iframely', name: 'Iframely' },
]);

/**
 * Fragments that cannot occur in the path of a page that ran the tracker.
 * Seeing one means the beacon was hand-built and replayed by a scanner aimed at
 * the site, not fired by a rendered page: browsers resolve '..' before sending
 * a request and percent-encode nothing back into a NUL, so a surviving '../'
 * or '%00' had to be typed by a tool.
 */
const PROBE_PATH_MARKERS = [
  '/.git/',
  '/.svn/',
  '/.aws/',
  '/.ssh/',
  '/wp-config.php',
  '/vendor/phpunit/',
  '/etc/passwd',
  '${jndi:',
  '<script',
  '../',
  '..%2f',
  '%00',
];

/**
 * Chrome 76 shipped Sec-Fetch-Site/Mode/Dest in July 2019. Requiring it only
 * from 90 up leaves a wide margin for Chromium forks and embedded WebViews that
 * carried an older engine behind a newer version string.
 */
const SEC_FETCH_SINCE = 90;

/**
 * Sec-CH-UA has shipped since Chrome 89, but took much longer to become
 * universal across forks and Android WebView. 120 is late enough that a client
 * claiming it and not sending the header is claiming something untrue.
 */
const SEC_CH_UA_SINCE = 120;

const CHROMIUM_VERSION = /(?:chrome|chromium)\/(\d{1,4})/;
const SEC_FETCH_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

/** True when the string holds an ASCII capital. Cheaper than a toLowerCase(). */
function hasUpperCase(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) return true;
  }
  return false;
}

/**
 * Accept whatever shape the caller has: node:http hands over a plain object
 * already keyed in lowercase, a fetch `Headers` or a Map answers `get`, and an
 * importer may pass something it built by hand with wire casing.
 *
 * Returns null when no headers were supplied at all. That is not the same thing
 * as a request that sent none, and must never be read as evidence.
 */
function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') return headers;
  const keys = Object.keys(headers);
  if (keys.length === 0) return null;
  if (!keys.some(hasUpperCase)) return headers;
  const lowered = {};
  for (const key of keys) lowered[key.toLowerCase()] = headers[key];
  return lowered;
}

/** One header value, trimmed; '' when absent. */
function header(headers, name) {
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  if (value == null) return '';
  return String(Array.isArray(value) ? value[0] : value).trim();
}

const hasSecFetch = (headers) => SEC_FETCH_HEADERS.some((name) => header(headers, name) !== '');

/**
 * Did the browser's own hop to us run over TLS?
 *
 * This gates the two Sec- signals, and getting it wrong is fatal. Browsers only
 * attach Fetch Metadata (Sec-Fetch-*) and client hints (Sec-CH-UA) to
 * potentially-trustworthy URLs, so an instance reached over plain HTTP never
 * sees either — from humans or from crawlers. Counting their absence as
 * evidence on such an instance would wipe out every visitor it has.
 *
 * `credible proxy` emits X-Forwarded-Proto for all five servers it supports and
 * every managed platform sets it, so the deployments people actually run are
 * covered. When nothing proves the hop was secure we skip the two signals
 * rather than guess.
 */
function secureHop(headers, explicit) {
  if (typeof explicit === 'boolean') return explicit;

  const proto = header(headers, 'x-forwarded-proto')
    || header(headers, 'x-forwarded-scheme')
    || header(headers, 'x-url-scheme');
  if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';

  if (header(headers, 'x-forwarded-ssl').toLowerCase() === 'on') return true;
  if (header(headers, 'front-end-https').toLowerCase() === 'on') return true;
  if (header(headers, 'cf-visitor').includes('"https"')) return true;

  // Otherwise the headers can prove it themselves: no browser sends these over
  // plain HTTP, so seeing one means this hop was secure.
  return hasSecFetch(headers) || header(headers, 'sec-ch-ua') !== '';
}

/**
 * Headers a browser adds that a script has to fake on purpose.
 *
 * Accept-Language comes from the user's OS and browser preferences and no HTTP
 * client library sends it unless told to. Sec-Fetch-* and Sec-CH-UA are set by
 * the browser itself and sit on the forbidden-header list, so page JavaScript
 * cannot add them even if it wanted to.
 *
 * Demanding the pair is what keeps real people who egress through cloud address
 * space out of the datacenter rule: corporate VPNs, Zscaler and Netskope
 * gateways, Cloudflare WARP, and any site behind Cloudflare while
 * CREDIBLE_TRUST_PROXY is off — all of which look exactly like a bot by address
 * alone. Over plain HTTP neither Sec- family exists, so there Accept-Language
 * is the most a real browser could possibly have offered and has to be enough.
 */
function carriesBrowserHeaders(headers, secure) {
  if (!header(headers, 'accept-language')) return false;
  if (hasSecFetch(headers) || header(headers, 'sec-ch-ua') !== '') return true;
  return !secure;
}

/** Major Chromium version claimed by a lowercased UA, or 0. */
function chromiumMajor(ua) {
  const match = CHROMIUM_VERSION.exec(ua);
  return match ? Number(match[1]) : 0;
}

/** True when the reported page path is a vulnerability-scanner probe. */
function isProbePath(pathname) {
  const path = pathname.toLowerCase();
  if (PROBE_PATH_MARKERS.some((marker) => path.includes(marker))) return true;
  // '.env' only counts as a whole segment: '/docs/.env-example' is a real page.
  return path.endsWith('/.env');
}

/**
 * Weigh everything a request says about who sent it.
 *
 * Signals are tested most-certain first and the first hit wins, so the reason
 * that comes back names the strongest evidence rather than the last thing
 * checked — which is what makes it worth putting on a dashboard. Within the
 * certain tier the specific checks run before the generic BOT_PATTERNS sweep,
 * or 'ua_pattern' would swallow every headless and unfurl hit and the reason
 * would stop being actionable.
 *
 * `confidence` qualifies the verdict, not the traffic. 'certain' means the
 * client identified itself as automation; 'likely' means we inferred it. A pass
 * is never better than 'likely' either, because no absence of evidence proves a
 * human was there.
 *
 * @param {object} signals
 * @param {string} signals.userAgent
 * @param {string} [signals.ip]
 * @param {object} [signals.headers]     raw request headers
 * @param {string} [signals.pathname]
 * @param {boolean} [signals.secure]     override for "the browser hop used TLS"
 * @returns {{ bot: boolean, reason: string, confidence: 'certain'|'likely' }}
 */
export function classifyTraffic(signals = {}) {
  const userAgent = typeof signals.userAgent === 'string' ? signals.userAgent : '';
  const ua = userAgent.trim().toLowerCase();

  /* Certain — the client told us what it is. */

  if (!ua) return { bot: true, reason: SIGNAL.UA_MISSING, confidence: 'certain' };

  if (HEADLESS_MARKERS.some((marker) => ua.includes(marker))) {
    return { bot: true, reason: SIGNAL.HEADLESS_UA, confidence: 'certain' };
  }
  if (PREVIEW_BOTS.some((preview) => ua.includes(preview.token))) {
    return { bot: true, reason: SIGNAL.PREVIEW_BOT, confidence: 'certain' };
  }
  if (isBot(userAgent)) return { bot: true, reason: SIGNAL.UA_PATTERN, confidence: 'certain' };

  // Getting here already proves the User-Agent is a plausible browser build
  // string: isBot() rejects anything carrying no mainstream browser token at
  // all. Every rule below therefore only has to ask whether the rest of the
  // request backs that claim up.

  const pathname = typeof signals.pathname === 'string' ? signals.pathname : '';
  if (pathname && isProbePath(pathname)) {
    return { bot: true, reason: SIGNAL.PROBE_PATH, confidence: 'likely' };
  }

  const headers = normalizeHeaders(signals.headers);
  // No headers were handed to us at all — the demo seeder and the import path
  // both call in that way. Every remaining rule reads headers, and inferring
  // from their absence would only invent bots out of missing arguments.
  if (!headers) return { bot: false, reason: '', confidence: 'likely' };

  const secure = secureHop(headers, signals.secure);

  /* Likely — inference, hardest fact first. */

  if (isDatacenterIp(signals.ip) && !carriesBrowserHeaders(headers, secure)) {
    return { bot: true, reason: SIGNAL.DATACENTER_IP, confidence: 'likely' };
  }
  if (header(headers, 'accept-language') === '') {
    return { bot: true, reason: SIGNAL.NO_ACCEPT_LANGUAGE, confidence: 'likely' };
  }

  const chromium = chromiumMajor(ua);
  if (secure && chromium >= SEC_FETCH_SINCE && !hasSecFetch(headers)) {
    return { bot: true, reason: SIGNAL.NO_SEC_FETCH, confidence: 'likely' };
  }
  if (secure && chromium >= SEC_CH_UA_SINCE && header(headers, 'sec-ch-ua') === '') {
    return { bot: true, reason: SIGNAL.NO_SEC_CH_UA, confidence: 'likely' };
  }

  return { bot: false, reason: '', confidence: 'likely' };
}
