/**
 * Coarse geography.
 *
 * Two sources, in order:
 *  1. Edge headers set by the CDN/proxy in front of Credible (Cloudflare,
 *     Vercel, Fly, Netlify, CloudFront...). Free, exact, zero maintenance.
 *  2. An optional IP→country CSV (DB-IP Lite or IP2Location Lite, both free)
 *     loaded into typed arrays and binary searched. Enable with
 *     CREDIBLE_GEO_DB=/path/to/dbip-country-lite.csv[.gz]
 *
 * The IP itself is never written to the database — it only ever exists in
 * memory for the duration of the request.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { config } from '../config.js';

let ranges = null; // { starts: Uint32Array, ends: Uint32Array, codes: string[] }

const clean = (value, max = 60) => String(value || '').trim().slice(0, max);

export function ipToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** Load a `start_ip,end_ip,country` CSV (DB-IP Lite / IP2Location Lite format). */
export function loadGeoDatabase(filePath = config.geoDbPath) {
  if (!filePath) return false;
  if (!fs.existsSync(filePath)) return false;
  let raw = fs.readFileSync(filePath);
  if (filePath.endsWith('.gz')) raw = zlib.gunzipSync(raw);

  const starts = [];
  const ends = [];
  const codes = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const cells = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    if (cells.length < 3) continue;
    const [from, to, code] = cells;
    // IP2Location Lite stores integers, DB-IP stores dotted quads.
    const start = /^\d+$/.test(from) ? Number(from) : ipToInt(from);
    const end = /^\d+$/.test(to) ? Number(to) : ipToInt(to);
    if (start == null || end == null || !/^[A-Za-z]{2}$/.test(code)) continue;
    starts.push(start);
    ends.push(end);
    codes.push(code.toUpperCase());
  }
  if (!starts.length) return false;
  ranges = { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), codes };
  return true;
}

export function lookupCountry(ip) {
  if (!ranges) return '';
  const value = ipToInt(ip);
  if (value == null) return '';
  let lo = 0;
  let hi = ranges.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value < ranges.starts[mid]) hi = mid - 1;
    else if (value > ranges.ends[mid]) lo = mid + 1;
    else return ranges.codes[mid];
  }
  return '';
}

/**
 * Resolve {country_code, region, city} for a request.
 * Returns empty strings rather than guessing.
 */
export function resolveGeo(ip, headers = {}) {
  const h = (name) => clean(headers[name]);

  const country =
    h('cf-ipcountry') ||
    h('x-vercel-ip-country') ||
    h('x-nf-client-connection-country') ||
    h('cloudfront-viewer-country') ||
    h('x-geo-country') ||
    h('x-country-code') ||
    h('fastly-geo-country') ||
    lookupCountry(ip);

  const region =
    h('x-vercel-ip-country-region') ||
    h('cloudfront-viewer-country-region-name') ||
    h('x-geo-region') ||
    h('cf-region');

  const city =
    decodeHeader(h('x-vercel-ip-city')) ||
    h('cloudfront-viewer-city') ||
    h('x-geo-city') ||
    h('cf-ipcity');

  const code = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '';
  if (code === 'XX' || code === 'T1') return { country_code: '', region: '', city: '' }; // Tor / unknown
  return { country_code: code, region: clean(region), city: clean(city) };
}

function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function geoDatabaseLoaded() {
  return Boolean(ranges);
}

/** Called once at boot. */
export function initGeo() {
  if (!config.geoDbPath) return false;
  const ok = loadGeoDatabase(config.geoDbPath);
  return ok;
}
