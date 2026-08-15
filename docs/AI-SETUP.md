# Setting up Credible, for an AI assistant

You have been asked to *"set up analytics on my site"*. This is the whole procedure, in
order, with no dashboard clicking anywhere in it. Work top to bottom; every command here is
copy-pasteable and every response body was captured from a real instance.

If an instance already exists, fetch **`https://INSTANCE/llms.txt`** first — it is a short
brief with that instance's real origin baked into every example.

Notation: replace `INSTANCE` with the origin of the Credible server
(`https://stats.example.com`) and `example.com` with the site being measured. Values shown in
responses are real output from a throwaway instance — yours will differ.

---

## 1. Decide where the instance runs

Credible is one Node process and one SQLite file. Ask the user which of these they want; do
not pick for them if a hosting bill or their own machine is involved.

**A. Their machine or a VPS** — no build step, no `npm install`, nothing to install:

```bash
git clone https://github.com/maixmeduret/credible.git && cd credible && node bin/credible.js serve
```

Serves on `http://localhost:8000` and creates `./data/credible.db`. Needs **Node ≥ 22.13**
(`node --version`). For a real deployment behind a domain, set `CREDIBLE_BASE_URL`,
`CREDIBLE_TRUST_PROXY=true` and `CREDIBLE_SECURE_COOKIES=true`, and follow
[SELF-HOSTING.md](SELF-HOSTING.md) for the systemd unit and the Caddy/nginx blocks.

**B. Docker** — `docker-compose.yml` is in the repo, one service, one volume:

```bash
git clone https://github.com/maixmeduret/credible.git && cd credible && docker compose up -d
```

Edit `CREDIBLE_BASE_URL` in `docker-compose.yml` to the URL people will actually visit.

**C. Fly.io** — `fly.toml` is in the repo and already sets the volume, the health check and
the proxy variables:

```bash
git clone https://github.com/maixmeduret/credible.git && cd credible
fly launch --copy-config --no-deploy && fly volumes create credible_data --size 1 && fly deploy
```

Set `CREDIBLE_BASE_URL` in `fly.toml` to the real hostname before deploying. Do not scale
past one machine — SQLite needs one local disk.

Confirm the instance is alive before going further:

```bash
curl -s https://INSTANCE/api/health
```

```json
{"status":"ok","version":"0.1.0","events":0,"uptime":2}
```

---

## 2. Provision in one call

One request creates the account, the API key and the site. Nothing else is needed.

```bash
curl -s -X POST https://INSTANCE/api/v1/provision \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","domain":"example.com","timezone":"Europe/Paris","currency":"EUR"}'
```

Exact 201 response:

```json
{
  "user": { "id": 1, "email": "you@example.com", "name": "" },
  "password": "vaNTa2DFftCDdpc6",
  "api_key": "cred_sfUWWIBL1DjWOu21uP3MLndPN1KmTruskDAe2gRFJqw",
  "site": { "domain": "example.com", "timezone": "Europe/Paris", "public": false, "currency": "EUR", "created_at": 1786827996 },
  "snippet": "<script defer data-domain=\"example.com\" src=\"https://INSTANCE/js/cr.js\"></script>",
  "instance_url": "https://INSTANCE",
  "dashboard_url": "https://INSTANCE/example.com",
  "created": { "user": true, "site": true },
  "next_steps": [
    "Put the snippet in the <head> of every page you want to measure.",
    "Confirm it works: GET https://INSTANCE/api/stats/example.com/realtime",
    "Keep api_key secret — it can read and change everything in this account."
  ]
}
```

Body fields: `email` (required unless you send a Bearer key), `password` (generated when
absent), `name`, `domain` (omit to create only the account — `site` and `snippet` come back
`null`), `timezone` (IANA, default `UTC`), `currency` (3 letters, default `EUR`), `key_name`.

**Adding a site to an account that already exists** — send the existing key instead of a
password; `password` comes back `null`, `created.user` is `false`, and a *fresh* `api_key` is
minted for the call (the key you sent keeps working — you do not have to switch to the new one):

```bash
curl -s -X POST https://INSTANCE/api/v1/provision \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  -H 'content-type: application/json' -d '{"domain":"blog.example.com"}'
```

