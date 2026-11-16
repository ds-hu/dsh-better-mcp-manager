/**
 * Model unit tests: validation, identity, key allocation, tool naming and the
 * preset predicate from docs/API-CONTRACT.md §2.1–§2.5.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  allocateKey,
  applyToolSettings,
  AUTO_ICON,
  buildToolCache,
  createServerId,
  DEFAULT_TIMEOUT_MS,
  ICON_MIME_EXT,
  InputError,
  keyFromName,
  MAX_CACHED_DESCRIPTION,
  MAX_CACHED_PARAMS,
  MAX_CACHED_TOOLS,
  MAX_ICON_BYTES,
  MAX_ICON_JSON_BYTES,
  MAX_TOOL_OVERRIDES,
  normalizeDraft,
  normalizeStoredIcon,
  normalizeToolCache,
  normalizeToolOverrides,
  presetAllows,
  publicToolName,
  SERVER_COLORS,
  serverView,
  toolEnabled,
  toolNeedsApproval,
  toolParameters,
  TRANSPORTS,
  transportLabel,
} from '../lib/model.js';

const NOW = Date.parse('2026-11-16T10:00:00.000Z');

/** One valid stored upload-icon object. */
const UPLOAD_ICON = Object.freeze({
  kind: 'upload',
  file: 'srv_1f3c9a2b70.png',
  mimeType: 'image/png',
  updatedAt: '2026-11-16T10:00:00.000Z',
});

/** One minimal valid http draft, with overrides. */
function httpDraft(overrides = {}) {
  return { name: 'My MCP', transport: 'http', url: 'http://127.0.0.1:3000/mcp', ...overrides };
}

/**
 * Run `fn` and assert it throws an InputError with the given code/field.
 * @param {() => unknown} fn - The throwing call.
 * @param {string} code - Expected stable code.
 * @param {string} [field] - Expected field path.
 * @returns {InputError} the error, for message assertions.
 */
function expectInputError(fn, code, field) {
  let caught;
  assert.throws(fn, (error) => {
    caught = error;
    return error instanceof InputError;
  }, `expected InputError(${code})`);
  assert.equal(caught.code, code);
  if (field !== undefined) assert.equal(caught.field, field);
  return caught;
}

/* ---------------------------------------------------------------- */
/* ids, keys, tool names                                             */
/* ---------------------------------------------------------------- */

test('model: createServerId is srv_ plus ten lowercase hex characters', () => {
  for (let index = 0; index < 20; index += 1) {
    assert.match(createServerId(), /^srv_[0-9a-f]{10}$/u);
  }
  assert.notEqual(createServerId(), createServerId());
});

test('model: keyFromName slugifies the contract way', () => {
  assert.equal(keyFromName('My MCP'), 'my-mcp');
  assert.equal(keyFromName('  Hello!!  World  '), 'hello-world');
  assert.equal(keyFromName('a---b'), 'a-b');
  assert.equal(keyFromName('Café MCP'), 'cafe-mcp');
  assert.equal(keyFromName('A_B-c'), 'a_b-c');
  assert.equal(keyFromName('123'), '123');
  assert.equal(keyFromName('我的服务器'), '', 'a CJK name has no ASCII slug and falls back to an id-derived key');
  assert.equal(keyFromName('---'), '');
  assert.equal(keyFromName(''), '');
  assert.equal(keyFromName('x'.repeat(40)).length, 32, 'the slug is trimmed to 32 characters');
});

test('model: allocateKey uses the id suffix when the slug is empty', () => {
  const key = allocateKey('', 'abcdefghij', () => false);
  assert.equal(key, 'mcp-abcdefghij');
  const real = allocateKey('', '1f3c9a2b70', () => false);
  assert.equal(real, 'mcp-1f3c9a2b70');
});

test('model: allocateKey derives a deterministic, valid, unique key on collision', () => {
  const taken = new Set(['mylocal']);
  const first = allocateKey('mylocal', 'deadbeef00', (key) => taken.has(key));
  assert.match(first, /^mylocal-[0-9a-f]{4}$/u);
  assert.ok(first.length <= 32);
  assert.equal(first, allocateKey('mylocal', 'deadbeef00', (key) => taken.has(key)), 'same state must derive the same key');

  taken.add(first);
  const keys = new Set();
  for (let index = 0; index < 100; index += 1) {
    const key = allocateKey('my-mcp', 'deadbeef00', (candidate) => taken.has(candidate));
    assert.doesNotMatch(key, /[^A-Za-z0-9_-]/u, `invalid key ${key}`);
    assert.ok(key.length <= 32, `key too long: ${key}`);
    assert.equal(keys.has(key), false, `duplicate key ${key}`);
    keys.add(key);
    taken.add(key);
  }
  assert.ok(keys.size === 100);
});

