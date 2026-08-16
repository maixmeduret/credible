/**
 * Importing history from other tools.
 *
 * The fixtures are built here rather than committed: a Plausible export is a
 * ZIP, and a ZIP we construct ourselves also proves the reader in src/import.js
 * against bytes it did not write (stored *and* deflated entries).
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { DATA_DIR, closeDatabase, events, track, utc, visits, withDatabase } from './helpers.js';

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  CREDIBLE_EXPORT_COLUMNS,
  GENERIC_COLUMNS,
  deleteImport,
  detectSource,
  importFile,
  importedBreakdown,
  importedRange,
  importedTotals,
  listImports,
  parseCsv,
} from '../src/import.js';
import { createSite } from '../src/sites.js';
import { all, get } from '../src/db/index.js';
import { aggregate, breakdown } from '../src/stats/index.js';
import { Scope } from '../src/stats/query.js';

let site;
let tmp;
let fixtureCount = 0;

beforeEach(async () => {
  await withDatabase('import');
  site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
  fixtureCount += 1;
  tmp = fs.mkdtempSync(path.join(DATA_DIR, `fixtures-${fixtureCount}-`));
});

after(closeDatabase);

// ------------------------------------------------------------- fixture kit --

function writeFile(name, contents) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, contents);
  return file;
}

/**
 * Build a real ZIP archive. `deflate` picks the compression method so both
 * branches of the reader are exercised by the same fixture.
 */
