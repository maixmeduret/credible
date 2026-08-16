# Credible for Google Tag Manager

Install Credible and track conversions from GTM, without touching your site's code.

There are two pieces, and you need them in this order:

1. **The install tag** — a Custom HTML tag that loads the tracker. One minute, once.
2. **The event template** — [`template.tpl`](./template.tpl), imported into GTM, so anyone on
   your team can add conversion events without writing JavaScript.

Piece 1 is enough for pageviews, outbound links, downloads, form submissions and engagement.
Piece 2 is for named conversions like `Signup` and `Purchase`.

- [Step 1: install the tracker](#step-1-install-the-tracker)
- [Step 2: import the template](#step-2-import-the-template)
- [Step 3: build an event tag](#step-3-build-an-event-tag)
- [Verifying it works](#verifying-it-works)
- [Why the template does not load the tracker](#why-the-template-does-not-load-the-tracker)
- [Options on the install tag](#options-on-the-install-tag)
- [A note on loading Credible through GTM at all](#a-note-on-loading-credible-through-gtm-at-all)

---

## Step 1: install the tracker

**Tags → New → Custom HTML.** Paste this, replacing the two values:

```html
<script>
  window.credible = window.credible || function () {
    (window.credible.q = window.credible.q || []).push(arguments);
  };
</script>
<script defer data-domain="example.com" src="https://stats.example.com/js/cr.js"></script>
```

- `data-domain` — your site, exactly as you added it in the Credible dashboard.
- `src` — your instance's origin, plus `/js/cr.js`.

**Triggering → All Pages.** Name it something like *Credible – install*. Save.

Leave **Support document.write** unchecked; the tag does not need it.

### Why the first block matters

That is the async stub. `defer` means the tracker has not loaded during page parse, so an event
tag firing early would call a function that does not exist yet. With the stub, those calls are
queued and replayed in order the moment the tracker boots. It removes any need for tag
sequencing, and it costs four lines.

### Use GTM variables for the two values

If you manage several sites from one container, make them variables — **Variables → New →
Constant** — and reference them:

```html
<script defer data-domain="{{Credible Domain}}" src="{{Credible Instance}}/js/cr.js"></script>
```

Then a lookup table variable keyed on `{{Page Hostname}}` gives you one container serving every
site you run.

---

## Step 2: import the template

1. **Templates → Tag Templates → New.**
2. In the editor's overflow menu (⋮, top right), choose **Import**.
3. Pick [`template.tpl`](./template.tpl) from this directory.
4. **Save**, then close the editor.

GTM will show you the permissions the template asks for. There are two, and you can check them
against the code in the same editor:

| Permission | What it covers | Why |
|---|---|---|
| **Accesses global variables** | `credible`, `credible.q`, `credible.l` | The only globals the tag touches. `credible` is the tracker's function, `credible.q` its async queue, `credible.l` its "already loaded" flag |
| **Logs to console** | debug environment only | The optional debug checkbox, and the one warning it prints when a revenue amount is not a number |

No `inject_script`. No network permission of any kind. The tag hands your event to a function
that is already on the page and does nothing else — which is a template worth reading before you
import it, and short enough that you can.

---

## Step 3: build an event tag

**Tags → New → Credible Analytics.**

| Field | Notes |
|---|---|
| **What should this tag send?** | *A custom event* for conversions; *A pageview* only for virtual ones |
| **Event name** | Free text, e.g. `Signup`. Match it with a goal in Credible to get a conversion rate |
| **Custom properties** | Key/value rows. Up to 30 per event, values stored as text and truncated at 255 characters |
| **Revenue** | Amount and currency, e.g. `{{Transaction Total}}` and `EUR`. Leave the currency empty to use the site's default |
| **Overrides** | Report the event against a different URL or referrer. Rarely needed |
| **Log to console** | Turn on while building, off before you publish |

Then pick your trigger as usual — a click, a form submission, a data layer event.

### Do not add a pageview tag on All Pages

The tracker sends a pageview when it loads, and wraps `history.pushState` / `replaceState`, so
single-page apps are already counted. A pageview tag on All Pages doubles every number in your
dashboard.

Use the *pageview* mode only for pages the browser never actually navigated to: a checkout step
rendered in place, a modal you want counted as a page, a wizard step. Everything sent afterwards
is attributed to that URL until the next pageview.

---

## Verifying it works

Five minutes, no guessing:

1. **Preview** in GTM, and load your site in the debug window.
2. Open the browser's **Network** tab and filter on `event`. You should see a `POST` to
   `/api/event` returning **202**, with a response header `x-credible: ok`. A `202` with
   `x-credible: ignored` means the event arrived and was dropped — nearly always a `data-domain`
   that does not match a site on your instance.
3. Trigger your conversion. A second `POST` should appear.
4. Check the dashboard's realtime view, or:

   ```bash
   curl -H "Authorization: Bearer <api key>" \
     https://stats.example.com/api/stats/example.com/realtime
   ```

If nothing is sent at all, add `data-debug` to the install tag's script element and reload. The
tracker prints the exact reason it dropped an event, prefixed `[Credible]`. The most common one
during testing is that you are on `localhost`, which is never counted without
`data-track-localhost`.

> **The template's `___TESTS___` block is empty on purpose.** GTM test scenarios only execute
> inside GTM's own template editor, and shipping tests that have never been run would be worse
> than shipping none. The structure of the template file — its JSON blocks, and the match
> between every `require()` and the permissions it declares — is checked by
> [`template.test.js`](./template.test.js) in the repository's normal test suite.

---

## Why the template does not load the tracker

This is the surprising part of the design, so here is the whole reasoning.

GTM's sandboxed JavaScript can load an external script with `injectScript(url)`. That is the
entire API: **a URL, and nothing else.** There is no way to create an element and put attributes
on it.

The Credible tracker reads the site it belongs to from `data-domain` on its own script tag. A
tag that injected `https://stats.example.com/js/cr.js` with no attributes would load the file,
define `window.credible`, and then drop every single event — because `data-domain` is missing,
which is exactly the first row of the troubleshooting table in
[docs/TRACKING.md](../../docs/TRACKING.md#no-data-is-showing-up).

That is the worst kind of broken: the tag reports success, the container publishes cleanly, and
the dashboard stays at zero. A Custom HTML tag can carry attributes, so that is what installs
the tracker, and the template sticks to the job it can do correctly.

**How Plausible avoids this**, for comparison: their server serves the script as
`/js/<domain>.js` and the script reads its own filename to learn the domain, so a URL is enough
and their template can inject. Credible serves one file, `/js/cr.js`, and reads the attribute.

If Credible ever learns to take the domain from its script URL — `/js/cr.js?domain=example.com`
would be a small, backwards-compatible change, since the tracker already parses its own `src` in
`apiEndpoint()` — this template can grow a proper install mode and step 1 disappears. Until
then, offering one would be pretending.

---

## Options on the install tag

Everything is a `data-*` attribute on the script element in your Custom HTML tag. The full
reference is [docs/TRACKING.md](../../docs/TRACKING.md#2-script-tag-attributes); the ones that
come up with GTM:

```html
<script
  defer
  data-domain="example.com"
  data-hash
  data-exclude="/admin/*, /preview/**"
  src="https://stats.example.com/js/cr.js"
></script>
```

| Attribute | When you want it |
|---|---|
| `data-hash` | Your app routes with `#fragments` |
| `data-exclude` | Paths that should send nothing at all. `*` stays inside a segment, `**` crosses |
| `data-api` | You proxy events through your own domain |
| `data-respect-dnt` | You want Do Not Track honoured. Off by default, deliberately |
| `data-track-localhost` | You are testing on localhost, which is otherwise never counted |
| `data-debug` | You are debugging. Take it off before publishing |

A flag counts as *on* when its value is empty, `true` or `1`. Anything else — including `yes` —
reads as off.

---

## A note on loading Credible through GTM at all

Worth saying plainly, because it cuts against the point of this directory: **if you can edit
your site's HTML, put the snippet there instead.**

Loading analytics through a tag manager means the tracker only runs once GTM has loaded and
evaluated your container, which delays the pageview and loses the visits where GTM itself is
blocked — and GTM is blocked far more often than a first-party analytics script is. You also
inherit GTM's own weight, which is larger than Credible's 4.5 KB tracker by a wide margin.

Use GTM when you genuinely cannot deploy code: an agency running a client's site, a marketing
team without release access, or a CMS you do not control. Those are real situations, and this
directory exists for them. If you are the developer of the site, the snippet in your template
is faster, more reliable, and one fewer dependency.

For WordPress specifically, the [plugin](../wordpress) is a better answer than either — it can
serve the tracker from your own domain, which neither the snippet nor GTM can do.
