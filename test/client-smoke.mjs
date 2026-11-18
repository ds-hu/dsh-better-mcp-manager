#!/usr/bin/env node
/**
 * Evaluate the browser bundle against a mock Cordis context.
 *
 * The client half is a hand-written classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; no bundler or type-checker ever looks
 * at it, so this script is its compiler. It runs the real file in a `vm` with a
 * fake browser, calls the real factory with a fake `require`, calls the real
 * `apply` with a mock Cordis context, and asserts the registrations the Web
 * shell depends on were actually made — the always-present Settings section and
 * its icon, the optional sidebar module the Host preference switches on and
 * off live, the locale dictionaries, the stylesheet, and the timers that must
 * not outlive dispose.
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
    const calls = [...source.matchAll(/\brequire\s*\(/gu)].length;
    assert.equal(calls, required.length, 'every require() call must be a string literal; the shell cannot resolve a dynamic specifier');
  });

  check('the browser half talks only to /better-mcp-manager/api', () => {
    assert.ok(source.includes('/better-mcp-manager/api'), 'lib/client.js does not contain the API base "/better-mcp-manager/api" (docs/API-CONTRACT.md §3)');
    const literals = [...source.matchAll(/["'`](\/[^"'`\s]{1,})["'`]/gu)].map((match) => match[1]);
    const foreign = literals.filter((path) => /^\/[a-z-]+\/api/u.test(path) && !path.startsWith('/better-mcp-manager/api'));
    assert.deepEqual(foreign, [], `unexpected API path literal(s): ${foreign.join(', ')}`);
  });

  check('the browser half has no emoji icon palette', () => {
    assert.doesNotMatch(source, /EMOJIS/u, 'the 0.1.0 EMOJIS palette must be gone (contract §2.6: no emoji palette)');
    assert.doesNotMatch(source, /iconGlyph/u, 'the 0.1.0 iconGlyph helper was replaced by iconLetter/iconUrlOf');
    const emoji = source.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
    assert.equal(emoji, null, `lib/client.js still contains emoji glyph(s): ${emoji === null ? '' : emoji.join(' ')}`);
  });

  check('the icon UI carries the agreed test hooks', () => {
    for (const testId of ['server-icon', 'form-icon', 'icon-preview', 'icon-upload', 'icon-file', 'icon-remove']) {
      assert.ok(source.includes(`"data-testid": "${testId}"`), `lib/client.js is missing data-testid="${testId}"`);
    }
    assert.match(source, /FileReader/u, 'the client must read the picked file with FileReader');
    assert.match(source, /readAsDataURL/u, 'the upload must become a data URL before POST');
    assert.match(source, /image\/png,image\/jpeg,image\/webp,image\/gif/u, 'the file input must accept the four raster types');
    assert.match(source, /accept:\s*ICON_ACCEPT/u, 'the file input accept filter must use ICON_ACCEPT');
    assert.match(source, /\/icon"/u, 'the client must call the icon endpoint');
  });

  check('the tools tab carries the agreed test hooks', () => {
    const testIds = [
      'form-tab-basic', 'form-tab-tools', 'tools-panel', 'tools-loading', 'tools-error', 'tools-retry',
      'tools-cached', 'tools-count', 'tools-empty', 'tools-save-first', 'tool-card', 'tool-name',
      'tool-desc', 'tool-param', 'tool-enabled', 'tool-approval', 'tools-save', 'tools-enable-all', 'tools-disable-all',
    ];
    for (const testId of testIds) assert.ok(source.includes(`"${testId}"`), `lib/client.js is missing the "${testId}" hook`);
    assert.match(source, /\/tools"/u, 'the client must call the /servers/:id/tools endpoint');
    assert.match(source, /enabledToolCount/u, 'the card count must read enabledToolCount (contract §2.3)');
  });

  check('the external MCP tab carries the agreed test hooks and no own-server actions', () => {
    const testIds = [
      'page-tab-owned', 'page-tab-external', 'external-panel', 'external-loading', 'external-error',
      'external-retry', 'external-empty', 'external-scan', 'external-preset', 'external-owned-badge',
      'external-pending', 'external-server-card', 'external-server-view', 'external-back',
      'external-tools-panel', 'external-count', 'external-enable-all', 'external-disable-all',
      'external-tool-card', 'external-tool-name', 'external-tool-desc', 'external-tool-param',
      'external-tool-enabled', 'external-tool-approval', 'external-save',
    ];
    for (const testId of testIds) assert.ok(source.includes(`"${testId}"`), `lib/client.js is missing the "${testId}" hook`);
    for (const path of ['"/external"', '"/external/scan"', '"/external/tools"']) {
      assert.ok(source.includes(path), `the client must call ${path}`);
    }
    for (const forbidden of ['external-add', 'external-edit', 'external-delete', 'external-test', 'external-reconnect']) {
      assert.equal(source.includes(`"${forbidden}"`), false, `the external tab must never offer ${forbidden}`);
    }
    assert.match(source, /data-preset-id/u, 'each external preset group carries its preset id');
    assert.match(source, /data-server-name/u, 'each compact server card carries its server name');
    assert.match(source, /externalBaselines/u, 'the tab tracks per-preset save baselines');

    // 0.4.1 compact presentation: the list view renders server cards only and
    // opens a per-server view; tool cards may only appear inside that detail view.
    const cardStart = source.indexOf('function ExternalServerCard');
    const viewStart = source.indexOf('function ExternalServerView');
    const nextFunction = source.indexOf('function EditFormView');
    assert.ok(cardStart > 0, 'ExternalServerCard must be defined');
    assert.ok(viewStart > cardStart, 'ExternalServerView must follow ExternalServerCard');
    assert.ok(nextFunction > viewStart, 'sanity: the detail view ends before the edit form');
    const cardBody = source.slice(cardStart, viewStart);
    const viewBody = source.slice(viewStart, nextFunction);
    assert.equal(cardBody.includes('ExternalToolCard'), false, 'the compact server card must not expand tool cards inline');
    assert.ok(viewBody.includes('ExternalToolCard'), 'the per-server view renders the full tool cards');
    assert.ok(cardBody.includes('external-server-card'), 'the compact card carries its test hook');
    assert.ok(cardBody.includes('mm-externalServerCard'), 'the compact card uses the shared card class');
    assert.ok(viewBody.includes('external-server-view'), 'the detail view carries its test hook');
    assert.ok(viewBody.includes('external-back'), 'the detail view has a back button');
    assert.ok(viewBody.includes('external-enable-all') && viewBody.includes('external-disable-all'), 'the detail view has the batch buttons');
    assert.ok(viewBody.includes('external-count'), 'the detail view shows the tools.count line');
  });

  check('the Settings entry and the optional sidebar module carry their test hooks', () => {
    for (const token of ['"settings.section"', '"settings.section.icon"', '"sidebar.panellist"', '"main"']) {
      assert.ok(source.includes(`ctx.slots.inject(${token}`) || source.includes(`inject(${token}`), `lib/client.js never injects the ${token} slot type`);
    }
    for (const testId of ['sidebar-entry-row', 'sidebar-entry-toggle']) {
      assert.ok(source.includes(`"${testId}"`), `lib/client.js is missing data-testid="${testId}"`);
    }
    assert.match(source, /"data-mode"/u, 'the manager root must carry data-mode so Settings mode can be styled/asserted');
    assert.match(source, /role:\s*"switch"/u, 'the sidebar-entry control must be a switch');
    assert.match(source, /"aria-checked"/u, 'the sidebar-entry switch must expose aria-checked');
    assert.match(source, /\/preferences/u, 'the client must call the Host preference endpoint');
    assert.match(source, /sidebarEntry/u, 'the client must follow the Host sidebarEntry preference');
    assert.match(source, /SETTINGS_ORDER\s*=\s*30|order:\s*30/u, 'the Settings section order must be 30');
    assert.match(source, /SIDEBAR_ORDER\s*=\s*20|order:\s*20/u, 'the optional sidebar row order must be 20');
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

const PREFERENCES_URL = '/better-mcp-manager/api/preferences';

/** Yield a few event-loop turns so mocked fetches and their promise chains settle. */
async function settle(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Load the browser bundle exactly the way the shell does and apply it.
 *
 * The mock Cordis slot ledger mirrors the real dynamic API: `inject(name, cb)`
 * invokes the callback immediately and returns its cleanup, and `register()`
 * returns a disposer that removes exactly that entry. That lets the checks
 * observe the optional sidebar module appearing and disappearing live.
 *
 * @param {{ sidebarEntry?: boolean }} [options] - Host preference answered by the mock.
 * @returns {Promise<object>} the loaded plugin plus everything it registered.
 */
async function loadBundle({ sidebarEntry = false } = {}) {
  const appended = [];
  const timers = createTimers();
  const document = createDocument(appended);
  const fetchCalls = [];
  const preferences = { sidebarEntry: sidebarEntry === true };
  const respond = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  const fetch = async (url, init) => {
    const target = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ url: target, init });
    if (target === PREFERENCES_URL) {
      if (method === 'PUT') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        if (typeof body.sidebarEntry === 'boolean') preferences.sidebarEntry = body.sidebarEntry;
      }
      return respond({ ok: true, preferences: { sidebarEntry: preferences.sidebarEntry } });
    }
    return respond({ ok: true, servers: [], presets: [], groups: [], version: '0.1.0' });
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
        const start = log.slots.length;
        const cleanup = callback();
        const created = log.slots.slice(start);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          if (typeof cleanup === 'function') cleanup();
          for (const entry of created) {
            const index = log.slots.indexOf(entry);
            if (index >= 0) log.slots.splice(index, 1);
          }
        };
      },
      register(definition, component) {
        const entry = { definition, component };
        log.slots.push(entry);
        return () => {
          const index = log.slots.indexOf(entry);
          if (index >= 0) log.slots.splice(index, 1);
        };
      },
    },
  };
  loaded.apply(ctx);
  // The initial preferences read is asynchronous on purpose; let it settle so
  // the default (off) still mounts nothing.
  await settle();
  return { registration, exports: loaded, log, timers, appended, disposers, dictionaries };
}

