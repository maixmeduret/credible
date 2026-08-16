/**
 * Importing history from other analytics tools.
 *
 * Migrating away from a hosted product is only possible if the history comes
 * with you, so this module reads three things:
 *
 *   plausible-csv  a ZIP (or a single file) of Plausible's `imported_*.csv`
 *                  tables — PRE-AGGREGATED DAILY ROLLUPS
 *   credible-csv   the raw events `credible export` writes — a lossless round trip
 *   generic-csv    anything else, through a documented column mapping
 *
 * The honest part
 * ---------------
 * Plausible's export contains no per-visitor rows: a line says "on 2023-02-09,
 * 40 visitors came from France", nothing more. There is no way to know which of
 * those 40 also used Firefox. Two ways to deal with that:
 *
 *   (a) synthesise fake events until the tables look full. This invents visitor
 *       identities that never existed, and every future query silently inherits
 *       the lie. We do NOT do this.
 *   (b) keep the aggregates as aggregates, in their own table, and let the stats
 *       engine add them to totals and to SINGLE-dimension breakdowns.
 *
 * We do (b). `imported_stats` therefore holds one row per (date, dimension,
 * value) and can never be cross-filtered: asking for "France AND Firefox" over
 * an imported period is a question the source data cannot answer, and the
 * dashboard has to say so rather than guess.
 *
 * Raw-event sources are different — they have real visitor ids, so they go
 * through `recordEvent`, the same ingestion path as live traffic, and get
 * genuinely re-sessionised. Nothing about their visits is synthetic.
 *
 * Tables owned by this module
 * ---------------------------
 *   imports              one row per import run
 *   imported_stats       the daily rollups (see above)
 *   import_event_ranges  which `events` rowids each raw import wrote, so that
 *                        `deleteImport` can be exact
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

import { all, exec, get, pluck, run, transaction, now } from './db/index.js';
import { HttpError } from './util/http.js';
import { findSite } from './sites.js';
import { recordEvent } from './ingest/index.js';
import { classifyReferrer, extractCampaign } from './ingest/referrer.js';
import { formatYmd, parseYmd, zonedToUnix } from './util/time.js';

/** Rows written (or ingested) per transaction. */
const CHUNK = 500;

/** Longest dimension value we will store. Page paths are the long ones. */
const MAX_VALUE = 2000;

/** Nothing before this is a plausible analytics timestamp — it is a parse bug. */
const MIN_TIMESTAMP = 946684800; // 2000-01-01T00:00:00Z

/**
 * Ceilings on the two places this module holds a whole file in memory.
 *
 * The raw and generic paths stream off disk, but a Plausible archive cannot:
 * the central directory has to be read before any entry can be found, and an
 * entry has to be inflated before it can be parsed. Without a cap that is a
 * decompression bomb — a 1 MB ZIP inflates to 400 MB and pins the event loop
 * for sixteen seconds, and a slightly larger one dies on V8's ~512 MB string
 * limit with a RangeError that is not an HttpError, so it escapes as a 500.
 *
 * The limits are far above any real export (a year of a busy site zips to tens
 * of KB) and are checked against the *declared* size first, so an honest
 * oversized file is refused before a byte is allocated, and `maxOutputLength`
 * then catches a central directory that lies about it.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TABLE_BYTES = 128 * 1024 * 1024;

const mb = (bytes) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

/**
 * Raw-event imports still have to pass `isBot`, which rejects an empty
 * User-Agent. The technology columns are overwritten from the CSV immediately
 * afterwards, so this string never reaches the database — it only exists to get
 * the row past the bot filter.
 */
const IMPORT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const IMPORT_SOURCES = ['plausible-csv', 'credible-csv', 'generic-csv'];

/** Every dimension key `imported_stats` can contain. '' is the daily total. */
export const IMPORTED_DIMENSIONS = [
  '',
  'event:page',
  'event:hostname',
  'event:name',
  'visit:entry_page',
  'visit:exit_page',
  'visit:channel',
  'visit:source',
  'visit:referrer',
  'visit:utm_source',
  'visit:utm_medium',
  'visit:utm_campaign',
  'visit:utm_content',
  'visit:utm_term',
  'visit:country',
  'visit:region',
  'visit:city',
  'visit:browser',
  'visit:browser_version',
  'visit:os',
  'visit:os_version',
  'visit:device',
  'visit:screen_size',
];

