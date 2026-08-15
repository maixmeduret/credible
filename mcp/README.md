# Credible MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant run Credible for you —
set up the instance, install the tracking snippet into your codebase, confirm the data is flowing,
and then answer questions about your traffic.

The whole point is that nobody has to click through the dashboard to get started. You say
*"add analytics to my site"*, and the assistant calls `credible_provision`, gets back an API key and
a `<script>` tag, edits your `<head>`, calls `credible_verify_install` to check that events are
arriving, and tells you the numbers. From zero to first pageview without a browser.

Like the rest of Credible: **one file, zero dependencies**. It is a stdio JSON-RPC 2.0 server
written against Node built-ins only.

## Requirements

- Node.js ≥ 22.13
- A Credible instance to talk to — `node bin/credible.js serve` is enough, it does not need to be
  set up first. Provisioning a brand new instance is exactly what this server is for.

## Register it

### Claude Code

```bash
claude mcp add credible \
  --env CREDIBLE_URL=https://analytics.example.com \
  --env CREDIBLE_API_KEY=cred_your_key_here \
  -- node /Users/maxime/Documents/Credible/mcp/server.js
```

Swap the path for wherever you cloned the repo, and `CREDIBLE_URL` for your instance's origin.

**On an instance you have not set up yet, drop the `--env CREDIBLE_API_KEY=…` flag** — there is no
key to give it. `credible_provision` creates the account, returns a key, and remembers it for the
rest of the session:

```bash
claude mcp add credible \
  --env CREDIBLE_URL=http://localhost:8000 \
  -- node /Users/maxime/Documents/Credible/mcp/server.js
```

Check it registered with `claude mcp list`, and see the tools in a session with `/mcp`.

### Any other MCP client (Claude Desktop, Cursor, Zed, …)

Add this to the client's `mcpServers` config file:

```json
{
  "mcpServers": {
    "credible": {
      "command": "node",
      "args": ["/Users/maxime/Documents/Credible/mcp/server.js"],
      "env": {
        "CREDIBLE_URL": "http://localhost:8000",
        "CREDIBLE_API_KEY": ""
      }
    }
  }
}
```

Restart the client afterwards. For Claude Desktop the file is
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `CREDIBLE_URL` | `http://localhost:8000` | Base URL of the instance every tool talks to. |
| `CREDIBLE_API_KEY` | *(empty)* | API key used by every tool. Optional — `credible_provision` mints one. |

