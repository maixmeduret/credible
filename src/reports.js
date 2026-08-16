/**
 * Scheduled email reports and traffic alerts.
 *
 * src/mail/ knows how to render and deliver a message; this module decides
 * which messages are owed and when. It is driven by the maintenance timer in
 * src/server.js, so a self-hosted instance needs no cron and no worker — the
 * one process it already runs is enough.
 */
import { all, get, run, now } from './db/index.js';
import { config, originFor } from './config.js';
import { HttpError } from './util/http.js';
import { log } from './util/log.js';
import { findSite, listAllSites } from './sites.js';
import { listGoals } from './goals.js';
import { Scope, aggregate, breakdown, currentVisitors, goalsBreakdown, pagesBreakdown } from './stats/index.js';
import { resolveRange, zonedParts } from './util/time.js';
import { mailConfigured } from './mail/index.js';
import { deliver, validateChannel } from './notify/index.js';
import {
  renderDropAlert,
  renderMonthlyReport,
  renderSpikeAlert,
  renderWeeklyReport,
} from './mail/render.js';

const FREQUENCIES = new Set(['weekly', 'monthly']);
const ALERT_TYPES = new Set(['spike', 'drop']);

// ------------------------------------------------------------------- CRUD --

export function listReports(siteId) {
  return all('SELECT * FROM email_reports WHERE site_id = ? ORDER BY id', [siteId]);
}

export function createReport(
  siteId,
  { frequency = 'weekly', recipients = '', send_hour = 9, channel = 'email', target = '' } = {},
) {
  if (!FREQUENCIES.has(frequency)) throw new HttpError(422, 'frequency must be weekly or monthly');
  validateChannel({ channel, target, recipients });
  assertDeliverable(channel);
  const hour = Math.min(23, Math.max(0, Number.parseInt(send_hour, 10) || 9));

  const result = run(
    'INSERT INTO email_reports (site_id, frequency, recipients, send_hour, channel, target, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    [siteId, frequency, String(recipients || ''), hour, channel, String(target || ''), now()],
  );
  return get('SELECT * FROM email_reports WHERE id = ?', [Number(result.lastInsertRowid)]);
}

/**
 * Refuse to create something that cannot possibly fire.
 *
 * Three independent testers hit the same trap: create an email report on an
 * instance with no SMTP configured, get 201 Created, tell the user "you will
 * get a digest every Monday" — and nothing ever arrives, with no error
 * anywhere. A 201 that means "accepted and silently discarded" is worse than a
 * refusal, so this is the refusal.
 */
function assertDeliverable(channel) {
  if (channel !== 'email') return; // ntfy and webhooks need no server-side setup
  if (mailConfigured()) return;
  throw new HttpError(
    422,
    'Email is not configured on this instance, so an email report would never be sent. ' +
      'Set CREDIBLE_SMTP_HOST and its companions, or use channel "ntfy" or "webhook", which need no server.',
  );
}

export function deleteReport(siteId, id) {
  run('DELETE FROM email_reports WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
}

export function listAlerts(siteId) {
  return all('SELECT * FROM alerts WHERE site_id = ? ORDER BY id', [siteId]);
}

export function createAlert(
  siteId,
  { type = 'spike', threshold = 10, recipients = '', cooldown_hours = 12, channel = 'email', target = '' } = {},
) {
  if (!ALERT_TYPES.has(type)) throw new HttpError(422, 'type must be spike or drop');
  validateChannel({ channel, target, recipients });
  assertDeliverable(channel);
  const value = Math.max(1, Number.parseInt(threshold, 10) || 10);

  const result = run(
    'INSERT INTO alerts (site_id, type, threshold, recipients, channel, target, enabled, cooldown_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    [
      siteId,
      type,
      value,
      String(recipients || ''),
      channel,
      String(target || ''),
      Math.max(1, Number.parseInt(cooldown_hours, 10) || 12),
      now(),
    ],
  );
  return get('SELECT * FROM alerts WHERE id = ?', [Number(result.lastInsertRowid)]);
}

export function deleteAlert(siteId, id) {
  run('DELETE FROM alerts WHERE site_id = ? AND id = ?', [siteId, Number(id)]);
}

// -------------------------------------------------------------- schedule --

/**
 * Is this report due?
 *
 * "Due" means: the local hour has arrived, the calendar boundary has passed
 * (Monday for weekly, the 1st for monthly), and we have not already sent one
 * this period. The last condition is what keeps a restart loop from mailing
 * somebody six copies of the same digest.
 */
export function reportIsDue(report, site, at = now()) {
  if (!report.enabled) return false;
  const tz = site.timezone || 'UTC';
  const local = zonedParts(at, tz);
  if (local.hour < report.send_hour) return false;

  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  if (report.frequency === 'weekly' && weekday !== 1) return false;
  if (report.frequency === 'monthly' && local.day !== 1) return false;

  if (!report.last_sent_at) return true;
  const minimumGap = report.frequency === 'monthly' ? 20 * 86400 : 5 * 86400;
  return at - report.last_sent_at >= minimumGap;
}

/** Build the numbers a digest talks about. */
function reportPayload(site, frequency) {
  const tz = site.timezone || 'UTC';
  const period = frequency === 'monthly' ? 'last_month' : '7d';
  const range = resolveRange({ period }, tz);
  const goals = listGoals(site.id);
  const scope = new Scope({ site, range, goals });

  const previousRange = { start: range.start - (range.end - range.start), end: range.start };
  const previous = new Scope({ site, range: previousRange, goals });

  return {
    site: site.domain,
    period: { ...range, timezone: tz },
    metrics: aggregate(scope),
    comparison: aggregate(previous),
    topPages: pagesBreakdown(scope, { limit: 5 }).results,
    topSources: breakdown(scope, { dimension: 'visit:source', limit: 5 }).results,
    goals: goalsBreakdown(scope, goals).results.slice(0, 5),
  };
}