// ------------------------------------------------------------------ schema --

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS imported_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    import_id INTEGER NOT NULL,
    date TEXT NOT NULL,              -- YYYY-MM-DD in the site's timezone
    dimension TEXT NOT NULL,         -- '' for the daily totals row, else 'visit:source' etc.
    value TEXT NOT NULL DEFAULT '',
    visitors INTEGER NOT NULL DEFAULT 0,
    visits INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    visit_duration INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS imported_site_date_idx ON imported_stats (site_id, date);
  CREATE INDEX IF NOT EXISTS imported_dim_idx ON imported_stats (site_id, dimension, date);

  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    source TEXT NOT NULL,            -- 'plausible-csv' | 'credible-csv' | 'generic-csv'
    status TEXT NOT NULL,            -- 'running' | 'complete' | 'failed'
    from_date TEXT, to_date TEXT,
    rows_read INTEGER NOT NULL DEFAULT 0,
    events_written INTEGER NOT NULL DEFAULT 0,
    aggregates_written INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS import_event_ranges (
    import_id INTEGER NOT NULL,
    first_id  INTEGER NOT NULL,
    last_id   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS import_event_ranges_idx ON import_event_ranges (import_id);
`;

/**
 * Create the import tables if they are missing.
 *
 * Called from every public entry point rather than memoised, because tests and
 * the CLI swap the process-wide database handle underneath us.
 */
function ensureSchema() {
  exec(SCHEMA);
  // Additive migration on top of the table above: Plausible's
  // `imported_custom_events` counts *events*, which none of the five original
  // metric columns can hold without lying about pageviews. Anything reading
  // only the documented columns is unaffected.
  const columns = all("SELECT name FROM pragma_table_info('imported_stats')");
  if (!columns.some((c) => c.name === 'events')) {
    exec('ALTER TABLE imported_stats ADD COLUMN events INTEGER NOT NULL DEFAULT 0');
  }
}

// --------------------------------------------------------------------- CSV --

/**
 * Incremental RFC 4180 parser.
 *
 * Written as a fed-chunk state machine rather than a regex so that a quoted
 * field containing commas, newlines or doubled quotes survives a chunk boundary
 * landing anywhere inside it — which is the whole point of streaming.
 */
function createCsvParser(where = 'CSV') {
  let field = '';
  let row = [];
  let quoted = false;
  let pendingQuote = false; // last char was a quote inside a quoted field
  let skipLf = false; // last char was CR, swallow a following LF
  let atStart = true; // for the byte order mark
  let line = 1;
  let recordLine = 1;

  const finishRecord = (emit) => {
    row.push(field);
    field = '';
    // A blank line is separator noise, not a record.
    if (row.length > 1 || row[0] !== '') emit(row, recordLine);
    row = [];
    line += 1;
    recordLine = line;
  };

  return {
    push(text, emit) {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (atStart) {
          atStart = false;
          if (ch === '﻿') continue;
        }
        if (skipLf) {
          skipLf = false;
          if (ch === '\n') continue;
        }

        if (quoted) {
          if (pendingQuote) {
            pendingQuote = false;
            if (ch === '"') {
              field += '"'; // "" is an escaped quote
              continue;
            }
            quoted = false; // the field closed; fall through and treat ch normally
          } else if (ch === '"') {
            pendingQuote = true;
            continue;
          } else {
            if (ch === '\n') line += 1;
            field += ch;
            continue;
          }
        }

        if (ch === '"' && field === '') {
          quoted = true;
        } else if (ch === ',') {
          row.push(field);
          field = '';
        } else if (ch === '\n') {
          finishRecord(emit);
        } else if (ch === '\r') {
          skipLf = true;
          finishRecord(emit);
        } else {
          field += ch;
        }
      }
    },

    end(emit) {
      if (quoted && !pendingQuote) {
        throw new HttpError(422, `${where} line ${recordLine}: unterminated quoted field`);
      }
      quoted = false;
      pendingQuote = false;
      if (field !== '' || row.length) finishRecord(emit);
    },
  };
}

/**
 * Parse a whole CSV document into an array of rows (each an array of strings).
 * The header, if any, is the first row — this function does not interpret it.
 */
export function parseCsv(text) {
  const rows = [];
  const parser = createCsvParser('CSV');
  const emit = (cells) => rows.push(cells);
  parser.push(String(text ?? ''), emit);
  parser.end(emit);
  return rows;
}

/** Feed an in-memory buffer through the parser without materialising all rows. */
function eachCsvRow(text, where, onRow) {
  const parser = createCsvParser(where);
  parser.push(text, onRow);
  parser.end(onRow);
}

/** Stream a CSV file off disk, one record at a time. */
async function eachCsvFileRow(filePath, where, onRow) {
  const parser = createCsvParser(where);
  const decoder = new StringDecoder('utf8');
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) parser.push(decoder.write(chunk), onRow);
  } finally {
    stream.destroy();
  }
  const tail = decoder.end();
  if (tail) parser.push(tail, onRow);
  parser.end(onRow);
}

/**
 * Bind a header row so cells can be read by name.
 * Column order is whatever the file says; only names matter.
 */
function makeReader(headers, where) {
  const index = new Map();
  headers.forEach((raw, i) => {
    const key = String(raw).trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, i);
  });
  return {
    names: [...index.keys()],
    has: (name) => index.has(name),
    /** Validate the shape of a data row and return a name->value accessor. */
    read(cells, line) {
      if (cells.length !== headers.length) {
        throw new HttpError(
          422,
          `${where} line ${line}: expected ${headers.length} columns, found ${cells.length}`,
        );
      }
      return (name) => {
        const i = index.get(name);
        return i === undefined ? '' : cells[i];
      };
    },
  };
}

// --------------------------------------------------------------------- ZIP --

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const zipError = (message) => new HttpError(422, `Bad ZIP archive: ${message}`);

/** Byte offset of the end-of-central-directory record. */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 65557); // 22 byte record + 64 KB comment
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw zipError('end of central directory not found');
}

/**
 * List the entries of a ZIP archive.
 *
 * Only the central directory is read here; entry bodies are inflated on demand
 * so a large export never has to be decompressed all at once. ZIP64 is handled
 * because a multi-year export can cross the 4 GB / 65535-entry limits.
 */
function readZipEntries(buf) {
  if (buf.length < 22) throw zipError('file is too small');
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) {
      throw zipError('ZIP64 archive without a ZIP64 locator');
    }
    const zip64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(zip64) !== EOCD64_SIG) throw zipError('ZIP64 directory not found');
    count = Number(buf.readBigUInt64LE(zip64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(zip64 + 48));
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw zipError(`central directory entry ${i + 1} is corrupt`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const entry = {
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method,
      encrypted: (flags & 0x0001) !== 0,
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    };
    readZip64Extra(buf, p + 46 + nameLen, extraLen, entry);
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** ZIP64 extended information: only the fields that overflowed are present. */
function readZip64Extra(buf, start, length, entry) {
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    let q = p + 4;
    if (id === 0x0001) {
      if (entry.size === 0xffffffff && q + 8 <= end) {
        entry.size = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.compressedSize === 0xffffffff && q + 8 <= end) {
        entry.compressedSize = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.localOffset === 0xffffffff && q + 8 <= end) {
        entry.localOffset = Number(buf.readBigUInt64LE(q));
      }
    }
    p += 4 + size;
  }
}

/** Decompress one entry. Supports stored (0) and deflate (8). */
function readZipEntry(buf, entry) {
  if (entry.encrypted) throw zipError(`"${entry.name}" is encrypted`);
  if (entry.size > MAX_TABLE_BYTES) {
    throw zipError(
      `"${entry.name}" unpacks to ${mb(entry.size)}, over the ${mb(MAX_TABLE_BYTES)} limit for one table`,
    );
  }
  const head = entry.localOffset;
  if (head + 30 > buf.length || buf.readUInt32LE(head) !== LOCAL_SIG) {
    throw zipError(`local header for "${entry.name}" is corrupt`);
  }
  const nameLen = buf.readUInt16LE(head + 26);
  const extraLen = buf.readUInt16LE(head + 28);
  const start = head + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return body;
  if (entry.method === 8) {
    try {
      // The declared size above can be a lie; this is the one that cannot be.
      return zlib.inflateRawSync(body, { maxOutputLength: MAX_TABLE_BYTES });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw zipError(
          `"${entry.name}" unpacks to more than the ${mb(MAX_TABLE_BYTES)} limit for one table`,
        );
      }
      throw zipError(`"${entry.name}" could not be inflated (${err.message})`);
    }
  }
  throw zipError(`"${entry.name}" uses unsupported compression method ${entry.method}`);
}

// -------------------------------------------------------- source detection --

/** Plausible names its tables `imported_x_20230209_20240123.csv`. */
const PLAUSIBLE_FILE = /^(imported_[a-z_]+?)(?:_\d{8}_\d{8})?\.csv$/i;

/** The columns `credible export` emits, in order. */
export const CREDIBLE_EXPORT_COLUMNS = [
  'timestamp', 'name', 'visitor_id', 'visit_id', 'pathname', 'channel', 'referrer_source',
  'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'country_code', 'region', 'city',
  'browser', 'os', 'device', 'screen_size', 'props', 'revenue', 'currency',
];

/** Enough of our own export to be unmistakable, whatever columns get added later. */
const CREDIBLE_SIGNATURE = ['timestamp', 'name', 'visitor_id', 'visit_id', 'pathname'];

function plausibleTableName(fileName) {
  const match = PLAUSIBLE_FILE.exec(path.basename(String(fileName || '')));
  const table = match ? match[1].toLowerCase() : '';
  return table in PLAUSIBLE_TABLES ? table : '';
}

/** Read the first record of a CSV without loading the whole file. */
function readCsvHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    let header = null;
    const collect = (cells) => {
      if (header === null) header = cells;
    };
    const parser = createCsvParser(path.basename(filePath));
    parser.push(buf.toString('utf8', 0, bytes), collect);
    // Only flush when the read covered the whole file: on a truncated read the
    // dangling record is an artefact of the window, not a malformed file.
    if (bytes < buf.length && header === null) parser.end(collect);
    return header || [];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decide what a file is, reading as little of it as possible.
 * Returns the ZIP buffer alongside so `importFile` does not read it twice.
 */
function sniff(filePath, stat = statFile(filePath)) {
  const fd = fs.openSync(filePath, 'r');
  let magic = Buffer.alloc(0);
  try {
    const buf = Buffer.alloc(4);
    const bytes = fs.readSync(fd, buf, 0, 4, 0);
    magic = buf.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }

  if (magic.length >= 4 && magic.readUInt32LE(0) === LOCAL_SIG) {
    // The central directory lives at the end, so the archive has to be read
    // whole before any entry can be located. Refuse an absurd one on the stat.
    if (stat.size > MAX_ARCHIVE_BYTES) {
      throw new HttpError(
        422,
        `${path.basename(filePath)} is ${mb(stat.size)}; the largest archive this can read is ` +
          `${mb(MAX_ARCHIVE_BYTES)}. Export a narrower date range.`,
      );
    }
    const zip = fs.readFileSync(filePath);
    const entries = readZipEntries(zip).filter((e) => !e.name.endsWith('/'));
    if (!entries.some((e) => plausibleTableName(e.name))) {
      throw new HttpError(
        422,
        'This ZIP contains no Plausible tables. Expected files named ' +
          `${Object.keys(PLAUSIBLE_TABLES).slice(0, 3).join(', ')}… — found ` +
          `${entries.slice(0, 5).map((e) => e.name).join(', ') || 'nothing'}.`,
      );
    }
    return { source: 'plausible-csv', zip, entries };
  }

  if (magic.length >= 2 && magic[0] === 0x1f && magic[1] === 0x8b) {
    throw new HttpError(422, 'Gzipped files are not supported — decompress it first.');
  }

  const header = readCsvHeader(filePath).map((c) => String(c).trim().toLowerCase());
  if (!header.length) throw new HttpError(422, `${path.basename(filePath)} is empty`);

  if (plausibleTableName(filePath) && header.includes('date')) {
    return { source: 'plausible-csv', zip: null, entries: null };
  }
  if (CREDIBLE_SIGNATURE.every((c) => header.includes(c))) {
    return { source: 'credible-csv', zip: null, entries: null };
  }
  return { source: 'generic-csv', zip: null, entries: null };
}

/** Public sniffer: 'plausible-csv' | 'credible-csv' | 'generic-csv'. */
export function detectSource(filePath) {
  return sniff(filePath, statFile(filePath)).source;
}

function statFile(filePath) {
  if (!filePath) throw new HttpError(422, 'No file to import');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HttpError(404, `File not found: ${filePath}`);
  }
  if (!stat.isFile()) throw new HttpError(422, `Not a file: ${filePath}`);
  if (stat.size === 0) throw new HttpError(422, `${path.basename(filePath)} is empty`);
  return stat;
}

// ---------------------------------------------------------- value handling --

const cell = (value, max = MAX_VALUE) => String(value ?? '').trim().slice(0, max);

/** A count. Empty is zero, negative is clamped, garbage is an error. */
function intCell(value, where, column) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const n = Number(text.replace(/[\s_]/g, ''));
  if (!Number.isFinite(n)) {
    throw new HttpError(422, `${where}: ${column} is "${text}", which is not a number`);
  }
  if (n <= 0) return 0;
  return Math.min(Math.round(n), Number.MAX_SAFE_INTEGER);
}

/** Same, but a refund is a real negative amount rather than a typo. */
function signedIntCell(value, where, column) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const n = Number(text.replace(/[\s_]/g, ''));
  if (!Number.isFinite(n)) {
    throw new HttpError(422, `${where}: ${column} is "${text}", which is not a number`);
  }
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Math.round(n), Number.MAX_SAFE_INTEGER));
}

const YMD = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/;

/** 'YYYY-MM-DD' (also accepts YYYY/MM/DD and YYYYMMDD), validated as a real date. */
function parseDateCell(value, where) {
  const text = String(value ?? '').trim();
  const m = YMD.exec(text);
  if (!m) throw new HttpError(422, `${where}: "${text}" is not a date (expected YYYY-MM-DD)`);
  const [year, month, day] = [+m[1], +m[2], +m[3]];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new HttpError(422, `${where}: "${text}" is not a real calendar date`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Unix seconds from whatever the column holds: unix seconds, unix milliseconds,
 * an ISO instant, or a naive wall clock (read in the site's timezone).
 */
function parseTimestampCell(value, timezone, where) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(422, `${where}: missing timestamp`);
  let ts = null;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    ts = n > 1e11 ? Math.floor(n / 1000) : n; // milliseconds vs seconds
  } else if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) ts = Math.floor(ms / 1000);
  } else {
    const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    if (m) ts = zonedToUnix(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), timezone);
  }

  if (ts == null || !Number.isFinite(ts)) {
    throw new HttpError(422, `${where}: "${text}" is not a timestamp`);
  }
  if (ts < MIN_TIMESTAMP || ts > now() + 86400) {
    throw new HttpError(422, `${where}: timestamp "${text}" is outside the plausible range`);
  }
  return Math.floor(ts);
}

const DEVICE_WORDS = { desktop: 'Desktop', laptop: 'Laptop', mobile: 'Mobile', tablet: 'Tablet', phone: 'Mobile', smartphone: 'Mobile' };

/** Other tools write 'desktop'; Credible stores 'Desktop'. */
const normalizeDevice = (value) => DEVICE_WORDS[cell(value, 32).toLowerCase()] || cell(value, 32);

// ------------------------------------------------- Plausible table mapping --

/**
 * Metric columns, per table. Plausible calls the visit count `entrances` on
 * entry pages and `exits` on exit pages; everything else is uniform.
 * `visit_duration` is a TOTAL in seconds, not an average.
 */
function plausibleMetrics(value, where, { visitsColumn = 'visits' } = {}) {
  return {
    visitors: intCell(value('visitors'), where, 'visitors'),
    visits: intCell(value(visitsColumn), where, visitsColumn),
    pageviews: intCell(value('pageviews'), where, 'pageviews'),
    bounces: intCell(value('bounces'), where, 'bounces'),
    visit_duration: intCell(value('visit_duration'), where, 'visit_duration'),
    events: 0,
  };
}

const agg = (dimension, value, metrics) => ({ dimension, value: cell(value), ...metrics });

/**
 * One entry per Plausible table: which extra columns it needs, and how its rows
 * become `imported_stats` rows.
 *
 * `expand` returns zero or more rows. Duplicates are fine and expected — the
 * stats engine groups by (dimension, value) and sums, so no merging is needed
 * here and none is done.
 */
const PLAUSIBLE_TABLES = {
  imported_visitors: {
    expand: (_row, m) => [agg('', '', m)],
  },

  imported_sources: {
    columns: ['source', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'],
    expand(row, m, ctx) {
      const out = [];
      const referrer = cell(row.referrer);
      const utm = {
        source: cell(row.utm_source, 255),
        medium: cell(row.utm_medium, 255),
        campaign: cell(row.utm_campaign, 255),
        content: cell(row.utm_content, 255),
        term: cell(row.utm_term, 255),
      };
      // Plausible has no channel column, so we derive it with Credible's own
      // classifier from the referrer host and the campaign — the same inputs
      // live ingestion uses. That is a derivation, not an invention.
      const classified = classifyReferrer({
        referrer: referrer ? `https://${referrer}` : '',
        siteHost: ctx.site.domain,
        utm,
      });
      const source = cell(row.source, 255) || classified.source || 'Direct';

      out.push(agg('visit:source', source, m));
      if (referrer) out.push(agg('visit:referrer', referrer, m));
      if (classified.channel) out.push(agg('visit:channel', classified.channel, m));
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        if (utm[key.slice(4)]) out.push(agg(`visit:${key}`, utm[key.slice(4)], m));
      }
      return out;
    },
  },

  imported_pages: {
    columns: ['hostname', 'page'],
    expand(row, m) {
      const out = [];
      if (cell(row.page)) out.push(agg('event:page', row.page, m));
      if (cell(row.hostname)) out.push(agg('event:hostname', row.hostname, m));
      return out;
    },
  },

  imported_entry_pages: {
    columns: ['entry_page'],
    visitsColumn: 'entrances',
    expand: (row, m) => (cell(row.entry_page) ? [agg('visit:entry_page', row.entry_page, m)] : []),
  },

  imported_exit_pages: {
    columns: ['exit_page'],
    visitsColumn: 'exits',
    expand: (row, m) => (cell(row.exit_page) ? [agg('visit:exit_page', row.exit_page, m)] : []),
  },

  imported_locations: {
    columns: ['country', 'region', 'city'],
    expand(row, m, ctx) {
      const out = [];
      const country = cell(row.country, 2).toUpperCase();
      if (/^[A-Z]{2}$/.test(country)) out.push(agg('visit:country', country, m));
      if (cell(row.region)) out.push(agg('visit:region', row.region, m));
      const city = cell(row.city, 120);
      // Plausible stores cities as GeoNames ids. Credible stores names, and a
      // dashboard row reading "3027647" is worse than no row at all.
      if (city && !/^\d+$/.test(city)) out.push(agg('visit:city', city, m));
      else if (city) ctx.counters.geonameCities += 1;
      return out;
    },
  },

  imported_devices: {
    columns: ['device'],
    expand(row, m) {
      const out = [];
      const size = normalizeDevice(row.device);
      if (!size) return out;
      // Plausible's single "device" column is a screen-size bucket (Mobile,
      // Tablet, Laptop, Desktop) — exactly Credible's `screen_size`. Credible
      // also has a User-Agent device class with no Laptop, so a laptop folds
      // into Desktop there. Both panels then show the imported period.
      out.push(agg('visit:screen_size', size, m));
      out.push(agg('visit:device', size === 'Laptop' ? 'Desktop' : size, m));
      return out;
    },
  },

  imported_browsers: {
    columns: ['browser', 'browser_version'],
    expand(row, m) {
      const out = [];
      if (cell(row.browser, 120)) out.push(agg('visit:browser', row.browser, m));
      if (cell(row.browser_version, 60)) out.push(agg('visit:browser_version', row.browser_version, m));
      return out;
    },
  },

  imported_operating_systems: {
    columns: ['operating_system', 'operating_system_version'],
    expand(row, m) {
      const out = [];
      if (cell(row.operating_system, 120)) out.push(agg('visit:os', row.operating_system, m));
      if (cell(row.operating_system_version, 60)) {
        out.push(agg('visit:os_version', row.operating_system_version, m));
      }
      return out;
    },
  },

  imported_custom_events: {
    columns: ['name', 'link_url', 'path'],
    metrics(value, where) {
      // This table has no session metrics at all — just who and how many.
      return {
        visitors: intCell(value('visitors'), where, 'visitors'),
        visits: 0,
        pageviews: 0,
        bounces: 0,
        visit_duration: 0,
        events: intCell(value('events'), where, 'events'),
      };
    },
    expand(row, m, ctx) {
      const name = cell(row.name, 120);
      if (!name) return [];
      // `link_url` and `path` are event properties; `imported_stats` has one
      // value column, so they are dropped rather than mangled into the name.
      if (cell(row.link_url) || cell(row.path)) ctx.counters.droppedProps += 1;
      return [agg('event:name', name, m)];
    },
  },
};

