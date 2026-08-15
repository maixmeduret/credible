/**
 * The HTTP surface, exercised over a real socket with `fetch`.
 *
 * The server is booted once on port 0 and torn down in an `after()` hook, so
 * the test process exits on its own. Tests inside a suite run in declaration
 * order and share the session cookie created by the first one.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { CHROME_UA, GOOGLEBOT_UA, closeDatabase, events, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

const DOMAIN = 'example.com';
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';

let server;
let origin;

/** Session cookie of the first (owner) account, filled in by the first suite. */
let cookie = '';
/** Session cookie of a second account with no access to the site. */
let strangerCookie = '';
let apiKey = '';
let shareSlug = '';

/**
 * One request. Returns the status, the parsed JSON body (when there is one)
 * and the raw headers.
 */
async function call(method, path, { body, cookie: jar, token, headers = {}, ua } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(jar ? { cookie: jar } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ua ? { 'user-agent': ua } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, body: json, text };
}

/** `credible_session=...` from a Set-Cookie response header. */
function sessionCookieFrom(response) {
  const [raw] = response.headers.getSetCookie();
  assert.ok(raw, 'expected a Set-Cookie header');
  return raw.split(';')[0];
}

const query = (params) => `?${new URLSearchParams(params)}`;

before(async () => {
  await withDatabase('api');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // fetch keeps its sockets alive, so drop them before waiting on close().
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

// --------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('reports the version and the event count', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.version, '0.1.0');
    assert.equal(res.body.events, 0);
    assert.equal(typeof res.body.uptime, 'number');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  });

  it('404s an unknown api path', async () => {
    const res = await call('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });
});

// --------------------------------------------------------------------------

describe('accounts and sites', () => {
  it('registers the first account and hands back a session cookie', async () => {
    const res = await call('POST', '/api/auth/register', {
      body: { email: EMAIL, password: PASSWORD, name: 'Owner' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.first, true, 'this is the first account on the instance');
    assert.deepEqual(res.body.user, { id: 1, email: EMAIL, name: 'Owner' });
    assert.equal(res.body.user.password_hash, undefined, 'never leak the hash');

    const [raw] = res.headers.getSetCookie();
    assert.match(raw, /^credible_session=/);
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Path=\//);
    cookie = sessionCookieFrom(res);
  });

  it('rejects a weak password and a duplicate email', async () => {
    const weak = await call('POST', '/api/auth/register', {
      body: { email: 'someone@example.com', password: 'short' },
    });
    assert.equal(weak.status, 422);
    assert.match(weak.body.error, /at least 8 characters/);

    const duplicate = await call('POST', '/api/auth/register', {
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(duplicate.status, 409);
  });

  it('identifies the signed-in user', async () => {
    const anonymous = await call('GET', '/api/auth/me');
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.user, null);
    assert.equal(anonymous.body.needs_setup, false, 'the first account already exists');

    const signedIn = await call('GET', '/api/auth/me', { cookie });
    assert.equal(signedIn.body.user.email, EMAIL);
    assert.deepEqual(signedIn.body.sites, []);
  });

  it('creates a site and returns the install snippet', async () => {
    const res = await call('POST', '/api/sites', {
      cookie,
      body: { domain: 'https://WWW.Example.com/pricing', timezone: 'Europe/Paris', currency: 'usd' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.site.domain, DOMAIN, 'the domain is normalised');
    assert.equal(res.body.site.timezone, 'Europe/Paris');
    assert.equal(res.body.site.currency, 'USD');
    assert.equal(res.body.site.public, false);
    assert.match(res.body.snippet, /data-domain="example\.com"/);
    assert.match(res.body.snippet, /\/js\/cr\.js/);
  });

  it('refuses to create a site twice, or without a session', async () => {
    const duplicate = await call('POST', '/api/sites', { cookie, body: { domain: DOMAIN } });
    assert.equal(duplicate.status, 409);

    const anonymous = await call('POST', '/api/sites', { body: { domain: 'other.example' } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, 'Sign in to continue');

    const invalid = await call('POST', '/api/sites', { cookie, body: { domain: 'not a domain' } });
    assert.equal(invalid.status, 422);
  });

  it('lists the sites the account can see', async () => {
    const res = await call('GET', '/api/sites', { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sites.map((s) => s.domain), [DOMAIN]);
    assert.equal(res.body.sites[0].role, 'owner');

    const anonymous = await call('GET', '/api/sites');
    assert.equal(anonymous.status, 401);
  });
});

// --------------------------------------------------------------------------

describe('POST /api/event', () => {
  it('accepts a pageview and stores it', async () => {
    const res = await call('POST', '/api/event', {
      ua: CHROME_UA,
      body: { n: 'pageview', d: DOMAIN, u: `https://${DOMAIN}/`, r: 'https://www.google.com/', w: 1440 },
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('x-credible'), 'ok');
    assert.equal(res.text, '', 'the tracker gets no body back');

    const rows = events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pathname, '/');
    assert.equal(rows[0].hostname, DOMAIN);
    assert.equal(rows[0].referrer_source, 'Google');
    assert.equal(rows[0].browser, 'Chrome');
    assert.equal(rows[0].screen_size, 'Desktop');

    const health = await call('GET', '/api/health');
    assert.equal(health.body.events, 1);
  });

  it('answers CORS preflight so the tracker can post from any origin', async () => {
    const res = await call('OPTIONS', '/api/event', { headers: { origin: 'https://example.com' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  it('silently ignores bots, unknown domains and junk', async () => {
    const bot = await call('POST', '/api/event', {
      ua: GOOGLEBOT_UA,
      body: { n: 'pageview', d: DOMAIN, u: `https://${DOMAIN}/` },
    });
    assert.equal(bot.status, 202, 'a dropped event still looks fine to the browser');
    assert.equal(bot.headers.get('x-credible'), 'ignored');

    const unknown = await call('POST', '/api/event', {
      ua: CHROME_UA,
      body: { n: 'pageview', d: 'not-tracked.example', u: 'https://not-tracked.example/' },
    });
    assert.equal(unknown.headers.get('x-credible'), 'ignored');

    const broken = await call('POST', '/api/event', {
      ua: CHROME_UA,
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
    assert.equal(broken.status, 202, 'an empty body is not an error either');

    assert.equal(events().length, 1, 'still just the one real pageview');
  });

  it('accepts the Plausible-compatible /event path', async () => {
    const res = await call('POST', '/event', {
      ua: CHROME_UA,
      body: { n: 'pageview', d: DOMAIN, u: `https://${DOMAIN}/pricing` },
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('x-credible'), 'ok');
    assert.deepEqual(events().map((e) => e.pathname), ['/', '/pricing']);
  });
});

// --------------------------------------------------------------------------

describe('dashboard authorization', () => {
  const dashboard = `/api/stats/${DOMAIN}/dashboard`;

  it('refuses an anonymous caller on a private site', async () => {
    const res = await call('GET', dashboard);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Sign in to continue');
  });

  it('serves a member with the session cookie', async () => {
    const res = await call('GET', `${dashboard}${query({ period: '7d' })}`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.site.domain, DOMAIN);
    assert.equal(res.body.period.period, '7d');
    assert.equal(res.body.period.timezone, 'Europe/Paris');
    assert.equal(res.body.metrics.pageviews, 2);
    assert.equal(res.body.metrics.visitors, 1);
    assert.equal(res.body.timeseries.length, 7);
    assert.ok(res.body.panels.pages.results.length >= 1);
    assert.equal(res.body.has_goals, false);
  });

  it('answers 403 for a signed-in stranger', async () => {
    const registered = await call('POST', '/api/auth/register', {
      body: { email: 'stranger@example.com', password: PASSWORD },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.first, false);
    strangerCookie = sessionCookieFrom(registered);

    const res = await call('GET', dashboard, { cookie: strangerCookie });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /do not have access/);
  });

  it('grants read access through a shared link', async () => {
    const created = await call('POST', `/api/sites/${DOMAIN}/shared-links`, {
      cookie,
      body: { name: 'Investors' },
    });
    assert.equal(created.status, 201);
    shareSlug = created.body.slug;
    assert.ok(shareSlug);
    assert.match(created.body.url, new RegExp(`/share/${DOMAIN}\\?auth=`));

    const shared = await call('GET', `${dashboard}${query({ auth: shareSlug })}`);
    assert.equal(shared.status, 200, 'no cookie needed with a valid slug');
    assert.equal(shared.body.metrics.pageviews, 2);

    const bogus = await call('GET', `${dashboard}${query({ auth: 'not-a-real-slug' })}`);
    assert.equal(bogus.status, 401);

    // A stranger's session must not be upgraded by an unknown slug either.
    const strangerWithBogus = await call('GET', `${dashboard}${query({ auth: 'nope' })}`, {
      cookie: strangerCookie,
    });
    assert.equal(strangerWithBogus.status, 403);
  });

  it('404s a domain that is not tracked here', async () => {
    const res = await call('GET', '/api/stats/unknown.example/dashboard', { cookie });
    assert.equal(res.status, 404);
  });

  it('round-trips a filter through the query string', async () => {
    const matching = await call(
      'GET',
      `/api/stats/${DOMAIN}/breakdown${query({
        dimension: 'visit:browser',
        filters: JSON.stringify([['is', 'event:page', ['/pricing']]]),
      })}`,
      { cookie },
    );
    assert.equal(matching.status, 200);
    assert.deepEqual(matching.body.results.map((r) => [r.name, r.pageviews]), [['Chrome', 1]]);

    const empty = await call(
      'GET',
      `/api/stats/${DOMAIN}/breakdown${query({
        dimension: 'visit:browser',
        filters: JSON.stringify([['is', 'event:page', ['/nowhere']]]),
      })}`,
      { cookie },
    );
    assert.deepEqual(empty.body.results, []);

    const malformed = await call(
      'GET',
      `/api/stats/${DOMAIN}/breakdown${query({ filters: 'not json' })}`,
      { cookie },
    );
    assert.equal(malformed.status, 422);
    assert.match(malformed.body.error, /valid JSON/);
  });

  it('serves the realtime panel', async () => {
    const res = await call('GET', `/api/stats/${DOMAIN}/realtime`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.visitors, 1);
    assert.deepEqual(res.body.pages.map((p) => p.name).sort(), ['/', '/pricing']);
  });
});

// --------------------------------------------------------------------------

describe('the public Stats API', () => {
  const aggregate = (params, options) =>
    call('GET', `/api/v1/stats/aggregate${query({ site_id: DOMAIN, ...params })}`, options);

  it('rejects a missing or unknown Bearer token', async () => {
    const missing = await aggregate({});
    assert.equal(missing.status, 401);
    assert.match(missing.body.error, /Authorization: Bearer/);

    const wrong = await aggregate({}, { token: 'cred_not_a_real_key' });
    assert.equal(wrong.status, 401);

    const notEvenBearer = await aggregate({}, { headers: { authorization: 'Basic abc' } });
    assert.equal(notEvenBearer.status, 401);
  });

  it('creates a key that is shown exactly once', async () => {
    const created = await call('POST', '/api/keys', { cookie, body: { name: 'CI' } });
    assert.equal(created.status, 201);
    apiKey = created.body.key;
    assert.match(apiKey, /^cred_/);

    const listed = await call('GET', '/api/keys', { cookie });
    assert.equal(listed.body.keys.length, 1);
    assert.equal(listed.body.keys[0].name, 'CI');
    assert.equal(listed.body.keys[0].key_prefix, apiKey.slice(0, 12));
    assert.equal(listed.body.keys[0].key_hash, undefined, 'the hash never leaves the database');
    assert.equal(JSON.stringify(listed.body).includes(apiKey), false, 'the key itself is not readable');
  });

  it('answers with the requested metrics', async () => {
    const res = await aggregate({ period: '7d' }, { token: apiKey });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.results), [
      'visitors', 'visits', 'pageviews', 'bounce_rate', 'visit_duration',
    ]);
    assert.equal(res.body.results.visitors.value, 1);
    assert.equal(res.body.results.pageviews.value, 2);

    const narrowed = await aggregate({ metrics: 'pageviews,revenue,nonsense' }, { token: apiKey });
    assert.deepEqual(Object.keys(narrowed.body.results), ['pageviews', 'revenue']);
  });

  it('adds a comparison when asked', async () => {
    const res = await aggregate(
      { period: '7d', comparison: 'previous_period' },
      { token: apiKey },
    );
    assert.equal(res.body.results.pageviews.value, 2);
    assert.equal(res.body.results.pageviews.change, 100, 'up from nothing');
  });

  it('round-trips a filter through the query string', async () => {
    const matching = await aggregate(
      { filters: JSON.stringify([['is', 'event:page', ['/pricing']]]) },
      { token: apiKey },
    );
    assert.equal(matching.status, 200);
    assert.equal(matching.body.results.pageviews.value, 1);

    const missing = await aggregate(
      { filters: JSON.stringify([['is', 'event:page', ['/nowhere']]]) },
      { token: apiKey },
    );
    assert.equal(missing.body.results.pageviews.value, 0);

    const negated = await aggregate(
      { filters: JSON.stringify([['is_not', 'event:page', ['/pricing']]]) },
      { token: apiKey },
    );
    assert.equal(negated.body.results.pageviews.value, 1);

    const unknownDimension = await aggregate(
      { filters: JSON.stringify([['is', 'event:sql_injection', ['x']]]) },
      { token: apiKey },
    );
    assert.equal(unknownDimension.status, 422);
    assert.match(unknownDimension.body.error, /Unknown dimension/);
  });

  it('serves a timeseries and a breakdown', async () => {
    const series = await call(
      'GET',
      `/api/v1/stats/timeseries${query({ site_id: DOMAIN, period: '7d', metrics: 'pageviews' })}`,
      { token: apiKey },
    );
    assert.equal(series.status, 200);
    assert.equal(series.body.results.length, 7);
    assert.equal(series.body.results.reduce((sum, row) => sum + row.pageviews, 0), 2);

    const pages = await call(
      'GET',
      `/api/v1/stats/breakdown${query({ site_id: DOMAIN, property: 'event:page', period: '7d' })}`,
      { token: apiKey },
    );
    assert.deepEqual(pages.body.results.map((r) => r['event:page']), ['/', '/pricing']);

    const realtime = await call(
      'GET',
      `/api/v1/stats/realtime/visitors${query({ site_id: DOMAIN })}`,
      { token: apiKey },
    );
    assert.equal(realtime.body, 1);
  });

  it('hides sites the key holder cannot read', async () => {
    const strangerKey = await call('POST', '/api/keys', { cookie: strangerCookie, body: {} });
    assert.equal(strangerKey.status, 201);
    const res = await aggregate({}, { token: strangerKey.body.key });
    assert.equal(res.status, 404, 'not 403 — the key holder cannot even tell the site exists');
  });

  it('records a server-side event', async () => {
    const res = await call('POST', '/api/v1/events', {
      token: apiKey,
      ua: CHROME_UA,
      body: {
        n: 'Purchase',
        d: DOMAIN,
        u: `https://${DOMAIN}/thanks`,
        v: { amount: 12.5, currency: 'EUR' },
      },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { status: 'ok', events: 1 });

    const stored = events("name = 'Purchase'")[0];
    assert.equal(stored.revenue, 1250);
    assert.equal(stored.currency, 'EUR');

    const anonymous = await call('POST', '/api/v1/events', {
      ua: CHROME_UA,
      body: { n: 'Purchase', d: DOMAIN, u: `https://${DOMAIN}/thanks` },
    });
    assert.equal(anonymous.status, 401);
  });
});
