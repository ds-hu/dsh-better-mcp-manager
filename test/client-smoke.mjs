#!/usr/bin/env node
/**
 * Evaluate the browser bundle against a mock Cordis context.
 *
 * The client half is a hand-written classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; no bundler or type-checker ever looks
 * at it, so this script is its compiler. It runs the real file in a `vm` with a
 * fake browser, calls the real factory with a fake `require`, calls the real
 * `apply` with a mock Cordis context, and asserts the registrations the Web
 * shell depends on were actually made — both slots, the locale dictionaries,
 * the stylesheet, and the timers that must not outlive dispose.
 *
 * Some checks are static (`require()` allow-list, API base string): the client
 * may never require anything but `react`, and it may only talk to the Host
 * under `/better-mcp-manager/api`.
 *
 * Offline: nothing here touches the network, the Host or a browser.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'lib/client.js');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageName = packageJson.name;

const failures = [];

/**
 * Run one labelled assertion without aborting the audit.
 * @param {string} label - What is being checked.
 * @param {() => void} fn - The check.
 * @returns {void}
 */
function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}

/* ---------------------------------------------------------------- */
/* static checks: the shipped file                                   */
/* ---------------------------------------------------------------- */

const source = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
let loadError = null;

check('lib/client.js exists and is not empty', () => {
  assert.ok(existsSync(clientPath), `lib/client.js is missing — the Web shell has no browser half to load (ui-builder owns this file)`);
  assert.ok(source.trim().length > 0, 'lib/client.js is empty');
});