function buildZip(files, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** The Plausible export, exactly as their docs describe each table. */
const PLAUSIBLE_FILES = {
  'imported_visitors_20230209_20230210.csv':
    '"date","visitors","pageviews","bounces","visits","visit_duration"\n' +
    '"2023-02-09",119,304,77,134,21070\n' +
    '"2023-02-10",166,325,117,180,21467\n',
  'imported_sources_20230209_20230210.csv':
    '"date","source","referrer","utm_source","utm_medium","utm_campaign","utm_content","utm_term","pageviews","visitors","visits","visit_duration","bounces"\n' +
    '"2023-02-09","Google","google.com","","","","","",70,23,25,8249,13\n' +
    '"2023-02-09","","","","","","","",12,9,9,300,4\n' +
    '"2023-02-10","newsletter","","newsletter","email","spring, 2023","","",8,5,5,900,1\n',
  'imported_pages_20230209_20230210.csv':
    '"date","hostname","page","visits","visitors","pageviews"\n' +
    '"2023-02-09","example.com","/docs/stats-api",8,7,11\n' +
    '"2023-02-09","example.com","/pricing",5,5,6\n',
  'imported_entry_pages_20230209_20230210.csv':
    '"date","entry_page","visitors","entrances","visit_duration","bounces","pageviews"\n' +
    '"2023-02-09","/docs",28,29,3573,13,64\n',
  'imported_exit_pages_20230209_20230210.csv':
    '"date","exit_page","visitors","visit_duration","exits","bounces","pageviews"\n' +
    '"2023-02-09","/pricing",12,900,14,7,20\n',
  'imported_locations_20230209_20230210.csv':
    '"date","country","region","city","visitors","visits","visit_duration","bounces","pageviews"\n' +
    '"2023-02-09","FR","FR-PAC",3027647,10,11,400,3,22\n' +
    '"2023-02-09","GB","GB-ENG",2634910,4,4,120,1,7\n',
  'imported_devices_20230209_20230210.csv':
    '"date","device","visitors","visits","visit_duration","bounces","pageviews"\n' +
    '"2023-02-09","Laptop",19,21,3545,11,36\n' +
    '"2023-02-09","Desktop",89,100,17385,56,251\n' +
    '"2023-02-09","Mobile",12,13,140,10,17\n',
  'imported_browsers_20230209_20230210.csv':
    '"date","browser","browser_version","visitors","visits","visit_duration","bounces","pageviews"\n' +
    '"2023-02-09","Chrome","109.0",54,60,6627,40,128\n' +
    '"2023-02-09","Firefox","109.0",24,26,5284,16,51\n',
  'imported_operating_systems_20230209_20230210.csv':
    '"date","operating_system","operating_system_version","visitors","visits","visit_duration","bounces","pageviews"\n' +
    '"2023-02-09","Mac","10.14",30,33,2000,12,60\n',
  'imported_custom_events_20230209_20230210.csv':
    '"date","name","link_url","path","visitors","events"\n' +
    '"2023-02-09","Signup","","",3,4\n' +
    '"2023-02-09","Outbound Link: Click","https://one.example.com/","",1,1\n',
  'README.txt': 'not a table',
};

const plausibleZip = (options) => writeFile('plausible-export.zip', buildZip(PLAUSIBLE_FILES, options));

/** Reproduce `credible export <domain>` against the current database. */
function credibleExportCsv(siteId) {
  const rows = all(
    `SELECT ${CREDIBLE_EXPORT_COLUMNS.join(', ')} FROM events WHERE site_id = ? ORDER BY timestamp, id`,
    [siteId],
  );
  const csvCell = (value) => {
    if (value == null) return '';
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [CREDIBLE_EXPORT_COLUMNS.join(',')];
  for (const row of rows) lines.push(CREDIBLE_EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

const scopeFor = (from, to) =>
  new Scope({ site, range: { start: utc(...from), end: utc(...to) }, filters: [] });

// ================================================================== parseCsv =

describe('parseCsv', () => {
  it('reads quotes, embedded commas and embedded newlines', () => {
    const rows = parseCsv('a,b,c\n"x,1","he said ""hi""","two\nlines"\n');
    assert.deepEqual(rows, [
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'two\nlines'],
    ]);
  });

  it('handles CRLF, a byte order mark and a missing final newline', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('keeps empty fields and skips blank lines', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3\n\n4,5,6\n'), [
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('treats "" as an empty quoted field', () => {
    assert.deepEqual(parseCsv('"",x,""\n'), [['', 'x', '']]);
  });

  it('names the line of an unterminated quote', () => {
    assert.throws(() => parseCsv('a,b\n1,"oops\n'), /line 2: unterminated quoted field/);
  });
});

// ============================================================ detectSource ==

describe('detectSource', () => {
  it('recognises a Plausible ZIP', () => {
    assert.equal(detectSource(plausibleZip()), 'plausible-csv');
  });

  it('recognises a stored (uncompressed) ZIP too', () => {
    assert.equal(detectSource(plausibleZip({ deflate: false })), 'plausible-csv');
  });

  it('recognises a single Plausible table', () => {
    const file = writeFile(
      'imported_visitors_20230209_20230210.csv',
      PLAUSIBLE_FILES['imported_visitors_20230209_20230210.csv'],
    );
    assert.equal(detectSource(file), 'plausible-csv');
  });

  it('recognises our own export by its header', () => {
    const file = writeFile('export.csv', `${CREDIBLE_EXPORT_COLUMNS.join(',')}\n`);
    assert.equal(detectSource(file), 'credible-csv');
  });

  it('falls back to generic for anything else', () => {
    assert.equal(detectSource(writeFile('other.csv', 'date,page,visitors\n2024-01-01,/,3\n')), 'generic-csv');
  });

  it('rejects a ZIP with no Plausible tables', () => {
    const file = writeFile('random.zip', buildZip({ 'notes.txt': 'hello' }));
    assert.throws(() => detectSource(file), /no Plausible tables/);
  });

  it('rejects a missing file', () => {
    assert.throws(() => detectSource(path.join(tmp, 'nope.csv')), /File not found/);
  });

  it('finds the directory behind a trailing archive comment', () => {
    const zip = buildZip(PLAUSIBLE_FILES);
    zip.writeUInt16LE(11, zip.length - 2); // comment length
    const file = writeFile('commented.zip', Buffer.concat([zip, Buffer.from('hello world')]));
    assert.equal(detectSource(file), 'plausible-csv');
  });
});

describe('ZIP64 archives', () => {
  /** Rewrite a normal archive so the reader has to go through the ZIP64 records. */
  function toZip64(zip, entryCount) {
    const eocdAt = zip.length - 22;
    const cdSize = zip.readUInt32LE(eocdAt + 12);
    const cdOffset = zip.readUInt32LE(eocdAt + 16);

    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4); // size of the rest of this record
    eocd64.writeBigUInt64LE(BigInt(entryCount), 24);
    eocd64.writeBigUInt64LE(BigInt(entryCount), 32);
    eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
    eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.from(zip.subarray(eocdAt));
    eocd.writeUInt16LE(0xffff, 8); // "look in the ZIP64 record instead"
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 16);

    return Buffer.concat([zip.subarray(0, eocdAt), eocd64, locator, eocd]);
  }

  it('reads a directory addressed through the ZIP64 records', async () => {
    const count = Object.keys(PLAUSIBLE_FILES).length;
    const file = writeFile('big.zip', toZip64(buildZip(PLAUSIBLE_FILES), count));
    assert.equal(detectSource(file), 'plausible-csv');

    const record = await importFile({ siteId: site.id, filePath: file });
    assert.equal(record.status, 'complete');
    assert.equal(importedTotals(site.id, '2023-02-09', '2023-02-10').visitors, 285);
  });
});

// ===================================================== decompression limits =

describe('archive size limits', () => {
  /** A file whose stat reports `size` but which occupies almost no disk. */
  function sparseFile(name, head, size) {
    const file = path.join(tmp, name);
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, Buffer.from(head, 'utf8'));
      fs.ftruncateSync(fd, size);
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  it('refuses an archive too large to hold in memory, on the stat alone', async () => {
    // The central directory is at the end, so the whole archive has to be read
    // before any entry can be found. 257 MB never gets read.
    const file = sparseFile('huge.zip', 'PK', 257 * 1024 * 1024);
    await assert.rejects(
      () => importFile({ siteId: site.id, filePath: file }),
      (err) => err.status === 422 && /largest archive this can read is 256 MB/.test(err.message),
    );
    assert.equal(listImports(site.id).length, 0);
  });

  it('refuses a bare table too large to hold in one string', async () => {
    const file = sparseFile(
      'imported_visitors_20230209_20230210.csv',
      'date,visitors,pageviews,bounces,visits,visit_duration\n',
      129 * 1024 * 1024,
    );
    assert.equal(detectSource(file), 'plausible-csv');
    await assert.rejects(
      () => importFile({ siteId: site.id, filePath: file }),
      (err) => err.status === 422 && /largest single table this can read is 128 MB/.test(err.message),
    );
  });

  it('refuses an entry that declares an unpacked size over the limit', async () => {
    // The declared size is a lie in the cheap direction: the archive is tiny,
    // so this is the branch that rejects before a single byte is allocated.
    const zip = buildZip({ 'imported_visitors_20230209_20230210.csv': 'date,visitors\n2023-02-09,1\n' });
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(200 * 1024 * 1024, central + 24); // uncompressed size
    const file = writeFile('liar.zip', zip);

    await assert.rejects(
      () => importFile({ siteId: site.id, filePath: file }),
      (err) => err.status === 422 && /unpacks to 200 MB, over the 128 MB limit/.test(err.message),
    );
  });

  it('aborts a decompression bomb instead of inflating it', async () => {
    // 129 MB of one repeated byte deflates to ~128 KB. The declared size is
    // understated so the pre-check passes and `maxOutputLength` is what stops
    // it — the inflate aborts partway rather than allocating the output.
    const raw = Buffer.alloc(129 * 1024 * 1024, 0x61);
    const body = zlib.deflateRawSync(raw);
    assert.ok(body.length < 1024 * 1024, 'fixture should be a >100:1 bomb');

    const zip = buildZip({ 'imported_visitors_20230209_20230210.csv': 'date,visitors\n2023-02-09,1\n' });
    const local = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const nameLen = zip.readUInt16LE(local + 26);
    const head = Buffer.from(zip.subarray(local, local + 30 + nameLen));
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(1024, 22); // understated, so the stat check waves it through

    const patched = Buffer.concat([head, body, zip.subarray(central)]);
    const cdAt = head.length + body.length;
    patched.writeUInt32LE(body.length, cdAt + 20);
    patched.writeUInt32LE(1024, cdAt + 24);
    patched.writeUInt32LE(0, cdAt + 42);
    patched.writeUInt32LE(cdAt, patched.length - 22 + 16);
    const file = writeFile('bomb.zip', patched);

    assert.ok(fs.statSync(file).size < 1024 * 1024, 'the archive itself is small');
    await assert.rejects(
      () => importFile({ siteId: site.id, filePath: file }),
      (err) => err.status === 422 && /unpacks to more than the 128 MB limit/.test(err.message),
    );
    assert.equal(listImports(site.id).length, 0);
  });
});

// ========================================================= Plausible import =

describe('Plausible CSV import', () => {
  it('stores rollups instead of inventing events', async () => {
    const record = await importFile({ siteId: site.id, filePath: plausibleZip() });

    assert.equal(record.source, 'plausible-csv');
    assert.equal(record.status, 'complete');
    assert.equal(record.from_date, '2023-02-09');
    assert.equal(record.to_date, '2023-02-10');
    assert.equal(record.events_written, 0, 'an aggregated source must never write events');
    assert.equal(events().length, 0);
    assert.equal(visits().length, 0);
    assert.ok(record.aggregates_written > 0);
    assert.ok(record.notes.some((n) => /cannot be filtered by two dimensions/.test(n)));
  });

  it('adds the daily totals verbatim', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const totals = importedTotals(site.id, '2023-02-09', '2023-02-10');
    assert.deepEqual(totals, {
      visitors: 119 + 166,
      visits: 134 + 180,
      pageviews: 304 + 325,
      bounces: 77 + 117,
      visit_duration: 21070 + 21467,
      events: 0,
    });
    // A narrower window only picks up its own day.
    assert.equal(importedTotals(site.id, '2023-02-09', '2023-02-09').visitors, 119);
    assert.deepEqual(importedRange(site.id), { first: '2023-02-09', last: '2023-02-10' });
  });

  it('maps every table onto a Credible dimension', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const of = (dimension) => importedBreakdown(site.id, dimension, '2023-02-09', '2023-02-10');
    const names = (dimension) => of(dimension).map((r) => r.name);

    assert.deepEqual(names('event:page'), ['/docs/stats-api', '/pricing']);
    assert.deepEqual(names('event:hostname'), ['example.com']);
    assert.deepEqual(names('visit:entry_page'), ['/docs']);
    assert.deepEqual(names('visit:exit_page'), ['/pricing']);
    assert.deepEqual(names('visit:country'), ['FR', 'GB']);
    assert.deepEqual(names('visit:region'), ['FR-PAC', 'GB-ENG']);
    assert.deepEqual(names('visit:browser'), ['Chrome', 'Firefox']);
    assert.deepEqual(names('visit:browser_version'), ['109.0']);
    assert.deepEqual(names('visit:os'), ['Mac']);
    assert.deepEqual(names('visit:os_version'), ['10.14']);
    assert.deepEqual(names('event:name'), ['Signup', 'Outbound Link: Click']);

    // Entry pages count entrances as visits, exit pages count exits.
    assert.equal(of('visit:entry_page')[0].visits, 29);
    assert.equal(of('visit:exit_page')[0].visits, 14);
    // Custom events keep their event count, which no metric column could hold.
    assert.equal(of('event:name')[0].events, 4);
  });

  it('derives the acquisition channel with Credible’s own classifier', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const sources = importedBreakdown(site.id, 'visit:source', '2023-02-09', '2023-02-10');
    const channels = importedBreakdown(site.id, 'visit:channel', '2023-02-09', '2023-02-10');

    assert.deepEqual(sources.map((r) => r.name).sort(), ['Direct', 'Google', 'newsletter']);
    assert.deepEqual(channels.map((r) => r.name).sort(), ['Direct', 'Email', 'Organic Search']);
    // A quoted campaign with an embedded comma survives the parser.
    const campaign = importedBreakdown(site.id, 'visit:utm_campaign', '2023-02-09', '2023-02-10');
    assert.deepEqual(campaign.map((r) => r.name), ['spring, 2023']);
  });

  it('files a laptop under both screen size and device', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const sizes = importedBreakdown(site.id, 'visit:screen_size', '2023-02-09', '2023-02-10');
    const devices = importedBreakdown(site.id, 'visit:device', '2023-02-09', '2023-02-10');

    assert.deepEqual(sizes.map((r) => r.name), ['Desktop', 'Laptop', 'Mobile']);
    // Credible's User-Agent device class has no Laptop, so it folds into Desktop.
    assert.deepEqual(devices.map((r) => r.name), ['Desktop', 'Mobile']);
    assert.equal(devices.find((r) => r.name === 'Desktop').visitors, 89 + 19);
  });

  it('drops GeoNames city ids rather than showing a number as a city', async () => {
    const record = await importFile({ siteId: site.id, filePath: plausibleZip() });
    assert.deepEqual(importedBreakdown(site.id, 'visit:city', '2023-02-09', '2023-02-10'), []);
    assert.ok(record.notes.some((n) => /GeoNames/.test(n)));
  });

  it('reports progress and can be previewed without writing', async () => {
    const seen = [];
    const record = await importFile({
      siteId: site.id,
      filePath: plausibleZip(),
      dryRun: true,
      onProgress: (p) => seen.push(p.phase),
    });
    assert.equal(record.rows_read, 19); // every data row across the ten tables
    assert.equal(record.dry_run, true);
    assert.ok(seen.includes('scanning'));
    assert.equal(listImports(site.id).length, 0, 'a dry run leaves no trace');
    assert.equal(all('SELECT * FROM imported_stats').length, 0);

    // What it predicted is what the real run writes.
    const real = await importFile({ siteId: site.id, filePath: plausibleZip() });
    assert.equal(real.aggregates_written, record.aggregates_written);
    assert.equal(real.rows_read, record.rows_read);
    assert.deepEqual(real.notes, record.notes);
  });
});

