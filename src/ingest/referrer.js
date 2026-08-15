/**
 * Acquisition-channel classification.
 *
 * Turns a raw `document.referrer` plus the campaign parameters found on the
 * landing URL into the three values the dashboard shows:
 *
 *   channel  — the CHANNELS tab (Direct, Organic Search, Paid Social, …)
 *   source   — the SOURCES tab, a human display name ('Google', 'Hacker News')
 *   referrer — the cleaned 'host/path' we store for the referrer breakdown
 *
 * Everything is a pure function over static lookup tables: no network calls, no
 * IP databases, no cookies. The tables below are deliberately verbose — they are
 * exported so the dashboard can render the same display names, and so tests can
 * assert against them without duplicating knowledge.
 *
 * Host matching happens in three passes, from most to least specific:
 *   1. exact host  ('mail.google.com' → Gmail, before Google the search engine)
 *   2. parent hosts, one label at a time down to the registrable domain
 *      ('l.facebook.com' → 'facebook.com' → Facebook)
 *   3. prefix rules on the *registrable domain only*, which is what makes the
 *      international variants work ('google.co.uk', 'amazon.de', 'yandex.com.tr')
 *      without letting 'google.com.evil.example' impersonate Google.
 */

/** Every channel `classifyReferrer` can return. Useful for dashboard ordering. */
export const CHANNELS = [
  'Direct',
  'Organic Search',
  'Paid Search',
  'Organic Social',
  'Paid Social',
  'Organic Video',
  'Organic Shopping',
  'Paid Shopping',
  'Email',
  'Affiliates',
  'Referral',
  'Display',
  'SMS',
  'Audio',
  'Unknown',
];

/** Advertising click identifiers we recognise on a landing URL. */
export const CLICK_ID_PARAMS = [
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
  'ttclid',
  'twclid',
  'li_fat_id',
  'dclid',
  'yclid',
  'irclickid',
  'epik',
  'rdt_cid',
];

/**
 * What a click id implies when nothing else identifies the visit.
 *
 * `fbclid` is the odd one out: Facebook appends it to *organic* shares too, so
 * on its own it only proves the visit came from Facebook — never that it was
 * paid. A paid utm_medium is required to upgrade it to 'Paid Social'.
 */
const CLICK_ID_INFO = {
  gclid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  gbraid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  wbraid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  msclkid: { channel: 'Paid Search', source: 'Bing', type: 'search' },
  yclid: { channel: 'Paid Search', source: 'Yandex', type: 'search' },
  dclid: { channel: 'Display', source: 'Google Display Network', type: 'referral' },
  irclickid: { channel: 'Affiliates', source: 'Impact', type: 'referral' },
  fbclid: { channel: 'Organic Social', source: 'Facebook', type: 'social' },
  ttclid: { channel: 'Paid Social', source: 'TikTok', type: 'social' },
  twclid: { channel: 'Paid Social', source: 'X (Twitter)', type: 'social' },
  li_fat_id: { channel: 'Paid Social', source: 'LinkedIn', type: 'social' },
  rdt_cid: { channel: 'Paid Social', source: 'Reddit', type: 'social' },
  epik: { channel: 'Paid Social', source: 'Pinterest', type: 'social' },
};

/* ------------------------------------------------------------------ *
 * Host tables — hostname (already lowercased and stripped of 'www.')  *
 * mapped to its display name.                                        *
 * ------------------------------------------------------------------ */

