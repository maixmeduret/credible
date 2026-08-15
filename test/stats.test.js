/**
 * The stats engine.
 *
 * A single hand-built day of traffic, small enough that every number below can
 * be counted by hand from the table in `seed()`. If one of these tests fails,
 * count the rows in that comment before changing the assertion.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import {
  CHROME_UA,
  FIREFOX_UA,
  closeDatabase,
  track,
  utc,
  withDatabase,
} from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Scope,
  aggregate,
  breakdown,
  currentVisitors,
  funnelReport,
  goalsBreakdown,
  pagesBreakdown,
  propertyBreakdown,
  propertyKeys,
  realtimePages,
  timeseries,
} from '../src/stats/index.js';
import { parseFilters } from '../src/stats/query.js';
import { createGoal, listGoals } from '../src/goals.js';
import { createSite } from '../src/sites.js';

const DAY = 86400;
const START = utc(2025, 6, 10, 0, 0, 0);
const END = START + DAY;
const at = (hour, minute = 0, second = 0) => utc(2025, 6, 10, hour, minute, second);

let site;
let funnelSite;
let pagesSite;
let goals;

/**
 * The whole dataset.
 *
 *   visitor  visit  time      event                       page
 *   -------  -----  --------  --------------------------  ---------
 *   alice    A      09:00:00  pageview                    /
 *   alice    A      09:01:00  pageview                    /pricing
 *   alice    A      09:02:00  engagement (20s, 80%)       /pricing
 *   bob      B      10:00:00  pageview (from Google)      /blog
 *   carol    C      11:00:00  pageview                    /
 *   carol    C      11:00:40  Signup  (25 EUR, plan=pro)  /
 *   alice    D      14:00:00  pageview                    /
 *
 *   visitors 3 · visits 4 · pageviews 5 · events 7 · revenue 25.00
 *   bounces: A no, B yes, C yes, D yes            -> 75%
 *   durations: A 120s, B 0s, C 40s, D 0s          -> 40s average
 */
function seed() {
  const alice = { visitorId: 'alice-000000000000000', userAgent: CHROME_UA, ip: '203.0.113.1' };
  const bob = { visitorId: 'bob-0000000000000000', userAgent: FIREFOX_UA, ip: '203.0.113.2' };
  const carol = { visitorId: 'carol-00000000000000', userAgent: CHROME_UA, ip: '203.0.113.3' };

  track({ path: '/' }, { ...alice, timestamp: at(9, 0, 0) });
  track({ path: '/pricing' }, { ...alice, timestamp: at(9, 1, 0) });
  track({ n: 'engagement', path: '/pricing', e: { t: 20000, s: 80 } }, { ...alice, timestamp: at(9, 2, 0) });

  track({ path: '/blog', r: 'https://www.google.com/' }, { ...bob, timestamp: at(10, 0, 0) });

  track({ path: '/' }, { ...carol, timestamp: at(11, 0, 0) });
  track(
    { n: 'Signup', path: '/', p: { plan: 'pro', method: 'card' }, v: { amount: 25 } },
    { ...carol, timestamp: at(11, 0, 40) },
  );

  track({ path: '/' }, { ...alice, timestamp: at(14, 0, 0) });

  // Two events around "now", far outside the fixture window above, so the
  // realtime numbers have both a visitor inside the 5 minute window and one
  // that has already fallen out of it.
  const now = Math.floor(Date.now() / 1000);
  track({ path: '/live' }, { visitorId: 'live-0000000000000', userAgent: CHROME_UA, timestamp: now });
  track({ path: '/stale' }, { visitorId: 'stale-000000000000', userAgent: CHROME_UA, timestamp: now - 600 });
}

/**
 * A third site whose only job is to average two engagement pings on one page:
 * 20s/80% and 10s/40% -> 15s and 60%.
 */
