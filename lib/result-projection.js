/**
 * MCP result projection.
 *
 * Adapted from `@deepseek-ai/dsh-mcp-client` (MIT, DeepSeek) — see NOTICE. Its
 * job is the narrow, subtle seam between an untrusted MCP `CallToolResult` and
 * the Harness's canonical tool value + model-visible content:
 *
 * - a result whose `isError` is true rejects the tool call (recorded as a
 *   failure, never as a fake success);
 * - text blocks are joined, resource links become text, audio/embedded
 *   resources say they are unavailable to the model while the raw value stays
 *   available to programmatic callers;
 * - canonical-base64 images are stored through the Host attachment service
 *   only when the current model declares image input, and otherwise project to
 *   a readable diagnostic instead of disappearing.
 *
 * The module deliberately imports nothing from `@deepseek-ai/*`: the Host
 * services it needs are looked up at call time so a profile without them
 * degrades to text instead of failing to load.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/result-projection
 */

/** Raster formats supported by the durable attachment vocabulary. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Canonical RFC 4648 base64 (no whitespace, no URL-safe aliases). */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Narrow one JSON value to a string-keyed object.
 * @param {unknown} value - Candidate.
 * @returns {value is Record<string, any>} whether it is a record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether an untrusted content array declares at least one image block.
 * @param {ReadonlyArray<unknown>} content - MCP content blocks.
 * @returns {boolean} the answer.
 */
function containsImage(content) {
  return content.some((value) => isRecord(value) && value.type === 'image');
}

/**
 * Narrow a declared MIME string to the durable image vocabulary.
 * @param {unknown} value - Declared media type.
 * @returns {boolean} the answer.
 */
function isImageMediaType(value) {
  return typeof value === 'string' && IMAGE_MEDIA_TYPES.includes(value);
}

/**
 * Decode one declared image without accepting base64 aliases.
 * @param {Record<string, any>} block - MCP image block.
 * @returns {{ data: Buffer, mediaType: string }} decoded image.
 * @throws {Error} when the media type or the base64 payload is invalid.
 */
function decodeImage(block) {
  if (!isImageMediaType(block.mimeType)) throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF');
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) throw new Error('the image data is not canonical base64');
  const data = Buffer.from(block.data, 'base64');
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64');
  return { data, mediaType: block.mimeType };
}

/**
 * Stable diagnostic text for an image block that was not admitted.
 * @param {Record<string, any>} block - MCP image block.
 * @param {string} reason - Why the image is not model-visible.
 * @returns {string} diagnostic text.
 */
function imageDiagnostic(block, reason) {
  return `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}; raw image data remains available to programmatic callers]`;
}

/**
 * Project ordered MCP blocks into the core content vocabulary.
 * Text-like runs are newline-coalesced; admitted images split those runs at
 * their original position.
 * @param {ReadonlyArray<unknown>} content - MCP content blocks.
 * @param {string} toolName - Raw tool name used in the empty-result notice.
 * @param {(block: Record<string, any>, index: number) => Record<string, any>} [image] - Image projector.
 * @returns {Record<string, any>[]} core content blocks.
 */
export function projectContent(content, toolName, image = (block) => ({
  type: 'text',
  text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
})) {
  const projected = [];
  const text = [];
  const flushText = () => {
    if (text.length === 0) return;
    projected.push({ type: 'text', text: text.splice(0).join('\n') });
  };
  for (const [index, value] of content.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]');
      continue;
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) text.push(String(value.text));
        break;
      case 'image':
        flushText();
        projected.push(image(value, index));
        break;
      case 'resource_link':
        if (value.name === undefined || value.uri === undefined) text.push('[resource link unavailable: the MCP block is missing its name or URI]');
        else text.push(`Resource link: ${value.name} (${value.uri})`);
        break;
      case 'audio':
        text.push(`[audio result unsupported: ${value.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`);
        break;
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]');
        break;
      default:
        text.push(`[unsupported MCP content type: ${String(value.type)}]`);
    }
  }
  flushText();
  return projected.length > 0 ? projected : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }];
}

