/**
 * The filter language: operators, regular expressions, boolean composition and
 * the behavioural (`has_done`) filters.
 *
 * A hand-built day of traffic, small enough that every number below can be
 * counted by hand from the table in `seed()`. If one of these fails, count the
 * rows in that comment before changing the assertion.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import {
  CHROME_UA,
  FIREFOX_UA,
  closeDatabase,
  countRows,
  events,
  track,
  utc,
  withDatabase,
} from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Scope, aggregate, breakdown, timeseries } from '../src/stats/index.js';
import { parseFilters } from '../src/stats/query.js';
import { createGoal, listGoals } from '../src/goals.js';
import { createSite } from '../src/sites.js';
import { get } from '../src/db/index.js';

const DAY = 86400;
const START = utc(2025, 6, 10, 0, 0, 0);
const END = START + DAY;
const at = (hour, minute = 0) => utc(2025, 6, 10, hour, minute, 0);

let site;
let goals;

/**
 * The whole dataset. Every event is a pageview.
 *
 *   visitor  visit  time   page                    browser  country
 *   -------  -----  -----  ----------------------  -------  -------
 *   dana     D1     09:00  /pricing                Chrome   FR
 *   dana     D1     09:05  /docs/getting-started   Chrome   FR
 *   dana     D2     15:00  /blog/changelog         Chrome   FR
 *   erik     E1     10:00  /pricing                Firefox  DE
 *   erik     E1     10:10  /checkout               Firefox  DE
 *   fay      F1     11:00  /blog/hello             Chrome   DE
 *   gus      G1     12:00  /docs/api               Firefox  FR
 *
 *   visitors 4 · visits 5 · pageviews 7 · events 7
 *   D2 is a second visit: six hours after D1, well past the 30 minute timeout.
 *   bounces: D1 no, D2 yes, E1 no, F1 yes, G1 yes    -> 60%
 *   durations: D1 300s, D2 0s, E1 600s, F1 0s, G1 0s -> 180s average
 *
 *   Chrome  -> dana, fay        (4 events)
 *   France  -> dana, gus        (4 events)
 *   either  -> dana, fay, gus   (5 events)  — strictly more than either side
 */
function seed() {
  const domain = site.domain;
  const person = (id, userAgent, country) => ({
    visitorId: id,
    userAgent,
    headers: { 'cf-ipcountry': country },
  });

  const dana = person('dana-0000000000000000', CHROME_UA, 'FR');
  const erik = person('erik-0000000000000000', FIREFOX_UA, 'DE');
  const fay = person('fay-00000000000000000', CHROME_UA, 'DE');
  const gus = person('gus-00000000000000000', FIREFOX_UA, 'FR');

  track({ domain, path: '/pricing' }, { ...dana, timestamp: at(9, 0) });
  track({ domain, path: '/docs/getting-started' }, { ...dana, timestamp: at(9, 5) });
  track({ domain, path: '/blog/changelog' }, { ...dana, timestamp: at(15, 0) });

  track({ domain, path: '/pricing' }, { ...erik, timestamp: at(10, 0) });
  track({ domain, path: '/checkout' }, { ...erik, timestamp: at(10, 10) });

  track({ domain, path: '/blog/hello' }, { ...fay, timestamp: at(11, 0) });

  track({ domain, path: '/docs/api' }, { ...gus, timestamp: at(12, 0) });
}

/** A scope over the fixture day, optionally filtered (wire format). */
function scopeFor(filters = []) {
  return new Scope({ site, range: { start: START, end: END }, filters: parseFilters(filters), goals });
}

/** visitors + events, the two numbers every assertion below is about. */
function counts(filters) {
  const metrics = aggregate(scopeFor(filters));
  return { visitors: metrics.visitors, events: metrics.events };
}

before(async () => {
  await withDatabase('filters');
  site = createSite({ domain: 'filters.example', timezone: 'UTC', currency: 'EUR' });
  seed();
  createGoal(site.id, { type: 'page', page_path: '/checkout', display_name: 'Checkout' });
  goals = listGoals(site.id);
});

after(closeDatabase);

// --------------------------------------------------------------------------

