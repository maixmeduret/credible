/**
 * The consolidated view: every site the caller can read, rolled into one page.
 *
 * The addition is the easy part. The hard part — and the reason this file is
 * mostly comments and notes — is being honest about what the sum means:
 *
 *   • Every site keeps its OWN timezone, so "last 7 days" is a different
 *     wall-clock window per site. Each site is therefore queried over the range
 *     resolved in its own zone. Only the graph, which needs a single shared x
 *     axis, is bucketed in one reference zone, and `timezone_note` says which.
 *   • Unique visitors DO NOT ADD UP. The daily identifier salt is per site by
 *     construction (src/ingest/salt.js) — that is what makes the identifiers
 *     unlinkable — so one human browsing two of your sites is two visitor ids.
 *     The total is an upper bound on people, never a count of them, and
 *     `visitors_note` says so on every single response.
 *   • Bounce rate and visit duration are pooled over sessions, not averaged
 *     across sites. A site with 3 visits must not weigh as much as one with
 *     30 000.
 *
 * One query per site, deliberately: a cross-site UNION would give up the
 * (site_id, timestamp) index that makes every one of these reads cheap.
 *
 * Segments are not applied here. A segment belongs to one site, so it has no
 * meaning across a set of them; plain `filters` do compose and are passed to
 * every site.
 */
import { get } from '../db/index.js';
import { Scope, aggregate, breakdown, currentVisitors, timeseries } from './index.js';
import { parseFilters } from './query.js';
import { listGoals } from '../goals.js';
import { siteDataRange } from '../sites.js';
import {
  buildBuckets,
  comparisonRange,
  pickInterval,
  resolveRange,
  startOfDay,
} from '../util/time.js';

const DAY = 86400;
const TOP_LIMIT = 10;

/**
 * How deep to read a dimension that gets MERGED across sites before ranking.
 *
 * Pages are never merged, so reading the top ten per site is exact: a site's
 * eleventh page cannot reach the global top ten, because that site's own ten
 * better pages already fill it. Sources DO merge, and that argument collapses —
 * a source sitting just below the cut on every site can outweigh anything above
 * it once summed. Reading ten per site loses it entirely. So the merged
 * dimension is read deep and truncated only after the addition.
 */
const MERGE_LIMIT = 100;

const num = (value) => (value == null ? 0 : Number(value));
const zoneOf = (site) => site.timezone || 'UTC';

