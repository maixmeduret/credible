/**
 * Credible — MAP tab: a world choropleth of visitors by country.
 *
 * Zero dependencies, plain ES module, no build step. The geometry comes from
 * the generated `world-map.js` module next to this file; everything here is
 * rendering, theming and interaction.
 *
 * Usage:
 *
 *   import { drawMap, destroyMap } from './map.js';
 *
 *   drawMap(el, {
 *     data: [{ name: 'FR', visitors: 1204 }, { name: 'US', visitors: 980 }],
 *     onSelect: function (code) { dashboard.filterByCountry(code); }
 *   });
 *
 * `drawMap` is idempotent: calling it again on the same container reuses the
 * SVG that is already there and only mutates the fills, so a live-updating
 * dashboard never rebuilds 174 paths.
 */

import { WORLD_VIEWBOX, COUNTRY_PATHS } from './world-map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Id of the one <style> element this module injects into the document. */
const STYLE_ID = 'credible-map-style';

/** Opacity ramp for countries that have data, applied on a square-root scale. */
const MIN_FILL_OPACITY = 0.18;
const MAX_FILL_OPACITY = 1;

/** Hairline widths, in device pixels (paths use a non-scaling stroke). */
const IDLE_STROKE_WIDTH = 0.5;
const HOVER_STROKE_WIDTH = 1.25;

/** Distance kept between the pointer and the tooltip, and between the tooltip and the container edge. */
const TOOLTIP_OFFSET = 14;
const TOOLTIP_EDGE_PAD = 6;

/** Per-container render state: { svg, paths, tooltip, ... }. Keyed weakly so detached containers are collectable. */
const mapStates = new WeakMap();

/** Locale used for country names and number formatting; `undefined` means the environment default. */
const LOCALE =
  typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language
    ? navigator.language
    : undefined;

const nameCache = new Map();
let displayNames;
let displayNamesReady = false;
let numberFormat;

/**
 * Stylesheet for the map. Injected once, at the very top of <head>, so that the
 * application's own stylesheet — which loads later — can override any of these
 * rules without needing higher specificity.
 */
const MAP_CSS = [
  '.credible-map{display:block;width:100%;height:100%;pointer-events:none}',
  // Only the country shapes are hit-testable; the background of the SVG is not.
  '.credible-map__country{pointer-events:auto;transition:fill-opacity 160ms ease}',
  '.credible-map__highlight{pointer-events:none}',
  '.map-tooltip{position:absolute;top:0;left:0;z-index:4;pointer-events:none;',
  'display:flex;align-items:baseline;gap:8px;white-space:nowrap;',
  'padding:6px 9px;border:1px solid var(--border);border-radius:8px;',
  'background:var(--panel-2);color:var(--text);',
  'font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
  'box-shadow:0 6px 20px rgba(0,0,0,.45);',
  'opacity:0;visibility:hidden;transition:opacity 120ms ease}',
  '.map-tooltip.is-visible{opacity:1;visibility:visible}',
  '.map-tooltip__name{font-weight:600}',
  '.map-tooltip__value{color:var(--muted);font-variant-numeric:tabular-nums}',
  '@media (prefers-reduced-motion:reduce){',
  '.credible-map__country,.map-tooltip{transition:none}}'
].join('');

/**
 * Turn an ISO 3166-1 alpha-2 code into a localized country name.
 * Falls back to the raw code whenever Intl cannot resolve it.
 *
 * @param {string} code Country code, e.g. 'FR'.
 * @returns {string} e.g. 'France'.
 */
export function countryName(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return typeof code === 'string' ? code : '';
  const cached = nameCache.get(normalized);
  if (cached !== undefined) return cached;

  let label = normalized;
  if (!displayNamesReady) {
    displayNamesReady = true;
    try {
      displayNames = new Intl.DisplayNames(LOCALE ? [LOCALE] : undefined, { type: 'region' });
    } catch (error) {
      displayNames = undefined;
    }
  }
  if (displayNames) {
    try {
      const resolved = displayNames.of(normalized);
      if (typeof resolved === 'string' && resolved) label = resolved;
    } catch (error) {
      label = normalized;
    }
  }
  nameCache.set(normalized, label);
  return label;
}

/**
 * Turn an ISO 3166-1 alpha-2 code into its flag emoji, built from the two
 * matching regional indicator symbols.
 *
 * @param {string} code Country code, e.g. 'FR'.
 * @returns {string} e.g. '🇫🇷', or '' when the code is not two ASCII letters.
 */
export function countryFlag(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return '';
  const base = 0x1f1e6; // REGIONAL INDICATOR SYMBOL LETTER A
  return String.fromCodePoint(
    base + (normalized.charCodeAt(0) - 65),
    base + (normalized.charCodeAt(1) - 65)
  );
}

