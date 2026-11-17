/**
 * Unit tests for `lib/external.js` — preset-owned ("other") MCP management.
 *
 * The Host pieces this module talks to (agents registry, agent presets, the
 * per-agent tools service, permission presets and the event bus) are all faked
 * here: the controller is driven entirely through its public exports, so no
 * Host, no network and no real Agent is involved. Every file write goes to a
 * `mkdtemp` directory.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InputError } from '../lib/model.js';
import {
  createExternal,
  externalServerName,
  isExternalToolName,
  MAX_EXTERNAL_DESCRIPTION,
  MAX_EXTERNAL_OVERRIDES,
  MAX_EXTERNAL_PARAMS,
  MAX_EXTERNAL_PRESETS,
  MAX_EXTERNAL_SERVERS,
  MAX_EXTERNAL_TOOLS,
  normalizeExternalOverrides,
  normalizeExternalState,
  normalizeExternalTools,
  EXTERNAL_STORE_FILE,
  EXTERNAL_STORE_VERSION,
} from '../lib/external.js';

const NOW = Date.parse('2026-11-17T09:00:00.000Z');
const ISO = new Date(NOW).toISOString();

/** One fake inherited tool descriptor for a view. */
function definition(description = '', parameters = undefined) {
  return { description, parameters };
}

/**
 * Build a fake Host context, fake agents and the controller.
 * @param {object} [options] - Harness options.
 * @returns {object} harness handles.
 */
function harness({ dir, ownNames = [], presetsRows = [], compositions = [], logger = () => {}, restrictionAware = false } = {}) {
  const listeners = new Map();
  const agents = [];
  const restrictCalls = [];
  const restrictionDisposals = [];
  const permission = new Map();
  const hostCtx = {
    get(name) {
      if (name === 'agents') return { list: () => agents };
      if (name === 'agentPresets') {
        return {
          async list() {
            return presetsRows;
          },
          composedPreset: (agentCtx) => agentCtx?.__preset,
          inspectCompositions: () => compositions,
        };
      }
      if (name === 'permissionPresets') {
        return { current: (session) => permission.get(session?.id) ?? 'standard' };
      }
      return undefined;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };
  const exposure = { ownToolNames: () => new Set(ownNames) };
  const external = createExternal({ hostCtx, dir, exposure, logger, now: () => NOW });

  /**
   * Register one fake live Agent with an independent tools view.
   * @param {string} id - Session id.
   * @param {object} [options] - Agent options.
   * @returns {object} agent handle with mutable view.
   */
  function addAgent(id, { preset, restrictable = [], visible = new Map() } = {}) {
    const state = { restrictable: [...restrictable], visible, baseVisible: visible, denies: [], tools: true };
    const toolsService = {
      view: () => {
        const current = restrictionAware
          ? new Map([...state.baseVisible].filter(([name]) => !state.denies.some((deny) => deny.has(name))))
          : state.visible;
        return { restrictableNames: new Set(state.restrictable), visible: current };
      },
      restrict: ({ deny }) => {
        const set = new Set(deny);
        restrictCalls.push({ sessionId: id, deny: [...deny] });
        if (restrictionAware) state.denies.push(set);
        return () => {
          restrictionDisposals.push({ sessionId: id, deny: [...deny] });
          if (restrictionAware) {
            const index = state.denies.indexOf(set);
            if (index >= 0) state.denies.splice(index, 1);
          }
        };
      },
    };
    const agent = {
      id,
      session: { id },
      ctx: {
        __preset: preset,
        get: (name) => (name === 'tools' && state.tools ? toolsService : undefined),
      },
      state,
    };
    agents.push(agent);
    return agent;
  }

  /** Fire one Host event. */
  function emit(event, payload) {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  }

  return { external, hostCtx, listeners, agents, addAgent, emit, restrictCalls, restrictionDisposals, permission, exposure };
}

/** Wait for debounced scans to settle. */
function flush(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a condition holds (keeps debounce tests deterministic under load). */
async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await flush(10);
  }
  throw new Error('timed out waiting for the expected external state');
}