Every tool also takes optional `instance_url` and `api_key` arguments that override the environment
for that one call, so a single registered server can drive several instances (staging and
production, or a client's instance) without being re-registered.

## Tools

| Tool | What it does | Required arguments |
|---|---|---|
| `credible_provision` | **The first call on a fresh instance.** Creates the account if there is none, creates the site, returns the API key, the generated password and the install snippet. The key is remembered for the rest of the session. | `email` |
| `credible_list_sites` | Every site the key can see, with live visitor counts. | — |
| `credible_add_site` | Start tracking another domain on an instance that is already set up. Returns the snippet. | `domain` |
| `credible_get_snippet` | The exact `<script>` tag for a site, plus where it goes and how to verify. | `domain` |
| `credible_verify_install` | *"Is this site receiving data yet?"* — checks realtime and history, reports when the first event arrived, and returns a checklist when nothing has. Call it after editing the site's code. | `domain` |
| `credible_get_stats` | Headline metrics for a period — visitors, visits, pageviews, views/visit, bounce rate, duration, revenue — plus top sources, pages, countries and goals. Supports comparison. | `domain` |
| `credible_breakdown` | Rank traffic by any dimension: `visit:source`, `event:page`, `visit:country`, `event:goal`, `event:props:<name>`, … | `domain`, `dimension` |
| `credible_realtime` | Who is on the site right now and what they are reading. | `domain` |
| `credible_create_goal` | Create a conversion goal, `event` (custom event name) or `page` (path). Returns the goal id. | `domain`, `type` |
| `credible_create_funnel` | Wire 2–8 goals into a funnel to see where people drop off. | `domain`, `name`, `goals` |
| `credible_share_dashboard` | Public (optionally password-protected) link to a dashboard. | `domain` |
| `credible_track_event` | Record an event server-side — log a conversion the assistant just completed, with props and revenue. | `domain`, `name`, `url` |

Every tool accepts `instance_url` and `api_key` on top of the arguments listed above.

Periods accepted by `credible_get_stats` and `credible_breakdown`: `realtime`, `day`, `yesterday`,
`7d`, `28d`, `30d`, `91d`, `month`, `last_month`, `6mo`, `12mo`, `year`, `all`, `custom`
(with `from` and `to`).

## From zero to numbers — a worked transcript

What follows is real output, from a Credible instance that had never been opened.

**1. The user asks.**

> **You:** Set up analytics on my site, it's acme.dev — the code is in this repo.

**2. The assistant provisions the instance.** No account, no API key, nothing — one call.

`credible_provision { "email": "you@acme.dev", "domain": "acme.dev", "timezone": "Europe/Paris", "currency": "EUR" }`

```
Credible is ready at http://localhost:8000

Account    you@acme.dev (created)
Password   Kx7QmZP4rT2wN9vB   <- generated, shown once, save it now
API key    cred_kJ2v9QpR8sT1uW4xY7zA0bC3dE6fG9hJ   <- shown once; remembered for the rest of this session
Site       acme.dev (Europe/Paris, EUR)
Dashboard  http://localhost:8000/acme.dev

Install this snippet in the site you are tracking:

<script defer data-domain="acme.dev" src="http://localhost:8000/js/cr.js"></script>

Where it goes: inside <head>, on every page of the site (a shared layout/template is the right place).
It must be the real deployed site — a page served from localhost only reports if this Credible instance
is reachable from that browser (http://localhost:8000).
Keep data-domain exactly "acme.dev": no protocol, no www, no trailing slash.
Then load a page and call credible_verify_install with domain "acme.dev".

Next steps
  1. Put the snippet in the <head> of every page you want to measure.
  2. Confirm it works: GET http://localhost:8000/api/stats/acme.dev/realtime
  3. Keep api_key secret — it can read and change everything in this account.
```

**3. The assistant installs the snippet** — an ordinary file edit, no MCP involved. It finds the
shared layout and adds one line:

```diff
  <head>
    <meta charset="utf-8" />
    <title>Acme</title>
+   <script defer data-domain="acme.dev" src="http://localhost:8000/js/cr.js"></script>
  </head>
```

**4. It checks its work before claiming success.**

`credible_verify_install { "domain": "acme.dev" }`

```
NOT YET — acme.dev has not received a single event on http://localhost:8000.

Check, in this order:
  1. The snippet is in <head> of the page you loaded: <script defer data-domain="acme.dev" src="http://localhost:8000/js/cr.js"></script>
  2. data-domain is exactly "acme.dev" — no https://, no www., no trailing slash.
  3. The change is deployed. Editing a local file is not enough unless you loaded that local page.
  4. The browser can reach http://localhost:8000. A localhost instance is invisible to visitors elsewhere.
  5. The page was loaded by a real browser — requests with a bot or empty User-Agent are dropped on purpose.
  6. No ad blocker on the browser you tested with, and the request to /api/event returned 204.

Fix, reload a page, then call credible_verify_install again.
```

The build had not been deployed yet — that is the point of checking. After a deploy and one page
load, the same call answers:

```
YES — acme.dev is receiving data.

First event   2026-07-17 00:38:21 UTC (4 weeks ago)
Latest event  2026-08-15 21:24:37 UTC (0 seconds ago)
Right now     2 visitors on the site
Today         378 visitors, 725 pageviews
Dashboard     http://localhost:8000/acme.dev

Pages being viewed right now
   1. / — 1 visitor
   2. /auth/sign-up — 1 visitor
   3. /listings — 1 visitor
   4. /pricing — 1 visitor
```

**5. Now it can answer questions about the traffic.**

> **You:** How did last week go?

`credible_get_stats { "domain": "acme.dev", "period": "7d", "comparison": "previous_period" }`

```
acme.dev — 7d (2026-08-08 to 2026-08-15, Europe/Paris)

Visitors        1,461   (+28%)
Visits          2,029   (+37%)
Pageviews       3,440   (+28%)
Views / visit   1.7   (-6%)
Bounce rate     68%   (+5 pts)
Visit duration  3m 48s   (-9%)
Revenue         652.00 EUR
On site now     2

Top sources
   1. Direct — 773 visitors, 1,630 pageviews
   2. Google — 340 visitors, 601 pageviews
   3. LinkedIn — 127 visitors, 197 pageviews
   4. Hacker News — 89 visitors, 167 pageviews
   5. X (Twitter) — 73 visitors, 139 pageviews

Top pages
   1. / — 856 visitors, 1,222 pageviews
   2. /listings — 357 visitors, 437 pageviews
   3. /analyse-zone — 281 visitors, 310 pageviews

Top countries
   1. FR — 681 visitors, 1,539 pageviews
   2. US — 197 visitors, 506 pageviews
   3. DE — 80 visitors, 204 pageviews

Goals
   1. Visit /pricing — 197 converting visitors, 13.5% of visitors, 212 total conversions
   2. Form: Submission — 192 converting visitors, 13.1% of visitors, 211 total conversions
   3. Purchase — 8 converting visitors, 0.5% of visitors, 652.00 EUR revenue

Full dashboard: http://localhost:8000/acme.dev
```

> **Assistant:** Analytics are live on acme.dev. Last week: 1,461 visitors, up 28% on the week
> before, mostly direct and Google, with France and the US leading. `/listings` is your strongest
> page after the homepage. Bounce rate is up 5 points though — worth a look.

From there the assistant can keep going without you: `credible_create_goal` for a signup event,
`credible_create_funnel` to see where people drop out, `credible_share_dashboard` to send a client
a read-only link, `credible_track_event` to log a conversion it just processed.

## Notes

**The API key is powerful.** It can read and change everything in the account it belongs to. It is
shown exactly once by `credible_provision`; if you lose it, mint another one from the dashboard's
settings and delete the old one.

**Session memory.** After a successful `credible_provision`, the key is kept in memory for that
instance and reused by every later tool call in the same session — the model does not need to pass
it around. It is never written to disk. When the MCP server process exits, it is gone, so save it
somewhere (or put it in `CREDIBLE_API_KEY`) if you want it to survive.

**Anything can be pointed elsewhere.** `instance_url` and `api_key` on any call override the
environment, which makes "compare staging to production" a single conversation.

**Instances describe themselves.** Every Credible serves a plain-text brief for agents at
`GET /llms.txt`, with its own origin baked in — useful for assistants that can fetch a URL but
have no MCP server registered.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no Credible instance is running at http://localhost:8000` | Nothing is listening there. Start one with `node bin/credible.js serve`, or fix `CREDIBLE_URL`. |
| `401 … The API key was missing or rejected` | No key in the environment and no `credible_provision` yet this session, or the key was deleted. |
| `403 … registration is closed` | The instance has `CREDIBLE_OPEN_REGISTRATION=false` and already has an account. Pass an existing `api_key` to `credible_provision`. |
| `409 … An account already exists for this email` | Pass that account's `password`, or its `api_key`, to add a site to it. |
| `404 Site not found` | The domain is not tracked by this account. `credible_list_sites` shows what the key can see. |
| Tools do not appear in the client | Check `claude mcp list`, then run `node mcp/server.js --help` — it prints the tool list to stderr and exits. |

## Development

The server writes JSON-RPC to stdout and **nothing else** — all logging goes to stderr, because
stdout is the transport. Keep it that way.

```bash
node --test test/mcp.test.js   # protocol + tools, against a real instance on a free port
node mcp/server.js --help      # tool list and configuration, printed to stderr
```

The test suite spawns the server as a child process and drives it over stdin/stdout the way a real
client does: handshake, notification semantics, `tools/list` schema validation, JSON-RPC error
codes, a genuine provisioning round-trip against a Credible booted in the test process, and the
unreachable-instance path.
