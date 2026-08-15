/**
 * Timezone maths.
 *
 * `src/util/time.js` has no dependencies (not even config), so this file talks
 * to it directly — no database, no environment. Every expectation is written
 * against a *fixed* `now`, so the suite cannot start failing next month.
 *
 * The interesting cases are the two European DST transitions:
 *   2025-03-30  02:00 -> 03:00  (a 23 hour day, 02:00-02:59 never happens)
 *   2025-10-26  03:00 -> 02:00  (a 25 hour day, 02:00-02:59 happens twice)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  addMonths,
  buildBuckets,
  comparisonRange,
  formatYmd,
  formatYmdHm,
  humanDuration,
  isValidTimezone,
  parseYmd,
  pickInterval,
  resolveRange,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  tzOffsetSeconds,
  zonedParts,
  zonedToUnix,
} from '../src/util/time.js';

const PARIS = 'Europe/Paris';
const KOLKATA = 'Asia/Kolkata'; // +05:30, never observes DST
const CHATHAM = 'Pacific/Chatham'; // +12:45 / +13:45
const NEW_YORK = 'America/New_York';

const DAY = 86400;
const HOUR = 3600;

/** Unix seconds for a UTC wall clock. */
const utc = (y, m, d, hh = 0, mm = 0, ss = 0) => Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);

/** 2025-06-10 14:30:00 UTC — the fixed "now" every relative period resolves against. */
const NOW = utc(2025, 6, 10, 14, 30);

/**
 * Buckets must tile the requested window: no gap, no overlap, first bucket at
 * or before `start` (interval alignment may reach back), last bucket ending
 * exactly on `end`.
 */
function assertTiles(buckets, start, end) {
  assert.ok(buckets.length > 0, 'expected at least one bucket');
  assert.ok(buckets[0].start <= start, 'first bucket must not start after the range');
  for (const bucket of buckets) {
    assert.ok(bucket.start < bucket.end, `empty bucket at ${bucket.iso}`);
  }
  for (let i = 1; i < buckets.length; i += 1) {
    assert.equal(buckets[i].start, buckets[i - 1].end, `gap or overlap before bucket ${i}`);
  }
  assert.equal(buckets[buckets.length - 1].end, end, 'last bucket must end on the range end');
  assert.deepEqual(
    buckets.map((b) => b.index),
    buckets.map((_, i) => i),
  );
}

// --------------------------------------------------------------------------

