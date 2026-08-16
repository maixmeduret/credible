/**
 * The tabbed list panels (Sources, Pages, Locations, Devices, Behaviour).
 *
 * A panel owns its tabs, knows which key of the combined dashboard payload
 * pre-fills its default tab, and fetches lazily for every other tab. Clicking a
 * row adds a filter; the expand button opens the full list in a modal, where
 * every column can be sorted and the choice is remembered per tab.
 */
import { append, clear, h, icon, modal, replace } from './dom.js';
import {
  countryFlag,
  countryName,
  duration,
  percent,
  shortNumber,
  sourceBadge,
} from './format.js';

const DEFAULT_COLUMNS = [{ key: 'visitors', label: 'Visitors', format: shortNumber }];

/**
 * The sort chosen in an expanded report, kept per tab.
 *
 * Reading and writing are both guarded: localStorage throws outright in a
 * private window in some browsers, and a report that will not open is a worse
 * bug than a sort order that will not stick.
 */
const SORT_PREFIX = 'credible.sort.';

function readSort(tabId) {
  try {
    const raw = localStorage.getItem(SORT_PREFIX + tabId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.key === 'string' ? { key: parsed.key, dir: parsed.dir === 'asc' ? 'asc' : 'desc' } : null;
  } catch {
    return null;
  }
}

function writeSort(tabId, sort) {
  try {
    if (sort) localStorage.setItem(SORT_PREFIX + tabId, JSON.stringify(sort));
    else localStorage.removeItem(SORT_PREFIX + tabId);
  } catch {
    /* storage unavailable — the sort still applies for this session */
  }
}

/**
 * Sorting happens here rather than in the query: an expanded report is at most
 * a hundred rows the browser already has, and re-fetching to reorder them
 * would empty the modal for a round trip.
 */
function sortItems(items, sort) {
  if (!sort) return items;
  const direction = sort.dir === 'asc' ? 1 : -1;
  const value = (item) => {
    if (sort.key === 'name') return null;
    const n = Number(item[sort.key]);
    return Number.isFinite(n) ? n : null;
  };
  return items.slice().sort((a, b) => {
    if (sort.key === 'name') {
      return direction * String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { numeric: true });
    }
    const av = value(a);
    const bv = value(b);
    // Rows with no number for this column ("—") sit at the bottom either way.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return direction * (av - bv);
  });
}

/** How a row's label is decorated, per dimension. */
function decorate(dimension, name) {
  if (dimension === 'visit:country') {
    return [h('span', { class: 'flag' }, countryFlag(name)), countryName(name)];
  }
  if (dimension === 'visit:source' || dimension === 'visit:referrer') {
    return [sourceBadge(name), name];
  }
  if (dimension === 'visit:device' || dimension === 'visit:browser' || dimension === 'visit:os') {
    return [name];
  }
  return [name];
}

function emptyState(message) {
  return h('div', { class: 'empty' }, message);
}

const flip = (dir) => (dir === 'asc' ? 'desc' : 'asc');

/**
 * @param {object} spec  { tabs, defaultTab }
 *   tab = { id, label, dimension?, dataKey?, head?, columns?, custom? }
 * @param {object} ctx   { domain, getQuery, onFilter, api, onNeedsRefresh }
 */
