/**
 * Query scope: turns a dashboard request (site + period + filters) into a
 * bound SQL fragment.
 *
 * Every dimension the UI can group or filter by is declared in DIMENSIONS.
 * Nothing outside that table ever reaches SQL, and every value is bound —
 * there is no string interpolation of user input anywhere in this file.
 */
import { HttpError } from '../util/http.js';

/**
 * table: which relation the column lives on.
 *   'events' — denormalised onto every event row (fast path, no join)
 *   'visits' — session scoped (entry/exit pages)
 */
export const DIMENSIONS = {
  'event:page': { table: 'events', column: 'e.pathname', label: 'Page' },
  'event:hostname': { table: 'events', column: 'e.hostname', label: 'Hostname' },
  'event:name': { table: 'events', column: 'e.name', label: 'Event' },

  'visit:entry_page': { table: 'visits', column: 'v.entry_page', label: 'Entry page' },
  'visit:exit_page': { table: 'visits', column: 'v.exit_page', label: 'Exit page' },

  'visit:channel': { table: 'events', column: 'e.channel', label: 'Channel' },
  'visit:source': { table: 'events', column: 'e.referrer_source', label: 'Source' },
  'visit:referrer': { table: 'events', column: 'e.referrer', label: 'Referrer' },
  'visit:utm_source': { table: 'events', column: 'e.utm_source', label: 'UTM source' },
  'visit:utm_medium': { table: 'events', column: 'e.utm_medium', label: 'UTM medium' },
  'visit:utm_campaign': { table: 'events', column: 'e.utm_campaign', label: 'UTM campaign' },
  'visit:utm_content': { table: 'events', column: 'e.utm_content', label: 'UTM content' },
  'visit:utm_term': { table: 'events', column: 'e.utm_term', label: 'UTM term' },

  'visit:country': { table: 'events', column: 'e.country_code', label: 'Country' },
  'visit:region': { table: 'events', column: 'e.region', label: 'Region' },
  'visit:city': { table: 'events', column: 'e.city', label: 'City' },

  'visit:browser': { table: 'events', column: 'e.browser', label: 'Browser' },
  'visit:browser_version': { table: 'events', column: 'e.browser_version', label: 'Browser version' },
  'visit:os': { table: 'events', column: 'e.os', label: 'Operating system' },
  'visit:os_version': { table: 'events', column: 'e.os_version', label: 'OS version' },
  'visit:device': { table: 'events', column: 'e.device', label: 'Device' },
  'visit:screen_size': { table: 'events', column: 'e.screen_size', label: 'Screen size' },
};

/** Same dimensions expressed against the `visits` table (for session queries). */
const VISIT_EQUIVALENT = {
  'visit:channel': 'v.channel',
  'visit:source': 'v.referrer_source',
  'visit:referrer': 'v.referrer',
  'visit:utm_source': 'v.utm_source',
  'visit:utm_medium': 'v.utm_medium',
  'visit:utm_campaign': 'v.utm_campaign',
  'visit:utm_content': 'v.utm_content',
  'visit:utm_term': 'v.utm_term',
  'visit:country': 'v.country_code',
  'visit:region': 'v.region',
  'visit:city': 'v.city',
  'visit:browser': 'v.browser',
  'visit:browser_version': 'v.browser_version',
  'visit:os': 'v.os',
  'visit:os_version': 'v.os_version',
  'visit:device': 'v.device',
  'visit:screen_size': 'v.screen_size',
  'visit:entry_page': 'v.entry_page',
  'visit:exit_page': 'v.exit_page',
};

export const FILTER_OPERATORS = new Set([
  'is',
  'is_not',
  'contains',
  'contains_not',
  'matches',
  'matches_not',
]);

const PROP_PREFIX = 'event:props:';
const escapeLike = (value) => String(value).replace(/[\\%_]/g, '\\$&');

/**
 * Resolve a filter/breakdown key to a SQL expression.
 * Custom properties are read out of the JSON blob with a bound path.
 */
