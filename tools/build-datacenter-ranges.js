#!/usr/bin/env node
/**
 * Credible — datacenter IP range builder.
 *
 * Downloads the address ranges the major clouds and hosting companies publish,
 * merges them into one sorted, non-overlapping set and writes the compact data
 * file that src/ingest/datacenters.js loads at boot. The result is committed:
 * a self-hosted instance must work with no network access and no cron job, and
 * cloud allocations move slowly enough that a refresh every few months is
 * plenty.
 *
 * Everything is Node built-ins: node:https for the downloads, node:zlib for the
 * one source that only ships gzip, and the address parsers exported by
 * src/ingest/datacenters.js — shared on purpose, so the ranges written here can
 * never disagree with the ranges matched at runtime.
 *
 * Usage:
 *   node tools/build-datacenter-ranges.js
 *   node tools/build-datacenter-ranges.js --out other.json
 *   node tools/build-datacenter-ranges.js --max-bytes 2097152
 *   node tools/build-datacenter-ranges.js --allow-partial   # ship what downloaded
 *   node tools/build-datacenter-ranges.js --only aws,azure  # a subset, for debugging
 *
 * By default a single failed source aborts the build without touching the data
 * file. Silently shipping a file with Azure missing would look like a working
 * build and quietly halve the detection rate, which is worse than no build.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { get } from 'node:https';
import zlib from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ipv4ToNumber, ipv6ToBigInt, loadRanges, rangeCount, isDatacenterIp } from '../src/ingest/datacenters.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'data-files', 'datacenter-ranges.json');

/** Hard ceiling for the committed file. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Hard ceiling for a single download, on the wire and after inflating.
 *
 * Every URL below is a vendor endpoint reached over TLS, but "we trust the
 * publisher" is not a size limit: a hung CDN that never sends its last chunk,
 * or a gzip stream that expands far past what it claims, would otherwise be
 * accumulated until the build host runs out of memory. Azure's service tag
 * file is the largest real source at roughly 35 MB, so 256 MB is several times
 * the headroom any of these need and still a bound.
 */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const USER_AGENT = 'credible-build-datacenter-ranges (+https://github.com/maixmeduret/credible)';

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch a URL over HTTPS, following redirects and inflating gzip.
 *
 * @param {string} url
 * @param {number} [redirects] Remaining redirect budget.
 * @returns {Promise<string>}
 */
