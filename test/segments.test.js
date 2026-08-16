/**
 * Saved segments, graph annotations, and the server-side shields.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { CHROME_UA, closeDatabase, events, track, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnnotation,
  createSegment,
  deleteAnnotation,
  deleteSegment,
  listAnnotations,
  listSegments,
  updateSegment,
} from '../src/segments.js';
import { createSite, shieldReason, updateSite } from '../src/sites.js';
import { createUser } from '../src/auth/index.js';
import { createServer } from '../src/server.js';
import { provision } from '../src/provision.js';

let site;
let alice;
let bob;

before(async () => {
  await withDatabase('segments');
  site = createSite({ domain: 'example.com', timezone: 'UTC' });
  alice = createUser({ email: 'alice@example.com', password: 'password-alice' });
  bob = createUser({ email: 'bob@example.com', password: 'password-bob' });
});
after(closeDatabase);

describe('segments', () => {
  it('saves a named set of filters', () => {
    const segment = createSegment(site.id, alice.id, {
      name: 'Mobile France',
      filters: [['is', 'visit:country', ['FR']], ['is', 'visit:device', ['Mobile']]],
      scope: 'site',
    });

    assert.equal(segment.name, 'Mobile France');
    assert.equal(segment.scope, 'site');
    assert.deepEqual(segment.filters, [
      ['is', 'visit:country', ['FR']],
      ['is', 'visit:device', ['Mobile']],
    ]);
  });

  it('validates the filters on the way in', () => {
    const bad = [
      { name: 'x', filters: [] },
      { name: 'x', filters: [['nonsense', 'visit:country', ['FR']]] },
      { name: 'x', filters: [['is', 'visit:nonexistent', ['FR']]] },
      { name: '', filters: [['is', 'visit:country', ['FR']]] },
    ];
    for (const input of bad) {
      assert.throws(() => createSegment(site.id, alice.id, input), { status: 422 }, JSON.stringify(input));
    }
  });

  it('rejects an unknown scope', () => {
    assert.throws(
      () => createSegment(site.id, alice.id, { name: 'x', filters: [['is', 'visit:country', ['FR']]], scope: 'world' }),
      { status: 422 },
    );
  });

  it('shows site segments to everyone and personal ones only to their owner', () => {
    createSegment(site.id, alice.id, { name: "Alice's own", filters: [['is', 'visit:browser', ['Firefox']]] });

    const forAlice = listSegments(site.id, alice.id).map((s) => s.name);
    const forBob = listSegments(site.id, bob.id).map((s) => s.name);

    assert.ok(forAlice.includes("Alice's own"));
    assert.ok(forAlice.includes('Mobile France'));
    assert.ok(!forBob.includes("Alice's own"), "Bob cannot see Alice's personal segment");
    assert.ok(forBob.includes('Mobile France'), 'but he does see the site-wide one');
  });

  it('lets the owner edit a personal segment and nobody else', () => {
    const segment = createSegment(site.id, alice.id, {
      name: 'Editable',
      filters: [['is', 'visit:browser', ['Chrome']]],
    });

    const renamed = updateSegment(site.id, alice.id, segment.id, { name: 'Renamed' });
    assert.equal(renamed.name, 'Renamed');

    assert.throws(() => updateSegment(site.id, bob.id, segment.id, { name: 'Hijacked' }), { status: 403 });
    assert.throws(() => deleteSegment(site.id, bob.id, segment.id), { status: 403 });

    deleteSegment(site.id, alice.id, segment.id);
    assert.ok(!listSegments(site.id, alice.id).some((s) => s.id === segment.id));
  });

  it('lets anyone edit a site-wide segment', () => {
    const segment = createSegment(site.id, alice.id, {
      name: 'Shared',
      filters: [['is', 'visit:os', ['macOS']]],
      scope: 'site',
    });
    assert.equal(updateSegment(site.id, bob.id, segment.id, { name: 'Shared, edited' }).name, 'Shared, edited');
    deleteSegment(site.id, bob.id, segment.id);
  });
});

describe('annotations', () => {
  it('records a dated note and reads it back in range', () => {
    createAnnotation(site.id, alice.id, { date: '2026-03-01', text: 'Launched the new pricing page' });
    createAnnotation(site.id, alice.id, { date: '2026-06-15', text: 'Hacker News front page' });

    const all = listAnnotations(site.id);
    assert.equal(all.length, 2);
    assert.equal(all[0].author_email, 'alice@example.com');

    const march = listAnnotations(site.id, { from: '2026-02-01', to: '2026-03-31' });
    assert.deepEqual(march.map((a) => a.text), ['Launched the new pricing page']);
  });

  it('refuses a bad date or empty text', () => {
    assert.throws(() => createAnnotation(site.id, alice.id, { date: '1 March', text: 'x' }), { status: 422 });
    assert.throws(() => createAnnotation(site.id, alice.id, { date: '2026-03-01', text: '  ' }), { status: 422 });
  });

  it('deletes one without touching the others', () => {
    const created = createAnnotation(site.id, alice.id, { date: '2026-07-01', text: 'Temporary' });
    deleteAnnotation(site.id, created.id);
    assert.ok(!listAnnotations(site.id).some((a) => a.id === created.id));
    assert.equal(listAnnotations(site.id).length, 2);
  });
});

describe('shields', () => {
  it('lets everything through by default', () => {
    assert.equal(shieldReason(site, { countryCode: 'FR', hostname: 'example.com' }), '');
  });

  it('blocks an excluded country', () => {
    const shielded = { ...site, excluded_countries: 'RU, CN' };
    assert.match(shieldReason(shielded, { countryCode: 'RU' }), /RU/);
    assert.match(shieldReason(shielded, { countryCode: 'cn' }), /cn/i);
    assert.equal(shieldReason(shielded, { countryCode: 'FR' }), '');
    assert.equal(shieldReason(shielded, { countryCode: '' }), '', 'unknown country is not blocked');
  });

  it('enforces a hostname allow-list when one is set', () => {
    const shielded = { ...site, allowed_hostnames: 'example.com, *.example.com' };
    assert.equal(shieldReason(shielded, { hostname: 'example.com' }), '');
    assert.equal(shieldReason(shielded, { hostname: 'www.example.com' }), '', 'www is normalised away');
    assert.equal(shieldReason(shielded, { hostname: 'blog.example.com' }), '', 'the wildcard covers subdomains');
    assert.match(shieldReason(shielded, { hostname: 'evil-mirror.test' }), /allow-list/);
    assert.match(shieldReason(shielded, { hostname: '' }), /allow-list/);
  });

  it('drops shielded events at ingest', () => {
    updateSite(site.id, { excluded_countries: 'RU' });
    const shieldedSite = { headers: { 'cf-ipcountry': 'RU' }, userAgent: CHROME_UA, ip: '203.0.113.9' };

    const before_ = events().length;
    track({ path: '/blocked' }, shieldedSite);
    assert.equal(events().length, before_, 'nothing was written');

    track({ path: '/allowed' }, { ...shieldedSite, headers: { 'cf-ipcountry': 'FR' } });
    assert.equal(events().length, before_ + 1);

    updateSite(site.id, { excluded_countries: '' });
  });

  it('validates the bot filtering level', () => {
    assert.throws(() => updateSite(site.id, { bot_filtering: 'paranoid' }), { status: 422 });
    assert.equal(updateSite(site.id, { bot_filtering: 'strict' }).bot_filtering, 'strict');
    updateSite(site.id, { bot_filtering: 'standard' });
  });
});

describe('over HTTP', () => {
  let server;
  let origin;
  let apiKey;
  let siteDomain;

  before(async () => {
    await withDatabase('segments-http');
    const provisioned = provision({ email: 'http@example.com', domain: 'seg.example' });
    apiKey = provisioned.apiKey;
    siteDomain = provisioned.site.domain;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    for (const path of ['/a', '/b']) {
      track({ domain: siteDomain, path }, { userAgent: CHROME_UA, headers: { 'cf-ipcountry': 'FR' } });
    }
    track({ domain: siteDomain, path: '/c' }, { userAgent: CHROME_UA, headers: { 'cf-ipcountry': 'DE' }, visitorId: 'de-visitor-00000000' });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const auth = () => ({ authorization: `Bearer ${apiKey}` });

  it('creates a segment over the API and applies it to a query', async () => {
    const created = await (
      await fetch(`${origin}/api/sites/${siteDomain}/segments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth() },
        body: JSON.stringify({ name: 'France only', filters: [['is', 'visit:country', ['FR']]], scope: 'site' }),
      })
    ).json();
    assert.equal(created.segment.name, 'France only');

    const unfiltered = await (
      await fetch(`${origin}/api/stats/${siteDomain}/dashboard?period=day`, { headers: auth() })
    ).json();
    const segmented = await (
      await fetch(`${origin}/api/stats/${siteDomain}/dashboard?period=day&segment=${created.segment.id}`, {
        headers: auth(),
      })
    ).json();

    assert.equal(unfiltered.metrics.visitors, 2, 'one French visitor and one German one');
    assert.equal(segmented.metrics.visitors, 1, 'the segment narrows it to France');
    assert.ok(Array.isArray(unfiltered.segments), 'the dashboard payload carries the segment list');
  });

  it('404s an unknown segment rather than silently ignoring it', async () => {
    const response = await fetch(`${origin}/api/stats/${siteDomain}/dashboard?period=day&segment=99999`, {
      headers: auth(),
    });
    assert.equal(response.status, 404);
  });

  it('round-trips an annotation and returns it with the dashboard', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await fetch(`${origin}/api/sites/${siteDomain}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ date: today, text: 'Deployed v2' }),
    });

    const dashboard = await (
      await fetch(`${origin}/api/stats/${siteDomain}/dashboard?period=day`, { headers: auth() })
    ).json();
    assert.deepEqual(dashboard.annotations.map((a) => a.text), ['Deployed v2']);
  });
});
