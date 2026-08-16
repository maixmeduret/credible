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
 *
 * ── Relationship to GA4 ────────────────────────────────────────────────────
 * The channel names and the matching rules follow Google's published Default
 * Channel Group definitions, so a site migrating from GA4 sees numbers it
 * recognises. GA4's paid-medium regex `^(.*cp.*|ppc|retargeting|paid.*)$`, its
 * shopping-campaign regex `^(.*(([^a-df-z]|^)shop|shopping).*)$` and its
 * cross-network rule are implemented verbatim. Four deliberate divergences:
 *
 *   1. GA4 calls the fallback bucket 'Unassigned'; we call it 'Unknown',
 *      because that string is already in the database.
 *   2. GA4 only reaches 'AI Assistants' through `utm_medium=ai-assistant`.
 *      That is useless in practice — nobody tags an LLM referral by hand — so
 *      a referrer from a known answer engine lands there too, the way
 *      Plausible does it.
 *   3. GA4's Mobile Push rule fires on any medium *containing* "mobile", which
 *      swallows the very common `utm_medium=mobile-web`. We require the medium
 *      to end in "push", contain "notification", or be exactly "mobile".
 *   4. We recognise a much longer list of advertising click ids than GA4
 *      exposes, and treat `fbclid`, `igshid` and `srsltid` as organic signals,
 *      because all three are appended to unpaid links as well.
 */

/**
 * Every channel `classifyReferrer` can return, in dashboard display order.
 *
 * These strings are written into `events.channel` and `visits.channel`, so a
 * rename orphans history. Add freely, never edit or delete.
 */
export const CHANNELS = [
  'Direct',
  'Organic Search',
  'AI Assistants',
  'Paid Search',
  'Organic Social',
  'Paid Social',
  'Organic Video',
  'Paid Video',
  'Organic Shopping',
  'Paid Shopping',
  'Cross-network',
  'Display',
  'Paid Other',
  'Email',
  'Affiliates',
  'Referral',
  'SMS',
  'Mobile Push Notifications',
  'Audio',
  'Unknown',
];

/**
 * Advertising click identifiers we recognise on a landing URL.
 *
 * Order is behaviour: `clickIdInfo` returns the first entry present, so the
 * unambiguous paid-search ids come before the softer social and email ones.
 * The first thirteen are frozen — they shipped first and reordering them would
 * silently reclassify traffic.
 *
 * Matching is case-insensitive (see `extractCampaign`): Snapchat ships `ScCid`
 * and Rakuten ships `ranMID`, and neither is going to change for us.
 */
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
  // Added later; safe to extend, see the note above.
  'sccid',
  'igshid',
  's_kwcid',
  'srsltid',
  'awc',
  'cjevent',
  'ranmid',
  'dicbo',
  'tblci',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'ef_id',
];

/**
 * What a click id implies when nothing else identifies the visit.
 *
 * Three of these are *not* proof of a paid click and are deliberately mapped to
 * an organic channel:
 *   - `fbclid`  — Facebook appends it to organic shares too.
 *   - `igshid`  — Instagram's share id, added by the "copy link" button.
 *   - `srsltid` — Google Merchant Center adds it to free Shopping listings as
 *                 well as to Shopping ads.
 * A paid utm_medium upgrades all three, because `channelFromMedium` is
 * consulted before the click id in `classifyReferrer`.
 */
const CLICK_ID_INFO = {
  gclid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  gbraid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  wbraid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  s_kwcid: { channel: 'Paid Search', source: 'Google', type: 'search' },
  msclkid: { channel: 'Paid Search', source: 'Bing', type: 'search' },
  yclid: { channel: 'Paid Search', source: 'Yandex', type: 'search' },
  dclid: { channel: 'Display', source: 'Google Display Network', type: 'referral' },
  dicbo: { channel: 'Display', source: 'Outbrain', type: 'referral' },
  tblci: { channel: 'Display', source: 'Taboola', type: 'referral' },
  ef_id: { channel: 'Paid Other', source: 'Adobe Advertising', type: 'referral' },
  irclickid: { channel: 'Affiliates', source: 'Impact', type: 'referral' },
  awc: { channel: 'Affiliates', source: 'Awin', type: 'referral' },
  cjevent: { channel: 'Affiliates', source: 'CJ Affiliate', type: 'referral' },
  ranmid: { channel: 'Affiliates', source: 'Rakuten Advertising', type: 'referral' },
  fbclid: { channel: 'Organic Social', source: 'Facebook', type: 'social' },
  igshid: { channel: 'Organic Social', source: 'Instagram', type: 'social' },
  srsltid: { channel: 'Organic Shopping', source: 'Google Shopping', type: 'shopping' },
  ttclid: { channel: 'Paid Social', source: 'TikTok', type: 'social' },
  twclid: { channel: 'Paid Social', source: 'X (Twitter)', type: 'social' },
  li_fat_id: { channel: 'Paid Social', source: 'LinkedIn', type: 'social' },
  rdt_cid: { channel: 'Paid Social', source: 'Reddit', type: 'social' },
  epik: { channel: 'Paid Social', source: 'Pinterest', type: 'social' },
  sccid: { channel: 'Paid Social', source: 'Snapchat', type: 'social' },
  mc_cid: { channel: 'Email', source: 'Mailchimp', type: 'email' },
  mc_eid: { channel: 'Email', source: 'Mailchimp', type: 'email' },
  mkt_tok: { channel: 'Email', source: 'Marketo', type: 'email' },
};

/* ------------------------------------------------------------------ *
 * Host tables — hostname (already lowercased and stripped of 'www.')  *
 * mapped to its display name.                                        *
 *                                                                    *
 * Hosts whose *subdomains* belong to unrelated people are absent on   *
 * purpose: 'github.io', 'netlify.app', 'myshopify.com' and friends    *
 * would collapse thousands of independent sites into one row.         *
 * ------------------------------------------------------------------ */

/** Search engines → 'Organic Search'. */
export const SEARCH_ENGINES = {
  // Google properties. The generic 'google.' prefix rule covers the ~190
  // country domains; these are the sub-properties that deserve their own name.
  'google.com': 'Google',
  'cse.google.com': 'Google',
  'news.google.com': 'Google News',
  'scholar.google.com': 'Google Scholar',
  'images.google.com': 'Google Images',
  'translate.google.com': 'Google Translate',
  'translate.goog': 'Google Translate',
  'maps.google.com': 'Google Maps',
  'books.google.com': 'Google Books',
  'patents.google.com': 'Google Patents',
  'lens.google.com': 'Google Lens',
  'webcache.googleusercontent.com': 'Google Cache',

  // Microsoft.
  'bing.com': 'Bing',
  'cn.bing.com': 'Bing',
  'msn.com': 'MSN',
  'ntp.msn.com': 'MSN',

  // Privacy-first engines.
  'duckduckgo.com': 'DuckDuckGo',
  'lite.duckduckgo.com': 'DuckDuckGo',
  'html.duckduckgo.com': 'DuckDuckGo',
  'start.duckduckgo.com': 'DuckDuckGo',
  'safe.duckduckgo.com': 'DuckDuckGo',
  'duck.com': 'DuckDuckGo',
  'search.brave.com': 'Brave Search',
  'startpage.com': 'Startpage',
  'eu.startpage.com': 'Startpage',
  'qwant.com': 'Qwant',
  'lite.qwant.com': 'Qwant',
  'ecosia.org': 'Ecosia',
  'kagi.com': 'Kagi',
  'mojeek.com': 'Mojeek',
  'marginalia.nu': 'Marginalia',
  'search.marginalia.nu': 'Marginalia',
  'old-search.marginalia.nu': 'Marginalia',
  'searx.be': 'SearXNG',
  'searxng.site': 'SearXNG',
  'searxng.world': 'SearXNG',
  'searx.tiekoetter.com': 'SearXNG',
  'search.inetol.net': 'SearXNG',
  'priv.au': 'SearXNG',
  'swisscows.com': 'Swisscows',
  'metager.de': 'MetaGer',
  'presearch.com': 'Presearch',
  'leta.mullvad.net': 'Mullvad Leta',
  'oscobo.com': 'Oscobo',
  'gibiru.com': 'Gibiru',
  'searchencrypt.com': 'Search Encrypt',
  'freespoke.com': 'Freespoke',
  'stract.com': 'Stract',
  'wiby.me': 'Wiby',
  'yep.com': 'Yep',
  'lilo.org': 'Lilo',
  'ekoru.org': 'Ekoru',

  // Legacy US portals.
  'yahoo.com': 'Yahoo!',
  'search.yahoo.com': 'Yahoo!',
  'ask.com': 'Ask',
  'search.ask.com': 'Ask',
  'aol.com': 'AOL',
  'search.aol.com': 'AOL',
  'aol.co.uk': 'AOL',
  'search.aol.co.uk': 'AOL',
  'lycos.com': 'Lycos',
  'search.lycos.com': 'Lycos',
  'excite.com': 'Excite',
  'info.com': 'Info.com',
  'dogpile.com': 'Dogpile',
  'webcrawler.com': 'WebCrawler',
  'metacrawler.com': 'MetaCrawler',
  'zapmeta.com': 'ZapMeta',
  'entireweb.com': 'Entireweb',
  'search.myway.com': 'MyWay',
  'wolframalpha.com': 'Wolfram Alpha',

  // Russia and the CIS.
  'yandex.com': 'Yandex',
  'yandex.ru': 'Yandex',
  'ya.ru': 'Yandex',
  'go.mail.ru': 'Mail.ru',
  'rambler.ru': 'Rambler',
  'nova.rambler.ru': 'Rambler',
  'sputnik.ru': 'Sputnik',

  // Greater China.
  'baidu.com': 'Baidu',
  'm.baidu.com': 'Baidu',
  'sogou.com': 'Sogou',
  'm.sogou.com': 'Sogou',
  'so.com': '360 Search',
  'haosou.com': '360 Search',
  'sm.cn': 'Shenma',
  'quark.sm.cn': 'Quark',

  // Japan and Korea.
  'yahoo.co.jp': 'Yahoo! Japan',
  'search.yahoo.co.jp': 'Yahoo! Japan',
  'goo.ne.jp': 'goo',
  'search.goo.ne.jp': 'goo',
  'biglobe.ne.jp': 'BIGLOBE',
  'search.smt.docomo.ne.jp': 'docomo',
  'search.rakuten.co.jp': 'Rakuten Search',
  'naver.com': 'Naver',
  'search.naver.com': 'Naver',
  'm.search.naver.com': 'Naver',
  'daum.net': 'Daum',
  'search.daum.net': 'Daum',
  'nate.com': 'Nate',
  'search.nate.com': 'Nate',
  'zum.com': 'ZUM',

  // Rest of Asia.
  'coccoc.com': 'Cốc Cốc',
  'rediff.com': 'Rediff',
  'search.rediff.com': 'Rediff',
  'petalsearch.com': 'Petal Search',

  // Europe.
  'seznam.cz': 'Seznam',
  'search.seznam.cz': 'Seznam',
  'centrum.cz': 'Centrum',
  'zoznam.sk': 'Zoznam',
  'onet.pl': 'Onet',
  'szukaj.onet.pl': 'Onet',
  'wp.pl': 'Wirtualna Polska',
  'interia.pl': 'Interia',
  'search.ch': 'Search.ch',
  'onesearch.com': 'OneSearch',
  'virgilio.it': 'Virgilio',
  'libero.it': 'Libero',
  'orange.fr': 'Orange',
  'terra.com.br': 'Terra',
  'uol.com.br': 'UOL',
};

