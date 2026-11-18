/**
 * API router unit tests.
 *
 * `createApi(...).handler(req, res)` is a plain `node:http` handler, so the
 * tests drive it with mock `IncomingMessage`/`ServerResponse` streams: no Host,
 * no listening socket, no network. Every assertion is on the real envelopes the
 * panel consumes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi } from '../lib/api.js';
import { InputError, MAX_ICON_BYTES } from '../lib/model.js';
import { createStore, PREFERENCES_FILE, PREFERENCES_VERSION } from '../lib/store.js';
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
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      this.ended = true;
      if (chunk !== undefined) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        this.chunks.push(buffer);
        this.body += buffer.toString('utf8');
      }
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
  };
}

/** One disposable API harness. */
async function harness(t, { roster, bare = false, connection, autoIcon, external, load = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-11-16T10:00:00Z') };
  const store = createStore({ dir, now: () => clock.value });
  if (load) await store.load();

  const state = { synced: 0, refreshes: 0, reconnects: [] };
  /** @type {Map<string, any>} */
  const connections = new Map();
  if (connection !== undefined) connections.set(connection.id, connection);
  const manager = {
    connections,
    status(id) {
      const live = connections.get(id);
      const snapshot = live === undefined
        ? undefined
        : (typeof live.snapshot === 'function' ? live.snapshot() : live.snapshot);
      return snapshot ?? {
        serverId: id,
        state: 'disabled',
        transportLabel: 'HTTP',
        toolCount: 0,
        enabledToolCount: 0,
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
    async icon(id) {
      return autoIcon === undefined ? null : autoIcon(id);
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
    external,
    hostCtx,
    version: PLUGIN_VERSION,
    dataDir: dir,
    now: () => clock.value,
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
    const bytes = Buffer.concat(res.chunks);
    const raw = bytes.toString('utf8');
    const contentType = String(res.headers?.['content-type'] ?? '');
    let parsed;
    if (contentType.startsWith('application/json')) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`response was not JSON: ${raw.slice(0, 200)} (${error.message})`, { cause: error });
      }
    }
    return { status: res.status, headers: res.headers, body: parsed, raw, bytes };
  }
  return { api, call, store, manager, exposure, state, dir, clock };
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

/** Minimal bytes that pass the contract's raster magic-number checks. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-payload', 'utf8')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-payload', 'utf8')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('webp-payload')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif-payload')]);

/** Encode bytes as the data URL the panel sends. */
function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
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
  const { call, store, dir } = await harness(t);
  // The probe loop waits with an unref'd timer; keep the test process alive so
  // the loop really runs (a Host always has more handles than one HTTP probe).
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));
  const result = await call({
    method: 'POST',
    path: '/servers/test',
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ url: 'http://127.0.0.1:1/mcp', icon: '🔌' })),
  });
  assert.equal(result.status, 200, 'a failed connection is still a successful test');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status.state, 'error', 'the unreachable probe must report the failure');
  assert.equal(result.body.status.serverId, undefined, 'the probe is not a real server');
  assert.equal(store.list().length, 0, 'testing a draft must not persist it');
  assert.equal(existsSync(join(dir, 'icons')), false, 'probing a draft must not write icon files');

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

/* ---------------------------------------------------------------- */
/* 0.2.0 server icons (contract §2.6/§3)                             */
/* ---------------------------------------------------------------- */

test('api: every server view carries an iconUrl with a version tag', async (t) => {
  const { call } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  const autoUrl = `${PREFIX}/servers/${id}/icon?v=auto`;
  assert.equal(created.body.server.iconUrl, autoUrl);
  assert.deepEqual(created.body.server.icon, { kind: 'auto' });

  const list = await call({ path: '/servers' });
  assert.equal(list.body.servers[0].iconUrl, autoUrl, 'the list view carries iconUrl too');
  const one = await call({ path: `/servers/${id}` });
  assert.equal(one.body.server.iconUrl, autoUrl);
  const updated = await call({
    method: 'PUT',
    path: `/servers/${id}`,
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ name: 'Renamed' })),
  });
  assert.equal(updated.body.server.iconUrl, autoUrl);
  const toggled = await call({
    method: 'POST',
    path: `/servers/${id}/enabled`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(toggled.body.server.iconUrl, autoUrl);
  const reconnected = await call({ method: 'POST', path: `/servers/${id}/reconnect`, headers: JSON_HEADERS });
  assert.equal(reconnected.body.server.iconUrl, autoUrl);
});