/** Await a rejected promise and assert it is InputError(code, field). */
async function expectInputError(fn, code, field) {
  let caught;
  await assert.rejects(fn, (error) => {
    caught = error;
    return error instanceof InputError;
  }, `expected InputError(${code})`);
  assert.equal(caught.code, code);
  if (field !== undefined) assert.equal(caught.field, field);
}

/** Recursively collect every object key in one JSON value. */
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Names, normalization and caps                                    */
/* ---------------------------------------------------------------- */

test('external: tool-name helpers follow the public mcp__ namespace', () => {
  assert.equal(isExternalToolName('mcp__pan__echo'), true);
  assert.equal(isExternalToolName('mcp__a'), true, 'a bare namespace is syntactically valid');
  assert.equal(isExternalToolName(`mcp__${'a'.repeat(59)}`), true);
  assert.equal(isExternalToolName(`mcp__${'a'.repeat(60)}`), false, 'the whole name is capped at 59 chars after mcp__');
  assert.equal(isExternalToolName('mcp__pan__echo.1'), false);
  assert.equal(isExternalToolName('MCP__pan__echo'), false);
  assert.equal(isExternalToolName(' mcp__pan__echo'), false);
  assert.equal(isExternalToolName('mcp__pan__echo '), false);
  assert.equal(isExternalToolName(''), false);
  assert.equal(isExternalToolName(42), false);

  assert.equal(externalServerName('mcp__pan__echo'), 'pan');
  assert.equal(externalServerName('mcp__pan_with_under__echo'), 'pan_with_under');
  assert.equal(externalServerName('mcp__a__b__c'), 'a', 'the first __ terminates the server namespace');
  assert.equal(externalServerName('mcp__pan'), undefined, 'no separator means no server');
  assert.equal(externalServerName('mcp__pan__'), undefined, 'an empty wire name is not addressable');
  assert.equal(externalServerName('mcp____echo'), undefined, 'an empty server name is not addressable');
  assert.equal(externalServerName(`mcp__${'a'.repeat(33)}__echo`), undefined, 'server names are at most 32 chars');
  assert.equal(externalServerName('mcp__pan__e cho'), undefined);
  assert.equal(externalServerName('read_file'), undefined);
});

test('external: override normalization stores only deviations and drops unsafe keys', () => {
  assert.deepEqual(normalizeExternalOverrides(undefined), {});
  assert.deepEqual(normalizeExternalOverrides(null), {});
  assert.deepEqual(normalizeExternalOverrides([]), {});
  assert.deepEqual(normalizeExternalOverrides('nope'), {});
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: {} }), {});
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: { enabled: true } }), {});
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: { approval: false } }), {});
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: { enabled: false } }), { mcp__pan__echo: { enabled: false } });
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: { approval: true } }), { mcp__pan__echo: { approval: true } });
  assert.deepEqual(
    normalizeExternalOverrides({ mcp__pan__echo: { enabled: false, approval: true, extra: 'x' } }),
    { mcp__pan__echo: { enabled: false, approval: true } },
    'unknown fields are dropped',
  );
  assert.deepEqual(normalizeExternalOverrides({ 'bad name': { enabled: false }, mcp__pan__ok: { enabled: false } }), {
    mcp__pan__ok: { enabled: false },
  });
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: null }), {});
  assert.deepEqual(normalizeExternalOverrides({ mcp__pan__echo: [] }), {});

  const unsafe = JSON.parse('{"__proto__":{"enabled":false},"constructor":{"enabled":false},"prototype":{"enabled":false},"mcp__pan__ok":{"enabled":false}}');
  assert.deepEqual(normalizeExternalOverrides(unsafe), { mcp__pan__ok: { enabled: false } });
  assert.equal({}.enabled, undefined, 'unsafe keys never reach Object.prototype');

  const many = {};
  for (let index = 0; index < MAX_EXTERNAL_OVERRIDES + 5; index += 1) many[`mcp__pan__t${index}`] = { enabled: false };
  assert.equal(Object.keys(normalizeExternalOverrides(many)).length, MAX_EXTERNAL_OVERRIDES, 'settings are capped at 2000 entries');
});

