/**
 * API router unit tests.
 *
 * `createApi(...).handler(req, res)` is a plain `node:http` handler, so the
 * tests drive it with mock `IncomingMessage`/`ServerResponse` streams: no Host,
 * no listening socket, no network. Every assertion is on the real envelopes the
 * panel consumes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/store.js';
import { PLUGIN_VERSION } from '../lib/version.js';

const PREFIX = '/better-mcp-manager/api';

/** A mock IncomingMessage carrying an optional body. */
function makeRequest({ method = 'GET', path = '/servers', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = `${PREFIX}${path}`;
  req.headers = { host: '127.0.0.1:3080', ...headers };
  return req;
}

/** A mock ServerResponse capturing status, headers and body. */
function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      this.ended = true;
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
  };
}

/** One disposable API harness. */
async function harness(t, { roster, bare = false, connection } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ dir, now: () => Date.parse('2026-11-16T10:00:00Z') });
  await store.load();

  const state = { synced: 0, refreshes: 0, reconnects: [] };
  /** @type {Map<string, any>} */
  const connections = new Map();
  if (connection !== undefined) connections.set(connection.id, connection);
  const manager = {
    connections,
    status(id) {
      const live = connections.get(id);
      return live?.snapshot ?? {
        serverId: id,
        state: 'disabled',
        transportLabel: 'HTTP',
        toolCount: 0,
        discoveredCount: 0,
        instructionsBytes: 0,
        error: null,
        attempts: 0,
        connectedAt: null,
        lastAttemptAt: null,
        nextRetryAt: null,
      };
    },
    get(id) {
      return connections.get(id);
    },
    async sync() {
      state.synced += 1;
    },
    async reconnect(id) {
      state.reconnects.push(id);
    },
    async callTool() {
      return { content: [] };
    },
  };
  const exposure = {
    agents: [],
    list() {
      return this.agents;
    },
    refreshSoon() {
      state.refreshes += 1;
    },
  };
  const hostCtx = {
    get(name) {
      if (name !== 'agentPresets') return undefined;
      if (bare) return undefined;
      return {
        async list() {
          return roster ?? [
            { id: 'standard', name: 'Standard', order: 2 },
            { id: 'custom', name: '', description: 'Custom preset', order: 1 },
            { id: '' },
          ];
        },
      };
    },
  };
  const api = createApi({
    store,
    manager,
    exposure,
    hostCtx,
    version: PLUGIN_VERSION,
    dataDir: dir,
    now: () => Date.parse('2026-11-16T10:00:00Z'),
  });

  /**
   * Send one request through the real handler.
   * @returns {Promise<{ status: number, headers: any, body: any, raw: string }>} the answer.
   */
  async function call({ method = 'GET', path = '/servers', headers = {}, body } = {}) {
    const req = makeRequest({ method, path, headers, body });
    const res = makeResponse();
    await api.handler(req, res);
    assert.equal(res.ended, true, 'the handler must end every response');
    assert.ok(res.status !== undefined, 'the handler must set a status');
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (error) {
      throw new Error(`response was not JSON: ${res.body.slice(0, 200)} (${error.message})`, { cause: error });
    }
    return { status: res.status, headers: res.headers, body: parsed, raw: res.body };
  }
  return { api, call, store, manager, exposure, state, dir };
}

