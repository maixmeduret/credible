/**
 * Saved segments and graph annotations, as dashboard widgets.
 *
 * These live outside dashboard.js because between them they carry a menu, four
 * dialogs and a positioned overlay, and the dashboard is already the longest
 * view in the app.
 *
 * api.js has no methods for the segment and annotation endpoints yet, so the
 * calls are made here with exactly the conventions request() uses there: the
 * mount point from withBase(), same-origin credentials, and the server's
 * `error` string surfaced as the Error message. That last part matters — a
 * personal segment that belongs to someone else answers 403 with a sentence
 * meant for the reader, and the UI shows it instead of failing quietly.
 */
import { withBase } from './api.js';
import { append, clear, h, icon, modal, popover, replace, toast } from './dom.js';

// ------------------------------------------------------------------ client --

async function request(method, path, { body, query } = {}) {
  const url = new URL(withBase(path), window.location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const sitePath = (domain) => `/api/sites/${encodeURIComponent(domain)}`;

export const segmentsApi = {
  list: (domain, query) => request('GET', `${sitePath(domain)}/segments`, { query }),
  create: (domain, body) => request('POST', `${sitePath(domain)}/segments`, { body }),
  update: (domain, id, body) => request('PATCH', `${sitePath(domain)}/segments/${id}`, { body }),
  remove: (domain, id) => request('DELETE', `${sitePath(domain)}/segments/${id}`),
};

export const annotationsApi = {
  list: (domain, query) => request('GET', `${sitePath(domain)}/annotations`, { query }),
  create: (domain, body) => request('POST', `${sitePath(domain)}/annotations`, { body }),
  remove: (domain, id) => request('DELETE', `${sitePath(domain)}/annotations/${id}`),
};

// ---------------------------------------------------------------- segments --

/** Radio groups need a name that is unique on the page, not across reloads. */
let uid = 0;

/**
 * The "Segments" control that sits next to Filter.
 *
 * @param {object} options
 * @param {string} options.domain
 * @param {boolean} options.canEdit   False on a shared link: read-only, apply only.
 * @param {() => Array} options.getFilters  The filters currently in the URL.
 * @param {() => string} options.getActiveId
 * @param {(id: string) => void} options.onApply   '' removes the segment.
 * @param {() => void} options.onChanged           Reload after a write.
 */
export function createSegmentsControl(options) {
  const { domain, canEdit, getFilters, getActiveId, onApply, onChanged } = options;
  let segments = [];

  const button = h(
    'button',
    { class: 'btn ghost', type: 'button', 'aria-haspopup': 'menu' },
    'Segments',
    icon('chevron', 14),
  );
  button.addEventListener('click', () => open());

  function open() {
    const menu = h('div', {});
    let close = () => {};

    const site = segments.filter((segment) => segment.scope === 'site');
    const personal = segments.filter((segment) => segment.scope !== 'site');
    const activeId = String(getActiveId() || '');

    const group = (label, list) => {
      if (!list.length) return;
      menu.appendChild(h('div', { class: 'menu-label' }, label));
      for (const segment of list) menu.appendChild(row(segment));
    };

    const row = (segment) => {
      const isActive = String(segment.id) === activeId;
      const apply = h(
        'button',
        {
          type: 'button',
          class: isActive ? 'active' : '',
          style: { flex: '1', minWidth: '0' },
          onClick: () => {
            close();
            onApply(isActive ? '' : String(segment.id));
          },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, segment.name),
        isActive ? icon('check', 14) : null,
      );
      if (!canEdit) return apply;

      // The two icon buttons have to opt out of `.menu button { width: 100% }`.
      const tool = (name, title, onClick, colour) =>
        h(
          'button',
          {
            type: 'button',
            title,
            'aria-label': `${title} ${segment.name}`,
            style: { width: 'auto', flex: 'none', padding: '8px', color: colour || 'inherit' },
            onClick: () => {
              close();
              onClick();
            },
          },
          icon(name, 14),
        );

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '2px' } },
        apply,
        tool('settings', 'Edit', () => editSegment(segment), null),
        tool('trash', 'Delete', () => confirmDelete(segment), 'var(--red)'),
      );
    };

    menu.appendChild(h('div', { class: 'menu-label' }, 'Segments'));
    if (!segments.length) {
      menu.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No segments yet.'));
    }
    group('Everyone', site);
    group('Only me', personal);

    if (activeId) {
      menu.appendChild(h('hr'));
      menu.appendChild(
        h('button', { type: 'button', onClick: () => { close(); onApply(''); } }, 'Remove the active segment'),
      );
    }

    if (canEdit) {
      const filters = getFilters();
      menu.appendChild(h('hr'));
      menu.appendChild(
        h(
          'button',
          {
            type: 'button',
            disabled: filters.length === 0,
            title: filters.length ? '' : 'Add at least one filter first',
            onClick: () => { close(); saveSegment(filters); },
          },
          'Save current filters as a segment…',
          icon('plus', 14),
        ),
      );
    }

    close = popover(button, menu);
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
    return close;
  }

  function saveSegment(filters) {
    openSegmentDialog({
      title: 'Save these filters as a segment',
      hint: `${filters.length} filter${filters.length === 1 ? '' : 's'} will be saved. Applying the segment adds them on top of whatever is already filtered.`,
      submitLabel: 'Save segment',
      onSubmit: async ({ name, scope }) => {
        const { segment } = await segmentsApi.create(domain, { name, scope, filters });
        toast('Segment saved');
        // Applying it reloads the dashboard, which brings back the fresh list.
        onApply(String(segment.id));
      },
    });
  }

  function editSegment(segment) {
    const filters = getFilters();
    openSegmentDialog({
      title: 'Edit segment',
      hint: describeScope(segment),
      submitLabel: 'Save changes',
      name: segment.name,
      scope: segment.scope,
      replaceFilters: filters.length > 0,
      onSubmit: async ({ name, scope, useCurrentFilters }) => {
        await segmentsApi.update(domain, segment.id, {
          name,
          scope,
          ...(useCurrentFilters ? { filters } : {}),
        });
        toast('Segment updated');
        onChanged();
      },
    });
  }

  function confirmDelete(segment) {
    const body = h('div', {});
    const error = h('p', { class: 'error', style: { display: 'none' } });
    const remove = h('button', { class: 'btn danger', type: 'button' }, 'Delete segment');
    body.append(
      h('h2', {}, `Delete “${segment.name}”?`),
      h('p', { class: 'hint' }, describeScope(segment)),
      error,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        remove,
      ),
    );
    const close = modal(body);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await segmentsApi.remove(domain, segment.id);
        close();
        toast('Segment deleted');
        if (String(segment.id) === String(getActiveId() || '')) onApply('');
        else onChanged();
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
        remove.disabled = false;
      }
    });
  }

  return {
    el: button,
    open,
    setSegments(list) {
      segments = Array.isArray(list) ? list : [];
    },
    /**
     * The segment the URL points at. Answers with a placeholder name while the
     * list is still in flight, so the chip does not pop in after the payload
     * lands and push the whole page down a row.
     */
    active() {
      const id = String(getActiveId() || '');
      if (!id) return null;
      return segments.find((segment) => String(segment.id) === id) || { id, name: 'Segment', scope: 'site' };
    },
  };
}

