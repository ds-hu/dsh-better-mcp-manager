/**
 * Same-origin client for the isolated DSH instance's own HTTP surface.
 *
 * The launcher prints an authenticated URL carrying `?token=…`. Fetching it
 * once mints the browser-auth cookie; every later request (including the
 * plugin's `/better-mcp-manager/api/*` routes) uses that cookie. Mutations send
 * an `Origin` header matching the instance host, which is what the Host's
 * same-origin fence accepts.
 */
import { redact } from './util.mjs';

export class InstanceApi {
  constructor({ origin, reporter }) {
    this.origin = origin;
    this.reporter = reporter;
    this.cookie = '';
  }

  /** Exchange the authenticated index URL for the auth cookie. */
  async login(authenticatedUrl) {
    const response = await fetch(authenticatedUrl, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(30_000),
    });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
    const cookie = setCookies
      .map((entry) => entry.split(';')[0])
      .find((entry) => entry.includes('='));
    if (cookie === undefined || cookie === '') {
      throw new Error(`the authenticated URL did not mint a cookie (HTTP ${response.status})`);
    }
    this.cookie = cookie;
    this.reporter?.debug(`browser-auth cookie acquired (${this.cookie.split('=')[0]}, value redacted)`);
    return { status: response.status, location: response.headers.get('location') };
  }

  async request(method, path, { body, expectOk = true } = {}) {
    const headers = { cookie: this.cookie, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers.origin = this.origin;
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (expectOk && !response.ok) {
      throw new Error(`${method} ${path} answered HTTP ${response.status}: ${redact(text).slice(0, 800)}`);
    }
    return { status: response.status, headers: response.headers, payload, text };
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, { body });
  }

  put(path, body) {
    return this.request('PUT', path, { body });
  }

  delete(path) {
    return this.request('DELETE', path);
  }

  /** Raw response for binary/conditional requests (icons, 304s). */
  async raw(method, path, { headers = {}, body } = {}) {
    const merged = { cookie: this.cookie, ...headers };
    if (method !== 'GET') merged.origin = this.origin;
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.origin}${path}`;
    const response = await fetch(url, {
      method,
      headers: merged,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes };
  }

  // ── plugin API convenience wrappers ──────────────────────────────────────
  async health() {
    return (await this.get('/better-mcp-manager/api/health')).payload;
  }

  async servers() {
    return (await this.get('/better-mcp-manager/api/servers')).payload;
  }

  async presets() {
    return (await this.get('/better-mcp-manager/api/presets')).payload;
  }

  async agents() {
    return (await this.get('/better-mcp-manager/api/agents')).payload;
  }

  async serverDetail(id) {
    return (await this.get(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}`)).payload;
  }

  async createServer(draft) {
    const result = await this.post('/better-mcp-manager/api/servers', draft);
    if (result.status !== 201) throw new Error(`POST /servers answered HTTP ${result.status}, expected 201`);
    return result.payload;
  }

  async updateServer(id, draft) {
    return (await this.put(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}`, draft)).payload;
  }

  async deleteServer(id) {
    return (await this.delete(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}`)).payload;
  }

  async setEnabled(id, enabled) {
    return (await this.post(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}/enabled`, { enabled })).payload;
  }

  async testServer(draft) {
    return (await this.post('/better-mcp-manager/api/servers/test', draft)).payload;
  }

  /** `GET /servers/:id/icon` (iconUrl carries a cache-busting `?v=`). */
  async fetchIcon(iconUrl, { ifNoneMatch } = {}) {
    const headers = {};
    if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch;
    const result = await this.raw('GET', iconUrl, { headers });
    return {
      status: result.status,
      contentType: result.headers.get('content-type'),
      etag: result.headers.get('etag'),
      cacheControl: result.headers.get('cache-control'),
      bytes: result.bytes,
    };
  }

  async tools(id) {
    return (await this.get(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}/tools`)).payload;
  }

  async putTools(id, tools) {
    return (await this.put(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}/tools`, { tools })).payload;
  }

  async external() {
    return (await this.get('/better-mcp-manager/api/external')).payload;
  }

  async scanExternal() {
    return (await this.post('/better-mcp-manager/api/external/scan')).payload;
  }

  async putExternalTools(presetId, tools) {
    return (await this.put('/better-mcp-manager/api/external/tools', { presetId, tools })).payload;
  }

  async uploadIcon(id, dataUrl) {
    return (await this.post(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}/icon`, { dataUrl })).payload;
  }

  async deleteIcon(id) {
    return (await this.delete(`/better-mcp-manager/api/servers/${encodeURIComponent(id)}/icon`)).payload;
  }
}
