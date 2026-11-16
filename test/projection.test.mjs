/**
 * MCP result projection + tool definition unit tests.
 *
 * These modules are the seam between an untrusted MCP `CallToolResult` and what
 * the model sees, so the tests cover every content block the contract names:
 * text joining, resource links, unsupported blocks, error results, and the
 * image diagnostics that must appear when no attachment service is mounted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor, createOutput, extractText, projectContent } from '../lib/result-projection.js';
import { createMcpToolDefinition } from '../lib/tool-definition.js';

const PNG_BASE64 = Buffer.from('not really a png').toString('base64');

/** A minimal canonical server record for a tool definition. */
function server(overrides = {}) {
  return {
    id: 'srv_1f3c9a2b70',
    key: 'my-key',
    name: 'My Server',
    transport: 'http',
    url: 'http://127.0.0.1:3000/mcp',
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** A minimal live MCP tool descriptor. */
function liveTool(overrides = {}) {
  return {
    rawName: 'echo',
    publicName: undefined,
    description: 'Echo text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: undefined,
    taskRequired: false,
    ...overrides,
  };
}

/** A host context with no optional services mounted. */
function bareHostCtx() {
  return { get: () => undefined };
}

/* ---------------------------------------------------------------- */
/* projectContent / extractText                                      */
/* ---------------------------------------------------------------- */

test('projection: text blocks are joined into one text block', () => {
  const projected = projectContent([{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }], 'echo');
  assert.deepEqual(projected, [{ type: 'text', text: 'line one\nline two' }]);
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'echo'), 'a\nb');
});

test('projection: resource links become readable text', () => {
  const projected = projectContent([{ type: 'resource_link', name: 'notes.txt', uri: 'file:///tmp/notes.txt' }], 'echo');
  assert.deepEqual(projected, [{ type: 'text', text: 'Resource link: notes.txt (file:///tmp/notes.txt)' }]);
  assert.match(extractText([{ type: 'resource_link', uri: 'file:///x' }], 'echo'), /missing its name or URI/u);
});