test('model: publicToolName names the clean case mcp__<key>__<raw>', () => {
  assert.equal(publicToolName('mylocal', 'echo'), 'mcp__mylocal__echo');
  assert.equal(publicToolName('my-local', 'read_file'), 'mcp__my-local__read_file');
});

test('model: publicToolName appends a 12-hex identity hash when it normalizes', () => {
  const hash = createHash('sha256').update('mylocal\0foo.bar', 'utf8').digest('hex').slice(0, 12);
  const name = publicToolName('mylocal', 'foo.bar');
  assert.equal(name, `mcp__mylocal__foo_bar_${hash}`);
  assert.match(name, /^[A-Za-z0-9_-]{1,64}$/u);
  assert.equal(name, publicToolName('mylocal', 'foo.bar'), 'tool names must be deterministic');
});

test('model: publicToolName truncates to 64 characters with the hash suffix', () => {
  const raw = 'x'.repeat(100);
  const hash = createHash('sha256').update(`mylocal\0${raw}`, 'utf8').digest('hex').slice(0, 12);
  const name = publicToolName('mylocal', raw);
  assert.equal(name.length, 64);
  assert.equal(name, `mcp__mylocal__${'x'.repeat(37)}_${hash}`);
  assert.ok(name.endsWith(`_${hash}`));
  assert.match(name, /^[A-Za-z0-9_-]+$/u);

  const fits = 'x'.repeat(56);
  assert.equal(publicToolName('k', fits), `mcp__k__${fits}`, 'a clean 64-character name needs no hash');
  assert.equal(publicToolName('k', `${fits}x`).length, 64, 'one character over must truncate');
});

test('model: tool names never collapse two distinct MCP identities', () => {
  assert.notEqual(publicToolName('mylocal', 'a.b'), publicToolName('mylocal', 'a_b'));
  assert.notEqual(publicToolName('mylocal', '工具'), publicToolName('mylocal', '工具 '));
  assert.notEqual(publicToolName('one', 'tool'), publicToolName('two', 'tool'));
});

/* ---------------------------------------------------------------- */
/* drafts                                                            */
/* ---------------------------------------------------------------- */

