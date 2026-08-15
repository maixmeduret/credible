/**
 * The stats engine — every number the dashboard shows is produced here.
 *
 * Two shapes of query:
 *   • event-scoped  (visitors, pageviews, breakdowns)   -> `events`
 *   • session-scoped (bounce rate, visit duration)      -> `visits`
 * Both are driven by the same Scope so a filter applies consistently across
 * the whole page.
 */
import { all, get } from '../db/index.js';
import { goalCondition, resolveDimension, Scope } from './query.js';
import { buildBuckets } from '../util/time.js';

const num = (value) => (value == null ? 0 : Number(value));

/** Headline metrics for the top bar. */
export function aggregate(scope) {
  const e = scope.events();
  const totals = get(
    `SELECT count(DISTINCT e.visitor_id) AS visitors,
            count(DISTINCT e.visit_id)   AS visits,
            sum(CASE WHEN e.name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            count(*) AS events,
            sum(COALESCE(e.revenue, 0)) AS revenue
       ${e.from} ${e.where}`,
    e.params,
  ) || {};

  const v = scope.visits();
  const session = get(
    `SELECT avg(v.is_bounce) AS bounce, avg(v.duration) AS duration, count(*) AS visits
       ${v.from} ${v.where}`,
    v.params,
  ) || {};

  const visits = num(totals.visits);
  const pageviews = num(totals.pageviews);

  return {
    visitors: num(totals.visitors),
    visits,
    pageviews,
    events: num(totals.events),
    views_per_visit: visits ? Number((pageviews / visits).toFixed(2)) : 0,
    bounce_rate: session.bounce == null ? 0 : Math.round(num(session.bounce) * 100),
    visit_duration: Math.round(num(session.duration)),
    revenue: num(totals.revenue) / 100,
  };
}

/**
 * The main graph. Returns one row per bucket with every metric, so switching
 * the displayed metric in the UI needs no round trip.
 */
export function timeseries(scope, interval, timezone) {
  const buckets = buildBuckets(scope.range.start, scope.range.end, interval, timezone);
  if (!buckets.length) return [];

  const bucketValues = buckets.map(() => '(?, ?, ?)').join(', ');
  const bucketParams = buckets.flatMap((b) => [b.index, b.start, b.end]);

  const e = scope.events();
  const eventRows = all(
    `WITH fe AS (SELECT e.timestamp AS ts, e.visitor_id AS visitor_id, e.visit_id AS visit_id, e.name AS name ${e.from} ${e.where}),
          b(i, bs, be) AS (VALUES ${bucketValues})
     SELECT b.i AS bucket,
            count(DISTINCT fe.visitor_id) AS visitors,
            count(DISTINCT fe.visit_id)   AS visits,
            sum(CASE WHEN fe.name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            count(fe.ts) AS events
       FROM b LEFT JOIN fe ON fe.ts >= b.bs AND fe.ts < b.be
      GROUP BY b.i ORDER BY b.i`,
    [...e.params, ...bucketParams],
  );

  const v = scope.visits();
  const visitRows = all(
    `WITH fv AS (SELECT v.started_at AS ts, v.is_bounce AS is_bounce, v.duration AS duration ${v.from} ${v.where}),
          b(i, bs, be) AS (VALUES ${bucketValues})
     SELECT b.i AS bucket,
            avg(fv.is_bounce) AS bounce,
            avg(fv.duration)  AS duration
       FROM b LEFT JOIN fv ON fv.ts >= b.bs AND fv.ts < b.be
      GROUP BY b.i ORDER BY b.i`,
    [...v.params, ...bucketParams],
  );

  const sessionByBucket = new Map(visitRows.map((r) => [r.bucket, r]));

  return buckets.map((bucket, i) => {
    const row = eventRows[i] || {};
    const session = sessionByBucket.get(bucket.index) || {};
    const visits = num(row.visits);
    const pageviews = num(row.pageviews);
    return {
      date: bucket.iso,
      label: bucket.label,
      start: bucket.start,
      end: bucket.end,
      visitors: num(row.visitors),
      visits,
      pageviews,
      events: num(row.events),
      views_per_visit: visits ? Number((pageviews / visits).toFixed(2)) : 0,
      bounce_rate: session.bounce == null ? 0 : Math.round(num(session.bounce) * 100),
      visit_duration: Math.round(num(session.duration)),
    };
  });
}

/**
 * Group by any dimension. Fetches one extra row so the caller knows whether a
 * "show more" affordance is needed.
 */
