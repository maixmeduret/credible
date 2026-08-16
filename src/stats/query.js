/**
 * Query scope: turns a dashboard request (site + period + filters) into a
 * bound SQL fragment.
 *
 * Every dimension the UI can group or filter by is declared in DIMENSIONS.
 * Nothing outside that table ever reaches SQL, and every value is bound —
 * there is no string interpolation of user input anywhere in this file.
 *
 * A filter is a tree. The leaves are the six comparison operators (plus `glob`
 * and its negation); the branches are `and` / `or` / `not`, and the two
 * behavioural operators `has_done` / `has_not_done`, which widen a condition
 * from "this event" to "any event this visitor sent in the period". A plain
 * flat array of leaves — the format the dashboard writes into the URL — is
 * still valid and still means AND.
 */
import { getDb } from '../db/index.js';
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

/**
 * Leaf operators — the ones that compare a dimension to a list of values.
 *
 * `matches` is a real regular expression (see below). `glob` is the SQLite
 * GLOB that `matches` used to be, kept under its own name so anything already
 * relying on `/blog/*` keeps working.
 */
export const FILTER_OPERATORS = new Set([
  'is',
  'is_not',
  'contains',
  'contains_not',
  'matches',
  'matches_not',
  'glob',
  'glob_not',
]);

/** Branch operators — the ones whose operands are other filters. */
const GROUP_OPERATORS = new Set(['and', 'or']);
const UNARY_OPERATORS = new Set(['not', 'has_done', 'has_not_done']);
export const COMPOSITE_OPERATORS = new Set([...GROUP_OPERATORS, ...UNARY_OPERATORS]);

/**
 * Limits on the shape of a filter tree. A tree arrives from the network and is
 * compiled into one SQL statement, so both its depth (nesting of subqueries)
 * and its size (number of bound conditions) have to be bounded before the
 * planner ever sees it.
 */
const MAX_FILTER_DEPTH = 5;
const MAX_FILTER_NODES = 40;

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

  // hasOwn, not a bare lookup: `DIMENSIONS['constructor']` inherits a truthy
  // value from Object.prototype and would resolve to an undefined column.
  if (!Object.hasOwn(DIMENSIONS, key)) throw new HttpError(422, `Unknown dimension: ${key}`);
  const dim = DIMENSIONS[key];
  if (forVisits && Object.hasOwn(VISIT_EQUIVALENT, key)) {
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

// ---------------------------------------------------------------- regexp --

/**
 * `matches` is a user-supplied regular expression that SQLite runs once per
 * candidate row, so it is the one place in the stats engine where a request can
 * buy unbounded CPU. Three defences, in order:
 *
 *   1. a hard length cap — long patterns are almost always machine generated;
 *   2. a structural check for the catastrophic-backtracking shapes, plus a
 *      refusal of backreferences and lookaround (which re2, the engine
 *      Plausible's API accepts patterns for, does not have either);
 *   3. compilation at parse time, so a bad pattern is a 422 on the request that
 *      introduced it rather than a failure inside a query months later, when it
 *      is a saved segment nobody remembers writing.
 */
const MAX_PATTERN_LENGTH = 200;
const MAX_QUANTIFIERS = 20;
const MAX_GROUP_DEPTH = 10;
const MAX_REPETITIONS = 1000;
const MAX_CACHED_PATTERNS = 512;

/**
 * Compiled patterns, keyed by their source text.
 *
 * The SQL function below is called once per row, so compiling there would
 * recompile the same pattern thousands of times in a single query. Patterns are
 * compiled once, when the filter is parsed, and looked up here. Bounded, so a
 * long-lived process cannot accumulate every pattern anyone has ever typed.
 */
const PATTERNS = new Map();

function remember(pattern, compiled) {
  if (PATTERNS.size >= MAX_CACHED_PATTERNS) {
    // Map iterates in insertion order, so this drops the oldest entry.
    PATTERNS.delete(PATTERNS.keys().next().value);
  }
  PATTERNS.set(pattern, compiled);
}

/**
 * Validate and compile one pattern, or throw HttpError(422) naming it.
 * Returns the compiled RegExp so callers can reuse it.
 */
export function compilePattern(pattern) {
  const cached = PATTERNS.get(pattern);
  if (cached) return cached; // already validated once

  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new HttpError(
      422,
      `Regular expression is too long (max ${MAX_PATTERN_LENGTH} characters): ${pattern.slice(0, 60)}…`,
    );
  }

  let compiled;
  try {
    // No flags: no `g` (which would make `test()` stateful across rows) and no
    // `i` (Plausible's `matches` is case sensitive, and so is ours).
    compiled = new RegExp(pattern);
  } catch (err) {
    throw new HttpError(422, `Invalid regular expression: ${pattern}`, { reason: err.message });
  }

  assertSafePattern(pattern);
  remember(pattern, compiled);
  return compiled;
}

