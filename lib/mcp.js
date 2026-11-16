/**
 * MCP connection supervisor and manager.
 *
 * The plugin owns every MCP connection itself instead of adding Loader rows:
 * that is what lets one server's tools be registered per agent (and therefore
 * per agent preset), and what keeps uninstall clean — nothing outside this
 * process and the one data directory changes.
 *
 * One `createConnection` instance supervises exactly one server:
 *
 * - connect → initialize → `tools/list` → cache tools + instructions;
 * - keep the connection and react to `tools/list_changed`;
 * - on a lost connection, retry with bounded exponential backoff (1s … 30s)
 *   until the server is disabled/removed or the plugin is disposed;
 * - on `callTool`, dispatch through the live client with the managed tool
 *   definition (structured output validation inside the SDK) and the
 *   configured per-call timeout.
 *
 * `createManager` owns the map of server id → connection and reconciles it
 * against the persisted server list, which is the only thing the HTTP API
 * mutates.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/mcp
 */
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { isRasterIcon } from './icons.js';
import { ICON_MIME_EXT, MAX_ICON_BYTES, publicToolName } from './model.js';
import { PLUGIN_VERSION } from './version.js';

/** Connect handshake budget (ms). */
const CONNECT_TIMEOUT_MS = 20_000;
/** `tools/list` budget after a successful handshake (ms). */
const DISCOVERY_TIMEOUT_MS = 20_000;
/** First reconnect delay (ms). */
const RETRY_INITIAL_MS = 1_000;
/** Reconnect delay ceiling (ms). */
const RETRY_MAX_MS = 30_000;
/** Maximum UTF-8 bytes of server instructions injected into a prompt. */
const MAX_INSTRUCTION_BYTES = 32_768;
/** Icons kept per server (contract §2.6). */
const MAX_SERVER_ICONS = 8;
/** Longest `src` string accepted from a server (a data: URL may carry 512 KiB). */
const MAX_ICON_SOURCE_CHARS = Math.ceil(MAX_ICON_BYTES * 4 / 3) + 256;
/** Icon fetch budget for an `http(s)` source (ms). */
const ICON_FETCH_TIMEOUT_MS = 5_000;
/** How long a fetched icon stays cached (ms). */
const ICON_CACHE_TTL_MS = 10 * 60_000;
/** How long a failed fetch is remembered before retrying (ms). */
const ICON_FAILURE_TTL_MS = 60_000;
/** Bytes of child stderr kept for an error's detail text. */
const STDERR_TAIL_BYTES = 4_096;
/** Connection close budget during dispose (ms). */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Await a promise with a deadline.
 * @template T
 * @param {Promise<T>} promise - Promise to await.
 * @param {number} ms - Deadline in milliseconds.
 * @param {string} label - What the deadline names in the timeout message.
 * @returns {Promise<T>} the promise's value.
 * @throws {Error} `code: "timeout"` when the deadline passes first.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms} ms`);
      error.code = 'timeout';
      reject(error);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Truncate a UTF-8 string to a byte budget without splitting a code point.
 * @param {string} text - Source text.
 * @param {number} maxBytes - Byte budget.
 * @returns {string} the possibly truncated text.
 */
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Walk an error's cause chain collecting messages.
 * @param {unknown} error - Thrown value.
 * @returns {string[]} one message per level (outermost first).
 */
function errorChain(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === undefined || current === null) break;
    if (current instanceof Error) {
      messages.push(current.message || current.name);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  if (messages.length === 0) messages.push(String(error));
  return messages;
}

/**
 * Classify a connection/call failure into the contract's stable codes.
 * @param {unknown} error - Thrown value.
 * @returns {"connect-failed" | "auth-failed" | "timeout" | "protocol" | "invalid-config" | "closed"} the code.
 */
function classifyFailure(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string'
    && ['connect-failed', 'auth-failed', 'timeout', 'protocol', 'invalid-config', 'closed'].includes(error.code)) {
    return error.code;
  }
  const text = errorChain(error).join(' ').toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('timeout') || text.includes('timed out') || text.includes('timeout')) return 'timeout';
  // HTTP status wins over wording: SDK failures may carry only a numeric status.
  const statuses = [];
  for (let current = error, depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    if (typeof current !== 'object') break;
    const status = current.status ?? current.statusCode ?? current.response?.status;
    if (typeof status === 'number') statuses.push(status);
    current = current.cause;
  }
  if (statuses.some((status) => status === 401 || status === 403)) return 'auth-failed';
  if (name.includes('unauthorized') || /\b(401|403)\b|unauthorized|invalid[ _-]token|forbidden/.test(text)) return 'auth-failed';
  if (name.includes('protocol') || /\bjson[ _-]?rpc\b|protocol|invalid[ _-]?request|invalid params|method not found|parse error/.test(text)) return 'protocol';
  return 'connect-failed';
}

/**
 * Build the error object reported by the panel.
 * @param {unknown} error - Thrown value.
 * @param {string} [stderrTail] - Child stderr captured for this server, if any.
 * @returns {{ code: string, message: string, detail: string, at: string }} detached error.
 */
function describeFailure(error, stderrTail) {
  const chain = errorChain(error);
  const message = truncateUtf8(chain.join(' — '), 800);
  const parts = [];
  if (error instanceof Error && typeof error.stack === 'string') parts.push(error.stack);
  if (stderrTail !== undefined && stderrTail.trim().length > 0) parts.push(`server stderr (tail):\n${stderrTail.trim()}`);
  return {
    code: classifyFailure(error),
    message,
    detail: truncateUtf8(parts.join('\n\n'), 8_000),
    at: new Date().toISOString(),
  };
}

/**
 * Narrow the `serverInfo.icons` array an MCP server reported at initialize.
 *
 * Unknown fields are dropped; a malformed entry is skipped rather than failing
 * the whole connection. The order is preserved so `pickServerIcon` can apply
 * the theme preference from contract §2.6.
 * @param {unknown} value - `serverInfo.icons`.
 * @returns {{ src: string, mimeType?: string, sizes?: string[], theme?: "light" | "dark" }[]} icons.
 */
export function readServerIcons(value) {
  if (!Array.isArray(value)) return [];
  const icons = [];
  for (const raw of value.slice(0, MAX_SERVER_ICONS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const source = raw.src;
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_ICON_SOURCE_CHARS) continue;
    /** @type {Record<string, any>} */
    const icon = { src: source };
    if (typeof raw.mimeType === 'string' && raw.mimeType.length > 0 && raw.mimeType.length <= 100) icon.mimeType = raw.mimeType;
    if (Array.isArray(raw.sizes) && raw.sizes.every((size) => typeof size === 'string')) icon.sizes = raw.sizes.slice(0, 8);
    if (raw.theme === 'light' || raw.theme === 'dark') icon.theme = raw.theme;
    icons.push(icon);
  }
  return icons;
}

/**
 * Choose the icon to serve: a light/no-theme icon wins over a dark-only one.
 * @param {{ src: string, theme?: "light" | "dark" }[]} icons - Server icons.
 * @returns {{ src: string, theme?: "light" | "dark" } | null} the chosen icon.
 */
export function pickServerIcon(icons) {
  if (!Array.isArray(icons) || icons.length === 0) return null;
  return icons.find((icon) => icon.theme === undefined || icon.theme === 'light') ?? icons[0] ?? null;
}

/**
 * Decode a `data:` icon source into proven raster bytes.
 * @param {string} source - `data:` URL.
 * @returns {{ bytes: Buffer, mimeType: string } | null} decoded image, or null when unacceptable.
 */
export function parseDataIcon(source) {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(source);
  if (match === null) return null;
  const mimeType = match[1].toLowerCase();
  if (ICON_MIME_EXT[mimeType] === undefined) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) return null;
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  if (!isRasterIcon(bytes, mimeType)) return null;
  return { bytes, mimeType };
}

/**
 * Fetch an `http(s)` icon source and prove it is a bounded raster image.
 *
 * Icons are fetched by the Host, never by the browser: the MCP server may sit
 * behind the headers/OAuth the operator configured, and the browser must not be
 * asked to make a cross-origin request for a tile.
 * @param {string} source - Absolute URL.
 * @param {Record<string, string>} headers - Request headers (server's own).
 * @param {typeof fetch} [fetchImpl] - Injectable fetch for tests.
 * @returns {Promise<{ bytes: Buffer, mimeType: string } | null>} image, or null.
 */
export async function fetchIconBytes(source, headers, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(source, {
      headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', ...headers },
      signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (ICON_MIME_EXT[contentType] === undefined) return null;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_BYTES) return null;
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  if (!isRasterIcon(bytes, contentType)) return null;
  return { bytes, mimeType: contentType };
}

/**
 * Detect a 401-ish failure from any error in the cause chain.
 * @param {unknown} error - Thrown value.
 * @returns {boolean} whether a fresh credential may help.
 */
function looksUnauthorized(error) {
  let current = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      if (current.name.toLowerCase().includes('unauthorized')) return true;
      const status = current.status ?? current.statusCode ?? current.response?.status;
      if (status === 401 || status === 403) return true;
      if (/\b(401|403)\b|unauthorized|forbidden/i.test(current.message)) return true;
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Create a client-credentials token source.
 *
 * Tokens are cached until 60 seconds before `expires_in` (5 minutes when the
 * identity provider omits it). A failed fetch throws an error with code
 * `auth-failed` so the panel shows the real reason instead of a bare 401.
 * @param {Record<string, any>} oauth - Normalized `client_credentials` settings.
 * @param {() => number} now - Clock.
 * @returns {{ get: () => Promise<string>, invalidate: () => void }} the token source.
 */
function createTokenSource(oauth, now) {
  let token;
  let expiresAt = 0;
  let inflight;
  const fetchToken = async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: oauth.clientId });
    if (typeof oauth.clientSecret === 'string' && oauth.clientSecret.length > 0) body.set('client_secret', oauth.clientSecret);
    if (typeof oauth.scope === 'string' && oauth.scope.length > 0) body.set('scope', oauth.scope);
    let response;
    try {
      response = await fetch(oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const wrapped = new Error(`token endpoint is unreachable: ${errorChain(error).join(' — ')}`);
      wrapped.code = 'auth-failed';
      wrapped.cause = error;
      throw wrapped;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const wrapped = new Error(`token endpoint answered HTTP ${response.status}${text ? `: ${truncateUtf8(text, 400)}` : ''}`);
      wrapped.code = 'auth-failed';
      throw wrapped;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const wrapped = new Error(`token endpoint returned invalid JSON: ${error.message}`);
      wrapped.code = 'auth-failed';
      throw wrapped;
    }
    if (typeof payload?.access_token !== 'string' || payload.access_token.length === 0) {
      const wrapped = new Error('token endpoint returned no access_token');
      wrapped.code = 'auth-failed';
      throw wrapped;
    }
    const lifetimeMs = Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? Math.max(5_000, payload.expires_in * 1000 - 60_000)
      : 5 * 60_000;
    token = payload.access_token;
    expiresAt = now() + lifetimeMs;
    return token;
  };
  return {
    get: async () => {
      if (typeof token === 'string' && now() < expiresAt) return token;
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate: () => {
      token = undefined;
      expiresAt = 0;
    },
  };
}

/**
 * Merge custom headers with the configured credential.
 *
 * A custom `Authorization` header always wins: the operator typed an exact
 * credential and an OAuth shortcut must not silently replace it.
 * @param {Record<string, any>} server - Stored server.
 * @param {(oauth: Record<string, any>) => { get: () => Promise<string>, invalidate: () => void }} tokensFor - Token-source factory.
 * @returns {Promise<Record<string, string>>} request headers.
 */
async function buildHeaders(server, tokensFor) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const header of server.headers) headers[header.name] = header.value;
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
  if (hasAuthorization) return headers;
  if (server.oauth?.mode === 'bearer' && typeof server.oauth.token === 'string' && server.oauth.token.length > 0) {
    headers.Authorization = `Bearer ${server.oauth.token}`;
    return headers;
  }
  if (server.oauth?.mode === 'client_credentials') {
    const token = await tokensFor(server.oauth).get();
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Build an unconnected MCP transport for one server.
 * @param {Record<string, any>} server - Stored server.
 * @param {object} hooks - Transport hooks.
 * @param {(oauth: Record<string, any>) => { get: () => Promise<string>, invalidate: () => void }} hooks.tokensFor - Token-source factory.
 * @param {(chunk: string) => void} hooks.onStderr - Child stderr sink (stdio only).
 * @returns {Promise<{ transport: import('@modelcontextprotocol/client').Transport, close: () => Promise<void>, retryFreshToken: () => boolean }>} the transport bundle.
 */
async function buildTransport(server, { tokensFor, onStderr }) {
  if (server.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...getDefaultEnvironment(), ...server.env },
      ...(server.cwd.length > 0 ? { cwd: server.cwd } : {}),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => onStderr(String(chunk)));
    return {
      transport,
      close: async () => {
        await transport.close();
      },
      retryFreshToken: () => false,
    };
  }
  const url = new URL(server.url);
  const tokens = server.oauth?.mode === 'client_credentials' ? tokensFor(server.oauth) : undefined;
  const headers = await buildHeaders(server, tokensFor);
  const transport = server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  return {
    transport,
    close: async () => {
      await transport.close();
    },
    retryFreshToken: () => {
      if (tokens === undefined) return false;
      tokens.invalidate();
      return true;
    },
  };
}

/**
 * Create the supervisor for one server.
 *
 * The returned handle never throws from its lifecycle methods; every problem is
 * reported through `snapshot()` so the panel can show it. `tools()` is empty
 * while disconnected, which keeps dead tools out of live agents.
 *
 * @param {object} options - Supervisor options.
 * @param {Record<string, any>} options.server - Initial stored record.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {(serverId: string) => void} [options.onToolsChange] - Called after the live tool set changes.
 * @param {() => number} [options.now] - Clock.
 * @returns {object} the connection handle.
 */
export function createConnection({ server, logger = () => {}, onToolsChange = () => {}, now = () => Date.now() }) {
  let record = server;
  let disposed = false;
  let running = false;
  /** @type {import('@modelcontextprotocol/client').Client | undefined} */
  let client;
  /** @type {(() => Promise<void>) | undefined} */
  let closeTransport;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  let attemptGeneration = 0;
  let stderrTail = '';
  const tokenSources = new Map();

  const state = {
    status: 'disabled',
    error: /** @type {null | Record<string, any>} */ (null),
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    connectedAt: null,
    tools: /** @type {Record<string, any>[]} */ ([]),
    icons: /** @type {{ src: string, mimeType?: string, sizes?: string[], theme?: "light" | "dark" }[]} */ ([]),
    instructions: '',
    instructionsTotalBytes: 0,
  };

  /** @type {Map<string, { value: { bytes: Buffer, mimeType: string } | null, expiresAt: number }>} */
  let iconCache = new Map();
  /** @type {Map<string, Promise<{ bytes: Buffer, mimeType: string } | null>>} */
  let iconInflight = new Map();

  /** @type {Map<string, Record<string, any>>} */
  let toolsByRawName = new Map();

  const tokensFor = (oauth) => {
    const cacheKey = JSON.stringify(oauth);
    let source = tokenSources.get(cacheKey);
    if (source === undefined) {
      source = createTokenSource(oauth, now);
      tokenSources.set(cacheKey, source);
    }
    return source;
  };

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    state.nextRetryAt = null;
  };

  const closeCurrent = async () => {
    const close = closeTransport;
    const current = client;
    closeTransport = undefined;
    client = undefined;
    if (current !== undefined) {
      current.onclose = undefined;
      current.onerror = undefined;
    }
    if (close !== undefined) {
      await withTimeout(close(), CLOSE_TIMEOUT_MS, 'transport close').catch((error) => {
        logger('warn', `better-mcp-manager(${record.name}): transport close was not confirmed: ${errorChain(error).join(' — ')}`);
      });
    }
  };

  const adoptTools = (tools) => {
    const next = [];
    const byRawName = new Map();
    const seenPublic = new Set();
    for (const tool of tools) {
      if (typeof tool?.name !== 'string' || tool.name.length === 0) continue;
      const entry = {
        rawName: tool.name,
        publicName: publicToolName(record.key, tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        tool,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        outputSchema: tool.outputSchema,
        taskRequired: tool.execution?.taskSupport === 'required',
      };
      if (seenPublic.has(entry.publicName)) {
        logger('warn', `better-mcp-manager(${record.name}): server listed two tools whose public names collide ("${entry.publicName}"); keeping the first`);
        continue;
      }
      seenPublic.add(entry.publicName);
      next.push(entry);
      byRawName.set(entry.rawName, entry);
    }
    state.tools = next;
    toolsByRawName = byRawName;
  };

  const setStatus = (status) => {
    const changed = state.status !== status;
    state.status = status;
    return changed;
  };

  /** Drop cached/observed server icons (disconnect, reconnect, version change). */
  const resetIcons = () => {
    state.icons = [];
    iconCache = new Map();
    iconInflight = new Map();
  };

  const scheduleRetry = () => {
    if (disposed || !running || !record.enabled) return;
    const exponent = Math.min(Math.max(state.attempts - 1, 0), 5);
    const delay = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** exponent);
    state.nextRetryAt = new Date(now() + delay).toISOString();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delay);
    retryTimer.unref?.();
  };

  const handleLost = () => {
    if (disposed || !running) return;
    if (state.status !== 'connected') return;
    void closeCurrent();
    state.tools = [];
    toolsByRawName = new Map();
    resetIcons();
    state.instructions = '';
    state.instructionsTotalBytes = 0;
    state.connectedAt = null;
    state.error = {
      code: 'closed',
      message: 'the MCP server closed the connection',
      detail: stderrTail.trim().length > 0 ? truncateUtf8(`server stderr (tail):\n${stderrTail.trim()}`, 8_000) : '',
      at: new Date().toISOString(),
    };
    state.attempts = 1;
    setStatus('error');
    onToolsChange(record.id);
    scheduleRetry();
  };

  /**
   * One connection attempt.
   * @param {boolean} [freshToken] - Retry once with a refreshed client-credentials token.
   * @returns {Promise<void>} settles when the attempt is adopted or reported.
   */
  const attempt = async (freshToken = false) => {
    if (disposed || !running) return;
    const generation = ++attemptGeneration;
    clearRetry();
    stderrTail = '';
    state.lastAttemptAt = new Date(now()).toISOString();
    state.error = null;
    state.connectedAt = null;
    setStatus('connecting');
    let activeClient;
    let activeClose;
    try {
      const built = await buildTransport(record, {
        tokensFor,
        onStderr: (chunk) => {
          stderrTail = truncateUtf8(stderrTail + chunk, STDERR_TAIL_BYTES);
        },
      });
      activeClose = built.close;
      activeClient = new Client(
        { name: 'dsh-better-mcp-manager', version: PLUGIN_VERSION },
        {
          listChanged: {
            tools: {
              onChanged: (error, tools) => {
                if (generation !== attemptGeneration || disposed) return;
                if (error !== undefined) {
                  logger('warn', `better-mcp-manager(${record.name}): refreshing the tool list failed: ${errorChain(error).join(' — ')}`);
                  return;
                }
                if (!Array.isArray(tools)) return;
                adoptTools(tools);
                onToolsChange(record.id);
              },
            },
          },
        },
      );
      await withTimeout(activeClient.connect(built.transport), CONNECT_TIMEOUT_MS, `connection to "${record.name}"`);
      const capabilities = activeClient.getServerCapabilities?.();
      let tools = [];
      if (capabilities?.tools !== undefined) {
        const listed = await withTimeout(activeClient.listTools(undefined, { cacheMode: 'refresh', timeout: DISCOVERY_TIMEOUT_MS }), DISCOVERY_TIMEOUT_MS + 2_000, `tools/list from "${record.name}"`);
        tools = listed.tools;
      }
      const rawInstructions = typeof activeClient.getInstructions === 'function' ? (activeClient.getInstructions() ?? '') : '';
      const instructions = truncateUtf8(rawInstructions, MAX_INSTRUCTION_BYTES);
      if (generation !== attemptGeneration || disposed) {
        await withTimeout(activeClient.close(), CLOSE_TIMEOUT_MS, 'late close').catch(() => {});
        return;
      }
      client = activeClient;
      closeTransport = built.close;
      activeClient.onclose = handleLost;
      activeClient.onerror = (error) => {
        logger('warn', `better-mcp-manager(${record.name}): transport error: ${errorChain(error).join(' — ')}`);
      };
      adoptTools(tools);
      resetIcons();
      state.icons = readServerIcons(activeClient.getServerVersion?.()?.icons);
      state.instructions = instructions;
      state.instructionsTotalBytes = Buffer.byteLength(rawInstructions, 'utf8');
      state.attempts = 0;
      state.error = null;
      state.nextRetryAt = null;
      state.connectedAt = new Date(now()).toISOString();
      setStatus('connected');
      onToolsChange(record.id);
    } catch (error) {
      if (generation !== attemptGeneration) return;
      if (activeClient !== undefined) {
        activeClient.onclose = undefined;
        activeClient.onerror = undefined;
        await withTimeout(activeClient.close(), CLOSE_TIMEOUT_MS, 'failed close').catch(() => {});
      } else if (activeClose !== undefined) {
        await withTimeout(activeClose(), CLOSE_TIMEOUT_MS, 'failed close').catch(() => {});
      }
      if (disposed) return;
      // A client-credentials token can expire between runs (or be revoked);
      // exactly one immediate retry with a fresh token covers that case.
      if (!freshToken && record.transport !== 'stdio' && looksUnauthorized(error)) {
        const tokens = record.oauth?.mode === 'client_credentials' ? tokensFor(record.oauth) : undefined;
        if (tokens !== undefined) {
          tokens.invalidate();
          state.attempts = Math.max(state.attempts, 0);
          setStatus('connecting');
          await attempt(true);
          return;
        }
      }
      state.tools = [];
      toolsByRawName = new Map();
      resetIcons();
      state.instructions = '';
      state.instructionsTotalBytes = 0;
      state.connectedAt = null;
      state.error = describeFailure(error, stderrTail);
      state.attempts += 1;
      setStatus('error');
      onToolsChange(record.id);
      scheduleRetry();
      logger('warn', `better-mcp-manager(${record.name}): connection failed (${state.error.code}): ${state.error.message}`);
    }
  };

  const start = () => {
    if (disposed || running) return;
    if (!record.enabled) {
      setStatus('disabled');
      return;
    }
    running = true;
    void attempt();
  };

  const stop = async () => {
    running = false;
    attemptGeneration += 1;
    clearRetry();
    await closeCurrent();
    state.tools = [];
    toolsByRawName = new Map();
    resetIcons();
    state.instructions = '';
    state.instructionsTotalBytes = 0;
    state.connectedAt = null;
    if (!record.enabled) {
      state.status = 'disabled';
      state.error = null;
    } else {
      state.status = 'disabled';
    }
  };

  /**
   * Replace the stored record; restart only when the connection configuration changed.
   * @param {Record<string, any>} next - Normalized stored record.
   * @returns {Promise<void>} completion after the change was applied.
   */
  const update = async (next) => {
    const previous = record;
    record = next;
    const signature = (value) => JSON.stringify([value.transport, value.url, value.command, value.args, value.env, value.cwd, value.headers, value.oauth]);
    const configChanged = signature(previous) !== signature(next);
    const enabledChanged = previous.enabled !== next.enabled;
    if (!next.enabled) {
      if (running || enabledChanged || configChanged) await stop();
      state.status = 'disabled';
      state.error = null;
      state.lastAttemptAt = null;
      state.nextRetryAt = null;
      return;
    }
    if (!running) {
      start();
      return;
    }
    if (enabledChanged || configChanged) {
      await stop();
      state.error = null;
      running = true;
      void attempt();
    }
  };

  const reconnect = async () => {
    if (disposed || !record.enabled) return;
    if (!running) {
      start();
      return;
    }
    attemptGeneration += 1;
    clearRetry();
    await closeCurrent();
    state.tools = [];
    toolsByRawName = new Map();
    resetIcons();
    state.instructions = '';
    state.instructionsTotalBytes = 0;
    state.attempts = 0;
    state.error = null;
    state.status = 'connecting';
    void attempt();
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await stop();
    clearRetry();
  };

  /**
   * The status object the panel reads (contract §2.3).
   * @returns {Record<string, any>} detached snapshot.
   */
  const snapshot = () => ({
    serverId: record.id,
    state: record.enabled ? state.status : 'disabled',
    transportLabel: record.transport === 'stdio' ? '内置' : record.transport.toUpperCase(),
    toolCount: state.tools.length,
    discoveredCount: state.tools.length,
    instructionsBytes: state.instructionsTotalBytes,
    error: state.error,
    attempts: state.attempts,
    connectedAt: state.connectedAt,
    lastAttemptAt: state.lastAttemptAt,
    nextRetryAt: state.nextRetryAt,
  });

  /**
   * Live tool descriptors (empty while disconnected).
   * @returns {Record<string, any>[]} the tools.
   */
  const tools = () => state.tools;

  /**
   * Server icons as reported at initialize (detached copies).
   * @returns {Record<string, any>[]} the icons.
   */
  const icons = () => state.icons.map((icon) => ({ ...icon }));

  /**
   * Resolve the automatic icon: the MCP server's own icon, fetched/cached.
   * @returns {Promise<{ bytes: Buffer, mimeType: string } | null>} image, or null.
   */
  const autoIcon = async () => {
    if (state.status !== 'connected') return null;
    const icon = pickServerIcon(state.icons);
    if (icon === null) return null;
    const cached = iconCache.get(icon.src);
    if (cached !== undefined && cached.expiresAt > now()) return cached.value;
    const pending = iconInflight.get(icon.src);
    if (pending !== undefined) return pending;
    const job = (async () => {
      let value = null;
      try {
        if (/^data:/iu.test(icon.src)) {
          value = parseDataIcon(icon.src);
        } else if (/^https?:/iu.test(icon.src)) {
          const headers = record.transport === 'stdio' ? {} : await buildHeaders(record, tokensFor);
          value = await fetchIconBytes(icon.src, headers);
        }
      } catch (error) {
        logger('warn', `better-mcp-manager(${record.name}): fetching the server icon failed: ${errorChain(error).join(' — ')}`);
        value = null;
      }
      iconCache.set(icon.src, { value, expiresAt: now() + (value === null ? ICON_FAILURE_TTL_MS : ICON_CACHE_TTL_MS) });
      return value;
    })().finally(() => iconInflight.delete(icon.src));
    iconInflight.set(icon.src, job);
    return job;
  };

  /**
   * Server instructions, truncated to the prompt budget.
   * @returns {string} instructions text.
   */
  const instructions = () => state.instructions;

  /**
   * Resolve one live tool descriptor by its MCP wire name.
   * @param {string} rawName - MCP tool name.
   * @returns {Record<string, any> | undefined} the descriptor.
   */
  const tool = (rawName) => toolsByRawName.get(rawName);

  /**
   * Call one tool on the live connection.
   * @param {string} rawName - MCP tool name.
   * @param {Record<string, unknown>} args - Model arguments.
   * @param {{ signal?: AbortSignal }} [execution] - Exact tool execution.
   * @returns {Promise<unknown>} the raw MCP result.
   */
  const callTool = async (rawName, args, execution) => {
    const descriptor = toolsByRawName.get(rawName);
    if (descriptor === undefined) throw new Error(`"${record.name}" no longer offers tool "${rawName}"`);
    if (client === undefined || state.status !== 'connected') {
      throw new Error(`MCP server "${record.name}" is not connected${state.error?.message ? `: ${state.error.message}` : ''}`);
    }
    return client.callTool(
      { name: descriptor.rawName, arguments: args ?? {} },
      {
        signal: execution?.signal,
        timeout: record.timeoutMs,
        toolDefinition: descriptor.tool,
      },
    );
  };

  return {
    get server() {
      return record;
    },
    start,
    stop,
    update,
    reconnect,
    dispose,
    snapshot,
    tools,
    icons,
    autoIcon,
    instructions,
    tool,
    callTool,
    get running() {
      return running;
    },
  };
}

/**
 * Create the manager that reconciles connections against the persisted list.
 * @param {object} options - Manager options.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {(serverId: string) => void} [options.onToolsChange] - Called after any server's live tool set changes.
 * @returns {object} the manager handle.
 */
export function createManager({ logger = () => {}, onToolsChange = () => {} } = {}) {
  /** @type {Map<string, ReturnType<typeof createConnection>>} */
  const connections = new Map();
  let disposed = false;

  /**
   * Apply the complete persisted server list.
   * @param {Record<string, any>[]} servers - Normalized records.
   * @returns {Promise<void>} completion after every connection converged or started.
   */
  const sync = async (servers) => {
    if (disposed) return;
    const seen = new Set();
    for (const server of servers) {
      seen.add(server.id);
      const existing = connections.get(server.id);
      if (existing === undefined) {
        const connection = createConnection({ server, logger, onToolsChange });
        connections.set(server.id, connection);
        connection.start();
        continue;
      }
      await existing.update(server);
    }
    for (const [id, connection] of [...connections.entries()]) {
      if (seen.has(id)) continue;
      connections.delete(id);
      await connection.dispose();
    }
  };

  /**
   * The supervisor for one server.
   * @param {string} id - Server id.
   * @returns {ReturnType<typeof createConnection> | undefined} the connection.
   */
  const get = (id) => connections.get(id);

  /**
   * Live status of one server, or a `disabled` placeholder for an unknown id.
   * @param {string} id - Server id.
   * @returns {Record<string, any>} the snapshot.
   */
  const status = (id) => connections.get(id)?.snapshot() ?? {
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

  /**
   * Resolve one server's automatic icon (contract §2.6).
   * @param {string} id - Server id.
   * @returns {Promise<{ bytes: Buffer, mimeType: string } | null>} image, or null.
   */
  const icon = async (id) => {
    const connection = connections.get(id);
    if (connection === undefined) return null;
    return connection.autoIcon();
  };

  /**
   * Reconnect one server now.
   * @param {string} id - Server id.
   * @returns {Promise<void>} completion after the attempt was scheduled.
   */
  const reconnect = async (id) => {
    await connections.get(id)?.reconnect();
  };

  /**
   * Dispatch a tool call through the owning connection.
   * @param {string} id - Server id.
   * @param {string} rawName - MCP tool name.
   * @param {Record<string, unknown>} args - Model arguments.
   * @param {{ signal?: AbortSignal }} [execution] - Exact tool execution.
   * @returns {Promise<unknown>} the raw MCP result.
   */
  const callTool = async (id, rawName, args, execution) => {
    const connection = connections.get(id);
    if (connection === undefined) throw new Error('that MCP server is no longer configured');
    return connection.callTool(rawName, args, execution);
  };

  /**
   * Stop every connection and forget them.
   * @returns {Promise<void>} completion after all connections closed.
   */
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const all = [...connections.values()];
    connections.clear();
    await Promise.all(all.map((connection) => connection.dispose().catch((error) => {
      logger('warn', `better-mcp-manager: closing a connection failed: ${errorChain(error).join(' — ')}`);
    })));
  };

  return { sync, get, status, icon, reconnect, callTool, dispose };
}

/**
 * Test-only surface.
 *
 * These helpers are private implementation detail but are deterministic, pure
 * (except `buildTransport`, which only constructs an object) and central to the
 * contract, so the offline unit suite exercises them directly instead of
 * asserting through a socket. Nothing in the shipped Host path reads this
 * object.
 */
export const __mcpTest = {
  createTokenSource,
  buildHeaders,
  readServerIcons,
  pickServerIcon,
  parseDataIcon,
  fetchIconBytes,
  classifyFailure,
  describeFailure,
  errorChain,
  truncateUtf8,
};