test('api: an uploaded icon is stored, served with an ETag and revalidated with 304', async (t) => {
  const { call, store, dir, clock } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;

  const upload = await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  assert.equal(upload.status, 200);
  const storedIcon = { kind: 'upload', file: `${id}.png`, mimeType: 'image/png', updatedAt: '2026-11-16T10:00:00.000Z' };
  assert.deepEqual(upload.body.server.icon, storedIcon);
  assert.equal(upload.body.server.iconUrl, `${PREFIX}/servers/${id}/icon?v=${encodeURIComponent(storedIcon.updatedAt)}`);
  assert.deepEqual(store.get(id).icon, storedIcon);

  const iconsDir = join(dir, 'icons');
  const iconFile = join(iconsDir, `${id}.png`);
  assert.deepEqual(await readFile(iconFile), PNG, 'the decoded bytes are stored verbatim');
  assert.equal((await stat(iconFile)).mode & 0o777, 0o600, 'icon files are private');
  assert.equal((await stat(iconsDir)).mode & 0o777, 0o700, 'the icon directory is private');

  const served = await call({ path: `/servers/${id}/icon` });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(String(served.headers['content-length']), String(PNG.length));
  assert.equal(served.headers['cache-control'], 'private, max-age=300');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  const expectedEtag = `"${createHash('sha1').update(PNG).update(storedIcon.updatedAt).digest('hex')}"`;
  assert.equal(served.headers.etag, expectedEtag, 'the ETag is sha1(bytes + icon version)');
  assert.deepEqual(served.bytes, PNG);

  const revalidated = await call({ path: `/servers/${id}/icon`, headers: { 'if-none-match': served.headers.etag } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.etag, served.headers.etag);
  assert.equal(revalidated.headers['content-type'], undefined);
  assert.equal(revalidated.bytes.length, 0, 'a 304 carries no body');

  // Replacing the icon changes extension, deletes the old file and changes the URL tag.
  clock.value += 1_000;
  const replaced = await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: dataUrl('image/jpeg', JPEG) }),
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.server.icon.file, `${id}.jpg`);
  assert.notEqual(replaced.body.server.iconUrl, upload.body.server.iconUrl, 'the cache-busting tag changes with the icon');
  assert.equal(existsSync(iconFile), false, 'the replaced icon file must be deleted');
  assert.deepEqual(await readdir(iconsDir), [`${id}.jpg`], 'one file per server');
  const servedJpeg = await call({ path: `/servers/${id}/icon` });
  assert.equal(servedJpeg.headers['content-type'], 'image/jpeg');
  assert.deepEqual(servedJpeg.bytes, JPEG);
  assert.notEqual(servedJpeg.headers.etag, served.headers.etag);
});

test('api: PNG, JPEG, WebP and GIF uploads are accepted and served with their own MIME type', async (t) => {
  const { call, dir } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  for (const [mimeType, bytes, ext] of [
    ['image/png', PNG, 'png'],
    ['image/jpeg', JPEG, 'jpg'],
    ['image/webp', WEBP, 'webp'],
    ['image/gif', GIF, 'gif'],
  ]) {
    const upload = await call({
      method: 'POST',
      path: `/servers/${id}/icon`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ dataUrl: dataUrl(mimeType, bytes) }),
    });
    assert.equal(upload.status, 200, `${mimeType} must be accepted`);
    assert.equal(upload.body.server.icon.file, `${id}.${ext}`);
    assert.deepEqual(await readdir(join(dir, 'icons')), [`${id}.${ext}`], 'only the newest icon file remains');
    const served = await call({ path: `/servers/${id}/icon` });
    assert.equal(served.headers['content-type'], mimeType);
    assert.deepEqual(served.bytes, bytes);
  }
});