export const PLAUSIBLE_TABLE_NAMES = Object.keys(PLAUSIBLE_TABLES);

/** Totals first, then the dimensions, so progress reporting reads sensibly. */
const PLAUSIBLE_ORDER = new Map(PLAUSIBLE_TABLE_NAMES.map((name, i) => [name, i]));

// --------------------------------------------------- generic column mapping --

/**
 * Accepted column names for `generic-csv`, canonical field first.
 *
 * A file with any of the timestamp aliases is treated as raw events and goes
 * through real ingestion. A file with `date` but no timestamp is treated as
 * daily rollups.
 */
export const GENERIC_COLUMNS = {
  timestamp: ['timestamp', 'time', 'datetime', 'date_time', 'occurred_at', 'event_time', 'ts'],
  date: ['date', 'day'],
  name: ['name', 'event', 'event_name', 'action'],
  visitor_id: ['visitor_id', 'visitor', 'user_id', 'client_id'],
  hostname: ['hostname', 'host'],
  pathname: ['pathname', 'page', 'page_path', 'path', 'page_url', 'url'],
  entry_page: ['entry_page', 'landing_page'],
  exit_page: ['exit_page'],
  channel: ['channel', 'default_channel_group', 'default_channel_grouping'],
  referrer_source: ['referrer_source', 'source', 'traffic_source'],
  referrer: ['referrer', 'referer', 'full_referrer'],
  utm_source: ['utm_source'],
  utm_medium: ['utm_medium', 'medium'],
  utm_campaign: ['utm_campaign', 'campaign'],
  utm_content: ['utm_content', 'content'],
  utm_term: ['utm_term', 'term', 'keyword'],
  country_code: ['country_code', 'country'],
  region: ['region', 'state'],
  city: ['city'],
  browser: ['browser'],
  browser_version: ['browser_version'],
  os: ['os', 'operating_system', 'platform'],
  os_version: ['os_version', 'operating_system_version'],
  device: ['device', 'device_type', 'device_category'],
  screen_size: ['screen_size', 'screen'],
  props: ['props', 'properties'],
  revenue: ['revenue'],
  currency: ['currency'],
  engagement_time: ['engagement_time', 'time_on_page'],
  scroll_depth: ['scroll_depth'],
  visitors: ['visitors', 'users', 'unique_visitors'],
  visits: ['visits', 'sessions', 'entrances', 'exits'],
  pageviews: ['pageviews', 'page_views', 'screen_page_views', 'views'],
  bounces: ['bounces'],
  visit_duration: ['visit_duration', 'total_visit_duration'],
};

