/**
 * `credible proxy` — the generated web server configuration, locked in.
 *
 * What this module emits is pasted into someone's production web server, where
 * a wrong character is a site outage or, worse, a dashboard that keeps looking
 * alive while it counts the whole internet as one visitor. So these tests are
 * about the details that decide that: the prefix is never stripped, nginx's
 * proxy_pass carries no trailing slash, the forwarded headers are accounted for,
 * and CREDIBLE_TRUST_PROXY is always part of the environment that ships with it.
 *
 * `src/proxy.js` reads no environment and touches no database — it only builds
 * strings — so this file deliberately does not import `./helpers.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SUPPORTED, proxyConfig, suggestMounting } from '../src/proxy.js';

const DOMAIN = 'monsite.fr';
const PORT = 8000;
const HOST = '127.0.0.1';

/**
 * The active directives only, with every comment line and trailing comment
 * removed. Every generated syntax here comments with '#'.
 *
 * This matters: the blocks explain the no-stripping choice by naming the
 * directive they refuse to use (`handle_path`, `stripprefix`, `replace-path`),
 * so "the config does not strip" can only be asserted against what the server
 * actually executes.
 */
const directives = (config) =>
  config
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');

/** What proves the client's address reaches Credible, per server. */
const CLIENT_IP = {
  caddy: /header_up X-Forwarded-For \{remote_host\}/,
  nginx: /proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/,
  apache: /RemoteIPHeader X-Forwarded-For/,
  haproxy: /option forwardfor/, // HAProxy's spelling of "append X-Forwarded-For"
  traefik: null, // Traefik sets X-Forwarded-* itself; there is nothing to configure
};

/** What proves the original scheme reaches Credible, per server. */
const CLIENT_PROTO = {
  caddy: /header_up X-Forwarded-Proto \{scheme\}/,
  nginx: /proxy_set_header X-Forwarded-Proto\s+\$scheme;/,
  apache: /RequestHeader set X-Forwarded-Proto/,
  haproxy: /http-request set-header X-Forwarded-Proto https if \{ ssl_fc \}/,
  traefik: null,
};

/** Directives whose whole job is to remove the prefix before proxying. */
const STRIPPING = /handle_path|stripprefix|replace-path|replace-uri|rewrite\s+\^\//i;

describe('SUPPORTED', () => {
  it('is every server crossed with every mode', () => {
    const pairs = SUPPORTED.map(({ server, mode }) => `${server}/${mode}`);

    assert.equal(pairs.length, 10);
    assert.equal(new Set(pairs).size, 10, 'no pair is listed twice');
    for (const server of ['caddy', 'nginx', 'apache', 'traefik', 'haproxy']) {
      assert.ok(pairs.includes(`${server}/subpath`), `${server} subpath is offered`);
      assert.ok(pairs.includes(`${server}/subdomain`), `${server} subdomain is offered`);
    }
    for (const entry of SUPPORTED) {
      assert.ok(entry.label.length > 10, 'a CLI can print something meaningful');
    }
  });

  it('only advertises pairs it can actually generate', () => {
    for (const { server, mode } of SUPPORTED) {
      const result = proxyConfig({ server, mode, domain: DOMAIN });
      assert.equal(result.server, server);
      assert.equal(result.mode, mode);
      assert.ok(result.config.length > 200, `${server}/${mode} produced a real block`);
    }
  });
});

