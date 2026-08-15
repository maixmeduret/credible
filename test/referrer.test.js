/**
 * Tests for acquisition-channel classification and bot detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReferrer,
  classifyHost,
  extractCampaign,
  registrableDomain,
  CHANNELS,
  CLICK_ID_PARAMS,
  SEARCH_ENGINES,
  SOCIAL_NETWORKS,
  VIDEO_PLATFORMS,
  SHOPPING_SITES,
  EMAIL_CLIENTS,
  AI_ASSISTANTS,
} from '../src/ingest/referrer.js';

import { isBot, BOT_PATTERNS } from '../src/ingest/bots.js';

/** Shorthand: classify a referrer for the site 'example.com'. */
const classify = (referrer, utm = {}) =>
  classifyReferrer({ referrer, siteHost: 'example.com', utm });

test('direct traffic', () => {
  assert.deepEqual(classify(''), { channel: 'Direct', source: 'Direct', referrer: '' });
  assert.deepEqual(classify(undefined), { channel: 'Direct', source: 'Direct', referrer: '' });
  assert.deepEqual(classifyReferrer({}), { channel: 'Direct', source: 'Direct', referrer: '' });
  assert.deepEqual(classifyReferrer(), { channel: 'Direct', source: 'Direct', referrer: '' });
  assert.equal(classify('   ').channel, 'Direct');
});

test('same site and subdomains count as direct, not referral', () => {
  assert.deepEqual(classify('https://example.com/pricing'), {
    channel: 'Direct',
    source: 'Direct',
    referrer: '',
  });
  assert.deepEqual(classify('https://www.example.com/pricing'), {
    channel: 'Direct',
    source: 'Direct',
    referrer: '',
  });
  // A subdomain of the tracked host is still the same site.
  assert.equal(classify('https://blog.example.com/post-1').channel, 'Direct');
  // …and so is the parent when the tracked host is itself a subdomain.
  assert.equal(
    classifyReferrer({
      referrer: 'https://example.com/',
      siteHost: 'blog.example.com',
      utm: {},
    }).channel,
    'Direct',
  );
  // Sibling subdomains share the registrable domain.
  assert.equal(
    classifyReferrer({
      referrer: 'https://shop.example.com/x',
      siteHost: 'blog.example.com',
      utm: {},
    }).channel,
    'Direct',
  );
  // A different registrable domain is not the same site.
  assert.equal(classify('https://example.org/').channel, 'Referral');
});

test('organic search', () => {
  const google = classify('https://www.google.com/search?q=privacy+analytics');
  assert.equal(google.channel, 'Organic Search');
  assert.equal(google.source, 'Google');
  assert.equal(google.referrer, 'google.com/search');

  assert.deepEqual(classify('https://www.google.co.uk/'), {
    channel: 'Organic Search',
    source: 'Google',
    referrer: 'google.co.uk',
  });
  assert.equal(classify('https://yandex.com.tr/search/?text=a').source, 'Yandex');
  assert.equal(classify('https://yandex.com.tr/search/?text=a').channel, 'Organic Search');
  assert.equal(classify('https://duckduckgo.com/').source, 'DuckDuckGo');
  assert.equal(classify('https://www.bing.com/search?q=a').source, 'Bing');
  assert.equal(classify('https://search.marginalia.nu/').source, 'Marginalia');
  assert.equal(classify('https://www.baidu.com/s?wd=a').source, 'Baidu');
  assert.equal(classify('https://search.brave.com/search?q=a').channel, 'Organic Search');
});

test('lookalike hosts cannot impersonate a search engine', () => {
  const spoof = classify('https://google.com.evil.example/landing');
  assert.equal(spoof.channel, 'Referral');
  assert.equal(spoof.source, 'google.com.evil.example');
});

