#!/usr/bin/env node
/**
 * Credible command line.
 *
 *   credible serve                     start the server (default)
 *   credible provision                 account + site + API key in one shot
 *   credible install                   put the snippet into a website's source
 *   credible seed [domain]             fill the database with demo traffic
 *   credible user:add <email>          create an account
 *   credible site:add <domain>         start tracking a site
 *   credible site:list                 list tracked sites
 *   credible export <domain>           dump events as CSV to stdout
 *   credible version
 *
 * Every command that produces data accepts --json, so an assistant can drive
 * the whole setup without parsing human prose.
 */
import path from 'node:path';
import process from 'node:process';
import { config, ensureDataDir } from '../src/config.js';
import { getDb, all, optimize } from '../src/db/index.js';
import { createUser, findUserByEmail, randomPassword, userCount, createApiKey } from '../src/auth/index.js';
import { addMember, createSite, findSiteByDomain, listAllSites, normalizeDomain } from '../src/sites.js';
import { nextSteps, provision, snippetFor } from '../src/provision.js';
import { serve } from '../src/server.js';
import { log } from '../src/util/log.js';

const [, , rawCommand = 'serve', ...rest] = process.argv;
const command = rawCommand.replace(/^--/, '');

const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg.startsWith('--')) {
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
    else flags[key] = true;
  } else {
    positional.push(arg);
  }
}

