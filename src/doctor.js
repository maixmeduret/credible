/**
 * `credible doctor` — check an instance is actually usable, and say what to fix.
 *
 * Self-hosting fails in a small number of predictable ways, and every one of
 * them produces the same useless symptom: "the dashboard says zero visitors".
 * This module turns each of them into a named check with a fix attached, so a
 * human or an assistant can act without guessing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ok = (id, label, detail = '') => ({ id, label, status: 'ok', detail, fix: '' });
const warn = (id, label, detail, fix) => ({ id, label, status: 'warn', detail, fix });
const fail = (id, label, detail, fix) => ({ id, label, status: 'fail', detail, fix });
const skip = (id, label, detail) => ({ id, label, status: 'skip', detail, fix: '' });

async function fetchWithTimeout(url, options = {}, ms = 6000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

/**
 * Is the URL being diagnosed the instance this shell is configured for?
 *
 * Matched on the configured public URL when there is one, otherwise on the
 * port, which is the only thing a local instance and this process share.
 */
function sameInstance(origin) {
  if (config.baseUrl && origin.startsWith(config.baseUrl)) return true;
  try {
    const { port, hostname } = new URL(origin);
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
    return isLoopback && Number(port || 80) === Number(config.port);
  } catch {
    return false;
  }
}

/**
 * @param {object} input
 * @param {string} input.url        instance origin to test, e.g. https://stats.example
 * @param {string} [input.domain]   a tracked domain to check for incoming data
 * @param {string} [input.apiKey]   used for the per-site checks
 * @param {string} [input.siteUrl]  the public URL of the site being measured
 * @param {boolean} [input.local]   also inspect this machine's config and database
 * @returns {Promise<{checks: Array, summary: {ok:number,warn:number,fail:number}, healthy: boolean}>}
 */
