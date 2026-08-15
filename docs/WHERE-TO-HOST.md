# Where to host Credible

The short answer: **on the machine that already serves your website**, at a path or a
subdomain of the domain you already own. Credible is one Node process and one file, so it
fits next to almost any site that runs on a real server, and serving it from your own domain
is strictly better than pointing at somebody else's analytics host.

The honest complication: a large and growing share of websites are on platforms that cannot
run a long-lived process or write to a disk at all. If your site is on Vercel, Netlify,
Cloudflare Pages, Squarespace or Shopify, "just install it on your server" is useless advice,
because there is no server you can install anything on. This document says which situation
you are in, and what to do in each.

- [Can your setup host it?](#can-your-setup-host-it)
- [The best setup: on the machine that already serves your site](#the-best-setup-on-the-machine-that-already-serves-your-site)
- [What it actually costs to run](#what-it-actually-costs-to-run)
- [Sizing, from a blog to a few million pageviews](#sizing-from-a-blog-to-a-few-million-pageviews)
- [Standing it up next to your site](#standing-it-up-next-to-your-site)
- [Backups and moving](#backups-and-moving)

---

## Can your setup host it?

Credible needs three things, and only these three: a **process that stays running**, a
**writable local disk**, and **Node.js 22.13 or newer**. No database server, no Redis, no
build step, no npm install.

### Yes — it can run next to your site

| Where your site lives | How to run Credible there |
|---|---|
| **A VPS** (Hetzner, OVH, Scaleway, DigitalOcean, Linode…) | The reference case. systemd unit + your existing Caddy/nginx — [SELF-HOSTING.md](SELF-HOSTING.md#install-on-a-vps) |
| **A dedicated server** | Same as a VPS, with more headroom than you will ever use |
| **A NAS** (Synology, QNAP) | Run the image from the repo's `Dockerfile` in Container Manager / Container Station, with a volume on the NAS disk. Use the NAS's own reverse proxy for TLS. Do not use the vendor's bundled Node package — it is usually years old |
| **A Raspberry Pi at home** | Genuinely fine, and a good fit for the workload. Boot from an SSD, not a microSD card — [SELF-HOSTING.md](SELF-HOSTING.md#raspberry-pi) |
| **Any Docker host** | `docker compose up -d`, one service, one named volume — [SELF-HOSTING.md](SELF-HOSTING.md#docker) |
| **Coolify, Dokku, CapRover, Kamal** | They build the repo's `Dockerfile` and run it. Attach a persistent volume at `/data`, keep `CREDIBLE_DATA_DIR=/data`, let their proxy terminate TLS, and run **one** replica |
| **cPanel / Plesk with a Node app** | Works through "Setup Node.js App" (Passenger) *if* the panel offers Node ≥ 22.13 and does not idle the app out. Check first: many panels top out below 22.13 |
| **Self-hosted WordPress** on your own host | Yes if you have shell access and can run Node ≥ 22.13 next to PHP. On shell-less shared hosting, no |
| **Fly.io, Render, Railway** | Yes, with a **persistent volume** attached and **sleep/scale-to-zero disabled** — a suspended machine silently drops the pageviews it was meant to record. `fly.toml` in the repo already sets that. One machine only |

Two rules that apply to every row: the database must be on **local disk** (SQLite over NFS or
a network volume can corrupt the file), and only **one** Credible process may own a database
file. Scaling to two instances gives you two separate, half-empty databases.

### No — that platform cannot host it

| Where your site lives | Why not |
|---|---|
| **Vercel** | No persistent process — functions are invoked per request, and the filesystem is read-only apart from a throwaway `/tmp` |
| **Netlify** | Same shape: functions are ephemeral, with no writable disk that survives an invocation |
| **Cloudflare Pages / Workers** | Not a Node process, and no local disk at all — durable state means D1/KV/R2, not a file |
| **GitHub Pages** | Static file hosting; there is no server to run anything on |
| **AWS Lambda, Google Cloud Functions, Azure Functions** | No persistent process, and each invocation may land on a different sandbox with its own empty `/tmp` |
| **Google Cloud Run and similar scale-to-zero container runtimes** | The container filesystem is ephemeral and in-memory. You can pin a minimum instance, but the durable storage on offer is network-attached (GCS FUSE, NFS), and SQLite is not safe on either |
| **Wix, Squarespace, Shopify** | No server access at all — you get a CMS, not a machine |
| **WordPress.com** | A managed PHP host. Even the plans that grant SSH/WP-CLI give you a PHP application container, not somewhere to run a long-lived Node process |

None of this stops you from *measuring* a site hosted on those platforms. It only means the
instance has to live somewhere else.

> ### If your site's host cannot run it
>
> Run Credible on the cheapest thing that stays up, and put it on a subdomain of the domain
> you already own — `stats.monsite.fr` — so your visitors only ever talk to your own hostname.
> Three options that all work:
>
> - **Fly.io** — `fly launch --copy-config --no-deploy`, `fly volumes create credible_data
>   --size 1`, `fly deploy`, then `fly certs add stats.monsite.fr`. The repo's `fly.toml` is
>   ready to go and pins a single small machine. Check their current pricing before you rely
>   on it being free.
> - **A small VPS**, around €4–6/month at the usual providers. Follow
>   [SELF-HOSTING.md](SELF-HOSTING.md#install-on-a-vps); it takes about fifteen minutes.
> - **A Raspberry Pi you already own**, exposed with a Cloudflare Tunnel or Tailscale Funnel
>   so you never open a port — [SELF-HOSTING.md](SELF-HOSTING.md#raspberry-pi).
>
> In all three cases, add one DNS record for `stats.monsite.fr`, set `CREDIBLE_BASE_URL` to
> it, and keep `CREDIBLE_TRUST_PROXY=true` since every one of them puts a proxy in front.
>
> **And if you do not want to run a server at all** — that is a completely reasonable
> position, and Credible is then the wrong tool. Pay for a hosted product instead: Plausible
> Cloud is the closest thing in spirit and worth the money.
> [COMPARISON.md](COMPARISON.md#choosing) lays out the alternatives without flattery.

---

## The best setup: on the machine that already serves your site

If the box that serves `monsite.fr` can also run a Node process, put Credible on it and serve
it from the same domain:

```
https://monsite.fr/stats/js/cr.js        subpath    — same origin as the site
https://stats.monsite.fr/js/cr.js        subdomain  — same registrable domain
```

Both are what "first-party analytics" actually means, and both beat pointing your `src` at a
third-party analytics host:

- **No cross-origin request.** For the subpath form, the tracker and the beacon go to the
  exact origin the page came from — no extra DNS lookup, no extra TLS handshake, one fewer
  connection for the browser to set up.
- **The certificate you already have covers it.** Nothing to renew, nothing extra to break.
- **There is no third-party hostname to block.** Content blockers work primarily from lists
  of known analytics *hostnames*. Yours is not on any list, because it is your own site.
- **It cannot outlive your site.** No third party to go down, change pricing, or start
  sampling your data.

### Be accurate about what that does and does not do

First-party serving defeats **hostname** blocklists. It does not make analytics invisible:
anyone can open devtools and see a `POST` to `/stats/api/event`, and blocklists also carry
path- and filename-based rules that a self-hosted script can occasionally match. If that
happens, the honest outcome is that you do not count that visit. Nothing on the page breaks,
and renaming things to stay ahead of a filter list is a game not worth playing.

More importantly, this is **not a technique for getting around someone's choice not to be
tracked**. The reason first-party serving is fine here is much simpler: Credible collects no
personal data at all. No cookie, no `localStorage`, no fingerprint, no raw IP on disk, and a
visitor hash whose salt is deleted after 48 hours — after which nothing can link it to
anything, including by you. There is no profile being built to hide. If you were doing
something that genuinely needed consent, serving it from your own domain would not make it
lawful. See [PRIVACY.md](PRIVACY.md).

### Subpath or subdomain?

| | **Subpath** — `monsite.fr/stats` | **Subdomain** — `stats.monsite.fr` |
|---|---|---|
| Origin | Same origin as the measured pages | Same registrable domain, different origin |
| DNS | Nothing to add | One A/AAAA (or CNAME) record |
| TLS | Covered by the site's existing certificate | Needs the certificate to cover it: a wildcard, or a second `certbot` run |
| Proxy config | A `location` / `handle` block inside the existing site's server block, and the app must know its prefix: `CREDIBLE_BASE_PATH=/stats` | A separate server block. Simpler, and independent of the site's config |
| App config | `CREDIBLE_BASE_PATH=/stats` and `CREDIBLE_BASE_URL=https://monsite.fr` — the **origin only** | `CREDIBLE_BASE_URL=https://stats.monsite.fr` |
| Blocker exposure | Nothing for a hostname list to match | A hostname that is yours and on no list, but visible as a separate host |
| Best when | The site and the instance share one machine and one proxy | The instance lives elsewhere, or several sites share it |

`CREDIBLE_BASE_PATH` is what makes the subpath form work: set it to `/stats` and the
dashboard is at `https://monsite.fr/stats`, ingestion at `https://monsite.fr/stats/api/event`,
and the tracker at `https://monsite.fr/stats/js/cr.js`. Left empty (the default), everything
sits at the root of the domain exactly as it does today.

**`CREDIBLE_BASE_URL` is the origin, not the mount point.** Credible appends
`CREDIBLE_BASE_PATH` to it itself, so the pair is `https://monsite.fr` + `/stats`. Setting the
base URL to `https://monsite.fr/stats` as well produces `https://monsite.fr/stats/stats` in
the install snippet and in every shared link — a mistake that only shows up later, in a URL
somebody else clicks.

The snippet needs no special attribute in either case:

```html
<script defer data-domain="monsite.fr" src="https://monsite.fr/stats/js/cr.js"></script>
```

The tracker derives its endpoint from its own `src` by dropping the `/js/…` segment, so
`…/stats/js/cr.js` posts to `…/stats/api/event` on its own. `data-api` is only for the
different case where the instance lives on another host and you proxy the beacon through your
domain — [TRACKING.md](TRACKING.md#data-api).

One last thing worth doing once your account exists: set `CREDIBLE_OPEN_REGISTRATION=false`.
The dashboard is now on your main domain, and there is no reason to leave signup open on it.

---

## What it actually costs to run

One process. Zero npm dependencies. No database server, no cache, no queue, no build step.
Whatever else is on the machine, Credible adds one `node` and one file.

The figures below were **measured** on this repository with a seeded database of 111,862
events over 60 days (`credible seed`), on an Apple Silicon laptop with an NVMe SSD and Node
26.5. Treat the shape as reliable and the digits as generous: a shared-vCPU VPS with
network-backed storage will be meaningfully slower, and that is an estimate, not a
measurement.

| | Measured | Notes |
|---|---|---|
| RAM, idle | **~62 MB** RSS, database open | Most of it is the V8 baseline |
| RAM, under ingest | **~90 MB** after 5,000 events back to back | Heap grows before GC bothers to shrink it. [SELF-HOSTING.md](SELF-HOSTING.md#requirements)'s "128 MB is enough, 512 MB is comfortable" holds up |
| Disk | **~295 bytes per event**, everything included | Derivation below |
| Ingest throughput | **~6,600 events/s** at 20 concurrent connections, rate limit off | On a 1-vCPU VPS expect a fraction of that — still orders of magnitude past what a normal site produces. For scale: 1M events/month averages **0.4 events/second** |
| Dashboard queries | **48–73 ms** each for aggregate, timeseries and breakdown over a 60-day window on 117k events | A dashboard load fires several of these |
| Tracker bandwidth | **13 KB** on disk, **4.6 KB** gzipped over the wire, then cached | Each beacon is a few hundred bytes |

**Where the 295 bytes come from.** After `VACUUM`, the seeded database was 33.0 MB for
111,862 events and 29,770 visits. Per event, by table, using SQLite's own `dbstat`:

| Component (from [`src/db/schema.sql`](../src/db/schema.sql)) | Bytes per event |
|---|---|
| The `events` row itself — ~30 short text columns, denormalised so breakdowns need no join | ~170 |
| Its four indexes (`site+ts`, `site+name+ts`, `visit_id`, `site+path+ts`) | ~74 |
| The `visits` row and its two indexes, amortised over ~3.8 events per visit | ~51 |
| **Total** | **~295** |

That is consistent with the 100–200 bytes per event quoted in
[SELF-HOSTING.md](SELF-HOSTING.md#requirements): that range is the event row, and the indexes
plus the session table are what take it to ~300. **Plan with 300 MB per million events.** The
seeded traffic has short paths (9 characters on average) and light campaign tagging; long
URLs and heavy UTM tagging push it up, so treat 300 as a working budget rather than a floor.

One conversion you need for planning: a normal pageview produces **two** events — the
pageview, and the `engagement` event carrying time-on-page and scroll depth when the visitor
leaves — plus any custom events you send. So **one million pageviews ≈ two million events ≈
600 MB**.

---

## Sizing, from a blog to a few million pageviews

| Your traffic | What to run it on | What to expect |
|---|---|---|
| **A personal blog or portfolio**, under ~10k pageviews/month | Anything at all: the Pi, the smallest VPS, the box already serving the site | ~240k events and well under 100 MB a year. You will never think about it again |
| **A busy blog or small SaaS**, ~100k pageviews/month | 1 vCPU / 1 GB, alongside the site | ~200k events/month, ~60 MB/month, under 1 GB a year. Comfortable everywhere |
| **A well-known site**, ~1M pageviews/month | Same 1 vCPU / 1 GB box, but plan the disk | ~2M events/month, ~600 MB/month, ~7 GB a year. CPU is a non-issue (0.8 events/second average); disk is the thing to watch. Consider `CREDIBLE_RETENTION_DAYS` |
| **A few million pageviews/month** | A VPS with real local SSD and room to grow | ~10M events/month at 5M pageviews, ~3 GB/month. Still within what SQLite handles well, but now you are managing disk deliberately: set a retention window, keep the file on local SSD, watch dashboard latency on long periods |
| **Beyond ~50M events/month, or you need more than one machine** | Not this | See below |

**When SQLite stops being the right answer.** SQLite in WAL mode allows many readers and
exactly one writer. The signals that you have arrived at the ceiling are concrete: writes
falling behind at traffic peaks, `SQLITE_BUSY` in the logs under normal load, dashboard
queries taking seconds on ordinary periods, or a requirement Credible structurally cannot
meet — high availability, or readers and writers in different regions.
[ARCHITECTURE.md § Scaling notes](ARCHITECTURE.md#scaling-notes) gives the full table and
names where to go next (ClickHouse, or DuckDB if you want to keep the single-file
operational model). It is not a defeat: the single-file design is chosen for the 99% of sites
that never get near these numbers.

Two hard rules at any size, both from that document:

- **Local disk, always.** SQLite over NFS or a shared network volume can corrupt the
  database. Fly.io volumes and ordinary VPS disks are fine.
- **One process per database file.** Never run two instances against the same file, and never
  scale a container deployment past one replica.

---

## Standing it up next to your site

This is the subpath case — the site and Credible on one machine, behind the proxy that
already terminates TLS for the site. Adapt the path if you prefer something other than
`/stats`.

**1. Run the instance.**

```bash
git clone https://github.com/maixmeduret/credible.git
cd credible
node bin/credible.js deploy --target local
```

That writes a user service (a launchd agent on macOS, a systemd *user* unit on Linux), keeps
the database in `~/.credible/data`, and listens on `127.0.0.1:8000` — reachable by the proxy
and by nothing else. The command prints the path of the file it wrote
(`~/.config/systemd/user/credible.service`, or `~/Library/LaunchAgents/dev.credible.plist`).

On a real server, prefer the **system** unit in
[SELF-HOSTING.md](SELF-HOSTING.md#run-it-as-a-service-systemd): it runs under a dedicated
`credible` user, keeps its data in `/var/lib/credible/data`, is hardened with
`ProtectSystem=strict`, and starts at boot without anyone logging in. A user unit needs
`loginctl enable-linger <user>` to survive logout at all.

**2. Tell it where it lives.** `deploy --target local` bakes in a localhost base URL, because
that is all it can know. Add these four variables to the service file it wrote (in the
`[Service]` section of a systemd unit; inside the `EnvironmentVariables` dict if it wrote a
launchd plist) and restart:

```ini
Environment=CREDIBLE_BASE_PATH=/stats
Environment=CREDIBLE_BASE_URL=https://monsite.fr
Environment=CREDIBLE_TRUST_PROXY=true
Environment=CREDIBLE_SECURE_COOKIES=true
```

Again: the base URL is the origin. `/stats` is carried by `CREDIBLE_BASE_PATH` alone.

> **`CREDIBLE_TRUST_PROXY=true` is mandatory behind a proxy.** Without it every event arrives
> with the proxy's address: one country, one visitor, all day. With it — and *only* with a
> proxy you control in front that always overwrites `X-Forwarded-For` — the client IP is read
> from the forwarded headers, used in memory to derive a country and the daily hash, and
> discarded. Enabling it on a directly-exposed instance lets anyone forge their own country
> and visitor hash. [SELF-HOSTING.md](SELF-HOSTING.md#about-credible_trust_proxy) has both
> failure modes in full.

**3. Add the proxy block.** Ask Credible for it rather than writing it by hand — it emits the
block, the environment variables that must match it, and the reload command:

```bash
node bin/credible.js proxy-config --domain monsite.fr --mode subpath --path /stats
```

`--server` picks the syntax — `caddy`, `nginx`, `apache`, `traefik` or `haproxy`; without it
Credible guesses from what is installed. `--mode subdomain` gives the `stats.monsite.fr`
variant instead. `--json` returns the config, the env block and the notes as data.

Paste what it prints **inside your existing site's server block**, next to the rules that serve
your pages. The shape, for orientation — take the real thing, with its comments, from the
command:

```caddy
monsite.fr {
	# … your existing site directives, inside a handle block of their own …

	@credible path /stats /stats/*
	handle @credible {          # handle, never handle_path
		reverse_proxy 127.0.0.1:8000 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			header_up Host {host}
		}
	}
}
```

```nginx
# inside the existing server { } block for monsite.fr
location ^~ /stats/ {
    proxy_pass http://127.0.0.1:8000;   # no trailing slash: the /stats prefix must survive
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
}
location = /stats { absolute_redirect off; return 301 /stats/; }
```

Three details that bite people. The prefix must reach the app **unstripped** when
`CREDIBLE_BASE_PATH` is set: in nginx that means no trailing slash and no URI on `proxy_pass`,
in Caddy it means `handle`, not `handle_path`. The `^~` matters too — without it a regex
`location ~* \.(js|css)$` asset block wins over the prefix match and serves `/stats/js/cr.js`
off the filesystem as a 404. And those forwarded headers are exactly what
`CREDIBLE_TRUST_PROXY` reads. Reload afterwards — `caddy validate --config /etc/caddy/Caddyfile
&& sudo systemctl reload caddy`, or `sudo nginx -t && sudo systemctl reload nginx`.

**4. Check the whole chain.**

```bash
node bin/credible.js doctor --url https://monsite.fr/stats --domain monsite.fr
```

It verifies that the instance answers, that it is on HTTPS, that `/stats/js/cr.js` is served,
and that `/stats/api/event` accepts events — attaching a fix to anything that is wrong, and
exiting non-zero so a script can act on it. `--json` gives the checks as structured data. Its
probe uses a domain nobody tracks, so running it never moves your numbers.

**5. Install the snippet**, then deploy your site. Nothing is recorded until the tag is live:

```html
<script defer data-domain="monsite.fr" src="https://monsite.fr/stats/js/cr.js"></script>
```

`node bin/credible.js install --domain monsite.fr --url https://monsite.fr/stats --path
/path/to/your/site --dry-run` will find the right template in most projects and show you the
diff before touching anything — [AI-SETUP.md § 3](AI-SETUP.md#3-install-the-snippet).

---

## Backups and moving

The whole instance is one SQLite file. Users, sites, API keys, goals, funnels and every event
are in it; there is no second place state hides.

**Back it up hot**, while the server keeps running:

```bash
sqlite3 /var/lib/credible/data/credible.db \
  ".backup '/var/lib/credible/backups/credible-$(date +%F).db'"
```

**Or stop the service and copy it**, including the `-wal` and `-shm` files:

```bash
sudo systemctl stop credible
sudo cp /var/lib/credible/data/credible.db* /var/lib/credible/backups/
sudo systemctl start credible
```

Never plain `cp` a live database without `.backup` — you can get a torn, unusable file.

**Moving** is the same operation with an `scp` in the middle: copy the file across, delete any
stale `-wal`/`-shm` next to it, fix ownership, start the service, update `CREDIBLE_BASE_URL`
(and `CREDIBLE_BASE_PATH` if the new mount point differs), and repoint the snippet's `src`.
The `data-domain` attribute never changes — that is how sites are identified, independently of
where the instance runs.

The full procedure, including the nightly cron entry, the retention/`VACUUM` interaction, and
restoring, is in [SELF-HOSTING.md § Backups](SELF-HOSTING.md#backups) and
[§ Moving to another instance](SELF-HOSTING.md#moving-to-another-instance).

One caveat specific to this document's advice: if Credible lives on the same machine as your
site, that machine dying takes both with it. Ship the backups somewhere else — `restic`,
`rclone`, `rsync`, anything — and test a restore before you need one.
