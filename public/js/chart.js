/**
 * Credible — dashboard time-series chart.
 *
 * A dependency-free SVG line/area chart, rendered at the container's measured
 * pixel size (never scaled with preserveAspectRatio, so text stays crisp) and
 * re-rendered through a ResizeObserver.
 *
 *   import { drawChart, destroyChart, niceScale } from './chart.js';
 *
 *   drawChart(el, {
 *     points: [{ label: 'Mon 4 Aug', date: '2025-08-04', value: 128 }, ...],
 *     comparison: null,
 *     metricLabel: 'Unique visitors',
 *     format: (n) => n.toLocaleString('en'),
 *     incompleteIndex: 29,
 *     onHover: (i) => {},
 *     onSelect: (point, i) => {}
 *   });
 *
 * Colours come from the dashboard's CSS custom properties (--accent, --muted,
 * ...). Because `var()` only resolves in CSS properties — not in SVG
 * presentation attributes — every paint is applied through element.style.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Number of gaps between gridlines; there is one more tick than that. */
const TICK_INTERVALS = 4;

/** Axis type size, in px. Matches the dashboard's small-label scale. */
const AXIS_FONT_SIZE = 11;

/** Plot padding. `left` grows to fit the widest y-axis label. */
const PAD_TOP = 14;
const PAD_RIGHT = 12;
const PAD_BOTTOM = 24;
const PAD_LEFT_MIN = 28;

/** Fallback size used when the container has not been laid out yet. */
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 240;

/** Live chart instances, so a redraw or destroy can find its own listeners. */
const INSTANCES = new WeakMap();

/** Counter used to mint unique gradient ids (several charts can coexist). */
let uid = 0;

/* ------------------------------------------------------------------ *
 * Scale helper (pure — unit tested directly)
 * ------------------------------------------------------------------ */

/**
 * Step candidates: the classic 1, 2, 5 × 10^n ladder plus the 2.5 rung.
 *
 * 2.5 matters because the max is always four steps: without it a peak of
 * exactly 100 needs a step of 50 (100/4 = 25 just clears the "2" rung), which
 * puts the axis at 200 and squashes the series into the bottom half. With it
 * the step is 25 and the axis lands on 100. It is also the only rung whose
 * max — 4 × 2.5 × 10^n = 10^(n+1) — is itself a round power of ten.
 */
const STEP_LADDER = [1, 2, 2.5, 5, 10];

/**
 * Build a rounded y-axis running from 0 to a "nice" maximum.
 *
 * The ladder is applied to the step, so the maximum is always a whole number
 * of nice steps and every gridline gets a round label. An all-zero (or empty)
 * series falls back to a 0..tickCount axis rather than collapsing to nothing.
 *
 * @param {number} maxValue Largest value in the series.
 * @param {number} [tickCount] Number of intervals; ticks.length is this + 1.
 * @returns {{ max: number, ticks: number[] }}
 */
export function niceScale(maxValue, tickCount = TICK_INTERVALS) {
  const intervals =
    Number.isFinite(tickCount) && tickCount >= 1 ? Math.floor(tickCount) : TICK_INTERVALS;
  const peak = Number.isFinite(maxValue) ? maxValue : 0;

  if (!(peak > 0)) {
    const flat = [];
    for (let i = 0; i <= intervals; i += 1) flat.push(i);
    return { max: intervals, ticks: flat };
  }

  const rawStep = peak / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  // Visitors and pageviews are whole things: a sub-unit step would print
  // "0.5 visitors", or worse, two gridlines that round to the same label.
  // Fractional steps stay available for series that live below 1.
  const wholeStepsOnly = peak >= 1;

  let step = 0;
  for (let m = magnitude; step === 0 && m <= magnitude * 10; m *= 10) {
    for (const factor of STEP_LADDER) {
      // A whole-number rung is rounded up rather than skipped: dropping 2.5
      // outright jumps straight to 5, which is what used to put a peak of 9 on
      // a 0..20 axis (45% of the plot height) instead of 0..12.
      const candidate = wholeStepsOnly ? Math.ceil(factor * m) : factor * m;
      // Tolerance keeps 1e-9-style float noise from pushing us a rung up.
      if (candidate >= rawStep - Math.abs(rawStep) * 1e-9) {
        step = candidate;
        break;
      }
    }
  }
  if (!(step > 0)) step = wholeStepsOnly ? Math.max(1, Math.ceil(rawStep)) : rawStep;

  const ticks = [];
  for (let i = 0; i <= intervals; i += 1) ticks.push(tidy(step * i));
  return { max: ticks[intervals], ticks };
}

