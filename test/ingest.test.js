/**
 * The ingestion pipeline.
 *
 * Sessionisation happens at write time, so these tests are mostly about the
 * `visits` row: when it is created, when it is extended, and what an event
 * inherits from it.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import {
  CHROME_UA,
  DEFAULT_IP,
  FIREFOX_UA,
  GOOGLEBOT_UA,
  closeDatabase,
  events,
  track,
  utc,
  visits,
  withDatabase,
} from './helpers.js';

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePath, recordEvent, sanitizeProps } from '../src/ingest/index.js';
import { createSite, updateSite } from '../src/sites.js';
import { config } from '../src/config.js';

/** Every fixture happens on the same UTC day, so visitor ids stay comparable. */
const T = utc(2025, 6, 10, 10, 0, 0);
const WINDOW = config.inactivityTimeout; // 1800 by default

let site;

beforeEach(async () => {
  await withDatabase('ingest');
  site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
});

after(closeDatabase);

// --------------------------------------------------------------------------

describe('a single pageview', () => {
  it('writes exactly one event and one visit', () => {
    const result = track({ path: '/' }, { timestamp: T });
    assert.deepEqual(result, { status: 'ok', events: 1 });

    const rows = events();
    const sessions = visits();
    assert.equal(rows.length, 1);
    assert.equal(sessions.length, 1);

    const [event] = rows;
    const [visit] = sessions;
    assert.equal(event.site_id, site.id);
    assert.equal(event.name, 'pageview');
    assert.equal(event.timestamp, T);
    assert.equal(event.pathname, '/');
    assert.equal(event.hostname, 'example.com');
    assert.equal(event.visit_id, visit.id);
    assert.equal(event.visitor_id.length, 22, 'visitor id is a truncated hash');

    assert.equal(visit.visitor_id, event.visitor_id);
    assert.equal(visit.started_at, T);
    assert.equal(visit.last_event_at, T);
    assert.equal(visit.duration, 0);
    assert.equal(visit.pageviews, 1);
    assert.equal(visit.events, 1);
    assert.equal(visit.is_bounce, 1);
    assert.equal(visit.entry_page, '/');
    assert.equal(visit.exit_page, '/');
  });

  it('derives device columns from the User-Agent and viewport', () => {
    track({ path: '/', w: 375 }, { timestamp: T, userAgent: FIREFOX_UA });
    const [event] = events();
    assert.equal(event.browser, 'Firefox');
    assert.equal(event.browser_version, '127');
    assert.equal(event.os, 'Linux');
    assert.equal(event.device, 'Desktop');
    assert.equal(event.screen_size, 'Mobile');
  });

  it('records the same visitor for identical ip + user agent, a different one otherwise', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/', domain: 'example.com' }, { timestamp: T + WINDOW + 1 });
    track({ path: '/' }, { timestamp: T, ip: '198.51.100.4' });
    track({ path: '/' }, { timestamp: T, userAgent: FIREFOX_UA });

    const ids = events().map((e) => e.visitor_id);
    assert.equal(ids[0], ids[1], 'same ip + user agent on the same day is the same visitor');
    assert.notEqual(ids[0], ids[2], 'a different ip is a different visitor');
    assert.notEqual(ids[0], ids[3], 'a different user agent is a different visitor');
  });
});

// --------------------------------------------------------------------------

