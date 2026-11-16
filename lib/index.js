/**
 * dsh-better-mcp-manager — Host half.
 *
 * Owns the whole plugin: the server store, the MCP connection supervisors, the
 * per-preset exposure controller and the panel HTTP API. The browser half in
 * `lib/client.js` is served by the Web shell and only talks to this Host over
 * same-origin HTTP.
 *
 * Everything this plugin writes lives under `$DSH_HOME/better-mcp-manager/` and
 * nothing else is touched — no Loader rows, no profile edits, no preset YAML.
 * That is what makes uninstalling clean: remove the bundle, run the cleanup CLI,
 * done. See `docs/TECHNICAL.md#uninstall`.
 *
 * `webServer` is a hard dependency: without it there is no panel. The agent
 * services are read opportunistically — a profile without agent presets still
 * gets the panel, global tools, and a roster explaining that per-preset
 * selection needs presets.
 *
 * @module @ds-hu/dsh-better-mcp-manager
 */
import { createApi } from './api.js';
import { buildToolCache } from './model.js';
import { createManager } from './mcp.js';
import { createExposure } from './presets.js';
import { createStore, resolveDataDir, STORE_VERSION } from './store.js';
import { API_PREFIX, PLUGIN_VERSION } from './version.js';

/** Plugin name registered with the Loader; must equal the row `id` declared by the bundle patch. */
export const name = 'dsh-better-mcp-manager';

/** Host services this plugin cannot work without. */
export const inject = ['webServer'];

/**
 * Mount the plugin.
 * @param {any} ctx - Host plugin context (Cordis).
 * @returns {void}
 */
export function apply(ctx) {
  /**
   * Route diagnostics through the Host logger when present, and stay quiet
   * enough on a bare profile that nothing floods a terminal.
   * @param {string} level - `debug` | `info` | `warn` | `error`.
   * @param {string} message - Text to record.
   * @returns {void}
   */
  const logger = (level, message) => {
    try {
      const sink = ctx.logger;
      if (sink !== undefined && typeof sink[level] === 'function') {
        sink[level](message);
        return;
      }
      if (typeof sink === 'function') {
        sink(level, message);
        return;
      }
      if (level === 'warn' || level === 'error') console.warn(message);
    } catch {
      /* diagnostics must never break the plugin */
    }
  };

  const dir = resolveDataDir();
  const store = createStore({ dir, logger });

  /** @type {ReturnType<typeof createExposure> | undefined} */
  let exposure;

  /**
   * Refresh the offline tool cache for one server after its live tool list
   * changes. The write goes through `store.patch`, which read-modify-writes
   * inside the serialized queue, so it cannot clobber a concurrent settings save.
   * @param {string} serverId - Server whose tools changed.
   * @returns {void}
   */
  function persistToolCache(serverId) {
    try {
      const connection = manager.get(serverId);
      if (connection === undefined || connection.snapshot().state !== 'connected') return;
      const record = store.get(serverId);
      if (record === undefined) return;
      const cache = buildToolCache(connection.tools());
      if (JSON.stringify(record.toolCache?.tools) === JSON.stringify(cache.tools)) return;
      void store.patch(serverId, (latest) => ({ ...latest, toolCache: cache })).catch((error) => {
        logger('warn', `better-mcp-manager: caching the tool list for ${serverId} failed: ${error?.message ?? String(error)}`);
      });
    } catch (error) {
      logger('warn', `better-mcp-manager: caching the tool list failed: ${error?.message ?? String(error)}`);
    }
  }

  const manager = createManager({
    logger,
    onToolsChange: (serverId) => {
      exposure?.refreshSoon();
      persistToolCache(serverId);
    },
  });
  exposure = createExposure({ hostCtx: ctx, store, manager, logger });

  const api = createApi({
    store,
    manager,
    exposure,
    hostCtx: ctx,
    version: PLUGIN_VERSION,
    dataDir: dir,
    logger,
  });

  /**
   * Converge every connection and refresh exposure; used at mount and after any
   * store mutation the API performs itself.
   * @returns {Promise<void>} completion.
   */
  const converge = async () => {
    await manager.sync(store.list());
    exposure.refreshSoon();
  };

  // Load, converge, and bind the agents that were already live before the
  // plugin mounted. A failure is reported through the panel (each card carries
  // its own error) and the Host log; it never rejects plugin activation.
  const loaded = store.load()
    .then((report) => {
      if (report.dropped > 0 || report.quarantined !== undefined || report.migrated === true) {
        logger('warn', `better-mcp-manager: loaded ${report.loaded} server(s), dropped ${report.dropped}${report.migrated === true ? `, migrated the store to schema version ${STORE_VERSION}` : ''}`
          + (report.quarantined === undefined ? '' : `, quarantined the damaged store to ${report.quarantined}`));
      }
      return converge();
    })
    .then(() => exposure.bindAll())
    .catch((error) => {
      logger('error', `better-mcp-manager: startup failed: ${error?.message ?? error}`);
    });

  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: api.handler,
    });
    return async () => {
      unregister();
      exposure.dispose();
      await loaded.catch(() => {});
      await manager.dispose();
      await store.close().catch(() => {});
    };
  }, 'better-mcp-manager: api and lifecycle');

  ctx.effect(() => {
    const disposers = [];
    const on = (event, listener) => {
      const dispose = ctx.on(event, listener);
      if (typeof dispose === 'function') disposers.push(dispose);
    };
    on('agent/created', (payload) => {
      if (payload?.agent !== undefined) exposure.onAgentCreated(payload.agent);
    });
    on('agent/disposed', (payload) => {
      if (payload?.agent !== undefined) exposure.onAgentDisposed(payload.agent);
    });
    on('agent-preset/selected', (sessionId) => {
      exposure.onPresetSelected(sessionId);
    });
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    };
  }, 'better-mcp-manager: agent lifecycle');

  // `agents` may mount after this plugin; a late service still gets a sweep so
  // sessions opened during startup see their server tools.
  ctx.inject(['agents'], (inner) => {
    inner.effect(() => {
      exposure.bindAll();
      return () => {};
    }, 'better-mcp-manager: late agent sweep');
  });
}