describe('resolveRange', () => {
  const range = (period, extra = {}) => resolveRange({ period, ...extra }, 'UTC', NOW);
  const ymd = (t) => formatYmd(t, 'UTC');

  it('resolves realtime as the last 30 minutes, inclusive of now', () => {
    const r = range('realtime');
    assert.equal(r.start, NOW - 30 * 60);
    assert.equal(r.end, NOW + 1);
    assert.equal(r.interval, 'minute');
  });

  it('resolves day and yesterday to whole calendar days', () => {
    const today = range('day');
    assert.equal(ymd(today.start), '2025-06-10');
    assert.equal(ymd(today.end), '2025-06-11');
    assert.equal(today.end - today.start, DAY);
    assert.equal(today.interval, 'hour');

    const yesterday = range('yesterday');
    assert.equal(ymd(yesterday.start), '2025-06-09');
    assert.equal(yesterday.end, today.start);
    assert.equal(yesterday.interval, 'hour');
  });

  it('resolves the rolling day windows inclusive of today', () => {
    for (const [period, days, interval] of [
      ['7d', 7, 'day'],
      ['28d', 28, 'day'],
      ['30d', 30, 'day'],
      ['91d', 91, 'week'],
    ]) {
      const r = range(period);
      assert.equal(r.end - r.start, days * DAY, `${period} span`);
      assert.equal(ymd(r.end), '2025-06-11', `${period} ends tomorrow`);
      assert.equal(r.interval, interval, `${period} interval`);
    }
    assert.equal(ymd(range('7d').start), '2025-06-04');
    assert.equal(ymd(range('30d').start), '2025-05-12');
  });

  it('resolves month as month-to-date and last_month as the whole previous month', () => {
    const month = range('month');
    assert.equal(ymd(month.start), '2025-06-01');
    assert.equal(ymd(month.end), '2025-06-11'); // clamped to tomorrow
    assert.equal(month.interval, 'day');

    const last = range('last_month');
    assert.equal(ymd(last.start), '2025-05-01');
    assert.equal(ymd(last.end), '2025-06-01');
    assert.equal(last.end - last.start, 31 * DAY);
  });

  it('resolves the multi-month windows from the first of the month', () => {
    const six = range('6mo');
    assert.equal(ymd(six.start), '2025-01-01');
    assert.equal(six.interval, 'month');

    const twelve = range('12mo');
    assert.equal(ymd(twelve.start), '2024-07-01');
    assert.equal(twelve.interval, 'month');

    const year = range('year');
    assert.equal(ymd(year.start), '2025-01-01');
    assert.equal(ymd(year.end), '2025-06-11'); // year-to-date
    assert.equal(year.interval, 'month');
  });

  it('leaves the start open for the all-time period', () => {
    const all = range('all');
    assert.equal(all.start, null);
    assert.equal(ymd(all.end), '2025-06-11');
    assert.equal(all.interval, 'month');
  });

  it('resolves a custom range as an inclusive pair of dates', () => {
    const r = range('custom', { from: '2025-01-05', to: '2025-01-09' });
    assert.equal(ymd(r.start), '2025-01-05');
    assert.equal(ymd(r.end), '2025-01-10'); // half open: the 9th is included
    assert.equal(r.end - r.start, 5 * DAY);
    assert.equal(r.interval, 'day');
  });

  it('picks the interval for a custom range from its span', () => {
    const wide = range('custom', { from: '2023-01-01', to: '2025-01-01' });
    assert.equal(wide.interval, 'month');
    // A single day is short enough to be shown hour by hour.
    const narrow = range('custom', { from: '2025-01-01', to: '2025-01-01' });
    assert.equal(narrow.end - narrow.start, DAY);
    assert.equal(narrow.interval, 'hour');
    const week = range('custom', { from: '2025-01-01', to: '2025-01-07' });
    assert.equal(week.interval, 'day');
  });

  it('falls back to 30d for an unknown period or a broken custom range', () => {
    const fallback = range('30d');
    for (const bad of [range('bogus'), range('custom'), range('custom', { from: 'nope', to: 'nah' })]) {
      assert.equal(bad.period, '30d');
      assert.equal(bad.start, fallback.start);
      assert.equal(bad.end, fallback.end);
    }
  });

  it('anchors relative periods on the `date` parameter', () => {
    const r = resolveRange({ period: 'day', date: '2024-02-29' }, 'UTC', NOW);
    assert.equal(ymd(r.start), '2024-02-29');
    assert.equal(ymd(r.end), '2024-03-01');
    assert.equal(r.date, '2024-02-29');

    const anchoredMonth = resolveRange({ period: 'month', date: '2025-03-15' }, 'UTC', NOW);
    assert.equal(ymd(anchoredMonth.start), '2025-03-01');
    assert.equal(ymd(anchoredMonth.end), '2025-03-16');

    const anchoredLast = resolveRange({ period: 'last_month', date: '2025-03-15' }, 'UTC', NOW);
    assert.equal(ymd(anchoredLast.start), '2025-02-01');
    assert.equal(ymd(anchoredLast.end), '2025-03-01');
  });

  it('reports the timezone and the resolved anchor date', () => {
    const r = resolveRange({ period: 'day' }, KOLKATA, NOW);
    assert.equal(r.timezone, KOLKATA);
    // 14:30 UTC is already 20:00 in Kolkata, still the 10th.
    assert.equal(r.date, '2025-06-10');
    assert.equal(formatYmdHm(r.start, KOLKATA), '2025-06-10 00:00');
    assert.equal(r.end - r.start, DAY);
  });

  it('uses defaults when called with nothing at all', () => {
    const r = resolveRange();
    assert.equal(r.period, '30d');
    assert.equal(r.timezone, 'UTC');
    assert.equal(r.interval, 'day');
  });
});

// --------------------------------------------------------------------------