/** Social networks and communities → 'Organic Social'. */
export const SOCIAL_NETWORKS = {
  // Meta.
  'facebook.com': 'Facebook',
  'm.facebook.com': 'Facebook',
  'l.facebook.com': 'Facebook',
  'lm.facebook.com': 'Facebook',
  'web.facebook.com': 'Facebook',
  'free.facebook.com': 'Facebook',
  'mbasic.facebook.com': 'Facebook',
  'touch.facebook.com': 'Facebook',
  'business.facebook.com': 'Facebook',
  'fb.com': 'Facebook',
  'fb.me': 'Facebook',
  'fb.watch': 'Facebook',
  'messenger.com': 'Messenger',
  'l.messenger.com': 'Messenger',
  'instagram.com': 'Instagram',
  'l.instagram.com': 'Instagram',
  'ig.me': 'Instagram',
  'threads.net': 'Threads',
  'threads.com': 'Threads',

  // X.
  'twitter.com': 'X (Twitter)',
  'mobile.twitter.com': 'X (Twitter)',
  'pro.twitter.com': 'X (Twitter)',
  'x.com': 'X (Twitter)',
  't.co': 'X (Twitter)',

  // Professional.
  'linkedin.com': 'LinkedIn',
  'lnkd.in': 'LinkedIn',
  'xing.com': 'XING',
  'glassdoor.com': 'Glassdoor',

  // Link-sharing communities.
  'reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'new.reddit.com': 'Reddit',
  'sh.reddit.com': 'Reddit',
  'np.reddit.com': 'Reddit',
  'out.reddit.com': 'Reddit',
  'amp.reddit.com': 'Reddit',
  'redd.it': 'Reddit',
  'news.ycombinator.com': 'Hacker News',
  'hn.algolia.com': 'Hacker News',
  // An AMP cache is a delivery detail: the visit still came from Hacker News.
  'news.ycombinator.com.cdn.ampproject.org': 'Hacker News',
  'ycombinator.com': 'Y Combinator',
  'lobste.rs': 'Lobsters',
  'tildes.net': 'Tildes',
  'slashdot.org': 'Slashdot',
  'news.slashdot.org': 'Slashdot',
  'digg.com': 'Digg',
  'echojs.com': 'Echo JS',
  'wykop.pl': 'Wykop',
  'meneame.net': 'Menéame',
  'lemmy.world': 'Lemmy',
  'lemmy.ml': 'Lemmy',
  'programming.dev': 'Lemmy',
  'kbin.social': 'kbin',

  // News aggregators and reader feeds people actually click through from.
  'flipboard.com': 'Flipboard',
  'apple.news': 'Apple News',
  'news.apple.com': 'Apple News',
  'smartnews.com': 'SmartNews',
  'toutiao.com': 'Toutiao',
  'dzen.ru': 'Dzen',

  // Pinboards and short video.
  'pinterest.com': 'Pinterest',
  'pin.it': 'Pinterest',
  'tiktok.com': 'TikTok',
  'vm.tiktok.com': 'TikTok',
  'vt.tiktok.com': 'TikTok',
  'm.tiktok.com': 'TikTok',
  'snapchat.com': 'Snapchat',
  'story.snapchat.com': 'Snapchat',
  'xiaohongshu.com': 'Xiaohongshu',
  'xhslink.com': 'Xiaohongshu',

  // Messengers.
  't.me': 'Telegram',
  'telegram.me': 'Telegram',
  'telegram.org': 'Telegram',
  'web.telegram.org': 'Telegram',
  'telegra.ph': 'Telegraph',
  'whatsapp.com': 'WhatsApp',
  'web.whatsapp.com': 'WhatsApp',
  'api.whatsapp.com': 'WhatsApp',
  'chat.whatsapp.com': 'WhatsApp',
  'wa.me': 'WhatsApp',
  'discord.com': 'Discord',
  'discordapp.com': 'Discord',
  'discord.gg': 'Discord',
  'slack.com': 'Slack',
  'app.slack.com': 'Slack',
  'line.me': 'LINE',
  'lin.ee': 'LINE',
  'timeline.line.me': 'LINE',
  'wechat.com': 'WeChat',
  'mp.weixin.qq.com': 'WeChat',
  'signal.org': 'Signal',

  // Fediverse. Only the large public instances — a self-hosted Mastodon is
  // more useful reported under its own hostname.
  'mastodon.social': 'Mastodon',
  'mastodon.online': 'Mastodon',
  'mastodon.world': 'Mastodon',
  'mastodon.cloud': 'Mastodon',
  'mstdn.social': 'Mastodon',
  'mstdn.jp': 'Mastodon',
  'mas.to': 'Mastodon',
  'fosstodon.org': 'Mastodon',
  'hachyderm.io': 'Mastodon',
  'techhub.social': 'Mastodon',
  'infosec.exchange': 'Mastodon',
  'ruby.social': 'Mastodon',
  'phpc.social': 'Mastodon',
  'front-end.social': 'Mastodon',
  'universeodon.com': 'Mastodon',
  'pawoo.net': 'Mastodon',
  'social.lol': 'Mastodon',
  'bsky.app': 'Bluesky',
  'bsky.social': 'Bluesky',
  'micro.blog': 'Micro.blog',
  'minds.com': 'Minds',
  'gab.com': 'Gab',
  'truthsocial.com': 'Truth Social',
  'plurk.com': 'Plurk',

  // Publishing communities.
  'medium.com': 'Medium',
  'substack.com': 'Substack',
  'open.substack.com': 'Substack',
  'quora.com': 'Quora',
  'tumblr.com': 'Tumblr',
  'dev.to': 'DEV Community',
  'hashnode.com': 'Hashnode',
  'hackernoon.com': 'HackerNoon',
  'indiehackers.com': 'Indie Hackers',
  'producthunt.com': 'Product Hunt',
  'note.com': 'note',
  'qiita.com': 'Qiita',
  'zenn.dev': 'Zenn',
  'ameblo.jp': 'Ameba',
  'hatena.ne.jp': 'Hatena',
  'b.hatena.ne.jp': 'Hatena Bookmark',
  'brunch.co.kr': 'Brunch',
  'blog.naver.com': 'Naver Blog',
  'cafe.naver.com': 'Naver Cafe',
  'tieba.baidu.com': 'Baidu Tieba',

  // Regional networks.
  'vk.com': 'VKontakte',
  'm.vk.com': 'VKontakte',
  'vk.ru': 'VKontakte',
  'ok.ru': 'Odnoklassniki',
  'weibo.com': 'Weibo',
  'weibo.cn': 'Weibo',
  't.cn': 'Weibo',
  'zhihu.com': 'Zhihu',
  'douban.com': 'Douban',
  'qq.com': 'QQ',
  'kakao.com': 'Kakao',
  'mixi.jp': 'mixi',
  '5ch.net': '5ch',
  'renren.com': 'Renren',
  'skyrock.com': 'Skyrock',
  'nairaland.com': 'Nairaland',
  'ask.fm': 'ASKfm',

  // Everything else with a real community around it.
  'nextdoor.com': 'Nextdoor',
  'meetup.com': 'Meetup',
  'clubhouse.com': 'Clubhouse',
  'goodreads.com': 'Goodreads',
  'strava.com': 'Strava',
  'deviantart.com': 'DeviantArt',
  'artstation.com': 'ArtStation',
  'imgur.com': 'Imgur',
  'giphy.com': 'GIPHY',
  '9gag.com': '9GAG',
  'buymeacoffee.com': 'Buy Me a Coffee',
  'patreon.com': 'Patreon',
  'ko-fi.com': 'Ko-fi',
};