function seedPages() {
  const domain = pagesSite.domain;
  const one = { visitorId: 'p1-000000000000000000', userAgent: CHROME_UA };
  const two = { visitorId: 'p2-000000000000000000', userAgent: CHROME_UA };

  track({ domain, path: '/guide' }, { ...one, timestamp: at(9, 0, 0) });
  track({ domain, n: 'engagement', path: '/guide', e: { t: 20000, s: 80 } }, { ...one, timestamp: at(9, 1, 0) });
  track({ domain, path: '/guide' }, { ...two, timestamp: at(10, 0, 0) });
  track({ domain, n: 'engagement', path: '/guide', e: { t: 10000, s: 40 } }, { ...two, timestamp: at(10, 1, 0) });
}

/**
 * A second site, used only by the funnel tests so the counts above stay clean.
 *
 *   f1  /step-1 then /step-2   -> converts
 *   f2  /step-2 then /step-1   -> reached step 2 first: must NOT convert
 *   f3  /step-1 only           -> drops out
 */
function seedFunnel() {
  const visitor = (id) => ({ visitorId: id, userAgent: CHROME_UA, ip: '203.0.113.9' });
  const domain = funnelSite.domain;

  track({ domain, path: '/step-1' }, { ...visitor('f1-000000000000000000'), timestamp: at(9, 0, 0) });
  track({ domain, path: '/step-2' }, { ...visitor('f1-000000000000000000'), timestamp: at(9, 1, 0) });

  track({ domain, path: '/step-2' }, { ...visitor('f2-000000000000000000'), timestamp: at(9, 0, 0) });
  track({ domain, path: '/step-1' }, { ...visitor('f2-000000000000000000'), timestamp: at(9, 1, 0) });

  track({ domain, path: '/step-1' }, { ...visitor('f3-000000000000000000'), timestamp: at(9, 0, 0) });
}

/** A scope over the fixture day, optionally filtered (wire format). */
function scopeFor(filters = []) {
  return new Scope({
    site,
    range: { start: START, end: END },
    filters: parseFilters(filters),
    goals,
  });
}

before(async () => {
  await withDatabase('stats');
  site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
  funnelSite = createSite({ domain: 'funnel.example', timezone: 'UTC' });
  pagesSite = createSite({ domain: 'pages.example', timezone: 'UTC' });
  seed();
  seedFunnel();
  seedPages();
  createGoal(site.id, { type: 'event', event_name: 'Signup' });
  createGoal(site.id, { type: 'page', page_path: '/pricing' });
  createGoal(site.id, { type: 'page', page_path: '/blog*', display_name: 'Read the blog' });
  goals = listGoals(site.id);
});

after(closeDatabase);

// --------------------------------------------------------------------------

describe('aggregate', () => {
  it('counts the headline metrics for the day', () => {
    assert.deepEqual(aggregate(scopeFor()), {
      visitors: 3,
      visits: 4,
      pageviews: 5,
      events: 7,
      views_per_visit: 1.25,
      bounce_rate: 75,
      visit_duration: 40,
      revenue: 25,
    });
  });

  it('returns zeroes for a window with no traffic', () => {
    const empty = new Scope({ site, range: { start: START - 7 * DAY, end: START - DAY }, goals });
    assert.deepEqual(aggregate(empty), {
      visitors: 0,
      visits: 0,
      pageviews: 0,
      events: 0,
      views_per_visit: 0,
      bounce_rate: 0,
      visit_duration: 0,
      revenue: 0,
    });
  });

  it('is scoped to one site', () => {
    const other = new Scope({ site: funnelSite, range: { start: START, end: END }, goals: [] });
    const metrics = aggregate(other);
    assert.equal(metrics.visitors, 3);
    assert.equal(metrics.pageviews, 5);
    assert.equal(metrics.revenue, 0);
  });
});

// --------------------------------------------------------------------------

