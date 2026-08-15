<div align="center">

# Credible

**Simple, privacy-first web analytics. Yours, for free.**

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Tests](https://github.com/maixmeduret/credible/actions/workflows/ci.yml/badge.svg)](https://github.com/maixmeduret/credible/actions/workflows/ci.yml)

[Quickstart](#60-second-quickstart) · [AI setup](docs/AI-SETUP.md) · [Where to host](docs/WHERE-TO-HOST.md) · [Tracking](docs/TRACKING.md) · [API](docs/API.md) · [Self-hosting](docs/SELF-HOSTING.md) · [Privacy](docs/PRIVACY.md) · [Comparison](docs/COMPARISON.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

Credible is a web analytics tool you run yourself. It answers the questions you actually
have — how many people came, where from, what they read, what they did — without cookies,
without fingerprinting, and without storing anything about the people who visit your site.
It is a single Node.js process with **zero npm dependencies** and a **single SQLite file**
for storage: no Postgres, no ClickHouse, no Redis, no container orchestration. Clone it,
run one command, paste one script tag. Every feature is in the box, forever, for free.

## Why Credible

Google Analytics and Plausible are the two tools most people weigh against each other.
Plausible is excellent, genuinely open source, and the direct inspiration for this project —
if you want a hosted, supported, commercially backed product, go pay them; it is worth it.
Credible exists for a narrower case: you want to *own* the whole thing, on your own box, with
as little machinery as possible, and you do not want a feature matrix with a price attached.

| | **Credible** | **Google Analytics 4** | **Plausible Cloud** |
|---|---|---|---|
| Price | Free, self-hosted only | Free (you pay in data) | Paid, from ~$9/mo by volume |
| Open source | Yes, AGPL-3.0 | No | Yes, AGPL-3.0 |
| Cookies / consent banner | None required | Required in the EU | None required |
| Personal data stored | None | Substantial | None |
| Script size | 4.5 KB gzipped | ~50 KB+ | ~1 KB gzipped |
| Where the data lives | Your disk | Google's | Plausible's EU servers |
| Setup | One Node process + a file | Tag manager + config | Signup |
| Self-host stack | Nothing but Node ≥ 22.13 | n/a | Postgres + ClickHouse + Docker Compose |
| Data sampling | Never | Above thresholds | Never |
| Funnels, revenue, custom properties | Included | Included | Included on higher tiers |
| Data ownership | Total | None | Yours, on their infra |

**The honest summary.** Against Google Analytics the argument is privacy, simplicity, and
ownership. Against Plausible the argument is much narrower: their self-hosted edition is a
Docker Compose stack with Postgres and ClickHouse behind it, which is the right call at their
scale and overkill at yours. Credible is one process and one file you can back up with `cp`.
If you outgrow that — and [we tell you exactly when](docs/ARCHITECTURE.md#scaling-notes) —
Plausible or Matomo is a good place to land.

## 60-second quickstart

```bash
git clone https://github.com/maixmeduret/credible.git
cd credible
node bin/credible.js serve
```

That is the whole install. There is no `npm install` step, because there is nothing to
install. Credible starts on **http://localhost:8000**, creates `./data/credible.db`, and
prints a one-time link in the terminal to create the first account.

> **Requirement:** Node.js **22.13 or newer** (or 24 / 26). Storage uses the built-in
> `node:sqlite` module, which landed in 22.5 but only stopped requiring the
> `--experimental-sqlite` flag in 22.13. On 22.5–22.12, start it with
> `node --experimental-sqlite bin/credible.js serve`. Check yours with `node --version`.

Then add your site in the dashboard and drop this in your page's `<head>`:

```html
<script defer data-domain="yourdomain.com" src="https://YOUR-INSTANCE/js/cr.js"></script>
```

Every option on that tag — SPA routing, path exclusions, outbound links, custom
events, revenue — is documented in **[docs/TRACKING.md](docs/TRACKING.md)**.

Numbers appear immediately. Want to see the dashboard populated before you wire up a real
site? `node bin/credible.js seed` fills it with realistic demo traffic.

## Let an AI assistant set it up

Credible is built to be driven by an agent, not just by a human clicking a
dashboard. One command hosts it, creates the account, and puts the snippet in
your codebase:

```bash
node bin/credible.js up --email you@example.com --domain yourdomain.com --site-path .
```

```
① Hosting        ✓ running at http://localhost:8395
② Account        ✓ yourdomain.com · dashboard http://localhost:8395/yourdomain.com
③ Snippet        ✓ next-app: inserted app/layout.tsx
④ Done           api key cred_…   ← shown once
```

It installs a service that survives a reboot (launchd on macOS, systemd on
Linux), and picks a hosting target for you — run `credible deploy --detect` to
see what it would choose. `--target fly` gives a permanent public HTTPS URL and
refuses to create anything remote without `--yes`; `--target tunnel` gives a
public HTTPS URL in seconds with no account at all, at the cost of an ephemeral
hostname. When something is off, `credible doctor` names it and attaches the fix.

Under the hood it is all HTTP, so an agent can drive each step on its own. One
call takes an instance from nothing to ready-to-install:

```bash
curl -X POST https://YOUR-INSTANCE/api/v1/provision \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","domain":"yourdomain.com","timezone":"Europe/Paris"}'
```

It returns the account, an **API key that authenticates the entire management
API** (sites, goals, funnels, shared links, stats), and the exact snippet to
install. The same thing locally: `node bin/credible.js provision --email … --domain … --json`.

Then let it patch your codebase — it detects Next.js, Astro, Nuxt, SvelteKit,
Vite, Hugo, Jekyll, Rails, Django, Laravel, WordPress themes and plain HTML:

```bash
node bin/credible.js install --domain yourdomain.com --url https://YOUR-INSTANCE --dry-run
```

For an assistant that will keep answering questions about your traffic, register
the **[MCP server](mcp/README.md)** — twelve tools covering provisioning,
installation, verification and every stat:

```bash
claude mcp add credible --env CREDIBLE_URL=https://YOUR-INSTANCE -- node /path/to/credible/mcp/server.js
```

Every instance also serves **`/llms.txt`**, a short brief with its own URLs baked
in that you can hand to any model. The full runbook is in
**[docs/AI-SETUP.md](docs/AI-SETUP.md)**.

## Features

Everything below ships in the box. There is no paid tier to unlock.

**Core metrics** — unique visitors, total visits, pageviews, views per visit, bounce rate,
average visit duration, and a live count of visitors on the site right now.

**Trends** — a time series graph over any period, with comparison against the previous
period or the same period last year.

**Acquisition** — channels, referrer sources, and full UTM campaign breakdown
(`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`).

**Content** — top pages, entry pages, and exit pages.

**Geography** — countries, regions, and cities, on a world map.

**Technology** — browsers, operating systems, and device types.

**Conversions** — goals with conversion rates, custom event properties, multi-step funnels,
and revenue tracking per goal.

**Slicing** — filters on every dimension above, combinable, and reflected in the URL so a
view can be bookmarked and shared.

**Sharing and integration** — public shared dashboards (optionally password protected), a
Stats API for pulling numbers into your own tools, and an events API for server-side tracking.

## Privacy

Credible is designed so that there is no personal data to leak, subpoena, or sell.

- **No cookies. No `localStorage`. No fingerprinting. No cross-site tracking.** The tracker
  never writes to the visitor's device, which is why you do not need a consent banner.
- **Raw IP addresses are never written to disk.** An IP is used in memory, for the length of
  one request, to derive a country and a hash, then discarded.
- **Visitors are counted with a rotating hash.** The visitor ID is
  `hash(daily_salt + site + ip + user_agent)`, truncated. The salt rotates every day and
  **all salts are deleted after 48 hours**, at which point the hashes are permanently
  unlinkable — even by you, even with the database in hand. The same person visiting on two
  consecutive days is two different IDs, and there is no key that could ever join them.
- **GDPR, CCPA and PECR compliant**, with no cookie banner required.
- **The data is yours**, on your disk, in a file you can read, export, back up, or delete.

The full explanation — including a worked example of the hash, exactly what a stored row
looks like, the legal basis, and a DPA/GDPR FAQ — is in **[docs/PRIVACY.md](docs/PRIVACY.md)**.

## Deployment

Credible is one process listening on one port. Anything that can run Node can
host it — and the best place is usually **the machine that already serves your
site**. Mounted under a path of your own domain, the tracker becomes first-party:

```bash
credible proxy-config --domain yourdomain.com --server nginx --mode subpath
```

That prints the exact proxy block (Caddy, nginx, Apache, Traefik or HAProxy) and
the environment variables to give the service, so the script is served from
`https://yourdomain.com/stats/js/cr.js` on your own certificate — no
cross-origin request, and no separate hostname for a blocklist to match. Which
setups can do this, and what to do when yours cannot, is in
**[docs/WHERE-TO-HOST.md](docs/WHERE-TO-HOST.md)**.

**Docker**

```bash
docker compose up -d
```

**Fly.io**

```bash
fly launch --copy-config --no-deploy
fly volumes create credible_data --size 1
fly deploy
```

**VPS with systemd, behind Caddy or nginx** — a unit file, real reverse-proxy config
blocks (including the headers `CREDIBLE_TRUST_PROXY` needs), TLS, backups and upgrades are
all in **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

**Raspberry Pi** — genuinely fine. A Pi 4 with an SSD handles a few million events a month
without complaint; the process idles in tens of megabytes of RAM. Install Node 22+ from
NodeSource, then follow the systemd instructions.

### Configuration

Everything is environment variables — there is no config file to manage.

| Variable | Default | Purpose |
|---|---|---|
| `CREDIBLE_PORT` | `8000` | Port to listen on |
| `CREDIBLE_HOST` | `0.0.0.0` | Bind address |
| `CREDIBLE_DATA_DIR` | `./data` | Directory for the database |
| `CREDIBLE_DATABASE` | `$DATA_DIR/credible.db` | Explicit database path |
| `CREDIBLE_BASE_URL` | *(guessed)* | Public origin, used in snippets and shared links |
| `CREDIBLE_BASE_PATH` | *(none)* | Mount under a path, e.g. `/stats`, to serve it from your site's own domain |
| `CREDIBLE_TRUST_PROXY` | `false` | Honour `X-Forwarded-For` — enable behind a proxy |
| `CREDIBLE_SESSION_TTL` | `2592000` | Dashboard login lifetime, seconds |
| `CREDIBLE_SECURE_COOKIES` | `false` | Mark the session cookie `Secure` (set behind HTTPS) |
| `CREDIBLE_OPEN_REGISTRATION` | `true` | Allow new signups; set `false` to lock the instance |
| `CREDIBLE_INACTIVITY_TIMEOUT` | `1800` | Seconds of silence that end a visit |
| `CREDIBLE_RATE_LIMIT` | `600` | Ingest events per minute per IP (`0` disables) |
| `CREDIBLE_RETENTION_DAYS` | `0` | Delete events older than N days (`0` keeps forever) |
| `CREDIBLE_LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

The complete list, including the tuning and geo-database settings, is in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#configuration-reference).

## Command line

```bash
credible up                     # host it, provision, install the snippet — everything
                                #   --email … --domain … [--target …] [--site-path .]
credible deploy                 # stand up a persistent instance
                                #   [--target auto|local|tunnel|docker|fly] [--detect] [--yes]
credible doctor                 # check an instance is usable, and say what to fix
                                #   [--url …] [--domain …] [--api-key …] [--json]
credible serve                  # start the server (default command)
credible provision              # account + site + API key in one command
                                #   --email … [--domain …] [--timezone …] [--json]
credible install                # insert the snippet into a website's source tree
                                #   --domain … [--url …] [--path .] [--dry-run] [--json]
credible seed [domain]          # fill the database with demo traffic
                                #   [--days 60] [--visitors 220]
credible user:add <email>       # create a dashboard user
                                #   [--password …] [--name …] [--api-key]
credible site:add <domain>      # register a site
                                #   [--email owner@example.com] [--timezone Europe/Paris]
credible site:list              # list tracked sites
credible export <domain>        # dump a site's events as CSV to stdout  [--days 30]
credible version                # print the version
credible help                   # the same list, from the CLI
```

Run them as `node bin/credible.js <command>` from a clone, or as `credible <command>` if you
installed it globally.

## Stats API

Every number on the dashboard is available over HTTP, authenticated with a Bearer token you
create in the dashboard. Point Grafana at it, drop live visitor counts into your own site,
or pull a weekly summary into a script:

```bash
curl -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  "https://YOUR-INSTANCE/api/v1/stats/aggregate?site_id=yourdomain.com&period=30d&metrics=visitors,pageviews,bounce_rate"
```

```json
{
  "results": {
    "visitors":    { "value": 18342 },
    "pageviews":   { "value": 41209 },
    "bounce_rate": { "value": 58 }
  }
}
```

Alongside `aggregate` there are `timeseries`, `breakdown`, and `realtime/visitors`. There is
also an events API (`POST /api/v1/events`), so you can record conversions from your backend —
a completed payment, a signup confirmed by webhook — without trusting the browser to report
them. Every endpoint, metric, dimension and filter operator is in
**[docs/API.md](docs/API.md)**.

## Roadmap

Not built yet, in rough order of interest. Opinions welcome in the issues:

- Scheduled email and RSS summary reports
- Importers for Google Analytics and Plausible exports
- An optional columnar backend (DuckDB or ClickHouse) for instances that outgrow SQLite
- More deployment recipes, and an ARM container image

## Contributing

Contributions are very welcome, especially bug reports from real deployments. The rules are
short: ESM only, zero dependencies, comments in English, and tests for anything with logic in
it. See **[CONTRIBUTING.md](CONTRIBUTING.md)** to get set up, and
**[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** for how we treat each other. Security issues go
to the process in **[SECURITY.md](SECURITY.md)**, not the public tracker.

```bash
node --test              # run the test suite
node tracker/build.js    # rebuild public/js/cr.js after editing the tracker
```

## License

Credible is licensed under the **GNU Affero General Public License v3.0 or later**.

Copyright (C) 2026 Credible contributors.

In plain terms: you may use, modify and self-host it freely, including commercially. If you
modify it and offer it to other people over a network, you must publish your changes under
the same license. That is deliberate — it is the same choice Plausible made, and it keeps
this project open for good rather than becoming the free tier of somebody's closed SaaS.

Credible is not affiliated with Plausible Insights OÜ, Google LLC, or any other product
mentioned in this repository.