The same thing on the machine hosting the instance, without HTTP:

```bash
node bin/credible.js provision --email you@example.com --domain example.com \
  --timezone Europe/Paris --json
```

`--json` prints the same payload (its `site` object carries `domain`, `timezone` and
`currency`); without the flag you get the same values as readable lines. Other flags:
`--password`, `--name`, `--currency`, `--key-name`. This command talks to the local database
directly, so run it from the clone with the same `CREDIBLE_DATA_DIR` the server uses, and it
takes its origin from `CREDIBLE_BASE_URL`. It cannot be reached over the network — use the
HTTP endpoint for that.

### What to do with what comes back

1. **`api_key` — store it where the user controls it, not in your context and not in the
   repo.** Write it to a gitignored `.env` (`CREDIBLE_API_KEY=cred_…`), or tell the user to
   paste it into their password manager. Check `.gitignore` covers the file before writing.
   It is shown once; only its hash is stored.
2. **`password` — show it to the user once, in your reply, and say it is not recoverable.**
   Never write it to a file in the repository. It is `null` when they supplied their own.
3. Keep `snippet` and `dashboard_url` for the next two steps.

### Errors

| Status | Body | What it means |
| --- | --- | --- |
| 403 | `Registration is closed on this instance` | An account exists, `CREDIBLE_OPEN_REGISTRATION=false`, and no valid Bearer key was sent. Ask the user for a key, or for shell access to run the CLI. |
| 409 | `An account already exists for this email…` | Send that account's `password`, or a Bearer key. |
| 409 | `That domain is already tracked by another account` | Someone else owns it on this instance. |
| 422 | `Enter a valid email address` / `Enter a valid domain, for example example.com` | Fix the input. |
| 429 | `Too many attempts, try again in a minute` | 30 requests/minute/IP on this endpoint. |

---

## 3. Install the snippet

The tag, exactly as returned in `snippet`:

```html
<script defer data-domain="example.com" src="https://INSTANCE/js/cr.js"></script>
```

It goes in the `<head>` of every page (end of `<body>` also works). `data-domain` must match
the site domain; the `src` origin is where events are sent. Do it automatically — from the
Credible clone, pointed at the user's project:

```bash
node bin/credible.js install --domain example.com --url https://INSTANCE \
  --path /path/to/their/project --dry-run
```

```
Project    next-app (high confidence) — found app/layout.tsx
inserted   app/layout.tsx
           --- a/app/layout.tsx
           +++ b/app/layout.tsx
           @@ -4,6 +4,7 @@
                  <head>
                    <meta charSet="utf-8" />
                    <title>Demo</title>
           +        <script defer data-domain="example.com" src="https://INSTANCE/js/cr.js" />
                  </head>
```

`--dry-run` writes nothing — **always run it first and show the user the diff**. Drop the flag
to apply. Running it twice reports `unchanged`, so it is safe to re-run. This command needs no
database and no running server; `--url` defaults to `CREDIBLE_BASE_URL`.

Other flags: `--file <path>` to patch one named file instead of trusting detection,
`--replace-plausible` to swap an existing Plausible tag for this one, `--json` for
machine-readable output (`{root, snippet, detected, result, dry_run}`), `--path` (default: the
current directory).

Detection covers these, and the table is also where to put the tag by hand:

| Detected | File it patches | Note |
| --- | --- | --- |
| `next-app` | `app/layout.tsx` (or `src/app/…`) | Inside `<head>`; falls back to a `next/script` component with `strategy="afterInteractive"` if the layout has no `<head>` |
| `next-pages` | `pages/_document.tsx` | Inside `<Head>` in `Document` |
| `astro` | every layout under `src/layouts` with a `<head>` | |
| `nuxt` | `nuxt.config.ts` | Registered as `app.head.script`, not as a template edit |
| `sveltekit` | `src/app.html` | Inside `<head>`, next to `%sveltekit.head%` |
| `remix` | `app/root.tsx` | |
| `gatsby` | `src/html.js` | Run `cp .cache/default-html.js src/html.js` first if absent |
| `eleventy` | layouts under `_includes` with a `<head>` | |
| `hugo` | `layouts/partials/head.html` or `layouts/_default/baseof.html` | A theme shipping its own `baseof.html` needs the tag there too |
| `jekyll` | `_includes/head.html` or `_layouts/default.html` | |
| `rails` | `app/views/layouts/application.html.erb` | |
| `django` | `templates/base.html` | The template every page extends |
| `laravel` | `resources/views/layouts/app.blade.php` | |
| `wordpress-theme` | `header.php`, before `</head>` | Direct theme edits are lost on update — prefer a child theme or a `wp_head` hook in `functions.php` |
| `vite` | `index.html` | |
| `html` | every `.html` file with a `<head>` | Prefer a shared header include so the tag lives in one place |