test('model: a valid http draft is normalized with the documented defaults', () => {
  const record = normalizeDraft(httpDraft(), { now: () => NOW });
  assert.match(record.id, /^srv_[0-9a-f]{10}$/u);
  assert.equal(record.key, 'my-mcp');
  assert.equal(record.name, 'My MCP');
  assert.equal(record.enabled, true);
  assert.equal(record.transport, 'http');
  assert.equal(record.url, 'http://127.0.0.1:3000/mcp');
  assert.equal(record.command, '');
  assert.deepEqual(record.args, []);
  assert.deepEqual(record.env, {});
  assert.equal(record.cwd, '');
  assert.deepEqual(record.headers, []);
  assert.deepEqual(record.oauth, { mode: 'none' });
  assert.deepEqual(record.icon, { kind: 'auto' }, 'a new server always starts on the automatic icon');
  assert.equal(record.color, 'blue');
  assert.equal(record.group, '');
  assert.equal(record.presets, 'all');
  assert.equal(record.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(record.createdAt, '2026-11-16T10:00:00.000Z');
  assert.equal(record.updatedAt, '2026-11-16T10:00:00.000Z');
});

test('model: unknown fields are dropped and the name is trimmed', () => {
  const record = normalizeDraft(httpDraft({ name: '  Trimmed  ', status: { state: 'connected' }, extra: 1 }), { now: () => NOW });
  assert.equal(record.name, 'Trimmed');
  assert.equal('status' in record, false, 'derived status must never be stored');
  assert.equal('extra' in record, false, 'unknown fields are dropped');
});

test('model: name is required and bounded to 80 characters', () => {
  expectInputError(() => normalizeDraft({ transport: 'http', url: 'http://x/mcp' }), 'invalid-name', 'name');
  expectInputError(() => normalizeDraft(httpDraft({ name: '   ' })), 'invalid-name', 'name');
  expectInputError(() => normalizeDraft(httpDraft({ name: 'x'.repeat(81) })), 'invalid-name', 'name');
  assert.equal(normalizeDraft(httpDraft({ name: 'x'.repeat(80) })).name.length, 80);
});

test('model: a CJK name still allocates a valid, id-derived key', () => {
  const record = normalizeDraft(httpDraft({ name: '我的服务器' }), { now: () => NOW });
  assert.match(record.key, /^mcp-[0-9a-f]{10}$/u);
  assert.equal(record.key, `mcp-${record.id.slice(-10)}`);
});

test('model: the transport is a closed set and http/sse need an absolute http(s) url', () => {
  expectInputError(() => normalizeDraft(httpDraft({ transport: 'websocket' })), 'invalid-transport', 'transport');
  for (const url of ['not a url', '/relative/mcp', 'ftp://example.com/mcp', 'ws://example.com/mcp', 'file:///tmp/mcp']) {
    expectInputError(() => normalizeDraft(httpDraft({ url })), 'invalid-url', 'url');
  }
  assert.equal(normalizeDraft(httpDraft({ url: 'https://example.com/mcp' })).url, 'https://example.com/mcp');
  assert.equal(normalizeDraft(httpDraft({ transport: 'sse', url: 'http://localhost:3000/sse' })).transport, 'sse');
});

test('model: a stdio draft stores command/args/env/cwd and clears the http fields', () => {
  const record = normalizeDraft({
    name: 'Local Files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { TOKEN: 'secret', PATH_EXT: '/opt/bin' },
    cwd: '/tmp/work',
    url: 'http://ignored/mcp',
    headers: [{ name: 'X-ignored', value: '1' }],
    oauth: { mode: 'bearer', token: 'ignored' },
  }, { now: () => NOW });
  assert.equal(record.transport, 'stdio');
  assert.equal(record.command, 'npx');
  assert.deepEqual(record.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(record.env, { TOKEN: 'secret', PATH_EXT: '/opt/bin' });
  assert.equal(record.cwd, '/tmp/work');
  assert.equal(record.url, '');
  assert.deepEqual(record.headers, [], 'stdio servers have no custom headers');
  assert.deepEqual(record.oauth, { mode: 'none' });
});

test('model: stdio requires a command and validates args/env', () => {
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio' }), 'invalid-command', 'command');
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio', command: '  ' }), 'invalid-command', 'command');
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio', command: 'x', args: 'not-an-array' }), 'invalid-args', 'args');
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio', command: 'x', args: [1] }), 'invalid-args', 'args');
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio', command: 'x', env: { 'BAD NAME': 'v' } }), 'invalid-env', 'env');
  expectInputError(() => normalizeDraft({ name: 'Broken', transport: 'stdio', command: 'x', env: { OK: 1 } }), 'invalid-env', 'env');
});

test('model: headers are validated, ordered and unique case-insensitively', () => {
  const record = normalizeDraft(httpDraft({
    headers: [
      { name: 'Authorization', value: 'Bearer a' },
      { name: 'X-Trace', value: '  spaced  ' },
    ],
  }), { now: () => NOW });
  assert.deepEqual(record.headers, [
    { name: 'Authorization', value: 'Bearer a' },
    { name: 'X-Trace', value: 'spaced' },
  ]);
  expectInputError(() => normalizeDraft(httpDraft({ headers: [{ name: 'Bad Header', value: 'x' }] })), 'invalid-header-name', 'headers[0].name');
  expectInputError(() => normalizeDraft(httpDraft({ headers: [{ name: 'Bad:Name', value: 'x' }] })), 'invalid-header-name', 'headers[0].name');
  expectInputError(() => normalizeDraft(httpDraft({ headers: [{ name: 'X', value: 'a' }, { name: 'x', value: 'b' }] })), 'duplicate-header', 'headers[1].name');
  expectInputError(() => normalizeDraft(httpDraft({ headers: [{ name: 'X', value: 'a'.repeat(4097) }] })), 'invalid-header-value', 'headers[0].value');
  expectInputError(() => normalizeDraft(httpDraft({ headers: [{ name: 'X', value: 42 }] })), 'invalid-header-value', 'headers[0].value');
  expectInputError(() => normalizeDraft(httpDraft({ headers: 'nope' })), 'invalid-headers', 'headers');
  expectInputError(() => normalizeDraft(httpDraft({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: 'v' })) })), 'invalid-headers', 'headers');
  assert.equal(normalizeDraft(httpDraft({ headers: Array.from({ length: 20 }, (_, i) => ({ name: `X-${i}`, value: 'v' })) })).headers.length, 20);
});