/* ---------------------------------------------------------------- */
/* runtime checks                                                    */
/* ---------------------------------------------------------------- */

let bundle = null;
try {
  bundle = source === '' ? null : await loadBundle();
} catch (error) {
  loadError = error;
  process.stdout.write(`FAIL lib/client.js could not be loaded\n     ${String(error.stack ?? error.message).split('\n').slice(0, 8).join('\n     ')}\n`);
}

/* A second instance whose Host preference is already true at load time. */
let prefOnBundle = null;
let prefOnError = null;
if (source !== '') {
  try {
    prefOnBundle = await loadBundle({ sidebarEntry: true });
  } catch (error) {
    prefOnError = error;
  }
}

/**
 * Run one async labelled assertion without aborting the audit.
 * @param {string} label - What is being checked.
 * @param {() => Promise<void>} fn - The check.
 * @returns {Promise<void>} resolves when done.
 */
async function checkAsync(label, fn) {
  try {
    await fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
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

check('the default entry is the Settings section and its icon, nothing else', () => {
  const loaded = bundleOrFail();
  const names = loaded.log.injected.slice().sort();
  assert.deepEqual(names, ['settings.section', 'settings.section.icon'], 'a fresh install registers the Settings section (and its nav icon) only; the sidebar module is opt-in');
  assert.equal(loaded.log.slots.length, 2, `expected two slot registrations, got ${loaded.log.slots.length}`);
  assert.deepEqual(loaded.log.slots.map((slot) => slot.definition.name).sort(), ['settings.section', 'settings.section.icon']);
  assert.equal(loaded.log.slots.some((slot) => slot.definition.name === 'main' || slot.definition.name === 'sidebar.panellist'), false, 'no sidebar/module entry may exist while the Host preference is off');
});

check('the Settings section is registered as agreed', () => {
  const loaded = bundleOrFail();
  const slot = loaded.log.slots.find((entry) => entry.definition.name === 'settings.section');
  assert.ok(slot, 'settings.section was not registered');
  const { definition, component } = slot;
  assert.equal(definition.id, 'mcp-manager', 'settings.section id must be "mcp-manager"');
  assert.equal(definition.order, 30, 'settings.section order must be 30');
  assert.equal(definition.locale, 'mcpManager', 'the section locale namespace must be "mcpManager"');
  assert.equal(typeof definition.label, 'function', 'the section needs a label thunk for the nav rail');
  assert.equal(typeof component, 'function', 'the section needs a component');
  const label = definition.label();
  assert.equal(typeof label, 'string', 'label() must return a translated string');
  assert.notEqual(label, 'panel', 'label() returned the raw key; the locale dictionary is not wired up');
  assert.match(label, /MCP\s*管理/u, 'the zh nav label must read MCP 管理');
});

check('the Settings section icon is registered under the same id', () => {
  const loaded = bundleOrFail();
  const slot = loaded.log.slots.find((entry) => entry.definition.name === 'settings.section.icon');
  assert.ok(slot, 'settings.section.icon was not registered; the nav would fall back to the gear glyph');
  const { definition, component } = slot;
  assert.equal(definition.id, 'mcp-manager', 'settings.section.icon id must match the section id');
  assert.equal(definition.order, 30, 'settings.section.icon order must be 30');
  assert.equal(definition.locale, 'mcpManager', 'the icon locale namespace must be "mcpManager"');
  assert.equal(typeof component, 'function', 'the icon slot needs a component');
});

check('a Host preference of sidebarEntry=true mounts the optional module on load', () => {
  assert.equal(prefOnError, null, prefOnError === null ? '' : `the sidebar-enabled bundle did not load: ${prefOnError.message}`);
  const loaded = prefOnBundle;
  assert.ok(loaded, 'the sidebar-enabled bundle did not load');
  const names = loaded.log.injected.slice().sort();
  assert.deepEqual(names, ['main', 'settings.section', 'settings.section.icon', 'sidebar.panellist'], 'the preference must add the panel row and the main page on top of the Settings entry');
  assert.equal(loaded.log.slots.length, 4, `expected four slot registrations, got ${loaded.log.slots.length}`);
  assert.equal(loaded.exports.__mcpTest.isSidebarEntryMounted(), true);
  assert.equal(loaded.exports.__mcpTest.getPreferences().sidebarEntry, true);

  const panellist = loaded.log.slots.find((entry) => entry.definition.name === 'sidebar.panellist');
  assert.ok(panellist, 'sidebar.panellist was not registered');
  assert.equal(panellist.definition.id, 'mcp-manager', 'sidebar.panellist id must be "mcp-manager" (docs/API-CONTRACT.md §5)');
  assert.equal(panellist.definition.order, 20, 'sidebar.panellist order must be 20');
  assert.equal(panellist.definition.locale, 'mcpManager', 'the panel locale namespace must be "mcpManager"');
  assert.equal(typeof panellist.definition.label, 'function', 'the panel needs a label function for the sidebar');
  assert.equal(typeof panellist.component, 'function', 'the sidebar entry needs an icon/component');
  const label = panellist.definition.label();
  assert.equal(typeof label, 'string', 'label() must return a translated string');
  assert.notEqual(label, 'panel', 'label() returned the raw key; the locale dictionary is not wired up');

  const main = loaded.log.slots.find((entry) => entry.definition.name === 'main');
  assert.ok(main, 'the main slot was not registered while the module is on');
  assert.equal(main.definition.key, 'mcp-manager', 'the main page key must be "mcp-manager"');
  assert.equal(main.definition.locale, 'mcpManager', 'the page locale namespace must be "mcpManager"');
  assert.equal(typeof main.component, 'function', 'the main slot needs a page component');
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

check('the Settings entry row copy matches the contract in both languages', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  assert.equal(zh['entry.sidebar'], '在侧边栏显示 MCP 管理入口', 'the zh switch label is part of the locked contract');
  assert.equal(en['entry.sidebar'], 'Show MCP Manager in the sidebar', 'the en switch label is part of the locked contract');
  for (const [locale, dictionary] of [['zh', zh], ['en', en]]) {
    for (const key of ['entry.sidebarHint', 'entry.loadFailed', 'entry.saveFailed']) {
      assert.equal(typeof dictionary[key], 'string', `${locale}["${key}"] is missing; the Settings row needs its hint/error copy`);
      assert.ok(dictionary[key].trim().length > 0, `${locale}["${key}"] is empty`);
    }
  }
  assert.match(zh['entry.loadFailed'], /\{message\}/u, 'entry.loadFailed must carry the {message} placeholder');
  assert.match(en['entry.saveFailed'], /\{message\}/u, 'entry.saveFailed must carry the {message} placeholder');
});

check('the client exposes the sidebar-entry preference hooks', () => {
  const api = bundleOrFail().exports.__mcpTest;
  for (const name of ['loadPreferences', 'setSidebarEntryPreference', 'isSidebarEntryMounted', 'getPreferences']) {
    assert.equal(typeof api[name], 'function', `__mcpTest.${name} must be a function for the offline suite`);
  }
});

check('the initial Host preference read settles with the module off by default', () => {
  const loaded = bundleOrFail();
  const reads = loaded.log.fetchCalls.filter((call) => call.url === PREFERENCES_URL && String(call.init?.method ?? 'GET').toUpperCase() === 'GET');
  assert.ok(reads.length >= 1, 'apply must read GET /better-mcp-manager/api/preferences so the Host decides whether the sidebar module exists');
  assert.equal(loaded.exports.__mcpTest.getPreferences().sidebarEntry, false);
  assert.equal(loaded.exports.__mcpTest.isSidebarEntryMounted(), false);
});

await checkAsync('setSidebarEntryPreference(true) mounts the module live and PUTs the preference', async () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  const before = loaded.log.fetchCalls.length;
  await api.setSidebarEntryPreference(true);
  await settle();
  const puts = loaded.log.fetchCalls.slice(before).filter((call) => call.url === PREFERENCES_URL && String(call.init?.method ?? 'GET').toUpperCase() === 'PUT');
  assert.equal(puts.length, 1, `expected exactly one PUT /preferences, got ${puts.length}`);
  assert.deepEqual(JSON.parse(puts[0].init.body), { sidebarEntry: true }, 'the PUT body must be exactly { sidebarEntry: true }');
  assert.deepEqual(loaded.log.slots.map((slot) => slot.definition.name).sort(), ['main', 'settings.section', 'settings.section.icon', 'sidebar.panellist'], 'turning the switch on must register the sidebar module immediately');
  assert.equal(api.isSidebarEntryMounted(), true);
  assert.equal(api.getPreferences().sidebarEntry, true);
});

await checkAsync('setSidebarEntryPreference(false) unmounts both sidebar registrations live', async () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  const before = loaded.log.fetchCalls.length;
  await api.setSidebarEntryPreference(false);
  await settle();
  const puts = loaded.log.fetchCalls.slice(before).filter((call) => call.url === PREFERENCES_URL && String(call.init?.method ?? 'GET').toUpperCase() === 'PUT');
  assert.equal(puts.length, 1, `expected exactly one PUT /preferences, got ${puts.length}`);
  assert.deepEqual(JSON.parse(puts[0].init.body), { sidebarEntry: false }, 'the PUT body must be exactly { sidebarEntry: false }');
  assert.deepEqual(loaded.log.slots.map((slot) => slot.definition.name).sort(), ['settings.section', 'settings.section.icon'], 'turning the switch off must unregister both entries immediately');
  assert.equal(api.isSidebarEntryMounted(), false);
  assert.equal(api.getPreferences().sidebarEntry, false);
});

await checkAsync('the module remounts cleanly after a second switch-on', async () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  await api.setSidebarEntryPreference(true);
  await settle();
  assert.equal(loaded.log.slots.length, 4, `expected four slot registrations after remount, got ${loaded.log.slots.length}`);
  assert.deepEqual(loaded.log.slots.map((slot) => slot.definition.name).sort(), ['main', 'settings.section', 'settings.section.icon', 'sidebar.panellist'], 'the same four entries must be re-registered (no duplicates, no strays)');
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
    { topic: 'server icon field', exact: 'field.icon' },
    { topic: 'icon upload', exact: 'icon.upload' },
    { topic: 'icon auto reset', exact: 'icon.auto' },
    { topic: 'icon hint', exact: 'icon.hint' },
    { topic: 'icon invalid type', exact: 'icon.invalidType' },
    { topic: 'icon too large', exact: 'icon.tooLarge' },
    { topic: 'icon upload failure', exact: 'icon.uploadFailed' },
    { topic: 'icon removed', exact: 'icon.removed' },
    { topic: 'icon automatic label', exact: 'icon.autoLabel' },
    { topic: 'form basic tab', exact: 'form.tabBasic' },
    { topic: 'form tools tab', exact: 'form.tabTools' },
    { topic: 'form tabs label', exact: 'form.tabsLabel' },
    { topic: 'tools title', exact: 'tools.title' },
    { topic: 'tools hint', exact: 'tools.hint' },
    { topic: 'tools loading', exact: 'tools.loading' },
    { topic: 'tools retry', exact: 'tools.retry' },
    { topic: 'tools empty', exact: 'tools.empty' },
    { topic: 'tools offline', exact: 'tools.offline' },
    { topic: 'tools cached', exact: 'tools.cached' },
    { topic: 'tools cachedAt', exact: 'tools.cachedAt' },
    { topic: 'tools save', exact: 'tools.save' },
    { topic: 'tools saved', exact: 'tools.saved' },
    { topic: 'tools save failure', exact: 'tools.saveFailed' },
    { topic: 'tools load failure', exact: 'tools.loadFailed' },
    { topic: 'tools enable all', exact: 'tools.enableAll' },
    { topic: 'tools disable all', exact: 'tools.disableAll' },
    { topic: 'tools approval', exact: 'tools.approval' },
    { topic: 'tools approval hint', exact: 'tools.approvalHint' },
    { topic: 'tools params', exact: 'tools.params' },
    { topic: 'tools required', exact: 'tools.required' },
    { topic: 'tools optional', exact: 'tools.optional' },
    { topic: 'tools no params', exact: 'tools.noParams' },
    { topic: 'tools disabled note', exact: 'tools.disabledNote' },
    { topic: 'tools count', exact: 'tools.count' },
    { topic: 'tools save first', exact: 'tools.saveFirst' },
    { topic: 'tools footer hint', exact: 'tools.footHint' },
    { topic: 'page owned tab', exact: 'page.tabOwned' },
    { topic: 'page external tab', exact: 'page.tabExternal' },
    { topic: 'page tabs label', exact: 'page.tabsLabel' },
    { topic: 'external title', exact: 'external.title' },
    { topic: 'external intro', exact: 'external.intro' },
    { topic: 'external scan', exact: 'external.scan' },
    { topic: 'external scanning', exact: 'external.scanning' },
    { topic: 'external scannedAt', exact: 'external.scannedAt' },
    { topic: 'external neverScanned', exact: 'external.neverScanned' },
    { topic: 'external loading', exact: 'external.loading' },
    { topic: 'external empty', exact: 'external.empty' },
    { topic: 'external pending', exact: 'external.pending' },
    { topic: 'external pendingHint', exact: 'external.pendingHint' },
    { topic: 'external save', exact: 'external.save' },
    { topic: 'external saved', exact: 'external.saved' },
    { topic: 'external saveFailed', exact: 'external.saveFailed' },
    { topic: 'external loadFailed', exact: 'external.loadFailed' },
    { topic: 'external retry', exact: 'external.retry' },
    { topic: 'external toolCount', exact: 'external.toolCount' },
    { topic: 'external ownedBadge', exact: 'external.ownedBadge' },
    { topic: 'external disabledNote', exact: 'external.disabledNote' },
    { topic: 'external footHint', exact: 'external.footHint' },
    { topic: 'external noParams', exact: 'external.noParams' },
    { topic: 'external toolsEmpty', exact: 'external.toolsEmpty' },
    { topic: 'external server meta', exact: 'external.serverMeta' },
    { topic: 'external discovered at', exact: 'external.discoveredAt' },
    { topic: 'external back', exact: 'external.back' },
    { topic: 'external detail hint', exact: 'external.detailHint' },
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

check('the obsolete emoji-icon dictionary keys are gone', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  for (const key of ['field.iconHint', 'field.iconPlaceholder', 'field.iconClear']) {
    assert.equal(Object.hasOwn(zh, key), false, `the zh dictionary still carries ${key}`);
    assert.equal(Object.hasOwn(en, key), false, `the en dictionary still carries ${key}`);
  }
});

check('the client exposes the icon helpers, not an emoji glyph helper', () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  assert.ok(api !== undefined && api !== null, 'the module must expose __mcpTest for the offline suite');
  assert.equal(Object.hasOwn(api, 'iconGlyph'), false, 'iconGlyph must be gone');
  assert.equal(typeof api.letterOf, 'function');
  assert.equal(typeof api.iconLetter, 'function');
  assert.equal(typeof api.iconUrlOf, 'function');
  assert.deepEqual([...api.ICON_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], 'the client accepts the four raster types');
  assert.equal(api.MAX_ICON_BYTES, 524288);
  assert.equal(api.letterOf('  alpha  '), 'A');
  assert.equal(api.letterOf(''), '?');
  assert.equal(api.letterOf(undefined), '?');
  assert.equal(api.letterOf('中文名字'), '中');
  assert.equal(api.iconLetter({ name: 'beta' }), 'B');
  assert.equal(api.iconLetter(null), '?');
  assert.equal(api.iconLetter({}), '?');
  assert.equal(api.iconUrlOf({ iconUrl: '/better-mcp-manager/api/servers/srv_1/icon?v=auto' }), '/better-mcp-manager/api/servers/srv_1/icon?v=auto');
  assert.equal(api.iconUrlOf({}), '');
  assert.equal(api.iconUrlOf({ iconUrl: '' }), '');
  assert.equal(api.iconUrlOf(null), '');
  assert.equal(api.iconUrlOf({ iconUrl: 42 }), '');
});