function describeScope(segment) {
  return segment.scope === 'site'
    ? 'Shared with everyone who can see this site.'
    : `Personal segment${segment.owner_email ? ` — ${segment.owner_email}` : ''}.`;
}

/** The create/edit form. Both writes report their errors in the same place. */
function openSegmentDialog({ title, hint, submitLabel, name = '', scope = 'personal', replaceFilters = false, onSubmit }) {
  uid += 1;
  const group = `credible-segment-scope-${uid}`;
  const body = h('form', {});
  const nameInput = h('input', { type: 'text', value: name, required: true, placeholder: 'Mobile visitors from France' });
  const personal = h('input', { type: 'radio', name: group, value: 'personal', checked: scope !== 'site', style: { width: 'auto' } });
  const siteWide = h('input', { type: 'radio', name: group, value: 'site', checked: scope === 'site', style: { width: 'auto' } });
  const useFilters = h('input', { type: 'checkbox', style: { width: 'auto' } });
  const error = h('p', { class: 'error', style: { display: 'none' } });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);

  const choice = (input, label, explanation) =>
    h(
      'label',
      { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
      input,
      h('span', {}, label, h('small', { style: { display: 'block', color: 'var(--muted)' } }, explanation)),
    );

  // append() from dom.js, not the native body.append(): two of these children
  // are conditional, and the native method stringifies null into a literal
  // "null" in the dialog rather than skipping it.
  append(
    body,
    h('h2', {}, title),
    hint ? h('p', { class: 'hint' }, hint) : null,
    error,
    h('div', { class: 'field' }, h('label', {}, 'Name'), nameInput),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Who can use it'),
      choice(personal, 'Only me', 'Nobody else sees it, and only you can change it.'),
      choice(siteWide, 'Everyone on this site', 'Anyone with access to the dashboard can apply and edit it.'),
    ),
    replaceFilters
      ? h(
          'div',
          { class: 'field' },
          h(
            'label',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            useFilters,
            'Replace its filters with the ones currently applied',
          ),
        )
      : null,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      submit,
    ),
  );

  const close = modal(body);
  nameInput.focus();

  body.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.style.display = 'none';
    try {
      await onSubmit({
        name: nameInput.value.trim(),
        scope: siteWide.checked ? 'site' : 'personal',
        useCurrentFilters: useFilters.checked,
      });
      close();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      submit.disabled = false;
    }
  };
}