describe('sessionisation', () => {
  it('extends the same visit for a second pageview inside the inactivity window', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/pricing' }, { timestamp: T + 60 });

    const sessions = visits();
    assert.equal(sessions.length, 1, 'no second visit');
    const [visit] = sessions;
    assert.equal(visit.pageviews, 2);
    assert.equal(visit.events, 2);
    assert.equal(visit.is_bounce, 0, 'two pageviews is not a bounce');
    assert.equal(visit.entry_page, '/', 'the entry page never moves');
    assert.equal(visit.exit_page, '/pricing', 'the exit page follows the last pageview');
    assert.equal(visit.last_event_at, T + 60);
    assert.equal(visit.duration, 60);

    const rows = events();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].visit_id, rows[1].visit_id);
    assert.equal(rows[0].visitor_id, rows[1].visitor_id);
  });

  it('still extends the visit at exactly the inactivity timeout', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/late' }, { timestamp: T + WINDOW });

    const sessions = visits();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].duration, WINDOW);
    assert.equal(sessions[0].exit_page, '/late');
  });

  it('opens a new visit one second past the inactivity window', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/second-session' }, { timestamp: T + WINDOW + 1 });

    const sessions = visits();
    assert.equal(sessions.length, 2);

    const [first, second] = sessions;
    assert.equal(first.pageviews, 1);
    assert.equal(first.exit_page, '/', 'the closed visit is untouched');
    assert.equal(first.duration, 0);

    assert.equal(second.visitor_id, first.visitor_id, 'the same person, a new visit');
    assert.equal(second.started_at, T + WINDOW + 1);
    assert.equal(second.pageviews, 1);
    assert.equal(second.is_bounce, 1);
    assert.equal(second.entry_page, '/second-session');

    const rows = events();
    assert.equal(rows[0].visit_id, first.id);
    assert.equal(rows[1].visit_id, second.id);
  });

  it('keeps a bounce a bounce when the extra event is not a pageview', () => {
    track({ path: '/' }, { timestamp: T });
    track({ n: 'Signup', path: '/' }, { timestamp: T + 30 });

    const [visit] = visits();
    assert.equal(visit.pageviews, 1, 'custom events are not pageviews');
    assert.equal(visit.events, 2);
    assert.equal(visit.is_bounce, 1);
    assert.equal(visit.duration, 30);
  });

  it('does not move the exit page for a non-pageview event', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/pricing' }, { timestamp: T + 10 });
    track({ n: 'Signup', path: '/checkout' }, { timestamp: T + 20 });

    const [visit] = visits();
    assert.equal(visit.exit_page, '/pricing');
    assert.equal(visit.pageviews, 2);
    assert.equal(visit.events, 3);
  });

  it('separates visitors into their own visits', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/' }, { timestamp: T + 5 });
    track({ path: '/' }, { timestamp: T + 5, ip: '198.51.100.9' });

    assert.equal(visits().length, 2);
  });
});

// --------------------------------------------------------------------------

describe('what gets dropped', () => {
  it('drops bots and blank user agents, and says which signal fired', () => {
    // The signal is not decoration: "0 visitors" is the symptom of half a dozen
    // different problems, and naming the rule that dropped an event is what
    // makes `credible doctor` able to tell them apart.
    const cases = [
      [GOOGLEBOT_UA, 'ua_pattern'],
      ['', 'ua_missing'],
      ['curl/8.4.0', 'ua_pattern'],
    ];
    for (const [userAgent, signal] of cases) {
      const result = track({ path: '/' }, { timestamp: T, userAgent });
      assert.equal(result.status, 'ignored', userAgent || '(blank)');
      assert.equal(result.reason, 'bot', userAgent || '(blank)');
      assert.equal(result.signal, signal, userAgent || '(blank)');
    }
    assert.equal(events().length, 0);
    assert.equal(visits().length, 0);
  });

  it('drops events for a domain this instance does not track', () => {
    const result = track({ path: '/', domain: 'not-tracked.example' }, { timestamp: T });
    assert.deepEqual(result, { status: 'ignored', reason: 'unknown domain' });
    assert.equal(events().length, 0);
  });

  it('drops excluded paths but keeps everything else', () => {
    updateSite(site.id, { excluded_paths: '/admin/**\n/private, /draft-*' });

    for (const path of ['/admin/settings', '/admin/users/7', '/private', '/draft-post']) {
      assert.equal(track({ path }, { timestamp: T }).status, 'ignored', `${path} should be excluded`);
    }
    for (const path of ['/', '/administration', '/private-ish']) {
      assert.equal(track({ path }, { timestamp: T }).status, 'ok', `${path} should be kept`);
    }

    assert.deepEqual(events().map((e) => e.pathname), ['/', '/administration', '/private-ish']);
  });

  it('drops excluded ip addresses', () => {
    updateSite(site.id, { excluded_ips: `${DEFAULT_IP}, 10.0.0.1` });
    assert.equal(track({ path: '/' }, { timestamp: T }).status, 'ignored');
    assert.equal(track({ path: '/' }, { timestamp: T, ip: '10.0.0.1' }).status, 'ignored');
    assert.equal(track({ path: '/' }, { timestamp: T, ip: '198.51.100.2' }).status, 'ok');
    assert.equal(events().length, 1);
  });

  it('rejects malformed payloads', () => {
    assert.deepEqual(recordEvent({ n: '', u: 'https://example.com/', d: 'example.com' }, { userAgent: CHROME_UA }), {
      status: 'ignored',
      reason: 'missing event name',
    });
    assert.deepEqual(recordEvent({ n: 'pageview', u: 'not a url', d: 'example.com' }, { userAgent: CHROME_UA }), {
      status: 'ignored',
      reason: 'invalid url',
    });
    assert.deepEqual(
      recordEvent({ n: 'pageview', u: 'file:///etc/passwd', d: 'example.com' }, { userAgent: CHROME_UA }),
      { status: 'ignored', reason: 'unsupported scheme' },
    );
    assert.deepEqual(recordEvent({ n: 'pageview', u: 'https://example.com/', d: '' }, { userAgent: CHROME_UA }), {
      status: 'ignored',
      reason: 'missing data-domain',
    });
    assert.equal(events().length, 0);
  });

  it('records one event per tracked domain in a multi-domain payload', () => {
    const second = createSite({ domain: 'shop.example', timezone: 'UTC' });
    const result = track({ path: '/', domain: 'example.com' }, { timestamp: T });
    assert.equal(result.events, 1);

    const both = recordEvent(
      { n: 'pageview', u: 'https://example.com/x', d: 'example.com,shop.example,ghost.example' },
      { userAgent: CHROME_UA, ip: DEFAULT_IP, timestamp: T },
    );
    assert.deepEqual(both, { status: 'ok', events: 2 });
    assert.equal(events('site_id = ?', [site.id]).length, 2);
    assert.equal(events('site_id = ?', [second.id]).length, 1);
  });
});