test('projection: unsupported blocks degrade to diagnostics instead of disappearing', () => {
  const text = extractText([
    { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
    { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
    { type: 'video', data: 'x' },
    'not-an-object',
    null,
  ], 'echo');
  assert.match(text, /\[audio result unsupported: audio\/wav;/u);
  assert.match(text, /\[embedded resource unsupported;/u);
  assert.match(text, /\[unsupported MCP content type: video\]/u);
  assert.match(text, /\[unsupported MCP content block: expected an object\]/u);
  assert.equal(text.split('unsupported MCP content block').length - 1, 2);
});

test('projection: an empty result still says something', () => {
  assert.deepEqual(projectContent([], 'echo'), [{ type: 'text', text: '(echo returned no model-visible content)' }]);
  assert.deepEqual(projectContent([{ type: 'text' }], 'echo'), [{ type: 'text', text: '(echo returned no model-visible content)' }]);
});

test('projection: images split text runs at their original position', () => {
  const projected = projectContent([
    { type: 'text', text: 'before' },
    { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    { type: 'text', text: 'after' },
  ], 'echo', (block, index) => ({ type: 'text', text: `image at ${index} (${block.mimeType})` }));
  assert.deepEqual(projected, [
    { type: 'text', text: 'before' },
    { type: 'text', text: 'image at 1 (image/png)' },
    { type: 'text', text: 'after' },
  ]);
});

test('projection: a default image projection explains why the model cannot see it', () => {
  const text = extractText([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }], 'echo');
  assert.match(text, /\[image unavailable: image\/png;/u);
  assert.match(text, /raw image data remains available to programmatic callers/u);
});

/* ---------------------------------------------------------------- */
/* createOutput                                                      */
/* ---------------------------------------------------------------- */

test('projection: createOutput advertises the canonical schema and renders text', () => {
  const plain = createOutput('echo', false);
  assert.deepEqual(plain.schema, {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content'],
    additionalProperties: false,
  });
  const structured = createOutput('echo', true);
  assert.deepEqual(structured.schema.required, ['content', 'structuredContent']);

  assert.deepEqual(plain.render({}, { content: [{ type: 'text', text: 'hi' }] }), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(plain.render({}, null), [{ type: 'text', text: '(echo returned no model-visible content)' }]);
  assert.deepEqual(plain.render({}, { content: 'not-an-array' }), [{ type: 'text', text: '(echo returned no model-visible content)' }]);
});

/* ---------------------------------------------------------------- */
/* createExecutor                                                    */
/* ---------------------------------------------------------------- */

/**
 * Build a projection-owning executor with a fake validator.
 * @param {object} options - call/validator/host options.
 * @returns {object} the executor, projections map and recorded calls.
 */
function executorHarness({ rawResult, validate = (raw) => ({ value: raw }), hostCtx = bareHostCtx(), taskRequired = false } = {}) {
  const calls = [];
  const projections = new WeakMap();
  const call = async (args, execution) => {
    calls.push({ args, execution });
    return rawResult;
  };
  const execute = createExecutor(hostCtx, {
    rawName: 'echo',
    taskRequired,
    call,
    validateResult: validate,
  }, projections);
  return { execute, projections, calls };
}

test('projection: a clean call returns the canonical value and stores no image projection', async () => {
  const content = [{ type: 'text', text: 'ok' }];
  const { execute, projections, calls } = executorHarness({ rawResult: { content } });
  const exec = {};
  const value = await execute({ text: 'hi' }, exec);
  assert.deepEqual(value, { content });
  assert.deepEqual(calls, [{ args: { text: 'hi' }, execution: exec }]);
  assert.equal(projections.get(exec), undefined);
});

test('projection: structuredContent is carried into the canonical value', async () => {
  const { execute } = executorHarness({
    rawResult: { content: [{ type: 'text', text: 'ok' }], structuredContent: { answer: 42 } },
  });
  const value = await execute({}, {});
  assert.deepEqual(value, { content: [{ type: 'text', text: 'ok' }], structuredContent: { answer: 42 } });
});

test('projection: a non-object argument value is sent as an empty object', async () => {
  const { execute, calls } = executorHarness({ rawResult: { content: [{ type: 'text', text: 'ok' }] } });
  await execute(null, {});
  assert.deepEqual(calls[0].args, {});
});

test('projection: an isError result rejects the tool call with the joined text', async () => {
  const { execute } = executorHarness({
    rawResult: { content: [{ type: 'text', text: 'server exploded' }, { type: 'text', text: 'second line' }], isError: true },
  });
  await assert.rejects(() => execute({}, {}), /server exploded\nsecond line/u);
});

test('projection: a result that violates the MCP schema rejects with the tool identity', async () => {
  const { execute } = executorHarness({
    rawResult: {},
    validate: () => ({ issues: [{ message: 'content is required' }, { message: 'second issue' }] }),
  });
  await assert.rejects(() => execute({}, {}), /tool "echo" returned an invalid MCP result: content is required; second issue/u);
});

test('projection: a task-required MCP tool is refused instead of silently failing', async () => {
  const { execute } = executorHarness({ rawResult: { content: [] }, taskRequired: true });
  await assert.rejects(() => execute({}, {}), /requires MCP task-based execution/u);
});

test('projection: an image result without an attachment service becomes a diagnostic', async () => {
  const content = [{ type: 'text', text: 'look' }, { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }];
  const { execute, projections } = executorHarness({ rawResult: { content } });
  const exec = {};
  const value = await execute({}, exec);
  assert.deepEqual(value, { content });
  const projection = projections.get(exec);
  assert.ok(projection, 'an image-bearing result must be remembered for projectContent');
  assert.deepEqual(projection.value, value);
  assert.deepEqual(projection.fallback, [{ type: 'text', text: extractText(content, 'echo') }]);
  assert.equal(projection.content.length, 2);
  assert.deepEqual(projection.content[0], { type: 'text', text: 'look' });
  assert.equal(projection.content[1].type, 'text');
  assert.match(projection.content[1].text, /no attachment store is mounted/u);
});

test('projection: an image is stored when the model declares image input', async () => {
  const content = [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }];
  const saved = [];
  const hostCtx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImages(images) {
            saved.push(...images);
            return images.map((image, index) => ({ attachmentId: `att-${index}`, mediaType: image.mediaType }));
          },
          isAttachmentError: () => false,
        };
      }
      if (name === 'llm') {
        return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
      }
      return undefined;
    },
  };
  const { execute, projections } = executorHarness({ rawResult: { content }, hostCtx });
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } } };
  await execute({}, exec);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  const projection = projections.get(exec);
  assert.deepEqual(projection.content, [{ type: 'image', attachment: { attachmentId: 'att-0', mediaType: 'image/png' } }]);
});

test('projection: a model without image input gets a readable reason', async () => {
  const hostCtx = {
    get(name) {
      if (name === 'attachments') return { saveImages: async () => [], isAttachmentError: () => false };
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) };
      return undefined;
    },
  };
  const { execute, projections } = executorHarness({
    rawResult: { content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] },
    hostCtx,
  });
  const exec = { agent: { options: { provider: 'p', model: 'm' } } };
  await execute({}, exec);
  assert.match(projections.get(exec).content[0].text, /does not declare image input/u);
});

