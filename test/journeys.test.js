/**
 * Path exploration.
 *
 * One hand-built day on a dedicated site, small enough that every number below
 * can be counted from the table in `seed()`. If one of these tests fails, count
 * the rows in that comment before changing the assertion.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { CHROME_UA, FIREFOX_UA, closeDatabase, track, utc, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groupPath, journey, topPaths } from '../src/stats/journeys.js';
import { Scope, parseFilters } from '../src/stats/query.js';
import { createGoal, listGoals } from '../src/goals.js';
import { createSite } from '../src/sites.js';

const DAY = 86400;
const START = utc(2025, 6, 10, 0, 0, 0);
const END = START + DAY;
const at = (hour, minute = 0, second = 0) => utc(2025, 6, 10, hour, minute, second);

let site;
let deepSite;
let forkSite;
let goals;

/**
 * The whole dataset. One visit per visitor, every event inside the same hour,
 * so each row of this table is exactly one visit.
 *
 *   visitor  time      event                     page          collapsed walk
 *   -------  --------  ------------------------  ------------  --------------------------------
 *   a        09:00:00  pageview                  /             /  → /pricing → /signup
 *            09:01:00  pageview                  /pricing
 *            09:01:30  engagement (late beacon)  /             (ignored: not a navigation)
 *            09:02:00  pageview                  /signup
 *   b        10:00:00  pageview                  /             /  → /pricing → /signup
 *            10:01:00  pageview                  /pricing
 *            10:02:00  pageview                  /signup
 *   c        11:00:00  pageview                  /             /  → /pricing
 *            11:01:00  pageview                  /pricing
 *   d        12:00:00  pageview                  /             /  → /docs
 *            12:01:00  pageview                  /docs
 *   e (FF)   13:00:00  pageview                  /blog/one     /blog/one → /blog/two → /pricing
 *            13:01:00  pageview                  /blog/two
 *            13:02:00  pageview                  /pricing
 *   f        14:00:00  pageview                  /             /  → /features
 *            14:01:00  pageview                  /             (reload: collapsed away)
 *            14:01:30  Newsletter (not a goal)   /             (ignored: not a goal)
 *            14:02:00  pageview                  /features
 *   g        15:00:00  pageview                  /             /  → /pricing → Subscribe
 *            15:01:00  pageview                  /pricing
 *            15:02:00  Subscribe (a goal)        /pricing
 *
 *   7 visitors · 7 visits · goals: page /signup, event Subscribe
 *
 * The forward tree from every entry page:
 *
 *   root ''                                    7
 *     /                          6  85.7%      drop 0
 *       /pricing                 4  66.7%      drop 1  (c)
 *         /signup                2  50.0%      drop 2  terminal
 *         Subscribe              1  25.0%      drop 1  terminal
 *       /docs                    1  16.7%      drop 1  terminal
 *       /features                1  16.7%      drop 1  terminal
 *     /blog/one                  1  14.3%      drop 0
 *       /blog/two                1 100.0%      drop 0
 *         /pricing               1 100.0%      drop 1  terminal
 */