/** Search engines → 'Organic Search'. */
export const SEARCH_ENGINES = {
  'google.com': 'Google',
  'news.google.com': 'Google News',
  'scholar.google.com': 'Google Scholar',
  'images.google.com': 'Google Images',
  'translate.google.com': 'Google Translate',
  'bing.com': 'Bing',
  'cn.bing.com': 'Bing',
  'duckduckgo.com': 'DuckDuckGo',
  'lite.duckduckgo.com': 'DuckDuckGo',
  'html.duckduckgo.com': 'DuckDuckGo',
  'yahoo.com': 'Yahoo!',
  'search.yahoo.com': 'Yahoo!',
  'yandex.com': 'Yandex',
  'yandex.ru': 'Yandex',
  'baidu.com': 'Baidu',
  'm.baidu.com': 'Baidu',
  'ecosia.org': 'Ecosia',
  'startpage.com': 'Startpage',
  'qwant.com': 'Qwant',
  'search.brave.com': 'Brave Search',
  'kagi.com': 'Kagi',
  'mojeek.com': 'Mojeek',
  'marginalia.nu': 'Marginalia',
  'search.marginalia.nu': 'Marginalia',
  'searx.be': 'SearXNG',
  'searxng.site': 'SearXNG',
  'swisscows.com': 'Swisscows',
  'metager.de': 'MetaGer',
  'presearch.com': 'Presearch',
  'ask.com': 'Ask',
  'aol.com': 'AOL',
  'search.aol.com': 'AOL',
  'lycos.com': 'Lycos',
  'excite.com': 'Excite',
  'naver.com': 'Naver',
  'search.naver.com': 'Naver',
  'daum.net': 'Daum',
  'search.daum.net': 'Daum',
  'seznam.cz': 'Seznam',
  'search.seznam.cz': 'Seznam',
  'sogou.com': 'Sogou',
  'so.com': '360 Search',
  'haosou.com': '360 Search',
  'coccoc.com': 'Cốc Cốc',
  'rambler.ru': 'Rambler',
  'nova.rambler.ru': 'Rambler',
  'go.mail.ru': 'Mail.ru',
  'petalsearch.com': 'Petal Search',
  'onesearch.com': 'OneSearch',
  'yep.com': 'Yep',
  'gibiru.com': 'Gibiru',
  'search.ch': 'Search.ch',
  'searchencrypt.com': 'Search Encrypt',
};

/** Social networks and communities → 'Organic Social'. */
export const SOCIAL_NETWORKS = {
  'facebook.com': 'Facebook',
  'm.facebook.com': 'Facebook',
  'l.facebook.com': 'Facebook',
  'lm.facebook.com': 'Facebook',
  'web.facebook.com': 'Facebook',
  'business.facebook.com': 'Facebook',
  'messenger.com': 'Messenger',
  'l.messenger.com': 'Messenger',
  'instagram.com': 'Instagram',
  'l.instagram.com': 'Instagram',
  'twitter.com': 'X (Twitter)',
  'mobile.twitter.com': 'X (Twitter)',
  'x.com': 'X (Twitter)',
  't.co': 'X (Twitter)',
  'linkedin.com': 'LinkedIn',
  'lnkd.in': 'LinkedIn',
  'reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'out.reddit.com': 'Reddit',
  'redd.it': 'Reddit',
  'pinterest.com': 'Pinterest',
  'pin.it': 'Pinterest',
  'tiktok.com': 'TikTok',
  'vm.tiktok.com': 'TikTok',
  'snapchat.com': 'Snapchat',
  't.me': 'Telegram',
  'telegram.me': 'Telegram',
  'web.telegram.org': 'Telegram',
  'whatsapp.com': 'WhatsApp',
  'web.whatsapp.com': 'WhatsApp',
  'chat.whatsapp.com': 'WhatsApp',
  'discord.com': 'Discord',
  'discordapp.com': 'Discord',
  'slack.com': 'Slack',
  'app.slack.com': 'Slack',
  'mastodon.social': 'Mastodon',
  'mastodon.online': 'Mastodon',
  'fosstodon.org': 'Mastodon',
  'hachyderm.io': 'Mastodon',
  'bsky.app': 'Bluesky',
  'threads.net': 'Threads',
  'threads.com': 'Threads',
  'news.ycombinator.com': 'Hacker News',
  'lobste.rs': 'Lobsters',
  'producthunt.com': 'Product Hunt',
  'medium.com': 'Medium',
  'substack.com': 'Substack',
  'quora.com': 'Quora',
  'tumblr.com': 'Tumblr',
  'dev.to': 'DEV Community',
  'hashnode.com': 'Hashnode',
  'indiehackers.com': 'Indie Hackers',
  'digg.com': 'Digg',
  'flipboard.com': 'Flipboard',
  'nextdoor.com': 'Nextdoor',
  'meetup.com': 'Meetup',
  'xing.com': 'XING',
  'vk.com': 'VKontakte',
  'ok.ru': 'Odnoklassniki',
  'weibo.com': 'Weibo',
  'zhihu.com': 'Zhihu',
  'douban.com': 'Douban',
  'line.me': 'LINE',
  'wechat.com': 'WeChat',
};