/** Video platforms → 'Organic Video'. */
export const VIDEO_PLATFORMS = {
  'youtube.com': 'YouTube',
  'm.youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'youtube-nocookie.com': 'YouTube',
  // GA4 files YouTube Music under video, not audio; we follow it so the two
  // dashboards agree.
  'music.youtube.com': 'YouTube Music',
  'vimeo.com': 'Vimeo',
  'player.vimeo.com': 'Vimeo',
  'dailymotion.com': 'Dailymotion',
  'dai.ly': 'Dailymotion',
  'twitch.tv': 'Twitch',
  'm.twitch.tv': 'Twitch',
  'clips.twitch.tv': 'Twitch',
  'kick.com': 'Kick',
  'trovo.live': 'Trovo',
  'rumble.com': 'Rumble',
  'odysee.com': 'Odysee',
  'bitchute.com': 'BitChute',
  'nebula.tv': 'Nebula',
  'floatplane.com': 'Floatplane',
  'ted.com': 'TED',
  'vevo.com': 'Vevo',
  'streamable.com': 'Streamable',
  'loom.com': 'Loom',
  'wistia.com': 'Wistia',
  'wistia.net': 'Wistia',
  'vidyard.com': 'Vidyard',
  'jwplayer.com': 'JW Player',
  'players.brightcove.net': 'Brightcove',
  'peertube.tv': 'PeerTube',
  'framatube.org': 'PeerTube',
  'bilibili.com': 'Bilibili',
  'b23.tv': 'Bilibili',
  'youku.com': 'Youku',
  'iqiyi.com': 'iQIYI',
  'v.qq.com': 'Tencent Video',
  'douyin.com': 'Douyin',
  'kuaishou.com': 'Kuaishou',
  'nicovideo.jp': 'Niconico',
  'rutube.ru': 'Rutube',
};

/**
 * Podcast and music platforms → 'Audio'.
 *
 * GA4 only reaches its Audio channel through `utm_medium=audio`. A click from
 * a podcast player's show notes is unmistakably audio acquisition, so we let
 * the host say so too.
 */
export const AUDIO_PLATFORMS = {
  'open.spotify.com': 'Spotify',
  'spotify.com': 'Spotify',
  'spoti.fi': 'Spotify',
  'podcasts.apple.com': 'Apple Podcasts',
  'music.apple.com': 'Apple Music',
  'podcasts.google.com': 'Google Podcasts',
  'soundcloud.com': 'SoundCloud',
  'on.soundcloud.com': 'SoundCloud',
  'overcast.fm': 'Overcast',
  'pocketcasts.com': 'Pocket Casts',
  'pca.st': 'Pocket Casts',
  'castbox.fm': 'Castbox',
  'player.fm': 'Player FM',
  'podbean.com': 'Podbean',
  'buzzsprout.com': 'Buzzsprout',
  'libsyn.com': 'Libsyn',
  'anchor.fm': 'Anchor',
  'transistor.fm': 'Transistor',
  'simplecast.com': 'Simplecast',
  'megaphone.fm': 'Megaphone',
  'acast.com': 'Acast',
  'redcircle.com': 'RedCircle',
  'fireside.fm': 'Fireside',
  'audioboom.com': 'Audioboom',
  'stitcher.com': 'Stitcher',
  'snipd.com': 'Snipd',
  'listennotes.com': 'Listen Notes',
  'iheart.com': 'iHeartRadio',
  'audible.com': 'Audible',
  'deezer.com': 'Deezer',
  'tidal.com': 'TIDAL',
  'pandora.com': 'Pandora',
  'mixcloud.com': 'Mixcloud',
  'bandcamp.com': 'Bandcamp',
};

/** Marketplaces → 'Organic Shopping'. */
export const SHOPPING_SITES = {
  // Global.
  'amazon.com': 'Amazon',
  'smile.amazon.com': 'Amazon',
  'amzn.to': 'Amazon',
  'ebay.com': 'eBay',
  'etsy.com': 'Etsy',
  'aliexpress.com': 'AliExpress',
  'alibaba.com': 'Alibaba',
  '1688.com': '1688',
  'temu.com': 'Temu',
  'shein.com': 'SHEIN',
  'wish.com': 'Wish',
  'shopping.google.com': 'Google Shopping',
  'play.google.com': 'Google Play',
  'apps.apple.com': 'App Store',
  'itunes.apple.com': 'App Store',
  'store.steampowered.com': 'Steam',
  'itch.io': 'itch.io',
  'kickstarter.com': 'Kickstarter',
  'indiegogo.com': 'Indiegogo',
  'discogs.com': 'Discogs',

  // Commerce platforms and creator storefronts.
  'shop.app': 'Shop',
  'shopify.com': 'Shopify',
  'gumroad.com': 'Gumroad',
  'lemonsqueezy.com': 'Lemon Squeezy',
  'paddle.com': 'Paddle',
  'payhip.com': 'Payhip',

  // North America.
  'walmart.com': 'Walmart',
  'target.com': 'Target',
  'bestbuy.com': 'Best Buy',
  'costco.com': 'Costco',
  'homedepot.com': 'Home Depot',
  'lowes.com': "Lowe's",
  'kohls.com': "Kohl's",
  'macys.com': "Macy's",
  'nordstrom.com': 'Nordstrom',
  'newegg.com': 'Newegg',
  'wayfair.com': 'Wayfair',
  'overstock.com': 'Overstock',
  'chewy.com': 'Chewy',
  'zappos.com': 'Zappos',
  'sephora.com': 'Sephora',

  // Europe.
  'bol.com': 'bol.com',
  'otto.de': 'OTTO',
  'idealo.de': 'Idealo',
  'mediamarkt.de': 'MediaMarkt',
  'saturn.de': 'Saturn',
  'kaufland.de': 'Kaufland',
  'lidl.de': 'Lidl',
  'kleinanzeigen.de': 'Kleinanzeigen',
  'cdiscount.com': 'Cdiscount',
  'fnac.com': 'Fnac',
  'darty.com': 'Darty',
  'laredoute.fr': 'La Redoute',
  'leboncoin.fr': 'leboncoin',
  'allegro.pl': 'Allegro',
  'ceneo.pl': 'Ceneo',
  'empik.com': 'Empik',
  'heureka.cz': 'Heureka',
  'alza.cz': 'Alza',
  'emag.ro': 'eMAG',
  'zalando.com': 'Zalando',
  'asos.com': 'ASOS',
  'argos.co.uk': 'Argos',
  'currys.co.uk': 'Currys',
  'johnlewis.com': 'John Lewis',
  'boots.com': 'Boots',
  'very.co.uk': 'Very',
  'ikea.com': 'IKEA',

  // Asia-Pacific.
  'rakuten.co.jp': 'Rakuten',
  'mercari.com': 'Mercari',
  'jp.mercari.com': 'Mercari',
  'taobao.com': 'Taobao',
  'tmall.com': 'Tmall',
  'jd.com': 'JD.com',
  'pinduoduo.com': 'Pinduoduo',
  'coupang.com': 'Coupang',
  'gmarket.co.kr': 'Gmarket',
  '11st.co.kr': '11st',
  'lazada.com': 'Lazada',
  'shopee.com': 'Shopee',
  'tokopedia.com': 'Tokopedia',
  'bukalapak.com': 'Bukalapak',
  'flipkart.com': 'Flipkart',
  'myntra.com': 'Myntra',
  'snapdeal.com': 'Snapdeal',
  'meesho.com': 'Meesho',

  // Latin America, Middle East, Africa, CIS.
  'mercadolibre.com': 'Mercado Libre',
  'mercadolivre.com.br': 'Mercado Libre',
  'americanas.com.br': 'Americanas',
  'magazineluiza.com.br': 'Magazine Luiza',
  'trendyol.com': 'Trendyol',
  'hepsiburada.com': 'Hepsiburada',
  'noon.com': 'noon',
  'jumia.com': 'Jumia',
  'takealot.com': 'Takealot',
  'wildberries.ru': 'Wildberries',
  'ozon.ru': 'Ozon',
  'avito.ru': 'Avito',
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
  'mail.protonmail.com': 'Proton Mail',
  'tuta.com': 'Tuta',
  'app.tuta.com': 'Tuta',
  'tutanota.com': 'Tuta',
  'mailbox.org': 'mailbox.org',
  'posteo.de': 'Posteo',
  'mail.zoho.com': 'Zoho Mail',
  'mail.zoho.eu': 'Zoho Mail',
  'superhuman.com': 'Superhuman',
  'mail.superhuman.com': 'Superhuman',
  'hey.com': 'HEY',
  'app.hey.com': 'HEY',
  'fastmail.com': 'Fastmail',
  'app.fastmail.com': 'Fastmail',
  'shortwave.com': 'Shortwave',
  'front.com': 'Front',
  'missiveapp.com': 'Missive',
  'sparkmailapp.com': 'Spark',
  'thunderbird.net': 'Thunderbird',
  'roundcube.net': 'Roundcube',
  'icloud.com': 'iCloud Mail',
  'mail.apple.com': 'Apple Mail',
  'mail.com': 'Mail.com',
  'gmx.com': 'GMX',
  'gmx.net': 'GMX',
  'gmx.de': 'GMX',
  'gmx.at': 'GMX',
  'gmx.ch': 'GMX',
  'web.de': 'WEB.DE',
  'mail.yandex.ru': 'Yandex Mail',
  'mail.yandex.com': 'Yandex Mail',
  // 'Mail.ru' on its own is the search portal at go.mail.ru; the mailbox takes
  // the qualifier, the way Yahoo! and Yandex already do in these tables.
  'mail.ru': 'Mail.ru Mail',
  'e.mail.ru': 'Mail.ru Mail',
  'email.seznam.cz': 'Seznam Email',
  'mail.naver.com': 'Naver Mail',
  'mail.daum.net': 'Daum Mail',
  'mail.qq.com': 'QQ Mail',
  'mail.163.com': 'NetEase Mail',
  'mail.126.com': 'NetEase Mail',
  'rediffmail.com': 'Rediffmail',

  // Campaign senders: the click goes through their tracking host, so the mail
  // platform is the most honest thing we can name.
  'list-manage.com': 'Mailchimp',
  'campaign-archive.com': 'Mailchimp',
  'mailchi.mp': 'Mailchimp',
  'sendgrid.net': 'SendGrid',
  'ct.sendgrid.net': 'SendGrid',
  'mailgun.org': 'Mailgun',
  'brevo.com': 'Brevo',
  'sendinblue.com': 'Brevo',
  'sibforms.com': 'Brevo',
  'klaviyo.com': 'Klaviyo',
  'klaviyomail.com': 'Klaviyo',
  'beehiiv.com': 'beehiiv',
  'mail.beehiiv.com': 'beehiiv',
  'kit.com': 'Kit',
  'convertkit.com': 'Kit',
  'convertkit-mail.com': 'Kit',
  'ck.page': 'Kit',
  'buttondown.com': 'Buttondown',
  'buttondown.email': 'Buttondown',
  'mailerlite.com': 'MailerLite',
  'omnisend.com': 'Omnisend',
  'activecampaign.com': 'ActiveCampaign',
  'constantcontact.com': 'Constant Contact',
  'rs6.net': 'Constant Contact',
  'hubspotemail.net': 'HubSpot',
  'marketo.com': 'Marketo',
  'pardot.com': 'Pardot',
  'postmarkapp.com': 'Postmark',
  'loops.so': 'Loops',
  'resend.com': 'Resend',
};

