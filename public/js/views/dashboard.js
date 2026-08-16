/**
 * The dashboard: one screen, every number.
 *
 * Structure mirrors what the product promises — a metric bar you can switch the
 * graph between, the graph itself, and a grid of tabbed panels. Clicking any
 * row anywhere adds a filter, and every filter applies to the whole page.
 */
import { append, clear, h, icon, modal, popover, replace, toast } from '../dom.js';
import {
  METRICS,
  METRIC_ORDER,
  countryName,
  fullNumber,
  shortNumber,
} from '../format.js';
import { openPeriodMenu, periodLabel, shiftPeriod, isSteppable } from '../dates.js';
import {
  DEVICES_PANEL,
  GOALS_COLUMNS,
  PAGES_PANEL,
  SOURCES_PANEL,
  createPanel,
} from '../panels.js';
import {
  createAnnotationLayer,
  createSegmentsControl,
  openAnnotationDialog,
  openAnnotationsDialog,
  segmentChip,
} from '../segments-ui.js';

const FILTER_LABELS = {
  'visit:channel': 'Channel',
  'visit:source': 'Source',
  'visit:referrer': 'Referrer',
  'visit:utm_campaign': 'Campaign',
  'visit:utm_source': 'UTM source',
  'visit:utm_medium': 'UTM medium',
  'event:page': 'Page',
  'visit:entry_page': 'Entry page',
  'visit:exit_page': 'Exit page',
  'visit:country': 'Country',
  'visit:region': 'Region',
  'visit:city': 'City',
  'visit:browser': 'Browser',
  'visit:os': 'Operating system',
  'visit:device': 'Device',
  'visit:screen_size': 'Screen size',
  'event:goal': 'Goal',
  'event:name': 'Event',
};

/** The keyboard map, in the order the ? dialog lists it. */
const SHORTCUTS = [
  ['?', 'Show this list'],
  ['D', 'Today'],
  ['W', 'Last 7 days'],
  ['M', 'Month to date'],
  ['Y', 'Year to date'],
  ['←  →', 'Step the period back and forward'],
  ['F', 'Open the filter menu'],
  ['S', 'Open the segments menu'],
  ['X', 'Clear every filter and segment'],
  ['Esc', 'Close the open menu or dialog'],
];

/** Which period each letter selects. */
const PERIOD_KEYS = { d: 'day', w: '7d', m: 'month', y: 'year' };

const EXPLORE_DIMENSIONS = [
  ['event:page', 'Page'],
  ['visit:entry_page', 'Entry page'],
  ['visit:exit_page', 'Exit page'],
  ['visit:channel', 'Channel'],
  ['visit:source', 'Source'],
  ['visit:referrer', 'Referrer'],
  ['visit:utm_campaign', 'Campaign'],
  ['visit:utm_medium', 'UTM medium'],
  ['visit:country', 'Country'],
  ['visit:region', 'Region'],
  ['visit:city', 'City'],
  ['visit:browser', 'Browser'],
  ['visit:browser_version', 'Browser version'],
  ['visit:os', 'Operating system'],
  ['visit:os_version', 'OS version'],
  ['visit:device', 'Device'],
  ['visit:screen_size', 'Screen size'],
  ['event:name', 'Event name'],
  ['event:hostname', 'Hostname'],
];

