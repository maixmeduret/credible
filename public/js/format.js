/** Number, duration and label formatting shared across the dashboard. */

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat();

/** 1234 -> "1.2K" for tight spaces. */
export function shortNumber(value) {
  const n = Number(value) || 0;
  return n < 1000 ? plain.format(n) : compact.format(n);
}

export function fullNumber(value) {
  return plain.format(Number(value) || 0);
}

export function percent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

export function decimal(value) {
  return (Number(value) || 0).toFixed(2);
}

/** 1438 -> "23m 58s" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function money(value, currency = 'EUR') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
      Number(value) || 0,
    );
  } catch {
    return `${Math.round(Number(value) || 0)} ${currency}`;
  }
}

let regionNames = null;
/** 'FR' -> 'France'. Falls back to the raw code on old browsers. */
export function countryName(code) {
  const value = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return code || 'Unknown';
  if (regionNames === null) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      regionNames = false;
    }
  }
  if (!regionNames) return value;
  try {
    return regionNames.of(value) || value;
  } catch {
    return value;
  }
}

/** 'FR' -> '🇫🇷' */
export function countryFlag(code) {
  const value = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return String.fromCodePoint(...[...value].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * A deterministic colour chip standing in for a favicon.
 * Credible never calls out to a third-party favicon service — that would leak
 * which sites a dashboard viewer is looking at.
 */
export function sourceBadge(name) {
  const label = String(name || '?').replace(/^www\./, '');
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const span = document.createElement('span');
  span.className = 'favicon';
  span.textContent = label[0] ? label[0].toUpperCase() : '?';
  span.style.cssText = `background:hsl(${hue} 55% 32%);color:hsl(${hue} 70% 88%);border-radius:4px;font-size:10px;font-weight:700;line-height:16px;text-align:center;`;
  return span;
}

export const METRICS = {
  visitors: { label: 'Unique visitors', short: 'Visitors', format: shortNumber, betterWhenUp: true },
  visits: { label: 'Total visits', short: 'Visits', format: shortNumber, betterWhenUp: true },
  pageviews: { label: 'Total pageviews', short: 'Pageviews', format: shortNumber, betterWhenUp: true },
  views_per_visit: { label: 'Views per visit', short: 'Views / visit', format: decimal, betterWhenUp: true },
  bounce_rate: { label: 'Bounce rate', short: 'Bounce rate', format: percent, betterWhenUp: false },
  visit_duration: { label: 'Visit duration', short: 'Duration', format: duration, betterWhenUp: true },
};

export const METRIC_ORDER = [
  'visitors',
  'visits',
  'pageviews',
  'views_per_visit',
  'bounce_rate',
  'visit_duration',
];