export function breakdown(scope, { dimension, limit = 9, offset = 0 } = {}) {
  const isSessionDimension = dimension === 'visit:entry_page' || dimension === 'visit:exit_page';
  return isSessionDimension
    ? sessionBreakdown(scope, { dimension, limit, offset })
    : eventBreakdown(scope, { dimension, limit, offset });
}

function eventBreakdown(scope, { dimension, limit, offset }) {
  const dim = resolveDimension(dimension);
  const e = scope.events();
  const rows = all(
    `SELECT ${dim.sql} AS name,
            count(DISTINCT e.visitor_id) AS visitors,
            count(DISTINCT e.visit_id)   AS visits,
            sum(CASE WHEN e.name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            count(*) AS events
       ${e.from} ${e.where}
        AND ${dim.sql} IS NOT NULL AND ${dim.sql} <> ''
      GROUP BY 1
      ORDER BY visitors DESC, pageviews DESC, name ASC
      LIMIT ? OFFSET ?`,
    [...dim.params, ...e.params, ...dim.params, ...dim.params, limit + 1, offset],
  );
  return paginate(rows, limit);
}

function sessionBreakdown(scope, { dimension, limit, offset }) {
  const dim = resolveDimension(dimension, { forVisits: true });
  const v = scope.visits();
  const rows = all(
    `SELECT ${dim.sql} AS name,
            count(DISTINCT v.visitor_id) AS visitors,
            count(*) AS visits,
            sum(v.pageviews) AS pageviews,
            avg(v.is_bounce) AS bounce,
            avg(v.duration)  AS duration
       ${v.from} ${v.where}
        AND ${dim.sql} IS NOT NULL AND ${dim.sql} <> ''
      GROUP BY 1
      ORDER BY visitors DESC, name ASC
      LIMIT ? OFFSET ?`,
    [...dim.params, ...v.params, ...dim.params, ...dim.params, limit + 1, offset],
  );
  const { results, hasMore } = paginate(rows, limit);
  return {
    results: results.map((row) => ({
      name: row.name,
      visitors: num(row.visitors),
      visits: num(row.visits),
      pageviews: num(row.pageviews),
      bounce_rate: row.bounce == null ? 0 : Math.round(num(row.bounce) * 100),
      visit_duration: Math.round(num(row.duration)),
    })),
    hasMore,
  };
}

/**
 * Pages get two extra columns the other dimensions do not have: time on page
 * and scroll depth, both derived from `engagement` events.
 */
export function pagesBreakdown(scope, { limit = 9, offset = 0 } = {}) {
  const e = scope.events();
  const rows = all(
    `SELECT e.pathname AS name,
            count(DISTINCT e.visitor_id) AS visitors,
            count(DISTINCT e.visit_id)   AS visits,
            sum(CASE WHEN e.name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            avg(CASE WHEN e.name = 'engagement' AND e.engagement_time > 0 THEN e.engagement_time END) AS engagement_ms,
            avg(CASE WHEN e.name = 'engagement' AND e.scroll_depth > 0 THEN e.scroll_depth END) AS scroll
       ${e.from} ${e.where} AND e.pathname <> ''
      GROUP BY 1
      ORDER BY visitors DESC, pageviews DESC, name ASC
      LIMIT ? OFFSET ?`,
    [...e.params, limit + 1, offset],
  );
  const { results, hasMore } = paginate(rows, limit);
  return {
    results: results.map((row) => ({
      name: row.name,
      visitors: num(row.visitors),
      visits: num(row.visits),
      pageviews: num(row.pageviews),
      time_on_page: Math.round(num(row.engagement_ms) / 1000),
      scroll_depth: Math.round(num(row.scroll)),
    })),
    hasMore,
  };
}

const COUNT_COLUMNS = ['visitors', 'visits', 'pageviews', 'events'];

function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const results = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
    const out = { ...row };
    for (const column of COUNT_COLUMNS) {
      if (column in row) out[column] = num(row[column]);
    }
    return out;
  });
  return { results, hasMore };
}

// ------------------------------------------------------------------ goals --