/**
 * Reject the patterns whose running time is not linear in the subject.
 *
 * Two shapes matter, and neither is caught by the caps above.
 *
 * The first is a repetition wrapped around something that can already match the
 * same text more than one way — `(a+)+`, `(a|a)*`, `((x)*y)+`. On a subject that
 * ends up failing, the engine tries every split and the cost explodes.
 *
 * The second has no group in it at all: two repetitions side by side that can
 * match the same character. `a*a*b` is quadratic in the subject, `a*a*a*a*b`
 * quartic — measured at 112ms on sixty characters, and it runs once per row —
 * and ten of them never finish. So an atom carrying a repetition is compared
 * against the one before it, and they may not overlap.
 */
function assertSafePattern(pattern) {
  const groups = []; // one frame per open group; `risky` = body matches ambiguously
  let quantifiers = 0;
  let inClass = false;
  let classStart = -1;
  // What the atom immediately to the left can match, when that atom carries a
  // repetition that can run more than once. `undefined` means there is no such
  // atom: the run was broken by a literal the engine cannot backtrack across.
  let repeated;

  const risky = () => {
    if (groups.length) groups[groups.length - 1].risky = true;
  };

  /** Close off one atom: `set` is what it matches, `at` its last character. */
  const settle = (set, at) => {
    if (!repeatsMoreThanOnce(pattern, at + 1)) {
      repeated = undefined;
      return;
    }
    if (repeated !== undefined && overlaps(repeated, set)) {
      throw new HttpError(
        422,
        `Regular expression could take exponential time — two repetitions in a row can match the same text: ${pattern}`,
      );
    }
    repeated = set;
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next >= '1' && next <= '9') {
        throw new HttpError(422, `Backreferences are not supported in a filter regex: ${pattern}`);
      }
      i += 1; // the escaped character is a literal, whatever it is
      if (!inClass) settle(escapeSet(next), i);
      continue;
    }

    if (inClass) {
      if (ch === ']') {
        inClass = false;
        settle(classSet(pattern.slice(classStart + 1, i)), i);
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      classStart = i;
      continue;
    }

    if (ch === '(') {
      if (groups.length >= MAX_GROUP_DEPTH) {
        throw new HttpError(422, `Regular expression nests groups more than ${MAX_GROUP_DEPTH} deep: ${pattern}`);
      }
      // A group is its own adjacency scope: in `(/[a-z]+)*` the `+` inside and
      // the `*` outside are separated by the group's own `/`, so the two never
      // compete for the same characters.
      groups.push({ risky: false, repeated });
      repeated = undefined;
      if (pattern[i + 1] === '?') {
        if (/^\?(=|!|<=|<!)/.test(pattern.slice(i + 1, i + 4))) {
          throw new HttpError(422, `Lookahead and lookbehind are not supported in a filter regex: ${pattern}`);
        }
        // Skip the group prefix so its `?` is not counted as a quantifier. A
        // malformed one cannot get here — new RegExp already accepted the
        // pattern — but an unterminated name would wind `i` backwards and spin
        // this loop forever, which is the exact failure this file exists to
        // prevent, so bail out rather than trust that.
        if (pattern[i + 2] === ':') i += 2; // (?: — non-capturing
        else if (pattern[i + 2] === '<') {
          const named = pattern.indexOf('>', i + 3); // (?<name>
          if (named < 0) break;
          i = named;
        }
      }
      continue;
    }

    if (ch === '|') {
      // An alternation makes the enclosing group ambiguous in exactly the way a
      // repetition of it would exploit.
      risky();
      repeated = undefined; // and it starts a fresh sequence of atoms
      continue;
    }

    if (ch === ')') {
      const frame = groups.pop();
      if (frame?.risky && repeatsMoreThanOnce(pattern, i + 1)) {
        throw new HttpError(
          422,
          `Regular expression could take exponential time — a repeated group that itself repeats or alternates: ${pattern}`,
        );
      }
      // The parent inherits the ambiguity: `((a+)b)+` is the same bomb.
      if (frame?.risky) risky();
      // Back in the enclosing scope, where the group is one atom. What it can
      // match is not worth modelling, so it overlaps with everything.
      repeated = frame ? frame.repeated : undefined;
      settle(ANY, i);
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?') {
      quantifiers += 1;
      risky();
      continue;
    }

    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      const body = close === -1 ? '' : pattern.slice(i + 1, close);
      if (!/^\d+(,\d*)?$/.test(body)) continue; // a literal brace, not a repetition
      const bounds = body.split(',').map(Number);
      if (bounds.some((n) => n > MAX_REPETITIONS)) {
        throw new HttpError(422, `Regular expression repeats more than ${MAX_REPETITIONS} times: ${pattern}`);
      }
      quantifiers += 1;
      risky();
      i = close;
      continue;
    }

    settle(ch === '.' ? ANY : charSet(ch), i);
  }

  if (quantifiers > MAX_QUANTIFIERS) {
    throw new HttpError(422, `Regular expression has more than ${MAX_QUANTIFIERS} repetitions: ${pattern}`);
  }
}

