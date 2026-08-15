# Security Policy

Credible receives data from the open internet on every self-hosted instance, and it holds the
analytics of everyone who runs it. Security reports are taken seriously and are welcome.

## Reporting a vulnerability

**Email security@credible.example.** Please do not open a public issue, pull request, or
discussion for a vulnerability — report it privately first so a fix can ship before the
details are public.

Encrypt the report if you prefer; ask for a key in a first message with no details in it.

Please include, as far as you can:

- What the issue is and roughly how severe you think it is
- The affected version (`node bin/credible.js version`) and how the instance is deployed
- Step-by-step reproduction, ideally against a fresh local instance
- A proof of concept, and what an attacker gains
- Anything you think would break if it were fixed naively

If you have a suggested patch, say so — but a clear report is worth more than a rushed fix.

## What to expect

This is a volunteer project without a paid on-call rotation, so these are honest targets
rather than contractual guarantees:

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 3 working days |
| Initial assessment and severity | within 7 days |
| Fix released for a critical issue | within 30 days |
| Fix released for other issues | usually the next release |

You will be kept informed as it moves, including if it turns out not to be a vulnerability
and why. Once a fix is released, an advisory goes out through GitHub Security Advisories with
credit to you by whatever name you prefer, or anonymously if you would rather. There is no
bug bounty — no money, only genuine thanks and public credit.

We ask that you give us a reasonable window to release a fix before publishing details, and
that your testing stays on your own instance: no attacks against other people's deployments,
no accessing or exfiltrating data that is not yours, and no denial of service against live
sites. Good-faith research that follows this policy will never be met with a legal complaint.

## Supported versions

The latest released version is the one that receives security fixes. Credible is small and
easy to upgrade; there are no long-term support branches.

## In scope

Anything in this repository that could compromise an instance or the privacy promise:

- Remote code execution, SQL injection, or path traversal
- Authentication or session flaws — login bypass, session fixation, privilege escalation
  between users, weaknesses in password or token handling
- Authorization flaws: reading or writing another site's data, escaping a shared dashboard's
  read-only scope, or a shared link exposing more than it should
- Cross-site scripting in the dashboard, including through attacker-controlled ingest data
  such as referrers, paths, UTM values, or custom event properties
- CSRF on state-changing endpoints
- **Privacy defects**, which we treat as security issues: any way a raw IP address reaches
  disk or logs, any way visitor hashes could be reversed or linked across the salt rotation,
  any leak of one instance's data to another party, or the tracker writing to a visitor's
  device
- Stats API or events API flaws: token leakage, missing authentication, injection via ingest
- Denial of service that is cheap for an attacker and expensive for the server, beyond what
  `CREDIBLE_RATE_LIMIT` is expected to absorb
- Insecure defaults in the shipped `Dockerfile`, `docker-compose.yml`, or `fly.toml`

## Out of scope

- Missing hardening headers or best practices with no demonstrated impact
- Findings from automated scanners without a working proof of concept
- Reports against a modified or misconfigured deployment, or against the operator's own
  reverse proxy, TLS setup, or host
- Attacks requiring an already-compromised server, physical access, or a malicious admin
  acting within their own instance
- Vulnerabilities in Node.js itself — report those to
  [the Node.js project](https://nodejs.org/en/security) (tell us too if Credible is affected)
- Rate limiting or volumetric denial of service that any HTTP service would share, and which
  belongs in front of the app at your proxy or CDN
- Social engineering, spam, or issues on `credible.example` (a documentation placeholder, not
  a real domain)

## For operators

If you run an instance, the fastest wins are: stay on the latest version, terminate TLS in
front of it and set `CREDIBLE_SECURE_COOKIES=true`, set `CREDIBLE_TRUST_PROXY=true` **only**
when a proxy you control is the one setting `X-Forwarded-For`, set
`CREDIBLE_OPEN_REGISTRATION=false` once your accounts exist, and keep backups of the database
file. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
