/**
 * Application shell: bootstrap, client-side routing and the top bar.
 *
 * Routes
 *   /                     sites list (or the dashboard when you only track one)
 *   /:domain              the dashboard
 *   /:domain/settings     site settings
 *   /account              API keys and password
 *   /share/:domain        a shared, read-only dashboard (?auth=<slug>)
 */
import { BASE, api, withBase } from './api.js';
import { clear, h, icon, logo, popover, replace, toast } from './dom.js';
import { renderAuth } from './views/auth.js';
import { renderSites } from './views/sites.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSiteSettings, renderAccount } from './views/settings.js';

const root = document.getElementById('root');

export const state = {
  user: null,
  sites: [],
  registrationOpen: true,
  needsSetup: false,
  shared: false,
};

const THEME_KEY = 'credible.theme';

export function applyTheme(theme) {
  const value = theme || localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.dataset.theme = value;
  localStorage.setItem(THEME_KEY, value);
}

export function navigate(path, { replace: replaceEntry = false } = {}) {
  const url = withBase(path);
  if (replaceEntry) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  render();
}

/** The app path of the current URL, with the mount point removed. */
function appPath() {
  let pathname = location.pathname;
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export { withBase };

/** The stats query lives in the URL so every view is linkable and shareable. */
export function currentQuery() {
  const params = new URLSearchParams(location.search);
  return {
    period: params.get('period') || '30d',
    date: params.get('date') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    // Comparison is on by default — a number without a trend is half a number.
    comparison: params.get('comparison') || 'previous_period',
    filters: params.get('filters') || '',
    auth: params.get('auth') || '',
  };
}

export function setQuery(next, { replace: replaceEntry = true } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value) params.set(key, value);
  }
  const search = params.toString();
  const url = `${location.pathname}${search ? `?${search}` : ''}`;
  if (replaceEntry) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  window.dispatchEvent(new CustomEvent('credible:query'));
}

export async function refreshSession() {
  const me = await api.me();
  state.user = me.user;
  state.sites = me.sites || [];
  state.registrationOpen = me.registration_open;
  state.needsSetup = me.needs_setup;
  return me;
}

// ------------------------------------------------------------------ top bar

function userMenu(anchor) {
  const menu = h('div', {});
  const close = () => closer();
  menu.appendChild(h('div', { class: 'menu-label' }, state.user.email));
  menu.appendChild(
    h('button', { type: 'button', onClick: () => { close(); navigate('/'); } }, 'All sites'),
  );
  menu.appendChild(
    h('button', { type: 'button', onClick: () => { close(); navigate('/account'); } }, 'Account & API keys'),
  );
  menu.appendChild(
    h(
      'button',
      {
        type: 'button',
        onClick: () => {
          const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          close();
        },
      },
      'Switch theme',
      icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 15),
    ),
  );
  menu.appendChild(h('hr'));
  menu.appendChild(
    h(
      'button',
      {
        type: 'button',
        onClick: async () => {
          close();
          await api.logout();
          await refreshSession();
          navigate('/');
        },
      },
      'Sign out',
      icon('logout', 15),
    ),
  );
  const closer = popover(anchor, menu);
  return closer;
}

function topbar() {
  const bar = h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: withBase('/'), onClick: link('/') }, logo(26), 'Credible'),
  );

  const right = h('div', { class: 'topbar-right' });
  if (state.user) {
    right.appendChild(
      h(
        'button',
        { class: 'btn ghost', type: 'button', onClick: () => navigate('/?new=1') },
        icon('plus', 15),
        'Add a site',
      ),
    );
    const initials = (state.user.name || state.user.email).trim()[0]?.toUpperCase() || '?';
    const button = h(
      'button',
      { class: 'btn ghost', type: 'button' },
      state.user.name || state.user.email,
      h('span', { class: 'avatar' }, initials),
    );
    button.addEventListener('click', () => userMenu(button));
    right.appendChild(button);
  } else if (state.shared) {
    right.appendChild(
      h('a', { class: 'btn ghost', href: 'https://github.com/maixmeduret/credible', target: '_blank', rel: 'noreferrer' }, 'Powered by Credible'),
    );
  }
  bar.appendChild(right);
  return bar;
}

function link(path) {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };
}

// ------------------------------------------------------------------- router

const context = {
  get state() {
    return state;
  },
  api,
  navigate,
  currentQuery,
  setQuery,
  refreshSession,
  toast,
  link,
  withBase,
};

async function render() {
  const segments = appPath().split('/').filter(Boolean);
  state.shared = segments[0] === 'share';

  if (!state.user && !state.shared) {
    replace(root, topbar(), await renderAuth(context));
    return;
  }

  const container = h('div', { class: 'container' });
  replace(root, topbar(), container);

  try {
    if (state.shared) {
      await renderDashboard(container, { ...context, domain: segments[1], shared: true });
    } else if (segments.length === 0) {
      if (state.sites.length === 1 && !new URLSearchParams(location.search).get('new')) {
        navigate(`/${state.sites[0].domain}`, { replace: true });
        return;
      }
      await renderSites(container, context);
    } else if (segments[0] === 'account') {
      await renderAccount(container, context);
    } else if (segments.length === 2 && segments[1] === 'settings') {
      await renderSiteSettings(container, { ...context, domain: segments[0] });
    } else if (segments.length === 1) {
      await renderDashboard(container, { ...context, domain: segments[0] });
    } else {
      container.appendChild(h('div', { class: 'empty' }, 'Page not found'));
    }
  } catch (err) {
    clear(container);
    container.appendChild(
      h(
        'div',
        { class: 'card', style: { padding: '28px', marginTop: '40px', textAlign: 'center' } },
        h('h2', { style: { margin: '0 0 6px' } }, 'Something went wrong'),
        h('p', { class: 'notice' }, err.message),
        h('button', { class: 'btn', type: 'button', onClick: () => render() }, 'Try again'),
      ),
    );
  }
}

window.addEventListener('popstate', render);

applyTheme();
refreshSession()
  .then(render)
  .catch(() => {
    replace(root, h('div', { class: 'boot' }, h('p', { class: 'notice' }, 'Credible is starting…')));
    setTimeout(() => refreshSession().then(render).catch(() => {}), 1500);
  });

export { render, context };
