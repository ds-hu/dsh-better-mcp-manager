/**
 * Host lifecycle unit test (docs/API-CONTRACT.md §4).
 *
 * `apply(ctx)` is driven against a mock Cordis context with the data directory
 * pointed at a temp directory, so mounting the plugin here can never touch the
 * real `$DSH_HOME`. The assertions cover the wiring the Web page depends on:
 * the prefix route, the agent lifecycle listeners, and a dispose that leaves
 * nothing registered.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { API_PREFIX, PLUGIN_VERSION } from '../lib/version.js';

/** A mock ServerResponse capturing the JSON answer. */
function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
  };
}

/** A minimal IncomingMessage for a GET. */
function makeGet(path, headers = {}) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = `${API_PREFIX}${path}`;
  req.headers = { host: '127.0.0.1:3080', ...headers };
  return req;
}

/** One mock Cordis host context. */
function mockContext() {
  const effects = [];
  const events = new Map();
  const routes = [];
  const logs = [];
  const unregistered = [];
  const ctx = {
    logger: (level, message) => logs.push([level, message]),
    webServer: {
      register(route) {
        routes.push(route);
        return () => unregistered.push(route);
      },
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ dispose, label });
      return dispose;
    },
    on(event, listener) {
      events.set(event, listener);
      return () => events.delete(event);
    },
    inject(_deps, callback) {
      // Cordis hands the callback a context scoped to the injected services.
      const inner = {
        effect(fn, label) {
          const dispose = fn();
          effects.push({ dispose, label });
          return dispose;
        },
        get: (...args) => ctx.get(...args),
        on: (...args) => ctx.on(...args),
      };
      callback(inner);
      return () => {};
    },
    get() {
      return undefined;
    },
  };
  return { ctx, effects, events, routes, logs, unregistered };
}

test('index: mount registers the prefix route, agent listeners and disposal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = {
    DSH_MCP_MANAGER_DATA_DIR: process.env.DSH_MCP_MANAGER_DATA_DIR,
    DSH_HOME: process.env.DSH_HOME,
  };
  t.after(() => {
    if (previous.DSH_MCP_MANAGER_DATA_DIR === undefined) delete process.env.DSH_MCP_MANAGER_DATA_DIR;
    else process.env.DSH_MCP_MANAGER_DATA_DIR = previous.DSH_MCP_MANAGER_DATA_DIR;
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.DSH_HOME;
  });

  // apply() resolves the data directory from the process environment; force it
  // into the temp directory so this test can never touch a real DSH home.
  process.env.DSH_MCP_MANAGER_DATA_DIR = dir;
  const { apply, name, inject } = await import('../lib/index.js');
  assert.equal(name, 'dsh-better-mcp-manager');
  assert.deepEqual(inject, ['webServer']);

  const { ctx, effects, events, routes, unregistered } = mockContext();
  apply(ctx);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, API_PREFIX);
  assert.equal(typeof routes[0].handler, 'function');

  assert.deepEqual([...events.keys()].sort(), ['agent-preset/selected', 'agent/created', 'agent/disposed']);
  assert.ok(effects.length >= 2, 'the plugin must own its route and lifecycle through ctx.effect');

  // Let the mount-time store load and agent sweep settle, then exercise the
  // real route handler through the mock context.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const res = makeResponse();
  await routes[0].handler(makeGet('/health'), res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, PLUGIN_VERSION);
  assert.equal(payload.pid, process.pid);
  assert.match(res.headers['content-type'], /^application\/json/u);

  const listing = makeResponse();
  await routes[0].handler(makeGet('/servers'), listing);
  assert.equal(listing.status, 200);
  const list = JSON.parse(listing.body);
  assert.deepEqual(list.servers, []);
  assert.equal(list.dataDir, dir, 'the panel must report the effective data directory');
  assert.deepEqual(await readdir(dir), [], 'mounting with no servers writes nothing');

  // Dispatch one agent event: an unknown agent is ignored without throwing.
  assert.doesNotThrow(() => events.get('agent/created')({ agent: { id: 'sess-1', ctx: { get: () => ({ register: () => () => {} }) } } }));
  assert.doesNotThrow(() => events.get('agent/disposed')({ agent: { id: 'sess-1' } }));
  assert.doesNotThrow(() => events.get('agent-preset/selected')('sess-1'));

  // Dispose the way Cordis does: run every effect disposer in reverse order.
  for (const { dispose } of effects.slice().reverse()) {
    if (typeof dispose === 'function') await dispose();
  }
  assert.equal(unregistered.length, 1, 'the prefix route is unregistered on dispose');
  assert.deepEqual([...events.keys()], [], 'the agent listeners are removed on dispose');
});