export async function renderDashboard(container, ctx) {
  const { api, domain, shared = false } = ctx;

  let query = { ...ctx.currentQuery() };
  // currentQuery() in app.js predates saved segments and does not carry
  // `segment` yet, so it is read straight off the URL. setQuery() writes back
  // every key it is handed, so the round trip already works; the day app.js
  // learns about segments this line quietly stops doing anything.
  if (query.segment == null) query.segment = new URLSearchParams(location.search).get('segment') || '';

  let data = null;
  let metric = localStorage.getItem('credible.metric') || 'visitors';
  if (!METRICS[metric]) metric = 'visitors';

  // ------------------------------------------------------------- skeleton --
  const liveEl = h('span', { class: 'live idle' }, h('span', { class: 'dot' }), '—');
  const dateBtn = h('button', { class: 'btn date-trigger', type: 'button' });
  const prevBtn = h('button', { class: 'btn icon', type: 'button', title: 'Previous period' }, icon('left', 15));
  const nextBtn = h('button', { class: 'btn icon', type: 'button', title: 'Next period' }, icon('right', 15));
  const filterBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('filter', 15), 'Filter');
  const moreBtn = h('button', { class: 'btn ghost icon', type: 'button', title: 'More' }, icon('more', 15));

  // Writing a segment or a note needs an account: a shared link may read them
  // but never create one, and the API says so with a 403 either way.
  const canEdit = !shared && Boolean(ctx.state.user);

  const segments = createSegmentsControl({
    domain,
    canEdit,
    getFilters: () => parseFilters(query.filters),
    getActiveId: () => query.segment,
    onApply: (id) => update({ segment: id }),
    onChanged: () => load(),
  });

  const siteButton = h(
    'button',
    { class: 'site-switcher', type: 'button' },
    icon('link', 15),
    domain,
    shared ? null : icon('chevron', 14),
  );

  const sitebar = h(
    'div',
    { class: 'sitebar' },
    siteButton,
    liveEl,
    h(
      'div',
      // Four controls no longer fit on one line at 375px, and .sitebar-right
      // does not wrap in the stylesheet — which this file may not edit.
      { class: 'sitebar-right', style: { flexWrap: 'wrap' } },
      segments.el,
      filterBtn,
      h('div', { class: 'stepper' }, dateBtn, prevBtn, nextBtn),
      shared ? null : moreBtn,
    ),
  );

  const filtersEl = h('div', { class: 'filters' });
  const metricsEl = h('section', { class: 'card metrics' });
  const chartHost = h('div', { class: 'chart-host' });
  const chartCard = h('section', { class: 'card chart-card' }, chartHost);
  const grid = h('div', { class: 'grid' });

  append(container, sitebar, filtersEl, metricsEl, chartCard, grid);

  const noteLayer = createAnnotationLayer({
    host: chartHost,
    canEdit,
    onAdd: (date) => openAnnotationDialog({ domain, date, onSaved: () => load() }),
    onOpen: (date) =>
      openAnnotationsDialog({
        domain,
        annotations: data?.annotations || [],
        canEdit,
        date,
        onChanged: () => load(),
      }),
  });

  // --------------------------------------------------------------- panels --
  const onFilter = (key, value) => {
    const filters = parseFilters(query.filters);
    // Only leaves can duplicate; a branch node has no values array to inspect.
    const already = filters.some(([, k, values]) => k === key && Array.isArray(values) && values.includes(value));
    if (already) return;
    filters.push(['is', key, [value]]);
    update({ filters: JSON.stringify(filters) });
  };

  const panelCtx = {
    api,
    domain,
    onFilter,
    getQuery: () => query,
  };

  const panels = [
    createPanel(SOURCES_PANEL, panelCtx),
    createPanel(PAGES_PANEL, panelCtx),
    createPanel(locationsPanel(panelCtx), panelCtx),
    createPanel(DEVICES_PANEL, panelCtx),
    createPanel(behaviourPanel(panelCtx, () => data), { ...panelCtx, wide: true }),
  ];
  panels.forEach((panel, index) => {
    if (index === 4) panel.el.classList.add('wide');
    grid.appendChild(panel.el);
  });

  // ------------------------------------------------------------- painting --
  function paintMetrics() {
    clear(metricsEl);
    for (const key of METRIC_ORDER) {
      const spec = METRICS[key];
      const value = data ? data.metrics[key] : 0;
      const change = data?.changes?.[key];
      const hasComparison = data?.comparison != null && change != null;
      const positive = spec.betterWhenUp ? change > 0 : change < 0;

      const button = h(
        'button',
        {
          class: `metric${key === metric ? ' selected' : ''}`,
          type: 'button',
          onClick: () => {
            metric = key;
            localStorage.setItem('credible.metric', key);
            paintMetrics();
            paintChart();
          },
        },
        h('span', { class: 'metric-label' }, spec.label),
        h(
          'span',
          { class: 'metric-row' },
          h('span', { class: 'metric-value' }, data ? spec.format(value) : '—'),
          hasComparison
            ? h(
                'span',
                { class: `metric-change ${change === 0 ? '' : positive ? 'up' : 'down'}` },
                `${change > 0 ? '↗' : change < 0 ? '↘' : '→'} ${Math.abs(change)}%`,
              )
            : null,
        ),
      );
      metricsEl.appendChild(button);
    }
  }

  let chartModule = null;
  async function paintChart() {
    if (!data) return;
    if (!chartModule) chartModule = await import('../chart.js');
    const spec = METRICS[metric];
    const points = data.timeseries.map((row) => ({ label: row.label, date: row.date, value: row[metric] ?? 0 }));
    const comparison = data.comparison_timeseries
      ? data.comparison_timeseries.map((row) => ({ label: row.label, value: row[metric] ?? 0 }))
      : null;

    const nowSeconds = Date.now() / 1000;
    let incompleteIndex = -1;
    for (let i = 0; i < data.timeseries.length; i += 1) {
      if (data.timeseries[i].end > nowSeconds) {
        incompleteIndex = i;
        break;
      }
    }

    chartModule.drawChart(chartHost, {
      points,
      comparison,
      metricLabel: spec.label,
      format: spec.format,
      incompleteIndex,
    });

    // drawChart() empties .chart-host, so the note markers are hung back up
    // afterwards, every time, and read their geometry off what it just drew.
    noteLayer.update({ points: data.timeseries, annotations: data.annotations || [] });
  }

  function paintFilters() {
    clear(filtersEl);
    const active = segments.active();
    const filters = parseFilters(query.filters);
    if (active) filtersEl.appendChild(segmentChip(active, () => update({ segment: '' })));

    filters.forEach(([operator, key, values], index) => {
      // A filter tree can also carry branch nodes — ["and", [...]], ["not", …],
      // ["has_done", …] — which arrive from a saved segment or the API and have
      // no dimension and no value list to print. They still deserve a chip that
      // can be removed, so summarise them instead of reaching into `values`.
      const isLeaf = Array.isArray(values) && typeof key === 'string';
      const label = isLeaf
        ? `${FILTER_LABELS[key] || key} ${operator === 'is' ? 'is' : operator.replace(/_/g, ' ')} `
        : `${operator.replace(/_/g, ' ')} `;
      const value = isLeaf
        ? (key === 'visit:country' ? values.map(countryName).join(', ') : values.join(', '))
        : 'grouped condition';

      filtersEl.appendChild(
        h(
          'span',
          { class: 'chip', title: isLeaf ? '' : JSON.stringify(filters[index]) },
          label,
          h('b', {}, value),
          h(
            'button',
            {
              type: 'button',
              title: 'Remove filter',
              onClick: () => {
                const next = parseFilters(query.filters);
                next.splice(index, 1);
                update({ filters: next.length ? JSON.stringify(next) : '' });
              },
            },
            '×',
          ),
        ),
      );
    });

    // One chip already carries its own ×; "Clear all" only earns its place once
    // there are two things to clear, and a segment counts as one of them.
    if (filters.length + (active ? 1 : 0) > 1) {
      filtersEl.appendChild(
        h('button', { class: 'link-btn', type: 'button', onClick: clearEverything }, 'Clear all'),
      );
    }
  }

  function clearEverything() {
    if (!query.filters && !query.segment) return;
    update({ filters: '', segment: '' });
  }

  function paintPeriod() {
    replace(dateBtn, icon('calendar', 15), h('span', {}, periodLabel(query)));
    const steppable = isSteppable(query.period);
    prevBtn.disabled = !steppable;
    nextBtn.disabled = !steppable || !shiftPeriod(query, 1);
  }

  function paintLive() {
    const count = data?.current_visitors || 0;
    liveEl.className = `live${count ? '' : ' idle'}`;
    replace(
      liveEl,
      h('span', { class: 'dot' }),
      `${fullNumber(count)} current visitor${count === 1 ? '' : 's'}`,
    );
  }

  // ---------------------------------------------------------------- wiring --
  dateBtn.addEventListener('click', () => openPeriodMenu(dateBtn, query, (next) => update(next)));
  prevBtn.addEventListener('click', () => {
    const next = shiftPeriod(query, -1);
    if (next) update(next);
  });
  nextBtn.addEventListener('click', () => {
    const next = shiftPeriod(query, 1);
    if (next) update(next);
  });
  filterBtn.addEventListener('click', () => openFilterMenu(filterBtn, query, update, api, domain));
  siteButton.addEventListener('click', () => {
    if (shared) return;
    const menu = h('div', {});
    menu.appendChild(h('div', { class: 'menu-label' }, 'Sites'));
    for (const site of ctx.state.sites) {
      menu.appendChild(
        h(
          'button',
          { type: 'button', class: site.domain === domain ? 'active' : '', onClick: () => { close(); ctx.navigate(`/${site.domain}`); } },
          site.domain,
        ),
      );
    }
    menu.appendChild(h('hr'));
    menu.appendChild(h('button', { type: 'button', onClick: () => { close(); ctx.navigate('/?new=1'); } }, 'Add a site'));
    const close = popover(siteButton, menu);
  });
  moreBtn.addEventListener('click', () => {
    const menu = h('div', {});
    const noteCount = data?.annotations?.length || 0;
    menu.append(
      h('button', { type: 'button', onClick: () => { close(); ctx.navigate(`/${domain}/settings`); } }, 'Site settings', icon('settings', 15)),
      h(
        'button',
        { type: 'button', onClick: () => { close(); openNotes(); } },
        'Notes on this period',
        h('span', { class: 'notice' }, String(noteCount)),
      ),
      h('button', { type: 'button', onClick: () => { close(); exportCsv(); } }, 'Export as CSV'),
      h('button', { type: 'button', onClick: () => { close(); shareDialog(ctx, domain); } }, 'Share dashboard'),
      h('hr'),
      h('button', { type: 'button', onClick: () => { close(); openShortcuts(); } }, 'Keyboard shortcuts', h('span', { class: 'notice' }, '?')),
    );
    const close = popover(moreBtn, menu);
  });

  function openNotes() {
    openAnnotationsDialog({
      domain,
      annotations: data?.annotations || [],
      canEdit,
      onChanged: () => load(),
    });
  }

  function exportCsv() {
    if (!data) return;
    const rows = [['date', ...METRIC_ORDER]];
    for (const row of data.timeseries) rows.push([row.date, ...METRIC_ORDER.map((key) => row[key])]);
    const csv = rows.map((row) => row.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = h('a', { href: url, download: `${domain}-${query.period}.csv` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Exported');
  }

  function update(patch) {
    query = { ...query, ...patch };
    ctx.setQuery(query);
    load();
  }

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    paintPeriod();
    paintFilters();
    try {
      const next = await api.dashboard(domain, query);
      if (token !== loadToken) return;
      data = next;
      segments.setSegments(data.segments);
      // The chip was drawn from the URL alone a moment ago; this is only the
      // real name arriving, so nothing moves.
      paintFilters();
      paintMetrics();
      paintLive();
      await paintChart();
      panels.forEach((panel) => panel.update(data));
    } catch (err) {
      if (token !== loadToken) return;
      if (err.status === 401 && shared) {
        promptSharedPassword(ctx, () => load());
        return;
      }
      clear(metricsEl);
      metricsEl.appendChild(h('div', { class: 'empty', style: { padding: '28px' } }, err.message));
    }
  }

  // ------------------------------------------------------------ shortcuts --

  /**
   * One global key handler for the whole dashboard.
   *
   * It stands down whenever the keystroke belongs to someone else: a field, the
   * chart (which walks its own buckets with the arrows), or an open menu or
   * dialog — those already close themselves on Escape, and a bare `d` should
   * not reshuffle the page behind them.
   */
  function onKeyDown(event) {
    if (!container.isConnected) {
      teardown();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    const tag = (target && target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.isContentEditable) return;
    if (target && typeof target.closest === 'function' && target.closest('.chart-host')) return;
    if (document.querySelector('.backdrop, .menu')) return;

    const key = event.key;
    if (key === '?') {
      event.preventDefault();
      openShortcuts();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const next = shiftPeriod(query, key === 'ArrowLeft' ? -1 : 1);
      if (!next) return;
      event.preventDefault();
      update(next);
      return;
    }

    const letter = key.length === 1 ? key.toLowerCase() : '';
    if (PERIOD_KEYS[letter]) {
      event.preventDefault();
      update({ period: PERIOD_KEYS[letter], date: '', from: '', to: '' });
      return;
    }
    if (letter === 'f') {
      event.preventDefault();
      filterBtn.focus();
      openFilterMenu(filterBtn, query, update, api, domain);
      return;
    }
    if (letter === 's') {
      event.preventDefault();
      segments.el.focus();
      segments.open();
      return;
    }
    if (letter === 'x') {
      event.preventDefault();
      clearEverything();
    }
  }

  let timer = null;
  function teardown() {
    if (timer) clearInterval(timer);
    document.removeEventListener('keydown', onKeyDown);
    noteLayer.destroy();
  }

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('popstate', teardown, { once: true });

  paintMetrics();
  paintPeriod();
  await load();

  timer = setInterval(async () => {
    // Navigating inside the app replaces the container without a popstate, so
    // the poller checks that it is still on screen before it costs a request.
    if (!container.isConnected) {
      teardown();
      return;
    }
    if (!document.hasFocus()) return;
    try {
      const realtime = await api.realtime(domain, { auth: query.auth });
      if (data) {
        data.current_visitors = realtime.visitors;
        paintLive();
      }
    } catch {
      /* transient */
    }
  }, 15000);
}

// --------------------------------------------------------------- helpers --

function parseFilters(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function openFilterMenu(anchor, query, update, api, domain) {
  const menu = h('div', {});
  menu.appendChild(h('div', { class: 'menu-label' }, 'Filter by'));
  const grid = h('div', { class: 'cols-2' });
  for (const [key, label] of EXPLORE_DIMENSIONS) {
    grid.appendChild(
      h(
        'button',
        {
          type: 'button',
          onClick: async () => {
            close();
            const data = await api.breakdown(domain, { ...query, dimension: key, limit: 100 });
            pickValue(label, key, data.results || [], (value) => {
              const filters = parseFilters(query.filters);
              filters.push(['is', key, [value]]);
              update({ filters: JSON.stringify(filters) });
            });
          },
        },
        label,
      ),
    );
  }
  menu.appendChild(grid);
  const close = popover(anchor, menu);
  // Opened with the keyboard, the menu has to take focus with it or the
  // shortcut leaves you looking at a list you cannot reach.
  const first = grid.querySelector('button');
  if (first) first.focus();
  return close;
}

/** The `?` dialog. */
function openShortcuts() {
  const body = h('div', {});
  const keyStyle = {
    display: 'inline-block',
    minWidth: '30px',
    padding: '2px 8px',
    textAlign: 'center',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--bg)',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: '12px',
  };

  body.append(
    h('h2', {}, 'Keyboard shortcuts'),
    h('p', { class: 'hint' }, 'They stay out of the way while you are typing in a field.'),
    h(
      'ul',
      { class: 'list' },
      ...SHORTCUTS.map(([key, description]) =>
        h('li', {}, h('span', { style: keyStyle }, key), h('span', { class: 'grow' }, description)),
      ),
    ),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, 'Close')),
  );
  const close = modal(body);
}

