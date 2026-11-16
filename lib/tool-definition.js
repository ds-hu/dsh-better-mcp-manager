/**
 * Hand-built Harness `ToolDefinition`s for MCP tools.
 *
 * A profile-installed plugin cannot import `@deepseek-ai/dsh-tools` (the profile
 * only resolves packages it installed plus the Cordis peer), so `defineTool` is
 * unavailable here. The raw definition object below is the same shape the
 * registry accepts, and `result-projection.js` carries the behavior:
 *
 * ```
 * { name, description, parameters, output, timeoutMs?, execute, projectContent? }
 * ```
 *
 * `parameters` is the MCP input schema verbatim; the registry projects it as the
 * model-facing argument schema without validating it against the supported
 * subset (only `output.schema` is checked, and that one is ours).
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/tool-definition
 */
import { isDeepStrictEqual } from 'node:util';
import { specTypeSchemas } from '@modelcontextprotocol/client';
import { createExecutor, createOutput } from './result-projection.js';
import { publicToolName } from './model.js';

/**
 * Validate one raw MCP result with the SDK's own spec schema.
 * @param {unknown} raw - Result returned by `client.callTool`.
 * @returns {{ issues?: { message: string }[], value: any }} standard-schema result.
 */
function validateResult(raw) {
  return specTypeSchemas.CallToolResult['~standard'].validate(raw);
}

/**
 * Build one Harness tool definition for one MCP tool.
 * @param {object} options - Definition options.
 * @param {object} options.hostCtx - Host plugin context (attachment/llm lookups happen at call time).
 * @param {Record<string, any>} options.server - Stored server the tool belongs to.
 * @param {Record<string, any>} options.tool - Live MCP tool descriptor.
 * @param {(args: Record<string, unknown>, execution: any) => Promise<unknown>} options.call - Raw MCP call callback.
 * @param {boolean} [options.approvalRequired] - Ask before calling outside full-access sessions.
 * @returns {Record<string, any>} the tool definition.
 */
export function createMcpToolDefinition({ hostCtx, server, tool, call, approvalRequired = false }) {
  const projections = new WeakMap();
  const rawName = tool.rawName;
  const timeoutMs = server.timeoutMs;
  return {
    name: tool.publicName ?? publicToolName(server.key, rawName),
    description: tool.description.length > 0 ? tool.description : `MCP tool "${rawName}" from server "${server.name}"`,
    parameters: tool.inputSchema,
    output: createOutput(rawName, tool.outputSchema !== undefined),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    execute: createExecutor(
      hostCtx,
      {
        rawName,
        publicName: tool.publicName ?? publicToolName(server.key, rawName),
        taskRequired: tool.taskRequired === true,
        requiresApproval: approvalRequired === true,
        call,
        validateResult,
      },
      projections,
    ),
    projectContent(exec, result) {
      const projection = projections.get(exec);
      if (projection === undefined) return undefined;
      projections.delete(exec);
      if (result.isError) return undefined;
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined;
      return projection.content;
    },
  };
}
