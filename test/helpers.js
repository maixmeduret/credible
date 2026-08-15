/**
 * Shared scaffolding for the backend test suite.
 *
 * `src/config.js` snapshots `process.env` the moment it is first evaluated, so
 * the environment has to be pointed at a throwaway data directory *before* any
 * `src/` module is loaded. That happens in this file's top-level body, and the
 * application modules are pulled in with dynamic `import()` from
 * `withDatabase()` — never with a static import — so the ordering can never be
 * reversed by an ESM hoist.
 *
 * Test files must therefore import THIS module first:
 *
 *     import { withDatabase, track } from './helpers.js';
 *     import { aggregate } from '../src/stats/index.js';   // safe: comes after
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------ environment --
// Everything below runs at import time, before src/config.js exists.

/** Throwaway data directory for this test process. */
export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'credible-test-'));

process.env.CREDIBLE_DATA_DIR = DATA_DIR;
process.env.CREDIBLE_DATABASE = path.join(DATA_DIR, 'credible.db');
process.env.CREDIBLE_LOG_LEVEL = 'silent';
process.env.CREDIBLE_TRUST_PROXY = 'false';
process.env.CREDIBLE_SECURE_COOKIES = 'false';
// Generous enough that a whole test file never trips the ingest limiter.
process.env.CREDIBLE_RATE_LIMIT = '100000';

process.on('exit', () => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort — the OS reclaims the temp dir anyway */
  }
});

// ------------------------------------------------------------- constants --

/** A real desktop Chrome User-Agent. `isBot('')` is true, so tests need one. */
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
export const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export const DEFAULT_DOMAIN = 'example.com';
export const DEFAULT_IP = '203.0.113.7';

// --------------------------------------------------------------- database --

let loaded = null; // { db, ingest } — cached module namespaces
let counter = 0;

/**
 * Open a brand new SQLite database in the throwaway data directory and install
 * it as the process-wide handle, so every `src/` module writes to it.
 *
 * @param {string} [name] label used in the database file name
 * @returns {Promise<object>} the raw `node:sqlite` handle
 */
export async function withDatabase(name = 'test') {
  if (!loaded) {
    const [db, ingest, config] = await Promise.all([
      import('../src/db/index.js'),
      import('../src/ingest/index.js'),
      import('../src/config.js'),
    ]);
    // Fail loudly rather than quietly writing into the developer's real data
    // directory if this module was somehow evaluated after src/config.js.
    if (path.resolve(config.config.dataDir) !== path.resolve(DATA_DIR)) {
      throw new Error(
        `helpers.js must be imported before src/config.js (data dir is ${config.config.dataDir})`,
      );
    }
    loaded = { db, ingest };
  }
  loaded.db.closeDb(); // never leave the previous test's handle open
  counter += 1;
  const file = path.join(DATA_DIR, `${name}-${counter}.db`);
  return loaded.db.useDatabase(loaded.db.openDatabase(file));
}

/** Close the process-wide handle. Safe to call when nothing is open. */
export async function closeDatabase() {
  if (!loaded) return;
  loaded.db.closeDb();
}

function modules() {
  if (!loaded) throw new Error('call `await withDatabase()` before using the test helpers');
  return loaded;
}

// ----------------------------------------------------------------- ingest --

/**
 * Convenience wrapper around `recordEvent`.
 *
 * Accepts the raw tracker payload keys (`n`, `u`, `d`, `r`, `p`, `v`, `e`, `w`)
 * plus two aliases that keep the tests readable:
 *   `path`   -> builds `u` as `https://<domain><path>`
 *   `domain` -> sets `d` (and the host of the generated `u`)
 *
 * @param {object} body payload overrides
 * @param {object} ctx  `{ ip, userAgent, headers, timestamp, visitorId }`
 */
export function track(body = {}, ctx = {}) {
  const { path: pathname, domain, ...rest } = body;
  const host = domain ?? DEFAULT_DOMAIN;
  const payload = {
    n: 'pageview',
    d: host,
    u: `https://${host}${pathname ?? '/'}`,
    ...rest,
  };
  return modules().ingest.recordEvent(payload, {
    ip: DEFAULT_IP,
    userAgent: CHROME_UA,
    ...ctx,
  });
}

// ------------------------------------------------------------ inspection --

/** Every event row, oldest first. */
export function events(where = '', params = []) {
  return modules().db.all(
    `SELECT * FROM events ${where ? `WHERE ${where}` : ''} ORDER BY id`,
    params,
  );
}

/** Every visit row, oldest first. */
export function visits(where = '', params = []) {
  return modules().db.all(
    `SELECT * FROM visits ${where ? `WHERE ${where}` : ''} ORDER BY id`,
    params,
  );
}

export function countRows(table) {
  return Number(modules().db.pluck(`SELECT count(*) FROM ${table}`, [], 0));
}

/** Unix seconds for a UTC wall-clock time — deterministic fixtures. */
export function utc(year, month, day, hour = 0, minute = 0, second = 0) {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}