check('the tools approval hint matches the restricted-permission wording', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  assert.equal(zh['tools.approvalHint'], '非完全权限时会要求你批准');
  assert.equal(en['tools.approvalHint'], 'Asks when the session is not in full access');
  assert.equal(zh['tools.count'].includes('{enabled}'), true, 'tools.count is a {enabled}/{total} template');
  assert.equal(zh['tools.count'].includes('{total}'), true);
});

check('the client exposes the 0.3.0 tool helpers and components', () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  assert.equal(typeof api.ToolsPanel, 'function', 'ToolsPanel must be exported for SSR-level checks');
  assert.equal(typeof api.ToolCard, 'function', 'ToolCard must be exported for SSR-level checks');
  assert.equal(typeof api.toolCounts, 'function');
  assert.equal(typeof api.normalizeToolList, 'function');
  assert.equal(typeof api.toolSettingsOf, 'function');
  assert.equal(typeof api.toolSettingsKey, 'function');

  const counts = api.toolCounts({ toolCount: 19, enabledToolCount: 17 });
  assert.equal(counts.enabled, 17);
  assert.equal(counts.total, 19);
  const fallback = api.toolCounts({ toolCount: 19 });
  assert.equal(fallback.enabled, 19, 'without enabledToolCount the enabled count falls back to the discovered count');
  assert.equal(fallback.total, 19);
  assert.equal(api.toolCounts({}).total, 0);
  assert.equal(api.toolCounts(undefined).enabled, 0);

  const normalized = api.normalizeToolList([
    { name: 'zeta', description: 'Z', enabled: false, params: [{ name: 'p', required: true }, { name: 'q' }, null] },
    null,
    { name: '' },
    { name: 'alpha', publicName: 'mcp__k__alpha', approval: true },
  ]);
  assert.equal(JSON.stringify(normalized), JSON.stringify([
    { name: 'alpha', publicName: 'mcp__k__alpha', description: '', params: [], enabled: true, approval: true },
    { name: 'zeta', publicName: 'zeta', description: 'Z', params: [{ name: 'p', required: true }, { name: 'q', required: false }], enabled: false, approval: false },
  ]), 'rows are normalized and sorted by raw name');
  assert.equal(JSON.stringify(api.normalizeToolList('nope')), '[]');

  const settings = api.toolSettingsOf(normalized);
  assert.equal(JSON.stringify(settings), JSON.stringify([
    { name: 'alpha', enabled: true, approval: true },
    { name: 'zeta', enabled: false, approval: false },
  ]), 'the PUT body is the full sorted settings list');
  assert.equal(api.toolSettingsKey(normalized), api.toolSettingsKey([...normalized].reverse()), 'the fingerprint is order-independent');
  assert.notEqual(api.toolSettingsKey(normalized), api.toolSettingsKey([{ ...normalized[0], enabled: false }, normalized[1]]), 'a toggle changes the fingerprint');
  assert.equal(JSON.stringify(api.toolSettingsKey([])), JSON.stringify('[]'));
});