function seed() {
  const domain = site.domain;
  const who = (id, userAgent = CHROME_UA) => ({ visitorId: id, userAgent, ip: '203.0.113.20' });

  const a = who('a-0000000000000000000');
  track({ domain, path: '/' }, { ...a, timestamp: at(9, 0, 0) });
  track({ domain, path: '/pricing' }, { ...a, timestamp: at(9, 1, 0) });
  // A late engagement beacon for the page they already left. It must never
  // become a step, or this visit would read as / → /pricing → / → /signup.
  track({ domain, n: 'engagement', path: '/', e: { t: 30000, s: 60 } }, { ...a, timestamp: at(9, 1, 30) });
  track({ domain, path: '/signup' }, { ...a, timestamp: at(9, 2, 0) });

  const b = who('b-0000000000000000000');
  track({ domain, path: '/' }, { ...b, timestamp: at(10, 0, 0) });
  track({ domain, path: '/pricing' }, { ...b, timestamp: at(10, 1, 0) });
  track({ domain, path: '/signup' }, { ...b, timestamp: at(10, 2, 0) });

  const c = who('c-0000000000000000000');
  track({ domain, path: '/' }, { ...c, timestamp: at(11, 0, 0) });
  track({ domain, path: '/pricing' }, { ...c, timestamp: at(11, 1, 0) });

  const d = who('d-0000000000000000000');
  track({ domain, path: '/' }, { ...d, timestamp: at(12, 0, 0) });
  track({ domain, path: '/docs' }, { ...d, timestamp: at(12, 1, 0) });

  const e = who('e-0000000000000000000', FIREFOX_UA);
  track({ domain, path: '/blog/one' }, { ...e, timestamp: at(13, 0, 0) });
  track({ domain, path: '/blog/two' }, { ...e, timestamp: at(13, 1, 0) });
  track({ domain, path: '/pricing' }, { ...e, timestamp: at(13, 2, 0) });

  const f = who('f-0000000000000000000');
  track({ domain, path: '/' }, { ...f, timestamp: at(14, 0, 0) });
  track({ domain, path: '/' }, { ...f, timestamp: at(14, 1, 0) });
  // A custom event the site never declared a goal: noise, not a step.
  track({ domain, n: 'Newsletter', path: '/' }, { ...f, timestamp: at(14, 1, 30) });
  track({ domain, path: '/features' }, { ...f, timestamp: at(14, 2, 0) });

  const g = who('g-0000000000000000000');
  track({ domain, path: '/' }, { ...g, timestamp: at(15, 0, 0) });
  track({ domain, path: '/pricing' }, { ...g, timestamp: at(15, 1, 0) });
  track({ domain, n: 'Subscribe', path: '/pricing' }, { ...g, timestamp: at(15, 2, 0) });
}

/**
 * Two distinct parents that share a name, a visitor count and a child name.
 *
 *   /p1 → /cart → /x        /cart is reached twice, by two visitors each, and
 *   /p1 → /cart → /y        /x hangs off both. Every visible field of the two
 *   /p2 → /cart → /x        /cart nodes is identical, so `from` cannot tell a
 *   /p2 → /cart → /z        consumer which of them a child belongs to.
 */
function seedFork() {
  const walks = [
    ['/p1', '/cart', '/x'],
    ['/p1', '/cart', '/y'],
    ['/p2', '/cart', '/x'],
    ['/p2', '/cart', '/z'],
  ];
  walks.forEach((walk, n) => {
    const who = { visitorId: `fork-${n}-00000000000000`, userAgent: CHROME_UA };
    walk.forEach((page, i) => {
      track({ domain: forkSite.domain, path: page }, { ...who, timestamp: at(8, n, i) });
    });
  });
}

/** One visitor, one visit, 105 pageviews — past the per-visit ceiling of 100. */
function seedDeepVisit() {
  const who = { visitorId: 'deep-000000000000000', userAgent: CHROME_UA };
  for (let i = 0; i < 105; i += 1) {
    track({ domain: deepSite.domain, path: `/p${i}` }, { ...who, timestamp: at(9, 0, 0) + i });
  }
}

/** A scope over the fixture day, optionally filtered (wire format). */
function scopeFor(filters = []) {
  return new Scope({ site, range: { start: START, end: END }, filters: parseFilters(filters), goals });
}

const names = (level) => level.map((node) => node.name);

before(async () => {
  await withDatabase('journeys');
  site = createSite({ domain: 'journey.example', timezone: 'UTC' });
  deepSite = createSite({ domain: 'deep.example', timezone: 'UTC' });
  forkSite = createSite({ domain: 'fork.example', timezone: 'UTC' });
  seed();
  seedDeepVisit();
  seedFork();
  createGoal(site.id, { type: 'page', page_path: '/signup' });
  createGoal(site.id, { type: 'event', event_name: 'Subscribe' });
  goals = listGoals(site.id);
});

after(closeDatabase);

// --------------------------------------------------------------------------

describe('groupPath', () => {
  it('folds everything below the requested depth into a wildcard', () => {
    assert.equal(groupPath('/blog/2026/how-to'), '/blog/*');
    assert.equal(groupPath('/blog/2026/how-to', 2), '/blog/2026/*');
    assert.equal(groupPath('/blog/2026/how-to', 3), '/blog/2026/how-to');
    assert.equal(groupPath('/blog/a'), '/blog/*');
  });

  it('leaves a path that has nothing below it alone', () => {
    assert.equal(groupPath('/blog'), '/blog');
    assert.equal(groupPath('/'), '/');
    assert.equal(groupPath('/blog/', 1), '/blog', 'a trailing slash is not a level');
  });

  it('never groups a name that is not a path', () => {
    assert.equal(groupPath('Subscribe'), 'Subscribe');
    assert.equal(groupPath(''), '');
  });

  it('clamps a nonsense depth to one level', () => {
    assert.equal(groupPath('/a/b/c', 0), '/a/*');
    assert.equal(groupPath('/a/b/c', -3), '/a/*');
    assert.equal(groupPath('/a/b/c', 'x'), '/a/*');
  });
});