/**
 * What one atom can match, as sorted code point ranges — or ANY, which stands
 * for "this scanner does not read that" and overlaps with everything. Only
 * precise enough to tell `[0-9]*[a-z]*` (disjoint, linear, allowed) from
 * `\w*[a-z]*` (overlapping, quadratic, refused).
 */
const ANY = null;

const SHORTHAND = {
  d: [[48, 57]],
  w: [[48, 57], [65, 90], [95, 95], [97, 122]],
  s: [[9, 13], [32, 32], [160, 160]],
};
const CONTROL_ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };

const charSet = (ch) => [[ch.codePointAt(0), ch.codePointAt(0)]];

function escapeSet(ch) {
  if (ch === undefined) return ANY;
  if (Object.hasOwn(SHORTHAND, ch)) return SHORTHAND[ch];
  if (Object.hasOwn(CONTROL_ESCAPES, ch)) return charSet(CONTROL_ESCAPES[ch]);
  // `\.` `\/` `\-` are the escaped literal. `\D` `\W` `\S` are complements and
  // `\b` `\x` `\u` `\p` introduce something this scanner does not read, so they
  // all fall back to ANY rather than being mistaken for the letter itself.
  return /[a-zA-Z0-9]/.test(ch) ? ANY : charSet(ch);
}

function classSet(body) {
  if (body.startsWith('^')) return ANY; // negated: the complement, not worth modelling
  const ranges = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') {
      const set = escapeSet(body[i + 1]);
      if (set === ANY) return ANY;
      ranges.push(...set);
      i += 1;
      continue;
    }
    if (body[i + 1] === '-' && i + 2 < body.length && body[i + 2] !== '\\') {
      ranges.push([body.codePointAt(i), body.codePointAt(i + 2)]);
      i += 2;
      continue;
    }
    ranges.push([body.codePointAt(i), body.codePointAt(i)]);
  }
  return ranges.length ? ranges : ANY;
}

function overlaps(a, b) {
  if (a === ANY || b === ANY) return true;
  return a.some(([lo, hi]) => b.some(([lo2, hi2]) => lo <= hi2 && lo2 <= hi));
}

