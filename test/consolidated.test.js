/**
 * The consolidated (multi-site) view.
 *
 * Four sites in three timezones, with traffic small enough that every number
 * below can be counted by hand from the table in `seed()`. If one of these
 * tests fails, count the rows in that comment before changing the assertion.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { closeDatabase, track, utc, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { consolidated } from '../src/stats/consolidated.js';
import { createSite } from '../src/sites.js';

const GOOGLE = 'https://www.google.com/';

let sites;

/**
 * The whole dataset. All times below are UTC; the day under test is
 * 2025-06-10, and each site resolves that day in its OWN zone:
 *
 *   utc.example    (UTC)              10 Jun 00:00Z .. 11 Jun 00:00Z
 *   paris.example  (Europe/Paris,+2)   9 Jun 22:00Z .. 10 Jun 22:00Z
 *   ny.example     (America/NY,-4)    10 Jun 04:00Z .. 11 Jun 04:00Z
 *   quiet.example  (UTC)              no traffic at all
 *
 *   site     visitor  time (UTC)      page       note
 *   -------  -------  --------------  ---------  ---------------------------
 *   utc      shared   10 Jun 12:00    /          from Google, bounce
 *   paris    shared   10 Jun 12:00    /          from Google  ┐ 100s, no bounce
 *   paris    shared   10 Jun 12:01:40 /pricing              ┘
 *   paris    p2       10 Jun 13:00    /          from Google  ┐ 200s, no bounce
 *   paris    p2       10 Jun 13:03:20 /pricing              ┘
 *   paris    p3       10 Jun 14:00    /                       ┐ 400s, no bounce
 *   paris    p3       10 Jun 14:06:40 /docs                 ┘
 *   paris    p4       10 Jun 15:00    /          bounce
 *   ny       n1       10 Jun 16:00    /          bounce  (12:00 in New York)
 *   ny       n2       11 Jun 02:00    /          bounce  (22:00 on 10 Jun in NY)
 *   paris    p9        9 Jun 12:00    /          previous period only
 *
 *   `shared` is deliberately the same visitor id on two sites: one human, two
 *   ids, which is exactly why the visitor total over-counts.
 *
 *   utc     visitors 1 · visits 1 · pageviews 1 · bounces 1/1 · 0s
 *   paris   visitors 4 · visits 4 · pageviews 7 · bounces 1/4 · (100+200+400+0)/4 = 175s
 *   ny      visitors 2 · visits 2 · pageviews 2 · bounces 2/2 · 0s
 *   quiet   nothing
 *
 *   totals  visitors 7 · visits 7 · pageviews 10 · 10/7 = 1.43 views per visit
 *   pooled bounce rate  4 bounces / 7 visits          = 57%   (naive site mean: 75%)
 *   pooled visit duration  700s / 7 visits            = 100s  (naive site mean: 58s)
 */
function seed() {
  const shared = { visitorId: 'shared-visitor-000001' };
  const p2 = { visitorId: 'paris-visitor-0000002' };
  const p3 = { visitorId: 'paris-visitor-0000003' };
  const p4 = { visitorId: 'paris-visitor-0000004' };
  const p9 = { visitorId: 'paris-visitor-0000009' };
  const n1 = { visitorId: 'ny-visitor-0000000001' };
  const n2 = { visitorId: 'ny-visitor-0000000002' };

  const at = (day, hour, minute = 0, second = 0) => utc(2025, 6, day, hour, minute, second);

  track({ domain: 'utc.example', path: '/', r: GOOGLE }, { ...shared, timestamp: at(10, 12) });

  track({ domain: 'paris.example', path: '/', r: GOOGLE }, { ...shared, timestamp: at(10, 12) });
  track({ domain: 'paris.example', path: '/pricing' }, { ...shared, timestamp: at(10, 12, 1, 40) });

  track({ domain: 'paris.example', path: '/', r: GOOGLE }, { ...p2, timestamp: at(10, 13) });
  track({ domain: 'paris.example', path: '/pricing' }, { ...p2, timestamp: at(10, 13, 3, 20) });

  track({ domain: 'paris.example', path: '/' }, { ...p3, timestamp: at(10, 14) });
  track({ domain: 'paris.example', path: '/docs' }, { ...p3, timestamp: at(10, 14, 6, 40) });

  track({ domain: 'paris.example', path: '/' }, { ...p4, timestamp: at(10, 15) });

  track({ domain: 'ny.example', path: '/' }, { ...n1, timestamp: at(10, 16) });
  track({ domain: 'ny.example', path: '/' }, { ...n2, timestamp: at(11, 2) });

  // The day before, for the comparison assertions.
  track({ domain: 'paris.example', path: '/' }, { ...p9, timestamp: at(9, 12) });
}