describe('DST — Europe/Paris', () => {
  it('knows the offset on each side of both transitions', () => {
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 1, 15)), 1 * HOUR);
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 7, 15)), 2 * HOUR);
    // 00:59:59 UTC is still CET, 01:00:00 UTC is already CEST.
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 3, 30, 0, 59, 59)), 1 * HOUR);
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 3, 30, 1, 0, 0)), 2 * HOUR);
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 10, 26, 0, 59, 59)), 2 * HOUR);
    assert.equal(tzOffsetSeconds(PARIS, utc(2025, 10, 26, 1, 0, 0)), 1 * HOUR);
  });

  it('makes the March transition day 23 hours long', () => {
    const r = resolveRange({ period: 'day', date: '2025-03-30' }, PARIS, NOW);
    assert.equal(r.end - r.start, 23 * HOUR);
    assert.equal(r.start, utc(2025, 3, 29, 23, 0, 0)); // 00:00 CET
    assert.equal(r.end, utc(2025, 3, 30, 22, 0, 0)); // 00:00 CEST the next day
    assert.equal(formatYmdHm(r.start, PARIS), '2025-03-30 00:00');
    assert.equal(formatYmdHm(r.end, PARIS), '2025-03-31 00:00');
  });

  it('makes the October transition day 25 hours long', () => {
    const r = resolveRange({ period: 'day', date: '2025-10-26' }, PARIS, NOW);
    assert.equal(r.end - r.start, 25 * HOUR);
    assert.equal(formatYmdHm(r.start, PARIS), '2025-10-26 00:00');
    assert.equal(formatYmdHm(r.end, PARIS), '2025-10-27 00:00');
  });

  it('emits 23 and 25 hourly buckets on the transition days', () => {
    const march = resolveRange({ period: 'day', date: '2025-03-30' }, PARIS, NOW);
    const marchBuckets = buildBuckets(march.start, march.end, 'hour', PARIS);
    assert.equal(marchBuckets.length, 23);
    assertTiles(marchBuckets, march.start, march.end);
    // 02:00 local never happens: the hour after 01:00 is labelled 03:00.
    assert.deepEqual(marchBuckets.slice(1, 3).map((b) => b.label), ['01:00', '03:00']);

    const october = resolveRange({ period: 'day', date: '2025-10-26' }, PARIS, NOW);
    const octoberBuckets = buildBuckets(october.start, october.end, 'hour', PARIS);
    assert.equal(octoberBuckets.length, 25);
    assertTiles(octoberBuckets, october.start, october.end);
    // 02:00 local happens twice — two distinct instants, one hour apart.
    const twos = octoberBuckets.filter((b) => b.label === '02:00');
    assert.equal(twos.length, 2);
    assert.equal(twos[1].start - twos[0].start, HOUR);
  });

  it('keeps calendar days whole when a rolling window crosses a transition', () => {
    const r = resolveRange({ period: '7d', date: '2025-10-28' }, PARIS, NOW);
    assert.equal(r.end - r.start, 7 * DAY + HOUR, 'the window gains the repeated hour');

    const buckets = buildBuckets(r.start, r.end, 'day', PARIS);
    assert.equal(buckets.length, 7);
    assertTiles(buckets, r.start, r.end);
    assert.deepEqual(
      buckets.map((b) => (b.end - b.start) / HOUR),
      [24, 24, 24, 24, 25, 24, 24],
    );
    assert.deepEqual(buckets.map((b) => b.iso), [
      '2025-10-22', '2025-10-23', '2025-10-24', '2025-10-25',
      '2025-10-26', '2025-10-27', '2025-10-28',
    ]);
  });

  it('resolves a wall-clock time inside the spring-forward gap to the instant after it', () => {
    // 02:30 does not exist on 2025-03-30; the documented behaviour is to return
    // the post-transition instant.
    const t = zonedToUnix(2025, 3, 30, 2, 30, 0, PARIS);
    assert.equal(formatYmdHm(t, PARIS), '2025-03-30 03:30');
    assert.equal(t, utc(2025, 3, 30, 1, 30));
  });

  it('resolves an ambiguous autumn wall-clock time to a real instant', () => {
    const t = zonedToUnix(2025, 10, 26, 2, 30, 0, PARIS);
    assert.equal(formatYmdHm(t, PARIS), '2025-10-26 02:30');
  });

  it('keeps day arithmetic on the wall clock across a transition', () => {
    const before = zonedToUnix(2025, 3, 29, 9, 0, 0, PARIS);
    const after = addDays(before, 1, PARIS);
    assert.equal(formatYmdHm(after, PARIS), '2025-03-30 09:00');
    assert.equal(after - before, 23 * HOUR, 'one calendar day, 23 real hours');
  });

  it('starts weeks on Monday in local time', () => {
    // 2025-06-12 is a Thursday.
    const week = startOfWeek(zonedToUnix(2025, 6, 12, 15, 0, 0, PARIS), PARIS);
    assert.equal(formatYmdHm(week, PARIS), '2025-06-09 00:00');
    // A Monday is its own week start.
    const monday = zonedToUnix(2025, 6, 9, 0, 0, 0, PARIS);
    assert.equal(startOfWeek(monday, PARIS), monday);
    // A Sunday belongs to the week that started six days earlier.
    assert.equal(startOfWeek(zonedToUnix(2025, 6, 15, 23, 59, 0, PARIS), PARIS), monday);
  });
});

