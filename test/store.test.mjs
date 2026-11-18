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
import { createStore, PREFERENCES_FILE, PREFERENCES_VERSION, resolveDataDir, STORE_FILE, STORE_VERSION } from '../lib/store.js';

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
  assert.equal(STORE_VERSION, 3, '0.3.0 adds per-tool settings and the tool cache, so the schema moved to version 3');
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
  assert.deepEqual(store.list().map((server) => server.toolOverrides), [{}, {}], 'a migrated record gets empty tool settings');
  assert.deepEqual(store.list().map((server) => server.toolCache), [null, null], 'a migrated record gets no tool cache');
  assert.deepEqual(store.list().map((server) => server.name), ['Legacy A', 'Legacy B']);
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('migrated') && message.includes('schema version 1')));

  // The in-memory migration is persisted by the next mutation; the file is
  // rewritten as version 2 with the icon object.
  await store.put({ ...store.get(legacy[0].id), name: 'Legacy A renamed' });
  await store.close();
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.version, STORE_VERSION);
  assert.deepEqual(raw.servers.map((server) => server.icon), [{ kind: 'auto' }, { kind: 'auto' }]);
  assert.deepEqual(raw.servers.map((server) => server.toolOverrides), [{}, {}]);
  assert.equal(raw.version, 3);
});

test('store: a 0.2 store (version 2) migrates its icon object and gains tool defaults', async (t) => {
  const dir = await tempDir(t);
  const record = draft('Zero two');
  record.icon = { kind: 'upload', file: 'srv_1f3c9a2b70.png', mimeType: 'image/png', updatedAt: '2026-11-16T10:00:00.000Z' };
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: 2, servers: [record] }), { mode: 0o600 });

  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.equal(summary.loaded, 1);
  assert.equal(summary.migrated, true);
  assert.deepEqual(store.get(record.id).icon, record.icon, 'the 0.2 upload icon is preserved');
  assert.deepEqual(store.get(record.id).toolOverrides, {});
  assert.equal(store.get(record.id).toolCache, null);
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('schema version 2')));
  await store.close();
});

test('store: invalid tool settings in a version 3 store are normalized per record', async (t) => {
  const dir = await tempDir(t);
  const bad = { ...draft('Bad tools'), toolOverrides: 'nope', toolCache: { at: 1, tools: [] } };
  const forged = { ...draft('Forged'), toolOverrides: { echo: { enabled: true }, share: { approval: true } }, toolCache: null };
  const good = {
    ...draft('Good tools'),
    toolOverrides: { echo: { enabled: false } },
    toolCache: { at: '2026-11-16T21:00:00.000Z', tools: [{ name: 'echo', publicName: 'mcp__k__echo', description: '', params: [] }] },
  };
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: STORE_VERSION, servers: [bad, forged, good] }), { mode: 0o600 });

  const store = createStore({ dir });
  const summary = await store.load();
  assert.equal(summary.loaded, 3, 'damaged tool fields never drop the record');
  assert.equal(summary.migrated, false);
  assert.deepEqual(store.get(bad.id).toolOverrides, {});
  assert.equal(store.get(bad.id).toolCache, null);
  assert.deepEqual(store.get(forged.id).toolOverrides, { share: { approval: true } }, 'default restatements are normalized away');
  assert.deepEqual(store.get(good.id).toolOverrides, { echo: { enabled: false } });
  assert.deepEqual(store.get(good.id).toolCache, good.toolCache);
  await store.close();
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

test('store: patch is a serialized read-modify-write that reports what happened', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const first = draft('Patch A');
  const second = draft('Patch B');
  await store.put(first);
  await store.put(second);

  assert.equal(await store.patch(first.id, (latest) => ({ ...latest, name: 'Patched' })), true);
  assert.equal(store.get(first.id).name, 'Patched');
  assert.equal(store.get(second.id).name, 'Patch B', 'other records are untouched');

  assert.equal(await store.patch('srv_missing', (latest) => latest), false, 'an unknown id reports false');
  assert.equal(await store.patch(first.id, () => undefined), false, 'an updater that declines reports false');
  assert.equal(store.get(first.id).name, 'Patched', 'a declined patch changes nothing');

  // Concurrent patches must not clobber each other: each updater sees the
  // previous patch's result because the read-modify-write runs in queue order.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.patch(second.id, (latest) => ({ ...latest, mark: (latest.mark ?? 0) + 1 }))),
  );
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(store.get(second.id).mark, 5, 'every concurrent patch was applied');
  await store.close();

  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.servers.find((server) => server.id === second.id).mark, 5, 'the accumulated result was persisted');
  assert.equal(raw.servers.find((server) => server.id === first.id).name, 'Patched');
  const reopened = createStore({ dir });
  await reopened.load();
  assert.equal(reopened.get(second.id).mark, 5);
  await reopened.close();
});

/* ---------------------------------------------------------------- */
/* 0.5.0 UI preferences (the optional sidebar module toggle)          */
/* ---------------------------------------------------------------- */