function pickValue(label, key, options, onPick) {
  const body = h('div', {});
  const search = h('input', { type: 'search', placeholder: `Search ${label.toLowerCase()}…` });
  const list = h('ul', { class: 'rows', style: { maxHeight: '50vh', overflow: 'auto' } });

  const draw = (term) => {
    clear(list);
    const filtered = options.filter((option) => String(option.name).toLowerCase().includes(term.toLowerCase()));
    if (!filtered.length) {
      list.appendChild(h('div', { class: 'empty' }, 'No matching value'));
      return;
    }
    for (const option of filtered.slice(0, 200)) {
      list.appendChild(
        h(
          'li',
          { class: 'row' },
          h(
            'span',
            { class: 'row-label' },
            h('button', { type: 'button', onClick: () => { close(); onPick(option.name); } },
              key === 'visit:country' ? countryName(option.name) : option.name),
          ),
          h('span', { class: 'row-value' }, shortNumber(option.visitors ?? option.uniques ?? 0)),
        ),
      );
    }
  };

  search.addEventListener('input', () => draw(search.value));
  body.append(h('h2', {}, `Filter by ${label.toLowerCase()}`), h('div', { class: 'field' }, search), list);
  const close = modal(body);
  draw('');
}

/** Locations panel: map + the three geographic breakdowns. */
function locationsPanel(panelCtx) {
  return {
    defaultTab: 'map',
    tabs: [
      {
        id: 'map',
        label: 'Map',
        custom: async () => {
          const host = h('div', { class: 'map-host' });
          const [{ drawMap }, data] = await Promise.all([
            import('../map.js'),
            panelCtx.api.breakdown(panelCtx.domain, {
              ...panelCtx.getQuery(),
              dimension: 'visit:country',
              limit: 300,
            }),
          ]);
          drawMap(host, {
            data: data.results || [],
            onSelect: (code) => panelCtx.onFilter('visit:country', code),
          });
          return host;
        },
      },
      { id: 'countries', label: 'Countries', dimension: 'visit:country', dataKey: 'countries', head: 'Country' },
      { id: 'regions', label: 'Regions', dimension: 'visit:region', head: 'Region' },
      { id: 'cities', label: 'Cities', dimension: 'visit:city', head: 'City' },
    ],
  };
}