// ======================================================== Credible round trip

describe('Credible CSV round trip', () => {
  const T = utc(2025, 3, 4, 9, 0, 0);

  function seedTraffic() {
    // Two visitors, one of whom bounces, plus a custom event with props.
    track({ path: '/' }, { timestamp: T, visitorId: 'alice' });
    track({ path: '/pricing' }, { timestamp: T + 120, visitorId: 'alice' });
    track({ n: 'Signup', path: '/pricing', p: { plan: 'pro' } }, { timestamp: T + 180, visitorId: 'alice' });
    track({ path: '/blog', r: 'https://news.ycombinator.com/item?id=1' }, { timestamp: T + 300, visitorId: 'bob' });
    // A second session for alice, well past the inactivity window.
    track({ path: '/' }, { timestamp: T + 7200, visitorId: 'alice' });
  }

  it('reproduces the same stats after export and re-import', async () => {
    seedTraffic();
    const before = {
      aggregate: aggregate(scopeFor([2025, 3, 4], [2025, 3, 5])),
      pages: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'event:page' }),
      sources: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'visit:source' }),
      entry: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'visit:entry_page' }),
    };
    const csv = credibleExportCsv(site.id);

    // Start from an empty database and replay the export into it.
    await withDatabase('import-roundtrip');
    site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
    const file = writeFile('export.csv', csv);
    const record = await importFile({ siteId: site.id, filePath: file });

    assert.equal(record.source, 'credible-csv');
    assert.equal(record.events_written, 5);
    assert.equal(record.aggregates_written, 0);

    const after = {
      aggregate: aggregate(scopeFor([2025, 3, 4], [2025, 3, 5])),
      pages: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'event:page' }),
      sources: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'visit:source' }),
      entry: breakdown(scopeFor([2025, 3, 4], [2025, 3, 5]), { dimension: 'visit:entry_page' }),
    };
    assert.deepEqual(after, before);
  });

  it('re-sessionises for real instead of trusting the exported visit ids', async () => {
    seedTraffic();
    const csv = credibleExportCsv(site.id);
    const originalVisits = visits().map((v) => ({
      visitor_id: v.visitor_id,
      started_at: v.started_at,
      duration: v.duration,
      pageviews: v.pageviews,
      events: v.events,
      is_bounce: v.is_bounce,
      entry_page: v.entry_page,
      exit_page: v.exit_page,
    }));

    await withDatabase('import-sessions');
    site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
    await importFile({ siteId: site.id, filePath: writeFile('export.csv', csv) });

    const rebuilt = visits().map((v) => ({
      visitor_id: v.visitor_id,
      started_at: v.started_at,
      duration: v.duration,
      pageviews: v.pageviews,
      events: v.events,
      is_bounce: v.is_bounce,
      entry_page: v.entry_page,
      exit_page: v.exit_page,
    }));
    assert.equal(rebuilt.length, 3, 'alice has two sessions, bob one');
    assert.deepEqual(rebuilt, originalVisits);
  });

  it('restores the exported dimensions rather than a synthetic User-Agent', async () => {
    track(
      { path: '/', r: 'https://www.google.com/search' },
      { timestamp: T, visitorId: 'carol', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0' },
    );
    const original = events()[0];
    const csv = credibleExportCsv(site.id);

    await withDatabase('import-dimensions');
    site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
    await importFile({ siteId: site.id, filePath: writeFile('export.csv', csv) });

    const imported = events()[0];
    for (const column of CREDIBLE_EXPORT_COLUMNS) {
      if (column === 'visit_id') continue; // re-sessionised, so the id is new
      assert.equal(imported[column], original[column], `column ${column}`);
    }
    // The visit row carries the same session attributes.
    assert.equal(visits()[0].browser, 'Firefox');
    assert.equal(visits()[0].referrer_source, 'Google');
  });

  it('keeps custom event props and revenue', async () => {
    track({ n: 'Purchase', path: '/checkout', p: { plan: 'pro' }, v: { amount: 12.5, currency: 'EUR' } },
      { timestamp: T, visitorId: 'dan' });
    const csv = credibleExportCsv(site.id);

    await withDatabase('import-props');
    site = createSite({ domain: 'example.com', timezone: 'UTC', currency: 'EUR' });
    await importFile({ siteId: site.id, filePath: writeFile('export.csv', csv) });

    const row = events()[0];
    assert.equal(row.name, 'Purchase');
    assert.equal(row.props, '{"plan":"pro"}');
    assert.equal(row.revenue, 1250);
    assert.equal(row.currency, 'EUR');
  });
});

