# How Credible compares

An honest side-by-side with the tools people actually weigh against each other. Every product
here is a reasonable choice for somebody, and several are excellent — Credible exists because
of a specific trade-off, not because the others are bad.

**How to read this.** A dash (**—**) means the answer varies, depends on configuration, or we
are not confident enough to state it. Pricing and feature tiers change often; check the
vendor before making a decision on a number in this table. Everything here reflects our
understanding at the time of writing, and corrections via pull request are welcome — that is
the fastest way to fix an error in a competitor's favour or our own.

## At a glance

| | **Credible** | **Plausible CE** (self-hosted) | **Plausible Cloud** | **Google Analytics 4** | **Matomo** (on-premise) | **Umami** (self-hosted) |
|---|---|---|---|---|---|---|
| **Price** | Free | Free | From $9/mo, by pageview volume. No free tier; 30-day trial | Free (GA4 360 is enterprise-priced) | Free; some plugins paid | Free |
| **Cookies** | None | None | None | Yes, by default | Configurable; cookies by default | None |
| **Consent banner needed** | No | No | No | Yes, in the EU | — (depends on configuration) | No |
| **Script size** (gzipped) | 4.5 KB | ~2.5 KB | ~2.5 KB | ~50 KB+ | ~20 KB+ | ~2 KB |
| **Storage engine** | SQLite (one file) | PostgreSQL + ClickHouse | Managed for you | Google's infrastructure | MySQL / MariaDB | PostgreSQL or MySQL |
| **Runtime** | Node.js, no dependencies | Elixir, in containers | n/a | n/a | PHP | Node.js |
| **Ops burden** | One process, one file | Docker Compose: app + 2 databases, 4 volumes, ≥ 2 GB RAM | None | None | LAMP stack + cron | App + a database server |
| **Funnels** | Included | **No** — Cloud only | Business plan | Yes (Explorations) | Paid plugin | — |
| **Revenue tracking** | Included | **No** — Cloud only | Business plan | Yes (ecommerce) | Yes (ecommerce) | — |
| **Custom event properties** | Included | Yes | Business plan | Yes | Yes (custom dimensions) | Yes |
| **Stats API** | Included | Yes | Business plan (600 req/hr) | Yes (Data API) | Yes, extensive | Yes |
| **Server-side / events API** | Included | Yes | Yes, all plans | Yes (Measurement Protocol) | Yes (HTTP Tracking API) | Yes |
| **Site provisioning API** | Included | **No** — Cloud only | Enterprise plan | Yes (Admin API) | — | — |
| **Public shared dashboards** | Included | Yes | Growth plan | No (accounts required) | Yes | Yes |
| **Bot filtering** | User-Agent based | User-Agent + referrer-spam lists | Both, plus ~32K data-centre IP ranges and network-wide pattern detection | — | — | — |
| **Data retention** | Unlimited by default; configurable | Configurable — it is your ClickHouse | 3 years (Starter, Growth), 5 years (Business), 5+ (Enterprise) | 2 or 14 months for event data | Configurable | Configurable |
| **Data sampling** | Never | Never | Only on views above 10M pageviews | Above thresholds | Never | Never |
| **Data ownership** | Total — your disk | Total — your disk | Yours, on their EU servers | None | Total — your disk | Total — your disk |
| **License** | AGPL-3.0-or-later | AGPL-3.0 core, plus a proprietary `extra/` directory | Same code; the premium parts are not AGPL | Proprietary | GPL-3.0-or-later | MIT |

Two footnotes on that table, because the short cells flatten something important:

- **Script size.** Plausible replaced its tracker in October 2025. The current per-site
  script (`/js/pa-<id>.js`) measures 2,493 bytes gzipped; the legacy `script.js` variants,
  still generated and still served, are around 1.3 KB. The "~1 KB Plausible script" that
  circulates in comparisons — including earlier versions of this one — is the old number.
- **License.** `plausible/analytics` is AGPL-3.0, and the JS tracker inside it is MIT so it
  is not AGPL-viral for the sites that embed it. But the repository's `extra/` directory
  carries its own license granting "no rights to use, distribute or otherwise exploit this
  software", and that is where funnels, user journeys, revenue goals, SSO, the Sites API and
  Consolidated View live. Plausible calls this an open-core model themselves. The accurate
  phrasing is "AGPL core plus a proprietary directory", not "AGPL".

## What each one is good at

**Credible.** The argument is operational simplicity plus completeness. One Node process, one
SQLite file, zero dependencies, and no feature held back behind a tier. Back it up with `cp`,
move it with `scp`, run it on a Raspberry Pi. The cost of that simplicity is a real ceiling:
one machine, one writer, and no horizontal scaling. It is a young project without a company
behind it, which matters if you need a support contract or a compliance questionnaire
answered.

**Plausible.** The direct inspiration for this project, and the tool most people should
probably use. Privacy-first, well designed, actively maintained (632 commits in the last
year), and backed by a profitable, investor-free company that will still be there next year.
The cloud product is worth paying for. Three things are worth stating precisely, because
comparisons — this one included, until recently — routinely get them wrong:

- **It is open core, not fully open source.** The core is AGPL-3.0 and the tracker is MIT,
  but funnels, user journeys, revenue goals, SSO, the Sites API and Consolidated View sit in
  a proprietary `extra/` directory that grants no rights to use or distribute it. That
  directory is not compiled into the Community Edition build at all.
- **Self-hosting is genuinely free, but it is not the whole product.** Community Edition
  gets the dashboard, goals, custom properties, segments, shared links, the Stats API, CSV
  export and Google Analytics import — a lot, and more than the $9 Cloud plan in a couple of
  places, since custom properties and the Stats API are Business-tier on Cloud and free in
  CE. It does not get the six features above, advanced bot filtering, the Looker Studio
  connector, or support. Plausible states this plainly and does not plan to change it.