// --------------------------------------------------------------------------

describe('buildBuckets', () => {
  it('tiles a UTC day into 24 hours', () => {
    const start = utc(2025, 6, 10);
    const end = utc(2025, 6, 11);
    const buckets = buildBuckets(start, end, 'hour', 'UTC');
    assert.equal(buckets.length, 24);
    assertTiles(buckets, start, end);
    assert.equal(buckets[0].label, '00:00');
    assert.equal(buckets[23].label, '23:00');
    assert.equal(buckets[9].iso, '2025-06-10 09:00');
  });

  it('tiles a rolling 30 day window into 30 days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', NOW);
    const buckets = buildBuckets(r.start, r.end, 'day', 'UTC');
    assert.equal(buckets.length, 30);
    assertTiles(buckets, r.start, r.end);
    assert.equal(buckets[0].iso, '2025-05-12');
    assert.equal(buckets[29].iso, '2025-06-10');
    assert.equal(buckets[29].label, '10 Jun');
  });

  it('clamps the final bucket to the end of the range', () => {
    const start = utc(2025, 6, 10);
    const end = utc(2025, 6, 10, 9, 30); // half an hour into the tenth bucket
    const buckets = buildBuckets(start, end, 'hour', 'UTC');
    assert.equal(buckets.length, 10);
    assertTiles(buckets, start, end);
    assert.equal(buckets[9].end - buckets[9].start, 1800);
  });

  it('aligns the first bucket back to the interval boundary', () => {
    const start = utc(2025, 6, 10, 9, 17, 42);
    const end = utc(2025, 6, 10, 9, 20, 0);
    const buckets = buildBuckets(start, end, 'minute', 'UTC');
    assertTiles(buckets, start, end);
    assert.equal(buckets[0].start, utc(2025, 6, 10, 9, 17));
    assert.equal(buckets.length, 3);
    assert.equal(buckets[0].end - buckets[0].start, 60);
  });

  it('tiles months across a year boundary in a non-UTC zone', () => {
    const start = zonedToUnix(2024, 11, 1, 0, 0, 0, NEW_YORK);
    const end = zonedToUnix(2025, 2, 1, 0, 0, 0, NEW_YORK);
    const buckets = buildBuckets(start, end, 'month', NEW_YORK);
    assert.equal(buckets.length, 3);
    assertTiles(buckets, start, end);
    assert.deepEqual(buckets.map((b) => b.label), ['Nov 2024', 'Dec 2024', 'Jan 2025']);
    // November 2024 contains the US fall-back transition, so it is an hour long.
    assert.equal(buckets[0].end - buckets[0].start, 30 * DAY + HOUR);
    assert.equal(buckets[1].end - buckets[1].start, 31 * DAY);
  });

  it('tiles weeks from Monday', () => {
    const r = resolveRange({ period: '91d' }, 'UTC', NOW);
    const buckets = buildBuckets(r.start, r.end, 'week', 'UTC');
    assertTiles(buckets, r.start, r.end);
    assert.ok(buckets[0].start <= r.start);
    for (const bucket of buckets.slice(1, -1)) {
      assert.equal(bucket.end - bucket.start, 7 * DAY);
    }
  });

  it('returns nothing for an empty or inverted range', () => {
    const t = utc(2025, 6, 10);
    assert.deepEqual(buildBuckets(t, t, 'day', 'UTC'), []);
    assert.deepEqual(buildBuckets(t, t - DAY, 'day', 'UTC'), []);
  });

  it('falls back to daily buckets for an unknown interval', () => {
    const start = utc(2025, 6, 10);
    const end = utc(2025, 6, 13);
    const buckets = buildBuckets(start, end, 'fortnight', 'UTC');
    assert.equal(buckets.length, 3);
    assertTiles(buckets, start, end);
  });
});

// --------------------------------------------------------------------------

