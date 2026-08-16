/**
 * Structural checks on the Google Tag Manager template.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * The sandboxed JavaScript only runs inside Tag Manager, so nothing here
 * executes the tag. What it does catch is the class of mistake that actually
 * ships: a block that will not parse and so cannot be imported at all, a
 * required key missing from __INFO__, and — the classic Tag Manager bug — a
 * require() in the code with no matching entry in the permissions block,
 * which fails at runtime in the customer's browser rather than at import.
 *
 * A hand-written parser rather than a YAML or .tpl library, because this
 * repository has no dependencies. The format is simple: blocks introduced by
 * ___NAME___ at the start of a line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'template.tpl'), 'utf8');

/** Split the file into { BLOCK_NAME: contents }. */
function parseBlocks(source) {
  const blocks = {};
  const pattern = /^___([A-Z_]+)___$/gm;
  const found = [];
  let match = pattern.exec(source);
  while (match) {
    found.push({ name: match[1], start: match.index + match[0].length });
    match = pattern.exec(source);
  }
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? source.lastIndexOf('___' + found[i + 1].name + '___') : source.length;
    blocks[found[i].name] = source.slice(found[i].start, end).trim();
  }
  return blocks;
}

const blocks = parseBlocks(SOURCE);

test('every block Tag Manager expects is present, in order', () => {
  const order = Object.keys(blocks);
  assert.deepEqual(order, [
    'TERMS_OF_SERVICE',
    'INFO',
    'TEMPLATE_PARAMETERS',
    'SANDBOXED_JS_FOR_WEB_TEMPLATE',
    'WEB_PERMISSIONS',
    'TESTS',
    'NOTES',
  ]);
});

test('__INFO__ is valid JSON and declares a web tag', () => {
  const info = JSON.parse(blocks.INFO);
  assert.equal(info.type, 'TAG');
  assert.equal(info.version, 1);
  assert.ok(info.id, 'an id is required');
  assert.equal(info.displayName, 'Credible Analytics');
  assert.deepEqual(info.containerContexts, ['WEB']);
  assert.deepEqual(info.categories, ['ANALYTICS']);
  assert.ok(info.description.length > 40, 'the gallery listing needs a real description');
  assert.ok(Array.isArray(info.securityGroups));
});

test('the template parameters parse and are internally consistent', () => {
  const params = JSON.parse(blocks.TEMPLATE_PARAMETERS);
  assert.ok(Array.isArray(params) && params.length > 0);

  /** Every parameter name, including those nested inside GROUPs. */
  const names = [];
  const walk = (list) => {
    for (const param of list) {
      assert.ok(param.type, 'a parameter has no type');
      assert.ok(param.name, 'a parameter has no name');
      names.push(param.name);
      if (param.subParams) walk(param.subParams);
    }
  };
  walk(params);

  assert.equal(new Set(names).size, names.length, 'parameter names must be unique');
  for (const expected of ['tagType', 'eventName', 'props', 'revenueAmount', 'revenueCurrency', 'pageUrl', 'referrer', 'debug']) {
    assert.ok(names.includes(expected), `the ${expected} parameter is missing`);
  }

  // An enabling condition pointing at a parameter that does not exist leaves
  // a field permanently hidden, which is invisible until a user complains.
  const checkConditions = (list) => {
    for (const param of list) {
      for (const condition of param.enablingConditions || []) {
        assert.ok(names.includes(condition.paramName), `${param.name} is gated on unknown parameter ${condition.paramName}`);
      }
      if (param.subParams) checkConditions(param.subParams);
    }
  };
  checkConditions(params);

  const tagType = params.find((param) => param.name === 'tagType');
  const values = tagType.radioItems.map((item) => item.value);
  assert.deepEqual(values, ['event', 'pageview']);
  assert.ok(values.includes(tagType.defaultValue), 'the default must be one of the choices');
});

