/**
 * Preset-owned ("external") MCP management.
 *
 * Other plugins and agent presets may mount their own
 * `@deepseek-ai/dsh-mcp-client` rows. This plugin never edits that YAML, never
 * starts or stops those connections and never reads their credentials; it only
 * controls the two things a Host plugin can reach at runtime:
 *
 * - **exposure**: an Agent's inherited preset tools can be removed from its
 *   model-facing tool set with `agent.ctx.tools.restrict({ deny })`;
 * - **approval**: a Host-wide `tools/pre-execute` policy can return
 *   `{ kind: 'ask' }` for one external tool, which makes the shared DSH
 *   pipeline ask the approval service before the MCP server is called.
 *
 * Discovery is necessarily live: preset tools are registered in the preset's
 * scope, and the public tool registry only exposes another scope's inherited
 * names to a live Agent (`tools.view(agent)`). Descriptors are cached in
 * `$DSH_HOME/better-mcp-manager/external.json` so the panel keeps showing the
 * last known list while that preset has no live Agent.
 *
 * Settings are keyed by `(presetId, public tool name)` and store only
 * deviations: `{ enabled: false }` and/or `{ approval: true }`.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/external
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InputError, toolParameters } from './model.js';
import { agentTools, composedPreset } from './presets.js';

/** Schema version of `external.json`. */
export const EXTERNAL_STORE_VERSION = 1;

/** File name inside the plugin data directory. */
export const EXTERNAL_STORE_FILE = 'external.json';

/** Maximum presets retained. */
export const MAX_EXTERNAL_PRESETS = 100;

/** Maximum servers retained per preset. */
export const MAX_EXTERNAL_SERVERS = 200;

/** Maximum tools retained per server. */
export const MAX_EXTERNAL_TOOLS = 300;

/** Maximum settings entries retained per preset. */
export const MAX_EXTERNAL_OVERRIDES = 2_000;

/** Maximum cached description characters per tool. */
export const MAX_EXTERNAL_DESCRIPTION = 2_000;

/** Maximum parameter chips retained per tool. */
export const MAX_EXTERNAL_PARAMS = 64;

/** Public MCP tool names are `mcp__<serverName>__<raw>`, sanitized to this budget. */
const EXTERNAL_TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,59}$/u;

/** Preset identities are short opaque keys (the same file is a JSON map). */
const PRESET_ID_PATTERN = /^[^\s/]{1,64}$/u;

/** `@deepseek-ai/dsh-mcp-client` server names. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

/** Module name whose mounted rows create preset-owned MCP tools. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client';

/** Keys that must never become own properties of a settings/cache map. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Default icon of the automatic source/client identity used in tool names. */
const MCP_PREFIX = 'mcp__';

/**
 * Whether a model-facing name belongs to the `mcp__` namespace.
 * @param {unknown} value - Candidate name.
 * @returns {boolean} whether it is a valid public MCP tool name.
 */
export function isExternalToolName(value) {
  return typeof value === 'string' && EXTERNAL_TOOL_NAME.test(value);
}

/**
 * Derive the MCP server namespace from one public tool name.
 *
 * `serverName` itself is limited to 32 `[A-Za-z0-9_-]` characters. A server name
 * may contain a single underscore but the naming contract reserves `__` as the
 * separator, so the first `__` terminates it. Names that do not follow the
 * contract return `undefined` and are ignored rather than guessed.
 * @param {string} name - Public tool name.
 * @returns {string | undefined} the server namespace.
 */