test('model: preset selection accepts "all", arrays of known ids, and rejects unknown ids', () => {
  const roster = [{ id: 'standard' }, { id: 'custom' }];
  assert.equal(normalizeDraft(httpDraft(), { presets: roster }).presets, 'all');
  assert.equal(normalizeDraft(httpDraft({ presets: 'all' }), { presets: roster }).presets, 'all');
  assert.deepEqual(normalizeDraft(httpDraft({ presets: ['custom', 'standard', 'custom'] }), { presets: roster }).presets, ['custom', 'standard']);
  assert.deepEqual(normalizeDraft(httpDraft({ presets: [] }), { presets: roster }).presets, [], 'an empty selection is allowed');
  assert.deepEqual(
    normalizeDraft(httpDraft({ presets: ['anything'] }), { presets: [] }).presets,
    ['anything'],
    'when the roster service is absent, ids cannot be checked and are stored as-is',
  );
  const error = expectInputError(
    () => normalizeDraft(httpDraft({ presets: ['nope'] }), { presets: roster }),
    'unknown-preset',
    'presets',
  );
  assert.match(error.message, /standard/u, 'the rejection message must carry the roster');
  assert.match(error.message, /custom/u);
  expectInputError(() => normalizeDraft(httpDraft({ presets: 'standard' }), { presets: roster }), 'invalid-presets', 'presets');
  expectInputError(() => normalizeDraft(httpDraft({ presets: Array.from({ length: 41 }, (_, i) => ({ id: `p${i}` })) }), { presets: roster }), 'invalid-presets', 'presets');
  expectInputError(() => normalizeDraft(httpDraft({ presets: [1] }), { presets: roster }), 'invalid-presets', 'presets');
});

test('model: the icon schema is the 0.2.0 object, not an emoji string', () => {
  assert.deepEqual(AUTO_ICON, { kind: 'auto' });
  assert.equal(Object.isFrozen(AUTO_ICON), true);
  assert.deepEqual(ICON_MIME_EXT, {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  });
  assert.equal(Object.isFrozen(ICON_MIME_EXT), true);
  assert.equal(MAX_ICON_BYTES, 524288, '512 KiB decoded, per contract §2.6');
  assert.equal(MAX_ICON_JSON_BYTES, 1048576, '1 MiB data-URL envelope, per contract §3');
});

test('model: normalizeStoredIcon migrates legacy strings and rejects damaged uploads', () => {
  // 0.1.0 stored an emoji string; every legacy value becomes the automatic icon.
  for (const legacy of ['🔌', '', 'x', 42, null, undefined, [], true]) {
    assert.deepEqual(normalizeStoredIcon(legacy), { kind: 'auto' }, `${JSON.stringify(legacy)} must migrate to auto`);
  }
  assert.deepEqual(normalizeStoredIcon({ kind: 'auto' }), { kind: 'auto' });
  assert.deepEqual(normalizeStoredIcon({ kind: 'upload', ...UPLOAD_ICON }), { ...UPLOAD_ICON }, 'a valid upload icon round-trips');
  assert.notEqual(normalizeStoredIcon(UPLOAD_ICON), UPLOAD_ICON, 'the helper returns a detached object');
  assert.equal('extra' in normalizeStoredIcon({ ...UPLOAD_ICON, extra: 'x' }), false, 'unknown fields are dropped');

  // Anything that cannot be safely served from disk resets to auto.
  const damaged = [
    { kind: 'upload' },
    { ...UPLOAD_ICON, file: '../escape.png' },
    { ...UPLOAD_ICON, file: '/etc/passwd.png' },
    { ...UPLOAD_ICON, file: 'srv_1f3c9a2b70' },
    { ...UPLOAD_ICON, file: `${'x'.repeat(65)}.png` },
    { ...UPLOAD_ICON, mimeType: 'image/svg+xml' },
    { ...UPLOAD_ICON, mimeType: 'text/html' },
    { ...UPLOAD_ICON, mimeType: undefined },
    { ...UPLOAD_ICON, updatedAt: '' },
    { ...UPLOAD_ICON, updatedAt: 42 },
    { ...UPLOAD_ICON, kind: 'emoji', file: 'x.png' },
  ];
  for (const value of damaged) {
    assert.deepEqual(normalizeStoredIcon(value), { kind: 'auto' }, `${JSON.stringify(value)} must reset to auto`);
  }
});

test('model: a draft never sets the icon; an update preserves the stored one', () => {
  // Contract §2.1: the icon has its own endpoints, so drafts ignore any value.
  for (const raw of ['🔌', '', UPLOAD_ICON, { kind: 'auto' }, 42, null]) {
    assert.deepEqual(normalizeDraft(httpDraft({ icon: raw }), { now: () => NOW }).icon, { kind: 'auto' }, 'create always starts auto');
  }
  assert.equal('iconUrl' in normalizeDraft(httpDraft({ iconUrl: '/x' }), { now: () => NOW }), false, 'only the API adds iconUrl');

  const auto = normalizeDraft(httpDraft(), { now: () => NOW });
  assert.deepEqual(normalizeDraft(httpDraft({ name: 'Renamed', icon: '🔌' }), { existing: auto, now: () => NOW }).icon, { kind: 'auto' });

  const uploaded = normalizeDraft(httpDraft(), { now: () => NOW });
  uploaded.icon = { ...UPLOAD_ICON };
  for (const raw of ['🔌', { kind: 'auto' }, { kind: 'upload', ...UPLOAD_ICON, file: 'other.gif' }, undefined]) {
    const updated = normalizeDraft(httpDraft({ name: 'Renamed' }), { existing: uploaded, now: () => NOW });
    assert.deepEqual(updated.icon, { ...UPLOAD_ICON }, `update must keep the stored icon (draft icon ${JSON.stringify(raw)} ignored)`);
    assert.notEqual(updated.icon, uploaded.icon, 'the stored icon is copied, never shared');
  }
});