test('external: tool normalization validates descriptors, params, caps and sort order', () => {
  assert.deepEqual(normalizeExternalTools(undefined), []);
  assert.deepEqual(normalizeExternalTools({}), []);
  const tools = normalizeExternalTools([
    { name: 'mcp__pan__zeta', description: 'z'.repeat(MAX_EXTERNAL_DESCRIPTION + 20), params: [{ name: 'p', required: true }, { name: 'q' }, { name: 3, required: false }, null] },
    { name: 'mcp__pan__alpha', description: 'A' },
    { name: 'bad name', description: 'skipped' },
    { name: 'mcp__pan__nodesc' },
    { name: 'mcp__pan__noddesc' },
    null,
    'nope',
  ]);
  assert.deepEqual(tools, [
    { name: 'mcp__pan__alpha', description: 'A', params: [] },
    { name: 'mcp__pan__zeta', description: 'z'.repeat(MAX_EXTERNAL_DESCRIPTION), params: [{ name: 'p', required: true }] },
  ], 'invalid names/descriptions are skipped, params validated, entries sorted');

  const manyParams = normalizeExternalTools([{
    name: 'mcp__pan__many',
    description: '',
    params: Array.from({ length: MAX_EXTERNAL_PARAMS + 10 }, (_, index) => ({ name: `p${index}`, required: index % 2 === 0 })),
  }]);
  assert.equal(manyParams[0].params.length, MAX_EXTERNAL_PARAMS, 'parameter chips are capped at 64');

  const manyTools = normalizeExternalTools(Array.from({ length: MAX_EXTERNAL_TOOLS + 5 }, (_, index) => ({
    name: `mcp__pan__t${index}`, description: '',
  })));
  assert.equal(manyTools.length, MAX_EXTERNAL_TOOLS, 'tools are capped at 300');
});

test('external: state normalization guards versions, ids, server names and unsafe maps', () => {
  assert.deepEqual(normalizeExternalState(undefined), { version: EXTERNAL_STORE_VERSION, presets: {} });
  assert.deepEqual(normalizeExternalState({ version: 7, presets: { x: { overrides: {} } } }).presets.x, { overrides: {}, servers: {} }, 'a wrong version is normalized back to the current schema');
  assert.deepEqual(normalizeExternalState([]), { version: EXTERNAL_STORE_VERSION, presets: {} });

  const state = normalizeExternalState({
    version: 1,
    presets: {
      standard: {
        updatedAt: ISO,
        overrides: { mcp__pan__echo: { enabled: false }, 'bad name': { enabled: false } },
        servers: {
          pan: { discoveredAt: ISO, tools: [{ name: 'mcp__pan__echo', description: 'Echo', params: [] }] },
          'bad name': { tools: [] },
          '__proto__': { tools: [] },
          empty: {},
        },
      },
      'bad/id': { overrides: {} },
      ['x'.repeat(65)]: { overrides: {} },
      '__proto__': { overrides: { mcp__pan__echo: { enabled: false } } },
      notObject: 'nope',
    },
  });
  assert.equal(state.version, 1);
  assert.deepEqual(Object.keys(state.presets), ['standard'], 'unsafe/invalid preset ids are dropped');
  assert.deepEqual(Object.keys(state.presets.standard.servers), ['pan', 'empty'], 'invalid/unsafe server names are dropped');
  assert.deepEqual(state.presets.standard.overrides, { mcp__pan__echo: { enabled: false } });

  const presets = {};
  for (let index = 0; index < MAX_EXTERNAL_PRESETS + 3; index += 1) presets[`p${index}`] = { overrides: {} };
  assert.equal(Object.keys(normalizeExternalState({ version: 1, presets }).presets).length, MAX_EXTERNAL_PRESETS, 'presets are capped at 100');

  const servers = {};
  for (let index = 0; index < MAX_EXTERNAL_SERVERS + 3; index += 1) servers[`s${index}`] = { tools: [] };
  assert.equal(Object.keys(normalizeExternalState({ version: 1, presets: { p: { servers } } }).presets.p.servers).length, MAX_EXTERNAL_SERVERS, 'servers per preset are capped at 200');
  assert.equal({}.polluted, undefined);
});