/** Video platforms → 'Organic Video'. */
export const VIDEO_PLATFORMS = {
  'youtube.com': 'YouTube',
  'm.youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'vimeo.com': 'Vimeo',
  'player.vimeo.com': 'Vimeo',
  'dailymotion.com': 'Dailymotion',
  'dai.ly': 'Dailymotion',
  'twitch.tv': 'Twitch',
  'm.twitch.tv': 'Twitch',
  'rumble.com': 'Rumble',
  'odysee.com': 'Odysee',
  'bitchute.com': 'BitChute',
  'nebula.tv': 'Nebula',
  'bilibili.com': 'Bilibili',
  'youku.com': 'Youku',
};

/** Marketplaces → 'Organic Shopping'. */
export const SHOPPING_SITES = {
  'amazon.com': 'Amazon',
  'smile.amazon.com': 'Amazon',
  'etsy.com': 'Etsy',
  'ebay.com': 'eBay',
  'aliexpress.com': 'AliExpress',
  'alibaba.com': 'Alibaba',
  'temu.com': 'Temu',
  'shein.com': 'SHEIN',
  'wish.com': 'Wish',
  'walmart.com': 'Walmart',
  'target.com': 'Target',
  'bestbuy.com': 'Best Buy',
  'newegg.com': 'Newegg',
  'wayfair.com': 'Wayfair',
  'shop.app': 'Shop',
  'shopify.com': 'Shopify',
  'gumroad.com': 'Gumroad',
  'flipkart.com': 'Flipkart',
  'bol.com': 'bol.com',
  'otto.de': 'OTTO',
  'cdiscount.com': 'Cdiscount',
  'allegro.pl': 'Allegro',
  'zalando.com': 'Zalando',
  'rakuten.co.jp': 'Rakuten',
  'mercadolibre.com': 'Mercado Libre',
  'mercadolivre.com.br': 'Mercado Libre',
};

/** Webmail and desktop mail clients → 'Email'. */
export const EMAIL_CLIENTS = {
  'mail.google.com': 'Gmail',
  'gmail.com': 'Gmail',
  'outlook.com': 'Outlook',
  'outlook.live.com': 'Outlook',
  'outlook.office.com': 'Outlook',
  'outlook.office365.com': 'Outlook',
  'hotmail.com': 'Outlook',
  'live.com': 'Outlook',
  'mail.yahoo.com': 'Yahoo! Mail',
  'mail.yahoo.co.jp': 'Yahoo! Mail',
  'mail.aol.com': 'AOL Mail',
  'mail.proton.me': 'Proton Mail',
  'proton.me': 'Proton Mail',
  'protonmail.com': 'Proton Mail',
  'mail.zoho.com': 'Zoho Mail',
  'superhuman.com': 'Superhuman',
  'mail.superhuman.com': 'Superhuman',
  'hey.com': 'HEY',
  'app.hey.com': 'HEY',
  'fastmail.com': 'Fastmail',
  'app.fastmail.com': 'Fastmail',
  'mail.com': 'Mail.com',
  'gmx.com': 'GMX',
  'gmx.net': 'GMX',
  'web.de': 'WEB.DE',
  'mail.yandex.ru': 'Yandex Mail',
  'mail.yandex.com': 'Yandex Mail',
  'mail.ru': 'Mail.ru',
  'e.mail.ru': 'Mail.ru',
  'roundcube.net': 'Roundcube',
  'missiveapp.com': 'Missive',
  'list-manage.com': 'Mailchimp',
  'campaign-archive.com': 'Mailchimp',
};

/**
 * AI assistants → 'Organic Search'.
 *
 * Answer engines replace a search box for a growing share of visits, so they
 * belong in the same channel as search while keeping their own display name.
 */
export const AI_ASSISTANTS = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'openai.com': 'OpenAI',
  'perplexity.ai': 'Perplexity',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'bard.google.com': 'Gemini',
  'aistudio.google.com': 'Google AI Studio',
  'notebooklm.google.com': 'NotebookLM',
  'copilot.microsoft.com': 'Microsoft Copilot',
  'copilot.cloud.microsoft': 'Microsoft Copilot',
  'meta.ai': 'Meta AI',
  'grok.com': 'Grok',
  'x.ai': 'Grok',
  'poe.com': 'Poe',
  'you.com': 'You.com',
  'phind.com': 'Phind',
  'mistral.ai': 'Le Chat',
  'chat.mistral.ai': 'Le Chat',
  'deepseek.com': 'DeepSeek',
  'chat.deepseek.com': 'DeepSeek',
  'doubao.com': 'Doubao',
  'kimi.moonshot.cn': 'Kimi',
};

