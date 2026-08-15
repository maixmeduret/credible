/**
 * `src/install.js` — putting the tracking snippet into a real source tree.
 *
 * Every test builds a throwaway project under a mkdtemp directory, runs the
 * detector and the installer against it, and then reads the files back from
 * disk. Nothing here touches the database or the server, so this file does not
 * need `./helpers.js`.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { InstallError, detectProject, installSnippet, parseSnippet, uninstallSnippet } from '../src/install.js';

const SNIPPET = '<script defer data-domain="example.com" src="https://analytics.example.com/js/cr.js"></script>';
const PLAUSIBLE = '<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>';

const temporaryDirs = [];

after(() => {
  for (const dir of temporaryDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp dir anyway */
    }
  }
});

/**
 * Materialise a project tree.
 * @param {Record<string,string>} files relative path -> contents
 * @returns {string} the real (symlink-free) absolute root
 */
function tree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credible-install-')));
  temporaryDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const install = (options) => installSnippet({ snippet: SNIPPET, ...options });

// ------------------------------------------------------------------ fixtures --

const HTML_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Home</title>
  </head>
  <body>
    <h1>Home</h1>
  </body>
</html>
`;

const NEXT_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Shop</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

const NEXT_LAYOUT_NO_HEAD = `import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
`;

const ASTRO_LAYOUT = `---
const { title } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
  </head>
  <body>
    <slot />
  </body>
</html>
`;

const HUGO_HEAD_PARTIAL = `<meta charset="utf-8">
<title>{{ .Title }}</title>
<link rel="stylesheet" href="/css/main.css">
`;

const WORDPRESS_HEADER = `<!doctype html>
<html <?php language_attributes(); ?>>
<head>
  <meta charset="<?php bloginfo( 'charset' ); ?>">
  <?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