// ============================================================== generic CSV =

describe('generic CSV import', () => {
  it('ingests raw events through the real pipeline', async () => {
    const file = writeFile(
      'raw.csv',
      'time,user_id,page,country,browser,device\n' +
        '2025-04-01T08:00:00Z,u1,/,FR,Safari,mobile\n' +
        '2025-04-01T08:05:00Z,u1,/pricing,FR,Safari,mobile\n' +
        '2025-04-01T09:30:00Z,u2,/,DE,Firefox,desktop\n',
    );
    const record = await importFile({ siteId: site.id, filePath: file });

    assert.equal(record.source, 'generic-csv');
    assert.equal(record.events_written, 3);
    assert.equal(visits().length, 2, 'u1 has one session, u2 another');

    const rows = events();
    assert.deepEqual(rows.map((r) => r.pathname), ['/', '/pricing', '/']);
    assert.deepEqual(rows.map((r) => r.country_code), ['FR', 'FR', 'DE']);
    assert.deepEqual(rows.map((r) => r.device), ['Mobile', 'Mobile', 'Desktop']);
    assert.deepEqual(rows.map((r) => r.browser), ['Safari', 'Safari', 'Firefox']);
    // No referrer column means direct, exactly as live ingestion would record it.
    assert.deepEqual(rows.map((r) => r.channel), ['Direct', 'Direct', 'Direct']);
  });

  it('accepts an explicit column mapping', async () => {
    const file = writeFile(
      'weird.csv',
      'When,Who,Where\n1743494400,visitor-9,/from-mapping\n',
    );
    const record = await importFile({
      siteId: site.id,
      filePath: file,
      columnMap: { timestamp: 'When', visitor_id: 'Who', pathname: 'Where' },
    });
    assert.equal(record.events_written, 1);
    assert.equal(events()[0].pathname, '/from-mapping');
  });

  it('classifies a referrer column it was given', async () => {
    const file = writeFile(
      'ref.csv',
      'timestamp,visitor_id,path,referrer\n1743494400,v1,/,https://news.ycombinator.com/item?id=2\n',
    );
    await importFile({ siteId: site.id, filePath: file });
    assert.equal(events()[0].referrer_source, 'Hacker News');
    assert.equal(events()[0].channel, 'Organic Social');
  });

  it('stores a dated file with no timestamp as rollups', async () => {
    const file = writeFile(
      'daily.csv',
      'date,visitors,pageviews,bounces,visits,visit_duration\n' +
        '2024-05-01,10,25,4,12,600\n2024-05-02,8,17,3,9,420\n',
    );
    const record = await importFile({ siteId: site.id, filePath: file });

    assert.equal(record.events_written, 0);
    assert.equal(record.aggregates_written, 2);
    assert.equal(importedTotals(site.id, '2024-05-01', '2024-05-02').visitors, 18);
    assert.ok(record.notes.some((n) => /read as daily totals/.test(n)));
  });

  it('turns a dated dimension column into a breakdown', async () => {
    const file = writeFile(
      'by-country.csv',
      'date,country,visitors,visits,pageviews\n2024-05-01,FR,10,11,20\n2024-05-01,DE,4,4,6\n',
    );
    await importFile({ siteId: site.id, filePath: file });
    assert.deepEqual(
      importedBreakdown(site.id, 'visit:country', '2024-05-01', '2024-05-01').map((r) => [r.name, r.visitors]),
      [['FR', 10], ['DE', 4]],
    );
  });

  it('warns when the imported days were already tracked natively', async () => {
    track({ path: '/' }, { timestamp: utc(2024, 5, 1, 10, 0, 0), visitorId: 'native' });
    const file = writeFile('daily.csv', 'date,visitors\n2024-05-01,10\n2024-05-02,8\n');
    const record = await importFile({ siteId: site.id, filePath: file });
    assert.ok(
      record.notes.some((n) => /1 events were already tracked natively between 2024-05-01 and 2024-05-02/.test(n)),
      record.notes.join(' | '),
    );
    // A range with no native traffic says nothing.
    const clean = writeFile('clean.csv', 'date,visitors\n2024-09-01,10\n');
    const second = await importFile({ siteId: site.id, filePath: clean });
    assert.ok(!second.notes.some((n) => /tracked natively/.test(n)));
  });

  it('documents the aliases it accepts', () => {
    assert.ok(GENERIC_COLUMNS.timestamp.includes('occurred_at'));
    assert.ok(GENERIC_COLUMNS.pathname.includes('page_path'));
    assert.ok(GENERIC_COLUMNS.visitors.includes('users'));
  });
});

