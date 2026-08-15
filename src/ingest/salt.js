/**
 * Visitor identification without cookies, without fingerprinting.
 *
 *   visitor_id = base64url(sha256(daily_salt + site_id + ip + user_agent))[0..21]
 *
 * The salt is random, rotates every UTC midnight, and is deleted after 48h.
 * Once a salt is gone the hash cannot be recomputed or reversed, so yesterday's
 * visitor ids can never be linked to today's. This is what lets Credible count
 * unique visitors while storing nothing that identifies a person.
 */
import crypto from 'node:crypto';
import { get, run } from '../db/index.js';

const cache = new Map(); // day -> salt

function utcDay(unix = Math.floor(Date.now() / 1000)) {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** The salt for a given UTC day, generated on first use. */
export function saltForDay(day = utcDay()) {
  const cached = cache.get(day);
  if (cached) return cached;

  let row = get('SELECT salt FROM daily_salts WHERE day = ?', [day]);
  if (!row) {
    const salt = crypto.randomBytes(32).toString('base64');
    run('INSERT OR IGNORE INTO daily_salts (day, salt, created_at) VALUES (?, ?, unixepoch())', [day, salt]);
    row = get('SELECT salt FROM daily_salts WHERE day = ?', [day]);
    purgeOldSalts();
  }
  cache.set(day, row.salt);
  if (cache.size > 4) {
    for (const key of cache.keys()) {
      if (key !== day) cache.delete(key);
      if (cache.size <= 2) break;
    }
  }
  return row.salt;
}

/** Drop salts older than 48h — the point of no return for re-identification. */
export function purgeOldSalts(unix = Math.floor(Date.now() / 1000)) {
  const cutoff = utcDay(unix - 2 * 86400);
  run('DELETE FROM daily_salts WHERE day < ?', [cutoff]);
  for (const key of [...cache.keys()]) if (key < cutoff) cache.delete(key);
}

/**
 * @param {number} siteId
 * @param {string} ip   raw client IP — used here and never stored
 * @param {string} userAgent
 * @param {number} [at] unix seconds, for tests and backfills
 */
export function visitorId(siteId, ip, userAgent, at = Math.floor(Date.now() / 1000)) {
  const salt = saltForDay(utcDay(at));
  return crypto
    .createHash('sha256')
    .update(`${salt}|${siteId}|${ip || ''}|${userAgent || ''}`)
    .digest('base64url')
    .slice(0, 22);
}

export { utcDay };