test('model: color, group and timeout follow the contract bounds', () => {
  for (const color of SERVER_COLORS) assert.equal(normalizeDraft(httpDraft({ color })).color, color);
  expectInputError(() => normalizeDraft(httpDraft({ color: 'purple' })), 'invalid-color', 'color');
  for (const transport of TRANSPORTS) {
    const draft = transport === 'stdio'
      ? { name: 'T', transport, command: 'x' }
      : { name: 'T', transport, url: 'http://localhost:1/mcp' };
    assert.equal(normalizeDraft(draft).transport, transport);
  }

  assert.equal(normalizeDraft(httpDraft({ group: '  工作  ' })).group, '工作');
  assert.equal(normalizeDraft(httpDraft({ group: '' })).group, '');
  expectInputError(() => normalizeDraft(httpDraft({ group: 'x'.repeat(61) })), 'invalid-group', 'group');

  assert.equal(normalizeDraft(httpDraft({ timeoutMs: 1000 })).timeoutMs, 1000);
  assert.equal(normalizeDraft(httpDraft({ timeoutMs: 600_000 })).timeoutMs, 600_000);
  for (const timeoutMs of [999, 600_001, 1500.5, '60000']) {
    expectInputError(() => normalizeDraft(httpDraft({ timeoutMs })), 'invalid-field', 'timeoutMs');
  }
  expectInputError(() => normalizeDraft(httpDraft({ enabled: 'true' })), 'invalid-field', 'enabled');
  assert.equal(normalizeDraft(httpDraft({ enabled: false })).enabled, false);
});

test('model: oauth modes are validated', () => {
  assert.deepEqual(normalizeDraft(httpDraft({ oauth: { mode: 'none' } })).oauth, { mode: 'none' });
  assert.deepEqual(
    normalizeDraft(httpDraft({ oauth: { mode: 'bearer', token: 'opaque' } })).oauth,
    { mode: 'bearer', token: 'opaque' },
  );
  assert.deepEqual(
    normalizeDraft(httpDraft({
      oauth: {
        mode: 'client_credentials',
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'client',
        clientSecret: 'secret',
        scope: 'mcp.read',
      },
    })).oauth,
    {
      mode: 'client_credentials',
      tokenUrl: 'https://idp.example.com/token',
      clientId: 'client',
      clientSecret: 'secret',
      scope: 'mcp.read',
    },
  );
  expectInputError(() => normalizeDraft(httpDraft({ oauth: { mode: 'bearer' } })), 'invalid-oauth', 'oauth.token');
  expectInputError(() => normalizeDraft(httpDraft({ oauth: { mode: 'client_credentials', clientId: 'c' } })), 'invalid-oauth', 'oauth.tokenUrl');
  expectInputError(
    () => normalizeDraft(httpDraft({ oauth: { mode: 'client_credentials', tokenUrl: 'https://idp/token' } })),
    'invalid-oauth',
    'oauth.clientId',
  );
  expectInputError(
    () => normalizeDraft(httpDraft({ oauth: { mode: 'client_credentials', tokenUrl: 'ftp://idp/token', clientId: 'c' } })),
    'invalid-url',
    'oauth.tokenUrl',
  );
  expectInputError(() => normalizeDraft(httpDraft({ oauth: { mode: 'magic' } })), 'invalid-oauth', 'oauth.mode');
});

test('model: update freezes id, key and createdAt, and refreshes updatedAt', () => {
  const created = normalizeDraft(httpDraft({ name: 'Original Name' }), { now: () => NOW });
  const updated = normalizeDraft(
    httpDraft({ name: 'Renamed Server', url: 'http://localhost:4000/mcp' }),
    { existing: created, now: () => NOW + 60_000 },
  );
  assert.equal(updated.id, created.id);
  assert.equal(updated.key, created.key, 'the tool namespace must be frozen on rename');
  assert.equal(updated.key, 'original-name');
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, '2026-11-16T10:01:00.000Z');
  assert.equal(updated.name, 'Renamed Server');
});

test('model: a duplicate name gets a suffixed key, never a duplicate key', () => {
  const keyTaken = (key) => key === 'my-mcp';
  const record = normalizeDraft(httpDraft(), { keyTaken, now: () => NOW });
  assert.match(record.key, /^my-mcp-[0-9a-f]{4}$/u);
  assert.notEqual(record.key, 'my-mcp');
});