/** Strip binary-float dust (0.30000000000000004 -> 0.3). */
function tidy(value) {
  if (!Number.isFinite(value)) return value;
  // Scaling by 1e10 is only exact while the product stays a safe integer. Past
  // that the round trip *adds* dust rather than removing it — a tick of
  // 250000000000000 came back as 250000000000000.03. Nothing up there needs
  // tidying anyway: fractional steps only occur for peaks below 1, so every
  // step this large is already a whole number.
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER / 1e10) return value;
  return Math.round(value * 1e10) / 1e10;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Draw (or redraw) the chart into `container`.
 * Safe to call repeatedly; it replaces its own content and listeners.
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {Array<{label:string, date:string, value:number}>} options.points
 * @param {Array<{label:string, value:number}>|null} [options.comparison]
 * @param {string} [options.metricLabel]
 * @param {(n:number)=>string} [options.format]
 * @param {number} [options.incompleteIndex]
 * @param {(index:number|null)=>void} [options.onHover]
 * @param {(point:object, index:number)=>void} [options.onSelect]
 */
export function drawChart(container, options) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('drawChart: container must be an element');
  }
  const opts = options || {};
  destroyChart(container);

  const doc = container.ownerDocument || globalThis.document;
  if (!doc) throw new Error('drawChart: no document available');

  const points = Array.isArray(opts.points) ? opts.points : [];
  const comparison =
    Array.isArray(opts.comparison) && opts.comparison.length === points.length
      ? opts.comparison
      : null;

  const state = {
    container,
    doc,
    uid: (uid += 1),
    points,
    comparison,
    metricLabel: typeof opts.metricLabel === 'string' ? opts.metricLabel : 'Value',
    format: typeof opts.format === 'function' ? opts.format : defaultFormat,
    incompleteIndex: Number.isInteger(opts.incompleteIndex) ? opts.incompleteIndex : -1,
    onHover: typeof opts.onHover === 'function' ? opts.onHover : null,
    onSelect: typeof opts.onSelect === 'function' ? opts.onSelect : null,
    activeIndex: null,
    geometry: null,
    nodes: null,
    listeners: [],
    observer: null,
    width: 0,
    height: 0,
    restorePosition: null
  };
  INSTANCES.set(container, state);

  // The tooltip is absolutely positioned inside the container.
  const position = readStyle(container, 'position');
  if (!position || position === 'static') {
    state.restorePosition = container.style.position || '';
    container.style.position = 'relative';
  }

  render(state);
  observeResize(state);
  return undefined;
}

/**
 * Tear a chart down: drop listeners, stop the ResizeObserver, empty the node.
 *
 * @param {HTMLElement} container
 */