/**
 * Is the quantifier at `at` one that can run its operand more than once?
 *
 * `?` and `{0,1}` cannot, so `(a|b)?` is harmless and stays allowed — only an
 * operand the engine can retry, `*` `+` `{2,}`, turns an ambiguous group into a
 * backtracking bomb.
 */
function repeatsMoreThanOnce(pattern, at) {
  const ch = pattern[at];
  if (ch === '*' || ch === '+') return true;
  if (ch !== '{') return false;
  const close = pattern.indexOf('}', at);
  if (close === -1) return false;
  const body = pattern.slice(at + 1, close);
  if (!/^\d+(,\d*)?$/.test(body)) return false; // a literal brace, not a repetition
  const [min, max] = body.split(',');
  if (max === undefined) return Number(min) > 1; // {n}
  return max === '' || Number(max) > 1; // {n,} and {n,m}
}

/**
 * SQLite has no REGEXP of its own — the `x REGEXP y` syntax parses but calls a
 * function named `regexp` that has to be supplied by the host. node:sqlite
 * exposes `DatabaseSync#function(name, options, fn)` for exactly that, and
 * SQLite calls it as `regexp(pattern, value)`.
 */
const REGISTERED = new WeakSet();

function ensureRegexp() {
  const handle = getDb();
  if (REGISTERED.has(handle)) return;
  handle.function('regexp', { deterministic: true, directOnly: true }, matchPattern);
  REGISTERED.add(handle);
}

function matchPattern(pattern, value) {
  if (typeof pattern !== 'string') return 0;
  // NULL and BLOB never match; a numeric column (json_extract of a numeric
  // property) is compared as its text, which is what the dashboard displays.
  const subject =
    typeof value === 'string' ? value
      : typeof value === 'number' || typeof value === 'bigint' ? String(value)
        : null;
  if (subject === null) return 0;

  let compiled = PATTERNS.get(pattern);
  if (!compiled) {
    // Only patterns that already passed compilePattern() can be bound into a
    // query, so a miss here means the cache was trimmed between parse and
    // execution. Recompiling keeps the answer right.
    try {
      compiled = new RegExp(pattern);
    } catch {
      return 0;
    }
    remember(pattern, compiled);
  }
  return compiled.test(subject) ? 1 : 0;
}

// ---------------------------------------------------------------- parsing --

/**
 * Every key a filter may name: the declared dimensions, the goal pseudo
 * dimension, and any custom property.
 */
export function assertFilterableKey(key) {
  if (Array.isArray(key)) {
    // A nested node turned up where a dimension belongs — nearly always a
    // misspelled composition operator. Say that, rather than reporting the
    // whole subtree as an unknown dimension.
    throw new HttpError(422, 'A filter dimension cannot be a nested filter — compose with "and", "or" or "not"');
  }
  if (typeof key !== 'string' || !key) throw new HttpError(422, 'A filter needs a dimension');
  if (key === 'event:goal') return key;
  if (key.startsWith(PROP_PREFIX)) {
    const prop = key.slice(PROP_PREFIX.length);
    if (!prop || prop.length > 64) throw new HttpError(422, `Invalid property: ${key}`);
    return key;
  }
  if (!Object.hasOwn(DIMENSIONS, key)) throw new HttpError(422, `Unknown dimension: ${key}`);
  return key;
}