check('the page tabs and external copy match the contract', () => {
  const loaded = bundleOrFail();
  const { zh, en } = loaded.log.locale[0].dictionary;
  assert.equal(zh['page.tabOwned'], '本插件 MCP');
  assert.equal(en['page.tabOwned'], 'Plugin MCP');
  assert.equal(zh['page.tabExternal'], '其他 MCP');
  assert.equal(en['page.tabExternal'], 'Other MCP');
  assert.equal(zh['page.tabsLabel'], 'MCP 分组');
  assert.equal(en['page.tabsLabel'], 'MCP groups');
  for (const key of ['external.scannedAt', 'external.saveFailed', 'external.loadFailed', 'external.toolCount']) {
    for (const dictionary of [zh, en]) assert.match(dictionary[key], /\{\w+\}/u, `${key} must carry a placeholder`);
  }
  assert.match(zh['external.intro'], /不能修改连接或凭据/u, 'the intro states that connections/credentials are out of scope');
  assert.match(zh['external.footHint'], /非完全权限/u);
  // 0.4.1 compact server cards + per-server detail view.
  for (const dictionary of [zh, en]) {
    assert.match(dictionary['external.serverMeta'], /\{enabled\}/u);
    assert.match(dictionary['external.serverMeta'], /\{total\}/u);
    assert.match(dictionary['external.discoveredAt'], /\{time\}/u);
    assert.equal(dictionary['external.back'].length > 0, true);
    assert.equal(dictionary['external.detailHint'].length > 0, true);
  }
  assert.match(zh['external.serverMeta'], /工具/u);
  assert.match(en['external.serverMeta'], /tools/u);
  assert.match(zh['external.detailHint'], /工具/u);
  assert.match(zh['external.detailHint'], /审批/u);
  assert.match(en['external.detailHint'], /tool/u);
  assert.match(en['external.detailHint'], /approval/u);
});