export function destroyChart(container) {
  const state = container && INSTANCES.get(container);
  if (!state) return;

  for (const [target, type, handler] of state.listeners) {
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener(type, handler);
    }
  }
  state.listeners.length = 0;

  if (state.observer && typeof state.observer.disconnect === 'function') {
    state.observer.disconnect();
  }
  state.observer = null;

  clearChildren(container);
  if (state.restorePosition !== null) container.style.position = state.restorePosition;
  INSTANCES.delete(container);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(state) {
  const { container, doc } = state;
  const size = measureBox(container);
  state.width = size.width;
  state.height = size.height;

  clearChildren(container);
  // Listeners live on nodes we are about to discard; window/observer entries
  // are re-added by their own owners.
  state.listeners = state.listeners.filter(([target]) => target === globalThis);

  const svg = el(doc, 'svg');
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('width', String(size.width));
  svg.setAttribute('height', String(size.height));
  svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-label', summarise(state));
  setStyle(svg, {
    display: 'block',
    width: '100%',
    height: '100%',
    overflow: 'visible',
    outline: 'none',
    // Let the page scroll vertically over the chart; horizontal drags scrub.
    touchAction: 'pan-y',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontVariantNumeric: 'tabular-nums'
  });

  const title = el(doc, 'title');
  title.textContent = summarise(state);
  svg.appendChild(title);
  container.appendChild(svg);

  const geometry = layout(state, svg, size);
  state.geometry = geometry;
  state.nodes = { svg };

  drawGrid(state, svg, geometry);

  if (state.points.length === 0) {
    drawEmptyState(state, svg, geometry);
    return;
  }

  drawXAxis(state, svg, geometry);
  if (state.comparison) drawComparison(state, svg, geometry);
  drawSeries(state, svg, geometry);
  drawInteraction(state, svg, geometry);
}

/**
 * Work out the plot rectangle and the value -> pixel mappings.
 * The left padding is measured from the real y-axis labels so large numbers
 * ("1,240,000") never collide with the plot.
 */
function layout(state, svg, size) {
  const values = state.points.map((p) => toNumber(p && p.value));
  if (state.comparison) {
    for (const c of state.comparison) values.push(toNumber(c && c.value));
  }
  const peak = values.length ? Math.max(...values) : 0;
  const scale = niceScale(peak, TICK_INTERVALS);
  const labels = scale.ticks.map((t) => String(state.format(t)));

  let widest = 0;
  for (const label of labels) widest = Math.max(widest, measureText(svg, state.doc, label));

  const left = Math.max(PAD_LEFT_MIN, Math.round(widest) + 10);
  const plotLeft = left;
  const plotRight = Math.max(left + 1, size.width - PAD_RIGHT);
  const plotTop = PAD_TOP;
  const plotBottom = Math.max(plotTop + 1, size.height - PAD_BOTTOM);
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const count = state.points.length;

  return {
    scale,
    labels,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    count,
    /** Pixel x of bucket `i`; a lone bucket sits in the middle. */
    xAt(i) {
      if (count <= 1) return plotLeft + plotWidth / 2;
      return plotLeft + (plotWidth * i) / (count - 1);
    },
    /** Pixel y of a value. */
    yAt(value) {
      const max = scale.max || 1;
      const ratio = Math.min(1, Math.max(0, toNumber(value) / max));
      return plotBottom - ratio * plotHeight;
    },
    /** Bucket nearest to a pixel x. */
    indexAt(px) {
      if (count <= 1) return 0;
      const slot = plotWidth / (count - 1);
      const raw = Math.round((px - plotLeft) / slot);
      return Math.min(count - 1, Math.max(0, raw));
    }
  };
}

/** Horizontal gridlines plus their left-hand value labels. */
function drawGrid(state, svg, g) {
  const group = el(state.doc, 'g');
  group.setAttribute('class', 'chart-grid');

  g.scale.ticks.forEach((tick, i) => {
    const y = round2(g.yAt(tick));
    // The zero line is the plot's baseline, so only the 4 above it are drawn:
    // that keeps exactly four gridlines on screen.
    if (i > 0) {
      const line = el(state.doc, 'line');
      line.setAttribute('x1', String(g.plotLeft));
      line.setAttribute('x2', String(g.plotRight));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      setStyle(line, { stroke: 'var(--border)', strokeWidth: '1', opacity: '0.5' });
      group.appendChild(line);
    }

    const label = el(state.doc, 'text');
    label.setAttribute('x', String(g.plotLeft - 8));
    label.setAttribute('y', String(y));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    setStyle(label, { fill: 'var(--muted)', fontSize: `${AXIS_FONT_SIZE}px` });
    label.textContent = g.labels[i];
    group.appendChild(label);
  });

  svg.appendChild(group);
}