describe('timeseries', () => {
  it('returns one bucket per hour and adds up to the daily total', () => {
    const rows = timeseries(scopeFor(), 'hour', 'UTC');
    assert.equal(rows.length, 24);

    const total = aggregate(scopeFor());
    assert.equal(rows.reduce((sum, row) => sum + row.pageviews, 0), total.pageviews);
    assert.equal(rows.reduce((sum, row) => sum + row.events, 0), total.events);
    assert.equal(rows.reduce((sum, row) => sum + row.visits, 0), total.visits);

    assert.deepEqual(rows.map((r) => r.pageviews), [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    assert.equal(rows[9].label, '09:00');
    assert.equal(rows[9].date, '2025-06-10 09:00');
    assert.equal(rows[9].start, at(9));
    assert.equal(rows[9].end, at(10));
  });

  it('carries the session metrics on the bucket the visit started in', () => {
    const rows = timeseries(scopeFor(), 'hour', 'UTC');
    assert.equal(rows[9].visitors, 1);
    assert.equal(rows[9].visits, 1);
    assert.equal(rows[9].bounce_rate, 0, 'alice saw two pages');
    assert.equal(rows[9].visit_duration, 120);
    assert.equal(rows[10].bounce_rate, 100, 'bob bounced');
    assert.equal(rows[12].visitors, 0, 'a quiet hour');
    assert.equal(rows[12].bounce_rate, 0);
  });

  it('returns one bucket per day over a longer window', () => {
    const scope = new Scope({ site, range: { start: START - 6 * DAY, end: END }, goals });
    const rows = timeseries(scope, 'day', 'UTC');
    assert.equal(rows.length, 7);
    assert.equal(rows[6].date, '2025-06-10');
    assert.equal(rows[6].pageviews, 5);
    assert.equal(rows.reduce((sum, row) => sum + row.pageviews, 0), 5);
  });
});

// --------------------------------------------------------------------------

describe('breakdown', () => {
  it('groups a session dimension by entry page', () => {
    const { results, hasMore } = breakdown(scopeFor(), { dimension: 'visit:entry_page' });
    assert.equal(hasMore, false);
    assert.deepEqual(results, [
      { name: '/', visitors: 2, visits: 3, pageviews: 4, bounce_rate: 67, visit_duration: 53 },
      { name: '/blog', visitors: 1, visits: 1, pageviews: 1, bounce_rate: 100, visit_duration: 0 },
    ]);
  });

  it('groups a session dimension by exit page', () => {
    const { results } = breakdown(scopeFor(), { dimension: 'visit:exit_page' });
    assert.deepEqual(
      results.map((r) => [r.name, r.visits]),
      [['/', 2], ['/blog', 1], ['/pricing', 1]],
    );
  });

  it('groups an event dimension by browser', () => {
    const { results } = breakdown(scopeFor(), { dimension: 'visit:browser' });
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => ({ name: r.name, visitors: r.visitors, visits: r.visits, pageviews: r.pageviews, events: r.events })),
      [
        { name: 'Chrome', visitors: 2, visits: 3, pageviews: 4, events: 6 },
        { name: 'Firefox', visitors: 1, visits: 1, pageviews: 1, events: 1 },
      ],
    );
  });

  it('groups acquisition dimensions', () => {
    const channels = breakdown(scopeFor(), { dimension: 'visit:channel' }).results;
    assert.deepEqual(
      channels.map((r) => [r.name, r.visitors]),
      [['Direct', 2], ['Organic Search', 1]],
    );
    const sources = breakdown(scopeFor(), { dimension: 'visit:source' }).results;
    assert.deepEqual(
      sources.map((r) => [r.name, r.visitors]),
      [['Direct', 2], ['Google', 1]],
    );
  });

  it('paginates and reports whether more rows exist', () => {
    const first = breakdown(scopeFor(), { dimension: 'event:page', limit: 1 });
    assert.equal(first.results.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(first.results[0].name, '/');

    const second = breakdown(scopeFor(), { dimension: 'event:page', limit: 1, offset: 1 });
    assert.equal(second.results[0].name, '/blog');
    assert.equal(second.hasMore, true);

    const last = breakdown(scopeFor(), { dimension: 'event:page', limit: 1, offset: 2 });
    assert.equal(last.results[0].name, '/pricing');
    assert.equal(last.hasMore, false);
  });

  it('rejects a dimension that is not in the allow list', () => {
    assert.throws(() => breakdown(scopeFor(), { dimension: 'event:secret' }), /Unknown dimension/);
    assert.throws(() => breakdown(scopeFor(), { dimension: 'e.pathname' }), /Unknown dimension/);
  });
});

// --------------------------------------------------------------------------

describe('pagesBreakdown', () => {
  it('adds time on page and scroll depth from engagement events', () => {
    const { results } = pagesBreakdown(scopeFor(), {});
    assert.deepEqual(results.map((r) => r.name), ['/', '/blog', '/pricing']);

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.deepEqual(byName['/'], {
      name: '/', visitors: 2, visits: 3, pageviews: 3, time_on_page: 0, scroll_depth: 0,
    });
    assert.deepEqual(byName['/pricing'], {
      name: '/pricing', visitors: 1, visits: 1, pageviews: 1, time_on_page: 20, scroll_depth: 80,
    });
    assert.deepEqual(byName['/blog'], {
      name: '/blog', visitors: 1, visits: 1, pageviews: 1, time_on_page: 0, scroll_depth: 0,
    });
  });

  it('averages time on page over the engagement events only', () => {
    // Two pings on /guide: (20s + 10s) / 2 and (80% + 40%) / 2.
    const scope = new Scope({ site: pagesSite, range: { start: START, end: END }, goals: [] });
    const { results } = pagesBreakdown(scope, {});
    assert.deepEqual(results, [
      { name: '/guide', visitors: 2, visits: 2, pageviews: 2, time_on_page: 15, scroll_depth: 60 },
    ]);
  });
});

// --------------------------------------------------------------------------

describe('filters', () => {
  it('filters with `is`', () => {
    const metrics = aggregate(scopeFor([['is', 'visit:browser', ['Firefox']]]));
    assert.equal(metrics.visitors, 1);
    assert.equal(metrics.visits, 1);
    assert.equal(metrics.pageviews, 1);
    assert.equal(metrics.events, 1);
    assert.equal(metrics.bounce_rate, 100);
    assert.equal(metrics.visit_duration, 0);
  });

  it('filters with `is` on several values at once', () => {
    const metrics = aggregate(scopeFor([['is', 'visit:browser', ['Firefox', 'Chrome']]]));
    assert.equal(metrics.visitors, 3);
    assert.equal(metrics.pageviews, 5);
  });

  it('filters with `is_not`', () => {
    const metrics = aggregate(scopeFor([['is_not', 'visit:browser', ['Firefox']]]));
    assert.equal(metrics.visitors, 2);
    assert.equal(metrics.visits, 3);
    assert.equal(metrics.pageviews, 4);
    assert.equal(metrics.events, 6);
    assert.equal(metrics.bounce_rate, 67);
    assert.equal(metrics.visit_duration, 53);
  });

  it('filters with `contains`', () => {
    const metrics = aggregate(scopeFor([['contains', 'event:page', ['/pric']]]));
    assert.equal(metrics.visitors, 1);
    assert.equal(metrics.pageviews, 1);
    assert.equal(metrics.events, 2, 'the pageview and the engagement ping');
    assert.equal(metrics.bounce_rate, 0, 'session metrics follow the matching visit');
    assert.equal(metrics.visit_duration, 120);

    assert.equal(aggregate(scopeFor([['contains', 'event:page', ['nothing']]])).events, 0);
  });

  it('escapes LIKE wildcards in a `contains` value', () => {
    // '%' must be matched literally, not as "anything".
    assert.equal(aggregate(scopeFor([['contains', 'event:page', ['%']]])).events, 0);
    assert.equal(aggregate(scopeFor([['contains', 'event:page', ['_']]])).events, 0);
  });

  it('filters on a custom property', () => {
    // Regression guard: `events.props` defaults to '' for every event without
    // properties, and SQLite raises "malformed JSON" on json_extract('', …).
    // resolveDimension wraps the column in nullif() for exactly this reason.
    const metrics = aggregate(scopeFor([['is', 'event:props:plan', ['pro']]]));
    assert.equal(metrics.visitors, 1);
    assert.equal(metrics.visits, 1);
    assert.equal(metrics.events, 1);
    assert.equal(metrics.pageviews, 0, 'the Signup event is not a pageview');
    assert.equal(metrics.views_per_visit, 0);
    assert.equal(metrics.revenue, 25);
    assert.equal(metrics.bounce_rate, 100, "carol's visit was a bounce");
    assert.equal(metrics.visit_duration, 40);

    assert.equal(aggregate(scopeFor([['is', 'event:props:plan', ['free']]])).events, 0);
  });

  it('filters a breakdown as well as the totals', () => {
    const { results } = breakdown(scopeFor([['is', 'visit:browser', ['Chrome']]]), {
      dimension: 'visit:entry_page',
    });
    assert.deepEqual(results.map((r) => [r.name, r.visits]), [['/', 3]]);
  });

  it('combines filters with AND', () => {
    const metrics = aggregate(
      scopeFor([
        ['is', 'visit:browser', ['Chrome']],
        ['contains', 'event:page', ['/pricing']],
      ]),
    );
    assert.equal(metrics.events, 2);
    assert.equal(metrics.visitors, 1);
  });

  it('rejects a malformed filter list', () => {
    assert.throws(() => parseFilters('not json'), /valid JSON/);
    assert.throws(() => parseFilters('{}'), /must be an array/);
    assert.throws(() => parseFilters([['is', 'event:page']]), /Malformed filter/);
    assert.throws(() => parseFilters([['equals', 'event:page', ['/']]]), /Unknown filter operator/);
  });

  it('parses the wire format from a query string', () => {
    assert.deepEqual(parseFilters('[["is","visit:country",["FR","BE"]]]'), [
      { operator: 'is', key: 'visit:country', values: ['FR', 'BE'] },
    ]);
    assert.deepEqual(parseFilters(''), []);
  });
});

// --------------------------------------------------------------------------

describe('goalsBreakdown', () => {
  it('counts conversions and the conversion rate against the filtered visitors', () => {
    const { results } = goalsBreakdown(scopeFor(), goals);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.deepEqual(byName.Signup, {
      id: byName.Signup.id, name: 'Signup', type: 'event',
      uniques: 1, total: 1, revenue: 25, cr: 33.3, // 1 of 3 visitors
    });
    assert.equal(byName['Visit /pricing'].uniques, 1);
    assert.equal(byName['Visit /pricing'].total, 1, 'only the pageview counts, not the engagement ping');
    assert.equal(byName['Visit /pricing'].cr, 33.3);
    assert.equal(byName['Read the blog'].uniques, 1, 'the trailing * matches /blog');
  });

  it('recomputes the rate inside a filter', () => {
    const { results } = goalsBreakdown(scopeFor([['is', 'visit:browser', ['Chrome']]]), goals);
    const signup = results.find((r) => r.name === 'Signup');
    assert.equal(signup.uniques, 1);
    assert.equal(signup.cr, 50, '1 of the 2 Chrome visitors');
    assert.equal(results.find((r) => r.name === 'Read the blog').uniques, 0, 'bob is on Firefox');
  });

  it('returns nothing when the site has no goals', () => {
    assert.deepEqual(goalsBreakdown(scopeFor(), []), { results: [], hasMore: false });
  });

  it('is sorted by conversions', () => {
    const { results } = goalsBreakdown(scopeFor(), goals);
    const uniques = results.map((r) => r.uniques);
    assert.deepEqual(uniques, [...uniques].sort((a, b) => b - a));
  });
});

// --------------------------------------------------------------------------

describe('custom properties', () => {
  it('lists the property keys in the scope', () => {
    assert.deepEqual(propertyKeys(scopeFor()), ['method', 'plan']);
  });

  it('lists no keys when nothing in the window carries props', () => {
    const empty = new Scope({ site, range: { start: START - DAY, end: START }, goals });
    assert.deepEqual(propertyKeys(empty), []);
  });

  it('breaks a property down by value', () => {
    // Mixed scope: most events carry no props at all, which json_extract must
    // tolerate rather than reject.
    const { results, hasMore } = propertyBreakdown(scopeFor(), 'plan');
    assert.equal(hasMore, false);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'pro');
    assert.equal(results[0].visitors, 1);
    assert.equal(results[0].events, 1);
    assert.equal(results[0].revenue, 25);
  });

  it('returns nothing for a property nobody sent', () => {
    assert.deepEqual(propertyBreakdown(scopeFor(), 'nope'), { results: [], hasMore: false });
  });

  it('breaks a property down when every event in scope carries props', () => {
    const scope = scopeFor([['is', 'event:name', ['Signup']]]);
    const { results, hasMore } = propertyBreakdown(scope, 'plan');
    assert.equal(hasMore, false);
    assert.deepEqual(results, [{ name: 'pro', visitors: 1, events: 1, revenue: 25 }]);
  });
});