describe('pickInterval', () => {
  const span = (seconds) => pickInterval(0, seconds);

  it('switches at each documented threshold', () => {
    assert.equal(span(2 * HOUR), 'minute');
    assert.equal(span(2 * HOUR + 1), 'hour');

    assert.equal(span(2 * DAY), 'hour');
    assert.equal(span(2 * DAY + 1), 'day');

    assert.equal(span(95 * DAY), 'day');
    assert.equal(span(95 * DAY + 1), 'week');

    assert.equal(span(400 * DAY), 'week');
    assert.equal(span(400 * DAY + 1), 'month');
  });

  it('keeps every range under a hundred buckets', () => {
    for (const seconds of [60, HOUR, DAY, 30 * DAY, 200 * DAY, 5 * 365 * DAY]) {
      const interval = pickInterval(0, seconds);
      const buckets = buildBuckets(0, seconds, interval, 'UTC');
      assert.ok(buckets.length <= 100, `${seconds}s produced ${buckets.length} ${interval} buckets`);
      assert.ok(buckets.length >= 1);
    }
  });
});

// --------------------------------------------------------------------------

describe('comparisonRange', () => {
  it('shifts by the exact length of the range for previous_period', () => {
    const r = resolveRange({ period: '7d' }, 'UTC', NOW);
    const previous = comparisonRange(r, 'previous_period', 'UTC');
    assert.equal(previous.end, r.start, 'the two ranges must touch');
    assert.equal(previous.end - previous.start, r.end - r.start);
    assert.equal(formatYmd(previous.start, 'UTC'), '2025-05-28');
  });

  it('shifts by twelve calendar months for year_over_year', () => {
    const r = resolveRange({ period: 'month', date: '2025-06-15' }, 'UTC', NOW);
    const previous = comparisonRange(r, 'year_over_year', 'UTC');
    assert.equal(formatYmd(previous.start, 'UTC'), '2024-06-01');
    assert.equal(formatYmd(previous.end, 'UTC'), '2024-06-16');
  });

  it('clamps 29 February to 28 February in a non-leap year', () => {
    const range = { start: utc(2024, 2, 29), end: utc(2024, 3, 1) };
    const previous = comparisonRange(range, 'year_over_year', 'UTC');
    assert.equal(formatYmd(previous.start, 'UTC'), '2023-02-28');
    assert.equal(formatYmd(previous.end, 'UTC'), '2023-03-01');
  });

  it('keeps local midnight across a DST boundary for year_over_year', () => {
    const range = {
      start: zonedToUnix(2025, 7, 1, 0, 0, 0, PARIS),
      end: zonedToUnix(2025, 8, 1, 0, 0, 0, PARIS),
    };
    const previous = comparisonRange(range, 'year_over_year', PARIS);
    assert.equal(formatYmdHm(previous.start, PARIS), '2024-07-01 00:00');
    assert.equal(formatYmdHm(previous.end, PARIS), '2024-08-01 00:00');
  });

  it('returns null when there is nothing to compare', () => {
    const r = resolveRange({ period: '7d' }, 'UTC', NOW);
    assert.equal(comparisonRange(r, 'off', 'UTC'), null);
    assert.equal(comparisonRange(r, '', 'UTC'), null);
    assert.equal(comparisonRange({ start: null, end: r.end }, 'previous_period', 'UTC'), null);
  });
});

// --------------------------------------------------------------------------

describe('humanDuration', () => {
  it('formats seconds, minutes and hours', () => {
    assert.equal(humanDuration(0), '0s');
    assert.equal(humanDuration(1), '1s');
    assert.equal(humanDuration(59), '59s');
    assert.equal(humanDuration(60), '1m 0s');
    assert.equal(humanDuration(90), '1m 30s');
    assert.equal(humanDuration(1438), '23m 58s');
    assert.equal(humanDuration(3599), '59m 59s');
    assert.equal(humanDuration(3600), '1h 0m');
    assert.equal(humanDuration(3661), '1h 1m');
    assert.equal(humanDuration(86399), '23h 59m');
  });

  it('rounds and never goes negative', () => {
    assert.equal(humanDuration(59.4), '59s');
    assert.equal(humanDuration(59.6), '1m 0s');
    assert.equal(humanDuration(-10), '0s');
    assert.equal(humanDuration(null), '0s');
    assert.equal(humanDuration(undefined), '0s');
    assert.equal(humanDuration(NaN), '0s');
  });
});

// --------------------------------------------------------------------------

