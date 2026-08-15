# Contributing to Credible

Thanks for being here. Credible is a small project with a deliberately small surface, and
that is what makes it maintainable by volunteers. This document explains how to run it, how
to test it, and the handful of rules that keep it the way it is.

## Getting set up

There is nothing to install.

```bash
git clone https://github.com/maixmeduret/credible.git
cd credible
node bin/credible.js serve
```

You need **Node.js 22.13 or newer** (24 and 26 also work). Storage uses the built-in
`node:sqlite` module, which stopped requiring the `--experimental-sqlite` flag in 22.13.

The server comes up on <http://localhost:8000>, creates `./data/credible.db`, and prints a
one-time link to create the first account. To iterate on the server without restarting it by
hand:

```bash
npm run dev          # node --watch bin/credible.js serve
```

To get a dashboard worth looking at, generate demo traffic:

```bash
node bin/credible.js seed
```

Delete `./data/credible.db` any time you want a clean slate. It is a normal file, and it is
gitignored.

### Working on the tracker

The browser tracker lives in `tracker/` and is compiled to `public/js/cr.js`, which is what
sites actually load. **The build output is committed**, and CI fails if it drifts from the
source. After any change under `tracker/`:

```bash
node tracker/build.js
git add public/js/cr.js
```

## Testing

```bash
node --test                          # everything
node --test test/referrer.test.js    # one file
```

Use bare `node --test` rather than `node --test test/`. Passing the directory works on Node
22 and 24 but fails on Node 26, which resolves the argument as a module instead of scanning
it; the runner's built-in discovery finds the same files on every version.

Tests use the built-in `node:test` runner and `node:assert`. Anything with logic in it needs
a test: parsing, sessionization, date bucketing, query building, and the privacy-critical
hashing in particular. Tests must not touch the network, must not depend on the machine's
timezone or the current date, and should build their own database with `openDatabase()` on a
temporary path rather than using the developer's real one.

CI runs the suite on Node 22 and 24, rebuilds the tracker, and verifies the committed build
is current.

## Code style

The constraints are the point of the project, so they are not negotiable:

- **Zero dependencies.** Node built-ins only — `node:fs`, `node:http`, `node:crypto`,
  `node:sqlite`, `node:test`, and friends. Nothing goes into `package.json`. If a task seems
  to need a library, that is usually a sign the task should be smaller.
- **ESM only.** `import`, never `require()`. The package is `"type": "module"`.
- **Server code targets modern Node.** Use the language properly.
- **Tracker code targets everything.** Anything under `tracker/`, and therefore the built
  `public/js/cr.js`, must be plain ES5-compatible JavaScript: no arrow functions, no
  `const`/`let`, no template literals, no `fetch`. It runs unbundled and untranspiled in
  whatever browser a visitor brought, on somebody else's website. The dashboard under
  `public/` is different — it is only ever loaded by the operator, so it is modern ESM, but
  it is still unbundled and dependency-free.
- **Comments in English**, explaining *why* rather than restating the code. Every module gets
  a short header comment saying what it is for.
- **No placeholders.** No `TODO`, no stubbed function that throws "not implemented". If it is
  not finished, it does not merge.
- Two-space indentation, semicolons, single quotes.
- Keep the privacy model intact. Any change that stores an IP address, sets a cookie, writes
  to `localStorage`, or makes a visitor identifiable across days will be declined, however
  useful the resulting metric is.

## Commits and pull requests

Commit messages follow a light [Conventional Commits](https://www.conventionalcommits.org)
style — it keeps the history skimmable and makes release notes easy:

```
feat: add exit page breakdown
fix: correct bounce rate when a visit has one engagement event
docs: explain the salt rotation window
refactor: extract the channel classifier
test: cover DST boundaries in day bucketing
chore: bump the CI matrix to Node 24
```

Write the subject in the imperative mood and keep it under about 72 characters. Explain the
reasoning in the body if it is not obvious.

For pull requests:

- One logical change per PR. Small is easy to review; large is easy to postpone.
- Say what problem it solves and how you verified it.
- Run `node --test` before pushing, and rebuild the tracker if you touched it.
- Update the docs in the same PR when behaviour changes. `docs/PRIVACY.md` must stay exactly
  true — treat it as part of the code.

**No CLA, and no DCO sign-off is required.** You do not need to add `Signed-off-by` to your
commits or sign a separate agreement. By contributing you agree that your work is licensed
under the project's AGPL-3.0-or-later, and you keep the copyright to what you wrote.

## Proposing a feature

Open an issue before writing a large patch — it is unpleasant to turn down finished work, and
a five-minute conversation usually improves the design anyway.

Good proposals describe the question the user is trying to answer about their traffic, not
just the widget they imagine. They also survive three checks:

1. It can be built with Node built-ins only.
2. It does not weaken the privacy model or create a need for a consent banner.
3. It is useful to most self-hosters, not only to one setup.

Things that are very likely to be accepted: bug fixes, accuracy improvements, better
referrer and channel classification, documentation, deployment recipes, accessibility fixes,
and performance work backed by a measurement.

Things that are likely to be declined: new dependencies, a second storage engine as the
default, anything requiring a build toolchain for browser code, individual-level or
cross-site tracking, and features that only make sense for a hosted commercial service.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by the [Contributor Covenant](CODE_OF_CONDUCT.md). Be decent to
people; assume good faith; reports go to conduct@credible.example.
