/**
 * From "nothing installed" to "an instance answering on a URL", in one call.
 *
 * The docs used to make a new user choose between a VPS, Docker and Fly.io
 * before they had seen a single pageview. This module removes that choice: it
 * looks at the machine, picks the best thing it can actually do, and does it.
 *
 *   detectEnvironment()   what this machine can host with, and what we'd pick
 *   deploy(options)       stand an instance up (idempotent)
 *   stopInstance(...)     stop what we started, and only what we started
 *   instanceStatus(url)   is it answering, and what does it know
 *
 * Four targets, in the order the recommendation prefers them:
 *
 *   fly      permanent public HTTPS URL, free tier, creates remote resources
 *   tunnel   public HTTPS in seconds, no account, EPHEMERAL hostname
 *   docker   a container that comes back after a reboot, localhost only
 *   local    a launchd/systemd service on this machine, localhost only
 *
 * Rules this file lives by: every spawned command is captured with its exit
 * code and output, a non-zero exit is recorded rather than thrown, nothing
 * destructive is ever run (no `rm -rf`, no `fly apps destroy`, no volume
 * deletion, no killing a process we did not start), and arguments are passed
 * as an argv array so nothing is ever handed to a shell to re-parse.
 *
 * Zero dependencies, like the rest of Credible: Node built-ins only.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ------------------------------------------------------------- constants --

/** Detection must feel instant, so every probe gets a short leash. */
const PROBE_TIMEOUT_MS = 3000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** `docker build` and `fly deploy` genuinely take minutes on a cold cache. */
const LONG_TIMEOUT_MS = 600_000;
/** `docker info` fails fast when the daemon is down; don't wait two minutes. */
const DAEMON_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5000;
const LOCAL_READY_TIMEOUT_MS = 15_000;
const REMOTE_READY_TIMEOUT_MS = 45_000;
const TUNNEL_URL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 4000;

const LAUNCHD_LABEL = 'dev.credible';
const LAUNCHD_TUNNEL_LABEL = 'dev.credible.tunnel';
const SYSTEMD_UNIT = 'credible';
const SYSTEMD_TUNNEL_UNIT = 'credible-tunnel';

const DOCKER_CONTAINER = 'credible';
const DOCKER_IMAGE = 'credible:latest';
const DOCKER_VOLUME = 'credible_data';
const FLY_VOLUME = 'credible_data';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY_POINT = path.join(REPO_ROOT, 'bin', 'credible.js');
const HOME = os.homedir();
const CREDIBLE_HOME = path.join(HOME, '.credible');
const DEFAULT_DATA_DIR = path.join(CREDIBLE_HOME, 'data');
const LOG_DIR = path.join(CREDIBLE_HOME, 'logs');
const SERVER_LOG = path.join(LOG_DIR, 'credible.log');
const SERVER_ERR_LOG = path.join(LOG_DIR, 'credible.err.log');
const TUNNEL_LOG = path.join(LOG_DIR, 'tunnel.log');

const TARGETS = new Set(['auto', 'local', 'tunnel', 'docker', 'fly']);
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

// ------------------------------------------------------------- utilities --

