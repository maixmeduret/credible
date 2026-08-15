/**
 * Tracker tests.
 *
 * The built file (public/js/cr.js) is executed against a hand written fake DOM:
 * plain objects for window / document / navigator / history / location that
 * record listeners and captured requests. No jsdom — it would be a dependency,
 * and the tracker only touches a handful of DOM APIs anyway.
 *
 * The build runs first, so these tests cover the minifier output, not the
 * source: a minifier bug fails the suite exactly like a tracker bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { minify } from '../tracker/build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'tracker', 'build.js');
const OUT_DIR = path.join(ROOT, 'public', 'js');

// Build once for the whole file. A build failure throws here and fails everything.
execFileSync(process.execPath, [BUILD], { stdio: 'pipe' });

// The tracker is a top-level IIFE reading `window` and `document`, so wrapping
// it in a function with those two parameters is enough to sandbox it.
const TRACKER = fs.readFileSync(path.join(OUT_DIR, 'cr.js'), 'utf8');
const TRACKER_DEBUG = fs.readFileSync(path.join(OUT_DIR, 'cr.debug.js'), 'utf8');
const load = new Function('window', 'document', TRACKER);
const loadDebug = new Function('window', 'document', TRACKER_DEBUG);

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */

/** Give an object addEventListener/removeEventListener backed by a registry. */
function withListeners(target) {
  target.listeners = Object.create(null);
  target.addEventListener = function (type, handler) {
    if (typeof handler !== 'function') return;
    (this.listeners[type] || (this.listeners[type] = [])).push(handler);
  };
  target.removeEventListener = function (type, handler) {
    const list = this.listeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index > -1) list.splice(index, 1);
  };
  return target;
}

/**
 * Build an isolated browser-ish environment.
 *
 * @param {object} [options]
 * @param {string} [options.url]        page URL
 * @param {string} [options.src]        script src, decides the ingestion origin
 * @param {object} [options.attrs]      extra data-* attributes on the script tag
 * @param {string} [options.domain]     data-domain value
 * @param {string|null} [options.referrer]
 * @param {boolean} [options.sendBeacon] false to force the XHR fallback
 * @param {string|null} [options.doNotTrack]
 * @param {object} [options.storage]    fake localStorage contents
 */
function createEnv(options = {}) {
  const settings = {
    url: 'https://example.com/pricing?ref=hn',
    src: 'https://cdn.credible.test/js/cr.js',
    domain: 'example.com',
    referrer: 'https://news.ycombinator.com/',
    sendBeacon: true,
    doNotTrack: null,
    attrs: {},
    storage: {},
    ...options
  };

  const requests = []; // { transport, url, body, headers }
  const warnings = [];
  const timers = [];

  const location = {};
  const setLocation = (href) => {
    const next = new URL(href, location.href || settings.url);
    Object.assign(location, {
      href: next.href,
      protocol: next.protocol,
      hostname: next.hostname,
      host: next.host,
      port: next.port,
      pathname: next.pathname,
      search: next.search,
      hash: next.hash,
      origin: next.origin
    });
  };
  setLocation(settings.url);

  const element = (tag, attrs = {}, extra = {}) => {
    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      className: '',
      parentNode: null,
      attributes: Object.keys(attrs).map((name) => ({ name, value: String(attrs[name]) })),
      getAttribute(name) {
        for (const item of this.attributes) if (item.name === name) return item.value;
        return null;
      },
      hasAttribute(name) {
        return this.attributes.some((item) => item.name === name);
      }
    };
    return Object.assign(el, extra);
  };

  const scriptAttrs = { 'data-domain': settings.domain, ...settings.attrs };
  const script = element('script', scriptAttrs, { src: settings.src });

  const cookieAccess = [];
  const document = withListeners({
    currentScript: script,
    referrer: settings.referrer === null ? '' : settings.referrer,
    visibilityState: 'visible',
    hidden: false,
    documentElement: { clientWidth: 1440, clientHeight: 800, scrollHeight: 2000, scrollTop: 0 },
    body: { clientWidth: 1440, scrollHeight: 2000, offsetHeight: 2000, scrollTop: 0 },
    getElementsByTagName: () => [script]
  });

  // Any read or write of document.cookie is recorded so a test can prove the
  // tracker never touches it.
  Object.defineProperty(document, 'cookie', {
    get() {
      cookieAccess.push('read');
      return '';
    },
    set(value) {
      cookieAccess.push('write:' + value);
    }
  });

  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.headers = {};
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      requests.push({ transport: 'xhr', url: this.url, headers: this.headers, body: JSON.parse(body) });
      this.readyState = 4;
      this.status = 202;
      if (this.onreadystatechange) this.onreadystatechange();
    }
  }

  const navigator = { userAgent: 'fake', doNotTrack: settings.doNotTrack };
  if (settings.sendBeacon) {
    navigator.sendBeacon = (url, body) => {
      requests.push({ transport: 'beacon', url, body: JSON.parse(body) });
      return true;
    };
  }

  const history = {
    pushState(state, title, url) {
      setLocation(url);
    },
    replaceState(state, title, url) {
      setLocation(url);
    }
  };

  const window = withListeners({
    location,
    document,
    navigator,
    history,
    innerWidth: 1440,
    innerHeight: 800,
    pageYOffset: 0,
    XMLHttpRequest: FakeXHR,
    console: { warn: (message) => warnings.push(String(message)), log() {}, error() {} },
    localStorage: {
      getItem: (key) => (key in settings.storage ? settings.storage[key] : null)
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: () => {}
  });

  const fire = (target, type, event = {}) => {
    for (const handler of (target.listeners[type] || []).slice()) handler(event);
    return event;
  };

  return {
    window,
    document,
    location,
    script,
    requests,
    warnings,
    timers,
    element,
    fire,
    setLocation,
    cookieAccess,
    load: () => load(window, document),
    loadSource: () => loadDebug(window, document),
    /** Parsed payloads, optionally filtered by event name. */
    events: (name) => requests.map((r) => r.body).filter((b) => !name || b.n === name),
    click: (target, extra = {}) => ({
      type: 'click',
      button: 0,
      target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra
    })
  };
}

