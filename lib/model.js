/**
 * Server model: validation, normalization, identity and tool naming.
 *
 * One `Server` record is the whole user-visible configuration of one MCP
 * server (contract §2.1). `normalizeDraft` is the only writer-side constructor:
 * it trims and validates every field, drops unknown ones, freezes `id`/`key`/
 * `createdAt` on update, and derives a stable, unique tool namespace for a new
 * record. Every validation failure is an `InputError` carrying a stable code and
 * the field that caused it, which the HTTP layer turns into a `400`.
 *
 * Nothing here touches the filesystem or the network; that keeps the rules
 * unit-testable and keeps `store.js` dumb.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/model
 */
import { createHash, randomBytes } from 'node:crypto';

/** Selectable icon-tile colors. */
export const SERVER_COLORS = Object.freeze(['blue', 'violet', 'teal', 'green', 'amber', 'rose', 'slate']);

/** Accepted uploaded-icon media types and their stored file extensions. */
export const ICON_MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

/** Largest accepted icon upload, decoded (bytes). */
export const MAX_ICON_BYTES = 512 * 1024;

/** Largest icon-upload JSON body, base64 envelope included (bytes). */
export const MAX_ICON_JSON_BYTES = 1024 * 1024;

/** Stored-icon file name grammar (the id plus one extension). */
const ICON_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{2,5}$/u;

/** The automatic icon, used whenever the operator has not uploaded one. */
export const AUTO_ICON = Object.freeze({ kind: 'auto' });

/** Tool names accepted from a server or the tools endpoint. */
const TOOL_NAME_PATTERN = /^\S{1,128}$/u;

/** Maximum tool overrides kept per server. */
export const MAX_TOOL_OVERRIDES = 500;

/** Maximum tools retained in the offline cache. */
export const MAX_CACHED_TOOLS = 300;

/** Maximum description characters retained per cached tool. */
export const MAX_CACHED_DESCRIPTION = 2_000;

/** Maximum parameter chips retained per cached tool. */
export const MAX_CACHED_PARAMS = 64;

/** Selectable transports. */
export const TRANSPORTS = Object.freeze(['http', 'sse', 'stdio']);

/** Short transport label shown on a server card. */
export const TRANSPORT_LABELS = Object.freeze({ http: 'HTTP', sse: 'SSE', stdio: '内置' });

/** OAuth modes accepted by the form. */
export const OAUTH_MODES = Object.freeze(['none', 'bearer', 'client_credentials']);

