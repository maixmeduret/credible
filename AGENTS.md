# AGENTS.md

Instructions for an AI agent working **inside this repository**.

> **Setting Credible up on somebody's website?** You are in the wrong file.
> Read **[docs/AI-SETUP.md](docs/AI-SETUP.md)** — it is the runbook for provisioning an
> instance, installing the snippet and verifying data, with no human clicking anything.

## Architecture in 20 lines

```
browser ─▶ public/js/cr.js ─▶ POST /api/event ─▶ src/ingest ─▶ SQLite ─▶ src/stats ─▶ dashboard
```

| Path | What lives there |
| --- | --- |
| `bin/credible.js` | CLI entry point and argument parsing. Every command is a key of `commands`. |
| `src/config.js` | All configuration, read from `process.env` **once at import time**. No config file exists. |
| `src/server.js` | HTTP server: router (`route()`), static files, error boundary. |
| `src/routes.js` | Every endpoint. Read this first when you need to know what the API does. |
| `src/auth/index.js` | scrypt passwords, login sessions, API keys, shared links. `currentUser()` accepts a session cookie **or** `Authorization: Bearer cred_…`. |
| `src/sites.js`, `src/goals.js` | Site records, exclusion rules, goals, funnels. |
| `src/provision.js` | Account + key + site in one function, shared by `POST /api/v1/provision` and `credible provision`. Keep the two paths on it. |
| `src/install.js` | Detects a website's framework and writes the snippet into its `<head>`. Pure file surgery, no database. |
| `src/db/` | `schema.sql` is the whole data model; `index.js` holds pragmas, migrations, cached statements. |
| `src/ingest/` | Beacon → one `events` row + one created-or-extended `visits` row. `salt.js` is privacy-critical. |
| `src/stats/` | `query.js` is the only place that emits SQL; `index.js` computes every dashboard number. |
| `src/util/` | `http.js` (JSON, CORS, `HttpError`), `time.js` (DST-safe bucketing via `Intl`), `log.js` (never logs an IP). |
| `tracker/src/credible.js` | Tracker source. Built to `public/js/cr.js`, which **is committed**. |
| `public/` | Dashboard SPA: unbundled modern ESM, loaded only by the operator. |
| `mcp/` | MCP server exposing the same API as typed tools. |
| `test/` | `node:test` suites. `helpers.js` must be imported *before* any `src/` module. |

Four decisions explain the rest: sessionization happens at **write** time; dimensions are
**denormalised** onto every event row; time buckets are computed in JS and pushed to SQL as
unix-second ranges; visitor identity is a **daily-rotating hash** with no user table behind it.

## Run it

```bash
node bin/credible.js serve                  # http://localhost:8000, creates ./data/credible.db
npm run dev                                 # same, with --watch and debug logging
node bin/credible.js seed example.com --days 30 --visitors 40   # realistic demo traffic
node bin/credible.js provision --email you@example.com --domain example.com --json
node bin/credible.js install --domain example.com --path ../their-site --dry-run
node bin/credible.js site:list
node bin/credible.js export example.com --days 30 > events.csv
node bin/credible.js help
```

Requires **Node ≥ 22.13** (`node:sqlite` without a flag). Never run a throwaway experiment
against `./data` — point it elsewhere:

```bash
CREDIBLE_DATA_DIR=/tmp/credible-scratch CREDIBLE_PORT=8331 node bin/credible.js serve
```

## Test it

```bash
node --test                          # everything
node --test test/referrer.test.js    # one file
```

Use bare `node --test`, never `node --test test/` — Node 26 resolves the directory as a
module and fails. Tests must not touch the network, must not depend on the machine's timezone
or the current date, and must build their own database through `withDatabase()` from
`test/helpers.js` rather than using `./data`.

**Anything with logic needs a test**: parsing, sessionization, date bucketing, query building,
and the hashing in `src/ingest/salt.js` above all.

## Rules

- **Zero dependencies.** Node built-ins only. **Never add anything to `package.json`** —
  CI fails the build if `dependencies` or `devDependencies` is non-empty.
- **ESM only.** `import`, never `require()`.
- **Tracker code is ES5.** Everything under `tracker/` runs untranspiled in a stranger's
  browser: no arrow functions, no `const`/`let`, no template literals, no `fetch`. Server and
  dashboard code targets modern Node/browsers and may use everything.
- **Rebuild the tracker after editing it:**
  ```bash
  node tracker/build.js && git add public/js/cr.js
  ```
  `public/js/cr.js` is committed and CI fails if it drifts from the source.
- **Comments in English**, explaining *why*. Every module starts with a header comment saying
  what it is for.
- **No placeholders.** No `TODO`, no function that throws "not implemented". Unfinished does
  not merge.
- Two-space indent, semicolons, single quotes.
- **Never commit `data/`.** It is gitignored and it holds real visitor-derived state. Do not
  copy it, print it, or attach it to an issue.
- **Do not weaken privacy.** No cookies, no `localStorage`, no stored IP addresses, nothing
  that makes a visitor identifiable across days. `docs/PRIVACY.md` is a promise, not a
  brochure — if behaviour changes, that file changes in the same commit.
- Errors thrown from a route must be `HttpError(status, message)` from `src/util/http.js`;
  anything else becomes a 500 with no detail leaked.

## Conventions that bite

- `src/config.js` snapshots the environment at import time. Setting `process.env` after some
  `src/` module has loaded does nothing.
- New dimensions must be added to the `DIMENSIONS` table in `src/stats/query.js`. Anything not
  in that table never reaches SQL — it is a 422 by design.
- Domains are normalised (`normalizeDomain()`): lowercased, scheme/`www.`/port/path stripped.
  Always compare normalised values.
- Timestamps are **unix seconds** everywhere, in the database and on the wire.
- The public ingest endpoint answers `202` with an empty body whether it wrote or dropped the
  event; the outcome is in the `x-credible` header. Use `POST /api/v1/events` when you need
  the reason in the body.
- Bot filtering drops any User-Agent without a browser token, so **curl is treated as a bot**.
  Send an explicit browser-like `user_agent` when posting test events.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`),
imperative mood, under ~72 characters. One logical change per PR, say how you verified it, and
update the docs in the same PR when behaviour changes. Before pushing:

```bash
node --test && node tracker/build.js && git status --short
```

Full detail for humans: [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/API.md](docs/API.md), [docs/TRACKING.md](docs/TRACKING.md).
