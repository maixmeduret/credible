/**
 * Path exploration — where visitors actually went.
 *
 * A funnel answers "did they walk the path we designed?". This file answers the
 * question that comes before it: "what path did they walk?" — an open-ended
 * tree of the sequences that really happened, forwards out of a page or
 * backwards into it.
 *
 * The unit of a journey is one visit: its pageviews in time order, plus any
 * custom event that the site has declared a goal, with immediate repeats
 * collapsed because a reload is not a step. Engagement pings are never steps —
 * they measure a pageview, they are not a navigation.
 *
 * SQLite numbers the steps (one window function, one pass) and JS folds them
 * into a tree, because "keep the eight biggest branches of this level" is a
 * ranking over a whole level and SQL has no sane way to say it.
 */
import { all } from '../db/index.js';
import { goalCondition } from './query.js';

/**
 * Ceilings that stop one request from reading a busy site's whole year into
 * memory. Neither is applied silently: both raise `truncated`.
 *
 * MAX_ROWS bounds the request; MAX_STEPS_PER_VISIT bounds a single pathological
 * visit, so one tab left open on a polling page cannot eat the whole budget and
 * starve every other visit of the period.
 */
const MAX_ROWS = 200_000;
const MAX_STEPS_PER_VISIT = 100;

/** The bucket every branch outside the top `limit` of its level falls into. */
const OTHER = 'Other';

const percent = (part, whole) => (whole ? Number(((part / whole) * 100).toFixed(1)) : 0);

/** Biggest first, then alphabetical, so an equal split is still deterministic. */
const byRank = (a, b) =>
  b.visitors.size - a.visitors.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * '/blog/2026/how-to' -> '/blog/*' at depth 1. Exported for tests and the UI.
 *
 * Only paths deeper than `depth` are grouped: '/blog' stays '/blog', because
 * folding a page into a directory that contains only itself hides a real page
 * behind a wildcard that means nothing.
 */
export function groupPath(pathname, depth = 1) {
  const path = String(pathname ?? '');
  // Goal names ("Signup") are steps too, and they are not paths. Leave them be.
  if (!path.startsWith('/')) return path;

  const levels = Math.max(1, Math.trunc(Number(depth)) || 1);
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= levels) return `/${segments.join('/')}`;
  return `/${segments.slice(0, levels).join('/')}/*`;
}

// ------------------------------------------------------------------ walks --

/**
 * Pull every candidate visit's ordered steps out of the database.
 *
 * A visit is a candidate when *any* of its events match the scope — the filter
 * selects the visits worth looking at, and then the whole visit is walked.
 * Filtering the steps themselves would produce journeys with holes in them:
 * "/pricing then /thanks" for someone who actually saw four pages in between.
 *
 * @returns {{ walks: Array<{visitor: string, steps: Array<{name: string, path: string, event: string}>}>,
 *             truncated: boolean }}
 */