/** Which canonical field feeds which `imported_stats` dimension, in priority order. */
const GENERIC_AGG_DIMENSIONS = [
  ['pathname', 'event:page'],
  ['entry_page', 'visit:entry_page'],
  ['exit_page', 'visit:exit_page'],
  ['hostname', 'event:hostname'],
  ['name', 'event:name'],
  ['channel', 'visit:channel'],
  ['referrer_source', 'visit:source'],
  ['referrer', 'visit:referrer'],
  ['utm_source', 'visit:utm_source'],
  ['utm_medium', 'visit:utm_medium'],
  ['utm_campaign', 'visit:utm_campaign'],
  ['utm_content', 'visit:utm_content'],
  ['utm_term', 'visit:utm_term'],
  ['country_code', 'visit:country'],
  ['region', 'visit:region'],
  ['city', 'visit:city'],
  ['browser', 'visit:browser'],
  ['browser_version', 'visit:browser_version'],
  ['os', 'visit:os'],
  ['os_version', 'visit:os_version'],
  ['device', 'visit:device'],
  ['screen_size', 'visit:screen_size'],
];

/**
 * Resolve the file's header against the alias table.
 * `columnMap` lets a caller override any field: { pathname: 'Landing Page' }.
 */
function resolveColumns(reader, columnMap = {}) {
  const resolved = {};
  for (const [field, aliases] of Object.entries(GENERIC_COLUMNS)) {
    const override = columnMap[field];
    if (override) {
      const key = String(override).trim().toLowerCase();
      if (!reader.has(key)) {
        throw new HttpError(422, `Column "${override}" (mapped to ${field}) is not in the file`);
      }
      resolved[field] = key;
      continue;
    }
    const hit = aliases.find((alias) => reader.has(alias));
    if (hit) resolved[field] = hit;
  }
  return resolved;
}

// -------------------------------------------------------------- bookkeeping --

/** Refuse to stack two imports over the same days — it would double every number. */
function checkOverlap(siteId, from, to) {
  const clash = get(
    `SELECT id, source, from_date, to_date FROM imports
      WHERE site_id = ? AND status <> 'failed'
        AND from_date IS NOT NULL AND to_date IS NOT NULL
        AND from_date <= ? AND to_date >= ?
      ORDER BY id LIMIT 1`,
    [siteId, to, from],
  );
  if (!clash) return;
  throw new HttpError(
    409,
    `${from} → ${to} overlaps import #${clash.id} (${clash.source}, ${clash.from_date} → ` +
      `${clash.to_date}). Delete that import first, or import a narrower range.`,
  );
}

/**
 * Warn — but do not refuse — when the site was already tracking natively over
 * the imported days. Imported numbers are *added* to native ones, so an overlap
 * double counts; refusing outright would block the ordinary case where the
 * snippet went live a few hours before the old tool's history ends.
 */
function warnAboutNativeOverlap(site, from, to, notes) {
  const f = parseYmd(from);
  const t = parseYmd(to);
  if (!f || !t) return;
  const start = zonedToUnix(f.year, f.month, f.day, 0, 0, 0, site.timezone);
  const end = zonedToUnix(t.year, t.month, t.day + 1, 0, 0, 0, site.timezone);
  const overlapping = Number(
    pluck('SELECT count(*) FROM events WHERE site_id = ? AND timestamp >= ? AND timestamp < ?',
      [site.id, start, end], 0),
  );
  if (!overlapping) return;
  notes.push(
    `${overlapping} events were already tracked natively between ${from} and ${to}; ` +
      'those days will now count both sources',
  );
}