const commands = {
  async serve() {
    ensureDataDir();
    const server = await serve();
    const url = config.baseUrl || `http://localhost:${config.port}`;
    log.print('');
    log.print(`  Credible ${config.version}`);
    log.print(`  ▸ dashboard   ${url}`);
    log.print(`  ▸ database    ${config.dbPath}`);
    log.print(`  ▸ tracker     ${url}/js/cr.js`);
    if (userCount() === 0) {
      log.print('');
      log.print(`  No account yet — open ${url} to create the first one.`);
    }
    log.print('');

    const shutdown = () => {
      log.print('Shutting down…');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },

  /** Check an instance is actually usable, and say what to fix. */
  async doctor() {
    const { diagnose, formatReport } = await import('../src/doctor.js');
    const report = await diagnose({
      url: flags.url || positional[0] || instanceOrigin(),
      domain: flags.domain || '',
      apiKey: flags['api-key'] || process.env.CREDIBLE_API_KEY || '',
      siteUrl: flags['site-url'] || '',
      local: !flags.remote,
    });
    if (flags.json) log.print(JSON.stringify(report, null, 2));
    else log.print(formatReport(report));
    if (!report.healthy) process.exitCode = 1;
  },

  /** Stand up a persistent instance: launchd/systemd, a tunnel, Docker or Fly. */
  async deploy() {
    const { deploy, detectEnvironment } = await import('../src/deploy.js');
    const target = flags.target || 'auto';

    if (flags.detect) {
      const environment = detectEnvironment();
      log.print(flags.json ? JSON.stringify(environment, null, 2) : formatEnvironment(environment));
      return;
    }

    const result = await deploy({
      target,
      port: Number(flags.port || config.port),
      dataDir: flags['data-dir'],
      appName: flags['app-name'],
      region: flags.region,
      yes: Boolean(flags.yes),
      dryRun: Boolean(flags['dry-run']),
      onProgress: flags.json ? undefined : (step) => log.print(`  ${step.done ? '✓' : '…'} ${step.message}`),
    });

    if (flags.json) {
      log.print(JSON.stringify(result, null, 2));
      return;
    }
    log.print('');
    log.print(`  target     ${result.target}`);
    log.print(`  status     ${result.status}`);
    if (result.url) log.print(`  url        ${result.url}${result.ephemeral ? '   (ephemeral — see notes)' : ''}`);
    if (result.service) log.print(`  service    ${result.service.kind} ${result.service.name}`);
    if (result.blocked_by) log.print(`  blocked    ${result.blocked_by}`);
    for (const note of result.notes || []) log.print(`  note       ${note}`);
    if (result.status === 'planned') {
      log.print('\n  Would run:');
      for (const command of result.commands || []) log.print(`    ${command.cmd}`);
      log.print('\n  Re-run with --yes to execute.');
    }
    for (const step of result.next || []) log.print(`  next       ${step}`);
    log.print('');
  },

  /**
   * The whole thing, in one command: host it, create the account, put the
   * snippet in the site's source, then check it all works.
   */
  async up() {
    const { deploy } = await import('../src/deploy.js');
    const email = flags.email;
    const domain = flags.domain;
    if (!email || !domain) {
      fail('Usage: credible up --email you@example.com --domain example.com [--target auto|local|tunnel|docker|fly] [--site-path .] [--json]');
    }

    const say = (message) => {
      if (!flags.json) log.print(message);
    };

    say('\n① Hosting');
    const hosted = await deploy({
      target: flags.target || 'auto',
      port: Number(flags.port || config.port),
      dataDir: flags['data-dir'],
      appName: flags['app-name'],
      region: flags.region,
      yes: Boolean(flags.yes),
      onProgress: flags.json ? undefined : (step) => say(`  ${step.done ? '✓' : '…'} ${step.message}`),
    });

    if (hosted.status !== 'running') {
      const payload = { step: 'deploy', ...hosted };
      if (flags.json) log.print(JSON.stringify(payload, null, 2));
      else {
        say(`  ✗ ${hosted.blocked_by || 'could not start an instance'}`);
        for (const note of hosted.notes || []) say(`    ${note}`);
      }
      process.exitCode = 1;
      return;
    }
    say(`  ✓ running at ${hosted.url}`);

    say('\n② Account and site');
    const provisioned = await provisionOverHttp(hosted.url, {
      email,
      domain,
      timezone: flags.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      currency: flags.currency || 'EUR',
      password: flags.password,
    });
    say(`  ✓ ${provisioned.site.domain} · dashboard ${provisioned.dashboard_url}`);

    let installed = null;
    if (flags['site-path']) {
      say('\n③ Snippet');
      const { installSnippet, detectProject } = await import('../src/install.js');
      const root = path.resolve(flags['site-path']);
      const detected = detectProject(root);
      installed = installSnippet({
        root,
        snippet: provisioned.snippet,
        dryRun: Boolean(flags['dry-run']),
        replacePlausible: Boolean(flags['replace-plausible']),
      });
      say(`  ✓ ${detected.framework}: ${installed.changed.map((c) => `${c.action} ${path.relative(root, c.file)}`).join(', ') || 'nothing to patch'}`);
    }

    if (flags.json) {
      log.print(JSON.stringify({ deploy: hosted, provision: provisioned, install: installed }, null, 2));
      return;
    }

    log.print('\n④ Done');
    if (provisioned.password) log.print(`  password   ${provisioned.password}   ← shown once`);
    log.print(`  api key    ${provisioned.api_key}   ← shown once`);
    log.print(`  dashboard  ${provisioned.dashboard_url}`);
    log.print('');
    log.print(`  ${provisioned.snippet}`);
    log.print('');
    if (!flags['site-path']) log.print('  Put that tag in your <head>, or run:');
    if (!flags['site-path']) log.print(`    credible install --domain ${provisioned.site.domain} --url ${hosted.url} --path .`);
    log.print(`  Then check it: credible doctor --url ${hosted.url} --domain ${provisioned.site.domain} --api-key <key>`);
    for (const note of hosted.notes || []) log.print(`  note       ${note}`);
    log.print('');
  },

  /** Everything an assistant needs, in one command. */
  async provision() {
    getDb();
    const email = flags.email || positional[0];
    if (!email) {
      fail('Usage: credible provision --email you@example.com [--domain example.com] [--timezone Europe/Paris] [--json]');
    }
    const result = provision({
      email,
      password: flags.password,
      name: flags.name || '',
      domain: flags.domain || positional[1] || '',
      timezone: flags.timezone || 'UTC',
      currency: flags.currency || 'EUR',
      keyName: flags['key-name'] || 'CLI',
    });

    const origin = instanceOrigin();
    const payload = {
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      password: result.password,
      api_key: result.apiKey,
      site: result.site ? { domain: result.site.domain, timezone: result.site.timezone, currency: result.site.currency } : null,
      snippet: result.site ? snippetFor(origin, result.site.domain) : null,
      instance_url: origin,
      dashboard_url: result.site ? `${origin}/${result.site.domain}` : origin,
      created: result.created,
      next_steps: nextSteps(origin, result.site),
    };

    if (flags.json) {
      log.print(JSON.stringify(payload, null, 2));
      return;
    }

    log.print('');
    log.print(`  Account    ${payload.user.email}${result.created.user ? ' (created)' : ' (existing)'}`);
    if (payload.password) log.print(`  Password   ${payload.password}   ← shown once, save it now`);
    log.print(`  API key    ${payload.api_key}   ← shown once, save it now`);
    if (payload.site) {
      log.print(`  Site       ${payload.site.domain} (${payload.site.timezone})`);
      log.print(`  Dashboard  ${payload.dashboard_url}`);
      log.print('');
      log.print(`  ${payload.snippet}`);
    }
    log.print('');
  },

  /** Put the snippet into a website's source tree. */
  async install() {
    const root = path.resolve(flags.path || positional[1] || process.cwd());
    const domain = flags.domain || positional[0];
    if (!domain) {
      fail('Usage: credible install --domain example.com [--url https://analytics.example] [--path .] [--dry-run] [--json]');
    }
    const origin = flags.url || instanceOrigin();
    const snippet = snippetFor(origin, normalizeDomain(domain));
    const { detectProject, installSnippet } = await import('../src/install.js');

    const detected = detectProject(root);
    const result = installSnippet({
      root,
      snippet,
      dryRun: Boolean(flags['dry-run']),
      replacePlausible: Boolean(flags['replace-plausible']),
      files: flags.file ? [flags.file] : undefined,
    });

    if (flags.json) {
      log.print(JSON.stringify({ root, snippet, detected, result, dry_run: Boolean(flags['dry-run']) }, null, 2));
      return;
    }

    log.print(`Project    ${detected.framework} (${detected.confidence} confidence) — ${detected.reason}`);
    if (!result.changed.length) {
      log.print('No place to put the snippet was found. Add it to your <head> by hand:');
      log.print(`  ${snippet}`);
    }
    for (const change of result.changed) {
      log.print(`${change.action.padEnd(10)} ${path.relative(root, change.file) || change.file}`);
      if (change.diff) log.print(change.diff.split('\n').map((line) => `           ${line}`).join('\n'));
    }
    for (const note of [...(detected.notes || []), ...(result.notes || [])]) log.print(`note       ${note}`);
    if (flags['dry-run']) log.print('\nNothing was written (--dry-run).');
  },

  async seed() {
    getDb();
    const { seed } = await import('../demo/seed.js');
    const domain = positional[0] || flags.domain || 'demo.credible.dev';
    const days = Number(flags.days || 60);
    const result = seed({ domain, days, dailyVisitors: Number(flags.visitors || 220) });
    optimize();
    log.print(`Seeded ${result.events} events / ${result.visits} visits for ${domain} over ${days} days.`);
    log.print(`Start the server and open http://localhost:${config.port}/${domain}`);
  },

  'user:add': async () => {
    getDb();
    const email = positional[0] || flags.email;
    if (!email) fail('Usage: credible user:add <email> [--password secret] [--name "Jane"]');
    const password = flags.password || randomPassword();
    if (findUserByEmail(email)) fail(`${email} already has an account`);
    const user = createUser({ email, password, name: flags.name || '' });
    const apiKey = flags['api-key'] ? createApiKey(user.id, 'CLI') : null;
    if (flags.json) {
      log.print(JSON.stringify({
        user: { id: user.id, email: user.email, name: user.name },
        password: flags.password ? null : password,
        api_key: apiKey,
      }, null, 2));
      return;
    }
    log.print(`Created ${user.email}`);
    if (!flags.password) log.print(`Password: ${password}`);
    if (apiKey) log.print(`API key: ${apiKey}`);
  },

  'site:add': async () => {
    getDb();
    const domain = positional[0] || flags.domain;
    if (!domain) fail('Usage: credible site:add <domain> [--email owner@example.com] [--timezone Europe/Paris]');
    const site =
      findSiteByDomain(normalizeDomain(domain)) ||
      createSite({ domain, timezone: flags.timezone || 'UTC', currency: flags.currency || 'EUR' });
    if (flags.email) {
      const owner = findUserByEmail(flags.email);
      if (!owner) fail(`No account for ${flags.email} — run: credible user:add ${flags.email}`);
      addMember(site.id, owner.id, 'owner');
    }
    const snippet = snippetFor(instanceOrigin(), site.domain);
    if (flags.json) {
      log.print(JSON.stringify({
        site: { domain: site.domain, timezone: site.timezone, currency: site.currency },
        snippet,
        dashboard_url: `${instanceOrigin()}/${site.domain}`,
      }, null, 2));
      return;
    }
    log.print(`Tracking ${site.domain} (${site.timezone})`);
    log.print(snippet);
  },

  'site:list': async () => {
    getDb();
    const sites = listAllSites();
    if (flags.json) {
      log.print(JSON.stringify(
        sites.map((site) => ({ domain: site.domain, timezone: site.timezone, currency: site.currency })),
        null,
        2,
      ));
      return undefined;
    }
    if (!sites.length) return log.print('No sites yet.');
    for (const site of sites) log.print(`${site.domain.padEnd(32)} ${site.timezone}`);
    return undefined;
  },

  async export() {
    getDb();
    const domain = positional[0];
    if (!domain) fail('Usage: credible export <domain> [--days 30]');
    const site = findSiteByDomain(normalizeDomain(domain));
    if (!site) fail(`Unknown site: ${domain}`);
    const days = Number(flags.days || 3650);
    const rows = all(
      `SELECT timestamp, name, visitor_id, visit_id, pathname, channel, referrer_source, referrer,
              utm_source, utm_medium, utm_campaign, country_code, region, city,
              browser, os, device, screen_size, props, revenue, currency
         FROM events WHERE site_id = ? AND timestamp > unixepoch() - ? ORDER BY timestamp`,
      [site.id, days * 86400],
    );
    const columns = rows.length ? Object.keys(rows[0]) : [];
    process.stdout.write(`${columns.join(',')}\n`);
    for (const row of rows) {
      process.stdout.write(`${columns.map((c) => csvCell(row[c])).join(',')}\n`);
    }
  },

  async version() {
    log.print(`credible ${config.version}`);
  },

  async help() {
    log.print(`credible <command>

  up                       host it, create the account, install the snippet — everything
                             --email you@example.com --domain example.com
                             [--target auto|local|tunnel|docker|fly] [--site-path .] [--json]
  deploy                   stand up a persistent instance
                             [--target …] [--port …] [--detect] [--dry-run] [--yes] [--json]
  doctor                   check an instance is usable and say what to fix
                             [--url …] [--domain …] [--api-key …] [--json]
  serve                    start the HTTP server (default)
  provision                account + site + API key in one command
                             --email you@example.com [--domain example.com]
                             [--timezone Europe/Paris] [--currency EUR] [--password] [--json]
  install                  insert the snippet into a website's source tree
                             --domain example.com [--url https://analytics.example]
                             [--path .] [--dry-run] [--replace-plausible] [--json]
  seed [domain]            generate demo traffic  [--days 60] [--visitors 220]
  user:add <email>         create an account      [--password] [--name] [--api-key] [--json]
  site:add <domain>        track a site           [--email owner] [--timezone] [--json]
  site:list                list tracked sites     [--json]
  export <domain>          write events as CSV to stdout [--days 30]
  version

Setting this up with an AI assistant? Point it at docs/AI-SETUP.md, or at
<instance>/llms.txt for a brief with your instance's real URLs baked in.

Environment: CREDIBLE_PORT, CREDIBLE_HOST, CREDIBLE_DATA_DIR, CREDIBLE_BASE_URL,
CREDIBLE_TRUST_PROXY, CREDIBLE_OPEN_REGISTRATION, CREDIBLE_RETENTION_DAYS…
See docs/SELF-HOSTING.md for the full list.`);
  },
};

function csvCell(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Where this instance answers, for snippets and links printed by the CLI. */
function instanceOrigin() {
  return (config.baseUrl || `http://localhost:${config.port}`).replace(/\/+$/, '');
}

/**
 * Provision against a running instance over HTTP rather than in-process: `up`
 * may have just deployed to Fly or Docker, where the database is not ours.
 */
async function provisionOverHttp(url, body) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/v1/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `provisioning failed (${response.status})`);
  return payload;
}

