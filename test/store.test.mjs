/**
 * Store unit tests: the one JSON file this plugin persists.
 *
 * Everything here runs in a throwaway directory under the OS temp dir; nothing
 * reads `$DSH_HOME` and no Host is involved.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDraft } from '../lib/model.js';
import { createStore, resolveDataDir, STORE_FILE, STORE_VERSION } from '../lib/store.js';

/** A disposable data directory removed when the test finishes. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One valid stored record (http transport). */
function draft(name = 'My MCP') {
  return normalizeDraft(
    { name, transport: 'http', url: 'http://127.0.0.1:3000/mcp' },
    { now: () => Date.parse('2026-11-16T10:00:00.000Z') },
  );
}

test('store: resolveDataDir keeps everything under $DSH_HOME/better-mcp-manager', () => {
  assert.equal(resolveDataDir({ DSH_HOME: '/srv/dsh' }), '/srv/dsh/better-mcp-manager');
  assert.equal(resolveDataDir({ DSH_HOME: '  /srv/dsh  ' }), '/srv/dsh/better-mcp-manager');
  assert.equal(resolveDataDir({ DSH_HOME: '/srv/dsh', HOME: '/home/someone' }), '/srv/dsh/better-mcp-manager');
  assert.equal(resolveDataDir({}), join(homedir(), '.dsh', 'better-mcp-manager'));
});

test('store: resolveDataDir honours an explicit directory override', () => {
  assert.equal(resolveDataDir({ DSH_MCP_MANAGER_DATA_DIR: '/var/tmp/isolation' }), '/var/tmp/isolation');
  assert.equal(resolveDataDir({ DSH_MCP_MANAGER_DATA_DIR: '   ' }), join(homedir(), '.dsh', 'better-mcp-manager'));
});

test('store: an empty directory loads as empty without writing', async (t) => {
  const dir = await tempDir(t);
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.deepEqual(summary, { loaded: 0, dropped: 0 });
  assert.equal(store.list().length, 0);
  assert.equal(existsSync(join(dir, STORE_FILE)), false, 'load must not create the store file');
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(warnings, []);
  await store.close();
});

test('store: create, update, delete round-trip survives a reload', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();

  const first = draft('Alpha');
  const second = draft('Beta');
  await store.put(first);
  await store.put(second);
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.get(first.id), first);
  assert.equal(store.get('srv_missing'), undefined);
  assert.equal(store.keyTaken(first.key), true);
  assert.equal(store.keyTaken('nope'), false);
  assert.equal(store.filePath(), join(dir, STORE_FILE));

  const renamed = { ...first, name: 'Alpha renamed', updatedAt: '2026-11-16T11:00:00.000Z' };
  await store.put(renamed);
  assert.equal(store.list().length, 2, 'putting an existing id replaces in place');
  assert.deepEqual(store.list().map((server) => server.name), ['Alpha renamed', 'Beta']);

  assert.equal(await store.remove(second.id), true);
  assert.equal(await store.remove(second.id), false, 'removing a missing record reports false');
  await store.close();

  const reopened = createStore({ dir });
  const summary = await reopened.load();
  assert.equal(summary.loaded, 1);
  assert.equal(summary.dropped, 0);
  assert.equal(summary.migrated, false, 'a current-version store needs no migration');
  assert.deepEqual(reopened.list(), [renamed]);
  await reopened.close();
});

test('store: list order is stable across updates and reloads', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const records = [draft('One'), draft('Two'), draft('Three')];
  for (const record of records) await store.put(record);
  await store.put({ ...records[1], name: 'Two updated' });
  assert.deepEqual(store.list().map((server) => server.name), ['One', 'Two updated', 'Three']);
  await store.close();

  const reopened = createStore({ dir });
  await reopened.load();
  assert.deepEqual(reopened.list().map((server) => server.id), [records[0].id, records[1].id, records[2].id]);
  await reopened.close();
});

test('store: the write is atomic, mode 0600, and leaves no temporary file', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  await store.put(draft('Atomic'));
  await store.close();

  assert.deepEqual(await readdir(dir), [STORE_FILE], 'no .tmp file may survive a write');
  const fileMode = (await stat(join(dir, STORE_FILE))).mode & 0o777;
  assert.equal(fileMode, 0o600, `store file mode must be 0600, got 0${fileMode.toString(8)}`);
  const dirMode = (await stat(dir)).mode & 0o777;
  assert.equal(dirMode, 0o700, `data directory mode must be 0700, got 0${dirMode.toString(8)}`);

  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(STORE_VERSION, 2, '0.2.0 stores icon objects, so the schema moved to version 2');
  assert.equal(raw.version, STORE_VERSION);
  assert.equal(raw.servers.length, 1);
  assert.equal(raw.servers[0].name, 'Atomic');
  assert.deepEqual(raw.servers[0].icon, { kind: 'auto' }, '0.2.0 writes the icon object even for a fresh record');
});

test('store: concurrent writes are serialized and all land', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const records = [draft('Concurrent A'), draft('Concurrent B'), draft('Concurrent C')];
  await Promise.all(records.map((record) => store.put(record)));
  await store.close();
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.deepEqual(raw.servers.map((server) => server.id), records.map((record) => record.id));
});

