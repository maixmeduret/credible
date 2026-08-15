/**
 * Reverse-proxy configuration — Credible on the website's own domain.
 *
 * Almost everyone who runs a website already owns the machine that serves it:
 * a VPS, a dedicated box, a NAS, a Raspberry Pi, a Docker host, a Coolify or
 * Dokku install. Credible is one Node process and one file, so it belongs on
 * that machine, answering on the site's own name:
 *
 *   https://monsite.fr/stats/js/cr.js     subpath   — the site's own origin
 *   https://stats.monsite.fr/js/cr.js     subdomain — the same registrable domain
 *
 * Both beat a third-party analytics host on every axis that matters: no
 * cross-origin request for the beacon, the certificate the site already has
 * covers the name, and content blockers — which match known analytics
 * *hostnames* — have nothing to match on.
 *
 * This module builds strings and nothing else. It reads no environment, opens
 * no file and runs no command: `credible proxy` prints what it returns and a
 * human pastes it into a web server they own. Because that output lands in
 * production configuration, every generated block is written to be complete and
 * correct on its own, and each non-obvious directive carries the reason it is
 * there — starting with the one that surprises everybody, which is that the
 * subpath is deliberately *not* stripped.
 */
import net from 'node:net';

// ------------------------------------------------------------- vocabulary --

const SERVERS = ['caddy', 'nginx', 'apache', 'traefik', 'haproxy'];
const MODES = ['subpath', 'subdomain'];

const DEFAULT_PATH = '/stats';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8000;

/** The subdomain label used when a site is mounted on a name of its own. */
const ANALYTICS_LABEL = 'stats';

const SERVER_NAMES = {
  caddy: 'Caddy',
  nginx: 'nginx',
  apache: 'Apache httpd',
  traefik: 'Traefik',
  haproxy: 'HAProxy',
};

const MODE_SUMMARIES = {
  subpath: 'https://<domain>/stats — same origin as the site, first-party script',
  subdomain: 'https://stats.<domain> — same registrable domain, its own server block',
};

/** Every (server, mode) pair, for a CLI that lists what it can generate. */
export const SUPPORTED = Object.freeze(
  SERVERS.flatMap((server) =>
    MODES.map((mode) =>
      Object.freeze({
        server,
        mode,
        label: `${SERVER_NAMES[server]} — ${MODE_SUMMARIES[mode]}`,
      }),
    ),
  ),
);

/** The command that makes each server pick the new configuration up. */
const RELOAD = {
  caddy: 'sudo systemctl reload caddy',
  nginx: 'sudo nginx -t && sudo systemctl reload nginx',
  apache: 'sudo apachectl configtest && sudo systemctl reload apache2',
  traefik: 'docker compose up -d credible',
  haproxy: 'sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo systemctl reload haproxy',
};

// ------------------------------------------------------------- validation --

/** A dotted hostname: two labels or more, no scheme, no port, no path. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The same, but a single label is allowed: an upstream may be `localhost`. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Mount points stay boring on purpose — they end up in five config syntaxes. */
const PATH_RE = /^(\/[A-Za-z0-9_~.-]+)+$/;

/** Show a rejected value in an error message without hiding what it was. */
const show = (value) => (typeof value === 'string' ? `"${value}"` : String(value));

function requireDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !DOMAIN_RE.test(domain)) {
    throw new Error(
      `Not a domain: ${show(value)}. Pass the site's bare hostname, for example ` +
        'monsite.fr — no scheme, no port, no path.',
    );
  }
  return domain;
}

function requireHost(value) {
  const raw = String(value ?? '').trim();
  if (net.isIP(raw)) return raw;
  const host = raw.toLowerCase();
  if (host && host.length <= 253 && HOST_RE.test(host)) return host;
  throw new Error(
    `Not a host: ${show(value)}. Pass the address Credible listens on, for example ` +
      '127.0.0.1 — a hostname or an IP, without a port.',
  );
}

function requirePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('/')) {
    throw new Error(`Not a mount path: ${show(value)}. It has to start with a slash, like /stats.`);
  }
  const mount = raw.replace(/\/+$/, '');
  if (!mount) {
    throw new Error(
      `Not a mount path: ${show(value)}. "/" is the site root — use mode "subdomain" for ` +
        'that, or a prefix of its own like /stats.',
    );
  }
  if (!PATH_RE.test(mount) || mount.includes('..')) {
    throw new Error(
      `Not a mount path: ${show(value)}. Use plain path segments, like /stats or /_analytics.`,
    );
  }
  return mount;
}

function requirePort(value) {
  const port = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Not a port: ${show(value)}. Use a whole number between 1 and 65535 — Credible ` +
        'listens on 8000 by default.',
    );
  }
  return port;
}

/**
 * The hostname the instance will answer on. In subdomain mode that is
 * `stats.<registrable domain>`: `www.` is not part of the site's identity, and
 * a domain that already starts with the analytics label is left alone so
 * passing `stats.monsite.fr` cannot produce `stats.stats.monsite.fr`.
 */
function publicHostFor(domain, mode) {
  if (mode === 'subpath') return domain;
  const bare = domain.replace(/^www\./, '');
  return bare.startsWith(`${ANALYTICS_LABEL}.`) ? bare : `${ANALYTICS_LABEL}.${bare}`;
}

// ------------------------------------------------------ generated configs --

function caddyConfig(ctx) {
  const { publicHost, mount, target, site } = ctx;

  if (ctx.mode === 'subdomain') {
    return `# /etc/caddy/Caddyfile — a new site block, next to the one serving ${site}.
#
# Point an A record (and an AAAA record if you have IPv6) for ${publicHost} at
# this machine BEFORE reloading: Caddy asks Let's Encrypt for the certificate as
# soon as the name is requested, and a failed attempt is retried with a backoff.

${publicHost} {
\t# TLS is automatic. Caddy obtains and renews the certificate for this name on
\t# its own, which is why there is no certificate path anywhere in this block —
\t# and why Caddy is the least error-prone of the five servers for this job.
\tencode gzip zstd

\treverse_proxy ${target} {
\t\t# Caddy already sets all three. They are spelled out because they are the
\t\t# difference between counting visitors and counting one visitor:
\t\t# CREDIBLE_TRUST_PROXY=true is what makes Credible read them.
\t\theader_up X-Forwarded-For {remote_host}
\t\theader_up X-Forwarded-Proto {scheme}
\t\theader_up Host {host}
\t}
}
`;
  }

  return `# /etc/caddy/Caddyfile — inside the site block that already serves ${site}.

${publicHost} {
\t# … your existing site directives stay here. Keep them inside a handle block
\t# of their own (\`handle { … }\` or \`handle /* { … }\`): handle blocks are
\t# mutually exclusive, so Caddy picks exactly one and the two never compete
\t# for a request.

\t# The exact path plus everything under it. A bare \`handle ${mount}*\` would
\t# also swallow a page of yours called ${mount}-old.
\t@credible path ${mount} ${mount}/*

\t# \`handle\`, deliberately NOT \`handle_path\`.
\t#
\t# handle_path strips the matched prefix before proxying, which is what nearly
\t# every reverse-proxy snippet does — and it is exactly wrong here. Credible is
\t# mount-point aware: it runs with CREDIBLE_BASE_PATH=${mount} and builds its
\t# dashboard links, its assets, the tracker src and the /api/event endpoint
\t# from that prefix. It has to receive the path the browser actually asked for.
\t# Strip it and the dashboard HTML loads while every URL inside it 404s.
\thandle @credible {
\t\treverse_proxy ${target} {
\t\t\t# CREDIBLE_TRUST_PROXY=true is what makes Credible read these.
\t\t\theader_up X-Forwarded-For {remote_host}
\t\t\theader_up X-Forwarded-Proto {scheme}
\t\t\theader_up Host {host}
\t\t}
\t}
}
`;
}

function nginxConfig(ctx) {
  const { publicHost, mount, target, site } = ctx;

  /** The same five headers at either nesting depth: server > location, or location. */
  const headers = (indent) =>
    [
      'proxy_set_header Host              $host;',
      'proxy_set_header X-Real-IP         $remote_addr;',
      'proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
      'proxy_set_header X-Forwarded-Proto $scheme;',
      'proxy_set_header X-Forwarded-Host  $host;',
    ]
      .map((line) => `${indent}${line}`)
      .join('\n');

  if (ctx.mode === 'subdomain') {
    return `# /etc/nginx/sites-available/${publicHost} — a new file. Enable it with:
#   sudo ln -s /etc/nginx/sites-available/${publicHost} /etc/nginx/sites-enabled/
#
# This block is HTTP-only on purpose. Put it in place, point ${publicHost} at
# this machine, then run certbot (see the notes): it adds the \`listen 443 ssl\`
# server, the real certificate paths and the HTTP→HTTPS redirect itself.
# Certificate paths invented by a generator are the single most common cause of
# "nginx: [emerg] cannot load certificate".

server {
    listen 80;
    listen [::]:80;
    server_name ${publicHost};

    # The beacon is a few hundred bytes of JSON. Nothing here is ever large.
    client_max_body_size 64k;

    gzip on;
    gzip_types application/javascript application/json text/css text/html;

    location / {
        proxy_pass http://${target};
        proxy_http_version 1.1;

        # These are what CREDIBLE_TRUST_PROXY=true reads. Without them every
        # event arrives from the proxy and the whole audience becomes 1 visitor.
${headers('        ')}

        proxy_read_timeout 60s;
        proxy_redirect off;
    }
}
`;
  }

  return `# /etc/nginx/sites-available/${site} — inside the existing \`server { … }\`
# block that serves https://${publicHost}.

# Credible under ${mount}, on your own domain and your own certificate.
# Two details here are deliberate, and both are easy to get wrong:
#
# 1. \`proxy_pass http://${target};\` has NO trailing slash and no URI part.
#    Without a URI nginx forwards the request path untouched:
#        ${mount}/js/cr.js  →  ${mount}/js/cr.js
#    Add one character — \`proxy_pass http://${target}/;\` — and nginx instead
#    replaces the part of the path matched by \`location\` with that URI:
#        ${mount}/js/cr.js  →  /js/cr.js
#    The stripping form is what most snippets show, and it breaks this setup.
#    Credible runs with CREDIBLE_BASE_PATH=${mount} and derives its links, its
#    assets, the tracker src and the /api/event endpoint from that prefix, so it
#    must be handed the full path.
#
# 2. \`^~\` tells nginx to stop looking once this prefix matches. A regex
#    location such as \`location ~* \\.(js|css)$ { … }\` — the standard
#    asset-caching block — otherwise wins over a plain prefix match and serves
#    ${mount}/js/cr.js off the filesystem, which is a 404 for the tracker.
location ^~ ${mount}/ {
    proxy_pass http://${target};
    proxy_http_version 1.1;

    # These are what CREDIBLE_TRUST_PROXY=true reads. Without them every event
    # arrives from ${ctx.host} and the whole audience becomes one visitor.
${headers('    ')}

    client_max_body_size 64k;
    proxy_read_timeout 60s;
    proxy_redirect off;
}

# Credible serves the bare ${mount} as well, but the location above ends with a
# slash so that a page of yours called ${mount}-old is never captured. This
# exact match covers the one URL that would otherwise fall through to the site.
location = ${mount} {
    absolute_redirect off;   # a relative Location survives any proxy in front
    return 301 ${mount}/;
}
`;
}

function apacheConfig(ctx) {
  const { publicHost, mount, targetUrl, site } = ctx;

  const clientIp = `    # mod_proxy_http already appends the client's address to X-Forwarded-For on
    # the way to Credible. X-Forwarded-Proto it does not send, so set it here.
    RequestHeader set X-Forwarded-Proto "expr=%{REQUEST_SCHEME}"

    # mod_remoteip matters when something else — a CDN, a load balancer — sits
    # in FRONT of Apache: it says which upstreams are allowed to speak for the
    # client. Trusting the header from everyone would let any visitor forge
    # their own address and country, so the list starts at loopback and you add
    # your CDN's ranges to it.
    RemoteIPHeader X-Forwarded-For
    RemoteIPInternalProxy 127.0.0.0/8 ::1`;

  if (ctx.mode === 'subdomain') {
    return `# /etc/apache2/sites-available/${publicHost}.conf — a new file.
#   sudo a2enmod proxy proxy_http remoteip headers
#   sudo a2ensite ${publicHost}
#
# Without mod_proxy, mod_proxy_http, mod_remoteip and mod_headers this block
# fails to load. Enabling a module needs a restart, not a reload.
#
# HTTP-only on purpose: run certbot once this file is in place (see the notes)
# and it writes the <VirtualHost *:443> with the real certificate paths for you.

<VirtualHost *:80>
    ServerName ${publicHost}

    # This is a reverse proxy and must never become a forward proxy.
    ProxyRequests Off
    # Credible needs the browser's Host header to build absolute links.
    ProxyPreserveHost On

    # Let certbot answer its own challenge from disk. Without this exclusion
    # mod_proxy hands /.well-known/… to Credible and renewal fails.
    ProxyPass /.well-known/acme-challenge/ !

    ProxyPass        / ${targetUrl}/
    ProxyPassReverse / ${targetUrl}/

${clientIp}

    ErrorLog  \${APACHE_LOG_DIR}/credible-error.log
    CustomLog \${APACHE_LOG_DIR}/credible-access.log combined
</VirtualHost>
`;
  }

  return `# /etc/apache2/sites-available/${site}.conf — inside the existing
# <VirtualHost *:443> that serves https://${publicHost}.
#   sudo a2enmod proxy proxy_http remoteip headers
#
# Without mod_proxy, mod_proxy_http, mod_remoteip and mod_headers these
# directives fail to load. Enabling a module needs a restart, not a reload.

    ProxyRequests Off        # a reverse proxy, never a forward proxy
    ProxyPreserveHost On     # Credible builds absolute links from the Host header

    # The prefix is NOT stripped: ${mount} appears on both sides of the mapping,
    # so ${mount}/js/cr.js reaches Credible as ${mount}/js/cr.js. The usual
    # snippet — \`ProxyPass ${mount}/ ${targetUrl}/\` — strips it, and that
    # breaks every URL Credible generates: it runs with
    # CREDIBLE_BASE_PATH=${mount} and builds its dashboard links, its assets,
    # the tracker src and the /api/event endpoint from that prefix.
    ProxyPass        ${mount}/ ${targetUrl}${mount}/
    ProxyPassReverse ${mount}/ ${targetUrl}${mount}/

    # Only ${mount}/… is proxied, so the bare ${mount} gets an exact redirect
    # rather than a second, looser prefix rule that would also capture a page of
    # yours called ${mount}-old.
    RedirectMatch 301 "^${mount}$" "${mount}/"

${clientIp}
`;
}

function traefikConfig(ctx) {
  const { publicHost, mount, host, port, target, mode } = ctx;
  const tick = '`';
  const rule =
    mode === 'subpath'
      ? `Host(${tick}${publicHost}${tick}) && (Path(${tick}${mount}${tick}) || PathPrefix(${tick}${mount}/${tick}))`
      : `Host(${tick}${publicHost}${tick})`;

  const basePathLine =
    mode === 'subpath' ? `\n      CREDIBLE_BASE_PATH: "${mount}"` : '';

  const noStrip =
    mode === 'subpath'
      ? `      # No stripprefix middleware, on purpose. The usual PathPrefix recipe pairs
      # itself with traefik.http.middlewares.x.stripprefix.prefixes=${mount};
      # here that breaks Credible, which runs with CREDIBLE_BASE_PATH=${mount}
      # and builds its dashboard links, its assets, the tracker src and the
      # /api/event endpoint from the prefix. It must receive ${mount}/… exactly
      # as the browser sent it.
      #
      # Path(…) || PathPrefix(…/) rather than a bare PathPrefix(${mount}), which
      # would also route a page of yours called ${mount}-old to Credible.
      # Traefik ranks routers by rule length, so this one already wins over the
      # site's plain Host() router; add a priority if you ever make that rule
      # longer.
      #
`
      : '';

  return `# Two ways of saying the same thing — use whichever provider your Traefik runs.
#
# ── A. docker-compose.yml, labels on the Credible service ────────────────────

services:
  credible:
    image: ghcr.io/maixmeduret/credible:latest   # or: build: .
    container_name: credible
    restart: unless-stopped
    # No \`ports:\` mapping on purpose: Traefik reaches Credible over the docker
    # network, and publishing ${port} would expose the instance next to it.
    volumes:
      - credible_data:/data
    environment:
      # Inside a container Credible must listen on every interface — the proxy
      # arrives from another address on the docker network, so 127.0.0.1 would
      # make it unreachable. The network boundary is what isolates it.
      CREDIBLE_HOST: "0.0.0.0"
      CREDIBLE_PORT: "${port}"${basePathLine}
      # The origin only: Credible appends CREDIBLE_BASE_PATH to it itself.
      CREDIBLE_BASE_URL: "https://${publicHost}"
      CREDIBLE_TRUST_PROXY: "true"
      CREDIBLE_SECURE_COOKIES: "true"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.credible.rule=${rule}"
      - "traefik.http.routers.credible.entrypoints=websecure"
      - "traefik.http.routers.credible.tls.certresolver=letsencrypt"
      - "traefik.http.services.credible.loadbalancer.server.port=${port}"
${noStrip}      # Traefik sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host on
      # every proxied request and passes the browser's Host through untouched,
      # so there is no header middleware to add here. CREDIBLE_TRUST_PROXY=true
      # is what makes Credible read them.

volumes:
  credible_data:

# ── B. file provider, /etc/traefik/dynamic/credible.yml ──────────────────────
#
# For a Traefik whose static config has providers.file.directory pointing at
# /etc/traefik/dynamic with watch: true. Traefik reloads this file on its own —
# nothing to restart. Use this form when Credible runs as a plain process on the
# Traefik host rather than as a container, and set CREDIBLE_HOST=${host} there.

http:
  routers:
    credible:
      rule: "${rule}"
      entryPoints:
        - websecure
      service: credible
      tls:
        certResolver: letsencrypt
  services:
    credible:
      loadBalancer:
        # Credible needs the browser's Host, not the backend's address.
        passHostHeader: true
        servers:
          - url: "http://${target}"
`;
}

function haproxyConfig(ctx) {
  const { publicHost, mount, target, port, mode } = ctx;

  const frontendMatch =
    mode === 'subpath'
      ? `    # Two matches rather than one \`path_beg ${mount}\`: the exact path plus the
    # subtree. A bare path_beg would also route a page of yours called
    # ${mount}-old to Credible.
    acl credible_req path     ${mount}
    acl credible_req path_beg ${mount}/`
      : `    acl credible_req hdr(host) -i ${publicHost}`;

  const backendComment =
    mode === 'subpath'
      ? `    # Nothing rewrites the path. The reflex when routing a prefix to a backend
    # is \`http-request replace-path ${mount}/?(.*) /\\1\` — do not add it here:
    # Credible runs with CREDIBLE_BASE_PATH=${mount} and builds its dashboard
    # links, its assets, the tracker src and the /api/event endpoint from that
    # prefix, so it needs the path exactly as the browser sent it.`
      : '    # Credible is mounted at the root of this name, so nothing is rewritten.';

  return `# /etc/haproxy/haproxy.cfg — the acl and use_backend go in the frontend that
# terminates TLS${mode === 'subpath' ? ` for ${publicHost}` : ''}; the backend goes at the end of the file.
#
# HAProxy wants the certificate chain and the private key in ONE file, which is
# not what certbot writes. See the notes for the two commands that build it.

frontend https_in
    bind :80
    bind :443 ssl crt /etc/haproxy/certs/${publicHost}.pem alpn h2,http/1.1
    mode http
    http-request redirect scheme https unless { ssl_fc }

    # HAProxy adds neither of these on its own, and passes the browser's Host
    # header through untouched. CREDIBLE_TRUST_PROXY=true is what makes Credible
    # read them; without the pair, every visitor collapses into one.
    option forwardfor        # this is HAProxy's spelling of "append X-Forwarded-For"
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    http-request set-header X-Forwarded-Proto http  unless { ssl_fc }

${frontendMatch}
    use_backend credible if credible_req

backend credible
    mode http
${backendComment}
    option httpchk GET ${mount}/api/health
    http-check expect status 200
    server credible1 ${target} check inter 10s

# The instance answers on http://${target}; keep that port closed on the
# firewall so the only way in is through HAProxy.
`;
}

const BUILDERS = {
  caddy: caddyConfig,
  nginx: nginxConfig,
  apache: apacheConfig,
  traefik: traefikConfig,
  haproxy: haproxyConfig,
};

// --------------------------------------------------------- env and notes --

/**
 * The environment the Credible service must run with for the block above to
 * work. CREDIBLE_BASE_URL is the origin *only*: config.js appends
 * CREDIBLE_BASE_PATH to it, so putting the mount point in both doubles it.
 */
function envFor(ctx) {
  const env = {};
  if (ctx.mode === 'subpath') env.CREDIBLE_BASE_PATH = ctx.mount;
  env.CREDIBLE_BASE_URL = ctx.origin;
  env.CREDIBLE_TRUST_PROXY = 'true';
  env.CREDIBLE_SECURE_COOKIES = 'true';
  // Traefik's compose form runs Credible in a container, where the proxy
  // arrives from another address on the docker network.
  env.CREDIBLE_HOST = ctx.server === 'traefik' ? '0.0.0.0' : ctx.host;
  env.CREDIBLE_PORT = String(ctx.port);
  return env;
}

function notesFor(ctx) {
  const { mode, server, publicHost, mount, url, origin, host, port, site } = ctx;
  const tracked = site.replace(/^www\./, '');
  const notes = [];

  notes.push(
    'CREDIBLE_TRUST_PROXY=true is not optional behind a proxy: without it every ' +
      `event is attributed to ${host}, so the dashboard shows one visitor from one ` +
      'country and keeps looking alive while it does. It is the worst failure mode ' +
      'of a proxied install because nothing errors.',
  );

  if (mode === 'subpath') {
    notes.push(
      `CREDIBLE_BASE_URL is the origin only (${origin}). Credible appends ` +
        `CREDIBLE_BASE_PATH to it, so setting it to ${url} would produce ` +
        `${url}${mount} in the install snippet and in every shared link.`,
    );
    notes.push(
      `Check the prefix is free before you reload: ${url} must be a 404 on the site ` +
        'today, or this block will shadow one of its own pages.',
    );
    notes.push(
      'The payoff: the tracker and the beacon are same-origin with the pages they ' +
        'measure, so there is no CORS preflight, no third-party request, and no ' +
        'separate hostname for a content blocker to match.',
    );
  } else {
    notes.push(
      `Create an A record (and an AAAA record if you have IPv6) for ${publicHost} ` +
        'pointing at this machine, and let it resolve, before reloading.',
    );
    notes.push(
      `${publicHost} is a subdomain of the site's own registrable domain, so the ` +
        'beacon stays first-party for the browser and there is no third-party ' +
        'analytics hostname on the page.',
    );
  }

  if (server === 'caddy') {
    notes.push(
      'Check the syntax before reloading: caddy validate --config /etc/caddy/Caddyfile',
    );
  }
  if (server === 'apache') {
    notes.push(
      'Enable the modules first — sudo a2enmod proxy proxy_http remoteip headers — ' +
        'and restart Apache once (a reload does not load a new module).',
    );
  }
  if (server === 'traefik') {
    notes.push(
      'Labels are read when the container is created, so the compose form needs ' +
        '`docker compose up -d credible`. The file-provider form is picked up by ' +
        'Traefik on its own when providers.file has watch: true.',
    );
    notes.push(
      'The certresolver named in the block (letsencrypt) must exist in Traefik\'s ' +
        'static configuration — rename it there or here so the two agree.',
    );
  }

  if (mode === 'subdomain') {
    if (server === 'caddy') {
      notes.push(
        `No certbot: Caddy requests and renews the certificate for ${publicHost} ` +
          'itself over HTTP-01 as soon as the name resolves here.',
      );
    }
    if (server === 'nginx') {
      notes.push(`Get the certificate: sudo certbot --nginx -d ${publicHost}`);
    }
    if (server === 'apache') {
      notes.push(`Get the certificate: sudo certbot --apache -d ${publicHost}`);
    }
    if (server === 'haproxy') {
      notes.push(
        `Certificate: sudo certbot certonly --standalone -d ${publicHost} with HAProxy ` +
          'stopped for a minute, then build the file HAProxy wants — cat ' +
          `/etc/letsencrypt/live/${publicHost}/fullchain.pem ` +
          `/etc/letsencrypt/live/${publicHost}/privkey.pem > ` +
          `/etc/haproxy/certs/${publicHost}.pem — and repeat it from a renewal ` +
          'deploy hook.',
      );
    }
  }

  if (server === 'nginx' || server === 'apache') {
    notes.push(
      'If a renewal ever fails because the challenge is being proxied, serve ' +
        '/.well-known/acme-challenge/ from disk instead of sending it upstream.',
    );
  }

  if (server !== 'traefik' && (host === '127.0.0.1' || host === '::1' || host === 'localhost')) {
    notes.push(
      `Keep Credible bound to ${host}:${port}. The proxy is the only thing that ` +
        'needs to reach it, and a loopback bind means a firewall mistake cannot ' +
        'expose the instance directly.',
    );
  }

  notes.push(
    `Install snippet for this mounting: <script defer data-domain="${tracked}" ` +
      `src="${url}/js/cr.js"></script>`,
  );
  notes.push(
    `Verify after the reload: curl -sI ${url}/js/cr.js should be 200 with ` +
      `content-type: application/javascript, and curl -s ${url}/api/health should ` +
      'answer from Credible rather than from the site.',
  );

  if (ctx.websockets) {
    notes.push(
      'websockets: true is reserved and changed nothing here — Credible polls over ' +
        'plain HTTP and opens no WebSocket, so no upgrade headers were emitted.',
    );
  }

  return notes;
}

// -------------------------------------------------------------- the entry --

/**
 * @param {object} options
 * @param {'caddy'|'nginx'|'apache'|'traefik'|'haproxy'} options.server
 * @param {'subpath'|'subdomain'} options.mode
 * @param {string} options.domain     the site's domain, e.g. 'monsite.fr'
 * @param {string} [options.path]     subpath mode only, default '/stats'
 * @param {string} [options.host]     where Credible listens, default '127.0.0.1'
 * @param {number} [options.port]     default 8000
 * @param {boolean} [options.websockets]  reserved; Credible needs none today
 * @returns {{ server: string, mode: string, url: string, config: string,
 *             env: Record<string,string>, notes: string[], reload: string }}
 *   url    the public URL the instance will answer on
 *   config the block to paste, complete and correct, with a leading comment
 *          naming the file it belongs in
 *   env    the environment variables the Credible service MUST have
 *   reload the command that applies it
 */
export function proxyConfig(options = {}) {
  const {
    server,
    mode,
    domain,
    path = DEFAULT_PATH,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    websockets = false,
  } = options ?? {};

  if (!SERVERS.includes(server)) {
    throw new Error(`Unknown server: ${show(server)}. Supported: ${SERVERS.join(', ')}.`);
  }
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown mode: ${show(mode)}. Supported: ${MODES.join(', ')}.`);
  }

  const site = requireDomain(domain);
  const listenHost = requireHost(host);
  const listenPort = requirePort(port);
  // `path` is meaningless at the root of a name of its own, so it is only read
  // — and only validated — in subpath mode.
  const mount = mode === 'subpath' ? requirePath(path) : '';

  const publicHost = publicHostFor(site, mode);
  const origin = `https://${publicHost}`;
  // An IPv6 literal has to be bracketed everywhere it is followed by a port.
  const target = net.isIPv6(listenHost) ? `[${listenHost}]:${listenPort}` : `${listenHost}:${listenPort}`;

  const ctx = {
    server,
    mode,
    site,
    publicHost,
    origin,
    mount,
    url: `${origin}${mount}`,
    host: listenHost,
    port: listenPort,
    target,
    targetUrl: `http://${target}`,
    websockets: Boolean(websockets),
  };

  return {
    server,
    mode,
    url: ctx.url,
    config: BUILDERS[server](ctx),
    env: envFor(ctx),
    notes: notesFor(ctx),
    reload: RELOAD[server],
  };
}

/**
 * Read a site's own URL and suggest the best mounting for it.
 *
 * The default answer is a subpath, because sharing the site's origin is what
 * makes the tracker first-party. Two shapes argue against it: a site URL that
 * already carries a path is not in charge of the whole origin, and a `www.`
 * host is usually a CDN or platform front end rather than the machine Credible
 * would run on. In both cases a subdomain of the same registrable domain gets
 * the same privacy properties out of a config the operator definitely owns.
 *
 * @param {string} siteUrl
 * @returns {{ mode:'subpath'|'subdomain', path:string, url:string, reason:string }}
 */
export function suggestMounting(siteUrl) {
  const raw = String(siteUrl ?? '').trim();
  if (!raw) {
    throw new Error(`Not a site URL: ${show(siteUrl)}. Pass the address people visit, like https://monsite.fr.`);
  }

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a site URL: ${show(siteUrl)}. Pass the address people visit, like https://monsite.fr.`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Not a site URL: ${show(siteUrl)}. Only http:// and https:// sites can be measured.`);
  }

  const domain = requireDomain(parsed.hostname);
  const hasPath = parsed.pathname !== '' && parsed.pathname !== '/';
  const isWww = domain.startsWith('www.');

  if (hasPath) {
    const subdomainHost = publicHostFor(domain, 'subdomain');
    return {
      mode: 'subdomain',
      path: '',
      url: `https://${subdomainHost}`,
      reason:
        `${raw} already lives below the root, so the ${DEFAULT_PATH} prefix on that host ` +
        `may belong to something else entirely. ${subdomainHost} is a name nothing else ` +
        'answers on, and it is still the site\'s own registrable domain.',
    };
  }

  if (isWww) {
    const subdomainHost = publicHostFor(domain, 'subdomain');
    return {
      mode: 'subdomain',
      path: '',
      url: `https://${subdomainHost}`,
      reason:
        `${domain} is usually a CDN or platform front end rather than the machine ` +
        `Credible runs on, so a subpath would have to be threaded through a config you ` +
        `may not control. ${subdomainHost} is one DNS record and one server block, on ` +
        'the same registrable domain.',
    };
  }

  return {
    mode: 'subpath',
    path: DEFAULT_PATH,
    url: `https://${domain}${DEFAULT_PATH}`,
    reason:
      `${domain} serves the site itself, so ${DEFAULT_PATH} rides on the same origin and ` +
      'the same certificate: the tracker is a first-party script, the beacon needs no ' +
      'CORS preflight, and there is no analytics hostname for a blocker to match.',
  };
}
