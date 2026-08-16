/**
 * Datacenter and cloud-provider IP ranges.
 *
 * A crawler that sends a normal Chrome User-Agent is invisible to the string
 * matching in bots.js, but it still has to run somewhere — and almost all of
 * them run on rented compute. Checking the client address against the address
 * space AWS, Azure, Google Cloud, Cloudflare, DigitalOcean, Linode, Hetzner,
 * OVH, Scaleway and Oracle Cloud publish catches that traffic without looking
 * at the request at all.
 *
 * A datacenter address is evidence, never a verdict. Corporate VPN egress,
 * secure web gateways (Zscaler, Netskope), Cloudflare WARP and a few mobile
 * carriers all put real people behind cloud ranges, and a site sitting behind
 * Cloudflare sees *every* visitor arrive from a Cloudflare address whenever
 * CREDIBLE_TRUST_PROXY is off. Weighing that is classifyTraffic()'s job in
 * bots.js; this module only answers the factual question "does this address
 * belong to a hosting provider".
 *
 * Like the geo database, the address is read from memory and never stored.
 *
 * DATA FILE — data-files/datacenter-ranges.json, generated and committed by
 * tools/build-datacenter-ranges.js. Ranges arrive already sorted and merged,
 * delta encoded as two flat token strings so the whole set decodes in a few
 * milliseconds without allocating one object per range:
 *
 *   v4  base-36 tokens, alternating `gap` and `span`, comma separated.
 *       gap  = start - previousEnd - 1   (previousEnd starts at -1)
 *       span = end - start
 *   v6  the same layout in base 16.
 *
 * The two radices differ on purpose. IPv4 bounds are plain Numbers, so base 36
 * is both the densest native `toString` radix and trivial to scan back by hand.
 * IPv6 bounds are BigInts, and BigInt has no radix-36 parser — hex lets the
 * decoder hand each token to the native `BigInt('0x…')` instead of running
 * 128-bit multiply-accumulate over every digit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The committed data file. Regenerate with tools/build-datacenter-ranges.js. */
const DEFAULT_FILE = path.resolve(here, '..', '..', 'data-files', 'datacenter-ranges.json');

const COMMA = 44;

/** { v4: {starts: Uint32Array, ends: Uint32Array}, v6: {starts: BigInt[], ends: BigInt[]} } */
let ranges = null;

// Set by the first loadRanges() call, successful or not. A failed *explicit*
// load must not silently fall back to the bundled file: an operator who pointed
// us at their own copy needs to see that it did not work.
let loadAttempted = false;

/* ------------------------------------------------------------------ *
 * Address parsing                                                     *
 * ------------------------------------------------------------------ */

/**
 * Strict dotted-quad parser. Rejects leading zeros, because `010.1.1.1` means
 * different things to different resolvers and we would rather look nothing up
 * than look the wrong address up.
 *
 * @param {string} text
 * @returns {number|null} Unsigned 32-bit value, or null when not an IPv4 literal.
 */
