#!/usr/bin/env node
/**
 * E2E fixture: a minimal MCP Streamable HTTP server over node:http, no deps.
 *
 * Implements the server half of MCP's Streamable HTTP transport closely enough
 * for `@modelcontextprotocol/client`'s `StreamableHTTPClientTransport`
 * (version 2.2.0, protocol 2025-11-25 / 2025-06-18):
 *
 *   POST /mcp  initialize                -> JSON-RPC result + `mcp-session-id`
 *   POST /mcp  notifications/initialized -> 202, no body
 *   POST /mcp  tools/list                -> three tools: echo, add, fail
 *   POST /mcp  tools/call                -> fixture text / isError result
 *   POST /mcp  ping                      -> {}
 *   GET  /mcp                            -> 405 (no server-initiated stream)
 *   DELETE /mcp                          -> 200, session ends
 *
 * Responses are plain `application/json` JSON-RPC messages: the client
 * accepts a JSON response to a POST even when it advertised SSE.
 *
 * Flags / environment:
 *   --port <n>             listen port, 0 = pick a free one (default 0)
 *   --label <name>         serverInfo.name suffix (default "http")
 *   MCP_FIXTURE_DEBUG=1    log every request line to stderr
 *
 * On start it prints one line of JSON to stdout:
 *   {"port":123,"url":"http://127.0.0.1:123/mcp"}
 * and keeps running until SIGTERM/SIGINT.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const PORT = Number(argOf('--port', process.env.MCP_FIXTURE_PORT || '0'));
const LABEL = argOf('--label', process.env.MCP_FIXTURE_LABEL || 'http');
const DEBUG = process.env.MCP_FIXTURE_DEBUG === '1';
const SERVER_NAME = `mcp-e2e-${LABEL}`;
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
const INSTRUCTIONS = `Fixture MCP server "${SERVER_NAME}" over Streamable HTTP. echo/add/fail are for e2e assertions.`;

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'fail',
    description: 'Always answer with an MCP tool error (used to test error projection).',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

/** session id -> metadata; one live session at a time is enough for e2e. */
const sessions = new Map();

function log(...parts) {
  if (DEBUG) process.stderr.write(`[mcp-http-fixture] ${parts.join(' ')}\n`);
}

function jsonRpcResult(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleToolCall(id, params) {
  const name = params?.name;
  const toolArgs = params?.arguments ?? {};
  if (name === 'echo') {
    return jsonRpcResult(id, { content: [{ type: 'text', text: `echo: ${String(toolArgs.text ?? '')}` }] });
  }
  if (name === 'add') {
    const sum = Number(toolArgs.a ?? 0) + Number(toolArgs.b ?? 0);
    return jsonRpcResult(id, { content: [{ type: 'text', text: `sum: ${sum}` }] });
  }
  if (name === 'fail') {
    return jsonRpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: `fixture failure: ${String(toolArgs.message ?? 'requested')}` }],
    });
  }
  return jsonRpcError(id, -32602, `unknown tool: ${String(name)}`);
}

function handleRpc(message, _session) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const negotiated = PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18';
      return {
        kind: 'result',
        payload: jsonRpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
          instructions: INSTRUCTIONS,
        }),
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { kind: 'accepted' };
    case 'ping':
      return { kind: 'result', payload: jsonRpcResult(id, {}) };
    case 'tools/list':
      return { kind: 'result', payload: jsonRpcResult(id, { tools: TOOLS }) };
    case 'tools/call':
      return isNotification ? { kind: 'accepted' } : { kind: 'result', payload: handleToolCall(id, params) };
    default:
      return isNotification
        ? { kind: 'accepted' }
        : { kind: 'result', payload: jsonRpcError(id, -32601, `method not found: ${String(method)}`) };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  log(req.method, url.pathname, req.headers['mcp-session-id'] ?? '-', req.headers.accept ?? '-');

  if (req.method === 'GET') {
    // No server-initiated messages: the spec permits 405 here and the client
    // transport tolerates it (it still receives replies on POST responses).
    res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server-initiated stream not supported by fixture' }));
    return;
  }
  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      sessions.delete(sessionId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing mcp-session-id' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE' });
    res.end();
    return;
  }

  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (error) {
    sendJson(res, 413, { error: String(error instanceof Error ? error.message : error) });
    return;
  }
  let message;
  try {
    message = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }

  const messages = Array.isArray(message) ? message : [message];
  const isInitialize = messages.some((item) => item?.method === 'initialize');
  const headerSession = req.headers['mcp-session-id'];
  let session;
  if (isInitialize) {
    // A fresh initialize always starts a new session (the client sends no id).
    session = { id: randomUUID(), createdAt: Date.now() };
    sessions.set(session.id, session);
  } else {
    if (typeof headerSession !== 'string' || !sessions.has(headerSession)) {
      sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unknown or missing mcp-session-id' } });
      return;
    }
    session = sessions.get(headerSession);
  }

  const results = messages.map((item) => handleRpc(item, session));
  const headers = isInitialize ? { 'mcp-session-id': session.id } : {};
  const result = results.find((entry) => entry.kind === 'result');
  if (result === undefined) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  sendJson(res, 200, result.payload, headers);
});

server.on('error', (error) => {
  process.stderr.write(`[mcp-http-fixture] server error: ${String(error)}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  process.stdout.write(`${JSON.stringify({ port, url: `http://127.0.0.1:${port}/mcp` })}\n`);
  log('listening', String(port));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