/** The removable chip shown in the filter bar while a segment is applied. */
export function segmentChip(segment, onRemove) {
  return h(
    'span',
    { class: 'chip' },
    'Segment ',
    h('b', {}, segment.name),
    h('button', { type: 'button', title: 'Remove segment', 'aria-label': 'Remove segment', onClick: onRemove }, '×'),
  );
}

// -------------------------------------------------------------- annotations --

/** Plot padding chart.js uses when it cannot be read back off the DOM. */
const FALLBACK_PAD_LEFT = 28;
const FALLBACK_PAD_RIGHT = 12;
const FALLBACK_PAD_BOTTOM = 24;

/**
 * Markers for dated notes, drawn under the x-axis.
 *
 * chart.js owns everything inside .chart-host and wipes it on every draw, so
 * the markers live in an overlay that is re-attached after each paint rather
 * than in the SVG. The plot rectangle is read back from the gridlines chart.js
 * just drew: its left padding is measured from the widest y-axis label, so it
 * cannot be recomputed here without duplicating that measurement.
 *
 * @param {object} options
 * @param {HTMLElement} options.host   The .chart-host element.
 * @param {boolean} options.canEdit
 * @param {(date: string) => void} options.onAdd     Alt+click on the graph.
 * @param {(date: string) => void} options.onOpen    Click on a marker.
 */
