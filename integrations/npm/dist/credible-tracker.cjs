/*! credible-tracker — MIT. Generated from src/index.js; do not edit. */
/**
 * credible-tracker — a thin wrapper around the Credible browser tracker.
 *
 * WHY THIS IS MIT AND THE REST OF CREDIBLE IS NOT
 * This file is bundled into whatever application imports it. AGPL-3.0 code
 * inside a bundle pulls the whole application into AGPL, which would make
 * `npm install credible-tracker` a licensing trap for a proprietary site.
 * The Credible server stays AGPL-3.0-or-later; this wrapper is MIT, for the
 * same reason Plausible's tracker is MIT while their server is AGPL.
 *
 * WHY IT IS A WRAPPER AND NOT A REIMPLEMENTATION
 * Every tracking decision — what counts as an outbound link, when engagement
 * is flushed, how the ingestion endpoint is derived from the script URL, how
 * SPA navigation is detected — lives in tracker/src/credible.js and is served
 * by your instance at /js/cr.js. Copying that logic here would create two
 * implementations that drift apart, and would add 13 KB to every consumer's
 * bundle for the privilege. So this module does exactly three things:
 *
 *   1. build the <script> tag with the right data-* attributes,
 *   2. install the async stub so calls made before the script has loaded are
 *      replayed instead of lost,
 *   3. forward calls to window.credible.
 *
 * NOTHING HERE MAY THROW AT EVENT TIME. A missing configuration value is a
 * developer mistake and init() throws immediately so it is caught in
 * development. trackEvent() and trackPageview() run in production on a
 * visitor's machine, so they swallow everything: analytics must never take a
 * host application down.
 *
 * BUILD CONTRACT: build.js rewrites this file into dist/credible-tracker.cjs
 * by stripping `export ` from top-level declarations. Keep every export a
 * top-level `export function`, and never add an import — the build refuses
 * both, loudly, rather than emitting a broken CommonJS file.
 */

/** Path a Credible instance serves the tracker from. */
const SCRIPT_PATH = '/js/cr.js';

/** id on the injected <script>, so a second init() can find its own work. */
const SCRIPT_ID = 'credible-tracker';

/** Set by init({ debug }). Read by warn(). Silent until someone asks. */
let debugEnabled = false;

/* -------------------------------------------------------------------- *
 * Environment
 * -------------------------------------------------------------------- */

/**
 * The browser globals, or null when there are none.
 *
 * Read through globalThis rather than the bare `window` / `document`
 * identifiers on purpose: it keeps server-side rendering a plain null check
 * instead of a ReferenceError, and it lets the test suite install a fake DOM.
 *
 * @returns {{ win: object, doc: object } | null}
 */
function environment() {
  const scope = typeof globalThis === 'undefined' ? null : globalThis;
  if (!scope || !scope.window || !scope.document) return null;
  return { win: scope.window, doc: scope.document };
}

/** Console feedback, but only when the caller asked for it. */
function warn(message) {
  if (!debugEnabled) return;
  if (typeof console !== 'undefined' && console && console.warn) {
    console.warn('[credible-tracker] ' + message);
  }
}

/* -------------------------------------------------------------------- *
 * Configuration -> script tag
 * -------------------------------------------------------------------- */

/** Ensure a leading slash, so 'js/cr.js' and '/js/cr.js' behave the same. */
function normalizePath(value) {
  const path = String(value).trim();
  return path.charAt(0) === '/' ? path : '/' + path;
}

/**
 * Where the script is loaded from.
 *
 * The tracker derives its ingestion endpoint from this URL by replacing the
 * trailing `/js/<file>` with `/api/event`, so an instance mounted under a
 * sub-path works with no extra configuration:
 *   https://stats.example.com      -> https://stats.example.com/js/cr.js
 *   https://example.com/stats      -> https://example.com/stats/js/cr.js
 * A relative instanceUrl ('/_stats') is equally valid and is what first-party
 * proxying looks like: the script and the events both come from your origin.
 */
function scriptUrl(options) {
  if (options.src) return String(options.src).trim();
  const base = String(options.instanceUrl == null ? '' : options.instanceUrl).trim();
  if (!base) {
    throw new Error(
      'credible-tracker: init() needs `instanceUrl` (the origin of your Credible ' +
        'instance, e.g. "https://stats.example.com") or an explicit `src`.',
    );
  }
  return base.replace(/\/+$/, '') + normalizePath(options.scriptPath || SCRIPT_PATH);
}

/** Accept 'a.com', 'a.com,b.com' or ['a.com', 'b.com'] and normalise to a list. */
function toList(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = String(raw[i]).trim();
    if (item) out.push(item);
  }
  return out;
}

/**
 * The data-* attributes for the script tag.
 *
 * Boolean flags are emitted as the string "true" and omitted when off, which
 * is what the tracker's flag() reader expects: it accepts a present attribute
 * whose value is empty, "true" or "1", and reads anything else — including
 * "yes" and "false" — as off.
 */
function attributesFor(options) {
  const domains = toList(options.domain);
  if (!domains.length) {
    throw new Error(
      'credible-tracker: init() needs `domain` — the site exactly as you added it ' +
        'in the Credible dashboard, e.g. "example.com".',
    );
  }

  const attributes = { 'data-domain': domains.join(',') };
  if (options.api) attributes['data-api'] = String(options.api).trim();

  const exclude = toList(options.exclude);
  if (exclude.length) attributes['data-exclude'] = exclude.join(',');

  if (options.hash) attributes['data-hash'] = 'true';
  if (options.respectDnt) attributes['data-respect-dnt'] = 'true';
  if (options.trackLocalhost) attributes['data-track-localhost'] = 'true';
  if (options.debug) attributes['data-debug'] = 'true';
  return attributes;
}

