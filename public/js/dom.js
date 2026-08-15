/**
 * A 30-line replacement for a view framework.
 *
 *   h('div', { class: 'card' }, h('h2', {}, 'Hello'))
 *
 * Props: `class`, `style` (object or string), `dataset`, on* handlers, everything
 * else becomes an attribute. `html` sets innerHTML (only used for inline SVG we
 * author ourselves — never for server data).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

/** Append children, skipping null/false and flattening arrays. */
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  return append(clear(el), children);
}

/** Inline SVG icon set. Kept tiny and monochrome (currentColor). */
const ICONS = {
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  chevron: 'm6 9 6 6 6-6',
  left: 'm15 18-6-6 6-6',
  right: 'm9 18 6-6-6-6',
  filter: 'M3 5h18M6 12h12M10 19h4',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  expand: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3',
  close: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  check: 'm20 6-11 11-5-5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  copy: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M4 16V4a1 1 0 0 1 1-1h11',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flex = 'none';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.appendChild(path);
  return svg;
}

export function logo(size = 26) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<rect width="32" height="32" rx="8" fill="#6b5cf6"/>' +
    '<path d="M9 21.5 14 13l4 5.5 5-9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

/**
 * Show `node` anchored under `anchor`, closing on outside click or Escape.
 * Returns a close function.
 */
export function popover(anchor, node) {
  const rect = anchor.getBoundingClientRect();
  node.classList.add('menu');
  node.style.visibility = 'hidden';
  document.body.appendChild(node);

  const width = node.offsetWidth;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  node.style.left = `${left + window.scrollX}px`;
  node.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  node.style.visibility = 'visible';

  const close = () => {
    node.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (event) => {
    if (!node.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

export function modal(node, { wide = false } = {}) {
  const backdrop = h('div', { class: 'backdrop' });
  const card = h('div', { class: `card modal${wide ? ' modal-wide' : ''}` });
  card.appendChild(node);
  backdrop.appendChild(card);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  const input = card.querySelector('input, select, textarea, button');
  if (input) input.focus();
  return close;
}

export function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
