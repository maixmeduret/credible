/**
 * Tests for acquisition-channel classification and bot detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReferrer,
  classifyHost,
  channelOf,
  extractCampaign,
  registrableDomain,
  CHANNELS,
  CLICK_ID_PARAMS,
  SEARCH_ENGINES,
  SOCIAL_NETWORKS,
  VIDEO_PLATFORMS,
  AUDIO_PLATFORMS,
  SHOPPING_SITES,
  EMAIL_CLIENTS,
  AI_ASSISTANTS,
  KNOWN_REFERRERS,
  APP_PACKAGE_HOSTS,
  IOS_APP_HOSTS,
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

// Until August 2026 these landed in 'Organic Search'. They now have their own
// channel: an answer-engine visit behaves nothing like a search-results visit,
// and merging the two hid the fastest-growing acquisition source there is.
test('AI assistants are their own channel, with their own name', () => {
  assert.equal(classify('https://chatgpt.com/').channel, 'AI Assistants');
  assert.equal(classify('https://chatgpt.com/').source, 'ChatGPT');
  assert.equal(classify('https://chat.openai.com/c/abc').source, 'ChatGPT');
  assert.equal(classify('https://www.perplexity.ai/search/abc').source, 'Perplexity');
  assert.equal(classify('https://www.perplexity.ai/search/abc').referrer, 'perplexity.ai/search/abc');
  assert.equal(classify('https://claude.ai/chat/1').source, 'Claude');
  // Beats the generic 'google.' prefix rule.
  assert.equal(classify('https://gemini.google.com/app').source, 'Gemini');
  assert.equal(classify('https://gemini.google.com/app').channel, 'AI Assistants');
  assert.equal(classify('https://copilot.microsoft.com/').source, 'Microsoft Copilot');
  // Search engines are untouched by the split.
  assert.equal(classify('https://www.google.com/search?q=a').channel, 'Organic Search');
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
  // The original thirteen click ids keep their identity *and* their position:
  // `clickIdInfo` returns the first match, so reordering reclassifies traffic.
  // Appending is safe, which is why this is a prefix check and not deepEqual.
  assert.deepEqual(CLICK_ID_PARAMS.slice(0, 13), [
    'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'twclid',
    'li_fat_id', 'dclid', 'yclid', 'irclickid', 'epik', 'rdt_cid',
  ]);
  assert.equal(new Set(CLICK_ID_PARAMS).size, CLICK_ID_PARAMS.length, 'click ids must be unique');
  for (const id of CLICK_ID_PARAMS) assert.equal(id, id.toLowerCase(), `${id} must be lowercase`);

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
 * The GA4-aligned channels added in the August 2026 expansion         *
 * ------------------------------------------------------------------ */

test('paid video is split out of paid social', () => {
  assert.deepEqual(classify('', { source: 'youtube', medium: 'cpc' }), {
    channel: 'Paid Video',
    source: 'YouTube',
    referrer: '',
  });
  assert.equal(classify('', { source: 'youtube', medium: 'cpv' }).channel, 'Paid Video');
  assert.equal(classify('', { source: 'twitch', medium: 'ppc' }).channel, 'Paid Video');
  assert.equal(classify('', { source: 'acme', medium: 'paid-video' }).channel, 'Paid Video');
  // Video mediums stay organic without a paid marker.
  assert.equal(classify('', { source: 'youtube', medium: 'video' }).channel, 'Organic Video');
});

test('paid other catches paid traffic from a source we cannot categorise', () => {
  // GA4 requires a *search* source for Paid Search; an unknown source with a
  // paid medium is Paid Other, not a guess at search.
  assert.deepEqual(classify('', { source: 'partnerblog', medium: 'cpc' }), {
    channel: 'Paid Other',
    source: 'partnerblog',
    referrer: '',
  });
  assert.equal(classify('', { source: 'acme', medium: 'retargeting' }).channel, 'Paid Other');
  assert.equal(classify('', { source: 'acme', medium: 'paid' }).channel, 'Paid Other');
  assert.equal(classify('', { clickIds: ['ef_id'] }).channel, 'Paid Other');
  // There is no Paid AI or Paid Audio channel anywhere, so both land here.
  assert.equal(classify('', { source: 'chatgpt', medium: 'cpc' }).channel, 'Paid Other');
  assert.equal(classify('', { source: 'spotify', medium: 'cpc' }).channel, 'Paid Other');
});

test('cross-network is read off the campaign name, GA4 style', () => {
  assert.equal(classify('', { campaign: 'cross-network' }).channel, 'Cross-network');
  assert.equal(classify('', { source: 'google', medium: 'cross-network' }).channel, 'Cross-network');
  const pmax = classify('', { source: 'google', medium: 'cpc', campaign: 'PMax-Brand-FR' });
  assert.equal(pmax.channel, 'Cross-network');
  assert.equal(pmax.source, 'Google');
  assert.equal(classify('', { campaign: 'Performance Max retail' }).channel, 'Cross-network');
  // Smart Shopping is cross-network, not shopping: the cross-network test runs first.
  assert.equal(classify('', { source: 'google', medium: 'cpc', campaign: 'smart shopping' }).channel, 'Cross-network');
  // A campaign name we do not recognise must not open the campaign branch at all.
  assert.equal(classify('https://news.ycombinator.com/', { campaign: 'launch' }).channel, 'Organic Social');
  assert.equal(classify('', { campaign: 'launch' }).channel, 'Direct');
});

test('shopping campaign names classify as shopping, GA4 regex verbatim', () => {
  assert.equal(classify('', { campaign: 'eshop-launch' }).channel, 'Organic Shopping');
  assert.equal(classify('', { campaign: 'summer shopping' }).channel, 'Organic Shopping');
  assert.equal(classify('', { source: 'google', medium: 'cpc', campaign: 'summer-shop' }).channel, 'Paid Shopping');
  // '([^a-df-z]|^)shop' deliberately excludes 'workshop' but allows 'eshop'.
  assert.equal(classify('', { campaign: 'workshop-2026' }).channel, 'Direct');
  assert.equal(classify('https://blog.acme.io/', { campaign: 'workshop-2026' }).channel, 'Referral');
});