/* ---------------------------------------------------------------- */
/* Persistence                                                       */
/* ---------------------------------------------------------------- */

test('external: missing state is fine and discovery with no agents writes nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external } = harness({ dir });
  await external.ready();
  const payload = await external.scan();
  assert.deepEqual(payload, { scannedAt: ISO, presets: [] });
  assert.deepEqual(await readdir(dir), [], 'a scan without changes never creates external.json');
  assert.equal(external.filePath(), join(dir, EXTERNAL_STORE_FILE));
  await external.dispose();
});

test('external: saving settings persists atomically with 0600/0700 and only safe fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent } = harness({ dir, presetsRows: [{ id: 'standard', name: 'Standard', order: 2 }] });
  addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'read_file'],
    visible: new Map([['mcp__pan__echo', definition('Echo', { properties: { q: { type: 'string' } }, required: ['q'] })]]),
  });
  await external.scan();
  const saved = await external.saveTools('standard', [
    { name: 'mcp__pan__echo', enabled: false, approval: true },
    { name: 'mcp__pan__other', enabled: true, approval: false },
  ]);
  assert.equal(saved.presets.length, 1);
  assert.equal(saved.presets[0].id, 'standard');
  assert.equal(saved.presets[0].tools, undefined);

  const path = join(dir, EXTERNAL_STORE_FILE);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, 'external.json is private');
  if (process.getuid?.() !== 0) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, EXTERNAL_STORE_VERSION);
  assert.deepEqual(raw.presets.standard.overrides, { mcp__pan__echo: { enabled: false, approval: true } }, 'a default row is not stored');
  assert.equal(typeof raw.presets.standard.updatedAt, 'string');

  const allowed = new Set([
    'version', 'presets', 'overrides', 'servers', 'updatedAt', 'discoveredAt', 'tools',
    'name', 'description', 'params', 'enabled', 'approval', 'required',
    'mcp__pan__echo', 'mcp__pan__other', 'pan', 'standard',
  ]);
  for (const key of keysOf(raw)) assert.ok(allowed.has(key), `unexpected persisted key "${key}"`);
  const text = await readFile(path, 'utf8');
  for (const secret of ['Authorization', 'Bearer', 'password', 'secret', 'apiKey']) {
    assert.equal(text.includes(secret), false, `external.json must never carry credentials (${secret})`);
  }
  await external.dispose();
});

test('external: corrupt or unknown-version state is quarantined and replaced by an empty one', async (t) => {
  for (const content of ['{ not json', JSON.stringify({ version: 99, presets: {} })]) {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, EXTERNAL_STORE_FILE), content, { mode: 0o600 });
    const warnings = [];
    const { external } = harness({ dir, logger: (level, message) => warnings.push([level, message]) });
    await external.ready();
    const payload = await external.scan();
    assert.deepEqual(payload.presets, []);
    const files = await readdir(dir);
    assert.equal(files.includes(EXTERNAL_STORE_FILE), false, 'the damaged file was moved away');
    assert.ok(files.some((file) => file.startsWith(`${EXTERNAL_STORE_FILE}.corrupt-`)), `expected a quarantine file, saw ${files.join(', ')}`);
    assert.ok(warnings.some(([level]) => level === 'warn'));
    await external.dispose();
  }
});

/* ---------------------------------------------------------------- */
/* Discovery                                                         */
/* ---------------------------------------------------------------- */

