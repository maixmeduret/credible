# Self-hosting Credible

Credible is one Node process writing to one SQLite file. There is no database server to
provision, no queue, no cache, and no container runtime required. This guide takes you from a
blank VPS to a production instance behind HTTPS, then covers backups, upgrades, retention,
and moving an existing instance.

- [Requirements](#requirements)
- [Configuration reference](#configuration-reference)
- [Install on a VPS](#install-on-a-vps)
- [Run it as a service (systemd)](#run-it-as-a-service-systemd)
- [Put it behind a reverse proxy](#put-it-behind-a-reverse-proxy)
  - [Caddy](#caddy)
  - [nginx](#nginx)
  - [About CREDIBLE_TRUST_PROXY](#about-credible_trust_proxy)
- [Docker](#docker)
- [Fly.io](#flyio)
- [Raspberry Pi](#raspberry-pi)
- [Backups](#backups)
- [Upgrades](#upgrades)
- [Retention](#retention)
- [Moving to another instance](#moving-to-another-instance)
- [Troubleshooting](#troubleshooting)

## Requirements

| | |
|---|---|
| Node.js | **22.13 or newer** (24 and 26 work too) |
| Disk | The database only. Roughly 100–200 bytes per event after indexes |
| RAM | 128 MB is enough for most instances; 512 MB is comfortable |
| CPU | One shared core handles millions of events a month |

Node 22.13 is the floor because storage uses the built-in `node:sqlite` module, which stopped
requiring the `--experimental-sqlite` flag in that release. Check with `node --version`.

A small VPS (1 vCPU / 1 GB) is more than most sites will ever need.

## Configuration reference

There is no config file. Every setting is an environment variable, and this is the complete
list — it is `src/config.js` in table form, so if a variable is not here it does not exist.

| Variable | Default | What it does |
|---|---|---|
| `CREDIBLE_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` when a reverse proxy is in front |
| `CREDIBLE_PORT` | `8000` | Port to listen on |
| `CREDIBLE_DATA_DIR` | `./data` | Directory for the database and generated secrets. Created with mode `700` |
| `CREDIBLE_DATABASE` | `$CREDIBLE_DATA_DIR/credible.db` | Explicit database path, if you want it somewhere else |
| `CREDIBLE_BASE_URL` | *(guessed from the request)* | Public origin, e.g. `https://stats.example.com`. Used in the install snippet and shared links |
| `CREDIBLE_TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For` / `CF-Connecting-IP`. See the warning below |
| `CREDIBLE_SECURE_COOKIES` | `false` | Mark the session cookie `Secure`. Set it once you are on HTTPS |
| `CREDIBLE_SESSION_TTL` | `2592000` | Dashboard login lifetime, in seconds (30 days) |
| `CREDIBLE_OPEN_REGISTRATION` | `true` | Allow new accounts. Set `false` to lock the instance down; the first account can always be created |
| `CREDIBLE_INACTIVITY_TIMEOUT` | `1800` | Seconds of silence that end a visit. Changing it does not rewrite existing visits |
| `CREDIBLE_RATE_LIMIT` | `600` | Ingest events per minute per IP. `0` disables the limit |
| `CREDIBLE_RETENTION_DAYS` | `0` | Delete raw events older than N days. `0` keeps them forever |
| `CREDIBLE_FLUSH_INTERVAL_MS` | `250` | **Reserved, currently no effect.** Intended write-buffer interval; today each event is written in its own transaction |
| `CREDIBLE_FLUSH_MAX_BATCH` | `500` | **Reserved, currently no effect.** Intended maximum events per buffered write |
| `CREDIBLE_GEO_DB` | *(unset)* | Path to a DB-IP Lite / IP2Location Lite `start_ip,end_ip,country` CSV (`.csv` or `.csv.gz`) for country lookup without a CDN. Without it, geography comes from edge headers |
| `CREDIBLE_LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. No level ever logs an IP address |

Booleans accept `1`, `true`, `yes`, or `on` (case-insensitive); anything else is false. An
empty value is treated as unset, so the default applies. Numbers that do not parse fall back
to the default rather than failing at startup.

## Install on a VPS

This assumes Debian or Ubuntu; adapt the package manager for anything else.

**1. Install Node from NodeSource** (distribution packages are often far too old):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version    # must print v22.13.0 or newer
```

**2. Create a dedicated system user.** The service should not run as root or as you:

```bash
sudo useradd --system --create-home --home-dir /var/lib/credible --shell /usr/sbin/nologin credible
```

**3. Install the application:**

```bash
sudo git clone https://github.com/maixmeduret/credible.git /opt/credible
sudo chown -R credible:credible /opt/credible
sudo install -d -o credible -g credible -m 750 /var/lib/credible/data
```

**4. Try it once by hand** to confirm it starts:

```bash
sudo -u credible CREDIBLE_DATA_DIR=/var/lib/credible/data node /opt/credible/bin/credible.js serve
```

It should print that it is listening on port 8000, along with a one-time link to create the
first account. Stop it with `Ctrl-C` — the next step makes it permanent.

## Run it as a service (systemd)

Write `/etc/systemd/system/credible.service`:

```ini
[Unit]
Description=Credible — privacy-first web analytics
Documentation=https://github.com/maixmeduret/credible
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=credible
Group=credible
WorkingDirectory=/opt/credible
ExecStart=/usr/bin/node /opt/credible/bin/credible.js serve
Restart=on-failure
RestartSec=5

# Listen only on loopback: the reverse proxy is the only thing that should
# reach the app directly.
Environment=CREDIBLE_HOST=127.0.0.1
Environment=CREDIBLE_PORT=8000
Environment=CREDIBLE_DATA_DIR=/var/lib/credible/data
Environment=CREDIBLE_BASE_URL=https://stats.example.com
Environment=CREDIBLE_TRUST_PROXY=true
Environment=CREDIBLE_SECURE_COOKIES=true
Environment=CREDIBLE_LOG_LEVEL=info

# Once your accounts exist, set this to false and reload.
Environment=CREDIBLE_OPEN_REGISTRATION=true

# Hardening. The service needs to write to its data directory and nothing else.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
ReadWritePaths=/var/lib/credible/data

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now credible
sudo systemctl status credible
sudo journalctl -u credible -f     # follow the logs; the setup link is here
```

If you keep secrets out of the unit file, put them in `/etc/credible.env` (mode `600`, owned
by `credible`) and replace the `Environment=` lines with `EnvironmentFile=/etc/credible.env`.

## Put it behind a reverse proxy

The app speaks plain HTTP on loopback. The proxy terminates TLS and forwards the client's
real IP, which Credible needs in memory to derive a country and the daily visitor hash.

### Caddy

Caddy gets you an automatic certificate with no extra work. `/etc/caddy/Caddyfile`:

```caddy
stats.example.com {
	encode gzip zstd

	reverse_proxy 127.0.0.1:8000 {
		# Caddy sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host
		# automatically; these are explicit so the intent is obvious.
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {host}
		header_up Host {host}
	}
}
```

```bash
sudo systemctl reload caddy
```

### nginx

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name stats.example.com;
    # Certbot will replace this with a redirect to HTTPS.
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name stats.example.com;

    ssl_certificate     /etc/letsencrypt/live/stats.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stats.example.com/privkey.pem;

    # The tracker posts small JSON bodies; nothing here is large.
    client_max_body_size 64k;

    gzip on;
    gzip_types application/javascript application/json text/css text/html;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # These four are what CREDIBLE_TRUST_PROXY reads. Without them every
        # visitor looks like 127.0.0.1: one country, one visitor, all day.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_read_timeout 60s;
        proxy_redirect off;
    }
}
```

Get a certificate with `sudo certbot --nginx -d stats.example.com`, then
`sudo nginx -t && sudo systemctl reload nginx`.

### About `CREDIBLE_TRUST_PROXY`

Set `CREDIBLE_TRUST_PROXY=true` **only** when a proxy you control sits in front and always
overwrites `X-Forwarded-For`. That is the case in every configuration above, and on Fly.io.

If you enable it without such a proxy, anyone can send a forged `X-Forwarded-For` header and
choose their own country and visitor hash, which corrupts your stats. If you leave it off
while behind a proxy, every event is attributed to the proxy's address: your dashboard shows
a single visitor from wherever your server lives. Both failure modes are obvious in the data
within a few minutes, so check the countries panel after switching it on.

Also set `CREDIBLE_BASE_URL` to your public origin so the install snippet and shared
dashboard links point at the right hostname, and `CREDIBLE_SECURE_COOKIES=true` so the
session cookie is only sent over HTTPS.

## Docker

```bash
git clone https://github.com/maixmeduret/credible.git
cd credible
docker compose up -d
docker compose logs -f credible     # the first-run account link
```

The bundled `docker-compose.yml` maps port 8000 and stores the database in a named volume
called `credible_data`, so `docker compose down` and image upgrades do not touch your data.
Edit the `environment:` block to set `CREDIBLE_BASE_URL` and, behind a proxy,
`CREDIBLE_TRUST_PROXY` and `CREDIBLE_SECURE_COOKIES`.

To back up or inspect the volume:

```bash
docker compose exec credible ls -la /data
docker run --rm -v credible_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/credible-data.tar.gz -C /data .
```

The container runs as the unprivileged `node` user. If you swap the named volume for a bind
mount, make the host directory writable by UID 1000 first
(`sudo chown -R 1000:1000 ./data`), otherwise the process cannot create its database.

## Fly.io

The included `fly.toml` is ready to use:

```bash
fly launch --copy-config --no-deploy    # choose a region close to your visitors
fly volumes create credible_data --size 1
fly deploy
fly logs                                 # the first-run account link
```

Then set your real hostname:

```bash
fly secrets set CREDIBLE_BASE_URL=https://stats.example.com
fly certs add stats.example.com
```

Two things matter here. `auto_stop_machines = false` and `min_machines_running = 1` are set
deliberately: a suspended machine silently drops the pageviews it was supposed to record.
And because SQLite needs real local disk, this app runs on **one** machine in one region —
do not `fly scale count 2`, because each machine would get its own separate database.

## Raspberry Pi

A Pi is a genuinely good host for this: the workload is small writes and occasional reads.

- Use a Pi 4 or newer, 64-bit Raspberry Pi OS, and **boot from an SSD** rather than a
  microSD card. SD cards wear out under a write-heavy workload and fail without warning.
- Install Node 22 from NodeSource as above (`arm64` is supported).
- Follow the systemd instructions unchanged.
- To expose it to the internet without opening a port, use a Cloudflare Tunnel or Tailscale
  Funnel in front, and keep `CREDIBLE_TRUST_PROXY=true` since those set `X-Forwarded-For`.
- Put backups on a different device — that is the whole point of a backup.

## Backups

The database is a single file. That is the main operational advantage of this project, so
take advantage of it.

**Hot backup with the `sqlite3` CLI** (recommended — safe while the server is running):

```bash
sudo apt-get install -y sqlite3

sudo -u credible sqlite3 /var/lib/credible/data/credible.db \
  ".backup '/var/lib/credible/backups/credible-$(date +%F).db'"
```

`.backup` takes a consistent snapshot even under concurrent writes. This is the only correct
way to copy a live database.

**Cold copy** (while the service is stopped):

```bash
sudo systemctl stop credible
sudo cp /var/lib/credible/data/credible.db* /var/lib/credible/backups/
sudo systemctl start credible
```

Copy the `-wal` and `-shm` files alongside it — hence the `credible.db*` glob. Copying only
`credible.db` from a running instance with `cp` risks a torn, unusable file.

**Never** `cp` a live database without `.backup`. If the `sqlite3` CLI is not available and
you cannot stop the service, use the logical export instead:

```bash
node /opt/credible/bin/credible.js export yourdomain.com > yourdomain-$(date +%F).csv
```

A nightly cron entry, keeping 14 days:

```cron
15 4 * * * sqlite3 /var/lib/credible/data/credible.db ".backup '/var/lib/credible/backups/credible-$(date +\%F).db'" && find /var/lib/credible/backups -name 'credible-*.db' -mtime +14 -delete
```

Then ship `/var/lib/credible/backups` off the machine with `restic`, `rclone`, or `rsync`.
Restoring is the reverse: stop the service, put the file at
`/var/lib/credible/data/credible.db`, remove any stale `-wal`/`-shm` files next to it, fix
ownership with `chown credible:credible`, start the service. Test a restore before you need
one.

## Upgrades

Take a backup first, every time.

**From a git clone:**

```bash
cd /opt/credible
sudo -u credible git pull
sudo systemctl restart credible
```

**With Docker:**

```bash
docker compose pull      # or: docker compose build --pull
docker compose up -d
```

Schema migrations run automatically at startup and are recorded in the
`schema_migrations` table, so there is no separate migrate command. Watch
`journalctl -u credible -n 50` after a restart to confirm it came up cleanly. Downgrades are
not supported — that is what the backup is for.

## Retention

By default Credible keeps raw events forever, which is usually what you want: the data is
small and history is the point.

To enforce a retention window, set `CREDIBLE_RETENTION_DAYS` and restart. Events older than
that are deleted automatically:

```bash
Environment=CREDIBLE_RETENTION_DAYS=730     # keep two years
```

`0` disables the cleanup. Note that deleting rows does not shrink the file on disk by itself;
SQLite reuses the freed pages for new data. To actually reclaim disk after a large deletion,
stop the service and run:

```bash
sudo -u credible sqlite3 /var/lib/credible/data/credible.db "VACUUM;"
```

This needs temporary free space roughly equal to the size of the database.

Separately from retention, the daily salts that make visitor hashes computable are deleted
after 48 hours regardless of this setting. That is part of the privacy model and is not
configurable — see [PRIVACY.md](PRIVACY.md).

## Moving to another instance

Because everything is in one file, migration is a file copy.

**Same version, whole instance** — users, sites, API keys and all events:

```bash
# On the old server
sudo systemctl stop credible
sudo -u credible sqlite3 /var/lib/credible/data/credible.db ".backup '/tmp/credible.db'"

# Copy it across
scp /tmp/credible.db newserver:/tmp/credible.db

# On the new server
sudo systemctl stop credible
sudo install -o credible -g credible -m 640 /tmp/credible.db /var/lib/credible/data/credible.db
sudo rm -f /var/lib/credible/data/credible.db-wal /var/lib/credible/data/credible.db-shm
sudo systemctl start credible
```

Upgrade both ends to the same version first if they differ; if the new server is newer,
migrations apply on first start.

Afterwards, point DNS at the new host and update `CREDIBLE_BASE_URL`. Leave the old instance
running until DNS has propagated — events sent to the old hostname in the meantime land in
the old database, and you can export and re-import them if you care about the gap.

**Only the data for one site**, or into a different tool:

```bash
node /opt/credible/bin/credible.js export yourdomain.com > yourdomain.csv
```

Update the script tag's `src` on your website to the new instance's hostname. The
`data-domain` attribute stays the same — that is how sites are identified, independently of
where the instance is hosted.

## Troubleshooting

**No data appears.** Confirm the `data-domain` attribute exactly matches the domain you
registered in the dashboard, with no `https://` and no trailing slash. Then check that
`/js/cr.js` actually loads (browser devtools, Network tab) — content blockers rarely block a
self-hosted first-party path, but a Content-Security-Policy on your site can. Requests from
`localhost` are ignored by design.

**Everyone is in one country, and the visitor count is stuck at 1.** The app is not seeing
real client IPs. Set `CREDIBLE_TRUST_PROXY=true` and confirm the proxy sets
`X-Forwarded-For`, per the config blocks above.

**`SQLITE_BUSY` or "database is locked" in the logs.** Something else is holding a write
lock on the file — commonly a backup script using `cp` instead of `.backup`, or a second
instance pointed at the same database. Only one Credible process may own a database file.

**"Cannot find module 'node:sqlite'" or a message about `--experimental-sqlite`.** Node is
older than 22.13. Upgrade it; `node --version` tells you what the service will actually use,
which on some systems differs from your shell's version.

**Login fails or the session drops immediately.** If `CREDIBLE_SECURE_COOKIES=true`, the
dashboard must be reached over HTTPS — the browser silently discards a `Secure` cookie sent
over plain HTTP.

**Permission denied writing the database.** The data directory must be writable by the user
in the systemd unit (`chown -R credible:credible /var/lib/credible/data`), or by UID 1000 for
a Docker bind mount.