test('display, audio, sms and mobile push', () => {
  assert.equal(classify('', { clickIds: ['dclid'] }).source, 'Google Display Network');
  assert.equal(classify('', { clickIds: ['dicbo'] }).source, 'Outbrain');
  assert.equal(classify('', { clickIds: ['tblci'] }).source, 'Taboola');
  assert.equal(classify('', { clickIds: ['dicbo'] }).channel, 'Display');
  assert.equal(classify('', { source: 'acme', medium: 'paid-display' }).channel, 'Display');

  assert.equal(classify('https://open.spotify.com/episode/1').channel, 'Audio');
  assert.equal(classify('https://open.spotify.com/episode/1').source, 'Spotify');
  assert.equal(classify('https://podcasts.apple.com/us/podcast/x').source, 'Apple Podcasts');
  assert.equal(classify('https://overcast.fm/+abc').channel, 'Audio');
  assert.equal(classify('', { source: 'acme', medium: 'radio' }).channel, 'Audio');

  assert.deepEqual(classify('', { source: 'sms' }), { channel: 'SMS', source: 'SMS', referrer: '' });
  assert.equal(classify('', { source: 'attentive' }).channel, 'SMS');
  assert.equal(classify('', { source: 'acme', medium: 'mms' }).channel, 'SMS');

  assert.deepEqual(classify('', { source: 'firebase' }), {
    channel: 'Mobile Push Notifications',
    source: 'Firebase',
    referrer: '',
  });
  assert.equal(classify('', { source: 'acme', medium: 'push' }).channel, 'Mobile Push Notifications');
  assert.equal(classify('', { source: 'acme', medium: 'web-push' }).channel, 'Mobile Push Notifications');
  assert.equal(classify('', { source: 'acme', medium: 'notification' }).channel, 'Mobile Push Notifications');
  assert.equal(classify('', { source: 'acme', medium: 'mobile' }).channel, 'Mobile Push Notifications');
  // Deliberate divergence from GA4, which would call this a push notification.
  assert.equal(classify('', { source: 'acme', medium: 'mobile-web' }).channel, 'Unknown');
  // …and an ad buy on mobile is an ad buy.
  assert.equal(classify('', { source: 'google', medium: 'mobile-cpc' }).channel, 'Paid Search');
});

test('ai-assistant medium reaches the channel without a known host', () => {
  assert.equal(classify('', { source: 'acme', medium: 'ai-assistant' }).channel, 'AI Assistants');
  assert.equal(classify('', { source: 'acme', medium: 'ai_assistant' }).channel, 'AI Assistants');
  assert.equal(classify('', { source: 'acme', medium: 'llm' }).channel, 'AI Assistants');
  assert.equal(classify('', { source: 'chatgpt', medium: 'referral' }).channel, 'Referral');
  assert.equal(classify('', { source: 'chatgpt', medium: 'organic' }).channel, 'AI Assistants');
});

test('paid sources spelled with an ad suffix', () => {
  assert.deepEqual(classify('', { source: 'facebook-ads' }), {
    channel: 'Paid Social',
    source: 'Facebook',
    referrer: '',
  });
  assert.equal(classify('', { source: 'linkedin_ads' }).channel, 'Paid Social');
  assert.equal(classify('', { source: 'google ads' }).channel, 'Paid Search');
  assert.equal(classify('', { source: 'youtube-ads' }).channel, 'Paid Video');
  assert.equal(classify('', { source: 'amazon-ads' }).channel, 'Paid Shopping');
  // The suffix only counts when what is left resolves to a source we know.
  assert.deepEqual(classify('', { source: 'nomads' }), {
    channel: 'Referral',
    source: 'nomads',
    referrer: '',
  });
  assert.equal(classify('', { source: 'xads' }).source, 'xads');
});

test('the new click ids, including the three that are not proof of payment', () => {
  assert.deepEqual(classify('', { clickIds: ['sccid'] }), {
    channel: 'Paid Social',
    source: 'Snapchat',
    referrer: '',
  });
  assert.equal(classify('', { clickIds: ['s_kwcid'] }).channel, 'Paid Search');
  assert.equal(classify('', { clickIds: ['awc'] }).source, 'Awin');
  assert.equal(classify('', { clickIds: ['cjevent'] }).source, 'CJ Affiliate');
  assert.equal(classify('', { clickIds: ['ranmid'] }).source, 'Rakuten Advertising');
  assert.equal(classify('', { clickIds: ['mc_cid'] }).channel, 'Email');
  assert.equal(classify('', { clickIds: ['mkt_tok'] }).source, 'Marketo');

  // igshid is Instagram's share link, appended to organic shares.
  assert.deepEqual(classify('', { clickIds: ['igshid'] }), {
    channel: 'Organic Social',
    source: 'Instagram',
    referrer: '',
  });
  assert.equal(classify('', { medium: 'paid-social', clickIds: ['igshid'] }).channel, 'Paid Social');
  // srsltid is on free Merchant Center listings as well as Shopping ads.
  assert.equal(classify('', { clickIds: ['srsltid'] }).channel, 'Organic Shopping');
  assert.equal(classify('', { clickIds: ['srsltid'] }).source, 'Google Shopping');
  assert.equal(classify('', { medium: 'cpc', clickIds: ['srsltid'] }).channel, 'Paid Shopping');
});

test('click ids are matched case-insensitively', () => {
  // Snapchat ships 'ScCid' and Rakuten ships 'ranMID'; neither will change.
  assert.deepEqual(extractCampaign('https://a.io/?ScCid=xyz').clickIds, ['sccid']);
  assert.deepEqual(extractCampaign('https://a.io/?ranMID=42&ranEAID=1').clickIds, ['ranmid']);
  assert.deepEqual(extractCampaign('https://a.io/?GCLID=abc').clickIds, ['gclid']);
  assert.equal(extractCampaign('https://a.io/?UTM_Source=Bing&UTM_Medium=CPC').source, 'Bing');
  assert.equal(extractCampaign('https://a.io/?UTM_Source=Bing&UTM_Medium=CPC').medium, 'cpc');
  // Mixed-case click ids still drive the classification end to end.
  const utm = extractCampaign('https://example.com/?ScCid=xyz');
  assert.equal(classifyReferrer({ referrer: '', siteHost: 'example.com', utm }).source, 'Snapchat');
});