if (source !== '') {
  check('the browser half requires nothing except react', () => {
    const required = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((match) => match[1]);
    const unexpected = required.filter((specifier) => specifier !== 'react');
    assert.deepEqual(unexpected, [], `lib/client.js requires ${unexpected.join(', ')}; only "react" exists in the shell's client module table`);
    assert.ok(required.includes('react'), 'lib/client.js must obtain React through require("react")');
  });

  check('the browser half talks only to /better-mcp-manager/api', () => {
    assert.ok(source.includes('/better-mcp-manager/api'), 'lib/client.js does not contain the API base "/better-mcp-manager/api" (docs/API-CONTRACT.md §3)');
    const literals = [...source.matchAll(/["'`](\/[^"'`\s]{1,})["'`]/gu)].map((match) => match[1]);
    const foreign = literals.filter((path) => /^\/[a-z-]+\/api/u.test(path) && !path.startsWith('/better-mcp-manager/api'));
    assert.deepEqual(foreign, [], `unexpected API path literal(s): ${foreign.join(', ')}`);
  });

  check('the browser half never imports a Harness package', () => {
    assert.doesNotMatch(source, /import\s[^;]*?from\s+['"]@deepseek-ai\//u, 'lib/client.js imports an @deepseek-ai/ package');
    assert.doesNotMatch(source, /require\(\s*['"]@deepseek-ai\//u, 'lib/client.js requires an @deepseek-ai/ package');
  });

  check('the browser half is syntactically valid JavaScript', () => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'lib/client.js' }), 'lib/client.js does not parse');
  });
}

/* ---------------------------------------------------------------- */
/* the browser-ish vm sandbox                                        */
/* ---------------------------------------------------------------- */

/**
 * Fake browser timers that never fire, so the smoke test is instant and cannot
 * leave anything running. Every created timer is tracked to prove dispose
 * cleared it.
 * @returns {object} the three timer functions plus the registry.
 */
function createTimers() {
  const created = [];
  let nextId = 1;
  const record = (kind) => {
    const id = nextId++;
    created.push({ id, kind, cleared: false });
    return id;
  };
  const clear = (id) => {
    const timer = created.find((candidate) => candidate.id === id);
    if (timer !== undefined) timer.cleared = true;
  };
  return {
    created,
    setTimeout: () => record('timeout'),
    clearTimeout: (id) => clear(id),
    setInterval: () => record('interval'),
    clearInterval: (id) => clear(id),
  };
}

/**
 * A DOM with exactly one <head>, style-tag creation and the query used by the
 * official CSS-injection idiom.
 * @param {object[]} appended - receives nodes appended to <head>.
 * @returns {object} the fake document.
 */
function createDocument(appended) {
  const makeNode = (tagName) => {
    const node = {
      tagName,
      dataset: {},
      style: {},
      attrs: {},
      textContent: '',
      children: [],
      parentNode: undefined,
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = undefined;
        return child;
      },
      remove() {
        if (this.parentNode !== undefined) this.parentNode.removeChild(this);
      },
    };
    return node;
  };
  const head = makeNode('head');
  head.appendChild = (child) => {
    child.parentNode = head;
    appended.push(child);
    return child;
  };
  head.removeChild = (child) => {
    const index = appended.indexOf(child);
    if (index >= 0) appended.splice(index, 1);
    child.parentNode = undefined;
    return child;
  };
  head.children = appended;
  const body = makeNode('body');
  return {
    head,
    body,
    documentElement: makeNode('html'),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tagName) => makeNode(tagName),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/**
 * A React stand-in: enough for a module to build element trees, never enough
 * to render them.
 * @returns {object} the fake react module.
 */
function createReact() {
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
    useReducer: (reducer, initial) => [initial, () => {}],
    useId: () => 'test-id',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createRef: () => ({ current: null }),
    forwardRef: (fn) => fn,
    memo: (fn) => fn,
    createContext: (defaultValue) => ({ Provider: Symbol('Provider'), Consumer: Symbol('Consumer'), _defaultValue: defaultValue }),
    useContext: (context) => context?._defaultValue,
  };
}

/**
 * Load the browser bundle exactly the way the shell does and apply it.
 * @returns {object} the loaded plugin plus everything it registered.
 */
function loadBundle() {
  const appended = [];
  const timers = createTimers();
  const document = createDocument(appended);
  const fetchCalls = [];
  const fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, servers: [], presets: [], groups: [], version: '0.1.0' }),
      text: async () => '{"ok":true}',
    };
  };
  const sandbox = {
    console,
    document,
    fetch,
    navigator: { language: 'zh-CN', userAgent: 'client-smoke' },
    location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', pathname: '/' },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    queueMicrotask: (fn) => fn(),
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    structuredClone,
    performance,
    crypto: globalThis.crypto,
    btoa,
    atob,
  };
  sandbox.window = {};
  Object.assign(sandbox.window, {
    document,
    fetch,
    location: sandbox.location,
    navigator: sandbox.navigator,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  let registration;
  sandbox.window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  if (!registration) throw new Error('the bundle never called window.__ModuleLoader__.load({ id, factory })');
  if (typeof registration.factory !== 'function') throw new Error('the registration has no factory function');

  const requires = [];
  const fakeReact = createReact();
  const loaded = registration.factory((specifier) => {
    requires.push(specifier);
    if (specifier === 'react') return fakeReact;
    throw new Error(`the client bundle must not require ${specifier}`);
  });
  if (loaded === undefined || loaded === null || typeof loaded !== 'object') {
    throw new Error('the factory returned no exports object');
  }

  /* Mock Cordis context: runs effects immediately, collects every registration. */
  const log = { locale: [], slots: [], injected: [], home: [], onDispose: [], fetchCalls, requires };
  const disposers = [];
  const dictionaries = {};
  const runDisposer = (dispose, label) => {
    if (typeof dispose !== 'function') return;
    disposers.push({ dispose, label });
  };
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        log.locale.push({ namespace, dictionary });
        dictionaries[namespace] = dictionary;
        return () => {
          delete dictionaries[namespace];
        };
      },
      bind(namespace) {
        return (key) => dictionaries[namespace]?.zh?.[key] ?? key;
      },
      current: 'zh',
    },
    effect(fn, label) {
      const dispose = fn();
      log.home.push({ label, dispose });
      runDisposer(dispose, label ?? 'effect');
      return dispose;
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    get(name) {
      return name === 'webServer' ? { route() {} } : undefined;
    },
    on(event, callback) {
      if (event === 'dispose') {
        log.onDispose.push(callback);
        runDisposer(callback, 'on(dispose)');
      }
      return () => {};
    },
    slots: {
      inject(name, callback) {
        log.injected.push(name);
        callback();
      },
      register(definition, component) {
        log.slots.push({ definition, component });
        return () => {
          log.slots = log.slots.filter((entry) => entry.definition !== definition);
        };
      },
    },
  };
  loaded.apply(ctx);
  return { registration, exports: loaded, log, timers, appended, disposers, dictionaries };
}

/* ---------------------------------------------------------------- */
/* runtime checks                                                    */
/* ---------------------------------------------------------------- */

let bundle = null;
try {
  bundle = source === '' ? null : loadBundle();
} catch (error) {
  loadError = error;
  process.stdout.write(`FAIL lib/client.js could not be loaded\n     ${String(error.stack ?? error.message).split('\n').slice(0, 8).join('\n     ')}\n`);
}

/**
 * Throw the load error (if any) so dependent checks report why they could not run.
 * @returns {object} the loaded bundle.
 */
function bundleOrFail() {
  if (loadError) throw new Error(`lib/client.js did not load: ${loadError.message}`);
  assert.ok(bundle, 'lib/client.js did not load');
  return bundle;
}

check('the factory registers under the package name', () => {
  const loaded = bundleOrFail();
  assert.equal(loaded.registration.id, packageName, `__ModuleLoader__.load id must equal package.json name (${packageName})`);
});

check('the module exports a plugin shape', () => {
  const loaded = bundleOrFail();
  assert.equal(typeof loaded.exports.name, 'string', 'the module must export a `name` string');
  assert.ok(loaded.exports.name.length > 0, 'the exported name is empty');
  assert.ok(Array.isArray(loaded.exports.inject), 'the module must export an `inject` array');
  assert.equal(typeof loaded.exports.apply, 'function', 'the module must export `apply`');
});

check('the plugin asks for the slots and locale services', () => {
  const loaded = bundleOrFail();
  assert.ok(loaded.exports.inject.includes('slots'), `inject must include "slots", got ${JSON.stringify(loaded.exports.inject)}`);
  assert.ok(loaded.exports.inject.includes('locale'), `inject must include "locale", got ${JSON.stringify(loaded.exports.inject)}`);
});

check('exactly two slots are registered', () => {
  const loaded = bundleOrFail();
  const names = loaded.log.injected.slice().sort();
  assert.deepEqual(names, ['main', 'sidebar.panellist'], 'the client registers the sidebar entry and the page, nothing else');
  assert.equal(loaded.log.slots.length, 2, `expected two slot registrations, got ${loaded.log.slots.length}`);
  assert.deepEqual(loaded.log.slots.map((slot) => slot.definition.name).sort(), ['main', 'sidebar.panellist']);
});

check('the sidebar panellist entry is registered as agreed', () => {
  const loaded = bundleOrFail();
  const slot = loaded.log.slots.find((entry) => entry.definition.name === 'sidebar.panellist');
  assert.ok(slot, 'sidebar.panellist was not registered');
  const { definition, component } = slot;
  assert.equal(definition.id, 'mcp-manager', 'sidebar.panellist id must be "mcp-manager" (docs/API-CONTRACT.md §5)');
  assert.equal(definition.order, 20, 'sidebar.panellist order must be 20');
  assert.equal(definition.locale, 'mcpManager', 'the panel locale namespace must be "mcpManager"');
  assert.equal(typeof definition.label, 'function', 'the panel needs a label function for the sidebar');
  assert.equal(typeof component, 'function', 'the sidebar entry needs an icon/component');
  const label = definition.label();
  assert.equal(typeof label, 'string', 'label() must return a translated string');
  assert.ok(label.trim().length > 0, 'label() returned an empty string');
  assert.notEqual(label, 'panel', 'label() returned the raw key; the locale dictionary is not wired up');
});

check('the main page is registered under the same key', () => {
  const loaded = bundleOrFail();
  const slot = loaded.log.slots.find((entry) => entry.definition.name === 'main');
  assert.ok(slot, 'the main slot was not registered');
  const { definition, component } = slot;
  assert.equal(definition.key, 'mcp-manager', 'the main page key must be "mcp-manager"');
  assert.equal(definition.locale, 'mcpManager', 'the page locale namespace must be "mcpManager"');
  assert.equal(typeof component, 'function', 'the main slot needs a page component');
});

check('one locale namespace carries zh and en dictionaries', () => {
  const loaded = bundleOrFail();
  assert.equal(loaded.log.locale.length, 1, `expected one locale registration, got ${loaded.log.locale.length}`);
  const [entry] = loaded.log.locale;
  assert.equal(entry.namespace, 'mcpManager', 'the locale namespace must be "mcpManager"');
  assert.ok(entry.dictionary.zh && typeof entry.dictionary.zh === 'object', 'the zh dictionary is missing');
  assert.ok(entry.dictionary.en && typeof entry.dictionary.en === 'object', 'the en dictionary is missing');
});

check('the zh and en dictionaries cover the same keys', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
  assert.deepEqual(missingInEn, [], `keys missing from en: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `keys missing from zh: ${missingInZh.join(', ')}`);
});

check('the dictionaries carry every label the panel needs', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  // The dictionary uses dotted namespaces (page.title, form.save, card.menu.edit,
  // …); assert that each contract §5 label exists in some form in both locales.
  const required = [
    { topic: 'panel', exact: 'panel' },
    { topic: 'title', pattern: /(^|\.)title$/u },
    { topic: 'add', pattern: /(^|\.)add$/u },
    { topic: 'save', pattern: /(^|\.)save$/u },
    { topic: 'delete', pattern: /(^|\.)delete$/u },
    { topic: 'enabled', pattern: /(^|\.)enabled$/u },
    { topic: 'name', pattern: /(^|\.)name$/u },
    { topic: 'transport', pattern: /(^|\.)transport$/u },
    { topic: 'address (URL or address)', pattern: /(^|\.)(?:url|address)$/u },
    { topic: 'headers', pattern: /(^|\.)headers(?:\.|$)/u },
    { topic: 'oauth', pattern: /(^|\.)oauth(?:\.|$)/u },
    { topic: 'presets', pattern: /(^|\.)presets(?:\.|$)/u },
    { topic: 'status.connected', exact: 'status.connected' },
    { topic: 'status.error', exact: 'status.error' },
    { topic: 'status.disabled', exact: 'status.disabled' },
    { topic: 'tools', pattern: /(^|\.)tools$/u },
    { topic: 'details', pattern: /(^|\.)details$/u },
    { topic: 'edit', pattern: /(^|\.)edit$/u },
    { topic: 'reconnect', pattern: /(^|\.)reconnect$/u },
    { topic: 'test', pattern: /(^|\.)test$/u },
    { topic: 'group', pattern: /(^|\.)group$/u },
    { topic: 'empty state', pattern: /(^|\.)empty/u },
  ];
  for (const { topic, exact, pattern } of required) {
    for (const locale of ['zh', 'en']) {
      const dictionary = locale === 'zh' ? zh : en;
      const match = exact !== undefined
        ? Object.hasOwn(dictionary, exact) && exact
        : Object.keys(dictionary).find((key) => pattern.test(key));
      assert.ok(match, `${locale} dictionary has no label for "${topic}"${exact === undefined ? '' : ` (expected key "${exact}")`}`);
      assert.equal(typeof dictionary[match], 'string', `${locale}["${match}"] is not a string`);
      assert.ok(dictionary[match].trim().length > 0, `${locale}["${match}"] is empty`);
    }
  }
});

check('every dictionary value is a non-empty string', () => {
  const loaded = bundleOrFail();
  for (const locale of ['zh', 'en']) {
    const dictionary = loaded.log.locale[0].dictionary[locale];
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}["${key}"] is not a string`);
      assert.ok(value.trim().length > 0, `${locale}["${key}"] is empty`);
    }
  }
});

check('exactly one owned stylesheet is attached and it carries the plugin id', () => {
  const loaded = bundleOrFail();
  const styles = loaded.appended.filter((node) => node.tagName === 'style');
  assert.equal(styles.length, 1, `expected one injected <style>, found ${styles.length}`);
  const [style] = styles;
  assert.equal(typeof style.dataset.pluginCss, 'string', 'the style tag needs data-plugin-css');
  assert.ok(style.dataset.pluginCss.length > 0, 'the style tag data-plugin-css is empty');
  assert.equal(typeof style.textContent, 'string', 'the style tag has no CSS text');
  assert.ok(style.textContent.trim().length > 0, 'the style tag is empty');
});

check('dispose removes the stylesheet', () => {
  const loaded = bundleOrFail();
  for (const { dispose, label } of loaded.disposers.slice().reverse()) {
    try {
      dispose();
    } catch (error) {
      throw new Error(`a dispose callback (${label}) threw: ${error.message}`, { cause: error });
    }
  }
  const styles = loaded.appended.filter((node) => node.tagName === 'style');
  assert.equal(styles.length, 0, 'the injected <style> is still in <head> after dispose');
});

check('dispose clears every timer the client created', () => {
  const loaded = bundleOrFail();
  const live = loaded.timers.created.filter((timer) => !timer.cleared);
  assert.deepEqual(live.map((timer) => `${timer.kind}#${timer.id}`), [], 'timers outlive dispose');
});

check('nothing is left polling after dispose', () => {
  const loaded = bundleOrFail();
  assert.equal(loaded.timers.created.filter((timer) => timer.kind === 'interval' && !timer.cleared).length, 0, 'an interval survives dispose');
});

/* ---------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} client check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nclient-smoke: all checks passed\n');
}
