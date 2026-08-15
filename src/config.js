/**
 * Credible configuration.
 *
 * Everything is environment driven so a self-hosted instance never needs a
 * config file. Defaults are chosen so that `node bin/credible.js serve` works
 * on a bare machine with no setup at all.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const dataDir = path.resolve(env('CREDIBLE_DATA_DIR', path.join(ROOT, 'data')));

/** '' | '/stats' — always a leading slash, never a trailing one. */
export function normalizeBasePath(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const config = {
  /** Directory holding the SQLite database and any generated secrets. */
  dataDir,
  dbPath: path.resolve(env('CREDIBLE_DATABASE', path.join(dataDir, 'credible.db'))),

  host: env('CREDIBLE_HOST', '0.0.0.0'),
  port: envInt('CREDIBLE_PORT', 8000),

  /** Public origin, used in the install snippet and shared links. */
  baseUrl: env('CREDIBLE_BASE_URL', '').replace(/\/+$/, ''),

  /**
   * Mount point when Credible is served under a path of a bigger site, e.g.
   * CREDIBLE_BASE_PATH=/stats puts the dashboard at https://monsite.fr/stats
   * and the tracker at https://monsite.fr/stats/js/cr.js.
   *
   * This is what makes first-party analytics possible: the script is served
   * from the measured site's own origin, so there is no cross-origin request
   * and no separate hostname for a blocklist to match.
   */
  basePath: normalizeBasePath(env('CREDIBLE_BASE_PATH', '')),

  /** Trust X-Forwarded-For / CF-Connecting-IP. Enable behind a reverse proxy. */
  trustProxy: envBool('CREDIBLE_TRUST_PROXY', false),

  /** Dashboard login cookie lifetime, seconds. */
  sessionTtl: envInt('CREDIBLE_SESSION_TTL', 60 * 60 * 24 * 30),
  secureCookies: envBool('CREDIBLE_SECURE_COOKIES', false),

  /**
   * Anyone can create an account and connect their site. Set
   * CREDIBLE_OPEN_REGISTRATION=false to lock an instance down to its existing
   * users (the first account can always be created).
   */
  openRegistration: envBool('CREDIBLE_OPEN_REGISTRATION', true),

  /** A visit ends after this many seconds without an event. */
  inactivityTimeout: envInt('CREDIBLE_INACTIVITY_TIMEOUT', 30 * 60),

  /** Ingest queue: events are buffered then written in a single transaction. */
  flushIntervalMs: envInt('CREDIBLE_FLUSH_INTERVAL_MS', 250),
  flushMaxBatch: envInt('CREDIBLE_FLUSH_MAX_BATCH', 500),

  /** Per-IP ingestion rate limit (events / minute). 0 disables. */
  rateLimitPerMinute: envInt('CREDIBLE_RATE_LIMIT', 600),

  /** Delete raw events older than N days. 0 keeps them forever. */
  retentionDays: envInt('CREDIBLE_RETENTION_DAYS', 0),

  /** Optional MaxMind-style country lookup; falls back to edge headers. */
  geoDbPath: env('CREDIBLE_GEO_DB', ''),

  /** Development mode: never cache dashboard assets, log every request. */
  dev: envBool('CREDIBLE_DEV', false),

  logLevel: env('CREDIBLE_LOG_LEVEL', 'info'),
  version: '0.1.0',
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config.dataDir;
}

/**
 * The public base URL of this instance — origin plus mount point. Everything
 * user-facing (the install snippet, shared links, the agent brief) is built
 * from this, so it must include the base path.
 */
export function originFor(req) {
  if (config.baseUrl) return config.baseUrl + config.basePath;
  const proto = config.trustProxy ? (req?.headers['x-forwarded-proto'] || 'http') : 'http';
  const host = req?.headers.host || `localhost:${config.port}`;
  return `${String(proto).split(',')[0].trim()}://${host}${config.basePath}`;
}

export const hostname = os.hostname();