/** Bottom labels, thinned so they never overlap; first and last always shown. */
function drawXAxis(state, svg, g) {
  const group = el(state.doc, 'g');
  group.setAttribute('class', 'chart-xaxis');

  const texts = state.points.map((p) => (p && p.label != null ? String(p.label) : ''));
  let widest = 0;
  for (const t of texts) widest = Math.max(widest, measureText(svg, state.doc, t));

  const slot = g.count > 1 ? g.plotWidth / (g.count - 1) : g.plotWidth;
  const stride = Math.max(1, Math.ceil((widest + 14) / Math.max(1, slot)));

  const shown = [];
  for (let i = 0; i < g.count; i += stride) shown.push(i);
  const last = g.count - 1;
  if (shown[shown.length - 1] !== last) {
    // Prefer the real last bucket over a tick that would crowd it.
    if (last - shown[shown.length - 1] < stride) shown.pop();
    shown.push(last);
  }

  const y = g.plotBottom + AXIS_FONT_SIZE + 6;
  for (const i of shown) {
    const text = el(state.doc, 'text');
    const half = measureText(svg, state.doc, texts[i]) / 2;
    // Keep the outermost labels inside the SVG box.
    const x = Math.min(state.width - half - 2, Math.max(half + 2, g.xAt(i)));
    text.setAttribute('x', String(round2(x)));
    text.setAttribute('y', String(round2(y)));
    text.setAttribute('text-anchor', 'middle');
    setStyle(text, { fill: 'var(--muted)', fontSize: `${AXIS_FONT_SIZE}px` });
    text.textContent = texts[i];
    group.appendChild(text);
  }

  svg.appendChild(group);
}

/** Comparison series: thin dashed line, behind everything, no fill. */
function drawComparison(state, svg, g) {
  const coords = state.comparison.map((c, i) => ({
    x: g.xAt(i),
    y: g.yAt(toNumber(c && c.value))
  }));
  if (coords.length === 1) {
    const dot = el(state.doc, 'circle');
    dot.setAttribute('cx', String(round2(coords[0].x)));
    dot.setAttribute('cy', String(round2(coords[0].y)));
    dot.setAttribute('r', '3');
    setStyle(dot, { fill: 'var(--muted)', opacity: '0.55' });
    svg.appendChild(dot);
    return;
  }
  const path = el(state.doc, 'path');
  path.setAttribute('class', 'chart-comparison');
  path.setAttribute('d', linePath(coords));
  setStyle(path, {
    fill: 'none',
    stroke: 'var(--muted)',
    strokeWidth: '1.5',
    strokeDasharray: '5 4',
    strokeLinecap: 'round',
    opacity: '0.55'
  });
  svg.appendChild(path);
}

