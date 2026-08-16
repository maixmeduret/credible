/**
 * The message bodies.
 *
 * Every renderer is a pure function returning `{ subject, text, html }`, so a
 * test can assert on the exact words that reach a mailbox and the scheduler
 * never has to care how a report is worded.
 *
 * Rules the HTML obeys, all of them forced by how email clients actually work:
 *   • inline CSS on every element, because Gmail strips <head> and most clients
 *     drop anything they do not recognise;
 *   • a 600px table layout — the only layout primitive that survives Outlook's
 *     Word rendering engine;
 *   • no external images, no web fonts, no JavaScript. Nothing in the message
 *     causes a network request when it is opened;
 *   • dark mode through a `prefers-color-scheme` block whose rules are marked
 *     !important (inline styles otherwise win), *plus* light defaults inline so
 *     a client that strips the <style> block still renders something readable.
 *
 * There is deliberately no tracking pixel and no link wrapping. Credible exists
 * because measuring people without their knowledge is not acceptable; opening
 * an email is not consent to be counted, and a product that says so on its
 * homepage cannot quietly do the opposite in its own newsletter. The text part
 * is written as a message in its own right, not as a stripped-down fallback,
 * for the same reason: a reader who blocks HTML should not be second class.
 */

// ---------------------------------------------------------------- palette --

// Light values live inline on the elements; the dark values are applied by the
// media query in `STYLE` below. Both sets come from the dashboard theme so the
// email and the app look like the same product.
const LIGHT = {
  page: '#f6f6f8',
  card: '#ffffff',
  border: '#e2e2e9',
  text: '#17171c',
  muted: '#6b6b78',
  chip: '#f1f1f5',
  accent: '#6b5cf6',
  up: '#0f7b52',
  down: '#c02626',
};