test('external: discovery groups preset tools by server prefix and caches descriptors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent } = harness({
    dir,
    presetsRows: [{ id: 'standard', name: 'Standard', order: 2 }, { id: 'custom', name: 'Custom', order: 1 }],
    compositions: [{ id: 'custom', modules: [{ moduleName: '@deepseek-ai/dsh-mcp-client' }] }],
  });
  addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__bild', 'mcp__obs__trace', 'read_file', 'mcp__novalue__x'],
    visible: new Map([
      ['mcp__pan__echo', definition('Echo text', { properties: { q: { type: 'string' }, n: { type: 'number' } }, required: ['q'] })],
      ['mcp__pan__bild', definition('Show an image')],
      ['mcp__obs__trace', definition('x'.repeat(MAX_EXTERNAL_DESCRIPTION + 100))],
      ['read_file', definition('ours')],
    ]),
  });

  const payload = await external.scan();
  assert.equal(payload.scannedAt, ISO);
  assert.equal(payload.presets.length, 2);
  assert.deepEqual(payload.presets.map((preset) => [preset.id, preset.name, preset.hasPresetMcp]), [
    ['custom', 'Custom', true],
    ['standard', 'Standard', true],
  ], 'presets sort by roster order, ids still render');
  assert.deepEqual(payload.presets[0].servers, [], 'hasPresetMcp with no discovered servers is a pending placeholder');
  const standard = payload.presets[1];
  assert.deepEqual(standard.servers.map((server) => server.name), ['obs', 'pan'], 'servers are grouped by mcp__<server>__ and sorted');
  assert.deepEqual(standard.servers[1].tools, [
    { name: 'mcp__pan__bild', description: 'Show an image', params: [], enabled: true, approval: false },
    {
      name: 'mcp__pan__echo',
      description: 'Echo text',
      params: [{ name: 'q', required: true }, { name: 'n', required: false }],
      enabled: true,
      approval: false,
    },
  ]);
  assert.equal(standard.servers[0].tools[0].description.length, MAX_EXTERNAL_DESCRIPTION, 'cached descriptions are truncated');

  const raw = JSON.parse(await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8'));
  const cached = raw.presets.standard.servers.pan;
  assert.equal(typeof cached.discoveredAt, 'string');
  assert.deepEqual(cached.tools.map((tool) => tool.name), ['mcp__pan__bild', 'mcp__pan__echo'], 'descriptors are cached, settings are not baked in');
  assert.equal('enabled' in cached.tools[0], false);
  assert.equal('approval' in cached.tools[0], false);

  // A second identical scan keeps the file byte-identical (nothing changed).
  const first = await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8');
  await external.scan();
  assert.equal(await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8'), first);
  await external.dispose();
});

test('external: our own tools are never reported or restricted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent, restrictCalls } = harness({ dir, ownNames: ['mcp__pan__echo', 'mcp__pan__own'] });
  addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__own', 'mcp__pan__external'],
    visible: new Map([
      ['mcp__pan__echo', definition('ours')],
      ['mcp__pan__own', definition('ours too')],
      ['mcp__pan__external', definition('theirs')],
    ]),
  });
  const payload = await external.scan();
  assert.deepEqual(payload.presets[0].servers[0].tools.map((tool) => tool.name), ['mcp__pan__external']);
  assert.deepEqual(restrictCalls, []);
  await external.dispose();
});

/* ---------------------------------------------------------------- */
/* Restrictions (exposure)                                           */
/* ---------------------------------------------------------------- */