export async function diagnose({ url, domain = '', apiKey = '', siteUrl = '', local = true } = {}) {
  const checks = [];
  const origin = String(url || '').replace(/\/+$/, '');

  // ----------------------------------------------------------- this host --
  // Only when the instance being diagnosed IS this machine's configuration.
  // Reading our own env while claiming to describe a remote instance produced
  // confidently wrong output — "CREDIBLE_BASE_URL is unset" about a server that
  // was started with it — and sent a tester off to re-check a correct setup.
  const describesThisShell = !origin || sameInstance(origin);
  if (local && describesThisShell) {
    const major = Number(process.versions.node.split('.')[0]);
    checks.push(
      major >= 22
        ? ok('node', 'Node.js version', process.version)
        : fail('node', 'Node.js version', `${process.version} is too old`, 'Install Node.js 22.13 or newer.'),
    );

    // A directory that does not exist yet is fine — the server creates it on
    // first run — as long as its parent can be written to.
    const dataDirExists = fs.existsSync(config.dataDir);
    const writableTarget = dataDirExists ? config.dataDir : path.dirname(config.dataDir);
    try {
      fs.accessSync(writableTarget, fs.constants.W_OK);
      const dbSize = dataDirExists && fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0;
      checks.push(
        ok(
          'data_dir',
          'Data directory',
          dbSize
            ? `${config.dataDir} (database ${(dbSize / 1e6).toFixed(1)} MB)`
            : `${config.dataDir}${dataDirExists ? ' (no database yet)' : ' (will be created on first run)'}`,
        ),
      );
    } catch {
      checks.push(
        fail(
          'data_dir',
          'Data directory',
          `cannot write to ${writableTarget}`,
          'Fix the permissions, or set CREDIBLE_DATA_DIR to a directory you own.',
        ),
      );
    }

    checks.push(
      config.baseUrl
        ? ok('base_url', 'Public URL', config.baseUrl)
        : warn(
            'base_url',
            'Public URL',
            'CREDIBLE_BASE_URL is unset, so snippets and shared links are built from the Host header',
            'Set CREDIBLE_BASE_URL to the URL visitors will load the script from.',
          ),
    );
  }

  if (local && !describesThisShell) {
    checks.push(
      skip(
        'local_env',
        'This machine',
        `not checked — ${origin} is a different instance, so this shell's configuration says nothing about it`,
      ),
    );
  }

  // ------------------------------------------------------- the instance --
  if (!origin) {
    checks.push(skip('reachable', 'Instance reachable', 'no --url given'));
    return summarize(checks);
  }

  let health = null;
  try {
    const response = await fetchWithTimeout(`${origin}/api/health`);
    health = response.ok ? await response.json() : null;
    checks.push(
      health
        ? ok('reachable', 'Instance reachable', `${origin} · v${health.version} · ${health.events} events stored`)
        : fail('reachable', 'Instance reachable', `${origin}/api/health returned ${response.status}`, 'Is something else listening on that port?'),
    );
  } catch (err) {
    checks.push(
      fail(
        'reachable',
        'Instance reachable',
        `${origin} did not answer (${err.name === 'TimeoutError' ? 'timed out' : err.message})`,
        'Start it with `credible serve`, or `credible deploy` for a persistent service.',
      ),
    );
    return summarize(checks);
  }

  // --------------------------------------------------- mixed content --
  // The single most common self-hosting failure: an HTTPS page cannot load a
  // script over HTTP, so the browser blocks the tracker and nothing is ever
  // recorded — silently, with no error the site owner would notice.
  const instanceIsHttp = origin.startsWith('http://');
  const localhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
  const siteIsHttps = siteUrl ? siteUrl.startsWith('https://') : true;

  if (instanceIsHttp && !localhost) {
    checks.push(
      fail(
        'https',
        'HTTPS',
        `${origin} is plain HTTP${siteIsHttps ? ', and browsers block an HTTP script on an HTTPS page' : ''}`,
        'Put it behind Caddy/nginx with TLS, or use `credible deploy --target fly` for HTTPS out of the box.',
      ),
    );
  } else if (localhost) {
    checks.push(
      warn(
        'https',
        'HTTPS',
        'the instance is only reachable on localhost',
        'A public website cannot load a script from your laptop. Use `credible deploy --target tunnel` for a public HTTPS URL, or host it somewhere reachable.',
      ),
    );
  } else {
    checks.push(ok('https', 'HTTPS', origin));
  }

  // ------------------------------------------------------ tracker file --
  try {
    const response = await fetchWithTimeout(`${origin}/js/cr.js`);
    const body = await response.text();
    checks.push(
      response.ok && body.includes('credible')
        ? ok('tracker', 'Tracker script', `${origin}/js/cr.js (${(body.length / 1024).toFixed(1)} KB)`)
        : fail('tracker', 'Tracker script', `returned ${response.status}`, 'Rebuild it with `node tracker/build.js`.'),
    );
  } catch (err) {
    checks.push(fail('tracker', 'Tracker script', err.message, 'Check the instance logs.'));
  }

  // --------------------------------------------------- ingest endpoint --
  // Posted for a domain that is deliberately not tracked, so the check never
  // pollutes anyone's numbers: a healthy instance answers 202 and ignores it.
  try {
    const response = await fetchWithTimeout(`${origin}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': CHROME_UA },
      body: JSON.stringify({
        n: 'pageview',
        d: 'credible-doctor.invalid',
        u: 'https://credible-doctor.invalid/',
        w: 1280,
      }),
    });
    checks.push(
      response.status === 202
        ? ok('ingest', 'Event endpoint', `${origin}/api/event accepts events`)
        : fail('ingest', 'Event endpoint', `returned ${response.status}`, 'Check the instance logs and any proxy in front of it.'),
    );
  } catch (err) {
    checks.push(fail('ingest', 'Event endpoint', err.message, 'A proxy or firewall may be blocking POST requests.'));
  }

  // -------------------------------------------------------- this site --
  if (!domain) {
    checks.push(skip('site', 'Site receiving data', 'no --domain given'));
    return summarize(checks);
  }

  if (!apiKey) {
    checks.push(skip('site', 'Site receiving data', 'no --api-key given'));
    return summarize(checks);
  }

  try {
    const response = await fetchWithTimeout(`${origin}/api/sites/${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      checks.push(
        fail(
          'site',
          'Site receiving data',
          `${domain}: ${response.status === 404 ? 'not tracked on this instance' : `API returned ${response.status}`}`,
          response.status === 404
            ? `Create it: credible provision --email you@example.com --domain ${domain}`
            : 'Check the API key.',
        ),
      );
      return summarize(checks);
    }

    const site = await response.json();
    const first = site.data_range?.first;
    const last = site.data_range?.last;
    if (!first) {
      checks.push(
        warn(
          'site',
          'Site receiving data',
          `${domain} has never received an event`,
          `Is the snippet in <head>? Is data-domain exactly "${domain}"? Note that localhost is not counted without data-track-localhost.`,
        ),
      );
    } else {
      const ageMinutes = Math.round((Date.now() / 1000 - last) / 60);
      checks.push(
        ok(
          'site',
          'Site receiving data',
          `${domain}: last event ${ageMinutes < 2 ? 'just now' : `${ageMinutes} min ago`}`,
        ),
      );
    }

    const snippetOrigin = /src="([^"]+)\/js\/cr\.js"/.exec(site.snippet || '')?.[1];
    if (snippetOrigin && snippetOrigin.replace(/\/+$/, '') !== origin) {
      checks.push(
        warn(
          'snippet_origin',
          'Snippet URL',
          `the instance builds snippets pointing at ${snippetOrigin}, not ${origin}`,
          'Set CREDIBLE_BASE_URL to the URL visitors actually use.',
        ),
      );
    }
  } catch (err) {
    checks.push(fail('site', 'Site receiving data', err.message, ''));
  }

  return summarize(checks);
}

function summarize(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;
  return { checks, summary, healthy: summary.fail === 0 };
}

/** Render the report for a terminal. */
export function formatReport({ checks, summary, healthy }) {
  const icon = { ok: '✓', warn: '!', fail: '✗', skip: '·' };
  const lines = [''];
  for (const check of checks) {
    lines.push(`  ${icon[check.status]} ${check.label.padEnd(24)} ${check.detail}`);
    if (check.fix) lines.push(`      → ${check.fix}`);
  }
  lines.push('');
  lines.push(
    healthy
      ? `  ${summary.ok} checks passed${summary.warn ? `, ${summary.warn} warning${summary.warn > 1 ? 's' : ''}` : ''}.`
      : `  ${summary.fail} problem${summary.fail > 1 ? 's' : ''} found.`,
  );
  lines.push('');
  return lines.join('\n');
}
