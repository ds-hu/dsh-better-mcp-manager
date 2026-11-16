#!/usr/bin/env node
/**
 * E2E fixture: a local OpenAI-compatible chat endpoint, no dependencies.
 *
 * Serves only what the isolated DeepSeek Harness instance needs, and records
 * everything an assertion needs to see:
 *
 *   POST /v1/chat/completions   streaming (default) or non-streaming reply.
 *                               Every request body is recorded, notably
 *                               `tools[].function.name` and `messages`.
 *   GET  /v1/models             minimal model listing.
 *   GET  /__e2e/state           { requests: [...], config, count }
 *   POST /__e2e/reset           clear recorded requests
 *   POST /__e2e/config          replace the marker->reply rule table
 *   GET  /__e2e/health          { ok: true }
 *
 * Rules (config.markers) are matched against the *user* message text of the
 * request. A rule fires only for requests that carry a `tools` array, so
 * harness side-calls (session titles, compaction) always get plain text.
 *
 * Rule shape:
 *   { "match": "E2E-STD-abc", "reply": { "kind": "text", "text": "..." } }
 *   { "match": "E2E-TOOL-abc", "reply": { "kind": "tool",
 *                                          "toolName": "mcp__echo__echo",
 *                                          "arguments": { "text": "hi" } } }
 *
 * Once a request contains a tool result (role "tool"), no marker rule fires:
 * the model answers with `config.afterToolText` (default "fixture: tool result
 * observed"), which ends the agent loop deterministically.
 *
 * Flags / environment:
 *   --port <n>   listen port, 0 = free (default 0)
 *   FAKE_LLM_DEBUG=1  log each request line to stderr
 *
 * On start prints one JSON line: {"port":123,"baseURL":"http://127.0.0.1:123/v1"}
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const PORT = Number(argOf('--port', process.env.FAKE_LLM_PORT || '0'));
const DEBUG = process.env.FAKE_LLM_DEBUG === '1';

const MAX_REQUESTS = 200;
const MAX_TEXT = 16 * 1024;

/** @type {{ requests: any[], config: any }} */
const state = {
  requests: [],
  config: {
    defaultText: 'fixture-llm: plain reply',
    afterToolText: 'fixture-llm: tool result observed',
    markers: [],
  },
};

function log(...parts) {
  if (DEBUG) process.stderr.write(`[fake-llm] ${parts.join(' ')}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clip(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[clipped]` : text;
}

/** Normalize one OpenAI chat message into something small and assertable. */
function normalizeMessage(message) {
  const role = typeof message?.role === 'string' ? message.role : 'unknown';
  const normalized = { role };
  if (typeof message?.content === 'string') {
    normalized.text = clip(message.content);
  } else if (Array.isArray(message?.content)) {
    const texts = [];
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (part?.type === 'image_url') texts.push('[image]');
      else if (part?.type === 'input_text' && typeof part.text === 'string') texts.push(part.text);
    }
    normalized.text = clip(texts.join('\n'));
  }
  if (Array.isArray(message?.tool_calls)) {
    normalized.tool_calls = message.tool_calls.map((call) => ({
      id: call?.id,
      name: call?.function?.name,
      arguments: clip(call?.function?.arguments ?? ''),
    }));
  }
  if (typeof message?.tool_call_id === 'string') normalized.tool_call_id = message.tool_call_id;
  if (typeof message?.name === 'string') normalized.name = message.name;
  return normalized;
}

function collectToolResultTexts(messages) {
  const texts = [];
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
    const content = message.content;
    if (typeof content === 'string') texts.push(clip(content));
    else if (Array.isArray(content)) {
      for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') texts.push(clip(part.text));
    }
  }
  return texts;
}

/**
 * Every user message's text, in order. The Harness appends runtime-context and
 * time-context as *separate* user messages, so a marker must be matched over
 * the whole set — the last user message is usually not the prompt itself.
 */
function userTexts(messages) {
  const texts = [];
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') texts.push(message.content);
    else if (Array.isArray(message.content)) {
      texts.push(
        message.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n'),
      );
    }
  }
  return texts;
}

function joinedUserText(messages) {
  return userTexts(messages).join('\n');
}