/** Default per-call timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Attribute-free HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** One invalid draft field. */
export class InputError extends Error {
  /**
   * @param {string} code - Stable machine code (`invalid-name`, `invalid-url`, …).
   * @param {string} message - Human-readable explanation naming the field.
   * @param {string} [field] - Field path for form highlighting.
   */
  constructor(code, message, field) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Read a string field with a length bound.
 * @param {unknown} value - Raw value.
 * @param {object} options - Field options.
 * @param {string} options.field - Field path for diagnostics.
 * @param {number} options.max - Maximum length in UTF-16 code units.
 * @param {number} [options.min] - Minimum length; defaults to 0.
 * @param {string} [options.code] - Error code for a wrong type or length.
 * @returns {string} the trimmed value.
 * @throws {InputError} on a wrong type or an out-of-bounds length.
 */
function readString(value, { field, max, min = 0, code = 'invalid-field' }) {
  if (value === undefined || value === null) {
    if (min > 0) throw new InputError(code, `${field} is required`, field);
    return '';
  }
  if (typeof value !== 'string') throw new InputError(code, `${field} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new InputError(code, `${field} is required`, field);
  if (trimmed.length > max) throw new InputError(code, `${field} must be at most ${max} characters`, field);
  return trimmed;
}

/**
 * Read a boolean field.
 * @param {unknown} value - Raw value.
 * @param {string} field - Field path for diagnostics.
 * @param {boolean} fallback - Value used when the field is absent.
 * @returns {boolean} the value.
 * @throws {InputError} on a wrong type.
 */
function readBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new InputError('invalid-field', `${field} must be a boolean`, field);
  return value;
}

/**
 * Read an integer field inside a closed range.
 * @param {unknown} value - Raw value.
 * @param {string} field - Field path for diagnostics.
 * @param {number} fallback - Value used when the field is absent.
 * @param {number} min - Inclusive minimum.
 * @param {number} max - Inclusive maximum.
 * @returns {number} the integer.
 * @throws {InputError} on a wrong type or an out-of-range value.
 */
function readInteger(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError('invalid-field', `${field} must be an integer between ${min} and ${max}`, field);
  }
  return value;
}

/**
 * Derive the tool namespace a name proposes.
 *
 * ASCII-only on purpose: the namespace is part of a model-facing function name,
 * which accepts `[A-Za-z0-9_-]` only. A CJK name therefore yields an empty slug
 * and falls back to an id-derived namespace.
 * @param {string} name - User-facing server name.
 * @returns {string} a slug of at most 32 characters (possibly empty).
 */
export function keyFromName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase()
    .slice(0, 32);
}

/**
 * Pick a namespace not present in `used`.
 * @param {string} base - Proposed slug (may be empty).
 * @param {string} fallbackSuffix - Id suffix used when the slug is empty.
 * @param {(key: string) => boolean} used - Predicate returning true for a taken key.
 * @returns {string} a key of at most 32 characters.
 */
export function allocateKey(base, fallbackSuffix, used) {
  const seed = base.length > 0 ? base : `mcp-${String(fallbackSuffix).slice(-10)}`;
  let key = seed.slice(0, 32);
  let attempt = 0;
  while (used(key)) {
    attempt += 1;
    const hash = createHash('sha256').update(`${seed}\0${attempt}`, 'utf8').digest('hex').slice(0, 4);
    key = `${seed.slice(0, 27)}-${hash}`;
  }
  return key;
}

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only [A-Za-z0-9_-]. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;

/**
 * Derive the model-facing public name of one MCP tool.
 *
 * The clean case is `mcp__<serverKey>__<rawName>`. When character replacement
 * or truncation changes that string, a 12-hex SHA-256 of `(serverKey, rawName)`
 * is appended so distinct MCP identities never collapse onto one name. This is
 * the same contract `@deepseek-ai/dsh-mcp-client` uses; tool names stay stable
 * across restarts while the server keeps the same key and raw name.
 * @param {string} serverKey - Frozen tool namespace.
 * @param {string} rawName - The MCP server's own tool name.
 * @returns {string} the public tool name.
 */
export function publicToolName(serverKey, rawName) {
  const joined = `mcp__${serverKey}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverKey}\0${rawName}`, 'utf8').digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Normalize the `headers` field.
 * @param {unknown} value - Raw value.
 * @returns {{ name: string, value: string }[]} ordered headers.
 * @throws {InputError} on an invalid name, duplicate name, or oversized list.
 */
function readHeaders(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError('invalid-headers', 'headers must be an array', 'headers');
  if (value.length > 20) throw new InputError('invalid-headers', 'at most 20 custom headers are allowed', 'headers');
  const seen = new Set();
  const headers = [];
  for (const [index, entry] of value.entries()) {
    const field = `headers[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InputError('invalid-headers', `${field} must be an object with name and value`, field);
    }
    const name = readString(entry.name, { field: `${field}.name`, max: 128, min: 1, code: 'invalid-header-name' });
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new InputError('invalid-header-name', `${field}.name is not a valid HTTP header name`, `${field}.name`);
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw new InputError('duplicate-header', `header "${name}" is defined twice`, `${field}.name`);
    seen.add(folded);
    const headerValue = readString(entry.value, { field: `${field}.value`, max: 4096, code: 'invalid-header-value' });
    headers.push({ name, value: headerValue });
  }
  return headers;
}

/**
 * Normalize the `oauth` field.
 * @param {unknown} value - Raw value.
 * @returns {Record<string, string>} normalized OAuth settings.
 * @throws {InputError} on an unsupported mode or missing required field.
 */
