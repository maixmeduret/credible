# Integrations

Getting Credible onto a site, whatever that site is built with.

Everything in this directory is a client of one HTTP contract: load `/js/cr.js` from your
instance with a `data-domain` attribute, and events post themselves to `/api/event`. Nothing
here stores or displays statistics — your instance does that. If your platform is not listed,
[the snippet](#every-other-platform) works everywhere and takes thirty seconds.

| | What it is | Install without code | Serves from your own domain | Typed API |
|---|---|:---:|:---:|:---:|
| **[WordPress](./wordpress)** | A real plugin, settings screen and all | yes | **yes** | — |
| **[Google Tag Manager](./gtm)** | Custom template + install tag | yes | no | — |
| **[npm](./npm)** | `credible-tracker`, a thin wrapper | no | via your own proxy | **yes** |
| **[The snippet](#every-other-platform)** | Four lines of HTML | paste | no | — |

**"Serves from your own domain"** is the column that matters most and is easiest to overlook.
Content blockers filter requests by hostname, so a tracker loaded from `stats.example.com` is
missing from a real slice of your traffic while the same file loaded from `example.com` is not.
Only the WordPress plugin does this for you; everywhere else it means putting a reverse proxy in
front of your site yourself, which is [documented but manual](../docs/TRACKING.md#data-api).

---

## How to install Credible on…

### WordPress

Install the plugin from [`integrations/wordpress`](./wordpress), activate it, and fill in your
instance URL under **Settings → Credible**. It defaults the site domain to your own hostname,
keeps your logged-in editing sessions out of the numbers, and previews the exact tag it will
print. Then tick **Enable the proxy** and set `CREDIBLE_TRUST_PROXY=true` on your instance:
WordPress will serve the tracker and forward events from your own domain, under a random path
prefix, which is the one thing a plugin can do that pasting a snippet cannot. Rewrite rules give
the pretty paths, with REST API routes as an automatic fallback when permalinks are set to
Plain.

### Google Tag Manager

Two tags. First a **Custom HTML** tag on All Pages carrying the snippet plus the four-line async
stub — GTM's sandbox cannot put a `data-domain` attribute on an injected script, and the tracker
needs one, so the install has to be Custom HTML rather than a template. Then import
[`template.tpl`](./gtm/template.tpl) so your team can add conversion events, properties and
revenue from the GTM UI with no JavaScript. The template asks for exactly two permissions and
touches nothing but `window.credible`. Full reasoning and a five-minute verification procedure
in [`integrations/gtm/README.md`](./gtm/README.md).

### React, Next.js, Vue, Svelte, Astro

`npm install credible-tracker`, then `init({ instanceUrl, domain })` once at the root of the app
and `trackEvent('Signup')` anywhere. It is MIT-licensed — the rest of Credible is AGPL, and code
that lands in your bundle must not be — with TypeScript declarations, ESM and CommonJS builds,
and no dependencies. It is a loader, not a copy of the tracker: your bundle grows by about 1 KB
and the tracker itself is fetched from your instance and cached by the browser. Server-side
rendering is a no-op rather than a crash, and `init()` is idempotent so React StrictMode's double
mount injects one script. Framework-by-framework snippets in
[`integrations/npm/README.md`](./npm/README.md).

The one thing to get right: **do not call `trackPageview()` on route changes.** The tracker
already wraps `history.pushState`, so every client-side router is counted automatically, and
adding a route effect double-counts every page.

### Every other platform

Paste this into `<head>`:

```html
<script defer data-domain="example.com" src="https://stats.example.com/js/cr.js"></script>
```

That is the whole integration for Astro, Hugo, Jekyll, Eleventy, Ghost, Shopify, Squarespace,
Webflow, Rails, Django, Laravel, Phoenix, plain HTML, and anything else that lets you edit a
template. Your dashboard shows you this exact line with your values already filled in, under
**Site settings**.

Mobile apps, backends, webhooks and cron jobs do not need a script at all — they can post to the
authenticated events endpoint instead. See [docs/API.md](../docs/API.md).

---

## What every integration configures

All of them set the same handful of `data-*` attributes; they differ only in how you type them.
[docs/TRACKING.md](../docs/TRACKING.md#2-script-tag-attributes) is the reference.

| Attribute | | WordPress | GTM | npm |
|---|---|---|---|---|
| `data-domain` | site(s), required | Site domain | in the install tag | `domain` |
| `data-api` | endpoint override | set by the proxy | in the install tag | `api` |
| `data-hash` | `#fragments` are pages | Hash-based routing | in the install tag | `hash` |
| `data-exclude` | paths never tracked | Excluded pages | in the install tag | `exclude` |
| `data-respect-dnt` | honour Do Not Track | Honour Do Not Track | in the install tag | `respectDnt` |
| `data-track-localhost` | count local traffic | Count local traffic | in the install tag | `trackLocalhost` |
| `data-debug` | explain dropped events | Console debugging | in the install tag | `debug` |

And all of them reach the same JavaScript API once loaded:

```js
credible('Signup', { props: { plan: 'pro' } });
credible('Purchase', { revenue: { amount: 19.99, currency: 'EUR' } });
credible.trackPageview({ url: 'https://example.com/checkout/step-2' });
```

Or with no JavaScript at all, by tagging the markup:

```html
<button class="credible+Signup">Sign up</button>
<button data-credible-event-name="Signup" data-credible-event-plan="pro">Sign up</button>
```

---

## What none of them do

Stated plainly, so nobody goes looking:

- **No consent banner is required, and none is provided.** No cookies are set and no personal
  data is collected, so there is nothing for a visitor to consent to. Do not add one for
  Credible's sake.
- **No outbound-link or file-download switch.** Both are compiled into the single tracker
  script and are always on. Credible has one script, not a family of variants, so there is no
  attribute to expose. The WordPress settings screen says this in place rather than showing a
  toggle that does nothing.
- **No way to suppress the first pageview.** The tracker sends one when it loads. Nothing
  removes it.
- **No historical import.** Every integration starts your dashboard at zero. See
  [docs/TRACKING.md](../docs/TRACKING.md#historical-data).
- **No Shopify app, no Wix app, no Drupal or Joomla module.** The snippet works on all of them;
  nobody has packaged it.

---

## Licences

Deliberately not all the same, because the licence has to suit where the code ends up.

| | Licence | Why |
|---|---|---|
| The Credible server, dashboard, CLI | AGPL-3.0-or-later | The repository's licence. It protects the part somebody could run as a service |
| `integrations/wordpress` | GPL-2.0-or-later | What WordPress.org requires. A separate program that talks HTTP to the server |
| `integrations/npm` | MIT | It is bundled into consumers' applications. AGPL there would be a licensing trap |
| `integrations/gtm` | AGPL-3.0-or-later | Nothing is distributed; the template runs in the user's own container |

The npm split is the same one Plausible makes, and for the same reason. Longer version in
[`integrations/npm/README.md`](./npm/README.md#licensing-and-why-it-matters-here).

> **One inconsistency, named rather than hidden.** The tracker file your instance serves
> (`public/js/cr.js`) carries an AGPL-3.0 banner inherited from the repository licence. It is
> fetched over the network and never linked into anybody's build, so it does not reach a
> consumer's application — but it runs on third-party pages, which is exactly the situation
> MIT exists for, and Plausible licenses their equivalent file MIT. Relicensing
> `tracker/src/credible.js` and the banner in `tracker/build.js` would remove the last piece of
> licence ambiguity for anyone embedding Credible.

---

## Testing

Every integration is covered by the repository's normal runner:

```bash
node --test
```

| | What runs | Needs |
|---|---|---|
| npm | 50 tests, against the built ESM **and** CommonJS files | nothing |
| GTM | 9 structural tests over `template.tpl` | nothing |
| WordPress | 7 static checks, always | nothing |
| WordPress | 84 assertions over the plugin's logic | a PHP binary |

The PHP suite skips with an explanatory message when there is no PHP, rather than making a Node
project depend on a PHP toolchain. To run it anyway:

```bash
CREDIBLE_PHP="docker run --rm -v $PWD:/app -w /app php:7.4-cli-alpine php" node --test
```

---

## Contributing an integration

The bar is the one in [CONTRIBUTING.md](../CONTRIBUTING.md), plus two things specific to here:

1. **No dependencies, in the integration itself.** The npm package has none, the plugin has
   none, the template has none. An integration is a place people are least willing to accept a
   supply chain.
2. **Nothing may half-work.** If a platform cannot support a feature — as GTM cannot inject a
   configured script — say so in the README and leave the feature out. A tag that reports
   success while measuring nothing costs somebody a month of data before they notice.
