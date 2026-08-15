/**
 * Small helpers over node:http — request parsing, responses, cookies.
 */
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

const MAX_BODY = 64 * 1024;

/** Read and JSON-parse a request body (64 KB cap). Returns {} when empty. */
export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(badRequest('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Read a urlencoded form body into a plain object. */
export function readForm(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      resolve(Object.fromEntries(params.entries()));
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendNoContent(res, headers = {}) {
  res.writeHead(202, { 'content-length': 0, ...headers });
  res.end();
}

export function redirect(res, location) {
  res.writeHead(302, { location, 'content-length': 0 });
  res.end();
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${new Date(opts.expires * 1000).toUTCString()}`);
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure ?? config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function appendHeader(res, name, value) {
  const existing = res.getHeader(name);
  if (!existing) res.setHeader(name, value);
  else if (Array.isArray(existing)) res.setHeader(name, [...existing, value]);
  else res.setHeader(name, [existing, value]);
}

/**
 * Best-effort client IP. Only trusts proxy headers when CREDIBLE_TRUST_PROXY
 * is set, otherwise a spoofed header could poison visitor hashing.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

/** Permissive CORS: the tracker posts from arbitrary customer domains. */
export function corsHeaders(req) {
  return {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
};

/** Fixed-window in-memory rate limiter (per key, per minute). */
export function createRateLimiter(limitPerMinute) {
  const hits = new Map();
  let windowStart = Math.floor(Date.now() / 60000);
  return function take(key) {
    if (!limitPerMinute) return true;
    const currentWindow = Math.floor(Date.now() / 60000);
    if (currentWindow !== windowStart) {
      hits.clear();
      windowStart = currentWindow;
    }
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    return count <= limitPerMinute;
  };
}
