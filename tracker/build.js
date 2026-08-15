#!/usr/bin/env node
/**
 * Builds the browser tracker.
 *
 *   node tracker/build.js
 *
 * Reads tracker/src/credible.js and writes three files to public/js:
 *   cr.js        minified, the file customers embed
 *   cr.debug.js  readable source with a header, for debugging a live site
 *   script.js    byte-identical copy of cr.js, so sites migrating from
 *                Plausible only have to change the host in their snippet
 *
 * The minifier below is deliberately conservative and dependency free. It
 * removes comments and redundant whitespace and nothing else: no identifier
 * mangling, no expression rewriting, no dead code removal. A tracking script
 * that is 200 bytes smaller but subtly broken in one browser is a bad trade,
 * and gzip recovers most of what mangling would have saved anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(HERE, 'src', 'credible.js');
const OUT_DIR = path.join(ROOT, 'public', 'js');

/** Characters that can appear inside an identifier or number. */
const WORD = /[\w$\\]/;

/** A `/` right after one of these starts a regular expression, not a division. */
const REGEX_AFTER = /[({[,;:=!&|?+\-*%~^<>]/;

/** ...and so does a `/` right after one of these keywords. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw'
]);

/** A newline after one of these characters can never trigger ASI. */
const NEWLINE_SAFE_AFTER = /[{(\[,;:=+\-*/%&|^!~?<>]/;

/** A newline before one of these characters can never trigger ASI either. */
const NEWLINE_SAFE_BEFORE = /[)\]},;.:]/;

/**
 * Would removing the whitespace between `a` and `b` change how they tokenise?
 * Two word characters would merge into one identifier, and pairs such as
 * `+ +` or `/ *` would turn into a different operator or open a comment.
 */
function needsSpace(a, b) {
  if (WORD.test(a) && WORD.test(b)) return true;
  if ((a === '+' || a === '-') && (b === '+' || b === '-')) return true;
  if (a === '/' && (b === '/' || b === '*')) return true;
  if (a === '<' && b === '!') return true;
  // `1 .toString()` must not become `1.toString()`.
  if (/[0-9]/.test(a) && b === '.') return true;
  return false;
}

/** Is the newline between `a` and `b` load bearing? When unsure, keep it. */
function keepNewline(a, b) {
  if (NEWLINE_SAFE_AFTER.test(a)) return false;
  if (NEWLINE_SAFE_BEFORE.test(b)) return false;
  return true;
}

/**
 * Minify JavaScript by stripping comments and collapsing whitespace.
 *
 * The scanner walks the source character by character and understands string
 * literals, template literals, regular expression literals and both comment
 * forms, so a `//` inside a string or a `/` inside a character class is never
 * mistaken for the start of a comment.
 *
 * @param {string} source
 * @returns {string} minified source
 */
export function minify(source) {
  const length = source.length;
  let out = '';
  let prev = ''; // last character written
  let word = ''; // identifier currently being written, for regex detection
  let pending = 0; // pending whitespace: 0 none, 1 space, 2 newline
  let i = 0;

  const emit = (text) => {
    if (!text) return;
    if (pending && prev) {
      const next = text.charAt(0);
      if (pending === 2 && keepNewline(prev, next)) out += '\n';
      else if (needsSpace(prev, next)) out += ' ';
    }
    pending = 0;
    out += text;
    prev = text.charAt(text.length - 1);
    word = text.length === 1 && WORD.test(text) ? word + text : '';
  };

  /** Read a quoted string, honouring backslash escapes. */
  const readString = (quote) => {
    let j = i + 1;
    while (j < length) {
      const ch = source.charAt(j);
      if (ch === '\\') {
        j += 2;
        continue;
      }
      j++;
      if (ch === quote) break;
    }
    const text = source.slice(i, j);
    i = j;
    return text;
  };

  /** Read a regular expression literal plus its flags. */
  const readRegex = () => {
    let j = i + 1;
    let inClass = false;
    let closed = false;
    while (j < length) {
      const ch = source.charAt(j);
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '\n') break;
      j++;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        closed = true;
        break;
      }
    }
    if (!closed) return null; // not a regex after all, treat `/` as division
    while (j < length && /[a-z]/i.test(source.charAt(j))) j++;
    const text = source.slice(i, j);
    i = j;
    return text;
  };

  /**
   * `if (ok) /x/.test(s)` — a `)` is followed by a regex only when it closes
   * the head of an if/while/for/with statement, so walk back to the matching
   * `(` and look at the keyword in front of it.
   */
  const closesStatementHead = () => {
    let depth = 0;
    let k = out.length - 1;
    for (; k >= 0; k--) {
      const ch = out.charAt(k);
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k < 0) return false;
    let end = k;
    while (end > 0 && /\s/.test(out.charAt(end - 1))) end--;
    let start = end;
    while (start > 0 && WORD.test(out.charAt(start - 1))) start--;
    const keyword = out.slice(start, end);
    return keyword === 'if' || keyword === 'while' || keyword === 'for' || keyword === 'with';
  };

  /** Decide whether the `/` at the cursor opens a regex literal. */
  const startsRegex = () => {
    if (!prev) return true;
    if (word && REGEX_KEYWORDS.has(word)) return true;
    // After a value — identifier, number, `]` — a slash can only be division.
    if (WORD.test(prev) || prev === ']') return false;
    // A `}` almost always closes a block, and a statement may open with a regex.
    if (prev === '}') return true;
    if (prev === ')') return closesStatementHead();
    return REGEX_AFTER.test(prev);
  };

  while (i < length) {
    const c = source.charAt(i);

    // Whitespace: remember the strongest separator seen and move on.
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      if (c === '\n' || c === '\r') pending = 2;
      else if (pending < 1) pending = 1;
      i++;
      continue;
    }

    // Line comment: runs to the end of the line, which is handled as whitespace.
    if (c === '/' && source.charAt(i + 1) === '/') {
      while (i < length && source.charAt(i) !== '\n') i++;
      if (pending < 1) pending = 1;
      continue;
    }

    // Block comment: acts as whitespace, and as a newline when it spans lines.
    if (c === '/' && source.charAt(i + 1) === '*') {
      const end = source.indexOf('*/', i + 2);
      const body = source.slice(i, end === -1 ? length : end);
      i = end === -1 ? length : end + 2;
      if (/[\r\n]/.test(body)) pending = 2;
      else if (pending < 1) pending = 1;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      emit(readString(c));
      continue;
    }

    if (c === '/' && startsRegex()) {
      const regex = readRegex();
      if (regex !== null) {
        emit(regex);
        continue;
      }
    }

    emit(c);
    i++;
  }

  return out;
}

