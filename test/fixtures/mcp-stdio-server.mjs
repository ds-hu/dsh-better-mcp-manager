#!/usr/bin/env node
/**
 * E2E fixture: a tiny MCP stdio server, no dependencies.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout and implements just
 * enough of the MCP server surface for the plugin's stdio transport:
 *
 *   initialize                     -> capabilities.tools + instructions
 *   notifications/initialized      -> no reply
 *   tools/list                     -> `echo` and `fail`
 *   tools/call                     -> `echo` returns text, `fail` returns isError
 *   ping                           -> {}
 *
 * Environment knobs used by the e2e runner:
 *   MCP_FIXTURE_LABEL          serverInfo.name suffix / instruction label (default "stdio")
 *   MCP_FIXTURE_EXIT_IMMEDIATELY=1  write to stderr and exit(1) before initialize
 *   MCP_FIXTURE_DEBUG=1        log every request to stderr
 *
 * It never writes to stdout except JSON-RPC frames.
 */
import { createInterface } from 'node:readline';

const LABEL = process.env.MCP_FIXTURE_LABEL || 'stdio';
const DEBUG = process.env.MCP_FIXTURE_DEBUG === '1';
const SERVER_NAME = `mcp-e2e-${LABEL}`;
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);

if (process.env.MCP_FIXTURE_EXIT_IMMEDIATELY === '1') {
  process.stderr.write(`${SERVER_NAME}: fixture configured to exit immediately\n`);
  process.exit(1);
}

const INSTRUCTIONS = `Fixture MCP server "${SERVER_NAME}". Use the echo tool to repeat text.`;

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
    name: 'fail',
    description: 'Always answer with an MCP tool error (used to test error projection).',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Failure message to report.' } },
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === 'echo') {
    return result(id, {
      content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }],
    });
  }
  if (name === 'fail') {
    return result(id, {
      isError: true,
      content: [{ type: 'text', text: `fixture failure: ${String(args.message ?? 'requested')}` }],
    });
  }
  return error(id, -32602, `unknown tool: ${String(name)}`);
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    process.stderr.write(`${SERVER_NAME}: ignoring non-JSON line\n`);
    return;
  }
  if (DEBUG) process.stderr.write(`${SERVER_NAME} <- ${raw}\n`);
  if (Array.isArray(message)) {
    for (const item of message) handleMessage(JSON.stringify(item));
    return;
  }
  if (message?.method === undefined) return; // client response; nothing pending here
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const negotiated = PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18';
      result(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
      return;
    case 'notifications/cancelled':
      return;
    case 'ping':
      if (!isNotification) result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call':
      if (!isNotification) handleToolCall(id, params);
      return;
    default:
      if (!isNotification) error(id, -32601, `method not found: ${String(method)}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed !== '') handleMessage(trimmed);
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