// ================================================================ bad input =

describe('malformed input', () => {
  it('names the line with the wrong column count', async () => {
    const file = writeFile(
      'broken.csv',
      'date,visitors,pageviews\n2024-01-01,5,9\n2024-01-02,7\n',
    );
    await assert.rejects(
      importFile({ siteId: site.id, filePath: file }),
      /broken\.csv line 3: expected 3 columns, found 2/,
    );
    assert.equal(listImports(site.id).length, 0, 'nothing is recorded when pass one fails');
  });

  it('names the line with an unparsable number', async () => {
    const file = writeFile('nan.csv', 'date,visitors\n2024-01-01,lots\n');
    await assert.rejects(
      importFile({ siteId: site.id, filePath: file }),
      /nan\.csv line 2: visitors is "lots", which is not a number/,
    );
  });

  it('names the line with an impossible date', async () => {
    const file = writeFile('date.csv', 'date,visitors\n2024-02-31,3\n');
    await assert.rejects(importFile({ siteId: site.id, filePath: file }), /line 2: "2024-02-31" is not a real calendar date/);
  });

  it('names the line with an unterminated quote', async () => {
    const file = writeFile('quote.csv', 'date,visitors\n"2024-01-01,3\n');
    await assert.rejects(importFile({ siteId: site.id, filePath: file }), /quote\.csv line 2: unterminated quoted field/);
  });

  it('refuses a raw file with no visitor column', async () => {
    const file = writeFile('anon.csv', 'timestamp,page\n1743494400,/\n');
    await assert.rejects(importFile({ siteId: site.id, filePath: file }), /no visitor column/);
  });

  it('refuses a CSV that is neither dated nor timestamped', async () => {
    const file = writeFile('nope.csv', 'colour,count\nred,3\n');
    await assert.rejects(importFile({ siteId: site.id, filePath: file }), /no timestamp and no date column/);
  });

  it('refuses an unknown site and an unknown source', async () => {
    const file = writeFile('daily.csv', 'date,visitors\n2024-01-01,1\n');
    await assert.rejects(importFile({ siteId: 9999, filePath: file }), /Site not found/);
    await assert.rejects(importFile({ siteId: site.id, filePath: file, source: 'ga4' }), /Unknown source "ga4"/);
  });

  it('refuses to read a ZIP as a flat CSV', async () => {
    await assert.rejects(
      importFile({ siteId: site.id, filePath: plausibleZip(), source: 'credible-csv' }),
      /is a ZIP archive, which only plausible-csv can read/,
    );
  });

  it('refuses a CSV that is not a Plausible export when told it is one', async () => {
    const file = writeFile('daily.csv', 'date,visitors\n2024-01-01,1\n');
    await assert.rejects(
      importFile({ siteId: site.id, filePath: file, source: 'plausible-csv' }),
      /does not look like a Plausible export/,
    );
  });

  it('rejects an unknown dimension in the first pass, before writing anything', async () => {
    // The dimension/value form is the one shape whose validity is only known
    // once a row is expanded — the dry run has to catch it all the same.
    const file = writeFile(
      'explicit.csv',
      'date,dimension,value,visitors\n2024-03-01,visit:country,FR,4\n2024-03-02,visit:planet,Mars,4\n',
    );
    await assert.rejects(
      importFile({ siteId: site.id, filePath: file, dryRun: true }),
      /unknown dimension "visit:planet"/,
    );
    await assert.rejects(importFile({ siteId: site.id, filePath: file }), /unknown dimension "visit:planet"/);
    assert.equal(all('SELECT * FROM imported_stats').length, 0);
    assert.equal(listImports(site.id).length, 0);
  });

  it('accepts the dimension/value form when the keys are known', async () => {
    const file = writeFile(
      'explicit-ok.csv',
      'date,dimension,value,visitors,pageviews\n2024-03-01,visit:country,FR,4,9\n2024-03-01,,,4,9\n',
    );
    const record = await importFile({ siteId: site.id, filePath: file });
    assert.equal(record.aggregates_written, 2);
    assert.equal(importedTotals(site.id, '2024-03-01', '2024-03-01').visitors, 4);
    assert.deepEqual(
      importedBreakdown(site.id, 'visit:country', '2024-03-01', '2024-03-01').map((r) => r.name),
      ['FR'],
    );
  });

  it('leaves earlier imports untouched when a later one is refused', async () => {
    const rows = ['date,visitors'];
    for (let i = 1; i <= 20; i += 1) rows.push(`2024-06-${String(i).padStart(2, '0')},${i}`);
    await importFile({ siteId: site.id, filePath: writeFile('first.csv', `${rows.join('\n')}\n`) });

    const before = all('SELECT * FROM imported_stats').length;
    assert.equal(before, 20);
    await assert.rejects(
      importFile({ siteId: site.id, filePath: writeFile('again.csv', `${rows.join('\n')}\n`) }),
      /overlaps import/,
    );
    assert.equal(all('SELECT * FROM imported_stats').length, before);
    assert.equal(listImports(site.id).length, 1);
  });

  it('lets a crashed import be cleaned up like any other', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const [record] = listImports(site.id);
    // What a process killed mid-write leaves behind.
    all("UPDATE imports SET status = 'running', finished_at = NULL WHERE id = ?", [record.id]);

    const removed = deleteImport(site.id, record.id);
    assert.ok(removed.aggregates_removed > 0);
    assert.equal(all('SELECT * FROM imported_stats').length, 0);
    assert.equal(listImports(site.id).length, 0);
  });
});