/**
 * Draw — or update — the choropleth inside `container`.
 *
 * Countries without data are painted with the panel colour; countries with
 * data are painted with the accent colour at an opacity taken from a
 * square-root scale of visitors/maxVisitors, so a single dominant country
 * does not flatten everything else to invisibility.
 *
 * Accessibility: the SVG is exposed as a single image (role="img") labelled
 * with the three busiest countries. Individual shapes are therefore not
 * keyboard stops — keyboard users pick a country from the dashboard's
 * countries table, which drives the same filter as `onSelect`.
 *
 * @param {HTMLElement} container Element the map is rendered into.
 * @param {object} options
 * @param {Array<{name:string, visitors:number}>} options.data name = ISO alpha-2 country code.
 * @param {(code:string)=>void} [options.onSelect] Called with the code of a clicked country.
 * @returns {void}
 */
export function drawMap(container, options) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('drawMap: container must be an element');
  }
  const config = options || {};
  const values = aggregate(config.data);

  injectStyle(container);

  let state = mapStates.get(container);
  // Rebuild if the container was never drawn, or if something outside this
  // module emptied or re-parented it.
  if (!state || state.svg.parentNode !== container) {
    if (state) teardown(container, state);
    state = createState(container);
    mapStates.set(container, state);
  }

  state.values = values;
  state.onSelect = typeof config.onSelect === 'function' ? config.onSelect : null;
  state.svg.style.cursor = state.onSelect ? 'pointer' : 'default';

  paint(state);
  state.svg.setAttribute('aria-label', buildAriaLabel(values));
  hideTooltip(state);
}

/**
 * Remove the map from `container`: drops the SVG, the tooltip and every
 * listener this module attached. Safe to call on a container that was never
 * drawn into.
 *
 * @param {HTMLElement} container
 * @returns {void}
 */
export function destroyMap(container) {
  if (!container) return;
  const state = mapStates.get(container);
  if (!state) return;
  teardown(container, state);
  mapStates.delete(container);
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} code
 * @returns {string} Upper-cased two-letter code, or '' when invalid.
 */
function normalizeCode(code) {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : '';
}

/**
 * Format a visitor count with the environment's grouping separators.
 *
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  if (!numberFormat) {
    try {
      numberFormat = new Intl.NumberFormat(LOCALE ? [LOCALE] : undefined);
    } catch (error) {
      numberFormat = { format: (n) => String(n) };
    }
  }
  return numberFormat.format(value);
}

/**
 * Collapse the incoming rows into a `code -> visitors` map, summing duplicates
 * and dropping anything that is not a drawable country with a positive count.
 *
 * @param {Array<{name:string, visitors:number}>|undefined} data
 * @returns {Map<string, number>}
 */
function aggregate(data) {
  const values = new Map();
  if (!Array.isArray(data)) return values;
  for (const row of data) {
    if (!row) continue;
    const code = normalizeCode(row.name);
    if (!code || !Object.prototype.hasOwnProperty.call(COUNTRY_PATHS, code)) continue;
    const visitors = Number(row.visitors);
    if (!Number.isFinite(visitors) || visitors <= 0) continue;
    values.set(code, (values.get(code) || 0) + visitors);
  }
  return values;
}

/**
 * Opacity for a country, on a square-root scale of its share of the busiest
 * country, mapped onto [MIN_FILL_OPACITY, MAX_FILL_OPACITY].
 *
 * @param {number} visitors
 * @param {number} max
 * @returns {number}
 */
function fillOpacity(visitors, max) {
  if (!(visitors > 0) || !(max > 0)) return MIN_FILL_OPACITY;
  const ratio = Math.min(1, visitors / max);
  const opacity = MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * Math.sqrt(ratio);
  return Math.round(opacity * 1000) / 1000;
}

/**
 * Inject the map stylesheet once per document, ahead of the application's own
 * stylesheet so the app can override it.
 *
 * @param {HTMLElement} container
 * @returns {void}
 */
function injectStyle(container) {
  const doc = container.ownerDocument;
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MAP_CSS;
  const head = doc.head || doc.documentElement;
  head.insertBefore(style, head.firstChild);
}

/**
 * Build the SVG, the country paths, the highlight overlay and the tooltip, and
 * wire up the (delegated) pointer listeners.
 *
 * @param {HTMLElement} container
 * @returns {object} The freshly created state.
 */