// --------------------------------------------------------------------------

describe('normalizePath', () => {
  it('collapses duplicate slashes and drops the trailing one', () => {
    assert.equal(normalizePath('/blog///post/'), '/blog/post');
    assert.equal(normalizePath('//a//b//'), '/a/b');
    assert.equal(normalizePath('/pricing/'), '/pricing');
    assert.equal(normalizePath('/'), '/', 'the root keeps its slash');
    assert.equal(normalizePath('///'), '/');
  });

  it('always returns an absolute path', () => {
    assert.equal(normalizePath('pricing'), '/pricing');
    assert.equal(normalizePath(''), '/');
    assert.equal(normalizePath(null), '/');
    assert.equal(normalizePath(undefined), '/');
  });

  it('decodes percent-encoding, and keeps it when it is broken', () => {
    assert.equal(normalizePath('/caf%C3%A9'), '/café');
    assert.equal(normalizePath('/%E2%9C%93/done'), '/✓/done');
    assert.equal(normalizePath('/%E0%A4%A'), '/%E0%A4%A', 'invalid escape is left alone');
    assert.equal(normalizePath('/a%2Fb'), '/a%2Fb', 'an encoded slash is not a separator');
  });

  it('is applied to the ingested url', () => {
    track({ path: '/blog///post/' }, { timestamp: T });
    track({ u: 'https://www.example.com/caf%C3%A9/?utm_source=x#frag' }, { timestamp: T + 1 });

    assert.deepEqual(events().map((e) => e.pathname), ['/blog/post', '/café']);
    assert.deepEqual(events().map((e) => e.hostname), ['example.com', 'example.com']);
  });

  it('keeps the fragment when the tracker is in hash mode', () => {
    track({ u: 'https://example.com/app/#/settings', h: 1 }, { timestamp: T });
    assert.equal(events()[0].pathname, '/app#/settings');
  });
});

// --------------------------------------------------------------------------

describe('sanitizeProps', () => {
  it('ignores anything that is not a plain object', () => {
    for (const input of [null, undefined, '', 'plan=pro', 42, true, ['a', 'b']]) {
      assert.equal(sanitizeProps(input), '', `${JSON.stringify(input)} should produce no props`);
    }
    assert.equal(sanitizeProps({}), '');
  });

  it('keeps flat scalars as strings and drops everything else', () => {
    const json = sanitizeProps({
      plan: 'pro',
      seats: 12,
      trial: false,
      nested: { deep: 1 },
      list: [1, 2],
      missing: null,
      undef: undefined,
      blank: '   ',
    });
    assert.deepEqual(JSON.parse(json), { plan: 'pro', seats: '12', trial: 'false' });
  });

  it('trims keys and values and skips empty ones', () => {
    assert.deepEqual(JSON.parse(sanitizeProps({ '  plan  ': '  pro  ' })), { plan: 'pro' });
    assert.equal(sanitizeProps({ '   ': 'value' }), '');
  });

  it('bounds key and value length', () => {
    const props = JSON.parse(sanitizeProps({ ['k'.repeat(200)]: 'v'.repeat(400) }));
    const [key] = Object.keys(props);
    assert.equal(key.length, 64);
    assert.equal(props[key].length, 255);
  });

  it('caps the number of keys at 30', () => {
    const many = {};
    for (let i = 0; i < 45; i += 1) many[`key${String(i).padStart(2, '0')}`] = `value${i}`;
    const kept = JSON.parse(sanitizeProps(many));
    assert.equal(Object.keys(kept).length, 30);
    assert.equal(kept.key00, 'value0');
    assert.equal(kept.key29, 'value29');
    assert.equal(kept.key30, undefined);
  });

  it('is stored on the event row', () => {
    track({ n: 'Signup', path: '/thanks', p: { plan: 'pro', seats: 3 } }, { timestamp: T });
    const [custom] = events();
    assert.equal(custom.name, 'Signup');
    assert.deepEqual(JSON.parse(custom.props), { plan: 'pro', seats: '3' });
  });
});