describe('the flat filter list still behaves exactly as it did', () => {
  it('counts the unfiltered day', () => {
    assert.deepEqual(counts([]), { visitors: 4, events: 7 });
  });

  it('filters with `is`', () => {
    assert.deepEqual(counts([['is', 'visit:browser', ['Firefox']]]), { visitors: 2, events: 3 });
  });

  it('filters with `is` on several values at once', () => {
    assert.deepEqual(counts([['is', 'visit:browser', ['Firefox', 'Chrome']]]), { visitors: 4, events: 7 });
  });

  it('filters with `is_not`', () => {
    assert.deepEqual(counts([['is_not', 'visit:browser', ['Firefox']]]), { visitors: 2, events: 4 });
  });

  it('filters with `contains`', () => {
    assert.deepEqual(counts([['contains', 'event:page', ['/pric']]]), { visitors: 2, events: 2 });
    assert.equal(counts([['contains', 'event:page', ['nothing']]]).events, 0);
  });

  it('escapes LIKE wildcards in a `contains` value', () => {
    // '%' must be matched literally, not as "anything".
    assert.equal(counts([['contains', 'event:page', ['%']]]).events, 0);
    assert.equal(counts([['contains', 'event:page', ['_']]]).events, 0);
  });

  it('combines filters with AND', () => {
    assert.deepEqual(
      counts([
        ['is', 'visit:browser', ['Chrome']],
        ['contains', 'event:page', ['/blog']],
      ]),
      { visitors: 2, events: 2 },
    );
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

  it('rejects a dimension that only exists on Object.prototype', () => {
    // `DIMENSIONS['constructor']` is truthy by inheritance; a bare lookup would
    // have let it through and produced SQL naming an undefined column.
    assert.throws(() => parseFilters([['is', 'constructor', ['x']]]), /Unknown dimension/);
    assert.throws(() => parseFilters([['is', 'toString', ['x']]]), /Unknown dimension/);
  });
});

// --------------------------------------------------------------------------

describe('regular expressions', () => {
  it('matches a character class between anchors', () => {
    // /docs/getting-started and /docs/api, and nothing else.
    assert.deepEqual(counts([['matches', 'event:page', ['^/docs/[a-z-]+$']]]), { visitors: 2, events: 2 });
  });

  it('honours an anchor rather than searching anywhere', () => {
    assert.equal(counts([['matches', 'event:page', ['^/blog/']]]).events, 2);
    assert.equal(counts([['matches', 'event:page', ['^/changelog']]]).events, 0, '/blog/changelog does not start there');
    assert.equal(counts([['matches', 'event:page', ['changelog$']]]).events, 1);
  });

  it('is a regex, not a glob', () => {
    const pattern = '^/docs/[a-z-]+$';
    assert.equal(counts([['matches', 'event:page', [pattern]]]).events, 2);
    // GLOB reads ^ + and $ as literal characters, so the same string matches
    // nothing at all. That difference is the whole point of this change.
    assert.equal(counts([['glob', 'event:page', [pattern]]]).events, 0);
  });

  it('keeps GLOB available under its own name', () => {
    assert.equal(counts([['glob', 'event:page', ['/docs/*']]]).events, 2);
    assert.equal(counts([['glob', 'event:page', ['/docs/?pi']]]).events, 1, 'GLOB ? is a single character');
    assert.equal(counts([['glob_not', 'event:page', ['/docs/*']]]).events, 5);
  });

  it('negates with `matches_not`', () => {
    assert.equal(counts([['matches_not', 'event:page', ['^/docs/']]]).events, 5);
  });

  it('ORs several patterns together', () => {
    assert.equal(counts([['matches', 'event:page', ['^/docs/', '^/blog/']]]).events, 4);
  });

  it('refuses a pattern that does not compile, naming it', () => {
    assert.throws(
      () => parseFilters([['matches', 'event:page', ['(unclosed']]]),
      (err) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /Invalid regular expression: \(unclosed/);
        return true;
      },
    );
  });

  it('refuses the catastrophic backtracking shapes', () => {
    // (a+)+ on a long run of a's that never reaches the b is the classic bomb;
    // it would pin a core for every row in the table.
    for (const pattern of ['(a+)+b', '(a|a)*b', '((x)*y)+z', '(a?)+b']) {
      assert.throws(() => parseFilters([['matches', 'event:page', [pattern]]]), { status: 422 }, pattern);
    }
    assert.throws(() => parseFilters([['matches', 'event:page', ['(a)\\1']]]), /Backreferences/);
    assert.throws(() => parseFilters([['matches', 'event:page', ['(?=/x)/y']]]), /Lookahead/);
    assert.throws(() => parseFilters([['matches', 'event:page', ['(a){2000}']]]), /repeats more than/);
  });

  it('refuses two repetitions in a row that can match the same character', () => {
    // No group anywhere in these, so the rule above never sees them, but they
    // are the same bomb: `a*a*a*a*b` on sixty characters measured at 112ms per
    // row, and `a*` ten times over never returns at all.
    for (const pattern of ['a*a*b', 'a+a+a+a+b', 'a*a*a*a*a*a*a*a*a*a*b', '.*.*!', '[a-z]*[a-z]*!', '\\w+\\w+!', 'a{2,}a{2,}', '(ab)*(ab)*']) {
      assert.throws(() => parseFilters([['matches', 'event:page', [pattern]]]), { status: 422 }, pattern);
    }
  });

  it('still allows the patterns people actually write', () => {
    for (const pattern of [
      '^/docs/[a-z-]+$',
      '^/(en|fr)?/blog',
      '/(page|post)-\\d{1,4}$',
      '^/a/b/c/.*$',
      '^/blog/[0-9]{4}/[a-z-]+$',
      '.*\\.pdf$',
      'utm_[a-z]+=[a-z0-9]+',
      // Adjacent repetitions over *disjoint* characters cannot split the same
      // text between them, so they stay linear and stay allowed.
      '[0-9]+[a-z]+',
    ]) {
      assert.doesNotThrow(() => parseFilters([['matches', 'event:page', [pattern]]]), pattern);
    }
  });

  it('caps the pattern length', () => {
    assert.throws(
      () => parseFilters([['matches', 'event:page', ['a'.repeat(201)]]]),
      /Regular expression is too long/,
    );
    assert.doesNotThrow(() => parseFilters([['matches', 'event:page', ['a'.repeat(200)]]]));
  });

  it('applies to a custom property as well as a column', () => {
    assert.equal(counts([['matches', 'event:props:nope', ['^x$']]]).events, 0);
  });

  it('survives the CTE the graph is built from', () => {
    // timeseries() wraps the filtered events in a WITH clause; a function
    // registered on the connection has to resolve there too.
    const rows = timeseries(scopeFor([['matches', 'event:page', ['^/docs/']]]), 'hour', 'UTC');
    assert.equal(rows.length, 24);
    assert.equal(rows.reduce((sum, row) => sum + row.pageviews, 0), 2);
    assert.deepEqual([rows[9].pageviews, rows[12].pageviews], [1, 1]);
  });
});

// --------------------------------------------------------------------------

describe('boolean composition', () => {
  const chrome = ['is', 'visit:browser', ['Chrome']];
  const france = ['is', 'visit:country', ['FR']];

  it('or returns strictly more than either branch', () => {
    const either = counts([['or', [chrome, france]]]);
    const left = counts([chrome]);
    const right = counts([france]);

    assert.deepEqual(left, { visitors: 2, events: 4 }, 'dana and fay');
    assert.deepEqual(right, { visitors: 2, events: 4 }, 'dana and gus');
    assert.deepEqual(either, { visitors: 3, events: 5 }, 'dana, fay and gus');
    assert.ok(either.visitors > left.visitors && either.visitors > right.visitors);
  });

  it('and means the same thing as two entries in the flat list', () => {
    const nested = counts([['and', [chrome, ['contains', 'event:page', ['/blog']]]]]);
    const flat = counts([chrome, ['contains', 'event:page', ['/blog']]]);
    assert.deepEqual(nested, flat);
    assert.deepEqual(nested, { visitors: 2, events: 2 });
  });

  it('not complements its operand', () => {
    assert.deepEqual(counts([['not', chrome]]), { visitors: 2, events: 3 }, 'erik and gus');
    // Same answer as the leaf-level negation, which is the point.
    assert.deepEqual(counts([['not', chrome]]), counts([['is_not', 'visit:browser', ['Chrome']]]));
  });

  it('accepts a one element list for not', () => {
    assert.deepEqual(counts([['not', [chrome]]]), counts([['not', chrome]]));
  });

  it('nests, and evaluates the tree row by row', () => {
    // Chrome AND (France OR NOT /blog), four levels deep. Both Chrome visitors
    // reach the inner OR: dana passes it on France, fay fails it twice over —
    // she is German and her only pageview is /blog/hello.
    const tree = ['and', [chrome, ['or', [france, ['not', ['contains', 'event:page', ['/blog']]]]]]];
    assert.deepEqual(counts([tree]), { visitors: 1, events: 3 }, 'dana only');
  });

  it('composes with the flat list, which keeps meaning AND', () => {
    assert.deepEqual(
      counts([['or', [chrome, france]], ['contains', 'event:page', ['/blog']]]),
      { visitors: 2, events: 2 },
      '/blog/changelog and /blog/hello',
    );
  });

  it('flows through a breakdown, not only the totals', () => {
    const { results } = breakdown(scopeFor([['or', [chrome, france]]]), { dimension: 'event:page' });
    assert.deepEqual(
      results.map((r) => r.name).sort(),
      ['/blog/changelog', '/blog/hello', '/docs/api', '/docs/getting-started', '/pricing'],
    );
  });

  it('rejects an operand that is not a list of filters', () => {
    assert.throws(() => parseFilters([['and', []]]), /takes a list of filters/);
    assert.throws(() => parseFilters([['or', 'nope']]), /takes a list of filters/);
    assert.throws(() => parseFilters([['and']]), /Malformed filter/);
    assert.throws(() => parseFilters([[['is'], 'event:page', ['/']]]), /Malformed filter/);
    assert.throws(
      () => parseFilters([['is', ['is', 'event:page', ['/']], ['x']]]),
      /cannot be a nested filter/,
    );
  });
});

// --------------------------------------------------------------------------

describe('behavioural filters', () => {
  const sawPricing = ['is', 'event:page', ['/pricing']];
  const sawCheckout = ['is', 'event:page', ['/checkout']];

  it('widens from the matching event to everything that visitor did', () => {
    // The plain filter keeps two pageviews; has_done keeps all five events of
    // the two people who sent them.
    assert.deepEqual(counts([sawPricing]), { visitors: 2, events: 2 });
    assert.deepEqual(counts([['has_done', sawPricing]]), { visitors: 2, events: 5 });
  });

  it('carries the session metrics of every visit those visitors made', () => {
    const metrics = aggregate(scopeFor([['has_done', sawPricing]]));
    assert.equal(metrics.visits, 3, "dana's two visits and erik's one");
    assert.equal(metrics.pageviews, 5);
    assert.equal(metrics.bounce_rate, 33, 'D2 bounced, D1 and E1 did not');
    assert.equal(metrics.visit_duration, 300, '(300 + 0 + 600) / 3');
  });

  it('has_not_done is the complement over visitors, not over events', () => {
    assert.deepEqual(counts([['has_not_done', sawPricing]]), { visitors: 2, events: 2 }, 'fay and gus');
    assert.equal(
      counts([['has_done', sawPricing]]).visitors + counts([['has_not_done', sawPricing]]).visitors,
      counts([]).visitors,
    );
  });

  it('answers "saw the pricing page and then left"', () => {
    const leftWithoutBuying = ['and', [['has_done', sawPricing], ['has_not_done', sawCheckout]]];
    assert.deepEqual(counts([leftWithoutBuying]), { visitors: 1, events: 3 }, 'dana, all three of her events');
  });

  it('takes a goal as its operand', () => {
    assert.deepEqual(counts([['has_done', ['is', 'event:goal', ['Checkout']]]]), { visitors: 1, events: 2 }, 'erik');
    assert.deepEqual(counts([['has_not_done', ['is', 'event:goal', ['Checkout']]]]), { visitors: 3, events: 5 });
  });

  it('takes a session dimension as its operand', () => {
    // The subquery joins `visits` itself and re-declares both aliases; the
    // outer query must not be disturbed by that.
    assert.deepEqual(counts([['is', 'visit:entry_page', ['/pricing']]]), { visitors: 2, events: 4 }, 'D1 and E1 only');
    assert.deepEqual(
      counts([['has_done', ['is', 'visit:entry_page', ['/pricing']]]]),
      { visitors: 2, events: 5 },
      "plus dana's second visit, because it is the same visitor",
    );
  });

  it('scopes the subquery to the same period as the query', () => {
    const morning = new Scope({
      site,
      range: { start: START, end: at(10, 0) },
      filters: parseFilters([['has_done', sawCheckout]]),
      goals,
    });
    assert.equal(aggregate(morning).events, 0, 'erik reaches /checkout at 10:10, outside this window');
  });

  it('narrows a session breakdown too', () => {
    const { results } = breakdown(scopeFor([['has_done', sawPricing]]), { dimension: 'visit:entry_page' });
    assert.deepEqual(
      results.map((r) => [r.name, r.visits]).sort(),
      [['/blog/changelog', 1], ['/pricing', 2]],
    );
  });

  it('composes with a regex', () => {
    assert.deepEqual(
      counts([['has_done', ['matches', 'event:page', ['^/docs/[a-z-]+$']]]]),
      { visitors: 2, events: 4 },
      'dana (3 events) and gus (1)',
    );
  });
});

// --------------------------------------------------------------------------

describe('limits on the shape of a filter', () => {
  const leaf = ['is', 'visit:browser', ['Chrome']];
  const nest = (depth) => (depth <= 1 ? leaf : ['and', [nest(depth - 1)]]);

  it('allows five levels and refuses six', () => {
    assert.doesNotThrow(() => parseFilters([nest(5)]));
    assert.throws(() => parseFilters([nest(6)]), (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /nest more than 5 levels/);
      return true;
    });
  });

  it('allows forty nodes and refuses forty-one', () => {
    const withLeaves = (count) => ['or', Array.from({ length: count }, () => leaf)];
    assert.doesNotThrow(() => parseFilters([withLeaves(39)]), '1 branch + 39 leaves');
    assert.throws(() => parseFilters([withLeaves(40)]), (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /more than 40 conditions/);
      return true;
    });
  });

  it('still caps the flat list and the value list', () => {
    assert.throws(() => parseFilters(Array.from({ length: 21 }, () => leaf)), /Too many filters/);
    assert.throws(
      () => parseFilters([['is', 'visit:browser', Array.from({ length: 101 }, (_, i) => `b${i}`)]]),
      /Too many filter values/,
    );
  });
});

