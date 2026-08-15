/** Period presets, the ‹ › stepper and the date-range menu. */
import { h, popover } from './dom.js';

export const PERIODS = [
  { key: 'realtime', label: 'Realtime' },
  { key: 'day', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'Month to date' },
  { key: 'last_month', label: 'Last month' },
  { key: '91d', label: 'Last 3 months' },
  { key: 'year', label: 'Year to date' },
  { key: '12mo', label: 'Last 12 months' },
  { key: 'all', label: 'All time' },
];

export const COMPARISONS = [
  { key: 'off', label: 'No comparison' },
  { key: 'previous_period', label: 'Previous period' },
  { key: 'year_over_year', label: 'Year over year' },
];

const pad = (n) => String(n).padStart(2, '0');
const toYmd = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const fromYmd = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date();
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Human label for the current selection, e.g. "Last 30 days" or "12 – 18 Aug". */
export function periodLabel(query) {
  if (query.period === 'custom') {
    const from = fromYmd(query.from);
    const to = fromYmd(query.to);
    const sameMonth = from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear();
    if (query.from === query.to) return `${from.getUTCDate()} ${MONTHS[from.getUTCMonth()].slice(0, 3)} ${from.getUTCFullYear()}`;
    return sameMonth
      ? `${from.getUTCDate()} – ${to.getUTCDate()} ${MONTHS[to.getUTCMonth()].slice(0, 3)} ${to.getUTCFullYear()}`
      : `${from.getUTCDate()} ${MONTHS[from.getUTCMonth()].slice(0, 3)} – ${to.getUTCDate()} ${MONTHS[to.getUTCMonth()].slice(0, 3)}`;
  }

  const preset = PERIODS.find((p) => p.key === query.period);
  const base = preset ? preset.label : 'Last 30 days';
  if (!query.date) return base;

  // An anchored period is no longer "today" — name the anchor instead.
  const anchor = fromYmd(query.date);
  if (query.period === 'day') return `${anchor.getUTCDate()} ${MONTHS[anchor.getUTCMonth()].slice(0, 3)} ${anchor.getUTCFullYear()}`;
  if (query.period === 'month' || query.period === 'last_month') return `${MONTHS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;
  if (query.period === 'year') return String(anchor.getUTCFullYear());
  return `${base} to ${anchor.getUTCDate()} ${MONTHS[anchor.getUTCMonth()].slice(0, 3)}`;
}

/** True when the selection can be walked with the ‹ › buttons. */
export function isSteppable(period) {
  return ['day', 'yesterday', '7d', '28d', '30d', '91d', 'month', 'last_month', 'year', 'custom'].includes(period);
}

/**
 * Move the anchor date one period back (-1) or forward (+1).
 * Returns a new query object, or null when the move would land in the future.
 */
export function shiftPeriod(query, direction) {
  if (!isSteppable(query.period)) return null;
  const today = new Date();
  const todayYmd = toYmd(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));

  if (query.period === 'custom') {
    const from = fromYmd(query.from);
    const to = fromYmd(query.to);
    const span = Math.round((to - from) / 86400000) + 1;
    from.setUTCDate(from.getUTCDate() + direction * span);
    to.setUTCDate(to.getUTCDate() + direction * span);
    if (toYmd(from) > todayYmd) return null;
    return { ...query, from: toYmd(from), to: toYmd(to) };
  }

  const anchor = fromYmd(query.date || todayYmd);
  switch (query.period) {
    case 'day':
    case 'yesterday':
      anchor.setUTCDate(anchor.getUTCDate() + direction);
      break;
    case '7d':
      anchor.setUTCDate(anchor.getUTCDate() + direction * 7);
      break;
    case '28d':
      anchor.setUTCDate(anchor.getUTCDate() + direction * 28);
      break;
    case '30d':
      anchor.setUTCDate(anchor.getUTCDate() + direction * 30);
      break;
    case '91d':
      anchor.setUTCDate(anchor.getUTCDate() + direction * 91);
      break;
    case 'month':
    case 'last_month':
      anchor.setUTCMonth(anchor.getUTCMonth() + direction);
      break;
    case 'year':
      anchor.setUTCFullYear(anchor.getUTCFullYear() + direction);
      break;
    default:
      return null;
  }

  const next = toYmd(anchor);
  if (next > todayYmd) return null;
  return { ...query, date: next === todayYmd ? '' : next };
}

/** The dropdown behind the date button. */
export function openPeriodMenu(anchor, query, onChange) {
  const menu = h('div', {});
  let close = () => {};

  const choose = (patch) => {
    close();
    onChange({ ...query, date: '', from: '', to: '', ...patch });
  };

  menu.appendChild(h('div', { class: 'menu-label' }, 'Period'));
  for (const period of PERIODS) {
    menu.appendChild(
      h(
        'button',
        {
          class: query.period === period.key ? 'active' : '',
          onClick: () => choose({ period: period.key }),
        },
        period.label,
        query.period === period.key ? h('span', {}, '✓') : null,
      ),
    );
  }

  menu.appendChild(h('hr'));
  menu.appendChild(h('div', { class: 'menu-label' }, 'Custom range'));

  const today = new Date();
  const todayYmd = toYmd(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
  const fromInput = h('input', { type: 'date', value: query.from || todayYmd, max: todayYmd });
  const toInput = h('input', { type: 'date', value: query.to || todayYmd, max: todayYmd });
  menu.appendChild(
    h(
      'div',
      { style: { padding: '4px 10px 10px', display: 'grid', gap: '6px' } },
      h('div', { class: 'cols-2', style: { gap: '6px' } }, fromInput, toInput),
      h(
        'button',
        {
          class: 'btn primary',
          style: { justifyContent: 'center' },
          onClick: () => {
            if (!fromInput.value || !toInput.value) return;
            const [from, to] = fromInput.value <= toInput.value
              ? [fromInput.value, toInput.value]
              : [toInput.value, fromInput.value];
            choose({ period: 'custom', from, to });
          },
        },
        'Apply',
      ),
    ),
  );

  menu.appendChild(h('hr'));
  menu.appendChild(h('div', { class: 'menu-label' }, 'Compare with'));
  for (const comparison of COMPARISONS) {
    menu.appendChild(
      h(
        'button',
        {
          class: (query.comparison || 'previous_period') === comparison.key ? 'active' : '',
          onClick: () => {
            close();
            onChange({ ...query, comparison: comparison.key });
          },
        },
        comparison.label,
        (query.comparison || 'previous_period') === comparison.key ? h('span', {}, '✓') : null,
      ),
    );
  }

  close = popover(anchor, menu);
  return close;
}