export function createAnnotationLayer({ host, canEdit, onAdd, onOpen }) {
  const overlay = h('div', {
    class: 'annotation-layer',
    style: { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '5' },
  });
  const tip = h('div', {
    class: 'chart-tooltip',
    style: { display: 'none', maxWidth: '240px', whiteSpace: 'normal', pointerEvents: 'none' },
  });
  overlay.appendChild(tip);

  let points = [];
  let notes = [];

  /** The plot rectangle, in CSS pixels relative to the host. */
  function geometry() {
    const svg = host.querySelector('svg');
    if (!svg) return null;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return null;

    // The SVG's user units are its pixel size, but a zoomed page can scale it.
    const units = Number(svg.getAttribute('width')) || width;
    const scale = units ? width / units : 1;

    let left = FALLBACK_PAD_LEFT;
    let right = units - FALLBACK_PAD_RIGHT;
    let bottom = (height / (scale || 1)) - FALLBACK_PAD_BOTTOM;

    const lines = [...host.querySelectorAll('.chart-grid line')];
    if (lines.length) {
      left = Number(lines[0].getAttribute('x1'));
      right = Number(lines[0].getAttribute('x2'));
      // Gridlines are evenly spaced and the baseline is one step below the
      // lowest of them — chart.js never strokes the zero line itself.
      const ys = lines.map((line) => Number(line.getAttribute('y1'))).sort((a, b) => a - b);
      const last = ys[ys.length - 1];
      if (ys.length > 1) bottom = last + (last - ys[ys.length - 2]);
    }

    const span = Math.max(1, right - left);
    const count = points.length;
    return {
      bottom: bottom * scale,
      xAt: (i) => (count <= 1 ? left + span / 2 : left + (span * i) / (count - 1)) * scale,
      indexAt: (px) => {
        if (count <= 1) return 0;
        const raw = Math.round((px / (scale || 1) - left) / (span / (count - 1)));
        return Math.min(count - 1, Math.max(0, raw));
      },
    };
  }

  function showTip(marker, lines) {
    replace(tip, ...lines.map((line, index) => h('div', { class: index ? '' : 'tt-title' }, line)));
    tip.style.display = 'block';
    // Measured after it is visible, so a long note is clamped, not clipped.
    const width = tip.offsetWidth;
    const x = Number(marker.dataset.x) || 0;
    const max = Math.max(0, host.clientWidth - width - 4);
    tip.style.left = `${Math.min(max, Math.max(4, x - width / 2))}px`;
    tip.style.top = `${Math.max(0, (Number(marker.dataset.y) || 0) - tip.offsetHeight - 8)}px`;
  }

  const hideTip = () => {
    tip.style.display = 'none';
  };

  function place() {
    if (!host.isConnected) return;
    // drawChart() empties the host, so the overlay is re-hung on every paint.
    if (overlay.parentNode !== host) host.appendChild(overlay);

    for (const node of [...overlay.children]) {
      if (node !== tip) node.remove();
    }
    hideTip();

    const g = geometry();
    if (!g || !points.length || !notes.length) return;

    const buckets = new Map();
    for (const note of notes) {
      const index = bucketFor(points, String(note.date || '').slice(0, 10));
      if (index < 0) continue;
      if (!buckets.has(index)) buckets.set(index, []);
      buckets.get(index).push(note);
    }

    for (const [index, group] of buckets) {
      const x = g.xAt(index);
      // Straddling the baseline: mostly below it, clear of the x-axis labels
      // that start about nine pixels further down at either chart height.
      const y = g.bottom - 2;
      const date = String(group[0].date).slice(0, 10);
      const label =
        group.length === 1
          ? `Note on ${date}: ${group[0].text}`
          : `${group.length} notes on ${date}`;

      const marker = h('button', {
        type: 'button',
        'aria-label': label,
        dataset: { x: String(x), y: String(y) },
        style: {
          position: 'absolute',
          left: `${x}px`,
          top: `${y}px`,
          transform: 'translateX(-50%)',
          width: '9px',
          height: '9px',
          padding: '0',
          border: '1px solid var(--panel)',
          borderRadius: '50%',
          background: 'var(--accent)',
          cursor: 'pointer',
          pointerEvents: 'auto',
          lineHeight: '0',
        },
        onClick: () => onOpen(date),
      });

      const lines = [date, ...group.map((note) => note.text)];
      marker.addEventListener('mouseenter', () => showTip(marker, lines));
      marker.addEventListener('focus', () => showTip(marker, lines));
      marker.addEventListener('mouseleave', hideTip);
      marker.addEventListener('blur', hideTip);
      overlay.appendChild(marker);
    }
  }

  // Alt+click proposes a note on the bucket under the pointer. Capture phase,
  // because chart.js listens for clicks on a transparent rect below us.
  host.addEventListener(
    'click',
    (event) => {
      if (!canEdit || !event.altKey) return;
      const g = geometry();
      if (!g) return;
      event.preventDefault();
      event.stopPropagation();
      const point = points[g.indexAt(event.clientX - host.getBoundingClientRect().left)];
      if (point) onAdd(String(point.date).slice(0, 10));
    },
    true,
  );

  // A resize redraws the chart from chart.js's own observer; deferring a frame
  // means the gridlines we measure are the new ones.
  const reflow = () => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(place);
    else place();
  };
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(reflow);
    observer.observe(host);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', reflow);
  }

  return {
    update(next) {
      points = Array.isArray(next.points) ? next.points : [];
      notes = Array.isArray(next.annotations) ? next.annotations : [];
      place();
    },
    /** Called when the view is torn down; the host may outlive the observer. */
    destroy() {
      if (observer) observer.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', reflow);
      overlay.remove();
    },
  };
}