function beginImport(siteId, source, from, to) {
  const result = run(
    `INSERT INTO imports (site_id, source, status, from_date, to_date, started_at)
     VALUES (?, ?, 'running', ?, ?, ?)`,
    [siteId, source, from, to, now()],
  );
  return Number(result.lastInsertRowid);
}

function readImport(id) {
  return get('SELECT * FROM imports WHERE id = ?', [id]);
}

/** Replace this import's event-id ranges. There is normally exactly one. */
function persistRanges(importId, ranges) {
  run('DELETE FROM import_event_ranges WHERE import_id = ?', [importId]);
  for (const range of ranges) {
    run('INSERT INTO import_event_ranges (import_id, first_id, last_id) VALUES (?, ?, ?)', [
      importId,
      range.first_id,
      range.last_id,
    ]);
  }
}

/** Grow the last range when ids stay consecutive, so the usual import stores one row. */
function trackEventId(ranges, id) {
  const last = ranges[ranges.length - 1];
  if (last && id === last.last_id + 1) last.last_id = id;
  else ranges.push({ first_id: id, last_id: id });
}

// ------------------------------------------------------------- import runs --

const AGG_INSERT = `INSERT INTO imported_stats
  (site_id, import_id, date, dimension, value, visitors, visits, pageviews, bounces, visit_duration, events)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Shared plumbing for a run: chunked transactions, counters, progress.
 * `flush` is what actually writes a batch; everything else is bookkeeping.
 */
function createWriter({ onProgress, source, write }) {
  const state = {
    rowsRead: 0,
    eventsWritten: 0,
    aggregatesWritten: 0,
    file: '',
    buffer: [],
    ranges: [],
    counters: { geonameCities: 0, droppedProps: 0, skippedRows: 0 },
  };

  const report = (phase) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        phase,
        source,
        file: state.file,
        rows_read: state.rowsRead,
        events_written: state.eventsWritten,
        aggregates_written: state.aggregatesWritten,
      });
    } catch {
      // A reporting callback must never be able to fail an import.
    }
  };

  const flush = () => {
    if (!state.buffer.length) return;
    const batch = state.buffer;
    state.buffer = [];
    transaction(() => write(batch, state));
    report('writing');
  };

  return {
    state,
    report,
    flush,
    add(item) {
      state.buffer.push(item);
      if (state.buffer.length >= CHUNK) flush();
    },
  };
}

// ------------------------------------------------------- Plausible CSV run --

/**
 * Every `imported_*.csv` in the archive (or the single file), in table order.
 * Bodies stay compressed until `read()` is called, so only one table is ever
 * decompressed at a time.
 */
function plausibleParts(filePath, sniffed) {
  if (!sniffed.zip) {
    const table = plausibleTableName(filePath);
    // Same ceiling as an unpacked archive entry: a bare table is parsed from a
    // single string, so it has to fit in one.
    const size = statFile(filePath).size;
    if (size > MAX_TABLE_BYTES) {
      throw new HttpError(
        422,
        `${path.basename(filePath)} is ${mb(size)}; the largest single table this can read is ` +
          `${mb(MAX_TABLE_BYTES)}. Split it by date range.`,
      );
    }
    return {
      parts: [{ table, name: path.basename(filePath), read: () => fs.readFileSync(filePath, 'utf8') }],
      skipped: [],
    };
  }
  const parts = [];
  const skipped = [];
  for (const entry of sniffed.entries) {
    const table = plausibleTableName(entry.name);
    if (!table) {
      skipped.push(entry.name);
      continue;
    }
    parts.push({
      table,
      name: path.basename(entry.name),
      read: () => readZipEntry(sniffed.zip, entry).toString('utf8'),
    });
  }
  parts.sort((a, b) => PLAUSIBLE_ORDER.get(a.table) - PLAUSIBLE_ORDER.get(b.table));
  return { parts, skipped };
}

/**
 * Walk one Plausible table, handing every parsed row to `onRow(date, row, metrics)`.
 * The header decides which columns exist; missing optional columns read as ''.
 */
function eachPlausibleRow(part, ctx, onRow) {
  const spec = PLAUSIBLE_TABLES[part.table];
  const where = part.name;
  let reader = null;

  eachCsvRow(part.read(), where, (cells, line) => {
    if (!reader) {
      reader = makeReader(cells, where);
      if (!reader.has('date')) {
        throw new HttpError(422, `${where} line ${line}: no "date" column (found ${cells.join(', ')})`);
      }
      return;
    }
    const value = reader.read(cells, line);
    const at = `${where} line ${line}`;
    const date = parseDateCell(value('date'), at);
    const metrics = spec.metrics
      ? spec.metrics(value, at)
      : plausibleMetrics(value, at, { visitsColumn: spec.visitsColumn });
    const row = {};
    for (const column of spec.columns || []) row[column] = value(column);
    onRow(date, row, metrics, ctx);
  });
}

async function runPlausible({ site, filePath, sniffed, dryRun, onProgress }) {
  const { parts, skipped } = plausibleParts(filePath, sniffed);
  const notes = skipped.map((name) => `skipped "${name}": not a Plausible table`);

  const writer = createWriter({
    onProgress,
    source: 'plausible-csv',
    write(batch, state) {
      for (const row of batch) {
        run(AGG_INSERT, [
          site.id, state.importId, row.date, row.dimension, row.value,
          row.visitors, row.visits, row.pageviews, row.bounces, row.visit_duration, row.events,
        ]);
      }
      state.aggregatesWritten += batch.length;
    },
  });
  const ctx = { site, counters: writer.state.counters };

  // Pass 1 — expand every row exactly as pass 2 will, but write nothing. A dry
  // run is only worth having if it hits every line of validation the real run
  // does, so the expansion happens here too and the result is discarded.
  let from = null;
  let to = null;
  let rowsRead = 0;
  let wouldWrite = 0;
  for (const part of parts) {
    writer.state.file = part.name;
    const spec = PLAUSIBLE_TABLES[part.table];
    eachPlausibleRow(part, ctx, (date, row, metrics) => {
      rowsRead += 1;
      if (from === null || date < from) from = date;
      if (to === null || date > to) to = date;
      wouldWrite += spec.expand(row, metrics, ctx).filter((r) => r.dimension === '' || r.value).length;
    });
    writer.state.rowsRead = rowsRead;
    writer.report('scanning');
  }
  if (!rowsRead) throw new HttpError(422, 'Nothing to import: no data rows in any Plausible table');
  checkOverlap(site.id, from, to);
  warnAboutNativeOverlap(site, from, to, notes);
  collectPlausibleNotes(notes, ctx.counters);

  const preview = {
    source: 'plausible-csv',
    from_date: from,
    to_date: to,
    rows_read: rowsRead,
    files: parts.map((p) => p.name),
  };
  if (dryRun) return { ...preview, notes, aggregates_written: wouldWrite, events_written: 0, dry_run: true };

  // Pass 2 — write.
  const importId = beginImport(site.id, 'plausible-csv', from, to);
  writer.state.importId = importId;
  writer.state.rowsRead = 0;

  try {
    for (const part of parts) {
      writer.state.file = part.name;
      const spec = PLAUSIBLE_TABLES[part.table];
      eachPlausibleRow(part, ctx, (date, row, metrics) => {
        writer.state.rowsRead += 1;
        for (const produced of spec.expand(row, metrics, ctx)) {
          if (produced.dimension !== '' && !produced.value) continue;
          writer.add({ date, ...produced });
        }
      });
      writer.flush();
    }
    writer.flush();
  } catch (err) {
    rollbackImport(site.id, importId);
    failImport(importId, err);
    throw err;
  }

  return finishImport(importId, writer.state, notes);
}

/** What the caller needs to be told about a Plausible export, honestly. */
function collectPlausibleNotes(notes, counters) {
  if (counters.geonameCities) {
    notes.push(`${counters.geonameCities} city rows skipped: Plausible exports GeoNames ids, not city names`);
  }
  if (counters.droppedProps) {
    notes.push(
      `${counters.droppedProps} custom events lost their link_url/path property (aggregates hold one value per row)`,
    );
  }
  notes.push('Imported data is aggregated: it cannot be filtered by two dimensions at once');
}

// ------------------------------------------------------- raw event imports --

/**
 * Build the exact dimension set for one raw row; '' wherever the file is silent.
 * `urlCampaign` is what the landing URL itself carried, used only for the utm
 * fields the file has no column for.
 */
function rawDimensions(value, columns, site, at, urlCampaign) {
  const pick = (field, max = 255) => (columns[field] ? cell(value(columns[field]), max) : '');

  const utm = {
    source: pick('utm_source') || cell(urlCampaign.source, 255),
    medium: pick('utm_medium') || cell(urlCampaign.medium, 255),
    campaign: pick('utm_campaign') || cell(urlCampaign.campaign, 255),
    content: pick('utm_content') || cell(urlCampaign.content, 255),
    term: pick('utm_term') || cell(urlCampaign.term, 255),
  };
  const referrer = pick('referrer', 1000);

  // Explicit columns win; otherwise re-derive with the live classifier so a
  // foreign CSV still lands in the right channel.
  let channel = pick('channel', 60);
  let source = pick('referrer_source');
  if (!channel || !source) {
    const classified = classifyReferrer({
      referrer: referrer ? (/^https?:\/\//i.test(referrer) ? referrer : `https://${referrer}`) : '',
      siteHost: site.domain,
      utm,
    });
    channel = channel || classified.channel;
    source = source || classified.source;
  }

  const country = pick('country_code', 2).toUpperCase();
  return {
    channel,
    referrer_source: source,
    referrer: referrer.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_term: utm.term,
    country_code: /^[A-Z]{2}$/.test(country) ? country : '',
    region: pick('region', 120),
    city: pick('city', 120),
    browser: pick('browser', 120),
    browser_version: pick('browser_version', 60),
    os: pick('os', 120),
    os_version: pick('os_version', 60),
    device: normalizeDevice(pick('device', 32)),
    screen_size: normalizeDevice(pick('screen_size', 32)),
    revenue: columns.revenue && cell(value(columns.revenue)) ? signedIntCell(value(columns.revenue), at, 'revenue') : null,
    currency: pick('currency', 3).toUpperCase(),
    engagement_time: columns.engagement_time ? intCell(value(columns.engagement_time), at, 'engagement_time') : 0,
    scroll_depth: Math.min(100, columns.scroll_depth ? intCell(value(columns.scroll_depth), at, 'scroll_depth') : 0),
  };
}