If it reports `No place to put the snippet was found`, name the template yourself with
`--file src/layouts/Base.astro` (repeat the command per file), or paste the tag in by hand.

Useful attributes on the tag (all of them in [TRACKING.md](TRACKING.md#2-script-tag-attributes)):

- `data-hash` — the site routes with `#/…`
- `data-exclude="/admin/*, /preview/**"` — never send those paths
- `data-api="https://example.com/api/event"` — proxy the beacon through the user's own domain
  to survive content blockers
- `data-track-localhost` — count `localhost` traffic (off by default)
- `data-debug` — print in the console why an event was dropped

Deploy the site after installing. Nothing is recorded until the tag is live.

---

## 4. Verify data is arriving

Ask the user to load a page on the deployed site, then:

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  https://INSTANCE/api/stats/example.com/realtime
```

```json
{"visitors":1,"pages":[{"name":"/","visitors":1}]}
```

("Realtime" is the last 5 minutes.) With the MCP server connected, `credible_verify_install`
does the same check and reports the likely cause when the count is zero — see
[mcp/README.md](../mcp/README.md).

**If it says 0 visitors**, in the order worth checking:

1. **The page was on localhost.** Local hostnames are never counted without
   `data-track-localhost`. Test on the deployed site.
2. **A content blocker ate the request.** Check the Network tab for `/js/cr.js` and
   `/api/event`. Fix: proxy both through the user's own domain with `data-api`.
3. **A reverse proxy without `CREDIBLE_TRUST_PROXY=true`.** Everyone collapses into one
   visitor, and the server logs a warning saying exactly this once.
4. **`data-domain` does not match the site.** `www.` and case are normalised away; anything
   else is not. Compare with `GET /api/sites`.
5. **The path is excluded**, or the visitor's IP is in `excluded_ips`.

Send a test event yourself — this is the fastest way to get a *reason* rather than a silence:

```bash
curl -s -X POST https://INSTANCE/api/v1/events \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"n":"pageview","d":"example.com","u":"https://example.com/",
       "user_agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"}'
```

```
202  {"status":"ok","events":1}
200  {"status":"ignored","reason":"unknown domain"}
```

**You must send an explicit browser-like `user_agent`.** Bot filtering drops curl's own
User-Agent, and the answer is `{"status":"ignored","reason":"bot"}` — which looks like a
broken install but is not one.

---

## 5. Configure the rest, without the UI

Every call below takes `Authorization: Bearer $CREDIBLE_API_KEY`. Nothing here needs the
dashboard.

```bash
# Everything about a site: settings, goals, funnels, shared_links, members, snippet,
# suggested_goals (event names already arriving) and data_range (first/last event)
curl -s -H "Authorization: Bearer $CREDIBLE_API_KEY" https://INSTANCE/api/sites/example.com

# Timezone, excluded paths and IPs, currency  (PATCH, any subset)
curl -s -X PATCH https://INSTANCE/api/sites/example.com \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"timezone":"Europe/Paris","excluded_paths":"/admin/**, /preview/*","excluded_ips":"203.0.113.7"}'

# A goal on a custom event  ->  {"goal":{"id":1,"site_id":1,"type":"event","event_name":"Signup",…}}
curl -s -X POST https://INSTANCE/api/sites/example.com/goals \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"event","event_name":"Signup"}'

# A goal on a page  (page_path must start with /, a trailing * is allowed)
curl -s -X POST https://INSTANCE/api/sites/example.com/goals \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"page","page_path":"/thanks","display_name":"Thank you"}'

# A funnel: 2 to 8 goal ids, in order
curl -s -X POST https://INSTANCE/api/sites/example.com/funnels \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Signup flow","goals":[1,2]}'

# A shared read-only dashboard  ->  {"slug":"bEaT…","url":"https://INSTANCE/share/example.com?auth=bEaT…"}
curl -s -X POST https://INSTANCE/api/sites/example.com/shared-links \
  -H "Authorization: Bearer $CREDIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Public dashboard","password":"optional"}'