describe('every (server, mode) pair', () => {
  for (const { server, mode } of SUPPORTED) {
    describe(`${server} / ${mode}`, () => {
      const result = proxyConfig({ server, mode, domain: DOMAIN });
      const active = directives(result.config);

      it('names the file it belongs in, up front', () => {
        const head = result.config.split('\n').slice(0, 6).join('\n');
        assert.match(head, /^#/, 'the block opens with a comment');
        assert.match(
          head,
          /(\/etc\/[\w./-]+|Caddyfile|docker-compose\.yml)/,
          'the opening comment names a file',
        );
      });

      it('carries the upstream port and the domain', () => {
        assert.match(result.config, new RegExp(String(PORT)), 'the port is in the block');
        assert.ok(result.config.includes(DOMAIN), 'the domain is in the block');
      });

      it('accounts for the forwarded headers', () => {
        // Named everywhere, because a reader has to be able to check them.
        for (const header of ['X-Forwarded-For', 'X-Forwarded-Proto', 'Host']) {
          assert.ok(result.config.includes(header), `${header} is addressed`);
        }
        // And actually configured, wherever the server needs to be told.
        if (CLIENT_IP[server]) assert.match(active, CLIENT_IP[server]);
        if (CLIENT_PROTO[server]) assert.match(active, CLIENT_PROTO[server]);
      });

      it('ships the environment Credible needs, CREDIBLE_TRUST_PROXY first', () => {
        assert.equal(result.env.CREDIBLE_TRUST_PROXY, 'true');
        assert.equal(result.env.CREDIBLE_PORT, String(PORT));
        assert.equal(result.env.CREDIBLE_SECURE_COOKIES, 'true');
        assert.ok(result.env.CREDIBLE_HOST, 'the bind address is pinned down');
        for (const [key, value] of Object.entries(result.env)) {
          assert.match(key, /^CREDIBLE_[A-Z_]+$/);
          assert.equal(typeof value, 'string', `${key} is a string`);
        }
      });

      it('says how to apply it, and why it matters', () => {
        assert.ok(result.reload.length > 5, 'there is a reload command');
        assert.ok(result.notes.length >= 3, 'there are notes');
        assert.ok(
          result.notes.some((note) => note.includes('CREDIBLE_TRUST_PROXY')),
          'the worst failure mode is called out',
        );
        assert.ok(
          result.notes.some((note) => note.includes(`${result.url}/js/cr.js`)),
          'the install snippet matches the mounting',
        );
      });

      it('is a finished block, with nothing left unresolved', () => {
        for (const leak of ['undefined', 'NaN', '[object', 'TODO', 'null']) {
          assert.ok(!result.config.includes(leak), `no ${leak} in the output`);
        }
        assert.ok(result.config.endsWith('\n'), 'ends with a newline, ready to paste');
      });
    });
  }
});

describe('the public URL', () => {
  it('is the site origin plus the mount point in subpath mode', () => {
    const { url, env } = proxyConfig({ server: 'caddy', mode: 'subpath', domain: DOMAIN });
    assert.equal(url, 'https://monsite.fr/stats');
    assert.equal(env.CREDIBLE_BASE_PATH, '/stats');
  });

  it('is a subdomain of the same registrable domain in subdomain mode', () => {
    const { url } = proxyConfig({ server: 'caddy', mode: 'subdomain', domain: DOMAIN });
    assert.equal(url, 'https://stats.monsite.fr');
  });

  it('does not stack a second stats. label, and drops www.', () => {
    assert.equal(
      proxyConfig({ server: 'caddy', mode: 'subdomain', domain: 'stats.monsite.fr' }).url,
      'https://stats.monsite.fr',
    );
    assert.equal(
      proxyConfig({ server: 'caddy', mode: 'subdomain', domain: 'www.monsite.fr' }).url,
      'https://stats.monsite.fr',
    );
  });
});

describe('nginx proxy_pass', () => {
  for (const mode of ['subpath', 'subdomain']) {
    it(`has no trailing slash and no URI part (${mode})`, () => {
      const { config } = proxyConfig({ server: 'nginx', mode, domain: DOMAIN });
      const lines = directives(config)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('proxy_pass'));

      assert.ok(lines.length > 0, 'there is a proxy_pass');
      for (const line of lines) {
        // A URI on proxy_pass makes nginx replace the matched prefix with it,
        // which is precisely the stripping this setup must not do.
        assert.equal(line, `proxy_pass http://${HOST}:${PORT};`);
        assert.ok(!/:\d+\/.*;$/.test(line), 'no URI after the upstream');
      }
    });
  }

  it('points at whatever host and port Credible was given', () => {
    const { config } = proxyConfig({
      server: 'nginx',
      mode: 'subpath',
      domain: DOMAIN,
      host: '10.0.0.5',
      port: 9123,
    });
    assert.match(directives(config), /proxy_pass http:\/\/10\.0\.0\.5:9123;/);
  });

  it('brackets an IPv6 upstream', () => {
    const { config } = proxyConfig({
      server: 'nginx',
      mode: 'subdomain',
      domain: DOMAIN,
      host: '::1',
    });
    assert.match(directives(config), /proxy_pass http:\/\/\[::1\]:8000;/);
  });

  it('keeps the prefix location out of reach of regex locations', () => {
    const { config } = proxyConfig({ server: 'nginx', mode: 'subpath', domain: DOMAIN });
    assert.match(directives(config), /location \^~ \/stats\/ \{/);
  });
});

describe('subpath mode never strips the prefix', () => {
  for (const { server, mode } of SUPPORTED.filter((entry) => entry.mode === 'subpath')) {
    it(`${server} passes the full path through`, () => {
      const result = proxyConfig({ server, mode, domain: DOMAIN });
      const active = directives(result.config);

      assert.ok(
        !STRIPPING.test(active),
        'no stripping directive survives in the executed config',
      );
      assert.equal(result.env.CREDIBLE_BASE_PATH, '/stats');
      assert.ok(
        result.config.includes('CREDIBLE_BASE_PATH'),
        'the block explains the choice by naming the variable that justifies it',
      );
    });
  }

  it('caddy uses handle, and matches the prefix exactly', () => {
    const { config } = proxyConfig({ server: 'caddy', mode: 'subpath', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /handle @credible \{/);
    assert.match(active, /@credible path \/stats \/stats\/\*/);
    assert.ok(!active.includes('handle_path'), 'handle_path only appears in the explanation');
    assert.ok(config.includes('handle_path'), 'and the explanation is there');
  });

  it('apache keeps the prefix on both sides of the mapping', () => {
    const { config } = proxyConfig({ server: 'apache', mode: 'subpath', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /ProxyPass\s+\/stats\/ http:\/\/127\.0\.0\.1:8000\/stats\//);
    assert.match(active, /ProxyPassReverse\s+\/stats\/ http:\/\/127\.0\.0\.1:8000\/stats\//);
    assert.ok(
      !/ProxyPass\s+\/stats\/ http:\/\/127\.0\.0\.1:8000\/$/m.test(active),
      'the stripping form is absent',
    );
  });

  it('traefik routes on the prefix without a stripprefix middleware', () => {
    const { config } = proxyConfig({ server: 'traefik', mode: 'subpath', domain: DOMAIN });
    const active = directives(config);
    assert.ok(!active.includes('stripprefix'), 'no stripprefix middleware');
    assert.ok(active.includes('Path(`/stats`) || PathPrefix(`/stats/`)'), 'segment-safe rule');
    assert.ok(config.includes('docker-compose.yml'), 'the label form is named');
    assert.ok(config.includes('/etc/traefik/dynamic/credible.yml'), 'the file form is named');
    assert.match(active, /rule: "Host\(`monsite\.fr`\)/, 'the file provider says the same thing');
    assert.match(active, /passHostHeader: true/);
  });

  it('haproxy acls on the path prefix and rewrites nothing', () => {
    const { config } = proxyConfig({ server: 'haproxy', mode: 'subpath', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /acl credible_req path\s+\/stats/);
    assert.match(active, /acl credible_req path_beg \/stats\//);
    assert.match(active, /use_backend credible if credible_req/);
    assert.match(active, /^backend credible$/m);
    assert.match(active, /server credible1 127\.0\.0\.1:8000 check/);
    assert.ok(!active.includes('replace-path'), 'the path is not rewritten');
  });

  it('honours a custom mount point everywhere, with no /stats left behind', () => {
    for (const { server, mode } of SUPPORTED.filter((entry) => entry.mode === 'subpath')) {
      const result = proxyConfig({ server, mode, domain: DOMAIN, path: '/_analytics' });
      assert.equal(result.url, 'https://monsite.fr/_analytics');
      assert.equal(result.env.CREDIBLE_BASE_PATH, '/_analytics');
      assert.ok(result.config.includes('/_analytics'), `${server} uses the given prefix`);
      assert.ok(!result.config.includes('/stats'), `${server} hardcodes nothing`);
    }
  });

  it('normalises a trailing slash on the mount point', () => {
    const { url, env } = proxyConfig({
      server: 'nginx',
      mode: 'subpath',
      domain: DOMAIN,
      path: '/stats/',
    });
    assert.equal(url, 'https://monsite.fr/stats');
    assert.equal(env.CREDIBLE_BASE_PATH, '/stats');
  });
});

describe('the environment that ships with the config', () => {
  it('sets CREDIBLE_BASE_URL to the origin only, never the mounted URL', () => {
    // config.js appends CREDIBLE_BASE_PATH to CREDIBLE_BASE_URL. Putting the
    // mount point in both would produce https://monsite.fr/stats/stats in the
    // install snippet and in every shared link.
    const { env, url, notes } = proxyConfig({
      server: 'nginx',
      mode: 'subpath',
      domain: DOMAIN,
    });
    assert.equal(env.CREDIBLE_BASE_URL, 'https://monsite.fr');
    assert.notEqual(env.CREDIBLE_BASE_URL, url);
    assert.ok(
      notes.some((note) => note.includes('CREDIBLE_BASE_URL')),
      'the doubling trap is explained',
    );
  });

  it('leaves CREDIBLE_BASE_PATH out entirely in subdomain mode', () => {
    for (const { server } of SUPPORTED.filter((entry) => entry.mode === 'subdomain')) {
      const { env } = proxyConfig({ server, mode: 'subdomain', domain: DOMAIN });
      assert.ok(!('CREDIBLE_BASE_PATH' in env), `${server} mounts at the root`);
      assert.equal(env.CREDIBLE_BASE_URL, 'https://stats.monsite.fr');
    }
  });

  it('binds Credible where the proxy will look for it', () => {
    const local = proxyConfig({ server: 'nginx', mode: 'subpath', domain: DOMAIN });
    assert.equal(local.env.CREDIBLE_HOST, '127.0.0.1');

    const remote = proxyConfig({
      server: 'haproxy',
      mode: 'subdomain',
      domain: DOMAIN,
      host: '10.0.0.5',
      port: 9000,
    });
    assert.equal(remote.env.CREDIBLE_HOST, '10.0.0.5');
    assert.equal(remote.env.CREDIBLE_PORT, '9000');

    // In a container the proxy arrives from another address on the docker
    // network, so loopback would make Credible unreachable.
    const containerised = proxyConfig({ server: 'traefik', mode: 'subpath', domain: DOMAIN });
    assert.equal(containerised.env.CREDIBLE_HOST, '0.0.0.0');
  });
});

describe('subdomain mode', () => {
  it('caddy needs no certificate path at all', () => {
    const { config, notes } = proxyConfig({ server: 'caddy', mode: 'subdomain', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /^stats\.monsite\.fr \{$/m, 'a complete site block');
    assert.match(active, /reverse_proxy 127\.0\.0\.1:8000 \{/);
    assert.ok(!/\.pem|ssl_certificate|SSLCertificate/.test(active), 'no invented paths');
    assert.ok(
      notes.some((note) => /certbot/i.test(note) && /Caddy/.test(note)),
      'it says why certbot is not needed',
    );
  });

  it('nginx and apache emit a certbot command instead of guessing paths', () => {
    for (const [server, flag] of [['nginx', '--nginx'], ['apache', '--apache']]) {
      const { config, notes } = proxyConfig({ server, mode: 'subdomain', domain: DOMAIN });
      assert.ok(
        !/ssl_certificate|SSLCertificateFile/.test(config),
        `${server} invents no certificate path`,
      );
      assert.ok(
        notes.some((note) => note.includes(`certbot ${flag} -d stats.monsite.fr`)),
        `${server} says exactly how to get the certificate`,
      );
    }
  });

  it('nginx emits a complete server block, apache a complete VirtualHost', () => {
    const nginx = directives(proxyConfig({ server: 'nginx', mode: 'subdomain', domain: DOMAIN }).config);
    assert.match(nginx, /^server \{$/m);
    assert.match(nginx, /server_name stats\.monsite\.fr;/);
    assert.match(nginx, /^\}$/m);

    const apache = directives(proxyConfig({ server: 'apache', mode: 'subdomain', domain: DOMAIN }).config);
    assert.match(apache, /<VirtualHost \*:80>/);
    assert.match(apache, /ServerName stats\.monsite\.fr/);
    assert.match(apache, /<\/VirtualHost>/);
    assert.match(apache, /ProxyPass\s+\/ http:\/\/127\.0\.0\.1:8000\//);
    assert.match(apache, /ProxyPassReverse\s+\/ http:\/\/127\.0\.0\.1:8000\//);
    // ACME must not be proxied away, or renewal fails on the first attempt.
    assert.match(apache, /ProxyPass \/\.well-known\/acme-challenge\/ !/);
  });

  it('haproxy routes on the Host header and says how to build its PEM', () => {
    const { config, notes } = proxyConfig({ server: 'haproxy', mode: 'subdomain', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /acl credible_req hdr\(host\) -i stats\.monsite\.fr/);
    assert.match(active, /bind :443 ssl crt \/etc\/haproxy\/certs\/stats\.monsite\.fr\.pem/);
    assert.ok(
      notes.some((note) => note.includes('fullchain.pem') && note.includes('privkey.pem')),
      'the one-file certificate is explained',
    );
  });

  it('traefik keeps its certresolver and drops the path rule', () => {
    const { config } = proxyConfig({ server: 'traefik', mode: 'subdomain', domain: DOMAIN });
    const active = directives(config);
    assert.match(active, /certresolver=letsencrypt/);
    assert.match(active, /certResolver: letsencrypt/);
    assert.ok(!active.includes('PathPrefix'), 'no path matching at the root of its own name');
  });

  it('tells the operator to create the DNS record first', () => {
    for (const { server } of SUPPORTED.filter((entry) => entry.mode === 'subdomain')) {
      const { notes } = proxyConfig({ server, mode: 'subdomain', domain: DOMAIN });
      assert.ok(
        notes.some((note) => /A record/.test(note) && note.includes('stats.monsite.fr')),
        `${server} asks for the DNS record`,
      );
    }
  });
});

describe('bad input is refused, by name', () => {
  const base = { server: 'nginx', mode: 'subpath', domain: DOMAIN };

  /** Assert it throws, and that the message quotes the value that caused it. */
  const refuses = (options, needle) => {
    assert.throws(
      () => proxyConfig(options),
      (error) => {
        assert.ok(error instanceof Error, 'a real Error');
        assert.ok(
          error.message.includes(needle),
          `"${error.message}" names ${needle}`,
        );
        return true;
      },
    );
  };

  it('refuses an unknown server or mode', () => {
    refuses({ ...base, server: 'iis' }, 'iis');
    refuses({ ...base, server: '' }, 'Unknown server');
    refuses({ ...base, server: undefined }, 'Unknown server');
    refuses({ ...base, mode: 'root' }, 'root');
    refuses({ ...base, mode: undefined }, 'Unknown mode');
  });

  it('refuses anything that is not a hostname as the domain', () => {
    for (const domain of [
      'https://monsite.fr',
      'monsite.fr/stats',
      'monsite.fr:8000',
      'mon site.fr',
      'monsite',
      '-monsite.fr',
      'monsite..fr',
      '',
      undefined,
      42,
    ]) {
      assert.throws(
        () => proxyConfig({ ...base, domain }),
        /Not a domain/,
        `${String(domain)} was refused`,
      );
    }
  });

  it('accepts a domain that only needs normalising', () => {
    assert.equal(proxyConfig({ ...base, domain: 'MonSite.FR.' }).url, 'https://monsite.fr/stats');
    assert.equal(proxyConfig({ ...base, domain: '  monsite.fr ' }).url, 'https://monsite.fr/stats');
  });

  it('refuses a path that is not a path', () => {
    for (const path of ['stats', 'stats/', '', '/', '//', '/stats/../etc', '/stats?a=1', null]) {
      assert.throws(
        () => proxyConfig({ ...base, path }),
        /Not a mount path/,
        `${String(path)} was refused`,
      );
    }
    // An absent path is not a bad path: it is the default mount point.
    assert.equal(proxyConfig({ ...base, path: undefined }).url, 'https://monsite.fr/stats');
  });

  it('refuses a port outside 1..65535', () => {
    for (const port of [0, -1, 70000, 65536, 3.5, Number.NaN, 'eight thousand', '', null]) {
      assert.throws(
        () => proxyConfig({ ...base, port }),
        /Not a port/,
        `${String(port)} was refused`,
      );
    }
    assert.equal(proxyConfig({ ...base, port: 65535 }).env.CREDIBLE_PORT, '65535');
    assert.equal(proxyConfig({ ...base, port: '9000' }).env.CREDIBLE_PORT, '9000');
  });

  it('refuses a host that carries a port or a scheme', () => {
    for (const host of ['127.0.0.1:8000', 'http://127.0.0.1', 'a host', '', null]) {
      assert.throws(() => proxyConfig({ ...base, host }), /Not a host/, `${String(host)} was refused`);
    }
    assert.equal(proxyConfig({ ...base, host: 'localhost' }).env.CREDIBLE_HOST, 'localhost');
    assert.equal(proxyConfig({ ...base, host: 'credible' }).env.CREDIBLE_HOST, 'credible');
  });

  it('ignores the mount path in subdomain mode rather than validating it', () => {
    const { url } = proxyConfig({ server: 'nginx', mode: 'subdomain', domain: DOMAIN, path: 'nonsense' });
    assert.equal(url, 'https://stats.monsite.fr');
  });
});

describe('websockets is reserved', () => {
  it('changes nothing, and says so', () => {
    const plain = proxyConfig({ server: 'nginx', mode: 'subpath', domain: DOMAIN });
    const asked = proxyConfig({ server: 'nginx', mode: 'subpath', domain: DOMAIN, websockets: true });

    assert.equal(asked.config, plain.config, 'the block is unchanged');
    assert.ok(
      asked.notes.some((note) => note.includes('websockets')),
      'the caller is told nothing was emitted',
    );
  });
});

describe('suggestMounting', () => {
  it('picks a subpath for a site that owns its origin', () => {
    const suggestion = suggestMounting('https://monsite.fr');

    assert.equal(suggestion.mode, 'subpath');
    assert.equal(suggestion.path, '/stats');
    assert.equal(suggestion.url, 'https://monsite.fr/stats');
    assert.ok(suggestion.reason.length > 40, 'it argues its case');
  });

  it('tolerates a missing scheme, a trailing slash and http', () => {
    for (const input of ['monsite.fr', 'https://monsite.fr/', 'http://monsite.fr', 'HTTPS://MonSite.fr']) {
      const suggestion = suggestMounting(input);
      assert.equal(suggestion.mode, 'subpath', `${input} is a plain site`);
      assert.equal(suggestion.url, 'https://monsite.fr/stats', 'always over TLS');
    }
  });

  it('picks a subdomain when the site URL already has a path', () => {
    const suggestion = suggestMounting('https://monsite.fr/blog');

    assert.equal(suggestion.mode, 'subdomain');
    assert.equal(suggestion.path, '');
    assert.equal(suggestion.url, 'https://stats.monsite.fr');
    assert.ok(suggestion.reason.includes('stats.monsite.fr'));
  });

  it('picks a subdomain when the site is served from a www host', () => {
    const suggestion = suggestMounting('https://www.monsite.fr');

    assert.equal(suggestion.mode, 'subdomain');
    assert.equal(suggestion.path, '');
    assert.equal(suggestion.url, 'https://stats.monsite.fr');
    assert.ok(suggestion.reason.length > 40);
  });

  it('refuses what it cannot mount', () => {
    for (const input of ['', '   ', 'not a url', 'ftp://monsite.fr', 'https://localhost', undefined, null]) {
      assert.throws(() => suggestMounting(input), /Not a (site URL|domain)/, `${String(input)} was refused`);
    }
  });

  it('produces something proxyConfig accepts, for every server', () => {
    for (const siteUrl of ['https://monsite.fr', 'https://www.monsite.fr', 'https://monsite.fr/blog']) {
      const suggestion = suggestMounting(siteUrl);
      for (const server of ['caddy', 'nginx', 'apache', 'traefik', 'haproxy']) {
        const result = proxyConfig({
          server,
          mode: suggestion.mode,
          domain: new URL(siteUrl).hostname,
          ...(suggestion.mode === 'subpath' ? { path: suggestion.path } : {}),
        });
        assert.equal(result.url, suggestion.url, `${server} agrees with the suggestion`);
      }
    }
  });
});