export function externalServerName(name) {
  if (!isExternalToolName(name)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const end = rest.indexOf('__');
  if (end <= 0) return undefined;
  const server = rest.slice(0, end);
  if (server.length > 32 || !SERVER_NAME_PATTERN.test(server)) return undefined;
  if (rest.length <= end + 2) return undefined;
  return server;
}

/**
 * Copy a plain object, or undefined for anything else.
 * @param {unknown} value - Candidate.
 * @returns {Record<string, unknown> | undefined} the object.
 */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * Narrow one persisted settings map to deviations only.
 * @param {unknown} value - Persisted overrides.
 * @returns {Record<string, { enabled?: false, approval?: true }>} the map.
 */
export function normalizeExternalOverrides(value) {
  const source = plainObject(value);
  /** @type {Record<string, { enabled?: false, approval?: true }>} */
  const overrides = {};
  if (source === undefined) return overrides;
  let kept = 0;
  for (const [name, raw] of Object.entries(source)) {
    if (kept >= MAX_EXTERNAL_OVERRIDES) break;
    if (UNSAFE_KEYS.has(name) || !isExternalToolName(name)) continue;
    const entry = plainObject(raw);
    if (entry === undefined) continue;
    /** @type {{ enabled?: false, approval?: true }} */
    const setting = {};
    if (entry.enabled === false) setting.enabled = false;
    if (entry.approval === true) setting.approval = true;
    if (Object.keys(setting).length === 0) continue;
    overrides[name] = setting;
    kept += 1;
  }
  return overrides;
}

/**
 * Narrow one descriptor array.
 * @param {unknown} value - Persisted tools.
 * @returns {{ name: string, description: string, params: { name: string, required: boolean }[] }[]} descriptors.
 */
export function normalizeExternalTools(value) {
  if (!Array.isArray(value)) return [];
  const tools = [];
  for (const raw of value.slice(0, MAX_EXTERNAL_TOOLS)) {
    const entry = plainObject(raw);
    if (entry === undefined) continue;
    if (typeof entry.name !== 'string' || !isExternalToolName(entry.name)) continue;
    if (typeof entry.description !== 'string') continue;
    /** @type {{ name: string, required: boolean }[]} */
    const params = [];
    if (Array.isArray(entry.params)) {
      for (const param of entry.params.slice(0, MAX_EXTERNAL_PARAMS)) {
        const item = plainObject(param);
        if (item === undefined || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 128) continue;
        if (typeof item.required !== 'boolean') continue;
        params.push({ name: item.name, required: item.required });
      }
    }
    tools.push({
      name: entry.name,
      description: entry.description.slice(0, MAX_EXTERNAL_DESCRIPTION),
      params,
    });
  }
  tools.sort((left, right) => left.name.localeCompare(right.name));
  return tools;
}

/**
 * Normalize a whole persisted external state.
 * @param {unknown} value - Parsed file.
 * @returns {{ version: 1, presets: Record<string, { updatedAt?: string, overrides: Record<string, any>, servers: Record<string, any> }> }} normalized state.
 */
export function normalizeExternalState(value) {
  /** @type {{ version: 1, presets: Record<string, any> }} */
  const state = { version: EXTERNAL_STORE_VERSION, presets: {} };
  const parsed = plainObject(value);
  const presets = plainObject(parsed?.presets);
  if (presets === undefined) return state;
  let count = 0;
  for (const [presetId, rawPreset] of Object.entries(presets)) {
    if (count >= MAX_EXTERNAL_PRESETS) break;
    if (UNSAFE_KEYS.has(presetId) || !PRESET_ID_PATTERN.test(presetId)) continue;
    const source = plainObject(rawPreset);
    if (source === undefined) continue;
    /** @type {{ updatedAt?: string, overrides: Record<string, any>, servers: Record<string, any> }} */
    const preset = {
      overrides: normalizeExternalOverrides(source.overrides),
      servers: {},
    };
    if (typeof source.updatedAt === 'string') preset.updatedAt = source.updatedAt;
    const servers = plainObject(source.servers);
    if (servers !== undefined) {
      let serverCount = 0;
      for (const [serverName, rawServer] of Object.entries(servers)) {
        if (serverCount >= MAX_EXTERNAL_SERVERS) break;
        if (serverName === '__proto__' || !SERVER_NAME_PATTERN.test(serverName)) continue;
        const server = plainObject(rawServer);
        if (server === undefined) continue;
        preset.servers[serverName] = {
          discoveredAt: typeof server.discoveredAt === 'string' ? server.discoveredAt : '',
          tools: normalizeExternalTools(server.tools),
        };
        serverCount += 1;
      }
    }
    state.presets[presetId] = preset;
    count += 1;
  }
  return state;
}

/**
 * Build the persisted snapshot text.
 * @param {{ version: number, presets: Record<string, any> }} state - State.
 * @returns {string} JSON text.
 */
function serializeState(state) {
  return JSON.stringify({
    version: EXTERNAL_STORE_VERSION,
    presets: state.presets,
  }, null, 2) + '\n';
}

/**
 * Whether the current session is in the exact full-access permission preset.
 * @param {object} hostCtx - Host plugin context.
 * @param {Record<string, any> | undefined} session - Calling session.
 * @returns {boolean} the answer (false when the service is absent/damaged).
 */
function isFullAccess(hostCtx, session) {
  try {
    const presets = hostCtx.get('permissionPresets');
    if (presets === undefined || typeof presets.current !== 'function') return false;
    return presets.current(session) === 'danger-full-access';
  } catch {
    return false;
  }
}

/**
 * Build the external MCP controller.
 * @param {object} options - Controller options.
 * @param {object} options.hostCtx - Host plugin context.
 * @param {string} options.dir - Plugin data directory.
 * @param {Record<string, any>} options.exposure - Own-tool exposure controller (for ownership checks).
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {() => number} [options.now] - Clock.
 * @returns {object} the controller.
 */
export function createExternal({ hostCtx, dir, exposure, logger = () => {}, now = () => Date.now() }) {
  const file = join(dir, EXTERNAL_STORE_FILE);
  /** @type {{ version: number, presets: Record<string, any> }} */
  let state = normalizeExternalState(undefined);
  let loaded = false;
  let disposed = false;
  /** @type {Promise<void>} */
  let persistQueue = Promise.resolve();
  let writeCounter = 0;
  let scannedAt = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let scanTimer;
  /** @type {Promise<any> | undefined} */
  let scanning;
  /** @type {Promise<void> | undefined} */
  let loadPromise;
  /** @type {Map<string, { presetId: string, signature: string, dispose: () => void }>} */
  const restrictions = new Map();
  /** @type {(() => void)[]} */
  let listenerDisposers = [];
  let started = false;

  /**
   * Read the file once, quarantining damage like the server store does.
   * @returns {Promise<void>} completion.
   */
  const load = async () => {
    if (loaded) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = normalizeExternalState(undefined);
        loaded = true;
        return;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const quarantine = join(dir, `${EXTERNAL_STORE_FILE}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      await rename(file, quarantine).catch(() => {});
      logger('warn', `better-mcp-manager: ${EXTERNAL_STORE_FILE} is not valid JSON (${error.message}); moved it to ${quarantine} and started empty`);
      state = normalizeExternalState(undefined);
      loaded = true;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.version !== EXTERNAL_STORE_VERSION) {
      const quarantine = join(dir, `${EXTERNAL_STORE_FILE}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      await rename(file, quarantine).catch(() => {});
      logger('warn', `better-mcp-manager: ${EXTERNAL_STORE_FILE} has an unknown shape or version; moved it to ${quarantine} and started empty`);
      state = normalizeExternalState(undefined);
      loaded = true;
      return;
    }
    state = normalizeExternalState(parsed);
    loaded = true;
  };

  /**
   * Ensure the file has been read.
   * @returns {Promise<void>} completion.
   */
  const ready = () => {
    loadPromise ??= load();
    return loadPromise;
  };

  /**
   * Serialize one atomic snapshot write.
   * @returns {Promise<void>} completion.
   */
  const persist = () => {
    const snapshot = serializeState(state);
    const run = async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      writeCounter += 1;
      const tmp = join(dir, `.${EXTERNAL_STORE_FILE}.${process.pid}.${writeCounter}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, file);
        await chmod(file, 0o600).catch(() => {});
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    };
    persistQueue = persistQueue.then(run, run);
    return persistQueue;
  };

  /**
   * Live agents from the registry, when mounted.
   * @returns {Record<string, any>[]} agents.
   */
  const liveAgents = () => {
    try {
      const agents = hostCtx.get('agents');
      if (agents === undefined || typeof agents.list !== 'function') return [];
      return agents.list();
    } catch {
      return [];
    }
  };

  /**
   * Preset display metadata.
   * @returns {Promise<Map<string, { name: string, order: number }>>} metadata.
   */
  const presetMetadata = async () => {
    /** @type {Map<string, { name: string, order: number }>} */
    const metadata = new Map();
    try {
      const presets = hostCtx.get('agentPresets');
      if (presets === undefined || typeof presets.list !== 'function') return metadata;
      const rows = await presets.list();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (typeof row?.id !== 'string') continue;
        metadata.set(row.id, {
          name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
          order: Number.isFinite(row.order) ? row.order : Number.MAX_SAFE_INTEGER,
        });
      }
    } catch {
      /* the roster is optional; ids still render */
    }
    return metadata;
  };

  /**
   * Preset ids whose standing composition mounts an MCP client row.
   * @returns {Set<string>} ids.
   */
  const compositionsWithMcp = () => {
    const ids = new Set();
    try {
      const presets = hostCtx.get('agentPresets');
      if (presets === undefined || typeof presets.inspectCompositions !== 'function') return ids;
      for (const composition of presets.inspectCompositions()) {
        if (typeof composition?.id !== 'string') continue;
        const modules = Array.isArray(composition.modules) ? composition.modules : [];
        if (modules.some((module) => module?.moduleName === MCP_CLIENT_MODULE)) ids.add(composition.id);
      }
    } catch {
      /* optional diagnostic */
    }
    return ids;
  };

  /**
   * Describe one live inherited tool definition.
   * @param {string} name - Public name.
   * @param {Record<string, any>} definition - Tool definition.
   * @returns {{ name: string, description: string, params: { name: string, required: boolean }[] }} descriptor.
   */
  const describe = (name, definition) => ({
    name,
    description: typeof definition?.description === 'string'
      ? definition.description.slice(0, MAX_EXTERNAL_DESCRIPTION)
      : '',
    params: toolParameters(definition?.parameters).slice(0, MAX_EXTERNAL_PARAMS),
  });

  /**
   * Merge the current live server descriptors over the cached list.
   *
   * A disabled tool is absent from the visible view after its restriction, so a
   * live scan must not delete it: cached entries stay until the server really
   * stops listing them and the operator no longer has a disabled override.
   * @param {Record<string, any>} server - Existing cached server record.
   * @param {{ name: string, description: string, params: any[] }[]} live - Live descriptors.
   * @param {Record<string, any>} overrides - Effective settings for this preset.
   * @returns {{ tools: any[], changed: boolean }} merged record.
   */
  const mergeServerTools = (server, live, overrides) => {
    const previous = Array.isArray(server?.tools) ? server.tools : [];
    /** @type {Map<string, any>} */
    const merged = new Map(previous.map((tool) => [tool.name, tool]));
    for (const tool of live) merged.set(tool.name, tool);
    const liveNames = new Set(live.map((tool) => tool.name));
    const tools = [...merged.values()].filter((tool) => liveNames.has(tool.name) || overrides[tool.name]?.enabled === false);
    tools.sort((left, right) => left.name.localeCompare(right.name));
    const before = JSON.stringify(previous);
    const after = JSON.stringify(tools);
    return { tools, changed: before !== after };
  };

  /**
   * Apply or lift one Agent's restriction from the stored settings.
   * @param {Record<string, any>} agent - Live agent.
   * @param {string} sessionId - Session identity.
   * @param {string} presetId - Bound preset.
   * @param {Record<string, any>} overrides - Effective settings.
   * @param {Set<string>} known - Inherited tool names of the viewing scope.
   * @returns {void}
   */
  const applyRestriction = (agent, sessionId, presetId, overrides, known) => {
    const deny = [...known].filter((name) => isExternalToolName(name) && overrides[name]?.enabled === false).sort();
    const signature = `${presetId}\0${deny.join('\0')}`;
    const previous = restrictions.get(sessionId);
    if (previous?.signature === signature) return;
    if (previous !== undefined) {
      try {
        previous.dispose();
      } catch (error) {
        logger('warn', `better-mcp-manager: lifting an external tool restriction failed: ${error?.message ?? error}`);
      }
      restrictions.delete(sessionId);
    }
    if (deny.length === 0) return;
    const tools = agentTools(agent);
    if (tools === undefined || typeof tools.restrict !== 'function') return;
    try {
      const dispose = tools.restrict({ deny });
      restrictions.set(sessionId, { presetId, signature, dispose });
    } catch (error) {
      logger('warn', `better-mcp-manager: restricting external tools for "${presetId}" failed: ${error?.message ?? error}`);
    }
  };

  /**
   * Build the panel payload from the current state and live metadata.
   * @returns {Promise<{ scannedAt: string | null, presets: any[] }>} payload.
   */
  const payload = async () => {
    const metadata = await presetMetadata();
    const hasMcp = compositionsWithMcp();
    const ids = new Set([...Object.keys(state.presets), ...hasMcp]);
    /** @type {any[]} */
    const presets = [];
    for (const presetId of ids) {
      const record = state.presets[presetId] ?? { overrides: {}, servers: {} };
      const overrides = record.overrides ?? {};
      /** @type {any[]} */
      const servers = [];
      for (const [serverName, server] of Object.entries(record.servers ?? {})) {
        const tools = (Array.isArray(server?.tools) ? server.tools : []).map((tool) => ({
          ...tool,
          enabled: overrides[tool.name]?.enabled !== false,
          approval: overrides[tool.name]?.approval === true,
        }));
        if (tools.length === 0) continue;
        servers.push({
          name: serverName,
          discoveredAt: typeof server?.discoveredAt === 'string' ? server.discoveredAt : null,
          tools,
        });
      }
      servers.sort((left, right) => left.name.localeCompare(right.name));
      if (servers.length === 0 && !hasMcp.has(presetId) && Object.keys(overrides).length === 0) continue;
      const meta = metadata.get(presetId);
      presets.push({
        id: presetId,
        name: meta?.name ?? presetId,
        hasPresetMcp: hasMcp.has(presetId) || servers.length > 0,
        servers,
      });
    }
    presets.sort((left, right) => {
      const leftOrder = metadata.get(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = metadata.get(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });
    return { scannedAt, presets };
  };

  /**
   * Run one discovery pass and apply restrictions.
   * @returns {Promise<{ scannedAt: string | null, presets: any[] }>} payload.
   */
  const scanOnce = async () => {
    await ready();
    if (disposed) return payload();
    let changed = false;
    const agents = liveAgents();
    const liveSessions = new Set();
    for (const agent of agents) {
      if (disposed) return payload();
      const sessionId = typeof agent?.id === 'string' ? agent.id : undefined;
      if (sessionId === undefined) continue;
      liveSessions.add(sessionId);
      const presetId = composedPreset(hostCtx, agent);
      if (presetId === undefined || UNSAFE_KEYS.has(presetId)) continue;
      const tools = agentTools(agent);
      if (tools === undefined || typeof tools.view !== 'function') continue;
      let initialView;
      try {
        initialView = tools.view(agent);
      } catch (error) {
        logger('warn', `better-mcp-manager: reading external tools failed: ${error?.message ?? error}`);
        continue;
      }
      const own = exposure.ownToolNames();
      const known = new Set([...(initialView?.restrictableNames instanceof Set ? initialView.restrictableNames : [])].filter((name) => !own.has(name)));
      const record = state.presets[presetId] ??= { overrides: {}, servers: {} };
      const overrides = record.overrides ??= {};
      // Apply/lift the restrictions *before* reading visibility: a tool that was
      // just re-enabled is still absent from `visible` while the old restriction
      // is alive, and merging that stale view would drop it from the payload and
      // the cache. `restrictableNames` is unaffected by restrictions, so it is
      // the stable input for the deny set.
      applyRestriction(agent, sessionId, presetId, overrides, known);
      let view;
      try {
        view = tools.view(agent);
      } catch {
        view = initialView;
      }
      const visible = view?.visible instanceof Map ? view.visible : new Map();
      /** @type {Map<string, any[]>} */
      const liveByServer = new Map();
      for (const name of known) {
        if (!isExternalToolName(name)) continue;
        const serverName = externalServerName(name);
        if (serverName === undefined) continue;
        if (visible.has(name)) {
          const list = liveByServer.get(serverName) ?? [];
          list.push(describe(name, visible.get(name)));
          liveByServer.set(serverName, list);
        }
      }
      for (const [serverName, live] of liveByServer) {
        const previous = record.servers?.[serverName];
        const merged = mergeServerTools(previous, live, overrides);
        const discoveredAt = new Date(now()).toISOString();
        if (merged.changed || previous === undefined) {
          record.servers ??= {};
          record.servers[serverName] = { discoveredAt, tools: merged.tools };
          changed = true;
        }
      }
    }
    for (const [sessionId, restriction] of restrictions) {
      if (liveSessions.has(sessionId)) continue;
      try {
        restriction.dispose();
      } catch {
        /* agent is gone */
      }
      restrictions.delete(sessionId);
    }
    scannedAt = new Date(now()).toISOString();
    if (changed) {
      try {
        await persist();
      } catch (error) {
        logger('warn', `better-mcp-manager: saving external MCP state failed: ${error?.message ?? error}`);
      }
    }
    return payload();
  };

  /**
   * Discover preset-owned tools (coalescing concurrent callers).
   * @returns {Promise<{ scannedAt: string | null, presets: any[] }>} payload.
   */
  const scan = () => {
    scanning ??= scanOnce().finally(() => {
      scanning = undefined;
    });
    return scanning;
  };

  /**
   * Coalesce a burst of lifecycle/registry notifications into one scan.
   * @param {number} [delayMs] - Delay; `0` uses a microtask.
   * @returns {void}
   */
  const scheduleScan = (delayMs = 0) => {
    if (disposed || scanTimer !== undefined) return;
    const run = () => {
      scanTimer = undefined;
      void scan().catch((error) => {
        logger('warn', `better-mcp-manager: external MCP scan failed: ${error?.message ?? error}`);
      });
    };
    if (delayMs > 0) scanTimer = setTimeout(run, delayMs);
    else queueMicrotask(run);
  };

  /**
   * Save one preset's complete tool settings and re-apply restrictions.
   * @param {string} presetId - Preset identity.
   * @param {unknown} tools - `tools` array from the endpoint.
   * @returns {Promise<{ scannedAt: string | null, presets: any[] }>} payload.
   */
  const saveTools = async (presetId, tools) => {
    await ready();
    if (typeof presetId !== 'string' || !PRESET_ID_PATTERN.test(presetId) || UNSAFE_KEYS.has(presetId)) {
      throw new InputError('invalid-preset', 'presetId is invalid', 'presetId');
    }
    if (!Array.isArray(tools)) throw new InputError('invalid-tools', 'tools must be an array', 'tools');
    if (tools.length > MAX_EXTERNAL_OVERRIDES) throw new InputError('invalid-tools', `at most ${MAX_EXTERNAL_OVERRIDES} tools are supported`, 'tools');
    /** @type {Record<string, { enabled?: false, approval?: true }>} */
    const overrides = {};
    const seen = new Set();
    for (const raw of tools) {
      const row = plainObject(raw);
      if (row === undefined) throw new InputError('invalid-tools', 'each tool must be an object', 'tools');
      const name = row.name;
      if (typeof name !== 'string' || UNSAFE_KEYS.has(name) || !isExternalToolName(name)) {
        throw new InputError('invalid-tool-name', `tool name "${String(name)}" is invalid`, 'tools');
      }
      if (seen.has(name)) throw new InputError('invalid-tools', `tool "${name}" appears twice`, 'tools');
      seen.add(name);
      if (typeof row.enabled !== 'boolean' || typeof row.approval !== 'boolean') {
        throw new InputError('invalid-tools', `tool "${name}" needs boolean enabled and approval`, 'tools');
      }
      /** @type {{ enabled?: false, approval?: true }} */
      const entry = {};
      if (row.enabled === false) entry.enabled = false;
      if (row.approval === true) entry.approval = true;
      if (Object.keys(entry).length > 0) overrides[name] = entry;
    }
    const record = state.presets[presetId] ??= { overrides: {}, servers: {} };
    record.overrides = overrides;
    record.updatedAt = new Date(now()).toISOString();
    try {
      await persist();
    } catch (error) {
      logger('warn', `better-mcp-manager: saving external MCP state failed: ${error?.message ?? error}`);
    }
    // Wait for any in-flight discovery so the response reflects the settings we
    // just wrote instead of a scan started before them.
    if (scanning !== undefined) await scanning.catch(() => {});
    return scan();
  };

  /**
   * Tool approval policy for preset-owned tools.
   *
   * Runs for every tool execution, but only answers for a tool that (a) belongs
   * to the calling Agent's preset inheritance, (b) is not one of this plugin's
   * own registrations and (c) has `approval: true` stored. In full access the
   * call proceeds; elsewhere the shared pipeline asks via `kind: 'ask'`.
   * @param {Record<string, any>} exec - Tool execution.
   * @param {() => Promise<any>} next - Downstream policy.
   * @returns {Promise<any>} decision.
   */
  const onPreExecute = async (exec, next) => {
    const name = exec?.name;
    if (!isExternalToolName(name)) return next();
    await ready();
    const agent = exec?.agent;
    if (agent === undefined || agent === null) return next();
    const presetId = composedPreset(hostCtx, agent);
    if (presetId === undefined) return next();
    const setting = state.presets[presetId]?.overrides?.[name];
    if (setting?.approval !== true) return next();
    if (exposure.ownToolNames().has(name)) return next();
    /** @type {boolean | undefined} */
    let external;
    try {
      const tools = agentTools(agent);
      const view = tools?.view?.(agent);
      external = view?.restrictableNames instanceof Set && view.restrictableNames.has(name);
    } catch {
      return next();
    }
    if (external !== true) return next();
    if (isFullAccess(hostCtx, agent.session)) return next();
    return { kind: 'ask', reason: `MCP 工具 "${name}" 需要审批（当前不是完全权限）` };
  };

  /**
   * Attach Host listeners and perform the first scan.
   * @returns {void}
   */
  const start = () => {
    if (started) return;
    started = true;
    void ready().then(() => scheduleScan()).catch((error) => {
      logger('warn', `better-mcp-manager: loading external MCP state failed: ${error?.message ?? error}`);
    });
    const on = (event, listener) => {
      const dispose = hostCtx.on(event, listener);
      if (typeof dispose === 'function') listenerDisposers.push(dispose);
    };
    on('agent/created', (payloadEvent) => {
      if (payloadEvent?.agent !== undefined) scheduleScan();
    });
    on('agent/disposed', (payloadEvent) => {
      const agent = payloadEvent?.agent;
      if (typeof agent?.id === 'string') {
        const restriction = restrictions.get(agent.id);
        if (restriction !== undefined) {
          try {
            restriction.dispose();
          } catch {
            /* already disposed */
          }
          restrictions.delete(agent.id);
        }
      }
      scheduleScan();
    });
    on('agent-preset/selected', () => {
      scheduleScan();
    });
    on('tools/change', () => {
      scheduleScan(25);
    });
    on('tools/pre-execute', onPreExecute);
  };

  /**
   * Detach listeners and release restrictions; wait for pending writes.
   * @returns {Promise<void>} completion.
   */
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (scanTimer !== undefined) {
      clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    for (const dispose of listenerDisposers) {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
    listenerDisposers = [];
    for (const restriction of restrictions.values()) {
      try {
        restriction.dispose();
      } catch {
        /* agent context may already be gone */
      }
    }
    restrictions.clear();
    await ready().catch(() => {});
    await persistQueue.catch(() => {});
  };

  /**
   * Path of the external state file (diagnostics/tests).
   * @returns {string} absolute path.
   */
  const filePath = () => file;

  return { start, ready, scan, saveTools, filePath, dispose };
}
