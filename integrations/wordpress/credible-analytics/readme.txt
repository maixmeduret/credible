=== Credible Analytics ===
Contributors: crediblecontributors
Tags: analytics, privacy, cookieless, gdpr, statistics
Requires at least: 5.6
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Privacy-first, cookieless analytics for your self-hosted Credible instance. No cookies, no consent banner, no personal data.

== Description ==

Credible is free, open-source, self-hosted web analytics. You run the server; nobody else sees
your visitors. This plugin connects your WordPress site to it.

It sets **no cookies**, stores **no identifiers**, and sends **no personal data** anywhere. The
payload is a page URL, a referrer and a viewport width. Visitors are counted server-side from a
salted hash that is thrown away and regenerated every day, which is what makes returning-visitor
metrics impossible here — deliberately, and permanently.

Because nothing about a visitor is stored, this plugin does not require a cookie consent banner.

= What it does =

* Adds the tracker to every page, with the options you pick, correctly escaped.
* **Serves the tracker and receives events on your own domain**, so content blockers that filter
  by hostname cannot quietly remove a slice of your traffic. This is the reason to install a
  plugin instead of pasting a snippet.
* Keeps your own editing sessions out of your numbers by default.
* Excludes pages you name, before anything leaves the browser.
* Shows you the exact markup it prints, and checks that your instance answers.

= What is tracked automatically =

Pageviews, client-side route changes, outbound link clicks, file downloads, form submissions,
engaged time and scroll depth. Outbound links and downloads are part of the tracker itself and
are always on — Credible ships one script with every feature built in rather than a family of
variants, so there is no version of it that leaves them out.

= Custom events =

The tracker exposes `window.credible`, so any theme or plugin can record a conversion:

`credible('Signup', { props: { plan: 'pro' } });`
`credible('Purchase', { revenue: { amount: 19.99, currency: 'EUR' } });`

Or tag an element and skip the JavaScript entirely:

`<button class="credible+Signup">Sign up</button>`

= You need a Credible instance =

This plugin is a client. It does not store or display statistics; your instance does. Setting one
up is one command, and it runs comfortably on the smallest VPS you can rent. See
https://github.com/maixmeduret/credible

= Licence =

This plugin is GPL-2.0-or-later. The Credible server it talks to is AGPL-3.0-or-later. They are
separate programs that exchange HTTP requests: no server code is copied into or distributed with
this plugin.

== Installation ==

1. Install and activate the plugin.
2. Go to **Settings → Credible**.
3. Enter your instance URL, for example `https://stats.example.com`.
4. Check the site domain. It defaults to this site's hostname and must match a site on your
   instance exactly.
5. Press **Verify installation**. It fetches the tracker from your instance and tells you what
   came back.

That is a working install. The rest is optional.

= Turning on the first-party proxy =

1. Tick **Enable the proxy** and save.
2. Set `CREDIBLE_TRUST_PROXY=true` on your Credible instance and restart it. Without this every
   event arrives with your web server's IP address and all your visitors are counted as one
   person.
3. Press **Verify installation** again.

If the proxy check fails right after you turn it on, go to **Settings → Permalinks** and press
Save. That rebuilds WordPress's rewrite rules, which is where the proxy's paths live.

== Frequently Asked Questions ==

= Do I need a cookie consent banner? =

Not for this plugin. It sets no cookies and collects no personal data, so there is nothing for a
visitor to consent to. Other plugins on your site may still need one.

= Why is my own traffic missing? =

Logged-in users are excluded by default, and so are post previews and the customizer. Tick
**Track logged-in users** if signed-in visitors are your audience. Note that traffic from
`localhost` is never counted unless you also tick **Count local traffic**.

= Nothing is showing up at all. =

Work down this list:

1. Press **Verify installation**. It checks the two things that are usually wrong.
2. Check that the **Site domain** matches a site on your instance character for character.
   `example.com` and `blog.example.com` are different sites.
3. Tick **Console debugging**, reload a page as a logged-out visitor, and read the browser
   console. The tracker prints the exact reason it dropped an event.
4. If you are behind a caching plugin or a CDN, make sure the page you are looking at is not a
   cached copy from before you configured the plugin.

= What does the first-party proxy actually do? =

Two URLs on your own domain, under a random prefix generated at activation:

* `/<prefix>/js/cr.js` — the tracker, fetched from your instance once and cached here for
  twelve hours.
* `/<prefix>/api/event` — events, forwarded to your instance from this server.

Because both are on your domain, a blocker that filters requests to analytics hostnames sees
nothing to filter. The prefix is random on purpose: `credible` or `analytics` in the path would
give the game away.

= Does the proxy slow my site down? =

The script is served from a cached copy, so no request leaves your server for it. Forwarding an
event does make one outgoing HTTP request, with a four-second ceiling, and the visitor's browser
is answered whatever happens upstream. On a busy site, consider whether your host is happy with
that; if not, leave the proxy off and let the browser talk to your instance directly.

= Can I turn off outbound link or download tracking? =

No, and the settings screen says so rather than pretending otherwise. Credible ships a single
tracker with every feature compiled in, toggled by attributes — and there is no attribute for
those two. If you need them gone, the change belongs in the tracker, not here.

= Does it work with caching plugins? =

Yes. The script tag is static markup with no user-specific content, so it caches like the rest of
the page. The one interaction worth knowing: if you exclude logged-in users (the default) and
your cache serves the same HTML to everyone, whether the tag is present depends on who triggered
the cache fill. Most caching plugins bypass the cache for logged-in users, which makes this a
non-issue.

= Is my analytics data deleted when I delete the plugin? =

No. Deleting the plugin removes its settings and its cached copy of the tracker from WordPress,
and touches nothing on your Credible instance. Your history stays where it is.

= Does it work on multisite? =

Activate it per site; each site gets its own settings and its own domain. Deleting the plugin
cleans up every site on the network.

== Changelog ==

= 0.1.0 =
* First release.
* Settings screen with instance URL, domain, hash routing, logged-in users, excluded pages,
  Do Not Track, local traffic and console debugging.
* First-party proxy serving the tracker and forwarding events from your own domain, via rewrite
  rules with a REST API fallback.
* Installation checks against your instance and, when the proxy is on, against this site.
* Uninstall routine that removes every option on single sites and across a network.

== Upgrade Notice ==

= 0.1.0 =
First release.