export function resolveDimension(key, { forVisits = false } = {}) {
  if (typeof key !== 'string') throw new HttpError(422, 'Invalid dimension');

  if (key.startsWith(PROP_PREFIX)) {
    const prop = key.slice(PROP_PREFIX.length);
    if (!prop || prop.length > 64) throw new HttpError(422, `Invalid property: ${key}`);
    return {
      // nullif() keeps json_extract away from the empty string most rows carry —
      // SQLite raises "malformed JSON" instead of returning NULL for it.
      sql: "json_extract(nullif(e.props, ''), ?)",
      params: [`$."${prop.replace(/"/g, '')}"`],
      table: 'events',
      label: prop,
      isProp: true,
    };
  }

  const dim = DIMENSIONS[key];
  if (!dim) throw new HttpError(422, `Unknown dimension: ${key}`);
  if (forVisits && VISIT_EQUIVALENT[key]) {
    return { sql: VISIT_EQUIVALENT[key], params: [], table: 'visits', label: dim.label };
  }
  return { sql: dim.column, params: [], table: dim.table, label: dim.label };
}

/**
 * A goal is either a custom event name or a page path (with an optional
 * trailing `*`). Returns a bound condition matching events for that goal.
 */
export function goalCondition(goal, prefix = 'e') {
  if (goal.type === 'page') {
    const path = String(goal.page_path || '');
    if (path.endsWith('*')) {
      return { sql: `(${prefix}.name = 'pageview' AND ${prefix}.pathname LIKE ? ESCAPE '\\')`, params: [`${escapeLike(path.slice(0, -1))}%`] };
    }
    return { sql: `(${prefix}.name = 'pageview' AND ${prefix}.pathname = ?)`, params: [path] };
  }
  return { sql: `${prefix}.name = ?`, params: [String(goal.event_name || '')] };
}

/**
 * Every key a filter may name: the declared dimensions, the goal pseudo
 * dimension, and any custom property.
 */
export function assertFilterableKey(key) {
  if (typeof key !== 'string' || !key) throw new HttpError(422, 'A filter needs a dimension');
  if (key === 'event:goal') return key;
  if (key.startsWith(PROP_PREFIX)) {
    const prop = key.slice(PROP_PREFIX.length);
    if (!prop || prop.length > 64) throw new HttpError(422, `Invalid property: ${key}`);
    return key;
  }
  if (!DIMENSIONS[key]) throw new HttpError(422, `Unknown dimension: ${key}`);
  return key;
}

/**
 * Parse the `filters` query parameter.
 * Wire format (JSON): [["is","visit:country",["FR","BE"]], ["contains","event:page",["/blog"]]]
 */
export function parseFilters(input) {
  if (!input) return [];
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new HttpError(422, 'filters must be valid JSON');
    }
  }
  if (!Array.isArray(raw)) throw new HttpError(422, 'filters must be an array');
  if (raw.length > 20) throw new HttpError(422, 'Too many filters');

  return raw.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 3) throw new HttpError(422, 'Malformed filter');
    const [operator, key, values] = entry;
    if (!FILTER_OPERATORS.has(operator)) throw new HttpError(422, `Unknown filter operator: ${operator}`);
    // Validate the dimension here rather than at query time. A saved segment is
    // written once and read forever; rejecting a bad key at the point somebody
    // can still fix it beats failing inside a query months later.
    assertFilterableKey(key);
    const list = (Array.isArray(values) ? values : [values]).map((v) => String(v ?? '').slice(0, 500));
    if (!list.length) throw new HttpError(422, 'Filter needs at least one value');
    if (list.length > 100) throw new HttpError(422, 'Too many filter values');
    return { operator, key, values: list };
  });
}