test('api: automatic icons resolve through the manager and 404 when there is none', async (t) => {
  const { call } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  const missing = await call({ path: `/servers/${id}/icon` });
  assertError(missing, 404, 'no-icon');

  const withIcon = await harness(t, { autoIcon: async () => ({ bytes: PNG, mimeType: 'image/png' }) });
  const created2 = await withIcon.call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const id2 = created2.body.server.id;
  const served = await withIcon.call({ path: `/servers/${id2}/icon` });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['cache-control'], 'private, max-age=300');
  assert.equal(served.headers.etag, `"${createHash('sha1').update(PNG).update('auto').digest('hex')}"`, 'the auto ETag is sha1(bytes + "auto")');
  assert.deepEqual(served.bytes, PNG);
  assert.equal(created2.body.server.iconUrl, `${PREFIX}/servers/${id2}/icon?v=auto`);

  const unknown = await call({ path: '/servers/srv_missing/icon' });
  assertError(unknown, 404, 'not-found');
});

test('api: icon uploads enforce data-URL, MIME, magic-byte and size rules', async (t) => {
  const { call, store, dir } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  const iconDir = join(dir, 'icons');
  const post = (payload) => call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: payload }),
  });

  const svg = await post(dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
  assertError(svg, 400, 'invalid-icon');
  assert.equal(svg.body.field, 'icon');
  assertError(await post('data:image/png;base64,iVBORw0KGgo=='), 400, 'invalid-icon'); // non-canonical base64
  assertError(await post(dataUrl('image/png', Buffer.from('not a png at all'))), 400, 'invalid-icon');
  assertError(await post('data:image/png;base64,'), 400, 'invalid-icon');
  assertError(await post('data:text/plain;base64,aGVsbG8='), 400, 'invalid-icon');
  assertError(await post('http://example.com/icon.png'), 400, 'invalid-icon');
  assertError(await post(undefined), 400, 'invalid-icon');
  assert.equal(store.get(id).icon.kind, 'auto', 'a rejected upload never mutates the record');
  assert.deepEqual(await readdir(iconDir).catch(() => []), [], 'a rejected upload writes nothing');

  // 512 KiB decoded is the cap; the JSON body stays below the 1 MiB envelope cap.
  const oversizedBytes = Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]);
  const oversizedPayload = dataUrl('image/png', oversizedBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({ dataUrl: oversizedPayload })) < 1024 * 1024);
  assertError(await post(oversizedPayload), 400, 'invalid-icon');

  // A body above 1 MiB is refused by the HTTP layer before decoding.
  const hugeBody = await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: `{"dataUrl":"data:image/png;base64,${'A'.repeat(1024 * 1024 + 16)}"}`,
  });
  assertError(hugeBody, 413, 'body-too-large');

  // The icon endpoint accepts bodies above the normal 64 KiB JSON cap.
  const largeButValid = Buffer.concat([PNG, Buffer.alloc(100 * 1024, 1)]);
  const accepted = await post(dataUrl('image/png', largeButValid));
  assert.equal(accepted.status, 200, 'icon uploads may exceed the 64 KiB panel-body cap');
  assert.deepEqual(await readFile(join(iconDir, `${id}.png`)), largeButValid);

  const noJson = await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  assertError(noJson, 415, 'unsupported-media-type');
  const crossSite = await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  assertError(crossSite, 403, 'cross-origin');
  const wrongMethod = await call({ method: 'PATCH', path: `/servers/${id}/icon`, headers: JSON_HEADERS, body: '{}' });
  assertError(wrongMethod, 405, 'method-not-allowed');
  const unknownServer = await call({
    method: 'POST',
    path: '/servers/srv_missing/icon',
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  assertError(unknownServer, 404, 'not-found');
});