test('app referrers: embedded urls, ios store ids and unresolvable packages', () => {
  // Chrome on Android appends the real page after the package name.
  assert.deepEqual(classify('android-app://com.google.android.googlequicksearchbox/https/www.google.com/search'), {
    channel: 'Organic Search',
    source: 'Google',
    referrer: 'google.com/search',
  });
  assert.equal(
    classify('android-app://com.example.unknown/https/news.ycombinator.com/item').source,
    'Hacker News',
  );
  // iOS hands us an App Store id rather than a bundle identifier.
  assert.deepEqual(classify('ios-app://284882215'), {
    channel: 'Organic Social',
    source: 'Facebook',
    referrer: 'facebook.com',
  });
  assert.equal(classify('ios-app://422689480').source, 'Gmail');
  assert.equal(classify('ios-app://999999999').channel, 'Referral');
  assert.equal(classify('android-app://com.openai.chatgpt').channel, 'AI Assistants');
  assert.equal(classify('android-app://com.spotify.music').channel, 'Audio');

  // An unresolved package is a reverse-DNS string, never a hostname: it must
  // not be able to match a host table, and it must not look like our own site.
  assert.deepEqual(classify('android-app://com.example.app'), {
    channel: 'Referral',
    source: 'com.example.app',
    referrer: 'com.example.app',
  });
  assert.deepEqual(
    classifyReferrer({ referrer: 'android-app://com.evil.example.com', siteHost: 'example.com', utm: {} }),
    { channel: 'Referral', source: 'com.evil.example.com', referrer: 'com.evil.example.com' },
  );
  assert.equal(classify('android-app://com.foo.x.com').source, 'com.foo.x.com');
});

test('channelOf resolves a source name on its own', () => {
  assert.equal(channelOf('Google'), 'Organic Search');
  assert.equal(channelOf('ChatGPT'), 'AI Assistants');
  assert.equal(channelOf('Hacker News'), 'Organic Social');
  assert.equal(channelOf('YouTube'), 'Organic Video');
  assert.equal(channelOf('Spotify'), 'Audio');
  assert.equal(channelOf('Amazon'), 'Organic Shopping');
  assert.equal(channelOf('Gmail'), 'Email');
  assert.equal(channelOf('GitHub'), 'Referral');
  assert.equal(channelOf('Awin'), 'Affiliates');
  assert.equal(channelOf('Firebase'), 'Mobile Push Notifications');
  assert.equal(channelOf('Twilio'), 'SMS');
  assert.equal(channelOf('Direct'), 'Direct');
  assert.equal(channelOf('Unknown'), 'Unknown');
  // Hostnames and utm_source aliases work too.
  assert.equal(channelOf('news.ycombinator.com'), 'Organic Social');
  assert.equal(channelOf('hn'), 'Organic Social');
  assert.equal(channelOf('facebook-ads'), 'Paid Social');
  // Case-insensitive second chance for hand-typed names.
  assert.equal(channelOf('hacker news'), 'Organic Social');
  // Anything unknown is what classifyReferrer would have stored: a referral.
  assert.equal(channelOf('blog.acme.io'), 'Referral');
  assert.equal(channelOf('Partner XYZ'), 'Referral');
  // Empty means no source at all, which is Direct.
  assert.equal(channelOf(''), 'Direct');
  assert.equal(channelOf(null), 'Direct');
  assert.equal(channelOf(42), 'Direct');
  for (const name of ['Google', 'ChatGPT', 'blog.acme.io', '', 'Partner XYZ']) {
    assert.ok(CHANNELS.includes(channelOf(name)), `channelOf(${name}) left the taxonomy`);
  }
});

test('channelOf agrees with classifyReferrer for every host we know', () => {
  const tables = [
    SEARCH_ENGINES, SOCIAL_NETWORKS, VIDEO_PLATFORMS, AUDIO_PLATFORMS,
    SHOPPING_SITES, EMAIL_CLIENTS, AI_ASSISTANTS, KNOWN_REFERRERS,
  ];
  for (const table of tables) {
    for (const [host, name] of Object.entries(table)) {
      const out = classify(`https://${host}/some/path`);
      assert.equal(out.source, name, `${host} should be reported as ${name}`);
      assert.ok(CHANNELS.includes(out.channel), `${host} produced ${out.channel}`);
      assert.equal(channelOf(name), out.channel, `channelOf(${name}) disagrees for ${host}`);
    }
  }
});

test('the source database is broad and internally consistent', () => {
  const tables = {
    SEARCH_ENGINES, SOCIAL_NETWORKS, VIDEO_PLATFORMS, AUDIO_PLATFORMS,
    SHOPPING_SITES, EMAIL_CLIENTS, AI_ASSISTANTS, KNOWN_REFERRERS,
  };
  const seen = new Map();
  let total = 0;
  for (const [label, table] of Object.entries(tables)) {
    for (const [host, name] of Object.entries(table)) {
      total += 1;
      assert.equal(host, host.toLowerCase(), `${host} must be lowercase`);
      assert.ok(!host.startsWith('www.'), `${host} must not carry a www. prefix`);
      assert.ok(!host.includes('/'), `${host} must be a bare hostname`);
      assert.ok(typeof name === 'string' && name.trim().length > 0, `${host} needs a display name`);
      const other = seen.get(host);
      assert.equal(other, undefined, `${host} is in both ${other} and ${label}`);
      seen.set(host, label);
    }
  }
  assert.ok(total >= 400, `expected at least 400 known hosts, got ${total}`);

  // App tables point at hosts the classifier can actually resolve.
  for (const [pkg, host] of Object.entries(APP_PACKAGE_HOSTS)) {
    assert.equal(pkg, pkg.toLowerCase(), `${pkg} must be lowercase`);
    assert.ok(classifyHost(host), `${pkg} maps to unknown host ${host}`);
  }
  for (const [id, host] of Object.entries(IOS_APP_HOSTS)) {
    assert.match(id, /^\d+$/, `${id} must be a numeric App Store id`);
    assert.ok(classifyHost(host), `${id} maps to unknown host ${host}`);
  }
});

