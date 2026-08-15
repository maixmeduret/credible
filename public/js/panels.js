/**
 * The tabbed list panels (Sources, Pages, Locations, Devices, Behaviour).
 *
 * A panel owns its tabs, knows which key of the combined dashboard payload
 * pre-fills its default tab, and fetches lazily for every other tab. Clicking a
 * row adds a filter; the expand button opens the full list in a modal.
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
      wrapper.appendChild(await tab.custom({ ...ctx, payload, expanded: true }));
      return;
    }
    const expandedTab = { ...tab, columns: tab.expandedColumns || tab.columns || DEFAULT_COLUMNS };
    wrapper.appendChild(header(expandedTab));
    const data = await dataFor(tab, { limit: 100, force: true });
    wrapper.appendChild(
      data.results?.length ? rowsFor(expandedTab, data.results) : emptyState('No data for this period'),
    );
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