/**
 * AI assistants → 'AI Assistants'.
 *
 * Answer engines are their own acquisition channel: a visit that started in a
 * chat window behaves nothing like a visit from a search results page, and
 * folding the two together is exactly the reporting blind spot people are
 * trying to close. GA4 reaches this channel only through a manual
 * `utm_medium=ai-assistant`; matching on the referrer host is the divergence
 * that makes the channel useful.
 */
export const AI_ASSISTANTS = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'openai.com': 'OpenAI',
  'perplexity.ai': 'Perplexity',
  'pplx.ai': 'Perplexity',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'bard.google.com': 'Gemini',
  'aistudio.google.com': 'Google AI Studio',
  'notebooklm.google.com': 'NotebookLM',
  'assistant.google.com': 'Google Assistant',
  'labs.google': 'Google Labs',
  'copilot.microsoft.com': 'Microsoft Copilot',
  'copilot.cloud.microsoft': 'Microsoft Copilot',
  'm365.cloud.microsoft': 'Microsoft 365 Copilot',
  'meta.ai': 'Meta AI',
  'grok.com': 'Grok',
  'x.ai': 'Grok',
  'duck.ai': 'Duck.ai',
  'lumo.proton.me': 'Lumo',
  'poe.com': 'Poe',
  'you.com': 'You.com',
  'phind.com': 'Phind',
  'mistral.ai': 'Le Chat',
  'chat.mistral.ai': 'Le Chat',
  'deepseek.com': 'DeepSeek',
  'chat.deepseek.com': 'DeepSeek',
  'qwen.ai': 'Qwen',
  'chat.qwen.ai': 'Qwen',
  'tongyi.aliyun.com': 'Tongyi',
  'doubao.com': 'Doubao',
  'kimi.moonshot.cn': 'Kimi',
  'kimi.ai': 'Kimi',
  'yiyan.baidu.com': 'Ernie Bot',
  'chatglm.cn': 'ChatGLM',
  'yuanbao.tencent.com': 'Yuanbao',
  'z.ai': 'Z.ai',
  'chat.z.ai': 'Z.ai',
  'openrouter.ai': 'OpenRouter',
  'groq.com': 'Groq',
  'chat.groq.com': 'Groq',
  'venice.ai': 'Venice',
  'character.ai': 'Character.AI',
  'pi.ai': 'Pi',
  'monica.im': 'Monica',
  'genspark.ai': 'Genspark',
  'felo.ai': 'Felo',
  'iask.ai': 'iAsk',
  'andisearch.com': 'Andi',
  'komo.ai': 'Komo',
  'consensus.app': 'Consensus',
  'lmarena.ai': 'LMArena',
};

/**
 * Well-known hosts that stay in the 'Referral' channel but deserve a proper
 * display name instead of a bare hostname.
 */