/* ------------------------------------------------------------------ *
 * Build output
 * ------------------------------------------------------------------ */

test('build writes cr.js, script.js and cr.debug.js', () => {
  const min = fs.readFileSync(path.join(OUT_DIR, 'cr.js'));
  const compat = fs.readFileSync(path.join(OUT_DIR, 'script.js'));
  const debug = fs.readFileSync(path.join(OUT_DIR, 'cr.debug.js'), 'utf8');

  assert.ok(min.length > 0, 'cr.js is not empty');
  assert.deepEqual(compat, min, 'script.js is byte identical to cr.js');
  assert.match(debug, /tracker\/src\/credible\.js/, 'debug build carries a source header');
  assert.ok(debug.length > min.length, 'debug build keeps the comments');
  assert.doesNotThrow(() => new Function(min.toString()), 'minified output parses');
});

/* ------------------------------------------------------------------ *
 * Pageviews
 * ------------------------------------------------------------------ */

test('sends a pageview on load with the documented payload', () => {
  const env = createEnv();
  env.load();

  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].transport, 'beacon');
  assert.equal(env.requests[0].url, 'https://cdn.credible.test/api/event');
  assert.deepEqual(env.requests[0].body, {
    n: 'pageview',
    d: 'example.com',
    u: 'https://example.com/pricing?ref=hn',
    r: 'https://news.ycombinator.com/',
    w: 1440,
    h: 0
  });
});

test('referrer is null when the page was opened directly', () => {
  const env = createEnv({ referrer: null });
  env.load();
  assert.equal(env.events('pageview')[0].r, null);
});

test('pushState triggers a second pageview, replaceState of the same URL does not', () => {
  const env = createEnv();
  env.load();

  env.window.history.pushState({}, '', '/docs/getting-started');
  env.window.history.replaceState({}, '', '/docs/getting-started');

  const pageviews = env.events('pageview');
  assert.equal(pageviews.length, 2);
  assert.equal(pageviews[1].u, 'https://example.com/docs/getting-started');
});

test('popstate is tracked as a pageview', () => {
  const env = createEnv();
  env.load();

  env.setLocation('/pricing/teams');
  env.fire(env.window, 'popstate', {});

  const pageviews = env.events('pageview');
  assert.equal(pageviews.length, 2);
  assert.equal(pageviews[1].u, 'https://example.com/pricing/teams');
});

