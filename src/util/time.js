/**
 * Timezone-correct date maths.
 *
 * Events are stored as unix seconds (UTC) but every dashboard number is
 * expressed in the *site's* timezone. SQLite has no IANA timezone database, so
 * all bucketing is computed here with `Intl` (which does know about DST) and
 * pushed down to SQL as plain unix-second ranges.
 */

const DAY = 86400;

const offsetFormatters = new Map();

function formatter(tz) {
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(tz, f);
  }
  return f;
}

/** True when `tz` is a timezone this runtime understands. */
export function isValidTimezone(tz) {
  try {
    formatter(tz).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `unix` in `tz`. */
export function zonedParts(unix, tz) {
  const parts = formatter(tz).formatToParts(new Date(unix * 1000));
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  if (out.hour === 24) out.hour = 0;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Seconds east of UTC in `tz` at instant `unix` (DST aware). */
export function tzOffsetSeconds(tz, unix) {
  const p = zonedParts(unix, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - unix;
}

/**
 * Unix timestamp of a wall-clock time in `tz`.
 * Converges in two passes, which is exact everywhere except inside a DST gap
 * (where the instant does not exist and we return the post-transition one).
 */
export function zonedToUnix(y, m, d, hh = 0, mm = 0, ss = 0, tz = 'UTC') {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;
  let ts = naive - tzOffsetSeconds(tz, naive);
  ts = naive - tzOffsetSeconds(tz, ts);
  return ts;
}

/** 'YYYY-MM-DD' for `unix` in `tz`. */
export function formatYmd(unix, tz) {
  const p = zonedParts(unix, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD HH:MM' for `unix` in `tz`. */
export function formatYmdHm(unix, tz) {
  const p = zonedParts(unix, tz);
  return `${formatYmd(unix, tz)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

export function startOfDay(unix, tz) {
  const p = zonedParts(unix, tz);
  return zonedToUnix(p.year, p.month, p.day, 0, 0, 0, tz);
}

export function startOfMonth(unix, tz) {
  const p = zonedParts(unix, tz);
  return zonedToUnix(p.year, p.month, 1, 0, 0, 0, tz);
}

export function startOfYear(unix, tz) {
  const p = zonedParts(unix, tz);
  return zonedToUnix(p.year, 1, 1, 0, 0, 0, tz);
}

/** Monday-based week start. */
export function startOfWeek(unix, tz) {
  const dayStart = startOfDay(unix, tz);
  const p = zonedParts(dayStart, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
  return addDays(dayStart, -((weekday + 6) % 7), tz);
}

/** Calendar-aware day arithmetic (keeps the wall-clock time stable across DST). */
export function addDays(unix, n, tz) {
  const p = zonedParts(unix, tz);
  return zonedToUnix(p.year, p.month, p.day + n, p.hour, p.minute, p.second, tz);
}

export function addMonths(unix, n, tz) {
  const p = zonedParts(unix, tz);
  const total = (p.year * 12) + (p.month - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return zonedToUnix(year, month, Math.min(p.day, lastDay), p.hour, p.minute, p.second, tz);
}

export const PERIODS = new Set([
  'realtime',
  'day',
  'yesterday',
  '7d',
  '28d',
  '30d',
  '91d',
  'month',
  'last_month',
  '6mo',
  '12mo',
  'year',
  'all',
  'custom',
]);

/**
 * Turn a dashboard query (`period`, `date`, `from`, `to`) into a concrete
 * half-open range [start, end) in unix seconds plus a sensible bucket size.
 *
 * `date` anchors relative periods so the dashboard's ‹ › arrows can walk back
 * in time without the client doing any date maths.
 */
export function resolveRange({ period = '30d', date = '', from = '', to = '' } = {}, tz = 'UTC', nowUnix = Math.floor(Date.now() / 1000)) {
  const p = PERIODS.has(period) ? period : '30d';
  const anchorYmd = parseYmd(date);
  const anchor = anchorYmd
    ? zonedToUnix(anchorYmd.year, anchorYmd.month, anchorYmd.day, 12, 0, 0, tz)
    : nowUnix;
  const today = startOfDay(anchor, tz);
  const tomorrow = addDays(today, 1, tz);

  let start;
  let end;
  let interval;

  switch (p) {
    case 'realtime':
      start = nowUnix - 30 * 60;
      end = nowUnix + 1;
      interval = 'minute';
      break;
    case 'day':
      start = today;
      end = tomorrow;
      interval = 'hour';
      break;
    case 'yesterday':
      start = addDays(today, -1, tz);
      end = today;
      interval = 'hour';
      break;
    case '7d':
      start = addDays(today, -6, tz);
      end = tomorrow;
      interval = 'day';
      break;
    case '28d':
      start = addDays(today, -27, tz);
      end = tomorrow;
      interval = 'day';
      break;
    case '30d':
      start = addDays(today, -29, tz);
      end = tomorrow;
      interval = 'day';
      break;
    case '91d':
      start = addDays(today, -90, tz);
      end = tomorrow;
      interval = 'week';
      break;
    case 'month':
      start = startOfMonth(anchor, tz);
      end = addMonths(start, 1, tz);
      if (end > tomorrow) end = tomorrow;
      interval = 'day';
      break;
    case 'last_month':
      start = addMonths(startOfMonth(anchor, tz), -1, tz);
      end = startOfMonth(anchor, tz);
      interval = 'day';
      break;
    case '6mo':
      start = startOfMonth(addMonths(today, -5, tz), tz);
      end = tomorrow;
      interval = 'month';
      break;
    case '12mo':
      start = startOfMonth(addMonths(today, -11, tz), tz);
      end = tomorrow;
      interval = 'month';
      break;
    case 'year':
      start = startOfYear(anchor, tz);
      end = Math.min(addMonths(start, 12, tz), tomorrow);
      interval = 'month';
      break;
    case 'custom': {
      const f = parseYmd(from);
      const t = parseYmd(to);
      if (!f || !t) return resolveRange({ period: '30d' }, tz, nowUnix);
      start = zonedToUnix(f.year, f.month, f.day, 0, 0, 0, tz);
      end = addDays(zonedToUnix(t.year, t.month, t.day, 0, 0, 0, tz), 1, tz);
      if (end < start) [start, end] = [end, start];
      interval = pickInterval(start, end);
      break;
    }
    case 'all':
    default:
      start = null; // caller substitutes the site's first event
      end = tomorrow;
      interval = 'month';
      break;
  }

  return { period: p, start, end, interval, timezone: tz, date: formatYmd(anchor, tz) };
}

/** Bucket size that keeps a range readable (≈ 10-90 points). */
export function pickInterval(start, end) {
  const span = end - start;
  if (span <= 2 * 3600) return 'minute';
  if (span <= 2 * DAY) return 'hour';
  if (span <= 95 * DAY) return 'day';
  if (span <= 400 * DAY) return 'week';
  return 'month';
}

/**
 * The previous comparable range.
 *  - 'previous_period' : the same length immediately before
 *  - 'year_over_year'  : the same calendar range one year earlier
 */
export function comparisonRange({ start, end }, mode, tz) {
  if (!start || !end) return null;
  if (mode === 'year_over_year') {
    return { start: addMonths(start, -12, tz), end: addMonths(end, -12, tz) };
  }
  if (mode === 'previous_period') {
    const span = end - start;
    return { start: start - span, end: start };
  }
  return null;
}

/**
 * Explicit bucket edges for the graph. Returned as half-open [start, end)
 * ranges so SQL can range-scan the (site_id, timestamp) index per bucket.
 */
export function buildBuckets(start, end, interval, tz) {
  const buckets = [];
  const step = {
    minute: (t) => t + 60,
    hour: (t) => t + 3600,
    day: (t) => addDays(t, 1, tz),
    week: (t) => addDays(t, 7, tz),
    month: (t) => addMonths(t, 1, tz),
  }[interval] || ((t) => addDays(t, 1, tz));

  let cursor = alignToInterval(start, interval, tz);
  let guard = 0;
  while (cursor < end && guard < 2000) {
    const next = step(cursor);
    buckets.push({
      index: buckets.length,
      start: cursor,
      end: Math.min(next, end),
      label: bucketLabel(cursor, interval, tz),
      iso: interval === 'minute' || interval === 'hour' ? formatYmdHm(cursor, tz) : formatYmd(cursor, tz),
    });
    cursor = next;
    guard += 1;
  }
  return buckets;
}

function alignToInterval(t, interval, tz) {
  switch (interval) {
    case 'minute':
      return t - (t % 60);
    case 'hour':
      return t - (t % 3600);
    case 'week':
      return startOfWeek(t, tz);
    case 'month':
      return startOfMonth(t, tz);
    case 'day':
    default:
      return startOfDay(t, tz);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(t, interval, tz) {
  const p = zonedParts(t, tz);
  switch (interval) {
    case 'minute':
    case 'hour':
      return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    case 'month':
      return `${MONTHS[p.month - 1]} ${p.year}`;
    case 'week':
    case 'day':
    default:
      return `${p.day} ${MONTHS[p.month - 1]}`;
  }
}

/** Human duration, e.g. 1438 -> "23m 58s". */
export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
