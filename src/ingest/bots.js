/**
 * Bot detection.
 *
 * Analytics numbers are only credible if crawlers, uptime monitors and link
 * preview fetchers never reach the counters. We match on the User-Agent alone:
 * it is the one signal every client sends, it costs nothing to check, and it
 * requires storing no personal data — in line with the rest of Credible, the UA
 * is inspected and thrown away, never persisted.
 *
 * The strategy is deliberately strict. A visit only counts as human when the
 * User-Agent matches none of the known automation markers *and* looks like a
 * real browser build string. Anything else is dropped: under-counting a rare
 * exotic client is far less damaging than inflating every chart with crawlers.
 */

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
