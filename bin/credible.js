#!/usr/bin/env node
/**
 * Credible command line.
 *
 *   credible serve                     start the server (default)
 *   credible seed [domain]             fill the database with demo traffic
 *   credible user:add <email>          create an account
 *   credible site:add <domain>         start tracking a site
 *   credible site:list                 list tracked sites
 *   credible export <domain>           dump events as CSV to stdout
 *   credible version
 */
import process from 'node:process';
import { config, ensureDataDir } from '../src/config.js';
import { getDb, all, optimize } from '../src/db/index.js';
import { createUser, findUserByEmail, userCount, createApiKey } from '../src/auth/index.js';
import { addMember, createSite, findSiteByDomain, listAllSites, normalizeDomain } from '../src/sites.js';
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
    log.print(`Created ${user.email}`);
    if (!flags.password) log.print(`Password: ${password}`);
    if (flags['api-key']) log.print(`API key: ${createApiKey(user.id, 'CLI')}`);
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
    log.print(`Tracking ${site.domain} (${site.timezone})`);
    log.print(`<script defer data-domain="${site.domain}" src="${config.baseUrl || `http://localhost:${config.port}`}/js/cr.js"></script>`);
  },

  'site:list': async () => {
    getDb();
    const sites = listAllSites();
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

  serve                    start the HTTP server (default)
  seed [domain]            generate demo traffic  [--days 60] [--visitors 220]
  user:add <email>         create an account      [--password] [--name] [--api-key]
  site:add <domain>        track a site           [--email owner] [--timezone]
  site:list                list tracked sites
  export <domain>          write events as CSV to stdout [--days 30]
  version

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

function randomPassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 16; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
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