# Delete a goal / a site
curl -s -X DELETE https://INSTANCE/api/sites/example.com/goals/1 -H "Authorization: Bearer $CREDIBLE_API_KEY"
curl -s -X DELETE https://INSTANCE/api/sites/example.com        -H "Authorization: Bearer $CREDIBLE_API_KEY"
```

Goals are evaluated **at query time** against stored events, so a goal created today also
counts matching events from before it existed. What is not retroactive is the *event*: if the
site never sent `Signup`, no goal invents one — the tracker has to be calling
`credible('Signup')`, or your backend has to be posting it to `/api/v1/events`. To see what
the site already sends, read `suggested_goals` from `GET /api/sites/example.com`.

`PATCH {"public": true}` makes the dashboard readable by **anyone with the URL, with no
password**. Ask the user before doing that — a shared link is the safer default.

---

## 6. Answer questions about the traffic afterwards

All of these take `Authorization: Bearer $CREDIBLE_API_KEY`. Periods: `realtime`, `day`,
`yesterday`, `7d`, `28d`, `30d`, `91d`, `month`, `last_month`, `6mo`, `12mo`, `year`, `all`,
`custom` (with `from`/`to` as `YYYY-MM-DD`).

**"How many visitors this week?"**

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  "https://INSTANCE/api/v1/stats/aggregate?site_id=example.com&period=7d&metrics=visitors,pageviews,bounce_rate"
```

```json
{"results":{"visitors":{"value":304},"pageviews":{"value":655},"bounce_rate":{"value":67}}}
```

Add `&comparison=previous_period` to get a `change` percentage alongside each value, or use
`/api/v1/stats/timeseries?…&period=7d&metrics=visitors` for a day-by-day list.

**"Where did they come from?"**

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  "https://INSTANCE/api/v1/stats/breakdown?site_id=example.com&property=visit:source&period=7d&limit=5"
```

```json
{"results":[
  {"visit:source":"Direct","name":"Direct","visitors":153,"visits":186,"pageviews":340,"events":717},
  {"visit:source":"Google","name":"Google","visitors":55,"visits":56,"pageviews":84,"events":183},
  {"visit:source":"LinkedIn","name":"LinkedIn","visitors":23,"visits":23,"pageviews":31,"events":66}
]}
```

Swap `property` for `visit:channel` (Organic Search, Referral, Email…), `visit:referrer`,
`visit:utm_campaign`, or `visit:country`.

**"Which page converts best?"** — break entry pages down with a goal filter:

```bash
curl -s -G -H "Authorization: Bearer $CREDIBLE_API_KEY" \
  https://INSTANCE/api/v1/stats/breakdown \
  --data-urlencode 'site_id=example.com' \
  --data-urlencode 'property=visit:entry_page' \
  --data-urlencode 'period=30d' \
  --data-urlencode 'filters=[["is","event:goal",["Signup"]]]'
```

```json
{"results":[
  {"visit:entry_page":"/auth/sign-up","name":"/auth/sign-up","visitors":5,"visits":5,"pageviews":6,"bounce_rate":80,"visit_duration":110},
  {"visit:entry_page":"/","name":"/","visitors":4,"visits":4,"pageviews":15,"bounce_rate":0,"visit_duration":544}
]}
```

`property=event:goal` gives every goal with its conversion rate (`cr`) and `revenue`. The
filter value must match a goal's display name. Filters are
`[[operator, dimension, [values]]]`, ANDed together — every operator, dimension and metric is
in [API.md](API.md).

Live count, no auth gymnastics: `GET /api/v1/stats/realtime/visitors?site_id=example.com`
returns a bare number.

---

## 7. MCP server, or plain curl?

Both drive the same API.

- **Use the MCP server** when you are a long-lived assistant that will keep answering
  questions about this site. It gives you typed tools instead of hand-built URLs —
  `credible_provision`, `credible_add_site`, `credible_get_snippet`,
  `credible_verify_install`, `credible_create_goal`, `credible_create_funnel`,
  `credible_share_dashboard`, `credible_get_stats`, `credible_breakdown`,
  `credible_realtime`, `credible_list_sites`, `credible_track_event` — and it holds the API
  key in its own config rather than in your context. Setup:
  **[mcp/README.md](../mcp/README.md)**.
- **Use curl** for a one-off "set this up for me": nothing to install, nothing to configure,
  and the user keeps a shell transcript of exactly what you did.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403 Registration is closed on this instance` | `CREDIBLE_OPEN_REGISTRATION=false` and no Bearer key | Get an API key from the user, or run `credible provision` on the host |