test('the permissions block parses and grants only window.credible', () => {
  const permissions = JSON.parse(blocks.WEB_PERMISSIONS);
  const ids = permissions.map((permission) => permission.instance.key.publicId);
  assert.deepEqual(ids.sort(), ['access_globals', 'logging']);

  const globals = permissions.find((permission) => permission.instance.key.publicId === 'access_globals');
  const keys = globals.instance.param[0].value.listItem.map((item) => {
    const index = item.mapKey.findIndex((entry) => entry.string === 'key');
    return item.mapValue[index].string;
  });
  assert.deepEqual(keys.sort(), ['credible', 'credible.l', 'credible.q']);

  // Nothing outside the tracker's own global is reachable. A template that
  // asked for more would be rejected by anyone reading it before importing.
  for (const key of keys) {
    assert.ok(key === 'credible' || key.startsWith('credible.'), `${key} is outside window.credible`);
  }
});

test('every require() in the sandboxed JS has a matching permission', () => {
  const code = blocks.SANDBOXED_JS_FOR_WEB_TEMPLATE;
  const required = [...code.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(required.length > 0, 'the tag requires nothing at all, which cannot be right');

  // Which permission each sandbox API needs. Anything demanding a permission
  // the block does not grant throws in the visitor's browser at tag time.
  const needs = {
    callInWindow: 'access_globals',
    copyFromWindow: 'access_globals',
    createArgumentsQueue: 'access_globals',
    setInWindow: 'access_globals',
    logToConsole: 'logging',
    injectScript: 'inject_script',
    sendPixel: 'send_pixel',
    makeNumber: null, // no permission needed
    makeTableMap: null,
    makeString: null,
    JSON: null,
    Math: null,
    Object: null,
  };

  const granted = new Set(
    JSON.parse(blocks.WEB_PERMISSIONS).map((permission) => permission.instance.key.publicId),
  );

  for (const api of required) {
    assert.ok(api in needs, `unrecognised sandbox API "${api}" — add it to this test's table`);
    const permission = needs[api];
    if (permission) {
      assert.ok(granted.has(permission), `require('${api}') needs the "${permission}" permission`);
    }
  }

  // Every granted permission should be used, or it is asking for access the
  // tag does not need.
  for (const permission of granted) {
    const used = required.some((api) => needs[api] === permission);
    assert.ok(used, `the "${permission}" permission is granted but never used`);
  }
});

test('the sandboxed JS parses as JavaScript', () => {
  // Necessary, not sufficient: Tag Manager's sandbox is a subset of
  // JavaScript, so this catches a typo but would not catch using a construct
  // the sandbox forbids. Wrapped in a function with `data` in scope, since
  // that is how Tag Manager supplies it.
  const code = blocks.SANDBOXED_JS_FOR_WEB_TEMPLATE;
  assert.doesNotThrow(() => new Function('data', 'require', code));
});

test('the sandboxed JS never reaches for a browser global', () => {
  // The sandbox has no window, document, fetch or XMLHttpRequest, and code
  // that reaches for one fails at runtime rather than at import.
  // Comments talk about window.credible constantly; only real code counts.
  const code = blocks.SANDBOXED_JS_FOR_WEB_TEMPLATE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/\bwindow\./, /\bdocument\./, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnavigator\./]) {
    assert.doesNotMatch(code, forbidden, `the sandboxed code references ${forbidden}`);
  }
});

test('the tests block is valid, and honest about being empty', () => {
  assert.equal(blocks.TESTS, 'scenarios: []');
  // Tag Manager scenarios only run inside its own editor. Shipping ones that
  // have never been executed would be worse than shipping none, so the notes
  // carry a manual verification procedure instead.
  assert.match(blocks.NOTES, /Preview/);
});

test('the notes explain why the tag does not inject the tracker', () => {
  // This is the surprising part of the design. If the explanation ever goes
  // missing, the next person will "fix" it by adding a broken install mode.
  assert.match(blocks.NOTES, /data-domain/);
  assert.match(blocks.NOTES, /injectScript/);
  assert.match(blocks.NOTES, /Custom HTML/);
});