const EVENT_DIMENSION_UPDATE = `UPDATE events SET
   hostname = ?, channel = ?, referrer_source = ?, referrer = ?,
   utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?,
   country_code = ?, region = ?, city = ?,
   browser = ?, browser_version = ?, os = ?, os_version = ?, device = ?, screen_size = ?,
   revenue = ?, currency = ?, engagement_time = ?, scroll_depth = ?
 WHERE id = ?`;

const VISIT_DIMENSION_UPDATE = `UPDATE visits SET
   channel = ?, referrer_source = ?, referrer = ?,
   utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?,
   country_code = ?, region = ?, city = ?,
   browser = ?, browser_version = ?, os = ?, os_version = ?, device = ?, screen_size = ?
 WHERE id = ?`;

const dimensionParams = (d) => [
  d.channel, d.referrer_source, d.referrer,
  d.utm_source, d.utm_medium, d.utm_campaign, d.utm_content, d.utm_term,
  d.country_code, d.region, d.city,
  d.browser, d.browser_version, d.os, d.os_version, d.device, d.screen_size,
];

/**
 * Ingest one raw row.
 *
 * The CSV carries dimensions that were already derived (a browser name, not a
 * User-Agent; a country code, not an IP), so nothing can re-derive them
 * faithfully. We therefore let `recordEvent` do the part that genuinely cannot
 * be faked — sessionisation — and then restore the exported dimension values
 * verbatim instead of guessing them from a synthetic User-Agent.
 */
function ingestRaw(event, site, ranges) {
  const hostname = event.hostname || site.domain;
  const result = recordEvent(
    { n: event.name, d: site.domain, u: `https://${hostname}${event.pathname}`, p: event.props },
    { ip: '', userAgent: IMPORT_USER_AGENT, timestamp: event.timestamp, visitorId: event.visitorId },
  );
  if (result.status !== 'ok') return { written: false, reason: result.reason };

  const row = get('SELECT id, visit_id FROM events WHERE id = last_insert_rowid() AND site_id = ?', [site.id]);
  if (!row) return { written: false, reason: 'row vanished' };

  const d = event.dimensions;
  run(EVENT_DIMENSION_UPDATE, [
    hostname, ...dimensionParams(d), d.revenue, d.currency, d.engagement_time, d.scroll_depth, Number(row.id),
  ]);
  // Session attributes belong to the hit that opened the visit; `events = 1`
  // is true only for a visit this very event just created.
  const visit = get('SELECT events FROM visits WHERE id = ?', [row.visit_id]);
  if (visit && Number(visit.events) === 1) run(VISIT_DIMENSION_UPDATE, [...dimensionParams(d), row.visit_id]);

  trackEventId(ranges, Number(row.id));
  return { written: true };
}

/** Turn one CSV record into the shape `ingestRaw` wants, validating as we go. */
function readRawEvent(value, columns, site, at) {
  const timestamp = parseTimestampCell(value(columns.timestamp), site.timezone, at);
  const visitorId = columns.visitor_id ? cell(value(columns.visitor_id), 64) : '';
  if (!visitorId) throw new HttpError(422, `${at}: empty ${columns.visitor_id} — raw events need a visitor id`);

  const rawPath = columns.pathname ? cell(value(columns.pathname)) : '/';
  let pathname = rawPath || '/';
  let hostname = columns.hostname ? cell(value(columns.hostname), 253) : '';
  if (/^https?:\/\//i.test(pathname)) {
    try {
      const url = new URL(pathname);
      hostname = hostname || url.hostname;
      pathname = `${url.pathname}${url.search}`;
    } catch {
      throw new HttpError(422, `${at}: "${rawPath}" is not a usable page URL`);
    }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  let props;
  const rawProps = columns.props ? cell(value(columns.props), 4000) : '';
  if (rawProps) {
    try {
      const parsed = JSON.parse(rawProps);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) props = parsed;
    } catch {
      throw new HttpError(422, `${at}: props is not a JSON object`);
    }
  }

  return {
    timestamp,
    visitorId,
    name: (columns.name ? cell(value(columns.name), 120) : '') || 'pageview',
    hostname: hostname.replace(/^www\./, ''),
    pathname,
    props,
    dimensions: rawDimensions(value, columns, site, at, extractCampaign(pathname)),
  };
}