/** Main series: gradient area + solid line, with the in-progress tail dashed. */
function drawSeries(state, svg, g) {
  const { doc } = state;
  const coords = state.points.map((p, i) => ({
    x: g.xAt(i),
    y: g.yAt(toNumber(p && p.value))
  }));

  const cut =
    state.incompleteIndex >= 0 && state.incompleteIndex < coords.length
      ? state.incompleteIndex
      : coords.length;
  const solid = coords.slice(0, cut);
  // The dashed tail starts one bucket early so the line reads as continuous.
  const dashed = cut < coords.length ? coords.slice(Math.max(0, cut - 1)) : [];

  const gradientId = `credible-chart-fill-${state.uid}`;
  const defs = el(doc, 'defs');
  const gradient = el(doc, 'linearGradient');
  gradient.setAttribute('id', gradientId);
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  // rgba(107,92,246,.35) -> rgba(107,92,246,0), expressed as the accent token
  // with an alpha so the hex is never duplicated here.
  const top = el(doc, 'stop');
  top.setAttribute('offset', '0');
  setStyle(top, { stopColor: 'var(--accent)', stopOpacity: '0.35' });
  const bottom = el(doc, 'stop');
  bottom.setAttribute('offset', '1');
  setStyle(bottom, { stopColor: 'var(--accent)', stopOpacity: '0' });
  gradient.appendChild(top);
  gradient.appendChild(bottom);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  if (solid.length > 1) {
    const area = el(doc, 'path');
    area.setAttribute('class', 'chart-area');
    area.setAttribute('d', areaPath(solid, g.plotBottom));
    setStyle(area, { fill: `url(#${gradientId})`, stroke: 'none' });
    svg.appendChild(area);
  }

  if (solid.length > 1) {
    const line = el(doc, 'path');
    line.setAttribute('class', 'chart-line');
    line.setAttribute('d', linePath(solid));
    setStyle(line, {
      fill: 'none',
      stroke: 'var(--accent)',
      strokeWidth: '2',
      strokeLinejoin: 'round',
      strokeLinecap: 'round'
    });
    svg.appendChild(line);
  }

  if (dashed.length > 1) {
    const line = el(doc, 'path');
    line.setAttribute('class', 'chart-line-incomplete');
    line.setAttribute('d', linePath(dashed));
    setStyle(line, {
      fill: 'none',
      stroke: 'var(--accent)',
      strokeWidth: '2',
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
      strokeDasharray: '4 4'
    });
    svg.appendChild(line);
  }

  // A single bucket has no segment to stroke, so mark it with a dot.
  if (coords.length === 1) {
    const dot = el(doc, 'circle');
    dot.setAttribute('class', 'chart-point');
    dot.setAttribute('cx', String(round2(coords[0].x)));
    dot.setAttribute('cy', String(round2(coords[0].y)));
    dot.setAttribute('r', '3.5');
    setStyle(dot, { fill: 'var(--accent)', opacity: cut === 0 ? '0.55' : '1' });
    svg.appendChild(dot);
  }
}

/** "No data for this period", centred over an empty axis. */
function drawEmptyState(state, svg, g) {
  const text = el(state.doc, 'text');
  text.setAttribute('x', String(round2(g.plotLeft + g.plotWidth / 2)));
  text.setAttribute('y', String(round2(g.plotTop + g.plotHeight / 2)));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'middle');
  setStyle(text, { fill: 'var(--muted)', fontSize: '13px' });
  text.textContent = 'No data for this period';
  svg.appendChild(text);
}

/* ------------------------------------------------------------------ *
 * Interaction: crosshair, dot, tooltip, pointer + keyboard
 * ------------------------------------------------------------------ */

function drawInteraction(state, svg, g) {
  const { doc } = state;

  const crosshair = el(doc, 'line');
  crosshair.setAttribute('class', 'chart-crosshair');
  crosshair.setAttribute('y1', String(g.plotTop));
  crosshair.setAttribute('y2', String(g.plotBottom));
  setStyle(crosshair, {
    stroke: 'var(--muted)',
    strokeWidth: '1',
    opacity: '0',
    pointerEvents: 'none'
  });
  svg.appendChild(crosshair);

  const dot = el(doc, 'circle');
  dot.setAttribute('class', 'chart-dot');
  dot.setAttribute('r', '4');
  setStyle(dot, {
    fill: 'var(--accent)',
    stroke: 'var(--bg)',
    strokeWidth: '2',
    opacity: '0',
    pointerEvents: 'none',
    transition: 'cx .09s ease-out, cy .09s ease-out, opacity .12s ease-out'
  });
  svg.appendChild(dot);

  const overlay = el(doc, 'rect');
  overlay.setAttribute('class', 'chart-overlay');
  overlay.setAttribute('x', '0');
  overlay.setAttribute('y', '0');
  overlay.setAttribute('width', String(state.width));
  overlay.setAttribute('height', String(state.height));
  setStyle(overlay, { fill: 'transparent', cursor: 'pointer' });
  svg.appendChild(overlay);

  const tooltip = state.doc.createElement('div');
  tooltip.setAttribute('class', 'chart-tooltip');
  setStyle(tooltip, {
    position: 'absolute',
    left: '0',
    top: '0',
    zIndex: '6',
    minWidth: '150px',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid var(--border)',
    background: 'var(--panel-2)',
    color: 'var(--text)',
    font: '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: '1.45',
    boxShadow: '0 8px 24px rgba(0, 0, 0, .45)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    opacity: '0',
    visibility: 'hidden'
  });
  state.container.appendChild(tooltip);

  Object.assign(state.nodes, { crosshair, dot, overlay, tooltip });

  const onPointer = (event) => {
    const rect = boundingRect(svg);
    if (!rect || !rect.width) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setActive(state, g.indexAt(x), { x, y });
  };
  const onLeave = () => setActive(state, null, null);
  const onClick = (event) => {
    if (!state.onSelect) return;
    const rect = boundingRect(svg);
    if (!rect || !rect.width) return;
    const index = g.indexAt(event.clientX - rect.left);
    state.onSelect(state.points[index], index);
  };
  const onKeyDown = (event) => handleKey(state, g, event);

  listen(state, overlay, 'pointermove', onPointer);
  listen(state, overlay, 'pointerdown', onPointer);
  listen(state, overlay, 'pointerleave', onLeave);
  listen(state, overlay, 'pointercancel', onLeave);
  listen(state, overlay, 'click', onClick);
  listen(state, svg, 'blur', onLeave);
  listen(state, svg, 'keydown', onKeyDown);

  // A resize keeps the highlighted bucket; the pointer position is unknown, so
  // the tooltip is anchored to the point itself.
  if (state.activeIndex !== null) setActive(state, state.activeIndex, null, true);
}