/**
 * Parse the `filters` query parameter.
 *
 * Wire format (JSON), a list of nodes that are AND-ed together:
 *   [["is","visit:country",["FR","BE"]], ["contains","event:page",["/blog"]]]
 *
 * A node is either a leaf — [operator, dimension, values] — or a branch:
 *   ["and", [ <node>, <node> ]]
 *   ["or",  [ <node>, <node> ]]
 *   ["not", <node> ]
 *   ["has_done", <node> ]        visitors who matched <node> at some point
 *   ["has_not_done", <node> ]
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

  // One budget for the whole request: twenty top-level filters that each nest
  // are still twenty subtrees to compile.
  const budget = { nodes: 0 };
  return raw.map((entry) => parseNode(entry, 1, budget));
}

function parseNode(entry, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_FILTER_NODES) {
    throw new HttpError(422, `A filter may not hold more than ${MAX_FILTER_NODES} conditions`);
  }
  if (depth > MAX_FILTER_DEPTH) {
    throw new HttpError(422, `Filters may not nest more than ${MAX_FILTER_DEPTH} levels deep`);
  }
  if (!Array.isArray(entry) || entry.length < 2) throw new HttpError(422, 'Malformed filter');

  const operator = entry[0];
  if (typeof operator !== 'string') throw new HttpError(422, 'Malformed filter');

  if (GROUP_OPERATORS.has(operator)) {
    const operands = entry[1];
    if (!Array.isArray(operands) || !operands.length) {
      throw new HttpError(422, `"${operator}" takes a list of filters`);
    }
    return branch(operator, operands.map((operand) => parseNode(operand, depth + 1, budget)));
  }

  if (UNARY_OPERATORS.has(operator)) {
    return branch(operator, [parseNode(unwrapSingle(entry[1]), depth + 1, budget)]);
  }

  return leaf(entry);
}

/**
 * `["not", <node>]` is the documented shape. `and` and `or` take a list, so
 * people write a one-element list for the unary operators too; it means the
 * same thing and costs nothing to accept.
 */
function unwrapSingle(operand) {
  if (Array.isArray(operand) && operand.length === 1 && Array.isArray(operand[0])) return operand[0];
  return operand;
}

/**
 * A branch node.
 *
 * `key` holds the operand in *wire* form and `values` is null, so the tuple
 * `[operator, key, values]` — exactly what src/segments.js writes into a saved
 * segment — parses back into the same tree. `children` holds the parsed form so
 * that building SQL never has to parse anything again.
 */
function branch(operator, children) {
  const operand = GROUP_OPERATORS.has(operator) ? children.map(toWire) : toWire(children[0]);
  return { operator, key: operand, values: null, children };
}

const toWire = (node) => [node.operator, node.key, node.values];

function leaf(entry) {
  if (entry.length < 3) throw new HttpError(422, 'Malformed filter');
  const [operator, key, values] = entry;
  if (!FILTER_OPERATORS.has(operator)) throw new HttpError(422, `Unknown filter operator: ${operator}`);
  // Validate the dimension here rather than at query time. A saved segment is
  // written once and read forever; rejecting a bad key at the point somebody
  // can still fix it beats failing inside a query months later.
  assertFilterableKey(key);
  const list = (Array.isArray(values) ? values : [values]).map((v) => String(v ?? '').slice(0, 500));
  if (!list.length) throw new HttpError(422, 'Filter needs at least one value');
  if (list.length > 100) throw new HttpError(422, 'Too many filter values');
  // Same reasoning for the pattern itself, with teeth: an unbounded regex is a
  // denial of service against the whole instance, not just this query.
  if (operator === 'matches' || operator === 'matches_not') list.forEach(compilePattern);
  return { operator, key, values: list };
}

// -------------------------------------------------------------- compiling --

/** Does this subtree need `visits` joined into the query it sits in? */
function usesVisitTable(node) {
  // A behavioural node joins inside its own subquery, so it never makes the
  // query around it need one.
  if (node.operator === 'has_done' || node.operator === 'has_not_done') return false;
  if (node.children) return node.children.some(usesVisitTable);
  return node.key === 'visit:entry_page' || node.key === 'visit:exit_page';
}

/**
 * Compile one node to a bound SQL condition.
 *
 * `options` carries `forVisits` (resolve dimensions against `visits`) and the
 * enclosing query's `siteId` / `start` / `end`, which the behavioural operators
 * need to scope their subquery to the same period.
 */
function filterCondition(filter, goals, options) {
  switch (filter.operator) {
    case 'and':
    case 'or': {
      const parts = filter.children.map((child) => filterCondition(child, goals, options));
      const glue = filter.operator === 'and' ? ' AND ' : ' OR ';
      return {
        sql: `(${parts.map((p) => p.sql).join(glue)})`,
        params: parts.flatMap((p) => p.params),
      };
    }
    case 'not': {
      const inner = filterCondition(filter.children[0], goals, options);
      // NOT NULL is NULL in SQL, and WHERE drops a NULL row — so a row the inner
      // condition could not decide would disappear from both sides of the
      // negation. Folding NULL to false first makes `not` a true complement.
      return { sql: `(NOT COALESCE(${inner.sql}, 0))`, params: inner.params };
    }
    case 'has_done':
    case 'has_not_done':
      return behaviouralCondition(filter, goals, options);
    default:
      return leafCondition(filter, goals, options);
  }
}