/** The tracker script this module already put on the page, if any. */
function findExistingScript(doc, url) {
  if (doc.getElementById) {
    const byId = doc.getElementById(SCRIPT_ID);
    if (byId) return byId;
  }
  if (!doc.querySelectorAll) return null;
  const scripts = doc.querySelectorAll('script[data-domain]');
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    const src = script.getAttribute ? script.getAttribute('src') : null;
    if (src === url) return script;
  }
  return null;
}

/**
 * Install the async stub documented in docs/TRACKING.md, or return the
 * function that is already there.
 *
 * The tracker reads window.credible.q on boot, replays every queued call in
 * order, and then replaces `q` with a live object whose push() executes
 * immediately. So the same call site works before the script has arrived,
 * while it is loading, and long after — which is the whole point of exposing
 * trackEvent() as a plain import in a framework app.
 */
function ensureStub(win) {
  if (typeof win.credible === 'function') return win.credible;
  const stub = function () {
    (stub.q = stub.q || []).push(arguments);
  };
  win.credible = stub;
  return stub;
}

/* -------------------------------------------------------------------- *
 * Public API
 * -------------------------------------------------------------------- */

/**
 * Load the Credible tracker.
 *
 * Safe to call more than once: React StrictMode mounts effects twice in
 * development, and a second call finds the script it injected the first time
 * and returns it instead of loading the tracker again.
 *
 * On the server it returns null without touching anything, so it can sit in a
 * module that is imported during SSR. Call it again on the client.
 *
 * Note that the tracker sends a pageview as soon as it runs, and patches
 * history.pushState / replaceState itself — so a client-side router needs no
 * trackPageview() call, and adding one right after init() double-counts the
 * first page.
 *
 * @param {object} options
 * @param {string} [options.instanceUrl] Origin of your instance. Required unless `src` is given.
 * @param {string|string[]} options.domain Site domain(s), exactly as added in the dashboard.
 * @param {string} [options.src] Full script URL, overriding instanceUrl + scriptPath.
 * @param {string} [options.scriptPath] Path to the tracker. Defaults to '/js/cr.js'.
 * @param {string} [options.api] data-api: the ingestion endpoint, when you proxy it.
 * @param {boolean} [options.hash] data-hash: treat #fragments as pages.
 * @param {string|string[]} [options.exclude] data-exclude: path globs never tracked.
 * @param {boolean} [options.respectDnt] data-respect-dnt: honour Do Not Track.
 * @param {boolean} [options.trackLocalhost] data-track-localhost: count local traffic.
 * @param {boolean} [options.debug] data-debug, and warnings from this wrapper.
 * @param {boolean} [options.defer] Load with `defer`. Defaults to true.
 * @param {Function} [options.onLoad] Called once the tracker has loaded.
 * @param {Function} [options.onError] Called when the request fails — usually a content blocker.
 * @returns {object|null} The script element, or null during SSR.
 */
function init(options) {
  const settings = options || {};
  debugEnabled = !!settings.debug;

  // Validate before touching the DOM: a configuration mistake should fail the
  // same way on the server and in the browser, not only where a DOM exists.
  const url = scriptUrl(settings);
  const attributes = attributesFor(settings);

  const env = environment();
  if (!env) return null; // Server-side render. Hydration calls init() again.
  const win = env.win;
  const doc = env.doc;

  const existing = findExistingScript(doc, url);
  if (existing) {
    warn('the tracker is already on this page; init() did nothing');
    return existing;
  }

  ensureStub(win);

  const script = doc.createElement('script');
  script.id = SCRIPT_ID;
  if (settings.defer !== false) script.defer = true;
  for (const name in attributes) {
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      script.setAttribute(name, attributes[name]);
    }
  }
  if (typeof settings.onLoad === 'function') script.onload = settings.onLoad;
  if (typeof settings.onError === 'function') script.onerror = settings.onError;

  // src last: the fetch starts on insertion, and this keeps the element fully
  // configured at every point a reader of this code might stop.
  script.src = url;

  const parent = doc.head || doc.body || doc.documentElement;
  if (!parent || !parent.appendChild) {
    warn('the document has no <head> to attach the tracker to');
    return null;
  }
  parent.appendChild(script);
  return script;
}

/**
 * Send a custom event.
 *
 * Queued when the tracker has not loaded yet, dropped on the server, and
 * never thrown: this runs on a visitor's machine.
 *
 * @param {string} name Event name, e.g. 'Signup'.
 * @param {object} [options] { props, revenue, callback, url, referrer }
 */
function trackEvent(name, options) {
  if (!name || typeof name !== 'string') {
    warn('trackEvent() needs a non-empty event name');
    return;
  }
  const env = environment();
  if (!env) return; // SSR: there is no visitor to count.
  try {
    ensureStub(env.win)(name, options || {});
  } catch (error) {
    warn('trackEvent("' + name + '") failed: ' + error);
  }
}

/**
 * Send a pageview, and make that URL the one engagement is measured against.
 *
 * The tracker already sends one on load and one per history navigation, so
 * this is for virtual pageviews — a multi-step form, a modal you count as a
 * page — not for ordinary routing.
 *
 * @param {object} [overrides] { url, referrer, props, revenue, callback }
 */
function trackPageview(overrides) {
  trackEvent('pageview', overrides || {});
}

module.exports = { init, trackEvent, trackPageview };