/**
 * Extract text from an MCP content array into one string.
 * @param {ReadonlyArray<unknown>} content - MCP content blocks.
 * @param {string} toolName - Raw tool name used in the empty-result notice.
 * @returns {string} model-visible text.
 */
export function extractText(content, toolName) {
  return projectContent(content, toolName).map((block) => block.text).join('\n');
}

/**
 * Resolve the active model route and durable store for an image-bearing result.
 * @param {object} hostCtx - Host plugin context.
 * @param {Record<string, any>} exec - Exact tool execution whose agent supplies the latest route.
 * @returns {Promise<Record<string, any>>} the attachment store after positive image capability proof.
 * @throws {Error} when no attachment store or model route is available.
 */
async function resolveImageAdmission(hostCtx, exec) {
  const attachments = hostCtx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment store is mounted');
  let routed;
  try {
    routed = exec.agent?.session?.requestHeader?.()?.config;
  } catch {
    routed = undefined;
  }
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = hostCtx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) throw new Error('the current model route could not be resolved');
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    throw new Error('the current model route could not be verified');
  }
  if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`);
  }
  if (exec.signal?.aborted) throw new Error('the tool call was canceled before image storage');
  return attachments;
}

/**
 * Decode, preflight and durably save one result's ordered image batch.
 * Any refusal projects every image as text while retaining the canonical raw
 * value for programmatic callers.
 * @param {object} hostCtx - Host plugin context.
 * @param {Record<string, any>} exec - Exact tool execution.
 * @param {ReadonlyArray<unknown>} content - MCP content blocks.
 * @param {string} toolName - Raw tool name.
 * @returns {Promise<Record<string, any>[]>} projected content blocks.
 */
async function prepareImageProjection(hostCtx, exec, content, toolName) {
  const decoded = [];
  const validationErrors = new Map();
  const imageIndexes = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue;
    imageIndexes.push(index);
    try {
      decoded.push(decodeImage(value));
    } catch (error) {
      validationErrors.set(index, error.message);
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(block, validationErrors.get(index) ?? 'another image in the same result was invalid'),
    }));
  }
  let attachments;
  try {
    attachments = await resolveImageAdmission(hostCtx, exec);
  } catch (error) {
    const reason = error.message;
    return projectContent(content, toolName, (block) => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    }));
  }
  try {
    const refs = await attachments.saveImages(decoded);
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]));
    return projectContent(content, toolName, (_block, index) => ({
      type: 'image',
      attachment: byIndex.get(index),
    }));
  } catch (error) {
    const reason = attachments.isAttachmentError?.(error) === true
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result';
    return projectContent(content, toolName, (block) => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    }));
  }
}

/**
 * Build the fixed canonical-result schema and its text projection.
 *
 * The advertised MCP `outputSchema` is deliberately not embedded in the
 * canonical schema: it may use vocabulary the Harness schema subset rejects,
 * and registration would then fail for the whole tool. `structuredContent`
 * stays an opaque `{}` property (present but not required) so the canonical
 * value can carry it without weakening the tool's registration.
 * @param {string} rawName - Raw tool name for the empty-result notice.
 * @param {boolean} requiresStructuredContent - Whether the upstream declared an output schema.
 * @returns {{ schema: Record<string, unknown>, render: (args: unknown, value: any) => Record<string, any>[] }} canonical output.
 */
export function createOutput(rawName, requiresStructuredContent) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: requiresStructuredContent ? ['content', 'structuredContent'] : ['content'],
      additionalProperties: false,
    },
    /**
     * Project the canonical value into model-facing text.
     * @param {unknown} _args - Validated arguments (unused).
     * @param {any} value - Canonical result.
     * @returns {{ type: 'text', text: string }[]} one text block.
     */
    render(_args, value) {
      return [{ type: 'text', text: extractText(Array.isArray(value?.content) ? value.content : [], rawName) }];
    },
  };
}

/**
 * Build the executor for one MCP tool.
 *
 * The MCP result is validated against the SDK's own spec schema, images are
 * projected through the attachment service when available, and the exact
 * canonical `(value, content)` pair is retained so `projectContent` only
 * rewrites the content for the execution that produced it.
 * @param {object} hostCtx - Host plugin context (attachment/llm services).
 * @param {object} options - Tool options.
 * @param {string} options.rawName - Raw MCP tool name.
 * @param {boolean} [options.taskRequired] - Whether the tool needs unsupported task execution.
 * @param {(args: Record<string, unknown>, execution: any) => Promise<unknown>} options.call - Raw-result callback.
 * @param {WeakMap<object, { value: any, fallback: any[], content: any[] }>} options.projections - Projection memory shared with `projectContent`.
 * @param {(input: unknown) => any} options.validateResult - Spec validation function for the raw result.
 * @returns {(args: unknown, exec: any) => Promise<Record<string, any>>} the execute body.
 */
/**
 * Ask the Host approval seam once, unless the calling session has full access.
 *
 * `needsApproval` is an operator preference, not a replacement for the session's
 * permission preset: in the 完全权限 (`danger-full-access`) preset the call runs
 * directly; every other preset asks once, and a missing channel or a non-grant
 * fails the call instead of silently allowing it.
 * @param {object} hostCtx - Host plugin context.
 * @param {Record<string, any>} exec - Tool execution context.
 * @param {string} displayName - Model-facing tool name.
 * @returns {Promise<void>} completion when the call may proceed.
 */
async function enforceApproval(hostCtx, exec, displayName) {
  if (exec === undefined || exec === null) throw new Error(`tool "${displayName}" requires approval, but the call has no execution context`);
  const agent = exec.agent;
  if (agent === undefined || agent === null) throw new Error(`tool "${displayName}" requires approval, but the call is not attached to an agent`);
  let preset;
  try {
    const presets = hostCtx.get?.('permissionPresets');
    if (presets !== undefined && typeof presets.current === 'function') preset = presets.current(agent.session);
  } catch {
    preset = undefined;
  }
  if (preset === 'danger-full-access') return;
  const approval = hostCtx.get?.('approval');
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new Error(`tool "${displayName}" requires approval outside full access, but no approval channel is available`);
  }
  let outcome;
  try {
    outcome = await approval.request({
      agent,
      toolName: typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : displayName,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: `MCP 工具 "${displayName}" 需要审批（当前不是完全权限）`,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    });
  } catch (error) {
    throw new Error(`tool "${displayName}" requires approval, but the request failed: ${error?.message ?? error}`, { cause: error });
  }
  if (outcome === 'allowed-once') return;
  if (outcome === 'rejected') throw new Error(`the user rejected tool "${displayName}"`);
  if (outcome === 'cancelled') throw new Error(`approval for tool "${displayName}" was cancelled`);
  throw new Error(`tool "${displayName}" requires approval, but no approval channel is available`);
}

export function createExecutor(hostCtx, options, projections) {
  const { rawName, taskRequired } = options;
  return async (args, exec) => {
    if (taskRequired) throw new Error(`tool "${rawName}" requires MCP task-based execution, which this manager does not support`);
    if (options.requiresApproval === true) await enforceApproval(hostCtx, exec, options.publicName ?? rawName);
    const argsObj = typeof args === 'object' && args !== null ? args : {};
    const parsed = options.validateResult(await options.call(argsObj, exec));
    if (parsed.issues !== undefined) {
      throw new Error(`tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
    }
    const result = parsed.value;
    const content = Array.isArray(result.content) ? result.content : [];
    const text = extractText(content, rawName);
    if (result.isError === true) throw new Error(text);
    const value = {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
    if (containsImage(content)) {
      const fallback = [{ type: 'text', text }];
      const projected = await prepareImageProjection(hostCtx, exec, content, rawName);
      projections.set(exec, { value, fallback, content: projected });
    }
    return value;
  };
}