export function createPanel(spec, ctx) {
  const tabsEl = h('div', { class: 'panel-tabs' });
  const bodyEl = h('div', { class: 'panel-body' });
  const el = h('section', { class: `card panel${spec.wide ? ' wide' : ''}` }, tabsEl, bodyEl);

  let active = spec.defaultTab || spec.tabs[0].id;
  let payload = null;
  const cache = new Map();

  const tabButtons = spec.tabs.map((tab) =>
    h(
      'button',
      {
        class: 'tab',
        type: 'button',
        onClick: () => {
          if (active === tab.id) return;
          active = tab.id;
          syncTabs();
          render();
        },
      },
      tab.label,
    ),
  );
  append(tabsEl, tabButtons);

  const expandBtn = h(
    'button',
    { class: 'btn ghost icon', type: 'button', title: 'Expand', onClick: () => openExpanded() },
    icon('expand', 15),
  );
  tabsEl.appendChild(h('div', { class: 'panel-tools' }, expandBtn));

  function syncTabs() {
    spec.tabs.forEach((tab, i) => tabButtons[i].classList.toggle('active', tab.id === active));
  }
  syncTabs();

  const currentTab = () => spec.tabs.find((tab) => tab.id === active) || spec.tabs[0];

  function rowsFor(tab, items, { limit } = {}) {
    const columns = tab.columns || DEFAULT_COLUMNS;
    const list = h('ul', { class: 'rows' });
    const max = Math.max(1, ...items.map((item) => Number(item[columns[0].key]) || 0));

    for (const item of items.slice(0, limit || items.length)) {
      const share = ((Number(item[columns[0].key]) || 0) / max) * 100;
      const label = h(
        'span',
        { class: 'row-label' },
        tab.dimension || tab.filterKey
          ? h(
              'button',
              {
                type: 'button',
                title: `Filter by ${item.name}`,
                onClick: () => ctx.onFilter(tab.filterKey || tab.dimension, item.name),
              },
              ...decorate(tab.dimension, item.name),
            )
          : h('span', {}, ...decorate(tab.dimension, item.name)),
      );

      list.appendChild(
        h(
          'li',
          { class: 'row', title: item.name },
          h('span', { class: 'bar', style: { width: `${Math.max(share, 1.5)}%` } }),
          label,
          ...columns.map((column, index) =>
            h(
              'span',
              { class: `row-value${index ? ' secondary' : ''}` },
              column.format(item[column.key], item),
            ),
          ),
        ),
      );
    }
    return list;
  }

  function header(tab) {
    const columns = tab.columns || DEFAULT_COLUMNS;
    return h(
      'div',
      { class: 'panel-head' },
      h('span', {}, tab.head || 'Name'),
      h('span', { class: 'cols' }, ...columns.map((column) => h('span', {}, column.label))),
    );
  }

  /** The same header, with every column a button that reorders the list. */
  function sortableHeader(tab, sort, onSort) {
    const columns = tab.columns || DEFAULT_COLUMNS;
    const cell = (key, label, fallbackDir) => {
      const active = sort && sort.key === key;
      const next = active && sort.dir === fallbackDir ? flip(fallbackDir) : fallbackDir;
      return h(
        'span',
        {},
        h(
          'button',
          {
            class: 'link-btn',
            type: 'button',
            'aria-label': `Sort by ${label}, ${next === 'asc' ? 'ascending' : 'descending'}`,
            onClick: () => onSort({ key, dir: next }),
          },
          label,
          active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '',
        ),
      );
    };

    return h(
      'div',
      { class: 'panel-head' },
      // Names read alphabetically, numbers read biggest-first.
      cell('name', tab.head || 'Name', 'asc'),
      h('span', { class: 'cols' }, ...columns.map((column) => cell(column.key, column.label, 'desc'))),
    );
  }

  async function dataFor(tab, { limit = 9, offset = 0, force = false } = {}) {
    if (!force && offset === 0 && tab.dataKey && payload?.panels?.[tab.dataKey]) {
      return payload.panels[tab.dataKey];
    }
    const cacheKey = `${tab.id}:${limit}:${offset}`;
    if (!force && cache.has(cacheKey)) return cache.get(cacheKey);
    const result = await ctx.api.breakdown(ctx.domain, {
      ...ctx.getQuery(),
      dimension: tab.dimension,
      limit,
      offset,
    });
    cache.set(cacheKey, result);
    return result;
  }

  async function render() {
    const tab = currentTab();
    clear(bodyEl);

    if (tab.custom) {
      try {
        bodyEl.appendChild(await tab.custom({ ...ctx, payload, panelEl: el }));
      } catch (err) {
        if (tab.id === active) bodyEl.appendChild(emptyState(err.message));
      }
      return;
    }

    bodyEl.appendChild(header(tab));
    const placeholder = h('div', { class: 'empty' }, '…');
    bodyEl.appendChild(placeholder);

    let data;
    try {
      data = await dataFor(tab);
    } catch (err) {
      replace(bodyEl, header(tab), emptyState(err.message));
      return;
    }
    if (tab.id !== active) return;

    const items = data.results || [];
    replace(bodyEl, header(tab));
    if (!items.length) {
      bodyEl.appendChild(emptyState(tab.emptyMessage || 'No data for this period'));
      return;
    }
    bodyEl.appendChild(rowsFor(tab, items));
    if (data.hasMore) {
      bodyEl.appendChild(
        h(
          'div',
          { class: 'panel-footer' },
          h('button', { class: 'link-btn', type: 'button', onClick: () => openExpanded() }, 'Show more'),
        ),
      );
    }
  }

  async function openExpanded() {
    const tab = currentTab();
    const wrapper = h('div', {});
    const close = modal(wrapper, { wide: true });
    wrapper.appendChild(
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
        h('h2', {}, tab.label),
        h('button', { class: 'btn ghost icon', type: 'button', onClick: () => close() }, icon('close', 16)),
      ),
    );

    if (tab.custom) {
      try {
        wrapper.appendChild(await tab.custom({ ...ctx, payload, expanded: true }));
      } catch (err) {
        wrapper.appendChild(emptyState(err.message));
      }
      return;
    }

    const expandedTab = { ...tab, columns: tab.expandedColumns || tab.columns || DEFAULT_COLUMNS };
    let sort = readSort(tab.id);
    // A fixed-height body means the header does not jump when the rows land.
    const body = h('div', { style: { minHeight: '240px', display: 'flex', flexDirection: 'column' } });
    let items = null;

    const paint = () => {
      clear(body);
      body.appendChild(
        sortableHeader(expandedTab, sort, (next) => {
          sort = next;
          writeSort(tab.id, next);
          paint();
        }),
      );
      if (items === null) {
        body.appendChild(emptyState('…'));
        return;
      }
      if (!items.length) {
        body.appendChild(emptyState('No data for this period'));
        return;
      }
      body.appendChild(rowsFor(expandedTab, sortItems(items, sort)));
    };

    wrapper.appendChild(body);
    paint();

    try {
      const data = await dataFor(tab, { limit: 100, force: true });
      items = data.results || [];
    } catch (err) {
      clear(body);
      body.appendChild(emptyState(err.message));
      return;
    }
    paint();
  }

  return {
    el,
    /** Called after every dashboard refresh. */
    update(next) {
      payload = next;
      cache.clear();
      render();
    },
  };
}