test('AI assistants are organic search with their own name', () => {
  assert.equal(classify('https://chatgpt.com/').channel, 'Organic Search');
  assert.equal(classify('https://chatgpt.com/').source, 'ChatGPT');
  assert.equal(classify('https://chat.openai.com/c/abc').source, 'ChatGPT');
  assert.equal(classify('https://www.perplexity.ai/search/abc').source, 'Perplexity');
  assert.equal(classify('https://www.perplexity.ai/search/abc').referrer, 'perplexity.ai/search/abc');
  assert.equal(classify('https://claude.ai/chat/1').source, 'Claude');
  // Beats the generic 'google.' prefix rule.
  assert.equal(classify('https://gemini.google.com/app').source, 'Gemini');
  assert.equal(classify('https://copilot.microsoft.com/').source, 'Microsoft Copilot');
});

test('organic social', () => {
  const hn = classify('https://news.ycombinator.com/item?id=123456');
  assert.equal(hn.channel, 'Organic Social');
  assert.equal(hn.source, 'Hacker News');
  assert.equal(hn.referrer, 'news.ycombinator.com/item');

  assert.equal(classify('https://t.co/abc123').source, 'X (Twitter)');
  assert.equal(classify('https://x.com/someone/status/1').source, 'X (Twitter)');
  assert.equal(classify('https://l.facebook.com/l.php?u=x').source, 'Facebook');
  assert.equal(classify('https://www.linkedin.com/feed/').source, 'LinkedIn');
  assert.equal(classify('https://old.reddit.com/r/selfhosted/').source, 'Reddit');
  assert.equal(classify('https://old.reddit.com/r/selfhosted/').channel, 'Organic Social');
  assert.equal(classify('https://bsky.app/profile/a').source, 'Bluesky');
});

test('organic video', () => {
  assert.equal(classify('https://www.youtube.com/watch?v=abc').channel, 'Organic Video');
  assert.equal(classify('https://www.youtube.com/watch?v=abc').source, 'YouTube');
  assert.equal(classify('https://youtu.be/abc').source, 'YouTube');
  assert.equal(classify('https://www.twitch.tv/someone').channel, 'Organic Video');
  assert.equal(classify('https://vimeo.com/12345').source, 'Vimeo');
});

test('organic shopping', () => {
  assert.equal(classify('https://www.amazon.de/dp/B00').channel, 'Organic Shopping');
  assert.equal(classify('https://www.amazon.de/dp/B00').source, 'Amazon');
  assert.equal(classify('https://www.etsy.com/listing/1').source, 'Etsy');
  assert.equal(classify('https://www.ebay.co.uk/itm/1').channel, 'Organic Shopping');
});

test('email clients', () => {
  assert.equal(classify('https://mail.google.com/mail/u/0/').channel, 'Email');
  assert.equal(classify('https://mail.google.com/mail/u/0/').source, 'Gmail');
  assert.equal(classify('https://outlook.live.com/mail/0/inbox').source, 'Outlook');
  assert.equal(classify('https://mail.yahoo.com/d/folders/1').source, 'Yahoo! Mail');
  assert.equal(classify('https://superhuman.com/').channel, 'Email');
  // Parent-host fallback: any Mailchimp campaign subdomain.
  assert.equal(classify('https://us17.list-manage.com/track/click').source, 'Mailchimp');
});

test('unknown hosts fall back to a plain referral', () => {
  assert.deepEqual(classify('https://blog.acme.io/posts/hello?utm=1#top'), {
    channel: 'Referral',
    source: 'blog.acme.io',
    referrer: 'blog.acme.io/posts/hello',
  });
  // Known name, still a referral channel.
  assert.deepEqual(classify('https://github.com/credible/credible'), {
    channel: 'Referral',
    source: 'GitHub',
    referrer: 'github.com/credible/credible',
  });
  assert.equal(classify('http://192.168.1.20:3000/dash').channel, 'Referral');
});

test('referrer cleaning strips scheme, www, query and trailing slash', () => {
  assert.equal(classify('https://www.acme.io/').referrer, 'acme.io');
  assert.equal(classify('http://acme.io').referrer, 'acme.io');
  assert.equal(classify('https://ACME.io/Path/').referrer, 'acme.io/Path');
  assert.equal(classify('https://acme.io/a/b?c=d#e').referrer, 'acme.io/a/b');
});