export const KNOWN_REFERRERS = {
  // Code hosting and package registries.
  'github.com': 'GitHub',
  'gist.github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'sourceforge.net': 'SourceForge',
  'sr.ht': 'SourceHut',
  'npmjs.com': 'npm',
  'pypi.org': 'PyPI',
  'crates.io': 'crates.io',
  'packagist.org': 'Packagist',
  'rubygems.org': 'RubyGems',
  'nuget.org': 'NuGet',
  'hub.docker.com': 'Docker Hub',
  'pkg.go.dev': 'Go Packages',

  // Q&A and reference.
  'stackoverflow.com': 'Stack Overflow',
  'stackexchange.com': 'Stack Exchange',
  'serverfault.com': 'Server Fault',
  'superuser.com': 'Super User',
  'askubuntu.com': 'Ask Ubuntu',
  'mathoverflow.net': 'MathOverflow',
  'wikipedia.org': 'Wikipedia',
  'en.wikipedia.org': 'Wikipedia',
  'wikimedia.org': 'Wikimedia',
  'wiktionary.org': 'Wiktionary',
  'wikidata.org': 'Wikidata',
  'archive.org': 'Internet Archive',
  'web.archive.org': 'Internet Archive',
  'archive.ph': 'archive.today',

  // Developer documentation and standards.
  'developer.mozilla.org': 'MDN',
  'mozilla.org': 'Mozilla',
  'addons.mozilla.org': 'Firefox Add-ons',
  'w3.org': 'W3C',
  'whatwg.org': 'WHATWG',
  'nodejs.org': 'Node.js',
  'python.org': 'Python',
  'rust-lang.org': 'Rust',
  'go.dev': 'Go',
  'web.dev': 'web.dev',
  'css-tricks.com': 'CSS-Tricks',
  'smashingmagazine.com': 'Smashing Magazine',
  'xda-developers.com': 'XDA',

  // Playgrounds and hosting dashboards.
  'codepen.io': 'CodePen',
  'jsfiddle.net': 'JSFiddle',
  'codesandbox.io': 'CodeSandbox',
  'stackblitz.com': 'StackBlitz',
  'replit.com': 'Replit',
  'glitch.com': 'Glitch',
  'vercel.com': 'Vercel',
  'netlify.com': 'Netlify',
  'render.com': 'Render',
  'fly.io': 'Fly.io',
  'railway.app': 'Railway',
  'digitalocean.com': 'DigitalOcean',
  'cloudflare.com': 'Cloudflare',

  // Workspace tools. Google's own sub-properties are listed so they do not get
  // swallowed by the 'google.' search prefix rule.
  'notion.so': 'Notion',
  'notion.site': 'Notion',
  'trello.com': 'Trello',
  'atlassian.net': 'Jira',
  'atlassian.com': 'Atlassian',
  'asana.com': 'Asana',
  'linear.app': 'Linear',
  'monday.com': 'monday.com',
  'clickup.com': 'ClickUp',
  'basecamp.com': 'Basecamp',
  'airtable.com': 'Airtable',
  'baserow.io': 'Baserow',
  'zoom.us': 'Zoom',
  'teams.microsoft.com': 'Microsoft Teams',
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'groups.google.com': 'Google Groups',
  'sites.google.com': 'Google Sites',
  'calendar.google.com': 'Google Calendar',
  'chat.google.com': 'Google Chat',
  'meet.google.com': 'Google Meet',
  'chromewebstore.google.com': 'Chrome Web Store',
  'chrome.google.com': 'Chrome Web Store',

  // Design.
  'figma.com': 'Figma',
  'dribbble.com': 'Dribbble',
  'behance.net': 'Behance',
  'canva.com': 'Canva',
  'awwwards.com': 'Awwwards',

  // Read-it-later and RSS.
  'feedly.com': 'Feedly',
  'inoreader.com': 'Inoreader',
  'newsblur.com': 'NewsBlur',
  'feedbin.com': 'Feedbin',
  'theoldreader.com': 'The Old Reader',
  'getpocket.com': 'Pocket',
  'instapaper.com': 'Instapaper',
  'raindrop.io': 'Raindrop',
  'readwise.io': 'Readwise',

  // Software directories and reviews.
  'alternativeto.net': 'AlternativeTo',
  'g2.com': 'G2',
  'capterra.com': 'Capterra',
  'trustpilot.com': 'Trustpilot',
  'slant.co': 'Slant',
  'saashub.com': 'SaaSHub',
  'privacytools.io': 'PrivacyTools',
  'awesome-selfhosted.net': 'Awesome Selfhosted',

  // Research and learning.
  'huggingface.co': 'Hugging Face',
  'kaggle.com': 'Kaggle',
  'arxiv.org': 'arXiv',
  'researchgate.net': 'ResearchGate',
  'semanticscholar.org': 'Semantic Scholar',
  'doi.org': 'DOI',
  'pubmed.ncbi.nlm.nih.gov': 'PubMed',
  'coursera.org': 'Coursera',
  'udemy.com': 'Udemy',
  'edx.org': 'edX',
  'khanacademy.org': 'Khan Academy',
  'freecodecamp.org': 'freeCodeCamp',

  // Technology press.
  'techcrunch.com': 'TechCrunch',
  'theverge.com': 'The Verge',
  'arstechnica.com': 'Ars Technica',
  'wired.com': 'WIRED',
  'engadget.com': 'Engadget',
  'zdnet.com': 'ZDNET',
  'venturebeat.com': 'VentureBeat',
  'theregister.com': 'The Register',
  'infoworld.com': 'InfoWorld',
  'heise.de': 'heise online',
  'golem.de': 'Golem.de',

  // General press.
  'nytimes.com': 'The New York Times',
  'washingtonpost.com': 'The Washington Post',
  'theguardian.com': 'The Guardian',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'cnn.com': 'CNN',
  'reuters.com': 'Reuters',
  'bloomberg.com': 'Bloomberg',
  'ft.com': 'Financial Times',
  'wsj.com': 'The Wall Street Journal',
  'forbes.com': 'Forbes',
  'businessinsider.com': 'Business Insider',
  'lemonde.fr': 'Le Monde',
  'lefigaro.fr': 'Le Figaro',
  'spiegel.de': 'Der Spiegel',
  'zeit.de': 'Die Zeit',

  // Link-in-bio pages and shorteners. Their subdomains belong to one operator,
  // so collapsing them to the product name loses nothing.
  'linktr.ee': 'Linktree',
  'bio.link': 'bio.link',
  'beacons.ai': 'Beacons',
  'carrd.co': 'Carrd',
  'bit.ly': 'Bitly',
  'tinyurl.com': 'TinyURL',
  'ow.ly': 'Hootsuite',
  'buff.ly': 'Buffer',
  'rebrand.ly': 'Rebrandly',
  'is.gd': 'is.gd',
  'dub.sh': 'Dub',
  'shorturl.at': 'ShortURL',

  // Payments — a checkout return is navigation, not acquisition, but the row
  // reads better with a name on it.
  'stripe.com': 'Stripe',
  'checkout.stripe.com': 'Stripe',
  'paypal.com': 'PayPal',
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
  { prefix: 'daum.', name: 'Daum', map: SEARCH_ENGINES },
  { prefix: 'aol.', name: 'AOL', map: SEARCH_ENGINES },
  { prefix: 'msn.', name: 'MSN', map: SEARCH_ENGINES },
  { prefix: 'pinterest.', name: 'Pinterest', map: SOCIAL_NETWORKS },
  { prefix: 'amazon.', name: 'Amazon', map: SHOPPING_SITES },
  { prefix: 'ebay.', name: 'eBay', map: SHOPPING_SITES },
  { prefix: 'etsy.', name: 'Etsy', map: SHOPPING_SITES },
  { prefix: 'aliexpress.', name: 'AliExpress', map: SHOPPING_SITES },
  { prefix: 'temu.', name: 'Temu', map: SHOPPING_SITES },
  { prefix: 'shein.', name: 'SHEIN', map: SHOPPING_SITES },
  { prefix: 'zalando.', name: 'Zalando', map: SHOPPING_SITES },
  { prefix: 'allegro.', name: 'Allegro', map: SHOPPING_SITES },
  { prefix: 'rakuten.', name: 'Rakuten', map: SHOPPING_SITES },
  { prefix: 'mercadolibre.', name: 'Mercado Libre', map: SHOPPING_SITES },
  { prefix: 'mercadolivre.', name: 'Mercado Libre', map: SHOPPING_SITES },
  { prefix: 'walmart.', name: 'Walmart', map: SHOPPING_SITES },
  { prefix: 'ikea.', name: 'IKEA', map: SHOPPING_SITES },
  { prefix: 'olx.', name: 'OLX', map: SHOPPING_SITES },
  { prefix: 'jumia.', name: 'Jumia', map: SHOPPING_SITES },
  { prefix: 'lazada.', name: 'Lazada', map: SHOPPING_SITES },
  { prefix: 'shopee.', name: 'Shopee', map: SHOPPING_SITES },
  { prefix: 'gmx.', name: 'GMX', map: EMAIL_CLIENTS },
  { prefix: 'wikipedia.', name: 'Wikipedia', map: KNOWN_REFERRERS },
  { prefix: 'wikimedia.', name: 'Wikimedia', map: KNOWN_REFERRERS },
];

/**
 * Which channel each table feeds, in match priority order.
 *
 * AI before email before search matters: 'gemini.google.com' and
 * 'mail.google.com' must both win against the 'google.' search prefix rule.
 */
const HOST_TABLES = [
  { map: AI_ASSISTANTS, channel: 'AI Assistants', type: 'ai' },
  { map: EMAIL_CLIENTS, channel: 'Email', type: 'email' },
  { map: SEARCH_ENGINES, channel: 'Organic Search', type: 'search' },
  { map: VIDEO_PLATFORMS, channel: 'Organic Video', type: 'video' },
  { map: AUDIO_PLATFORMS, channel: 'Audio', type: 'audio' },
  { map: SOCIAL_NETWORKS, channel: 'Organic Social', type: 'social' },
  { map: SHOPPING_SITES, channel: 'Organic Shopping', type: 'shopping' },
  { map: KNOWN_REFERRERS, channel: 'Referral', type: 'referral' },
];

const TABLE_BY_MAP = new Map(HOST_TABLES.map((t) => [t.map, t]));

/**
 * Android package name → the web host that best represents the app.
 * Referrers arrive as 'android-app://<package>'; mapping them back lets the
 * rest of the pipeline treat them like any other referrer.
 */
