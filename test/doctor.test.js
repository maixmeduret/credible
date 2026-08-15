/**
 * `credible doctor` — the checks that turn "zero visitors" into a fix.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { closeDatabase, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diagnose, formatReport } from '../src/doctor.js';
import { provision } from '../src/provision.js';
import { recordEvent } from '../src/ingest/index.js';
import { createServer } from '../src/server.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let server;
let origin;
let apiKey;

const find = (report, id) => report.checks.find((check) => check.id === id);

before(async () => {
  await withDatabase('doctor');
  const provisioned = provision({ email: 'doctor@example.com', domain: 'doctor.example' });
  apiKey = provisioned.apiKey;

  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

describe('diagnose', () => {
  it('reports a dead instance as a failure with a fix attached', async () => {
    // Port 1 is privileged and nothing listens there.
    const report = await diagnose({ url: 'http://127.0.0.1:1', local: false });
    const reachable = find(report, 'reachable');

    assert.equal(reachable.status, 'fail');
    assert.match(reachable.fix, /credible (serve|deploy)/);
    assert.equal(report.healthy, false);
    // It stops there rather than reporting a cascade of derived failures.
    assert.equal(find(report, 'tracker'), undefined);
  });

  it('checks a live instance end to end', async () => {
    const report = await diagnose({ url: origin, local: false });

    assert.equal(find(report, 'reachable').status, 'ok');
    assert.equal(find(report, 'tracker').status, 'ok', 'the tracker script is served');
    assert.equal(find(report, 'ingest').status, 'ok', 'the event endpoint accepts events');
  });

  it('warns that a localhost instance cannot serve a public site', async () => {
    const report = await diagnose({ url: origin, local: false });
    const https = find(report, 'https');

    assert.equal(https.status, 'warn');
    assert.match(https.detail, /localhost/);
    assert.match(https.fix, /tunnel|reachable/);
  });

  it('never records the event it uses to probe the ingest endpoint', async () => {
    const before = await fetch(`${origin}/api/health`).then((r) => r.json());
    await diagnose({ url: origin, local: false });
    const after_ = await fetch(`${origin}/api/health`).then((r) => r.json());
    assert.equal(after_.events, before.events, 'the probe uses a domain nobody tracks');
  });

  it('says a tracked site has never received data, and how to fix that', async () => {
    const report = await diagnose({ url: origin, domain: 'doctor.example', apiKey, local: false });
    const site = find(report, 'site');

    assert.equal(site.status, 'warn');
    assert.match(site.detail, /never received/);
    assert.match(site.fix, /data-domain/);
  });

  it('confirms a site once an event lands', async () => {
    recordEvent(
      { n: 'pageview', d: 'doctor.example', u: 'https://doctor.example/', w: 1440 },
      { ip: '203.0.113.5', userAgent: CHROME_UA },
    );

    const report = await diagnose({ url: origin, domain: 'doctor.example', apiKey, local: false });
    const site = find(report, 'site');

    assert.equal(site.status, 'ok');
    assert.match(site.detail, /just now|min ago/);
  });

  it('reports an unknown domain as a failure that names the fix', async () => {
    const report = await diagnose({ url: origin, domain: 'not-tracked.example', apiKey, local: false });
    const site = find(report, 'site');

    assert.equal(site.status, 'fail');
    assert.match(site.fix, /credible provision/);
  });

  it('skips the site checks when it has nothing to check with', async () => {
    const noDomain = await diagnose({ url: origin, local: false });
    assert.equal(find(noDomain, 'site').status, 'skip');

    const noKey = await diagnose({ url: origin, domain: 'doctor.example', local: false });
    assert.equal(find(noKey, 'site').status, 'skip');
  });

  it('inspects this host when asked to', async () => {
    const report = await diagnose({ url: '', local: true });
    assert.equal(find(report, 'node').status, 'ok');
    assert.ok(find(report, 'data_dir'), 'the data directory is checked');
    assert.equal(find(report, 'reachable').status, 'skip', 'nothing to reach without a url');
  });

  it('renders a report a human can act on', async () => {
    const report = await diagnose({ url: origin, domain: 'doctor.example', apiKey, local: false });
    const text = formatReport(report);

    assert.match(text, /Instance reachable/);
    assert.match(text, /checks passed|problem/);
    for (const check of report.checks) {
      if (check.fix) assert.ok(text.includes(check.fix), `the fix for ${check.id} is shown`);
    }
  });
});
