/**
 * SQLite access layer.
 *
 * Uses `node:sqlite` (built into Node >= 22.5) so Credible ships with zero
 * runtime dependencies and no native build step. Statements are cached and
 * reused; all parameters are positional (`?`) and always bound, never
 * interpolated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDir } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;
const stmtCache = new Map();

/** Open (once) and return the database handle. */
export function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(config.dbPath);
  applyPragmas(db);
  migrate(db);
  return db;
}

/** Open an isolated database (tests, tooling). Does not touch the singleton. */
export function openDatabase(filePath) {
  const handle = new DatabaseSync(filePath);
  applyPragmas(handle);
  migrate(handle);
  return handle;
}

/** Replace the process-wide handle. Used by tests and the CLI. */
export function useDatabase(handle) {
  db = handle;
  stmtCache.clear();
  return db;
}

export function closeDb() {
  if (!db) return;
  stmtCache.clear();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}

function applyPragmas(handle) {
  handle.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32000;
    PRAGMA mmap_size = 268435456;
  `);
}

function migrate(handle) {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  handle.exec(sql);
  const row = handle.prepare('SELECT max(version) AS v FROM schema_migrations').get();
  if (!row || row.v == null) {
    handle
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(1, Math.floor(Date.now() / 1000));
  }
}

function prep(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** Run a statement. Returns { changes, lastInsertRowid }. */
export function run(sql, params = []) {
  return prep(sql).run(...params);
}

/** First row, or undefined. */
export function get(sql, params = []) {
  return prep(sql).get(...params);
}

/** All rows as plain objects. */
export function all(sql, params = []) {
  return prep(sql)
    .all(...params)
    .map((row) => ({ ...row }));
}

/** Single scalar value from the first column of the first row. */
export function pluck(sql, params = [], fallback = null) {
  const row = prep(sql).get(...params);
  if (!row) return fallback;
  const [first] = Object.values(row);
  return first === undefined ? fallback : first;
}

/** Multi-statement DDL / batch execution. */
export function exec(sql) {
  getDb().exec(sql);
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction.
 * Returns whatever `fn` returns; rolls back and rethrows on error.
 */
let txDepth = 0;
export function transaction(fn) {
  const handle = getDb();
  if (txDepth > 0) return fn();
  handle.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* transaction already unwound */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/** Reclaim space and refresh the query planner statistics. */
export function optimize() {
  const handle = getDb();
  handle.exec('PRAGMA optimize');
  handle.exec('ANALYZE');
}

export const now = () => Math.floor(Date.now() / 1000);