// ============================================================== overlapping =

describe('overlapping ranges', () => {
  it('refuses a second import over the same days and says which', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const [first] = listImports(site.id);

    const overlapping = writeFile('overlap.csv', 'date,visitors\n2023-02-10,5\n2023-02-14,6\n');
    await assert.rejects(
      importFile({ siteId: site.id, filePath: overlapping }),
      new RegExp(`overlaps import #${first.id} \\(plausible-csv, 2023-02-09 → 2023-02-10\\)`),
    );
    assert.equal(listImports(site.id).length, 1);
  });

  it('allows an adjacent range', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const next = writeFile('next.csv', 'date,visitors\n2023-02-11,5\n2023-02-12,6\n');
    const record = await importFile({ siteId: site.id, filePath: next });
    assert.equal(record.status, 'complete');
    assert.equal(listImports(site.id).length, 2);
  });

  it('ignores a failed import when checking overlap', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const [first] = listImports(site.id);
    get('SELECT 1'); // keep the handle warm
    all("UPDATE imports SET status = 'failed' WHERE id = ?", [first.id]);
    const again = writeFile('again.csv', 'date,visitors\n2023-02-09,5\n');
    const record = await importFile({ siteId: site.id, filePath: again });
    assert.equal(record.status, 'complete');
  });

  it('lets an import be re-run after it is deleted', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    deleteImport(site.id, listImports(site.id)[0].id);
    const record = await importFile({ siteId: site.id, filePath: plausibleZip() });
    assert.equal(record.status, 'complete');
  });
});