/** Send every digest that is owed. Returns how many went out. */
export async function sendDueReports(at = now()) {
  let sent = 0;

  for (const site of listAllSites()) {
    for (const report of listReports(site.id)) {
      if (!reportIsDue(report, site, at)) continue;

      try {
        const payload = reportPayload(site, report.frequency);
        const dashboardUrl = `${originFor()}/${site.domain}`;
        const message =
          report.frequency === 'monthly'
            ? renderMonthlyReport({ ...payload, dashboardUrl, instanceUrl: originFor() })
            : renderWeeklyReport({ ...payload, dashboardUrl, instanceUrl: originFor() });

        await deliver(report, message, { dashboardUrl, kind: 'report', site: site.domain });
        run('UPDATE email_reports SET last_sent_at = ? WHERE id = ?', [at, report.id]);
        sent += 1;
      } catch (err) {
        // A failing report must never stop the others, and must never retry in
        // a tight loop: stamp it as attempted and let the next window try again.
        log.error(`Report ${report.id} for ${site.domain} failed:`, err.message);
        run('UPDATE email_reports SET last_sent_at = ? WHERE id = ?', [at, report.id]);
      }
    }
  }
  return sent;
}

/**
 * Fire traffic alerts.
 *
 * A spike is measured on the live visitor count, which is the number a person
 * would refresh the dashboard to see. A drop compares the last hour with the
 * same hour a week ago, because comparing with yesterday makes every Monday
 * morning look like an outage.
 */
export async function checkAlerts(at = now()) {
  let fired = 0;

  for (const site of listAllSites()) {
    for (const alert of listAlerts(site.id)) {
      if (!alert.enabled) continue;
      if (alert.last_fired_at && at - alert.last_fired_at < alert.cooldown_hours * 3600) continue;

      try {
        const message = alertMessage(site, alert, at);
        if (!message) continue;
        await deliver(alert, message, {
          dashboardUrl: `${originFor()}/${site.domain}`,
          kind: alert.type,
          site: site.domain,
        });
        run('UPDATE alerts SET last_fired_at = ? WHERE id = ?', [at, alert.id]);
        fired += 1;
      } catch (err) {
        log.error(`Alert ${alert.id} for ${site.domain} failed:`, err.message);
      }
    }
  }
  return fired;
}

function alertMessage(site, alert, at) {
  const dashboardUrl = `${originFor()}/${site.domain}`;

  if (alert.type === 'spike') {
    const current = currentVisitors(site.id);
    if (current < alert.threshold) return null;
    return renderSpikeAlert({
      site: site.domain,
      current,
      threshold: alert.threshold,
      dashboardUrl,
      window: 'right now',
      instanceUrl: originFor(),
    });
  }

  // Drop: this hour against the same hour last week.
  const hour = 3600;
  const current = countVisitors(site.id, at - hour, at);
  const expected = countVisitors(site.id, at - 7 * 86400 - hour, at - 7 * 86400);
  // Below the threshold percentage of last week's figure, and last week was
  // busy enough for the comparison to mean anything.
  if (expected < 10) return null;
  if (current > (expected * alert.threshold) / 100) return null;

  return renderDropAlert({
    site: site.domain,
    current,
    expected,
    dashboardUrl,
    window: 'the last hour',
    instanceUrl: originFor(),
  });
}

function countVisitors(siteId, from, to) {
  return Number(
    get('SELECT count(DISTINCT visitor_id) AS c FROM events WHERE site_id = ? AND timestamp >= ? AND timestamp < ?', [
      siteId,
      from,
      to,
    ])?.c || 0,
  );
}

/**
 * Send one report right now, ignoring the schedule.
 *
 * This is what makes a notification setup testable: configure a channel, run
 * it, and either the phone buzzes or you get an error naming the reason.
 * Waiting until Monday to discover a typo in the topic is not a plan.
 */
export async function sendReportNow(
  siteId,
  { frequency = 'weekly', channel = 'ntfy', target = '', recipients = '' } = {},
) {
  const site = findSite(siteId);
  if (!site) throw new HttpError(404, 'Site not found');
  validateChannel({ channel, target, recipients });

  const payload = reportPayload(site, frequency);
  const dashboardUrl = `${originFor()}/${site.domain}`;
  const message =
    frequency === 'monthly'
      ? renderMonthlyReport({ ...payload, dashboardUrl, instanceUrl: originFor() })
      : renderWeeklyReport({ ...payload, dashboardUrl, instanceUrl: originFor() });

  const result = await deliver({ channel, target, recipients }, message, {
    dashboardUrl,
    kind: 'report',
    site: site.domain,
  });
  return { site: site.domain, channel, subject: message.subject, result };
}

/**
 * One pass of both, called by the maintenance timer. Never throws.
 *
 * It no longer short-circuits on "email is not configured": ntfy and webhook
 * rows need no server-side setup at all, and skipping them because SMTP is
 * absent is precisely the silent failure this scheduler is meant not to have.
 */
export async function runScheduler(at = now()) {
  try {
    const reports = await sendDueReports(at);
    const alerts = await checkAlerts(at);
    if (reports || alerts) log.info(`Scheduler sent ${reports} report(s) and ${alerts} alert(s)`);
    return { reports, alerts, skipped: '' };
  } catch (err) {
    log.error('Scheduler failed:', err);
    return { reports: 0, alerts: 0, skipped: err.message };
  }
}

export { findSite, config };