test('data-hash tracks the fragment as part of the URL', () => {
  const env = createEnv({ url: 'https://example.com/app#/inbox', attrs: { 'data-hash': 'true' } });
  env.load();

  assert.equal(env.events('pageview')[0].u, 'https://example.com/app#/inbox');
  assert.equal(env.events('pageview')[0].h, 1);

  env.setLocation('https://example.com/app#/settings');
  env.fire(env.window, 'hashchange', {});
  assert.equal(env.events('pageview').length, 2);
  assert.equal(env.events('pageview')[1].u, 'https://example.com/app#/settings');
});

test('the fragment is dropped when hash mode is off', () => {
  const env = createEnv({ url: 'https://example.com/app#/inbox' });
  env.load();
  assert.equal(env.events('pageview')[0].u, 'https://example.com/app');
});

test('a comma separated data-domain sends one request per site', () => {
  const env = createEnv({ domain: 'example.com, second.example' });
  env.load();

  assert.deepEqual(
    env.events('pageview').map((body) => body.d),
    ['example.com', 'second.example']
  );
});

/* ------------------------------------------------------------------ *
 * Opt-outs
 * ------------------------------------------------------------------ */

test('an excluded path sends nothing at all', () => {
  const env = createEnv({
    url: 'https://example.com/admin/settings',
    attrs: { 'data-exclude': '/admin/*, /private/**', 'data-debug': '' }
  });
  env.load();
  env.window.credible('Signup');

  assert.equal(env.requests.length, 0);
  assert.match(env.warnings.join('\n'), /data-exclude/);
});

test('data-exclude globs: * stays inside a segment, ** crosses them', () => {
  const attrs = { 'data-exclude': '/admin/*, /private/**' };

  const deep = createEnv({ url: 'https://example.com/admin/users/42', attrs });
  deep.load();
  assert.equal(deep.requests.length, 1, '/admin/* does not match a nested path');

  const nested = createEnv({ url: 'https://example.com/private/a/b/c', attrs });
  nested.load();
  assert.equal(nested.requests.length, 0, '/private/** matches any depth');

  const other = createEnv({ url: 'https://example.com/docs', attrs });
  other.load();
  assert.equal(other.requests.length, 1, 'unrelated paths are tracked');
});

test('localhost is never tracked and says so in the console', () => {
  const env = createEnv({ url: 'http://localhost:5173/dashboard' });
  env.load();

  assert.equal(env.requests.length, 0);
  assert.match(env.warnings.join('\n'), /localhost/);
});

test('credible_ignore in the URL or in localStorage disables tracking', () => {
  const param = createEnv({ url: 'https://example.com/?credible_ignore=true' });
  param.load();
  assert.equal(param.requests.length, 0);

  const stored = createEnv({ storage: { credible_ignore: 'true' } });
  stored.load();
  assert.equal(stored.requests.length, 0);

  const other = createEnv({ url: 'https://example.com/?ref=credible_ignore=true-blog' });
  other.load();
  assert.equal(other.requests.length, 1, 'only a real query parameter counts');
});

test('Do Not Track is only honoured with data-respect-dnt', () => {
  const counted = createEnv({ doNotTrack: '1' });
  counted.load();
  assert.equal(counted.requests.length, 1, 'DNT is ignored by default');

  const respected = createEnv({ doNotTrack: '1', attrs: { 'data-respect-dnt': 'true' } });
  respected.load();
  assert.equal(respected.requests.length, 0);
});

/* ------------------------------------------------------------------ *
 * Automatic events
 * ------------------------------------------------------------------ */

test('an outbound link click sends "Outbound Link: Click" and then navigates', () => {
  const env = createEnv();
  env.load();

  const link = env.element('a', {}, { href: 'https://news.ycombinator.com/item?id=1', target: '' });
  const icon = env.element('span', {}, { parentNode: link });
  const event = env.fire(env.document, 'click', env.click(icon));

  const outbound = env.events('Outbound Link: Click');
  assert.equal(outbound.length, 1);
  assert.deepEqual(outbound[0].p, { url: 'https://news.ycombinator.com/item?id=1' });
  assert.equal(outbound[0].u, 'https://example.com/pricing?ref=hn');
  assert.equal(event.defaultPrevented, true, 'same-tab navigation is delayed');
  assert.equal(env.location.href, 'https://news.ycombinator.com/item?id=1', 'and then resumed');
  assert.equal(env.timers[0].delay, 150, 'with a 150 ms safety net');
});