| `409 That domain is already tracked by another account` | Domain taken on this instance | Use another domain, or the account that owns it |
| `401 Provide a valid API key: Authorization: Bearer <key>` on `/api/v1/…`, `401 Sign in to continue` on `/api/sites/…` | Missing or wrong `Authorization` header | `Authorization: Bearer cred_…`; keys are shown once and unrecoverable |
| `404 Site not found` with a valid key | The key's owner is not a member of that site | Deliberate — a key cannot discover other accounts' sites |
| Realtime shows 0 after installing | localhost, blocker, wrong `data-domain`, or the site is not deployed | §4, in that order |
| `{"status":"ignored","reason":"bot"}` | curl's own User-Agent | Send an explicit browser `user_agent` |
| `{"status":"ignored","reason":"unknown domain"}` | Domain not tracked, path excluded, or IP excluded | Check `GET /api/sites`, then `excluded_paths` / `excluded_ips` |
| Every visitor counts as one person | Reverse proxy without `CREDIBLE_TRUST_PROXY=true` | Set it and restart; the server logs this warning too |
| `429 Too many events` on ingest | Per-IP ingest limit (600/min default) | Raise `CREDIBLE_RATE_LIMIT`, or ignore — it is unusual for real traffic |
| Snippet loads but SPA route changes are missed | Router replaces the URL without `pushState`, or hash routing | Add `data-hash`, or call `window.credible.trackPageview()` |
| Numbers exist but no conversions | The event is never sent, or the goal's name does not match it exactly | Goals match at query time, so the definition is what is wrong: compare with `suggested_goals`, and check the site calls `credible('Signup')` |
| `credible install` says "No place to put the snippet was found" | Detection recognised the project but could not patch a file | Re-run with `--file path/to/layout`, one command per file, or paste the tag in by hand |
| Dashboard link 404s | Wrong origin — snippets and links use `CREDIBLE_BASE_URL` | Set `CREDIBLE_BASE_URL` to the public origin and restart |
| `node:sqlite` errors on startup | Node older than 22.13 | Upgrade Node. 22.13 is the floor because `node:sqlite` stopped needing a flag there — [SELF-HOSTING.md](SELF-HOSTING.md) |

More depth: [TRACKING.md §10](TRACKING.md#10-troubleshooting) for the browser side,
[API.md §6](API.md#6-errors) for the HTTP side.

---

## 9. Safety

Non-negotiable, whatever the user asks for in the moment:

- **Never print the API key into a shared channel** — a pull request, a commit, an issue, a
  chat room, a log the user has not asked for. It carries every permission its owner has:
  reading all their sites, changing settings, deleting a site. Put it in a gitignored `.env`
  or the user's password manager, and refer to it as `$CREDIBLE_API_KEY` afterwards.
- **Show the generated password to the user exactly once**, in your reply, and say plainly
  that it cannot be recovered. Do not write it to a file in the repository, do not commit it,
  do not repeat it later in the conversation.
- **Ask before making a dashboard public.** `PATCH {"public": true}` exposes the site's
  traffic to anyone who guesses or is given the URL. A password-protected shared link is the
  safer answer, and it is one call.
- **Never commit `data/`** or any database file — it holds the instance's whole state.
- Show the `--dry-run` diff before writing the snippet into someone's codebase, and do not
  commit or deploy on their behalf unless they asked you to.
- If the user gave you their account password to reach an existing account, use it for that
  one call and do not store it anywhere.