/**
 * Well-known hosts that stay in the 'Referral' channel but deserve a proper
 * display name instead of a bare hostname.
 */
export const KNOWN_REFERRERS = {
  'github.com': 'GitHub',
  'gist.github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'stackoverflow.com': 'Stack Overflow',
  'stackexchange.com': 'Stack Exchange',
  'serverfault.com': 'Server Fault',
  'superuser.com': 'Super User',
  'wikipedia.org': 'Wikipedia',
  'en.wikipedia.org': 'Wikipedia',
  'notion.so': 'Notion',
  'trello.com': 'Trello',
  'atlassian.net': 'Jira',
  'figma.com': 'Figma',
  'codepen.io': 'CodePen',
  'npmjs.com': 'npm',
  'baserow.io': 'Baserow',
  'feedly.com': 'Feedly',
  'getpocket.com': 'Pocket',
  'news.ycombinator.com.cdn.ampproject.org': 'Hacker News',
};

/**
 * Prefix rules applied to the registrable domain only, so every country
 * variant of the big players resolves without listing hundreds of TLDs.
 */
const DOMAIN_PREFIXES = [
  { prefix: 'google.', name: 'Google', map: SEARCH_ENGINES },
  { prefix: 'yahoo.', name: 'Yahoo!', map: SEARCH_ENGINES },
  { prefix: 'yandex.', name: 'Yandex', map: SEARCH_ENGINES },
  { prefix: 'baidu.', name: 'Baidu', map: SEARCH_ENGINES },
  { prefix: 'bing.', name: 'Bing', map: SEARCH_ENGINES },
  { prefix: 'duckduckgo.', name: 'DuckDuckGo', map: SEARCH_ENGINES },
  { prefix: 'ecosia.', name: 'Ecosia', map: SEARCH_ENGINES },
  { prefix: 'qwant.', name: 'Qwant', map: SEARCH_ENGINES },
  { prefix: 'startpage.', name: 'Startpage', map: SEARCH_ENGINES },
  { prefix: 'seznam.', name: 'Seznam', map: SEARCH_ENGINES },
  { prefix: 'naver.', name: 'Naver', map: SEARCH_ENGINES },
  { prefix: 'amazon.', name: 'Amazon', map: SHOPPING_SITES },
  { prefix: 'ebay.', name: 'eBay', map: SHOPPING_SITES },
  { prefix: 'etsy.', name: 'Etsy', map: SHOPPING_SITES },
  { prefix: 'aliexpress.', name: 'AliExpress', map: SHOPPING_SITES },
  { prefix: 'temu.', name: 'Temu', map: SHOPPING_SITES },
  { prefix: 'zalando.', name: 'Zalando', map: SHOPPING_SITES },
  { prefix: 'allegro.', name: 'Allegro', map: SHOPPING_SITES },
  { prefix: 'rakuten.', name: 'Rakuten', map: SHOPPING_SITES },
  { prefix: 'mercadolibre.', name: 'Mercado Libre', map: SHOPPING_SITES },
  { prefix: 'mercadolivre.', name: 'Mercado Libre', map: SHOPPING_SITES },
  { prefix: 'wikipedia.', name: 'Wikipedia', map: KNOWN_REFERRERS },
];

/** Which channel each table feeds, in match priority order. */
const HOST_TABLES = [
  { map: AI_ASSISTANTS, channel: 'Organic Search', type: 'ai' },
  { map: EMAIL_CLIENTS, channel: 'Email', type: 'email' },
  { map: SEARCH_ENGINES, channel: 'Organic Search', type: 'search' },
  { map: VIDEO_PLATFORMS, channel: 'Organic Video', type: 'video' },
  { map: SOCIAL_NETWORKS, channel: 'Organic Social', type: 'social' },
  { map: SHOPPING_SITES, channel: 'Organic Shopping', type: 'shopping' },
  { map: KNOWN_REFERRERS, channel: 'Referral', type: 'referral' },
];

const TABLE_BY_MAP = new Map(HOST_TABLES.map((t) => [t.map, t]));

/**
 * Native app referrers arrive as 'android-app://<package>' (and occasionally
 * 'ios-app://<bundle>'). Mapping the package back to its web host lets the rest
 * of the pipeline treat them like any other referrer.
 */