/**
 * "Visitors who at some point in the period did X" — the question behind
 * "people who saw the pricing page and then left".
 *
 * The inner filter is matched against every event the visitor sent in the same
 * window, and the result is the visitor's whole activity, not just the events
 * that matched.
 */
function behaviouralCondition(filter, goals, options) {
  const { siteId, start, end } = options;
  if (siteId == null) throw new Error('behavioural filters need the enclosing query scope');

  // Always event scoped: the subquery reads `events`, whatever the outer query
  // is doing.
  const inner = filterCondition(filter.children[0], goals, { siteId, start, end });
  const join = usesVisitTable(filter.children[0]) ? ' JOIN visits v ON v.id = e.visit_id' : '';
  const membership = filter.operator === 'has_done' ? 'IN' : 'NOT IN';

  // The subquery re-declares `e` (and `v`), shadowing the outer aliases for its
  // own duration — which is exactly right: the inner filter describes a
  // *different* event by the same visitor, never the row being tested.
  // `events.visitor_id` is NOT NULL, so `NOT IN` cannot be defeated by a NULL.
  return {
    sql: `e.visitor_id ${membership} (SELECT e.visitor_id FROM events e${join}
             WHERE e.site_id = ? AND e.timestamp >= ? AND e.timestamp < ? AND ${inner.sql})`,
    params: [siteId, start, end, ...inner.params],
  };
}

/**
 * `col OP ?` for every value, OR-ed together. A `_not` operator negates the
 * whole thing and keeps rows where the column is unset, which is what a person
 * means by "not /blog" — `col` appears twice, so its own bound params repeat.
 */
function anyOf(filter, col, colParams, comparison, bind = (value) => value) {
  const clause = `(${filter.values.map(() => `${col} ${comparison}`).join(' OR ')})`;
  const params = [];
  for (const value of filter.values) params.push(...colParams, bind(value));
  if (!filter.operator.endsWith('_not')) return { sql: clause, params };
  return { sql: `(NOT ${clause} OR ${col} IS NULL)`, params: [...params, ...colParams] };
}

function leafCondition(filter, goals, options) {
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
    case 'contains_not':
      return anyOf(filter, col, colParams, "LIKE ? ESCAPE '\\'", (value) => `%${escapeLike(value)}%`);
    case 'glob':
    case 'glob_not':
      return anyOf(filter, col, colParams, 'GLOB ?');
    case 'matches':
    case 'matches_not':
      // Register before the caller prepares the statement: SQLite resolves
      // function names at prepare time and would fail with "no such function".
      ensureRegexp();
      return anyOf(filter, col, colParams, 'REGEXP ?');
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
    this.needsVisitJoin = filters.some(usesVisitTable);
  }

  /** WHERE clause + params for an events query aliased `e`. */
  events({ start = this.range.start, end = this.range.end } = {}) {
    const clauses = ['e.site_id = ?', 'e.timestamp >= ?', 'e.timestamp < ?'];
    const params = [this.site.id, start, end];
    const options = { siteId: this.site.id, start, end };
    for (const filter of this.filters) {
      const { sql, params: p } = filterCondition(filter, this.goals, options);
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
    const options = { forVisits: true, siteId: this.site.id, start, end };
    for (const filter of this.filters) {
      // Session dimensions are on `visits` already; event-level filters — and
      // every composed or behavioural one, whose `key` is a subtree rather than
      // a dimension — have to go through the event table.
      if (typeof filter.key === 'string' && Object.hasOwn(VISIT_EQUIVALENT, filter.key)) {
        const { sql, params: p } = filterCondition(filter, this.goals, options);
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