function createState(container) {
  const doc = container.ownerDocument;

  // The tooltip is absolutely positioned against the container, so the
  // container has to be a containing block. Note that getComputedStyle returns
  // '' for a detached element — and callers do build the map before inserting
  // it — so an empty answer counts as "not positioned yet".
  const inlinePosition = container.style.position;
  if (!inlinePosition || inlinePosition === 'static') {
    let computed = '';
    if (doc.defaultView) {
      try {
        computed = doc.defaultView.getComputedStyle(container).position;
      } catch (error) {
        computed = '';
      }
    }
    if (!computed || computed === 'static') container.style.position = 'relative';
  }

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'credible-map');
  svg.setAttribute('viewBox', WORLD_VIEWBOX);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-label', 'World map of visitors by country');

  const paths = new Map();
  const codes = Object.keys(COUNTRY_PATHS).sort();
  const fragment = doc.createDocumentFragment();
  for (const code of codes) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'credible-map__country');
    path.setAttribute('d', COUNTRY_PATHS[code]);
    // Multi-landmass countries concatenate their subpaths, so interior holes
    // (Lesotho inside South Africa) need the even-odd rule.
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('data-code', code);
    path.style.stroke = 'var(--border)';
    path.style.strokeWidth = String(IDLE_STROKE_WIDTH);
    fragment.appendChild(path);
    paths.set(code, path);
  }

  // One overlay path re-used for the hover outline: drawn last, so the raised
  // stroke is never clipped by a neighbouring country painted on top of it.
  const highlight = doc.createElementNS(SVG_NS, 'path');
  highlight.setAttribute('class', 'credible-map__highlight');
  highlight.setAttribute('fill', 'none');
  highlight.setAttribute('fill-rule', 'evenodd');
  highlight.setAttribute('vector-effect', 'non-scaling-stroke');
  highlight.setAttribute('stroke-linejoin', 'round');
  highlight.style.stroke = 'var(--text)';
  highlight.style.strokeWidth = String(HOVER_STROKE_WIDTH);
  fragment.appendChild(highlight);

  svg.appendChild(fragment);

  const tooltip = doc.createElement('div');
  tooltip.className = 'map-tooltip';
  tooltip.setAttribute('aria-hidden', 'true');
  const flagEl = doc.createElement('span');
  flagEl.className = 'map-tooltip__flag';
  const nameEl = doc.createElement('span');
  nameEl.className = 'map-tooltip__name';
  const valueEl = doc.createElement('span');
  valueEl.className = 'map-tooltip__value';
  tooltip.appendChild(flagEl);
  tooltip.appendChild(nameEl);
  tooltip.appendChild(valueEl);

  container.appendChild(svg);
  container.appendChild(tooltip);

  const state = {
    container,
    svg,
    paths,
    highlight,
    tooltip,
    flagEl,
    nameEl,
    valueEl,
    values: new Map(),
    onSelect: null,
    hovered: '',
    handlers: null
  };

  state.handlers = {
    over: (event) => handlePointerOver(state, event),
    move: (event) => handlePointerMove(state, event),
    out: (event) => handlePointerOut(state, event),
    click: (event) => handleClick(state, event),
    leave: () => hideTooltip(state)
  };

  // Delegated on the SVG: events bubble up from the country paths even though
  // the SVG itself is not hit-testable.
  svg.addEventListener('pointerover', state.handlers.over);
  svg.addEventListener('pointermove', state.handlers.move);
  svg.addEventListener('pointerout', state.handlers.out);
  svg.addEventListener('pointercancel', state.handlers.leave);
  svg.addEventListener('click', state.handlers.click);
  container.addEventListener('pointerleave', state.handlers.leave);

  return state;
}

/**
 * Apply the current values to the existing paths. Attribute mutation only —
 * no DOM is created here, which is what keeps repeated draws cheap.
 *
 * @param {object} state
 * @returns {void}
 */
function paint(state) {
  let max = 0;
  for (const visitors of state.values.values()) {
    if (visitors > max) max = visitors;
  }
  for (const [code, path] of state.paths) {
    const visitors = state.values.get(code) || 0;
    if (visitors > 0) {
      path.style.fill = 'var(--accent)';
      path.style.fillOpacity = String(fillOpacity(visitors, max));
    } else {
      path.style.fill = 'var(--panel-2)';
      path.style.fillOpacity = '1';
    }
  }
}

/**
 * Label describing the image for assistive technology: the three busiest
 * countries that the map can actually draw.
 *
 * @param {Map<string, number>} values
 * @returns {string}
 */
function buildAriaLabel(values) {
  if (values.size === 0) return 'World map of visitors by country. No visitor data for this period.';
  const top = [...values.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([code, visitors]) => countryName(code) + ' ' + formatNumber(visitors))
    .join(', ');
  return 'World map of visitors by country. Most visitors: ' + top + '.';
}