test('projection: a malformed image is diagnosed before any attachment call', async () => {
  let saved = 0;
  const hostCtx = {
    get(name) {
      if (name === 'attachments') return { saveImages: async () => { saved += 1; return []; } };
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
      return undefined;
    },
  };
  for (const block of [
    { type: 'image', data: 'not base64!', mimeType: 'image/png' },
    { type: 'image', data: PNG_BASE64, mimeType: 'image/svg+xml' },
  ]) {
    const { execute, projections } = executorHarness({ rawResult: { content: [block] }, hostCtx });
    const exec = {};
    await execute({}, exec);
    assert.equal(projections.get(exec).content[0].type, 'text');
    assert.match(projections.get(exec).content[0].text, /\[image unavailable:/u);
  }
  assert.equal(saved, 0, 'an invalid image must never reach the attachment store');
});

test('projection: an attachment rejection falls back to text', async () => {
  const hostCtx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImages() {
            const error = new Error('quota exceeded');
            error.name = 'AttachmentError';
            throw error;
          },
          isAttachmentError: () => true,
        };
      }
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
      return undefined;
    },
  };
  const { execute, projections } = executorHarness({
    rawResult: { content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] },
    hostCtx,
  });
  const exec = { agent: { options: { provider: 'p', model: 'm' } } };
  await execute({}, exec);
  assert.match(projections.get(exec).content[0].text, /rejected the result: quota exceeded/u);
});

/* ---------------------------------------------------------------- */
/* createMcpToolDefinition                                           */
/* ---------------------------------------------------------------- */

test('tool definition: builds the name, description, parameters and output', () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool(),
    call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  assert.equal(definition.name, 'mcp__my-key__echo');
  assert.equal(definition.description, 'Echo text');
  assert.deepEqual(definition.parameters, { type: 'object', properties: { text: { type: 'string' } } });
  assert.equal(definition.timeoutMs, 60_000);
  assert.equal(typeof definition.execute, 'function');
  assert.equal(typeof definition.projectContent, 'function');
  assert.deepEqual(definition.output.schema.required, ['content']);
});

test('tool definition: prefers the precomputed public name and falls back for descriptions', () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server({ name: 'Files' }),
    tool: liveTool({ publicName: 'mcp__my-key__echo_0123456789ab', description: '' }),
    call: async () => ({ content: [] }),
  });
  assert.equal(definition.name, 'mcp__my-key__echo_0123456789ab');
  assert.equal(definition.description, 'MCP tool "echo" from server "Files"');
});

test('tool definition: an upstream output schema requires structuredContent', () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool({ outputSchema: { type: 'object' } }),
    call: async () => ({ content: [] }),
  });
  assert.deepEqual(definition.output.schema.required, ['content', 'structuredContent']);
});

test('tool definition: a non-finite timeout is omitted', () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server({ timeoutMs: undefined }),
    tool: liveTool(),
    call: async () => ({ content: [] }),
  });
  assert.equal('timeoutMs' in definition, false);
});

test('tool definition: execute validates a real MCP result through the SDK schema', async () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool(),
    call: async () => ({ content: [{ type: 'text', text: 'hello' }] }),
  });
  const value = await definition.execute({}, {});
  assert.deepEqual(value, { content: [{ type: 'text', text: 'hello' }] });
  assert.equal(definition.projectContent({}, { isError: false, value, content: [{ type: 'text', text: 'hello' }] }), undefined);

  const broken = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool(),
    call: async () => ({ content: 'not an array' }),
  });
  await assert.rejects(() => broken.execute({}, {}), /invalid MCP result/u);
});

test('tool definition: a text result never gets a custom projection', async () => {
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool(),
    call: async () => ({ content: [{ type: 'text', text: 'plain' }] }),
  });
  const exec = {};
  const value = await definition.execute({}, exec);
  assert.equal(definition.projectContent(exec, { isError: false, value, content: [] }), undefined);
});

test('tool definition: an image result projects the stored fallback content', async () => {
  const content = [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }];
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool({ rawName: 'screenshot' }),
    call: async () => ({ content }),
  });
  const exec = {};
  const value = await definition.execute({}, exec);
  const fallbackText = extractText(content, 'screenshot');
  const projected = definition.projectContent(exec, { isError: false, value, content: [{ type: 'text', text: fallbackText }] });
  assert.ok(Array.isArray(projected));
  assert.equal(projected[0].type, 'text');
  assert.match(projected[0].text, /no attachment store is mounted/u);
  // The projection is one-shot: a second read has nothing to project.
  assert.equal(definition.projectContent(exec, { isError: false, value, content: [{ type: 'text', text: fallbackText }] }), undefined);
});

test('tool definition: projectContent declines when the value or content was rewritten', async () => {
  const content = [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }];
  const definition = createMcpToolDefinition({
    hostCtx: bareHostCtx(),
    server: server(),
    tool: liveTool({ rawName: 'screenshot' }),
    call: async () => ({ content }),
  });
  const exec = {};
  const value = await definition.execute({}, exec);
  assert.equal(definition.projectContent(exec, { isError: true, value, content: [] }), undefined);
  assert.equal(definition.projectContent(exec, { isError: false, value: { content: [] }, content: [] }), undefined);
});