test('CHANNELS is the complete, unique, ordered taxonomy', () => {
  assert.equal(new Set(CHANNELS).size, CHANNELS.length, 'duplicate channel name');
  for (const required of [
    'Direct', 'Organic Search', 'Paid Search', 'Organic Social', 'Paid Social',
    'Organic Video', 'Paid Video', 'Organic Shopping', 'Paid Shopping',
    'Cross-network', 'Display', 'Paid Other', 'Email', 'Affiliates', 'Referral',
    'SMS', 'Mobile Push Notifications', 'Audio', 'AI Assistants', 'Unknown',
  ]) {
    assert.ok(CHANNELS.includes(required), `${required} is missing from CHANNELS`);
  }
  // 'Unknown' is our name for GA4's 'Unassigned' and must stay last.
  assert.equal(CHANNELS[CHANNELS.length - 1], 'Unknown');
});

/* ------------------------------------------------------------------ *
 * Table-driven sweep: one row per (referrer, utm) → channel rule we   *
 * claim to implement. Every channel in CHANNELS appears at least once.*
 * ------------------------------------------------------------------ */

/** Shorthand for a referrer-only row. */
const host = (h, channel) => [`https://${h}/x`, {}, channel];
/** Shorthand for a campaign-only row. */
const utmRow = (utm, channel) => ['', utm, channel];