check('the client exposes the 0.4.0 external helpers and components', () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  assert.equal(typeof api.ExternalTab, 'function', 'ExternalTab must be exported');
  assert.equal(typeof api.ExternalView, 'function', 'ExternalView must be SSR-able');
  assert.equal(typeof api.ExternalToolCard, 'function');
  assert.equal(typeof api.ExternalServerCard, 'function', '0.4.1 exposes the compact server card');
  assert.equal(typeof api.ExternalServerView, 'function', '0.4.1 exposes the per-server tool view');
  assert.equal(typeof api.normalizeExternalPayload, 'function');
  assert.equal(typeof api.externalToolSettings, 'function');
  assert.equal(typeof api.externalToolSettingsKey, 'function');
  assert.equal(typeof api.externalBaselines, 'function');

  assert.deepEqual(
    JSON.parse(JSON.stringify(api.normalizeExternalPayload(undefined))),
    { scannedAt: null, presets: [] },
    'a missing payload normalizes to the empty state',
  );
  const normalized = JSON.parse(JSON.stringify(api.normalizeExternalPayload({
    scannedAt: '2026-11-17T09:00:00.000Z',
    extra: 'dropped',
    presets: [
      {
        id: 'standard',
        name: 'Standard',
        hasPresetMcp: true,
        servers: [
          {
            name: 'pan',
            discoveredAt: 42,
            tools: [
              { name: 'mcp__pan__zeta', description: 7, enabled: false, params: [{ name: 'q', required: 1 }, null] },
              null,
              { name: '' },
              { name: 'mcp__pan__alpha' },
            ],
          },
          { name: '', tools: [] },
        ],
      },
      { id: 'custom', servers: 'nope' },
      { id: '', servers: [] },
      null,
    ],
  })));
  assert.equal(normalized.scannedAt, '2026-11-17T09:00:00.000Z');
  assert.deepEqual(normalized.presets.map((preset) => preset.id), ['standard', 'custom'], 'invalid presets are dropped, valid ones keep payload order');
  assert.deepEqual(normalized.presets[1], { id: 'custom', name: 'custom', hasPresetMcp: false, servers: [] });
  assert.deepEqual(normalized.presets[0], {
    id: 'standard',
    name: 'Standard',
    hasPresetMcp: true,
    servers: [{
      name: 'pan',
      discoveredAt: null,
      tools: [
        { name: 'mcp__pan__alpha', description: '', params: [], enabled: true, approval: false },
        { name: 'mcp__pan__zeta', description: '', params: [{ name: 'q', required: false }], enabled: false, approval: false },
      ],
    }],
  }, 'servers and tools are sorted, damaged entries dropped, defaults applied');

  const settings = JSON.parse(JSON.stringify(api.externalToolSettings(normalized.presets[0])));
  assert.deepEqual(settings, [
    { name: 'mcp__pan__alpha', enabled: true, approval: false },
    { name: 'mcp__pan__zeta', enabled: false, approval: false },
  ], 'the PUT body is the flattened sorted full list');
  const standard = normalized.presets[0];
  const reversed = { ...standard, servers: [{ ...standard.servers[0], tools: [...standard.servers[0].tools].reverse() }] };
  assert.equal(api.externalToolSettingsKey(standard), api.externalToolSettingsKey(reversed), 'the fingerprint is order-independent');
  assert.notEqual(
    api.externalToolSettingsKey(standard),
    api.externalToolSettingsKey({ ...standard, servers: [{ ...standard.servers[0], tools: [{ ...standard.servers[0].tools[0], approval: true }, standard.servers[0].tools[1]] }] }),
    'a toggle changes the fingerprint',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.externalBaselines(normalized.presets))),
    { standard: api.externalToolSettingsKey(standard), custom: api.externalToolSettingsKey(normalized.presets[1]) },
    'baselines are keyed by preset id',
  );
});

check('save drafts never carry an icon or tool-settings field', () => {
  const loaded = bundleOrFail();
  const api = loaded.exports.__mcpTest;
  const body = api.bodyFromDraft(api.blankDraft());
  for (const field of ['icon', 'iconUrl', 'toolOverrides', 'toolCache']) {
    assert.equal(Object.hasOwn(body, field), false, `${field} is changed through its own endpoint, not a save draft`);
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