function collectWalks(scope, { direction = 'forward', groupDirectories = false, depth = 1 } = {}) {
  // Only event goals become steps. Page goals are pageviews already, and an
  // undeclared custom event is not a navigation the visitor made.
  const eventGoals = (scope.goals || []).filter((goal) => goal.type !== 'page' && goal.event_name);
  const labels = new Map(eventGoals.map((goal) => [goal.event_name, goal.display_name || goal.event_name]));

  const conditions = ["p.name = 'pageview'"];
  const goalParams = [];
  for (const goal of eventGoals) {
    const cond = goalCondition(goal, 'p');
    conditions.push(cond.sql);
    goalParams.push(...cond.params);
  }

  // Not user input: a two-way branch on our own `direction`. Reversing the sort
  // is the whole of backward mode — everything downstream stays identical.
  const order = direction === 'backward' ? 'DESC' : 'ASC';

  const e = scope.events();
  const rows = all(
    `WITH scoped AS (SELECT DISTINCT e.visit_id AS visit_id ${e.from} ${e.where}),
          walk AS (
            SELECT p.visit_id   AS visit_id,
                   p.visitor_id AS visitor_id,
                   p.pathname   AS pathname,
                   p.name       AS name,
                   row_number() OVER (PARTITION BY p.visit_id
                                          ORDER BY p.timestamp ${order}, p.id ${order}) AS step
              FROM events p JOIN scoped ON scoped.visit_id = p.visit_id
             WHERE p.site_id = ? AND (${conditions.join(' OR ')})
          )
     SELECT visit_id, visitor_id, pathname, name, step
       FROM walk
      WHERE step <= ?
      ORDER BY visit_id, step
      LIMIT ?`,
    [...e.params, scope.site.id, ...goalParams, MAX_STEPS_PER_VISIT, MAX_ROWS + 1],
  );

  let truncated = rows.length > MAX_ROWS;
  if (truncated) {
    // The row cap lands wherever it lands, usually inside a visit. Drop that
    // visit whole: a journey that stops for no reason is worse than one less
    // journey in the count.
    const partial = rows[rows.length - 1].visit_id;
    while (rows.length && rows[rows.length - 1].visit_id === partial) rows.pop();
  }

  const walks = [];
  let current = null;
  for (const row of rows) {
    // A visit that reached the per-visit ceiling may have been clipped, so say
    // so. It over-reports for a visit of exactly 100 pageviews, which is the
    // right way round: `truncated` promises "there may be more", not "there is".
    if (row.step >= MAX_STEPS_PER_VISIT) truncated = true;

    if (!current || current.visit !== row.visit_id) {
      current = { visit: row.visit_id, visitor: row.visitor_id, steps: [] };
      walks.push(current);
    }

    const isGoal = row.name !== 'pageview';
    const name = isGoal
      ? labels.get(row.name) || row.name
      : groupDirectories
        ? groupPath(row.pathname, depth)
        : row.pathname;

    // Collapse immediate self-repeats. A reload is not a step, and with
    // directory grouping on neither is /blog/a -> /blog/b: both are /blog/*,
    // and "/blog/* -> /blog/*" tells nobody anything.
    const previous = current.steps[current.steps.length - 1];
    if (previous && previous.name === name) continue;

    current.steps.push({ name, path: row.pathname, event: row.name });
  }

  return { walks, truncated };
}

// ---------------------------------------------------------------- journey --

/**
 * Where visitors went, starting from (or arriving at) a page.
 *
 * @param {Scope} scope
 * @param {object} options
 * @param {string} [options.startPage]   '' = start from every entry page
 * @param {string} [options.endPage]     set instead of startPage to walk backwards
 * @param {number} [options.steps=5]     1..10
 * @param {number} [options.limit=8]     branches kept per step; the rest fold into "Other"
 * @param {boolean} [options.groupDirectories=false]  /blog/a and /blog/b -> /blog/*
 * @returns {{
 *   direction: 'forward'|'backward',
 *   root: { name: string, visitors: number },
 *   steps: Array<Array<{ name: string, visitors: number, share: number,
 *                        dropoff: number, terminal: boolean,
 *                        from: string, parent: number }>>,
 *   total_visits: number,
 *   truncated: boolean
 * }}
 *
 * `root.name` is '' when no page was named: the root is then every entry page
 * (forward) or every exit page (backward), and `steps[0]` holds those pages.
 * `steps` is clamped to 1..10 and `limit` to 1..25, so the answer stays small
 * enough to read whatever the caller asks for.
 *
 * Within a level, nodes are grouped by parent in the parent's own rank order,
 * so children form contiguous runs. `parent` is the index of the parent inside
 * `steps[depth - 1]` (-1 at the first level, whose parent is the root), and it
 * is what actually makes the tree rebuildable: `from` carries only the parent's
 * *name*, and two different parents sharing a name — /cart reached from three
 * different products — are indistinguishable by name alone.
 */
