/**
 * HTTP server: a tiny router, a static file handler, and the error boundary.
 * Route handlers live in src/routes.js.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from './config.js';
import { getDb } from './db/index.js';
import { initGeo } from './ingest/geo.js';
import { purgeExpiredSessions } from './auth/index.js';
import { purgeOldSalts } from './ingest/salt.js';
import { enforceRetention } from './ingest/index.js';
import { HttpError, corsHeaders, securityHeaders, sendJson, sendText } from './util/http.js';
import { log } from './util/log.js';
import { registerRoutes } from './routes.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const routes = [];

/** Register a route. `pattern` may contain :params, e.g. '/api/sites/:domain'. */
export function route(method, pattern, handler) {
  const segments = pattern.split('/').filter(Boolean);
  routes.push({ method, pattern, segments, handler, wildcard: pattern.endsWith('/*') });
}

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== method && candidate.method !== 'ALL') continue;
    const { segments } = candidate;
    const wildcard = segments[segments.length - 1] === '*';
    if (!wildcard && segments.length !== parts.length) continue;
    if (wildcard && parts.length < segments.length - 1) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment === '*') {
        params.rest = parts.slice(i).join('/');
        break;
      }
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } else if (segment !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: candidate.handler, params };
  }
  return null;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve a file from public/. Returns false when there is nothing to serve. */
export function serveStatic(req, res, relativePath) {
  const clean = relativePath.replace(/\.\.+/g, '').replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, clean);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const ext = path.extname(filePath);
  const isTracker = clean.startsWith('js/') && /^(cr|script)(\.|$)/.test(path.basename(clean));

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'content-length': stat.size,
    etag,
    // The tracker is cached hard (it changes rarely and is fetched by every
    // visitor); dashboard assets revalidate with their ETag so an upgraded
    // instance never serves a half-stale UI.
    'cache-control': config.dev
      ? 'no-store'
      : isTracker
        ? 'public, max-age=86400, must-revalidate'
        : 'no-cache',
    ...(isTracker ? { 'access-control-allow-origin': '*' } : {}),
    ...securityHeaders,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function sendHtml(res, name) {
  const filePath = path.join(PUBLIC_DIR, name);
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-cache',
    ...securityHeaders,
  });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams.entries());

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders(req), 'content-length': 0 });
    res.end();
    return;
  }

  const found = match(req.method, url.pathname);
  if (found) {
    await found.handler({ req, res, params: found.params, query, url });
    return;
  }

  // Static assets, then the SPA shell for everything else.
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (serveStatic(req, res, url.pathname)) return;
    if (!url.pathname.startsWith('/api/')) {
      sendHtml(res, 'index.html');
      return;
    }
  }

  throw new HttpError(404, 'Not found');
}

export function createServer() {
  getDb();
  initGeo();
  registerRoutes();

  return http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (config.logLevel === 'debug') {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        log.debug(`${req.method} ${req.url} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    });

    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
          return;
        }
        log.error(`Unhandled error on ${req.method} ${req.url}:`, err);
        sendJson(res, 500, { error: 'Internal server error' });
      });
  });
}

/** Periodic housekeeping: expired sessions, old salts, retention. */
export function startMaintenance() {
  const run = () => {
    try {
      purgeExpiredSessions();
      purgeOldSalts();
      enforceRetention();
    } catch (err) {
      log.error('Maintenance failed:', err);
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

export async function serve() {
  const server = createServer();
  startMaintenance();
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  return server;
}

export { PUBLIC_DIR, ROOT, sendText };
