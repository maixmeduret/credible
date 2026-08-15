/**
 * Zero-touch setup: the path an AI assistant takes to stand an instance up
 * without a human ever opening the dashboard.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { closeDatabase, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextSteps, provision, snippetFor } from '../src/provision.js';
import { config } from '../src/config.js';
import { currentUser, userFromApiKey } from '../src/auth/index.js';
import { findSiteByDomain } from '../src/sites.js';
import { createServer } from '../src/server.js';

before(async () => {
  await withDatabase('provision');
});
after(closeDatabase);

/** Minimal fake request, enough for currentUser(). */
const request = (headers = {}) => ({ headers, socket: { remoteAddress: '203.0.113.1' } });

describe('provision()', () => {
  it('takes an empty instance to ready-to-install in one call', () => {
    const result = provision({
      email: 'Agent@Example.com',
      domain: 'https://www.MonSite.fr/boutique',
      timezone: 'Europe/Paris',
      currency: 'EUR',
    });

    assert.equal(result.user.email, 'agent@example.com', 'the email is normalised');
    assert.equal(result.created.user, true);
    assert.equal(result.created.site, true);
    assert.equal(result.site.domain, 'monsite.fr', 'the domain is normalised out of a full URL');
    assert.equal(result.site.timezone, 'Europe/Paris');
    assert.match(result.apiKey, /^cred_/);
    assert.equal(typeof result.password, 'string');
    assert.ok(result.password.length >= 12, 'a strong password was generated');
  });

  it('does not echo back a password the caller chose', () => {
    const result = provision({ email: 'chosen@example.com', password: 'a-password-i-picked' });
    assert.equal(result.password, null);
    assert.equal(result.site, null, 'no domain means no site');
  });

  it('mints a key that authenticates the management API', () => {
    const result = provision({ email: 'keyed@example.com', domain: 'keyed.example' });
    const user = currentUser(request({ authorization: `Bearer ${result.apiKey}` }));
    assert.equal(user?.email, 'keyed@example.com');
    assert.equal(userFromApiKey(`Bearer ${result.apiKey}`)?.id, result.user.id);
  });

  it('ignores a bearer-shaped string that is not a key', () => {
    assert.equal(currentUser(request({ authorization: 'Bearer cred_not-a-real-key' })), null);
    assert.equal(currentUser(request({})), null);
  });

  it('adds a site to an already authenticated account without creating a user', () => {
    const first = provision({ email: 'owner@example.com', domain: 'one.example' });
    const second = provision({ user: first.user, domain: 'two.example' });

    assert.equal(second.created.user, false);
    assert.equal(second.created.site, true);
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.password, null);
    assert.notEqual(second.apiKey, first.apiKey, 'every call mints a fresh key');
  });

  it('reuses a site the caller already owns instead of failing', () => {
    const first = provision({ email: 'repeat@example.com', domain: 'repeat.example' });
    const again = provision({ user: first.user, domain: 'repeat.example' });
    assert.equal(again.created.site, false);
    assert.equal(again.site.id, first.site.id);
  });

  it('refuses a known email without its password', () => {
    provision({ email: 'known@example.com', password: 'the-real-password' });
    assert.throws(() => provision({ email: 'known@example.com' }), { status: 409 });
    assert.throws(
      () => provision({ email: 'known@example.com', password: 'wrong' }),
      { status: 401 },
    );
    // …and accepts the right one.
    const ok = provision({ email: 'known@example.com', password: 'the-real-password', domain: 'known.example' });
    assert.equal(ok.created.user, false);
    assert.equal(ok.site.domain, 'known.example');
  });

  it('refuses a domain that belongs to somebody else', () => {
    const owner = provision({ email: 'first-owner@example.com', domain: 'contested.example' });
    assert.ok(owner.site);
    const intruder = provision({ email: 'intruder@example.com' });
    assert.throws(() => provision({ user: intruder.user, domain: 'contested.example' }), { status: 409 });
  });

  it('rejects an invalid email or domain', () => {
    assert.throws(() => provision({ email: 'not-an-email' }), { status: 422 });
    assert.throws(() => provision({ email: 'ok@example.com', domain: 'not a domain' }), { status: 422 });
  });

  it('honours a locked-down instance', () => {
    const wasOpen = config.openRegistration;
    config.openRegistration = false;
    try {
      assert.throws(() => provision({ email: 'stranger@example.com' }), { status: 403 });
      // An existing account can still be used — that is what the API key is for.
      const existing = findSiteByDomain('one.example');
      assert.ok(existing, 'fixture site still present');
    } finally {
      config.openRegistration = wasOpen;
    }
  });
});