test('a cmd/ctrl or middle click is tracked without touching the navigation', () => {
  const env = createEnv();
  env.load();
  const link = env.element('a', {}, { href: 'https://other.example/' });

  const meta = env.fire(env.document, 'click', env.click(link, { metaKey: true }));
  assert.equal(meta.defaultPrevented, false);

  const middle = env.fire(env.document, 'auxclick', env.click(link, { type: 'auxclick', button: 1 }));
  assert.equal(middle.defaultPrevented, false);
  assert.equal(env.events('Outbound Link: Click').length, 2);
  assert.equal(env.location.href, 'https://example.com/pricing?ref=hn', 'the page did not move');
});

test('internal links are not outbound', () => {
  const env = createEnv();
  env.load();
  const link = env.element('a', {}, { href: 'https://example.com/features' });
  env.fire(env.document, 'click', env.click(link));
  assert.equal(env.events('Outbound Link: Click').length, 0);
  assert.equal(env.requests.length, 1);
});

test('clicking a file link sends "File Download"', () => {
  const env = createEnv();
  env.load();

  const link = env.element('a', {}, { href: 'https://example.com/files/report.pdf' });
  env.fire(env.document, 'click', env.click(link));

  const downloads = env.events('File Download');
  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0].p, { url: 'https://example.com/files/report.pdf' });

  const ignored = env.element('a', {}, { href: 'https://example.com/about.html' });
  env.fire(env.document, 'click', env.click(ignored));
  assert.equal(env.events('File Download').length, 1);
});

test('a hostile DOM node cannot break the host page', () => {
  const env = createEnv({ attrs: { 'data-debug': '' } });
  env.load();

  const hostile = {
    get tagName() {
      throw new Error('boom');
    }
  };
  assert.doesNotThrow(() => env.fire(env.document, 'click', env.click(hostile)));
  assert.match(env.warnings.join('\n'), /click handler failed/);
});

test('form submissions send "Form: Submission"', () => {
  const env = createEnv();
  env.load();
  env.fire(env.document, 'submit', { type: 'submit', target: env.element('form') });
  assert.equal(env.events('Form: Submission').length, 1);
});

test('tagged elements fire their own event with their data props', () => {
  const env = createEnv();
  env.load();

  const button = env.element(
    'button',
    { 'data-credible-event-plan': 'pro', 'data-credible-event-source': 'hero' },
    { className: 'btn credible+Signup+Completed' }
  );
  const label = env.element('span', {}, { parentNode: button });
  env.fire(env.document, 'click', env.click(label));

  const tagged = env.events('Signup Completed');
  assert.equal(tagged.length, 1);
  assert.deepEqual(tagged[0].p, { plan: 'pro', source: 'hero' });
});

test('data-credible-event-name wins over the class convention', () => {
  const env = createEnv();
  env.load();

  const button = env.element(
    'button',
    { 'data-credible-event-name': 'Purchase', 'data-credible-event-tier': 'team' },
    { className: 'credible+Ignored' }
  );
  env.fire(env.document, 'click', env.click(button));

  assert.equal(env.events('Purchase').length, 1);
  assert.deepEqual(env.events('Purchase')[0].p, { tier: 'team' });
});

/* ------------------------------------------------------------------ *
 * Engagement
 * ------------------------------------------------------------------ */

test('engagement is sent when the tab is hidden, never with zero time', async () => {
  const env = createEnv();
  env.load();

  env.window.pageYOffset = 1200; // (1200 + 800) / 2000 -> 100%
  env.fire(env.window, 'scroll', {});

  await new Promise((resolve) => setTimeout(resolve, 20));

  env.document.visibilityState = 'hidden';
  env.document.hidden = true;
  env.fire(env.document, 'visibilitychange', {});

  const engagement = env.events('engagement');
  assert.equal(engagement.length, 1);
  assert.ok(engagement[0].e.t > 0, 'engaged time is measured');
  assert.equal(engagement[0].e.s, 100, 'max scroll depth is reported');
  assert.equal(engagement[0].u, 'https://example.com/pricing?ref=hn');

  // Hidden tab: no time accumulates, so no second engagement event.
  env.fire(env.document, 'visibilitychange', {});
  env.fire(env.window, 'pagehide', {});
  assert.equal(env.events('engagement').length, 1);
});