function pickReply(request, body) {
  const toolNames = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name ?? tool?.name) : [];
  const hasTools = toolNames.length > 0;
  const toolResults = collectToolResultTexts(body.messages ?? []);
  if (hasTools && toolResults.length > 0) {
    return { kind: 'text', text: state.config.afterToolText };
  }
  const marker = joinedUserText(body.messages ?? []);
  if (hasTools) {
    for (const rule of state.config.markers ?? []) {
      if (typeof rule?.match === 'string' && marker.includes(rule.match)) return { ...rule.reply, rule: rule.match };
    }
  }
  return { kind: 'text', text: state.config.defaultText };
}

function completionChunk(model, delta, finishReason, extra = {}) {
  return {
    id: `chatcmpl-fixture-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

const USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };

function writeSse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamText(res, model, text) {
  writeSse(res, [
    completionChunk(model, { role: 'assistant', content: '' }, null),
    completionChunk(model, { content: text }, null),
    completionChunk(model, {}, 'stop', { usage: USAGE }),
  ]);
}

function streamToolCall(res, model, toolName, toolArguments) {
  writeSse(res, [
    completionChunk(model, { role: 'assistant', content: null }, null),
    completionChunk(
      model,
      {
        tool_calls: [
          {
            index: 0,
            id: `call_fixture_${randomUUID().slice(0, 8)}`,
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(toolArguments ?? {}) },
          },
        ],
      },
      null,
    ),
    completionChunk(model, {}, 'tool_calls', { usage: USAGE }),
  ]);
}

function completionJson(model, reply) {
  const message =
    reply.kind === 'tool'
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_fixture_${randomUUID().slice(0, 8)}`,
              type: 'function',
              function: { name: reply.toolName, arguments: JSON.stringify(reply.arguments ?? {}) },
            },
          ],
        }
      : { role: 'assistant', content: String(reply.text ?? '') };
  return {
    id: `chatcmpl-fixture-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === 'tool' ? 'tool_calls' : 'stop' }],
    usage: USAGE,
  };
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }));
    return;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const toolNames = Array.isArray(body?.tools)
    ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === 'string')
    : [];
  const record = {
    seq: state.requests.length + 1,
    at: new Date().toISOString(),
    model: body?.model,
    stream: body?.stream !== false,
    userText: clip(joinedUserText(messages)),
    userTexts: userTexts(messages).map(clip),
    tools: toolNames,
    toolCount: toolNames.length,
    messages: messages.map(normalizeMessage),
    toolResultTexts: collectToolResultTexts(messages),
    systemText: clip(
      messages
        .filter((message) => message?.role === 'system' || message?.role === 'developer')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n'),
    ),
  };
  state.requests.push(record);
  if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS);

  const reply = pickReply(record, body);
  record.replyKind = reply.kind;
  record.matchedRule = reply.rule ?? null;
  log('chat', JSON.stringify({ seq: record.seq, tools: record.toolCount, marker: record.userText.slice(0, 40), reply: reply.kind }));

  if (body?.stream === false) {
    const payload = completionJson(body?.model ?? 'fixture-model', reply);
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(data.length) });
    res.end(data);
    return;
  }
  if (reply.kind === 'tool') streamToolCall(res, body?.model ?? 'fixture-model', reply.toolName, reply.arguments);
  else streamText(res, body?.model ?? 'fixture-model', String(reply.text ?? ''));
}

async function handleControl(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/__e2e/state') {
    const data = Buffer.from(JSON.stringify({ count: state.requests.length, requests: state.requests, config: state.config }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(data.length) });
    res.end(data);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__e2e/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
    await readBody(req).catch(() => {});
    state.requests.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__e2e/config') {
    const raw = await readBody(req);
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }
    state.config = {
      ...state.config,
      ...config,
      markers: Array.isArray(config?.markers) ? config.markers : state.config.markers,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: state.config }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'unknown control endpoint' }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'fixture-model', object: 'model', owned_by: 'mcp-e2e-fixture' }],
      }),
    );
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    handleChatCompletions(req, res).catch((error) => {
      process.stderr.write(`[fake-llm] chat handler failed: ${String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error), type: 'server_error' } }));
    });
    return;
  }
  if (url.pathname.startsWith('/__e2e/')) {
    handleControl(req, res, url).catch((error) => {
      process.stderr.write(`[fake-llm] control handler failed: ${String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

server.on('error', (error) => {
  process.stderr.write(`[fake-llm] server error: ${String(error)}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  process.stdout.write(`${JSON.stringify({ port, baseURL: `http://127.0.0.1:${port}/v1` })}\n`);
  log('listening', String(port));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