`;

const nextTree = (layout = NEXT_LAYOUT) =>
  tree({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '15.0.0', react: '19.0.0' } }),
    'next.config.mjs': 'export default {};\n',
    'app/layout.tsx': layout,
    'app/page.tsx': 'export default function Page() {\n  return <p>hi</p>;\n}\n',
  });

const astroTree = () =>
  tree({
    'package.json': JSON.stringify({ name: 'blog', dependencies: { astro: '4.0.0' } }),
    'astro.config.mjs': 'export default {};\n',
    'src/layouts/Base.astro': ASTRO_LAYOUT,
    'src/pages/index.astro': '---\nimport Base from "../layouts/Base.astro";\n---\n<Base title="Home" />\n',
  });

const htmlTree = (extra = {}) =>
  tree({
    'index.html': HTML_PAGE,
    'about.html': HTML_PAGE.replace('Home', 'About'),
    'readme.txt': 'not html',
    'node_modules/pkg/index.html': HTML_PAGE,
    'dist/index.html': HTML_PAGE,
    '.next/server/index.html': HTML_PAGE,
    'a/b/c/deep.html': HTML_PAGE,
    ...extra,
  });

const hugoTree = () =>
  tree({
    'hugo.toml': 'baseURL = "https://example.com/"\ntitle = "Example"\n',
    'layouts/partials/head.html': HUGO_HEAD_PARTIAL,
    'content/_index.md': '# hello\n',
  });

const wordpressTree = () =>
  tree({
    'style.css': '/*\nTheme Name: Credible Demo\nAuthor: Someone\n*/\nbody { margin: 0; }\n',
    'header.php': WORDPRESS_HEADER,
    'index.php': "<?php get_header(); ?>\n",
    'functions.php': "<?php\n",
  });

const unknownTree = () =>
  tree({
    'README.md': '# just some notes\n',
    'notes/todo.txt': 'buy milk\n',
  });

// ----------------------------------------------------------------- detection --

describe('detectProject', () => {
  it('recognises a Next.js app-router tree and aims at the layout head', () => {
    const root = nextTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'next-app');
    assert.equal(detection.confidence, 'high');
    assert.match(detection.reason, /app\/layout\.tsx/);
    assert.match(detection.reason, /next\.config\.mjs/);
    assert.equal(detection.targets.length, 1);

    const [target] = detection.targets;
    assert.equal(target.file, path.join(root, 'app/layout.tsx'));
    assert.equal(target.strategy, 'head-tag');
    assert.equal(target.existing, 'none');
    // `</head>` sits on line 7 of the fixture.
    assert.equal(target.line, NEXT_LAYOUT.split('\n').indexOf('      </head>') + 1);
  });

  it('falls back to next/script when the app-router layout has no <head>', () => {
    const root = nextTree(NEXT_LAYOUT_NO_HEAD);
    const detection = detectProject(root);

    assert.equal(detection.framework, 'next-app');
    assert.equal(detection.targets[0].strategy, 'next-script');
    assert.equal(detection.targets[0].line, NEXT_LAYOUT_NO_HEAD.split('\n').indexOf('      </body>') + 1);
    assert.match(detection.notes.join('\n'), /next\/script.*afterInteractive/s);
  });

  it('recognises an Astro tree and prefers the shared layout', () => {
    const root = astroTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'astro');
    assert.equal(detection.confidence, 'high');
    assert.deepEqual(
      detection.targets.map((target) => rel(root, target.file)),
      ['src/layouts/Base.astro'],
    );
    assert.equal(detection.targets[0].strategy, 'head-tag');
  });

  it('finds plain HTML pages and skips build output and deep files', () => {
    const root = htmlTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'html');
    assert.deepEqual(
      detection.targets.map((target) => rel(root, target.file)),
      ['index.html', 'about.html'],
    );
    assert.ok(detection.targets.every((target) => target.strategy === 'head-tag'));
  });

  it('recognises Hugo and appends to the head partial', () => {
    const root = hugoTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'hugo');
    assert.equal(detection.confidence, 'high');
    assert.equal(rel(root, detection.targets[0].file), 'layouts/partials/head.html');
    // The partial is a fragment: there is no </head> to insert before.
    assert.equal(detection.targets[0].strategy, 'append-partial');
    assert.equal(detection.targets[0].line, HUGO_HEAD_PARTIAL.trimEnd().split('\n').length + 1);
  });

  it('recognises a WordPress theme by its style.css header', () => {
    const root = wordpressTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'wordpress-theme');
    assert.equal(rel(root, detection.targets[0].file), 'header.php');
    assert.equal(detection.targets[0].strategy, 'head-tag');
    assert.match(detection.notes.join('\n'), /child theme/i);
  });

  it('gives up gracefully on a tree it does not recognise', () => {
    const root = unknownTree();
    const detection = detectProject(root);

    assert.equal(detection.framework, 'unknown');
    assert.equal(detection.confidence, 'low');
    assert.deepEqual(detection.targets, []);
    assert.ok(detection.notes.length > 0);
    assert.match(detection.notes.join('\n'), /<\/head>/);
  });

  it('never writes anything', () => {
    const root = htmlTree();
    const before = read(root, 'index.html');
    detectProject(root);
    assert.equal(read(root, 'index.html'), before);
  });

  it('reports an existing Credible tag on the target', () => {
    const root = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${SNIPPET}\n  </head>`) });
    const [target] = detectProject(root).targets;
    assert.equal(target.existing, 'credible');
  });

  it('reports Plausible and third-party analytics', () => {
    const plausible = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${PLAUSIBLE}\n  </head>`) });
    assert.equal(detectProject(plausible).targets[0].existing, 'plausible');

    const ga = htmlTree({
      'index.html': HTML_PAGE.replace(
        '  </head>',
        '    <script async src="https://www.googletagmanager.com/gtag/js?id=G-XYZ"></script>\n  </head>',
      ),
    });
    assert.equal(detectProject(ga).targets[0].existing, 'other-analytics');
  });

  it('skips files larger than 2 MB', () => {
    const big = `<!doctype html>\n<html>\n<head>\n<!-- ${'x'.repeat(2 * 1024 * 1024)} -->\n</head>\n<body></body>\n</html>\n`;
    const root = htmlTree({ 'huge.html': big });
    const detection = detectProject(root);
    assert.ok(!detection.targets.some((target) => target.file.endsWith('huge.html')));

    install({ root });
    assert.equal(read(root, 'huge.html'), big);
  });

  it('recognises the rest of the supported frameworks', () => {
    const cases = [
      {
        name: 'next-pages',
        files: {
          'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
          'pages/_document.tsx':
            'import { Html, Head, Main, NextScript } from "next/document";\n\nexport default function Document() {\n  return (\n    <Html>\n      <Head>\n        <meta charSet="utf-8" />\n      </Head>\n      <body>\n        <Main />\n        <NextScript />\n      </body>\n    </Html>\n  );\n}\n',
        },
        target: 'pages/_document.tsx',
        strategy: 'head-tag',
      },
      {
        name: 'nuxt',
        files: { 'nuxt.config.mjs': 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n' },
        target: 'nuxt.config.mjs',
        strategy: 'nuxt-config',
      },
      {
        name: 'sveltekit',
        files: {
          'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
          'svelte.config.js': 'export default {};\n',
          'src/app.html': '<!doctype html>\n<html>\n  <head>\n    %sveltekit.head%\n  </head>\n  <body>%sveltekit.body%</body>\n</html>\n',
        },
        target: 'src/app.html',
        strategy: 'head-tag',
      },
      {
        name: 'remix',
        files: {
          'package.json': JSON.stringify({ dependencies: { '@remix-run/react': '^2.0.0' } }),
          'app/root.tsx': 'import { Links, Meta, Outlet } from "@remix-run/react";\n\nexport default function App() {\n  return (\n    <html lang="en">\n      <head>\n        <Meta />\n        <Links />\n      </head>\n      <body>\n        <Outlet />\n      </body>\n    </html>\n  );\n}\n',
        },
        target: 'app/root.tsx',
        strategy: 'head-tag',
      },
      {
        name: 'gatsby',
        files: {
          'gatsby-config.js': 'module.exports = {};\n',
          'src/html.js': 'import React from "react";\n\nexport default function HTML(props) {\n  return (\n    <html {...props.htmlAttributes}>\n      <head>\n        {props.headComponents}\n      </head>\n      <body>{props.body}</body>\n    </html>\n  );\n}\n',
        },
        target: 'src/html.js',
        strategy: 'head-tag',
      },
      {
        name: 'vite',
        files: { 'vite.config.js': 'export default {};\n', 'index.html': HTML_PAGE },
        target: 'index.html',
        strategy: 'head-tag',
      },
      {
        name: 'jekyll',
        files: {
          '_config.yml': 'title: Example\n',
          '_includes/head.html': '<head>\n  <meta charset="utf-8">\n</head>\n',
        },
        target: '_includes/head.html',
        strategy: 'head-tag',
      },
      {
        name: 'eleventy',
        files: {
          '.eleventy.js': 'module.exports = function () {};\n',
          '_includes/base.njk': '<!doctype html>\n<html>\n  <head>\n    <title>{{ title }}</title>\n  </head>\n  <body>{{ content | safe }}</body>\n</html>\n',
        },
        target: '_includes/base.njk',
        strategy: 'head-tag',
      },
      {
        name: 'rails',
        files: {
          'config/application.rb': "require 'rails/all'\n",
          'app/views/layouts/application.html.erb': '<!DOCTYPE html>\n<html>\n  <head>\n    <%= csrf_meta_tags %>\n  </head>\n  <body><%= yield %></body>\n</html>\n',
        },
        target: 'app/views/layouts/application.html.erb',
        strategy: 'head-tag',
      },
      {
        name: 'django',
        files: {
          'manage.py': '#!/usr/bin/env python\n',
          'templates/base.html': '<html>\n  <head>\n    <title>{% block title %}{% endblock %}</title>\n  </head>\n  <body>{% block content %}{% endblock %}</body>\n</html>\n',
        },
        target: 'templates/base.html',
        strategy: 'head-tag',
      },
      {
        name: 'laravel',
        files: {
          artisan: '#!/usr/bin/env php\n',
          'resources/views/layouts/app.blade.php': '<!DOCTYPE html>\n<html>\n  <head>\n    <title>{{ config("app.name") }}</title>\n  </head>\n  <body>@yield("content")</body>\n</html>\n',
        },
        target: 'resources/views/layouts/app.blade.php',
        strategy: 'head-tag',
      },
    ];

    for (const testCase of cases) {
      const root = tree(testCase.files);
      const detection = detectProject(root);
      assert.equal(detection.framework, testCase.name, `framework for ${testCase.name}`);
      assert.equal(detection.confidence, 'high', `confidence for ${testCase.name}`);
      assert.deepEqual(
        detection.targets.map((target) => rel(root, target.file)),
        [testCase.target],
        `target for ${testCase.name}`,
      );
      assert.equal(detection.targets[0].strategy, testCase.strategy, `strategy for ${testCase.name}`);
    }
  });
});

// -------------------------------------------------------------- installation --

describe('installSnippet', () => {
  it('inserts plain HTML before </head> keeping the indentation', () => {
    const root = htmlTree();
    const result = install({ root });

    assert.equal(result.framework, 'html');
    assert.deepEqual(
      result.changed.map((entry) => entry.action),
      ['inserted', 'inserted'],
    );

    const content = read(root, 'index.html');
    assert.ok(content.includes(`    ${SNIPPET}\n  </head>`), content);
    assert.match(result.changed[0].diff, /^--- a\/index\.html$/m);
    assert.match(result.changed[0].diff, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    assert.match(result.changed[0].diff, /^\+ {4}<script defer data-domain="example\.com"/m);
    // Three lines of context on either side.
    assert.equal(result.changed[0].diff.split('\n').filter((line) => line.startsWith(' ')).length, 6);
  });

  it('never touches node_modules, dist or files deeper than the scan', () => {
    const root = htmlTree();
    install({ root });

    for (const rel_ of ['node_modules/pkg/index.html', 'dist/index.html', '.next/server/index.html', 'a/b/c/deep.html']) {
      assert.equal(read(root, rel_), HTML_PAGE, `${rel_} must not be touched`);
    }
  });

  it('uses the self-closing form in JSX and the tag pair everywhere else', () => {
    const nextRoot = nextTree();
    install({ root: nextRoot });
    const layout = read(nextRoot, 'app/layout.tsx');
    assert.ok(
      layout.includes('        <script defer data-domain="example.com" src="https://analytics.example.com/js/cr.js" />'),
      layout,
    );
    assert.ok(!layout.includes('</script>'), 'JSX must not get a closing tag');

    const astroRoot = astroTree();
    install({ root: astroRoot });
    assert.ok(read(astroRoot, 'src/layouts/Base.astro').includes(`    ${SNIPPET}`));

    const wpRoot = wordpressTree();
    install({ root: wpRoot });
    assert.ok(read(wpRoot, 'header.php').includes(`  ${SNIPPET}\n</head>`));
  });

  it('inserts into <Head> in a pages-router document', () => {
    const root = tree({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
      'pages/_document.tsx':
        'import { Html, Head, Main, NextScript } from "next/document";\n\nexport default function Document() {\n  return (\n    <Html>\n      <Head>\n        <meta charSet="utf-8" />\n      </Head>\n      <body>\n        <Main />\n        <NextScript />\n      </body>\n    </Html>\n  );\n}\n',
    });
    install({ root });
    const document = read(root, 'pages/_document.tsx');
    assert.match(document, /<script defer data-domain="example\.com" src="[^"]+" \/>\n {6}<\/Head>/);
  });

  it('appends to a head partial that has no </head>', () => {
    const root = hugoTree();
    const result = install({ root });

    assert.equal(result.changed[0].action, 'inserted');
    assert.equal(read(root, 'layouts/partials/head.html'), `${HUGO_HEAD_PARTIAL}${SNIPPET}\n`);
  });

  it('adds a next/script component when the layout has no <head>', () => {
    const root = nextTree(NEXT_LAYOUT_NO_HEAD);
    const result = install({ root });

    assert.equal(result.changed[0].action, 'inserted');
    const layout = read(root, 'app/layout.tsx');
    assert.match(layout, /^import Script from 'next\/script';$/m);
    assert.match(
      layout,
      /<Script defer data-domain="example\.com" src="https:\/\/analytics\.example\.com\/js\/cr\.js" strategy="afterInteractive" \/>/,
    );
    assert.ok(layout.indexOf('<Script') < layout.indexOf('</body>'), 'the component belongs inside <body>');
  });

  it('puts the next/script import after a multi-line import block', () => {
    const layout = `'use client';
import {
  Inter,
  Roboto,
} from 'next/font/google';
import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`;
    const root = nextTree(layout);
    install({ root });
    const lines = read(root, 'app/layout.tsx').split('\n');

    assert.equal(lines[6], "import Script from 'next/script';");
    assert.equal(lines[5], "import './globals.css';");
    // Still valid: the multi-line import was not cut in half.
    assert.equal(lines.slice(1, 5).join('\n'), "import {\n  Inter,\n  Roboto,\n} from 'next/font/google';");
  });

  it('registers the tracker in a Nuxt config that still parses', async () => {
    const root = tree({ 'nuxt.config.mjs': 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n' });
    const result = install({ root });

    assert.equal(result.framework, 'nuxt');
    assert.equal(result.changed[0].action, 'inserted');

    globalThis.defineNuxtConfig = (value) => value;
    const module_ = await import(`${pathToFileURL(path.join(root, 'nuxt.config.mjs')).href}?v=1`);
    assert.deepEqual(module_.default.app.head.script, [
      { defer: true, 'data-domain': 'example.com', src: 'https://analytics.example.com/js/cr.js' },
    ]);
    assert.equal(module_.default.devtools.enabled, true);

    // Idempotent, and a second entry is never appended.
    const again = install({ root });
    assert.equal(again.changed[0].action, 'unchanged');
  });

  it('handles every shape of Nuxt config', async () => {
    const variants = {
      bare: 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n',
      emptyScriptArray: 'export default defineNuxtConfig({\n  app: {\n    head: {\n      title: "Shop",\n      script: [],\n    },\n  },\n});\n',
      populatedScriptArray:
        'export default defineNuxtConfig({\n  app: {\n    head: {\n      script: [\n        { src: "https://cdn.example/other.js" },\n      ],\n    },\n  },\n});\n',
      headWithoutScript: 'export default defineNuxtConfig({\n  app: {\n    head: {\n      title: "Shop",\n    },\n  },\n});\n',
      appWithoutHead: 'export default defineNuxtConfig({\n  app: {\n    baseURL: "/",\n  },\n});\n',
    };

    globalThis.defineNuxtConfig = (value) => value;
    let version = 100;
    for (const [name, source] of Object.entries(variants)) {
      const root = tree({ 'nuxt.config.mjs': source });
      const file = path.join(root, 'nuxt.config.mjs');

      assert.equal(install({ root }).changed[0].action, 'inserted', name);
      const module_ = await import(`${pathToFileURL(file).href}?v=${version++}`);
      const scripts = module_.default.app.head.script;
      assert.equal(scripts.filter((entry) => entry.src.includes('/js/cr.js')).length, 1, `one entry for ${name}`);
      assert.equal(install({ root }).changed[0].action, 'unchanged', `idempotent for ${name}`);

      uninstallSnippet({ root });
      assert.ok(!read(root, 'nuxt.config.mjs').includes('cr.js'), `uninstall for ${name}`);
    }

    // Existing entries survive.
    const kept = tree({ 'nuxt.config.mjs': variants.populatedScriptArray });
    install({ root: kept });
    const module_ = await import(`${pathToFileURL(path.join(kept, 'nuxt.config.mjs')).href}?v=${version}`);
    assert.equal(module_.default.app.head.script.length, 2);
  });

  it('is idempotent', () => {
    for (const root of [htmlTree(), nextTree(), nextTree(NEXT_LAYOUT_NO_HEAD), hugoTree(), astroTree()]) {
      const first = install({ root });
      const snapshot = first.changed.map((entry) => fs.readFileSync(entry.file, 'utf8'));

      const second = install({ root });
      assert.deepEqual(
        second.changed.map((entry) => entry.action),
        first.changed.map(() => 'unchanged'),
        `second run on ${root}`,
      );
      assert.deepEqual(second.changed.map((entry) => entry.diff), first.changed.map(() => ''));
      assert.deepEqual(second.changed.map((entry) => fs.readFileSync(entry.file, 'utf8')), snapshot);
    }
  });

  it('replaces a Credible tag that points somewhere else', () => {
    const root = htmlTree();
    install({ root });

    const moved = '<script defer data-domain="example.com" src="https://stats.example.org/js/cr.js"></script>';
    const result = installSnippet({ root, snippet: moved });

    assert.equal(result.changed[0].action, 'replaced');
    const content = read(root, 'index.html');
    assert.ok(content.includes(moved));
    assert.ok(!content.includes('analytics.example.com'));
    assert.equal(content.match(/\/js\/cr\.js/g).length, 1, 'exactly one Credible tag survives');
    assert.match(result.changed[0].diff, /^-.*analytics\.example\.com/m);
    assert.match(result.changed[0].diff, /^\+.*stats\.example\.org/m);
    assert.match(result.notes.join('\n'), /Updated the Credible tag already in index\.html/);
  });

  it('replaces a tag whose domain changed', () => {
    const root = htmlTree();
    install({ root });
    const other = SNIPPET.replace('example.com', 'shop.example.com');
    const result = installSnippet({ root, snippet: other });

    assert.equal(result.changed[0].action, 'replaced');
    assert.ok(read(root, 'index.html').includes(other));
  });

  // data-api, data-hash, data-exclude, data-respect-dnt, data-track-localhost and
  // data-debug all change what the tracker does. A tag whose src happens to be
  // right but whose options are stale is not "already installed".
  it('refreshes a tag whose tracker options changed', () => {
    const root = htmlTree();
    install({ root });

    const withOptions = SNIPPET.replace('<script defer', '<script defer data-track-localhost data-hash="true"');
    const result = installSnippet({ root, snippet: withOptions });

    assert.equal(result.changed[0].action, 'replaced');
    const content = read(root, 'index.html');
    assert.ok(content.includes(withOptions), 'the file holds the snippet that was asked for');
    assert.equal(content.match(/\/js\/cr\.js/g).length, 1, 'exactly one Credible tag survives');
    assert.match(result.notes.join('\n'), /attributes did not match/);

    const again = installSnippet({ root, snippet: withOptions });
    assert.ok(again.changed.every((entry) => entry.action === 'unchanged'), 'and then it settles');
  });

  it('drops a tracker option the snippet no longer carries', () => {
    const root = htmlTree();
    installSnippet({ root, snippet: SNIPPET.replace('<script defer', '<script defer data-debug') });
    assert.ok(read(root, 'index.html').includes('data-debug'));

    const result = installSnippet({ root, snippet: SNIPPET });
    assert.equal(result.changed[0].action, 'replaced');
    assert.ok(!read(root, 'index.html').includes('data-debug'));
  });

  it('does not rewrite a tag that only spells a boolean attribute differently', () => {
    const spelled = SNIPPET.replace('<script defer', '<script defer=""');
    const root = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${spelled}\n  </head>`) });

    const result = install({ root });
    const entry = result.changed.find((item) => item.file.endsWith('index.html'));

    assert.equal(entry.action, 'unchanged');
    assert.ok(read(root, 'index.html').includes(spelled), 'the file is left byte for byte alone');
  });

  it('refreshes a next/script tag without duplicating the import', () => {
    const root = nextTree(NEXT_LAYOUT_NO_HEAD);
    install({ root });

    const withOptions = SNIPPET.replace('<script defer', '<script defer data-exclude="/admin/*"');
    const result = installSnippet({ root, snippet: withOptions });

    assert.equal(result.changed[0].action, 'replaced');
    const content = read(root, 'app/layout.tsx');
    assert.ok(content.includes('data-exclude="/admin/*"'));
    assert.equal(content.match(/<Script\b/g).length, 1, 'exactly one Script component');
    assert.equal(content.match(/next\/script/g).length, 1, 'exactly one next/script import');
    assert.equal(installSnippet({ root, snippet: withOptions }).changed[0].action, 'unchanged');
  });

  it('refreshes a Nuxt entry whose tracker options changed', async () => {
    globalThis.defineNuxtConfig = (value) => value;
    const root = tree({ 'nuxt.config.mjs': 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n' });
    install({ root });

    const withOptions = SNIPPET.replace('<script defer', '<script defer data-hash="true"');
    assert.equal(installSnippet({ root, snippet: withOptions }).changed[0].action, 'replaced');

    const module_ = await import(`${pathToFileURL(path.join(root, 'nuxt.config.mjs')).href}?v=700`);
    const scripts = module_.default.app.head.script;
    assert.equal(scripts.length, 1, 'the stale entry was replaced, not doubled');
    assert.equal(scripts[0]['data-hash'], 'true');
    assert.equal(installSnippet({ root, snippet: withOptions }).changed[0].action, 'unchanged');
  });

  it('refuses to rewrite a Nuxt entry that shares its line with other config', () => {
    const source =
      'export default defineNuxtConfig({\n' +
      '  app: { head: { script: [{ defer: true, src: "https://analytics.example.com/js/cr.js" }] } },\n' +
      '});\n';
    const root = tree({ 'nuxt.config.mjs': source });

    const result = installSnippet({ root, snippet: SNIPPET.replace('<script defer', '<script defer data-debug') });

    assert.equal(result.changed[0].action, 'unchanged');
    assert.equal(read(root, 'nuxt.config.mjs'), source, 'the surrounding config is not deleted');
    assert.match(result.notes.join('\n'), /holds other configuration/);
  });

  it('leaves a Plausible tag alone by default and explains itself', () => {
    const root = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${PLAUSIBLE}\n  </head>`) });
    const result = install({ root });

    assert.equal(result.changed[0].action, 'inserted');
    const content = read(root, 'index.html');
    assert.ok(content.includes(PLAUSIBLE), 'the Plausible tag stays');
    assert.ok(content.includes(SNIPPET), 'the Credible tag is added');

    const notes = result.notes.join('\n');
    assert.match(notes, /Plausible/);
    assert.match(notes, /line 6/);
    assert.match(notes, /replacePlausible/);
  });

  it('swaps the Plausible tag out when asked', () => {
    const root = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${PLAUSIBLE}\n  </head>`) });
    const result = install({ root, replacePlausible: true });

    assert.equal(result.changed[0].action, 'replaced');
    const content = read(root, 'index.html');
    assert.ok(!content.includes('plausible.io'));
    assert.ok(content.includes(`    ${SNIPPET}`));
    assert.equal(content.match(/<script/g).length, 1);
    assert.match(result.notes.join('\n'), /Replaced the Plausible tag/);
  });

  it('warns when another analytics script is already installed', () => {
    const root = htmlTree({
      'index.html': HTML_PAGE.replace(
        '  </head>',
        '    <script async src="https://www.googletagmanager.com/gtag/js?id=G-XYZ"></script>\n  </head>',
      ),
    });
    const result = install({ root });
    assert.equal(result.changed[0].action, 'inserted');
    assert.match(result.notes.join('\n'), /googletagmanager\.com/);
  });

  it('writes nothing on a dry run but still reports the diff', () => {
    const root = htmlTree();
    const before = read(root, 'index.html');
    const result = install({ root, dryRun: true });

    assert.equal(result.changed[0].action, 'inserted');
    assert.ok(result.changed[0].diff.includes('+'));
    assert.equal(read(root, 'index.html'), before);
    assert.equal(read(root, 'about.html'), HTML_PAGE.replace('Home', 'About'));
    assert.match(result.notes.join('\n'), /Dry run/);
  });

  it('patches an explicit file list, bypassing detection', () => {
    const root = htmlTree();
    const result = install({ root, files: ['about.html'] });

    assert.deepEqual(result.changed.map((entry) => rel(root, entry.file)), ['about.html']);
    assert.ok(read(root, 'about.html').includes(SNIPPET));
    assert.equal(read(root, 'index.html'), HTML_PAGE, 'index.html was not in the list');
  });

  it('does nothing but explain itself on an unrecognised tree', () => {
    const root = unknownTree();
    const result = install({ root });

    assert.deepEqual(result.changed, []);
    assert.equal(result.framework, 'unknown');
    assert.ok(result.notes.length > 0);
  });

  it('preserves CRLF line endings', () => {
    const root = tree({ 'index.html': HTML_PAGE.replace(/\n/g, '\r\n'), 'vite.config.js': 'export default {};\r\n' });
    install({ root });
    const content = read(root, 'index.html');
    assert.ok(content.includes(`\r\n    ${SNIPPET}\r\n  </head>`), JSON.stringify(content));
    assert.ok(!/[^\r]\n/.test(content), 'no bare LF was introduced');
  });

  it('opens up a one-line head', () => {
    const root = tree({ 'index.html': '<html><head><title>x</title></head><body></body></html>\n' });
    install({ root });
    assert.equal(
      read(root, 'index.html'),
      `<html><head><title>x</title>\n  ${SNIPPET}\n</head><body></body></html>\n`,
    );
  });
});