// --------------------------------------------------------------------------

describe('revenue', () => {
  it('stores minor currency units', () => {
    track({ n: 'Purchase', path: '/thanks', v: { amount: 19.99, currency: 'usd' } }, { timestamp: T });
    const [event] = events();
    assert.equal(event.revenue, 1999, 'stored in cents');
    assert.equal(event.currency, 'USD');
  });

  it('accepts the short payload keys and falls back to the site currency', () => {
    track({ n: 'Purchase', path: '/a', v: { a: 10 } }, { timestamp: T });
    const [event] = events();
    assert.equal(event.revenue, 1000);
    assert.equal(event.currency, 'EUR', 'the site currency');
  });

  it('leaves revenue null when there is no usable amount', () => {
    track({ n: 'Purchase', path: '/a', v: { amount: 'free' } }, { timestamp: T });
    track({ n: 'Purchase', path: '/b', v: 'nope' }, { timestamp: T + 1 });
    track({ n: 'Purchase', path: '/c' }, { timestamp: T + 2 });
    for (const event of events()) {
      assert.equal(event.revenue, null);
      assert.equal(event.currency, '');
    }
  });

  it('stores nothing for a currency that cannot be a three letter code', () => {
    track({ n: 'Purchase', path: '/a', v: { amount: 5, currency: 'e' } }, { timestamp: T });
    track({ n: 'Purchase', path: '/b', v: { amount: 5, currency: '123' } }, { timestamp: T + 1 });
    for (const event of events()) {
      assert.equal(event.currency, '');
      assert.equal(event.revenue, 500, 'the amount is still recorded');
    }
  });

  it('truncates an over-long currency to its first three letters', () => {
    // Documented behaviour rather than an endorsement: the value is sliced
    // before it is validated, so 'bitcoin' is stored as 'BIT'.
    track({ n: 'Purchase', path: '/a', v: { amount: 5, currency: 'bitcoin' } }, { timestamp: T });
    assert.equal(events()[0].currency, 'BIT');
  });
});

// --------------------------------------------------------------------------

