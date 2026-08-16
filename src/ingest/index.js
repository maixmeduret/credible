/**
 * The ingestion pipeline: one tracker beacon in, one row in `events` and one
 * created-or-extended row in `visits` out.
 *
 * Sessionisation happens here, at write time, rather than in the query path.
 * That is the single most important design decision in Credible: it makes
 * bounce rate, visit duration and entry/exit pages plain column reads instead
 * of self-joins over the whole event table.
 */
import { config } from '../config.js';
import { get, run, transaction } from '../db/index.js';
import { findSiteByDomain, isExcludedPath, shieldReason } from '../sites.js';
import { isBot } from './bots.js';
import { classifyReferrer, extractCampaign } from './referrer.js';
import { parseUserAgent, screenSizeBucket } from './useragent.js';
import { resolveGeo } from './geo.js';
import { visitorId } from './salt.js';

export const PAGEVIEW = 'pageview';
export const ENGAGEMENT = 'engagement';

const MAX_PROPS = 30;
const MAX_NAME = 120;
const MAX_PATH = 2000;

const str = (value, max = 255) => (value == null ? '' : String(value).slice(0, max));

/** Collapse duplicate slashes and drop a trailing slash (but keep the root). */
export function normalizePath(pathname) {
  let path = String(pathname || '/');
  try {
    path = decodeURI(path);
  } catch {
    /* keep the raw value if it is not valid percent-encoding */
  }
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!path.startsWith('/')) path = `/${path}`;
  return path.slice(0, MAX_PATH);
}

/** Custom event properties: flat, string values, bounded. */
export function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '';
  const out = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(props)) {
    if (count >= MAX_PROPS) break;
    const key = str(rawKey, 64).trim();
    if (!key) continue;
    if (rawValue == null || typeof rawValue === 'object') continue;
    const value = str(typeof rawValue === 'boolean' ? String(rawValue) : rawValue, 255).trim();
    if (!value) continue;
    out[key] = value;
    count += 1;
  }
  return count ? JSON.stringify(out) : '';
}

function parseRevenue(input, siteCurrency) {
  if (!input || typeof input !== 'object') return { revenue: null, currency: '' };
  const amount = Number(input.amount ?? input.a);
  if (!Number.isFinite(amount)) return { revenue: null, currency: '' };
  const currency = str(input.currency ?? input.c ?? siteCurrency, 3).toUpperCase();
  return { revenue: Math.round(amount * 100), currency: /^[A-Z]{3}$/.test(currency) ? currency : '' };
}

function ipExcluded(site, ip) {
  if (!site.excluded_ips || !ip) return false;
  return site.excluded_ips
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .includes(ip);
}

/**
 * @param {object} body   the tracker payload: { n, d, u, r, w, h, p, v, e }
 * @param {object} ctx    { ip, userAgent, headers, timestamp }
 * @returns {{status: 'ok'|'ignored', reason?: string, events?: number}}
 */