async function runRaw({ site, filePath, source, dryRun, onProgress, columnMap }) {
  const where = path.basename(filePath);
  const notes = [];
  let columns = null;
  let reader = null;

  const bind = (cells, line) => {
    reader = makeReader(cells, where);
    columns = resolveColumns(reader, columnMap);
    if (!columns.timestamp) {
      throw new HttpError(
        422,
        `${where} line ${line}: no timestamp column (looked for ${GENERIC_COLUMNS.timestamp.join(', ')})`,
      );
    }
    if (!columns.visitor_id) {
      throw new HttpError(
        422,
        `${where} line ${line}: no visitor column (looked for ${GENERIC_COLUMNS.visitor_id.join(', ')}). ` +
          'Raw event imports need one so visits can be reconstructed.',
      );
    }
  };

  // Pass 1 — parse and validate everything, learn the range, write nothing.
  let from = null;
  let to = null;
  let rowsRead = 0;
  let previous = -Infinity;
  let outOfOrder = 0;
  await eachCsvFileRow(filePath, where, (cells, line) => {
    if (!reader) return bind(cells, line);
    const value = reader.read(cells, line);
    const event = readRawEvent(value, columns, site, `${where} line ${line}`);
    rowsRead += 1;
    const date = formatYmd(event.timestamp, site.timezone);
    if (from === null || date < from) from = date;
    if (to === null || date > to) to = date;
    if (event.timestamp < previous) outOfOrder += 1;
    previous = event.timestamp;
    return undefined;
  });

  if (!rowsRead) throw new HttpError(422, `${where} has a header but no data rows`);
  checkOverlap(site.id, from, to);
  warnAboutNativeOverlap(site, from, to, notes);
  if (outOfOrder) {
    notes.push(
      `${outOfOrder} rows are older than the row before them; visits are stitched in file order, ` +
        'so sort the file by timestamp for exact sessionisation',
    );
  }

  const preview = {
    source,
    from_date: from,
    to_date: to,
    rows_read: rowsRead,
    files: [where],
    columns: Object.fromEntries(Object.entries(columns).filter(([, v]) => v)),
  };
  if (dryRun) return { ...preview, notes, aggregates_written: 0, events_written: 0, dry_run: true };

  // Pass 2 — ingest, chronologically, in chunks.
  const importId = beginImport(site.id, source, from, to);
  const writer = createWriter({
    onProgress,
    source,
    write(batch, state) {
      for (const event of batch) {
        const result = ingestRaw(event, site, state.ranges);
        if (result.written) state.eventsWritten += 1;
        else state.counters.skippedRows += 1;
      }
      persistRanges(importId, state.ranges);
    },
  });
  writer.state.importId = importId;
  writer.state.file = where;
  reader = null;

  try {
    await eachCsvFileRow(filePath, where, (cells, line) => {
      if (!reader) return bind(cells, line);
      const value = reader.read(cells, line);
      writer.state.rowsRead += 1;
      writer.add(readRawEvent(value, columns, site, `${where} line ${line}`));
      return undefined;
    });
    writer.flush();
  } catch (err) {
    rollbackImport(site.id, importId);
    failImport(importId, err);
    throw err;
  }

  if (writer.state.counters.skippedRows) {
    notes.push(
      `${writer.state.counters.skippedRows} rows were dropped by the ingestion pipeline ` +
        '(excluded path, excluded IP, or an unusable URL)',
    );
  }
  return finishImport(importId, writer.state, notes);
}

// ---------------------------------------------- generic aggregated imports --

async function runGenericAggregate({ site, filePath, dryRun, onProgress, columnMap }) {
  const where = path.basename(filePath);
  const notes = [];
  let reader = null;
  let columns = null;
  let dimensions = [];
  let explicitDimension = false;

  const bind = (cells) => {
    reader = makeReader(cells, where);
    columns = resolveColumns(reader, columnMap);
    if (!columns.date) {
      throw new HttpError(422, `${where}: no date column (looked for ${GENERIC_COLUMNS.date.join(', ')})`);
    }
    explicitDimension = reader.has('dimension') && reader.has('value');
    dimensions = explicitDimension
      ? []
      : GENERIC_AGG_DIMENSIONS.filter(([field]) => columns[field]);
  };

  const metricsOf = (value, at) => ({
    visitors: columns.visitors ? intCell(value(columns.visitors), at, 'visitors') : 0,
    visits: columns.visits ? intCell(value(columns.visits), at, 'visits') : 0,
    pageviews: columns.pageviews ? intCell(value(columns.pageviews), at, 'pageviews') : 0,
    bounces: columns.bounces ? intCell(value(columns.bounces), at, 'bounces') : 0,
    visit_duration: columns.visit_duration ? intCell(value(columns.visit_duration), at, 'visit_duration') : 0,
    events: 0,
  });

  const expand = (value, metrics) => {
    if (explicitDimension) {
      const key = cell(value('dimension'), 60);
      if (!IMPORTED_DIMENSIONS.includes(key)) {
        throw new HttpError(422, `${where}: unknown dimension "${key}". Use one of: ${IMPORTED_DIMENSIONS.filter(Boolean).join(', ')}`);
      }
      return [agg(key, value('value'), metrics)];
    }
    if (!dimensions.length) return [agg('', '', metrics)];
    return dimensions
      .map(([field, key]) => agg(key, cell(value(columns[field])), metrics))
      .filter((row) => row.value);
  };

  // Pass 1 — expand every row the way pass 2 will, so a dry run validates the
  // whole file, and learn the date range.
  let from = null;
  let to = null;
  let rowsRead = 0;
  let wouldWrite = 0;
  await eachCsvFileRow(filePath, where, (cells, line) => {
    if (!reader) return bind(cells);
    const value = reader.read(cells, line);
    const at = `${where} line ${line}`;
    const date = parseDateCell(value(columns.date), at);
    wouldWrite += expand(value, metricsOf(value, at)).length;
    rowsRead += 1;
    if (from === null || date < from) from = date;
    if (to === null || date > to) to = date;
    return undefined;
  });

  if (!rowsRead) throw new HttpError(422, `${where} has a header but no data rows`);
  checkOverlap(site.id, from, to);
  warnAboutNativeOverlap(site, from, to, notes);
  if (!explicitDimension && !dimensions.length) {
    notes.push('No dimension column recognised — the file is read as daily totals');
  } else {
    notes.push('Only daily-total files feed the headline numbers; this file feeds breakdowns');
  }

  const preview = {
    source: 'generic-csv',
    from_date: from,
    to_date: to,
    rows_read: rowsRead,
    files: [where],
    dimensions: explicitDimension ? ['(from the dimension column)'] : dimensions.map(([, key]) => key),
  };
  if (dryRun) return { ...preview, notes, aggregates_written: wouldWrite, events_written: 0, dry_run: true };

  const importId = beginImport(site.id, 'generic-csv', from, to);
  const writer = createWriter({
    onProgress,
    source: 'generic-csv',
    write(batch, state) {
      for (const row of batch) {
        run(AGG_INSERT, [
          site.id, importId, row.date, row.dimension, row.value,
          row.visitors, row.visits, row.pageviews, row.bounces, row.visit_duration, row.events,
        ]);
      }
      state.aggregatesWritten += batch.length;
    },
  });
  writer.state.importId = importId;
  writer.state.file = where;
  reader = null;

  try {
    await eachCsvFileRow(filePath, where, (cells, line) => {
      if (!reader) return bind(cells);
      const value = reader.read(cells, line);
      const at = `${where} line ${line}`;
      const date = parseDateCell(value(columns.date), at);
      const metrics = metricsOf(value, at);
      writer.state.rowsRead += 1;
      for (const row of expand(value, metrics)) writer.add({ date, ...row });
      return undefined;
    });
    writer.flush();
  } catch (err) {
    rollbackImport(site.id, importId);
    failImport(importId, err);
    throw err;
  }

  notes.push('Imported data is aggregated: it cannot be filtered by two dimensions at once');
  return finishImport(importId, writer.state, notes);
}

// -------------------------------------------------------------- completion --

function finishImport(importId, state, notes) {
  run(
    `UPDATE imports SET status = 'complete', rows_read = ?, events_written = ?,
            aggregates_written = ?, finished_at = ? WHERE id = ?`,
    [state.rowsRead, state.eventsWritten, state.aggregatesWritten, now(), importId],
  );
  return { ...readImport(importId), notes };
}

function failImport(importId, err) {
  run(`UPDATE imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, [
    String(err?.message || err).slice(0, 500),
    now(),
    importId,
  ]);
}

/** Undo the rows a half-finished import already wrote, leaving the record behind. */
function rollbackImport(siteId, importId) {
  try {
    transaction(() => removeImportRows(siteId, importId));
  } catch {
    // The failure is already being reported; leave the record for `credible
    // import:delete` rather than masking the original error with this one.
  }
}