/** Behaviour panel: goals, custom properties, funnels and free exploration. */
function behaviourPanel(panelCtx, getData) {
  return {
    defaultTab: 'goals',
    wide: true,
    tabs: [
      {
        id: 'goals',
        label: 'Goals',
        dimension: 'event:goal',
        filterKey: 'event:goal',
        dataKey: 'goals',
        head: 'Goal',
        columns: GOALS_COLUMNS,
        emptyMessage: 'No goals yet — add one in site settings to measure conversions.',
      },
      {
        id: 'properties',
        label: 'Properties',
        custom: async () => {
          const host = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column' } });
          const payload = await panelCtx.api.properties(panelCtx.domain, panelCtx.getQuery());
          if (!payload.keys.length) {
            host.appendChild(
              h('div', { class: 'empty' }, 'No custom properties yet. Send them with credible("Signup", { props: { plan: "pro" } }).'),
            );
            return host;
          }
          const select = h(
            'select',
            { style: { maxWidth: '220px', marginBottom: '8px' } },
            ...payload.keys.map((key) => h('option', { value: key, selected: key === payload.key }, key)),
          );
          const list = h('ul', { class: 'rows' });
          const draw = (results) => {
            clear(list);
            const max = Math.max(1, ...results.map((row) => row.visitors));
            for (const row of results) {
              list.appendChild(
                h(
                  'li',
                  { class: 'row' },
                  h('span', { class: 'bar', style: { width: `${(row.visitors / max) * 100}%` } }),
                  h('span', { class: 'row-label' }, row.name),
                  h('span', { class: 'row-value' }, shortNumber(row.visitors)),
                  h('span', { class: 'row-value secondary' }, shortNumber(row.events)),
                ),
              );
            }
          };
          select.addEventListener('change', async () => {
            const next = await panelCtx.api.properties(panelCtx.domain, { ...panelCtx.getQuery(), key: select.value });
            draw(next.results || []);
          });
          host.append(
            h('div', { class: 'field', style: { marginBottom: '4px' } }, select),
            h('div', { class: 'panel-head' }, h('span', {}, 'Value'), h('span', { class: 'cols' }, h('span', {}, 'Visitors'), h('span', {}, 'Events'))),
            list,
          );
          draw(payload.results || []);
          return host;
        },
      },
      {
        id: 'funnels',
        label: 'Funnels',
        custom: async () => {
          const host = h('div', { style: { flex: '1' } });
          const { funnels } = await panelCtx.api.funnels(panelCtx.domain, panelCtx.getQuery());
          if (!funnels.length) {
            host.appendChild(h('div', { class: 'empty' }, 'No funnels yet — create one from two or more goals in site settings.'));
            return host;
          }
          const select = h('select', {}, ...funnels.map((funnel) => h('option', { value: funnel.id }, funnel.name)));
          const body = h('div', { class: 'funnel-steps', style: { marginTop: '12px' } });
          const draw = async (id) => {
            clear(body);
            const report = await panelCtx.api.funnel(panelCtx.domain, id, panelCtx.getQuery());
            const first = report.steps[0]?.visitors || 1;
            for (const [index, step] of report.steps.entries()) {
              body.appendChild(
                h(
                  'div',
                  { class: 'funnel-step' },
                  h(
                    'div',
                    {},
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } },
                      h('span', {}, `${index + 1}. ${step.name}`),
                      h('span', { class: 'meta' }, `${fullNumber(step.visitors)} visitors · ${step.conversion_rate}%`),
                    ),
                    h('div', { class: 'funnel-bar', style: { width: `${Math.max(2, (step.visitors / first) * 100)}%` } }),
                  ),
                  h('span', { class: 'meta' }, index ? `−${fullNumber(step.dropoff)}` : ''),
                ),
              );
            }
            body.appendChild(
              h('p', { class: 'notice', style: { marginTop: '10px' } },
                `${report.completion_rate}% of the ${fullNumber(report.visitors)} visitors who entered completed the funnel.`),
            );
          };
          select.addEventListener('change', () => draw(select.value));
          host.append(h('div', { class: 'field', style: { maxWidth: '260px' } }, select), body);
          await draw(funnels[0].id);
          return host;
        },
      },
      {
        id: 'explore',
        label: 'Explore',
        custom: async () => {
          const host = h('div', { style: { flex: '1' } });
          const select = h(
            'select',
            {},
            ...EXPLORE_DIMENSIONS.map(([key, label]) => h('option', { value: key }, label)),
          );
          const list = h('ul', { class: 'rows' });
          const draw = async (dimension) => {
            clear(list);
            const result = await panelCtx.api.breakdown(panelCtx.domain, {
              ...panelCtx.getQuery(),
              dimension,
              limit: 20,
            });
            const results = result.results || [];
            if (!results.length) {
              list.appendChild(h('div', { class: 'empty' }, 'No data for this period'));
              return;
            }
            const max = Math.max(1, ...results.map((row) => row.visitors));
            for (const row of results) {
              list.appendChild(
                h(
                  'li',
                  { class: 'row' },
                  h('span', { class: 'bar', style: { width: `${(row.visitors / max) * 100}%` } }),
                  h(
                    'span',
                    { class: 'row-label' },
                    h('button', { type: 'button', onClick: () => panelCtx.onFilter(dimension, row.name) },
                      dimension === 'visit:country' ? countryName(row.name) : row.name),
                  ),
                  h('span', { class: 'row-value' }, shortNumber(row.visitors)),
                ),
              );
            }
          };
          select.addEventListener('change', () => draw(select.value));
          host.append(h('div', { class: 'field', style: { maxWidth: '260px' } }, select), list);
          await draw(EXPLORE_DIMENSIONS[0][0]);
          void getData;
          return host;
        },
      },
    ],
  };
}