test('model: duplicate display names are allowed', () => {
  assert.doesNotThrow(() => normalizeDraft(httpDraft({ name: 'Same' })));
  assert.doesNotThrow(() => normalizeDraft(httpDraft({ name: 'Same' })));
});

test('model: serverView is a detached panel-facing copy with a transport label', () => {
  const record = normalizeDraft(httpDraft({
    headers: [{ name: 'X-One', value: '1' }],
    oauth: { mode: 'bearer', token: 'secret' },
    presets: ['standard'],
  }), { presets: [{ id: 'standard' }], now: () => NOW });
  record.icon = { ...UPLOAD_ICON };
  const view = serverView(record);
  assert.equal(view.transportLabel, 'HTTP');
  assert.deepEqual(view.icon, { ...UPLOAD_ICON }, 'serverView reports the stored icon object');
  view.icon.file = 'mutated.png';
  assert.equal(record.icon.file, 'srv_1f3c9a2b70.png', 'the icon object is deep-copied');

  const autoRecord = normalizeDraft(httpDraft(), { now: () => NOW });
  const autoView = serverView(autoRecord);
  assert.deepEqual(autoView.icon, { kind: 'auto' });
  assert.notEqual(autoView.icon, AUTO_ICON, 'the automatic icon is copied too');
  assert.equal(view.id, record.id);
  assert.deepEqual(view.headers, [{ name: 'X-One', value: '1' }]);
  assert.equal('status' in view, false, 'status is derived and added by the API, not by serverView');

  view.name = 'mutated';
  view.headers[0].value = 'mutated';
  view.env.EXTRA = 'x';
  view.presets.push('another');
  assert.equal(record.name, 'My MCP');
  assert.equal(record.headers[0].value, '1');
  assert.equal('EXTRA' in record.env, false);
  assert.deepEqual(record.presets, ['standard']);

  assert.equal(transportLabel('sse'), 'SSE');
  assert.equal(transportLabel('stdio'), '内置');
  assert.equal(transportLabel('weird'), 'weird');
});

/* ---------------------------------------------------------------- */
/* preset exposure                                                   */
/* ---------------------------------------------------------------- */

test('model: presetAllows implements the contract exposure rule', () => {
  const server = { presets: 'all' };
  assert.equal(presetAllows(server, undefined), true, '"all" reaches agents with no preset');
  assert.equal(presetAllows(server, 'standard'), true);
  assert.equal(presetAllows({ presets: ['standard', 'custom'] }, 'standard'), true);
  assert.equal(presetAllows({ presets: ['standard'] }, 'custom'), false);
  assert.equal(presetAllows({ presets: ['standard'] }, undefined), false, 'an unselected agent only sees "all" servers');
  assert.equal(presetAllows({ presets: [] }, 'standard'), false);
  assert.equal(presetAllows({ presets: ['standard'] }, 'unknown-preset'), false);
  assert.equal(presetAllows({ presets: 'garbage' }, 'standard'), false, 'a corrupt record must not leak tools');
  assert.equal(presetAllows({ presets: 'garbage' }, undefined), false);
});

/* ---------------------------------------------------------------- */
/* 0.3.0 per-tool settings and offline cache                         */
/* ---------------------------------------------------------------- */

test('model: tool-settings constants and override normalization follow the contract', () => {
  assert.equal(MAX_TOOL_OVERRIDES, 500);
  assert.equal(MAX_CACHED_TOOLS, 300);
  assert.equal(MAX_CACHED_DESCRIPTION, 2000);
  assert.equal(MAX_CACHED_PARAMS, 64);

  assert.deepEqual(normalizeToolOverrides(undefined), {});
  assert.deepEqual(normalizeToolOverrides(null), {});
  assert.deepEqual(normalizeToolOverrides([]), {});
  assert.deepEqual(normalizeToolOverrides('nope'), {});
  assert.deepEqual(normalizeToolOverrides({ tool: {} }), {}, 'a default restatement is dropped');
  assert.deepEqual(normalizeToolOverrides({ tool: { enabled: true } }), {});
  assert.deepEqual(normalizeToolOverrides({ tool: { approval: false } }), {});
  assert.deepEqual(normalizeToolOverrides({ tool: { enabled: false } }), { tool: { enabled: false } });
  assert.deepEqual(normalizeToolOverrides({ tool: { approval: true } }), { tool: { approval: true } });
  assert.deepEqual(normalizeToolOverrides({ tool: { enabled: false, approval: true } }), { tool: { enabled: false, approval: true } });
  assert.deepEqual(normalizeToolOverrides({ tool: { enabled: false, approval: true, extra: 'x' } }), { tool: { enabled: false, approval: true } }, 'unknown fields are dropped');
  assert.deepEqual(normalizeToolOverrides({ 'bad name': { enabled: false }, ok: { enabled: false } }), { ok: { enabled: false } });
  assert.deepEqual(normalizeToolOverrides({ ['x'.repeat(129)]: { enabled: false } }), {}, 'names are at most 128 non-space chars');
  assert.deepEqual(normalizeToolOverrides({ tool: 'no' }), {});
  assert.deepEqual(normalizeToolOverrides({ tool: [] }), {});

  const many = {};
  for (let index = 0; index < MAX_TOOL_OVERRIDES + 5; index += 1) many[`tool_${index}`] = { enabled: false };
  assert.equal(Object.keys(normalizeToolOverrides(many)).length, MAX_TOOL_OVERRIDES, 'the map is capped at 500 entries');
});