/**
 * Which bucket a YYYY-MM-DD note belongs to. An exact match wins, so hourly
 * buckets pin the note to the start of its day; otherwise it falls into the
 * last bucket that starts on or before it, which is what week and month
 * intervals need.
 */
function bucketFor(points, date) {
  let fallback = -1;
  for (let i = 0; i < points.length; i += 1) {
    const day = String(points[i].date || '').slice(0, 10);
    if (day === date) return i;
    if (day && day <= date) fallback = i;
  }
  return fallback;
}

/** "Add a note on <date>". */
export function openAnnotationDialog({ domain, date, onSaved }) {
  const body = h('form', {});
  const when = h('input', { type: 'date', value: date, required: true });
  const text = h('textarea', { rows: '3', required: true, maxlength: '500', placeholder: 'Shipped the new pricing page' });
  const error = h('p', { class: 'error', style: { display: 'none' } });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Add note');

  body.append(
    h('h2', {}, `Add a note on ${date}`),
    h('p', { class: 'hint' }, 'Notes appear as a marker under the graph for everyone who can see this dashboard.'),
    error,
    h('div', { class: 'field' }, h('label', {}, 'Date'), when),
    h('div', { class: 'field' }, h('label', {}, 'Note'), text),
    h(
      'div',
      { class: 'form-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      submit,
    ),
  );

  const close = modal(body);
  text.focus();

  body.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.style.display = 'none';
    try {
      await annotationsApi.create(domain, { date: when.value, text: text.value });
      close();
      toast('Note added');
      onSaved();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      submit.disabled = false;
    }
  };
}

/**
 * The period's notes, in a list. Opened from the ⋮ menu for everything in
 * range, or from a marker for a single day.
 */
export function openAnnotationsDialog({ domain, annotations, canEdit, date = '', onChanged }) {
  const notes = (annotations || []).filter((note) => !date || String(note.date).slice(0, 10) === date);
  const body = h('div', {});
  const list = h('ul', { class: 'list' });
  const error = h('p', { class: 'error', style: { display: 'none' } });
  let changed = false;

  const draw = () => {
    clear(list);
    if (!notes.length) {
      list.appendChild(
        h(
          'li',
          { class: 'notice' },
          canEdit ? 'No notes here yet. Alt+click the graph to add one.' : 'No notes here yet.',
        ),
      );
      return;
    }
    for (const note of notes) {
      list.appendChild(
        h(
          'li',
          {},
          h('div', { class: 'grow' }, note.text, h('small', {}, `${note.date}${note.author_email ? ` · ${note.author_email}` : ''}`)),
          canEdit
            ? h(
                'button',
                {
                  class: 'btn danger',
                  type: 'button',
                  title: 'Delete note',
                  'aria-label': `Delete the note from ${note.date}`,
                  onClick: async (event) => {
                    event.currentTarget.disabled = true;
                    error.style.display = 'none';
                    try {
                      await annotationsApi.remove(domain, note.id);
                      notes.splice(notes.indexOf(note), 1);
                      changed = true;
                      draw();
                    } catch (err) {
                      error.textContent = err.message;
                      error.style.display = 'block';
                      event.currentTarget.disabled = false;
                    }
                  },
                },
                icon('trash', 15),
              )
            : null,
        ),
      );
    }
  };

  body.append(
    h('h2', {}, date ? `Notes on ${date}` : 'Notes on this period'),
    h('p', { class: 'hint' }, 'A dated note, drawn under the graph, so next month a spike still has its explanation attached.'),
    error,
    list,
    h(
      'div',
      { class: 'form-actions' },
      canEdit
        ? h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onClick: () => {
                close();
                openAnnotationDialog({ domain, date: date || todayYmd(), onSaved: onChanged });
              },
            },
            icon('plus', 15),
            'Add a note',
          )
        : null,
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: () => {
            close();
            if (changed) onChanged();
          },
        },
        'Done',
      ),
    ),
  );

  draw();
  const close = modal(body);
}

function todayYmd() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