// --------------------------------------------------------- panel presets --

const pathColumns = [
  { key: 'visitors', label: 'Visitors', format: shortNumber },
];

const pathExpanded = [
  { key: 'visitors', label: 'Visitors', format: shortNumber },
  { key: 'pageviews', label: 'Pageviews', format: (v) => (v == null ? '—' : shortNumber(v)) },
  { key: 'time_on_page', label: 'Time on page', format: (v) => (v ? duration(v) : '—') },
  { key: 'scroll_depth', label: 'Scroll', format: (v) => (v ? percent(v) : '—') },
];

export const SOURCES_PANEL = {
  defaultTab: 'channels',
  tabs: [
    { id: 'channels', label: 'Channels', dimension: 'visit:channel', dataKey: 'channels', head: 'Channel' },
    { id: 'sources', label: 'Sources', dimension: 'visit:source', dataKey: 'sources', head: 'Source' },
    { id: 'campaigns', label: 'Campaigns', dimension: 'visit:utm_campaign', head: 'Campaign', emptyMessage: 'No campaign traffic yet. Tag your links with ?utm_campaign=…' },
    { id: 'referrers', label: 'Referrers', dimension: 'visit:referrer', head: 'Referrer' },
  ],
};

export const PAGES_PANEL = {
  defaultTab: 'pages',
  tabs: [
    { id: 'pages', label: 'Top pages', dimension: 'event:page', dataKey: 'pages', head: 'Page', columns: pathColumns, expandedColumns: pathExpanded },
    { id: 'entry', label: 'Entry pages', dimension: 'visit:entry_page', dataKey: 'entry_pages', head: 'Entry page' },
    { id: 'exit', label: 'Exit pages', dimension: 'visit:exit_page', head: 'Exit page' },
  ],
};

export const DEVICES_PANEL = {
  defaultTab: 'browsers',
  tabs: [
    { id: 'browsers', label: 'Browsers', dimension: 'visit:browser', dataKey: 'browsers', head: 'Browser' },
    { id: 'os', label: 'Operating systems', dimension: 'visit:os', head: 'Operating system' },
    { id: 'devices', label: 'Devices', dimension: 'visit:device', head: 'Device' },
    { id: 'sizes', label: 'Screen size', dimension: 'visit:screen_size', head: 'Screen size' },
  ],
};

export const GOALS_COLUMNS = [
  { key: 'uniques', label: 'Uniques', format: shortNumber },
  { key: 'total', label: 'Total', format: shortNumber },
  { key: 'cr', label: 'CR', format: (v) => `${v}%` },
];