/**
 * @param {Event} event
 * @returns {string} Country code of the event target, or '' when it is not a country path.
 */
function codeFromEvent(event) {
  const target = event.target;
  if (!target || typeof target.getAttribute !== 'function') return '';
  return normalizeCode(target.getAttribute('data-code'));
}

/**
 * @param {object} state
 * @param {PointerEvent} event
 * @returns {void}
 */
function handlePointerOver(state, event) {
  const code = codeFromEvent(event);
  if (!code) return;
  if (code !== state.hovered) showCountry(state, code);
  positionTooltip(state, event);
}

/**
 * Same work as the `pointerover` handler: a redraw hides the tooltip while the
 * pointer is parked on a country, and no fresh `pointerover` will fire there,
 * so the next move has to be able to bring it back.
 *
 * @param {object} state
 * @param {PointerEvent} event
 * @returns {void}
 */
function handlePointerMove(state, event) {
  handlePointerOver(state, event);
}

/**
 * Point the highlight overlay at `code` and fill the tooltip with its numbers.
 *
 * @param {object} state
 * @param {string} code
 * @returns {void}
 */
function showCountry(state, code) {
  state.hovered = code;
  state.highlight.setAttribute('d', COUNTRY_PATHS[code]);
  const visitors = state.values.get(code) || 0;
  state.flagEl.textContent = countryFlag(code);
  state.nameEl.textContent = countryName(code);
  state.valueEl.textContent = formatNumber(visitors) + (visitors === 1 ? ' visitor' : ' visitors');
  state.tooltip.classList.add('is-visible');
}

/**
 * Hide only when the pointer really left the countries — moving straight from
 * one country to its neighbour must not flash the tooltip off and on.
 *
 * @param {object} state
 * @param {PointerEvent} event
 * @returns {void}
 */
function handlePointerOut(state, event) {
  const related = event.relatedTarget;
  if (related && typeof related.getAttribute === 'function' && normalizeCode(related.getAttribute('data-code'))) {
    return;
  }
  hideTooltip(state);
}

/**
 * @param {object} state
 * @param {MouseEvent} event
 * @returns {void}
 */
function handleClick(state, event) {
  const code = codeFromEvent(event);
  if (!code || !state.onSelect) return;
  state.onSelect(code);
}

/**
 * Park the tooltip next to the pointer, flipping it around the cursor and
 * clamping it so it never sticks out of the container.
 *
 * @param {object} state
 * @param {PointerEvent} event
 * @returns {void}
 */
function positionTooltip(state, event) {
  const container = state.container;
  const rect = container.getBoundingClientRect();
  // Absolute positioning is relative to the padding box, hence clientLeft/Top.
  const pointerX = event.clientX - rect.left - container.clientLeft;
  const pointerY = event.clientY - rect.top - container.clientTop;
  const width = state.tooltip.offsetWidth;
  const height = state.tooltip.offsetHeight;
  const maxX = container.clientWidth - width - TOOLTIP_EDGE_PAD;
  const maxY = container.clientHeight - height - TOOLTIP_EDGE_PAD;

  let x = pointerX + TOOLTIP_OFFSET;
  if (x > maxX) x = pointerX - TOOLTIP_OFFSET - width;
  if (x > maxX) x = maxX;
  if (x < TOOLTIP_EDGE_PAD) x = TOOLTIP_EDGE_PAD;

  let y = pointerY + TOOLTIP_OFFSET;
  if (y > maxY) y = pointerY - TOOLTIP_OFFSET - height;
  if (y > maxY) y = maxY;
  if (y < TOOLTIP_EDGE_PAD) y = TOOLTIP_EDGE_PAD;

  state.tooltip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
}

/**
 * @param {object} state
 * @returns {void}
 */
function hideTooltip(state) {
  state.hovered = '';
  state.tooltip.classList.remove('is-visible');
  state.highlight.removeAttribute('d');
}

/**
 * @param {HTMLElement} container
 * @param {object} state
 * @returns {void}
 */
function teardown(container, state) {
  const handlers = state.handlers;
  if (handlers) {
    state.svg.removeEventListener('pointerover', handlers.over);
    state.svg.removeEventListener('pointermove', handlers.move);
    state.svg.removeEventListener('pointerout', handlers.out);
    state.svg.removeEventListener('pointercancel', handlers.leave);
    state.svg.removeEventListener('click', handlers.click);
    container.removeEventListener('pointerleave', handlers.leave);
  }
  if (state.svg.parentNode) state.svg.parentNode.removeChild(state.svg);
  if (state.tooltip.parentNode) state.tooltip.parentNode.removeChild(state.tooltip);
  state.paths.clear();
  state.values.clear();
}
