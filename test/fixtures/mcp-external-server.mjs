#!/usr/bin/env node
/**
 * E2E fixture: a tiny MCP stdio server owned by an *external agent preset*.
 *
 * The 0.4.0 host must discover MCP servers that other presets mount through
 * `@deepseek-ai/dsh-mcp-client` and let the page hide/approve their tools. This
 * fixture is the server behind the test preset `external` (serverName
 * `foreign`); it is copied into the run directory and spawned by the shipped
 * mcp-client plugin, never by our plugin.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout and implements just
 * the methods the shipped client uses:
 *
 *   initialize                  -> capabilities.tools + instructions
 *   notifications/initialized   -> no reply
 *   tools/list                  -> `ping` (required text) and `add` (optional a,b)
 *   tools/call                  -> `ping` echoes text, `add` sums the numbers
 *   ping                        -> {}
 *   resources/list, prompts/list, resources/templates/list -> empty lists
 *
 * Environment knob: MCP_EXTERNAL_DEBUG=1 logs every request to stderr.
 * It never writes to stdout except JSON-RPC frames.
 */
import { createInterface } from 'node:readline';

const DEBUG = process.env.MCP_EXTERNAL_DEBUG === '1';
const SERVER_NAME = 'foreign';
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);

const INSTRUCTIONS = 'External fixture MCP server "foreign". Use ping to echo text; add sums two numbers.';

const TOOLS = [
  {
    name: 'ping',
    description: 'Ping the external fixture MCP server and echo the given text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers; both operands are optional and default to zero.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First operand (optional).' },
        b: { type: 'number', description: 'Second operand (optional).' },
      },
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
  if (name === 'ping') {
    return result(id, { content: [{ type: 'text', text: `external-ping: ${String(args.text ?? '')}` }] });
  }
  if (name === 'add') {
    const a = typeof args.a === 'number' ? args.a : 0;
    const b = typeof args.b === 'number' ? args.b : 0;
    return result(id, { content: [{ type: 'text', text: `external-add: ${a + b}` }] });
  }
  return result(id, { content: [{ type: 'text', text: `unknown external tool: ${String(name)}` }], isError: true });
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
    case 'resources/list':
    case 'resources/templates/list':
    case 'prompts/list':
      if (!isNotification) result(id, { [method.split('/')[0]]: [] });
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
