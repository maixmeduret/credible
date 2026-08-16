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

/**
 * Schema changes that cannot be expressed as CREATE TABLE IF NOT EXISTS.
 *
 * schema.sql is the shape of a *fresh* database and is re-run on every boot, so
 * new tables and indexes belong there. Anything that alters an existing table
 * belongs here, keyed by version, and must be safe to run against a database
 * that already has it — people upgrade by pulling and restarting, with no step
 * in between, so a migration that can fail is a migration that breaks upgrades.
 */
const MIGRATIONS = [
  {
    version: 2,
    describe: 'per-site country and hostname shields',
    up(handle) {
      addColumn(handle, 'sites', 'excluded_countries', "TEXT NOT NULL DEFAULT ''");
      addColumn(handle, 'sites', 'allowed_hostnames', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 3,
    describe: 'record why an event was dropped, for the filtering report',
    up(handle) {
      addColumn(handle, 'sites', 'bot_filtering', "TEXT NOT NULL DEFAULT 'standard'");
    },
  },
];

/** Add a column only if it is missing. Idempotent by inspection, not by error. */
function addColumn(handle, table, column, definition) {
  const columns = handle.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return false;
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function migrate(handle) {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  handle.exec(sql);

  const row = handle.prepare('SELECT max(version) AS v FROM schema_migrations').get();
  const current = row?.v ?? 0;
  const stamp = handle.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const now_ = Math.floor(Date.now() / 1000);

  if (current === 0) stamp.run(1, now_);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    handle.exec('BEGIN IMMEDIATE');
    try {
      migration.up(handle);
      stamp.run(migration.version, now_);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.describe}) failed: ${err.message}`);
    }
  }
}

/** The schema version this build expects. Surfaced by /api/health. */
export const SCHEMA_VERSION = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 1;

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
