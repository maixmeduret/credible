/**
 * Every HTTP endpoint Credible exposes.
 *
 *   /api/event            ingestion (public, CORS open — the tracker calls it)
 *   /api/auth/*           sign up, sign in, sign out
 *   /api/sites/*          site management, goals, funnels, shared links
 *   /api/stats/:domain/*  the dashboard's own API (cookie or shared link auth)
 *   /api/v1/stats/*       the public Stats API (Bearer token)
 */
import { readFileSync } from 'node:fs';
import { config, originFor } from './config.js';
import { route, sendHtml } from './server.js';
import { getDb, get, all, run, now } from './db/index.js';
import {
  SESSION_COOKIE,
  authenticate,
  clearedSessionCookie,
  createApiKey,
  createAuthSession,
  createSharedLink,
  changePassword,
  createUser,
  currentUser,
  deleteApiKey,
  deleteSharedLink,
  destroyAuthSession,
  findSharedLink,
  listApiKeys,
  listSharedLinks,
  requireUser,
  sessionCookie,
  userCount,
  userFromApiKey,
  verifyPassword,
} from './auth/index.js';
import {
  addMember,
  canAccess,
  createSite,
  deleteSite,
  findSiteByDomain,
  listMembers,
  listSitesForUser,
  normalizeDomain,
  siteDataRange,
  updateSite,
} from './sites.js';
import {
  createFunnel,
  createGoal,
  deleteFunnel,
  deleteGoal,
  funnelSteps,
  listFunnels,
  listGoals,
  suggestGoals,
} from './goals.js';
import { recordEvent } from './ingest/index.js';
import { nextSteps, provision } from './provision.js';
import {
  createAnnotation,
  createSegment,
  deleteAnnotation,
  deleteSegment,
  findSegment,
  listAnnotations,
  listSegments,
  updateSegment,
} from './segments.js';
import {
  Scope,
  aggregate,
  breakdown,
  currentVisitors,
  funnelReport,
  goalsBreakdown,
  pagesBreakdown,
  propertyBreakdown,
  propertyKeys,
  realtimePages,
  timeseries,
} from './stats/index.js';
import { parseFilters } from './stats/query.js';
import {
  comparisonRange,
  formatYmd,
  pickInterval,
  resolveRange,
  startOfDay,
} from './util/time.js';
import {
  HttpError,
  appendHeader,
  clientIp,
  corsHeaders,
  createRateLimiter,
  parseCookies,
  readJson,
  sendJson,
  sendNoContent,
  sendText,
  serializeCookie,
} from './util/http.js';
import { log } from './util/log.js';

const takeIngest = createRateLimiter(config.rateLimitPerMinute);
const takeAuth = createRateLimiter(30);

// --------------------------------------------------------------- helpers --

function publicUser(user) {
  return user ? { id: user.id, email: user.email, name: user.name } : null;
}

function publicSite(site) {
  return {
    domain: site.domain,
    timezone: site.timezone,
    public: Boolean(site.public),
    currency: site.currency,
    created_at: site.created_at,
    ...(site.role ? { role: site.role } : {}),
    ...(site.current_visitors != null ? { current_visitors: Number(site.current_visitors) } : {}),
  };
}

/**
 * Resolve which site a stats request is for and whether the caller may read it.
 * Three ways in: a logged-in member, a public site, or a shared link slug.
 */
function authorizeSite(req, query, domain) {
  const site = findSiteByDomain(domain);
  if (!site) throw new HttpError(404, 'Site not found');

  const user = currentUser(req);
  if (user && canAccess(user, site)) return { site, user, via: 'member' };
  if (site.public) return { site, user, via: 'public' };

  const slug = query.auth || '';
  if (slug) {
    const link = findSharedLink(slug);
    if (link && link.site_id === site.id) {
      if (link.password_hash) {
        const cookie = parseCookies(req)[`credible_shared_${slug}`];
        if (!cookie || !verifyPassword(cookie, link.password_hash)) {
          throw new HttpError(401, 'This dashboard is password protected');
        }
      }
      return { site, user: null, via: 'shared' };
    }
  }

  throw new HttpError(user ? 403 : 401, user ? 'You do not have access to this site' : 'Sign in to continue');
}