/** Deliberately not unref'd: a poll loop must keep the process alive. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Trim captured output so a runaway build log never ends up in a JSON reply. */
function trimOutput(value) {
  const text = String(value ?? '').trim();
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

const firstLine = (text) => String(text || '').trim().split('\n')[0].trim();

/**
 * Quote a value for the human-readable `cmd` string only. Nothing built here
 * is ever executed — commands run through spawn() with an argv array.
 */
function shellQuote(value) {
  const text = String(value);
  if (text === '') return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

const displayCommand = (file, args) => [file, ...args].map(shellQuote).join(' ');

/** A command record for a command we chose not to run (dry run, or a plan). */
const plannedCommand = (file, args, output = '') => ({
  cmd: displayCommand(file, args),
  ran: false,
  code: null,
  output,
});

/**
 * Synchronous probe used by detectEnvironment(). Never throws: a missing
 * binary, a timeout and a crash all come back as a record.
 */
function probe(file, args, timeout = PROBE_TIMEOUT_MS) {
  try {
    const result = spawnSync(file, args, { timeout, encoding: 'utf8', windowsHide: true });
    if (result.error) {
      return { ran: false, code: null, output: trimOutput(result.error.message) };
    }
    return {
      ran: true,
      code: result.status,
      output: trimOutput(`${result.stdout || ''}${result.stderr || ''}`),
    };
  } catch (err) {
    return { ran: false, code: null, output: trimOutput(err?.message) };
  }
}

/**
 * Absolute path of a binary. launchd and systemd start with a minimal PATH,
 * so a unit file that says `cloudflared` will not find it.
 * The name is matched against a strict pattern because it reaches `sh -c`.
 */
function resolveBinary(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) return '';
  const result = probe('/bin/sh', ['-c', `command -v ${name}`]);
  return result.code === 0 ? firstLine(result.output) : '';
}

/**
 * Run a command, capture everything, never throw.
 * @returns {Promise<{cmd:string, ran:boolean, code:number|null, output:string}>}
 */
function runCommand(file, args, { timeout = DEFAULT_TIMEOUT_MS, cwd, env } = {}) {
  const cmd = displayCommand(file, args);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ cmd, ran: false, code: null, output: trimOutput(err?.message) });
      return;
    }

    let output = '';
    let settled = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(record);
    };
    const timer = setTimeout(() => {
      output += `\n[no answer after ${Math.round(timeout / 1000)}s — the command was stopped]`;
      // Only ever a process we started ourselves.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }, timeout);

    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (err) => finish({ cmd, ran: false, code: null, output: trimOutput(`${output}\n${err.message}`) }));
    child.on('close', (code) => finish({ cmd, ran: true, code, output: trimOutput(output) }));
  });
}

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** systemd accepts a quoted Environment= value, which is what makes spaces safe. */
const systemdValue = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Write a file, reporting whether it actually differs — that is our "converged". */
function writeFileTracked(file, contents) {
  let existed = false;
  let changed = true;
  try {
    existed = true;
    changed = fs.readFileSync(file, 'utf8') !== contents;
  } catch {
    existed = false;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return { existed, changed };
}

// ----------------------------------------------------------- environment --

let cachedFlyBinary;

/** `fly` on a modern install, `flyctl` on an older one, '' when absent. */
function flyBinary() {
  if (cachedFlyBinary !== undefined) return cachedFlyBinary;
  cachedFlyBinary = '';
  for (const candidate of ['fly', 'flyctl']) {
    const result = probe(candidate, ['version']);
    if (result.ran && result.code === 0) {
      cachedFlyBinary = candidate;
      break;
    }
  }
  return cachedFlyBinary;
}

/**
 * What this machine can host with, and what we would pick.
 * Pure inspection: it starts no server, writes no file and changes nothing.
 *
 * @returns {{
 *   platform: string, node: string, repoRoot: string,
 *   tools: {
 *     docker: {available: boolean, running: boolean, version: string},
 *     flyctl: {available: boolean, authenticated: boolean, version: string, account: string},
 *     cloudflared: {available: boolean, version: string},
 *     systemd: {available: boolean, user: boolean},
 *     launchd: {available: boolean},
 *   },
 *   recommended: 'fly'|'tunnel'|'local'|'docker', reason: string, notes: string[],
 * }}
 */
export function detectEnvironment() {
  const notes = [];

  // --- docker: installed is cheap to know, running needs the daemon socket.
  const dockerVersion = probe('docker', ['--version']);
  const docker = {
    available: dockerVersion.ran && dockerVersion.code === 0,
    running: false,
    version: dockerVersion.code === 0 ? firstLine(dockerVersion.output) : '',
  };
  if (docker.available) {
    // `docker info` is the daemon check; --format keeps a page of output down
    // to one line without changing what exit code 0 means.
    docker.running = probe('docker', ['info', '--format', '{{.ServerVersion}}']).code === 0;
  }

  // --- flyctl: authenticated is the only state that unlocks the fly target.
  const flyBin = flyBinary();
  const flyctl = { available: Boolean(flyBin), authenticated: false, version: '', account: '' };
  if (flyBin) {
    flyctl.version = firstLine(probe(flyBin, ['version']).output);
    const whoami = probe(flyBin, ['auth', 'whoami']);
    flyctl.authenticated = whoami.code === 0;
    if (whoami.code === 0) flyctl.account = firstLine(whoami.output);
    else if (!whoami.ran) notes.push('`fly auth whoami` did not answer within 3s, so the Fly account could not be confirmed.');
  }

  // --- cloudflared: presence is enough, a quick tunnel needs no account.
  const cloudflaredVersion = probe('cloudflared', ['--version']);
  const cloudflared = {
    available: cloudflaredVersion.ran && cloudflaredVersion.code === 0,
    version: cloudflaredVersion.code === 0 ? firstLine(cloudflaredVersion.output) : '',
  };

  // --- service managers.
  const systemctlVersion = probe('systemctl', ['--version']);
  const systemd = { available: systemctlVersion.ran && systemctlVersion.code === 0, user: false };
  if (systemd.available) {
    // A non-zero exit is fine here ("degraded" exits 1). What disqualifies the
    // user bus is the "not been booted" / "failed to connect" family of errors,
    // which is what you get inside a container or over a bare SSH session.
    const state = probe('systemctl', ['--user', 'is-system-running']);
    systemd.user = state.ran && !/has not been booted|failed to connect|no such file or directory/i.test(state.output);
  }
  const launchd = { available: process.platform === 'darwin' && fs.existsSync('/bin/launchctl') };

  // --- the recommendation.
  let recommended = 'local';
  let reason = '';
  if (flyctl.authenticated) {
    recommended = 'fly';
    reason = `flyctl is authenticated${flyctl.account ? ` as ${flyctl.account}` : ''}, so Fly.io can give this instance a permanent public HTTPS URL on the free tier.`;
  } else if (cloudflared.available) {
    recommended = 'tunnel';
    reason = 'cloudflared is installed, so a public HTTPS URL is seconds away with no account at all — but the hostname is ephemeral.';
  } else if (docker.running) {
    recommended = 'docker';
    reason = 'The Docker daemon is running, so a container with a named volume is the sturdiest local option.';
  } else {
    const manager = launchd.available ? 'launchd' : systemd.user ? 'systemd' : 'a detached process';
    recommended = 'local';
    reason = `No hosting tool is ready, so run it here as ${manager} and reach it on localhost.`;
  }

  // --- notes: only things the caller can act on.
  if (docker.available && !docker.running) {
    notes.push('Docker is installed but its daemon is not running — start Docker Desktop (or `colima start`) before using the docker target.');
  }
  if (flyctl.available && !flyctl.authenticated) {
    notes.push('flyctl is installed but not authenticated — run `flyctl auth login` to unlock the fly target and its permanent HTTPS URL.');
  }
  if (!flyctl.available) {
    notes.push('flyctl is not installed — see https://fly.io/docs/flyctl/install/ if you want a permanent public URL on the free tier.');
  }
  if (recommended === 'tunnel') {
    notes.push('A cloudflared quick tunnel hostname changes every time the tunnel restarts. It is right for trying Credible out, wrong for a snippet you leave in production.');
  }
  if (!launchd.available && !systemd.user && process.platform !== 'win32') {
    notes.push('No user service manager was found, so a local instance is started detached and will not come back after a reboot.');
  }
  if (process.platform === 'win32') {
    notes.push('Windows has no supported service manager here — the local target starts a detached process that stops at reboot. WSL2 or Docker is a better home for a long-running instance.');
  }

  return {
    platform: process.platform,
    node: process.version,
    repoRoot: REPO_ROOT,
    tools: { docker, flyctl, cloudflared, systemd, launchd },
    recommended,
    reason,
    notes,
  };
}

// ---------------------------------------------------------------- health --

/**
 * Ask an instance how it is. GETs <url>/api/health with a 5s timeout and
 * never throws — a dead URL is a normal answer, not an exception.
 *
 * @param {string} url
 * @returns {Promise<{reachable:boolean, healthy:boolean, version:string,
 *                    events:number, uptime:number, error:string}>}
 */
export async function instanceStatus(url) {
  const blank = { reachable: false, healthy: false, version: '', events: 0, uptime: 0, error: '' };
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) {
    return { ...blank, error: `not a usable http(s) URL: ${JSON.stringify(String(url ?? ''))}` };
  }

  let response;
  try {
    response = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') return { ...blank, error: 'no answer within 5s' };
    // fetch() reports every network failure as "fetch failed" and hides the
    // useful part (ECONNREFUSED, ENOTFOUND, a TLS error) in the cause. A host
    // that resolves to both ::1 and 127.0.0.1 nests them in an AggregateError.
    let detail = err?.message;
    const cause = err?.cause;
    if (detail === 'fetch failed' && cause) {
      detail = cause.message
        || (Array.isArray(cause.errors) ? [...new Set(cause.errors.map((e) => e?.message).filter(Boolean))].join('; ') : '')
        || detail;
    }
    return { ...blank, error: String(detail || err) };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { ...blank, reachable: true, error: `HTTP ${response.status}` };
  }
  return {
    reachable: true,
    healthy: body?.status === 'ok',
    version: String(body?.version || ''),
    events: Number(body?.events || 0),
    uptime: Number(body?.uptime || 0),
    error: body?.status === 'ok' ? '' : 'answered, but not with status "ok"',
  };
}