const CASES = [
  // ── Direct ───────────────────────────────────────────────────────────
  ['', {}, 'Direct'],
  ['   ', {}, 'Direct'],
  [undefined, {}, 'Direct'],
  ['https://example.com/pricing', {}, 'Direct'],
  ['https://www.example.com/', {}, 'Direct'],
  ['https://blog.example.com/post', {}, 'Direct'],
  ['', { campaign: 'spring-2026' }, 'Direct'],

  // ── Organic Search: Google and its sub-properties ────────────────────
  host('google.com', 'Organic Search'),
  host('google.co.uk', 'Organic Search'),
  host('google.de', 'Organic Search'),
  host('google.com.br', 'Organic Search'),
  host('news.google.com', 'Organic Search'),
  host('scholar.google.com', 'Organic Search'),
  host('images.google.com', 'Organic Search'),
  host('maps.google.com', 'Organic Search'),
  host('books.google.com', 'Organic Search'),
  host('patents.google.com', 'Organic Search'),
  host('lens.google.com', 'Organic Search'),
  host('translate.google.com', 'Organic Search'),
  host('acme-io.translate.goog', 'Organic Search'),
  host('webcache.googleusercontent.com', 'Organic Search'),
  // ── Organic Search: everyone else ────────────────────────────────────
  host('bing.com', 'Organic Search'),
  host('cn.bing.com', 'Organic Search'),
  host('msn.com', 'Organic Search'),
  host('ntp.msn.com', 'Organic Search'),
  host('duckduckgo.com', 'Organic Search'),
  host('lite.duckduckgo.com', 'Organic Search'),
  host('duck.com', 'Organic Search'),
  host('search.brave.com', 'Organic Search'),
  host('startpage.com', 'Organic Search'),
  host('qwant.com', 'Organic Search'),
  host('ecosia.org', 'Organic Search'),
  host('kagi.com', 'Organic Search'),
  host('mojeek.com', 'Organic Search'),
  host('search.marginalia.nu', 'Organic Search'),
  host('searx.be', 'Organic Search'),
  host('searxng.world', 'Organic Search'),
  host('swisscows.com', 'Organic Search'),
  host('metager.de', 'Organic Search'),
  host('leta.mullvad.net', 'Organic Search'),
  host('presearch.com', 'Organic Search'),
  host('yahoo.com', 'Organic Search'),
  host('search.yahoo.com', 'Organic Search'),
  host('yahoo.co.jp', 'Organic Search'),
  host('ask.com', 'Organic Search'),
  host('aol.com', 'Organic Search'),
  host('lycos.com', 'Organic Search'),
  host('dogpile.com', 'Organic Search'),
  host('wolframalpha.com', 'Organic Search'),
  host('yandex.ru', 'Organic Search'),
  host('ya.ru', 'Organic Search'),
  host('yandex.com.tr', 'Organic Search'),
  host('go.mail.ru', 'Organic Search'),
  host('rambler.ru', 'Organic Search'),
  host('baidu.com', 'Organic Search'),
  host('sogou.com', 'Organic Search'),
  host('so.com', 'Organic Search'),
  host('sm.cn', 'Organic Search'),
  host('quark.sm.cn', 'Organic Search'),
  host('naver.com', 'Organic Search'),
  host('search.naver.com', 'Organic Search'),
  host('daum.net', 'Organic Search'),
  host('nate.com', 'Organic Search'),
  host('zum.com', 'Organic Search'),
  host('coccoc.com', 'Organic Search'),
  host('rediff.com', 'Organic Search'),
  host('petalsearch.com', 'Organic Search'),
  host('seznam.cz', 'Organic Search'),
  host('centrum.cz', 'Organic Search'),
  host('zoznam.sk', 'Organic Search'),
  host('onet.pl', 'Organic Search'),
  host('wp.pl', 'Organic Search'),
  host('interia.pl', 'Organic Search'),
  host('search.ch', 'Organic Search'),
  host('virgilio.it', 'Organic Search'),
  host('libero.it', 'Organic Search'),
  host('orange.fr', 'Organic Search'),
  host('uol.com.br', 'Organic Search'),
  host('goo.ne.jp', 'Organic Search'),
  host('biglobe.ne.jp', 'Organic Search'),
  host('search.rakuten.co.jp', 'Organic Search'),
  utmRow({ source: 'google', medium: 'organic' }, 'Organic Search'),
  utmRow({ source: 'ecosia' }, 'Organic Search'),

  // ── AI Assistants ────────────────────────────────────────────────────
  host('chatgpt.com', 'AI Assistants'),
  host('chat.openai.com', 'AI Assistants'),
  host('openai.com', 'AI Assistants'),
  host('perplexity.ai', 'AI Assistants'),
  host('pplx.ai', 'AI Assistants'),
  host('claude.ai', 'AI Assistants'),
  host('gemini.google.com', 'AI Assistants'),
  host('bard.google.com', 'AI Assistants'),
  host('aistudio.google.com', 'AI Assistants'),
  host('notebooklm.google.com', 'AI Assistants'),
  host('copilot.microsoft.com', 'AI Assistants'),
  host('m365.cloud.microsoft', 'AI Assistants'),
  host('meta.ai', 'AI Assistants'),
  host('grok.com', 'AI Assistants'),
  host('x.ai', 'AI Assistants'),
  host('duck.ai', 'AI Assistants'),
  host('poe.com', 'AI Assistants'),
  host('you.com', 'AI Assistants'),
  host('phind.com', 'AI Assistants'),
  host('chat.mistral.ai', 'AI Assistants'),
  host('chat.deepseek.com', 'AI Assistants'),
  host('qwen.ai', 'AI Assistants'),
  host('kimi.ai', 'AI Assistants'),
  host('doubao.com', 'AI Assistants'),
  host('yiyan.baidu.com', 'AI Assistants'),
  host('character.ai', 'AI Assistants'),
  host('openrouter.ai', 'AI Assistants'),
  host('lmarena.ai', 'AI Assistants'),
  host('genspark.ai', 'AI Assistants'),
  host('consensus.app', 'AI Assistants'),
  utmRow({ source: 'perplexity' }, 'AI Assistants'),
  utmRow({ source: 'acme', medium: 'ai-assistant' }, 'AI Assistants'),

  // ── Paid Search ──────────────────────────────────────────────────────
  utmRow({ source: 'google', medium: 'cpc' }, 'Paid Search'),
  utmRow({ source: 'bing', medium: 'ppc' }, 'Paid Search'),
  utmRow({ source: 'google', medium: 'paidsearch' }, 'Paid Search'),
  utmRow({ source: 'yandex', medium: 'cpc' }, 'Paid Search'),
  utmRow({ source: 'duckduckgo', medium: 'cpc' }, 'Paid Search'),
  utmRow({ source: 'acme', medium: 'sem' }, 'Paid Search'),
  utmRow({ source: 'google-ads' }, 'Paid Search'),
  utmRow({ source: 'adwords', medium: 'cpc' }, 'Paid Search'),
  utmRow({ clickIds: ['gclid'] }, 'Paid Search'),
  utmRow({ clickIds: ['gbraid'] }, 'Paid Search'),
  utmRow({ clickIds: ['wbraid'] }, 'Paid Search'),
  utmRow({ clickIds: ['msclkid'] }, 'Paid Search'),
  utmRow({ clickIds: ['yclid'] }, 'Paid Search'),
  utmRow({ clickIds: ['s_kwcid'] }, 'Paid Search'),

  // ── Organic Social ───────────────────────────────────────────────────
  host('facebook.com', 'Organic Social'),
  host('m.facebook.com', 'Organic Social'),
  host('l.facebook.com', 'Organic Social'),
  host('fb.me', 'Organic Social'),
  host('fb.watch', 'Organic Social'),
  host('messenger.com', 'Organic Social'),
  host('instagram.com', 'Organic Social'),
  host('ig.me', 'Organic Social'),
  host('threads.net', 'Organic Social'),
  host('twitter.com', 'Organic Social'),
  host('x.com', 'Organic Social'),
  host('t.co', 'Organic Social'),
  host('linkedin.com', 'Organic Social'),
  host('lnkd.in', 'Organic Social'),
  host('xing.com', 'Organic Social'),
  host('reddit.com', 'Organic Social'),
  host('old.reddit.com', 'Organic Social'),
  host('sh.reddit.com', 'Organic Social'),
  host('redd.it', 'Organic Social'),
  host('news.ycombinator.com', 'Organic Social'),
  host('lobste.rs', 'Organic Social'),
  host('tildes.net', 'Organic Social'),
  host('slashdot.org', 'Organic Social'),
  host('digg.com', 'Organic Social'),
  host('lemmy.world', 'Organic Social'),
  host('flipboard.com', 'Organic Social'),
  host('apple.news', 'Organic Social'),
  host('smartnews.com', 'Organic Social'),
  host('toutiao.com', 'Organic Social'),
  host('dzen.ru', 'Organic Social'),
  host('pinterest.com', 'Organic Social'),
  host('pin.it', 'Organic Social'),
  host('pinterest.co.uk', 'Organic Social'),
  host('tiktok.com', 'Organic Social'),
  host('vt.tiktok.com', 'Organic Social'),
  host('snapchat.com', 'Organic Social'),
  host('xiaohongshu.com', 'Organic Social'),
  host('t.me', 'Organic Social'),
  host('wa.me', 'Organic Social'),
  host('discord.gg', 'Organic Social'),
  host('slack.com', 'Organic Social'),
  host('line.me', 'Organic Social'),
  host('mp.weixin.qq.com', 'Organic Social'),
  host('signal.org', 'Organic Social'),
  host('mastodon.social', 'Organic Social'),
  host('hachyderm.io', 'Organic Social'),
  host('infosec.exchange', 'Organic Social'),
  host('bsky.app', 'Organic Social'),
  host('micro.blog', 'Organic Social'),
  host('medium.com', 'Organic Social'),
  host('substack.com', 'Organic Social'),
  host('someone.substack.com', 'Organic Social'),
  host('quora.com', 'Organic Social'),
  host('tumblr.com', 'Organic Social'),
  host('dev.to', 'Organic Social'),
  host('hashnode.com', 'Organic Social'),
  host('hackernoon.com', 'Organic Social'),
  host('indiehackers.com', 'Organic Social'),
  host('producthunt.com', 'Organic Social'),
  host('qiita.com', 'Organic Social'),
  host('zenn.dev', 'Organic Social'),
  host('b.hatena.ne.jp', 'Organic Social'),
  host('blog.naver.com', 'Organic Social'),
  host('tieba.baidu.com', 'Organic Social'),
  host('vk.com', 'Organic Social'),
  host('ok.ru', 'Organic Social'),
  host('weibo.com', 'Organic Social'),
  host('zhihu.com', 'Organic Social'),
  host('qq.com', 'Organic Social'),
  host('5ch.net', 'Organic Social'),
  host('ask.fm', 'Organic Social'),
  host('nextdoor.com', 'Organic Social'),
  host('meetup.com', 'Organic Social'),
  host('goodreads.com', 'Organic Social'),
  host('strava.com', 'Organic Social'),
  host('imgur.com', 'Organic Social'),
  host('9gag.com', 'Organic Social'),
  host('patreon.com', 'Organic Social'),
  host('ko-fi.com', 'Organic Social'),
  utmRow({ source: 'acme', medium: 'social' }, 'Organic Social'),
  utmRow({ source: 'acme', medium: 'social-media' }, 'Organic Social'),
  utmRow({ source: 'acme', medium: 'sm' }, 'Organic Social'),
  utmRow({ clickIds: ['fbclid'] }, 'Organic Social'),
  utmRow({ clickIds: ['igshid'] }, 'Organic Social'),

  // ── Paid Social ──────────────────────────────────────────────────────
  utmRow({ source: 'facebook', medium: 'cpc' }, 'Paid Social'),
  utmRow({ source: 'linkedin', medium: 'paid-social' }, 'Paid Social'),
  utmRow({ source: 'reddit', medium: 'cpc' }, 'Paid Social'),
  utmRow({ source: 'facebook-ads' }, 'Paid Social'),
  utmRow({ medium: 'cpc', clickIds: ['fbclid'] }, 'Paid Social'),
  utmRow({ clickIds: ['ttclid'] }, 'Paid Social'),
  utmRow({ clickIds: ['twclid'] }, 'Paid Social'),
  utmRow({ clickIds: ['li_fat_id'] }, 'Paid Social'),
  utmRow({ clickIds: ['rdt_cid'] }, 'Paid Social'),
  utmRow({ clickIds: ['epik'] }, 'Paid Social'),
  utmRow({ clickIds: ['sccid'] }, 'Paid Social'),

  // ── Organic Video ────────────────────────────────────────────────────
  host('youtube.com', 'Organic Video'),
  host('m.youtube.com', 'Organic Video'),
  host('youtu.be', 'Organic Video'),
  host('music.youtube.com', 'Organic Video'),
  host('vimeo.com', 'Organic Video'),
  host('dailymotion.com', 'Organic Video'),
  host('twitch.tv', 'Organic Video'),
  host('kick.com', 'Organic Video'),
  host('rumble.com', 'Organic Video'),
  host('odysee.com', 'Organic Video'),
  host('nebula.tv', 'Organic Video'),
  host('ted.com', 'Organic Video'),
  host('bilibili.com', 'Organic Video'),
  host('b23.tv', 'Organic Video'),
  host('nicovideo.jp', 'Organic Video'),
  host('rutube.ru', 'Organic Video'),
  host('loom.com', 'Organic Video'),
  host('streamable.com', 'Organic Video'),
  host('peertube.tv', 'Organic Video'),
  utmRow({ source: 'acme', medium: 'video' }, 'Organic Video'),

  // ── Paid Video ───────────────────────────────────────────────────────
  utmRow({ source: 'youtube', medium: 'cpc' }, 'Paid Video'),
  utmRow({ source: 'youtube', medium: 'cpv' }, 'Paid Video'),
  utmRow({ source: 'twitch', medium: 'ppc' }, 'Paid Video'),
  utmRow({ source: 'acme', medium: 'paid-video' }, 'Paid Video'),
  utmRow({ source: 'youtube-ads' }, 'Paid Video'),

  // ── Organic Shopping ─────────────────────────────────────────────────
  host('amazon.com', 'Organic Shopping'),
  host('amazon.de', 'Organic Shopping'),
  host('amazon.co.jp', 'Organic Shopping'),
  host('amzn.to', 'Organic Shopping'),
  host('ebay.com', 'Organic Shopping'),
  host('ebay.co.uk', 'Organic Shopping'),
  host('etsy.com', 'Organic Shopping'),
  host('aliexpress.com', 'Organic Shopping'),
  host('temu.com', 'Organic Shopping'),
  host('shein.com', 'Organic Shopping'),
  host('walmart.com', 'Organic Shopping'),
  host('target.com', 'Organic Shopping'),
  host('bestbuy.com', 'Organic Shopping'),
  host('wayfair.com', 'Organic Shopping'),
  host('shop.app', 'Organic Shopping'),
  host('gumroad.com', 'Organic Shopping'),
  host('flipkart.com', 'Organic Shopping'),
  host('bol.com', 'Organic Shopping'),
  host('otto.de', 'Organic Shopping'),
  host('cdiscount.com', 'Organic Shopping'),
  host('allegro.pl', 'Organic Shopping'),
  host('zalando.de', 'Organic Shopping'),
  host('rakuten.co.jp', 'Organic Shopping'),
  host('mercadolibre.com.ar', 'Organic Shopping'),
  host('coupang.com', 'Organic Shopping'),
  host('shopee.com', 'Organic Shopping'),
  host('lazada.com', 'Organic Shopping'),
  host('trendyol.com', 'Organic Shopping'),
  host('ozon.ru', 'Organic Shopping'),
  host('shopping.google.com', 'Organic Shopping'),
  host('play.google.com', 'Organic Shopping'),
  host('apps.apple.com', 'Organic Shopping'),
  host('store.steampowered.com', 'Organic Shopping'),
  host('kickstarter.com', 'Organic Shopping'),
  utmRow({ source: 'acme', medium: 'shopping' }, 'Organic Shopping'),
  utmRow({ campaign: 'eshop-launch' }, 'Organic Shopping'),
  utmRow({ clickIds: ['srsltid'] }, 'Organic Shopping'),

  // ── Paid Shopping ────────────────────────────────────────────────────
  utmRow({ source: 'amazon', medium: 'cpc' }, 'Paid Shopping'),
  utmRow({ source: 'ebay', medium: 'ppc' }, 'Paid Shopping'),
  utmRow({ source: 'acme', medium: 'paid-shopping' }, 'Paid Shopping'),
  utmRow({ source: 'google', medium: 'cpc', campaign: 'summer-shop' }, 'Paid Shopping'),
  utmRow({ medium: 'cpc', clickIds: ['srsltid'] }, 'Paid Shopping'),

  // ── Cross-network ────────────────────────────────────────────────────
  utmRow({ campaign: 'cross-network' }, 'Cross-network'),
  utmRow({ source: 'google', medium: 'cross-network' }, 'Cross-network'),
  utmRow({ source: 'google', medium: 'cpc', campaign: 'PMax-Brand' }, 'Cross-network'),
  utmRow({ campaign: 'Performance Max retail' }, 'Cross-network'),
  utmRow({ source: 'google', medium: 'cpc', campaign: 'smart shopping' }, 'Cross-network'),

  // ── Display ──────────────────────────────────────────────────────────
  utmRow({ source: 'acme', medium: 'display' }, 'Display'),
  utmRow({ source: 'acme', medium: 'banner' }, 'Display'),
  utmRow({ source: 'acme', medium: 'cpm' }, 'Display'),
  utmRow({ source: 'acme', medium: 'interstitial' }, 'Display'),
  utmRow({ source: 'acme', medium: 'programmatic' }, 'Display'),
  utmRow({ source: 'acme', medium: 'native-ad' }, 'Display'),
  utmRow({ source: 'acme', medium: 'paid-display' }, 'Display'),
  utmRow({ clickIds: ['dclid'] }, 'Display'),
  utmRow({ clickIds: ['dicbo'] }, 'Display'),
  utmRow({ clickIds: ['tblci'] }, 'Display'),

  // ── Paid Other ───────────────────────────────────────────────────────
  utmRow({ source: 'partnerblog', medium: 'cpc' }, 'Paid Other'),
  utmRow({ source: 'acme', medium: 'ppc' }, 'Paid Other'),
  utmRow({ source: 'acme', medium: 'retargeting' }, 'Paid Other'),
  utmRow({ source: 'acme', medium: 'paid' }, 'Paid Other'),
  utmRow({ source: 'acme', medium: 'ads' }, 'Paid Other'),
  utmRow({ source: 'chatgpt', medium: 'cpc' }, 'Paid Other'),
  utmRow({ source: 'spotify', medium: 'cpc' }, 'Paid Other'),
  utmRow({ clickIds: ['ef_id'] }, 'Paid Other'),

  // ── Email ────────────────────────────────────────────────────────────
  host('mail.google.com', 'Email'),
  host('gmail.com', 'Email'),
  host('outlook.live.com', 'Email'),
  host('outlook.office.com', 'Email'),
  host('hotmail.com', 'Email'),
  host('mail.yahoo.com', 'Email'),
  host('mail.proton.me', 'Email'),
  host('tuta.com', 'Email'),
  host('mailbox.org', 'Email'),
  host('posteo.de', 'Email'),
  host('mail.zoho.com', 'Email'),
  host('superhuman.com', 'Email'),
  host('app.hey.com', 'Email'),
  host('app.fastmail.com', 'Email'),
  host('icloud.com', 'Email'),
  host('mail.apple.com', 'Email'),
  host('gmx.net', 'Email'),
  host('gmx.de', 'Email'),
  host('web.de', 'Email'),
  host('mail.yandex.ru', 'Email'),
  host('e.mail.ru', 'Email'),
  host('mail.qq.com', 'Email'),
  host('us17.list-manage.com', 'Email'),
  host('mailchi.mp', 'Email'),
  host('rs6.net', 'Email'),
  host('klaviyomail.com', 'Email'),
  host('ct.sendgrid.net', 'Email'),
  utmRow({ source: 'newsletter', medium: 'email' }, 'Email'),
  utmRow({ source: 'acme', medium: 'e_mail' }, 'Email'),
  utmRow({ source: 'acme', medium: 'e mail' }, 'Email'),
  utmRow({ source: 'gmail' }, 'Email'),
  utmRow({ source: 'beehiiv' }, 'Email'),
  utmRow({ clickIds: ['mc_cid'] }, 'Email'),
  utmRow({ clickIds: ['mkt_tok'] }, 'Email'),

  // ── Affiliates ───────────────────────────────────────────────────────
  utmRow({ source: 'partner', medium: 'affiliate' }, 'Affiliates'),
  utmRow({ source: 'acme', medium: 'partner-program' }, 'Affiliates'),
  utmRow({ clickIds: ['irclickid'] }, 'Affiliates'),
  utmRow({ clickIds: ['awc'] }, 'Affiliates'),
  utmRow({ clickIds: ['cjevent'] }, 'Affiliates'),
  utmRow({ clickIds: ['ranmid'] }, 'Affiliates'),

  // ── Referral ─────────────────────────────────────────────────────────
  host('github.com', 'Referral'),
  host('gitlab.com', 'Referral'),
  host('codeberg.org', 'Referral'),
  host('stackoverflow.com', 'Referral'),
  host('unix.stackexchange.com', 'Referral'),
  host('en.wikipedia.org', 'Referral'),
  host('fr.wikipedia.org', 'Referral'),
  host('developer.mozilla.org', 'Referral'),
  host('npmjs.com', 'Referral'),
  host('pypi.org', 'Referral'),
  host('crates.io', 'Referral'),
  host('notion.so', 'Referral'),
  host('figma.com', 'Referral'),
  host('feedly.com', 'Referral'),
  host('getpocket.com', 'Referral'),
  host('techcrunch.com', 'Referral'),
  host('theverge.com', 'Referral'),
  host('bbc.co.uk', 'Referral'),
  host('nytimes.com', 'Referral'),
  host('linktr.ee', 'Referral'),
  host('bit.ly', 'Referral'),
  host('huggingface.co', 'Referral'),
  host('arxiv.org', 'Referral'),
  host('docs.google.com', 'Referral'),
  host('chromewebstore.google.com', 'Referral'),
  host('blog.acme.io', 'Referral'),
  ['http://192.168.1.20:3000/dash', {}, 'Referral'],
  ['android-app://com.example.app', {}, 'Referral'],
  utmRow({ source: 'acme', medium: 'referral' }, 'Referral'),
  utmRow({ source: 'acme', medium: 'link' }, 'Referral'),
  utmRow({ source: 'acme', medium: 'app' }, 'Referral'),
  utmRow({ source: 'Partner XYZ' }, 'Referral'),

  // ── SMS ──────────────────────────────────────────────────────────────
  utmRow({ source: 'twilio', medium: 'sms' }, 'SMS'),
  utmRow({ source: 'acme', medium: 'mms' }, 'SMS'),
  utmRow({ source: 'acme', medium: 'text-message' }, 'SMS'),
  utmRow({ source: 'sms' }, 'SMS'),
  utmRow({ source: 'attentive' }, 'SMS'),

  // ── Mobile Push Notifications ────────────────────────────────────────
  utmRow({ source: 'firebase' }, 'Mobile Push Notifications'),
  utmRow({ source: 'onesignal' }, 'Mobile Push Notifications'),
  utmRow({ source: 'acme', medium: 'push' }, 'Mobile Push Notifications'),
  utmRow({ source: 'acme', medium: 'mobile-push' }, 'Mobile Push Notifications'),
  utmRow({ source: 'acme', medium: 'notification' }, 'Mobile Push Notifications'),
  utmRow({ source: 'acme', medium: 'mobile' }, 'Mobile Push Notifications'),

  // ── Audio ────────────────────────────────────────────────────────────
  host('open.spotify.com', 'Audio'),
  host('spotify.com', 'Audio'),
  host('podcasts.apple.com', 'Audio'),
  host('music.apple.com', 'Audio'),
  host('soundcloud.com', 'Audio'),
  host('overcast.fm', 'Audio'),
  host('pca.st', 'Audio'),
  host('castbox.fm', 'Audio'),
  host('acast.com', 'Audio'),
  host('audible.com', 'Audio'),
  host('deezer.com', 'Audio'),
  host('tidal.com', 'Audio'),
  host('pandora.com', 'Audio'),
  host('bandcamp.com', 'Audio'),
  host('listennotes.com', 'Audio'),
  utmRow({ source: 'syntax.fm', medium: 'podcast' }, 'Audio'),
  utmRow({ source: 'acme', medium: 'audio' }, 'Audio'),
  utmRow({ source: 'acme', medium: 'radio' }, 'Audio'),

  // ── Unknown ──────────────────────────────────────────────────────────
  ['not a url', {}, 'Unknown'],
  ['://', {}, 'Unknown'],
  ['javascript:void(0)', {}, 'Unknown'],
  ['localhost-only', {}, 'Unknown'],
  utmRow({ source: 'partner', medium: 'qrcode' }, 'Unknown'),
  utmRow({ source: 'acme', medium: 'mobile-web' }, 'Unknown'),
];