const APP_PACKAGE_HOSTS = {
  'com.google.android.gm': 'mail.google.com',
  'com.google.android.googlequicksearchbox': 'google.com',
  'com.google.android.youtube': 'youtube.com',
  'com.google.android.apps.magazines': 'news.google.com',
  'com.microsoft.office.outlook': 'outlook.com',
  'com.yahoo.mobile.client.android.mail': 'mail.yahoo.com',
  'ch.protonmail.android': 'mail.proton.me',
  'com.facebook.katana': 'facebook.com',
  'com.facebook.lite': 'facebook.com',
  'com.facebook.orca': 'messenger.com',
  'com.instagram.android': 'instagram.com',
  'com.twitter.android': 'twitter.com',
  'com.linkedin.android': 'linkedin.com',
  'com.reddit.frontpage': 'reddit.com',
  'com.pinterest': 'pinterest.com',
  'com.zhiliaoapp.musically': 'tiktok.com',
  'com.snapchat.android': 'snapchat.com',
  'org.telegram.messenger': 't.me',
  'com.whatsapp': 'whatsapp.com',
  'com.discord': 'discord.com',
  'com.slack': 'slack.com',
  'com.amazon.mshop.android.shopping': 'amazon.com',
  'com.medium.reader': 'medium.com',
  'com.apple.mobilemail': 'mail.apple.com',
};

/** utm_source values that are not hostnames, mapped to a canonical host. */
const SOURCE_ALIAS_HOSTS = {
  google: 'google.com',
  'google ads': 'google.com',
  google_ads: 'google.com',
  googleads: 'google.com',
  adwords: 'google.com',
  bing: 'bing.com',
  microsoft: 'bing.com',
  'bing ads': 'bing.com',
  yahoo: 'yahoo.com',
  duckduckgo: 'duckduckgo.com',
  ddg: 'duckduckgo.com',
  ecosia: 'ecosia.org',
  brave: 'search.brave.com',
  kagi: 'kagi.com',
  baidu: 'baidu.com',
  yandex: 'yandex.com',
  naver: 'naver.com',
  facebook: 'facebook.com',
  fb: 'facebook.com',
  'facebook ads': 'facebook.com',
  meta: 'facebook.com',
  messenger: 'messenger.com',
  instagram: 'instagram.com',
  ig: 'instagram.com',
  twitter: 'twitter.com',
  x: 'x.com',
  linkedin: 'linkedin.com',
  li: 'linkedin.com',
  reddit: 'reddit.com',
  pinterest: 'pinterest.com',
  tiktok: 'tiktok.com',
  snapchat: 'snapchat.com',
  telegram: 't.me',
  whatsapp: 'whatsapp.com',
  discord: 'discord.com',
  slack: 'slack.com',
  mastodon: 'mastodon.social',
  bluesky: 'bsky.app',
  threads: 'threads.net',
  hn: 'news.ycombinator.com',
  hackernews: 'news.ycombinator.com',
  'hacker news': 'news.ycombinator.com',
  'hacker-news': 'news.ycombinator.com',
  ycombinator: 'news.ycombinator.com',
  lobsters: 'lobste.rs',
  producthunt: 'producthunt.com',
  'product-hunt': 'producthunt.com',
  'product hunt': 'producthunt.com',
  quora: 'quora.com',
  medium: 'medium.com',
  tumblr: 'tumblr.com',
  vk: 'vk.com',
  youtube: 'youtube.com',
  yt: 'youtube.com',
  vimeo: 'vimeo.com',
  twitch: 'twitch.tv',
  github: 'github.com',
  gitlab: 'gitlab.com',
  stackoverflow: 'stackoverflow.com',
  wikipedia: 'wikipedia.org',
  amazon: 'amazon.com',
  etsy: 'etsy.com',
  ebay: 'ebay.com',
  aliexpress: 'aliexpress.com',
  gmail: 'mail.google.com',
  outlook: 'outlook.com',
  chatgpt: 'chatgpt.com',
  openai: 'openai.com',
  perplexity: 'perplexity.ai',
  claude: 'claude.ai',
  anthropic: 'claude.ai',
  gemini: 'gemini.google.com',
  bard: 'gemini.google.com',
  copilot: 'copilot.microsoft.com',
};

