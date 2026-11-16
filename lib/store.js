/**
 * The plugin's one persistence file.
 *
 * Everything the user configures lives in `$DSH_HOME/better-mcp-manager/servers.json`
 * (contract §2): a versioned object with an ordered server list. The directory is
 * mode `0700` and the file mode `0600`; writes go through a uniquely named temporary
 * file in the same directory followed by `rename`, so a crash never truncates the
 * store. A file that cannot be parsed is quarantined beside itself and the plugin
 * starts empty instead of refusing to mount — the panel reports the count it
 * dropped through the Host log.
 *
 * This module performs no network I/O and no validation of server fields; the HTTP
 * layer normalizes drafts with `model.js` first.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/store
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeStoredIcon } from './model.js';
import { DATA_DIR_NAME } from './version.js';

/** Store schema version written into the file. */
export const STORE_VERSION = 2;

/** Schema versions this build can read (1 = 0.1.0 emoji icons, 2 = 0.2.0 icon objects). */
const READABLE_VERSIONS = new Set([1, 2]);

/** Name of the store file inside the data directory. */
export const STORE_FILE = 'servers.json';

/**
 * Resolve the plugin data directory.
 * @param {Record<string, string | undefined>} [env] - Environment to read (defaults to `process.env`).
 * @returns {string} absolute directory path.
 */
export function resolveDataDir(env = process.env) {
  const explicit = env.DSH_MCP_MANAGER_DATA_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = env.DSH_HOME?.trim();
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh');
  return join(root, DATA_DIR_NAME);
}

/**
 * Validate one loaded record enough to trust its identity fields.
 * @param {unknown} value - One entry of the loaded `servers` array.
 * @returns {boolean} whether the entry looks like a stored server.
 */
function isStoredServer(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.key === 'string'
    && /^[A-Za-z0-9_-]{1,32}$/.test(record.key)
    && typeof record.name === 'string'
    && typeof record.enabled === 'boolean'
    && (record.transport === 'http' || record.transport === 'sse' || record.transport === 'stdio')
    && Array.isArray(record.headers)
    && typeof record.oauth === 'object'
    && record.oauth !== null;
}

/**
 * Create the store over one directory.
 * @param {object} options - Store options.
 * @param {string} options.dir - Absolute data directory.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {() => number} [options.now] - Clock (injectable for tests).
 * @returns {object} the store handle.
 */
export function createStore({ dir, logger = () => {}, now = () => Date.now() }) {
  /** @type {Record<string, any>[]} */
  let servers = [];
  let loaded = false;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  let writeCounter = 0;

  const file = join(dir, STORE_FILE);

  /**
   * Serialize one write behind all earlier writes.
   * @returns {Promise<void>} completion of the queued write.
   */
  const persist = () => {
    const snapshot = JSON.stringify({ version: STORE_VERSION, servers }, null, 2) + '\n';
    const run = async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      writeCounter += 1;
      const tmp = join(dir, `.${STORE_FILE}.${process.pid}.${writeCounter}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, file);
        await chmod(file, 0o600).catch(() => {});
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    };
    queue = queue.then(run, run);
    return queue;
  };

  /**
   * Load the store from disk, quarantining an unreadable file.
   * @returns {Promise<{ loaded: number, dropped: number, quarantined?: string }>} load report.
   */
  const load = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        servers = [];
        loaded = true;
        return { loaded: 0, dropped: 0 };
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const quarantine = join(dir, `${STORE_FILE}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      await rename(file, quarantine).catch(() => {});
      logger('warn', `better-mcp-manager: ${STORE_FILE} is not valid JSON (${error.message}); moved it to ${quarantine} and started empty`);
      servers = [];
      loaded = true;
      return { loaded: 0, dropped: 0, quarantined: quarantine };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !READABLE_VERSIONS.has(parsed.version) || !Array.isArray(parsed.servers)) {
      const quarantine = join(dir, `${STORE_FILE}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      await rename(file, quarantine).catch(() => {});
      logger('warn', `better-mcp-manager: ${STORE_FILE} has an unknown shape or version; moved it to ${quarantine} and started empty`);
      servers = [];
      loaded = true;
      return { loaded: 0, dropped: 0, quarantined: quarantine };
    }
    const valid = parsed.servers.filter(isStoredServer);
    const dropped = parsed.servers.length - valid.length;
    if (dropped > 0) logger('warn', `better-mcp-manager: dropped ${dropped} malformed server record(s) from ${STORE_FILE}`);
    const migrated = parsed.version !== STORE_VERSION;
    // Version 1 stored an emoji string; version 2 stores the icon object. Both
    // narrow through the same helper, so a damaged/unknown icon becomes `auto`
    // instead of dropping the whole record.
    servers = valid.map((record) => ({ ...record, icon: normalizeStoredIcon(record.icon) }));
    loaded = true;
    if (migrated) logger('warn', `better-mcp-manager: migrated ${STORE_FILE} from schema version ${parsed.version} to ${STORE_VERSION}`);
    return { loaded: servers.length, dropped, migrated };
  };

  /**
   * Ensure `load()` ran exactly once.
   * @returns {Promise<void>} readiness.
   */
  const ready = () => {
    if (loaded) return Promise.resolve();
    return load().then(() => {});
  };

  /**
   * Every stored record, in list order (internal references; callers treat them read-only).
   * @returns {Record<string, any>[]} the records.
   */
  const list = () => servers;

  /**
   * Find one record by id.
   * @param {string} id - Server id.
   * @returns {Record<string, any> | undefined} the record.
   */
  const get = (id) => servers.find((server) => server.id === id);

  /**
   * Whether a tool namespace is already taken.
   * @param {string} key - Candidate namespace.
   * @returns {boolean} the answer.
   */
  const keyTaken = (key) => servers.some((server) => server.key === key);

  /**
   * Insert or replace one record, then persist.
   * @param {Record<string, any>} server - Normalized record.
   * @returns {Promise<void>} completion after the write lands.
   */
  const put = async (server) => {
    await ready();
    const index = servers.findIndex((entry) => entry.id === server.id);
    if (index >= 0) servers = servers.map((entry, at) => (at === index ? server : entry));
    else servers = [...servers, server];
    await persist();
  };

  /**
   * Remove one record, then persist when it existed.
   * @param {string} id - Server id.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  const remove = async (id) => {
    await ready();
    const next = servers.filter((server) => server.id !== id);
    if (next.length === servers.length) return false;
    servers = next;
    await persist();
    return true;
  };

  /**
   * The store file path.
   * @returns {string} absolute path.
   */
  const filePath = () => file;

  /**
   * Wait for every queued write.
   * @returns {Promise<void>} completion.
   */
  const close = () => queue;

  return { dir, filePath, load, ready, list, get, keyTaken, put, remove, close };
}
