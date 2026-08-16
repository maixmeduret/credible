/**
 * Tests for the ESM -> CommonJS transform.
 *
 * The transform is small enough to read in one sitting, which is exactly why
 * it needs tests: it is the kind of code that looks obviously correct and
 * silently emits a broken package the day someone adds an `export const`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toCommonJs, toEsm } from '../build.js';

/** A source the transform is expected to accept. */
const VALID = [
  'const A = 1;',
  '',
  'export function init(options) {',
  '  return options || A;',
  '}',
  '',
  'export function trackEvent(name) {',
  '  return name;',
  '}',
  '',
  'export function trackPageview() {',
  '  return trackEvent("pageview");',
  '}',
  '',
].join('\n');

test('exports lose their keyword and reappear on module.exports', () => {
  const out = toCommonJs(VALID);
  assert.match(out, /^function init\(options\) \{$/m);
  assert.doesNotMatch(out, /^export /m);
  assert.match(out, /module\.exports = \{ init, trackEvent, trackPageview \};/);
});

test('the generated CommonJS parses and runs', () => {
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func -- exercising the build output is the point.
  new Function('module', 'exports', 'require', toCommonJs(VALID))(module, module.exports, () => {});
  assert.equal(typeof module.exports.init, 'function');
  assert.equal(module.exports.trackPageview(), 'pageview');
});

test('the ESM build is the source behind a banner', () => {
  const out = toEsm(VALID);
  assert.ok(out.startsWith('/*! credible-tracker'));
  assert.ok(out.endsWith(VALID.replace(/^\n+/, '')));
});

test('an import is refused rather than silently dropped', () => {
  assert.throws(() => toCommonJs('import fs from "node:fs";\n' + VALID), /must not import/);
});

test('a module form the transform cannot express is refused', () => {
  assert.throws(() => toCommonJs(VALID + '\nexport const VERSION = 1;\n'), /only use top-level/);
  assert.throws(() => toCommonJs(VALID + '\nexport default init;\n'), /only use top-level/);
  assert.throws(() => toCommonJs(VALID + '\nexport { init as start };\n'), /only use top-level/);
});

test('a missing or surprise export fails the build', () => {
  const missing = VALID.replace('export function trackPageview', 'function trackPageview');
  assert.throws(() => toCommonJs(missing), /missing expected export\(s\): trackPageview/);

  const extra = VALID + '\nexport function reset() {}\n';
  assert.throws(() => toCommonJs(extra), /exports reset/);
});

test('the word export inside a comment or string is left alone', () => {
  const source = VALID + '\n/* nothing here is exported twice */\nconst note = "export function x";\n';
  assert.doesNotThrow(() => toCommonJs(source));
});