/** Percent change, using the same convention as the single-site dashboard. */
function percentChange(current, previous) {
  if (previous == null) return null;
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

// ----------------------------------------------------------------- ranges --

const periodOf = (query) => ({
  period: query.period,
  date: query.date,
  from: query.from,
  to: query.to,
});

/**
 * The range for one site, resolved in that site's own timezone.
 *
 * `period=all` comes back without a start: it depends on when the site's data
 * begins, which is a different instant for every site — precisely the reason
 * this is resolved per site instead of once for the whole rollup.
 */
function rangeFor(site, query) {
  const tz = zoneOf(site);
  const range = resolveRange(periodOf(query), tz);
  if (range.start == null) {
    const { first } = siteDataRange(site.id);
    range.start = first ? startOfDay(first, tz) : range.end - 30 * DAY;
    range.interval = pickInterval(range.start, range.end);
  }
  return range;
}

/** The single range the graph is drawn over, in the reference timezone. */
function referenceRange(sites, query, tz) {
  const range = resolveRange(periodOf(query), tz);
  if (range.start == null) {
    // "All time" for the rollup starts when the earliest site started.
    const firsts = sites.map((site) => siteDataRange(site.id).first).filter(Boolean);
    range.start = firsts.length ? startOfDay(Math.min(...firsts), tz) : range.end - 30 * DAY;
    range.interval = pickInterval(range.start, range.end);
  }
  return range;
}

// ------------------------------------------------------------- arithmetic --

/**
 * Unrounded session totals for one scope.
 *
 * `aggregate()` returns bounce rate rounded to whole percent and duration to
 * whole seconds, which is what a dashboard cell wants and the wrong input to a
 * cross-site mean: the rounding error would compound once per site. Summing
 * bounces and seconds instead makes the rollup a pooled average — exactly the
 * number a single site with all this traffic would report.
 */
function sessionTotals(scope) {
  const v = scope.visits();
  const row = get(
    `SELECT count(*) AS sessions, sum(v.is_bounce) AS bounces, sum(v.duration) AS seconds
       ${v.from} ${v.where}`,
    v.params,
  ) || {};
  return { sessions: num(row.sessions), bounces: num(row.bounces), seconds: num(row.seconds) };
}

/**
 * Add per-site rows into one set of headline metrics.
 * Counts sum; the two session metrics are weighted by the number of sessions
 * they were measured over, never averaged across sites.
 */
function rollup(rows) {
  let visitors = 0;
  let visits = 0;
  let pageviews = 0;
  let revenue = 0;
  let live = 0;
  let sessions = 0;
  let bounces = 0;
  let seconds = 0;

  for (const row of rows) {
    visitors += row.metrics.visitors;
    visits += row.metrics.visits;
    pageviews += row.metrics.pageviews;
    revenue += row.metrics.revenue;
    live += row.live;
    sessions += row.session.sessions;
    bounces += row.session.bounces;
    seconds += row.session.seconds;
  }

  return {
    visitors,
    visits,
    pageviews,
    views_per_visit: visits ? Number((pageviews / visits).toFixed(2)) : 0,
    bounce_rate: sessions ? Math.round((bounces / sessions) * 100) : 0,
    visit_duration: sessions ? Math.round(seconds / sessions) : 0,
    // Money is summed as floats one site at a time, so trim the binary dust.
    revenue: Number(revenue.toFixed(2)),
    current_visitors: live,
  };
}

// ------------------------------------------------------------------ notes --

function timezoneNote(sites, zones, timezone) {
  if (!sites.length) return 'No sites to roll up.';
  if (zones.length === 1) {
    return `All ${sites.length} ${sites.length === 1 ? 'site reports' : 'sites report'} in ${timezone}, so every number here covers the same window.`;
  }
  return (
    `These ${sites.length} sites span ${zones.length} timezones (${zones.join(', ')}). ` +
    'Each site\'s totals are counted over the selected period resolved in its own timezone, ' +
    'so the windows do not line up with each other. The graph needs one shared x axis and is ' +
    `bucketed in ${timezone}: an event inside a site's own window but outside the ${timezone} ` +
    'window is counted in that site\'s totals and not in the graph.'
  );
}

function visitorsNote(totalVisitors, siteCount) {
  // With a single site there is nothing to double count, and claiming otherwise
  // would be its own small lie. The field still ships on every response so a
  // caller never has to branch on whether the caveat exists.
  if (siteCount <= 1) {
    return `${totalVisitors} is one site's own visitor count, so nothing is double counted here.`;
  }
  return (
    'Visitor counts are per site and do not add up to people. The daily identifier salt is ' +
    'per site by design — that is what makes visitor ids unlinkable — so one person who visits ' +
    `two of your sites is counted twice here. Read ${totalVisitors} as an upper bound on ` +
    'distinct humans, not a unique visitor count.'
  );
}

/**
 * What the summed revenue is denominated in, and whether saying so is a lie.
 * Only sites that actually earned something in the range can make the total
 * mixed; a zero-revenue site in another currency is irrelevant.
 */
function revenueCurrency(sites, rows) {
  const earning = [...new Set(
    rows.filter((row) => row.metrics.revenue > 0).map((row) => (row.site.currency || 'EUR').toUpperCase()),
  )];
  if (earning.length > 1) return { currency: null, mixed: earning };
  if (earning.length === 1) return { currency: earning[0], mixed: null };
  const configured = [...new Set(sites.map((site) => (site.currency || 'EUR').toUpperCase()))];
  return { currency: configured.length === 1 ? configured[0] : null, mixed: null };
}

// ------------------------------------------------------------------- view --

/**
 * Roll several sites into one view.
 *
 * @param {object} input
 * @param {Array<object>} input.sites   site rows the caller may read
 * @param {object} input.query          { period, date, from, to, comparison, filters }
 * @returns {{
 *   sites: Array<{ domain, timezone, visitors, visits, pageviews, bounce_rate,
 *                  visit_duration, change: number|null, current_visitors: number }>,
 *   totals: { visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration,
 *             revenue, current_visitors },
 *   comparison: object|null,
 *   timeseries: Array<{ date, label, visitors, pageviews, visits }>,
 *   top_pages: Array<{ name, site, visitors }>,
 *   top_sources: Array<{ name, visitors }>,
 *   period: object,
 *   timezone: string,
 *   timezones: Array<string>,
 *   currency: string|null,
 *   timezone_note: string,
 *   visitors_note: string,
 *   notes: Array<string>
 * }}
 */
export function consolidated({ sites = [], query = {} } = {}) {
  const filters = parseFilters(query.filters);
  // Goals are only needed to expand an `event:goal` filter, and they are a
  // query per site — so do not pay for them when nothing asked.
  const needsGoals = filters.some((filter) => filter.key === 'event:goal');

  const zones = [...new Set(sites.map(zoneOf))];
  // One shared zone means the graph and the per-site windows agree exactly.
  // When they disagree there is no honest winner, so fall back to UTC rather
  // than quietly adopting one site's clock as everybody's.
  const timezone = zones.length === 1 ? zones[0] : 'UTC';
  const reference = referenceRange(sites, query, timezone);
  const mode = query.comparison && query.comparison !== 'off' ? query.comparison : '';

  const graph = new Map(
    buildBuckets(reference.start, reference.end, reference.interval, timezone).map((bucket) => [
      bucket.iso,
      { date: bucket.iso, label: bucket.label, visitors: 0, pageviews: 0, visits: 0 },
    ]),
  );

  const rows = [];
  const previousRows = [];
  const pages = [];
  const sources = new Map();

  for (const site of sites) {
    const tz = zoneOf(site);
    const goals = needsGoals ? listGoals(site.id) : [];
    const range = rangeFor(site, query);
    const scope = new Scope({ site, range, filters, goals });

    const metrics = aggregate(scope);
    const session = sessionTotals(scope);
    // listSitesForUser() already counted the last five minutes; re-use it
    // rather than running the same query again, but stay correct for callers
    // that hand us a bare `sites` row.
    const live = site.current_visitors == null ? currentVisitors(site.id) : num(site.current_visitors);

    let change = null;
    if (mode) {
      const previous = comparisonRange(range, mode, tz);
      if (previous) {
        const previousScope = new Scope({ site, range: previous, filters, goals });
        const previousMetrics = aggregate(previousScope);
        previousRows.push({
          site,
          metrics: previousMetrics,
          session: sessionTotals(previousScope),
          live: 0, // "right now" has no meaning in a past range
        });
        change = percentChange(metrics.visitors, previousMetrics.visitors);
      }
    }

    rows.push({ site, metrics, session, live, change });

    // The graph is bucketed over the REFERENCE range in the reference zone for
    // every site, not over each site's own window — otherwise the buckets would
    // not line up and there would be nothing to add together.
    const graphScope = new Scope({ site, range: reference, filters, goals });
    for (const point of timeseries(graphScope, reference.interval, timezone)) {
      const bucket = graph.get(point.date);
      if (!bucket) continue;
      bucket.visitors += point.visitors;
      bucket.pageviews += point.pageviews;
      bucket.visits += point.visits;
    }

    for (const page of breakdown(scope, { dimension: 'event:page', limit: TOP_LIMIT }).results) {
      // Two sites can each have a /pricing, and they are different pages. Pages
      // stay labelled with their domain instead of being merged by path.
      pages.push({ name: page.name, site: site.domain, visitors: page.visitors });
    }

    // Sources do merge: Google is the same Google whichever site it sent the
    // traffic to. Read MERGE_LIMIT deep so a source that is below the top ten
    // on every single site still shows up if the sum says it belongs. The
    // visitor numbers still over-count people, as everywhere.
    for (const source of breakdown(scope, { dimension: 'visit:source', limit: MERGE_LIMIT }).results) {
      sources.set(source.name, (sources.get(source.name) || 0) + source.visitors);
    }
  }

  const totals = rollup(rows);
  const { currency, mixed } = revenueCurrency(sites, rows);

  const tzNote = timezoneNote(sites, zones, timezone);
  const vNote = visitorsNote(totals.visitors, sites.length);
  const notes = [tzNote, vNote];
  if (mixed) {
    notes.push(
      `Revenue adds amounts in ${mixed.length} different currencies (${mixed.join(', ')}). ` +
      'The total is a sum of unlike units and is not a monetary figure.',
    );
  }

  return {
    sites: rows
      .map((row) => ({
        domain: row.site.domain,
        timezone: zoneOf(row.site),
        visitors: row.metrics.visitors,
        visits: row.metrics.visits,
        pageviews: row.metrics.pageviews,
        bounce_rate: row.metrics.bounce_rate,
        visit_duration: row.metrics.visit_duration,
        change: row.change,
        current_visitors: row.live,
      }))
      // Busiest first, but a site with no traffic at all still gets its row:
      // "nothing came in" is information, and a vanishing site looks like a
      // tracking bug you never notice.
      .sort((a, b) => b.visitors - a.visitors || a.domain.localeCompare(b.domain)),
    totals,
    comparison: previousRows.length ? rollup(previousRows) : null,
    timeseries: [...graph.values()],
    top_pages: pages
      .sort((a, b) => b.visitors - a.visitors || a.site.localeCompare(b.site) || a.name.localeCompare(b.name))
      .slice(0, TOP_LIMIT),
    top_sources: [...sources.entries()]
      .map(([name, visitors]) => ({ name, visitors }))
      .sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name))
      .slice(0, TOP_LIMIT),
    period: reference,
    timezone,
    timezones: zones,
    currency,
    timezone_note: tzNote,
    visitors_note: vNote,
    notes,
  };
}
