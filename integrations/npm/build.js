#!/usr/bin/env node
/**
 * Builds the credible-tracker package.
 *
 *   node integrations/npm/build.js
 *
 * Reads src/index.js and src/index.d.ts, writes four files to dist/:
 *   credible-tracker.js     ESM, the source plus a banner
 *   credible-tracker.cjs    CommonJS, mechanically derived from the same source
 *   credible-tracker.d.ts   types for the ESM entry
 *   credible-tracker.d.cts  types for the CommonJS entry
 *
 * WHY A BUILD AT ALL, FOR A FILE THIS SMALL
 * Because the package has to be requireable. Bundling with a real toolchain
 * would mean a dependency, which this repository does not allow anywhere, so
 * the "build" is one narrow, verifiable source transform: strip `export ` off
 * top-level declarations and append a module.exports. It refuses anything it
 * does not fully understand rather than guessing — a silently mangled
 * CommonJS build would be far worse than a failed one.
 *
 * The outputs are committed, exactly like public/js in the tracker build, so
 * `npm install` needs no build step and the working tree stays clean. A test
 * rebuilds in memory and compares byte for byte, so a stale dist fails CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'src', 'index.js');
const TYPES = path.join(HERE, 'src', 'index.d.ts');
const OUT_DIR = path.join(HERE, 'dist');

const BANNER = '/*! credible-tracker — MIT. Generated from src/index.js; do not edit. */\n';

/** Exports the CommonJS entry must expose, in this order. */
const EXPECTED_EXPORTS = ['init', 'trackEvent', 'trackPageview'];

/**
 * Rewrite the ESM source as CommonJS.
 *
 * The transform is deliberately tiny and total: every `export function foo`
 * at column zero loses its `export ` keyword and its name is collected; a
 * `module.exports` listing those names is appended. Anything else that looks
 * like module syntax — an import, an `export const`, a default export, a
 * re-export — throws, because handling it correctly needs a real parser and
 * handling it incorrectly ships a broken package.
 *
 * @param {string} source ESM source
 * @returns {string} CommonJS source
 */
export function toCommonJs(source) {
  if (/^import[\s{'"(]/m.test(source)) {
    throw new Error('src/index.js must not import anything: the CommonJS build cannot express it.');
  }

  const names = [];
  const body = source.replace(/^export function (\w+)/gm, (_match, name) => {
    names.push(name);
    return 'function ' + name;
  });

  const leftover = /^export\b.*$/m.exec(body);
  if (leftover) {
    throw new Error(
      'src/index.js may only use top-level `export function` declarations, found: ' + leftover[0].trim(),
    );
  }

  const missing = EXPECTED_EXPORTS.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error('src/index.js is missing expected export(s): ' + missing.join(', '));
  }
  const unexpected = names.filter((name) => !EXPECTED_EXPORTS.includes(name));
  if (unexpected.length) {
    throw new Error(
      'src/index.js exports ' + unexpected.join(', ') + '; add them to EXPECTED_EXPORTS in build.js first.',
    );
  }

  return (
    BANNER +
    body.replace(/^\n+/, '') +
    '\nmodule.exports = { ' +
    EXPECTED_EXPORTS.join(', ') +
    ' };\n'
  );
}

/** The ESM output: the source, unchanged, behind a banner. */
export function toEsm(source) {
  return BANNER + source.replace(/^\n+/, '');
}

/** Throws when the generated CommonJS does not parse. */
function validateCommonJs(code) {
  // eslint-disable-next-line no-new-func -- parsing only, the body never runs.
  new Function('module', 'exports', 'require', code);
}

function main() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const types = fs.readFileSync(TYPES, 'utf8');

  const esm = toEsm(source);
  const cjs = toCommonJs(source);

  try {
    validateCommonJs(cjs);
  } catch (error) {
    console.error('Build failed: the generated CommonJS does not parse.');
    console.error(error && error.message);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'credible-tracker.js'), esm);
  fs.writeFileSync(path.join(OUT_DIR, 'credible-tracker.cjs'), cjs);
  fs.writeFileSync(path.join(OUT_DIR, 'credible-tracker.d.ts'), types);
  fs.writeFileSync(path.join(OUT_DIR, 'credible-tracker.d.cts'), types);

  const line = (label, bytes) => console.log('  ' + label.padEnd(26) + String(bytes).padStart(6) + ' B');
  console.log('credible-tracker built -> ' + path.relative(HERE, OUT_DIR));
  line('credible-tracker.js', Buffer.byteLength(esm));
  line('credible-tracker.cjs', Buffer.byteLength(cjs));
  line('credible-tracker.d.ts', Buffer.byteLength(types));
  line('credible-tracker.d.cts', Buffer.byteLength(types));
  console.log('  exports                  ' + EXPECTED_EXPORTS.join(', '));
}

// Only build when run directly, so tests can import the transforms.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