// ------------------------------------------------------------------ public --

/**
 * Import a file into a site.
 *
 * @param {object}   options
 * @param {number}   options.siteId
 * @param {string}   options.filePath  a .zip of Plausible tables, or a .csv
 * @param {string}   [options.source]  'auto' | 'plausible-csv' | 'credible-csv' | 'generic-csv'
 * @param {boolean}  [options.dryRun]  parse and validate, write nothing
 * @param {Function} [options.onProgress] called per chunk with counters
 * @param {object}   [options.columnMap] generic-csv overrides, { field: 'Column Name' }
 * @returns {Promise<object>} the `imports` row, plus `notes`
 */
export async function importFile({
  siteId,
  filePath,
  source = 'auto',
  dryRun = false,
  onProgress,
  columnMap = {},
} = {}) {
  ensureSchema();
  const site = findSite(siteId);
  if (!site) throw new HttpError(404, 'Site not found');

  const sniffed = sniff(filePath, statFile(filePath));
  const resolved = source === 'auto' ? sniffed.source : String(source);
  if (!IMPORT_SOURCES.includes(resolved)) {
    throw new HttpError(422, `Unknown source "${source}". Use auto, ${IMPORT_SOURCES.join(', ')}.`);
  }
  if (resolved === 'plausible-csv' && sniffed.source !== 'plausible-csv' && !plausibleTableName(filePath)) {
    throw new HttpError(422, `${path.basename(filePath)} does not look like a Plausible export`);
  }
  if (sniffed.zip && resolved !== 'plausible-csv') {
    throw new HttpError(
      422,
      `${path.basename(filePath)} is a ZIP archive, which only plausible-csv can read. ` +
        `Unpack it and import the ${resolved} file directly.`,
    );
  }

  const options = { site, filePath, sniffed, source: resolved, dryRun, onProgress, columnMap };
  if (resolved === 'plausible-csv') return runPlausible(options);
  if (resolved === 'credible-csv') return runRaw(options);

  // generic-csv: raw events when the file has a timestamp, rollups when it has a date.
  const header = makeReader(readCsvHeader(filePath), path.basename(filePath));
  const columns = resolveColumns(header, columnMap);
  if (columns.timestamp) return runRaw(options);
  if (columns.date) return runGenericAggregate(options);
  throw new HttpError(
    422,
    `${path.basename(filePath)}: no timestamp and no date column. Raw events need one of ` +
      `[${GENERIC_COLUMNS.timestamp.join(', ')}]; daily rollups need one of [${GENERIC_COLUMNS.date.join(', ')}].`,
  );
}

/** Every import recorded for a site, newest first. */
export function listImports(siteId) {
  ensureSchema();
  return all('SELECT * FROM imports WHERE site_id = ? ORDER BY id DESC', [siteId]);
}

/**
 * Remove exactly what one import wrote, and nothing else.
 *
 * Aggregates carry `import_id`, so they go directly. Raw events do not — the
 * `events` table belongs to the ingestion pipeline — so the rowid ranges
 * recorded during the run identify them instead. Visits are then recomputed
 * from whatever events remain, which repairs a visit the import extended and
 * deletes one it created outright.
 */
export function deleteImport(siteId, importId) {
  ensureSchema();
  const record = get('SELECT * FROM imports WHERE id = ? AND site_id = ?', [importId, siteId]);
  if (!record) throw new HttpError(404, `No import #${importId} for this site`);
  return transaction(() => {
    const removed = removeImportRows(siteId, importId);
    run('DELETE FROM imports WHERE id = ?', [importId]);
    return { id: Number(importId), source: record.source, ...removed };
  });
}

function removeImportRows(siteId, importId) {
  const aggregates = Number(
    run('DELETE FROM imported_stats WHERE site_id = ? AND import_id = ?', [siteId, importId]).changes || 0,
  );

  const ranges = all('SELECT first_id, last_id FROM import_event_ranges WHERE import_id = ?', [importId]);
  const touched = new Set();
  let events = 0;
  for (const range of ranges) {
    for (const row of all(
      'SELECT DISTINCT visit_id FROM events WHERE site_id = ? AND id BETWEEN ? AND ?',
      [siteId, range.first_id, range.last_id],
    )) {
      touched.add(row.visit_id);
    }
    events += Number(
      run('DELETE FROM events WHERE site_id = ? AND id BETWEEN ? AND ?', [siteId, range.first_id, range.last_id])
        .changes || 0,
    );
  }
  run('DELETE FROM import_event_ranges WHERE import_id = ?', [importId]);

  let visits = 0;
  for (const visitId of touched) {
    const remaining = get(
      `SELECT count(*) AS events,
              sum(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
              min(timestamp) AS first_at, max(timestamp) AS last_at
         FROM events WHERE visit_id = ?`,
      [visitId],
    );
    if (!remaining || !remaining.events) {
      visits += Number(run('DELETE FROM visits WHERE id = ?', [visitId]).changes || 0);
      continue;
    }
    const pageviews = Number(remaining.pageviews || 0);
    run(
      `UPDATE visits SET
         started_at = ?, last_event_at = ?, duration = ?, events = ?, pageviews = ?,
         is_bounce = ?,
         entry_page = COALESCE((SELECT pathname FROM events WHERE visit_id = ? ORDER BY timestamp, id LIMIT 1), entry_page),
         exit_page  = COALESCE((SELECT pathname FROM events WHERE visit_id = ? AND name = 'pageview'
                                 ORDER BY timestamp DESC, id DESC LIMIT 1), exit_page)
       WHERE id = ?`,
      [
        remaining.first_at, remaining.last_at, remaining.last_at - remaining.first_at,
        remaining.events, pageviews, pageviews > 1 ? 0 : 1, visitId, visitId, visitId,
      ],
    );
  }

  return { aggregates_removed: aggregates, events_removed: events, visits_removed: visits };
}

// ------------------------------------------- reading the imported rollups --

const TOTAL_COLUMNS = `COALESCE(sum(visitors), 0) AS visitors,
        COALESCE(sum(visits), 0) AS visits,
        COALESCE(sum(pageviews), 0) AS pageviews,
        COALESCE(sum(bounces), 0) AS bounces,
        COALESCE(sum(visit_duration), 0) AS visit_duration,
        COALESCE(sum(events), 0) AS events`;

/**
 * Imported daily totals for a site over a site-local date range (inclusive).
 * Dates come from `formatYmd(start, tz)` and `formatYmd(end - 1, tz)`.
 */
export function importedTotals(siteId, fromDate, toDate) {
  ensureSchema();
  const row = get(
    `SELECT ${TOTAL_COLUMNS} FROM imported_stats
      WHERE site_id = ? AND dimension = '' AND date >= ? AND date <= ?`,
    [siteId, fromDate, toDate],
  );
  return { visitors: 0, visits: 0, pageviews: 0, bounces: 0, visit_duration: 0, events: 0, ...row };
}

/**
 * Imported rows for one dimension, summed per value.
 * Single dimension only — see the note at the top of this file about why there
 * is no cross-filtered version and cannot be one.
 */
export function importedBreakdown(siteId, dimension, fromDate, toDate, limit = 100) {
  ensureSchema();
  return all(
    `SELECT value AS name, ${TOTAL_COLUMNS} FROM imported_stats
      WHERE site_id = ? AND dimension = ? AND date >= ? AND date <= ? AND value <> ''
      GROUP BY value ORDER BY visitors DESC, pageviews DESC, name ASC LIMIT ?`,
    [siteId, dimension, fromDate, toDate, Math.max(1, Math.min(Number(limit) || 100, 10000))],
  );
}

/** The span of imported history for a site, or null when there is none. */
export function importedRange(siteId) {
  ensureSchema();
  const row = get(
    "SELECT min(date) AS first, max(date) AS last FROM imported_stats WHERE site_id = ?",
    [siteId],
  );
  return row && row.first ? { first: row.first, last: row.last } : null;
}
