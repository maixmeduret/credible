# Credible Analytics — WordPress plugin

The installable plugin lives in [`credible-analytics/`](./credible-analytics). This file is for
whoever maintains it; the user-facing documentation is
[`credible-analytics/readme.txt`](./credible-analytics/readme.txt) in the WordPress.org format.

```
credible-analytics/
  credible-analytics.php      plugin header, constants, bootstrap
  uninstall.php               removes every option, single site and network
  readme.txt                  WordPress.org listing
  includes/
    class-credible-analytics-settings.php   options, sanitisation, Settings -> Credible
    class-credible-analytics-proxy.php      first-party script and event proxy
    class-credible-analytics-tracker.php    what the script tag says, and whether to print it
tests/
  stubs.php                   just enough WordPress to run the logic outside WordPress
  run-tests.php               84 assertions over the sanitisers, the tag builder and the filters
  plugin.test.js              node:test bridge — static checks always, PHP suite when available
```

## Installing it

Zip the inner directory and upload it, or symlink it while developing:

```bash
cd /path/to/wordpress/wp-content/plugins
ln -s /path/to/credible/integrations/wordpress/credible-analytics credible-analytics
```

Then **Plugins → Credible Analytics → Activate**, and **Settings → Credible**.

Activation generates a random proxy path prefix and flushes the rewrite rules once. Nothing else
happens until you fill in an instance URL.

## Running the tests

The behavioural suite is plain PHP with no framework and no WordPress:

```bash
php integrations/wordpress/tests/run-tests.php
```

No PHP on the machine? Any container will do:

```bash
docker run --rm -v "$PWD:/app" -w /app php:7.4-cli-alpine \
  php integrations/wordpress/tests/run-tests.php
```

The repository's own runner picks all of this up:

```bash
node --test                      # static checks; skips the PHP suite if PHP is missing
CREDIBLE_PHP="docker run --rm -v $PWD:/app -w /app php:7.4-cli-alpine php" node --test
```

`plugin.test.js` always runs the checks that need nothing but a filesystem — the header block,
`readme.txt` against the plugin version, a direct-access guard in every file, no `eval`, every
superglobal read through `wp_unslash`. It runs the PHP suite when it can find PHP and skips it
with an explanatory message when it cannot, rather than making a Node project depend on a PHP
toolchain.

Syntax is checked against both ends of the supported range:

```bash
for v in 7.4 8.3; do
  docker run --rm -v "$PWD:/app" -w /app "php:$v-cli-alpine" \
    sh -c 'for f in $(find integrations/wordpress -name "*.php"); do php -l "$f"; done'
done
```

## How the first-party proxy works

This is the only part with real machinery in it.

```
visitor                     WordPress                        Credible instance
   |                            |                                    |
   |  GET /cr-a1b2c3d4/js/cr.js |                                    |
   |--------------------------->|  cached 12h, ETag revalidated      |
   |                            |----------------------------------->|
   |<---------------------------|  application/javascript            |
   |                            |                                    |
   |  POST /cr-a1b2c3d4/api/event                                    |
   |--------------------------->|  + User-Agent, X-Forwarded-For,    |
   |         202, empty         |    edge geo headers                |
   |<---------------------------|----------------------------------->|
```

**Both URLs are on the site's own domain**, which is the entire point: a content blocker that
filters requests by hostname has nothing to match on. The path prefix is randomly generated at
activation (`cr-` plus eight characters) because `/credible/js/cr.js` would be trivially
blockable.

**Two routes reach the same handlers.** Rewrite rules give the pretty paths above and are
preferred. They need permalinks to be anything but *Plain*, so REST routes at
`credible/v1/script` and `credible/v1/event` are registered too and used automatically
otherwise. Since the plugin always writes `data-api` explicitly when proxying, the tracker never
has to derive the endpoint from its own `src`, and the REST fallback — whose path has no `/js/`
segment to swap — works identically.

