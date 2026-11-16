/**
 * The panel's HTTP surface.
 *
 * One `prefix` route on the Host web server serves every read and mutation the
 * page needs; the panel polls `GET /servers` and never opens a second channel.
 * Mutations are same-origin JSON, capped at 64 KiB, and answer with the affected
 * record (plus its live status) so the page needs no follow-up round trip.
 *
 * Plain `node:http` request/response objects keep the router unit-testable
 * without a Host: `createApi(...).handler(req, res)` is the whole contract.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/api
 */
import { asHttpError, assertSameOrigin, HttpError, readJson, sendError, sendJson } from './http.js';
import { createConnection } from './mcp.js';
import { InputError, normalizeDraft, serverView } from './model.js';
import { API_PREFIX } from './version.js';

/** Route pattern for one server id. */
const SERVER_ROUTE = /^\/servers\/([^/]+)$/u;
/** Route pattern for one server action. */
const SERVER_ACTION_ROUTE = /^\/servers\/([^/]+)\/(enabled|reconnect)$/u;

/**
 * Read the current preset roster from the Host.
 * @param {object} ctx - Host plugin context.
 * @returns {Promise<{ id: string, name: string, description: string, order: number, broken?: string }[]>} roster rows.
 */
async function readRoster(ctx) {
  try {
    const presets = ctx.get('agentPresets');
    if (presets === undefined || typeof presets.list !== 'function') return [];
    const list = await presets.list();
    if (!Array.isArray(list)) return [];
    return list
      .filter((preset) => typeof preset?.id === 'string' && preset.id.length > 0)
      .map((preset) => ({
        id: preset.id,
        name: typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : preset.id,
        description: typeof preset.description === 'string' ? preset.description : '',
        order: Number.isFinite(preset.order) ? preset.order : 0,
        ...(typeof preset.broken === 'string' ? { broken: preset.broken } : {}),
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/**
 * Build the HTTP router.
 * @param {object} options - Router options.
 * @param {Record<string, any>} options.store - The server store.
 * @param {Record<string, any>} options.manager - The connection manager.
 * @param {Record<string, any>} options.exposure - The per-preset exposure controller.
 * @param {object} options.hostCtx - Host plugin context.
 * @param {string} options.version - Plugin version.
 * @param {string} options.dataDir - Plugin data directory (reported to the panel).
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {() => number} [options.now] - Clock.
 * @returns {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }} the router.
 */
export function createApi({ store, manager, exposure, hostCtx, version, dataDir, logger = () => {}, now = () => Date.now() }) {
  const startedAt = now();

  /**
   * The panel's view of one stored record.
   * @param {Record<string, any>} server - Stored record.
   * @returns {Record<string, any>} view + status.
   */
  const withStatus = (server) => ({ ...serverView(server), status: manager.status(server.id) });

  /**
   * Validate a draft against the current roster and persistence order.
   * @param {unknown} body - Request body.
   * @param {Record<string, any>} [existing] - Record being updated.
   * @param {Awaited<ReturnType<typeof readRoster>>} roster - Preset roster.
   * @returns {Record<string, any>} normalized record.
   */
  const normalize = (body, existing, roster) => normalizeDraft(body, {
    existing,
    keyTaken: (key) => store.keyTaken(key),
    presets: roster,
    now,
  });

  /**
   * Persist one normalized record, converge connections, refresh exposure.
   * @param {Record<string, any>} server - Normalized record.
   * @returns {Promise<Record<string, any>>} the view + status answer.
   */
  const save = async (server) => {
    await store.put(server);
    await manager.sync(store.list());
    exposure.refreshSoon();
    return withStatus(server);
  };

  /**
   * Test an unsaved draft by opening a short-lived supervised connection.
   * @param {Record<string, any>} draft - Normalized (unstored) record.
   * @returns {Promise<Record<string, any>>} the terminal status snapshot.
   */
  const probe = async (draft) => {
    const temporary = { ...draft, id: 'srv_probe', enabled: true };
    const connection = createConnection({
      server: temporary,
      logger,
      now,
    });
    try {
      connection.start();
      const deadline = Date.now() + 15_000;
      let snapshot = connection.snapshot();
      while (Date.now() < deadline) {
        snapshot = connection.snapshot();
        if (snapshot.state === 'connected' || snapshot.state === 'error' || snapshot.state === 'disabled') break;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100);
          timer.unref?.();
        });
      }
      return { ...snapshot, serverId: undefined };
    } finally {
      await connection.dispose();
    }
  };

  /**
   * Dispatch one request after the prefix was stripped.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @param {string} path - Path below the API prefix.
   * @returns {Promise<void>} completion after the response was written.
   */
  const route = async (req, res, path) => {
    const method = String(req.method ?? 'GET').toUpperCase();

    if (path === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, version, pid: process.pid, uptimeMs: now() - startedAt });
      return;
    }

    if (path === '/servers' && method === 'GET') {
      const roster = await readRoster(hostCtx);
      const groups = [];
      for (const server of store.list()) {
        if (server.group.length > 0 && !groups.includes(server.group)) groups.push(server.group);
      }
      sendJson(res, 200, {
        ok: true,
        servers: store.list().map(withStatus),
        presets: roster,
        groups,
        version,
        dataDir,
      });
      return;
    }

    if (path === '/servers' && method === 'POST') {
      assertSameOrigin(req);
      const body = await readJson(req);
      const roster = await readRoster(hostCtx);
      const server = normalize(body, undefined, roster);
      sendJson(res, 201, { ok: true, server: await save(server) });
      return;
    }

    if (path === '/servers/test' && method === 'POST') {
      assertSameOrigin(req);
      const body = await readJson(req);
      const roster = await readRoster(hostCtx);
      const draft = normalize(body, undefined, roster);
      sendJson(res, 200, { ok: true, status: await probe(draft) });
      return;
    }

    if (path === '/presets' && method === 'GET') {
      sendJson(res, 200, { ok: true, presets: await readRoster(hostCtx) });
      return;
    }

    if (path === '/agents' && method === 'GET') {
      sendJson(res, 200, { ok: true, agents: exposure.list() });
      return;
    }

    const actionMatch = SERVER_ACTION_ROUTE.exec(path);
    if (actionMatch !== null) {
      const [, id, action] = actionMatch;
      const existing = store.get(id);
      if (existing === undefined) throw new HttpError(404, 'not-found', `no MCP server with id ${id}`);
      if (method !== 'POST') throw new HttpError(405, 'method-not-allowed', `POST is required for /servers/:id/${action}`);
      assertSameOrigin(req);
      if (action === 'enabled') {
        const body = await readJson(req);
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'invalid-enabled', 'enabled must be a boolean');
        const roster = await readRoster(hostCtx);
        const server = normalize({ ...serverView(existing), enabled: body.enabled }, existing, roster);
        sendJson(res, 200, { ok: true, server: await save(server) });
        return;
      }
      await manager.reconnect(id);
      exposure.refreshSoon();
      sendJson(res, 200, { ok: true, server: withStatus(store.get(id) ?? existing) });
      return;
    }

    const serverMatch = SERVER_ROUTE.exec(path);
    if (serverMatch !== null) {
      const [, id] = serverMatch;
      const existing = store.get(id);
      if (existing === undefined) throw new HttpError(404, 'not-found', `no MCP server with id ${id}`);
      if (method === 'GET') {
        const connection = manager.get(id);
        const tools = connection === undefined ? [] : connection.tools().map((tool) => ({
          name: tool.rawName,
          publicName: tool.publicName,
          description: tool.description,
        }));
        sendJson(res, 200, { ok: true, server: { ...withStatus(existing), tools } });
        return;
      }
      if (method === 'PUT') {
        assertSameOrigin(req);
        const body = await readJson(req);
        const roster = await readRoster(hostCtx);
        const server = normalize(body, existing, roster);
        sendJson(res, 200, { ok: true, server: await save(server) });
        return;
      }
      if (method === 'DELETE') {
        assertSameOrigin(req);
        const removed = await store.remove(id);
        if (!removed) throw new HttpError(404, 'not-found', `no MCP server with id ${id}`);
        await manager.sync(store.list());
        exposure.refreshSoon();
        sendJson(res, 200, { ok: true, deleted: true });
        return;
      }
      throw new HttpError(405, 'method-not-allowed', `${method} is not supported for /servers/:id`);
    }

    throw new HttpError(404, 'not-found', `unknown API path ${path}`);
  };

  /**
   * The web-server route handler.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @returns {Promise<void>} completion after the response was written.
   */
  const handler = async (req, res) => {
    let path = '/';
    try {
      const url = new URL(String(req.url ?? '/'), 'http://localhost');
      path = url.pathname;
      if (path.startsWith(API_PREFIX)) path = path.slice(API_PREFIX.length);
      if (path.length === 0) path = '/';
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      await route(req, res, path);
    } catch (error) {
      if (error instanceof InputError) {
        const httpError = new HttpError(400, error.code, error.message);
        if (typeof error.field === 'string') httpError.field = error.field;
        sendError(res, httpError);
        return;
      }
      const httpError = asHttpError(error);
      if (httpError.status >= 500) logger('error', `better-mcp-manager: API request ${String(req.method)} ${path} failed: ${httpError.message}`);
      sendError(res, httpError);
    }
  };

  return { handler, withStatus };
}