test('malformed referrers never throw', () => {
  assert.deepEqual(classify('://'), { channel: 'Unknown', source: 'Unknown', referrer: '' });
  assert.deepEqual(classify('not a url'), { channel: 'Unknown', source: 'Unknown', referrer: '' });
  assert.equal(classify('javascript:void(0)').channel, 'Unknown');
  assert.equal(classify('localhost-only').channel, 'Unknown');
  assert.equal(classify(42).channel, 'Direct');
  // A malformed referrer still yields to campaign parameters.
  assert.equal(classify('not a url', { source: 'newsletter', medium: 'email' }).channel, 'Email');
});

test('native app referrers map onto their web host', () => {
  assert.deepEqual(classify('android-app://com.google.android.gm'), {
    channel: 'Email',
    source: 'Gmail',
    referrer: 'mail.google.com',
  });
  assert.equal(classify('android-app://com.twitter.android').source, 'X (Twitter)');
  assert.equal(classify('android-app://com.twitter.android').channel, 'Organic Social');
  assert.deepEqual(classify('android-app://com.example.app'), {
    channel: 'Referral',
    source: 'com.example.app',
    referrer: 'com.example.app',
  });
});

test('utm parameters win over document.referrer', () => {
  const r = classify('https://www.google.com/', { source: 'newsletter', medium: 'email' });
  assert.equal(r.channel, 'Email');
  assert.equal(r.source, 'Newsletter');
  // The raw referrer is still recorded for the referrers report.
  assert.equal(r.referrer, 'google.com');
});

test('paid search and paid social from utm_medium', () => {
  assert.deepEqual(classify('', { source: 'google', medium: 'cpc' }), {
    channel: 'Paid Search',
    source: 'Google',
    referrer: '',
  });
  assert.equal(classify('', { source: 'bing', medium: 'ppc' }).channel, 'Paid Search');
  assert.equal(classify('', { source: 'google', medium: 'paidsearch' }).channel, 'Paid Search');
  const paidSocial = classify('https://l.facebook.com/', { source: 'facebook', medium: 'cpc' });
  assert.equal(paidSocial.channel, 'Paid Social');
  assert.equal(paidSocial.source, 'Facebook');
  assert.equal(classify('', { source: 'linkedin', medium: 'paid-social' }).channel, 'Paid Social');
  assert.equal(classify('', { source: 'amazon', medium: 'cpc' }).channel, 'Paid Shopping');
});

test('every other utm_medium keyword', () => {
  assert.equal(classify('', { source: 'partner', medium: 'affiliate' }).channel, 'Affiliates');
  assert.equal(classify('', { source: 'acme', medium: 'display' }).channel, 'Display');
  assert.equal(classify('', { source: 'acme', medium: 'banner' }).channel, 'Display');
  assert.equal(classify('', { source: 'acme', medium: 'cpm' }).channel, 'Display');
  assert.equal(classify('', { source: 'twilio', medium: 'sms' }).channel, 'SMS');
  assert.equal(classify('', { source: 'acme', medium: 'e-mail' }).channel, 'Email');
  assert.equal(classify('', { source: 'acme', medium: 'newsletter' }).channel, 'Email');
  assert.equal(classify('', { source: 'acme', medium: 'social' }).channel, 'Organic Social');
  assert.equal(classify('', { source: 'acme', medium: 'social_media' }).channel, 'Organic Social');
  assert.equal(classify('', { source: 'acme', medium: 'social-network' }).channel, 'Organic Social');
  assert.equal(classify('', { source: 'acme', medium: 'referral' }).channel, 'Referral');
  assert.equal(classify('', { source: 'syntax.fm', medium: 'podcast' }).channel, 'Audio');
  assert.equal(classify('', { source: 'google', medium: 'organic' }).channel, 'Organic Search');
});