test('leaving a SPA page reports its engagement before the next pageview', async () => {
  const env = createEnv();
  env.load();
  await new Promise((resolve) => setTimeout(resolve, 20));

  env.window.history.pushState({}, '', '/docs');

  const names = env.requests.map((r) => r.body.n);
  assert.deepEqual(names, ['pageview', 'engagement', 'pageview']);
  assert.equal(env.events('engagement')[0].u, 'https://example.com/pricing?ref=hn');
});

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

test('window.credible sends custom events with props and revenue', () => {
  const env = createEnv();
  env.load();

  env.window.credible('Signup', { props: { plan: 'pro' } });
  const signup = env.events('Signup')[0];
  assert.equal(signup.n, 'Signup');
  assert.equal(signup.d, 'example.com');
  assert.deepEqual(signup.p, { plan: 'pro' });
  assert.equal(signup.u, 'https://example.com/pricing?ref=hn');

  env.window.credible('Purchase', { revenue: { amount: 19.99, currency: 'eur' } });
  assert.deepEqual(env.events('Purchase')[0].v, { amount: 19.99, currency: 'EUR' });
});

test('callbacks run and unusable props are dropped', () => {
  const env = createEnv();
  env.load();

  let called = 0;
  env.window.credible('Signup', {
    props: { ok: 'yes', n: 3, b: true, nested: { a: 1 }, empty: null },
    callback: () => called++
  });

  assert.equal(called, 1);
  assert.deepEqual(env.events('Signup')[0].p, { ok: 'yes', n: 3, b: true });
});

test('trackPageview and trackEvent are exposed', () => {
  const env = createEnv();
  env.load();

  env.window.credible.trackPageview({ url: 'https://example.com/virtual/step-2', referrer: null });
  env.window.credible.trackEvent('Goal');

  const pageviews = env.events('pageview');
  assert.equal(pageviews.length, 2);
  assert.equal(pageviews[1].u, 'https://example.com/virtual/step-2');
  assert.equal(pageviews[1].r, null);
  assert.equal(env.events('Goal').length, 1);
  assert.equal(env.events('Goal')[0].u, 'https://example.com/virtual/step-2');
});

test('the async stub queue is drained on load and stays usable afterwards', () => {
  const env = createEnv();

  // The snippet customers paste before the script has loaded.
  env.window.credible = function () {
    (env.window.credible.q = env.window.credible.q || []).push(arguments);
  };
  env.window.credible('Queued Goal', { props: { source: 'stub' } });
  env.window.credible('Second Queued Goal');

  env.load();

  const names = env.requests.map((r) => r.body.n);
  assert.deepEqual(names, ['pageview', 'Queued Goal', 'Second Queued Goal']);
  assert.deepEqual(env.events('Queued Goal')[0].p, { source: 'stub' });

  // A late push through the stub API is executed immediately.
  env.window.credible.q.push(['Late Goal']);
  assert.equal(env.events('Late Goal').length, 1);
});

test('loading the script twice does not double count', () => {
  const env = createEnv();
  env.load();
  env.load();
  assert.equal(env.events('pageview').length, 1);
});

test('invalid calls are ignored instead of throwing', () => {
  const env = createEnv({ attrs: { 'data-debug': '' } });
  env.load();
  assert.doesNotThrow(() => env.window.credible());
  assert.doesNotThrow(() => env.window.credible(42));
  assert.equal(env.requests.length, 1);
});

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

test('falls back to XHR with a text/plain body when sendBeacon is missing', () => {
  const env = createEnv({ sendBeacon: false });
  env.load();

  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].transport, 'xhr');
  assert.equal(env.requests[0].url, 'https://cdn.credible.test/api/event');
  assert.equal(env.requests[0].headers['Content-Type'], 'text/plain');
  assert.equal(env.requests[0].body.n, 'pageview');
});

test('data-api overrides the ingestion endpoint', () => {
  const env = createEnv({ attrs: { 'data-api': 'https://proxy.example.com/e' } });
  env.load();
  assert.equal(env.requests[0].url, 'https://proxy.example.com/e');
});

test('an instance mounted under a path posts back to that path', () => {
  // First-party serving: the script comes from the measured site's own origin,
  // under a mount point, and its events must go to the same place rather than
  // to the root of the domain.
  const env = createEnv({ src: 'https://example.com/stats/js/cr.js' });
  env.load();
  assert.equal(env.requests[0].url, 'https://example.com/stats/api/event');
});

