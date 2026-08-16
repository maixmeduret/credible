/**
 * credible-tracker tests.
 *
 * The built files are exercised, not the source, so a build bug fails exactly
 * like a wrapper bug. Both entries are loaded — the ESM one by import, the
 * CommonJS one by require — and the behavioural suite runs twice, once
 * against each, because a dual package whose two halves disagree is the
 * classic way this kind of build goes wrong.
 *
 * The DOM is a handful of plain objects. No jsdom: this repository has no
 * dependencies, and the wrapper touches six DOM methods in total.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { toCommonJs, toEsm } from '../build.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

// Nothing here rebuilds dist/. It used to run build.js first, which made the
// freshness check at the bottom of this file tautological — it compared a
// just-written dist against the source it had just been written from, so it
// could never fail. Corrupting dist/credible-tracker.cjs and running this file
// passed, and silently restored the corrupted file. The committed dist is what
// npm publishes, so that is what these tests load and assert against; when it
// is stale, the freshness test fails and `node build.js` is the fix.
const esm = await import('../dist/credible-tracker.js');
const cjs = createRequire(import.meta.url)('../dist/credible-tracker.cjs');

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */

/** A script element with just enough surface for the wrapper. */
function fakeElement() {
  return {
    attributes: Object.create(null),
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
  };
}

/**
 * Install a fake window/document on globalThis and return it.
 * `restore()` puts the globals back exactly as they were.
 */
function installDom() {
  const created = [];
  const appended = [];
  const head = {
    appendChild(node) {
      appended.push(node);
      return node;
    },
  };
  const doc = {
    head,
    createElement() {
      const el = fakeElement();
      created.push(el);
      return el;
    },
    getElementById(id) {
      for (let i = 0; i < appended.length; i++) {
        if (appended[i].id === id) return appended[i];
      }
      return null;
    },
    querySelectorAll() {
      return appended.filter((node) => node.getAttribute('data-domain') != null);
    },
  };
  const win = { document: doc };

  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  globalThis.window = win;
  globalThis.document = doc;

  return {
    win,
    doc,
    created,
    appended,
    /** The single script the wrapper injected. Fails loudly when there isn't one. */
    script() {
      assert.equal(appended.length, 1, 'expected exactly one injected script');
      return appended[0];
    },
    restore() {
      for (const key of ['window', 'document']) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
        else delete globalThis[key];
      }
    },
  };
}

/** Run `body` with a fresh fake DOM, always tearing it down. */
function withDom(body) {
  const dom = installDom();
  try {
    return body(dom);
  } finally {
    dom.restore();
  }
}

/** Run `body` with no browser globals at all — the SSR case. */
function withoutDom(body) {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  delete globalThis.window;
  delete globalThis.document;
  try {
    return body();
  } finally {
    for (const key of ['window', 'document']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
    }
  }
}

/**
 * Stand in for the real tracker booting: it drains window.credible.q, then
 * replaces the stub with a live function. Mirrors tracker/src/credible.js.
 */
function bootTracker(win) {
  const calls = [];
  const queued = win.credible && win.credible.q;
  const credible = function () {
    calls.push(Array.prototype.slice.call(arguments));
  };
  credible.l = true;
  credible.q = {
    push(args) {
      credible.apply(null, args);
    },
  };
  win.credible = credible;
  if (queued && queued.length) {
    for (let i = 0; i < queued.length; i++) credible.apply(null, queued[i]);
  }
  return calls;
}

/* ------------------------------------------------------------------ *
 * Behavioural suite, run against both builds
 * ------------------------------------------------------------------ */