test('store: preferences default to off and a load writes no file', async (t) => {
  const dir = await tempDir(t);
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.deepEqual(summary, { loaded: 0, dropped: 0 }, 'the server report shape is unchanged');
  assert.deepEqual(store.preferences(), { sidebarEntry: false });
  assert.equal(store.preferencesPath(), join(dir, PREFERENCES_FILE));
  assert.equal(existsSync(join(dir, PREFERENCES_FILE)), false, 'load must not create preferences.json');
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(warnings, []);
  await store.close();
});

test('store: setPreferences persists mode 0600 preferences.json and round-trips', async (t) => {
  const dir = await tempDir(t);
  const preferencesFile = join(dir, PREFERENCES_FILE);
  const store = createStore({ dir });
  await store.load();

  assert.deepEqual(await store.setPreferences({ sidebarEntry: true }), { sidebarEntry: true });
  assert.deepEqual(store.preferences(), { sidebarEntry: true });
  assert.deepEqual(await readdir(dir), [PREFERENCES_FILE], 'no temporary file may survive the write');
  assert.equal((await stat(preferencesFile)).mode & 0o777, 0o600, 'preferences are private');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: true });
  await store.close();

  const reopened = createStore({ dir });
  const summary = await reopened.load();
  assert.deepEqual(summary, { loaded: 0, dropped: 0 });
  assert.deepEqual(reopened.preferences(), { sidebarEntry: true }, 'the toggle survives a reload');
  assert.deepEqual(await reopened.setPreferences({ sidebarEntry: false }), { sidebarEntry: false });
  await reopened.close();

  const again = createStore({ dir });
  await again.load();
  assert.deepEqual(again.preferences(), { sidebarEntry: false });
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: false });
  await again.close();
});

test('store: a preferences-only directory loads without changing the server report', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, PREFERENCES_FILE), JSON.stringify({ version: PREFERENCES_VERSION, sidebarEntry: true }), { mode: 0o600 });
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = await store.load();
  assert.deepEqual(summary, { loaded: 0, dropped: 0 }, 'a missing servers.json still reports the backward-compatible shape');
  assert.deepEqual(store.preferences(), { sidebarEntry: true });
  assert.deepEqual(warnings, [], 'a missing servers.json with valid preferences is not a warning');
  assert.deepEqual(await readdir(dir), [PREFERENCES_FILE], 'a read must never create servers.json');
  await store.close();
});

test('store: damaged preferences are ignored with a warning and replaced by the next write', async (t) => {
  const cases = [
    { text: '{ this is not json', reason: /not valid JSON/u },
    { text: JSON.stringify({ version: PREFERENCES_VERSION, sidebarEntry: 'yes' }), reason: /unknown shape or version/u },
    { text: JSON.stringify({ version: 99, sidebarEntry: true }), reason: /unknown shape or version/u },
    { text: JSON.stringify(['sidebarEntry']), reason: /unknown shape or version/u },
  ];
  for (const { text, reason } of cases) {
    const dir = await tempDir(t);
    const preferencesFile = join(dir, PREFERENCES_FILE);
    await writeFile(preferencesFile, text, { mode: 0o600 });
    const warnings = [];
    const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
    await store.load();
    assert.deepEqual(store.preferences(), { sidebarEntry: false }, `damaged preferences must reset to the defaults: ${text}`);
    assert.ok(
      warnings.some(([level, message]) => level === 'warn' && message.includes(PREFERENCES_FILE) && reason.test(message)),
      `the damage must be logged, got ${JSON.stringify(warnings)}`,
    );
    assert.equal(existsSync(preferencesFile), true, 'a damaged preferences file is never quarantined');
    assert.deepEqual(await readdir(dir), [PREFERENCES_FILE], 'resetting creates no side file');
    assert.deepEqual(await store.setPreferences({ sidebarEntry: true }), { sidebarEntry: true });
    assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: true }, 'the next write replaces the damaged file');
    await store.close();
  }
});

test('store: preference and server writes share one queue, and close() awaits both', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const record = draft('Queued with preferences');
  const writes = Promise.all([store.put(record), store.setPreferences({ sidebarEntry: true })]);
  await Promise.resolve();
  await store.close();
  await writes;
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.version, STORE_VERSION);
  assert.equal(raw.servers.length, 1);
  assert.equal(raw.servers[0].id, record.id);
  assert.deepEqual(JSON.parse(await readFile(join(dir, PREFERENCES_FILE), 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: true });
  assert.deepEqual((await readdir(dir)).sort(), [PREFERENCES_FILE, STORE_FILE].sort(), 'no temporary file remains');
});

test('store: the servers schema stays version 3 when preferences are written', async (t) => {
  const dir = await tempDir(t);
  const store = createStore({ dir });
  await store.load();
  const record = draft('Schema check');
  await store.put(record);
  await store.setPreferences({ sidebarEntry: true });
  await store.close();
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(STORE_VERSION, 3, '0.5.0 adds a second file, not a new servers schema');
  assert.equal(raw.version, STORE_VERSION);
  assert.deepEqual(raw.servers.map((server) => server.id), [record.id], 'the server list is written exactly as before');
  assert.deepEqual(JSON.parse(await readFile(join(dir, PREFERENCES_FILE), 'utf8')), { version: PREFERENCES_VERSION, sidebarEntry: true });
});