/** Conversions per goal, with conversion rate against the filtered visitors. */
export function goalsBreakdown(scope, goals) {
  if (!goals.length) return { results: [], hasMore: false };
  const totalVisitors = aggregate(scope).visitors;
  const e = scope.events();

  const results = goals
    .map((goal) => {
      const cond = goalCondition(goal);
      const row = get(
        `SELECT count(DISTINCT e.visitor_id) AS uniques,
                count(*) AS total,
                sum(COALESCE(e.revenue, 0)) AS revenue
           ${e.from} ${e.where} AND ${cond.sql}`,
        [...e.params, ...cond.params],
      ) || {};
      return {
        id: goal.id,
        name: goal.display_name || goal.event_name || goal.page_path,
        type: goal.type,
        uniques: num(row.uniques),
        total: num(row.total),
        revenue: num(row.revenue) / 100,
        cr: totalVisitors ? Number(((num(row.uniques) / totalVisitors) * 100).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.uniques - a.uniques);

  return { results, hasMore: false };
}

// ------------------------------------------------------- custom properties --

/** Property keys seen in the current scope. */
export function propertyKeys(scope) {
  const e = scope.events();
  const rows = all(
    `SELECT DISTINCT j.key AS key
       FROM (SELECT e.props AS props ${e.from} ${e.where} AND e.props <> '') x,
            json_each(x.props) j
      ORDER BY 1 LIMIT 50`,
    e.params,
  );
  return rows.map((r) => r.key);
}

export function propertyBreakdown(scope, key, { limit = 9, offset = 0 } = {}) {
  const e = scope.events();
  const path = `$."${String(key).replace(/"/g, '')}"`;
  const rows = all(
    `SELECT json_extract(nullif(e.props, ''), ?) AS name,
            count(DISTINCT e.visitor_id) AS visitors,
            count(*) AS events,
            sum(COALESCE(e.revenue, 0)) AS revenue
       ${e.from} ${e.where} AND json_extract(nullif(e.props, ''), ?) IS NOT NULL
      GROUP BY 1 ORDER BY visitors DESC, name ASC LIMIT ? OFFSET ?`,
    [path, ...e.params, path, limit + 1, offset],
  );
  const { results, hasMore } = paginate(rows, limit);
  return {
    results: results.map((r) => ({ ...r, revenue: num(r.revenue) / 100 })),
    hasMore,
  };
}

// ---------------------------------------------------------------- funnels --

/**
 * Ordered funnel: a visitor counts for step N only if they hit steps 1..N in
 * chronological order within the selected period.
 */
export function funnelReport(scope, funnel, steps) {
  if (!steps.length) return { name: funnel.name, steps: [], visitors: 0 };
  const e = scope.events();

  const ctes = [];
  const params = [];
  steps.forEach((goal, index) => {
    const cond = goalCondition(goal);
    ctes.push(
      `s${index} AS (SELECT e.visitor_id AS visitor_id, min(e.timestamp) AS t
                       ${e.from} ${e.where} AND ${cond.sql}
                      GROUP BY 1)`,
    );
    params.push(...e.params, ...cond.params);
  });

  const counts = steps.map((_, index) => {
    const joins = [];
    for (let i = 1; i <= index; i += 1) {
      joins.push(`JOIN s${i} ON s${i}.visitor_id = s0.visitor_id AND s${i}.t >= s${i - 1}.t`);
    }
    return `(SELECT count(*) FROM s0 ${joins.join(' ')}) AS step${index}`;
  });

  const row = get(`WITH ${ctes.join(', ')} SELECT ${counts.join(', ')}`, params) || {};

  let previous = null;
  const reported = steps.map((goal, index) => {
    const visitors = num(row[`step${index}`]);
    const entry = {
      name: goal.display_name || goal.event_name || goal.page_path,
      visitors,
      conversion_rate: index === 0 ? 100 : previous ? Number(((visitors / previous) * 100).toFixed(1)) : 0,
      dropoff: previous == null ? 0 : Math.max(0, previous - visitors),
    };
    previous = visitors;
    return entry;
  });

  const first = reported[0]?.visitors || 0;
  const last = reported[reported.length - 1]?.visitors || 0;
  return {
    id: funnel.id,
    name: funnel.name,
    steps: reported,
    visitors: first,
    completion_rate: first ? Number(((last / first) * 100).toFixed(1)) : 0,
  };
}

// --------------------------------------------------------------- realtime --

/** Visitors seen in the last `window` seconds — the green dot in the header. */
export function currentVisitors(siteId, window = 300) {
  return num(
    get(
      'SELECT count(DISTINCT visitor_id) AS c FROM events WHERE site_id = ? AND timestamp > unixepoch() - ?',
      [siteId, window],
    )?.c,
  );
}

export function realtimePages(siteId, window = 300, limit = 10) {
  return all(
    `SELECT pathname AS name, count(DISTINCT visitor_id) AS visitors
       FROM events
      WHERE site_id = ? AND timestamp > unixepoch() - ? AND name = 'pageview'
      GROUP BY 1 ORDER BY visitors DESC LIMIT ?`,
    [siteId, window, limit],
  ).map((r) => ({ ...r, visitors: num(r.visitors) }));
}

export { Scope };
