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
  -- node /path/to/credible/mcp/server.js
```

Swap the path for wherever you cloned the repo, and `CREDIBLE_URL` for your instance's origin.

**On an instance you have not set up yet, drop the `--env CREDIBLE_API_KEY=…` flag** — there is no
key to give it. `credible_provision` creates the account, returns a key, and remembers it for the
rest of the session:

```bash
claude mcp add credible \
  --env CREDIBLE_URL=http://localhost:8000 \
  -- node /path/to/credible/mcp/server.js
```

Check it registered with `claude mcp list`, and see the tools in a session with `/mcp`.

### Any other MCP client (Claude Desktop, Cursor, Zed, …)

Add this to the client's `mcpServers` config file:

```json
{
  "mcpServers": {
    "credible": {
      "command": "node",
      "args": ["/path/to/credible/mcp/server.js"],
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

Twenty-three of them. `credible_help` prints the same map at runtime, which is what an assistant
handed this server mid-conversation should call first.

### Set up and configure

| Tool | What it does | Required arguments |
|---|---|---|
| `credible_help` | A map of every tool, grouped by the question it answers, plus which instance this server points at. Makes no network request. | — |
| `credible_provision` | **The first call on a fresh instance.** Creates the account if there is none, creates the site, returns the API key, the generated password and the install snippet. The key is remembered for the rest of the session. | `email` |
| `credible_list_sites` | Every site the key can see, with live visitor counts. | — |
| `credible_add_site` | Start tracking another domain on an instance that is already set up. Returns the snippet. | `domain` |
| `credible_get_snippet` | The exact `<script>` tag for a site, plus where it goes and how to verify. | `domain` |
| `credible_verify_install` | *"Is this site receiving data yet?"* — checks realtime and history, reports when the first event arrived, and returns a checklist when nothing has. Call it after editing the site's code. | `domain` |
| `credible_configure_site` | Read or change timezone, currency, excluded paths, excluded IPs, excluded countries, the hostname allow-list and the bot filtering level. With only `domain`, it reads. Pass a setting as an empty string to clear it; the four list settings take either a comma-separated string or an array of strings. | `domain` |
| `credible_import_status` | Historical imports for a site and how far along each is. | `domain` |

### Read the numbers

| Tool | What it does | Required arguments |
|---|---|---|
| `credible_get_stats` | Headline metrics for a period — visitors, visits, pageviews, views/visit, bounce rate, duration, revenue — plus top sources, pages, countries, goals, and any annotations that fall inside the period. Supports comparison. | `domain` |
| `credible_compare_periods` | The same query over two arbitrary periods, side by side, with the change on every metric and a sentence to read aloud. | `domain`, `compare_period` |
| `credible_breakdown` | Rank traffic by any dimension: `visit:source`, `event:page`, `visit:country`, `event:goal`, `event:props:<name>`, … | `domain`, `dimension` |
| `credible_realtime` | Who is on the site right now and what they are reading. | `domain` |
| `credible_journey` | Path exploration — the routes visitors take between pages, anchored with `start_page` and/or `end_page`. | `domain` |
| `credible_consolidated` | Every site on the instance in one rollup for a period. | — |

### Narrow and explain them

| Tool | What it does | Required arguments |
|---|---|---|
| `credible_list_segments` | Saved segments on a site, with their filters written out in prose. | `domain` |
| `credible_create_segment` | Name a set of filters so it can be reused in one argument. `scope: "site"` shares it. | `domain`, `name`, `filters` |
| `credible_apply_segment` | Run the dashboard through a saved segment — by id or by name — and summarise that audience. | `domain`, `segment` |
| `credible_list_annotations` | Dated notes on the graph, for a period or for all time. | `domain` |
| `credible_add_annotation` | Record one: *"shipped the new pricing page"*. | `domain`, `date`, `text` |

### Measure and share

| Tool | What it does | Required arguments |
|---|---|---|
| `credible_create_goal` | Create a conversion goal, `event` (custom event name) or `page` (path). Returns the goal id. | `domain`, `type` |
| `credible_create_funnel` | Wire 2–8 goals into a funnel to see where people drop off. | `domain`, `name`, `goals` |
| `credible_track_event` | Record an event server-side — log a conversion the assistant just completed, with props and revenue. | `domain`, `name`, `url` |
| `credible_share_dashboard` | Public (optionally password-protected) link to a dashboard. | `domain` |

Every tool accepts `instance_url` and `api_key` on top of the arguments listed above.

Periods accepted anywhere a period is taken: `realtime`, `day`, `yesterday`, `7d`, `28d`, `30d`,
`91d`, `month`, `last_month`, `6mo`, `12mo`, `year`, `all`, `custom` (with `from` and `to`).

### Filtering

Every stats tool takes `filters`, in Credible's JSON wire format — **not** Plausible's
`visit:country==FR` string syntax, which the instance rejects with `filters must be valid JSON`:

```json
[["is", "visit:country", ["FR", "BE"]], ["contains", "event:page", ["/blog"]]]
```

`[operator, dimension, values]`; entries are ANDed, values inside one entry are ORed. Operators:
`is`, `is_not`, `contains`, `contains_not`, `matches` (a glob, not a regex), `matches_not`.

Any triple can be replaced by a branch — `["and",[…]]`, `["or",[…]]`, `["not",<node>]`,
`["has_done",<node>]`, `["has_not_done",<node>]`. *Visitors from France who saw pricing but never
signed up*:

```json
[["is","visit:country",["FR"]],
 ["has_done",["is","event:page",["/pricing"]]],
 ["has_not_done",["is","event:goal",["Signup"]]]]
```

Pass filters as a JSON string or as an actual array — either is accepted, and **whatever you pass
is forwarded to the instance untouched**. This server validates no operator and no dimension, on
purpose: a form it has never heard of still reaches an instance that understands it, and an
instance that does not answers 422 in its own words rather than having half the question quietly
dropped on the way out.

`segment` sits on top: pass a saved segment's id or its exact name to any stats tool and its
filters are applied in addition to whatever you filtered by.

### When a tool says the instance cannot do it

`credible_journey`, `credible_consolidated` and `credible_import_status` need endpoints that older
instances do not serve. They report that as a readable tool error naming the endpoint, the 404, and
what to use instead — never a crash, and never a message that sends you hunting for a typo in your
own arguments.

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

The build had not been deployed yet — that is the point of checking. After the deploy and one page
load, the same call answers:

```
YES — acme.dev is receiving data.

First event   2026-08-15 21:17:54 UTC (0 seconds ago)
Latest event  2026-08-15 21:17:54 UTC (0 seconds ago)
Right now     1 visitor on the site
Today         1 visitor, 1 pageview
Dashboard     http://localhost:8000/acme.dev

Pages being viewed right now
   1. / — 1 visitor
```

Setup is done, and it was checked rather than assumed.

**5. A week later, it answers questions about the traffic.**

> **You:** How did last week go?

`credible_get_stats { "domain": "acme.dev", "period": "7d", "comparison": "previous_period" }`

```
acme.dev — 7d (2026-08-09 to 2026-08-15, Europe/Paris)

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

**6. It writes down why the numbers moved, instead of leaving the next person to guess.**

`credible_add_annotation { "domain": "acme.dev", "date": "2026-08-16", "text": "Shipped the redesigned pricing page" }`

```
Noted on acme.dev for 2026-08-16: "Shipped the redesigned pricing page"

It is drawn on the graph for any period covering that day, and credible_list_annotations returns it (annotation #1).
```

Annotations come back inside `credible_get_stats` from then on, under *What happened in this
period* — so an assistant reading the graph a month later cannot explain a spike without first
being told what caused it.

**7. And it can ask about one audience rather than everybody.**

`credible_create_segment { "domain": "acme.dev", "name": "French readers of the blog", "filters": [["is","visit:country",["FR"]],["contains","event:page",["/blog"]]], "scope": "site" }`
then `credible_apply_segment { "domain": "acme.dev", "segment": "French readers of the blog", "period": "7d" }`

```
acme.dev — 7d (2026-08-10 to 2026-08-16, Europe/Paris)

Through segment "French readers of the blog" (#1, site-wide):
  visit:country is FR
  event:page contains /blog

Visitors        11
Visits          11
Pageviews       11
Views / visit   1
Bounce rate     0%
Visit duration  0s
On site now     0

Top sources
   1. Direct — 11 visitors, 11 pageviews

Top pages
   1. /blog/launch — 11 visitors, 11 pageviews
…
```

The segment is saved on the site, so the dashboard shows the same one-click filter to whoever opens
it next. Naming an audience once, in the owner's words, is worth more than rebuilding the filter
every time somebody asks.

**8. Two periods, side by side, in a shape you can read out loud.**

`credible_compare_periods { "domain": "acme.dev", "period": "7d", "compare_period": "28d" }`

```
acme.dev — 7d compared with 28d

63 visitors over 7d, down 62% on the 168 visitors over 28d.

                7d    28d  Change
Visitors        63    168  -62%
Visits          63    168  -62%
Pageviews       159   420  -62%
Views / visit   2.52  2.5  +1%
Bounce rate     24%   25%  -1 pts
Visit duration  0s    0s   no change

7d   2026-08-10 to 2026-08-16 (Europe/Paris)
28d  2026-07-20 to 2026-08-16 (Europe/Paris)

Change reads 7d against 28d. Full dashboard: http://localhost:8000/acme.dev
```

From there the assistant can keep going without you: `credible_create_goal` for a signup event,
`credible_create_funnel` to see where people drop out, `credible_journey` to see the routes between
two pages, `credible_configure_site` to stop counting your own office, `credible_share_dashboard`
to send a client a read-only link, `credible_track_event` to log a conversion it just processed.

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

**The tool descriptions are the documentation.** A model never reads this file; it reads the
`description` of each tool and of each argument, and nothing else. They are written to say *when*
to reach for a tool, not only what it does — that is why they are long, and why changing one is a
change to the product rather than to a comment.

**Nothing is destructive.** No tool deletes a site, a goal, a segment or an annotation. Creating,
reading and configuring is the whole surface, and `credible_configure_site` deliberately cannot
make a dashboard public — `credible_share_dashboard` does that, so publishing is always something
someone asked for by name.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no Credible instance is running at http://localhost:8000` | Nothing is listening there. Start one with `node bin/credible.js serve`, or fix `CREDIBLE_URL`. |
| `401 … The API key was missing or rejected` | No key in the environment and no `credible_provision` yet this session, or the key was deleted. |
| `403 … registration is closed` | The instance has `CREDIBLE_OPEN_REGISTRATION=false` and already has an account. Pass an existing `api_key` to `credible_provision`. |
| `409 … An account already exists for this email` | Pass that account's `password`, or its `api_key`, to add a site to it. |
| `404 Site not found` | The domain is not tracked by this account. `credible_list_sites` shows what the key can see. |
| `this Credible instance does not provide …` | The endpoint behind that tool is not in the version running here. Upgrade the instance; the message names what to use meanwhile. |
| `filters must be valid JSON` | Plausible's `visit:source==Google` syntax was used. Credible takes the JSON form: `[["is","visit:source",["Google"]]]`. |
| `Segment not found` | The segment id belongs to another site, or was deleted. `credible_list_segments` shows what exists — and a segment can be given by name instead. |
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
codes, a genuine provisioning round-trip against a Credible booted in the test process, every tool
against that instance — segments applied by id and by name, annotations round-tripped through the
site's own timezone, shields read back out of the database to prove they were written rather than
echoed — the filter-passthrough contract, and both failure paths: an unreachable instance, and an
endpoint the instance does not serve.

`TOOLS_AWAITING_AN_ENDPOINT` in `test/mcp.test.js` is the list of endpoints this server calls that
Credible does not answer yet. Each entry asserts a readable tool error today; when the endpoint
lands, that assertion fails loudly rather than passing for the wrong reason, which is the point.