// --------------------------------------------------------------------------

describe('journey — forward from every entry page', () => {
  it('counts the first hop out of the entry pages', () => {
    const report = journey(scopeFor());
    assert.equal(report.direction, 'forward');
    assert.deepEqual(report.root, { name: '', visitors: 7 });
    assert.equal(report.total_visits, 7);
    assert.equal(report.truncated, false);

    assert.deepEqual(report.steps[0], [
      { name: '/', visitors: 6, share: 85.7, dropoff: 0, terminal: false, from: '', parent: -1 },
      { name: '/blog/one', visitors: 1, share: 14.3, dropoff: 0, terminal: false, from: '', parent: -1 },
    ]);
  });

  it('shares against the parent, not against the total', () => {
    const report = journey(scopeFor());
    // 4 of the 6 visitors who landed on / went to /pricing: 66.7%, not 4/7.
    assert.deepEqual(report.steps[1], [
      { name: '/pricing', visitors: 4, share: 66.7, dropoff: 1, terminal: false, from: '/', parent: 0 },
      { name: '/docs', visitors: 1, share: 16.7, dropoff: 1, terminal: true, from: '/', parent: 0 },
      { name: '/features', visitors: 1, share: 16.7, dropoff: 1, terminal: true, from: '/', parent: 0 },
      { name: '/blog/two', visitors: 1, share: 100, dropoff: 0, terminal: false, from: '/blog/one', parent: 1 },
    ]);
  });

  it('marks the exits and counts who left there', () => {
    const report = journey(scopeFor());
    assert.deepEqual(report.steps[2], [
      { name: '/signup', visitors: 2, share: 50, dropoff: 2, terminal: true, from: '/pricing', parent: 0 },
      { name: 'Subscribe', visitors: 1, share: 25, dropoff: 1, terminal: true, from: '/pricing', parent: 0 },
      { name: '/pricing', visitors: 1, share: 100, dropoff: 1, terminal: true, from: '/blog/two', parent: 3 },
    ]);
    assert.equal(report.steps.length, 3, 'nothing continues past step three');
  });

  it('groups a level by parent, in the parent order of the level above', () => {
    const report = journey(scopeFor());
    // Children of / come before children of /blog/one because / outranks it,
    // which is what lets a consumer rebuild the tree from two flat arrays.
    assert.deepEqual(names(report.steps[0]), ['/', '/blog/one']);
    assert.deepEqual(report.steps[1].map((n) => n.from), ['/', '/', '/', '/blog/one']);
  });

  it('ignores engagement pings and events that are not goals', () => {
    const report = journey(scopeFor());
    const every = report.steps.flat().map((node) => node.name);
    assert.ok(!every.includes('Newsletter'), 'an undeclared custom event is not a step');
    // a's late engagement beacon for / would show up here as a second '/'.
    assert.deepEqual(names(report.steps[2]), ['/signup', 'Subscribe', '/pricing']);
  });

  it('collapses an immediate self-repeat', () => {
    // f loaded / twice before /features, so / must not be its own child.
    const report = journey(scopeFor());
    const selfLoop = report.steps[1].find((node) => node.name === '/' && node.from === '/');
    assert.equal(selfLoop, undefined);
    assert.equal(report.steps[1].find((n) => n.name === '/features').visitors, 1);
  });

  it('stops at the requested depth', () => {
    assert.equal(journey(scopeFor(), { steps: 1 }).steps.length, 1);
    assert.equal(journey(scopeFor(), { steps: 2 }).steps.length, 2);
    assert.equal(journey(scopeFor(), { steps: 99 }).steps.length, 3, 'the data runs out first');
  });
});

// --------------------------------------------------------------------------