test('the mount point may be several segments deep', () => {
  const env = createEnv({ src: 'https://example.com/internal/tools/analytics/js/cr.js' });
  env.load();
  assert.equal(env.requests[0].url, 'https://example.com/internal/tools/analytics/api/event');
});

test('a root-mounted instance is unaffected', () => {
  const env = createEnv({ src: 'https://cdn.credible.test/js/cr.js' });
  env.load();
  assert.equal(env.requests[0].url, 'https://cdn.credible.test/api/event');
});

test('a relative script src resolves against the page origin', () => {
  const env = createEnv({ url: 'https://example.com/pricing', src: '/stats/js/cr.js' });
  env.load();
  assert.equal(env.requests[0].url, 'https://example.com/stats/api/event');
});

test('a protocol-relative script src keeps the page protocol', () => {
  const env = createEnv({ url: 'https://example.com/', src: '//cdn.credible.test/stats/js/cr.js' });
  env.load();
  assert.equal(env.requests[0].url, 'https://cdn.credible.test/stats/api/event');
});

test('a missing data-domain disables the script without throwing', () => {
  const env = createEnv({ domain: '' });
  assert.doesNotThrow(() => env.load());
  assert.equal(env.requests.length, 0);
  assert.equal(typeof env.window.credible, 'function');
});

/* ------------------------------------------------------------------ *
 * Minifier
 * ------------------------------------------------------------------ */

test('the minifier keeps strings, regex literals and ASI intact', () => {
  assert.equal(minify('var a = 1; // trailing\nvar b = 2;'), 'var a=1;var b=2;');
  assert.equal(minify('var url = "http://x/y"; /* c */ var z = 1;'), 'var url="http://x/y";var z=1;');
  assert.equal(minify("var s = 'a // b /* c */';"), "var s='a // b /* c */';");
  assert.equal(minify('var re = /a\\/[/*]b/g.test(x);'), 'var re=/a\\/[/*]b/g.test(x);');
  assert.equal(minify('var d = a / b / c;'), 'var d=a/b/c;');
  assert.equal(minify('return /x/.test(y);'), 'return/x/.test(y);');
  assert.equal(minify('if (ok) /a b/.test(s);'), 'if(ok)/a b/.test(s);', 'regex after a statement head');
  assert.equal(minify('var q = f(a) / 2;'), 'var q=f(a)/2;', 'division after a call');
  assert.equal(minify('function f() {}\n/a b/.test(s);'), 'function f(){}\n/a b/.test(s);');
  assert.equal(minify('x[0] / 2;'), 'x[0]/2;');
  assert.equal(minify('var a = b\n+ c;'), 'var a=b\n+c;', 'ASI hazards keep their newline');
  assert.equal(minify('a\n++b;'), 'a\n++b;');
  assert.equal(minify('var a = 1\nvar b = 2'), 'var a=1\nvar b=2');
  assert.equal(minify('function f() {\n  return 1;\n}'), 'function f(){return 1;}');
});

test('the minified build behaves exactly like the source build', () => {
  const scenario = (env) => {
    env.window.credible('Signup', { props: { plan: 'pro' } });
    env.window.history.pushState({}, '', '/checkout');
    const link = env.element('a', {}, { href: 'https://stripe.example/pay' });
    env.fire(env.document, 'click', env.click(link));
    // Engagement carries a wall-clock duration, which cannot match across two
    // runs; everything else must be identical byte for byte.
    return env.requests.map((r) => r.body).filter((body) => body.n !== 'engagement');
  };

  const minified = createEnv();
  minified.load();
  const source = createEnv();
  source.loadSource();

  assert.deepEqual(scenario(minified), scenario(source));
});

test('nothing ever reads or writes a cookie', () => {
  const env = createEnv();
  env.load();
  env.window.credible('Signup', { props: { plan: 'pro' } });
  env.window.history.pushState({}, '', '/checkout');
  env.fire(env.document, 'submit', { type: 'submit', target: env.element('form') });
  env.document.visibilityState = 'hidden';
  env.fire(env.document, 'visibilitychange', {});

  assert.deepEqual(env.cookieAccess, []);
  assert.ok(env.requests.length >= 3, 'the scenario really did send events');
});

test('minified source is smaller and still parses', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tracker', 'src', 'credible.js'), 'utf8');
  const output = minify(source);
  assert.ok(output.length < source.length * 0.75);
  assert.ok(!output.includes('/**'), 'documentation comments are gone');
  assert.doesNotThrow(() => new Function(output));
});