function shareDialog(ctx, domain) {
  const body = h('div', {});
  const name = h('input', { type: 'text', placeholder: 'Marketing team' });
  const password = h('input', { type: 'password', placeholder: 'Optional password' });
  const output = h('div', {});
  body.append(
    h('h2', {}, 'Share this dashboard'),
    h('p', { class: 'hint' }, 'Anyone with the link sees a read-only version. No account needed.'),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'field' }, h('label', {}, 'Password'), password),
    output,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Close'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const { url } = await ctx.api.createSharedLink(domain, name.value, password.value);
            replace(output, h('pre', { class: 'snippet' }, url));
            try {
              await navigator.clipboard.writeText(url);
              toast('Link copied');
            } catch {
              /* clipboard unavailable */
            }
          },
        },
        'Create link',
      ),
    ),
  );
  const close = modal(body);
}

function promptSharedPassword(ctx, retry) {
  const slug = new URLSearchParams(location.search).get('auth');
  const body = h('form', {});
  const password = h('input', { type: 'password', required: true, placeholder: 'Password' });
  const error = h('p', { class: 'error', style: { display: 'none' } });
  body.append(
    h('h2', {}, 'This dashboard is protected'),
    h('p', { class: 'hint' }, 'Enter the password you were given.'),
    error,
    h('div', { class: 'field' }, password),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Unlock')),
  );
  const close = modal(body);
  body.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await ctx.api.unlockShared(slug, password.value);
      close();
      retry();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  };
}