/** Build the query scope shared by every stats endpoint. */
function buildScope(site, query) {
  const tz = site.timezone || 'UTC';
  const range = resolveRange(
    { period: query.period, date: query.date, from: query.from, to: query.to },
    tz,
  );

  if (range.start == null) {
    const { first } = siteDataRange(site.id);
    range.start = first ? startOfDay(first, tz) : range.end - 30 * 86400;
    range.interval = pickInterval(range.start, range.end);
  }
  if (query.interval && ['minute', 'hour', 'day', 'week', 'month'].includes(query.interval)) {
    range.interval = query.interval;
  }

  const goals = listGoals(site.id);
  const filters = parseFilters(query.filters);

  // A saved segment is just more filters, applied on top of whatever the user
  // has already narrowed to — so a segment and an ad-hoc filter compose.
  if (query.segment) {
    const segment = findSegment(site.id, query.segment);
    if (!segment) throw new HttpError(404, 'Segment not found');
    filters.push(...parseFilters(JSON.stringify(segment.filters)));
  }

  const scope = new Scope({ site, range, filters, goals });
  return { scope, range, goals, timezone: tz };
}

function comparisonScope(site, scope, query) {
  const mode = query.comparison || '';
  if (!mode || mode === 'off') return null;
  const previous = comparisonRange(scope.range, mode, site.timezone || 'UTC');
  if (!previous) return null;
  return new Scope({ site, range: previous, filters: scope.filters, goals: scope.goals });
}

function changeFor(metric, current, previous) {
  if (previous == null) return null;
  if (metric === 'bounce_rate') return Math.round(current - previous);
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

const intParam = (value, fallback, max = 1000) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
};

// ---------------------------------------------------------------- routes --