function readOAuth(value) {
  if (value === undefined || value === null) return { mode: 'none' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new InputError('invalid-oauth', 'oauth must be an object', 'oauth');
  const mode = value.mode === undefined ? 'none' : value.mode;
  if (!OAUTH_MODES.includes(mode)) throw new InputError('invalid-oauth', `oauth.mode must be one of ${OAUTH_MODES.join(', ')}`, 'oauth.mode');
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'bearer') {
    const token = readString(value.token, { field: 'oauth.token', max: 8192, min: 1, code: 'invalid-oauth' });
    return { mode, token };
  }
  const tokenUrl = readString(value.tokenUrl, { field: 'oauth.tokenUrl', max: 2048, min: 1, code: 'invalid-oauth' });
  assertHttpUrl(tokenUrl, 'oauth.tokenUrl');
  const clientId = readString(value.clientId, { field: 'oauth.clientId', max: 256, min: 1, code: 'invalid-oauth' });
  const clientSecret = readString(value.clientSecret, { field: 'oauth.clientSecret', max: 4096, code: 'invalid-oauth' });
  const scope = readString(value.scope, { field: 'oauth.scope', max: 1024, code: 'invalid-oauth' });
  return { mode, tokenUrl, clientId, clientSecret, scope };
}

/**
 * Assert that a string is an absolute http(s) URL.
 * @param {string} value - Candidate URL.
 * @param {string} field - Field path for diagnostics.
 * @returns {void}
 * @throws {InputError} when the URL is invalid or uses another protocol.
 */
function assertHttpUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError('invalid-url', `${field} must be an absolute http(s) URL`, field);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InputError('invalid-url', `${field} must use http or https`, field);
  }
}

/**
 * Normalize the preset selection.
 * @param {unknown} value - Raw value (`"all"` or an array of preset ids).
 * @param {{ id: string }[]} presets - Known preset roster (empty when unavailable).
 * @returns {"all" | string[]} the normalized selection.
 * @throws {InputError} when the value names unknown presets or too many of them.
 */