test('api: DELETE icon resets to auto, removes the file, and deleting a server reaps its icon', async (t) => {
  const { call, store, dir } = await harness(t);
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  const { id } = created.body.server;
  const iconFile = join(dir, 'icons', `${id}.png`);
  const upload = () => call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  await upload();
  assert.equal(existsSync(iconFile), true);

  const deleted = await call({ method: 'DELETE', path: `/servers/${id}/icon` });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.server.icon, { kind: 'auto' });
  assert.equal(deleted.body.server.iconUrl, `${PREFIX}/servers/${id}/icon?v=auto`);
  assert.equal(existsSync(iconFile), false, 'resetting removes the stored file');
  assert.equal(store.get(id).icon.kind, 'auto');

  const again = await call({ method: 'DELETE', path: `/servers/${id}/icon` });
  assert.equal(again.status, 200, 'resetting an automatic icon is idempotent');
  const missing = await call({ method: 'DELETE', path: '/servers/srv_missing/icon' });
  assertError(missing, 404, 'not-found');

  // Deleting the server itself reaps its icon file as well.
  await upload();
  assert.equal(existsSync(iconFile), true);
  const removedServer = await call({ method: 'DELETE', path: `/servers/${id}` });
  assert.equal(removedServer.status, 200);
  assert.equal(existsSync(iconFile), false, 'no icon may outlive its server');
});

test('api: save drafts ignore an icon field; uploads survive unrelated edits', async (t) => {
  const { call, store } = await harness(t);
  const created = await call({
    method: 'POST',
    path: '/servers',
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ icon: '🔌' })),
  });
  const { id } = created.body.server;
  assert.deepEqual(created.body.server.icon, { kind: 'auto' });

  const uploadShaped = {
    kind: 'upload',
    file: `${id}.png`,
    mimeType: 'image/png',
    updatedAt: '2026-11-16T10:00:00.000Z',
  };
  const second = await call({
    method: 'POST',
    path: '/servers',
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ name: 'Second', icon: uploadShaped })),
  });
  assert.deepEqual(second.body.server.icon, { kind: 'auto' }, 'a created record always starts auto');

  await call({
    method: 'POST',
    path: `/servers/${id}/icon`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ dataUrl: dataUrl('image/png', PNG) }),
  });
  const renamed = await call({
    method: 'PUT',
    path: `/servers/${id}`,
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ name: 'Renamed', icon: '🔌' })),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.server.icon.kind, 'upload', 'an edit must not reset the uploaded icon');
  assert.equal(store.get(id).icon.kind, 'upload');

  const reset = await call({
    method: 'PUT',
    path: `/servers/${id}`,
    headers: JSON_HEADERS,
    body: JSON.stringify(validDraft({ name: 'Renamed', icon: { kind: 'auto' } })),
  });
  assert.equal(reset.body.server.icon.kind, 'upload', 'the icon changes only through its own endpoint');
});

/* ---------------------------------------------------------------- */
/* 0.3.0 per-tool settings and tool cache (contract §2.7/§3)          */
/* ---------------------------------------------------------------- */

/** One live tool descriptor as the connection exposes it. */
function liveTool(rawName, overrides = {}) {
  return {
    rawName,
    publicName: `mcp__my-mcp__${rawName}`,
    description: `${rawName} description`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: undefined,
    taskRequired: false,
    ...overrides,
  };
}

/** One fake connected supervisor for the harness manager. */
function liveConnection(id, tools) {
  const snapshot = {
    serverId: id,
      state: 'connected',
      transportLabel: 'HTTP',
      toolCount: tools.length,
      enabledToolCount: tools.length,
      discoveredCount: tools.length,
      instructionsBytes: 20,
      error: null,
      attempts: 0,
      connectedAt: '2026-11-16T10:00:00.000Z',
      lastAttemptAt: '2026-11-16T10:00:00.000Z',
    nextRetryAt: null,
  };
  return {
    id,
    snapshot: () => snapshot,
    tools: () => tools,
  };
}

/** Create one server through the API and return its id. */
async function createServer(call) {
  const created = await call({ method: 'POST', path: '/servers', headers: JSON_HEADERS, body: JSON.stringify(validDraft()) });
  assert.equal(created.status, 201);
  return created.body.server.id;
}