test('model: toolEnabled and toolNeedsApproval read the stored overrides with safe defaults', () => {
  assert.equal(toolEnabled({}, 'echo'), true);
  assert.equal(toolEnabled({ toolOverrides: {} }, 'echo'), true);
  assert.equal(toolEnabled({ toolOverrides: { echo: { enabled: false } } }, 'echo'), false);
  assert.equal(toolEnabled({ toolOverrides: { echo: { approval: true } } }, 'echo'), true);
  assert.equal(toolEnabled(undefined, 'echo'), true, 'a missing record must not hide tools');
  assert.equal(toolNeedsApproval({}, 'echo'), false);
  assert.equal(toolNeedsApproval({ toolOverrides: { echo: { approval: true } } }, 'echo'), true);
  assert.equal(toolNeedsApproval({ toolOverrides: { echo: { enabled: false } } }, 'echo'), false);
  assert.equal(toolNeedsApproval({ toolOverrides: { other: { approval: true } } }, 'echo'), false);
});

test('model: applyToolSettings validates a batch and stores only non-default overrides', () => {
  const empty = { id: 'srv_1', toolOverrides: {} };
  assert.deepEqual(applyToolSettings(empty, [{ name: 'a', enabled: true, approval: false }]), {}, 'defaults are not stored');
  assert.deepEqual(applyToolSettings(empty, [{ name: 'a', enabled: false, approval: false }]), { a: { enabled: false } });
  assert.deepEqual(applyToolSettings(empty, [{ name: 'a', enabled: true, approval: true }]), { a: { approval: true } });
  assert.deepEqual(applyToolSettings(empty, [{ name: 'a', enabled: false, approval: true }]), { a: { enabled: false, approval: true } });
  assert.deepEqual(applyToolSettings(empty, [
    { name: 'b', enabled: false, approval: false },
    { name: 'a', enabled: true, approval: true },
  ]), { a: { approval: true }, b: { enabled: false } }, 'the result is order-independent');

  const existing = { id: 'srv_1', toolOverrides: { gone: { enabled: false }, kept: { approval: true } } };
  assert.deepEqual(applyToolSettings(existing, [{ name: 'kept', enabled: true, approval: true }]), { kept: { approval: true } }, 'unmentioned tools return to defaults');
  assert.deepEqual(applyToolSettings(existing, [{ name: 'gone', enabled: false, approval: true }]), { gone: { enabled: false, approval: true } }, 'previous flags merge into the batch row');

  const expectToolError = (fn, code) => {
    let caught;
    assert.throws(fn, (error) => {
      caught = error;
      return error instanceof InputError;
    }, `expected InputError(${code})`);
    assert.equal(caught.code, code);
    assert.equal(caught.field, 'tools');
  };
  expectToolError(() => applyToolSettings(empty, undefined), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, {}), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, Array.from({ length: MAX_TOOL_OVERRIDES + 1 }, (_, index) => ({ name: `t${index}`, enabled: true, approval: false }))), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, [null]), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, ['nope']), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, [{ name: 'bad name', enabled: true, approval: false }]), 'invalid-tool-name');
  expectToolError(() => applyToolSettings(empty, [{ name: '', enabled: true, approval: false }]), 'invalid-tool-name');
  expectToolError(() => applyToolSettings(empty, [{ name: 'a', enabled: true }, ]), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, [{ name: 'a', enabled: 'true', approval: false }]), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, [{ name: 'a', enabled: true, approval: 1 }]), 'invalid-tools');
  expectToolError(() => applyToolSettings(empty, [
    { name: 'a', enabled: true, approval: false },
    { name: 'a', enabled: false, approval: false },
  ]), 'invalid-tools');
});