for (const [flavour, api] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  const { init, trackEvent, trackPageview } = api;

  test(`[${flavour}] init injects a deferred script at <instanceUrl>/js/cr.js`, () => {
    withDom((dom) => {
      const returned = init({ instanceUrl: 'https://stats.example.com', domain: 'example.com' });
      const script = dom.script();
      assert.equal(returned, script);
      assert.equal(script.src, 'https://stats.example.com/js/cr.js');
      assert.equal(script.defer, true);
      assert.equal(script.id, 'credible-tracker');
      assert.equal(script.getAttribute('data-domain'), 'example.com');
    });
  });

  test(`[${flavour}] instance URL trailing slashes and sub-paths are handled`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://stats.example.com///', domain: 'a.com' });
      assert.equal(dom.script().src, 'https://stats.example.com/js/cr.js');
    });
    withDom((dom) => {
      init({ instanceUrl: 'https://example.com/stats', domain: 'a.com' });
      assert.equal(dom.script().src, 'https://example.com/stats/js/cr.js');
    });
    // A relative instance URL is what first-party proxying looks like.
    withDom((dom) => {
      init({ instanceUrl: '/_stats', domain: 'a.com' });
      assert.equal(dom.script().src, '/_stats/js/cr.js');
    });
  });

  test(`[${flavour}] src and scriptPath override the derived URL`, () => {
    withDom((dom) => {
      init({ src: 'https://example.com/x/js/script.js', domain: 'a.com' });
      assert.equal(dom.script().src, 'https://example.com/x/js/script.js');
    });
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example.com', scriptPath: 'js/script.js', domain: 'a.com' });
      assert.equal(dom.script().src, 'https://s.example.com/js/script.js');
    });
  });

  test(`[${flavour}] domain accepts a string, a comma list and an array`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: ' example.com , example.org ' });
      assert.equal(dom.script().getAttribute('data-domain'), 'example.com,example.org');
    });
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: ['a.com', ' b.com'] });
      assert.equal(dom.script().getAttribute('data-domain'), 'a.com,b.com');
    });
  });

  test(`[${flavour}] boolean options emit exactly the attribute values the tracker accepts`, () => {
    withDom((dom) => {
      init({
        instanceUrl: 'https://s.example',
        domain: 'a.com',
        hash: true,
        respectDnt: true,
        trackLocalhost: true,
        debug: true,
        api: 'https://a.com/_s/api/event',
        exclude: ['/admin/*', '/private/**'],
      });
      const script = dom.script();
      // The tracker's flag() reads a present attribute valued "", "true" or
      // "1" as on, and anything else — including "yes" — as off.
      assert.equal(script.getAttribute('data-hash'), 'true');
      assert.equal(script.getAttribute('data-respect-dnt'), 'true');
      assert.equal(script.getAttribute('data-track-localhost'), 'true');
      assert.equal(script.getAttribute('data-debug'), 'true');
      assert.equal(script.getAttribute('data-api'), 'https://a.com/_s/api/event');
      assert.equal(script.getAttribute('data-exclude'), '/admin/*,/private/**');
    });
  });

  test(`[${flavour}] options left off produce no attribute at all`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: 'a.com', hash: false, debug: false });
      const script = dom.script();
      assert.deepEqual(Object.keys(script.attributes), ['data-domain']);
      assert.equal(script.getAttribute('data-hash'), null);
    });
  });

  test(`[${flavour}] defer can be turned off`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: 'a.com', defer: false });
      assert.equal(dom.script().defer, undefined);
    });
  });

  test(`[${flavour}] onLoad and onError are wired to the element`, () => {
    withDom((dom) => {
      const onLoad = () => {};
      const onError = () => {};
      init({ instanceUrl: 'https://s.example', domain: 'a.com', onLoad, onError });
      assert.equal(dom.script().onload, onLoad);
      assert.equal(dom.script().onerror, onError);
    });
  });

  test(`[${flavour}] init is idempotent — StrictMode double mount injects once`, () => {
    withDom((dom) => {
      const first = init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      const second = init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      assert.equal(dom.appended.length, 1);
      assert.equal(second, first);
    });
  });

  test(`[${flavour}] a second instance on the same page is still injected`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://one.example', domain: 'a.com' });
      // getElementById would match the first script, so the guard must look at
      // the src too; two instances is a real configuration, not a mistake.
      dom.appended[0].id = 'other';
      init({ instanceUrl: 'https://two.example', domain: 'a.com' });
      assert.equal(dom.appended.length, 2);
    });
  });

  test(`[${flavour}] init installs the async stub before the script loads`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      assert.equal(typeof dom.win.credible, 'function');
      assert.equal(dom.win.credible.q, undefined, 'the queue is created lazily, on first call');
    });
  });

  test(`[${flavour}] calls made before the tracker loads are replayed in order`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      trackEvent('Signup', { props: { plan: 'pro' } });
      trackPageview({ url: 'https://a.com/step-2' });
      trackEvent('Purchase', { revenue: { amount: 19.99, currency: 'EUR' } });

      const calls = bootTracker(dom.win);
      assert.deepEqual(
        calls.map((call) => call[0]),
        ['Signup', 'pageview', 'Purchase'],
      );
      assert.deepEqual(calls[0][1], { props: { plan: 'pro' } });
      assert.deepEqual(calls[1][1], { url: 'https://a.com/step-2' });
      assert.deepEqual(calls[2][1], { revenue: { amount: 19.99, currency: 'EUR' } });
    });
  });

  test(`[${flavour}] once the tracker is live, calls reach it directly`, () => {
    withDom((dom) => {
      init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      const calls = bootTracker(dom.win);
      trackEvent('Late Goal');
      assert.deepEqual(calls, [['Late Goal', {}]]);
    });
  });

  test(`[${flavour}] tracking works without init — the stub is created on demand`, () => {
    withDom((dom) => {
      trackEvent('Standalone');
      const calls = bootTracker(dom.win);
      assert.deepEqual(calls, [['Standalone', {}]]);
    });
  });

  test(`[${flavour}] trackPageview defaults to an empty override object`, () => {
    withDom((dom) => {
      trackPageview();
      const calls = bootTracker(dom.win);
      assert.deepEqual(calls, [['pageview', {}]]);
    });
  });

  test(`[${flavour}] a bad event name is dropped, never thrown`, () => {
    withDom((dom) => {
      trackEvent('');
      trackEvent(null);
      trackEvent(42);
      assert.equal(dom.win.credible, undefined, 'nothing was queued');
    });
  });

  test(`[${flavour}] a throwing tracker cannot escape into the host app`, () => {
    withDom((dom) => {
      dom.win.credible = function () {
        throw new Error('boom');
      };
      assert.doesNotThrow(() => trackEvent('Signup'));
    });
  });

  test(`[${flavour}] init throws on missing configuration, before touching the DOM`, () => {
    withDom((dom) => {
      assert.throws(() => init({ instanceUrl: 'https://s.example' }), /needs `domain`/);
      assert.throws(() => init({ domain: 'a.com' }), /needs `instanceUrl`/);
      assert.throws(() => init({ instanceUrl: 'https://s.example', domain: '  ,  ' }), /needs `domain`/);
      assert.equal(dom.appended.length, 0);
    });
  });

  test(`[${flavour}] server-side rendering is inert, not fatal`, () => {
    withoutDom(() => {
      assert.equal(init({ instanceUrl: 'https://s.example', domain: 'a.com' }), null);
      assert.doesNotThrow(() => trackEvent('Signup'));
      assert.doesNotThrow(() => trackPageview());
      // Configuration mistakes still surface during SSR, which is where a
      // Next.js developer is most likely to see them first.
      assert.throws(() => init({ instanceUrl: 'https://s.example' }), /needs `domain`/);
    });
  });

  test(`[${flavour}] a document with no head still gets the script`, () => {
    withDom((dom) => {
      const body = { appendChild: (node) => dom.appended.push(node) };
      dom.doc.head = null;
      dom.doc.body = body;
      init({ instanceUrl: 'https://s.example', domain: 'a.com' });
      assert.equal(dom.appended.length, 1);
    });
  });
}