test('external: disabled tools are denied, re-applied only on change, lifted and preset-scoped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent, restrictCalls, restrictionDisposals } = harness({ dir });
  const agent = addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__hide', 'mcp__pan__bild'],
    visible: new Map([
      ['mcp__pan__echo', definition('Echo')],
      ['mcp__pan__hide', definition('Hide')],
      ['mcp__pan__bild', definition('Bild')],
    ]),
  });

  await external.scan();
  assert.deepEqual(restrictCalls, [], 'no settings means no restriction');

  await external.saveTools('standard', [
    { name: 'mcp__pan__hide', enabled: false, approval: false },
    { name: 'mcp__pan__echo', enabled: true, approval: true },
    { name: 'mcp__pan__bild', enabled: true, approval: false },
  ]);
  assert.deepEqual(restrictCalls, [{ sessionId: 'sess-1', deny: ['mcp__pan__hide'] }], 'one deny entry for the disabled tool');

  await external.scan();
  assert.equal(restrictCalls.length, 1, 'an unchanged signature is not re-applied');

  // The live view no longer lists the restricted tool: the cache keeps it.
  agent.state.restrictable = ['mcp__pan__echo', 'mcp__pan__bild'];
  agent.state.visible = new Map([['mcp__pan__echo', definition('Echo')], ['mcp__pan__bild', definition('Bild')]]);
  const cached = await external.scan();
  const tools = cached.presets[0].servers[0].tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.enabled]), [
    ['mcp__pan__bild', true],
    ['mcp__pan__echo', true],
    ['mcp__pan__hide', false],
  ], 'a restricted tool stays visible in the panel with its disabled state');

  // Re-enabling lifts the restriction: the deny list becomes empty.
  agent.state.restrictable = ['mcp__pan__echo', 'mcp__pan__hide', 'mcp__pan__bild'];
  await external.saveTools('standard', [
    { name: 'mcp__pan__hide', enabled: true, approval: false },
  ]);
  assert.equal(restrictionDisposals.length >= 1, true, 'the old restriction was lifted');
  assert.deepEqual(restrictCalls.at(-1), { sessionId: 'sess-1', deny: ['mcp__pan__hide'] }, 'the last applied deny was the disabled tool');
  await external.scan();
  assert.equal(restrictCalls.length, 1, 'nothing to deny after re-enabling');

  // Preset switch: the standard deny is gone; custom has its own settings map.
  agent.ctx.__preset = 'custom';
  await external.scan();
  assert.equal(restrictCalls.length, 1, 'the previous deny has no preset override now');
  await external.saveTools('custom', [{ name: 'mcp__pan__echo', enabled: false, approval: false }]);
  assert.deepEqual(restrictCalls.at(-1), { sessionId: 'sess-1', deny: ['mcp__pan__echo'] }, 'settings are keyed by preset id');

  // Losing the tools service / disposing releases the remaining restriction.
  agent.state.tools = false;
  await external.dispose();
  assert.equal(restrictionDisposals.length >= 2, true, 'dispose releases every remaining restriction');
});

test('external: dispose removes listeners, timers and restrictions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, listeners, addAgent, restrictionDisposals } = harness({ dir });
  addAgent('sess-1', { preset: 'standard', restrictable: ['mcp__pan__echo'], visible: new Map([['mcp__pan__echo', definition('Echo')]]) });
  await external.saveTools('standard', [{ name: 'mcp__pan__echo', enabled: false, approval: false }]);
  external.start();
  await flush(20);
  assert.deepEqual([...listeners.keys()].sort(), ['agent-preset/selected', 'agent/created', 'agent/disposed', 'tools/change', 'tools/pre-execute']);
  for (const list of listeners.values()) assert.equal(list.length, 1);

  await external.dispose();
  assert.equal(restrictionDisposals.length, 1, 'dispose releases the restriction');
  for (const list of listeners.values()) assert.equal(list.length, 0, 'dispose detaches every listener');
});

/* ---------------------------------------------------------------- */
/* test / event-driven rescans                                       */
/* ---------------------------------------------------------------- */