export function journey(scope, options = {}) {
  const { startPage = '', endPage, groupDirectories = false } = options;
  // startPage wins when both are given: a forward walk from a named page is the
  // question people actually mean when they fill in both boxes.
  const backward = !startPage && typeof endPage === 'string';
  const direction = backward ? 'backward' : 'forward';
  const target = String((backward ? endPage : startPage) || '');
  const maxDepth = clamp(options.steps, 1, 10, 5);
  const width = clamp(options.limit, 1, 25, 8);

  const { walks, truncated } = collectWalks(scope, { direction, groupDirectories });

  const journeys = [];
  const rootVisitors = new Set();
  for (const walk of walks) {
    let seq = walk.steps;
    if (target) {
      // The steps are already in walk order, so in backward mode this finds the
      // *last* time the visit touched the page, and everything after it in the
      // array is what came before it in time.
      const at = walk.steps.findIndex((step) => step.name === target || step.path === target);
      if (at === -1) continue; // this visit never reached the page: not its journey
      seq = walk.steps.slice(at + 1);
    }
    journeys.push({ visitor: walk.visitor, seq });
    rootVisitors.add(walk.visitor);
  }

  const root = { name: target, visitors: rootVisitors.size };
  const report = { direction, root, steps: [], total_visits: journeys.length, truncated };
  if (!journeys.length) return report;

  // `index` is where the node sits in the level it was emitted into, so its
  // children can point back at it. The root is not in any level: -1.
  let frontier = [{ node: root, index: -1, journeys }];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    // Every surviving node of the previous level splits its journeys by where
    // they went next. `depth` indexes the sequence directly: a journey that
    // reached this node has already matched every earlier position.
    const groups = [];
    for (const parent of frontier) {
      const buckets = new Map();
      for (const walked of parent.journeys) {
        const step = walked.seq[depth];
        if (!step) continue; // the visit ended at the parent
        const bucket = buckets.get(step.name);
        if (bucket) bucket.push(walked);
        else buckets.set(step.name, [walked]);
      }
      if (buckets.size) groups.push({ parent: parent.node, at: parent.index, buckets });
    }
    if (!groups.length) break;

    for (const group of groups) {
      group.branches = [];
      for (const [name, bucket] of group.buckets) group.branches.push(measure(name, bucket, depth));
    }

    // The `limit` biggest branches of the level survive, wherever they hang.
    // Ranking per level rather than per parent is what keeps the answer
    // readable: keeping eight children *per node* is 4096 nodes by step four,
    // and neither a person nor a model reads that.
    const kept = new Set(groups.flatMap((group) => group.branches).sort(byRank).slice(0, width));

    const level = [];
    const next = [];
    for (const group of groups) {
      const survivors = group.branches.filter((branch) => kept.has(branch)).sort(byRank);
      const folded = group.branches.filter((branch) => !kept.has(branch));
      for (const branch of survivors) {
        const node = present(branch, group.parent, group.at);
        next.push({ node, index: level.length, journeys: branch.bucket });
        level.push(node);
      }
      // "Other" is a bag of unrelated pages, so it is never expanded: its
      // children would answer a question nobody asked. Nothing in the next
      // level will point at it, which is how a consumer knows not to draw an
      // expander on it even when `terminal` is false.
      if (folded.length) level.push(present(fold(folded), group.parent, group.at));
    }

    report.steps.push(level);
    frontier = next;
    if (!frontier.length) break;
  }

  return report;
}

/** Visitor counts for one branch of one parent, at one depth. */
function measure(name, bucket, depth) {
  const visitors = new Set();
  const ended = new Set();
  let continued = false;
  for (const walked of bucket) {
    visitors.add(walked.visitor);
    if (walked.seq.length === depth + 1) ended.add(walked.visitor);
    else continued = true;
  }
  return { name, bucket, visitors, ended, continued };
}