/** utm_source values that always mean email, whatever the medium says. */
const EMAIL_SOURCE_NAMES = {
  newsletter: 'Newsletter',
  email: 'Email',
  'e-mail': 'Email',
  mailchimp: 'Mailchimp',
  klaviyo: 'Klaviyo',
  sendgrid: 'SendGrid',
  brevo: 'Brevo',
  sendinblue: 'Brevo',
  mailerlite: 'MailerLite',
  convertkit: 'ConvertKit',
  kit: 'Kit',
  beehiiv: 'beehiiv',
  buttondown: 'Buttondown',
  ghost: 'Ghost',
  customerio: 'Customer.io',
  postmark: 'Postmark',
  mailgun: 'Mailgun',
  activecampaign: 'ActiveCampaign',
  constantcontact: 'Constant Contact',
  braze: 'Braze',
  iterable: 'Iterable',
};

/**
 * Two-label public suffixes, enough to compute a registrable domain without
 * shipping the full Public Suffix List. Only used as a matching heuristic —
 * a miss degrades to "one label too many", never to a wrong channel.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'co.th', 'co.id',
  'co.in', 'net.in', 'org.in', 'com.pk', 'com.bd',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.ec', 'com.uy',
  'com.tr', 'com.ua', 'com.ru', 'com.pl', 'com.ro',
  'co.za', 'com.ng', 'com.eg', 'com.ma', 'co.ke',
  'com.sa', 'com.qa', 'co.il', 'com.kw',
  'co.at', 'co.no', 'co.hu',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_FIELD = 255;

/** Trim, cap and optionally lowercase a query-string value. */
function cleanValue(value, lower = false) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, MAX_FIELD);
  return lower ? trimmed.toLowerCase() : trimmed;
}

/** Lowercase a hostname and drop the leading 'www.' and any trailing dot. */
function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/**
 * Best-effort registrable domain ("example.co.uk" from "shop.example.co.uk").
 * IP literals and single-label hosts are returned untouched.
 */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h || IPV4.test(h) || h.includes(':')) return h;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Accept a hostname, an origin or a full URL and return the bare hostname. */
function hostFromLoose(value) {
  if (!value || typeof value !== 'string') return '';
  let raw = value.trim();
  if (!raw) return '';
  if (raw.includes('://')) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      raw = raw.slice(raw.indexOf('://') + 3);
    }
  }
  raw = raw.split('/')[0];
  // Strip a port, but leave bracketed IPv6 literals alone.
  if (!raw.startsWith('[') && raw.includes(':')) raw = raw.split(':')[0];
  return normalizeHost(raw);
}

/**
 * Parse a raw `document.referrer`.
 * @returns {{host: string, path: string, clean: string} | null} null when the
 * referrer is absent; `{host: '', ...}` never happens — malformed input throws
 * the value away and is reported through the second return value.
 */
function parseReferrer(raw) {
  if (typeof raw !== 'string') return { ok: false, empty: true };
  const value = raw.trim();
  if (!value) return { ok: false, empty: true };

  // Native app referrers: android-app://com.google.android.gm
  const appMatch = /^(?:android-app|ios-app|app):\/\/([^/?#]+)/i.exec(value);
  if (appMatch) {
    const pkg = appMatch[1].toLowerCase();
    const host = APP_PACKAGE_HOSTS[pkg] || pkg;
    return { ok: true, host, path: '', clean: host };
  }

  let url = null;
  try {
    url = new URL(value);
  } catch {
    try {
      url = new URL(`https://${value}`);
    } catch {
      url = null;
    }
  }
  if (!url) return { ok: false, empty: false };

  // Only web referrers carry a usable hostname; file:, data:, javascript: do not.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, empty: false };
  }

  const host = normalizeHost(url.hostname);
  const plausible = host && (host.includes('.') || host === 'localhost' || host.startsWith('['));
  if (!plausible) return { ok: false, empty: false };

  let path = url.pathname || '';
  while (path.endsWith('/')) path = path.slice(0, -1);
  const clean = `${host}${path}`.slice(0, MAX_FIELD);
  return { ok: true, host, path, clean };
}

/** Look a hostname up in every table, exact match only. */
function exactLookup(host) {
  for (const table of HOST_TABLES) {
    const name = table.map[host];
    if (name) return { channel: table.channel, source: name, type: table.type };
  }
  return null;
}

/**
 * Classify a hostname.
 * @returns {{channel: string, source: string, type: string} | null} null when
 * the host is unknown, which the caller turns into a plain 'Referral'.
 */
export function classifyHost(host) {
  const h = normalizeHost(host);
  if (!h) return null;

  // 1. exact host
  const exact = exactLookup(h);
  if (exact) return exact;

  // 2. parent hosts, down to (and including) the registrable domain
  const registrable = registrableDomain(h);
  const labels = h.split('.');
  for (let i = 1; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    const hit = exactLookup(candidate);
    if (hit) return hit;
    if (candidate === registrable) break;
  }

  // 3. prefix rules, on the registrable domain only
  for (const rule of DOMAIN_PREFIXES) {
    if (registrable.startsWith(rule.prefix)) {
      const table = TABLE_BY_MAP.get(rule.map);
      return { channel: table.channel, source: rule.name, type: table.type };
    }
  }
  return null;
}

/**
 * Classify a utm_source value, which may be a hostname ('news.ycombinator.com'),
 * an alias ('hn') or a free-form vendor name ('partner-xyz').
 */
function classifySource(rawSource) {
  const token = normalizeHost(rawSource.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0]);
  if (!token) return null;

  const emailName = EMAIL_SOURCE_NAMES[token];
  if (emailName) return { channel: 'Email', source: emailName, type: 'email' };

  const aliased = SOURCE_ALIAS_HOSTS[token];
  if (aliased) return classifyHost(aliased);

  if (token.includes('.')) {
    const hit = classifyHost(token);
    if (hit) return hit;
    return { channel: null, source: token, type: 'referral' };
  }
  return null;
}