describe('journey — anchored on a page', () => {
  it('walks forward from the named page only', () => {
    const report = journey(scopeFor(), { startPage: '/pricing' });
    assert.equal(report.direction, 'forward');
    // a, b, c, e and g reached /pricing; d and f never did.
    assert.deepEqual(report.root, { name: '/pricing', visitors: 5 });
    assert.equal(report.total_visits, 5);
    assert.deepEqual(report.steps, [
      [
        { name: '/signup', visitors: 2, share: 40, dropoff: 2, terminal: true, from: '/pricing', parent: -1 },
        { name: 'Subscribe', visitors: 1, share: 20, dropoff: 1, terminal: true, from: '/pricing', parent: -1 },
      ],
    ]);
  });

  it('reaches the page even when it is not the entry page', () => {
    // e arrived at /pricing on their third step, from /blog/two.
    const report = journey(scopeFor(), { startPage: '/blog/two' });
    assert.deepEqual(report.root, { name: '/blog/two', visitors: 1 });
    assert.deepEqual(report.steps[0], [
      { name: '/pricing', visitors: 1, share: 100, dropoff: 1, terminal: true, from: '/blog/two', parent: -1 },
    ]);
  });

  it('is empty when nobody saw the page', () => {
    const report = journey(scopeFor(), { startPage: '/nope' });
    assert.deepEqual(report, {
      direction: 'forward',
      root: { name: '/nope', visitors: 0 },
      steps: [],
      total_visits: 0,
      truncated: false,
    });
  });
});

// --------------------------------------------------------------------------

describe('journey — backward', () => {
  it('walks back from the named page', () => {
    const report = journey(scopeFor(), { endPage: '/signup' });
    assert.equal(report.direction, 'backward');
    assert.deepEqual(report.root, { name: '/signup', visitors: 2 });
    assert.equal(report.total_visits, 2);
    assert.deepEqual(report.steps, [
      [{ name: '/pricing', visitors: 2, share: 100, dropoff: 0, terminal: false, from: '/signup', parent: -1 }],
      // Going backwards, "dropoff" is where the trail ends: both visits began
      // on / and there is nothing before it.
      [{ name: '/', visitors: 2, share: 100, dropoff: 2, terminal: true, from: '/pricing', parent: 0 }],
    ]);
  });

  it('walks back from every exit page when none is named', () => {
    const report = journey(scopeFor(), { endPage: '' });
    assert.equal(report.direction, 'backward');
    assert.deepEqual(report.root, { name: '', visitors: 7 });
    assert.deepEqual(
      report.steps[0].map((node) => [node.name, node.visitors]),
      [['/pricing', 2], ['/signup', 2], ['/docs', 1], ['/features', 1], ['Subscribe', 1]],
    );
  });

  it('prefers startPage when both ends are given', () => {
    const report = journey(scopeFor(), { startPage: '/pricing', endPage: '/signup' });
    assert.equal(report.direction, 'forward');
    assert.equal(report.root.name, '/pricing');
  });
});

// --------------------------------------------------------------------------

describe('journey — folding and grouping', () => {
  it('folds everything past the limit into Other, per parent', () => {
    const report = journey(scopeFor(), { limit: 1 });

    assert.deepEqual(report.steps[0], [
      { name: '/', visitors: 6, share: 85.7, dropoff: 0, terminal: false, from: '', parent: -1 },
      { name: 'Other', visitors: 1, share: 14.3, dropoff: 0, terminal: false, from: '', parent: -1 },
    ]);
    assert.deepEqual(report.steps[1], [
      { name: '/pricing', visitors: 4, share: 66.7, dropoff: 1, terminal: false, from: '/', parent: 0 },
      // /docs and /features together: two visitors, both of whom left there.
      { name: 'Other', visitors: 2, share: 33.3, dropoff: 2, terminal: true, from: '/', parent: 0 },
    ]);
    assert.deepEqual(report.steps[2], [
      { name: '/signup', visitors: 2, share: 50, dropoff: 2, terminal: true, from: '/pricing', parent: 0 },
      { name: 'Other', visitors: 1, share: 25, dropoff: 1, terminal: true, from: '/pricing', parent: 0 },
    ]);
    assert.equal(report.steps.length, 3);
  });

  it('never expands Other', () => {
    // /blog/one was folded at step one, so /blog/two must not appear at step two.
    const report = journey(scopeFor(), { limit: 1 });
    assert.ok(!report.steps.flat().some((node) => node.from === 'Other'));
    assert.ok(!report.steps.flat().some((node) => node.name === '/blog/two'));

    // Said by index rather than by name: nothing in a level points at an
    // "Other" of the level above, whatever it happens to be called.
    report.steps.forEach((level, depth) => {
      if (!depth) return;
      const above = report.steps[depth - 1];
      for (const node of level) {
        assert.notEqual(above[node.parent].name, 'Other', `${node.name} hangs off an Other`);
      }
    });
  });

  it('groups directories', () => {
    const report = journey(scopeFor(), { groupDirectories: true });
    assert.deepEqual(names(report.steps[0]), ['/', '/blog/*']);

    // /blog/one → /blog/two is one hop inside /blog/*, so it collapses and the
    // visit reads /blog/* → /pricing.
    const fromBlog = report.steps[1].filter((node) => node.from === '/blog/*');
    assert.deepEqual(fromBlog, [
      { name: '/pricing', visitors: 1, share: 100, dropoff: 1, terminal: true, from: '/blog/*', parent: 1 },
    ]);
    // e's walk is one hop shorter, so the /blog branch is done by step two —
    // but / → /pricing → /signup still runs to step three.
    assert.equal(report.steps.length, 3);
    assert.deepEqual(report.steps[2].map((n) => n.from), ['/pricing', '/pricing']);
  });

  it('anchors on a grouped name as readily as on a raw path', () => {
    const report = journey(scopeFor(), { startPage: '/blog/*', groupDirectories: true });
    assert.deepEqual(report.root, { name: '/blog/*', visitors: 1 });
    assert.deepEqual(names(report.steps[0]), ['/pricing']);
  });
});