// ------------------------------------------------------------------- removal --

describe('uninstallSnippet', () => {
  it('removes exactly what was added', () => {
    for (const root of [htmlTree(), nextTree(), nextTree(NEXT_LAYOUT_NO_HEAD), hugoTree(), astroTree(), wordpressTree()]) {
      const files = detectProject(root).targets.map((target) => target.file);
      const before = files.map((file) => fs.readFileSync(file, 'utf8'));

      install({ root });
      const result = uninstallSnippet({ root });

      assert.ok(
        result.changed.every((entry) => entry.action === 'replaced'),
        `uninstall on ${root}: ${JSON.stringify(result.changed.map((entry) => entry.action))}`,
      );
      assert.deepEqual(files.map((file) => fs.readFileSync(file, 'utf8')), before, `round trip on ${root}`);
    }
  });

  it('leaves other analytics tags in place', () => {
    const root = htmlTree({ 'index.html': HTML_PAGE.replace('  </head>', `    ${PLAUSIBLE}\n  </head>`) });
    install({ root });
    uninstallSnippet({ root });

    const content = read(root, 'index.html');
    assert.ok(content.includes(PLAUSIBLE));
    assert.ok(!content.includes('/js/cr.js'));
  });

  it('reports unchanged when there is nothing to remove', () => {
    const root = htmlTree();
    const result = uninstallSnippet({ root });

    assert.ok(result.changed.every((entry) => entry.action === 'unchanged'));
    assert.match(result.notes.join('\n'), /nothing was removed/i);
    assert.equal(read(root, 'index.html'), HTML_PAGE);
  });

  it('writes nothing on a dry run', () => {
    const root = htmlTree();
    install({ root });
    const installed = read(root, 'index.html');

    const result = uninstallSnippet({ root, dryRun: true });
    assert.equal(result.changed[0].action, 'replaced');
    assert.equal(read(root, 'index.html'), installed);
  });

  it('drops the next/script import it added', () => {
    const root = nextTree(NEXT_LAYOUT_NO_HEAD);
    install({ root });
    uninstallSnippet({ root });
    assert.equal(read(root, 'app/layout.tsx'), NEXT_LAYOUT_NO_HEAD);
  });

  it('takes the entry back out of a Nuxt config', () => {
    const source = 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n';
    const root = tree({ 'nuxt.config.mjs': source });
    install({ root });
    uninstallSnippet({ root });
    // The nested app.head.script scaffolding stays, but the tracker is gone.
    const content = read(root, 'nuxt.config.mjs');
    assert.ok(!content.includes('cr.js'));
    assert.ok(!content.includes('example.com'));
  });
});