/* ------------------------------------------------------------------ *
 * The two builds agree, and the committed dist is current
 * ------------------------------------------------------------------ */

test('both builds expose the same API', () => {
  assert.deepEqual(Object.keys(cjs).sort(), ['init', 'trackEvent', 'trackPageview']);
  for (const name of Object.keys(cjs)) {
    assert.equal(typeof esm[name], 'function', name + ' is missing from the ESM build');
    assert.equal(typeof cjs[name], 'function', name + ' is missing from the CommonJS build');
  }
});

test('the committed dist matches a fresh build of src', () => {
  const source = fs.readFileSync(path.join(PKG, 'src', 'index.js'), 'utf8');
  const types = fs.readFileSync(path.join(PKG, 'src', 'index.d.ts'), 'utf8');
  const read = (file) => fs.readFileSync(path.join(PKG, 'dist', file), 'utf8');
  const stale = (file) => `dist/${file} is out of date with src/. Run: node integrations/npm/build.js`;

  // Built in memory and compared; this file never writes to dist/, so a stale
  // or hand-edited artifact fails here instead of being quietly overwritten.
  assert.equal(read('credible-tracker.js'), toEsm(source), stale('credible-tracker.js'));
  assert.equal(read('credible-tracker.cjs'), toCommonJs(source), stale('credible-tracker.cjs'));
  assert.equal(read('credible-tracker.d.ts'), types, stale('credible-tracker.d.ts'));
  assert.equal(read('credible-tracker.d.cts'), types, stale('credible-tracker.d.cts'));
});

test('package.json points at files that exist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const targets = [
    pkg.main,
    pkg.module,
    pkg.types,
    pkg.exports['.'].import.types,
    pkg.exports['.'].import.default,
    pkg.exports['.'].require.types,
    pkg.exports['.'].require.default,
  ];
  for (const target of targets) {
    assert.ok(fs.existsSync(path.join(PKG, target)), target + ' is referenced but missing');
  }
  // The tracker must not be AGPL: it ends up inside the consumer's bundle.
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.dependencies, {});
});
