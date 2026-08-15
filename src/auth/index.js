/**
 * Accounts, login sessions, API keys and shared dashboard links.
 *
 * Passwords use scrypt (built into Node) with a per-password salt. Session and
 * API tokens are 256-bit random values; only their SHA-256 digest is stored for
 * API keys, so a database leak cannot be replayed against the Stats API.
 */
import crypto from 'node:crypto';
import { all, get, run, now } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, parseCookies, serializeCookie } from '../util/http.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'credible_session';

// ------------------------------------------------------------- passwords --

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new HttpError(422, 'Password must be at least 8 characters');
  if (value.length > 200) throw new HttpError(422, 'Password is too long');
  return value;
}

export function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(422, 'Enter a valid email address');
  return value;
}

const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ----------------------------------------------------------------- users --

export function userCount() {
  return get('SELECT count(*) AS c FROM users').c;
}

export function findUserByEmail(email) {
  return get('SELECT * FROM users WHERE lower(email) = ?', [String(email || '').trim().toLowerCase()]);
}

export function findUser(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export function createUser({ email, password, name = '' }) {
  const normalized = normalizeEmail(email);
  validatePassword(password);
  if (findUserByEmail(normalized)) throw new HttpError(409, 'An account with this email already exists');
  const result = run(
    'INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [normalized, String(name || '').slice(0, 100), hashPassword(password), now()],
  );
  return findUser(Number(result.lastInsertRowid));
}

export function changePassword(userId, password) {
  validatePassword(password);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), userId]);
  run('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
}

export function authenticate(email, password) {
  const user = findUserByEmail(email);
  // Always run a hash comparison so a missing account and a wrong password take
  // the same amount of time.
  const ok = verifyPassword(password, user?.password_hash || 'scrypt$16384$8$1$AAAA$AAAA');
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password');
  return user;
}

// -------------------------------------------------------- login sessions --

export function createAuthSession(userId, userAgent = '') {
  const value = token();
  const created = now();
  run(
    'INSERT INTO auth_sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    [value, userId, created, created + config.sessionTtl, String(userAgent).slice(0, 250)],
  );
  return value;
}

export function sessionCookie(value) {
  return serializeCookie(SESSION_COOKIE, value, { maxAge: config.sessionTtl, sameSite: 'Lax' });
}

export function clearedSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
}

export function destroyAuthSession(value) {
  if (value) run('DELETE FROM auth_sessions WHERE token = ?', [value]);
}

/** The signed-in user for a request, or null. */
export function currentUser(req) {
  const value = parseCookies(req)[SESSION_COOKIE];
  if (!value) return null;
  const session = get('SELECT * FROM auth_sessions WHERE token = ?', [value]);
  if (!session) return null;
  if (session.expires_at < now()) {
    destroyAuthSession(value);
    return null;
  }
  return findUser(session.user_id) || null;
}

export function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Sign in to continue');
  return user;
}

export function purgeExpiredSessions() {
  run('DELETE FROM auth_sessions WHERE expires_at < ?', [now()]);
}

// -------------------------------------------------------------- API keys --

export function createApiKey(userId, name = '') {
  const raw = `cred_${token()}`;
  run(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, String(name).slice(0, 80), sha256(raw), raw.slice(0, 12), now()],
  );
  return raw; // shown once, never recoverable
}

export function listApiKeys(userId) {
  return all(
    'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC',
    [userId],
  );
}

export function deleteApiKey(userId, id) {
  run('DELETE FROM api_keys WHERE user_id = ? AND id = ?', [userId, id]);
}

/** Resolve `Authorization: Bearer <key>` to a user. */
export function userFromApiKey(header) {
  const raw = String(header || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  const key = get('SELECT * FROM api_keys WHERE key_hash = ?', [sha256(raw)]);
  if (!key) return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now(), key.id]);
  return findUser(key.user_id) || null;
}

// --------------------------------------------------------- shared links --

export function createSharedLink(siteId, name = '', password = '') {
  const slug = crypto.randomBytes(12).toString('base64url');
  run(
    'INSERT INTO shared_links (slug, site_id, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [slug, siteId, String(name).slice(0, 80), password ? hashPassword(password) : '', now()],
  );
  return slug;
}

export function listSharedLinks(siteId) {
  return all('SELECT slug, name, password_hash <> \'\' AS protected, created_at FROM shared_links WHERE site_id = ?', [siteId]);
}

export function deleteSharedLink(siteId, slug) {
  run('DELETE FROM shared_links WHERE site_id = ? AND slug = ?', [siteId, slug]);
}

export function findSharedLink(slug) {
  return get('SELECT * FROM shared_links WHERE slug = ?', [slug]);
}

/** Short-lived signed cookie value proving a shared link's password was entered. */
export function sharedLinkPass(slug) {
  return crypto.createHmac('sha256', instanceSecret()).update(`shared:${slug}`).digest('base64url');
}

let secretCache = null;
function instanceSecret() {
  if (secretCache) return secretCache;
  // Derived from the oldest user's password hash + salt table so it survives
  // restarts without needing a config file. Falls back to a random value on a
  // brand new instance (which has nothing to protect yet).
  const row = get('SELECT password_hash FROM users ORDER BY id LIMIT 1');
  secretCache = crypto
    .createHash('sha256')
    .update(row?.password_hash || crypto.randomBytes(32).toString('hex'))
    .digest('hex');
  return secretCache;
}