/** Throws when the generated code does not parse. */
function validate(code) {
  // eslint-disable-next-line no-new-func -- parsing only, the body never runs.
  new Function(code);
}

function kb(bytes) {
  return (bytes / 1024).toFixed(2) + ' KB';
}

function report(label, bytes, reference) {
  const ratio = reference ? ' (' + Math.round((1 - bytes / reference) * 100) + '% smaller)' : '';
  console.log('  ' + label.padEnd(22) + String(bytes).padStart(6) + ' B  ' + kb(bytes).padStart(9) + ratio);
}

function main() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const banner = '/*! Credible — privacy-first, cookieless analytics. AGPL-3.0 */\n';
  const minified = banner + minify(source).replace(/^\n+/, '');

  try {
    validate(minified);
  } catch (error) {
    console.error('Build failed: the minified tracker does not parse.');
    console.error(error && error.message);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // No build timestamp: the three outputs are committed, so the build has to be
  // reproducible. A clock in the header would rewrite cr.debug.js on every run
  // (the test suite builds too) and leave the working tree permanently dirty.
  const debug =
    '/**\n' +
    ' * Credible tracker — unminified build for debugging.\n' +
    ' * Source: tracker/src/credible.js — do not edit this file, run `node tracker/build.js`.\n' +
    ' */\n' +
    source;

  fs.writeFileSync(path.join(OUT_DIR, 'cr.js'), minified);
  fs.writeFileSync(path.join(OUT_DIR, 'script.js'), minified); // Plausible-compatible name
  fs.writeFileSync(path.join(OUT_DIR, 'cr.debug.js'), debug);

  const rawBytes = Buffer.byteLength(source);
  const minBytes = Buffer.byteLength(minified);
  const gzBytes = gzipSync(Buffer.from(minified), { level: 9 }).length;

  console.log('Credible tracker built -> ' + path.relative(ROOT, OUT_DIR));
  report('source', rawBytes);
  report('minified', minBytes, rawBytes);
  report('minified + gzipped', gzBytes, rawBytes);
  console.log('  files                  cr.js, script.js, cr.debug.js');
  if (gzBytes > 2048) {
    console.log(
      '  note: above the 2 KB gzipped goal. Identifier mangling is deliberately\n' +
      '        not performed, so this is the floor for the current feature set.'
    );
  }
}

// Only build when run directly, so tests can import minify() without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