function handleKey(state, g, event) {
  const key = event.key;
  const last = g.count - 1;
  const current = state.activeIndex;

  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const step = key === 'ArrowRight' ? 1 : -1;
    const base = current === null ? (step > 0 ? -1 : last + 1) : current;
    const next = Math.min(last, Math.max(0, base + step));
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setActive(state, next, null);
    return;
  }
  if (key === 'Home' || key === 'End') {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setActive(state, key === 'Home' ? 0 : last, null);
    return;
  }
  if (key === 'Escape') {
    setActive(state, null, null);
    return;
  }
  if ((key === 'Enter' || key === ' ') && current !== null && state.onSelect) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    state.onSelect(state.points[current], current);
  }
}

/**
 * Highlight a bucket (or clear it with `index === null`).
 *
 * @param {object} state
 * @param {number|null} index
 * @param {{x:number,y:number}|null} pointer Pointer position, when available.
 * @param {boolean} [silent] Skip the onHover callback (used on re-render).
 */
function setActive(state, index, pointer, silent) {
  const { crosshair, dot, tooltip } = state.nodes || {};
  if (!crosshair || !dot || !tooltip) return;
  const g = state.geometry;

  if (index === null || index === undefined || !state.points[index]) {
    if (state.activeIndex !== null) {
      state.activeIndex = null;
      if (!silent && state.onHover) state.onHover(null);
    }
    setStyle(crosshair, { opacity: '0' });
    setStyle(dot, { opacity: '0' });
    setStyle(tooltip, { opacity: '0', visibility: 'hidden' });
    return;
  }

  const changed = state.activeIndex !== index;
  state.activeIndex = index;

  const x = round2(g.xAt(index));
  const y = round2(g.yAt(toNumber(state.points[index].value)));

  crosshair.setAttribute('x1', String(x));
  crosshair.setAttribute('x2', String(x));
  setStyle(crosshair, { opacity: '0.45' });

  dot.setAttribute('cx', String(x));
  dot.setAttribute('cy', String(y));
  setStyle(dot, { opacity: '1' });

  fillTooltip(state, index);
  positionTooltip(state, pointer || { x, y: y - 6 });

  if (changed && !silent && state.onHover) state.onHover(index);
}

