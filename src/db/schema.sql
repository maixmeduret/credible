-- Credible — database schema (SQLite)
--
-- Design notes
-- ------------
-- * Everything is append-mostly. `events` is the source of truth; `visits` is a
--   maintained aggregate used for session-scoped metrics (bounce rate, visit
--   duration, entry/exit pages) so we never have to self-join `events`.
-- * No column in this schema can identify a person. `visitor_id` is a truncated
--   hash of (rotating daily salt + site + ip + user agent) and is unrecoverable
--   once the salt is discarded (see `daily_salts`, purged after 48h).
-- * Timestamps are unix seconds, UTC. Timezone bucketing happens in JS so that
--   DST transitions are exact (see src/util/time.js).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- accounts --

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL,
  name          TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- Dashboard login sessions (cookie based).
CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);

-- ------------------------------------------------------------------ sites --

CREATE TABLE IF NOT EXISTS sites (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  domain             TEXT    NOT NULL,
  timezone           TEXT    NOT NULL DEFAULT 'UTC',
  public             INTEGER NOT NULL DEFAULT 0,  -- 1 = dashboard readable by anyone
  excluded_paths     TEXT    NOT NULL DEFAULT '', -- newline separated globs
  excluded_ips       TEXT    NOT NULL DEFAULT '', -- newline separated
  excluded_countries TEXT    NOT NULL DEFAULT '', -- comma separated ISO alpha-2
  allowed_hostnames  TEXT    NOT NULL DEFAULT '', -- comma separated; empty = accept any
  bot_filtering      TEXT    NOT NULL DEFAULT 'standard', -- 'off' | 'standard' | 'strict'
  currency           TEXT    NOT NULL DEFAULT 'EUR',
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_domain_idx ON sites (domain);

CREATE TABLE IF NOT EXISTS site_members (
  site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    TEXT    NOT NULL DEFAULT 'viewer', -- owner | admin | viewer
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS site_members_user_idx ON site_members (user_id);

-- Read-only public dashboard links, optionally password protected.
CREATE TABLE IF NOT EXISTS shared_links (
  slug          TEXT    PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  name          TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_links_site_idx ON shared_links (site_id);

-- Stats API credentials (Bearer tokens). Only the hash is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',
  key_hash     TEXT    NOT NULL,
  key_prefix   TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);

-- ------------------------------------------------------------ privacy key --

-- One salt per UTC day. Rows older than 48h are deleted, which makes every
-- visitor_id computed with them permanently un-reversible and un-linkable.
CREATE TABLE IF NOT EXISTS daily_salts (
  day        TEXT PRIMARY KEY,   -- YYYY-MM-DD (UTC)
  salt       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------- events --

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,           -- unix seconds, UTC
  name            TEXT    NOT NULL,           -- 'pageview' | 'engagement' | custom goal
  visitor_id      TEXT    NOT NULL,
  visit_id        INTEGER NOT NULL,

  hostname        TEXT    NOT NULL DEFAULT '',
  pathname        TEXT    NOT NULL DEFAULT '/',

  -- acquisition
  channel         TEXT    NOT NULL DEFAULT 'Direct',  -- Direct | Organic Search | Paid Search | Organic Social | Paid Social | Referral | Email | Organic Video | Unknown
  referrer_source TEXT    NOT NULL DEFAULT 'Direct',  -- 'Google', 'Hacker News', 'example.com'
  referrer        TEXT    NOT NULL DEFAULT '',        -- host + path, never a query string
  utm_source      TEXT    NOT NULL DEFAULT '',
  utm_medium      TEXT    NOT NULL DEFAULT '',
  utm_campaign    TEXT    NOT NULL DEFAULT '',
  utm_content     TEXT    NOT NULL DEFAULT '',
  utm_term        TEXT    NOT NULL DEFAULT '',

  -- geography (coarse: derived from IP at ingest, IP never stored)
  country_code    TEXT    NOT NULL DEFAULT '',
  region          TEXT    NOT NULL DEFAULT '',
  city            TEXT    NOT NULL DEFAULT '',

  -- technology
  browser         TEXT    NOT NULL DEFAULT '',
  browser_version TEXT    NOT NULL DEFAULT '',
  os              TEXT    NOT NULL DEFAULT '',
  os_version      TEXT    NOT NULL DEFAULT '',
  device          TEXT    NOT NULL DEFAULT '',  -- Desktop | Mobile | Tablet
  screen_size     TEXT    NOT NULL DEFAULT '',  -- Mobile | Tablet | Laptop | Desktop

  -- custom event payload
  props           TEXT    NOT NULL DEFAULT '',  -- JSON object, flat, string values
  revenue         INTEGER,                      -- minor currency units
  currency        TEXT    NOT NULL DEFAULT '',

  -- engagement events (accurate time on page + scroll depth)
  engagement_time INTEGER NOT NULL DEFAULT 0,   -- milliseconds
  scroll_depth    INTEGER NOT NULL DEFAULT 0    -- 0..100
);

CREATE INDEX IF NOT EXISTS events_site_ts_idx    ON events (site_id, timestamp);
CREATE INDEX IF NOT EXISTS events_site_name_idx  ON events (site_id, name, timestamp);
CREATE INDEX IF NOT EXISTS events_visit_idx      ON events (visit_id);
CREATE INDEX IF NOT EXISTS events_site_path_idx  ON events (site_id, pathname, timestamp);

-- ----------------------------------------------------------------- visits --

-- A visit ends after 30 minutes of inactivity (see INACTIVITY_TIMEOUT).
CREATE TABLE IF NOT EXISTS visits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         INTEGER NOT NULL,
  visitor_id      TEXT    NOT NULL,
  started_at      INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  duration        INTEGER NOT NULL DEFAULT 0,  -- seconds
  pageviews       INTEGER NOT NULL DEFAULT 0,
  events          INTEGER NOT NULL DEFAULT 0,
  is_bounce       INTEGER NOT NULL DEFAULT 1,
  entry_page      TEXT    NOT NULL DEFAULT '',
  exit_page       TEXT    NOT NULL DEFAULT '',

  -- acquisition/tech/geo of the first hit, denormalised for session metrics
  channel         TEXT    NOT NULL DEFAULT 'Direct',
  referrer_source TEXT    NOT NULL DEFAULT 'Direct',
  referrer        TEXT    NOT NULL DEFAULT '',
  utm_source      TEXT    NOT NULL DEFAULT '',
  utm_medium      TEXT    NOT NULL DEFAULT '',
  utm_campaign    TEXT    NOT NULL DEFAULT '',
  utm_content     TEXT    NOT NULL DEFAULT '',
  utm_term        TEXT    NOT NULL DEFAULT '',
  country_code    TEXT    NOT NULL DEFAULT '',
  region          TEXT    NOT NULL DEFAULT '',
  city            TEXT    NOT NULL DEFAULT '',
  browser         TEXT    NOT NULL DEFAULT '',
  browser_version TEXT    NOT NULL DEFAULT '',
  os              TEXT    NOT NULL DEFAULT '',
  os_version      TEXT    NOT NULL DEFAULT '',
  device          TEXT    NOT NULL DEFAULT '',
  screen_size     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS visits_lookup_idx  ON visits (site_id, visitor_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS visits_site_ts_idx ON visits (site_id, started_at);

-- ------------------------------------------------------- goals & funnels --

CREATE TABLE IF NOT EXISTS goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  type         TEXT    NOT NULL,           -- 'event' | 'page'
  event_name   TEXT    NOT NULL DEFAULT '',
  page_path    TEXT    NOT NULL DEFAULT '', -- supports a trailing '*' wildcard
  display_name TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_site_idx ON goals (site_id);

CREATE TABLE IF NOT EXISTS funnels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS funnels_site_idx ON funnels (site_id);

CREATE TABLE IF NOT EXISTS funnel_steps (
  funnel_id  INTEGER NOT NULL REFERENCES funnels (id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  goal_id    INTEGER NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  PRIMARY KEY (funnel_id, step_index)
);

-- --------------------------------------------------- segments & annotations --

-- A named, reusable set of filters. 'personal' is visible only to its owner,
-- 'site' to everyone who can read the site.
CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  filters    TEXT    NOT NULL,            -- the same JSON wire format as ?filters=
  scope      TEXT    NOT NULL DEFAULT 'personal', -- 'personal' | 'site'
  owner_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_site_idx ON segments (site_id);

-- A dated note on the graph: a launch, a campaign, an outage.
CREATE TABLE IF NOT EXISTS annotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,            -- YYYY-MM-DD in the site's timezone
  text       TEXT    NOT NULL,
  author_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_site_date_idx ON annotations (site_id, date);

-- ------------------------------------------------------- reports and alerts --

CREATE TABLE IF NOT EXISTS email_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  frequency    TEXT    NOT NULL DEFAULT 'weekly',  -- 'weekly' | 'monthly'
  recipients   TEXT    NOT NULL DEFAULT '',        -- comma separated
  send_hour    INTEGER NOT NULL DEFAULT 9,         -- 0-23, in the site's timezone
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_reports_site_idx ON email_reports (site_id);

CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  type           TEXT    NOT NULL DEFAULT 'spike',  -- 'spike' | 'drop'
  threshold      INTEGER NOT NULL DEFAULT 10,       -- current visitors, or % for a drop
  recipients     TEXT    NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  cooldown_hours INTEGER NOT NULL DEFAULT 12,
  last_fired_at  INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_site_idx ON alerts (site_id);