describe('snippet and next steps', () => {
  it('builds the install snippet for an instance origin', () => {
    assert.equal(
      snippetFor('https://stats.example', 'shop.example'),
      '<script defer data-domain="shop.example" src="https://stats.example/js/cr.js"></script>',
    );
  });

  it('tells the caller what to do next', () => {
    const withSite = nextSteps('https://stats.example', { domain: 'shop.example' });
    assert.equal(withSite.length, 3);
    assert.ok(withSite[1].includes('https://stats.example/api/stats/shop.example/realtime'));

    const withoutSite = nextSteps('https://stats.example', null);
    assert.ok(withoutSite[0].includes('POST /api/sites'));
  });
});

// --------------------------------------------------------------------------

describe('over HTTP', () => {
  let server;
  let origin;

  before(async () => {
    await withDatabase('provision-http');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path, body, headers = {}) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('POST /api/v1/provision returns everything needed to install', async () => {
    const response = await post('/api/v1/provision', {
      email: 'http@example.com',
      domain: 'http-site.example',
      timezone: 'Europe/Paris',
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.user.email, 'http@example.com');
    assert.match(body.api_key, /^cred_/);
    assert.equal(typeof body.password, 'string');
    assert.equal(body.site.domain, 'http-site.example');
    assert.equal(
      body.snippet,
      `<script defer data-domain="http-site.example" src="${origin}/js/cr.js"></script>`,
    );
    assert.equal(body.dashboard_url, `${origin}/http-site.example`);
    assert.deepEqual(body.created, { user: true, site: true });
    assert.ok(Array.isArray(body.next_steps) && body.next_steps.length);
  });

  it('the returned key drives the rest of the management API', async () => {
    const provisioned = await (await post('/api/v1/provision', {
      email: 'driver@example.com',
      domain: 'driver.example',
    })).json();
    const auth = { authorization: `Bearer ${provisioned.api_key}` };

    const me = await (await fetch(`${origin}/api/auth/me`, { headers: auth })).json();
    assert.equal(me.user.email, 'driver@example.com');
    assert.equal(me.sites.length, 1);

    const created = await (await post('/api/sites', { domain: 'second.example' }, auth)).json();
    assert.equal(created.site.domain, 'second.example');

    const goal = await (
      await post('/api/sites/driver.example/goals', { type: 'event', event_name: 'Signup' }, auth)
    ).json();
    assert.equal(goal.goal.event_name, 'Signup');

    const shared = await (await post('/api/sites/driver.example/shared-links', { name: 'Team' }, auth)).json();
    assert.match(shared.url, /\/share\/driver\.example\?auth=/);

    const stats = await fetch(
      `${origin}/api/v1/stats/aggregate?site_id=driver.example&period=7d`,
      { headers: auth },
    );
    assert.equal(stats.status, 200);
  });

  it('rejects an anonymous management call', async () => {
    const response = await post('/api/sites', { domain: 'nope.example' });
    assert.equal(response.status, 401);
  });

  it('serves an agent brief at /llms.txt', async () => {
    const response = await fetch(`${origin}/llms.txt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/plain/);

    const text = await response.text();
    assert.ok(text.includes(origin), 'the instance origin is baked in');
    assert.ok(text.includes('/api/v1/provision'));
    assert.ok(text.includes('/js/cr.js'));
  });

  it('POST /api/v1/provision with a bearer key adds a site to that account', async () => {
    const first = await (await post('/api/v1/provision', { email: 'bearer@example.com' })).json();
    const second = await (
      await post('/api/v1/provision', { domain: 'bearer-site.example' }, { authorization: `Bearer ${first.api_key}` })
    ).json();

    assert.equal(second.user.email, 'bearer@example.com');
    assert.deepEqual(second.created, { user: false, site: true });
    assert.equal(second.password, null);
  });

  it('rejects a malformed email with 422', async () => {
    const response = await post('/api/v1/provision', { email: 'nope' });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /valid email/i);
  });
});