function formatEnvironment(environment) {
  const mark = (value) => (value ? '✓' : '·');
  const { tools } = environment;
  return [
    '',
    `  platform   ${environment.platform} · node ${environment.node}`,
    `  ${mark(tools.flyctl.available)} flyctl      ${tools.flyctl.available ? `${tools.flyctl.version}${tools.flyctl.authenticated ? ` (${tools.flyctl.account})` : ' — not logged in'}` : 'not installed'}`,
    `  ${mark(tools.docker.available)} docker      ${tools.docker.available ? `${tools.docker.version}${tools.docker.running ? '' : ' — daemon not running'}` : 'not installed'}`,
    `  ${mark(tools.cloudflared.available)} cloudflared ${tools.cloudflared.available ? tools.cloudflared.version : 'not installed'}`,
    `  ${mark(tools.launchd.available || tools.systemd.available)} service     ${tools.launchd.available ? 'launchd' : tools.systemd.user ? 'systemd (user)' : 'none — the process will not survive a reboot'}`,
    '',
    `  recommended ${environment.recommended} — ${environment.reason}`,
    ...(environment.notes || []).map((note) => `  note        ${note}`),
    '',
  ].join('\n');
}

function fail(message) {
  log.print(message);
  process.exit(1);
}

const handler = commands[command] || commands[`${command}:list`];
if (!handler) {
  log.print(`Unknown command: ${command}\n`);
  await commands.help();
  process.exit(1);
}

try {
  await handler();
} catch (err) {
  log.error(err);
  process.exit(1);
}