export function recordEvent(body, ctx = {}) {
  const userAgent = str(ctx.userAgent, 500);
  const timestamp = ctx.timestamp || Math.floor(Date.now() / 1000);

  const name = str(body?.n ?? body?.name, MAX_NAME).trim();
  if (!name) return { status: 'ignored', reason: 'missing event name' };
  if (isBot(userAgent)) return { status: 'ignored', reason: 'bot' };

  const rawUrl = str(body?.u ?? body?.url, 2400);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 'ignored', reason: 'invalid url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { status: 'ignored', reason: 'unsupported scheme' };
  }

  const domains = str(body?.d ?? body?.domain, 500)
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  if (!domains.length) return { status: 'ignored', reason: 'missing data-domain' };

  const hashMode = body?.h === 1 || body?.h === true;
  const pathname = normalizePath(url.pathname) + (hashMode ? url.hash : '');
  const hostname = str(url.hostname, 253).replace(/^www\./, '');

  const campaign = extractCampaign(url);
  const ua = parseUserAgent(userAgent);
  const screen = screenSizeBucket(Number(body?.w ?? body?.width));
  const geo = resolveGeo(ctx.ip, ctx.headers || {});
  const props = sanitizeProps(body?.p ?? body?.props);
  const engagement = body?.e && typeof body.e === 'object' ? body.e : null;
  const engagementTime = engagement ? Math.max(0, Math.min(Number(engagement.t) || 0, 30 * 60 * 1000)) : 0;
  const scrollDepth = engagement ? Math.max(0, Math.min(Math.round(Number(engagement.s) || 0), 100)) : 0;

  let written = 0;
  for (const domain of domains) {
    const site = findSiteByDomain(domain);
    if (!site) continue;
    if (isExcludedPath(site, pathname)) continue;
    if (ipExcluded(site, ctx.ip)) continue;
    if (shieldReason(site, { countryCode: geo.country_code, hostname })) continue;

    const acquisition = classifyReferrer({
      referrer: str(body?.r ?? body?.referrer, 1000),
      siteHost: site.domain,
      utm: campaign,
    });
    const money = parseRevenue(body?.v ?? body?.revenue, site.currency);
    // `ctx.visitorId` is only used by trusted internal callers (the demo seeder
    // and importers) which already know the visitor grouping. Requests coming
    // from the network never set it — they always go through the daily salt.
    const vid = ctx.visitorId || visitorId(site.id, ctx.ip, userAgent, timestamp);

    const dimensions = {
      channel: acquisition.channel,
      referrer_source: acquisition.source,
      referrer: acquisition.referrer,
      utm_source: str(campaign.source),
      utm_medium: str(campaign.medium),
      utm_campaign: str(campaign.campaign),
      utm_content: str(campaign.content),
      utm_term: str(campaign.term),
      country_code: geo.country_code,
      region: geo.region,
      city: geo.city,
      browser: ua.browser,
      browser_version: ua.browserVersion,
      os: ua.os,
      os_version: ua.osVersion,
      device: ua.device,
      screen_size: screen,
    };

    transaction(() => {
      const visit = attachToVisit({
        site,
        visitorId: vid,
        timestamp,
        name,
        pathname,
        dimensions,
      });

      // Acquisition, geography and device are *session* attributes: every event
      // in a visit is attributed to what brought the visitor in, not to the
      // internal referrer of the page they happen to be on. This is what makes
      // the Sources panel add up to the visitor count.
      Object.assign(dimensions, visit.dimensions);

      run(
        `INSERT INTO events (
           site_id, timestamp, name, visitor_id, visit_id, hostname, pathname,
           channel, referrer_source, referrer,
           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
           country_code, region, city,
           browser, browser_version, os, os_version, device, screen_size,
           props, revenue, currency, engagement_time, scroll_depth
         ) VALUES (?, ?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)`,
        [
          site.id, timestamp, name, vid, visit.id, hostname, pathname,
          dimensions.channel, dimensions.referrer_source, dimensions.referrer,
          dimensions.utm_source, dimensions.utm_medium, dimensions.utm_campaign,
          dimensions.utm_content, dimensions.utm_term,
          dimensions.country_code, dimensions.region, dimensions.city,
          dimensions.browser, dimensions.browser_version, dimensions.os,
          dimensions.os_version, dimensions.device, dimensions.screen_size,
          props, money.revenue, money.currency, engagementTime, scrollDepth,
        ],
      );
      written += 1;
    });
  }

  return written ? { status: 'ok', events: written } : { status: 'ignored', reason: 'unknown domain' };
}

/**
 * Find the visitor's open visit (or start one) and fold this event into it.
 * A visit closes after `inactivityTimeout` seconds without any event.
 */
function attachToVisit({ site, visitorId: vid, timestamp, name, pathname, dimensions }) {
  const isPageview = name === PAGEVIEW;
  const open = get(
    `SELECT id, started_at, pageviews,
            channel, referrer_source, referrer,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            country_code, region, city,
            browser, browser_version, os, os_version, device, screen_size
       FROM visits
      WHERE site_id = ? AND visitor_id = ? AND last_event_at >= ?
      ORDER BY last_event_at DESC LIMIT 1`,
    [site.id, vid, timestamp - config.inactivityTimeout],
  );

  if (!open) {
    const result = run(
      `INSERT INTO visits (
         site_id, visitor_id, started_at, last_event_at, duration,
         pageviews, events, is_bounce, entry_page, exit_page,
         channel, referrer_source, referrer,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         country_code, region, city,
         browser, browser_version, os, os_version, device, screen_size
       ) VALUES (?, ?, ?, ?, 0,  ?, 1, 1, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?, ?)`,
      [
        site.id, vid, timestamp, timestamp,
        isPageview ? 1 : 0, pathname, pathname,
        dimensions.channel, dimensions.referrer_source, dimensions.referrer,
        dimensions.utm_source, dimensions.utm_medium, dimensions.utm_campaign,
        dimensions.utm_content, dimensions.utm_term,
        dimensions.country_code, dimensions.region, dimensions.city,
        dimensions.browser, dimensions.browser_version, dimensions.os,
        dimensions.os_version, dimensions.device, dimensions.screen_size,
      ],
    );
    return { id: Number(result.lastInsertRowid), created: true, dimensions };
  }

  const pageviews = open.pageviews + (isPageview ? 1 : 0);
  run(
    `UPDATE visits
        SET last_event_at = max(last_event_at, ?),
            duration      = max(last_event_at, ?) - started_at,
            pageviews     = ?,
            events        = events + 1,
            is_bounce     = CASE WHEN ? > 1 THEN 0 ELSE is_bounce END,
            exit_page     = CASE WHEN ? THEN ? ELSE exit_page END
      WHERE id = ?`,
    [timestamp, timestamp, pageviews, pageviews, isPageview ? 1 : 0, pathname, open.id],
  );

  const { id, started_at: _started, pageviews: _pageviews, ...inherited } = open;
  return { id, created: false, dimensions: inherited };
}

/** Delete events and visits older than the configured retention window. */
export function enforceRetention(days = config.retentionDays) {
  if (!days) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const events = run('DELETE FROM events WHERE timestamp < ?', [cutoff]);
  run('DELETE FROM visits WHERE last_event_at < ?', [cutoff]);
  return Number(events.changes || 0);
}