test('table-driven channel classification', () => {
  assert.ok(CASES.length >= 200, `expected 200+ cases, got ${CASES.length}`);

  const failures = [];
  for (const [referrer, utm, expected] of CASES) {
    const out = classify(referrer, utm);
    if (out.channel !== expected) {
      failures.push(`${JSON.stringify(referrer)} + ${JSON.stringify(utm)} → ${out.channel}, want ${expected}`);
    }
    assert.equal(typeof out.source, 'string');
    assert.ok(out.source.length <= 255);
    assert.ok(!out.referrer.startsWith('http'), 'referrer must not keep its scheme');
  }
  assert.deepEqual(failures, [], `${failures.length} mismatches:\n${failures.join('\n')}`);

  // The sweep has to exercise the whole taxonomy, or it is not a sweep.
  const covered = new Set(CASES.map(([, , channel]) => channel));
  const missing = CHANNELS.filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `channels with no case: ${missing.join(', ')}`);
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

/**
 * Regression: every lookup table is an object literal, so `map[key]` also finds
 * inherited members — `map['__proto__']` is Object.prototype, truthy, and not a
 * string. That used to escape as a non-string `source`, and since ingestion
 * binds `referrer_source` straight into SQLite the driver threw
 * ERR_INVALID_ARG_TYPE and aborted the write transaction: one crafted link
 * (`?utm_source=__proto__`) dropped the event.
 */
test('inherited object keys are not sources', () => {
  const hostile = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype'];

  for (const key of hostile) {
    assert.equal(classifyHost(key), null, `classifyHost(${key})`);
    assert.equal(channelOf(key), 'Referral', `channelOf(${key})`);
  }

  for (const key of hostile) {
    for (const utm of [
      { source: key },
      { source: key, medium: 'cpc' },
      { medium: key },
      { source: 'google', clickIds: [key] },
      { source: `${key}-ads` },
    ]) {
      const out = classifyReferrer({ referrer: '', siteHost: 'example.com', utm });
      for (const field of ['channel', 'source', 'referrer']) {
        assert.equal(typeof out[field], 'string', `${field} for ${key}: ${JSON.stringify(out)}`);
      }
      assert.ok(CHANNELS.includes(out.channel), `unknown channel ${out.channel} for ${key}`);
    }
  }

  // The same key as a referrer host, and as an app package.
  for (const referrer of ['https://__proto__/', 'https://constructor/', 'android-app://__proto__/']) {
    const out = classifyReferrer({ referrer, siteHost: 'example.com', utm: {} });
    assert.equal(typeof out.source, 'string', referrer);
    assert.ok(CHANNELS.includes(out.channel), referrer);
  }
});

/** classifyReferrer's three fields are SQLite bind parameters; they are always strings. */
test('classifyReferrer always returns three strings', () => {
  const inputs = [
    undefined,
    null,
    {},
    { referrer: 'https://chatgpt.com/', siteHost: 'example.com' },
    { referrer: 'not a url', siteHost: 'example.com', utm: {} },
    { referrer: 12345, siteHost: 'example.com', utm: { source: 99, medium: [], campaign: {} } },
    { referrer: '', siteHost: 'example.com', utm: { clickIds: 'gclid' } },
    { referrer: '', siteHost: 'example.com', utm: { clickIds: [null, 7, {}] } },
  ];

  for (const input of inputs) {
    const out = classifyReferrer(input);
    assert.deepEqual(Object.keys(out).sort(), ['channel', 'referrer', 'source']);
    for (const field of ['channel', 'source', 'referrer']) {
      assert.equal(typeof out[field], 'string', `${field} for ${JSON.stringify(input)}`);
    }
    assert.ok(CHANNELS.includes(out.channel), `${out.channel} for ${JSON.stringify(input)}`);
  }
});
