# credible-tracker

A thin wrapper around the [Credible](https://github.com/maixmeduret/credible) browser tracker,
for apps that would rather `npm install` than paste a `<script>` tag.

```bash
npm install credible-tracker
```

```js
import { init, trackEvent } from 'credible-tracker';

init({ instanceUrl: 'https://stats.example.com', domain: 'example.com' });

trackEvent('Signup', { props: { plan: 'pro' } });
```

No dependencies. No cookies. No consent banner needed. About 1 KB in your bundle.

- [What this package is, and is not](#what-this-package-is-and-is-not)
- [Licensing, and why it matters here](#licensing-and-why-it-matters-here)
- [API](#api)
- [Framework recipes](#framework-recipes) — [React](#react) · [Next.js](#nextjs) ·
  [Vue](#vue) · [Svelte / SvelteKit](#svelte--sveltekit) · [Astro](#astro)
- [Proxying through your own domain](#proxying-through-your-own-domain)
- [TypeScript](#typescript)
- [Building and testing](#building-and-testing)

---

## What this package is, and is not

**It is a loader.** `init()` builds a `<script>` tag with the right `data-*` attributes and
appends it to `<head>`. `trackEvent()` and `trackPageview()` forward to `window.credible`,
queueing calls made before the script has arrived.

**It is not a reimplementation of the tracker.** Every tracking decision — what counts as an
outbound link, how engaged time is measured, when a `pushState` is a new pageview, how the
ingestion endpoint is derived from the script URL — lives in `tracker/src/credible.js` and is
served by your own instance at `/js/cr.js`. Two copies of that logic would drift apart, and
inlining it would add 13 KB to your bundle to duplicate a file the browser caches for a day
anyway.

The practical consequences, which are worth knowing before you install:

| | |
|---|---|
| The tracker is fetched at runtime | from **your** instance, not from a CDN and not from npm |
| Your bundle grows by | ~1 KB (this wrapper), not ~13 KB (the tracker) |
| Upgrading the tracker | happens when you upgrade your instance; no `npm update` needed |
| If your instance is down | `init()` still returns, `onError` fires, your app is unaffected |
| Version of this package | tracks the wrapper's API, **not** your instance's version |

---

## Licensing, and why it matters here

**This package is MIT. The rest of Credible is AGPL-3.0-or-later.** That split is deliberate,
and it is the same one Plausible makes.

AGPL is a copyleft licence: code you link into your own program pulls that program under the
same terms. A `npm install` that quietly put AGPL source inside a proprietary app's bundle
would be a licensing trap, not a convenience. So the code that actually ends up in your build
output — this wrapper, and only this wrapper — is MIT, and you can ship it in a closed-source
product with nothing more than the copyright notice in `LICENSE`.

The Credible **server** you run stays AGPL-3.0-or-later. That is the part the licence is meant
to protect: if you host a modified Credible and let other people use it over a network, you owe
them the source. Self-hosting it for your own sites, unmodified, asks nothing of you.

> **One honest wrinkle.** The tracker file your instance serves (`public/js/cr.js`) currently
> carries an `AGPL-3.0` banner, inherited from the repository-wide licence. It is loaded over
> the network at runtime and is never linked into your bundle, so it does not reach your
> application — but the banner is still the wrong signal for a file that runs on third-party
> pages. Plausible licenses the equivalent file MIT for exactly this reason, and Credible
> should too. Track it at
> [maixmeduret/credible/issues](https://github.com/maixmeduret/credible/issues); nothing in
> this package depends on the outcome.

---

## API

### `init(options)`

Loads the tracker. Returns the `<script>` element, or `null` during server-side rendering.

```js
init({
  instanceUrl: 'https://stats.example.com',  // required (unless `src` is given)
  domain: 'example.com',                     // required
});
```

| Option | Type | Maps to | Notes |
|---|---|---|---|
| `instanceUrl` | `string` | the `src` origin | Origin of your instance. Sub-paths work: `https://example.com/stats` |
| `domain` | `string \| string[]` | `data-domain` | Exactly as added in the dashboard. A list sends one request per domain |
| `src` | `string` | the `src` | Full script URL, overriding `instanceUrl` + `scriptPath` |
| `scriptPath` | `string` | | Defaults to `/js/cr.js` |
| `api` | `string` | `data-api` | Ingestion endpoint, when you proxy events |
| `hash` | `boolean` | `data-hash` | Treat `#fragments` as pages (hash routers) |
| `exclude` | `string \| string[]` | `data-exclude` | Path globs never tracked. `*` stays in a segment, `**` crosses |
| `respectDnt` | `boolean` | `data-respect-dnt` | Honour Do Not Track. Off by default — see below |
| `trackLocalhost` | `boolean` | `data-track-localhost` | Count local hostnames. Development only |
| `debug` | `boolean` | `data-debug` | Explain dropped events in the console |
| `defer` | `boolean` | `defer` | Defaults to `true` |
| `onLoad` | `() => void` | | The tracker loaded |
| `onError` | `() => void` | | The request failed — usually a content blocker |

Three behaviours worth committing to memory:

- **It is idempotent.** React StrictMode mounts effects twice in development; the second call
  finds the script the first one injected and returns it. Two `init()` calls, one script tag.
- **It is inert during SSR.** No `document`, no injection, returns `null`. Call it again on the
  client.
- **It throws on a missing `domain` or `instanceUrl`,** in the browser *and* on the server. A
  configuration mistake should stop you in development, not silently produce an empty
  dashboard three weeks later. Nothing else in this package ever throws.

> `respectDnt` is off by default because Credible sets no cookie, stores no identifier and
> builds no cross-site profile, so a Do Not Track signal has nothing to protect against here.
> Turning it on hides real, anonymous traffic from your own numbers. It is a deliberate choice,
> one option away.

### `trackEvent(name, options?)`

```js
trackEvent('Signup');
trackEvent('Signup', { props: { plan: 'pro', seats: 5, trial: true } });
trackEvent('Purchase', { revenue: { amount: 19.99, currency: 'EUR' } });
trackEvent('Download', {
  props: { file: 'whitepaper.pdf' },
  callback: (result) => console.log(result.status),
});
```

| Option | Type | Effect |
|---|---|---|
| `props` | `object` | Custom properties. Flat strings, numbers and booleans only |
| `revenue` | `{ amount, currency? }` | Monetary value. `currency` falls back to the site's |
| `callback` | `(result) => void` | Fires once, after every configured domain settles |
| `url` | `string` | Override the reported URL |
| `referrer` | `string \| null` | Override the referrer |

Calls made before the tracker has loaded are queued and replayed in order, so you never have to
wait for `onLoad`. On the server it is a no-op. It never throws — not on a bad name, not when
the tracker itself fails.

### `trackPageview(overrides?)`

```js
trackPageview();
trackPageview({ url: 'https://example.com/checkout/step-2', referrer: null });
trackPageview({ props: { variant: 'b' } });
```

> **You probably do not need this.** The tracker sends a pageview on load and wraps
> `history.pushState` / `replaceState`, so React Router, Vue Router, SvelteKit and the Next.js
> app router are already counted with no code. Calling `trackPageview()` in a route effect
> **double-counts every page**, starting with the first one.
>
> Use it for virtual pageviews the router does not produce: a multi-step form, a modal you want
> counted as a page, a wizard step. Everything sent afterwards is attributed to that URL until
> the next pageview.

---

## Framework recipes

### React

Initialise once, above your router, at the root of the app.

```jsx
// src/analytics.js
import { init } from 'credible-tracker';

export function startAnalytics() {
  init({
    instanceUrl: import.meta.env.VITE_CREDIBLE_URL,
    domain: import.meta.env.VITE_CREDIBLE_DOMAIN,
  });
}
```

```jsx
// src/main.jsx
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { startAnalytics } from './analytics';
import App from './App';

function Root() {
  // init() is idempotent, so StrictMode's double mount is harmless.
  useEffect(startAnalytics, []);
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
```

Then anywhere in the tree:

```jsx
import { trackEvent } from 'credible-tracker';

export function UpgradeButton({ plan }) {
  return (
    <button onClick={() => trackEvent('Upgrade Clicked', { props: { plan } })}>
      Upgrade
    </button>
  );
}
```

No context, no provider, no hook. `trackEvent` is a plain function that queues until the script
lands, which is the whole reason this package installs the async stub.

### Next.js

**App Router** — a client component mounted in the root layout:

```jsx
// app/analytics.jsx
'use client';

import { useEffect } from 'react';
import { init } from 'credible-tracker';

export default function Analytics() {
  useEffect(() => {
    init({
      instanceUrl: process.env.NEXT_PUBLIC_CREDIBLE_URL,
      domain: process.env.NEXT_PUBLIC_CREDIBLE_DOMAIN,
    });
  }, []);
  return null;
}
```

```jsx
// app/layout.jsx
import Analytics from './analytics';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

The app router navigates with `history.pushState`, which the tracker already wraps — do **not**
add a `usePathname()` effect that calls `trackPageview()`, or every route change is counted
twice.

**Pages Router** — the same idea in `_app.jsx`:

```jsx
// pages/_app.jsx
import { useEffect } from 'react';
import { init } from 'credible-tracker';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    init({
      instanceUrl: process.env.NEXT_PUBLIC_CREDIBLE_URL,
      domain: process.env.NEXT_PUBLIC_CREDIBLE_DOMAIN,
    });
  }, []);
  return <Component {...pageProps} />;
}
```

Importing this package from a server component or from `getServerSideProps` is safe: every
function is a no-op without a `document`.

**Or skip the package entirely.** Next.js can render the snippet itself, which is one fewer
dependency and one fewer client component:

```jsx
import Script from 'next/script';

<Script
  defer
  data-domain="example.com"
  src="https://stats.example.com/js/cr.js"
  strategy="afterInteractive"
/>;
```

Use `credible-tracker` when you also want `trackEvent()` with types; use `next/script` when the
snippet is all you need.

### Vue

```js
// src/main.js
import { createApp } from 'vue';
import { init } from 'credible-tracker';
import App from './App.vue';

init({
  instanceUrl: import.meta.env.VITE_CREDIBLE_URL,
  domain: import.meta.env.VITE_CREDIBLE_DOMAIN,
});

createApp(App).mount('#app');
```

```vue
<script setup>
import { trackEvent } from 'credible-tracker';

function upgrade() {
  trackEvent('Upgrade Clicked', { props: { plan: 'pro' } });
}
</script>

<template>
  <button @click="upgrade">Upgrade</button>
</template>
```

Vue Router's history mode uses `pushState`, so pageviews are automatic. If you use hash mode
(`createWebHashHistory`), add `hash: true` to `init()` — otherwise every route reports as the
same page.

### Svelte / SvelteKit

SvelteKit runs the root layout on the server too, so guard the call with `onMount`, which only
runs in the browser:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { onMount } from 'svelte';
  import { init } from 'credible-tracker';
  import { PUBLIC_CREDIBLE_URL, PUBLIC_CREDIBLE_DOMAIN } from '$env/static/public';

  onMount(() => {
    init({ instanceUrl: PUBLIC_CREDIBLE_URL, domain: PUBLIC_CREDIBLE_DOMAIN });
  });
</script>

<slot />
```

```svelte
<script>
  import { trackEvent } from 'credible-tracker';
</script>

<button on:click={() => trackEvent('Upgrade Clicked')}>Upgrade</button>
```

SvelteKit's client-side router uses `pushState`, so it is counted automatically.

### Astro

Astro ships zero JS by default, so the plain snippet is usually the better answer:

```astro
---
// src/layouts/Base.astro
---
<html lang="en">
  <head>
    <script is:inline defer data-domain="example.com" src="https://stats.example.com/js/cr.js"></script>
  </head>
  <body><slot /></body>
</html>
```

Reach for this package only in an island that needs `trackEvent()`.

---

## Proxying through your own domain

Content blockers filter requests by hostname, so a tracker served from `stats.example.com` is
blocked on some visitors' machines while one served from `example.com` is not. Serve both the
script and the events from your own origin and the problem goes away.

Point `instanceUrl` at the proxied path — a **relative** value is fine, and is the point:

```js
init({ instanceUrl: '/_stats', domain: 'example.com' });
// -> <script src="/_stats/js/cr.js">
// -> events POST to https://example.com/_stats/api/event
```

The tracker derives the endpoint by replacing the trailing `/js/<file>` of its own `src` with
`/api/event`, so nothing else needs configuring. Keep the `/js/` segment in the path.

A minimal Caddy front end:

```caddyfile
example.com {
    handle_path /_stats/* {
        reverse_proxy https://stats.example.com {
            header_up Host stats.example.com
        }
    }
}
```

If your proxy cannot preserve that shape, set the endpoint explicitly instead:

```js
init({
  instanceUrl: 'https://example.com/_stats',
  api: 'https://example.com/collect',
  domain: 'example.com',
});
```

> Set `CREDIBLE_TRUST_PROXY=true` on the instance whenever you proxy. Visitor hashing and
> per-site IP exclusions are computed from the client IP; without it every proxied visitor
> arrives with your proxy's address and collapses into a single person.

On WordPress, the [Credible Analytics plugin](../wordpress) does all of this for you — see
[integrations/README.md](../README.md).

---

## TypeScript

Types ship with the package; there is no `@types/credible-tracker` to install. Both the ESM and
CommonJS entry points are typed.

```ts
import { init, trackEvent, type CredibleInitOptions } from 'credible-tracker';

const options: CredibleInitOptions = {
  instanceUrl: 'https://stats.example.com',
  domain: ['example.com', 'example.org'],
  exclude: ['/admin/**'],
};

init(options);

trackEvent('Purchase', {
  props: { plan: 'pro', seats: 5 },
  revenue: { amount: 19.99, currency: 'EUR' },
  callback: (result) => {
    if (result.ignored) console.log('dropped in the browser');
  },
});
```

`props` values are typed as `string | number | boolean`, matching what the tracker actually
transmits — nested objects and arrays are dropped in the browser, so the type stops you before
the wire does.

---

## Building and testing

Zero dependencies here too. `dist/` is generated from `src/index.js` by a 60-line transform
that strips `export ` from top-level declarations and appends a `module.exports`; it refuses
any module syntax it cannot express rather than emitting a broken CommonJS file.

```bash
node build.js     # writes dist/*.js, *.cjs and both .d.ts flavours
node --test       # 50 tests, run against the built files
```

`dist/` is committed, so `npm install` needs no build step — and a test rebuilds in memory and
compares byte for byte, so a stale `dist/` fails the suite. The behavioural tests run twice,
once against the ESM build and once against the CommonJS build, because a dual package whose
two halves disagree is the classic way this goes wrong.

---

## See also

- **[docs/TRACKING.md](../../docs/TRACKING.md)** — everything the tracker does, and why
- **[docs/API.md](../../docs/API.md)** — the stats and events HTTP API
- **[integrations/](../README.md)** — WordPress, Google Tag Manager, and the rest

## Licence

MIT. See [LICENSE](./LICENSE).