export const APP_PACKAGE_HOSTS = {
  'com.google.android.gm': 'mail.google.com',
  'com.google.android.googlequicksearchbox': 'google.com',
  'com.google.android.youtube': 'youtube.com',
  'com.google.android.apps.magazines': 'news.google.com',
  'com.google.android.apps.bard': 'gemini.google.com',
  'com.openai.chatgpt': 'chatgpt.com',
  'ai.perplexity.app.android': 'perplexity.ai',
  'com.anthropic.claude': 'claude.ai',
  'com.microsoft.office.outlook': 'outlook.com',
  'com.microsoft.copilot': 'copilot.microsoft.com',
  'com.yahoo.mobile.client.android.mail': 'mail.yahoo.com',
  'ch.protonmail.android': 'mail.proton.me',
  'com.facebook.katana': 'facebook.com',
  'com.facebook.lite': 'facebook.com',
  'com.facebook.facebook': 'facebook.com',
  'com.facebook.orca': 'messenger.com',
  'com.instagram.android': 'instagram.com',
  'com.burbn.instagram': 'instagram.com',
  'com.twitter.android': 'twitter.com',
  'com.atebits.tweetie2': 'twitter.com',
  'com.linkedin.android': 'linkedin.com',
  'com.reddit.frontpage': 'reddit.com',
  'com.pinterest': 'pinterest.com',
  'com.zhiliaoapp.musically': 'tiktok.com',
  'com.ss.android.ugc.trill': 'tiktok.com',
  'com.snapchat.android': 'snapchat.com',
  'com.toyopagroup.picaboo': 'snapchat.com',
  'org.telegram.messenger': 't.me',
  'com.whatsapp': 'whatsapp.com',
  'com.discord': 'discord.com',
  'com.slack': 'slack.com',
  'com.amazon.mshop.android.shopping': 'amazon.com',
  'com.medium.reader': 'medium.com',
  'com.spotify.music': 'open.spotify.com',
  'com.google.android.apps.podcasts': 'podcasts.google.com',
  'com.apple.mobilemail': 'mail.apple.com',
  'com.apple.news': 'apple.news',
};

/**
 * iOS App Store numeric ids → the web host they represent.
 * Safari emits 'ios-app://<store id>' rather than a bundle identifier, and the
 * number is meaningless in a report.
 */
export const IOS_APP_HOSTS = {
  284882215: 'facebook.com',
  389801252: 'instagram.com',
  333903271: 'twitter.com',
  544007664: 'youtube.com',
  429047995: 'pinterest.com',
  288429040: 'linkedin.com',
  1064216828: 'reddit.com',
  447188370: 'snapchat.com',
  835599320: 'tiktok.com',
  310633997: 'whatsapp.com',
  686449807: 't.me',
  422689480: 'mail.google.com',
  951937596: 'outlook.com',
  284815942: 'google.com',
  618783545: 'slack.com',
  985746746: 'discord.com',
  297606951: 'amazon.com',
  324684580: 'open.spotify.com',
};

/** utm_source values that are not hostnames, mapped to a canonical host. */
const SOURCE_ALIAS_HOSTS = {
  google: 'google.com',
  'google ads': 'google.com',
  google_ads: 'google.com',
  googleads: 'google.com',
  adwords: 'google.com',
  'google shopping': 'shopping.google.com',
  googleshopping: 'shopping.google.com',
  'google news': 'news.google.com',
  googlenews: 'news.google.com',
  bing: 'bing.com',
  microsoft: 'bing.com',
  'bing ads': 'bing.com',
  msn: 'msn.com',
  yahoo: 'yahoo.com',
  duckduckgo: 'duckduckgo.com',
  ddg: 'duckduckgo.com',
  ecosia: 'ecosia.org',
  brave: 'search.brave.com',
  kagi: 'kagi.com',
  startpage: 'startpage.com',
  qwant: 'qwant.com',
  mojeek: 'mojeek.com',
  searx: 'searx.be',
  searxng: 'searx.be',
  baidu: 'baidu.com',
  yandex: 'yandex.com',
  naver: 'naver.com',
  daum: 'daum.net',
  seznam: 'seznam.cz',
  sogou: 'sogou.com',
  coccoc: 'coccoc.com',
  rediff: 'rediff.com',
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
  snap: 'snapchat.com',
  telegram: 't.me',
  whatsapp: 'whatsapp.com',
  discord: 'discord.com',
  slack: 'slack.com',
  signal: 'signal.org',
  mastodon: 'mastodon.social',
  fediverse: 'mastodon.social',
  bluesky: 'bsky.app',
  bsky: 'bsky.app',
  threads: 'threads.net',
  hn: 'news.ycombinator.com',
  hackernews: 'news.ycombinator.com',
  'hacker news': 'news.ycombinator.com',
  'hacker-news': 'news.ycombinator.com',
  ycombinator: 'news.ycombinator.com',
  lobsters: 'lobste.rs',
  lemmy: 'lemmy.world',
  producthunt: 'producthunt.com',
  'product-hunt': 'producthunt.com',
  'product hunt': 'producthunt.com',
  quora: 'quora.com',
  medium: 'medium.com',
  substack: 'substack.com',
  tumblr: 'tumblr.com',
  devto: 'dev.to',
  'dev.to': 'dev.to',
  hashnode: 'hashnode.com',
  indiehackers: 'indiehackers.com',
  slashdot: 'slashdot.org',
  digg: 'digg.com',
  flipboard: 'flipboard.com',
  nextdoor: 'nextdoor.com',
  xing: 'xing.com',
  vk: 'vk.com',
  vkontakte: 'vk.com',
  weibo: 'weibo.com',
  zhihu: 'zhihu.com',
  wechat: 'wechat.com',
  weixin: 'wechat.com',
  line: 'line.me',
  kakao: 'kakao.com',
  youtube: 'youtube.com',
  yt: 'youtube.com',
  vimeo: 'vimeo.com',
  twitch: 'twitch.tv',
  dailymotion: 'dailymotion.com',
  rumble: 'rumble.com',
  bilibili: 'bilibili.com',
  spotify: 'open.spotify.com',
  soundcloud: 'soundcloud.com',
  'apple podcasts': 'podcasts.apple.com',
  applepodcasts: 'podcasts.apple.com',
  overcast: 'overcast.fm',
  pocketcasts: 'pocketcasts.com',
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  stackoverflow: 'stackoverflow.com',
  'stack overflow': 'stackoverflow.com',
  wikipedia: 'wikipedia.org',
  notion: 'notion.so',
  figma: 'figma.com',
  npm: 'npmjs.com',
  huggingface: 'huggingface.co',
  'hugging face': 'huggingface.co',
  amazon: 'amazon.com',
  etsy: 'etsy.com',
  ebay: 'ebay.com',
  aliexpress: 'aliexpress.com',
  temu: 'temu.com',
  shopify: 'shopify.com',
  walmart: 'walmart.com',
  gmail: 'mail.google.com',
  outlook: 'outlook.com',
  chatgpt: 'chatgpt.com',
  'chat gpt': 'chatgpt.com',
  openai: 'openai.com',
  searchgpt: 'chatgpt.com',
  perplexity: 'perplexity.ai',
  claude: 'claude.ai',
  anthropic: 'claude.ai',
  gemini: 'gemini.google.com',
  bard: 'gemini.google.com',
  notebooklm: 'notebooklm.google.com',
  copilot: 'copilot.microsoft.com',
  'microsoft copilot': 'copilot.microsoft.com',
  grok: 'grok.com',
  deepseek: 'deepseek.com',
  mistral: 'mistral.ai',
  lechat: 'chat.mistral.ai',
  'le chat': 'chat.mistral.ai',
  qwen: 'qwen.ai',
  kimi: 'kimi.ai',
  doubao: 'doubao.com',
  poe: 'poe.com',
  'meta ai': 'meta.ai',
  metaai: 'meta.ai',
  'ai assistant': 'chatgpt.com',
  llm: 'chatgpt.com',
};

/** utm_source values that always mean email, whatever the medium says. */
const EMAIL_SOURCE_NAMES = {
  newsletter: 'Newsletter',
  email: 'Email',
  'e-mail': 'Email',
  e_mail: 'Email',
  'e mail': 'Email',
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
  'customer.io': 'Customer.io',
  postmark: 'Postmark',
  mailgun: 'Mailgun',
  resend: 'Resend',
  loops: 'Loops',
  omnisend: 'Omnisend',
  activecampaign: 'ActiveCampaign',
  constantcontact: 'Constant Contact',
  braze: 'Braze',
  iterable: 'Iterable',
  marketo: 'Marketo',
  pardot: 'Pardot',
  hubspot: 'HubSpot',
  drip: 'Drip',
  emarsys: 'Emarsys',
  salesloft: 'Salesloft',
  outreach: 'Outreach',
};

/** utm_source values that mean a text message, whatever the medium says. */
const SMS_SOURCE_NAMES = {
  sms: 'SMS',
  mms: 'SMS',
  'text message': 'SMS',
  twilio: 'Twilio',
  messagebird: 'MessageBird',
  vonage: 'Vonage',
  attentive: 'Attentive',
  postscript: 'Postscript',
  klaviyosms: 'Klaviyo SMS',
};

/**
 * utm_source values that mean a push notification. GA4 hard-codes 'firebase';
 * the rest are the vendors whose SDKs actually append a utm_source.
 */