// -------------------------------------------------------------------- safety --

describe('path safety', () => {
  it('refuses a relative path that escapes the root', () => {
    const root = htmlTree();
    const outside = path.join(path.dirname(root), 'outside.html');
    fs.writeFileSync(outside, HTML_PAGE, 'utf8');

    assert.throws(
      () => install({ root, files: ['../outside.html'] }),
      (error) => error instanceof InstallError && /outside/.test(error.message),
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), HTML_PAGE);
    fs.rmSync(outside, { force: true });
  });

  it('refuses an absolute path outside the root', () => {
    const root = htmlTree();
    const other = htmlTree();
    assert.throws(
      () => install({ root, files: [path.join(other, 'index.html')] }),
      (error) => error instanceof InstallError && error.status === 403,
    );
    assert.equal(read(other, 'index.html'), HTML_PAGE);
  });

  it('refuses a symlink pointing out of the root', () => {
    const root = htmlTree();
    const other = htmlTree();
    fs.symlinkSync(path.join(other, 'index.html'), path.join(root, 'linked.html'));

    assert.throws(() => install({ root, files: ['linked.html'] }), InstallError);
    assert.equal(read(other, 'index.html'), HTML_PAGE);
  });

  it('refuses build output and dependencies even when named explicitly', () => {
    const root = htmlTree();
    for (const target of ['node_modules/pkg/index.html', 'dist/index.html', '.next/server/index.html']) {
      assert.throws(
        () => install({ root, files: [target] }),
        (error) => error instanceof InstallError && error.status === 403,
        target,
      );
      assert.equal(read(root, target), HTML_PAGE);
    }
  });

  it('refuses a missing root and a missing file', () => {
    const root = htmlTree();
    assert.throws(() => install({ root: path.join(root, 'nope') }), InstallError);
    assert.throws(() => install({ root, files: ['nope.html'] }), InstallError);
  });
});

// ------------------------------------------------------------------- snippet --

describe('parseSnippet', () => {
  it('keeps the tag it was given and derives the JSX form', () => {
    const parsed = parseSnippet(`  ${SNIPPET}  `);
    assert.equal(parsed.html, SNIPPET);
    assert.equal(parsed.jsx, '<script defer data-domain="example.com" src="https://analytics.example.com/js/cr.js" />');
    assert.equal(parsed.domain, 'example.com');
    assert.equal(parsed.src, 'https://analytics.example.com/js/cr.js');
  });

  it('rejects anything that is not a script tag', () => {
    assert.throws(() => parseSnippet('cred_123'), InstallError);
    assert.throws(() => parseSnippet('<script defer></script>'), InstallError);
    assert.throws(() => install({ root: htmlTree(), snippet: '' }), InstallError);
  });
});