// Single quotes around the multi-word family, never double: this string is
// interpolated into `style="…"` attributes, and a double quote there ends the
// attribute — silently dropping every declaration after it.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const STYLE = `
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    @media (prefers-color-scheme: dark) {
      .cr-page { background:#0b0b0e !important; }
      .cr-card { background:#131318 !important; border-color:#26262e !important; }
      .cr-text { color:#e7e7ea !important; }
      .cr-muted { color:#8b8b96 !important; }
      .cr-line { border-color:#26262e !important; }
      .cr-chip { background:#1a1a21 !important; border-color:#26262e !important; }
      .cr-up { color:#34d399 !important; }
      .cr-down { color:#f87171 !important; }
      .cr-link { color:#9d8dff !important; }
    }
    @media (max-width:620px) {
      .cr-pad { padding-left:20px !important; padding-right:20px !important; }
      /* Stacking a two-column grid needs the table, the row *and* the cells to
         become blocks — a td on its own gets re-wrapped in an anonymous cell
         and stays side by side. */
      .cr-grid, .cr-grid tbody, .cr-grid tr { display:block !important; width:100% !important; }
      /* auto, not 100%: a cell keeps its padding and border outside the width,
         so a stacked 100% cell would hang past the card by exactly that much. */
      .cr-grid td { display:block !important; width:auto !important; margin:0 0 12px !important; }
      .cr-gap { display:none !important; }
    }`;

// ---------------------------------------------------------------- helpers --

/** Escape for HTML text and attribute values alike. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s) URLs are ever emitted. Reset and invitation links are built
 * from configuration, and a `javascript:` or `data:` href in an email is
 * either a mistake or an attack.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const NUMBER = new Intl.NumberFormat('en-US');

export const formatNumber = (value) => NUMBER.format(Math.round(Number(value) || 0));

/** "2m 14s" — the same shape the dashboard shows. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const percent = (value) => `${Math.round(Number(value) || 0)}%`;

/**
 * Change against the previous period.
 *
 * Rates are compared in percentage points — a bounce rate moving from 40% to
 * 44% is "+4 pts", never "+10%", which would be true and useless.
 *
 * @returns {{label: string, direction: 'up'|'down'|'flat'}}
 */
export function formatDelta(current, previous, { points = false } = {}) {
  const now = Number(current) || 0;
  const before = Number(previous);
  if (!Number.isFinite(before)) return { label: '', direction: 'flat' };

  if (points) {
    const diff = Math.round(now) - Math.round(before);
    if (diff === 0) return { label: 'no change', direction: 'flat' };
    return { label: `${diff > 0 ? '+' : '−'}${Math.abs(diff)} pts`, direction: diff > 0 ? 'up' : 'down' };
  }

  if (before === 0) return now === 0 ? { label: 'no change', direction: 'flat' } : { label: 'new', direction: 'up' };
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return { label: 'no change', direction: 'flat' };
  return { label: `${change > 0 ? '+' : '−'}${Math.abs(change)}%`, direction: change > 0 ? 'up' : 'down' };
}

/** A site may arrive as a row from the database or as a bare domain. */
const domainOf = (site) => String((site && typeof site === 'object' ? site.domain : site) ?? '').trim() || 'your site';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Turn a boundary into `{year, month, day}` without ever crossing a timezone.
 *
 * 'YYYY-MM-DD' is read literally — it is already expressed in the site's
 * timezone by the caller, and re-parsing it as an instant would shift the label
 * by a day for half the planet. Unix seconds and Date objects are read as UTC.
 */
function dateParts(value) {
  if (value == null || value === '') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * "4 – 10 August 2026", "28 July – 3 August 2026", "July 2026" for a whole
 * month. An explicit `period.label` always wins.
 *
 * @param {{label?: string, start?: string|number|Date, end?: string|number|Date}} period
 */
export function formatPeriod(period = {}) {
  if (period.label) return String(period.label);
  const start = dateParts(period.start);
  const end = dateParts(period.end);
  if (!start || !end) return start || end ? `${MONTH_NAMES[(start || end).month - 1]} ${(start || end).year}` : '';

  if (
    start.year === end.year &&
    start.month === end.month &&
    start.day === 1 &&
    end.day === daysInMonth(end.year, end.month)
  ) {
    return `${MONTH_NAMES[start.month - 1]} ${start.year}`;
  }
  if (start.year === end.year && start.month === end.month) {
    return `${start.day} – ${end.day} ${MONTH_NAMES[start.month - 1]} ${start.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${MONTH_NAMES[start.month - 1]} – ${end.day} ${MONTH_NAMES[end.month - 1]} ${start.year}`;
  }
  return `${start.day} ${MONTH_NAMES[start.month - 1]} ${start.year} – ${end.day} ${MONTH_NAMES[end.month - 1]} ${end.year}`;
}

/** Keep a page path or a source name from blowing out a 600px table. */
const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const padRight = (value, width) => {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
};

const padLeft = (value, width) => {
  const text = String(value ?? '');
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
};

/** The origin of the instance, for the footer, when the caller did not pass one. */
function resolveInstanceUrl({ instanceUrl, dashboardUrl, acceptUrl, resetUrl }) {
  const explicit = safeUrl(instanceUrl);
  if (explicit) return explicit.replace(/\/+$/, '');
  for (const candidate of [dashboardUrl, acceptUrl, resetUrl]) {
    const url = safeUrl(candidate);
    if (url) return new URL(url).origin;
  }
  return '';
}

// ----------------------------------------------------------- html pieces --

const METRICS = [
  { key: 'visitors', label: 'Unique visitors', format: formatNumber, points: false, goodWhenUp: true },
  { key: 'pageviews', label: 'Pageviews', format: formatNumber, points: false, goodWhenUp: true },
  { key: 'bounce_rate', label: 'Bounce rate', format: percent, points: true, goodWhenUp: false },
  { key: 'visit_duration', label: 'Visit duration', format: formatDuration, points: false, goodWhenUp: true },
];

function deltaColour(direction, goodWhenUp) {
  if (direction === 'flat') return { colour: LIGHT.muted, className: 'cr-muted' };
  const good = direction === 'up' ? goodWhenUp : !goodWhenUp;
  return good ? { colour: LIGHT.up, className: 'cr-up' } : { colour: LIGHT.down, className: 'cr-down' };
}

/** Two rows of two metric cells: readable at 600px and stacked on a phone. */
function metricsGrid(metrics = {}, comparison = null) {
  const cells = METRICS.map((metric) => {
    const value = metric.format(metrics[metric.key]);
    const delta = comparison ? formatDelta(metrics[metric.key], comparison[metric.key], { points: metric.points }) : null;
    const tone = delta ? deltaColour(delta.direction, metric.goodWhenUp) : null;
    return `
              <td class="cr-chip" width="50%" valign="top" style="width:50%;padding:14px 16px;background:${LIGHT.chip};border:1px solid ${LIGHT.border};border-radius:10px;">
                <div class="cr-muted" style="font:400 12px/1.4 ${FONT};color:${LIGHT.muted};text-transform:uppercase;letter-spacing:.04em;">${esc(metric.label)}</div>
                <div class="cr-text" style="font:700 26px/1.3 ${FONT};color:${LIGHT.text};padding-top:2px;">${esc(value)}</div>
                ${
                  delta && delta.label
                    ? `<div class="${tone.className}" style="font:600 13px/1.4 ${FONT};color:${tone.colour};">${esc(delta.label)}</div>`
                    : ''
                }
              </td>`;
  });

  const spacer = '<td class="cr-gap" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>';
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cr-grid" style="width:100%;border-collapse:separate;">
            <tr>${cells[0]}${spacer}${cells[1]}</tr>
            <tr><td class="cr-gap" colspan="3" height="12" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>${cells[2]}${spacer}${cells[3]}</tr>
          </table>`;
}

function sectionHeading(title) {
  return `
          <div class="cr-muted" style="font:700 12px/1.4 ${FONT};color:${LIGHT.muted};text-transform:uppercase;letter-spacing:.06em;padding:28px 0 8px;">${esc(title)}</div>`;
}

/**
 * A ranked list: name on the left, one number on the right, plus an optional
 * secondary number. Rows are separated by a rule rather than a background so
 * the table stays legible when a client forces its own colours.
 */
function rankedTable(rows) {
  if (!rows.length) return '';
  const body = rows
    .map(
      (row, index) => `
            <tr>
              <td class="cr-muted cr-line" width="24" style="width:24px;padding:9px 0;border-bottom:1px solid ${LIGHT.border};font:400 13px/1.4 ${FONT};color:${LIGHT.muted};">${index + 1}</td>
              <td class="cr-text cr-line" style="padding:9px 8px 9px 0;border-bottom:1px solid ${LIGHT.border};font:400 14px/1.4 ${FONT};color:${LIGHT.text};word-break:break-word;">${esc(row.name)}</td>
              <td class="cr-text cr-line" align="right" style="padding:9px 0;border-bottom:1px solid ${LIGHT.border};font:600 14px/1.4 ${FONT};color:${LIGHT.text};white-space:nowrap;">${esc(row.value)}</td>
              ${
                row.note
                  ? `<td class="cr-muted cr-line" align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${LIGHT.border};font:400 13px/1.4 ${FONT};color:${LIGHT.muted};white-space:nowrap;">${esc(row.note)}</td>`
                  : ''
              }
            </tr>`,
    )
    .join('');
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${body}
          </table>`;
}

function paragraph(text, { muted = false, top = 0 } = {}) {
  const colour = muted ? LIGHT.muted : LIGHT.text;
  return `
          <p class="${muted ? 'cr-muted' : 'cr-text'}" style="margin:${top}px 0 0;font:400 15px/1.6 ${FONT};color:${colour};">${text}</p>`;
}

function button(url, label) {
  const href = safeUrl(url);
  if (!href) return '';
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;">
            <tr>
              <td style="background:${LIGHT.accent};border-radius:8px;">
                <a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font:600 15px/1.2 ${FONT};color:#ffffff;text-decoration:none;">${esc(label)}</a>
              </td>
            </tr>
          </table>`;
}

const link = (url, label) => {
  const href = safeUrl(url);
  return href
    ? `<a class="cr-link" href="${esc(href)}" style="color:${LIGHT.accent};text-decoration:underline;">${esc(label || href)}</a>`
    : esc(label || '');
};

/**
 * The footer every message carries: where this instance lives, why the message
 * arrived, and how to stop it.
 *
 * Transactional mail gets an honest sentence instead of a dead unsubscribe
 * link — there is no list to leave when someone asked for a password reset.
 */
function footerLines({ instanceUrl, reason, unsubscribeUrl }) {
  const unsubscribe = safeUrl(unsubscribeUrl);
  return {
    instanceUrl,
    reason,
    unsubscribe,
    unsubscribeText: unsubscribe
      ? `Stop these emails: ${unsubscribe}`
      : 'This is a one-off message: you are not subscribed to anything, and nothing will follow it.',
  };
}

function footerHtml(footer) {
  const parts = [
    `Sent by Credible${footer.instanceUrl ? ` · ${link(footer.instanceUrl, footer.instanceUrl)}` : ''}`,
    esc(footer.reason),
    footer.unsubscribe
      ? `Stop these emails: ${link(footer.unsubscribe, footer.unsubscribe)}`
      : esc(footer.unsubscribeText),
    'No tracking pixel, no click tracking — this email counts nothing.',
  ].filter(Boolean);

  return `
          <div class="cr-line" style="border-top:1px solid ${LIGHT.border};margin-top:32px;"></div>
          <p class="cr-muted" style="margin:16px 0 0;font:400 12px/1.7 ${FONT};color:${LIGHT.muted};">${parts.join('<br>')}</p>`;
}

function footerText(footer) {
  return [
    '--',
    `Sent by Credible${footer.instanceUrl ? ` · ${footer.instanceUrl}` : ''}`,
    footer.reason,
    footer.unsubscribeText,
    'No tracking pixel, no click tracking — this email counts nothing.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The 600px shell. Everything above is content; this is the only place that
 * knows about <html>, and the only place that carries the dark-mode block.
 */
function shell({ title, eyebrow, heading, body, footer }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>${STYLE}
</style>
</head>
<body class="cr-page" style="margin:0;padding:0;background:${LIGHT.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cr-page" style="width:100%;background:${LIGHT.page};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="cr-card" style="width:100%;max-width:600px;background:${LIGHT.card};border:1px solid ${LIGHT.border};border-radius:12px;">
          <tr>
            <td class="cr-pad" style="padding:32px;">
              <div class="cr-muted" style="font:700 13px/1.4 ${FONT};color:${LIGHT.muted};letter-spacing:.02em;">
                <span style="color:${LIGHT.accent};">●</span> Credible${eyebrow ? ` · ${esc(eyebrow)}` : ''}
              </div>
              <h1 class="cr-text" style="margin:10px 0 0;font:700 22px/1.35 ${FONT};color:${LIGHT.text};">${esc(heading)}</h1>
${body}
${footerHtml(footer)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

// -------------------------------------------------------- traffic reports --

/**
 * @param {object} input
 * @param {object|string} input.site        site row, or the bare domain
 * @param {object} input.period             `{ label }` or `{ start, end }` as 'YYYY-MM-DD' in the site's timezone
 * @param {object} input.metrics            `aggregate()` output: visitors, pageviews, bounce_rate, visit_duration
 * @param {object|null} [input.comparison]  the same shape for the previous period
 * @param {Array}  [input.topPages]         `{ name, visitors, pageviews }`
 * @param {Array}  [input.topSources]       `{ name, visitors }`
 * @param {Array}  [input.goals]            `{ name, uniques, cr }`
 * @param {string} [input.dashboardUrl]
 * @param {string} [input.unsubscribeUrl]
 * @param {string} [input.instanceUrl]
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderWeeklyReport(input) {
  return trafficReport({ ...input, cadence: 'week' });
}

/** Same numbers, monthly framing — the comparison is against the month before. */
export function renderMonthlyReport(input) {
  return trafficReport({ ...input, cadence: 'month' });
}

function trafficReport({
  site,
  period = {},
  metrics = {},
  comparison = null,
  topPages = [],
  topSources = [],
  goals = [],
  dashboardUrl = '',
  unsubscribeUrl = '',
  instanceUrl = '',
  cadence = 'week',
}) {
  const domain = domainOf(site);
  const label = formatPeriod(period);
  const cadenceWord = cadence === 'month' ? 'Monthly' : 'Weekly';
  const previousWord = cadence === 'month' ? 'the previous month' : 'the previous week';
  const visitors = Math.round(Number(metrics.visitors) || 0);

  // The em dash is deliberate: it is also the cheapest possible check that the
  // RFC 2047 header encoder is doing its job on a real subject line.
  const subject = `${cadenceWord} report for ${domain}${label ? ` — ${label}` : ''}`;

  const footer = footerLines({
    instanceUrl: resolveInstanceUrl({ instanceUrl, dashboardUrl }),
    reason: `You receive this because ${cadence === 'month' ? 'monthly' : 'weekly'} reports are on for ${domain}.`,
    unsubscribeUrl,
  });

  const pages = topPages.slice(0, 5);
  const sources = topSources.slice(0, 5);
  const converted = goals.slice(0, 5);

  // ------------------------------------------------------------- text --
  const lines = [];
  lines.push(`${cadenceWord} report for ${domain}`);
  if (label) lines.push(label);
  lines.push('');

  if (visitors === 0) {
    lines.push(`No visitors were recorded for ${domain} during this period.`);
    lines.push('');
    lines.push('If that is a surprise, run `credible doctor` — the usual cause is');
    lines.push('a snippet that is missing, blocked, or pointing at another domain.');
  } else {
    for (const metric of METRICS) {
      const delta = comparison ? formatDelta(metrics[metric.key], comparison[metric.key], { points: metric.points }) : null;
      const suffix = delta && delta.label ? `  ${delta.label} vs ${previousWord}` : '';
      lines.push(`  ${padRight(metric.label, 18)}${padLeft(metric.format(metrics[metric.key]), 10)}${suffix}`);
    }
  }

  if (pages.length) {
    lines.push('');
    lines.push('Top pages');
    pages.forEach((page, index) => {
      lines.push(
        `  ${index + 1}. ${padRight(truncate(page.name, 38), 40)}${padLeft(formatNumber(page.visitors), 9)} visitors`,
      );
    });
  }

  if (sources.length) {
    lines.push('');
    lines.push('Top sources');
    sources.forEach((source, index) => {
      lines.push(
        `  ${index + 1}. ${padRight(truncate(source.name, 38), 40)}${padLeft(formatNumber(source.visitors), 9)} visitors`,
      );
    });
  }

  if (converted.length) {
    lines.push('');
    lines.push('Goals');
    converted.forEach((goal, index) => {
      const rate = goal.cr == null ? '' : `  ${Number(goal.cr).toFixed(1)}% CR`;
      lines.push(
        `  ${index + 1}. ${padRight(truncate(goal.name, 38), 40)}${padLeft(formatNumber(goal.uniques), 9)} conversions${rate}`,
      );
    });
  }

  const dashboard = safeUrl(dashboardUrl);
  if (dashboard) {
    lines.push('');
    lines.push(`Open the dashboard: ${dashboard}`);
  }
  lines.push('');
  lines.push(footerText(footer));

  // ------------------------------------------------------------- html --
  const blocks = [];
  blocks.push(
    paragraph(
      label
        ? `${esc(domain)} · ${esc(label)}`
        : esc(domain),
      { muted: true, top: 4 },
    ),
  );

  if (visitors === 0) {
    blocks.push(
      paragraph(
        `No visitors were recorded during this period. If that is a surprise, run <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">credible doctor</code> — the usual cause is a snippet that is missing, blocked, or pointing at another domain.`,
        { top: 20 },
      ),
    );
  } else {
    blocks.push(`\n          <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>${metricsGrid(metrics, comparison)}`);
    if (comparison) {
      blocks.push(paragraph(`Compared with ${esc(previousWord)}.`, { muted: true, top: 12 }));
    }
  }

  if (pages.length) {
    blocks.push(sectionHeading('Top pages'));
    blocks.push(
      rankedTable(
        pages.map((page) => ({
          name: truncate(page.name, 46),
          value: `${formatNumber(page.visitors)} visitors`,
          note: page.pageviews == null ? '' : `${formatNumber(page.pageviews)} views`,
        })),
      ),
    );
  }

  if (sources.length) {
    blocks.push(sectionHeading('Top sources'));
    blocks.push(
      rankedTable(sources.map((source) => ({ name: truncate(source.name, 46), value: `${formatNumber(source.visitors)} visitors` }))),
    );
  }

  if (converted.length) {
    blocks.push(sectionHeading('Goals'));
    blocks.push(
      rankedTable(
        converted.map((goal) => ({
          name: truncate(goal.name, 46),
          value: `${formatNumber(goal.uniques)} conversions`,
          note: goal.cr == null ? '' : `${Number(goal.cr).toFixed(1)}% CR`,
        })),
      ),
    );
  }

  blocks.push(button(dashboard, 'Open the dashboard'));

  return {
    subject,
    text: lines.join('\n'),
    html: shell({
      title: subject,
      eyebrow: cadence === 'month' ? 'monthly report' : 'weekly report',
      heading: `${cadenceWord} report for ${domain}`,
      body: blocks.filter(Boolean).join('\n'),
      footer,
    }),
  };
}

// ------------------------------------------------------------------ alerts --

/**
 * Traffic went above the threshold the site owner set.
 *
 * @param {object} input
 * @param {object|string} input.site
 * @param {number} input.current    visitors observed in the alert window
 * @param {number} input.threshold  the configured trigger
 * @param {string} [input.dashboardUrl]
 * @param {string} [input.window]   human label for the window, e.g. 'the last hour'
 * @param {string} [input.unsubscribeUrl]
 * @param {string} [input.instanceUrl]
 */
export function renderSpikeAlert({
  site,
  current,
  threshold,
  dashboardUrl = '',
  window = 'the last hour',
  unsubscribeUrl = '',
  instanceUrl = '',
}) {
  const domain = domainOf(site);
  const now = Math.round(Number(current) || 0);
  const trigger = Math.round(Number(threshold) || 0);
  const subject = `Traffic spike on ${domain} — ${formatNumber(now)} visitors`;

  const footer = footerLines({
    instanceUrl: resolveInstanceUrl({ instanceUrl, dashboardUrl }),
    reason: `You receive this because a spike alert above ${formatNumber(trigger)} visitors is set for ${domain}.`,
    unsubscribeUrl,
  });

  const sentence = `${domain} has ${formatNumber(now)} visitors in ${window}, above the ${formatNumber(trigger)} you set.`;
  const dashboard = safeUrl(dashboardUrl);

  const text = [
    `Traffic spike on ${domain}`,
    '',
    sentence,
    '',
    `  Visitors now       ${padLeft(formatNumber(now), 10)}`,
    `  Alert threshold    ${padLeft(formatNumber(trigger), 10)}`,
    '',
    'Something is sending you people right now. The referrers panel will say what.',
    ...(dashboard ? ['', `Open the dashboard: ${dashboard}`] : []),
    '',
    footerText(footer),
  ].join('\n');

  // Alerts carry two numbers, not the four-metric grid a report uses.
  const body = [
    paragraph(esc(sentence), { top: 16 }),
    `
          <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
          ${twoUp([
            { label: 'Visitors now', value: formatNumber(now), tone: 'up' },
            { label: 'Alert threshold', value: formatNumber(trigger), tone: 'muted' },
          ])}`,
    paragraph('Something is sending you people right now. The referrers panel will say what.', { muted: true, top: 16 }),
    button(dashboard, 'See who is on the site'),
  ];

  return {
    subject,
    text,
    html: shell({
      title: subject,
      eyebrow: 'traffic alert',
      heading: `Traffic spike on ${domain}`,
      body: body.filter(Boolean).join('\n'),
      footer,
    }),
  };
}

/**
 * Traffic fell below what this site normally does — usually the first sign
 * that the tracker stopped loading, not that the audience left.
 *
 * @param {object} input
 * @param {object|string} input.site
 * @param {number} input.current   visitors observed
 * @param {number} input.expected  the baseline it was compared against
 * @param {string} [input.dashboardUrl]
 * @param {string} [input.window]
 * @param {string} [input.unsubscribeUrl]
 * @param {string} [input.instanceUrl]
 */
export function renderDropAlert({
  site,
  current,
  expected,
  dashboardUrl = '',
  window = 'the last 24 hours',
  unsubscribeUrl = '',
  instanceUrl = '',
}) {
  const domain = domainOf(site);
  const now = Math.round(Number(current) || 0);
  const baseline = Math.round(Number(expected) || 0);
  const share = baseline > 0 ? Math.round((now / baseline) * 100) : 0;
  const subject = `Traffic drop on ${domain} — ${formatNumber(now)} visitors`;

  const footer = footerLines({
    instanceUrl: resolveInstanceUrl({ instanceUrl, dashboardUrl }),
    reason: `You receive this because a drop alert is set for ${domain}.`,
    unsubscribeUrl,
  });

  const sentence =
    `${domain} has ${formatNumber(now)} visitors in ${window}, against ${formatNumber(baseline)} expected` +
    `${baseline > 0 ? ` — ${share}% of normal` : ''}.`;
  const dashboard = safeUrl(dashboardUrl);

  const text = [
    `Traffic drop on ${domain}`,
    '',
    sentence,
    '',
    `  Visitors now       ${padLeft(formatNumber(now), 10)}`,
    `  Normally           ${padLeft(formatNumber(baseline), 10)}`,
    '',
    'A drop this size is more often a broken tracker than a lost audience.',
    'Worth checking, in order:',
    '  1. the site itself is up',
    '  2. the Credible snippet is still in <head> on every page',
    `  3. credible doctor --domain ${domain}`,
    ...(dashboard ? ['', `Open the dashboard: ${dashboard}`] : []),
    '',
    footerText(footer),
  ].join('\n');

  const body = [
    paragraph(esc(sentence), { top: 16 }),
    `
          <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
          ${twoUp([
            { label: 'Visitors now', value: formatNumber(now), tone: 'down' },
            { label: 'Normally', value: formatNumber(baseline), tone: 'muted' },
          ])}`,
    paragraph('A drop this size is more often a broken tracker than a lost audience. Worth checking, in order:', {
      top: 20,
    }),
    `
          <ol class="cr-text" style="margin:8px 0 0;padding-left:20px;font:400 15px/1.7 ${FONT};color:${LIGHT.text};">
            <li>the site itself is up</li>
            <li>the Credible snippet is still in &lt;head&gt; on every page</li>
            <li><code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">credible doctor --domain ${esc(domain)}</code></li>
          </ol>`,
    button(dashboard, 'Open the dashboard'),
  ];

  return {
    subject,
    text,
    html: shell({
      title: subject,
      eyebrow: 'traffic alert',
      heading: `Traffic drop on ${domain}`,
      body: body.filter(Boolean).join('\n'),
      footer,
    }),
  };
}

/** Two labelled numbers side by side, used by the alerts. */
function twoUp(cells) {
  const tones = { up: LIGHT.up, down: LIGHT.down, muted: LIGHT.text };
  const classes = { up: 'cr-up', down: 'cr-down', muted: 'cr-text' };
  const rendered = cells.map(
    (cell) => `
              <td class="cr-chip" width="50%" valign="top" style="width:50%;padding:14px 16px;background:${LIGHT.chip};border:1px solid ${LIGHT.border};border-radius:10px;">
                <div class="cr-muted" style="font:400 12px/1.4 ${FONT};color:${LIGHT.muted};text-transform:uppercase;letter-spacing:.04em;">${esc(cell.label)}</div>
                <div class="${classes[cell.tone] || 'cr-text'}" style="font:700 26px/1.3 ${FONT};color:${tones[cell.tone] || LIGHT.text};padding-top:2px;">${esc(cell.value)}</div>
              </td>`,
  );
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cr-grid" style="width:100%;border-collapse:separate;">
            <tr>${rendered[0]}<td class="cr-gap" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>${rendered[1]}</tr>
          </table>`;
}

// ----------------------------------------------------------- transactional --

/**
 * @param {object} input
 * @param {object|string} input.site
 * @param {string} input.inviter    the person's name or email
 * @param {string} input.acceptUrl
 * @param {string} [input.role]
 * @param {string} [input.instanceUrl]
 */
export function renderInvitation({ site, inviter, acceptUrl, role = '', instanceUrl = '' }) {
  const domain = domainOf(site);
  const who = String(inviter ?? '').trim() || 'Someone';
  const subject = `${who} invited you to ${domain} on Credible`;
  const accept = safeUrl(acceptUrl);

  const footer = footerLines({
    instanceUrl: resolveInstanceUrl({ instanceUrl, acceptUrl }),
    reason: 'You received this because someone entered your email address when inviting a teammate.',
    unsubscribeUrl: '',
  });

  const opening = `${who} invited you to see the analytics for ${domain}${role ? ` as ${role}` : ''}.`;

  const text = [
    subject,
    '',
    opening,
    '',
    'Credible is privacy-first web analytics: no cookies, no personal data, no',
    'cross-site profile of anyone who visits that site. The dashboard shows',
    'counts, not people.',
    ...(accept ? ['', 'Accept the invitation:', accept] : []),
    '',
    'If you were not expecting this, ignore it — nothing happens until you',
    'follow the link, and the invitation expires on its own.',
    '',
    footerText(footer),
  ].join('\n');

  const body = [
    paragraph(esc(opening), { top: 16 }),
    paragraph(
      'Credible is privacy-first web analytics: no cookies, no personal data, no cross-site profile of anyone who visits that site. The dashboard shows counts, not people.',
      { top: 14 },
    ),
    button(accept, 'Accept the invitation'),
    paragraph(
      'If you were not expecting this, ignore it — nothing happens until you follow the link, and the invitation expires on its own.',
      { muted: true, top: 20 },
    ),
  ];

  return {
    subject,
    text,
    html: shell({
      title: subject,
      eyebrow: 'invitation',
      heading: `${who} invited you to ${domain}`,
      body: body.filter(Boolean).join('\n'),
      footer,
    }),
  };
}

/**
 * @param {object} input
 * @param {object|string} input.user  user row, or a name/email
 * @param {string} input.resetUrl
 * @param {number} [input.expiresInMinutes]
 * @param {string} [input.instanceUrl]
 */
export function renderPasswordReset({ user, resetUrl, expiresInMinutes = 60, instanceUrl = '' }) {
  const name =
    (user && typeof user === 'object' ? user.name || user.email : user) || '';
  const greeting = String(name).trim() ? `Hi ${String(name).trim().split(/\s+/)[0]},` : 'Hi,';
  const subject = 'Reset your Credible password';
  const reset = safeUrl(resetUrl);
  const minutes = Math.max(1, Math.round(Number(expiresInMinutes) || 60));
  const validFor = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;

  const footer = footerLines({
    instanceUrl: resolveInstanceUrl({ instanceUrl, resetUrl }),
    reason: 'You received this because a password reset was requested for your account.',
    unsubscribeUrl: '',
  });

  const text = [
    subject,
    '',
    greeting,
    '',
    `Follow this link to choose a new password. It works once and expires in ${validFor}:`,
    ...(reset ? ['', reset] : []),
    '',
    'If you did not ask for this, nothing has changed and you can ignore this',
    'message — your current password still works. Only someone who can read',
    'this mailbox can use the link.',
    '',
    footerText(footer),
  ].join('\n');

  const body = [
    paragraph(esc(greeting), { top: 16 }),
    paragraph(`Follow this link to choose a new password. It works once and expires in ${esc(validFor)}.`, { top: 14 }),
    button(reset, 'Choose a new password'),
    paragraph(
      'If you did not ask for this, nothing has changed and you can ignore this message — your current password still works. Only someone who can read this mailbox can use the link.',
      { muted: true, top: 20 },
    ),
  ];

  return {
    subject,
    text,
    html: shell({
      title: subject,
      eyebrow: 'account',
      heading: 'Reset your password',
      body: body.filter(Boolean).join('\n'),
      footer,
    }),
  };
}