function filterCondition(filter, goals, options) {
  // `event:goal` is special: it expands to the goal's own definition.
  if (filter.key === 'event:goal') {
    const matches = goals.filter((g) => filter.values.includes(g.display_name || g.event_name || g.page_path));
    if (!matches.length) return { sql: '0', params: [] };
    const parts = matches.map((g) => goalCondition(g));
    const sql = `(${parts.map((p) => p.sql).join(' OR ')})`;
    const params = parts.flatMap((p) => p.params);
    return filter.operator.endsWith('_not') ? { sql: `NOT ${sql}`, params } : { sql, params };
  }

  const dim = resolveDimension(filter.key, options);
  const { sql: col, params: colParams } = dim;

  switch (filter.operator) {
    case 'is':
    case 'is_not': {
      const placeholders = filter.values.map(() => '?').join(', ');
      const clause = `${col} IN (${placeholders})`;
      if (filter.operator === 'is') {
        return { sql: clause, params: [...colParams, ...filter.values] };
      }
      // NULL-safety: `is_not` must also keep rows where the column is unset.
      // `col` appears twice, so its own bound params are repeated too.
      return {
        sql: `(NOT (${clause}) OR ${col} IS NULL)`,
        params: [...colParams, ...filter.values, ...colParams],
      };
    }
    case 'contains':
    case 'contains_not': {
      const parts = filter.values.map(() => `${col} LIKE ? ESCAPE '\\'`);
      const clause = `(${parts.join(' OR ')})`;
      const params = [];
      for (const value of filter.values) {
        params.push(...colParams, `%${escapeLike(value)}%`);
      }
      return {
        sql: filter.operator === 'contains' ? clause : `(NOT ${clause} OR ${col} IS NULL)`,
        params: filter.operator === 'contains' ? params : [...params, ...colParams],
      };
    }
    case 'matches':
    case 'matches_not': {
      const parts = filter.values.map(() => `${col} GLOB ?`);
      const clause = `(${parts.join(' OR ')})`;
      const params = [];
      for (const value of filter.values) params.push(...colParams, value);
      return {
        sql: filter.operator === 'matches' ? clause : `(NOT ${clause} OR ${col} IS NULL)`,
        params: filter.operator === 'matches' ? params : [...params, ...colParams],
      };
    }
    default:
      throw new HttpError(422, `Unsupported operator: ${filter.operator}`);
  }
}

/**
 * The scope of a stats query.
 *
 * `where()` returns a fragment for `FROM events e [JOIN visits v]`.
 * `visitSubquery()` returns the set of visit ids matching the same filters,
 * used by session-scoped metrics.
 */
export class Scope {
  constructor({ site, range, filters = [], goals = [] }) {
    this.site = site;
    this.range = range;
    this.filters = filters;
    this.goals = goals;
    this.needsVisitJoin = filters.some(
      (f) => f.key === 'visit:entry_page' || f.key === 'visit:exit_page',
    );
  }

  /** WHERE clause + params for an events query aliased `e`. */
  events({ start = this.range.start, end = this.range.end } = {}) {
    const clauses = ['e.site_id = ?', 'e.timestamp >= ?', 'e.timestamp < ?'];
    const params = [this.site.id, start, end];
    for (const filter of this.filters) {
      const { sql, params: p } = filterCondition(filter, this.goals, {});
      clauses.push(sql);
      params.push(...p);
    }
    return {
      from: `FROM events e${this.needsVisitJoin ? ' JOIN visits v ON v.id = e.visit_id' : ''}`,
      where: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /** WHERE clause + params for a visits query aliased `v`. */
  visits({ start = this.range.start, end = this.range.end } = {}) {
    const clauses = ['v.site_id = ?', 'v.started_at >= ?', 'v.started_at < ?'];
    const params = [this.site.id, start, end];
    for (const filter of this.filters) {
      // Session dimensions are on `visits` already; event-level filters have to
      // go through the event table.
      if (VISIT_EQUIVALENT[filter.key]) {
        const { sql, params: p } = filterCondition(filter, this.goals, { forVisits: true });
        clauses.push(sql);
        params.push(...p);
      } else {
        const sub = this.events({ start, end });
        clauses.push(`v.id IN (SELECT e.visit_id ${sub.from} ${sub.where})`);
        params.push(...sub.params);
        break; // one subquery carries every remaining event-level filter
      }
    }
    return { from: 'FROM visits v', where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  withFilters(extra) {
    return new Scope({
      site: this.site,
      range: this.range,
      filters: [...this.filters, ...extra],
      goals: this.goals,
    });
  }
}