/** First recognised click id, in the order they were found on the URL. */
function clickIdInfo(clickIds) {
  for (const id of clickIds) {
    const info = CLICK_ID_INFO[id];
    if (info) return info;
  }
  return null;
}

const MEDIUM_RULES = [
  { test: /^(?:e-?mail|newsletter|mail)/, channel: 'Email' },
  { test: /^(?:affiliate|partner-?program|cpa-?affiliate)/, channel: 'Affiliates' },
  { test: /^(?:display|banner|cpm|expandable|interstitial|programmatic|native-?ad)/, channel: 'Display' },
  { test: /^(?:sms|mms|text-?message)/, channel: 'SMS' },
  { test: /^(?:audio|podcast|radio)/, channel: 'Audio' },
];

const PAID_MEDIUM = /^(?:cpc|ppc|paid)/;
const PAID_MEDIUM_EXACT = new Set(['sem', 'ads', 'ad', 'adwords', 'googleads', 'bingads', 'retargeting', 'remarketing', 'cpv', 'cpa']);

/**
 * Channel implied by utm_medium alone, refined by what the source looks like.
 * @returns {string|null} null when the medium says nothing we understand.
 */
function channelFromMedium(medium, type) {
  if (!medium) return null;

  for (const rule of MEDIUM_RULES) {
    if (rule.test.test(medium)) return rule.channel;
  }

  if (PAID_MEDIUM.test(medium) || PAID_MEDIUM_EXACT.has(medium)) {
    if (medium.includes('social')) return 'Paid Social';
    if (medium.includes('search')) return 'Paid Search';
    if (medium.includes('shop')) return 'Paid Shopping';
    if (type === 'social' || type === 'video') return 'Paid Social';
    if (type === 'shopping') return 'Paid Shopping';
    // Default for a bare 'cpc'/'ppc'/'paid': search ads are by far the most
    // common use of those mediums.
    return 'Paid Search';
  }

  if (/^social/.test(medium)) return 'Organic Social';
  if (/^refer/.test(medium)) return 'Referral';
  if (/^video/.test(medium)) return 'Organic Video';
  if (/^shopping/.test(medium)) return 'Organic Shopping';
  if (/^organic/.test(medium)) {
    if (type === 'social') return 'Organic Social';
    if (type === 'video') return 'Organic Video';
    if (type === 'shopping') return 'Organic Shopping';
    return 'Organic Search';
  }
  return null;
}

/** True when two hosts belong to the same site (equal, subdomain, or sibling). */
function isSameSite(host, siteHost) {
  const a = normalizeHost(host);
  const b = normalizeHost(siteHost);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return Boolean(ra) && ra === rb;
}

/** Normalise the `utm` bag handed to `classifyReferrer`. */
function normalizeUtm(utm) {
  const u = utm && typeof utm === 'object' ? utm : {};
  const clickIds = Array.isArray(u.clickIds)
    ? u.clickIds.map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    source: cleanValue(u.source),
    medium: cleanValue(u.medium, true),
    campaign: cleanValue(u.campaign),
    content: cleanValue(u.content),
    term: cleanValue(u.term),
    clickIds,
  };
}