export function registerRoutes() {
  if (registerRoutes.done) return;
  registerRoutes.done = true;

  // ------------------------------------------------------------- health --
  route('GET', '/api/health', ({ res }) => {
    const db = getDb();
    const events = db.prepare('SELECT count(*) AS c FROM events').get().c;
    sendJson(res, 200, {
      status: 'ok',
      version: config.version,
      events: Number(events),
      uptime: Math.round(process.uptime()),
    });
  });

  // ---------------------------------------------------------- ingestion --

  const ingest = async ({ req, res }) => {
    const cors = corsHeaders(req);
    warnAboutUntrustedProxy(req);
    const ip = clientIp(req);
    if (!takeIngest(ip)) {
      sendJson(res, 429, { error: 'Too many events' }, cors);
      return;
    }
    let body;
    try {
      body = await readJson(req, 32 * 1024);
    } catch {
      sendJson(res, 400, { error: 'Invalid payload' }, cors);
      return;
    }
    try {
      const result = recordEvent(body, {
        ip,
        userAgent: req.headers['user-agent'] || '',
        headers: req.headers,
      });
      sendNoContent(res, { ...cors, 'x-credible': result.status });
    } catch (err) {
      log.error('Ingest failed:', err);
      sendNoContent(res, cors); // never leak internals to a public endpoint
    }
  };

  route('POST', '/api/event', ingest);
  route('POST', '/api/events', ingest);
  route('POST', '/event', ingest); // Plausible-compatible path

  // --------------------------------------------------------------- auth --

  route('POST', '/api/auth/register', async ({ req, res }) => {
    if (!takeAuth(clientIp(req))) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const body = await readJson(req);
    const first = userCount() === 0;
    if (!first && !config.openRegistration) throw new HttpError(403, 'Registration is closed on this instance');

    const user = createUser({ email: body.email, password: body.password, name: body.name });
    const token = createAuthSession(user.id, req.headers['user-agent']);
    appendHeader(res, 'set-cookie', sessionCookie(token));
    sendJson(res, 201, { user: publicUser(user), first });
  });

  route('POST', '/api/auth/login', async ({ req, res }) => {
    if (!takeAuth(clientIp(req))) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const body = await readJson(req);
    const user = authenticate(body.email, body.password);
    const token = createAuthSession(user.id, req.headers['user-agent']);
    appendHeader(res, 'set-cookie', sessionCookie(token));
    sendJson(res, 200, { user: publicUser(user) });
  });

  route('POST', '/api/auth/logout', ({ req, res }) => {
    destroyAuthSession(parseCookies(req)[SESSION_COOKIE]);
    appendHeader(res, 'set-cookie', clearedSessionCookie());
    sendJson(res, 200, { ok: true });
  });

  route('PATCH', '/api/auth/password', async ({ req, res }) => {
    const user = requireUser(req);
    const body = await readJson(req);
    authenticate(user.email, body.current_password);
    changePassword(user.id, body.password);
    const token = createAuthSession(user.id, req.headers['user-agent']);
    appendHeader(res, 'set-cookie', sessionCookie(token));
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/auth/me', ({ req, res }) => {
    const user = currentUser(req);
    sendJson(res, 200, {
      user: publicUser(user),
      sites: user ? listSitesForUser(user.id).map(publicSite) : [],
      registration_open: config.openRegistration || userCount() === 0,
      needs_setup: userCount() === 0,
    });
  });

  // -------------------------------------------------------------- sites --

  route('GET', '/api/sites', ({ req, res }) => {
    const user = requireUser(req);
    sendJson(res, 200, { sites: listSitesForUser(user.id).map(publicSite) });
  });

  route('POST', '/api/sites', async ({ req, res }) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const site = createSite({
      domain: body.domain,
      timezone: body.timezone || 'UTC',
      currency: body.currency || 'EUR',
      userId: user.id,
    });
    sendJson(res, 201, { site: publicSite(site), snippet: snippetFor(req, site) });
  });

  route('GET', '/api/sites/:domain', ({ req, res, params }) => {
    const user = requireUser(req);
    const site = findSiteByDomain(normalizeDomain(params.domain));
    if (!site || !canAccess(user, site)) throw new HttpError(404, 'Site not found');
    sendJson(res, 200, {
      site: publicSite({ ...site, role: 'viewer' }),
      settings: {
        excluded_paths: site.excluded_paths,
        excluded_ips: site.excluded_ips,
      },
      goals: listGoals(site.id),
      funnels: listFunnels(site.id),
      shared_links: listSharedLinks(site.id),
      members: listMembers(site.id),
      suggested_goals: suggestGoals(site.id),
      snippet: snippetFor(req, site),
      data_range: siteDataRange(site.id),
    });
  });

  route('PATCH', '/api/sites/:domain', async ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    const body = await readJson(req);
    sendJson(res, 200, { site: publicSite(updateSite(site.id, body)) });
  });

  route('DELETE', '/api/sites/:domain', ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'owner');
    deleteSite(site.id);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/sites/:domain/members', async ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'owner');
    const body = await readJson(req);
    const invitee = get('SELECT * FROM users WHERE lower(email) = ?', [String(body.email || '').toLowerCase()]);
    if (!invitee) throw new HttpError(404, 'That person does not have a Credible account yet');
    addMember(site.id, invitee.id, body.role || 'viewer');
    sendJson(res, 200, { members: listMembers(site.id) });
  });

  // -------------------------------------------------------------- goals --

  route('POST', '/api/sites/:domain/goals', async ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    const goal = createGoal(site.id, await readJson(req));
    sendJson(res, 201, { goal });
  });

  route('DELETE', '/api/sites/:domain/goals/:id', ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    deleteGoal(site.id, Number(params.id));
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/sites/:domain/funnels', async ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    const body = await readJson(req);
    sendJson(res, 201, { funnel: createFunnel(site.id, { name: body.name, goalIds: body.goals || body.goalIds || [] }) });
  });

  route('DELETE', '/api/sites/:domain/funnels/:id', ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    deleteFunnel(site.id, Number(params.id));
    sendJson(res, 200, { ok: true });
  });

  // ------------------------------------------- segments and annotations --

  route('GET', '/api/sites/:domain/segments', ({ req, res, params, query }) => {
    const { site, user } = authorizeSite(req, query, normalizeDomain(params.domain));
    sendJson(res, 200, { segments: listSegments(site.id, user?.id ?? null) });
  });

  route('POST', '/api/sites/:domain/segments', async ({ req, res, params }) => {
    const { site, user } = requireOwnedSite(req, params.domain, 'viewer');
    sendJson(res, 201, { segment: createSegment(site.id, user.id, await readJson(req)) });
  });

  route('PATCH', '/api/sites/:domain/segments/:id', async ({ req, res, params }) => {
    const { site, user } = requireOwnedSite(req, params.domain, 'viewer');
    sendJson(res, 200, { segment: updateSegment(site.id, user.id, params.id, await readJson(req)) });
  });

  route('DELETE', '/api/sites/:domain/segments/:id', ({ req, res, params }) => {
    const { site, user } = requireOwnedSite(req, params.domain, 'viewer');
    deleteSegment(site.id, user.id, params.id);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/sites/:domain/annotations', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    sendJson(res, 200, { annotations: listAnnotations(site.id, { from: query.from, to: query.to }) });
  });

  route('POST', '/api/sites/:domain/annotations', async ({ req, res, params }) => {
    const { site, user } = requireOwnedSite(req, params.domain, 'viewer');
    sendJson(res, 201, { annotation: createAnnotation(site.id, user.id, await readJson(req)) });
  });

  route('DELETE', '/api/sites/:domain/annotations/:id', ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'viewer');
    deleteAnnotation(site.id, params.id);
    sendJson(res, 200, { ok: true });
  });

  // ------------------------------------------------------- shared links --

  route('POST', '/api/sites/:domain/shared-links', async ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    const body = await readJson(req);
    const slug = createSharedLink(site.id, body.name, body.password || '');
    sendJson(res, 201, { slug, url: `${originFor(req)}/share/${site.domain}?auth=${slug}` });
  });

  route('DELETE', '/api/sites/:domain/shared-links/:slug', ({ req, res, params }) => {
    const { site } = requireOwnedSite(req, params.domain, 'admin');
    deleteSharedLink(site.id, params.slug);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/shared/:slug/unlock', async ({ req, res, params }) => {
    const link = findSharedLink(params.slug);
    if (!link) throw new HttpError(404, 'Unknown link');
    const body = await readJson(req);
    if (!verifyPassword(body.password || '', link.password_hash)) throw new HttpError(401, 'Wrong password');
    appendHeader(
      res,
      'set-cookie',
      serializeCookie(`credible_shared_${params.slug}`, body.password, { maxAge: 86400 }),
    );
    sendJson(res, 200, { ok: true });
  });

  // ----------------------------------------------------------- api keys --

  route('GET', '/api/keys', ({ req, res }) => {
    const user = requireUser(req);
    sendJson(res, 200, { keys: listApiKeys(user.id) });
  });

  route('POST', '/api/keys', async ({ req, res }) => {
    const user = requireUser(req);
    const body = await readJson(req);
    sendJson(res, 201, { key: createApiKey(user.id, body.name || 'Stats API key') });
  });

  route('DELETE', '/api/keys/:id', ({ req, res, params }) => {
    const user = requireUser(req);
    deleteApiKey(user.id, Number(params.id));
    sendJson(res, 200, { ok: true });
  });

  // --------------------------------------------------------- dashboard --

  route('GET', '/api/stats/:domain/dashboard', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    const { scope, range, goals, timezone } = buildScope(site, query);
    const previous = comparisonScope(site, scope, query);

    const metrics = aggregate(scope);
    const comparison = previous ? aggregate(previous) : null;

    sendJson(res, 200, {
      site: publicSite(site),
      period: { ...range, timezone },
      metrics,
      comparison,
      changes: Object.fromEntries(
        Object.keys(metrics).map((key) => [key, changeFor(key, metrics[key], comparison?.[key] ?? null)]),
      ),
      timeseries: timeseries(scope, range.interval, timezone),
      comparison_timeseries: previous ? timeseries(previous, range.interval, timezone) : null,
      current_visitors: currentVisitors(site.id),
      panels: {
        channels: breakdown(scope, { dimension: 'visit:channel' }),
        sources: breakdown(scope, { dimension: 'visit:source' }),
        pages: pagesBreakdown(scope, {}),
        entry_pages: breakdown(scope, { dimension: 'visit:entry_page' }),
        countries: breakdown(scope, { dimension: 'visit:country' }),
        browsers: breakdown(scope, { dimension: 'visit:browser' }),
        goals: goalsBreakdown(scope, goals),
      },
      has_goals: goals.length > 0,
      property_keys: propertyKeys(scope),
      segments: listSegments(site.id, currentUser(req)?.id ?? null),
      annotations: listAnnotations(site.id, {
        from: formatYmd(range.start, timezone),
        to: formatYmd(range.end - 1, timezone),
      }),
    });
  });

  route('GET', '/api/stats/:domain/breakdown', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    const { scope, goals } = buildScope(site, query);
    const limit = intParam(query.limit, 9, 500);
    const offset = intParam(query.offset, 0, 100000);
    const dimension = query.dimension || 'event:page';

    if (dimension === 'event:goal') {
      sendJson(res, 200, goalsBreakdown(scope, goals));
      return;
    }
    if (dimension === 'event:page') {
      sendJson(res, 200, pagesBreakdown(scope, { limit, offset }));
      return;
    }
    if (dimension.startsWith('event:props:')) {
      sendJson(res, 200, propertyBreakdown(scope, dimension.slice('event:props:'.length), { limit, offset }));
      return;
    }
    sendJson(res, 200, breakdown(scope, { dimension, limit, offset }));
  });

  route('GET', '/api/stats/:domain/properties', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    const { scope } = buildScope(site, query);
    const keys = propertyKeys(scope);
    const key = query.key && keys.includes(query.key) ? query.key : keys[0];
    sendJson(res, 200, {
      keys,
      key: key || null,
      ...(key ? propertyBreakdown(scope, key, { limit: intParam(query.limit, 9, 500) }) : { results: [], hasMore: false }),
    });
  });

  route('GET', '/api/stats/:domain/funnels', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    sendJson(res, 200, { funnels: listFunnels(site.id) });
  });

  route('GET', '/api/stats/:domain/funnels/:id', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    const { scope } = buildScope(site, query);
    const funnel = get('SELECT * FROM funnels WHERE site_id = ? AND id = ?', [site.id, Number(params.id)]);
    if (!funnel) throw new HttpError(404, 'Funnel not found');
    sendJson(res, 200, funnelReport(scope, funnel, funnelSteps(funnel.id)));
  });

  route('GET', '/api/stats/:domain/realtime', ({ req, res, params, query }) => {
    const { site } = authorizeSite(req, query, normalizeDomain(params.domain));
    sendJson(res, 200, {
      visitors: currentVisitors(site.id),
      pages: realtimePages(site.id),
    });
  });

  // ------------------------------------------------------ public API v1 --

  const apiUser = (req) => {
    const user = userFromApiKey(req.headers.authorization);
    if (!user) throw new HttpError(401, 'Provide a valid API key: Authorization: Bearer <key>');
    return user;
  };

  const apiSite = (req, query) => {
    const user = apiUser(req);
    const domain = normalizeDomain(query.site_id || query.site || '');
    const site = findSiteByDomain(domain);
    if (!site || !canAccess(user, site)) throw new HttpError(404, 'Site not found');
    return site;
  };

  route('GET', '/api/v1/stats/aggregate', ({ req, res, query }) => {
    const site = apiSite(req, query);
    const { scope } = buildScope(site, query);
    const previous = comparisonScope(site, scope, query);
    const metrics = aggregate(scope);
    const comparison = previous ? aggregate(previous) : null;
    const requested = String(query.metrics || 'visitors,visits,pageviews,bounce_rate,visit_duration')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m in metrics);

    sendJson(res, 200, {
      results: Object.fromEntries(
        requested.map((metric) => [
          metric,
          {
            value: metrics[metric],
            ...(comparison ? { change: changeFor(metric, metrics[metric], comparison[metric]) } : {}),
          },
        ]),
      ),
    });
  });

  route('GET', '/api/v1/stats/timeseries', ({ req, res, query }) => {
    const site = apiSite(req, query);
    const { scope, range, timezone } = buildScope(site, query);
    const metric = query.metrics || 'visitors';
    sendJson(res, 200, {
      results: timeseries(scope, range.interval, timezone).map((row) => ({
        date: row.date,
        [metric]: row[metric] ?? row.visitors,
      })),
    });
  });

  route('GET', '/api/v1/stats/breakdown', ({ req, res, query }) => {
    const site = apiSite(req, query);
    const { scope, goals } = buildScope(site, query);
    const property = query.property || 'event:page';
    const limit = intParam(query.limit, 100, 1000);
    const page = Math.max(1, intParam(query.page, 1, 10000));
    const offset = (page - 1) * limit;

    const data =
      property === 'event:goal'
        ? goalsBreakdown(scope, goals)
        : property === 'event:page'
          ? pagesBreakdown(scope, { limit, offset })
          : property.startsWith('event:props:')
            ? propertyBreakdown(scope, property.slice('event:props:'.length), { limit, offset })
            : breakdown(scope, { dimension: property, limit, offset });

    sendJson(res, 200, { results: data.results.map((row) => ({ [property]: row.name, ...row })) });
  });

  route('GET', '/api/v1/stats/realtime/visitors', ({ req, res, query }) => {
    const site = apiSite(req, query);
    sendJson(res, 200, currentVisitors(site.id));
  });

  /**
   * Zero-touch setup: one call takes an instance from nothing to "ready to
   * install", and hands back the API key needed for everything after.
   *
   * This is the endpoint an AI assistant calls first. It is deliberately
   * idempotent-ish: pointing it at an account that already exists (with its
   * password, or a Bearer key) just adds the site and mints a fresh key.
   */
  route('POST', '/api/v1/provision', async ({ req, res }) => {
    if (!takeAuth(clientIp(req))) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const body = await readJson(req);

    const result = provision({
      email: body.email,
      password: body.password,
      name: body.name,
      domain: body.domain,
      timezone: body.timezone || 'UTC',
      currency: body.currency || 'EUR',
      keyName: body.key_name,
      user: userFromApiKey(req.headers.authorization),
    });

    const origin = originFor(req);
    sendJson(res, 201, {
      user: publicUser(result.user),
      password: result.password,
      api_key: result.apiKey,
      site: result.site ? publicSite(result.site) : null,
      snippet: result.site ? snippetFor(req, result.site) : null,
      instance_url: origin,
      dashboard_url: result.site ? `${origin}/${result.site.domain}` : origin,
      created: result.created,
      next_steps: nextSteps(origin, result.site),
    });
  });

  /** Server-side event tracking (mobile apps, backends, webhooks). */
  route('POST', '/api/v1/events', async ({ req, res }) => {
    apiUser(req);
    const body = await readJson(req);
    const result = recordEvent(body, {
      ip: body.ip || clientIp(req),
      userAgent: body.user_agent || req.headers['user-agent'] || '',
      headers: req.headers,
      timestamp: body.timestamp ? Math.floor(Number(body.timestamp)) : undefined,
    });
    sendJson(res, result.status === 'ok' ? 202 : 200, result);
  });

  // ------------------------------------------------------- agent brief --

  /**
   * A machine-readable "how to drive this instance" note, with this instance's
   * real origin baked in. An assistant can fetch it and get to work.
   */
  route('GET', '/llms.txt', ({ req, res }) => {
    const origin = originFor(req);
    const open = config.openRegistration || userCount() === 0;
    sendText(res, 200, agentBrief(origin, open), { 'cache-control': 'no-cache' });
  });

  // ---------------------------------------------------------- SPA shell --

  route('GET', '/share/:domain', ({ res }) => sendHtml(res, 'index.html'));

  // A page that exercises every tracker feature. Development only.
  if (config.dev) {
    route('GET', '/_demo', ({ res }) => {
      const body = readFileSync(new URL('../demo/site.html', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(body);
    });
  }
}

function requireOwnedSite(req, domain, role) {
  const user = requireUser(req);
  const site = findSiteByDomain(normalizeDomain(domain));
  if (!site) throw new HttpError(404, 'Site not found');
  if (!canAccess(user, site, role)) throw new HttpError(403, 'You do not have access to this site');
  return { user, site };
}

/** The text served at /llms.txt. Kept short enough to paste into a prompt. */
function agentBrief(origin, registrationOpen) {
  return `# Credible — ${origin}

Privacy-first web analytics. Everything below is doable over HTTP; the dashboard
is optional. Docs: https://github.com/maixmeduret/credible/blob/main/docs/AI-SETUP.md

## 1. Set up in one call${registrationOpen ? '' : '  (registration is CLOSED — you need an existing API key)'}

curl -X POST ${origin}/api/v1/provision \\
  -H 'content-type: application/json' \\
  -d '{"email":"you@example.com","domain":"example.com","timezone":"Europe/Paris"}'

Returns: api_key (use it for everything after), password (show it to the user
once, it is not recoverable), snippet, dashboard_url.

## 2. Install

Put the returned snippet in the <head> of every page:
<script defer data-domain="example.com" src="${origin}/js/cr.js"></script>

Options on that tag: data-hash, data-exclude, data-api, data-respect-dnt,
data-track-localhost (localhost is NOT counted without it), data-debug.

## 3. Verify

curl -H "Authorization: Bearer <key>" ${origin}/api/stats/example.com/realtime

## 4. Manage (all take Authorization: Bearer <key>)

POST   ${origin}/api/sites                          {"domain":"…","timezone":"…"}
GET    ${origin}/api/sites/example.com              site, goals, funnels, snippet
PATCH  ${origin}/api/sites/example.com              {"timezone":"…","excluded_paths":"/admin/*"}
POST   ${origin}/api/sites/example.com/goals        {"type":"event","event_name":"Signup"}
POST   ${origin}/api/sites/example.com/funnels      {"name":"…","goals":[1,2,3]}
POST   ${origin}/api/sites/example.com/shared-links {"name":"…"} -> public read-only URL

## 5. Read the numbers

GET ${origin}/api/v1/stats/aggregate?site_id=example.com&period=30d&metrics=visitors,pageviews,bounce_rate
GET ${origin}/api/v1/stats/breakdown?site_id=example.com&property=visit:source&period=7d
GET ${origin}/api/v1/stats/timeseries?site_id=example.com&period=30d
GET ${origin}/api/v1/stats/realtime/visitors?site_id=example.com

Periods: realtime day yesterday 7d 28d 30d 91d month last_month 6mo 12mo year all custom
Dimensions: event:page event:name event:goal event:props:<key> visit:channel visit:source
visit:referrer visit:utm_* visit:entry_page visit:exit_page visit:country visit:region
visit:city visit:browser visit:os visit:device visit:screen_size
Filters: ?filters=[["is","visit:country",["FR"]]]  (URL-encoded JSON)

## 6. Record an event server-side

POST ${origin}/api/v1/events  {"n":"Purchase","d":"example.com","u":"https://example.com/thanks","v":{"amount":39,"currency":"EUR"}}

## Rules for you, the assistant

- Never paste the API key or the password into a shared channel or commit them to a repo.
- Ask before making a dashboard public (POST /api/sites/:domain shared-links or "public": true).
- No cookies are set on visitors, so no consent banner is needed. Do not add one.
`;
}

/**
 * Behind a reverse proxy with CREDIBLE_TRUST_PROXY unset, every visitor arrives
 * with the proxy's IP: they all collapse into a single visitor id and share one
 * rate-limit bucket. Loud, once, because the symptom ("only 1 visitor ever") is
 * baffling until you know the cause.
 */
let proxyWarningShown = false;
function warnAboutUntrustedProxy(req) {
  if (proxyWarningShown || config.trustProxy) return;
  if (!req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip']) return;
  proxyWarningShown = true;
  log.warn(
    'Events are arriving with X-Forwarded-For but CREDIBLE_TRUST_PROXY is not set. ' +
      'Every visitor will be counted as the same person. Set CREDIBLE_TRUST_PROXY=true ' +
      'if a reverse proxy you control sits in front of Credible.',
  );
}

function snippetFor(req, site) {
  const origin = originFor(req);
  return `<script defer data-domain="${site.domain}" src="${origin}/js/cr.js"></script>`;
}