export function ipv4ToNumber(text) {
  if (typeof text !== 'string' || text.length < 7 || text.length > 15) return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (part.length > 1 && part.charCodeAt(0) === 48) return null;
    let octet = 0;
    for (let i = 0; i < part.length; i += 1) {
      const digit = part.charCodeAt(i) - 48;
      if (digit < 0 || digit > 9) return null;
      octet = octet * 10 + digit;
    }
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** One 1-4 digit hex group, or -1 when the text is not one. */
function hexGroup(text) {
  if (text.length === 0 || text.length > 4) return -1;
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const digit =
      code >= 48 && code <= 57 ? code - 48
        : code >= 97 && code <= 102 ? code - 87
          : code >= 65 && code <= 70 ? code - 55
            : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

/**
 * Parse an IPv6 literal, including the `::ffff:203.0.113.9` form node:http
 * hands us for IPv4 clients on a dual-stack socket.
 *
 * @param {string} text
 * @returns {bigint|null} 128-bit value, or null when not an IPv6 literal.
 */
export function ipv6ToBigInt(text) {
  if (typeof text !== 'string' || text.length < 2 || text.length > 45) return null;

  let body = text;
  if (body.indexOf('.') !== -1) {
    // Rewrite the dotted tail as the two hex groups it stands for.
    const cut = body.lastIndexOf(':');
    if (cut === -1) return null;
    const embedded = ipv4ToNumber(body.slice(cut + 1));
    if (embedded === null) return null;
    body = `${body.slice(0, cut + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  const halves = body.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  // Without '::' every group must be spelled out; with it, '::' has to stand
  // for at least one omitted group.
  if (tail === null && head.length !== 8) return null;
  if (tail !== null && head.length + tail.length > 7) return null;

  let value = 0n;
  for (const group of head) {
    const word = hexGroup(group);
    if (word < 0) return null;
    value = (value << 16n) | BigInt(word);
  }
  if (tail !== null) {
    value <<= BigInt(16 * (8 - head.length - tail.length));
    for (const group of tail) {
      const word = hexGroup(group);
      if (word < 0) return null;
      value = (value << 16n) | BigInt(word);
    }
  }
  return value;
}

/** Drop the `[…]` brackets and the `%eth0` zone id a socket address may carry. */
function cleanAddress(ip) {
  if (typeof ip !== 'string') return '';
  let text = ip.trim();
  if (text.charCodeAt(0) === 91) {
    const close = text.indexOf(']');
    if (close === -1) return '';
    text = text.slice(1, close);
  }
  const zone = text.indexOf('%');
  return zone === -1 ? text : text.slice(0, zone);
}

/* ------------------------------------------------------------------ *
 * Data file decoding                                                  *
 * ------------------------------------------------------------------ */

/**
 * Decode the IPv4 token string into two parallel Uint32Arrays.
 *
 * The scan walks character codes and never cuts a substring: at ~50k tokens
 * that is the difference between a handful of milliseconds and a garbage
 * collection pause on the first request that needs the data.
 *
 * @param {string} text
 * @param {number} count Expected number of ranges, used to size and verify.
 * @returns {{starts: Uint32Array, ends: Uint32Array}|null}
 */
function decodeNumberRanges(text, count) {
  const starts = new Uint32Array(count);
  const ends = new Uint32Array(count);
  if (count === 0) return text.length === 0 ? { starts, ends } : null;

  let index = 0;
  let expectSpan = false;
  let value = 0;
  let start = 0;
  let previousEnd = -1;

  for (let i = 0, n = text.length; i <= n; i += 1) {
    const code = i < n ? text.charCodeAt(i) : COMMA;
    if (code !== COMMA) {
      const digit = code <= 57 ? code - 48 : code - 87;
      if (digit < 0 || digit > 35) return null;
      value = value * 36 + digit;
      continue;
    }
    if (!expectSpan) {
      start = previousEnd + 1 + value;
      expectSpan = true;
    } else {
      if (index >= count) return null;
      previousEnd = start + value;
      starts[index] = start;
      ends[index] = previousEnd;
      index += 1;
      expectSpan = false;
    }
    value = 0;
  }

  return index === count && !expectSpan ? { starts, ends } : null;
}

/**
 * Decode the IPv6 token string into two parallel BigInt arrays.
 *
 * @param {string} text
 * @param {number} count
 * @returns {{starts: bigint[], ends: bigint[]}|null}
 */
function decodeBigRanges(text, count) {
  const starts = new Array(count);
  const ends = new Array(count);
  if (count === 0) return text.length === 0 ? { starts, ends } : null;

  let index = 0;
  let expectSpan = false;
  let from = 0;
  let start = 0n;
  let previousEnd = -1n;

  for (let i = 0, n = text.length; i <= n; i += 1) {
    if (i < n && text.charCodeAt(i) !== COMMA) continue;
    const token = text.slice(from, i);
    from = i + 1;
    if (!token) return null;

    let value;
    try {
      value = BigInt(`0x${token}`);
    } catch {
      return null;
    }

    if (!expectSpan) {
      start = previousEnd + 1n + value;
      expectSpan = true;
    } else {
      if (index >= count) return null;
      previousEnd = start + value;
      starts[index] = start;
      ends[index] = previousEnd;
      index += 1;
      expectSpan = false;
    }
  }

  return index === count && !expectSpan ? { starts, ends } : null;
}

/**
 * Validate a declared range count against the text that has to justify it.
 *
 * Both decoders size their arrays from `counts` before reading a single token,
 * so an untrustworthy count is an allocation primitive: `new Uint32Array(4e9)`
 * reserves 16 GB from a ninety-byte file, and `new Uint32Array(-1)` throws
 * RangeError straight out of loadRanges() — which, because ensureLoaded() runs
 * lazily, means out of the first isDatacenterIp() call rather than at boot.
 *
 * The honest ceiling is in the payload itself: a range costs at least `g,s`
 * plus a separator, so four characters, less the separator the last one does
 * not need. A file can therefore never ask for more memory than it brought
 * data for, and anything truncated or hand-edited fails the load cleanly.
 *
 * @param {unknown} value Count as it appears in the file.
 * @param {string} text The token string it describes.
 * @returns {number} The count, or -1 when it is not credible.
 */
function declaredCount(value, text) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return -1;
  return count <= Math.floor((text.length + 1) / 4) ? count : -1;
}

/* ------------------------------------------------------------------ *
 * Lookup                                                              *
 * ------------------------------------------------------------------ */

/** Binary search over sorted, non-overlapping [start, end] pairs. */
function contains(table, value) {
  const { starts, ends } = table;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value < starts[mid]) hi = mid - 1;
    else if (value > ends[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Load the merged range file.
 *
 * @param {string} [filePath] Defaults to the committed data-files/ copy.
 * @returns {boolean} False when the file is missing or does not decode; the
 *   previously loaded set is dropped either way, so a bad file never leaves
 *   stale ranges behind pretending to be current.
 */
export function loadRanges(filePath = DEFAULT_FILE) {
  loadAttempted = true;
  ranges = null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.counts) return false;

  const v4Text = String(parsed.v4 ?? '');
  const v6Text = String(parsed.v6 ?? '');
  const v4Count = declaredCount(parsed.counts.v4, v4Text);
  const v6Count = declaredCount(parsed.counts.v6, v6Text);
  if (v4Count < 0 || v6Count < 0) return false;

  const v4 = decodeNumberRanges(v4Text, v4Count);
  const v6 = decodeBigRanges(v6Text, v6Count);
  if (!v4 || !v6) return false;

  ranges = { v4, v6 };
  return true;
}

/**
 * Load the bundled file the first time anything asks a question, so the module
 * is correct even if boot forgot to call loadRanges(). Calling it at boot only
 * moves the cost off the first request.
 */
function ensureLoaded() {
  if (ranges) return true;
  if (loadAttempted) return false;
  return loadRanges();
}

/**
 * True when the address belongs to a published cloud or hosting range.
 * Anything unparseable — '', null, '10.0.0.999', a hostname — is false: we only
 * ever report what we can prove.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isDatacenterIp(ip) {
  const text = cleanAddress(ip);
  if (!text) return false;
  if (!ensureLoaded()) return false;

  if (text.indexOf(':') === -1) {
    const value = ipv4ToNumber(text);
    return value === null ? false : contains(ranges.v4, value);
  }

  const value = ipv6ToBigInt(text);
  if (value === null) return false;
  // ::ffff:a.b.c.d is an IPv4 client on a dual-stack socket, not IPv6 space.
  if ((value >> 32n) === 0xffffn) return contains(ranges.v4, Number(value & 0xffffffffn));
  return contains(ranges.v6, value);
}

/**
 * How many merged ranges are loaded, for the dashboard and `credible doctor`.
 * Zeroes mean the data file is missing or unreadable.
 *
 * @returns {{v4: number, v6: number}}
 */
export function rangeCount() {
  ensureLoaded();
  return {
    v4: ranges ? ranges.v4.starts.length : 0,
    v6: ranges ? ranges.v6.starts.length : 0,
  };
}