describe('acquisition', () => {
  it('classifies an external referrer', () => {
    track({ path: '/', r: 'https://news.ycombinator.com/item?id=123' }, { timestamp: T });
    const [event] = events();
    assert.equal(event.channel, 'Organic Social');
    assert.equal(event.referrer_source, 'Hacker News');
    assert.equal(event.referrer, 'news.ycombinator.com/item', 'the query string is dropped');
  });

  it('treats an internal referrer as Direct', () => {
    track({ path: '/', r: 'https://example.com/other' }, { timestamp: T });
    const [event] = events();
    assert.equal(event.channel, 'Direct');
    assert.equal(event.referrer_source, 'Direct');
    assert.equal(event.referrer, '');
  });

  it('reads utm parameters off the landing url', () => {
    track(
      { u: 'https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_content=hero&utm_term=analytics' },
      { timestamp: T },
    );
    const [event] = events();
    assert.equal(event.channel, 'Email');
    assert.equal(event.utm_source, 'newsletter');
    assert.equal(event.utm_medium, 'email');
    assert.equal(event.utm_campaign, 'launch');
    assert.equal(event.utm_content, 'hero');
    assert.equal(event.utm_term, 'analytics');
  });

  it('inherits the visit acquisition for every later event in the session', () => {
    track({ path: '/', r: 'https://news.ycombinator.com/item?id=123' }, { timestamp: T });
    // Internal navigation: the referrer is now our own site.
    track({ path: '/pricing', r: 'https://example.com/' }, { timestamp: T + 60 });
    // Even a *new* external referrer mid-session does not re-attribute the visit.
    track({ n: 'Signup', path: '/pricing', r: 'https://www.google.com/' }, { timestamp: T + 120 });

    const [first, second, third] = events();
    for (const later of [second, third]) {
      assert.equal(later.channel, first.channel);
      assert.equal(later.referrer_source, first.referrer_source);
      assert.equal(later.referrer, first.referrer);
    }
    assert.equal(second.referrer_source, 'Hacker News');
    assert.equal(third.channel, 'Organic Social');

    const [visit] = visits();
    assert.equal(visit.channel, 'Organic Social');
    assert.equal(visit.referrer_source, 'Hacker News');
    assert.equal(visit.referrer, 'news.ycombinator.com/item');
  });

  it('inherits utm attribution too, and geo and device', () => {
    track({ u: 'https://example.com/?utm_source=newsletter&utm_medium=email' }, { timestamp: T });
    track({ path: '/pricing' }, { timestamp: T + 60, userAgent: CHROME_UA, headers: { 'cf-ipcountry': 'DE' } });

    const [first, second] = events();
    assert.equal(second.utm_source, 'newsletter');
    assert.equal(second.utm_medium, 'email');
    assert.equal(second.channel, 'Email');
    assert.equal(second.country_code, first.country_code, 'geo comes from the visit, not the event');
  });

  it('re-attributes once a new visit starts', () => {
    track({ path: '/', r: 'https://news.ycombinator.com/item?id=123' }, { timestamp: T });
    track({ path: '/', r: 'https://example.com/other' }, { timestamp: T + WINDOW + 1 });

    const [first, second] = events();
    assert.equal(first.referrer_source, 'Hacker News');
    assert.equal(second.referrer_source, 'Direct', 'a fresh visit is classified on its own');
    assert.equal(visits().length, 2);
  });

  it('resolves geography from edge headers, never from the raw ip', () => {
    track({ path: '/' }, {
      timestamp: T,
      headers: { 'cf-ipcountry': 'FR', 'x-geo-region': 'Île-de-France', 'cf-ipcity': 'Paris' },
    });
    const [event] = events();
    assert.equal(event.country_code, 'FR');
    assert.equal(event.region, 'Île-de-France');
    assert.equal(event.city, 'Paris');
    assert.equal(JSON.stringify(event).includes(DEFAULT_IP), false, 'the ip is never stored');
  });
});

// --------------------------------------------------------------------------

describe('engagement events', () => {
  it('extends the visit without counting as a pageview', () => {
    track({ path: '/' }, { timestamp: T });
    track({ n: 'engagement', path: '/', e: { t: 15000, s: 75 } }, { timestamp: T + 30 });

    const [visit] = visits();
    assert.equal(visit.pageviews, 1, 'engagement is not a pageview');
    assert.equal(visit.events, 2);
    assert.equal(visit.is_bounce, 1, 'one page seen is still a bounce');
    assert.equal(visit.duration, 30, 'but the visit is 30 seconds long');
    assert.equal(visit.last_event_at, T + 30);
    assert.equal(visit.exit_page, '/');

    const [, engagement] = events();
    assert.equal(engagement.name, 'engagement');
    assert.equal(engagement.engagement_time, 15000);
    assert.equal(engagement.scroll_depth, 75);
  });

  it('clamps engagement time and scroll depth', () => {
    track({ n: 'engagement', path: '/', e: { t: 99_999_999, s: 500 } }, { timestamp: T });
    track({ n: 'engagement', path: '/', e: { t: -5, s: -20 } }, { timestamp: T + 1 });
    track({ n: 'engagement', path: '/', e: { t: 'soon', s: 'far' } }, { timestamp: T + 2 });

    const [big, negative, nonsense] = events();
    assert.equal(big.engagement_time, 30 * 60 * 1000, 'capped at 30 minutes');
    assert.equal(big.scroll_depth, 100);
    assert.equal(negative.engagement_time, 0);
    assert.equal(negative.scroll_depth, 0);
    assert.equal(nonsense.engagement_time, 0);
    assert.equal(nonsense.scroll_depth, 0);
  });

  it('stores zeroes when there is no engagement payload', () => {
    track({ path: '/' }, { timestamp: T });
    track({ path: '/', e: 'not an object' }, { timestamp: T + 1 });
    for (const event of events()) {
      assert.equal(event.engagement_time, 0);
      assert.equal(event.scroll_depth, 0);
    }
  });
});
