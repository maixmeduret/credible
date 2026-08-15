# Credible HTTP API

Everything Credible exposes over HTTP, read out of `src/routes.js`.

There are three separate surfaces, with three different authentication models:

| Surface | Path prefix | Auth | Stability |
| --- | --- | --- | --- |
| Ingestion | `/api/event`, `/api/events`, `/event` | none (public, open CORS) | stable, matches the tracker |
| Public Stats API v1 | `/api/v1/*` | `Authorization: Bearer <api key>` | the documented, supported API |
| Dashboard API | `/api/stats/:domain/*`, `/api/auth/*`, `/api/sites/*`, `/api/keys` | session cookie (or a shared-link slug) | **internal**, may change between releases |

Conventions that hold everywhere:

- Request and response bodies are JSON. Successful JSON responses carry
  `content-type: application/json; charset=utf-8` and `cache-control: no-store`.
- Timestamps in responses are **unix seconds** (integers). Dates are strings
  formatted in the site's timezone.
- Errors are always `{"error": "<message>"}` — see [Errors](#6-errors).
- There is no API versioning beyond the `/api/v1/` prefix, and no `Accept`
  header negotiation.

A quick liveness check needs no auth:

```bash
curl -s http://localhost:8000/api/health
```

```json
{"status":"ok","version":"0.1.0","events":5484,"uptime":2}
```

---

## 1. Authentication

### Creating an API key

API keys are created from the dashboard: **Account → API keys**, or over the
dashboard API with a logged-in session cookie:

```bash
curl -s -X POST http://localhost:8000/api/keys \
  -H 'content-type: application/json' \
  -b 'credible_session=<your session cookie>' \
  -d '{"name":"Grafana"}'
```

```json
{"key":"cred_eWA0_3mmsKm0TWNG4Pmk2eLkD0XQkqoQQrYSjNyH2FI"}
```

There is also a CLI shortcut that creates an account and a key in one go:

```bash
node bin/credible.js user:add you@example.com --api-key
```

**The key is shown exactly once.** `createApiKey()` in `src/auth/index.js`
stores only `sha256(key)` plus the first 12 characters as a display prefix. It
is not recoverable from the database — if you lose it, delete the key and make a
new one. Listing keys returns the metadata only:

```bash
curl -s http://localhost:8000/api/keys -b 'credible_session=…'
```

```json
{"keys":[
  {"id":2,"name":"Grafana","key_prefix":"cred_eWA0_3m","created_at":1786826706,"last_used_at":null},
  {"id":1,"name":"CLI","key_prefix":"cred_E4PNaUA","created_at":1786826607,"last_used_at":1786826695}
]}
```

`DELETE /api/keys/:id` revokes one (scoped to the calling user).

### Using a key

Send it as a bearer token:

```
Authorization: Bearer cred_E4PNaUAmHnAlUhmJOpVmK45RQWMc33gNvGCdgXQteoc
```

The prefix is stripped case-insensitively (`/^Bearer\s+/i`) and the remainder is
trimmed, so a bare `Authorization: cred_…` with no `Bearer` prefix also
authenticates. Anything else — no header, a `Basic` header, an unknown key — is
a 401:

```json
{"error":"Provide a valid API key: Authorization: Bearer <key>"}
```

Notes on the key model, all verifiable in `src/auth/index.js` and
`src/routes.js`:

- A key inherits **all** the permissions of the user who created it. There are
  no per-site or read-only keys, and no scopes or expiry.
- Every successful authentication updates `last_used_at`.
- Requesting a site the key's owner is not a member of returns **404**, not 403
  — a key holder cannot discover which other sites exist on the instance.
- Keys are for `/api/v1/*` only. The dashboard API does not accept them; it
  reads the `credible_session` cookie.

---

## 2. The public Stats API v1

Five endpoints:

```
GET  /api/v1/stats/aggregate
GET  /api/v1/stats/timeseries
GET  /api/v1/stats/breakdown
GET  /api/v1/stats/realtime/visitors
POST /api/v1/events
```

> Every response body below was captured from a real instance seeded with
> `node bin/credible.js seed example.com --days 30 --visitors 40`, running on
> 2026-08-15 with the site timezone set to `Europe/Paris`. The numbers are real
> output of the code in this repository, not illustrations — but they are demo
> traffic, so do not read anything into the values themselves.

### 2.1 Shared query parameters

All four `GET` endpoints build their query the same way (`buildScope()` in
`src/routes.js`), so these parameters mean the same thing everywhere.

| Parameter | Endpoints | Default | Meaning |
| --- | --- | --- | --- |
| `site_id` | all | — | Domain of the site. Required. Normalised like the dashboard does it: scheme, `www.`, port, path and query are stripped and it is lowercased, so `https://WWW.Example.com/pricing` resolves to `example.com`. `site` is accepted as an alias. |
| `period` | aggregate, timeseries, breakdown | `30d` | See the table below. An unrecognised value silently falls back to `30d`. |
| `date` | aggregate, timeseries, breakdown | today | `YYYY-MM-DD`. Anchors the *relative* periods so you can walk back in time (`period=month&date=2026-03-04` is March 2026). Anything that is not exactly `YYYY-MM-DD` is ignored and "now" is used. |
| `from`, `to` | aggregate, timeseries, breakdown | — | `YYYY-MM-DD`, used **only** with `period=custom`. Inclusive of both days. If either is missing or malformed the request falls back to `30d`. |
| `filters` | aggregate, timeseries, breakdown | none | JSON array — see [Filters](#5-filters). |
| `metrics` | aggregate, timeseries | see below | Comma-separated on `aggregate`; a **single** metric name on `timeseries`. |
| `property` | breakdown | `event:page` | The dimension to group by — see [Dimensions](#4-dimensions-reference). |
| `limit` | breakdown | `100` | Rows per page. Clamped to `1000`. Values that are not a non-negative integer fall back to the default; `limit=0` returns an empty list. |
| `page` | breakdown | `1` | 1-based page number, clamped to `10000`. Offset is `(page - 1) * limit`. |
| `comparison` | aggregate | none | `previous_period` or `year_over_year`. Anything else (including `off` and unknown values) means "no comparison". |
| `interval` | timeseries (and aggregate, harmlessly) | derived from `period` | Overrides the bucket size. Only `minute`, `hour`, `day`, `week`, `month` are accepted; anything else is ignored. |

There is **no `site_id`-less mode** and no way to query several sites at once.

#### Accepted `period` values

From `PERIODS` in `src/util/time.js`. Ranges are half-open `[start, end)` and are
computed in the **site's** timezone.

| `period` | Range | Default interval |
| --- | --- | --- |
| `realtime` | the last 30 minutes (wall clock, ignores `date`) | `minute` |
| `day` | the anchor day, midnight → midnight | `hour` |
| `yesterday` | the day before the anchor day | `hour` |
| `7d` | anchor day minus 6 days → end of anchor day | `day` |
| `28d` | anchor day minus 27 days → end of anchor day | `day` |
| `30d` | anchor day minus 29 days → end of anchor day | `day` |
| `91d` | anchor day minus 90 days → end of anchor day | `week` |
| `month` | calendar month containing the anchor, truncated at today | `day` |
| `last_month` | the whole calendar month before the anchor's month | `day` |
| `6mo` | start of the month 5 months back → end of anchor day | `month` |
| `12mo` | start of the month 11 months back → end of anchor day | `month` |
| `year` | 1 January of the anchor's year → end of anchor day | `month` |
| `all` | the site's **first recorded event** (start of that day) → end of anchor day. With no data at all, the last 30 days. | recomputed by span |
| `custom` | `from` 00:00 → `to` 24:00 | recomputed by span |

For `all` and `custom`, the interval is chosen by `pickInterval()` from the span:
`≤ 2h → minute`, `≤ 2d → hour`, `≤ 95d → day`, `≤ 400d → week`, else `month`.

#### Accepted `interval` values

`minute`, `hour`, `day`, `week`, `month`. Weeks start on Monday. Months and days
are calendar-correct in the site's timezone (DST is handled by `Intl`, not by
adding 86400 seconds). The graph is capped at **2000 buckets** — a range longer
than that is truncated, not rejected.

---

### 2.2 `GET /api/v1/stats/aggregate`

Headline numbers for the period.

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/aggregate?site_id=example.com&period=7d'
```

```json
{"results":{
  "visitors":{"value":354},
  "visits":{"value":389},
  "pageviews":{"value":695},
  "bounce_rate":{"value":67},
  "visit_duration":{"value":231}
}}
```

The default `metrics` list is exactly
`visitors,visits,pageviews,bounce_rate,visit_duration`. Ask for others by name;
unknown names are **silently dropped** rather than rejected, and the response
preserves the order you asked for:

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/aggregate?site_id=example.com&period=7d&comparison=previous_period&metrics=visitors,visits,pageviews,events,views_per_visit,bounce_rate,visit_duration,revenue'
```

```json
{"results":{
  "visitors":{"value":354,"change":4},
  "visits":{"value":389,"change":-3},
  "pageviews":{"value":695,"change":-3},
  "events":{"value":1459,"change":-4},
  "views_per_visit":{"value":1.79,"change":1},
  "bounce_rate":{"value":67,"change":0},
  "visit_duration":{"value":231,"change":-4},
  "revenue":{"value":236,"change":33}
}}
```

`change` appears only when `comparison` is set. It is:

- for `bounce_rate`: the **difference in percentage points**, rounded
  (`round(current − previous)`);
- for every other metric: the **percent change**, rounded
  (`round((current − previous) / previous × 100)`);
- `100` when the previous value was 0 and the current one is positive, `0` when
  both are 0.

`comparison=previous_period` shifts the window back by its own length;
`year_over_year` shifts it back 12 calendar months.

---

### 2.3 `GET /api/v1/stats/timeseries`

One row per bucket.

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/timeseries?site_id=example.com&period=7d&metrics=visitors'
```

```json
{"results":[
  {"date":"2026-08-09","visitors":30},
  {"date":"2026-08-10","visitors":53},
  {"date":"2026-08-11","visitors":68},
  {"date":"2026-08-12","visitors":68},
  {"date":"2026-08-13","visitors":59},
  {"date":"2026-08-14","visitors":66},
  {"date":"2026-08-15","visitors":39}
]}
```

`date` is `YYYY-MM-DD` for the `day`, `week` and `month` intervals and
`YYYY-MM-DD HH:MM` for `minute` and `hour`. For `week` and `month` it is the
first day of the bucket. Buckets with no traffic are returned with zeros, so the
array length is stable.

Overriding the interval:

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/timeseries?site_id=example.com&period=all&interval=month&metrics=visitors'
```

```json
{"results":[{"date":"2026-07-01","visitors":402},{"date":"2026-08-01","visitors":647}]}
```

**Two sharp edges, both real:**

1. `metrics` here is a **single** metric, not a list. The handler does
   `{ date, [metric]: row[metric] ?? row.visitors }`, so `metrics=visitors,pageviews`
   produces a key literally named `"visitors,pageviews"` holding the *visitors*
   value:

   ```json
   {"results":[{"date":"2026-08-09","visitors,pageviews":30}, …]}
   ```

2. An unknown metric name does not error — it falls back to visitors under the
   name you asked for (`metrics=nonsense` → `{"date":"2026-08-09","nonsense":30}`).
   Check the spelling yourself.

Per-bucket metrics available: `visitors`, `visits`, `pageviews`, `events`,
`views_per_visit`, `bounce_rate`, `visit_duration`. `revenue` is **not** computed
per bucket, so `metrics=revenue` silently returns visitors.

---

### 2.4 `GET /api/v1/stats/breakdown`

Group by a dimension.

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/breakdown?site_id=example.com&period=7d&property=event:page&limit=3'
```

```json
{"results":[
  {"event:page":"/","name":"/","visitors":187,"visits":197,"pageviews":252,"time_on_page":115,"scroll_depth":60},
  {"event:page":"/listings","name":"/listings","visitors":77,"visits":79,"pageviews":90,"time_on_page":112,"scroll_depth":61},
  {"event:page":"/analyse-zone","name":"/analyse-zone","visitors":60,"visits":64,"pageviews":68,"time_on_page":123,"scroll_depth":61}
]}
```

Every row carries the value **twice**: once under the property name (Plausible
style) and once as `name` (the internal field). Rows are ordered by `visitors`
descending, then `pageviews` descending, then `name` ascending. Empty and NULL
values are excluded.

**The columns depend on the dimension.** There are four shapes:

*Ordinary event dimensions* (`event:name`, `event:hostname`, all `visit:*`
except entry/exit page) — `visitors`, `visits`, `pageviews`, `events`:

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/breakdown?site_id=example.com&period=30d&property=visit:channel&limit=4'
```

```json
{"results":[
  {"visit:channel":"Direct","name":"Direct","visitors":495,"visits":707,"pageviews":1297,"events":2734},
  {"visit:channel":"Organic Search","name":"Organic Search","visitors":303,"visits":333,"pageviews":572,"events":1211},
  {"visit:channel":"Organic Social","name":"Organic Social","visitors":207,"visits":222,"pageviews":393,"events":830},
  {"visit:channel":"Referral","name":"Referral","visitors":77,"visits":79,"pageviews":135,"events":291}
]}
```

*`event:page`* — the special case above, with `time_on_page` (seconds) and
`scroll_depth` (percent) instead of `events`.

*`visit:entry_page` and `visit:exit_page`* — queried against the `visits` table,
so they get session metrics instead of `events`:

```json
{"results":[
  {"visit:entry_page":"/","name":"/","visitors":152,"visits":156,"pageviews":280,"bounce_rate":63,"visit_duration":229},
  {"visit:entry_page":"/listings","name":"/listings","visitors":55,"visits":55,"pageviews":93,"bounce_rate":76,"visit_duration":207}
]}
```

*`event:props:<key>`* — `visitors`, `events`, `revenue`:

```json
{"results":[
  {"event:props:plan":"free","name":"free","visitors":18,"events":18,"revenue":0},
  {"event:props:plan":"pro","name":"pro","visitors":17,"events":20,"revenue":551}
]}
```

*`event:goal`* — a completely different row shape, and **`limit`/`page` are
ignored**: every configured goal is always returned, sorted by `uniques`.

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/breakdown?site_id=example.com&period=7d&property=event:goal'
```

```json
{"results":[
  {"event:goal":"Visit /pricing","id":6,"name":"Visit /pricing","type":"page","uniques":41,"total":43,"revenue":0,"cr":11.6},
  {"event:goal":"Form: Submission","id":3,"name":"Form: Submission","type":"event","uniques":28,"total":29,"revenue":0,"cr":7.9},
  {"event:goal":"Signup","id":1,"name":"Signup","type":"event","uniques":11,"total":11,"revenue":0,"cr":3.1}
]}
```

- `uniques` — distinct visitors who triggered the goal
- `total` — number of matching events
- `revenue` — sum of revenue on those events, in major units
- `cr` — `uniques / visitors_in_scope × 100`, one decimal

**Pagination.** There is no total count and no `has_more` flag in the v1
response (the internal `hasMore` computed by the engine is dropped by this
handler). Page until you get fewer rows than `limit`, or an empty array.

---

### 2.5 `GET /api/v1/stats/realtime/visitors`

Distinct visitors seen in the **last 300 seconds**. The window is hard-coded and
`period`/`filters` are not applied.

```bash
curl -s -H "Authorization: Bearer $CREDIBLE_KEY" \
  'http://localhost:8000/api/v1/stats/realtime/visitors?site_id=example.com'
```

```json
2
```

The body is a bare JSON number, not an object.

---

### 2.6 `POST /api/v1/events`

Server-side tracking for backends, mobile apps and webhooks. Requires a bearer
token (unlike the public `/api/event` beacon endpoint) and takes the same
payload as the browser tracker plus three server-only fields.

```bash
curl -s -X POST http://localhost:8000/api/v1/events \
  -H "Authorization: Bearer $CREDIBLE_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "n": "Purchase",
    "d": "example.com",
    "u": "https://example.com/thanks",
    "r": "https://news.ycombinator.com/",
    "p": {"plan": "pro", "seats": "3"},
    "v": {"amount": 49.9, "currency": "EUR"},
    "ip": "81.2.69.142",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  }'
```

```json
{"status":"ok","events":1}
```

Status is **202** when at least one event was written, **200** when the event was
accepted but deliberately dropped.

#### Every accepted body field

Read out of `recordEvent()` in `src/ingest/index.js` and the `/api/v1/events`
handler in `src/routes.js`. Short and long names are interchangeable where two
are listed.

| Field | Alias | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| `n` | `name` | string | **yes** | Event name, trimmed, max 120 chars. `pageview` and `engagement` are the two reserved names the tracker uses; anything else is a custom event. Empty → `{"status":"ignored","reason":"missing event name"}`. |
| `u` | `url` | string | **yes** | Full URL of the page, max 2400 chars. Must parse as a URL with an `http:`/`https:` scheme. The path is normalised (duplicate slashes collapsed, trailing slash dropped except at the root) and the hostname loses a leading `www.`. UTM parameters and ad click ids are read from here. |
| `d` | `domain` | string | **yes** | The tracked domain. Comma-separated for multiple sites; each is lowercased and stripped of `www.`. Domains not tracked on this instance are skipped. |
| `r` | `referrer` | string | no | Referrer URL, max 1000 chars. Classified into `visit:channel`, `visit:source` and `visit:referrer`. |
| `w` | `width` | number | no | Viewport width in CSS pixels. Bucketed into `visit:screen_size`: `<576 Mobile`, `<992 Tablet`, `<1440 Laptop`, else `Desktop`. Missing or `<1` → empty. |
| `h` | — | `1`/`true` | no | Hash mode. When set, `location.hash` is appended to the stored path. |
| `p` | `props` | object | no | Custom properties. Flat object only: max 30 keys, keys ≤ 64 chars, values coerced to strings and capped at 255 chars. Nested objects, arrays and `null` values are dropped; booleans become `"true"`/`"false"`; empty keys and empty values are dropped. |
| `v` | `revenue` | object | no | `{"amount": <number>, "currency": "EUR"}` (`a`/`c` also accepted). Stored as integer minor units (`round(amount × 100)`). The currency must be exactly three letters or it is stored empty; when omitted it defaults to the site's currency. A non-numeric `amount` disables revenue for the event. |
| `e` | — | object | no | Engagement: `{"t": <ms>, "s": <percent>}`. `t` is clamped to 0…1 800 000 ms, `s` to 0…100. Only meaningful on `engagement` events — this is what feeds `time_on_page` and `scroll_depth`. |
| `ip` | — | string | no | **Server-side only.** Overrides the source IP used for geolocation and for the daily visitor hash. Falls back to the request's client IP. The IP is never stored. |
| `user_agent` | — | string | no | **Server-side only.** Overrides the `User-Agent` header for browser/OS/device parsing and bot detection. Max 500 chars. |
| `timestamp` | — | number | no | **Server-side only.** Unix **seconds** for the event. `Math.floor(Number(...))` — no validation, no range check, so a bad value writes a bogus row. Defaults to now. |

#### When an event is dropped

The endpoint returns **200** with `{"status":"ignored","reason":"…"}`. The
reasons, in the order they are checked:

| `reason` | Cause |
| --- | --- |
| `missing event name` | `n`/`name` absent or empty |
| `bot` | the effective User-Agent is a crawler, or does not look like a browser |
| `invalid url` | `u` does not parse |
| `unsupported scheme` | `u` is not `http:`/`https:` |
| `missing data-domain` | `d`/`domain` absent or empty |
| `unknown domain` | none of the listed domains is tracked on this instance |

**Bot detection catches command-line clients.** `isBot()` requires the
User-Agent to contain a browser marker (`mozilla/`, `applewebkit`, `gecko/`,
`opera/`, `webkit/`, `trident/`, `msie `). A default `curl/8.x` or a Node
`fetch` User-Agent has none of them, so the event is silently dropped as a bot:

```bash
# no user_agent field, curl's own UA → dropped
curl -s -X POST http://localhost:8000/api/v1/events \
  -H "Authorization: Bearer $CREDIBLE_KEY" -H 'content-type: application/json' \
  -d '{"n":"Purchase","d":"example.com","u":"https://example.com/thanks"}'
```

```json
{"status":"ignored","reason":"bot"}
```

**Always send an explicit browser-like `user_agent` from a server.** There is no
way to bypass bot filtering otherwise.

Two more caveats worth knowing:

- The endpoint checks that the bearer token is valid, but **not that its owner
  can access the domain in `d`**. Any valid key on the instance can write events
  into any tracked site.
- Sessionisation is applied exactly as for browser traffic: events from the same
  visitor hash within `CREDIBLE_INACTIVITY_TIMEOUT` (default 1800 s) join one
  visit, and acquisition/geo/device attributes are inherited from the visit's
  first event.

#### The public ingestion endpoint

`POST /api/event` (aliases `/api/events` and `/event`) is the same pipeline
without authentication — it is what the browser tracker posts to. It accepts the
`n`/`d`/`u`/`r`/`w`/`h`/`p`/`v`/`e` fields only (no `ip`, `user_agent` or
`timestamp`), always answers **202 with an empty body**, and reports the outcome
in an `x-credible` response header (`ok` or `ignored`). CORS is open
(`access-control-allow-origin` echoes the request `Origin`, or `*`). A malformed
JSON body there is a 400 `{"error":"Invalid payload"}`; anything else that goes
wrong is swallowed so the endpoint never leaks internals.

---

## 3. Metrics reference

Computed in `aggregate()` / `timeseries()` / the breakdown functions in
`src/stats/index.js`.

| Metric | Type | How it is computed |
| --- | --- | --- |
| `visitors` | integer | `count(DISTINCT e.visitor_id)` over the events in scope. `visitor_id` is a daily-rotating salted hash of IP + User-Agent + site, so the same person on two days counts twice. |
| `visits` | integer | `count(DISTINCT e.visit_id)` over the events in scope — sessions that had at least one event inside the range. |
| `pageviews` | integer | `sum(CASE WHEN e.name = 'pageview' THEN 1 ELSE 0 END)`. |
| `events` | integer | `count(*)` — every row, including `engagement` events and custom events. Always ≥ `pageviews`. |
| `views_per_visit` | 2-decimal number | `pageviews / visits`, `0` when there are no visits. Computed from the two numbers above, not averaged per session. |
| `bounce_rate` | integer, 0–100 | `round(avg(v.is_bounce) × 100)` over `visits`. A visit is a bounce until it records a **second pageview** — an engagement event or a custom event does not un-bounce it. `0` when there are no visits. |
| `visit_duration` | integer seconds | `round(avg(v.duration))` over `visits`, where `duration = last_event_at − started_at`. Single-event visits have duration 0. |
| `revenue` | number, major units | `sum(COALESCE(e.revenue, 0)) / 100` over the events in scope. Revenue is stored in minor units. **Currencies are summed together without conversion** — if a site receives several currencies this number is meaningless. Only on `aggregate`, `event:goal` and `event:props:*` breakdowns. |

Two derived values appear only in `event:page` breakdowns:

| Metric | How it is computed |
| --- | --- |
| `time_on_page` | `round(avg(engagement_time) / 1000)` over `engagement` events with `engagement_time > 0` on that path. Seconds. `0` when the tracker never reported engagement. |
| `scroll_depth` | `round(avg(scroll_depth))` over `engagement` events with `scroll_depth > 0` on that path. Percent. |

**A subtlety that matters when you reconcile numbers:** event metrics
(`visitors`, `visits`, `pageviews`, `events`, `revenue`) select events whose
`timestamp` falls in the range, while session metrics (`bounce_rate`,
`visit_duration`) average over visits whose `started_at` falls in the range. A
visit that starts at 23:55 and ends at 00:10 contributes events to both days but
its bounce/duration only to the first.

---

## 4. Dimensions reference

The complete `DIMENSIONS` table from `src/stats/query.js`. Nothing outside this
table (plus `event:goal` and `event:props:<key>`) ever reaches SQL — an unknown
key is a 422. Every one of these can be used both as a `property` (group by) and
inside `filters`.

| Key | Label | Stored value |
| --- | --- | --- |
| `event:page` | Page | Normalised path, e.g. `/blog/post`. No query string. Includes the hash when the tracker runs in hash mode. |
| `event:hostname` | Hostname | Hostname of the page URL, `www.` stripped. |
| `event:name` | Event | Event name: `pageview`, `engagement`, or a custom name. |
| `visit:entry_page` | Entry page | Path of the visit's first pageview. Session-scoped. |
| `visit:exit_page` | Exit page | Path of the visit's last pageview. Session-scoped. |
| `visit:channel` | Channel | One of `Direct`, `Organic Search`, `Paid Search`, `Organic Social`, `Paid Social`, `Organic Video`, `Organic Shopping`, `Paid Shopping`, `Email`, `Affiliates`, `Referral`, `Display`, `SMS`, `Audio`, `Unknown`. |
| `visit:source` | Source | Friendly source name (`Google`, `Hacker News`, `X (Twitter)`, `Direct`…), derived from the referrer or from `utm_source`. |
| `visit:referrer` | Referrer | The referrer reduced to `host + path`, with the scheme, `www.`, query string, fragment and trailing slashes removed: `https://news.ycombinator.com/item?id=1` is stored as `news.ycombinator.com/item`. Empty for direct traffic and for referrers on the site's own domain. |
| `visit:utm_source` | UTM source | `utm_source` from the landing URL. |
| `visit:utm_medium` | UTM medium | `utm_medium`. |
| `visit:utm_campaign` | UTM campaign | `utm_campaign`. |
| `visit:utm_content` | UTM content | `utm_content`. |
| `visit:utm_term` | UTM term | `utm_term`. |
| `visit:country` | Country | **ISO 3166-1 alpha-2 code**, uppercase (`FR`, `US`), not a country name. Empty when geography is unavailable. |
| `visit:region` | Region | Region name as supplied by the edge headers. Often empty. |
| `visit:city` | City | City name as supplied by the edge headers. Often empty. |
| `visit:browser` | Browser | `Chrome`, `Safari`, `Firefox`, … |
| `visit:browser_version` | Browser version | Major version string. |
| `visit:os` | Operating system | `macOS`, `Windows`, `iOS`, … |
| `visit:os_version` | OS version | Version string. |
| `visit:device` | Device | Always one of `Desktop`, `Mobile`, `Tablet`. |
| `visit:screen_size` | Screen size | `Mobile`, `Tablet`, `Laptop`, `Desktop`, from the reported viewport width. |

Despite the `visit:` prefix, most of these are denormalised onto every event row
and queried without a join; only `visit:entry_page` and `visit:exit_page` are
truly session-scoped. The prefix describes semantics (an attribute of the whole
session, inherited from its first event), not storage.

### Two extra keys

**`event:goal`** — not in `DIMENSIONS`; handled specially.

- As `property`: returns the goal breakdown described in §2.4.
- In `filters`: values are matched against each goal's `display_name`, falling
  back to `event_name` then `page_path`, and expand to the goal's own definition
  (an event-name match, or a path match with an optional trailing `*`). If no
  value matches a configured goal the filter matches **nothing** — including
  `event:goal` with `is_not`, which returns zero rows rather than everything.

**`event:props:<key>`** — a custom property, read out of the event's JSON blob
with `json_extract`. The key must be non-empty and ≤ 64 characters; double
quotes are stripped from it. Works as a `property` and inside `filters`.
Property keys are not declared anywhere in advance — they appear as soon as an
event carries them.

---

## 5. Filters

### Wire format

`filters` is a **JSON array of three-element arrays**:

```json
[["is", "visit:country", ["FR", "BE"]], ["contains", "event:page", ["/blog"]]]
```

That is `[operator, dimension, values]`. The whole thing is JSON-encoded, then
URL-encoded into the query string. Entries within the array are combined with
**AND**; the values inside one entry are combined with **OR**.

`values` is normally an array, but a bare scalar is accepted and wrapped
(`["is","visit:country","FR"]` works). Each value is coerced to a string and
truncated to 500 characters.

### Operators

The complete `FILTER_OPERATORS` set:

| Operator | SQL | Behaviour |
| --- | --- | --- |
| `is` | `col IN (…)` | Exact match against any of the values. Case-sensitive. |
| `is_not` | `NOT (col IN (…)) OR col IS NULL` | Excludes those values **and keeps rows where the column is unset**. |
| `contains` | `col LIKE '%value%' ESCAPE '\'` | Substring match. `%`, `_` and `\` in your value are escaped, so they are literal. Case-insensitivity follows SQLite's `LIKE`: ASCII-insensitive, but not for non-ASCII characters. |
| `contains_not` | `NOT (…) OR col IS NULL` | Negated substring match, NULL-safe like `is_not`. |
| `matches` | `col GLOB 'pattern'` | **SQLite `GLOB`, not a regular expression.** `*` matches any run of characters, `?` matches one, `[abc]` a character class. Always case-sensitive. |
| `matches_not` | `NOT (…) OR col IS NULL` | Negated glob, NULL-safe. |

Any other operator is a 422: `{"error":"Unknown filter operator: gt"}`.

There is no `OR` between different dimensions, no nesting, and no numeric
comparison.

### Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| Filters per request | 20 | `Too many filters` |
| Values per filter | 100 | `Too many filter values` |
| Value length | 500 chars | silently truncated |
| Property-key length (`event:props:<key>`) | 64 chars | `Invalid property: …` |

Other 422s from the parser: `filters must be valid JSON` (not parseable),
`filters must be an array` (parsed to something else), `Malformed filter` (an
entry that is not an array of at least three elements), `Filter needs at least
one value`, `Unknown dimension: …`.

### URL encoding

`filters` must be percent-encoded. With curl, use `-G --data-urlencode` and
single-quote the JSON so the shell leaves it alone:

```bash
curl -s -G -H "Authorization: Bearer $CREDIBLE_KEY" \
  http://localhost:8000/api/v1/stats/aggregate \
  --data-urlencode 'site_id=example.com' \
  --data-urlencode 'period=30d' \
  --data-urlencode 'filters=[["is","visit:country",["FR","BE"]]]'
```

In JavaScript:

```js
const params = new URLSearchParams({
  site_id: 'example.com',
  period: '30d',
  filters: JSON.stringify([['is', 'visit:country', ['FR', 'BE']]]),
});
const res = await fetch(`http://localhost:8000/api/v1/stats/aggregate?${params}`, {
  headers: { authorization: `Bearer ${process.env.CREDIBLE_KEY}` },
});
console.log(await res.json());
```

### Three worked examples

**1. Traffic from France or Belgium.**

```bash
curl -s -G -H "Authorization: Bearer $CREDIBLE_KEY" \
  http://localhost:8000/api/v1/stats/aggregate \
  --data-urlencode 'site_id=example.com' \
  --data-urlencode 'period=30d' \
  --data-urlencode 'filters=[["is","visit:country",["FR","BE"]]]'
```

```json
{"results":{"visitors":{"value":431},"visits":{"value":717},"pageviews":{"value":1247},"bounce_rate":{"value":68},"visit_duration":{"value":229}}}
```

**2. Where non-direct blog traffic comes from** — two filters, ANDed:

```bash
curl -s -G -H "Authorization: Bearer $CREDIBLE_KEY" \
  http://localhost:8000/api/v1/stats/breakdown \
  --data-urlencode 'site_id=example.com' \
  --data-urlencode 'period=30d' \
  --data-urlencode 'property=visit:source' \
  --data-urlencode 'limit=3' \
  --data-urlencode 'filters=[["contains","event:page",["/blog"]],["is_not","visit:source",["Direct"]]]'
```

```json
{"results":[
  {"visit:source":"Google","name":"Google","visitors":50,"visits":51,"pageviews":56,"events":117},
  {"visit:source":"LinkedIn","name":"LinkedIn","visitors":16,"visits":16,"pageviews":17,"events":34},
  {"visit:source":"Hacker News","name":"Hacker News","visitors":13,"visits":13,"pageviews":13,"events":26}
]}
```

**3. Revenue from a custom property.** `event:props:*` filters combine with
revenue metrics:

```bash
curl -s -G -H "Authorization: Bearer $CREDIBLE_KEY" \
  http://localhost:8000/api/v1/stats/aggregate \
  --data-urlencode 'site_id=example.com' \
  --data-urlencode 'period=30d' \
  --data-urlencode 'metrics=visitors,events,revenue' \
  --data-urlencode 'filters=[["is","event:props:plan",["pro"]]]'
```

```json
{"results":{"visitors":{"value":18},"events":{"value":21},"revenue":{"value":600.9}}}
```

A glob filter, for comparison — every blog post under `/blog/`:

```bash
--data-urlencode 'filters=[["matches","event:page",["/blog/*"]]]'
```

```json
{"results":{"visitors":{"value":270},"pageviews":{"value":342}}}
```

And a goal filter — visitors who triggered the `Signup` goal:

```bash
--data-urlencode 'filters=[["is","event:goal",["Signup"]]]'
```

```json
{"results":{"visitors":{"value":29},"events":{"value":29}}}
```

---

## 6. Errors

Every failure produced by the error boundary in `src/server.js` has the same
shape:

```json
{"error": "Human-readable message"}
```

An optional `details` key is added when the thrown `HttpError` carries one;
nothing in the current codebase sets it, so in practice `error` is the only
field.

| Status | When | Example body |
| --- | --- | --- |
| **400** | Malformed JSON request body | `{"error":"Invalid JSON body"}` — on `/api/event` it is `{"error":"Invalid payload"}` |
| **401** | Missing/unknown API key; no session cookie on a dashboard endpoint; wrong password; wrong shared-link password | `{"error":"Provide a valid API key: Authorization: Bearer <key>"}`, `{"error":"Sign in to continue"}`, `{"error":"Wrong email or password"}` |
| **403** | Signed-in user without access to the site; registration disabled | `{"error":"You do not have access to this site"}`, `{"error":"Registration is closed on this instance"}` |
| **404** | Unknown route; unknown site; **a site the API key's owner cannot read**; unknown funnel or shared link | `{"error":"Not found"}`, `{"error":"Site not found"}` |
| **409** | Duplicate email on registration; a site that is already tracked | `{"error":"An account with this email already exists"}`, `{"error":"This site is already being tracked"}` |
| **422** | Validation: unknown dimension, bad filters, invalid domain, invalid timezone, short password, bad goal/funnel definition | `{"error":"Unknown dimension: visit:nope"}`, `{"error":"filters must be valid JSON"}`, `{"error":"Enter a valid domain, for example example.com"}` |
| **429** | Rate limited — see below | `{"error":"Too many events"}`, `{"error":"Too many attempts, try again in a minute"}` |
| **500** | Any unhandled exception. The real error is logged server-side and never returned. | `{"error":"Internal server error"}` |

Worth knowing:

- **`site_id` missing or invalid is a 422**, not a 400 — it goes through domain
  normalisation first: `{"error":"Enter a valid domain, for example example.com"}`.
  A well-formed domain that is not tracked, or not readable by the key, is a 404.
- **An oversized request body does not produce a clean 413.** `readJson()`
  rejects with a 413 `HttpError` but also calls `req.destroy()`, so the socket
  is closed before a response is written and the client sees a dropped
  connection. The limit is 64 KB on `/api/v1/events` and the dashboard API,
  32 KB on `/api/event`.
- Unknown `period`, unknown `interval`, unknown `metrics` and unknown
  `comparison` values are **never** errors. They fall back silently. Validate
  your own input.

---

## 7. Rate limits

Two independent fixed-window limiters (`createRateLimiter()` in
`src/util/http.js`), both **in-memory, per process, per calendar minute**, keyed
by client IP. The window is a hard boundary, not a sliding one: the counters
reset at the top of each minute. No `Retry-After` or `X-RateLimit-*` headers are
sent.

| Limiter | Applies to | Limit | Response |
| --- | --- | --- | --- |
| Ingestion | `POST /api/event`, `/api/events`, `/event` | `CREDIBLE_RATE_LIMIT` events per IP per minute, **default 600**. Set it to `0` to disable. | `429` + `{"error":"Too many events"}`, with CORS headers |
| Auth | `POST /api/auth/register`, `POST /api/auth/login` | **30** attempts per IP per minute (hard-coded, not configurable) | `429` + `{"error":"Too many attempts, try again in a minute"}` |

**The Stats API v1 is not rate limited at all** — neither the read endpoints nor
`POST /api/v1/events`. If you expose an instance publicly, put your own limiter
in front of it.

The client IP comes from `clientIp()`: the socket address, unless
`CREDIBLE_TRUST_PROXY` is enabled, in which case `cf-connecting-ip`,
`x-real-ip` and the first entry of `x-forwarded-for` are consulted in that
order. Behind a proxy without that flag set, every request looks like it comes
from the proxy and shares one bucket.

---

## 8. The dashboard's own API (internal)

> **These endpoints are internal.** They exist to serve the dashboard SPA in
> `public/`, they are not versioned, and their shapes may change in any release
> without notice. API keys do **not** work here. Build on them if you self-host
> and want something the v1 API cannot do — but pin your Credible version, and
> expect to re-check after upgrades.

Authentication is one of three things, resolved by `authorizeSite()`:

1. the `credible_session` cookie of a user who is a member of the site;
2. no auth at all, if the site has `public` set;
3. `?auth=<slug>` from a shared link — plus, when the link has a password, a
   `credible_shared_<slug>` cookie obtained from `POST /api/shared/:slug/unlock`.

Anonymous callers on a private site get 401; signed-in non-members get 403.

### Stats

All of these accept the same `period` / `date` / `from` / `to` / `filters` /
`interval` parameters as the v1 API, plus `auth` for shared links.

| Endpoint | Returns |
| --- | --- |
| `GET /api/stats/:domain/dashboard` | Everything the main screen needs in one request: `site`, `period` (with resolved `start`/`end`/`interval`/`timezone`/`date`), `metrics`, `comparison`, `changes`, `timeseries`, `comparison_timeseries`, `current_visitors`, `panels` (`channels`, `sources`, `pages`, `entry_pages`, `countries`, `browsers`, `goals`), `has_goals`, `property_keys`. Also takes `comparison`. |
| `GET /api/stats/:domain/breakdown` | One panel. Uses `dimension` (default `event:page`), `limit` (default **9**, max 500) and `offset` (default 0, max 100000) — note the different parameter names and defaults from v1. Returns `{results, hasMore}`. |
| `GET /api/stats/:domain/properties` | `{keys, key, results, hasMore}` — the custom-property keys present in scope (max 50) and a breakdown of one of them. Takes `key` and `limit`. |
| `GET /api/stats/:domain/funnels` | `{funnels: [...]}` with each funnel's steps. |
| `GET /api/stats/:domain/funnels/:id` | A computed funnel report: `{id, name, steps: [{name, visitors, conversion_rate, dropoff}], visitors, completion_rate}`. Steps must be reached in chronological order by the same visitor within the period. |
| `GET /api/stats/:domain/realtime` | `{visitors, pages}` for the last 300 seconds (top 10 pages). |

Unlike v1, breakdown rows here carry only `name` (no duplicated property key),
and `hasMore` **is** returned.

### Account, sites, goals, keys

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/register` | Create an account. The first one always works; later ones need `CREDIBLE_OPEN_REGISTRATION`. Sets the session cookie, returns `{user, first}`. |
| `POST /api/auth/login` | `{email, password}` → sets the cookie, returns `{user}`. |
| `POST /api/auth/logout` | Destroys the session. |
| `PATCH /api/auth/password` | `{current_password, password}`. Invalidates all other sessions. |
| `GET /api/auth/me` | `{user, sites, registration_open, needs_setup}`. Works anonymously (`user: null`). |
| `GET /api/sites` | Sites the user can see, with `role` and `current_visitors`. |
| `POST /api/sites` | `{domain, timezone, currency}` → `{site, snippet}`. |
| `GET /api/sites/:domain` | Full settings bundle: settings, goals, funnels, shared links, members, suggested goals, install snippet, data range. |
| `PATCH /api/sites/:domain` | Admin. Accepts `timezone`, `public`, `excluded_paths`, `excluded_ips`, `currency`. |
| `DELETE /api/sites/:domain` | Owner. Deletes the site **and all of its events and visits**. |
| `POST /api/sites/:domain/members` | Owner. `{email, role}` — the invitee must already have an account. Roles: `viewer`, `admin`, `owner`. |
| `POST /api/sites/:domain/goals` | Admin. `{type: 'event'\|'page', event_name, page_path, display_name}`. A page path may end in `*`. |
| `DELETE /api/sites/:domain/goals/:id` | Admin. |
| `POST /api/sites/:domain/funnels` | Admin. `{name, goals: [id, …]}` — between 2 and 8 steps. |
| `DELETE /api/sites/:domain/funnels/:id` | Admin. |
| `POST /api/sites/:domain/shared-links` | Admin. `{name, password}` → `{slug, url}`. |
| `DELETE /api/sites/:domain/shared-links/:slug` | Admin. |
| `POST /api/shared/:slug/unlock` | `{password}` → sets the `credible_shared_<slug>` cookie for 24 h. |
| `GET/POST/DELETE /api/keys[/:id]` | API-key management (see §1). |

The session cookie is `credible_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Secure` when `CREDIBLE_SECURE_COOKIES` is on, lifetime
`CREDIBLE_SESSION_TTL` (default 30 days).

---

## 9. Compatibility with Plausible's Stats API

Credible aims at *drop-in-ish* compatibility for the common cases, not at parity.
The comparison below describes Credible precisely — it is read out of this
repository. The Plausible side is from its public documentation and is **not**
verified here; check against your Plausible version before relying on it.

### What matches

- **Endpoint paths**: `/api/v1/stats/aggregate`, `/api/v1/stats/timeseries`,
  `/api/v1/stats/breakdown`, `/api/v1/stats/realtime/visitors`.
- **Auth scheme**: `Authorization: Bearer <key>`.
- **Parameter names**: `site_id`, `period`, `date`, `filters`, `metrics`,
  `property`, `limit`, `page`.
- **Response envelopes**: `{"results": …}` for the three stats endpoints; a bare
  number for `realtime/visitors`.
- **Dimension names**: `event:page`, `event:name`, `event:hostname`,
  `event:goal`, `event:props:<key>`, `visit:source`, `visit:referrer`,
  `visit:entry_page`, `visit:exit_page`, `visit:utm_source`, `visit:utm_medium`,
  `visit:utm_campaign`, `visit:utm_content`, `visit:utm_term`, `visit:country`,
  `visit:region`, `visit:city`, `visit:browser`, `visit:browser_version`,
  `visit:os`, `visit:os_version`, `visit:device`, `visit:screen_size`,
  `visit:channel`.
- **Metric names**: `visitors`, `visits`, `pageviews`, `events`,
  `views_per_visit`, `bounce_rate`, `visit_duration`.
- **Breakdown rows** repeat the grouped value under the property name
  (`{"event:page": "/", …}`).
- **Ingestion**: `POST /event` is accepted as an alias of `/api/event`, with the
  same `n`/`u`/`d`/`r`/`w`/`h`/`p` payload the Plausible script sends, so an
  existing Plausible tracker can be pointed at a Credible instance.

### What differs

| Area | Credible |
| --- | --- |
| **Filter syntax** | **JSON only**: `[["is","visit:country",["FR"]]]`. The Plausible v1 string syntax (`visit:source==Google;event:page==/blog`, `!=`, `*` wildcards, `\|` alternation) is **rejected** with `{"error":"filters must be valid JSON"}`. This is the single biggest incompatibility. |
| **Filter operators** | Exactly six: `is`, `is_not`, `contains`, `contains_not`, `matches`, `matches_not`. No `matches_wildcard`, no `has_done`, no `and`/`or`/`not` combinators, no nesting. |
| **Custom date range** | `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`. The Plausible form `date=YYYY-MM-DD,YYYY-MM-DD` is **not** parsed — it is ignored and the request silently falls back to `30d`. |
| **`timeseries` metrics** | One metric per request. A comma-separated list produces a single key literally named `"a,b"` whose value is the *visitors* count, because no bucket field has that name. Call the endpoint once per metric. |
| **Period list** | `realtime`, `day`, `yesterday`, `7d`, `28d`, `30d`, `91d`, `month`, `last_month`, `6mo`, `12mo`, `year`, `all`, `custom`. Unrecognised values fall back to `30d` instead of erroring. |
| **Pagination** | `limit` + `page` as in Plausible, but no total count and no `has_more` in the v1 response. `event:goal` ignores both. |
| **`event:goal` rows** | `{id, name, type, uniques, total, revenue, cr}` — not Plausible's `visitors`/`events`/`conversion_rate` naming. |
| **Metrics not implemented** | `conversion_rate`, `group_conversion_rate`, `scroll_depth` (as an aggregate metric), `time_on_page` (as an aggregate metric), `exit_rate`, `percentage`, `average_revenue`, `total_revenue`. Credible has `revenue` (a plain sum) plus `time_on_page`/`scroll_depth` as columns on `event:page` breakdowns only. |
| **Unknown metric names** | Silently dropped (`aggregate`) or silently aliased to visitors (`timeseries`), never a 400. |
| **Revenue** | A single `revenue` number in major units, summed across currencies without conversion. No per-currency splitting. |
| **Dimensions not implemented** | `visit:source_hostname`, `visit:utm_*` beyond the five listed, `event:page_match`, time dimensions (`time:day`, `time:hour`…), and any `segment:*` concept. |
| **Multi-dimension breakdown** | Not supported. `property` takes exactly one dimension. |
| **Stats API v2 / query API** | Not implemented. There is no `POST /api/v2/query`. |
| **Sites Provisioning API** | Not implemented. Sites are managed through the dashboard API in §8. |
| **Imports / exports API** | Not implemented. Use `node bin/credible.js export <domain>` for a CSV dump. |
| **`/api/v1/events`** | Credible-specific: a bearer-authenticated server-side ingestion endpoint with `ip`, `user_agent` and `timestamp` overrides. Plausible's equivalent is the unauthenticated events endpoint with `X-Forwarded-For`/`User-Agent` headers. |
| **Key scoping** | Keys are per-user, not per-site, with no scopes and no expiry. |
| **Rate limiting** | None on the Stats API. |

---

## Things this document does not cover, and things left unverified

Stated plainly, so you know where the edges are:

- **`GET /api/health`** is public and unauthenticated — it exposes the version
  string and the total event count of the whole instance. There is no way to
  turn it off.
- **`GET /_demo`** exists only when `CREDIBLE_DEV` is enabled.
- **`GET /share/:domain`** serves the SPA shell (HTML), not JSON.
- The `x-credible` header on the ingestion endpoint takes the values `ok` and
  `ignored`. It is not documented as a stable contract anywhere in the source;
  the tests do assert it.
- Behaviour under a horizontally scaled deployment is not covered here: the
  rate limiters are per-process in-memory maps, so limits multiply by the number
  of instances.
- The Plausible comparison in §9 was written from Plausible's public
  documentation, not by running Plausible. Every claim about *Credible* in this
  file was verified against the source in this repository, and the example
  responses were captured from a live seeded instance.