/** Everything that missed the cut, as one node. */
function fold(branches) {
  const visitors = new Set();
  const ended = new Set();
  let continued = false;
  for (const branch of branches) {
    for (const visitor of branch.visitors) visitors.add(visitor);
    for (const visitor of branch.ended) ended.add(visitor);
    if (branch.continued) continued = true;
  }
  return { name: OTHER, bucket: [], visitors, ended, continued };
}

function present(branch, parent, at) {
  return {
    name: branch.name,
    visitors: branch.visitors.size,
    // Share of the parent, never of the total. "Of the people who got here, how
    // many went there" is the only reading that still means something four
    // steps down, where every number is a rounding error of the total.
    share: percent(branch.visitors.size, parent.visitors),
    // In backward mode this is where the trail ends going back — the visit
    // started on this page — which is the same computation seen from the
    // other end.
    dropoff: branch.ended.size,
    // Terminal means no visit continued past this node — not merely that
    // somebody left here. It is a fact about the data; whether a node has
    // children in *this* answer is a different question, answered by `parent`
    // (an "Other" node and anything at the last requested step are both
    // childless without being terminal).
    terminal: !branch.continued,
    from: parent.name,
    // Index of the parent in the previous level, -1 for the root.
    parent: at,
  };
}

// -------------------------------------------------------------- top paths --

/**
 * The most common complete paths, as ranked sequences.
 *
 * A visit longer than `length` contributes its first `length` steps, so the
 * ranking stays about how visits *begin* rather than being shattered into one
 * unique path per visitor.
 *
 * `share` is the percentage of `total`, the visitors who walked any path at all
 * in this scope.
 *
 * @returns {{ paths: Array<{ steps: string[], visitors: number, share: number,
 *                            converted: boolean }>, total: number }}
 */
export function topPaths(scope, { length = 4, limit = 10 } = {}) {
  const size = clamp(length, 1, 10, 4);
  const top = clamp(limit, 1, 50, 10);

  const { walks } = collectWalks(scope, { direction: 'forward' });
  const converts = goalMatcher(scope.goals || []);

  const paths = new Map();
  const everyone = new Set();
  for (const walk of walks) {
    const steps = walk.steps.slice(0, size);
    if (!steps.length) continue;

    // JSON, not a joined string: a decoded pathname can contain any separator
    // we might pick, and two different sequences must never collide into one
    // key. It doubles as the tie-break, so an equal split is still ordered.
    const key = JSON.stringify(steps.map((step) => step.name));
    let entry = paths.get(key);
    if (!entry) {
      entry = {
        name: key,
        steps: JSON.parse(key),
        visitors: new Set(),
        // A conversion inside the counted steps only. Truncating the path has
        // to truncate its outcome too, or a two-step ranking would claim
        // conversions that happen on step nine.
        converted: steps.some(converts),
      };
      paths.set(key, entry);
    }
    entry.visitors.add(walk.visitor);
    everyone.add(walk.visitor);
  }

  const total = everyone.size;
  const ranked = [...paths.values()]
    .sort(byRank)
    .slice(0, top)
    .map((entry) => ({
      steps: entry.steps,
      visitors: entry.visitors.size,
      share: percent(entry.visitors.size, total),
      converted: entry.converted,
    }));

  return { paths: ranked, total };
}

/**
 * Goal matching for steps already in memory.
 *
 * Mirrors `goalCondition` in query.js deliberately: asking SQL the same
 * question would mean a self-join per step of every path, to re-derive
 * something the walk is already holding.
 */
function goalMatcher(goals) {
  const events = new Set(goals.filter((g) => g.type !== 'page' && g.event_name).map((g) => g.event_name));
  const pages = goals.filter((g) => g.type === 'page').map((g) => String(g.page_path || '')).filter(Boolean);
  const prefixes = pages.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));
  const exact = new Set(pages.filter((p) => !p.endsWith('*')));

  return (step) =>
    step.event === 'pageview'
      ? exact.has(step.path) || prefixes.some((prefix) => step.path.startsWith(prefix))
      : events.has(step.event);
}
