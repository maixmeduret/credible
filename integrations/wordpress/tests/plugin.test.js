/**
 * WordPress plugin checks, from the repository's own test runner.
 *
 * Two halves, and the split is deliberate:
 *
 *   1. Static checks that need nothing but a filesystem. They run everywhere,
 *      including on the maintainer's machine and in CI, and they cover the
 *      things a WordPress plugin gets rejected or hacked for: a malformed
 *      header block, a readme.txt whose Stable tag has drifted from the
 *      plugin version, a file that can be requested directly.
 *
 *   2. The behavioural suite in run-tests.php, which needs a PHP binary. It
 *      is skipped — visibly, with a message saying how to run it — when there
 *      is none, because requiring PHP to run `node --test` on a Node project
 *      would be a worse trade than the coverage is worth.
 *
 * Point CREDIBLE_PHP at a binary, or at a command such as
 *   CREDIBLE_PHP="docker run --rm -v $PWD:/app -w /app php:7.4-cli-alpine php"
 * to run the second half where PHP is not installed directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'credible-analytics');
const MAIN = path.join(PLUGIN, 'credible-analytics.php');
const README = path.join(PLUGIN, 'readme.txt');

const read = (file) => fs.readFileSync(file, 'utf8');

/** Every PHP file in the plugin, relative to the plugin root. */
function phpFiles(dir = PLUGIN, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...phpFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.php')) out.push(rel);
  }
  return out;
}

/** Parse `Field: value` out of the plugin header or readme.txt preamble. */
function headerField(source, field) {
  const match = new RegExp('^[\\s*]*' + field + ':\\s*(.+)$', 'mi').exec(source);
  return match ? match[1].trim() : null;
}

/* ------------------------------------------------------------------ *
 * Static checks — these run everywhere
 * ------------------------------------------------------------------ */

test('the plugin header carries every field WordPress reads', () => {
  const source = read(MAIN);
  const required = {
    'Plugin Name': /^Credible Analytics$/,
    'Description': /.{40,}/,
    'Version': /^\d+\.\d+\.\d+$/,
    'Requires at least': /^\d+\.\d+$/,
    'Requires PHP': /^7\.4$/,
    'License': /^GPL-2\.0-or-later$/,
    'License URI': /^https?:\/\//,
    'Text Domain': /^credible-analytics$/,
  };
  for (const [field, pattern] of Object.entries(required)) {
    const value = headerField(source, field);
    assert.ok(value, `the header is missing ${field}`);
    assert.match(value, pattern, `${field} is "${value}"`);
  }
});

test('readme.txt is in the WordPress.org format', () => {
  const source = read(README);
  assert.match(source, /^=== Credible Analytics ===$/m, 'the title line is missing');
  for (const section of ['Description', 'Installation', 'Frequently Asked Questions', 'Changelog']) {
    assert.match(source, new RegExp('^== ' + section + ' ==$', 'm'), `the ${section} section is missing`);
  }
  for (const field of ['Contributors', 'Tags', 'Requires at least', 'Tested up to', 'Requires PHP', 'Stable tag', 'License', 'License URI']) {
    assert.ok(headerField(source, field), `readme.txt is missing ${field}`);
  }
  // The short description is the line under the header block and is truncated
  // hard at 150 characters in the plugin directory listing.
  const short = /^Stable tag:.*\n(?:.*\n)*?\n(.+)\n/m.exec(source);
  assert.ok(short, 'readme.txt has no short description');
  assert.ok(short[1].length <= 150, `the short description is ${short[1].length} characters, over the 150 limit`);
});

test('readme.txt and the plugin header agree', () => {
  const plugin = read(MAIN);
  const readme = read(README);
  assert.equal(
    headerField(readme, 'Stable tag'),
    headerField(plugin, 'Version'),
    'Stable tag must match the plugin Version, or WordPress.org serves the wrong build',
  );
  assert.equal(headerField(readme, 'Requires PHP'), headerField(plugin, 'Requires PHP'));
  assert.equal(headerField(readme, 'Requires at least'), headerField(plugin, 'Requires at least'));
  assert.equal(headerField(readme, 'License'), headerField(plugin, 'License'));
});

