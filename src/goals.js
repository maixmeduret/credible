/**
 * Goals and funnels.
 *
 * A goal is either a custom event name ("Signup") or a page path ("/thanks",
 * or "/blog/*" with a trailing wildcard). Funnels are ordered lists of goals.
 */
import { all, get, run, transaction, now } from './db/index.js';
import { HttpError } from './util/http.js';

export function listGoals(siteId) {
  return all('SELECT * FROM goals WHERE site_id = ? ORDER BY id', [siteId]);
}

export function findGoal(siteId, id) {
  return get('SELECT * FROM goals WHERE site_id = ? AND id = ?', [siteId, id]);
}

export function createGoal(siteId, { type, event_name = '', page_path = '', display_name = '' }) {
  const kind = type === 'page' ? 'page' : 'event';
  const name = String(event_name || '').trim().slice(0, 120);
  const path = String(page_path || '').trim().slice(0, 500);

  if (kind === 'event' && !name) throw new HttpError(422, 'An event goal needs an event name');
  if (kind === 'page' && !path.startsWith('/')) throw new HttpError(422, 'A page goal needs a path starting with /');

  const existing = get(
    'SELECT id FROM goals WHERE site_id = ? AND type = ? AND event_name = ? AND page_path = ?',
    [siteId, kind, name, path],
  );
  if (existing) return findGoal(siteId, existing.id);

  const result = run(
    'INSERT INTO goals (site_id, type, event_name, page_path, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [siteId, kind, name, path, String(display_name || '').slice(0, 120) || (kind === 'page' ? `Visit ${path}` : name), now()],
  );
  return findGoal(siteId, Number(result.lastInsertRowid));
}

export function deleteGoal(siteId, id) {
  run('DELETE FROM goals WHERE site_id = ? AND id = ?', [siteId, id]);
}

/** Event names seen recently, to suggest goals in the UI. */
export function suggestGoals(siteId, limit = 20) {
  return all(
    `SELECT name, count(*) AS events, count(DISTINCT visitor_id) AS visitors
       FROM events
      WHERE site_id = ? AND name NOT IN ('pageview', 'engagement')
        AND timestamp > unixepoch() - 90 * 86400
      GROUP BY 1 ORDER BY visitors DESC LIMIT ?`,
    [siteId, limit],
  );
}

// ---------------------------------------------------------------- funnels --

export function listFunnels(siteId) {
  return all('SELECT * FROM funnels WHERE site_id = ? ORDER BY id', [siteId]).map((funnel) => ({
    ...funnel,
    steps: funnelSteps(funnel.id),
  }));
}

export function funnelSteps(funnelId) {
  return all(
    `SELECT g.* FROM funnel_steps fs JOIN goals g ON g.id = fs.goal_id
      WHERE fs.funnel_id = ? ORDER BY fs.step_index`,
    [funnelId],
  );
}

export function createFunnel(siteId, { name, goalIds = [] }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) throw new HttpError(422, 'A funnel needs a name');
  if (goalIds.length < 2) throw new HttpError(422, 'A funnel needs at least two steps');
  if (goalIds.length > 8) throw new HttpError(422, 'A funnel can have at most eight steps');

  return transaction(() => {
    const result = run('INSERT INTO funnels (site_id, name, created_at) VALUES (?, ?, ?)', [siteId, label, now()]);
    const id = Number(result.lastInsertRowid);
    goalIds.forEach((goalId, index) => {
      if (!findGoal(siteId, goalId)) throw new HttpError(422, `Unknown goal: ${goalId}`);
      run('INSERT INTO funnel_steps (funnel_id, step_index, goal_id) VALUES (?, ?, ?)', [id, index, goalId]);
    });
    return { ...get('SELECT * FROM funnels WHERE id = ?', [id]), steps: funnelSteps(id) };
  });
}

export function deleteFunnel(siteId, id) {
  run('DELETE FROM funnels WHERE site_id = ? AND id = ?', [siteId, id]);
}
