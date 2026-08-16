/**
 * Saved segments and graph annotations.
 *
 * A segment is a named set of filters — "mobile visitors from France", "people
 * who saw the pricing page" — that anyone on the site can apply in one click
 * instead of rebuilding it. Annotations are dated notes drawn on the graph, so
 * next month's spike still has an explanation attached to it.
 */
import { all, get, run, now } from './db/index.js';
import { HttpError } from './util/http.js';
import { parseFilters } from './stats/query.js';

const SCOPES = new Set(['personal', 'site']);

// ---------------------------------------------------------------- segments --

/** Site-wide segments, plus this user's own personal ones. */
export function listSegments(siteId, userId = null) {
  return all(
    `SELECT s.*, u.email AS owner_email
       FROM segments s LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.site_id = ? AND (s.scope = 'site' OR s.owner_id = ?)
      ORDER BY s.scope DESC, s.name`,
    [siteId, userId],
  ).map(present);
}

export function findSegment(siteId, id) {
  const row = get('SELECT * FROM segments WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
  return row ? present(row) : null;
}

export function createSegment(siteId, userId, { name, filters, scope = 'personal' }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) throw new HttpError(422, 'A segment needs a name');
  if (!SCOPES.has(scope)) throw new HttpError(422, 'scope must be "personal" or "site"');

  const encoded = encodeFilters(filters);
  const stamp = now();
  const result = run(
    'INSERT INTO segments (site_id, name, filters, scope, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [siteId, label, encoded, scope, userId, stamp, stamp],
  );
  return findSegment(siteId, Number(result.lastInsertRowid));
}

export function updateSegment(siteId, userId, id, patch = {}) {
  const segment = get('SELECT * FROM segments WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
  if (!segment) throw new HttpError(404, 'Segment not found');
  // A personal segment belongs to one person; a site segment belongs to the site.
  if (segment.scope === 'personal' && segment.owner_id !== userId) {
    throw new HttpError(403, 'That segment belongs to someone else');
  }

  const fields = [];
  const values = [];
  if (patch.name !== undefined) {
    const label = String(patch.name).trim().slice(0, 120);
    if (!label) throw new HttpError(422, 'A segment needs a name');
    fields.push('name = ?');
    values.push(label);
  }
  if (patch.filters !== undefined) {
    fields.push('filters = ?');
    values.push(encodeFilters(patch.filters));
  }
  if (patch.scope !== undefined) {
    if (!SCOPES.has(patch.scope)) throw new HttpError(422, 'scope must be "personal" or "site"');
    fields.push('scope = ?');
    values.push(patch.scope);
  }
  if (!fields.length) return present(segment);

  fields.push('updated_at = ?');
  values.push(now(), siteId, Number(id));
  run(`UPDATE segments SET ${fields.join(', ')} WHERE site_id = ? AND id = ?`, values);
  return findSegment(siteId, id);
}

export function deleteSegment(siteId, userId, id) {
  const segment = get('SELECT * FROM segments WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
  if (!segment) return;
  if (segment.scope === 'personal' && segment.owner_id !== userId) {
    throw new HttpError(403, 'That segment belongs to someone else');
  }
  run('DELETE FROM segments WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
}

/**
 * Filters are stored in the same JSON wire format the dashboard puts in the
 * URL, and validated on the way in so a saved segment can never be the thing
 * that breaks a query later.
 */
function encodeFilters(filters) {
  const raw = typeof filters === 'string' ? filters : JSON.stringify(filters ?? []);
  const parsed = parseFilters(raw); // throws HttpError(422) on anything malformed
  if (!parsed.length) throw new HttpError(422, 'A segment needs at least one filter');
  return JSON.stringify(parsed.map((f) => [f.operator, f.key, f.values]));
}

function present(row) {
  return {
    id: row.id,
    name: row.name,
    filters: JSON.parse(row.filters),
    scope: row.scope,
    owner_id: row.owner_id,
    owner_email: row.owner_email || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ------------------------------------------------------------- annotations --

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function listAnnotations(siteId, { from = '', to = '' } = {}) {
  const clauses = ['a.site_id = ?'];
  const params = [siteId];
  if (YMD.test(from)) {
    clauses.push('a.date >= ?');
    params.push(from);
  }
  if (YMD.test(to)) {
    clauses.push('a.date <= ?');
    params.push(to);
  }
  return all(
    `SELECT a.id, a.date, a.text, a.created_at, u.email AS author_email
       FROM annotations a LEFT JOIN users u ON u.id = a.author_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.date, a.id`,
    params,
  );
}

export function createAnnotation(siteId, userId, { date, text }) {
  if (!YMD.test(String(date || ''))) throw new HttpError(422, 'date must be YYYY-MM-DD');
  const body = String(text || '').trim().slice(0, 500);
  if (!body) throw new HttpError(422, 'An annotation needs some text');

  const result = run(
    'INSERT INTO annotations (site_id, date, text, author_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [siteId, date, body, userId, now()],
  );
  return get('SELECT * FROM annotations WHERE id = ?', [Number(result.lastInsertRowid)]);
}

export function deleteAnnotation(siteId, id) {
  run('DELETE FROM annotations WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
}