function fillTooltip(state, index) {
  const { doc, nodes } = state;
  const tooltip = nodes.tooltip;
  clearChildren(tooltip);

  const point = state.points[index] || {};
  const value = toNumber(point.value);

  const heading = doc.createElement('div');
  heading.setAttribute('class', 'chart-tooltip__label');
  setStyle(heading, {
    color: 'var(--muted)',
    fontSize: '11px',
    marginBottom: '4px'
  });
  heading.textContent = point.label != null ? String(point.label) : '';
  tooltip.appendChild(heading);

  tooltip.appendChild(
    tooltipRow(doc, state.metricLabel, state.format(value), {
      accent: true,
      strong: true
    })
  );

  if (state.comparison) {
    const previous = state.comparison[index] || {};
    const previousValue = toNumber(previous.value);
    const previousLabel = previous.label != null ? String(previous.label) : 'Previous';
    tooltip.appendChild(
      tooltipRow(doc, previousLabel, state.format(previousValue), { muted: true })
    );

    const delta = changeText(value, previousValue);
    const change = doc.createElement('div');
    change.setAttribute('class', 'chart-tooltip__change');
    setStyle(change, {
      marginTop: '4px',
      paddingTop: '4px',
      borderTop: '1px solid var(--border)',
      fontSize: '11px',
      color: delta.tone === 'up' ? 'var(--green)' : delta.tone === 'down' ? 'var(--red)' : 'var(--muted)'
    });
    change.textContent = delta.text;
    tooltip.appendChild(change);
  }
}

function tooltipRow(doc, label, value, look) {
  const row = doc.createElement('div');
  row.setAttribute('class', 'chart-tooltip__row');
  setStyle(row, {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '16px'
  });

  const left = doc.createElement('span');
  setStyle(left, { color: 'var(--muted)', fontSize: '11px' });
  left.textContent = String(label);

  const right = doc.createElement('span');
  setStyle(right, {
    color: look && look.muted ? 'var(--muted)' : 'var(--text)',
    fontWeight: look && look.strong ? '600' : '400',
    fontVariantNumeric: 'tabular-nums'
  });
  right.textContent = String(value);

  if (look && look.accent) {
    const swatch = doc.createElement('span');
    setStyle(swatch, {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      marginRight: '6px',
      borderRadius: '50%',
      background: 'var(--accent)'
    });
    const wrap = doc.createElement('span');
    setStyle(wrap, { display: 'inline-flex', alignItems: 'center' });
    wrap.appendChild(swatch);
    wrap.appendChild(left);
    row.appendChild(wrap);
  } else {
    row.appendChild(left);
  }

  row.appendChild(right);
  return row;
}

