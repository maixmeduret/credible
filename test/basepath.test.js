/**
 * Mounting Credible under a path of a bigger site.
 *
 * This is what first-party analytics needs: the instance lives at
 * https://monsite.fr/stats, so the tracker is served from the measured site's
 * own origin and there is no third-party request at all.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment
 * at a throwaway data directory before `src/config.js` reads it.
 */
import { closeDatabase, withDatabase } from './helpers.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config, normalizeBasePath, originFor } from '../src/config.js';
import { createServer, stripBasePath } from '../src/server.js';
import { provision } from '../src/provision.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('normalizeBasePath', () => {
  it('normalises every reasonable spelling to the same thing', () => {
    assert.equal(normalizeBasePath('/stats'), '/stats');
    assert.equal(normalizeBasePath('stats'), '/stats');
    assert.equal(normalizeBasePath('/stats/'), '/stats');
    assert.equal(normalizeBasePath('/a/b/c/'), '/a/b/c');
  });

  it('treats an empty mount point and the root as the same', () => {
    for (const value of ['', '/', '   ', undefined, null]) {
      assert.equal(normalizeBasePath(value), '');
    }
  });
});

describe('stripBasePath', () => {
  const withMount = (mount, fn) => {
    const previous = config.basePath;
    config.basePath = mount;
    try {
      fn();
    } finally {
      config.basePath = previous;
    }
  };

  it('is a no-op at the root', () => {
    withMount('', () => {
      assert.equal(stripBasePath('/api/health'), '/api/health');
      assert.equal(stripBasePath('/'), '/');
    });
  });

  it('removes the mount point', () => {
    withMount('/stats', () => {
      assert.equal(stripBasePath('/stats'), '/');
      assert.equal(stripBasePath('/stats/'), '/');
      assert.equal(stripBasePath('/stats/api/health'), '/api/health');
      assert.equal(stripBasePath('/stats/js/cr.js'), '/js/cr.js');
    });
  });

  it('refuses anything outside the mount point', () => {
    withMount('/stats', () => {
      assert.equal(stripBasePath('/'), null);
      assert.equal(stripBasePath('/api/health'), null);
      // A prefix match is not enough — /statsomething is a different path.
      assert.equal(stripBasePath('/statsomething'), null);
    });
  });
});

// --------------------------------------------------------------------------

describe('an instance mounted at /stats', () => {
  let server;
  let host;
  let mounted;
  let previousBasePath;
  let apiKey;

  before(async () => {
    await withDatabase('basepath');
    previousBasePath = config.basePath;
    config.basePath = '/stats';

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${server.address().port}`;
    mounted = `${host}/stats`;

    const provisioned = provision({ email: 'mount@example.com', domain: 'monsite.fr' });
    apiKey = provisioned.apiKey;
  });

  after(async () => {
    config.basePath = previousBasePath;
    await new Promise((resolve) => server.close(resolve));
    await closeDatabase();
  });

  it('answers under the mount point', async () => {
    const response = await fetch(`${mounted}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });

  it('does not answer at the root of the domain', async () => {
    for (const path of ['/', '/api/health', '/js/cr.js']) {
      const response = await fetch(`${host}${path}`);
      assert.equal(response.status, 404, `${path} is not ours to serve`);
    }
  });

  it('serves the tracker under the mount point', async () => {
    const response = await fetch(`${mounted}/js/cr.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /credible/);
  });

  it('tells the dashboard where it lives', async () => {
    const html = await (await fetch(mounted)).text();
    assert.match(html, /window\.CREDIBLE_BASE = '\/stats'/);
    assert.match(html, /src="\/stats\/js\/app\.js"/);
    assert.match(html, /href="\/stats\/app\.css"/);
    assert.ok(!html.includes('__CREDIBLE_BASE__'), 'every placeholder was substituted');
  });

  it('serves the dashboard shell for an app route under the mount point', async () => {
    const response = await fetch(`${mounted}/monsite.fr`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
  });

  it('builds a snippet that points back at the mount point', async () => {
    const site = await (
      await fetch(`${mounted}/api/sites/monsite.fr`, { headers: { authorization: `Bearer ${apiKey}` } })
    ).json();

    assert.match(site.snippet, /src="http:\/\/127\.0\.0\.1:\d+\/stats\/js\/cr\.js"/);
  });

  it('accepts events under the mount point', async () => {
    const response = await fetch(`${mounted}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': CHROME_UA },
      body: JSON.stringify({
        n: 'pageview',
        d: 'monsite.fr',
        u: 'https://monsite.fr/tarifs',
        w: 1440,
      }),
    });
    assert.equal(response.status, 202);

    const realtime = await (
      await fetch(`${mounted}/api/stats/monsite.fr/realtime`, {
        headers: { authorization: `Bearer ${apiKey}` },
      })
    ).json();
    assert.equal(realtime.visitors, 1);
    assert.deepEqual(realtime.pages, [{ name: '/tarifs', visitors: 1 }]);
  });

  it('bakes the mount point into the agent brief', async () => {
    const text = await (await fetch(`${mounted}/llms.txt`)).text();
    assert.ok(text.includes(`${mounted}/api/v1/provision`));
    assert.ok(text.includes(`${mounted}/js/cr.js`));
  });

  it('reports the mounted URL as its public origin', () => {
    const origin = originFor({ headers: { host: '127.0.0.1:1234' } });
    assert.equal(origin, 'http://127.0.0.1:1234/stats');
  });
});