- **CE ships twice a year.** Cloud ships multiple times a week. Self-hosters run software up
  to six months behind, and security fixes are not backported — the RCE patched in v3.2.1
  (CVE-2026-8467) had been present in every CE release for roughly thirteen months, and
  applying it was the self-hoster's job.

Its self-hosted edition runs Postgres and ClickHouse alongside the app, in four Docker
volumes, needing at least 2 GB of RAM — exactly right for the scale they serve, and more
machinery than a personal site needs. Plausible are candid about that cost themselves:
self-hosting is "community supported only", and they tell you to treat it as infrastructure
you maintain rather than software you install once. If you want a hosted service with
support, or you have outgrown a single SQLite file, go here.

**Google Analytics 4.** Free at any scale, unmatched in breadth, and integrated with Google
Ads and BigQuery — if you buy Google advertising, the attribution loop is a genuine advantage
no independent tool can match. The costs are the ones this whole category exists to avoid:
consent banners in the EU, sampling above thresholds, capped retention of event-level data,
a steep interface, and no ownership of the data you collect.

**Matomo.** The most feature-complete self-hosted option, with over a decade of development
behind it — ecommerce, heatmaps, session recording, A/B testing, roll-up reporting, tag
management, and a very thorough API. It is also the heaviest here: a PHP application with
MySQL, cron-driven report archiving, and a plugin marketplace where several notable features
(funnels among them) are paid add-ons. Choose it when you want depth and are prepared to run
a real LAMP stack.

**Umami.** The closest neighbour to Credible in spirit: small, cookieless, MIT-licensed, and
pleasant to look at. Nothing is held back from self-hosters — there is no open-core carve-out
— which makes it the strongest argument against Plausible CE specifically, and a fair
argument against Credible too. The main structural difference from Credible is that it
expects a PostgreSQL or MySQL server, so self-hosting is at least two moving parts rather
than one. The MIT license is more permissive than AGPL — better if you want to embed it in a
closed product, worse if you want guarantees that derivatives stay open.

## Choosing

Rough guidance rather than a verdict:

- **You buy Google Ads and need attribution across them** → Google Analytics 4.
- **You want someone else to run it, with support** → Plausible Cloud.
- **You want maximum features and can run a LAMP stack** → Matomo.
- **You want the simplest possible thing you fully own** → Credible.
- **You want something small but already run Postgres** → Umami or Credible.
- **You are past a few hundred million events, or need HA** → Plausible Cloud, Matomo, or a
  columnar warehouse. Credible is not the right tool at that size, and
  [says so plainly](ARCHITECTURE.md#scaling-notes). Note that Plausible CE is not an obvious
  answer here either: the query sampling that keeps Cloud fast on large sites lives in the
  proprietary directory, and self-hosters have reported CE struggling in the tens of millions
  of pageviews.

## Where Credible is genuinely weaker

Stated plainly, because a comparison that only flatters its author is not worth reading:

- **One machine.** SQLite means a single writer and no horizontal scaling. There is no
  clustering story, and high availability means "restore your backup quickly".
- **No hosted option.** Somebody has to run it, patch it, and hold the backups.
- **Young and small.** Less battle-testing, a smaller community, no company, no SLA, no
  certifications, and no support contract.
- **No returning-visitor metrics, ever.** Cohorts, retention curves, and cross-day user
  journeys are impossible by construction, because the salt that would link them is deleted.
  Tools that report those numbers are keeping an identifier that Credible refuses to keep.
- **Fewer features than Matomo or GA4.** No heatmaps, no session recordings, no A/B testing,
  no tag manager. Several of those are also things the privacy model rules out.
- **Coarse geography.** Country, region, and city, derived without storing an IP — not
  street-level, and not as precise as commercial databases.
- **A bigger script than Plausible's.** 4.5 KB gzipped against about 2.5 KB for Plausible's
  current tracker, or 1.3 KB for their legacy variants. The tracker is minified but
  deliberately not identifier-mangled, so it stays readable by anyone who wants to audit what
  runs on their visitors' machines — a trade of bytes for verifiability. It is still a bigger
  script, and the gap is real.
- **Much weaker bot filtering than Plausible Cloud.** Credible filters on the User-Agent.
  Plausible Cloud adds roughly 32,000 data-centre IP ranges and a traffic-pattern algorithm
  trained across every site on the network. That is not something a single instance can
  replicate — Plausible make the same argument about their own Community Edition, and it is
  correct. Expect more junk in Credible's numbers than in Plausible Cloud's.
- **No importers and no Search Console.** Plausible imports GA4 history and CSV exports, and
  pulls search queries, impressions and positions live from Google Search Console. Credible
  has none of that; importers are on the roadmap and nothing more.
- **Fewer years of edge cases.** Plausible has been shipping since 2018 with a paid team
  behind it. Channel classification, referrer parsing, device detection and bot lists are
  where that accumulated work is least visible and most valuable.

If any of those are dealbreakers, one of the other tools in this table is a better fit, and
you should use it.

---

**Last verified: 16 August 2026.** The Plausible rows were checked against Plausible's own
documentation and pricing (plausible.io/docs, plausible.io/self-hosted-web-analytics,
plausible.io/data-policy, and the pricing block on plausible.io), the `plausible/analytics`
and `plausible/community-edition` repositories including `mix.exs`, `extra/COPYING.txt`,
`compose.yml`, `priv/plans_v5.json` and the release history, plus a direct measurement of the
served tracker script. Google Analytics, Matomo and Umami rows are older and were not
re-verified in that pass, beyond Matomo's GPL-3.0 and Umami's MIT licensing; treat their
figures with more suspicion than the Plausible ones, and please correct them.