/** The day under test, resolved per site by `consolidated()` itself. */
const DAY_QUERY = { period: 'day', date: '2025-06-10' };

const row = (result, domain) => result.sites.find((site) => site.domain === domain);

/**
 * A separate cast for the money assertions: three sites in three currencies,
 * two of which actually take money on 12 June. All UTC, so the timezone
 * machinery stays out of the way of what is being measured here.
 */
let paid;

function seedRevenue() {
  const at = (hour) => utc(2025, 6, 12, hour);
  const buy = (domain, amount, currency, who, hour) => {
    track({ domain, path: '/' }, { visitorId: who, timestamp: at(hour) });
    track(
      { domain, path: '/buy', n: 'Purchase', v: { amount, currency } },
      { visitorId: who, timestamp: at(hour) },
    );
  };
  buy('eur.example', 10.5, 'EUR', 'eur-visitor-000000001', 9);
  buy('usd.example', 4.25, 'USD', 'usd-visitor-000000001', 10);
  // jpy.example has traffic but never earns, so it cannot make the total mixed.
  track({ domain: 'jpy.example', path: '/' }, { visitorId: 'jpy-visitor-000000001', timestamp: at(11) });
}

/**
 * Three sites for the merged-source assertion. Each has ten sources of its own
 * with two visitors each — enough to fill any per-site top ten — plus one
 * source shared by all three with a single visitor each, which is therefore
 * eleventh everywhere and the largest of all once the three are added up.
 */
let crowded;

function seedCrowdedSources() {
  let n = 0;
  const visitor = () => `crowd-visitor-${String(++n).padStart(7, '0')}`;
  ['c1', 'c2', 'c3'].forEach((name, index) => {
    const domain = `${name}.example`;
    for (let source = 0; source < 10; source += 1) {
      for (let i = 0; i < 2; i += 1) {
        track(
          { domain, path: '/', r: `https://local${index}-${source}.example/` },
          { visitorId: visitor(), timestamp: utc(2025, 6, 13, 1 + source, i) },
        );
      }
    }
    track(
      { domain, path: '/', r: 'https://spread.example/' },
      { visitorId: visitor(), timestamp: utc(2025, 6, 13, 20) },
    );
  });
}

before(async () => {
  await withDatabase('consolidated');
  sites = [
    createSite({ domain: 'utc.example', timezone: 'UTC' }),
    createSite({ domain: 'paris.example', timezone: 'Europe/Paris' }),
    createSite({ domain: 'ny.example', timezone: 'America/New_York' }),
    createSite({ domain: 'quiet.example', timezone: 'UTC' }),
  ];
  seed();

  paid = [
    createSite({ domain: 'eur.example', timezone: 'UTC', currency: 'EUR' }),
    createSite({ domain: 'usd.example', timezone: 'UTC', currency: 'USD' }),
    createSite({ domain: 'jpy.example', timezone: 'UTC', currency: 'JPY' }),
  ];
  seedRevenue();

  crowded = ['c1', 'c2', 'c3'].map((name) => createSite({ domain: `${name}.example`, timezone: 'UTC' }));
  seedCrowdedSources();
});
after(closeDatabase);

