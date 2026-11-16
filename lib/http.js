/**
 * Small HTTP helpers shared by the panel API.
 *
 * The route owns its full response lifecycle (that is the `dsh-host-webserver`
 * contract), so these are plain `node:http` utilities rather than a framework:
 * read a bounded JSON body, answer a JSON envelope, and answer an error with a
 * stable machine code.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/http
 */

/** Largest JSON body the panel API accepts (bytes). */
export const MAX_JSON_BYTES = 64 * 1024;

/** One request that cannot be answered as asked, carrying its HTTP status. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status to send.
   * @param {string} code - Stable machine code shown to the panel.
   * @param {string} message - Human-readable explanation.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Write one JSON response and end it.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - Status code.
 * @param {unknown} value - JSON-serializable body.
 * @returns {void}
 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Write one error envelope.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {HttpError} error - Error to report.
 * @returns {void}
 */
export function sendError(res, error) {
  sendJson(res, error.status, {
    ok: false,
    code: error.code,
    error: error.message,
    ...(typeof error.field === 'string' ? { field: error.field } : {}),
  });
}

/**
 * Read the request body up to `limit` bytes.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {number} [limit] - Byte cap.
 * @returns {Promise<Buffer>} the complete body.
 * @throws {HttpError} `413` when the body is larger than the cap.
 */
export function readBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.destroy?.();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'body-too-large', `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(new HttpError(400, 'body-read-failed', error?.message ?? String(error))));
  });
}

/**
 * Read a JSON object body.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @returns {Promise<Record<string, unknown>>} parsed object (never an array or null).
 * @throws {HttpError} `415` for a wrong content type, `400` for invalid JSON.
 */
export async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported-media-type', 'mutations require Content-Type: application/json');
  }
  const buffer = await readBody(req);
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, 'invalid-json', `request body is not valid JSON: ${error.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid-body', 'request body must be a JSON object');
  }
  return parsed;
}

/**
 * Browser-trust fence for mutations: a request from this origin has either no
 * `Origin` header (curl, tests, same-origin form posts) or one whose authority
 * equals the `Host` the request arrived on. A cross-site page always carries a
 * mismatching `Origin`.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @throws {HttpError} `403` when a supplied Origin does not match the request host.
 * @returns {void}
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const host = req.headers.host;
  let authority;
  try {
    authority = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'cross-origin', 'request Origin is not a valid authority');
  }
  if (host === undefined || authority !== host) {
    throw new HttpError(403, 'cross-origin', 'request Origin does not match the request host');
  }
}

/**
 * Normalize an unknown thrown value into an `HttpError` the router can send.
 * An `HttpError` passes through; everything else becomes a `500 server-error`
 * whose message is the error's message (never a stack).
 * @param {unknown} error - Thrown value.
 * @returns {HttpError} the reportable error.
 */
export function asHttpError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'server-error', error instanceof Error ? error.message : String(error));
}