/**
 * Extract utm_* parameters and advertising click ids from a landing URL.
 *
 * Accepts a URL string, a bare query string ('?utm_source=x' or 'utm_source=x'),
 * a `URL` instance or a `URLSearchParams`. Never throws.
 *
 * @param {string|URL|URLSearchParams} urlOrSearchParams
 * @returns {{source: string, medium: string, campaign: string, content: string, term: string, clickIds: string[]}}
 */
export function extractCampaign(urlOrSearchParams) {
  const empty = { source: '', medium: '', campaign: '', content: '', term: '', clickIds: [] };
  const input = urlOrSearchParams;
  let params = null;

  if (!input) return empty;

  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return empty;
    const q = raw.indexOf('?');
    let query = q >= 0 ? raw.slice(q + 1) : raw;
    const hash = query.indexOf('#');
    if (hash >= 0) query = query.slice(0, hash);
    try {
      params = new URLSearchParams(query);
    } catch {
      return empty;
    }
  } else if (typeof input.searchParams?.get === 'function') {
    params = input.searchParams; // URL instance (or anything URL-shaped)
  } else if (typeof input.get === 'function') {
    params = input; // URLSearchParams instance
  } else {
    return empty;
  }

  const pick = (...names) => {
    for (const name of names) {
      const value = params.get(name);
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  };

  const clickIds = [];
  for (const name of CLICK_ID_PARAMS) {
    const value = params.get(name);
    if (typeof value === 'string' && value.trim()) clickIds.push(name);
  }

  return {
    source: cleanValue(pick('utm_source', 'ref', 'source')),
    medium: cleanValue(pick('utm_medium', 'medium'), true),
    campaign: cleanValue(pick('utm_campaign', 'campaign')),
    content: cleanValue(pick('utm_content', 'content')),
    term: cleanValue(pick('utm_term', 'term')),
    clickIds,
  };
}

/**
 * Classify a visit into a channel, a display source and a cleaned referrer.
 *
 * @param {object} input
 * @param {string} input.referrer   raw document.referrer (may be '')
 * @param {string} input.siteHost   the tracked site's own hostname, e.g. 'example.com'
 * @param {object} input.utm        { source, medium, campaign, content, term, clickIds } — may be empty
 * @returns {{ channel: string, source: string, referrer: string }}
 */
export function classifyReferrer(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const siteHost = hostFromLoose(opts.siteHost);
  const utm = normalizeUtm(opts.utm);
  const parsed = parseReferrer(opts.referrer);

  // Rule 2 (applied early so it also clears the stored referrer): a referrer on
  // our own registrable domain is internal navigation, not an acquisition.
  const internal = parsed.ok && isSameSite(parsed.host, siteHost);
  const external = parsed.ok && !internal ? parsed : null;
  const refString = external ? external.clean : '';
  const refInfo = external ? classifyHost(external.host) : null;
  // The host fallback is attacker-controlled (it comes from document.referrer),
  // so it goes through the same MAX_FIELD cap as every other stored field.
  const refSource = external ? (refInfo ? refInfo.source : cleanValue(external.host)) : '';

  // Rule 1: campaign parameters and click ids win over document.referrer.
  const srcInfo = utm.source ? classifySource(utm.source) : null;
  const clickInfo = clickIdInfo(utm.clickIds);

  if (utm.source || utm.medium || clickInfo) {
    const type = srcInfo?.type || clickInfo?.type || refInfo?.type || '';
    const source =
      srcInfo?.source ||
      (utm.source ? cleanValue(utm.source) : '') ||
      clickInfo?.source ||
      refSource ||
      'Direct';

    const channel =
      channelFromMedium(utm.medium, type) ||
      clickInfo?.channel ||
      srcInfo?.channel ||
      refInfo?.channel ||
      (external ? 'Referral' : '') ||
      // A source with no medium is a referral we simply cannot name; a medium we
      // do not understand with nothing else to go on is genuinely unclassified.
      (utm.medium ? 'Unknown' : 'Referral');

    return { channel, source, referrer: refString };
  }

  // Rule 4: nothing at all — or an internal referrer — is Direct. A referrer we
  // received but could not parse is neither direct nor a usable referral.
  if (!external) {
    if (!parsed.ok && !parsed.empty) return { channel: 'Unknown', source: 'Unknown', referrer: '' };
    return { channel: 'Direct', source: 'Direct', referrer: '' };
  }

  // Rule 3: classify by referrer host, anything unknown is a plain referral.
  return {
    channel: refInfo ? refInfo.channel : 'Referral',
    source: refSource,
    referrer: refString,
  };
}