test('every PHP file refuses to be requested directly', () => {
  for (const file of phpFiles()) {
    const source = read(path.join(PLUGIN, file));
    const guarded =
      /if\s*\(\s*!\s*defined\(\s*'ABSPATH'\s*\)\s*\)/.test(source) ||
      /if\s*\(\s*!\s*defined\(\s*'WP_UNINSTALL_PLUGIN'\s*\)\s*\)/.test(source);
    assert.ok(guarded, `${file} has no direct-access guard`);
  }
});

test('the plugin ships an uninstall routine that removes what it wrote', () => {
  const source = read(path.join(PLUGIN, 'uninstall.php'));
  for (const option of [
    'credible_analytics_settings',
    'credible_analytics_script_cache',
    'credible_analytics_flush_rewrites',
  ]) {
    assert.match(source, new RegExp(option), `uninstall.php leaves ${option} behind`);
  }
  assert.match(source, /is_multisite/, 'uninstall.php ignores multisite');
});

test('no PHP file uses a construct the plugin directory rejects', () => {
  // eval and friends are an automatic rejection on WordPress.org, and a
  // reviewer will not accept "it was only for a test".
  const banned = [/\beval\s*\(/, /\bcreate_function\s*\(/, /\bbase64_decode\s*\(/, /\bassert\s*\(\s*\$/];
  for (const file of phpFiles()) {
    const source = read(path.join(PLUGIN, file));
    for (const pattern of banned) {
      assert.doesNotMatch(source, pattern, `${file} uses ${pattern}`);
    }
  }
});

test('the raw superglobals are always unslashed and sanitised together', () => {
  // wp_unslash before sanitising is the WordPress rule, and forgetting it is
  // how escaped quotes end up stored in an option.
  for (const file of phpFiles()) {
    const source = read(path.join(PLUGIN, file));
    const uses = source.match(/\$_(SERVER|GET|POST|REQUEST)\s*\[[^\]]+\]/g) || [];
    for (const use of uses) {
      const index = source.indexOf(use);
      const line = source.slice(source.lastIndexOf('\n', index) + 1, source.indexOf('\n', index));
      const readOnly = /empty\(|isset\(|!\s*empty\(/.test(line);
      assert.ok(
        readOnly || /wp_unslash\(/.test(line),
        `${file}: ${use} is read without wp_unslash on "${line.trim()}"`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Behavioural suite — needs PHP
 * ------------------------------------------------------------------ */

/** A PHP command, as an argv array, or null when there is no PHP to be had. */
function findPhp() {
  const configured = process.env.CREDIBLE_PHP;
  if (configured) return configured.split(/\s+/);
  const probe = spawnSync('php', ['--version'], { stdio: 'ignore' });
  return probe.status === 0 ? ['php'] : null;
}

const php = findPhp();

test(
  'the plugin logic passes its PHP suite',
  {
    skip: php
      ? false
      : 'no PHP binary found. Install PHP, or set CREDIBLE_PHP — for example ' +
        'CREDIBLE_PHP="docker run --rm -v $PWD:/app -w /app php:7.4-cli-alpine php"',
  },
  () => {
    // A repository-relative path, run from the repository root: an absolute
    // host path would not exist inside a container, and CREDIBLE_PHP is most
    // useful precisely when it points at one.
    const root = path.resolve(HERE, '..', '..', '..');
    const script = path.relative(root, path.join(HERE, 'run-tests.php'));
    const output = execFileSync(php[0], [...php.slice(1), script], {
      encoding: 'utf8',
      cwd: root,
    });
    assert.match(output, /^# fail\s+0$/m, 'the PHP suite reported failures:\n' + output);
    const total = /^# tests\s+(\d+)$/m.exec(output);
    assert.ok(total && Number(total[1]) > 0, 'the PHP suite ran no tests:\n' + output);
  },
);