/** Poll until the instance answers, or give up. Returns the last status seen. */
async function waitForHealth(probeUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await instanceStatus(probeUrl);
  while (!last.reachable && Date.now() < deadline) {
    await sleep(500);
    last = await instanceStatus(probeUrl);
  }
  return last;
}

// --------------------------------------------------------------- options --

/**
 * Validate and normalise everything a caller can get wrong, once, up front.
 * Throws on input a deploy could not act on sanely; everything else that can
 * go wrong comes back as a `blocked` result instead.
 */
function normalizeOptions(options = {}) {
  const target = options.target ?? 'auto';
  if (!TARGETS.has(target)) {
    throw new TypeError(`Unknown deploy target ${JSON.stringify(target)} — expected one of: ${[...TARGETS].join(', ')}`);
  }

  const port = options.port === undefined ? 8000 : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`port must be an integer between 1 and 65535, got ${JSON.stringify(options.port)}`);
  }

  const explicitDataDir = typeof options.dataDir === 'string' && options.dataDir.trim() !== '';
  const dataDir = explicitDataDir ? path.resolve(options.dataDir.trim()) : DEFAULT_DATA_DIR;
  const insideHome = dataDir === HOME || dataDir.startsWith(`${HOME}${path.sep}`);
  // Outside the home directory is allowed, but only when the caller asked for
  // it by name with an absolute path — never as a side effect of a relative one.
  if (!insideHome && !(explicitDataDir && path.isAbsolute(options.dataDir.trim()))) {
    throw new Error(`dataDir ${dataDir} is outside ${HOME}; pass an explicit absolute path if that is really what you want`);
  }
  if (dataDir === path.parse(dataDir).root) {
    throw new Error('dataDir cannot be the filesystem root');
  }

  const appName = options.appName ? String(options.appName).trim() : `credible-${randomSuffix()}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appName)) {
    throw new Error(`appName ${JSON.stringify(appName)} is not a valid Fly app name (lowercase letters, digits and dashes)`);
  }

  const region = options.region ? String(options.region).trim() : 'cdg';
  if (!/^[a-z]{3}$/.test(region)) {
    throw new Error(`region ${JSON.stringify(region)} is not a Fly region code (three lowercase letters, e.g. cdg)`);
  }

  return {
    target,
    port,
    dataDir,
    appName,
    region,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
  };
}

/** Six characters of entropy for a default Fly app name. Not a secret. */
function randomSuffix() {
  try {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  } catch {
    return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }
}

/** Everything a target implementation needs, plus where it records what it did. */
function createContext(opts, target, env) {
  return {
    ...opts,
    target,
    env,
    commands: [],
    notes: [],
    /** Progress is a courtesy to the caller: it must never break a deploy. */
    step(message, done = false) {
      if (!this.onProgress) return;
      try {
        this.onProgress({ message, done });
      } catch { /* a broken reporter is not a broken deploy */ }
    },
    /** Run a command and record it. In a dry run it is only ever recorded. */
    async run(file, args, options = {}) {
      if (this.dryRun) {
        const record = plannedCommand(file, args, '[dry run — not executed]');
        this.commands.push(record);
        return record;
      }
      const record = await runCommand(file, args, options);
      this.commands.push(record);
      return record;
    },
    plan(file, args, output = '') {
      const record = plannedCommand(file, args, output);
      this.commands.push(record);
      return record;
    },
  };
}

/** Shape every return value the same way, so a caller can trust the fields. */
function result(ctx, fields) {
  return {
    target: ctx.target,
    status: fields.status,
    url: fields.url || '',
    ephemeral: Boolean(fields.ephemeral),
    service: fields.service || null,
    commands: ctx.commands,
    blocked_by: fields.status === 'blocked' ? fields.blocked_by || 'unknown' : '',
    notes: ctx.notes,
    next: fields.next || [],
  };
}

// ---------------------------------------------------------------- deploy --

/**
 * Stand an instance up. Idempotent: running it twice converges on the same
 * instance rather than creating a second one.
 *
 * @param {object} [options]
 * @param {'auto'|'local'|'tunnel'|'docker'|'fly'} [options.target='auto']
 * @param {number}  [options.port=8000]
 * @param {string}  [options.dataDir]   defaults to ~/.credible/data
 * @param {string}  [options.appName]   fly app name, defaults to credible-<suffix>
 * @param {string}  [options.region]    fly region, default 'cdg'
 * @param {boolean} [options.yes=false] REQUIRED for anything that creates remote resources
 * @param {boolean} [options.dryRun=false]
 * @param {(step:{message:string,done?:boolean})=>void} [options.onProgress]
 * @returns {Promise<{target:string, status:'running'|'planned'|'blocked', url:string,
 *   ephemeral:boolean, service:{kind:string,name:string,file:string|null}|null,
 *   commands:Array<{cmd:string,ran:boolean,code:number|null,output:string}>,
 *   blocked_by:string, notes:string[], next:string[]}>}
 */
export async function deploy(options = {}) {
  const opts = normalizeOptions(options);
  const env = detectEnvironment();
  const target = opts.target === 'auto' ? env.recommended : opts.target;
  const ctx = createContext(opts, target, env);

  if (opts.target === 'auto') {
    ctx.notes.push(`Target chosen automatically: ${target}. ${env.reason}`);
  }
  if (opts.dryRun) {
    ctx.notes.push('Dry run: nothing was executed, no file was written and no network call was made.');
  }
  if (!fs.existsSync(ENTRY_POINT) && (target === 'local' || target === 'tunnel')) {
    ctx.notes.push(`The CLI entry point is missing at ${ENTRY_POINT}.`);
    return result(ctx, { status: 'blocked', blocked_by: `no ${ENTRY_POINT} — run deploy from a Credible checkout` });
  }

  ctx.step(`Deploying with target "${target}"`);
  switch (target) {
    case 'local':
      return deployLocal(ctx);
    case 'tunnel':
      return deployTunnel(ctx);
    case 'docker':
      return deployDocker(ctx);
    case 'fly':
      return deployFly(ctx);
    default:
      return result(ctx, { status: 'blocked', blocked_by: `unsupported target ${target}` });
  }
}

// ----------------------------------------------------------------- local --

/** Which service manager the local target will use on this machine. */
function serviceKind(env) {
  if (env.tools.launchd.available) return 'launchd';
  if (env.tools.systemd.user) return 'systemd';
  return 'none';
}

function launchAgentPath(label) {
  return path.join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
}

function systemdUnitPath(unit) {
  return path.join(HOME, '.config', 'systemd', 'user', `${unit}.service`);
}

/** The environment the served process runs with. Localhost only, by design. */
function serverEnvironment(ctx, baseUrl) {
  return {
    CREDIBLE_DATA_DIR: ctx.dataDir,
    CREDIBLE_PORT: String(ctx.port),
    CREDIBLE_BASE_URL: baseUrl,
    // The local and tunnel targets never listen on a public interface: a
    // tunnel reaches 127.0.0.1 from this machine, and nothing else should.
    CREDIBLE_HOST: '127.0.0.1',
  };
}

function plistFor({ label, programArguments, environment, stdout, stderr, workingDirectory }) {
  const args = programArguments.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n');
  const vars = Object.entries(environment)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderr)}</string>
  </dict>
</plist>
`;
}