function readPresets(value, presets) {
  if (value === undefined || value === null || value === 'all') return 'all';
  if (!Array.isArray(value)) throw new InputError('invalid-presets', 'presets must be "all" or an array of preset ids', 'presets');
  if (value.length > 40) throw new InputError('invalid-presets', 'at most 40 presets can be selected', 'presets');
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new InputError('invalid-presets', 'every preset id must be a string', 'presets');
    const id = entry.trim();
    if (id.length === 0 || id.length > 64) throw new InputError('invalid-presets', 'every preset id must be 1..64 characters', 'presets');
    if (presets.length > 0 && !presets.some((preset) => preset.id === id)) {
      const known = presets.map((preset) => preset.id).join(', ') || '(none)';
      throw new InputError('unknown-preset', `unknown agent preset "${id}"; known presets: ${known}`, 'presets');
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Normalize the stdio command/args/env/cwd fields.
 * @param {Record<string, unknown>} raw - Raw draft.
 * @returns {{ command: string, args: string[], env: Record<string, string>, cwd: string }} stdio settings.
 * @throws {InputError} on an invalid command, argument, env name, or cwd.
 */
function readStdio(raw) {
  const command = readString(raw.command, { field: 'command', max: 4096, min: 1, code: 'invalid-command' });
  let args = [];
  if (raw.args !== undefined && raw.args !== null) {
    if (!Array.isArray(raw.args)) throw new InputError('invalid-args', 'args must be an array of strings', 'args');
    if (raw.args.length > 64) throw new InputError('invalid-args', 'at most 64 arguments are allowed', 'args');
    args = raw.args.map((arg, index) => {
      if (typeof arg !== 'string') throw new InputError('invalid-args', `args[${index}] must be a string`, 'args');
      if (arg.length > 2048) throw new InputError('invalid-args', `args[${index}] is too long`, 'args');
      return arg;
    });
  }
  let env = {};
  if (raw.env !== undefined && raw.env !== null) {
    if (typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new InputError('invalid-env', 'env must be an object', 'env');
    const entries = Object.entries(raw.env);
    if (entries.length > 64) throw new InputError('invalid-env', 'at most 64 environment variables are allowed', 'env');
    for (const [name, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new InputError('invalid-env', `env name "${name}" is not a valid environment variable name`, 'env');
      if (typeof value !== 'string') throw new InputError('invalid-env', `env "${name}" must have a string value`, 'env');
      if (value.length > 8192) throw new InputError('invalid-env', `env "${name}" is too long`, 'env');
      env[name] = value;
    }
  }
  const cwd = readString(raw.cwd, { field: 'cwd', max: 4096, code: 'invalid-cwd' });
  return { command, args, env, cwd };
}

/**
 * Narrow one persisted `toolOverrides` map.
 *
 * Only deviations from the defaults survive: `{ enabled: false }` disables a
 * tool and `{ approval: true }` makes it ask in restricted permission modes.
 * An entry that would restate the defaults is dropped, so the file stays small
 * and a later default change is not silently pinned by old saves.
 * @param {unknown} value - Persisted map.
 * @returns {Record<string, { enabled?: false, approval?: true }>} the map.
 */
export function normalizeToolOverrides(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  /** @type {Record<string, { enabled?: false, approval?: true }>} */
  const overrides = {};
  let kept = 0;
  for (const [name, raw] of Object.entries(value)) {
    if (kept >= MAX_TOOL_OVERRIDES) break;
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) continue;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    /** @type {{ enabled?: false, approval?: true }} */
    const entry = {};
    if (raw.enabled === false) entry.enabled = false;
    if (raw.approval === true) entry.approval = true;
    if (Object.keys(entry).length === 0) continue;
    overrides[name] = entry;
    kept += 1;
  }
  return overrides;
}

/**
 * Whether one tool is exposed to agents.
 * @param {Record<string, any>} server - Stored server.
 * @param {string} rawName - Raw MCP tool name.
 * @returns {boolean} the answer (default true).
 */
export function toolEnabled(server, rawName) {
  return server?.toolOverrides?.[rawName]?.enabled !== false;
}

/**
 * Whether one tool asks for approval outside full-access sessions.
 * @param {Record<string, any>} server - Stored server.
 * @param {string} rawName - Raw MCP tool name.
 * @returns {boolean} the answer (default false).
 */
export function toolNeedsApproval(server, rawName) {
  return server?.toolOverrides?.[rawName]?.approval === true;
}

/**
 * Turn one tools-endpoint batch into a normalized overrides map.
 * @param {Record<string, any>} existing - Record being updated.
 * @param {unknown} tools - `tools` array from `PUT /servers/:id/tools`.
 * @returns {Record<string, { enabled?: false, approval?: true }>} the new map.
 * @throws {InputError} on a malformed batch.
 */
export function applyToolSettings(existing, tools) {
  if (!Array.isArray(tools)) throw new InputError('invalid-tools', 'tools must be an array', 'tools');
  if (tools.length > MAX_TOOL_OVERRIDES) throw new InputError('invalid-tools', `at most ${MAX_TOOL_OVERRIDES} tools are supported`, 'tools');
  /** @type {Record<string, { enabled?: false, approval?: true }>} */
  const next = {};
  const seen = new Set();
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('invalid-tools', 'each tool must be an object', 'tools');
    const name = raw.name;
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) throw new InputError('invalid-tool-name', `tool name "${String(name)}" is invalid`, 'tools');
    if (seen.has(name)) throw new InputError('invalid-tools', `tool "${name}" appears twice`, 'tools');
    seen.add(name);
    if (typeof raw.enabled !== 'boolean' || typeof raw.approval !== 'boolean') {
      throw new InputError('invalid-tools', `tool "${name}" needs boolean enabled and approval`, 'tools');
    }
    const entry = {};
    if (raw.enabled === false) entry.enabled = false;
    if (raw.approval === true) entry.approval = true;
    if (Object.keys(entry).length > 0) next[name] = entry;
    // Removing an entry is how defaults are restored; nothing else to keep.
  }
  return normalizeToolOverrides(next);
}

/**
 * Derive the compact parameter chips the panel shows for one input schema.
 * @param {unknown} inputSchema - MCP tool input schema.
 * @returns {{ name: string, required: boolean }[]} parameter chips.
 */
export function toolParameters(inputSchema) {
  if (typeof inputSchema !== 'object' || inputSchema === null) return [];
  const properties = inputSchema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  const required = Array.isArray(inputSchema.required) ? new Set(inputSchema.required.filter((name) => typeof name === 'string')) : new Set();
  return Object.keys(properties)
    .slice(0, MAX_CACHED_PARAMS)
    .map((name) => ({ name, required: required.has(name) }));
}

/**
 * Build the offline tool cache from one live connection's tool descriptors.
 * @param {{ rawName: string, publicName: string, description?: string, inputSchema?: unknown }[]} tools - Live descriptors.
 * @param {() => number} [now] - Clock.
 * @returns {{ at: string, tools: { name: string, publicName: string, description: string, params: { name: string, required: boolean }[] }[] }} cache.
 */
export function buildToolCache(tools, now = () => Date.now()) {
  const entries = [];
  for (const tool of tools.slice(0, MAX_CACHED_TOOLS)) {
    if (typeof tool?.rawName !== 'string' || !TOOL_NAME_PATTERN.test(tool.rawName)) continue;
    entries.push({
      name: tool.rawName,
      publicName: typeof tool.publicName === 'string' ? tool.publicName : tool.rawName,
      description: typeof tool.description === 'string' ? tool.description.slice(0, MAX_CACHED_DESCRIPTION) : '',
      params: toolParameters(tool.inputSchema),
    });
  }
  return { at: new Date(now()).toISOString(), tools: entries };
}

/**
 * Narrow one persisted tool cache.
 * @param {unknown} value - Persisted cache.
 * @returns {{ at: string, tools: { name: string, publicName: string, description: string, params: { name: string, required: boolean }[] }[] } | null} the cache.
 */
export function normalizeToolCache(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (typeof value.at !== 'string' || !Array.isArray(value.tools)) return null;
  const tools = [];
  for (const raw of value.tools.slice(0, MAX_CACHED_TOOLS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (typeof raw.name !== 'string' || !TOOL_NAME_PATTERN.test(raw.name)) continue;
    if (typeof raw.description !== 'string') continue;
    const params = [];
    if (Array.isArray(raw.params)) {
      for (const param of raw.params.slice(0, MAX_CACHED_PARAMS)) {
        if (typeof param?.name !== 'string' || typeof param.required !== 'boolean') continue;
        params.push({ name: param.name, required: param.required });
      }
    }
    tools.push({
      name: raw.name,
      publicName: typeof raw.publicName === 'string' ? raw.publicName : raw.name,
      description: raw.description.slice(0, MAX_CACHED_DESCRIPTION),
      params,
    });
  }
  return { at: value.at, tools };
}

/**
 * Narrow one persisted icon value to the stored shape.
 *
 * Version 1 files carry an emoji string (or `""`); 0.2.0 has no string icons, so
 * every legacy value becomes the automatic icon. A version 2 value that does not
 * match the upload shape is also reset to automatic instead of failing the load.
 * @param {unknown} value - Persisted icon field.
 * @returns {{ kind: "auto" } | { kind: "upload", file: string, mimeType: string, updatedAt: string }} the icon.
 */
export function normalizeStoredIcon(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'auto' };
  const icon = /** @type {Record<string, unknown>} */ (value);
  if (icon.kind !== 'upload') return { kind: 'auto' };
  if (typeof icon.file !== 'string' || !ICON_FILE_PATTERN.test(icon.file)) return { kind: 'auto' };
  if (typeof icon.mimeType !== 'string' || ICON_MIME_EXT[icon.mimeType] === undefined) return { kind: 'auto' };
  if (typeof icon.updatedAt !== 'string' || icon.updatedAt.length === 0) return { kind: 'auto' };
  return { kind: 'upload', file: icon.file, mimeType: icon.mimeType, updatedAt: icon.updatedAt };
}

/**
 * Create a fresh server id.
 * @returns {string} `srv_` plus 10 lowercase hex characters.
 */
export function createServerId() {
  return `srv_${randomBytes(5).toString('hex')}`;
}

/**
 * Normalize one create/update draft into a stored record.
 *
 * The caller supplies the existing record on update (its `id`, `key` and
 * `createdAt` are preserved) and the persistence order of already-used keys so
 * a new record's namespace can be allocated. `updatedAt` is always refreshed.
 *
 * @param {unknown} raw - Request body.
 * @param {object} options - Normalization context.
 * @param {Record<string, any>} [options.existing] - Record being updated.
 * @param {(key: string) => boolean} [options.keyTaken] - Predicate for taken namespaces.
 * @param {{ id: string }[]} [options.presets] - Known preset roster.
 * @param {() => number} [options.now] - Clock.
 * @returns {Record<string, any>} the stored record.
 * @throws {InputError} when any field is invalid.
 */
export function normalizeDraft(raw, { existing, keyTaken = () => false, presets = [], now = () => Date.now() } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputError('invalid-body', 'server draft must be a JSON object');
  }
  const name = readString(raw.name, { field: 'name', max: 80, min: 1, code: 'invalid-name' });
  const transport = raw.transport === undefined ? 'http' : raw.transport;
  if (!TRANSPORTS.includes(transport)) throw new InputError('invalid-transport', `transport must be one of ${TRANSPORTS.join(', ')}`, 'transport');
  const enabled = readBoolean(raw.enabled, 'enabled', true);
  const id = existing?.id ?? createServerId();
  const key = existing?.key ?? allocateKey(keyFromName(name), id.slice(-10), keyTaken);
  const color = raw.color === undefined ? 'blue' : raw.color;
  if (!SERVER_COLORS.includes(color)) throw new InputError('invalid-color', `color must be one of ${SERVER_COLORS.join(', ')}`, 'color');
  // The icon has its own endpoints (contract §2.6); a draft never sets it.
  const icon = existing?.icon === undefined ? { ...AUTO_ICON } : normalizeStoredIcon(existing.icon);
  const group = readString(raw.group, { field: 'group', max: 60, code: 'invalid-group' });
  const presetsSelection = readPresets(raw.presets, presets);
  const timeoutMs = readInteger(raw.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS, 1000, 600_000);
  const common = {
    id,
    key,
    name,
    enabled,
    transport,
    icon,
    color,
    group,
    presets: presetsSelection,
    toolOverrides: normalizeToolOverrides(existing?.toolOverrides),
    toolCache: normalizeToolCache(existing?.toolCache),
    timeoutMs,
    createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
  };
  if (transport === 'stdio') {
    const stdio = readStdio(raw);
    return {
      ...common,
      url: '',
      command: stdio.command,
      args: stdio.args,
      env: stdio.env,
      cwd: stdio.cwd,
      headers: [],
      oauth: { mode: 'none' },
    };
  }
  const url = readString(raw.url, { field: 'url', max: 2048, min: 1, code: 'invalid-url' });
  assertHttpUrl(url, 'url');
  const headers = readHeaders(raw.headers);
  const oauth = readOAuth(raw.oauth);
  // Both may name a credential; the transport merges them with the custom header
  // winning, so the stored record keeps exactly what the operator typed.
  return {
    ...common,
    url,
    command: '',
    args: [],
    env: {},
    cwd: '',
    headers,
    oauth,
  };
}