test('store: a 0.1.0 (version 1) store migrates every emoji icon to auto', async (t) => {
  const dir = await tempDir(t);
  const legacy = [draft('Legacy A'), draft('Legacy B')];
  for (const record of legacy) record.icon = '🔌';
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: 1, servers: legacy }), { mode: 0o600 });

  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.equal(summary.loaded, 2);
  assert.equal(summary.dropped, 0);
  assert.equal(summary.migrated, true, 'a version 1 file is migrated on load');
  assert.equal(summary.quarantined, undefined, 'a readable old version must not be quarantined');
  assert.deepEqual(store.list().map((server) => server.icon), [{ kind: 'auto' }, { kind: 'auto' }]);
  assert.deepEqual(store.list().map((server) => server.name), ['Legacy A', 'Legacy B']);
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('migrated') && message.includes('schema version 1')));

  // The in-memory migration is persisted by the next mutation; the file is
  // rewritten as version 2 with the icon object.
  await store.put({ ...store.get(legacy[0].id), name: 'Legacy A renamed' });
  await store.close();
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.version, STORE_VERSION);
  assert.deepEqual(raw.servers.map((server) => server.icon), [{ kind: 'auto' }, { kind: 'auto' }]);
});

test('store: invalid or missing icons in a version 2 store reset to auto', async (t) => {
  const dir = await tempDir(t);
  const withEmoji = { ...draft('Emoji'), icon: '🔌' };
  const missing = { ...draft('Missing') };
  delete missing.icon;
  const garbage = { ...draft('Garbage'), icon: { kind: 'upload', file: '../escape.png', mimeType: 'image/png', updatedAt: 'x' } };
  const upload = {
    ...draft('Upload'),
    icon: {
      kind: 'upload',
      file: 'srv_1f3c9a2b70.png',
      mimeType: 'image/png',
      updatedAt: '2026-11-16T10:00:00.000Z',
    },
  };
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: STORE_VERSION, servers: [withEmoji, missing, garbage, upload] }), { mode: 0o600 });

  const store = createStore({ dir });
  const summary = await store.load();
  assert.equal(summary.loaded, 4, 'a damaged icon must not drop the record itself');
  assert.equal(summary.migrated, false);
  assert.deepEqual(store.list().map((server) => server.icon), [
    { kind: 'auto' },
    { kind: 'auto' },
    { kind: 'auto' },
    { ...upload.icon },
  ]);
  await store.close();
});

test('store: an uploaded-icon object round-trips through the file', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const record = draft('Uploaded');
  record.icon = {
    kind: 'upload',
    file: 'srv_1f3c9a2b70.webp',
    mimeType: 'image/webp',
    updatedAt: '2026-11-16T10:00:00.000Z',
  };
  await store.put(record);
  await store.close();

  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.deepEqual(raw.servers[0].icon, record.icon);
  const reopened = createStore({ dir });
  await reopened.load();
  assert.deepEqual(reopened.get(record.id).icon, record.icon, 'the upload metadata survives a reload unchanged');
  await reopened.close();
});

test('store: a corrupt file is quarantined and the plugin starts empty', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, STORE_FILE);
  await writeFile(file, '{ this is not json', { mode: 0o600 });
  const warnings = [];
  const store = createStore({
    dir,
    logger: (level, message) => warnings.push([level, message]),
    now: () => Date.parse('2026-11-16T10:00:00.000Z'),
  });
  const summary = await store.load();
  assert.equal(summary.loaded, 0);
  assert.equal(typeof summary.quarantined, 'string', 'a corrupt file must be quarantined, not deleted');
  assert.equal(existsSync(summary.quarantined), true, 'the quarantine file must actually exist');
  assert.equal(existsSync(file), false, 'the corrupt store must be moved aside');
  assert.match(summary.quarantined, /servers\.json\.corrupt-/u);
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('not valid JSON')));
  assert.equal(store.list().length, 0);

  const record = draft('After corruption');
  await store.put(record);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.servers.length, 1);
  assert.equal(raw.servers[0].id, record.id);
  await store.close();
});

test('store: an unknown document shape or version is quarantined', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: 99, servers: [] }), { mode: 0o600 });
  const store = createStore({ dir });
  const summary = await store.load();
  assert.equal(summary.loaded, 0);
  assert.equal(typeof summary.quarantined, 'string');
  assert.equal(existsSync(summary.quarantined), true);
  await store.close();
});

test('store: one malformed record is dropped and the rest load', async (t) => {
  const dir = await tempDir(t);
  const good = draft('Good');
  const bad = { ...draft('Bad'), key: 'not a valid key!' };
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: STORE_VERSION, servers: [good, bad] }), { mode: 0o600 });
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.equal(summary.loaded, 1);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.quarantined, undefined, 'one bad record must not quarantine the whole file');
  assert.equal(store.get(good.id).name, 'Good');
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('dropped 1 malformed')));
  await store.close();
});

test('store: close waits for queued writes instead of losing them', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const record = draft('Queued');
  const pending = store.put(record);
  await store.close();
  await pending;
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.servers.length, 1);
  assert.equal(raw.servers[0].id, record.id);
});

test('store: a write failure is reported to the caller, not swallowed', async (t) => {
  const dir = await tempDir(t);
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'x');
  const store = createStore({ dir: join(blocker, 'inside') });
  await assert.rejects(() => store.load(), 'a data directory that cannot be created must fail loudly');
});