describe('consolidated view', () => {
  it('reports one row per site, busiest first', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    assert.deepEqual(
      view.sites.map((site) => site.domain),
      ['paris.example', 'ny.example', 'utc.example', 'quiet.example'],
    );

    assert.deepEqual(row(view, 'paris.example'), {
      domain: 'paris.example',
      timezone: 'Europe/Paris',
      visitors: 4,
      visits: 4,
      pageviews: 7,
      bounce_rate: 25,
      visit_duration: 175,
      change: null,
      current_visitors: 0,
    });

    assert.deepEqual(row(view, 'utc.example'), {
      domain: 'utc.example',
      timezone: 'UTC',
      visitors: 1,
      visits: 1,
      pageviews: 1,
      bounce_rate: 100,
      visit_duration: 0,
      change: null,
      current_visitors: 0,
    });
  });

  it('keeps a site with no data in the range, at zero', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    // A site that vanishes from the list is a tracking outage nobody notices.
    assert.deepEqual(row(view, 'quiet.example'), {
      domain: 'quiet.example',
      timezone: 'UTC',
      visitors: 0,
      visits: 0,
      pageviews: 0,
      bounce_rate: 0,
      visit_duration: 0,
      change: null,
      current_visitors: 0,
    });
  });

  it('sums the counting metrics', () => {
    const { totals } = consolidated({ sites, query: DAY_QUERY });

    assert.equal(totals.visitors, 7); // 1 + 4 + 2 + 0
    assert.equal(totals.visits, 7);
    assert.equal(totals.pageviews, 10); // 1 + 7 + 2 + 0
    assert.equal(totals.views_per_visit, 1.43); // 10 / 7
    assert.equal(totals.revenue, 0);
    assert.equal(totals.current_visitors, 0);
  });

  it('weights bounce rate and visit duration by visits, not by site', () => {
    const view = consolidated({ sites, query: DAY_QUERY });
    const rates = view.sites.filter((s) => s.visits).map((s) => s.bounce_rate);
    const durations = view.sites.filter((s) => s.visits).map((s) => s.visit_duration);

    // Per site: 25% over 4 visits, 100% over 2, 100% over 1.
    assert.deepEqual(rates.sort((a, b) => a - b), [25, 100, 100]);

    // 4 bounces out of 7 visits.
    assert.equal(view.totals.bounce_rate, 57);
    // The naive means a per-site average would have produced, both wrong:
    const naiveRate = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
    assert.equal(naiveRate, 75);
    assert.notEqual(view.totals.bounce_rate, naiveRate);

    // 700 seconds over 7 visits.
    assert.equal(view.totals.visit_duration, 100);
    const naiveDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    assert.equal(naiveDuration, 58);
    assert.notEqual(view.totals.visit_duration, naiveDuration);
  });

  it('resolves the range in each site own timezone', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    // 11 Jun 02:00Z is 10 Jun 22:00 in New York, so it belongs to the New York
    // day under test. A rollup that resolved the range once, in UTC, would
    // have dropped this visitor.
    assert.equal(row(view, 'ny.example').visitors, 2);

    // And the mirror image: the graph is bucketed in the reference zone (UTC,
    // because the sites disagree), so that same event is outside every bucket.
    const graphVisitors = view.timeseries.reduce((sum, point) => sum + point.visitors, 0);
    assert.equal(graphVisitors, 6);
    assert.equal(view.totals.visitors, 7);
    assert.equal(view.timezone, 'UTC');
    assert.deepEqual(view.timezones, ['UTC', 'Europe/Paris', 'America/New_York']);
  });

  it('adds every site into one aligned graph', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    assert.equal(view.timeseries.length, 24); // one UTC day, hourly
    assert.equal(view.period.interval, 'hour');

    const bucket = (iso) => view.timeseries.find((point) => point.date === iso);

    // 12:00 holds utc.example's single pageview plus paris.example's two.
    assert.deepEqual(bucket('2025-06-10 12:00'), {
      date: '2025-06-10 12:00',
      label: '12:00',
      visitors: 2,
      pageviews: 3,
      visits: 2,
    });
    assert.equal(bucket('2025-06-10 15:00').visitors, 1);
    assert.equal(bucket('2025-06-10 16:00').visitors, 1);
    assert.equal(bucket('2025-06-10 03:00').visitors, 0);
  });

  it('labels top pages by site and merges top sources across sites', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    // The same '/' on three sites is three different pages.
    assert.deepEqual(view.top_pages, [
      { name: '/', site: 'paris.example', visitors: 4 },
      { name: '/', site: 'ny.example', visitors: 2 },
      { name: '/pricing', site: 'paris.example', visitors: 2 },
      { name: '/docs', site: 'paris.example', visitors: 1 },
      { name: '/', site: 'utc.example', visitors: 1 },
    ]);

    // Sources DO merge: Google is the same Google whichever site it sent the
    // traffic to — 1 visitor on utc, 2 on paris. The other four (p3, p4, n1,
    // n2) arrived with no referrer.
    assert.deepEqual(view.top_sources, [
      { name: 'Direct', visitors: 4 },
      { name: 'Google', visitors: 3 },
    ]);
  });

  it('says that visitor totals over-count people', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    // 'shared' browsed two sites and was counted twice, so the honest number of
    // humans here is at most 6 even though the total says 7.
    assert.match(view.visitors_note, /counted twice/);
    assert.match(view.visitors_note, /upper bound/);
    assert.match(view.visitors_note, /salt is per site/);
    assert.match(view.visitors_note, /\b7\b/);
    assert.ok(view.notes.includes(view.visitors_note));
  });

  it('does not claim double counting when there is only one site', () => {
    // The caveat is true of a rollup and false of a single site. Saying it
    // anyway would train the reader to skip the note on the pages where it
    // matters, so it has to be right on the pages where it does not.
    const view = consolidated({ sites: [sites[1]], query: DAY_QUERY });

    assert.match(view.visitors_note, /nothing is double counted/);
    assert.doesNotMatch(view.visitors_note, /counted twice/);
    // Still present on every response, so no caller has to branch on it.
    assert.ok(view.notes.includes(view.visitors_note));
  });

  it('says which timezone the graph is drawn in when the sites disagree', () => {
    const view = consolidated({ sites, query: DAY_QUERY });

    assert.match(view.timezone_note, /3 timezones/);
    assert.match(view.timezone_note, /Europe\/Paris/);
    assert.match(view.timezone_note, /its own timezone/);
    assert.match(view.timezone_note, /bucketed in UTC/);
    assert.ok(view.notes.includes(view.timezone_note));
  });

  it('says so plainly when every site shares one timezone', () => {
    const sameZone = sites.filter((site) => (site.timezone || 'UTC') === 'UTC');
    const view = consolidated({ sites: sameZone, query: DAY_QUERY });

    assert.deepEqual(view.timezones, ['UTC']);
    assert.match(view.timezone_note, /All 2 sites report in UTC/);
    assert.match(view.timezone_note, /same window/);

    // One zone, one window: nothing falls outside the graph any more.
    const graphVisitors = view.timeseries.reduce((sum, point) => sum + point.visitors, 0);
    assert.equal(graphVisitors, view.totals.visitors);
  });

  it('compares against the previous period per site', () => {
    const view = consolidated({
      sites,
      query: { ...DAY_QUERY, comparison: 'previous_period' },
    });

    // Only paris.example had traffic on 9 June: one visitor, one bounced visit.
    assert.equal(view.comparison.visitors, 1);
    assert.equal(view.comparison.visits, 1);
    assert.equal(view.comparison.pageviews, 1);
    assert.equal(view.comparison.bounce_rate, 100);

    assert.equal(row(view, 'paris.example').change, 300); // 1 -> 4
    assert.equal(row(view, 'utc.example').change, 100); // 0 -> 1
    assert.equal(row(view, 'quiet.example').change, 0); // 0 -> 0
  });

  it('has no comparison unless one was asked for', () => {
    assert.equal(consolidated({ sites, query: DAY_QUERY }).comparison, null);
    assert.equal(
      consolidated({ sites, query: { ...DAY_QUERY, comparison: 'off' } }).comparison,
      null,
    );
  });

  it('applies the same filters to every site', () => {
    const view = consolidated({
      sites,
      query: { ...DAY_QUERY, filters: JSON.stringify([['is', 'event:page', ['/pricing']]]) },
    });

    assert.equal(row(view, 'paris.example').visitors, 2);
    assert.equal(row(view, 'ny.example').visitors, 0);
    assert.equal(view.totals.visitors, 2);
    assert.equal(view.totals.visits, 2);
    // Both of those visits saw a second page, so neither bounced.
    assert.equal(view.totals.bounce_rate, 0);
  });

  it('re-uses a current_visitors count the caller already has', () => {
    const view = consolidated({
      sites: sites.map((site) => ({ ...site, current_visitors: site.domain === 'ny.example' ? 3 : 0 })),
      query: DAY_QUERY,
    });

    assert.equal(row(view, 'ny.example').current_visitors, 3);
    assert.equal(view.totals.current_visitors, 3);
  });

  it('survives being handed no sites at all', () => {
    const view = consolidated({ sites: [], query: DAY_QUERY });

    assert.deepEqual(view.sites, []);
    assert.equal(view.totals.visitors, 0);
    assert.equal(view.totals.bounce_rate, 0);
    assert.deepEqual(view.top_pages, []);
    assert.deepEqual(view.top_sources, []);
    assert.equal(view.timezone, 'UTC');
    assert.match(view.timezone_note, /No sites/);
  });

  it('keeps a merged source that is below the cut on every single site', () => {
    // Ten local sources of two visitors each fill every per-site top ten, and
    // 'spread.example' is eleventh on all three sites with one visitor apiece.
    // Reading only ten per site would drop it, and it is the biggest source
    // there is: three visitors against the runners-up's two.
    const view = consolidated({ sites: crowded, query: { period: 'day', date: '2025-06-13' } });

    assert.deepEqual(view.top_sources[0], { name: 'spread.example', visitors: 3 });
    assert.equal(view.top_sources.length, 10);
    assert.ok(view.top_sources.slice(1).every((source) => source.visitors === 2));
  });

  it('names the currency the revenue total is in, and refuses to when it cannot', () => {
    const REVENUE_DAY = { period: 'day', date: '2025-06-12' };

    // Two sites earning in two currencies: the sum is a number, not an amount.
    const mixed = consolidated({ sites: paid, query: REVENUE_DAY });
    assert.equal(mixed.totals.revenue, 14.75);
    assert.equal(mixed.currency, null);
    assert.equal(mixed.notes.length, 3);
    assert.match(mixed.notes[2], /2 different currencies \(EUR, USD\)/);
    assert.match(mixed.notes[2], /not a monetary figure/);

    // The JPY site never earned anything, so it cannot make the total mixed:
    // one earner means the total really is denominated in that currency.
    const single = consolidated({ sites: [paid[0], paid[2]], query: REVENUE_DAY });
    assert.equal(single.totals.revenue, 10.5);
    assert.equal(single.currency, 'EUR');
    assert.equal(single.notes.length, 2);

    // Nobody earned: no lie is possible, but no single currency to claim either.
    const quiet = consolidated({ sites: [paid[1], paid[2]], query: { period: 'day', date: '2025-06-14' } });
    assert.equal(quiet.totals.revenue, 0);
    assert.equal(quiet.currency, null);
    assert.equal(quiet.notes.length, 2);
  });

  it('rejects a malformed filter with a 422 instead of a 500', () => {
    // The route needs no guard of its own: parseFilters throws HttpError, so
    // bad input from the query string surfaces as a client error.
    for (const filters of [
      '{not json',
      JSON.stringify([['is', 'event:nope', ['x']]]),
      JSON.stringify([['bogus_op', 'event:page', ['/']]]),
    ]) {
      assert.throws(
        () => consolidated({ sites, query: { ...DAY_QUERY, filters } }),
        (err) => err.status === 422,
        `expected 422 for ${filters}`,
      );
    }
  });

  it('ignores a segment, which belongs to one site and cannot cross them', () => {
    const plain = consolidated({ sites, query: DAY_QUERY });
    const segmented = consolidated({ sites, query: { ...DAY_QUERY, segment: '1' } });

    assert.deepEqual(segmented.totals, plain.totals);
  });

  it('covers each site own history for the all-time period', () => {
    const view = consolidated({ sites, query: { period: 'all' } });

    // Everything ever recorded: paris gains its 9 June visitor.
    assert.equal(row(view, 'paris.example').visitors, 5);
    assert.equal(row(view, 'ny.example').visitors, 2);
    assert.equal(view.totals.visitors, 8);
    assert.equal(row(view, 'quiet.example').visitors, 0);
  });
});