// --------------------------------------------------------------------------

describe('journey — rebuilding the tree', () => {
  const forkReport = () =>
    journey(new Scope({ site: forkSite, range: { start: START, end: END }, goals: [] }), { steps: 3 });

  it('keeps two parents that share a name apart', () => {
    const report = forkReport();
    // Both /cart nodes are identical on the wire but for `parent`, and both
    // have a child called /x. Only the index says which /x belongs to which.
    assert.deepEqual(names(report.steps[1]), ['/cart', '/cart']);
    assert.deepEqual(report.steps[1].map((n) => n.from), ['/p1', '/p2']);
    assert.deepEqual(report.steps[1].map((n) => n.parent), [0, 1]);

    assert.deepEqual(
      report.steps[2].map((n) => [n.parent, n.name]),
      [[0, '/x'], [0, '/y'], [1, '/x'], [1, '/z']],
    );
  });

  it('rebuilds to exactly the walks that were tracked', () => {
    const report = forkReport();
    // Walk the levels bottom-up through `parent` and reconstruct every root to
    // leaf path. Nothing but the index makes this possible.
    const paths = [];
    report.steps.forEach((level, depth) => {
      level.forEach((node, index) => {
        const below = report.steps[depth + 1] || [];
        if (below.some((child) => child.parent === index)) return; // not a leaf
        const path = [node.name];
        let at = node.parent;
        for (let up = depth - 1; up >= 0; up -= 1) {
          path.unshift(report.steps[up][at].name);
          at = report.steps[up][at].parent;
        }
        paths.push(path.join(' > '));
      });
    });
    assert.deepEqual(paths.sort(), [
      '/p1 > /cart > /x',
      '/p1 > /cart > /y',
      '/p2 > /cart > /x',
      '/p2 > /cart > /z',
    ]);
  });

  it('points the first level at the root', () => {
    assert.deepEqual(journey(scopeFor()).steps[0].map((n) => n.parent), [-1, -1]);
    assert.deepEqual(journey(scopeFor(), { startPage: '/pricing' }).steps[0].map((n) => n.parent), [-1, -1]);
  });

  it('never points outside the level above', () => {
    for (const options of [{}, { limit: 1 }, { groupDirectories: true }, { endPage: '' }]) {
      const report = journey(scopeFor(), options);
      report.steps.forEach((level, depth) => {
        const above = depth ? report.steps[depth - 1].length : 0;
        for (const node of level) {
          const ok = depth ? node.parent >= 0 && node.parent < above : node.parent === -1;
          assert.ok(ok, `${JSON.stringify(options)} step ${depth}: ${node.name} -> parent ${node.parent}`);
        }
      });
    }
  });
});

// --------------------------------------------------------------------------