test('utm_source without a usable medium', () => {
  // Unknown source, no medium: a referral we cannot name any better.
  assert.deepEqual(classify('', { source: 'Partner XYZ' }), {
    channel: 'Referral',
    source: 'Partner XYZ',
    referrer: '',
  });
  // Known source alias still classifies on its own.
  assert.equal(classify('', { source: 'hn' }).source, 'Hacker News');
  assert.equal(classify('', { source: 'hn' }).channel, 'Organic Social');
  assert.equal(classify('', { source: 'news.ycombinator.com' }).source, 'Hacker News');
  // Nothing recognisable anywhere: genuinely unclassified.
  assert.deepEqual(classify('', { source: 'partner', medium: 'qrcode' }), {
    channel: 'Unknown',
    source: 'partner',
    referrer: '',
  });
});

test('advertising click ids', () => {
  assert.deepEqual(classify('', { clickIds: ['gclid'] }), {
    channel: 'Paid Search',
    source: 'Google',
    referrer: '',
  });
  assert.equal(classify('', { clickIds: ['gbraid'] }).channel, 'Paid Search');
  assert.equal(classify('', { clickIds: ['wbraid'] }).channel, 'Paid Search');
  assert.deepEqual(classify('', { clickIds: ['msclkid'] }), {
    channel: 'Paid Search',
    source: 'Bing',
    referrer: '',
  });
  assert.equal(classify('', { clickIds: ['dclid'] }).channel, 'Display');
  assert.equal(classify('', { clickIds: ['irclickid'] }).channel, 'Affiliates');

  // fbclid alone only proves the visit came from Facebook — it is appended to
  // organic shares too, so it stays organic unless utm_medium says otherwise.
  const organic = classify('https://m.facebook.com/', { clickIds: ['fbclid'] });
  assert.equal(organic.channel, 'Organic Social');
  assert.equal(organic.source, 'Facebook');
  const paid = classify('https://m.facebook.com/', { medium: 'paid-social', clickIds: ['fbclid'] });
  assert.equal(paid.channel, 'Paid Social');

  // A click id with an explicit referrer keeps the referrer for reporting.
  assert.equal(classify('https://www.google.com/', { clickIds: ['gclid'] }).referrer, 'google.com');
  // utm.clickIds may be absent entirely.
  assert.equal(classify('https://www.google.com/', { source: '', medium: '' }).channel, 'Organic Search');
});

test('extractCampaign accepts URLs, query strings and URLSearchParams', () => {
  const full = extractCampaign(
    'https://example.com/pricing?utm_source=Google&utm_medium=CPC&utm_campaign=Launch&utm_content=hero&utm_term=analytics&gclid=abc123#anchor',
  );
  assert.deepEqual(full, {
    source: 'Google',
    medium: 'cpc',
    campaign: 'Launch',
    content: 'hero',
    term: 'analytics',
    clickIds: ['gclid'],
  });

  assert.equal(extractCampaign('utm_source=x&utm_medium=Email').medium, 'email');
  assert.equal(extractCampaign('?utm_source=x').source, 'x');
  assert.equal(extractCampaign(new URL('https://a.io/?utm_source=hn')).source, 'hn');
  assert.equal(extractCampaign(new URLSearchParams('utm_source=hn&fbclid=z')).source, 'hn');
  assert.deepEqual(extractCampaign(new URLSearchParams('fbclid=z&ttclid=y')).clickIds, ['fbclid', 'ttclid']);

  // Short aliases.
  assert.equal(extractCampaign('https://a.io/?ref=producthunt').source, 'producthunt');
  assert.equal(extractCampaign('https://a.io/?source=partner').source, 'partner');
  // utm_source wins over the aliases.
  assert.equal(extractCampaign('https://a.io/?ref=a&utm_source=b').source, 'b');

  // Empty click id values do not count.
  assert.deepEqual(extractCampaign('https://a.io/?gclid=').clickIds, []);
  // Values are trimmed and capped.
  assert.equal(extractCampaign(`?utm_campaign=${'z'.repeat(400)}`).campaign.length, 255);
  assert.equal(extractCampaign('?utm_source=%20spaced%20').source, 'spaced');
});

