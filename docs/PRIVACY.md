# Privacy

Credible is built so that there is nothing sensitive to protect. Not "we protect it well" —
there is no personal data in the database to begin with. This document explains exactly what
is collected, how visitors are counted without identifying them, and why an instance does not
need a cookie banner.

> **This is not legal advice.** It is a precise description of what the software does, so
> that you or your lawyer can assess it against your obligations. You are the data controller
> for your instance, and jurisdictions differ.

- [What is collected](#what-is-collected)
- [What is never collected](#what-is-never-collected)
- [How visitors are counted](#how-visitors-are-counted)
- [A worked example](#a-worked-example)
- [What a stored row looks like](#what-a-stored-row-looks-like)
- [Why no consent banner is needed](#why-no-consent-banner-is-needed)
- [Data ownership](#data-ownership)
- [GDPR and DPA FAQ](#gdpr-and-dpa-faq)

## What is collected

Everything below is either sent by the browser on any ordinary HTTP request, or derived from
it at the moment of the request. Nothing is read from the visitor's device.

| Collected | Where it comes from | Stored as |
|---|---|---|
| Page URL | The page itself | Hostname and path, **without the query string**, apart from recognised UTM parameters |
| Referrer | `Referrer` header / `document.referrer` | Host and path only, never a query string |
| Acquisition channel and source | Classified from the referrer and UTM tags | `Organic Search`, `Referral`, `Google`, … |
| UTM campaign tags | The URL, when present | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` |
| Country, region, city | Looked up from the IP **in memory**, then the IP is discarded | Coarse names / country code |
| Browser and version | `User-Agent` header | `Chrome`, `120` |
| Operating system and version | `User-Agent` header | `macOS`, `10.15` |
| Device type | `User-Agent` header | `Desktop`, `Mobile`, `Tablet` |
| Screen size bucket | Screen width | `Mobile`, `Tablet`, `Laptop`, `Desktop` |
| Timestamp | Server clock | Unix seconds, UTC |
| Visitor ID | A daily-rotating salted hash — see below | 22 characters, unlinkable after 48h |
| Engagement time and scroll depth | Measured on the page | Milliseconds; a percentage |
| Custom event properties | Only what **you** choose to send | A flat JSON object of string values |
| Revenue | Only what **you** choose to send | Minor currency units + currency code |

Two things deserve emphasis. **Query strings are dropped** apart from UTM parameters, because
they routinely contain session tokens, email addresses, password reset codes, and search
terms. And **custom properties are entirely under your control** — if you put a user's email
address in one, it will be stored, and that is your decision and your responsibility, not
something the software does on its own.

## What is never collected

- **No cookies.** The tracker sets none, of any kind, first-party or otherwise.
- **No `localStorage`, `sessionStorage`, or IndexedDB.** The tracker never writes to the
  visitor's device. This is the technically load-bearing fact for ePrivacy.
- **No fingerprinting.** No canvas, WebGL, audio, font enumeration, or hardware probing. No
  attempt to build a stable device identifier.
- **No raw IP addresses on disk.** An IP exists in server memory for the duration of one
  request, is used to derive a country and to feed the hash, and is then gone. It is not
  written to the database and not written to the application log.
- **No cross-site tracking.** Each site's data is separate, and the visitor hash is salted
  per site, so the same person on two sites in the same instance produces two unrelated IDs.
  There is no way to follow anyone between sites, and no third party receives anything.
- **No individual profiles, and no way to build one.** There is no user-level export, because
  there is no user.
- **No data sold, shared, or sent anywhere.** The software makes no outbound connections for
  analytics, telemetry, or licensing.

## How visitors are counted

Counting unique visitors normally requires a persistent identifier — a cookie, or a
fingerprint. Credible uses neither. Instead each event gets a hash. This is the actual
implementation, from `src/ingest/salt.js`:

```js
crypto.createHash('sha256')
  .update(`${salt}|${siteId}|${ip}|${userAgent}`)
  .digest('base64url')
  .slice(0, 22);
```

That is: a SHA-256 of the day's secret salt, the site, the IP address, and the user agent,
encoded as base64url and truncated to 22 characters.

Four properties make this safe:

1. **The salt is random and secret.** It is generated on your server, never leaves it, and is
   not derived from anything guessable.
2. **It rotates every day.** At the UTC day boundary a new salt is generated. The same person
   visiting today and tomorrow produces two completely unrelated IDs.
3. **Salts are deleted after 48 hours.** This is the crucial part. Once the salt is gone, the
   hash cannot be recomputed or checked against any candidate — not by an attacker with the
   database, not by a court order, not by you. The link between a hash and a person is
   destroyed permanently, and the retained hashes become anonymous statistics.
4. **The IP is never stored** alongside the hash, so there is nothing to correlate it with.

The 48-hour window exists because a visit that starts at 23:59 must still be joinable to its
own pageview at 00:01, and because the server must handle a late-arriving event. Nothing
needs the salt after that, so it is deleted.

The practical consequence is that Credible measures **unique visitors per day** accurately,
and deliberately cannot measure returning visitors across days, cohorts, or individual user
journeys over time. That is a real limitation and an intentional one: those numbers cannot be
produced without tracking people.

## A worked example

Every value below is a real output of the code above, and you can reproduce all of them
yourself — every input is given in full, with nothing elided. Two different people visit the
same site from the same office, with the same browser:

```
salt (day 1)  kJ8sV2mQ9xR4tN7pL1wZ6yB3cF5hD0gA8eK2jM4nP6s=     (32 random bytes, base64)
site id       1
user agent    Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
              (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36

Person A   ip 203.0.113.42
  = mSOapnCR1-onCjquVV_kY61Jrmnj3Lttx1MlPyh3yqg     (full digest, 43 characters)
  → stored as  mSOapnCR1-onCjquVV_kY6                (first 22 characters)

Person B   ip 203.0.113.43
  = iw910rEkpWqqz29hV6RACGK6m7quTuejHI3OIQ6JE8Y
  → stored as  iw910rEkpWqqz29hV6RACG
```

One digit of difference in the input produces a completely unrelated output, so the two are
counted as two visitors. Tomorrow a new salt is generated — say
`fB+dSy5qBYN/TB2SqzDl9tgbR6DJ4jWPa00QrH6TXyg=` — and **Person A, same IP, same browser, same
site**, becomes:

```
Person A, day 2  →  A_C1uKraLw4SzH2iRxHkU-
```

And the same person on a *different site* (site id `2`) in the same instance, on the same
day, is:

```
Person A, site 2  →  mEddcEwnZr1QOE1KA-kIq7
```

Check any of these for yourself — this prints Person A's day-1 id:

```bash
node --input-type=module -e 'import crypto from "node:crypto";
const salt = "kJ8sV2mQ9xR4tN7pL1wZ6yB3cF5hD0gA8eK2jM4nP6s=";
const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
console.log(crypto.createHash("sha256").update(`${salt}|1|203.0.113.42|${ua}`).digest("base64url").slice(0, 22));'
```

Nothing connects `mSOapnCR1-onCjquVV_kY6` to `A_C1uKraLw4SzH2iRxHkU-`, or to
`mEddcEwnZr1QOE1KA-kIq7`. Two days later the first salt has been deleted, and at that point
nobody can ever determine that `mSOapnCR1-onCjquVV_kY6` came from `203.0.113.42` — the only
way to check would be to recompute the hash, and the required ingredient no longer exists
anywhere.

Note that the hash is truncated to 22 of its 43 characters before storage, so even while the
salt exists, more than one input maps to the same stored value. This is a deliberate trade: a
negligible collision rate in exchange for a permanent ambiguity that works in the visitor's
favour.

Salt deletion is enforced in code, not by policy — `purgeOldSalts()` runs during ingestion
and deletes every salt older than 48 hours. You can confirm it yourself:
`sqlite3 data/credible.db "SELECT day FROM daily_salts;"` never returns more than three rows.

## What a stored row looks like

This is a complete event as it exists in the `events` table. There is no hidden column.

| Column | Value |
|---|---|
| `timestamp` | `1786694400` |
| `name` | `pageview` |
| `visitor_id` | `mSOapnCR1-onCjquVV_kY6` |
| `visit_id` | `48213` |
| `hostname` | `yourdomain.com` |
| `pathname` | `/pricing` |
| `channel` | `Organic Search` |
| `referrer_source` | `Google` |
| `referrer` | `google.com` |
| `utm_source` … `utm_term` | *(empty)* |
| `country_code` | `FR` |
| `region` | `Île-de-France` |
| `city` | `Paris` |
| `browser` / `browser_version` | `Chrome` / `120` |
| `os` / `os_version` | `macOS` / `10.15` |
| `device` / `screen_size` | `Desktop` / `Desktop` |
| `props` | *(empty)* |
| `revenue` / `currency` | *(empty)* |
| `engagement_time` | `42000` |
| `scroll_depth` | `85` |

Look at what is absent: no IP address, no cookie ID, no user ID, no email, no name, no
device identifier, no query string, and nothing that persists across days. After 48 hours,
`visitor_id` is a number that refers to nobody.

The `visits` table stores one row per visit with the same kind of fields plus session
metrics (duration, pageviews, bounce, entry and exit page). It contains no additional
categories of data.

## Why no consent banner is needed

Two separate laws are usually at stake in the EU and UK. Credible is designed to clear both,
but the conclusion depends on your configuration and your jurisdiction, so read this as the
reasoning rather than as a guarantee.

**ePrivacy Directive / PECR — the "cookie law".** This one is not about personal data at all;
it governs *storing or accessing information on a user's device*. It is why cookie banners
exist, and it applies regardless of whether the stored value identifies anyone. Credible sets
no cookie and writes nothing to `localStorage`, `sessionStorage`, IndexedDB, or any other
client-side store, and reads nothing back. Because there is no access to the terminal
equipment, the consent requirement in Article 5(3) is not triggered. This is a factual
property of the tracker, and you can verify it yourself by reading `public/js/cr.js` or
opening the Application tab of your browser's devtools on a page that uses it.

**GDPR.** The data described above is not personal data once the salt is deleted, but an IP
address *is* personal data at the moment it is processed in memory, so a lawful basis is
needed for that brief processing. The usual basis is **Article 6(1)(f), legitimate
interests**: understanding how your own website is used is a legitimate interest; the
processing is necessary to do it; and the balancing test against the visitor's rights is
about as favourable as it gets, because the processing is transient, produces only aggregate
statistics, involves no profiling or automated decision-making, is not shared with anyone,
and cannot be used to reach or single out the person. Consent under Article 6(1)(a) is not
the only available basis, which is what makes a banner unnecessary.

Recital 26 is the other half: data that has been anonymised such that the subject is no
longer identifiable falls outside the GDPR entirely. Deleting the salt is what takes the
stored rows across that line — irreversibly, not merely by policy.

**What you should still do.** Mention analytics in your privacy policy: say that you use a
self-hosted, cookieless analytics tool, that no personal data is stored, and that no data
leaves your infrastructure. Transparency under Articles 13 and 14 is a separate obligation
from consent, and it is cheap to satisfy honestly here.

**Where this reasoning can break.** If you deliberately put personal data into custom event
properties, or you place identifiers in URLs that end up in stored paths, then your instance
does hold personal data and the analysis above no longer applies to it. Some regulators and
some sectors take stricter positions than the mainstream reading, and rules outside the
EU/UK differ. If the stakes are high, ask a lawyer — a short review is inexpensive next to
the cost of guessing.

## Data ownership

The database file is on a disk you control. Nobody else has a copy, and there is no vendor.

- **No third party is involved.** The software phones nobody home. There is no license
  check, no usage telemetry, no error reporting service, no CDN dependency, no hosted API.
  You can run an instance permanently airgapped from everything except your own website's
  visitors.
- **The data is portable.** `node bin/credible.js export yourdomain.com` writes CSV to
  stdout, and the database is a standard SQLite file you can query with any SQLite client.
- **The data is deletable.** Stop the process and delete `data/credible.db`. That is the
  entire erasure procedure. Set `CREDIBLE_RETENTION_DAYS` to age out raw events
  automatically.
- **You are the controller** for your instance, and — since there is no processor — there is
  nobody for you to sign a data processing agreement with.

## GDPR and DPA FAQ

**Do I need a cookie banner?**
Not for Credible, because it stores nothing on the visitor's device and there is no consent
requirement to satisfy. If other tools on your site set cookies, you still need a banner for
those.

**Do I need a Data Processing Agreement?**
No. A DPA is an agreement between a controller and a processor. Self-hosting means there is
no processor: the data never leaves your infrastructure. If your hosting provider stores the
disk, they may be your processor for infrastructure purposes — that is a contract you already
have with them, and unrelated to this software.

**Is a visitor hash personal data?**
While the salt still exists (under 48 hours), treat it as pseudonymous data — it is derived
from an IP and is theoretically re-identifiable by someone holding both the salt and a list
of candidate IPs. After the salt is deleted, it is anonymous under Recital 26, because
re-identification is no longer possible by any means. The 48-hour window is the honest answer
to this question.

**Do international transfers apply?**
Only if you host the instance outside your own jurisdiction. The software transfers nothing
anywhere; your hosting choice is the only variable. Host it in the EU and there is no
transfer to assess.

**How do I answer a data subject access or erasure request?**
Explain that your analytics store no personal data and hold no identifier that could locate
that person's records — there is nothing to search by, which is a direct consequence of the
design. Keep a copy of this document to substantiate it.

**Is this valid in Germany, Austria, France, or Italy?**
The cookieless, no-personal-data, self-hosted configuration is the approach that survived the
national decisions against Google Analytics, which turned on transfers to the US and on
persistent identifiers — neither of which exists here. The strictest DPAs have been more
demanding than the mainstream reading; if you operate in one of these jurisdictions, get the
setup reviewed locally.

**Does CCPA apply?**
The CCPA governs personal information, and Credible stores none, so the sale/sharing and
access provisions have no subject matter. Mention analytics in your privacy notice anyway.

**Is it HIPAA-safe? PCI-safe?**
Those depend on your whole system, not on one component. The relevant property is that
Credible stores no identifiers by default — but if your URLs contain patient or cardholder
identifiers, those end up in stored paths. Do not put such identifiers in URLs or in custom
properties.

**Can I prove any of this?**
Yes, and you should. The source is AGPL-licensed and small: the tracker is a single readable
file, and the schema in `src/db/schema.sql` lists every column that exists. Open devtools and
confirm that no cookie is set and no storage is written. Do not take this document's word
for it.
