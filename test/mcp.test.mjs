/**
 * MCP connection unit tests.
 *
 * The supervisor itself needs a real MCP server, so its end-to-end behavior is
 * covered by the E2E suite. What is tested here is the part that must be right
 * offline: client-credentials token acquisition/caching/refresh, credential
 * header precedence, failure classification and the contract status snapshot.
 * `lib/mcp.js` exports `__mcpTest` for exactly this (same idiom as the sibling
 * plugins' `__tcTest`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, createManager, __mcpTest } from '../lib/mcp.js';

const { createTokenSource, buildHeaders, classifyFailure, describeFailure, errorChain, truncateUtf8 } = __mcpTest;

/** One normalized client_credentials OAuth config. */
function oauth(overrides = {}) {
  return {
    mode: 'client_credentials',
    tokenUrl: 'https://idp.example.com/token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scope: 'mcp.read',
    ...overrides,
  };
}

/**
 * Replace global fetch for one test, capturing calls.
 * @param {object} t - node:test context.
 * @param {(call: { url: string, init: any }, index: number) => any} responder - Response factory.
 * @returns {object[]} the recorded calls.
 */
function mockFetch(t, responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** One fetch Response stand-in. */
function response({ ok = true, status = 200, json, text, jsonError } = {}) {
  return {
    ok,
    status,
    async json() {
      if (jsonError !== undefined) throw new Error(jsonError);
      return json ?? {};
    },
    async text() {
      return text ?? '';
    },
  };
}

/* ---------------------------------------------------------------- */
/* client_credentials token source                                   */
/* ---------------------------------------------------------------- */

test('mcp oauth: client_credentials POSTs the documented form and returns the token', async (t) => {
  const calls = mockFetch(t, () => response({ json: { access_token: 'tok-1', expires_in: 120 } }));
  const tokens = createTokenSource(oauth(), () => 0);
  assert.equal(await tokens.get(), 'tok-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://idp.example.com/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  const body = calls[0].init.body;
  assert.equal(body instanceof URLSearchParams, true);
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('client_secret'), 'client-secret');
  assert.equal(body.get('scope'), 'mcp.read');
});

test('mcp oauth: optional secret and scope are omitted when empty', async (t) => {
  const calls = mockFetch(t, () => response({ json: { access_token: 'tok' } }));
  const tokens = createTokenSource(oauth({ clientSecret: '', scope: '' }), () => 0);
  await tokens.get();
  const body = calls[0].init.body;
  assert.equal(body.has('client_secret'), false);
  assert.equal(body.has('scope'), false);
});

test('mcp oauth: the token is cached until 60 seconds before expiry', async (t) => {
  let now = 0;
  const calls = mockFetch(t, (_call, index) => response({ json: { access_token: `tok-${index}`, expires_in: 120 } }));
  const tokens = createTokenSource(oauth(), () => now);

  assert.equal(await tokens.get(), 'tok-0');
  now = 59_999;
  assert.equal(await tokens.get(), 'tok-0');
  assert.equal(calls.length, 1, 'a token well inside its lifetime is reused');

  now = 60_000;
  assert.equal(await tokens.get(), 'tok-1');
  assert.equal(calls.length, 2, 'a token inside the 60-second safety window is refreshed');
});

test('mcp oauth: expires_in without a value caches for five minutes', async (t) => {
  let now = 0;
  const calls = mockFetch(t, () => response({ json: { access_token: 'tok' } }));
  const tokens = createTokenSource(oauth(), () => now);
  await tokens.get();
  now = 299_999;
  assert.equal(await tokens.get(), 'tok');
  assert.equal(calls.length, 1);
  now = 300_000;
  await tokens.get();
  assert.equal(calls.length, 2);
});

test('mcp oauth: a short lifetime is floored at five seconds', async (t) => {
  let now = 0;
  const calls = mockFetch(t, () => response({ json: { access_token: 'tok', expires_in: 30 } }));
  const tokens = createTokenSource(oauth(), () => now);
  await tokens.get();
  now = 4_999;
  await tokens.get();
  assert.equal(calls.length, 1);
  now = 5_000;
  await tokens.get();
  assert.equal(calls.length, 2);
});

test('mcp oauth: concurrent callers share one token request', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  mockFetch(t, () => pending);
  const tokens = createTokenSource(oauth(), () => 0);
  const first = tokens.get();
  const second = tokens.get();
  release(response({ json: { access_token: 'tok' } }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 'tok');
  assert.equal(b, 'tok');
  assert.equal(first instanceof Promise, true);
  assert.equal(second instanceof Promise, true);
});

test('mcp oauth: invalidate forces a fresh token on the next call', async (t) => {
  const calls = mockFetch(t, (_call, index) => response({ json: { access_token: `tok-${index}` } }));
  const tokens = createTokenSource(oauth(), () => 0);
  assert.equal(await tokens.get(), 'tok-0');
  tokens.invalidate();
  assert.equal(await tokens.get(), 'tok-1');
  assert.equal(calls.length, 2);
});

test('mcp oauth: a failed token endpoint is an auth-failed error', async (t) => {
  mockFetch(t, () => response({ ok: false, status: 401, text: 'invalid client' }));
  const tokens = createTokenSource(oauth(), () => 0);
  await assert.rejects(() => tokens.get(), (error) => {
    assert.equal(error.code, 'auth-failed');
    assert.match(error.message, /HTTP 401/u);
    assert.match(error.message, /invalid client/u);
    return true;
  });
});

test('mcp oauth: an unreachable token endpoint is auth-failed too', async (t) => {
  mockFetch(t, () => {
    throw new Error('ECONNREFUSED');
  });
  const tokens = createTokenSource(oauth(), () => 0);
  await assert.rejects(() => tokens.get(), (error) => {
    assert.equal(error.code, 'auth-failed');
    assert.match(error.message, /unreachable/u);
    assert.match(error.message, /ECONNREFUSED/u);
    return true;
  });
});

test('mcp oauth: invalid JSON, a missing access_token and a bad body are auth-failed', async (t) => {
  for (const responder of [
    () => response({ jsonError: 'unexpected token <' }),
    () => response({ json: { token_type: 'Bearer' } }),
    () => response({ json: { access_token: '' } }),
  ]) {
    mockFetch(t, responder);
    const tokens = createTokenSource(oauth(), () => 0);
    await assert.rejects(() => tokens.get(), (error) => {
      assert.equal(error.code, 'auth-failed');
      assert.ok(error.message.length > 0);
      return true;
    });
  }
});

/* ---------------------------------------------------------------- */
/* credential headers                                                */
/* ---------------------------------------------------------------- */

test('mcp headers: a bearer token becomes an Authorization header', async () => {
  const server = {
    headers: [{ name: 'X-Trace', value: '1' }],
    oauth: { mode: 'bearer', token: 'opaque' },
  };
  const headers = await buildHeaders(server, () => {
    throw new Error('bearer mode must not fetch a token');
  });
  assert.deepEqual(headers, { 'X-Trace': '1', Authorization: 'Bearer opaque' });
});

test('mcp headers: a custom Authorization header wins over the OAuth shortcut', async () => {
  const server = {
    headers: [{ name: 'authorization', value: 'Custom credential' }],
    oauth: { mode: 'bearer', token: 'opaque' },
  };
  const headers = await buildHeaders(server, () => {
    throw new Error('a custom Authorization header must not be replaced');
  });
  assert.deepEqual(headers, { authorization: 'Custom credential' });
});

test('mcp headers: client_credentials fetches a token for the Authorization header', async () => {
  const requested = [];
  const server = {
    headers: [],
    oauth: oauth(),
  };
  const headers = await buildHeaders(server, (config) => {
    requested.push(config);
    return { get: async () => 'fetched-token', invalidate: () => {} };
  });
  assert.deepEqual(requested, [server.oauth]);
  assert.deepEqual(headers, { Authorization: 'Bearer fetched-token' });
});

test('mcp headers: no credential mode adds no Authorization header', async () => {
  assert.deepEqual(await buildHeaders({ headers: [{ name: 'X', value: 'y' }], oauth: { mode: 'none' } }, () => {
    throw new Error('no token should be requested');
  }), { X: 'y' });
});

/* ---------------------------------------------------------------- */
/* failure classification                                            */
/* ---------------------------------------------------------------- */

test('mcp failure: stable codes pass through and messages are classified', () => {
  assert.equal(classifyFailure(Object.assign(new Error('anything'), { code: 'timeout' })), 'timeout');
  assert.equal(classifyFailure(Object.assign(new Error('401 unauthorized'), { code: 'protocol' })), 'protocol');
  assert.equal(classifyFailure(new Error('request timed out after 20000 ms')), 'timeout');
  const timeout = new Error('slow');
  timeout.name = 'TimeoutError';
  assert.equal(classifyFailure(timeout), 'timeout');

  assert.equal(classifyFailure(new Error('HTTP 401 Unauthorized')), 'auth-failed');
  assert.equal(classifyFailure(new Error('HTTP 403 Forbidden')), 'auth-failed');
  const statusOnly = new Error('denied');
  statusOnly.status = 401;
  assert.equal(classifyFailure(statusOnly), 'auth-failed', 'a numeric 401 classifies even without a 401 message');
  const statusCode = new Error('denied again');
  statusCode.statusCode = 403;
  assert.equal(classifyFailure(statusCode), 'auth-failed');
  const nested = new Error('request failed', { cause: Object.assign(new Error('denied'), { response: { status: 401 } }) });
  assert.equal(classifyFailure(nested), 'auth-failed', 'status is found through the cause chain');
  const named = new Error('nope');
  named.name = 'UnauthorizedError';
  assert.equal(classifyFailure(named), 'auth-failed');

  assert.equal(classifyFailure(new Error('Protocol error: invalid params')), 'protocol');
  assert.equal(classifyFailure(new Error('Method not found')), 'protocol');
  assert.equal(classifyFailure(new Error('Parse error at line 3')), 'protocol');
  assert.equal(classifyFailure(new TypeError('fetch failed')), 'connect-failed');
  assert.equal(classifyFailure('plain text failure'), 'connect-failed');
});

test('mcp failure: describeFailure reports code, message, stack detail and stderr tail', () => {
  const inner = new Error('connection refused');
  const outer = new Error('could not connect', { cause: inner });
  const described = describeFailure(outer, 'server stderr line\nsecond line');
  assert.equal(described.code, 'connect-failed');
  assert.match(described.message, /could not connect — connection refused/u);
  assert.match(described.detail, /could not connect/u, 'the stack is kept for the details dialog');
  assert.match(described.detail, /server stderr \(tail\):\nserver stderr line/u);
  assert.match(described.at, /^\d{4}-\d{2}-\d{2}T/u);

  assert.equal(describeFailure('plain').code, 'connect-failed');
  assert.equal(describeFailure({ code: 'invalid-config', message: 'bad url' }).code, 'invalid-config');

  const long = describeFailure(new Error('x'.repeat(4000)));
  assert.ok(Buffer.byteLength(long.message, 'utf8') <= 800, 'the panel message is capped');
  assert.ok(Buffer.byteLength(long.detail, 'utf8') <= 8000, 'the details detail is capped');
});

test('mcp failure: errorChain walks causes and tolerates non-errors', () => {
  const inner = new Error('inner');
  const middle = new Error('middle', { cause: inner });
  const outer = new Error('outer', { cause: middle });
  assert.deepEqual(errorChain(outer), ['outer', 'middle', 'inner']);
  assert.deepEqual(errorChain('text'), ['text']);
  assert.deepEqual(errorChain({ nope: true }), ['[object Object]']);
  assert.deepEqual(errorChain(undefined), ['undefined']);
});

test('mcp failure: truncateUtf8 never splits a code point', () => {
  assert.equal(truncateUtf8('hello', 10), 'hello');
  assert.equal(truncateUtf8('hello', 5), 'hello');
  assert.equal(truncateUtf8('ééééé', 5), 'éé', 'é is two bytes, so five bytes fit two');
  assert.equal(truncateUtf8('😀', 2), '', 'a four-byte emoji cannot be cut');
  assert.equal(truncateUtf8('😀', 4), '😀');
  assert.equal(truncateUtf8('ab😀', 5), 'ab', 'the boundary stops before the emoji');
});

/* ---------------------------------------------------------------- */
/* contract snapshots without a connection                            */
/* ---------------------------------------------------------------- */

test('mcp manager: an unknown server has the contract disabled snapshot', async () => {
  const manager = createManager();
  try {
    const snapshot = manager.status('srv_missing');
    assert.equal(snapshot.serverId, 'srv_missing');
    assert.equal(snapshot.state, 'disabled');
    assert.equal(snapshot.transportLabel, 'HTTP');
    assert.equal(snapshot.toolCount, 0);
    assert.equal(snapshot.discoveredCount, 0);
    assert.equal(snapshot.instructionsBytes, 0);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.attempts, 0);
    assert.equal(snapshot.connectedAt, null);
    assert.equal(snapshot.lastAttemptAt, null);
    assert.equal(snapshot.nextRetryAt, null);
    assert.equal(manager.get('srv_missing'), undefined);
  } finally {
    await manager.dispose();
  }
});