function systemdUnitFor({ description, execStart, environment, workingDirectory, logFile }) {
  const vars = Object.entries(environment)
    .map(([key, value]) => `Environment=${systemdValue(`${key}=${value}`)}`)
    .join('\n');
  return `[Unit]
Description=${description}
Documentation=https://github.com/maixmeduret/credible
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
ExecStart=${execStart}
${vars}
Restart=always
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Load (or reload) a launchd agent. `bootout` first is what makes this
 * idempotent — it is also expected to fail the first time, which is fine.
 */
async function reloadLaunchAgent(ctx, label, plistFile) {
  const domain = `gui/${process.getuid?.() ?? ''}`;
  await ctx.run('launchctl', ['bootout', `${domain}/${label}`], { timeout: 20_000 });
  // `bootout` returns before launchd has finished retiring the label, and
  // bootstrapping into that window fails with "Input/output error" (5).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && probe('launchctl', ['print', `${domain}/${label}`]).code === 0) {
    await sleep(250);
  }
  const bootstrap = await ctx.run('launchctl', ['bootstrap', domain, plistFile], { timeout: 20_000 });
  if (bootstrap.ran && bootstrap.code !== 0) {
    // Older macOS, or a domain that refuses bootstrap: the legacy verb still works.
    const legacy = await ctx.run('launchctl', ['load', '-w', plistFile], { timeout: 20_000 });
    return legacy.code === 0;
  }
  return bootstrap.code === 0;
}

async function reloadSystemdUnit(ctx, unit) {
  await ctx.run('systemctl', ['--user', 'daemon-reload'], { timeout: 30_000 });
  const enable = await ctx.run('systemctl', ['--user', 'enable', '--now', unit], { timeout: 30_000 });
  if (enable.code === 0) {
    // A unit that was already enabled does not restart on `enable --now`.
    await ctx.run('systemctl', ['--user', 'restart', unit], { timeout: 30_000 });
  }
  return enable.code === 0;
}

/**
 * A local service listening on localhost, surviving logout and reboot where
 * the platform allows it.
 * @param {object} ctx
 * @param {string} [baseUrl] public origin to bake in (the tunnel target sets this)
 */
async function deployLocal(ctx, baseUrl = `http://localhost:${ctx.port}`) {
  const kind = serviceKind(ctx.env);
  const probeUrl = `http://127.0.0.1:${ctx.port}`;
  const environment = serverEnvironment(ctx, baseUrl);
  const service = { kind, name: kind === 'systemd' ? SYSTEMD_UNIT : kind === 'launchd' ? LAUNCHD_LABEL : 'credible (detached)', file: null };
  if (kind === 'launchd') service.file = launchAgentPath(LAUNCHD_LABEL);
  if (kind === 'systemd') service.file = systemdUnitPath(SYSTEMD_UNIT);
  const next = localNextSteps(ctx, baseUrl);

  if (ctx.dryRun) {
    if (kind === 'launchd') {
      ctx.plan('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`]);
      ctx.plan('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, service.file]);
    } else if (kind === 'systemd') {
      ctx.plan('systemctl', ['--user', 'daemon-reload']);
      ctx.plan('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    } else {
      ctx.plan(process.execPath, [ENTRY_POINT, 'serve'], '[would be spawned detached]');
    }
    ctx.notes.push(`Would write ${service.file || `${path.join(ctx.dataDir, 'credible.pid')} (pid file)`} and serve ${ctx.dataDir} on ${baseUrl}.`);
    return result(ctx, { status: 'planned', url: baseUrl, service, next });
  }

  ctx.step('Preparing directories');
  ensureDir(ctx.dataDir);
  ensureDir(LOG_DIR);

  if (kind === 'launchd') {
    ctx.step('Writing the launch agent');
    const contents = plistFor({
      label: LAUNCHD_LABEL,
      programArguments: [process.execPath, ENTRY_POINT, 'serve'],
      environment,
      stdout: SERVER_LOG,
      stderr: SERVER_ERR_LOG,
      workingDirectory: REPO_ROOT,
    });
    const written = writeFileTracked(service.file, contents);
    ctx.notes.push(written.existed
      ? `Reused the existing launch agent at ${service.file}${written.changed ? ' (its settings changed)' : ' (unchanged)'}.`
      : `Wrote a launch agent at ${service.file}.`);
    ctx.step('Loading the service into launchd');
    await reloadLaunchAgent(ctx, LAUNCHD_LABEL, service.file);
  } else if (kind === 'systemd') {
    ctx.step('Writing the systemd user unit');
    const contents = systemdUnitFor({
      description: 'Credible — privacy-first web analytics',
      execStart: `${process.execPath} ${ENTRY_POINT} serve`,
      environment,
      workingDirectory: REPO_ROOT,
      logFile: SERVER_LOG,
    });
    const written = writeFileTracked(service.file, contents);
    ctx.notes.push(written.existed
      ? `Reused the existing unit at ${service.file}${written.changed ? ' (its settings changed)' : ' (unchanged)'}.`
      : `Wrote a systemd user unit at ${service.file}.`);
    ctx.step('Enabling the service');
    await reloadSystemdUnit(ctx, SYSTEMD_UNIT);
    ctx.notes.push(`Run \`loginctl enable-linger ${os.userInfo().username}\` so the service also runs when you are not logged in.`);
  } else {
    await startDetached(ctx, environment, probeUrl);
  }

  ctx.step('Waiting for the instance to answer');
  const health = await waitForHealth(probeUrl, LOCAL_READY_TIMEOUT_MS);
  if (!health.reachable) {
    ctx.notes.push(`Logs: ${SERVER_ERR_LOG} and ${SERVER_LOG}.`);
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `nothing answered on ${probeUrl}/api/health within 15s (${health.error})`,
      next: [`Read the log: tail -n 50 ${SERVER_ERR_LOG}`, `Check the port is free: lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN`],
    });
  }

  ctx.notes.push(`Credible ${health.version} is answering on ${baseUrl} with ${health.events} events stored in ${ctx.dataDir}.`);
  ctx.step('Instance is up', true);
  return result(ctx, { status: 'running', url: baseUrl, service, next });
}

/** No service manager: a detached process and an honest warning. */
async function startDetached(ctx, environment, probeUrl) {
  const pidFile = path.join(ctx.dataDir, 'credible.pid');
  const running = await instanceStatus(probeUrl);
  if (running.reachable) {
    ctx.notes.push(`Something already answers on ${probeUrl} — left it alone rather than starting a second copy.`);
    return;
  }

  ctx.step('Starting a detached process');
  const logFd = fs.openSync(SERVER_LOG, 'a');
  const record = plannedCommand(process.execPath, [ENTRY_POINT, 'serve']);
  try {
    const child = spawn(process.execPath, [ENTRY_POINT, 'serve'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...environment },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
    record.ran = true;
    record.code = 0;
    record.output = `started pid ${child.pid}, pid file ${pidFile}`;
  } catch (err) {
    record.output = trimOutput(err?.message);
  } finally {
    fs.closeSync(logFd);
  }
  ctx.commands.push(record);
  ctx.notes.push(`This machine has no user service manager, so Credible runs as a detached process (pid in ${pidFile}). It will NOT come back after a reboot — put it behind systemd, launchd or Docker before you rely on it.`);
}

function localNextSteps(ctx, url) {
  return [
    `Create the account and the first site: CREDIBLE_DATA_DIR=${ctx.dataDir} node ${ENTRY_POINT} provision --email you@example.com --domain example.com --json`,
    `Install the snippet in your site's source: node ${ENTRY_POINT} install --domain example.com --url ${url} --path /path/to/your/site`,
    `Or open ${url} and create the first account in the browser.`,
  ];
}

// ---------------------------------------------------------------- tunnel --

/**
 * A local instance plus a Cloudflare quick tunnel: public HTTPS in seconds,
 * no account, and a hostname that does not survive a restart.
 *
 * The tunnel is started under the service manager *first*, then we read the
 * hostname out of its log. Starting a throwaway tunnel to learn the hostname
 * and a supervised one to keep it alive would give two different hostnames.
 */
async function deployTunnel(ctx) {
  const kind = serviceKind(ctx.env);
  const cloudflaredPath = ctx.dryRun ? 'cloudflared' : resolveBinary('cloudflared');
  const loudNote = 'This hostname is EPHEMERAL: it changes every time the tunnel restarts, and it dies with it. Perfect for trying Credible out or sharing a demo for an afternoon — wrong for a snippet you leave in production. For that, use the fly target or a VPS with a domain you own.';

  if (!ctx.dryRun && !cloudflaredPath) {
    return result(ctx, {
      status: 'blocked',
      blocked_by: 'cloudflared is not installed',
      next: ['Install it: brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connector/', 'Or deploy without it: target "local" for localhost, "fly" for a permanent public URL.'],
    });
  }

  // Step 1 — the instance itself, on localhost, with a placeholder base URL.
  ctx.step('Starting the local instance');
  const local = await deployLocal(ctx);
  if (local.status === 'blocked') {
    ctx.notes.push('The tunnel was not started because the local instance never came up.');
    return { ...local, target: 'tunnel' };
  }

  const tunnelService = {
    kind,
    name: kind === 'systemd' ? SYSTEMD_TUNNEL_UNIT : kind === 'launchd' ? LAUNCHD_TUNNEL_LABEL : 'cloudflared (detached)',
    file: kind === 'launchd' ? launchAgentPath(LAUNCHD_TUNNEL_LABEL) : kind === 'systemd' ? systemdUnitPath(SYSTEMD_TUNNEL_UNIT) : null,
  };
  const tunnelArgs = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${ctx.port}`];

  if (ctx.dryRun) {
    ctx.plan(cloudflaredPath, tunnelArgs, '[would run under the service manager and print an https://<random>.trycloudflare.com hostname]');
    ctx.notes.push(loudNote);
    ctx.notes.push(`The hostname would be written to ${path.join(ctx.dataDir, 'tunnel-url.txt')} and baked into the instance as CREDIBLE_BASE_URL.`);
    return result(ctx, { status: 'planned', url: '', ephemeral: true, service: local.service, next: local.next });
  }

  // Step 2 — the tunnel, supervised, with its output going somewhere we can read.
  ctx.step('Opening a Cloudflare quick tunnel');
  fs.writeFileSync(TUNNEL_LOG, '', { mode: 0o600 }); // never read a stale hostname
  if (kind === 'launchd') {
    writeFileTracked(tunnelService.file, plistFor({
      label: LAUNCHD_TUNNEL_LABEL,
      programArguments: [cloudflaredPath, ...tunnelArgs],
      environment: {},
      stdout: TUNNEL_LOG,
      stderr: TUNNEL_LOG,
      workingDirectory: HOME,
    }));
    await reloadLaunchAgent(ctx, LAUNCHD_TUNNEL_LABEL, tunnelService.file);
  } else if (kind === 'systemd') {
    writeFileTracked(tunnelService.file, systemdUnitFor({
      description: 'Credible — Cloudflare quick tunnel',
      execStart: `${cloudflaredPath} ${tunnelArgs.join(' ')}`,
      environment: {},
      workingDirectory: HOME,
      logFile: TUNNEL_LOG,
    }));
    await reloadSystemdUnit(ctx, SYSTEMD_TUNNEL_UNIT);
  } else {
    const logFd = fs.openSync(TUNNEL_LOG, 'a');
    const record = plannedCommand(cloudflaredPath, tunnelArgs);
    try {
      const child = spawn(cloudflaredPath, tunnelArgs, { detached: true, stdio: ['ignore', logFd, logFd] });
      child.unref();
      fs.writeFileSync(path.join(ctx.dataDir, 'tunnel.pid'), `${child.pid}\n`, { mode: 0o600 });
      record.ran = true;
      record.code = 0;
      record.output = `started pid ${child.pid}`;
    } catch (err) {
      record.output = trimOutput(err?.message);
    } finally {
      fs.closeSync(logFd);
    }
    ctx.commands.push(record);
  }

  // Step 3 — read the hostname it printed.
  ctx.step('Waiting for the public hostname');
  const tunnelUrl = await waitForTunnelUrl(TUNNEL_URL_TIMEOUT_MS);
  if (!tunnelUrl) {
    ctx.notes.push(`The local instance is still running on http://localhost:${ctx.port}; only the public hostname is missing.`);
    ctx.notes.push(`Tunnel log: ${TUNNEL_LOG}`);
    return result(ctx, {
      status: 'blocked',
      url: '',
      ephemeral: true,
      service: local.service,
      blocked_by: 'cloudflared did not print a trycloudflare.com hostname within 60s',
      next: [`Read the tunnel log: tail -n 50 ${TUNNEL_LOG}`, 'Quick tunnels are rate limited — wait a minute and try again, or use the fly target.'],
    });
  }
  fs.writeFileSync(path.join(ctx.dataDir, 'tunnel-url.txt'), `${tunnelUrl}\n`, { mode: 0o600 });

  // Step 4 — restart the instance so snippets and shared links carry the public URL.
  ctx.step('Restarting the instance with its public URL');
  const republished = await deployLocal(ctx, tunnelUrl);
  ctx.notes.push(loudNote);
  ctx.notes.push(`The hostname is also in ${path.join(ctx.dataDir, 'tunnel-url.txt')}, and the tunnel runs as ${tunnelService.name}${tunnelService.file ? ` (${tunnelService.file})` : ''}.`);

  if (republished.status !== 'running') {
    return { ...republished, target: 'tunnel', url: '', ephemeral: true, blocked_by: republished.blocked_by || 'the instance did not restart with its public URL' };
  }

  const remote = await instanceStatus(tunnelUrl);
  if (!remote.reachable) {
    ctx.notes.push(`The tunnel is up but ${tunnelUrl} did not answer yet (${remote.error}). Cloudflare usually needs a few more seconds — retry with instanceStatus().`);
  }

  return result(ctx, {
    status: 'running',
    url: tunnelUrl,
    ephemeral: true,
    service: republished.service,
    next: [
      `Create the account and the first site: CREDIBLE_DATA_DIR=${ctx.dataDir} node ${ENTRY_POINT} provision --email you@example.com --domain example.com --json`,
      `Install the snippet: node ${ENTRY_POINT} install --domain example.com --url ${tunnelUrl} --path /path/to/your/site`,
      `Open ${tunnelUrl} to create the first account.`,
      'Before this becomes production, move to a permanent URL: deploy({ target: "fly", yes: true }).',
    ],
  });
}

/** Tail the tunnel log until cloudflared prints its hostname. */
async function waitForTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = fs.readFileSync(TUNNEL_LOG, 'utf8');
    } catch { /* not written yet */ }
    const match = text.match(QUICK_TUNNEL_RE);
    if (match) return match[0].toLowerCase();
    await sleep(500);
  }
  return '';
}