test('external: lifecycle and registry events trigger coalesced rescans', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent, emit: fire } = harness({ dir });
  const agent = addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo'],
    visible: new Map([['mcp__pan__echo', definition('Echo')]]),
  });
  external.start();
  await waitFor(async () => (await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8').catch(() => '')).includes('mcp__pan__echo'));
  assert.ok(true, 'start() discovers existing agents');

  agent.state.visible = new Map([['mcp__pan__echo', definition('Echo v2')]]);
  fire('tools/change', {});
  await waitFor(async () => {
    const raw = JSON.parse(await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8'));
    return raw.presets.standard.servers.pan.tools[0].description === 'Echo v2';
  });
  assert.ok(true, 'tools/change rescans after the debounce');

  fire('agent/disposed', { agent: { id: 'sess-1' } });
  await flush(30);
  await external.dispose();
});

/* ---------------------------------------------------------------- */
/* Approval policy (tools/pre-execute listener)                      */
/* ---------------------------------------------------------------- */

test('external: pre-execute asks only for an approved external tool outside full access', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harnessResult = harness({ dir, ownNames: ['mcp__pan__own'] });
  const { external, addAgent, permission } = harnessResult;
  const agent = addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__other', 'mcp__pan__own'],
    visible: new Map([['mcp__pan__echo', definition('Echo')]]),
  });
  await external.saveTools('standard', [
    { name: 'mcp__pan__echo', enabled: true, approval: true },
    { name: 'mcp__pan__other', enabled: true, approval: false },
    { name: 'mcp__pan__own', enabled: true, approval: true },
  ]);
  external.start();
  await flush(20);
  const policy = harnessResult.listeners.get('tools/pre-execute')[0];
  assert.equal(typeof policy, 'function');
  const next = async () => 'next';

  const ask = await policy({ name: 'mcp__pan__echo', agent, session: agent.session }, next);
  assert.deepEqual(ask, { kind: 'ask', reason: 'MCP 工具 "mcp__pan__echo" 需要审批（当前不是完全权限）' });

  assert.equal(await policy({ name: 'mcp__pan__other', agent }, next), 'next', 'approval is off by default');
  assert.equal(await policy({ name: 'read_file', agent }, next), 'next', 'non-MCP names are never considered');
  assert.equal(await policy({ name: 'mcp__pan__echo' }, next), 'next', 'no agent means no policy');
  assert.equal(await policy({ name: 'mcp__pan__echo', agent: null }, next), 'next');
  assert.equal(await policy({ name: 'mcp__pan__own', agent }, next), 'next', 'our own tools are never asked for');

  permission.set('sess-1', 'danger-full-access');
  assert.equal(await policy({ name: 'mcp__pan__echo', agent }, next), 'next', 'full access never asks');
  permission.set('sess-1', 'standard');

  // An unknown preset has no settings at all.
  const anonymous = addAgent('sess-2', { preset: undefined, restrictable: ['mcp__pan__echo'] });
  assert.equal(await policy({ name: 'mcp__pan__echo', agent: anonymous }, next), 'next');

  // Tools that are not part of the inherited (restrictable) view are not ours.
  const foreign = addAgent('sess-3', { preset: 'standard', restrictable: [] });
  assert.equal(await policy({ name: 'mcp__pan__echo', agent: foreign }, next), 'next', 'a tool outside the viewer scope is ignored');

  // A damaged tools service must degrade to next, never to a denial.
  const broken = addAgent('sess-4', { preset: 'standard', restrictable: ['mcp__pan__echo'] });
  broken.state.tools = false;
  assert.equal(await policy({ name: 'mcp__pan__echo', agent: broken }, next), 'next');
  await external.dispose();
});

/* ---------------------------------------------------------------- */
/* saveTools validation                                              */
/* ---------------------------------------------------------------- */

test('external: saveTools validates the preset, names, booleans and duplicates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external } = harness({ dir });
  const row = { name: 'mcp__pan__echo', enabled: true, approval: false };

  for (const presetId of [undefined, '', 'has space', 'with/slash', 'x'.repeat(65), '__proto__', 42]) {
    await expectInputError(() => external.saveTools(presetId, [row]), 'invalid-preset', 'presetId');
  }
  await expectInputError(() => external.saveTools('standard', undefined), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', {}), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', Array.from({ length: MAX_EXTERNAL_OVERRIDES + 1 }, (_, index) => ({
    name: `mcp__pan__t${index}`, enabled: true, approval: false,
  }))), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', [null]), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', ['nope']), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', [{ name: 'bad name', enabled: true, approval: false }]), 'invalid-tool-name', 'tools');
  await expectInputError(() => external.saveTools('standard', [{ name: '__proto__', enabled: true, approval: false }]), 'invalid-tool-name', 'tools');
  await expectInputError(() => external.saveTools('standard', [{ name: 'mcp__pan__echo', enabled: true }]), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', [{ name: 'mcp__pan__echo', enabled: 'true', approval: false }]), 'invalid-tools', 'tools');
  await expectInputError(() => external.saveTools('standard', [row, { ...row }]), 'invalid-tools', 'tools');

  // A valid save replaces that preset's settings only and returns the payload.
  await external.saveTools('keep', [{ name: 'mcp__pan__keep', enabled: false, approval: false }]);
  const payload = await external.saveTools('standard', [
    { name: 'mcp__pan__echo', enabled: false, approval: true, ignored: 'x' },
    { name: 'mcp__pan__bild', enabled: true, approval: false },
  ]);
  assert.deepEqual(payload.presets.map((preset) => preset.id).sort(), ['keep', 'standard']);
  const raw = JSON.parse(await readFile(join(dir, EXTERNAL_STORE_FILE), 'utf8'));
  assert.deepEqual(raw.presets.standard.overrides, { mcp__pan__echo: { enabled: false, approval: true } });
  assert.deepEqual(raw.presets.keep.overrides, { mcp__pan__keep: { enabled: false } }, 'other presets are untouched');
  await external.dispose();
});