test('model: toolParameters derives bounded parameter chips from an input schema', () => {
  assert.deepEqual(toolParameters(undefined), []);
  assert.deepEqual(toolParameters(null), []);
  assert.deepEqual(toolParameters({}), []);
  assert.deepEqual(toolParameters({ properties: [] }), []);
  assert.deepEqual(
    toolParameters({ properties: { b: {}, a: {} }, required: ['a', 'missing'] }),
    [{ name: 'b', required: false }, { name: 'a', required: true }],
    'property order is preserved and only string required names count',
  );
  const wide = { properties: Object.fromEntries(Array.from({ length: MAX_CACHED_PARAMS + 3 }, (_, index) => [`p${index}`, {}])) };
  assert.equal(toolParameters(wide).length, MAX_CACHED_PARAMS, 'parameter chips are capped at 64');
});

test('model: buildToolCache and normalizeToolCache agree on the cached descriptor shape', () => {
  const now = () => Date.parse('2026-11-16T21:00:00.000Z');
  const live = [
    { rawName: 'echo', publicName: 'mcp__k__echo', description: 'Echo', inputSchema: { properties: { text: {} }, required: ['text'] } },
    { rawName: 'bad name', publicName: 'x', description: 'skipped' },
    { rawName: 'brief', publicName: undefined, description: undefined, inputSchema: undefined },
  ];
  const cache = buildToolCache(live, now);
  assert.equal(cache.at, '2026-11-16T21:00:00.000Z');
  assert.deepEqual(cache.tools, [
    { name: 'echo', publicName: 'mcp__k__echo', description: 'Echo', params: [{ name: 'text', required: true }] },
    { name: 'brief', publicName: 'brief', description: '', params: [] },
  ], 'invalid live descriptors are skipped and missing fields get defaults');
  assert.deepEqual(normalizeToolCache(cache), cache, 'a built cache normalizes to itself');
  assert.deepEqual(normalizeToolCache(buildToolCache([], now)), { at: '2026-11-16T21:00:00.000Z', tools: [] });

  const long = { rawName: 'long', description: 'x'.repeat(MAX_CACHED_DESCRIPTION + 50) };
  assert.equal(buildToolCache([long], now).tools[0].description.length, MAX_CACHED_DESCRIPTION);
  const many = Array.from({ length: MAX_CACHED_TOOLS + 5 }, (_, index) => ({ rawName: `t${index}` }));
  assert.equal(buildToolCache(many, now).tools.length, MAX_CACHED_TOOLS, 'at most 300 cached tools');

  assert.equal(normalizeToolCache(null), null);
  assert.equal(normalizeToolCache('nope'), null);
  assert.equal(normalizeToolCache({ tools: [] }), null, 'a cache needs its timestamp');
  assert.equal(normalizeToolCache({ at: 42, tools: [] }), null);
  assert.equal(normalizeToolCache({ at: 'x' }), null);
  const normalized = normalizeToolCache({
    at: '2026-11-16T21:00:00.000Z',
    extra: 'dropped',
    tools: [
      { name: 'ok', publicName: 42, description: 'fine', params: [{ name: 'p', required: true }, { name: 'q' }, { name: 3, required: false }], extra: 'dropped' },
      { name: 'skip-no-description' },
      { name: 'bad name', description: '' },
      null,
    ],
  });
  assert.deepEqual(normalized, {
    at: '2026-11-16T21:00:00.000Z',
    tools: [{ name: 'ok', publicName: 'ok', description: 'fine', params: [{ name: 'p', required: true }] }],
  }, 'damaged cache entries are skipped, unknown fields dropped');
});

test('model: drafts ignore tool settings and the panel view never exposes them', () => {
  const existing = normalizeDraft(httpDraft(), { now: () => NOW });
  existing.toolOverrides = { echo: { enabled: false }, share: { approval: true } };
  existing.toolCache = { at: '2026-11-16T21:00:00.000Z', tools: [{ name: 'echo', publicName: 'mcp__k__echo', description: '', params: [] }] };

  const updated = normalizeDraft(httpDraft({ name: 'Renamed', toolOverrides: { forged: { enabled: false } }, toolCache: { at: 'forged', tools: [] } }), { existing, now: () => NOW });
  assert.deepEqual(updated.toolOverrides, { echo: { enabled: false }, share: { approval: true } }, 'stored settings are preserved and drafts cannot forge them');
  assert.deepEqual(updated.toolCache, existing.toolCache, 'the cached list is preserved');

  const created = normalizeDraft(httpDraft({ toolOverrides: { forged: { enabled: false } }, toolCache: { at: 'x', tools: [] } }), { now: () => NOW });
  assert.deepEqual(created.toolOverrides, {}, 'a new server starts with no overrides');
  assert.equal(created.toolCache, null, 'a new server starts with no cache');

  const view = serverView(updated);
  assert.equal('toolOverrides' in view, false, 'tool settings have their own endpoint');
  assert.equal('toolCache' in view, false);
});