/**
 * Whether one preset may see a server's tools.
 * @param {{ presets: "all" | string[] }} server - Stored server.
 * @param {string | undefined} presetId - Preset of the agent, if any.
 * @returns {boolean} the answer.
 */
export function presetAllows(server, presetId) {
  if (server.presets === 'all') return true;
  if (!Array.isArray(server.presets)) return false;
  if (presetId === undefined) return false;
  return server.presets.includes(presetId);
}

/**
 * Human label of a transport.
 * @param {string} transport - Stored transport id.
 * @returns {string} `HTTP`, `SSE` or `内置`.
 */
export function transportLabel(transport) {
  return TRANSPORT_LABELS[transport] ?? String(transport);
}

/**
 * The public shape sent to the panel: the stored record (which contains
 * secrets the local operator typed in) plus its derived status.
 * @param {Record<string, any>} server - Stored record.
 * @returns {Record<string, any>} a detached copy.
 */
export function serverView(server) {
  return {
    id: server.id,
    key: server.key,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    transportLabel: transportLabel(server.transport),
    url: server.url,
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
    cwd: server.cwd,
    headers: server.headers.map((header) => ({ name: header.name, value: header.value })),
    oauth: { ...server.oauth },
    icon: server.icon.kind === 'upload' ? { ...server.icon } : { ...AUTO_ICON },
    color: server.color,
    group: server.group,
    presets: server.presets === 'all' ? 'all' : [...server.presets],
    timeoutMs: server.timeoutMs,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}