test('api: GET /servers/:id/tools serves the live list, persists the cache and falls back when offline', async (t) => {
  const { call, store, manager, dir } = await harness(t);
  const id = await createServer(call);

  const empty = await call({ path: `/servers/${id}/tools` });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { ok: true, connected: false, cachedAt: null, tools: [] });

  const tools = [liveTool('alpha'), liveTool('beta', { description: 'Beta tool' })];
  manager.connections.set(id, liveConnection(id, tools));

  const live = await call({ path: `/servers/${id}/tools` });
  assert.equal(live.status, 200, `live tools failed: ${live.raw}`);
  assert.equal(live.body.ok, true);
  assert.equal(live.body.connected, true);
  assert.equal(live.body.cachedAt, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(live.body.tools, [
    { name: 'alpha', publicName: 'mcp__my-mcp__alpha', description: 'alpha description', params: [{ name: 'query', required: true }], enabled: true, approval: false },
    { name: 'beta', publicName: 'mcp__my-mcp__beta', description: 'Beta tool', params: [{ name: 'query', required: true }], enabled: true, approval: false },
  ]);
  assert.deepEqual(store.get(id).toolCache, {
    at: '2026-11-16T10:00:00.000Z',
    tools: [
      { name: 'alpha', publicName: 'mcp__my-mcp__alpha', description: 'alpha description', params: [{ name: 'query', required: true }] },
      { name: 'beta', publicName: 'mcp__my-mcp__beta', description: 'Beta tool', params: [{ name: 'query', required: true }] },
    ],
  }, 'reading the live list refreshes the offline cache');

  // Settings stored through the endpoint are reflected in both live and cached lists.
  const saved = await call({
    method: 'PUT',
    path: `/servers/${id}/tools`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ tools: [{ name: 'alpha', enabled: false, approval: false }, { name: 'beta', enabled: true, approval: true }] }),
  });
  assert.equal(saved.status, 200);
  const liveAfter = await call({ path: `/servers/${id}/tools` });
  assert.equal(liveAfter.body.tools[0].enabled, false);
  assert.equal(liveAfter.body.tools[1].approval, true);

  // Disconnect: the tools tab keeps working from the persisted cache.
  manager.connections.delete(id);
  const offline = await call({ path: `/servers/${id}/tools` });
  assert.equal(offline.body.connected, false);
  assert.equal(offline.body.cachedAt, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(offline.body.tools.map((tool) => [tool.name, tool.enabled, tool.approval]), [
    ['alpha', false, false],
    ['beta', true, true],
  ]);
  assert.deepEqual(offline.body.tools[0].params, [{ name: 'query', required: true }]);
  assert.deepEqual(await readdir(dir), ['servers.json'], 'the tool cache lives in the store file, not in side files');

  const missing = await call({ path: '/servers/srv_missing/tools' });
  assertError(missing, 404, 'not-found');
});