const PUSH_SOURCE_NAMES = {
  firebase: 'Firebase',
  fcm: 'Firebase',
  onesignal: 'OneSignal',
  airship: 'Airship',
  urbanairship: 'Airship',
  pushwoosh: 'Pushwoosh',
  webpush: 'Web Push',
  'web-push': 'Web Push',
  'web push': 'Web Push',
  pushnotification: 'Push Notification',
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
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'net.ph', 'org.ph',
  'com.vn', 'net.vn', 'co.th', 'co.id', 'com.kh', 'com.mm', 'com.la',
  'co.in', 'net.in', 'org.in', 'com.pk', 'com.bd', 'com.np', 'com.lk',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
  'com.ve', 'com.ec', 'com.uy', 'com.py', 'com.bo', 'com.do', 'com.gt',
  'com.sv', 'com.ni', 'com.pa', 'co.cr',
  'com.tr', 'net.tr', 'org.tr', 'gen.tr', 'com.ua', 'com.ru', 'com.pl', 'com.ro',
  'co.za', 'com.ng', 'com.eg', 'com.ma', 'co.ke', 'co.ug', 'co.tz',
  'com.gh', 'co.zw',
  'com.sa', 'net.sa', 'com.qa', 'com.kw', 'com.bh', 'com.om', 'com.lb', 'com.jo',
  'co.il', 'org.il', 'net.il', 'ac.il',
  'co.at', 'co.no', 'co.hu', 'com.cy', 'com.mt',
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
 * Native app referrers: 'android-app://com.google.android.gm' and the iOS
 * equivalent 'ios-app://284882215'.
 *
 * Chrome on Android may append the real page after the package, as
 * 'android-app://<pkg>/https/host/path'. That embedded URL is strictly better
 * information than the package, so it wins.
 *
 * @returns {{ok: true, host: string, path: string, clean: string, app?: true}}
 * `app: true` marks a package we could not resolve — the "host" is a reverse
 * DNS package name, not a hostname, and must never be fed to the host tables.
 */
function parseAppReferrer(scheme, rest) {
  const slash = rest.indexOf('/');
  const pkg = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  const tail = slash >= 0 ? rest.slice(slash) : '';

  const embedded = /^\/(https?)\/([^/?#]+)([^?#]*)/i.exec(tail);
  if (embedded) {
    const host = normalizeHost(embedded[2]);
    if (host.includes('.')) {
      let path = embedded[3] || '';
      while (path.endsWith('/')) path = path.slice(0, -1);
      return { ok: true, host, path, clean: `${host}${path}`.slice(0, MAX_FIELD) };
    }
  }

  // An iOS store id is numeric and an Android package is not, so the two
  // namespaces cannot collide; checking both keeps a mis-declared scheme working.
  const mapped = scheme === 'ios-app'
    ? lookup(IOS_APP_HOSTS, pkg) || lookup(APP_PACKAGE_HOSTS, pkg)
    : lookup(APP_PACKAGE_HOSTS, pkg) || lookup(IOS_APP_HOSTS, pkg);
  if (mapped) return { ok: true, host: mapped, path: '', clean: mapped };
  return { ok: true, host: pkg, path: '', clean: pkg.slice(0, MAX_FIELD), app: true };
}

/**
 * Parse a raw `document.referrer`.
 * @returns {{ok: boolean, empty?: boolean, host?: string, path?: string, clean?: string, app?: true}}
 */
function parseReferrer(raw) {
  if (typeof raw !== 'string') return { ok: false, empty: true };
  const value = raw.trim();
  if (!value) return { ok: false, empty: true };

  const appMatch = /^(android-app|ios-app|app):\/\/(.+)$/i.exec(value);
  if (appMatch) return parseAppReferrer(appMatch[1].toLowerCase(), appMatch[2]);

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

/**
 * Read one key from a lookup table.
 *
 * Every table here is an object literal, so a plain `map[key]` also finds
 * inherited members: `map['__proto__']` is `Object.prototype` and
 * `map['constructor']` is a function. Both are truthy, so a visitor arriving
 * with `?utm_source=__proto__` used to be classified as a real source and have
 * a *non-string* pushed into `referrer_source`, which the SQLite driver then
 * refused to bind — one crafted link killed the whole ingestion write. Only
 * own, string-valued entries count.
 *
 * @returns {string} the display name, or '' when the key is not in the table
 */
function lookup(map, key) {
  if (!Object.hasOwn(map, key)) return '';
  const value = map[key];
  return typeof value === 'string' ? value : '';
}

/** Look a hostname up in every table, exact match only. */
function exactLookup(host) {
  for (const table of HOST_TABLES) {
    const name = lookup(table.map, host);
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

/* ------------------------------------------------------------------ *
 * Medium and campaign rules                                           *
 * ------------------------------------------------------------------ */

/** GA4's paid-medium regex, verbatim. Matches cpc, cpm, cpv, ppc, paid-*, … */
const PAID_MEDIUM = /^(?:.*cp.*|ppc|retargeting|paid.*)$/;

/** Mediums that mean "paid" without containing 'cp' or 'paid'. */
const PAID_MEDIUM_EXACT = new Set(['sem', 'ads', 'ad', 'adwords', 'googleads', 'bingads', 'remarketing']);

/** GA4's shopping campaign-name regex, verbatim (allows 'eshop', rejects 'workshop'). */
const SHOPPING_CAMPAIGN = /^.*(?:(?:[^a-df-z]|^)shop|shopping).*$/;

/** GA4 signals a Performance Max / Smart Shopping click through the campaign name. */
const CROSS_NETWORK_CAMPAIGN = /cross[-_ ]?network|performance[-_ ]?max|(?:^|[-_ ])pmax(?:[-_ ]|$)|smart[-_ ]?shopping/;
const CROSS_NETWORK_MEDIUM = /^cross[-_ ]?network$/;

/** GA4's own AI channel is medium-driven; these are the spellings people use. */
const AI_MEDIUM = /^ai[-_ ]?(?:assistant|assistants|chat|chatbot|search|overview)$|^(?:llm|genai|chatbot)$/;

/**
 * Push notifications. GA4 fires on any medium *containing* "mobile", which
 * eats the extremely common `utm_medium=mobile-web`; we require the medium to
 * end in push, mention a notification, or be exactly "mobile".
 */
const PUSH_MEDIUM = /push$|notification|^mobile$/;

const SOCIAL_MEDIUM = /^social|^sm$/;

/** Keyword rules that outrank the paid check, in GA4's evaluation order. */
const MEDIUM_RULES = [
  { test: /^(?:e[-_ ]?mail|newsletter|mail)/, channel: 'Email' },
  { test: /^(?:affiliate|partner-?program|cpa-?affiliate)/, channel: 'Affiliates' },
  { test: /^(?:display|banner|cpm|expandable|interstitial|programmatic|native-?ad|rich-?media)/, channel: 'Display' },
  { test: /^(?:sms|mms|text-?message)/, channel: 'SMS' },
  { test: /^(?:audio|podcast|radio)/, channel: 'Audio' },
];

function isPaidMedium(medium) {
  return PAID_MEDIUM.test(medium) || PAID_MEDIUM_EXACT.has(medium);
}

/** Which paid channel a paid medium lands in, given what the source looks like. */
function paidChannelFor(medium, type) {
  if (medium.includes('search') || medium.includes('sem')) return 'Paid Search';
  if (medium.includes('social')) return 'Paid Social';
  if (medium.includes('video')) return 'Paid Video';
  if (medium.includes('shop')) return 'Paid Shopping';
  if (medium.includes('display') || medium.includes('banner')) return 'Display';
  switch (type) {
    case 'search': return 'Paid Search';
    case 'social': return 'Paid Social';
    case 'video': return 'Paid Video';
    case 'shopping': return 'Paid Shopping';
    // There is no "Paid AI" or "Paid Audio" in GA4, and inventing one would put
    // rows in a bucket no other tool reports.
    default: return 'Paid Other';
  }
}

/** Which organic channel `utm_medium=organic` lands in, given the source. */
function organicChannelFor(type) {
  switch (type) {
    case 'ai': return 'AI Assistants';
    case 'social': return 'Organic Social';
    case 'video': return 'Organic Video';
    case 'shopping': return 'Organic Shopping';
    case 'audio': return 'Audio';
    case 'email': return 'Email';
    default: return 'Organic Search';
  }
}

/**
 * Channel implied by utm_medium alone, refined by what the source looks like.
 * @returns {string|null} null when the medium says nothing we understand.
 */
function channelFromMedium(medium, type) {
  if (!medium) return null;

  if (CROSS_NETWORK_MEDIUM.test(medium)) return 'Cross-network';
  if (AI_MEDIUM.test(medium)) return 'AI Assistants';

  for (const rule of MEDIUM_RULES) {
    if (rule.test.test(medium)) return rule.channel;
  }

  if (isPaidMedium(medium)) return paidChannelFor(medium, type);

  // After the paid check: 'mobile-cpc' is an ad buy, not a push notification.
  if (PUSH_MEDIUM.test(medium)) return 'Mobile Push Notifications';

  if (SOCIAL_MEDIUM.test(medium)) return 'Organic Social';
  if (medium.includes('video')) return 'Organic Video';
  if (/^shop/.test(medium)) return 'Organic Shopping';
  if (/^(?:referral|app|link)$/.test(medium) || /^refer/.test(medium)) return 'Referral';
  if (/^organic/.test(medium)) return organicChannelFor(type);
  return null;
}

/**
 * Plausible's rule: 'facebook-ads' or 'google ads' is the paid face of a source
 * we already know. Only accepted when the stripped token resolves, so 'nomads'
 * stays 'nomads'.
 */
const PAID_SOURCE_SUFFIX = /^(.{2,}?)[-_. ]?(?:ads?|adwords|ppc|cpc|paid)$/;

/**
 * Classify a utm_source value, which may be a hostname ('news.ycombinator.com'),
 * an alias ('hn'), a paid variant ('linkedin-ads') or a free-form vendor name.
 */
function classifySource(rawSource) {
  const token = normalizeHost(rawSource.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0]);
  if (!token) return null;

  const emailName = lookup(EMAIL_SOURCE_NAMES, token);
  if (emailName) return { channel: 'Email', source: emailName, type: 'email' };

  const smsName = lookup(SMS_SOURCE_NAMES, token);
  if (smsName) return { channel: 'SMS', source: smsName, type: 'referral' };

  const pushName = lookup(PUSH_SOURCE_NAMES, token);
  if (pushName) return { channel: 'Mobile Push Notifications', source: pushName, type: 'referral' };

  // Checked before the plain alias so 'facebook ads' is paid, not organic.
  const paid = PAID_SOURCE_SUFFIX.exec(token);
  if (paid) {
    const base = paid[1];
    const hit = classifyHost(lookup(SOURCE_ALIAS_HOSTS, base) || (base.includes('.') ? base : ''));
    if (hit) return { channel: paidChannelFor('', hit.type), source: hit.source, type: hit.type };
  }

  const aliased = lookup(SOURCE_ALIAS_HOSTS, token);
  if (aliased) return classifyHost(aliased);

  if (token.includes('.')) {
    const hit = classifyHost(token);
    if (hit) return hit;
    return { channel: null, source: token, type: 'referral' };
  }
  return null;
}

/** First recognised click id, in CLICK_ID_PARAMS order. */
function clickIdInfo(clickIds) {
  for (const id of clickIds) {
    // Own properties only — `clickIds` reaches here from callers that build the
    // utm object themselves (the CSV importer), not just from extractCampaign.
    if (typeof id !== 'string' || !Object.hasOwn(CLICK_ID_INFO, id)) continue;
    const info = CLICK_ID_INFO[id];
    if (info && typeof info.source === 'string') return info;
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
 * Case-insensitive parameter reader. Ad platforms ship mixed-case names
 * ('ScCid', 'ranMID', 'mc_cid') and hand-written links mangle the rest.
 */
function paramReader(params) {
  if (typeof params.keys !== 'function') {
    return (name) => params.get(name);
  }
  const byLowerName = new Map();
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, params.get(key));
  }
  return (name) => byLowerName.get(name.toLowerCase());
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

  const read = paramReader(params);
  const pick = (...names) => {
    for (const name of names) {
      const value = read(name);
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  };

  const clickIds = [];
  for (const name of CLICK_ID_PARAMS) {
    const value = read(name);
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
  return asStrings(classifyReferrerInner(input));
}

/**
 * The three fields go straight into SQLite bind parameters, and the driver
 * throws on anything that is not a primitive — a throw here would abort the
 * whole ingestion transaction and drop the event. The classifier is careful to
 * return strings, so this is a guard against a future table entry, not a known
 * hole; it costs three typeof checks per pageview.
 */
function asStrings(result) {
  const { channel, source, referrer } = result;
  return {
    channel: typeof channel === 'string' && channel ? channel : 'Unknown',
    source: typeof source === 'string' ? source : '',
    referrer: typeof referrer === 'string' ? referrer : '',
  };
}

function classifyReferrerInner(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const siteHost = hostFromLoose(opts.siteHost);
  const utm = normalizeUtm(opts.utm);
  const parsed = parseReferrer(opts.referrer);

  // Rule 2 (applied early so it also clears the stored referrer): a referrer on
  // our own registrable domain is internal navigation, not an acquisition.
  // An unresolved app package is never "our own domain" — it is not a hostname.
  const internal = parsed.ok && !parsed.app && isSameSite(parsed.host, siteHost);
  const external = parsed.ok && !internal ? parsed : null;
  const refString = external ? external.clean : '';
  const refInfo = external && !external.app ? classifyHost(external.host) : null;
  // The host fallback is attacker-controlled (it comes from document.referrer),
  // so it goes through the same MAX_FIELD cap as every other stored field.
  const refSource = external ? (refInfo ? refInfo.source : cleanValue(external.host)) : '';

  // Rule 1: campaign parameters and click ids win over document.referrer.
  const srcInfo = utm.source ? classifySource(utm.source) : null;
  const clickInfo = clickIdInfo(utm.clickIds);

  // GA4 reads the campaign *name* for two channels, and both outrank the medium.
  const campaignName = utm.campaign.toLowerCase();
  const crossNetwork = Boolean(campaignName) && CROSS_NETWORK_CAMPAIGN.test(campaignName);
  const shoppingCampaign =
    !crossNetwork && Boolean(campaignName) && SHOPPING_CAMPAIGN.test(campaignName);

  if (utm.source || utm.medium || clickInfo || crossNetwork || shoppingCampaign) {
    // GA4 evaluates its shopping rules before the social/search ones, so a
    // shopping campaign name overrides what the source looks like.
    const type = shoppingCampaign
      ? 'shopping'
      : srcInfo?.type || clickInfo?.type || refInfo?.type || '';

    const source =
      srcInfo?.source ||
      (utm.source ? cleanValue(utm.source) : '') ||
      clickInfo?.source ||
      refSource ||
      'Direct';

    const channel =
      (crossNetwork ? 'Cross-network' : '') ||
      channelFromMedium(utm.medium, type) ||
      clickInfo?.channel ||
      srcInfo?.channel ||
      // A campaign the owner tagged as shopping beats a channel we merely
      // inferred from the referring host.
      (shoppingCampaign ? 'Organic Shopping' : '') ||
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

/**
 * Reverse index: display name → channel.
 *
 * Built once from the same tables the classifier uses, so the two can never
 * drift. A name that appears in two tables (Mail.ru is both a search portal and
 * a mail provider) resolves to the higher-priority table, matching what
 * `classifyHost` would have returned for an ambiguous host.
 */
const CHANNEL_BY_SOURCE_NAME = new Map();
const CHANNEL_BY_LOWER_NAME = new Map();

function indexSourceName(name, channel) {
  if (!CHANNEL_BY_SOURCE_NAME.has(name)) CHANNEL_BY_SOURCE_NAME.set(name, channel);
  const lower = name.toLowerCase();
  if (!CHANNEL_BY_LOWER_NAME.has(lower)) CHANNEL_BY_LOWER_NAME.set(lower, channel);
}

for (const table of HOST_TABLES) {
  for (const name of Object.values(table.map)) indexSourceName(name, table.channel);
}
for (const name of Object.values(EMAIL_SOURCE_NAMES)) indexSourceName(name, 'Email');
for (const name of Object.values(SMS_SOURCE_NAMES)) indexSourceName(name, 'SMS');
for (const name of Object.values(PUSH_SOURCE_NAMES)) indexSourceName(name, 'Mobile Push Notifications');
for (const info of Object.values(CLICK_ID_INFO)) indexSourceName(info.source, info.channel);
indexSourceName('Direct', 'Direct');
indexSourceName('Unknown', 'Unknown');

/**
 * Channel for a source name on its own, for callers holding a stored
 * `referrer_source` with no referrer or campaign next to it — a saved filter,
 * a CSV import, an API caller grouping by source.
 *
 * Accepts a display name ('Hacker News'), a hostname ('news.ycombinator.com')
 * or a utm_source alias ('hn'). Anything unrecognised is a 'Referral', which is
 * what `classifyReferrer` would have stored for it.
 *
 * A source name cannot tell paid from organic — 'Google' is 'Organic Search'
 * here whether the visit was an ad click or not. When the row also has a
 * medium, a click id or a referrer, call `classifyReferrer` instead: it is the
 * authority, and this function is the degraded fallback for callers that have
 * nothing else.
 *
 * @param {string} source
 * @returns {string} one of CHANNELS
 */
export function channelOf(source) {
  const raw = typeof source === 'string' ? source.trim() : '';
  if (!raw) return 'Direct';

  const exact = CHANNEL_BY_SOURCE_NAME.get(raw);
  if (exact) return exact;

  const viaSource = classifySource(raw);
  if (viaSource?.channel) return viaSource.channel;

  const lower = CHANNEL_BY_LOWER_NAME.get(raw.toLowerCase());
  if (lower) return lower;

  return 'Referral';
}