// ============================================================= deleteImport =

describe('deleteImport', () => {
  it('removes exactly its own aggregate rows', async () => {
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const keep = writeFile('keep.csv', 'date,visitors,pageviews\n2024-01-01,50,90\n');
    await importFile({ siteId: site.id, filePath: keep });

    const [second, first] = listImports(site.id);
    assert.equal(first.source, 'plausible-csv');
    const removed = deleteImport(site.id, first.id);

    assert.equal(removed.events_removed, 0);
    assert.ok(removed.aggregates_removed > 0);
    assert.equal(importedTotals(site.id, '2023-02-09', '2023-02-10').visitors, 0);
    assert.equal(importedTotals(site.id, '2024-01-01', '2024-01-01').visitors, 50);
    assert.deepEqual(
      all('SELECT DISTINCT import_id FROM imported_stats').map((r) => r.import_id),
      [second.id],
    );
    assert.deepEqual(listImports(site.id).map((r) => r.id), [second.id]);
  });

  it('removes its events and repairs the visits, leaving live traffic alone', async () => {
    const T = utc(2025, 7, 1, 12, 0, 0);
    // Live traffic that must survive untouched.
    track({ path: '/live' }, { timestamp: T, visitorId: 'live-1' });
    track({ path: '/live/2' }, { timestamp: T + 60, visitorId: 'live-1' });
    const liveVisits = visits();
    const liveEvents = events();

    const file = writeFile(
      'raw.csv',
      'timestamp,visitor_id,page\n' +
        `${T - 86400},imported-1,/a\n${T - 86400 + 60},imported-1,/b\n${T - 86400 + 120},imported-2,/c\n`,
    );
    const record = await importFile({ siteId: site.id, filePath: file });
    assert.equal(record.events_written, 3);
    assert.equal(events().length, 5);
    assert.equal(visits().length, 3); // one live, two imported

    const removed = deleteImport(site.id, record.id);
    assert.equal(removed.events_removed, 3);
    assert.equal(removed.visits_removed, 2);
    assert.deepEqual(events(), liveEvents);
    assert.deepEqual(visits(), liveVisits);
    assert.equal(listImports(site.id).length, 0);
    assert.equal(all('SELECT * FROM import_event_ranges').length, 0);
  });

  it('records one contiguous id range for an uninterrupted import', async () => {
    const file = writeFile(
      'raw.csv',
      'timestamp,visitor_id,page\n1743494400,v1,/a\n1743494460,v1,/b\n1743494520,v2,/c\n',
    );
    const record = await importFile({ siteId: site.id, filePath: file });
    const ranges = all('SELECT first_id, last_id FROM import_event_ranges WHERE import_id = ?', [record.id]);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].last_id - ranges[0].first_id, 2);
  });

  it('rejects an import id that belongs to another site', async () => {
    const other = createSite({ domain: 'other.test', timezone: 'UTC', currency: 'EUR' });
    await importFile({ siteId: site.id, filePath: plausibleZip() });
    const [record] = listImports(site.id);
    assert.throws(() => deleteImport(other.id, record.id), /No import #/);
    assert.equal(listImports(site.id).length, 1);
  });
});
