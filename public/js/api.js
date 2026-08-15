/** Thin client over Credible's own dashboard API. */

/**
 * Where this instance is mounted. Empty at the root of a domain, '/stats' when
 * it is served under a path of a bigger site (see CREDIBLE_BASE_PATH).
 */
export const BASE = String(window.CREDIBLE_BASE || '').replace(/\/+$/, '');

/** Prefix an app path with the mount point. */
export const withBase = (path) => `${BASE}${path}`;

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

const get = (path, query) => request('GET', path, { query });
const post = (path, body) => request('POST', path, { body });
const patch = (path, body) => request('PATCH', path, { body });
const del = (path) => request('DELETE', path);

export const api = {
  // auth
  me: () => get('/api/auth/me'),
  login: (email, password) => post('/api/auth/login', { email, password }),
  register: (email, password, name) => post('/api/auth/register', { email, password, name }),
  logout: () => post('/api/auth/logout', {}),

  // sites
  sites: () => get('/api/sites'),
  createSite: (domain, timezone, currency) => post('/api/sites', { domain, timezone, currency }),
  site: (domain) => get(`/api/sites/${encodeURIComponent(domain)}`),
  updateSite: (domain, patchBody) => patch(`/api/sites/${encodeURIComponent(domain)}`, patchBody),
  deleteSite: (domain) => del(`/api/sites/${encodeURIComponent(domain)}`),
  addMember: (domain, email, role) => post(`/api/sites/${encodeURIComponent(domain)}/members`, { email, role }),

  // goals & funnels
  createGoal: (domain, goal) => post(`/api/sites/${encodeURIComponent(domain)}/goals`, goal),
  deleteGoal: (domain, id) => del(`/api/sites/${encodeURIComponent(domain)}/goals/${id}`),
  createFunnel: (domain, name, goals) => post(`/api/sites/${encodeURIComponent(domain)}/funnels`, { name, goals }),
  deleteFunnel: (domain, id) => del(`/api/sites/${encodeURIComponent(domain)}/funnels/${id}`),

  // sharing & keys
  createSharedLink: (domain, name, password) =>
    post(`/api/sites/${encodeURIComponent(domain)}/shared-links`, { name, password }),
  deleteSharedLink: (domain, slug) => del(`/api/sites/${encodeURIComponent(domain)}/shared-links/${slug}`),
  unlockShared: (slug, password) => post(`/api/shared/${slug}/unlock`, { password }),
  keys: () => get('/api/keys'),
  createKey: (name) => post('/api/keys', { name }),
  deleteKey: (id) => del(`/api/keys/${id}`),

  // stats
  dashboard: (domain, query) => get(`/api/stats/${encodeURIComponent(domain)}/dashboard`, query),
  breakdown: (domain, query) => get(`/api/stats/${encodeURIComponent(domain)}/breakdown`, query),
  properties: (domain, query) => get(`/api/stats/${encodeURIComponent(domain)}/properties`, query),
  funnels: (domain, query) => get(`/api/stats/${encodeURIComponent(domain)}/funnels`, query),
  funnel: (domain, id, query) => get(`/api/stats/${encodeURIComponent(domain)}/funnels/${id}`, query),
  realtime: (domain, query) => get(`/api/stats/${encodeURIComponent(domain)}/realtime`, query),
};