/** Assert the JSON error envelope shape and its status. */
function assertError(result, status, code) {
  assert.equal(result.status, status, `expected HTTP ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, code);
  assert.equal(typeof result.body.error, 'string');
  assert.ok(result.body.error.length > 0, 'the error envelope needs human text');
  assert.match(result.headers['content-type'], /^application\/json/u);
}

/** One valid http draft body. */
const validDraft = (overrides = {}) => ({
  name: 'My MCP',
  transport: 'http',
  url: 'http://127.0.0.1:3000/mcp',
  ...overrides,
});

const JSON_HEADERS = { 'content-type': 'application/json' };

test('api: GET /health answers the version, pid and uptime', async (t) => {
  const { call } = await harness(t);
  const result = await call({ path: '/health' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.version, PLUGIN_VERSION);
  assert.equal(result.body.pid, process.pid);
  assert.equal(typeof result.body.uptimeMs, 'number');
  assert.match(result.headers['content-type'], /^application\/json/u);
});

test('api: GET /servers reports servers, the preset roster, groups and the data dir', async (t) => {
  const { call } = await harness(t);
  const result = await call({ path: '/servers' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    servers: [],
    presets: [
      { id: 'custom', name: 'custom', description: 'Custom preset', order: 1 },
      { id: 'standard', name: 'Standard', description: '', order: 2 },
    ],
    groups: [],
    version: PLUGIN_VERSION,
    dataDir: result.body.dataDir,
  });
  assert.match(result.body.dataDir, /mcp-manager-api-/u);
});

test('api: GET /servers works without an agent-preset service', async (t) => {
  const { call } = await harness(t, { bare: true });
  const result = await call({ path: '/servers' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.presets, []);
});

test('api: POST /servers creates a record and answers 201 with its status', async (t) => {
  const { call, store, state } = await harness(t);
  const result = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  assert.equal(result.status, 201);
  assert.equal(result.body.ok, true);
  assert.match(result.body.server.id, /^srv_[0-9a-f]{10}$/u);
  assert.equal(result.body.server.key, 'my-mcp');
  assert.equal(result.body.server.name, 'My MCP');
  assert.equal(result.body.server.status.state, 'disabled');
  assert.equal(store.list().length, 1);
  assert.ok(state.synced >= 1, 'a create must converge the connection manager');
  assert.ok(state.refreshes >= 1, 'a create must refresh per-preset exposure');

  const duplicate = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  assert.equal(duplicate.status, 201, 'display names are not unique');
  assert.notEqual(duplicate.body.server.key, result.body.server.key, 'tool namespaces are unique');
});

test('api: mutations require a JSON content type', async (t) => {
  const { call, store } = await harness(t);
  const result = await call({ method: 'POST', path: '/servers', body: JSON.stringify(validDraft()) });
  assertError(result, 415, 'unsupported-media-type');
  assert.equal(store.list().length, 0);

  const wrongType = await call({
    method: 'POST',
    path: '/servers',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(validDraft()),
  });
  assertError(wrongType, 415, 'unsupported-media-type');
});

test('api: cross-origin mutations are rejected and same-origin ones are accepted', async (t) => {
  const { call } = await harness(t);
  const draft = JSON.stringify(validDraft());

  const crossSite = await call({
    method: 'POST',
    path: '/servers',
    headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
    body: draft,
  });
  assertError(crossSite, 403, 'cross-origin');

  const invalidOrigin = await call({
    method: 'POST',
    path: '/servers',
    headers: { ...JSON_HEADERS, origin: 'not a URL' },
    body: draft,
  });
  assertError(invalidOrigin, 403, 'cross-origin');

  const sameOrigin = await call({
    method: 'POST',
    path: '/servers',
    headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:3080' },
    body: draft,
  });
  assert.equal(sameOrigin.status, 201);

  const noOrigin = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: draft });
  assert.equal(noOrigin.status, 201);
});

test('api: invalid JSON and invalid drafts answer 400 with the field code', async (t) => {
  const { call } = await harness(t);
  const invalidJson = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: '{ nope' });
  assertError(invalidJson, 400, 'invalid-json');

  const badName = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify({ transport: 'http', url: 'http://x/mcp' }) });
  assertError(badName, 400, 'invalid-name');
  assert.equal(badName.body.field, 'name', 'the panel highlights the offending field');

  const badUrl = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft({ url: 'ftp://x/mcp' })) });
  assertError(badUrl, 400, 'invalid-url');

  const arrayBody = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: '[]' });
  assertError(arrayBody, 400, 'invalid-body');
});

test('api: a body larger than 64 KiB is rejected', async (t) => {
  const { call, store } = await harness(t);
  const huge = JSON.stringify(validDraft({ group: 'x'.repeat(70 * 1024) }));
  assert.ok(Buffer.byteLength(huge) > 64 * 1024);
  const result = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: huge });
  assertError(result, 413, 'body-too-large');
  assert.equal(store.list().length, 0);
});

test('api: GET /servers/:id returns the record, its status and its live tools', async (t) => {
  const connection = {
    id: 'srv_live',
    snapshot: { serverId: 'srv_live', state: 'connected', transportLabel: 'HTTP', toolCount: 2, discoveredCount: 2, instructionsBytes: 11, error: null, attempts: 0, connectedAt: '2026-11-16T10:00:00.000Z', lastAttemptAt: '2026-11-16T10:00:00.000Z', nextRetryAt: null },
    tools: () => [
      { rawName: 'echo', publicName: 'mcp__live__echo', description: 'Echo text' },
      { rawName: 'sum', publicName: 'mcp__live__sum', description: '' },
    ],
  };
  const { call, manager } = await harness(t, { connection });
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const id = created.body.server.id;
  manager.connections.delete('srv_live');
  manager.connections.set(id, { ...connection, id });

  const result = await call({ path: `/servers/${id}` });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.server.id, id);
  assert.equal(result.body.server.status.state, 'connected');
  assert.deepEqual(result.body.server.tools, [
    { name: 'echo', publicName: 'mcp__live__echo', description: 'Echo text' },
    { name: 'sum', publicName: 'mcp__live__sum', description: '' },
  ]);

  const missing = await call({ path: '/servers/srv_missing' });
  assertError(missing, 404, 'not-found');
});

test('api: PUT /servers/:id updates in place and keeps the frozen key', async (t) => {
  const { call } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft({ name: 'Original' })) });
  const { id, key } = created.body.server;

  const updated = await call({
    method: 'PUT',
    path: `/servers/${id}`,
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ name: 'Renamed', url: 'http://localhost:4000/mcp' })),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.server.id, id);
  assert.equal(updated.body.server.key, key, 'the tool namespace is frozen across renames');
  assert.equal(updated.body.server.name, 'Renamed');
  assert.equal(updated.body.server.url, 'http://localhost:4000/mcp');

  const missing = await call({ method: 'PUT', path: '/servers/srv_missing', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  assertError(missing, 404, 'not-found');

  const crossSite = await call({
    method: 'PUT',
    path: `/servers/${id}`,
    headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify(validDraft()),
  });
  assertError(crossSite, 403, 'cross-origin');

  const wrongMethod = await call({ method: 'PATCH', path: `/servers/${id}`, headers: JSON_HEADERS, body: '{}' });
  assertError(wrongMethod, 405, 'method-not-allowed');
});

test('api: DELETE /servers/:id removes the record and answers {deleted:true}', async (t) => {
  const { call, store, state } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;

  const deleted = await call({ method: 'DELETE', path: `/servers/${id}` });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, deleted: true });
  assert.equal(store.list().length, 0);
  assert.ok(state.synced >= 2, 'a delete must converge the manager');

  const again = await call({ method: 'DELETE', path: `/servers/${id}` });
  assertError(again, 404, 'not-found');

  const crossSite = await call({ method: 'DELETE', path: '/servers/whatever', headers: { origin: 'https://evil.example' } });
  assertError(crossSite, 404, 'not-found');
});

test('api: POST /servers/:id/enabled toggles the flag and refuses non-booleans', async (t) => {
  const { call, store } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;

  const disabled = await call({
    method: 'POST',
    path: `/servers/${id}/enabled`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.ok, true);
  assert.equal(disabled.body.server.enabled, false);
  assert.equal(store.get(id).enabled, false);

  const invalid = await call({ method: 'POST', path: `/servers/${id}/enabled`, headers: JSON_HEADERS, body: JSON.stringify({ enabled: 'yes' }) });
  assertError(invalid, 400, 'invalid-enabled');

  const missing = await call({ method: 'POST', path: '/servers/srv_missing/enabled', headers: JSON_HEADERS, body: JSON.stringify({ enabled: false }) });
  assertError(missing, 404, 'not-found');

  const wrongMethod = await call({ path: `/servers/${id}/enabled` });
  assertError(wrongMethod, 405, 'method-not-allowed');
});

test('api: POST /servers/:id/reconnect starts a fresh attempt', async (t) => {
  const { call, state } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  const result = await call({ method: 'POST', path: `/servers/${id}/reconnect`, headers: JSON_HEADERS });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.server.id, id);
  assert.deepEqual(state.reconnects, [id]);
});

test('api: POST /servers/test probes an unsaved draft and never stores it', async (t) => {
  const { call, store } = await harness(t);
  // The probe loop waits with an unref'd timer; keep the test process alive so
  // the loop really runs (a Host always has more handles than one HTTP probe).
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));
  const result = await call({
    method: 'POST',
    path: '/servers/test',
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ url: 'http://127.0.0.1:1/mcp' })),
  });
  assert.equal(result.status, 200, 'a failed connection is still a successful test');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status.state, 'error', 'the unreachable probe must report the failure');
  assert.equal(result.body.status.serverId, undefined, 'the probe is not a real server');
  assert.equal(store.list().length, 0, 'testing a draft must not persist it');

  const invalid = await call({ method: 'POST', path: '/servers/test', headers: JSON_HEADERS, body: JSON.stringify({ transport: 'http' }) });
  assertError(invalid, 400, 'invalid-name');
});

test('api: GET /presets and GET /agents expose the read surfaces', async (t) => {
  const { call, exposure } = await harness(t);
  exposure.agents = [{ sessionId: 'sess-1', preset: 'standard', servers: ['my-mcp'], tools: ['mcp__my-mcp__echo'] }];

  const presets = await call({ path: '/presets' });
  assert.equal(presets.status, 200);
  assert.deepEqual(presets.body.presets.map((preset) => preset.id), ['custom', 'standard']);

  const agents = await call({ path: '/agents' });
  assert.equal(agents.status, 200);
  assert.deepEqual(agents.body.agents, exposure.agents);
});

test('api: grouped servers report their group names once, in list order', async (t) => {
  const { call } = await harness(t);
  for (const [name, group] of [['A', 'Work'], ['B', 'Home'], ['C', 'Work'], ['D', '']]) {
    const result = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft({ name, group })) });
    assert.equal(result.status, 201);
  }
  const list = await call({ path: '/servers' });
  assert.deepEqual(list.body.groups, ['Work', 'Home']);
});

test('api: an unexpected failure answers a 500 server-error envelope', async (t) => {
  const { call, store } = await harness(t);
  store.list = () => {
    throw new Error('disk on fire');
  };
  const result = await call({ path: '/servers' });
  assertError(result, 500, 'server-error');
  assert.match(result.body.error, /disk on fire/u);
});

test('api: unknown paths answer a 404 JSON envelope', async (t) => {
  const { call } = await harness(t);
  const result = await call({ path: '/nope' });
  assertError(result, 404, 'not-found');
  const root = await call({ path: '/' });
  assertError(root, 404, 'not-found');
});

test('api: trailing slashes are normalized', async (t) => {
  const { call } = await harness(t);
  const result = await call({ path: '/servers/' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});