test('extractCampaign never throws on junk input', () => {
  const empty = { source: '', medium: '', campaign: '', content: '', term: '', clickIds: [] };
  assert.deepEqual(extractCampaign(''), empty);
  assert.deepEqual(extractCampaign(null), empty);
  assert.deepEqual(extractCampaign(undefined), empty);
  assert.deepEqual(extractCampaign(42), empty);
  assert.deepEqual(extractCampaign({}), empty);
  assert.deepEqual(extractCampaign('://???'), empty);
  assert.deepEqual(extractCampaign('https://a.io/no-query'), empty);
});

test('extractCampaign output feeds classifyReferrer directly', () => {
  const utm = extractCampaign('https://example.com/?utm_source=twitter&utm_medium=social');
  assert.deepEqual(classifyReferrer({ referrer: '', siteHost: 'example.com', utm }), {
    channel: 'Organic Social',
    source: 'X (Twitter)',
    referrer: '',
  });
});

test('exported maps and helpers', () => {
  const maps = [SEARCH_ENGINES, SOCIAL_NETWORKS, VIDEO_PLATFORMS, SHOPPING_SITES, EMAIL_CLIENTS, AI_ASSISTANTS];
  const total = maps.reduce((n, m) => n + Object.keys(m).length, 0);
  assert.ok(total >= 120, `expected at least 120 known hosts, got ${total}`);
  for (const map of maps) {
    for (const [host, name] of Object.entries(map)) {
      assert.equal(host, host.toLowerCase(), `${host} must be lowercase`);
      assert.ok(!host.startsWith('www.'), `${host} must not carry a www. prefix`);
      assert.ok(name.length > 0);
    }
  }
  assert.deepEqual(CLICK_ID_PARAMS, [
    'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'twclid',
    'li_fat_id', 'dclid', 'yclid', 'irclickid', 'epik', 'rdt_cid',
  ]);
  assert.equal(classifyHost('www.google.fr').source, 'Google');
  assert.equal(classifyHost('nope.invalid'), null);
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('every classification is a declared channel', () => {
  const samples = [
    ['', {}], ['https://example.com/x', {}], ['https://www.google.com/', {}],
    ['https://news.ycombinator.com/', {}], ['https://youtu.be/x', {}],
    ['https://amazon.fr/x', {}], ['https://mail.google.com/', {}],
    ['https://blog.acme.io/', {}], ['not a url', {}],
    ['', { source: 'g', medium: 'cpc' }], ['', { source: 'a', medium: 'affiliate' }],
    ['', { source: 'a', medium: 'sms' }], ['', { source: 'a', medium: 'podcast' }],
    ['', { source: 'a', medium: 'banner' }], ['', { source: 'a', medium: 'weird' }],
    ['', { clickIds: ['gclid'] }],
  ];
  for (const [ref, utm] of samples) {
    const out = classify(ref, utm);
    assert.ok(CHANNELS.includes(out.channel), `unexpected channel ${out.channel}`);
    assert.equal(typeof out.source, 'string');
    assert.equal(typeof out.referrer, 'string');
    assert.ok(!out.referrer.startsWith('http'), 'referrer must not keep its scheme');
  }
});

/* ------------------------------------------------------------------ *
 * Bot detection                                                       *
 * ------------------------------------------------------------------ */

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const CUBOT = 'Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36';

test('real browsers are not bots', () => {
  for (const ua of [CHROME, IPHONE, FIREFOX, ANDROID, CUBOT]) {
    assert.equal(isBot(ua), false, ua);
  }
  assert.equal(
    isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'),
    false,
  );
  assert.equal(isBot('Opera/9.80 (Windows NT 6.0) Presto/2.12.388 Version/12.14'), false);
});

test('missing or empty user agents are treated as bots', () => {
  assert.equal(isBot(''), true);
  assert.equal(isBot('   '), true);
  assert.equal(isBot(undefined), true);
  assert.equal(isBot(null), true);
  assert.equal(isBot(123), true);
});

test('crawlers, monitors and preview fetchers are bots', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0)',
    'Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1)',
    'Mozilla/5.0 (compatible; Yahoo! Slurp)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    'Mozilla/5.0 (compatible; Bytespider)',
    'Mozilla/5.0 (compatible; Amazonbot/0.1)',
    'Mozilla/5.0 (Device; Mac OS X) AppleWebKit/600 (KHTML, like Gecko) Version/9.0 Safari/600 Applebot/0.1',
    'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
    'Screaming Frog SEO Spider/19.2',
    'Mozilla/5.0 (compatible; MJ12bot/v1.4.8)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Chrome-Lighthouse',
    'PhantomJS/2.1.1',
    'Mozilla/5.0 (Linux; Android 6.0) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36 Puppeteer',
    'Mozilla/5.0 (Windows NT 10.0) Playwright/1.44',
    'Pingdom.com_bot_version_1.4',
    'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'Site24x7',
    'Datadog/Synthetics',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Embedly/0.2)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
    'Mozilla/5.0 (compatible; SkypeUriPreview Preview/0.5)',
    'curl/8.4.0',
    'Wget/1.21.4',
    'python-requests/2.32.3',
    'axios/1.7.2',
    'Go-http-client/2.0',
    'Java/17.0.9',
    'okhttp/4.12.0',
    'PostmanRuntime/7.39.0',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'Scrapy/2.11 (+https://scrapy.org)',
    'Mozilla/5.0 (compatible; CCBot/2.0; https://commoncrawl.org/faq/)',
    'Mozilla/5.0 (compatible; monitoring360bot/1.1)',
    'Feedly/1.0 (+http://www.feedly.com/fetcher.html)',
  ];
  for (const ua of bots) assert.equal(isBot(ua), true, ua);
});

