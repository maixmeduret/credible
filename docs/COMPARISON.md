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
| **Price** | Free | Free | From ~$9/mo, by pageview volume | Free (GA4 360 is enterprise-priced) | Free; some plugins paid | Free |
| **Cookies** | None | None | None | Yes, by default | Configurable; cookies by default | None |
| **Consent banner needed** | No | No | No | Yes, in the EU | — (depends on configuration) | No |
| **Script size** (gzipped) | 4.5 KB | ~1 KB | ~1 KB | ~50 KB+ | ~20 KB+ | ~2 KB |
| **Storage engine** | SQLite (one file) | PostgreSQL + ClickHouse | Managed for you | Google's infrastructure | MySQL / MariaDB | PostgreSQL or MySQL |
| **Runtime** | Node.js, no dependencies | Elixir, in containers | n/a | n/a | PHP | Node.js |
| **Ops burden** | One process, one file | Docker Compose: app + 2 databases | None | None | LAMP stack + cron | App + a database server |
| **Funnels** | Included | — | On higher tiers | Yes (Explorations) | Paid plugin | — |
| **Revenue tracking** | Included | — | On higher tiers | Yes (ecommerce) | Yes (ecommerce) | — |
| **Custom event properties** | Included | Yes | On higher tiers | Yes | Yes (custom dimensions) | Yes |
| **Stats API** | Included | Yes | On higher tiers | Yes (Data API) | Yes, extensive | Yes |
| **Server-side / events API** | Included | Yes | Yes | Yes (Measurement Protocol) | Yes (HTTP Tracking API) | Yes |
| **Public shared dashboards** | Included | Yes | Yes | No (accounts required) | Yes | Yes |
| **Data retention** | Unlimited by default; configurable | Unlimited | Unlimited on current plans | 2 or 14 months for event data | Configurable | Configurable |
| **Data sampling** | Never | Never | Never | Above thresholds | Never | Never |
| **Data ownership** | Total — your disk | Total — your disk | Yours, on their EU servers | None | Total — your disk | Total — your disk |
| **License** | AGPL-3.0-or-later | AGPL-3.0 | AGPL-3.0 (hosted service) | Proprietary | GPL-3.0-or-later | MIT |

## What each one is good at

**Credible.** The argument is operational simplicity plus completeness. One Node process, one
SQLite file, zero dependencies, and no feature held back behind a tier. Back it up with `cp`,
move it with `scp`, run it on a Raspberry Pi. The cost of that simplicity is a real ceiling:
one machine, one writer, and no horizontal scaling. It is a young project without a company
behind it, which matters if you need a support contract or a compliance questionnaire
answered.

**Plausible.** The direct inspiration for this project, and the tool most people should
probably use. It is genuinely open source, privacy-first, well designed, actively maintained,
and backed by a company that will still be there next year. The cloud product is worth paying
for. Its self-hosted edition runs Postgres and ClickHouse alongside the app — exactly right
for the scale they serve, and more machinery than a personal site needs. If you want a hosted
service with support, or you have outgrown a single SQLite file, go here.

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
pleasant to look at. The main structural difference is that it expects a PostgreSQL or MySQL
server, so self-hosting is at least two moving parts rather than one. The MIT license is more
permissive than AGPL — better if you want to embed it in a closed product, worse if you want
guarantees that derivatives stay open.

## Choosing

Rough guidance rather than a verdict:

- **You buy Google Ads and need attribution across them** → Google Analytics 4.
- **You want someone else to run it, with support** → Plausible Cloud.
- **You want maximum features and can run a LAMP stack** → Matomo.
- **You want the simplest possible thing you fully own** → Credible.
- **You want something small but already run Postgres** → Umami or Credible.
- **You are past a few hundred million events, or need HA** → Plausible CE, Matomo, or a
  columnar warehouse. Credible is not the right tool at that size, and
  [says so plainly](ARCHITECTURE.md#scaling-notes).

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
- **A bigger script than Plausible's.** 4.5 KB gzipped against roughly 1 KB. The tracker is
  minified but deliberately not identifier-mangled, so it stays readable by anyone who wants
  to audit what runs on their visitors' machines — a trade of bytes for verifiability.

If any of those are dealbreakers, one of the other tools in this table is a better fit, and
you should use it.