/** Percentage change, with the direction the dashboard colours on. */
function changeText(current, previous) {
  if (previous === 0) {
    if (current === 0) return { text: 'No change', tone: 'flat' };
    return { text: current > 0 ? '▲ New' : '▼ New', tone: current > 0 ? 'up' : 'down' };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 0.05) return { text: 'No change', tone: 'flat' };
  const digits = Math.abs(pct) < 10 ? 1 : 0;
  const arrow = pct > 0 ? '▲' : '▼';
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(digits)}%`,
    tone: pct > 0 ? 'up' : 'down'
  };
}

/** Follow the pointer, flipping to the left near the right edge. */
function positionTooltip(state, anchor) {
  const tooltip = state.nodes.tooltip;
  setStyle(tooltip, { visibility: 'visible', opacity: '1' });

  const width = tooltip.offsetWidth || 170;
  const height = tooltip.offsetHeight || 70;
  const gap = 14;

  let left = anchor.x + gap;
  if (left + width > state.width - 4) left = anchor.x - gap - width;
  left = Math.min(Math.max(4, left), Math.max(4, state.width - width - 4));

  let top = anchor.y - height - 10;
  if (top < 4) top = anchor.y + gap;
  top = Math.min(Math.max(4, top), Math.max(4, state.height - height - 4));

  setStyle(tooltip, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

/* ------------------------------------------------------------------ *
 * Resize handling
 * ------------------------------------------------------------------ */

function observeResize(state) {
  const RO = globalThis.ResizeObserver;
  if (typeof RO === 'function') {
    const observer = new RO(() => {
      const size = measureBox(state.container);
      // The observer fires once on observe(); only a real change redraws.
      if (size.width === state.width && size.height === state.height) return;
      render(state);
    });
    observer.observe(state.container);
    state.observer = observer;
    return;
  }
  // Fallback for environments without ResizeObserver.
  if (typeof globalThis.addEventListener === 'function') {
    const handler = () => {
      const size = measureBox(state.container);
      if (size.width === state.width && size.height === state.height) return;
      render(state);
    };
    listen(state, globalThis, 'resize', handler);
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function el(doc, tag) {
  return doc.createElementNS(SVG_NS, tag);
}

function listen(state, target, type, handler) {
  if (!target || typeof target.addEventListener !== 'function') return;
  target.addEventListener(type, handler);
  state.listeners.push([target, type, handler]);
}

function setStyle(node, styles) {
  if (!node || !node.style) return;
  for (const key of Object.keys(styles)) {
    const value = styles[key];
    if (value !== null && value !== undefined) node.style[key] = String(value);
  }
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') {
    node.replaceChildren();
    return;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
}

function readStyle(node, property) {
  const view = globalThis.getComputedStyle;
  if (typeof view !== 'function') return null;
  try {
    return view(node)[property];
  } catch {
    return null;
  }
}

function boundingRect(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  try {
    return node.getBoundingClientRect();
  } catch {
    return null;
  }
}

/** Container size in CSS pixels, with a sane fallback before first layout. */
function measureBox(container) {
  const rect = boundingRect(container);
  const width = Math.round((rect && rect.width) || container.clientWidth || 0);
  const height = Math.round((rect && rect.height) || container.clientHeight || 0);
  return {
    width: width > 0 ? width : FALLBACK_WIDTH,
    height: height > 0 ? height : FALLBACK_HEIGHT
  };
}

/**
 * Width of a string at the axis type size. Uses the real text metrics when the
 * SVG is laid out, and falls back to an average-glyph estimate otherwise.
 */
function measureText(svg, doc, text) {
  const value = String(text == null ? '' : text);
  if (!value) return 0;
  const estimate = value.length * AXIS_FONT_SIZE * 0.62;
  try {
    const probe = el(doc, 'text');
    setStyle(probe, {
      fontSize: `${AXIS_FONT_SIZE}px`,
      fontVariantNumeric: 'tabular-nums',
      visibility: 'hidden'
    });
    probe.textContent = value;
    svg.appendChild(probe);
    const measured =
      typeof probe.getComputedTextLength === 'function' ? probe.getComputedTextLength() : 0;
    svg.removeChild(probe);
    return measured > 0 ? measured : estimate;
  } catch {
    return estimate;
  }
}

function linePath(coords) {
  let d = '';
  for (let i = 0; i < coords.length; i += 1) {
    d += `${i === 0 ? 'M' : 'L'}${round2(coords[i].x)} ${round2(coords[i].y)}`;
  }
  return d;
}

function areaPath(coords, baseline) {
  if (coords.length < 2) return '';
  const first = coords[0];
  const last = coords[coords.length - 1];
  return `${linePath(coords)}L${round2(last.x)} ${round2(baseline)}L${round2(first.x)} ${round2(
    baseline
  )}Z`;
}

function summarise(state) {
  const n = state.points.length;
  if (n === 0) return `${state.metricLabel}: no data for this period`;
  const first = state.points[0];
  const last = state.points[n - 1];
  let peakIndex = 0;
  for (let i = 1; i < n; i += 1) {
    if (toNumber(state.points[i].value) > toNumber(state.points[peakIndex].value)) peakIndex = i;
  }
  const peak = state.points[peakIndex];
  return (
    `${state.metricLabel}, ${n} ${n === 1 ? 'bucket' : 'buckets'} ` +
    `from ${first.label} to ${last.label}. ` +
    `Highest ${state.format(toNumber(peak.value))} on ${peak.label}. ` +
    `Latest ${state.format(toNumber(last.value))}.`
  );
}

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function defaultFormat(value) {
  return Number.isFinite(value) ? String(value) : '0';
}
