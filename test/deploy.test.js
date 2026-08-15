/**
 * `credible deploy` — the safety properties, locked in.
 *
 * These tests deliberately never start a real service: they cover the guards
 * that stop an assistant running this command from doing something the user did
 * not ask for. The happy paths are exercised by hand (and by `credible up`),
 * because they install launch agents that a test suite has no business leaving
 * behind on a developer's machine.
 *
 * NOTE: `./helpers.js` must stay the first import — it points the environment at
 * a throwaway data directory before `src/config.js` reads it.
 */
import './helpers.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deploy, detectEnvironment, instanceStatus } from '../src/deploy.js';

const tmp = (name) => path.join(os.tmpdir(), `credible-deploy-test-${name}-${process.pid}`);

describe('detectEnvironment', () => {
  it('reports what this machine can host with', () => {
    const environment = detectEnvironment();

    assert.ok(['darwin', 'linux', 'win32'].includes(environment.platform));
    assert.equal(environment.node, process.version);
    for (const tool of ['docker', 'flyctl', 'cloudflared', 'systemd', 'launchd']) {
      assert.equal(typeof environment.tools[tool]?.available, 'boolean', `${tool} is probed`);
    }
    assert.ok(['fly', 'tunnel', 'local', 'docker'].includes(environment.recommended));
    assert.ok(environment.reason.length > 10, 'the recommendation explains itself');
    assert.ok(Array.isArray(environment.notes));
  });

  it('never recommends a target whose tool is missing or unusable', () => {
    const { recommended, tools } = detectEnvironment();
    if (recommended === 'fly') assert.equal(tools.flyctl.authenticated, true);
    if (recommended === 'tunnel') assert.equal(tools.cloudflared.available, true);
    if (recommended === 'docker') assert.equal(tools.docker.running, true);
  });
});

describe('remote resources need consent', () => {
  it('plans the fly target instead of running it without --yes', async () => {
    const result = await deploy({ target: 'fly', appName: 'credible-unit-test', yes: false });

    assert.equal(result.status, 'planned');
    assert.ok(result.commands.length > 0, 'it shows what it would run');
    assert.ok(
      result.commands.every((command) => command.ran === false),
      'nothing was executed',
    );
    assert.ok(
      result.commands.some((command) => /fly apps create/.test(command.cmd)),
      'the plan includes creating the app',
    );
  });

  it('does not touch the disk in dry-run mode', async () => {
    const dataDir = tmp('dryrun');
    fs.rmSync(dataDir, { recursive: true, force: true });

    const result = await deploy({ target: 'local', dataDir, port: 8399, dryRun: true });

    assert.ok(result.commands.every((command) => command.ran === false));
    assert.equal(fs.existsSync(dataDir), false, 'the data directory was not created');
  });
});

describe('shell safety', () => {
  const canary = path.join(os.tmpdir(), `credible-pwned-${process.pid}`);

  /** Rejecting by throwing and rejecting by refusing to run are both fine. */
  const rejected = async (options) => {
    try {
      const result = await deploy(options);
      assert.notEqual(result.status, 'running');
      return true;
    } catch {
      return true;
    }
  };

  it('cannot be talked into running a second command through its arguments', async () => {
    fs.rmSync(canary, { force: true });

    // Every one of these would execute `touch` if a value reached a shell unquoted.
    await rejected({ target: 'fly', appName: `a$(touch ${canary})`, region: `cdg; touch ${canary}`, yes: false });
    await rejected({ target: 'local', dataDir: `${tmp('inject')}; touch ${canary}`, port: 8399, dryRun: true });
    await rejected({ target: 'local', dataDir: `${tmp('inject2')}\`touch ${canary}\``, port: 8399, dryRun: true });

    assert.equal(fs.existsSync(canary), false, 'no injected command ran');
  });

  it('refuses a nonsense port', async () => {
    for (const port of [0, -1, 70000, Number.NaN]) {
      assert.ok(await rejected({ target: 'local', port, dryRun: true }), `port ${port} was rejected`);
    }
  });
});

describe('instanceStatus', () => {
  it('reports an unreachable instance without throwing', async () => {
    const status = await instanceStatus('http://127.0.0.1:1');
    assert.equal(status.reachable, false);
    assert.equal(status.healthy, false);
    assert.ok(status.error.length > 0);
  });

  it('tolerates a malformed url', async () => {
    const status = await instanceStatus('not a url');
    assert.equal(status.reachable, false);
  });
});