// --------------------------------------------------------------------------

describe('round-tripping through a saved segment', () => {
  /** Exactly what src/segments.js writes into the `segments` table. */
  const encode = (filters) => JSON.stringify(parseFilters(filters).map((f) => [f.operator, f.key, f.values]));

  it('re-parses a nested tree into the same query', () => {
    const tree = [
      ['and', [['has_done', ['is', 'event:page', ['/pricing']]], ['not', ['is', 'visit:browser', ['Firefox']]]]],
      ['matches', 'event:page', ['^/(docs|blog)/']],
    ];

    const stored = encode(tree);
    // Storing and re-reading must be a fixed point, or a segment would drift
    // every time somebody edited it.
    assert.equal(encode(JSON.parse(stored)), stored);
    assert.deepEqual(counts(JSON.parse(stored)), counts(tree));
    assert.deepEqual(counts(tree), { visitors: 1, events: 2 }, "dana's /docs and /blog pageviews");
  });

  it('leaves a flat list byte-identical to what came in', () => {
    const flat = [['is', 'visit:country', ['FR', 'BE']], ['contains_not', 'event:page', ['/x']]];
    assert.equal(encode(flat), JSON.stringify(flat));
  });
});

// --------------------------------------------------------------------------

describe('filter values are bound, never interpolated', () => {
  const INJECTION = "'); DROP TABLE events; --";
  const LEAF_OPERATORS = ['is', 'is_not', 'contains', 'contains_not', 'matches', 'matches_not', 'glob', 'glob_not'];

  it('runs the payload through every operator without executing it', () => {
    const total = countRows('events');

    for (const operator of LEAF_OPERATORS) {
      try {
        const metrics = aggregate(scopeFor([[operator, 'event:page', [INJECTION]]]));
        // No page contains that string, so the positive operators match nothing
        // and the negative ones match everything. Either way it was data.
        assert.equal(metrics.events, operator.endsWith('_not') ? total : 0, operator);
      } catch (err) {
        // The regex operators compile the value first, and this payload is not
        // a valid pattern — an unbalanced parenthesis. 422, never a SQL error.
        assert.equal(err.status, 422, `${operator}: ${err.message}`);
        assert.match(err.message, /Invalid regular expression/);
      }
    }

    // The same payload as a *valid* regex, so it actually reaches SQLite.
    assert.equal(aggregate(scopeFor([['matches', 'event:page', ["'\\); DROP TABLE events; --"]]])).events, 0);

    // And through the composed and behavioural operators, which build subqueries.
    assert.equal(aggregate(scopeFor([['not', ['is', 'event:page', [INJECTION]]]])).events, total);
    assert.equal(aggregate(scopeFor([['has_done', ['is', 'event:page', [INJECTION]]]])).events, 0);
    assert.equal(aggregate(scopeFor([['has_not_done', ['is', 'event:page', [INJECTION]]]])).events, total);
    assert.equal(aggregate(scopeFor([['or', [['is', 'event:page', [INJECTION]], ['is', 'event:page', ['/pricing']]]]])).events, 2);

    // A custom property name is user input too, and lands in a json path.
    assert.equal(aggregate(scopeFor([['is', `event:props:${INJECTION}`, ['x']]])).events, 0);

    assert.equal(countRows('events'), total, 'nothing was deleted');
    assert.equal(events().length, total);
    assert.equal(
      get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")?.name,
      'events',
      'the events table is still there',
    );
  });

  it('refuses the payload in the dimension slot instead of binding it', () => {
    assert.throws(() => parseFilters([['is', INJECTION, ['x']]]), /Unknown dimension/);
    assert.throws(() => parseFilters([[INJECTION, 'event:page', ['x']]]), /Unknown filter operator/);
  });
});
