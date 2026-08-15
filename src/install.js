/**
 * `credible install` — put the tracking snippet into a website's source tree.
 *
 * Three entry points:
 *   detectProject(root)       work out which framework this is and which files to patch
 *   installSnippet(options)   insert (or replace) the snippet, idempotently
 *   uninstallSnippet(options) take a previously installed tag back out
 *
 * Everything is line based. A file is read once, a handful of edits are computed
 * against its original lines, a unified-diff excerpt is rendered from those
 * edits, and the result is written back with the file's original line endings.
 * Nothing outside `root` is ever written, build output directories are refused
 * even when named explicitly, and files larger than 2 MB are skipped.
 *
 * This module deliberately imports nothing from the rest of Credible: an agent
 * can run it against a project directory without a database or a server.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Thrown for anything the caller can fix (bad root, path outside root, …). */
export class InstallError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InstallError';
    this.status = status;
  }
}

/** Never patched, even when passed explicitly. */
const PROTECTED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.output', 'vendor', 'coverage',
]);

/** Additionally never walked when looking for candidate files. */
const SKIP_DIRS = new Set([
  ...PROTECTED_DIRS,
  '.svelte-kit', '.nuxt', '.cache', '.vercel', '.netlify', '.astro', '.parcel-cache',
  'bower_components', '__pycache__', '.venv', 'venv', 'target', 'tmp', 'out', '_site',
  'storage', '.pytest_cache', '.turbo',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024;
/** Depth of the plain-HTML fallback scan: `a/b/c.html` is depth 3. */
const HTML_SCAN_DEPTH = 3;
/** Refuse to spray the snippet over an unbounded number of pages. */
const MAX_HTML_TARGETS = 50;

const CLOSING_HEAD = /<\/head\s*>/i;
const CLOSING_BODY = /<\/body\s*>/i;

// --------------------------------------------------------------- recognising --

/** `<script …>…</script>` or `<script … />`, JSX `<Script …/>` included. */
const SCRIPT_TAG = /<script\b[^>]*\/>|<script\b[\s\S]*?>[\s\S]*?<\/script\s*>/gi;
const ATTRIBUTE =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'`=<>]+)))?/g;

/** Credible's tracker is always served from `/js/cr*.js`. */
const CREDIBLE_PATH = /\/js\/cr(\.[\w-]+)?\.js(\?|#|$)/i;
const CREDIBLE_FILE = /(^|\/)cr(\.[\w-]+)?\.js(\?|#|$)/i;
/** Same, but for a src buried in a config line rather than a whole attribute. */
const CREDIBLE_ANYWHERE = /\/js\/cr(\.[\w-]+)?\.js(?![\w.-])/i;
const PLAUSIBLE_HOST = /plausible/i;
const PLAUSIBLE_PATH = /\/js\/(script|plausible)[\w.-]*\.js(\?|#|$)/i;
const OTHER_ANALYTICS =
  /(googletagmanager\.com|google-analytics\.com|gtag\/js|\/ga\.js|umami|usefathom\.com|matomo|piwik|posthog|simpleanalytics|counter\.dev|cloudflareinsights|mixpanel|hotjar|clarity\.ms|goatcounter|pirsch|splitbee|panelbear|ackee|cdn\.segment\.com|_vercel\/insights|swetrix|tinylytics|beampipe)/i;
const INLINE_ANALYTICS =
  /(gtag\s*\(|dataLayer\s*\.\s*push|GoogleAnalytics|_paq\s*\.\s*push|posthog\s*\.\s*init|clarity\s*\(|mixpanel\s*\.\s*init)/i;

/** Split a tag's attributes into an ordered list and a lookup. */
function parseAttributes(tagText) {
  const inner = tagText.replace(/^<\s*[A-Za-z][\w.-]*/, '').replace(/\/?>[\s\S]*$/, '');
  const order = [];
  const attrs = Object.create(null);
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(inner))) {
    const [, name, dq, sq, expr, bare] = match;
    const value = dq ?? sq ?? (expr === undefined ? undefined : `{${expr}}`) ?? bare ?? true;
    order.push([name, value]);
    attrs[name] = value;
  }
  return { order, attrs };
}

function classifyTag(attrs, inner) {
  const src = typeof attrs.src === 'string' ? attrs.src : '';
  const hasDomain = attrs['data-domain'] !== undefined;
  if (CREDIBLE_PATH.test(src) || (hasDomain && CREDIBLE_FILE.test(src))) return 'credible';
  if (PLAUSIBLE_HOST.test(src) || (hasDomain && PLAUSIBLE_PATH.test(src))) return 'plausible';
  if (OTHER_ANALYTICS.test(src) || (!src && INLINE_ANALYTICS.test(inner))) return 'other-analytics';
  return 'other';
}

/** Every script tag in `text`, with offsets, attributes and a classification. */
function findScriptTags(text) {
  const found = [];
  SCRIPT_TAG.lastIndex = 0;
  let match;
  while ((match = SCRIPT_TAG.exec(text))) {
    const raw = match[0];
    const open = raw.indexOf('>');
    const close = raw.toLowerCase().lastIndexOf('</script');
    const inner = close > open ? raw.slice(open + 1, close) : '';
    const { order, attrs } = parseAttributes(raw);
    found.push({
      start: match.index,
      end: match.index + raw.length,
      text: raw,
      inner,
      order,
      attrs,
      kind: classifyTag(attrs, inner),
    });
  }
  return found;
}

/** Short label for a third-party analytics tag, used in notes. */
function analyticsLabel(tag) {
  const src = typeof tag.attrs.src === 'string' ? tag.attrs.src : '';
  const host = /^[a-z]+:\/\/([^/]+)/i.exec(src)?.[1];
  return host || (src ? src.split('/').pop() : 'an inline analytics script');
}

// ------------------------------------------------------------------ snippet --

/**
 * Turn the `<script …></script>` tag Credible hands out into the forms the
 * different file types need.
 *
 * @param {string} snippet
 * @returns {{html:string, jsx:string, src:string, domain:string, order:Array, attrs:object}}
 */
export function parseSnippet(snippet) {
  const text = String(snippet ?? '').trim();
  const [tag] = findScriptTags(text);
  if (!tag) {
    throw new InstallError(
      'The snippet must be a <script> tag, for example ' +
        '<script defer data-domain="example.com" src="https://analytics.example.com/js/cr.js"></script>',
      422,
    );
  }
  if (typeof tag.attrs.src !== 'string' || !tag.attrs.src) {
    throw new InstallError('The snippet has no src attribute', 422);
  }
  const attrString = tag.order
    .map(([name, value]) => (value === true ? name : `${name}="${String(value).replace(/"/g, '&quot;')}"`))
    .join(' ');
  return {
    // Keep the caller's exact text when it is already an HTML tag pair.
    html: /<\/script\s*>$/i.test(tag.text) ? tag.text : `<script ${attrString}></script>`,
    jsx: `<script ${attrString} />`,
    order: tag.order,
    attrs: tag.attrs,
    src: tag.attrs.src,
    domain: typeof tag.attrs['data-domain'] === 'string' ? tag.attrs['data-domain'] : '',
  };
}

/** `<Script … strategy="afterInteractive" />` for a next/script insertion. */
function nextScriptTag(parsed, component) {
  const attrString = parsed.order
    .map(([name, value]) => (value === true ? name : `${name}="${String(value).replace(/"/g, '&quot;')}"`))
    .join(' ');
  return `<${component} ${attrString} strategy="afterInteractive" />`;
}

const quoteJs = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `{ defer: true, 'data-domain': 'example.com', src: 'https://…/js/cr.js' }` */
function nuxtEntry(parsed) {
  const parts = parsed.order.map(([name, value]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : quoteJs(name);
    return `${key}: ${value === true ? 'true' : quoteJs(value)}`;
  });
  return `{ ${parts.join(', ')} }`;
}

// ------------------------------------------------------------- file context --

const toPosix = (value) => value.split(path.sep).join('/');

function isProtected(base, file) {
  const rel = path.relative(base, file);
  return rel.split(path.sep).some((segment) => PROTECTED_DIRS.has(segment));
}

function insideRoot(base, file) {
  const rel = path.relative(base, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read a file into the shape every planner works with.
 *
 * `text` is the content with line endings normalised to `\n` so that offsets,
 * line numbers and columns all agree; the original ending is restored on write.
 *
 * @returns {object|null} null when the file is missing, too big or unreadable
 */
function loadContext(base, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(raw);
  const lines = raw.replace(/\r?\n$/, '').split(/\r?\n/);
  if (raw === '') lines.length = 0;
  const text = lines.join('\n');
  const lineStarts = [0];
  for (let i = 0; i < lines.length - 1; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  return { base, file, rel: toPosix(path.relative(base, file)), lines, eol, trailing, text, lineStarts };
}

function lineAt(ctx, offset) {
  let low = 0;
  let high = ctx.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (ctx.lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

const leadingSpace = (line) => /^[\t ]*/.exec(line)[0];

/** Does this file want JSX syntax (self-closing tags)? */
function usesJsx(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jsx' || ext === '.tsx' || ext === '.mdx') return true;
  if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.cjs') {
    return /className=|htmlFor=|from ['"]react['"]|from ['"]next\/|from ['"]gatsby['"]|React\.createElement/.test(text);
  }
  return false;
}

// -------------------------------------------------------------------- edits --

/**
 * An edit is `{ start, deleteCount, insert }` over the ORIGINAL line array.
 * Edits never overlap, so they can be applied back to front.
 */
function applyEdits(lines, edits) {
  const next = lines.slice();
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next.splice(edit.start, edit.deleteCount, ...edit.insert);
  }
  return next;
}

/** Replace the characters `[start, end)` with `replacement`, line by line. */
function replaceRange(ctx, start, end, replacement) {
  const firstLine = lineAt(ctx, start);
  const lastLine = lineAt(ctx, end - 1);
  const prefix = ctx.lines[firstLine].slice(0, start - ctx.lineStarts[firstLine]);
  const suffix = ctx.lines[lastLine].slice(end - ctx.lineStarts[lastLine]);
  const merged = `${prefix}${replacement}${suffix}`;
  return {
    start: firstLine,
    deleteCount: lastLine - firstLine + 1,
    insert: replacement === '' && merged.trim() === '' ? [] : merged.split('\n'),
  };
}

const removeRange = (ctx, start, end) => replaceRange(ctx, start, end, '');

/** Insert `text` on its own line before the first match of `anchor`. */
function insertBefore(ctx, anchor, text) {
  const match = anchor.exec(ctx.text);
  if (!match) return null;
  const index = lineAt(ctx, match.index);
  const line = ctx.lines[index];
  const column = match.index - ctx.lineStarts[index];
  const before = line.slice(0, column);
  const indent = leadingSpace(line);

  if (before.trim() === '') {
    // The closing tag owns its line: copy the indentation used inside the block.
    let inner = `${indent}  `;
    for (let i = index - 1; i >= 0 && i >= index - 20; i--) {
      if (!ctx.lines[i].trim()) continue;
      const previous = leadingSpace(ctx.lines[i]);
      if (previous.length > indent.length) inner = previous;
      break;
    }
    return [{ start: index, deleteCount: 0, insert: [inner + text] }];
  }
  // Something shares the line (`<head><title>x</title></head>`): split it open.
  return [
    {
      start: index,
      deleteCount: 1,
      insert: [before.replace(/\s+$/, ''), `${indent}  ${text}`, indent + line.slice(column)],
    },
  ];
}

function appendEdit(ctx, text) {
  return [{ start: ctx.lines.length, deleteCount: 0, insert: [text] }];
}

// --------------------------------------------------------------------- diff --

/** A unified-diff excerpt with 3 lines of context, for humans and agents. */
function renderDiff(rel, oldLines, edits, context = 3) {
  if (!edits.length) return '';
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const groups = [];
  for (const edit of sorted) {
    const group = groups[groups.length - 1];
    if (group && edit.start <= group.end + context * 2) {
      group.items.push(edit);
      group.end = Math.max(group.end, edit.start + edit.deleteCount);
    } else {
      groups.push({ items: [edit], start: edit.start, end: edit.start + edit.deleteCount });
    }
  }

  const out = [`--- a/${rel}`, `+++ b/${rel}`];
  let delta = 0;
  for (const group of groups) {
    const from = Math.max(0, group.start - context);
    const to = Math.min(oldLines.length, group.end + context);
    const body = [];
    let cursor = from;
    let added = 0;
    let removed = 0;
    for (const edit of group.items) {
      for (; cursor < edit.start; cursor++) body.push(` ${oldLines[cursor]}`);
      for (let i = 0; i < edit.deleteCount; i++, cursor++) {
        body.push(`-${oldLines[cursor]}`);
        removed++;
      }
      for (const line of edit.insert) {
        body.push(`+${line}`);
        added++;
      }
    }
    for (; cursor < to; cursor++) body.push(` ${oldLines[cursor]}`);
    const oldCount = to - from;
    out.push(`@@ -${from + 1},${oldCount} +${from + 1 + delta},${oldCount - removed + added} @@`);
    out.push(...body);
    delta += added - removed;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- strategies --

/** Which insertion strategy suits this file? */
function strategyFor(ctx) {
  if (/^nuxt\.config\./i.test(path.basename(ctx.file))) return 'nuxt-config';
  if (CLOSING_HEAD.test(ctx.text)) return 'head-tag';
  if (usesJsx(ctx.file, ctx.text) && CLOSING_BODY.test(ctx.text)) return 'next-script';
  return 'append-partial';
}

/** 1-indexed line the snippet would land on, or null when there is no anchor. */
function insertionLine(ctx, strategy) {
  if (strategy === 'append-partial') return ctx.lines.length + 1;
  if (strategy === 'nuxt-config') {
    const existing = ctx.lines.findIndex((line) => CREDIBLE_ANYWHERE.test(line));
    if (existing >= 0) return existing + 1;
    const anchor = nuxtAnchor(ctx);
    return anchor ? anchor.index + 2 : null;
  }
  const anchor = strategy === 'next-script' ? CLOSING_BODY : CLOSING_HEAD;
  const match = anchor.exec(ctx.text);
  return match ? lineAt(ctx, match.index) + 1 : null;
}

/** 'none' | 'credible' | 'plausible' | 'other-analytics' for a whole file. */
function classifyContent(ctx, strategy) {
  if (strategy === 'nuxt-config') {
    if (CREDIBLE_ANYWHERE.test(ctx.text)) return 'credible';
    if (PLAUSIBLE_HOST.test(ctx.text)) return 'plausible';
    if (OTHER_ANALYTICS.test(ctx.text)) return 'other-analytics';
    return 'none';
  }
  const kinds = new Set(findScriptTags(ctx.text).map((tag) => tag.kind));
  if (kinds.has('credible')) return 'credible';
  if (kinds.has('plausible')) return 'plausible';
  if (kinds.has('other-analytics')) return 'other-analytics';
  return 'none';
}

/** The `import Script from 'next/script'` line, when it is missing. */
function nextScriptImport(ctx) {
  const existing = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]next\/script['"]/.exec(ctx.text);
  if (existing) return { component: existing[1], edits: [] };

  const quote = /from\s+"/.test(ctx.text) && !/from\s+'/.test(ctx.text) ? '"' : "'";
  const semicolon = /^import\b.*;\s*$/m.test(ctx.text) || !/^import\b/m.test(ctx.text) ? ';' : '';
  const statement = `import Script from ${quote}next/script${quote}${semicolon}`;
  let after = -1;
  for (let i = 0; i < ctx.lines.length && i < 80; i++) {
    if (/^\s*import\b/.test(ctx.lines[i])) after = i;
  }
  if (after < 0) {
    // Keep a leading 'use client' / 'use server' directive first.
    const directive = /^\s*['"]use [a-z]+['"];?\s*$/.test(ctx.lines[0] || '') ? 1 : 0;
    return { component: 'Script', edits: [{ start: directive, deleteCount: 0, insert: [statement, ''] }] };
  }
  return { component: 'Script', edits: [{ start: after + 1, deleteCount: 0, insert: [statement] }] };
}

/** Where a `script:` entry can be spliced into a Nuxt config. */
function nuxtAnchor(ctx) {
  const find = (pattern) => {
    for (let i = 0; i < ctx.lines.length; i++) if (pattern.test(ctx.lines[i])) return i;
    return -1;
  };
  const script = find(/(^|[\s,{])script\s*:\s*\[/);
  if (script >= 0) return { kind: 'script', index: script };
  const head = find(/(^|[\s,{])head\s*:\s*\{/);
  if (head >= 0) return { kind: 'head', index: head };
  const app = find(/(^|[\s,{])app\s*:\s*\{/);
  if (app >= 0) return { kind: 'app', index: app };
  const root = find(/defineNuxtConfig\s*\(\s*\{|export\s+default\s*\{/);
  if (root >= 0) return { kind: 'root', index: root };
  return null;
}

/** Plan the edits for `app.head.script` in a Nuxt config file. */
function planNuxtConfig(ctx, parsed) {
  const entry = nuxtEntry(parsed);
  const notes = [];
  const existing = ctx.lines.findIndex((line) => CREDIBLE_ANYWHERE.test(line));

  if (existing >= 0) {
    const line = ctx.lines[existing];
    if (line.includes(quoteJs(parsed.src)) && (!parsed.domain || line.includes(quoteJs(parsed.domain)))) {
      return { action: 'unchanged', edits: [], notes };
    }
    const indent = leadingSpace(line);
    const comma = /,\s*$/.test(line) ? ',' : '';
    return {
      action: 'replaced',
      edits: [{ start: existing, deleteCount: 1, insert: [`${indent}${entry}${comma}`] }],
      notes,
    };
  }

  const anchor = nuxtAnchor(ctx);
  if (!anchor) {
    notes.push(
      `Could not find a place for the tracker in ${ctx.rel}. Add ` +
        `app: { head: { script: [ ${entry} ] } } to the exported config by hand.`,
    );
    return { action: 'unchanged', edits: [], notes };
  }

  const line = ctx.lines[anchor.index];
  const indent = leadingSpace(line);
  const pad = (level) => indent + '  '.repeat(level);

  if (anchor.kind === 'script') {
    // `script: []` on one line has to be opened up first.
    if (/script\s*:\s*\[\s*\]/.test(line)) {
      const opened = line.replace(/script\s*:\s*\[\s*\]/, 'script: [\n__ENTRY__\n' + indent + ']');
      const rendered = opened.replace('__ENTRY__', `${pad(1)}${entry},`).split('\n');
      return { action: 'inserted', edits: [{ start: anchor.index, deleteCount: 1, insert: rendered }], notes };
    }
    return { action: 'inserted', edits: [{ start: anchor.index + 1, deleteCount: 0, insert: [`${pad(1)}${entry},`] }], notes };
  }
  if (anchor.kind === 'head') {
    return {
      action: 'inserted',
      edits: [{ start: anchor.index + 1, deleteCount: 0, insert: [`${pad(1)}script: [`, `${pad(2)}${entry},`, `${pad(1)}],`] }],
      notes,
    };
  }
  const body =
    anchor.kind === 'app'
      ? [`${pad(1)}head: {`, `${pad(2)}script: [`, `${pad(3)}${entry},`, `${pad(2)}],`, `${pad(1)}},`]
      : [`${pad(1)}app: {`, `${pad(2)}head: {`, `${pad(3)}script: [`, `${pad(4)}${entry},`, `${pad(3)}],`, `${pad(2)}},`, `${pad(1)}},`];
  return { action: 'inserted', edits: [{ start: anchor.index + 1, deleteCount: 0, insert: body }], notes };
}

/**
 * Plan the edits for a markup file.
 * @returns {{action:'inserted'|'replaced'|'unchanged', edits:Array, notes:string[]}}
 */
function planMarkup(ctx, parsed, strategy, { replacePlausible }) {
  const notes = [];
  const jsx = usesJsx(ctx.file, ctx.text);
  const importPlan = strategy === 'next-script' ? nextScriptImport(ctx) : null;
  const tagText =
    strategy === 'next-script'
      ? nextScriptTag(parsed, importPlan.component)
      : jsx
        ? parsed.jsx
        : parsed.html;

  const tags = findScriptTags(ctx.text);
  const credible = tags.filter((tag) => tag.kind === 'credible');

  if (credible.length) {
    const [first, ...duplicates] = credible;
    const same =
      first.attrs.src === parsed.src &&
      (typeof first.attrs['data-domain'] === 'string' ? first.attrs['data-domain'] : '') === parsed.domain;
    const edits = [];
    if (!same) edits.push(replaceRange(ctx, first.start, first.end, tagText));
    for (const duplicate of duplicates) edits.push(removeRange(ctx, duplicate.start, duplicate.end));
    if (duplicates.length) notes.push(`Removed ${duplicates.length} duplicate Credible tag(s) from ${ctx.rel}.`);
    if (!edits.length) return { action: 'unchanged', edits, notes };
    if (!same && strategy === 'next-script') edits.push(...importPlan.edits);
    return { action: 'replaced', edits, notes };
  }

  const plausible = tags.filter((tag) => tag.kind === 'plausible');
  if (plausible.length && replacePlausible) {
    const edits = [replaceRange(ctx, plausible[0].start, plausible[0].end, tagText)];
    if (strategy === 'next-script') edits.push(...importPlan.edits);
    notes.push(`Replaced the Plausible tag in ${ctx.rel} with the Credible one.`);
    if (plausible.length > 1) {
      notes.push(`${ctx.rel} has ${plausible.length - 1} more Plausible tag(s); remove them by hand.`);
    }
    return { action: 'replaced', edits, notes };
  }

  let edits;
  if (strategy === 'append-partial') {
    edits = appendEdit(ctx, tagText);
  } else if (strategy === 'next-script') {
    edits = insertBefore(ctx, CLOSING_BODY, tagText);
    if (edits) edits.push(...importPlan.edits);
  } else {
    edits = insertBefore(ctx, CLOSING_HEAD, tagText);
    if (!edits && jsx) {
      // A JSX layout with no <head>: fall back to next/script.
      return planMarkup(ctx, parsed, 'next-script', { replacePlausible });
    }
  }
  if (!edits) {
    notes.push(
      `${ctx.rel} has no </head> to insert before. Paste the snippet into the file that renders ` +
        'your <head>, or pass that file explicitly.',
    );
    return { action: 'unchanged', edits: [], notes };
  }

  if (plausible.length) {
    const line = lineAt(ctx, plausible[0].start) + 1;
    notes.push(
      `${ctx.rel} still loads Plausible (line ${line}); both trackers will now run. Delete that ` +
        'line, or re-run with replacePlausible (credible install --replace-plausible) to swap it out.',
    );
  }
  for (const other of tags.filter((tag) => tag.kind === 'other-analytics')) {
    notes.push(`${ctx.rel} also loads ${analyticsLabel(other)}; both analytics scripts will run.`);
  }
  return { action: 'inserted', edits, notes };
}

/** Plan the removal of every Credible tag from a file. */
function planRemoval(ctx, strategy) {
  const notes = [];
  if (strategy === 'nuxt-config') {
    const edits = [];
    for (let i = ctx.lines.length - 1; i >= 0; i--) {
      if (CREDIBLE_ANYWHERE.test(ctx.lines[i])) {
        edits.unshift({ start: i, deleteCount: 1, insert: [] });
      }
    }
    return { action: edits.length ? 'replaced' : 'unchanged', edits, notes };
  }

  const tags = findScriptTags(ctx.text).filter((tag) => tag.kind === 'credible');
  if (!tags.length) return { action: 'unchanged', edits: [], notes };
  const edits = tags.map((tag) => removeRange(ctx, tag.start, tag.end));

  // Drop `import Script from 'next/script'` once nothing uses it any more.
  const importLine = ctx.lines.findIndex((line) => /import\s+[A-Za-z_$][\w$]*\s+from\s+['"]next\/script['"]/.test(line));
  if (importLine >= 0) {
    const component = /import\s+([A-Za-z_$][\w$]*)\s+from/.exec(ctx.lines[importLine])[1];
    const remaining = applyEdits(ctx.lines, edits).join('\n');
    if (!new RegExp(`<${component}\\b`).test(remaining)) {
      const blankAfter = ctx.lines[importLine + 1] !== undefined && ctx.lines[importLine + 1].trim() === '';
      const previous = ctx.lines[importLine - 1];
      const alone = previous === undefined || !/^\s*import\b/.test(previous);
      edits.push({ start: importLine, deleteCount: blankAfter && alone ? 2 : 1, insert: [] });
    }
  }
  return { action: 'replaced', edits: edits.sort((a, b) => a.start - b.start), notes };
}

// ---------------------------------------------------------------- detection --

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_SIZE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Files with one of `extensions` below `dir`, depth first, sorted. */
function listFiles(dir, extensions, maxDepth = 2, depth = 1, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) listFiles(full, extensions, maxDepth, depth + 1, out);
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Inspect a project directory and work out where the snippet belongs.
 * Never writes anything.
 *
 * @param {string} root
 * @returns {{framework:string, confidence:'high'|'medium'|'low', reason:string,
 *            targets:Array<{file:string, strategy:string, existing:string, line:number|null}>,
 *            notes:string[]}}
 */
export function detectProject(root) {
  const base = resolveRoot(root);
  const notes = [];

  const abs = (rel) => path.join(base, rel);
  const has = (rel) => fs.existsSync(abs(rel));
  const pick = (...rels) => rels.find((rel) => has(rel)) ?? null;

  /** Build a target descriptor for an existing file, or null when unusable. */
  const target = (where, strategy) => {
    const file = path.isAbsolute(where) ? where : abs(where);
    const ctx = loadContext(base, file);
    if (!ctx) {
      notes.push(`Skipped ${toPosix(path.relative(base, file))}: unreadable or larger than 2 MB.`);
      return null;
    }
    const chosen = strategy || strategyFor(ctx);
    return {
      file,
      strategy: chosen,
      existing: classifyContent(ctx, chosen),
      line: insertionLine(ctx, chosen),
    };
  };

  const done = (framework, confidence, reason, targets) => ({
    framework,
    confidence,
    reason,
    targets: targets.filter(Boolean),
    notes,
  });

  const pkg = readJsonFile(abs('package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies };
  const depNames = Object.keys(deps);

  // ------------------------------------------------------------- Next.js --
  if (deps.next) {
    const config = pick('next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.cjs');
    const layout = pick(
      'app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'app/layout.ts',
      'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js', 'src/app/layout.ts',
    );
    if (layout) {
      const built = target(layout);
      if (built?.strategy === 'next-script') {
        notes.push(
          `${layout} has no <head> element, so the snippet goes in as a next/script component ` +
            'with strategy="afterInteractive".',
        );
      }
      return done('next-app', 'high', `found ${layout}${config ? ` and ${config}` : ''}`, [built]);
    }
    const document = pick(
      'pages/_document.tsx', 'pages/_document.jsx', 'pages/_document.js',
      'src/pages/_document.tsx', 'src/pages/_document.jsx', 'src/pages/_document.js',
    );
    if (document) {
      return done('next-pages', 'high', `found ${document}${config ? ` and ${config}` : ''}`, [target(document)]);
    }
    notes.push(
      'This is a Next.js project but it has neither app/layout.* nor pages/_document.*. ' +
        'Create one of them, then run the install again.',
    );
    return done('next-app', 'low', 'package.json depends on next', []);
  }

  // --------------------------------------------------------------- Astro --
  const astroConfig = pick('astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs');
  if (astroConfig || deps.astro) {
    const layouts = listFiles(abs('src/layouts'), ['.astro'], 3).filter((file) =>
      CLOSING_HEAD.test(readTextFile(file) || ''),
    );
    if (layouts.length) {
      if (layouts.length > 1) notes.push(`${layouts.length} layouts contain a <head>; all of them get the snippet.`);
      return done('astro', 'high', `found ${astroConfig || 'the astro dependency'} and ${layouts.length} layout(s) under src/layouts`, layouts.map((file) => target(file)));
    }
    const index = pick('src/pages/index.astro');
    if (index && CLOSING_HEAD.test(readTextFile(abs(index)) || '')) {
      notes.push('No layout under src/layouts has a <head>, so the snippet goes into src/pages/index.astro. Move it into a shared layout to track every page.');
      return done('astro', 'medium', `found ${astroConfig || 'the astro dependency'} and ${index}`, [target(index)]);
    }
    notes.push('No .astro file with a <head> was found. Add the snippet to your layout component by hand.');
    return done('astro', 'medium', `found ${astroConfig || 'the astro dependency'}`, []);
  }

  // ---------------------------------------------------------------- Nuxt --
  const nuxtConfig = pick('nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts');
  if (nuxtConfig) {
    notes.push(`The tracker is registered through app.head.script in ${nuxtConfig}; no template edit is needed.`);
    return done('nuxt', 'high', `found ${nuxtConfig}`, [target(nuxtConfig, 'nuxt-config')]);
  }

  // ----------------------------------------------------------- SvelteKit --
  if (deps['@sveltejs/kit']) {
    const appHtml = pick('src/app.html');
    if (appHtml) return done('sveltekit', 'high', `found ${appHtml} and the @sveltejs/kit dependency`, [target(appHtml)]);
    notes.push('SvelteKit project without src/app.html — add the snippet to your app template by hand.');
    return done('sveltekit', 'medium', 'package.json depends on @sveltejs/kit', []);
  }

  // --------------------------------------------------------------- Remix --
  const remixDep = depNames.find((name) => name.startsWith('@remix-run/'));
  if (remixDep) {
    const root_ = pick('app/root.tsx', 'app/root.jsx', 'app/root.js', 'app/root.ts');
    if (root_) return done('remix', 'high', `found ${root_} and the ${remixDep} dependency`, [target(root_)]);
    notes.push('Remix project without app/root.* — add the snippet to your root route by hand.');
    return done('remix', 'medium', `package.json depends on ${remixDep}`, []);
  }

  // -------------------------------------------------------------- Gatsby --
  const gatsbyConfig = pick('gatsby-config.js', 'gatsby-config.ts', 'gatsby-config.mjs');
  if (gatsbyConfig || deps.gatsby) {
    const html = pick('src/html.js', 'src/html.jsx', 'src/html.tsx');
    if (html) return done('gatsby', 'high', `found ${gatsbyConfig || 'the gatsby dependency'} and ${html}`, [target(html)]);
    notes.push(
      'Gatsby has no src/html.js in this project. Run `cp .cache/default-html.js src/html.js` and ' +
        'install again, or add the tag from gatsby-ssr.js with the onRenderBody API ' +
        '(setHeadComponents([...])).',
    );
    return done('gatsby', 'medium', `found ${gatsbyConfig || 'the gatsby dependency'}`, []);
  }

  // ------------------------------------------------------------ Eleventy --
  const eleventyConfig = pick('.eleventy.js', '.eleventy.cjs', 'eleventy.config.js', 'eleventy.config.mjs', 'eleventy.config.cjs');
  if (eleventyConfig || deps['@11ty/eleventy']) {
    const includes = ['_includes', 'src/_includes'].map(abs).filter((dir) => fs.existsSync(dir));
    const layouts = includes
      .flatMap((dir) => listFiles(dir, ['.html', '.njk', '.liquid', '.hbs', '.ejs', '.vto'], 3))
      .filter((file) => CLOSING_HEAD.test(readTextFile(file) || ''));
    if (layouts.length) {
      if (layouts.length > 1) notes.push(`${layouts.length} Eleventy layouts contain a <head>; all of them get the snippet.`);
      return done('eleventy', 'high', `found ${eleventyConfig || 'the @11ty/eleventy dependency'} and ${layouts.length} layout(s) under _includes`, layouts.map((file) => target(file)));
    }
    notes.push('No layout with a <head> was found under _includes. Add the snippet to your base layout by hand.');
    return done('eleventy', 'medium', `found ${eleventyConfig || 'the @11ty/eleventy dependency'}`, []);
  }

  // ---------------------------------------------------------------- Hugo --
  const hugoConfig = ['hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json'].find(has)
    ?? (['config.toml', 'config.yaml', 'config.yml'].find(has) && (has('layouts') || has('content') || has('themes'))
      ? ['config.toml', 'config.yaml', 'config.yml'].find(has)
      : null);
  if (hugoConfig) {
    const head = pick('layouts/partials/head.html', 'layouts/partials/head/head.html', 'layouts/_default/baseof.html');
    if (head) {
      if (head.endsWith('baseof.html')) {
        notes.push('Hugo themes usually override layouts/_default/baseof.html — if your theme ships its own, copy the snippet there too.');
      }
      return done('hugo', 'high', `found ${hugoConfig} and ${head}`, [target(head)]);
    }
    notes.push(
      'Hugo project without layouts/partials/head.html or layouts/_default/baseof.html. ' +
        'The theme under themes/ owns the <head>: copy its baseof.html into layouts/_default/ ' +
        'first, then install again.',
    );
    return done('hugo', 'medium', `found ${hugoConfig}`, []);
  }

  // -------------------------------------------------------------- Jekyll --
  const jekyllConfig = pick('_config.yml', '_config.yaml');
  if (jekyllConfig) {
    const head = pick('_includes/head.html', '_layouts/default.html');
    if (head) return done('jekyll', 'high', `found ${jekyllConfig} and ${head}`, [target(head)]);
    notes.push(
      'Jekyll project with no _includes/head.html or _layouts/default.html. Run ' +
        '`bundle exec jekyll new-theme`-style overriding: copy the theme file into _includes/ first.',
    );
    return done('jekyll', 'medium', `found ${jekyllConfig}`, []);
  }

  // --------------------------------------------------------------- Rails --
  if (has('config/application.rb')) {
    const layout = pick('app/views/layouts/application.html.erb');
    if (layout) return done('rails', 'high', `found config/application.rb and ${layout}`, [target(layout)]);
    notes.push('Rails project without app/views/layouts/application.html.erb — add the snippet to your layout by hand.');
    return done('rails', 'medium', 'found config/application.rb', []);
  }

  // -------------------------------------------------------------- Django --
  if (has('manage.py')) {
    let layout = pick('templates/base.html');
    if (!layout) {
      // Apps commonly keep templates in <app>/templates/base.html.
      for (const entry of safeReadDir(base)) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (has(`${entry.name}/templates/base.html`)) {
          layout = `${entry.name}/templates/base.html`;
          break;
        }
      }
    }
    if (layout) return done('django', 'high', `found manage.py and ${layout}`, [target(layout)]);
    notes.push('Django project without templates/base.html — add the snippet to the template every page extends.');
    return done('django', 'medium', 'found manage.py', []);
  }

  // ------------------------------------------------------------- Laravel --
  if (has('artisan')) {
    const layout = pick(
      'resources/views/layouts/app.blade.php',
      'resources/views/layouts/guest.blade.php',
      'resources/views/app.blade.php',
      'resources/views/welcome.blade.php',
    );
    if (layout) return done('laravel', 'high', `found artisan and ${layout}`, [target(layout)]);
    notes.push('Laravel project without resources/views/layouts/app.blade.php — add the snippet to your Blade layout.');
    return done('laravel', 'medium', 'found artisan', []);
  }

  // ----------------------------------------------------- WordPress theme --
  if (has('style.css') && has('header.php') && /^\s*(\*\s*)?Theme Name:/im.test(readTextFile(abs('style.css')) || '')) {
    notes.push('Editing a theme directly is lost on update — use a child theme, or hook wp_head in functions.php.');
    return done('wordpress-theme', 'high', 'found style.css with a "Theme Name:" header and header.php', [target('header.php')]);
  }

  // ---------------------------------------------------------------- Vite --
  const viteConfig = pick('vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs');
  if (viteConfig) {
    const index = pick('index.html', 'src/index.html', 'public/index.html');
    if (index) return done('vite', 'high', `found ${viteConfig} and ${index}`, [target(index)]);
    notes.push('Vite project without an index.html at the project root — add the snippet to your entry HTML file.');
    return done('vite', 'medium', `found ${viteConfig}`, []);
  }

  // ------------------------------------------------------------ bare HTML --
  const htmlFiles = findHtmlFiles(base);
  if (htmlFiles.length) {
    const truncated = htmlFiles.slice(0, MAX_HTML_TARGETS);
    if (htmlFiles.length > truncated.length) {
      notes.push(`${htmlFiles.length} HTML files have a <head>; only the first ${MAX_HTML_TARGETS} are patched. Pass files: [...] to choose.`);
    }
    if (truncated.length > 1) {
      notes.push(`${truncated.length} HTML pages get the snippet. A shared header include would keep this to one place.`);
    }
    const rootIndex = truncated.some((file) => path.dirname(file) === base && path.basename(file) === 'index.html');
    return done(
      'html',
      rootIndex ? 'medium' : 'low',
      `found ${htmlFiles.length} HTML file(s) with a <head> element`,
      truncated.map((file) => target(file)),
    );
  }

  notes.push(
    'Could not tell what this project is. Add the snippet just before </head> in whichever file ' +
      'renders your site\'s <head>, or re-run with an explicit list of files ' +
      '(credible install --file path/to/layout.html).',
  );
  return done('unknown', 'low', 'no framework marker file and no HTML file with a <head> were found', []);
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** *.html files containing a <head>, no deeper than HTML_SCAN_DEPTH. */
function findHtmlFiles(base) {
  const out = [];
  const walk = (dir, depth) => {
    for (const entry of safeReadDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < HTML_SCAN_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        const text = readTextFile(full);
        if (text && CLOSING_HEAD.test(text)) out.push(full);
      }
    }
  };
  walk(base, 1);
  // The site's entry page first, everything else alphabetically.
  return out.sort((a, b) => {
    const score = (file) => (path.dirname(file) === base && /^index\.html?$/i.test(path.basename(file)) ? 0 : 1);
    return score(a) - score(b) || a.localeCompare(b);
  });
}

// ------------------------------------------------------------------- public --

function resolveRoot(root) {
  if (!root || typeof root !== 'string') throw new InstallError('A project directory is required', 422);
  const abs = path.resolve(root);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new InstallError(`No such directory: ${abs}`, 404);
  }
  if (!fs.statSync(real).isDirectory()) throw new InstallError(`Not a directory: ${abs}`, 422);
  return real;
}

/** Turn a caller-supplied path into a target, refusing anything out of bounds. */
function explicitTarget(base, entry) {
  if (typeof entry !== 'string' || !entry.trim()) throw new InstallError('Empty file path', 422);
  const abs = path.resolve(base, entry);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    /* the file may not exist yet — the checks below still apply to `abs` */
  }
  if (!insideRoot(base, real) || !insideRoot(base, abs)) {
    throw new InstallError(`Refusing to touch ${abs}: it is outside ${base}`, 403);
  }
  if (isProtected(base, real)) {
    throw new InstallError(`Refusing to touch ${toPosix(path.relative(base, real))}: it is build output or a dependency`, 403);
  }
  const ctx = loadContext(base, real);
  if (!ctx) throw new InstallError(`Cannot read ${abs} (missing, not a file, or larger than 2 MB)`, 404);
  const strategy = strategyFor(ctx);
  return { file: real, strategy, existing: classifyContent(ctx, strategy), line: insertionLine(ctx, strategy) };
}

/** Read, plan, render the diff and (unless dryRun) write one file. */
function patchFile(base, target, plan, dryRun) {
  const file = target.file;
  if (!insideRoot(base, file)) {
    throw new InstallError(`Refusing to touch ${file}: it is outside ${base}`, 403);
  }
  if (isProtected(base, file)) {
    return { entry: null, notes: [`Skipped ${toPosix(path.relative(base, file))}: build output or dependency.`] };
  }
  const ctx = loadContext(base, file);
  if (!ctx) {
    return { entry: null, notes: [`Skipped ${toPosix(path.relative(base, file))}: unreadable or larger than 2 MB.`] };
  }

  const result = plan(ctx, target.strategy);
  const diff = result.action === 'unchanged' ? '' : renderDiff(ctx.rel, ctx.lines, result.edits);
  if (result.action !== 'unchanged' && !dryRun) {
    const lines = applyEdits(ctx.lines, result.edits);
    fs.writeFileSync(file, lines.join(ctx.eol) + (ctx.trailing ? ctx.eol : ''), 'utf8');
  }
  return { entry: { file, action: result.action, diff }, notes: result.notes };
}

function collectTargets(base, files, fallback) {
  if (Array.isArray(files) && files.length) {
    return { framework: fallback().framework, targets: files.map((entry) => explicitTarget(base, entry)), notes: [] };
  }
  const detection = fallback();
  return { framework: detection.framework, targets: detection.targets, notes: detection.notes };
}

/**
 * Insert (or replace) the snippet. Idempotent: running it twice changes nothing
 * the second time.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.snippet the exact `<script …></script>` tag
 * @param {boolean} [options.dryRun] compute the diff without touching disk
 * @param {boolean} [options.replacePlausible] swap an existing Plausible tag for this one
 * @param {string[]} [options.files] explicit files to patch, bypassing detection
 * @returns {{changed:Array<{file:string, action:'inserted'|'replaced'|'unchanged', diff:string}>,
 *            framework:string, notes:string[]}}
 */
export function installSnippet(options = {}) {
  const { root, snippet, dryRun = false, replacePlausible = false, files } = options;
  const base = resolveRoot(root);
  const parsed = parseSnippet(snippet);

  const { framework, targets, notes } = collectTargets(base, files, () => detectProject(base));
  const changed = [];
  for (const target of targets) {
    const { entry, notes: fileNotes } = patchFile(
      base,
      target,
      (ctx, strategy) =>
        strategy === 'nuxt-config'
          ? planNuxtConfig(ctx, parsed)
          : planMarkup(ctx, parsed, strategy, { replacePlausible }),
      dryRun,
    );
    if (entry) changed.push(entry);
    notes.push(...fileNotes);
  }

  if (!changed.length) {
    notes.push('Nothing was changed. Pass files: [...] to name the template that renders your <head>.');
  } else if (dryRun) {
    notes.push('Dry run: nothing was written to disk.');
  }
  return { changed, framework, notes };
}

/**
 * Remove a previously installed Credible tag. Same return shape as
 * `installSnippet`; a file the tag was taken out of is reported as 'replaced'.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {boolean} [options.dryRun]
 * @param {string[]} [options.files] explicit files to clean, bypassing detection
 */
export function uninstallSnippet(options = {}) {
  const { root, dryRun = false, files } = options;
  const base = resolveRoot(root);

  const { framework, targets, notes } = collectTargets(base, files, () => detectProject(base));
  const detectionNotes = notes.length;
  const changed = [];
  for (const target of targets) {
    const { entry, notes: fileNotes } = patchFile(base, target, (ctx, strategy) => planRemoval(ctx, strategy), dryRun);
    if (entry) changed.push(entry);
    notes.push(...fileNotes);
  }

  const removed = changed.filter((entry) => entry.action !== 'unchanged');
  if (!removed.length) {
    notes.length = detectionNotes;
    notes.push('No Credible tag was found, so nothing was removed.');
  } else if (dryRun) {
    notes.push('Dry run: nothing was written to disk.');
  }
  return { changed, framework, notes };
}