// ---------------------------------------------------------------- docker --

/**
 * A container with a named volume: it restarts with the machine and keeps its
 * database outside the image.
 */
async function deployDocker(ctx) {
  const service = { kind: 'docker', name: DOCKER_CONTAINER, file: path.join(REPO_ROOT, 'Dockerfile') };
  const url = `http://localhost:${ctx.port}`;
  const runArgs = [
    'run', '-d',
    '--name', DOCKER_CONTAINER,
    '--restart', 'unless-stopped',
    '-p', `${ctx.port}:8000`,
    '-v', `${DOCKER_VOLUME}:/data`,
    '-e', 'CREDIBLE_BASE_URL=',
    DOCKER_IMAGE,
  ];
  const next = [
    `Create the account and the first site: docker exec ${DOCKER_CONTAINER} node bin/credible.js provision --email you@example.com --domain example.com --json`,
    `Install the snippet: node ${ENTRY_POINT} install --domain example.com --url ${url} --path /path/to/your/site`,
    `Follow the logs: docker logs -f ${DOCKER_CONTAINER}`,
  ];

  if (ctx.dryRun) {
    ctx.plan('docker', ['build', '-t', DOCKER_IMAGE, REPO_ROOT]);
    ctx.plan('docker', ['rm', '-f', DOCKER_CONTAINER], '[only if a container of that name already exists]');
    ctx.plan('docker', runArgs);
    ctx.notes.push(`The database lives on the named volume ${DOCKER_VOLUME}, never inside the container, which is what makes recreating the container safe.`);
    return result(ctx, { status: 'planned', url, service, next });
  }

  ctx.step('Checking the Docker daemon');
  const info = await ctx.run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: DAEMON_TIMEOUT_MS });
  if (info.code !== 0) {
    ctx.notes.push(ctx.env.tools.docker.available
      ? `${ctx.env.tools.docker.version} is installed, but nothing is listening on its socket.`
      : 'The docker command itself was not found on this machine.');
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: 'the Docker daemon is not running',
      next: [
        'Start Docker Desktop (or `colima start`, or `sudo systemctl start docker`), then run this again.',
        'Or deploy without Docker: target "local" for localhost, "tunnel" for a quick public URL, "fly" for a permanent one.',
      ],
    });
  }

  ctx.step('Building the image (this can take a few minutes)');
  const build = await ctx.run('docker', ['build', '-t', DOCKER_IMAGE, REPO_ROOT], { timeout: LONG_TIMEOUT_MS, cwd: REPO_ROOT });
  if (build.code !== 0) {
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `docker build failed with exit code ${build.code}`,
      next: ['Read the build output above, fix what it names, and run this again.'],
    });
  }

  // Idempotent converge: the container is disposable, the volume is not.
  const existing = await ctx.run('docker', ['ps', '-a', '--filter', `name=^${DOCKER_CONTAINER}$`, '--format', '{{.Names}}'], { timeout: 30_000 });
  if (existing.code === 0 && existing.output.split('\n').includes(DOCKER_CONTAINER)) {
    ctx.step('Replacing the existing container');
    await ctx.run('docker', ['rm', '-f', DOCKER_CONTAINER], { timeout: 60_000 });
    ctx.notes.push(`An existing container named ${DOCKER_CONTAINER} was replaced. Its data was never at risk: the database lives on the named volume ${DOCKER_VOLUME}.`);
  }

  ctx.step('Starting the container');
  const started = await ctx.run('docker', runArgs, { timeout: 60_000 });
  if (started.code !== 0) {
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `docker run failed with exit code ${started.code}`,
      next: [`Check whether port ${ctx.port} is already taken: lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN`],
    });
  }

  ctx.step('Waiting for the container to answer');
  const health = await waitForHealth(`http://127.0.0.1:${ctx.port}`, LOCAL_READY_TIMEOUT_MS);
  if (!health.reachable) {
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `the container started but nothing answered on ${url}/api/health within 15s (${health.error})`,
      next: [`Read the container log: docker logs ${DOCKER_CONTAINER}`],
    });
  }

  ctx.notes.push(`Credible ${health.version} is answering on ${url} from container "${DOCKER_CONTAINER}", with its database on the ${DOCKER_VOLUME} volume.`);
  ctx.notes.push('This is localhost only. Put a reverse proxy with TLS in front of it, or use the tunnel/fly target, before pointing a real website at it.');
  ctx.step('Container is up', true);
  return result(ctx, { status: 'running', url, service, next });
}