test('unrecognised non-browser strings are rejected', () => {
  assert.equal(isBot('x'), true);
  assert.equal(isBot('MyInternalScript 1.0'), true);
  assert.equal(isBot('-'), true);
});

test('isBot is stable across repeated calls (cache)', () => {
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot('curl/8.4.0'), true);
  assert.equal(isBot('curl/8.4.0'), true);
});

test('every stored field is capped at 255 chars', () => {
  const huge = 'x'.repeat(5000);

  // A hostile document.referrer must not widen the source column.
  const fromHost = classifyReferrer({
    referrer: `https://${huge}.com/${huge}`,
    siteHost: 'example.com',
    utm: {},
  });
  assert.ok(fromHost.source.length <= 255, `source was ${fromHost.source.length}`);
  assert.ok(fromHost.referrer.length <= 255, `referrer was ${fromHost.referrer.length}`);

  // …nor may an unrecognised utm_source.
  const fromUtm = classifyReferrer({
    referrer: '',
    siteHost: 'example.com',
    utm: { source: huge, medium: 'cpc' },
  });
  assert.ok(fromUtm.source.length <= 255, `source was ${fromUtm.source.length}`);

  const campaign = extractCampaign(`?utm_source=${huge}&utm_campaign=${huge}&utm_term=${huge}`);
  for (const [field, value] of Object.entries(campaign)) {
    if (typeof value === 'string') assert.ok(value.length <= 255, `${field} was ${value.length}`);
  }
});

test('BOT_PATTERNS is a non-empty list of strings and regexes', () => {
  assert.ok(Array.isArray(BOT_PATTERNS));
  assert.ok(BOT_PATTERNS.length > 50);
  for (const pattern of BOT_PATTERNS) {
    const ok = typeof pattern === 'string' ? pattern === pattern.toLowerCase() : pattern instanceof RegExp;
    assert.ok(ok, `invalid pattern: ${pattern}`);
  }
});