// --------------------------------------------------------------------------

describe('funnelReport', () => {
  const funnelScope = () =>
    new Scope({ site: funnelSite, range: { start: START, end: END }, goals: [] });

  let steps;
  let funnel;

  before(() => {
    steps = [
      createGoal(funnelSite.id, { type: 'page', page_path: '/step-1', display_name: 'Landed' }),
      createGoal(funnelSite.id, { type: 'page', page_path: '/step-2', display_name: 'Signed up' }),
    ];
    funnel = { id: 1, name: 'Signup funnel' };
  });

  it('only counts a visitor for step 2 when step 1 came first', () => {
    const report = funnelReport(funnelScope(), funnel, steps);
    assert.equal(report.name, 'Signup funnel');
    assert.equal(report.visitors, 3);
    assert.deepEqual(report.steps, [
      { name: 'Landed', visitors: 3, conversion_rate: 100, dropoff: 0 },
      { name: 'Signed up', visitors: 1, conversion_rate: 33.3, dropoff: 2 },
    ]);
    assert.equal(report.completion_rate, 33.3);
  });

  it('is empty when the funnel has no steps', () => {
    assert.deepEqual(funnelReport(funnelScope(), funnel, []), {
      name: 'Signup funnel',
      steps: [],
      visitors: 0,
    });
  });

  it('reports zeroes for a window with no traffic', () => {
    const scope = new Scope({ site: funnelSite, range: { start: START - DAY, end: START }, goals: [] });
    const report = funnelReport(scope, funnel, steps);
    assert.deepEqual(report.steps.map((s) => s.visitors), [0, 0]);
    assert.equal(report.completion_rate, 0);
  });
});

// --------------------------------------------------------------------------

describe('realtime', () => {
  it('counts the visitors seen in the last five minutes', () => {
    assert.equal(currentVisitors(site.id), 1, 'the 10 minute old visitor has dropped out');
    assert.equal(currentVisitors(funnelSite.id), 0, 'the fixture day is over a year in the past');
  });

  it('takes the window as an argument', () => {
    assert.equal(currentVisitors(site.id, 900), 2, 'a 15 minute window catches both');
    assert.equal(currentVisitors(site.id, 0), 0);
  });

  it('lists the pages those visitors are on', () => {
    assert.deepEqual(realtimePages(site.id), [{ name: '/live', visitors: 1 }]);
    // Equal visitor counts, so the order between them is not guaranteed.
    assert.deepEqual(realtimePages(site.id, 900).map((r) => r.name).sort(), ['/live', '/stale']);
    assert.deepEqual(realtimePages(funnelSite.id), []);
  });
});