// ------------------------------------------------------------------- fly --

/** A fly.toml for this app name, generated in a temp dir — the repo's is left alone. */
function flyConfig(appName, region) {
  return `# Generated by credible deploy for ${appName}. The repository's fly.toml is untouched.
app = "${appName}"
primary_region = "${region}"

[build]
  dockerfile = "Dockerfile"

[env]
  CREDIBLE_DATA_DIR = "/data"
  CREDIBLE_HOST = "0.0.0.0"
  CREDIBLE_PORT = "8000"
  CREDIBLE_TRUST_PROXY = "true"
  CREDIBLE_SECURE_COOKIES = "true"
  CREDIBLE_BASE_URL = "https://${appName}.fly.dev"

[[mounts]]
  source = "${FLY_VOLUME}"
  destination = "/data"

[http_service]
  internal_port = 8000
  force_https = true
  # An analytics endpoint must never be asleep: a suspended machine drops the
  # pageviews it was meant to record.
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    soft_limit = 200
    hard_limit = 400

  [[http_service.checks]]
    method = "GET"
    path = "/api/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`;
}

/**
 * A permanent public HTTPS URL on Fly's free tier.
 * This creates REMOTE resources, so without `yes: true` it only ever plans.
 */
async function deployFly(ctx) {
  const bin = flyBinary() || 'fly';
  const app = ctx.appName;
  const url = `https://${app}.fly.dev`;
  const service = { kind: 'fly', name: app, file: null };
  const configPath = path.join(os.tmpdir(), `credible-fly-${app}`, 'fly.toml');
  const steps = [
    [bin, ['auth', 'whoami']],
    [bin, ['apps', 'create', app, '--org', 'personal']],
    [bin, ['volumes', 'create', FLY_VOLUME, '--size', '1', '--region', ctx.region, '--app', app, '--yes']],
    [bin, ['secrets', 'set', `CREDIBLE_BASE_URL=${url}`, 'CREDIBLE_TRUST_PROXY=true', '--app', app]],
    [bin, ['deploy', '--config', configPath, '--app', app, '--ha=false', '--yes']],
  ];
  const next = [
    `Create the account and the first site: ${bin} ssh console --app ${app} -C "node /app/bin/credible.js provision --email you@example.com --domain example.com --json"`,
    `Install the snippet: node ${ENTRY_POINT} install --domain example.com --url ${url} --path /path/to/your/site`,
    `Open ${url} to create the first account in the browser.`,
    `Follow the logs: ${bin} logs --app ${app}`,
  ];

  if (ctx.port !== 8000) {
    ctx.notes.push(`The port option is ignored on Fly: the app answers on 443 at ${url} and Fly forwards to 8000 inside the machine.`);
  }

  // --- plan only: no yes, or an explicit dry run. Nothing is created.
  if (!ctx.yes || ctx.dryRun) {
    for (const [file, args] of steps) ctx.plan(file, args);
    ctx.notes.push(`This creates remote resources on Fly.io (an app, a 1 GB volume and a machine), so nothing ran. Pass yes: true to execute the ${steps.length} commands above.`);
    ctx.notes.push(`App name ${app} in region ${ctx.region}; the generated ${configPath} keeps the repository's fly.toml untouched.`);
    if (!ctx.env.tools.flyctl.available) {
      ctx.notes.push('flyctl is not installed yet — install it from https://fly.io/docs/flyctl/install/ before running these.');
    } else if (!ctx.env.tools.flyctl.authenticated) {
      ctx.notes.push(`flyctl is installed (${ctx.env.tools.flyctl.version}) but not authenticated — run \`${bin} auth login\` first.`);
    }
    ctx.notes.push('Fly free-tier volumes are single-machine by design: SQLite needs real local disk, so never scale this app past one machine.');
    return result(ctx, {
      status: 'planned',
      url,
      service,
      next: [`Confirm and run it: deploy({ target: 'fly', yes: true, appName: '${app}', region: '${ctx.region}' })`, ...next],
    });
  }

  // --- authentication is the one thing we cannot do for the caller.
  ctx.step('Checking the Fly account');
  const whoami = await ctx.run(bin, ['auth', 'whoami'], { timeout: 30_000 });
  if (whoami.code !== 0) {
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `flyctl is not authenticated — run \`${bin} auth login\``,
      next: [`Log in: ${bin} auth login`, 'Then run this again with yes: true.'],
    });
  }
  ctx.notes.push(`Fly account: ${firstLine(whoami.output)}.`);

  ctx.step(`Creating the app ${app}`);
  const created = await ctx.run(bin, ['apps', 'create', app, '--org', 'personal'], { timeout: 60_000 });
  if (created.code !== 0) {
    if (/already|taken|exists/i.test(created.output)) {
      ctx.notes.push(`The app ${app} already existed, so this run updates it instead of creating it.`);
    } else {
      return result(ctx, {
        status: 'blocked',
        url: '',
        service,
        blocked_by: `\`fly apps create\` failed with exit code ${created.code}`,
        next: ['Read the error above; a different --appName is usually the fix.'],
      });
    }
  }

  // A second volume would silently give the app a second, empty database.
  ctx.step('Checking the volume');
  const volumes = await ctx.run(bin, ['volumes', 'list', '--app', app, '--json'], { timeout: 60_000 });
  const hasVolume = volumes.code === 0 && new RegExp(`"name"\\s*:\\s*"${FLY_VOLUME}"`).test(volumes.output);
  if (hasVolume) {
    ctx.notes.push(`The ${FLY_VOLUME} volume already exists, so it was reused — creating a second one would give the app a second, empty database.`);
  } else {
    ctx.step('Creating the 1 GB volume');
    const volume = await ctx.run(bin, ['volumes', 'create', FLY_VOLUME, '--size', '1', '--region', ctx.region, '--app', app, '--yes'], { timeout: 120_000 });
    if (volume.code !== 0) {
      return result(ctx, {
        status: 'blocked',
        url: '',
        service,
        blocked_by: `\`fly volumes create\` failed with exit code ${volume.code}`,
        next: [`Check the region code: ${bin} platform regions`],
      });
    }
  }

  ctx.step('Setting secrets');
  await ctx.run(bin, ['secrets', 'set', `CREDIBLE_BASE_URL=${url}`, 'CREDIBLE_TRUST_PROXY=true', '--app', app], { timeout: 120_000 });

  ctx.step('Deploying (this takes a few minutes)');
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, flyConfig(app, ctx.region), { mode: 0o600 });
  const deployed = await ctx.run(bin, ['deploy', '--config', configPath, '--app', app, '--ha=false', '--yes'], {
    timeout: LONG_TIMEOUT_MS,
    cwd: REPO_ROOT,
  });
  if (deployed.code !== 0) {
    return result(ctx, {
      status: 'blocked',
      url: '',
      service,
      blocked_by: `\`fly deploy\` failed with exit code ${deployed.code}`,
      next: [`Read the full log: ${bin} logs --app ${app}`, `The app and volume still exist; fix the error and re-run deploy({ target: 'fly', yes: true, appName: '${app}' }).`],
    });
  }

  ctx.step('Waiting for the app to answer');
  const health = await waitForHealth(url, REMOTE_READY_TIMEOUT_MS);
  ctx.notes.push(health.reachable
    ? `Credible ${health.version} is answering on ${url}.`
    : `The deploy succeeded but ${url} has not answered yet (${health.error}) — Fly machines and DNS sometimes need another minute.`);
  ctx.notes.push(`Config used: ${configPath} (a temp file — the repository's fly.toml was not touched).`);
  ctx.notes.push('SQLite needs real local disk, so this app is pinned to one machine in one region. Never scale it past one machine — each would get its own database.');
  ctx.step('Deployed', true);

  return result(ctx, { status: 'running', url, service, next });
}