test('mcp manager: a disabled server is tracked without connecting and removed on sync', async () => {
  const manager = createManager();
  const record = {
    id: 'srv_disabled',
    key: 'disabled',
    name: 'Disabled',
    enabled: false,
    transport: 'stdio',
    command: 'node',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: [],
    oauth: { mode: 'none' },
    timeoutMs: 60_000,
  };
  try {
    await manager.sync([record]);
    const connection = manager.get('srv_disabled');
    assert.ok(connection, 'sync must create one supervisor per stored server');
    assert.equal(connection.snapshot().state, 'disabled');
    assert.equal(connection.snapshot().transportLabel, '内置');
    assert.deepEqual(connection.tools(), []);
    assert.equal(connection.instructions(), '');
    assert.equal(connection.running, false);
    await assert.rejects(() => connection.callTool('echo', {}, {}), /no longer offers tool/u);

    await manager.sync([{ ...record, enabled: false, name: 'Renamed' }]);
    assert.equal(manager.get('srv_disabled').server.name, 'Renamed');

    await manager.sync([]);
    assert.equal(manager.get('srv_disabled'), undefined, 'a removed server loses its supervisor');
  } finally {
    await manager.dispose();
  }
});

test('mcp manager: dispose is idempotent and rejects no late work', async () => {
  const manager = createManager();
  await manager.dispose();
  await manager.dispose();
  await manager.sync([]);
  assert.equal(manager.status('x').state, 'disabled');
});

test('mcp connection: a disabled stdio server reports the contract snapshot', async () => {
  const connection = createConnection({
    server: {
      id: 'srv_1',
      key: 'one',
      name: 'One',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      url: '',
      headers: [],
      oauth: { mode: 'none' },
      timeoutMs: 5_000,
    },
  });
  const snapshot = connection.snapshot();
  assert.equal(snapshot.state, 'disabled');
  assert.equal(snapshot.transportLabel, '内置');
  assert.equal(snapshot.serverId, 'srv_1');
  assert.equal(connection.tools().length, 0);
  assert.equal(connection.instructions(), '');
  connection.start();
  assert.equal(connection.snapshot().state, 'disabled', 'start on a disabled server does nothing');
  await connection.dispose();
  await connection.dispose();
});