test('api: PUT /servers/:id/tools stores only non-default overrides and rebinds agents', async (t) => {
  const { call, store, state, clock, manager } = await harness(t);
  const id = await createServer(call);
  manager.connections.set(id, liveConnection(id, [liveTool('alpha'), liveTool('beta')]));
  await call({ path: `/servers/${id}/tools` }); // persist a cache first
  const cached = store.get(id).toolCache;
  const refreshesBefore = state.refreshes;

  clock.value += 5_000;
  const saved = await call({
    method: 'PUT',
    path: `/servers/${id}/tools`,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tools: [
        { name: 'alpha', enabled: false, approval: true, ignored: 'x' },
        { name: 'beta', enabled: true, approval: false },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.server.id, id);
  assert.equal('toolOverrides' in saved.body.server, false, 'the settings surface is the tools endpoint');
  assert.equal('toolCache' in saved.body.server, false);
  assert.equal(saved.body.server.updatedAt, '2026-11-16T10:00:05.000Z', 'a settings save bumps updatedAt');
  assert.ok(state.refreshes > refreshesBefore, 'live agents are rebound');
  assert.deepEqual(store.get(id).toolOverrides, { alpha: { enabled: false, approval: true } }, 'default restatements are not stored');
  assert.deepEqual(store.get(id).toolCache, cached, 'saving settings never drops the cached list');

  const reset = await call({
    method: 'PUT',
    path: `/servers/${id}/tools`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ tools: [{ name: 'alpha', enabled: true, approval: false }, { name: 'beta', enabled: true, approval: false }] }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(store.get(id).toolOverrides, {}, 'returning to defaults clears the overrides');
});

test('api: PUT /servers/:id/tools validates the batch and the request', async (t) => {
  const { call, store } = await harness(t);
  const id = await createServer(call);
  const put = (body) => call({ method: 'PUT', path: `/servers/${id}/tools`, headers: JSON_HEADERS, body: JSON.stringify(body) });
  const validRow = { name: 'alpha', enabled: true, approval: false };

  const emptyBatch = await put({ tools: [] });
  assert.equal(emptyBatch.status, 200);

  for (const body of [
    {},
    { tools: null },
    { tools: 'nope' },
    { tools: [null] },
    { tools: ['nope'] },
    { tools: [{ name: 'bad name', enabled: true, approval: false }] },
    { tools: [{ name: '', enabled: true, approval: false }] },
    { tools: [{ name: 'a', enabled: true }] },
    { tools: [{ name: 'a', enabled: 1, approval: false }] },
    { tools: [{ name: 'a', enabled: true, approval: 'true' }] },
    { tools: [validRow, { ...validRow }] },
    { tools: Array.from({ length: 501 }, (_, index) => ({ name: `t${index}`, enabled: true, approval: false })) },
  ]) {
    const result = await put(body);
    assert.equal(result.status, 400, `${JSON.stringify(body).slice(0, 80)} must be a 400: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.ok, false);
    assert.ok(['invalid-tools', 'invalid-tool-name'].includes(result.body.code), `unexpected code ${result.body.code}`);
    assert.equal(result.body.field, 'tools');
  }
  assert.deepEqual(store.get(id).toolOverrides, {}, 'rejected batches never change the settings');

  const malformedJson = await call({ method: 'PUT', path: `/servers/${id}/tools`, headers: JSON_HEADERS, body: '{ nope' });
  assertError(malformedJson, 400, 'invalid-json');
  const noJson = await call({ method: 'PUT', path: `/servers/${id}/tools`, body: JSON.stringify({ tools: [] }) });
  assertError(noJson, 415, 'unsupported-media-type');
  const crossSite = await call({
    method: 'PUT',
    path: `/servers/${id}/tools`,
    headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ tools: [] }),
  });
  assertError(crossSite, 403, 'cross-origin');
  const missing = await call({ method: 'PUT', path: '/servers/srv_missing/tools', headers: JSON_HEADERS, body: JSON.stringify({ tools: [] }) });
  assertError(missing, 404, 'not-found');
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const wrong = await call({ method, path: `/servers/${id}/tools`, headers: JSON_HEADERS, body: JSON.stringify({ tools: [] }) });
    assertError(wrong, 405, 'method-not-allowed');
  }
});

test('api: server views report enabledToolCount from the live status', async (t) => {
  const { call, manager } = await harness(t);
  const id = await createServer(call);
  const createdFallback = await call({ path: `/servers/${id}` });
  assert.equal(createdFallback.body.server.status.enabledToolCount, 0);

  const connection = liveConnection(id, [liveTool('alpha'), liveTool('beta')]);
  connection.snapshot().enabledToolCount = 1;
  manager.connections.set(id, connection);
  const list = await call({ path: '/servers' });
  assert.equal(list.body.servers[0].status.toolCount, 2);
  assert.equal(list.body.servers[0].status.enabledToolCount, 1);
});

/* ---------------------------------------------------------------- */
/* 0.4.0 preset-owned ("external") MCP routes                        */
/* ---------------------------------------------------------------- */

test('api: external MCP routes answer 500 when the controller is not mounted', async (t) => {
  const { call } = await harness(t);
  assertError(await call({ path: '/external' }), 500, 'unavailable');
  assertError(await call({ method: 'POST', path: '/external/scan' }), 500, 'unavailable');
  assertError(await call({
    method: 'PUT',
    path: '/external/tools',
    headers: JSON_HEADERS,
    body: JSON.stringify({ presetId: 'standard', tools: [] }),
  }), 500, 'unavailable');
});

test('api: GET/POST external endpoints scan and PUT saves one preset', async (t) => {
  const scans = [];
  const saves = [];
  const payload = {
    scannedAt: '2026-11-17T09:00:00.000Z',
    presets: [{ id: 'standard', name: 'Standard', hasPresetMcp: true, servers: [] }],
  };
  const external = {
    async scan() {
      scans.push(Date.now());
      return payload;
    },
    async saveTools(presetId, tools) {
      saves.push({ presetId, tools });
      if (presetId === 'bad') throw new InputError('invalid-preset', 'presetId is invalid', 'presetId');
      if (!Array.isArray(tools)) throw new InputError('invalid-tools', 'tools must be an array', 'tools');
      return payload;
    },
  };
  const { call } = await harness(t, { external });

  const get = await call({ path: '/external' });
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { ok: true, ...payload }, 'GET returns the scan payload');
  assert.equal(scans.length, 1, 'GET refreshes discovery first');

  const scan = await call({ method: 'POST', path: '/external/scan' });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body, { ok: true, ...payload });
  assert.equal(scans.length, 2);
  assertError(await call({ method: 'POST', path: '/external/scan', headers: { origin: 'https://evil.example' } }), 403, 'cross-origin');

  const body = { presetId: 'standard', tools: [{ name: 'mcp__pan__echo', enabled: false, approval: true }] };
  const saved = await call({ method: 'PUT', path: '/external/tools', headers: JSON_HEADERS, body: JSON.stringify(body) });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ok: true, ...payload });
  assert.deepEqual(saves.at(-1), body, 'the controller receives the preset and the full tool list');

  assertError(await call({ method: 'PUT', path: '/external/tools', headers: JSON_HEADERS, body: JSON.stringify({ presetId: 'bad', tools: [] }) }), 400, 'invalid-preset');
  const invalid = await call({ method: 'PUT', path: '/external/tools', headers: JSON_HEADERS, body: JSON.stringify({ presetId: 'standard', tools: null }) });
  assertError(invalid, 400, 'invalid-tools');
  assert.equal(invalid.body.field, 'tools');
  assertError(await call({ method: 'PUT', path: '/external/tools', headers: JSON_HEADERS, body: '[]' }), 400, 'invalid-body');
  assertError(await call({ method: 'PUT', path: '/external/tools', headers: JSON_HEADERS, body: '{ nope' }), 400, 'invalid-json');
  assertError(await call({ method: 'PUT', path: '/external/tools', body: JSON.stringify(body) }), 415, 'unsupported-media-type');
  for (const request of [
    { method: 'DELETE', path: '/external' },
    { method: 'GET', path: '/external/tools' },
    { method: 'PUT', path: '/external/scan', headers: JSON_HEADERS, body: JSON.stringify(body) },
  ]) {
    assertError(await call(request), 404, 'not-found');
  }
});

/* ---------------------------------------------------------------- */
/* 0.5.0 Host-owned UI preferences (the optional sidebar module)     */
/* ---------------------------------------------------------------- */

test('api: GET /preferences defaults to the sidebar module off', async (t) => {
  const { call, dir, store } = await harness(t);
  const result = await call({ path: '/preferences' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, preferences: { sidebarEntry: false } });
  assert.deepEqual(store.preferences(), { sidebarEntry: false });
  assert.equal(existsSync(join(dir, PREFERENCES_FILE)), false, 'a read must not create the file');
});

test('api: GET /preferences waits for the store load instead of answering the defaults', async (t) => {
  const { call, dir, store } = await harness(t, { load: false });
  await writeFile(join(dir, PREFERENCES_FILE), `${JSON.stringify({ version: PREFERENCES_VERSION, sidebarEntry: true }, null, 2)}\n`, { mode: 0o600 });
  assert.deepEqual(store.preferences(), { sidebarEntry: false }, 'the in-memory state is still the default before the load runs');

  const result = await call({ path: '/preferences' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, preferences: { sidebarEntry: true } }, 'an early GET must read the file, not the not-yet-loaded default');
  assert.deepEqual(store.preferences(), { sidebarEntry: true });
});

test('api: PUT /preferences persists the toggle before answering and GET reads it back', async (t) => {
  const { call, dir } = await harness(t);
  const enabled = await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: JSON.stringify({ sidebarEntry: true }) });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body, { ok: true, preferences: { sidebarEntry: true } });
  const file = join(dir, PREFERENCES_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'preferences are private');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: true }, 'the answer is written only after the file exists');

  const read = await call({ path: '/preferences' });
  assert.deepEqual(read.body, { ok: true, preferences: { sidebarEntry: true } });

  const off = await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: JSON.stringify({ sidebarEntry: false }) });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.preferences, { sidebarEntry: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: false });
  assert.deepEqual((await readdir(dir)).sort(), ['preferences.json'].sort(), 'a preference save writes no other file');
});

test('api: PUT /preferences ignores unknown keys and rejects invalid bodies', async (t) => {
  const { call, dir, store } = await harness(t);
  const extra = await call({
    method: 'PUT',
    path: '/preferences',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sidebarEntry: true, theme: 'dark', keep: [1, 2, 3] }),
  });
  assert.equal(extra.status, 200);
  assert.deepEqual(extra.body.preferences, { sidebarEntry: true });
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, PREFERENCES_FILE), 'utf8')),
    { version: PREFERENCES_VERSION, sidebarEntry: true },
    'unknown keys are ignored, not persisted',
  );

  for (const body of [{}, { sidebarEntry: 'yes' }, { sidebarEntry: 1 }, { sidebarEntry: null }, { sidebarEntry: undefined }]) {
    const result = await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: JSON.stringify(body) });
    assertError(result, 400, 'invalid-preferences');
  }
  assert.deepEqual(store.preferences(), { sidebarEntry: true }, 'rejected bodies change nothing');

  assertError(await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: '[]' }), 400, 'invalid-body');
  assertError(await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: 'null' }), 400, 'invalid-body');
  assertError(await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: '{ nope' }), 400, 'invalid-json');
  assert.deepEqual(store.preferences(), { sidebarEntry: true });
});

test('api: PUT /preferences is same-origin only and refuses other methods', async (t) => {
  const { call, store } = await harness(t);
  const body = JSON.stringify({ sidebarEntry: true });
  assertError(
    await call({ method: 'PUT', path: '/preferences', headers: { ...JSON_HEADERS, origin: 'https://evil.example' }, body }),
    403,
    'cross-origin',
  );
  assert.deepEqual(store.preferences(), { sidebarEntry: false }, 'a cross-origin PUT changes nothing');

  const sameOrigin = await call({ method: 'PUT', path: '/preferences', headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:3080' }, body });
  assert.equal(sameOrigin.status, 200);
  assert.deepEqual(sameOrigin.body.preferences, { sidebarEntry: true });

  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assertError(await call({ method, path: '/preferences', headers: JSON_HEADERS, body }), 405, 'method-not-allowed');
  }
  assertError(await call({ method: 'PUT', path: '/preferences', body }), 415, 'unsupported-media-type');
});

test('api: a preference save never rewrites servers.json or its schema', async (t) => {
  const { call, dir } = await harness(t);
  const id = await createServer(call);
  const saved = await call({ method: 'PUT', path: '/preferences', headers: JSON_HEADERS, body: JSON.stringify({ sidebarEntry: true }) });
  assert.equal(saved.status, 200);

  const raw = JSON.parse(await readFile(join(dir, 'servers.json'), 'utf8'));
  assert.equal(raw.version, 3, '0.5.0 adds a file, it does not bump the servers schema');
  assert.deepEqual(raw.servers.map((server) => server.id), [id], 'the server list is untouched');
  assert.deepEqual((await readdir(dir)).sort(), [PREFERENCES_FILE, 'servers.json'].sort());
});