function fetchOnce(url, redirects = 5) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = get(
      url,
      { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, identity' } },
      (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirects === 0) {
            rejectPromise(new Error(`Too many redirects for ${url}`));
            return;
          }
          resolvePromise(fetchOnce(new URL(headers.location, url).href, redirects - 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          rejectPromise(new Error(`HTTP ${statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            response.destroy();
            rejectPromise(new Error(`${url} exceeded ${MAX_DOWNLOAD_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', rejectPromise);
        response.on('end', () => {
          let body = Buffer.concat(chunks);
          const encoding = String(headers['content-encoding'] || '').toLowerCase();
          // maxOutputLength caps the *inflated* size too, so a small response
          // that expands without bound fails here instead of on the heap.
          const limit = { maxOutputLength: MAX_DOWNLOAD_BYTES };
          try {
            if (encoding === 'gzip') body = zlib.gunzipSync(body, limit);
            else if (encoding === 'deflate') body = zlib.inflateSync(body, limit);
          } catch (error) {
            rejectPromise(new Error(`Cannot decompress ${url}: ${error.message}`));
            return;
          }
          resolvePromise(body.toString('utf8'));
        });
      },
    );

    request.on('error', rejectPromise);
    request.setTimeout(120_000, () => request.destroy(new Error(`Timeout for ${url}`)));
  });
}

/** Fetch with two retries: these are big files from busy CDNs. */
async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 2000));
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** Pull the `prefix` field out of a RIPEstat announced-prefixes response. */
async function ripeStatPrefixes(asns) {
  const cidrs = [];
  const sources = [];
  for (const asn of asns) {
    const url = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=${asn}`;
    const payload = JSON.parse(await fetchText(url));
    if (payload.status !== 'ok' || !payload.data || !Array.isArray(payload.data.prefixes)) {
      throw new Error(`RIPEstat returned no prefixes for ${asn}`);
    }
    for (const entry of payload.data.prefixes) cidrs.push(entry.prefix);
    sources.push(url);
  }
  return { cidrs, sources };
}

/** RFC 8805 geofeed / plain CSV: the first column is the prefix. */
function parseGeofeed(text) {
  const cidrs = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    cidrs.push(trimmed.split(',')[0].trim());
  }
  return cidrs;
}

/**
 * The providers, in descending order of value to bot detection.
 *
 * `priority` is only consulted when the merged file busts the size budget: the
 * highest number is dropped first. Cloudflare is last on purpose. Its published
 * list is the address space of its *reverse proxies* and of WARP, so it is the
 * one source that routinely fronts real human visitors — the least useful set
 * to keep and the most expensive one to get wrong.
 *
 * Hetzner, OVH and Scaleway publish no machine-readable range file at all. The
 * public record of what they route is BGP, so their prefixes come from RIPE
 * NCC's RIPEstat API, keyed by the ASNs each company registers.
 */
const PROVIDERS = [
  {
    id: 'aws',
    name: 'Amazon Web Services',
    priority: 1,
    async collect() {
      const url = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
      const data = JSON.parse(await fetchText(url));
      const cidrs = [
        ...data.prefixes.map((entry) => entry.ip_prefix),
        ...data.ipv6_prefixes.map((entry) => entry.ipv6_prefix),
      ];
      return { cidrs, sources: [url] };
    },
  },
  {
    id: 'azure',
    name: 'Microsoft Azure',
    priority: 1,
    async collect() {
      // Microsoft stamps the date into the ServiceTags_Public filename and
      // republishes weekly, so the download URL has to be read off the
      // (stable) details page rather than hard-coded.
      const page = 'https://www.microsoft.com/en-us/download/details.aspx?id=56519';
      const html = await fetchText(page);
      const found = html.match(/https:\/\/download\.microsoft\.com\/download\/[^"'\s\\]+ServiceTags_Public_\d+\.json/gi);
      if (!found || found.length === 0) {
        throw new Error(`No ServiceTags_Public URL found on ${page} — Microsoft changed the page layout`);
      }
      // Several copies of the same link; the newest date wins.
      const url = [...new Set(found)].sort().pop();
      const data = JSON.parse(await fetchText(url));
      const cidrs = [];
      for (const tag of data.values) {
        for (const prefix of tag.properties.addressPrefixes || []) cidrs.push(prefix);
      }
      return { cidrs, sources: [url] };
    },
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    priority: 1,
    async collect() {
      // cloud.json is Google Cloud customer space. The wider goog.json also
      // covers Google's consumer services, whose addresses front real people.
      const url = 'https://www.gstatic.com/ipranges/cloud.json';
      const data = JSON.parse(await fetchText(url));
      const cidrs = data.prefixes.map((entry) => entry.ipv4Prefix || entry.ipv6Prefix).filter(Boolean);
      return { cidrs, sources: [url] };
    },
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    priority: 2,
    async collect() {
      const url = 'https://www.digitalocean.com/geo/google.csv';
      return { cidrs: parseGeofeed(await fetchText(url)), sources: [url] };
    },
  },
  {
    id: 'linode',
    name: 'Akamai / Linode',
    priority: 2,
    async collect() {
      const url = 'https://geoip.linode.com/';
      return { cidrs: parseGeofeed(await fetchText(url)), sources: [url] };
    },
  },
  {
    id: 'hetzner',
    name: 'Hetzner Online',
    priority: 2,
    collect: () => ripeStatPrefixes(['AS24940', 'AS213230', 'AS212317']),
  },
  {
    id: 'ovh',
    name: 'OVHcloud',
    priority: 2,
    collect: () => ripeStatPrefixes(['AS16276']),
  },
  {
    id: 'oracle',
    name: 'Oracle Cloud Infrastructure',
    priority: 3,
    async collect() {
      const url = 'https://docs.oracle.com/iaas/tools/public_ip_ranges.json';
      const data = JSON.parse(await fetchText(url));
      const cidrs = [];
      for (const region of data.regions) {
        for (const entry of region.cidrs) cidrs.push(entry.cidr);
      }
      return { cidrs, sources: [url] };
    },
  },
  {
    id: 'scaleway',
    name: 'Scaleway',
    priority: 3,
    collect: () => ripeStatPrefixes(['AS12876']),
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    priority: 4,
    async collect() {
      const urls = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];
      const cidrs = [];
      for (const url of urls) {
        for (const line of (await fetchText(url)).split('\n')) {
          const trimmed = line.trim();
          if (trimmed) cidrs.push(trimmed);
        }
      }
      return { cidrs, sources: urls };
    },
  },
];

/* ------------------------------------------------------------------ */
/* CIDR handling                                                       */
/* ------------------------------------------------------------------ */

/**
 * Address space that is never legitimately announced by a hosting provider.
 * One bad upstream entry covering 10.0.0.0/8 or 127.0.0.0/8 would blackhole
 * every LAN and loopback visit on a self-hosted instance, so overlapping CIDRs
 * are dropped rather than trusted.
 */
const RESERVED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
const RESERVED_V6 = ['::/8', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8'];

/**
 * Expand one CIDR into an inclusive [start, end] pair.
 *
 * @param {string} cidr
 * @returns {{family: 4|6, start: number|bigint, end: number|bigint}|null}
 */
function cidrToRange(cidr) {
  const text = String(cidr || '').trim();
  if (!text) return null;

  const slash = text.indexOf('/');
  const address = slash === -1 ? text : text.slice(0, slash);
  const bitsText = slash === -1 ? '' : text.slice(slash + 1);

  if (address.indexOf(':') === -1) {
    const base = ipv4ToNumber(address);
    if (base === null) return null;
    const bits = bitsText === '' ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const size = 2 ** (32 - bits);
    const start = Math.floor(base / size) * size; // tolerate a non-canonical prefix
    return { family: 4, start, end: start + size - 1 };
  }

  const base = ipv6ToBigInt(address);
  if (base === null) return null;
  const bits = bitsText === '' ? 128 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const hostBits = BigInt(128 - bits);
  const start = (base >> hostBits) << hostBits;
  return { family: 6, start, end: start + ((1n << hostBits) - 1n) };
}

/** Build the reserved [start, end] lists once. */
function reservedRanges(list) {
  return list.map((cidr) => {
    const range = cidrToRange(cidr);
    if (!range) throw new Error(`Bad reserved CIDR in this file: ${cidr}`);
    return range;
  });
}

const RESERVED = {
  4: reservedRanges(RESERVED_V4),
  6: reservedRanges(RESERVED_V6),
};

/** True when the range touches reserved space at all. */
function overlapsReserved(range) {
  return RESERVED[range.family].some((blocked) => range.start <= blocked.end && range.end >= blocked.start);
}

/**
 * Sort and fuse ranges. Adjacency counts: /24s handed out in a run collapse
 * into one entry, which is where most of the compression comes from.
 *
 * @param {Array<{start: number|bigint, end: number|bigint}>} input
 * @param {number|bigint} one The value 1 in the right numeric type.
 */
function mergeRanges(input, one) {
  const sorted = input.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + one) {
      if (range.end > last.end) last.end = range.end;
    } else {
      out.push({ start: range.start, end: range.end });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Delta encode merged ranges into the token string documented at the top of
 * src/ingest/datacenters.js: alternating gap and span, comma separated.
 *
 * @param {Array<{start: number|bigint, end: number|bigint}>} merged
 * @param {number|bigint} zero
 * @param {number|bigint} one
 * @param {number} radix
 */
function encodeRanges(merged, zero, one, radix) {
  const tokens = [];
  let previousEnd = zero - one;
  for (const { start, end } of merged) {
    tokens.push((start - previousEnd - one).toString(radix));
    tokens.push((end - start).toString(radix));
    previousEnd = end;
  }
  return tokens.join(',');
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Merge the collected providers and render the data file.
 *
 * @param {Array<{provider: object, ranges: Array<object>, sources: string[], counts: object}>} collected
 * @param {string[]} dropped Ids left out because of the size budget.
 */
function render(collected, dropped) {
  const v4 = [];
  const v6 = [];
  for (const { ranges } of collected) {
    for (const range of ranges) (range.family === 4 ? v4 : v6).push(range);
  }

  const merged4 = mergeRanges(v4, 1);
  const merged6 = mergeRanges(v6, 1n);

  const payload = {
    _: 'GENERATED FILE — do not edit. Rebuild with: node tools/build-datacenter-ranges.js',
    version: 1,
    generated: new Date().toISOString(),
    encoding: 'delta pairs (gap,span) — v4 base 36, v6 base 16; see src/ingest/datacenters.js',
    counts: { v4: merged4.length, v6: merged6.length },
    providers: collected.map(({ provider, sources, counts }) => ({
      id: provider.id,
      name: provider.name,
      sources,
      raw: counts,
    })),
    dropped,
    v4: encodeRanges(merged4, 0, 1, 36),
    v6: encodeRanges(merged6, 0n, 1n, 16),
  };

  return { payload, text: `${JSON.stringify(payload, null, 0)}\n`, merged4, merged6 };
}

/* ------------------------------------------------------------------ */
/* Self-verification                                                   */
/* ------------------------------------------------------------------ */

const formatV4 = (value) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');

function formatV6(value) {
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn).toString(16));
  return groups.join(':');
}

/**
 * Walk a sample of the merged set through the runtime lookup.
 *
 * Both edges of a range must match, and the addresses immediately outside it
 * must not. That second half is what proves the merge worked: adjacent ranges
 * are fused, so every surviving boundary has at least one free address beyond
 * it, and a hit there would mean the encoder and the decoder disagree about
 * where a range ends.
 */
function verifySample(merged, format, one, min, max) {
  let checked = 0;
  const step = Math.max(1, Math.floor(merged.length / 400));
  for (let i = 0; i < merged.length; i += step) {
    const { start, end } = merged[i];
    for (const value of [start, end]) {
      if (!isDatacenterIp(format(value))) throw new Error(`round trip lost ${format(value)}`);
      checked += 1;
    }
    for (const value of [start - one, end + one]) {
      if (value < min || value > max) continue;
      if (isDatacenterIp(format(value))) throw new Error(`range boundary is wrong near ${format(value)}`);
      checked += 1;
    }
  }
  return checked;
}

/** Read `--flag value` style arguments. */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    options[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = resolve(ROOT, options.out || DEFAULT_OUT);
  const maxBytes = options['max-bytes'] ? Number(options['max-bytes']) : DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`Invalid --max-bytes: ${options['max-bytes']}`);

  const wanted = options.only ? new Set(options.only.split(',').map((id) => id.trim())) : null;
  const selected = PROVIDERS.filter((provider) => !wanted || wanted.has(provider.id));
  if (selected.length === 0) throw new Error(`--only matched no provider: ${options.only}`);

  const collected = [];
  const failures = [];

  for (const provider of selected) {
    process.stderr.write(`${provider.id.padEnd(13)} fetching…\n`);
    try {
      const { cidrs, sources } = await provider.collect();
      const ranges = [];
      let malformed = 0;
      let reserved = 0;
      for (const cidr of cidrs) {
        const range = cidrToRange(cidr);
        if (!range) {
          malformed += 1;
          continue;
        }
        if (overlapsReserved(range)) {
          reserved += 1;
          continue;
        }
        ranges.push(range);
      }
      if (ranges.length === 0) throw new Error('no usable prefixes');

      const counts = {
        v4: ranges.filter((range) => range.family === 4).length,
        v6: ranges.filter((range) => range.family === 6).length,
      };
      collected.push({ provider, ranges, sources, counts });
      process.stderr.write(
        `${provider.id.padEnd(13)} ${counts.v4} IPv4 + ${counts.v6} IPv6 prefixes`
        + `${malformed ? `, ${malformed} malformed skipped` : ''}`
        + `${reserved ? `, ${reserved} in reserved space skipped` : ''}\n`,
      );
    } catch (error) {
      failures.push(`  ${provider.id}: ${error.message}`);
      process.stderr.write(`${provider.id.padEnd(13)} FAILED — ${error.message}\n`);
    }
  }

  if (failures.length > 0 && options['allow-partial'] !== 'true') {
    throw new Error(`${failures.length} source(s) failed; refusing to write a partial file:\n${failures.join('\n')}\n`
      + '  Re-run, or pass --allow-partial to ship what did download.');
  }
  if (collected.length === 0) throw new Error('every source failed');

  // Size budget: drop the least valuable providers until the file fits.
  const kept = collected.slice();
  const dropped = [];
  let built = render(kept, dropped);
  while (Buffer.byteLength(built.text, 'utf8') > maxBytes && kept.length > 1) {
    let worstIndex = 0;
    for (let i = 1; i < kept.length; i += 1) {
      if (kept[i].provider.priority >= kept[worstIndex].provider.priority) worstIndex = i;
    }
    const [removed] = kept.splice(worstIndex, 1);
    dropped.push(removed.provider.id);
    process.stderr.write(`over ${maxBytes} bytes — dropping ${removed.provider.id}\n`);
    built = render(kept, dropped);
  }

  const size = Buffer.byteLength(built.text, 'utf8');
  if (size > maxBytes) throw new Error(`Still ${size} bytes with one provider left; budget is ${maxBytes}`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, built.text, 'utf8');

  process.stderr.write(`\nWrote ${outputPath}\n`);
  process.stderr.write(`  ${built.payload.counts.v4} IPv4 ranges, ${built.payload.counts.v6} IPv6 ranges\n`);
  process.stderr.write(`  ${(size / 1024).toFixed(1)} KB of ${(maxBytes / 1024).toFixed(0)} KB budget\n`);
  if (dropped.length > 0) process.stderr.write(`  dropped for size: ${dropped.join(', ')}\n`);
  if (failures.length > 0) process.stderr.write(`  MISSING (partial build): \n${failures.join('\n')}\n`);

  // Read the file back through the runtime loader. A builder that emits
  // something the runtime cannot decode is the one bug this file must not ship.
  const start = process.hrtime.bigint();
  const ok = loadRanges(outputPath);
  const millis = Number(process.hrtime.bigint() - start) / 1e6;
  if (!ok) throw new Error('the runtime loader rejected the file we just wrote');

  const counted = rangeCount();
  if (counted.v4 !== built.payload.counts.v4 || counted.v6 !== built.payload.counts.v6) {
    throw new Error(`round trip lost ranges: wrote ${JSON.stringify(built.payload.counts)}, read ${JSON.stringify(counted)}`);
  }

  const checked =
    verifySample(built.merged4, formatV4, 1, 0, 0xffffffff)
    + verifySample(built.merged6, formatV6, 1n, 0n, (1n << 128n) - 1n);
  process.stderr.write(`  verified ${checked} boundary addresses, loaded in ${millis.toFixed(1)} ms\n`);
}

main().catch((error) => {
  process.stderr.write(`build-datacenter-ranges failed: ${error.message}\n`);
  process.exitCode = 1;
});