**Three things are forwarded, and each one matters:**

| Forwarded | Without it |
|---|---|
| The visitor's `User-Agent` | The instance's bot filter drops everything: WordPress's own agent has no browser marker |
| The visitor's IP as `X-Forwarded-For` | Every visitor hashes to the same value and the site reports one visitor, forever |
| `CF-IPCountry` and friends | A site behind a CDN loses its geography, since the instance would only see this server |

The IP is forwarded and never stored. The instance hashes it with a salt that rotates daily and
throws both away; this plugin keeps no log of its own.

> **The instance must be started with `CREDIBLE_TRUST_PROXY=true`.** Without it,
> `clientIp()` ignores `X-Forwarded-For` and reads the socket address, which is this server for
> every single event. The settings screen says so whenever the proxy is on, and the *Verify
> installation* check repeats it.

**Caching.** The tracker is fetched once and kept in a non-autoloaded option for twelve hours,
revalidated with `If-None-Match` when the instance sends an ETag. If the instance is unreachable
the stale copy is served anyway — a tracker a few hours old still counts visitors correctly, and
serving nothing loses them. Only when there has never been a successful fetch does the proxy
answer `502`, with a valid JavaScript comment as the body and `no-store`, so a failure costs a
pageview and never breaks a page.

**Failure policy for events.** The endpoint answers `202` with an empty body whatever happened
upstream, with a four-second ceiling on the forward. The instance itself answers `202` for
events it accepts and then drops, so this matches, and a visitor's browser has nothing useful to
do with an analytics failure.

## Design decisions worth not re-litigating

**One option, not eleven.** Everything lives in `credible_analytics_settings` as a flat array,
with one `sanitize_callback` as the only path by which user input reaches the database. Eleven
options would mean eleven chances to disagree with each other after a partial save.

**The tag is built, not patched.** `script_loader_tag` returns a tag assembled from scratch
rather than a string replacement over WordPress's version, so every attribute goes through
`esc_attr` and the `src` through `esc_url`, in one place you can read in ten seconds. The
settings screen previews the tag using the same method that prints it, so the preview cannot
drift.

**Outbound links and file downloads have no setting.** The tracker has no attribute for them —
Credible ships one script with every feature compiled in, unlike Plausible's family of script
variants. The settings screen shows them as ticked and disabled with an explanation, because
"where is the outbound links option?" is a question worth answering in place rather than a
setting worth faking. If they should be switchable, the change belongs in
`tracker/src/credible.js`, and this plugin can expose it the same day.

**Invalid URLs keep the old value.** `esc_url_raw('javascript:alert(1)')` returns an empty
string, which is indistinguishable from the user clearing the field — so validation tests the
*raw* input and restores the previous value with a settings error. Without that, one bad paste
silently switches tracking off. This was a real bug; `run-tests.php` covers it.

**Two filters, no more.** `credible_analytics_should_track` and
`credible_analytics_script_attributes` are enough to exclude a role, a post type or a staging
hostname without patching the plugin.

## Publishing to WordPress.org

`readme.txt` is already in the required format and `plugin.test.js` asserts that its `Stable tag`
matches the plugin header's `Version` — the mismatch that makes the directory serve the wrong
build. Before submitting:

- Bump `Version` in `credible-analytics.php` **and** `Stable tag` in `readme.txt` together.
- Update `Tested up to` against the current WordPress release.
- Run the tests above, including `php -l` on both 7.4 and 8.3.
- Consider running the official
  [Plugin Check](https://wordpress.org/plugins/plugin-check/) plugin, which applies the
  WordPress Coding Standards rules this repository does not carry a linter for.
- Replace the `Contributors` slug with real WordPress.org usernames.

## Licence

GPL-2.0-or-later, as WordPress.org requires. The Credible server is AGPL-3.0-or-later; the two
are separate programs exchanging HTTP requests, and no server code is copied into or distributed
with the plugin.