// ------------------------------------------------------------------ stop --

/**
 * Stop what deploy() started, and nothing else. Never deletes an app, a
 * volume, an image or a database, and never signals a process it did not
 * start itself.
 *
 * @param {object} [options]
 * @param {'auto'|'local'|'tunnel'|'docker'|'fly'} [options.target='auto']
 * @param {string} [options.appName] required to name a Fly app in the notes
 * @returns {Promise<{stopped:boolean, commands:Array<object>, notes:string[]}>}
 */
export async function stopInstance({ target = 'auto', appName = '' } = {}) {
  if (!TARGETS.has(target)) {
    throw new TypeError(`Unknown target ${JSON.stringify(target)} — expected one of: ${[...TARGETS].join(', ')}`);
  }
  const commands = [];
  const notes = [];
  const env = detectEnvironment();
  const kind = serviceKind(env);
  let stopped = false;

  const run = async (file, args, options) => {
    const record = await runCommand(file, args, options);
    commands.push(record);
    return record;
  };

  if (target === 'docker') {
    // `stop`, never `rm`: the container and its volume stay exactly where they are.
    const stopping = await run('docker', ['stop', DOCKER_CONTAINER], { timeout: 60_000 });
    stopped = stopping.code === 0;
    notes.push(stopped
      ? `Container ${DOCKER_CONTAINER} is stopped. Its data is untouched on the ${DOCKER_VOLUME} volume — start it again with \`docker start ${DOCKER_CONTAINER}\`.`
      : `Could not stop container ${DOCKER_CONTAINER} (exit ${stopping.code}). It may already be stopped or may never have existed.`);
    return { stopped, commands, notes };
  }

  if (target === 'fly') {
    // Scaling a remote app down is a decision for a human with an intact
    // memory of what runs where, so this only ever hands over the command.
    const app = appName || '<your app>';
    commands.push(plannedCommand('fly', ['scale', 'count', '0', '--app', app], '[not run — remote resources are never changed without an explicit human step]'));
    notes.push(`Stopping a Fly app is not done for you. To pause it: \`fly scale count 0 --app ${app}\` (reversible with \`fly scale count 1\`).`);
    notes.push('Nothing here will ever run `fly apps destroy` or delete a volume — that would take the database with it.');
    return { stopped: false, commands, notes };
  }

  // local / tunnel / auto: unload the units this module wrote.
  const wantsTunnel = target === 'tunnel' || target === 'auto';
  if (kind === 'launchd') {
    const domain = `gui/${process.getuid?.() ?? ''}`;
    if (wantsTunnel) {
      const tunnel = await run('launchctl', ['bootout', `${domain}/${LAUNCHD_TUNNEL_LABEL}`], { timeout: 20_000 });
      if (tunnel.code === 0) notes.push(`Unloaded the tunnel agent ${LAUNCHD_TUNNEL_LABEL}. Its hostname is now gone for good — the next tunnel gets a different one.`);
    }
    const unload = await run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { timeout: 20_000 });
    stopped = unload.code === 0;
    notes.push(stopped
      ? `Unloaded ${LAUNCHD_LABEL}. The plist is still at ${launchAgentPath(LAUNCHD_LABEL)}, so deploy() will bring it straight back.`
      : `${LAUNCHD_LABEL} was not loaded (exit ${unload.code}) — nothing to stop.`);
  } else if (kind === 'systemd') {
    if (wantsTunnel) {
      const tunnel = await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_TUNNEL_UNIT], { timeout: 30_000 });
      if (tunnel.code === 0) notes.push(`Stopped ${SYSTEMD_TUNNEL_UNIT}. Its hostname is now gone for good.`);
    }
    const unload = await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { timeout: 30_000 });
    stopped = unload.code === 0;
    notes.push(stopped
      ? `Stopped and disabled ${SYSTEMD_UNIT}. The unit file is still at ${systemdUnitPath(SYSTEMD_UNIT)}.`
      : `${SYSTEMD_UNIT} was not running (exit ${unload.code}) — nothing to stop.`);
  } else {
    // No service manager: only ever signal a pid we wrote down ourselves.
    for (const [label, file] of [['instance', 'credible.pid'], ['tunnel', 'tunnel.pid']]) {
      if (label === 'tunnel' && !wantsTunnel) continue;
      const pidFile = path.join(DEFAULT_DATA_DIR, file);
      const record = plannedCommand('kill', ['-TERM', `$(cat ${pidFile})`]);
      let pid = 0;
      try {
        pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      } catch {
        record.output = `no pid file at ${pidFile}`;
        commands.push(record);
        continue;
      }
      if (!Number.isInteger(pid) || pid <= 1) {
        record.output = `${pidFile} does not hold a usable pid`;
        commands.push(record);
        continue;
      }
      try {
        process.kill(pid, 'SIGTERM');
        record.ran = true;
        record.code = 0;
        record.output = `sent SIGTERM to pid ${pid}`;
        fs.rmSync(pidFile, { force: true });
        if (label === 'instance') stopped = true;
      } catch (err) {
        record.output = `pid ${pid} did not accept SIGTERM: ${err?.message}`;
      }
      commands.push(record);
    }
    notes.push(`Only pids written by deploy() are signalled, and only the ones under ${DEFAULT_DATA_DIR}.`);
  }

  notes.push('Nothing was deleted: the database, the launch agents and the unit files are all still in place.');
  return { stopped, commands, notes };
}