describe('journey — scope', () => {
  it('walks the whole visit when any one of its events matches the filter', () => {
    // Only d's /docs pageview matches, but the journey still starts at /.
    const report = journey(scopeFor([['is', 'event:page', ['/docs']]]));
    assert.deepEqual(report.root, { name: '', visitors: 1 });
    assert.equal(report.total_visits, 1);
    assert.deepEqual(report.steps, [
      [{ name: '/', visitors: 1, share: 100, dropoff: 0, terminal: false, from: '', parent: -1 }],
      [{ name: '/docs', visitors: 1, share: 100, dropoff: 1, terminal: true, from: '/', parent: 0 }],
    ]);
  });

  it('honours a session filter', () => {
    const report = journey(scopeFor([['is', 'visit:browser', ['Firefox']]]));
    assert.deepEqual(report.root, { name: '', visitors: 1 });
    assert.deepEqual(names(report.steps[0]), ['/blog/one']);
    assert.deepEqual(names(report.steps[1]), ['/blog/two']);
  });

  it('is scoped to one site', () => {
    const other = new Scope({ site: deepSite, range: { start: START, end: END }, goals: [] });
    assert.deepEqual(names(journey(other).steps[0]), ['/p0']);
  });

  it('returns an empty shape for a window with no traffic', () => {
    const empty = new Scope({ site, range: { start: START - 7 * DAY, end: START - DAY }, goals });
    assert.deepEqual(journey(empty), {
      direction: 'forward',
      root: { name: '', visitors: 0 },
      steps: [],
      total_visits: 0,
      truncated: false,
    });
    assert.deepEqual(topPaths(empty), { paths: [], total: 0 });
  });

  it('flags a visit longer than the per-visit ceiling', () => {
    const deep = new Scope({ site: deepSite, range: { start: START, end: END }, goals: [] });
    assert.equal(journey(deep).truncated, true, '105 pageviews in one visit, ceiling is 100');
    assert.equal(journey(scopeFor()).truncated, false);
  });
});

// --------------------------------------------------------------------------

describe('topPaths', () => {
  it('ranks the whole sequences and counts the visitors on each', () => {
    const { paths, total } = topPaths(scopeFor());
    assert.equal(total, 7);
    assert.equal(paths.length, 6);

    assert.deepEqual(paths[0], {
      steps: ['/', '/pricing', '/signup'],
      visitors: 2,
      share: 28.6,
      converted: true,
    });

    const byPath = Object.fromEntries(paths.map((p) => [p.steps.join(' > '), p]));
    assert.deepEqual(
      Object.fromEntries(paths.map((p) => [p.steps.join(' > '), [p.visitors, p.share, p.converted]])),
      {
        '/ > /pricing > /signup': [2, 28.6, true],
        '/ > /pricing > Subscribe': [1, 14.3, true],
        '/ > /pricing': [1, 14.3, false],
        '/ > /docs': [1, 14.3, false],
        '/ > /features': [1, 14.3, false],
        '/blog/one > /blog/two > /pricing': [1, 14.3, false],
      },
    );
    assert.equal(byPath['/ > /docs'].steps.length, 2);

    const counts = paths.map((p) => p.visitors);
    assert.deepEqual(counts, [...counts].sort((x, y) => y - x), 'ranked by visitors');
  });

  it('truncates a long visit to `length` steps, outcome included', () => {
    const { paths, total } = topPaths(scopeFor(), { length: 2 });
    assert.equal(total, 7);
    assert.deepEqual(paths[0], {
      steps: ['/', '/pricing'],
      visitors: 4,
      share: 57.1,
      // /signup and Subscribe both happen on step three, outside this window.
      converted: false,
    });
    assert.deepEqual(
      paths.map((p) => [p.steps.join(' > '), p.visitors]),
      [
        ['/ > /pricing', 4],
        ['/ > /docs', 1],
        ['/ > /features', 1],
        ['/blog/one > /blog/two', 1],
      ],
    );
  });

  it('keeps a one step ranking to the entry pages', () => {
    const { paths } = topPaths(scopeFor(), { length: 1 });
    assert.deepEqual(
      paths.map((p) => [p.steps, p.visitors]),
      [[['/'], 6], [['/blog/one'], 1]],
    );
  });

  it('honours the limit', () => {
    assert.equal(topPaths(scopeFor(), { limit: 2 }).paths.length, 2);
    assert.equal(topPaths(scopeFor(), { limit: 2 }).total, 7, 'the total is not the page size');
  });

  it('respects the scope', () => {
    const { paths, total } = topPaths(scopeFor([['is', 'visit:browser', ['Firefox']]]));
    assert.equal(total, 1);
    assert.deepEqual(paths, [
      { steps: ['/blog/one', '/blog/two', '/pricing'], visitors: 1, share: 100, converted: false },
    ]);
  });
});