describe('wall clock round trips', () => {
  const DATES = [
    [2025, 1, 1], [2025, 2, 28], [2024, 2, 29], [2025, 6, 10],
    [2025, 3, 30], [2025, 10, 26], [2025, 12, 31],
  ];

  for (const tz of [KOLKATA, CHATHAM, NEW_YORK, PARIS, 'UTC']) {
    it(`round trips dates through ${tz}`, () => {
      for (const [y, m, d] of DATES) {
        const noon = zonedToUnix(y, m, d, 12, 0, 0, tz);
        const expected = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        assert.equal(formatYmd(noon, tz), expected);
        assert.equal(formatYmdHm(noon, tz), `${expected} 12:00`);

        // Midnight is the start of the same day, and one second earlier belongs
        // to the previous day.
        const midnight = startOfDay(noon, tz);
        assert.equal(formatYmd(midnight, tz), expected);
        assert.equal(formatYmdHm(midnight, tz), `${expected} 00:00`);
        assert.notEqual(formatYmd(midnight - 1, tz), expected);

        const parts = zonedParts(noon, tz);
        assert.deepEqual(
          { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour },
          { year: y, month: m, day: d, hour: 12 },
        );
      }
    });
  }

  it('honours a half-hour offset zone', () => {
    // 18:30 UTC is exactly midnight in Kolkata (+05:30).
    assert.equal(zonedToUnix(2025, 6, 11, 0, 0, 0, KOLKATA), utc(2025, 6, 10, 18, 30));
    assert.equal(formatYmd(utc(2025, 6, 10, 18, 30), KOLKATA), '2025-06-11');
    assert.equal(formatYmd(utc(2025, 6, 10, 18, 29, 59), KOLKATA), '2025-06-10');
    assert.equal(tzOffsetSeconds(KOLKATA, NOW), 5 * HOUR + 1800);
  });

  it('honours a quarter-hour offset zone with DST', () => {
    assert.equal(tzOffsetSeconds(CHATHAM, utc(2025, 6, 10)), 12 * HOUR + 45 * 60);
    assert.equal(tzOffsetSeconds(CHATHAM, utc(2025, 1, 10)), 13 * HOUR + 45 * 60);
  });

  it('anchors month, year and day starts in local time', () => {
    const t = zonedToUnix(2025, 6, 10, 15, 45, 30, NEW_YORK);
    assert.equal(formatYmdHm(startOfDay(t, NEW_YORK), NEW_YORK), '2025-06-10 00:00');
    assert.equal(formatYmdHm(startOfMonth(t, NEW_YORK), NEW_YORK), '2025-06-01 00:00');
    assert.equal(formatYmdHm(startOfYear(t, NEW_YORK), NEW_YORK), '2025-01-01 00:00');
  });

  it('clamps month arithmetic to the last day of the target month', () => {
    const jan31 = zonedToUnix(2025, 1, 31, 0, 0, 0, 'UTC');
    assert.equal(formatYmd(addMonths(jan31, 1, 'UTC'), 'UTC'), '2025-02-28');
    assert.equal(formatYmd(addMonths(jan31, 13, 'UTC'), 'UTC'), '2026-02-28');
    assert.equal(formatYmd(addMonths(jan31, -1, 'UTC'), 'UTC'), '2024-12-31');
    assert.equal(formatYmd(addMonths(utc(2025, 3, 31), -1, 'UTC'), 'UTC'), '2025-02-28');
    // Crossing a year backwards must not land in the wrong year.
    assert.equal(formatYmd(addMonths(utc(2025, 1, 15), -1, 'UTC'), 'UTC'), '2024-12-15');
    assert.equal(formatYmd(addMonths(utc(2025, 1, 15), -13, 'UTC'), 'UTC'), '2023-12-15');
  });

  it('parses and rejects date strings', () => {
    assert.deepEqual(parseYmd('2025-06-10'), { year: 2025, month: 6, day: 10 });
    assert.deepEqual(parseYmd('  2025-06-10 '), { year: 2025, month: 6, day: 10 });
    for (const bad of ['2025-6-10', '20250610', 'yesterday', '', null, undefined, '2025-06-10T00:00']) {
      assert.equal(parseYmd(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('validates timezones', () => {
    assert.equal(isValidTimezone('UTC'), true);
    assert.equal(isValidTimezone(PARIS), true);
    assert.equal(isValidTimezone('Mars/Olympus_Mons'), false);
    assert.equal(isValidTimezone(''), false);
  });
});