test('external: a persisted version 1 state is loaded and its settings applied on scan', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seeded = {
    version: 1,
    presets: {
      standard: {
        updatedAt: ISO,
        overrides: { mcp__pan__echo: { enabled: false }, mcp__pan__trace: { approval: true } },
        servers: {
          pan: { discoveredAt: ISO, tools: [{ name: 'mcp__pan__echo', description: 'Cached echo', params: [] }] },
        },
      },
    },
  };
  await writeFile(join(dir, EXTERNAL_STORE_FILE), JSON.stringify(seeded), { mode: 0o600 });
  const { external, addAgent, restrictCalls } = harness({ dir, presetsRows: [{ id: 'standard', name: 'Standard', order: 2 }] });
  addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__trace'],
    visible: new Map([
      ['mcp__pan__echo', definition('Live echo')],
      ['mcp__pan__trace', definition('Trace')],
    ]),
  });
  const payload = await external.scan();
  assert.equal(payload.presets.length, 1);
  const [preset] = payload.presets;
  assert.equal(preset.id, 'standard');
  assert.equal(preset.name, 'Standard');
  assert.equal(preset.hasPresetMcp, true);
  assert.deepEqual(restrictCalls, [{ sessionId: 'sess-1', deny: ['mcp__pan__echo'] }], 'the persisted disabled setting is enforced on the first scan');
  const tools = preset.servers[0].tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.description, tool.enabled, tool.approval]), [
    ['mcp__pan__echo', 'Live echo', false, false],
    ['mcp__pan__trace', 'Trace', true, true],
  ], 'live descriptors win over the cache and stored settings are overlaid');
  await external.dispose();
});

test('external: re-enabling a restricted tool lifts the deny before visibility is read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { external, addAgent, restrictCalls, restrictionDisposals } = harness({ dir, restrictionAware: true });
  addAgent('sess-1', {
    preset: 'standard',
    restrictable: ['mcp__pan__echo', 'mcp__pan__hide'],
    visible: new Map([
      ['mcp__pan__echo', definition('Echo')],
      ['mcp__pan__hide', definition('Hide')],
    ]),
  });

  await external.saveTools('standard', [
    { name: 'mcp__pan__echo', enabled: true, approval: false },
    { name: 'mcp__pan__hide', enabled: false, approval: false },
  ]);
  assert.deepEqual(restrictCalls, [{ sessionId: 'sess-1', deny: ['mcp__pan__hide'] }]);

  // The deny is still alive here; the scan must lift it before reading `visible`,
  // otherwise the re-enabled tool would vanish from the payload and the cache.
  const payload = await external.saveTools('standard', [
    { name: 'mcp__pan__echo', enabled: true, approval: false },
    { name: 'mcp__pan__hide', enabled: true, approval: false },
  ]);
  assert.equal(restrictionDisposals.length, 1, 'the previous deny was lifted');
  assert.equal(restrictCalls.length, 1, 'nothing is denied after re-enabling');
  const tools = payload.presets[0].servers[0].tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.enabled]), [
    ['mcp__pan__echo', true],
    ['mcp__pan__hide', true],
  ], 'the re-enabled tool is immediately present and enabled');

  const again = await external.scan();
  assert.deepEqual(again.presets[0].servers[0].tools.map((tool) => [tool.name, tool.enabled]), [
    ['mcp__pan__echo', true],
    ['mcp__pan__hide', true],
  ], 'the corrected visibility is stable on the next scan');
  await external.dispose();
});
