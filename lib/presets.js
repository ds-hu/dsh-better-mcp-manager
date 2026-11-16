/**
 * Per-preset exposure: registering one server's tools on the agents that may
 * use them.
 *
 * DSH agent presets are declarations mounted in isolated scopes; an agent's
 * scope chain is what decides which tools it sees. A Host plugin cannot edit
 * preset YAML, but it can register tools on `agent.ctx` — they are scoped to
 * exactly that agent and disposed with it. This module owns that mapping:
 *
 * - `agent/created` (or the live-agent sweep at mount) → compute the agent's
 *   preset with `ctx.agentPresets.composedPreset(agent.ctx)`, take every enabled
 *   server whose `presets` selection admits that preset, and register the
 *   server's currently live tools + instructions on `agent.ctx`;
 * - `agent/disposed` → dispose that agent's registrations;
 * - `agent-preset/selected` → rebind that session (a blank session may choose a
 *   different preset before its first turn);
 * - any configuration or connection change → rebind every live agent after a
 *   microtask, so one reconnect storm cannot cause a registration storm.
 *
 * Nothing is registered while a server is disconnected: dead tools never reach
 * a model. The diagnostics snapshot (`list()`) is what the panel shows and what
 * E2E asserts on.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/presets
 */
import { presetAllows, toolEnabled, toolNeedsApproval } from './model.js';
import { createMcpToolDefinition } from './tool-definition.js';

/**
 * Read the preset an agent is bound to, if the service is mounted.
 * @param {object} hostCtx - Host plugin context.
 * @param {Record<string, any>} agent - Live agent.
 * @returns {string | undefined} the preset id.
 */
function composedPreset(hostCtx, agent) {
  try {
    const presets = hostCtx.get('agentPresets');
    if (presets === undefined || typeof presets.composedPreset !== 'function') return undefined;
    return presets.composedPreset(agent.ctx);
  } catch {
    return undefined;
  }
}

/**
 * Read the live tools service from an agent context.
 * @param {Record<string, any>} agent - Live agent.
 * @returns {Record<string, any> | undefined} the registry.
 */
function agentTools(agent) {
  try {
    return agent.ctx?.get?.('tools');
  } catch {
    return undefined;
  }
}

/**
 * Build the exposure controller.
 * @param {object} options - Controller options.
 * @param {object} options.hostCtx - Host plugin context.
 * @param {Record<string, any>} options.store - The server store.
 * @param {Record<string, any>} options.manager - The connection manager.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @returns {object} the controller.
 */
export function createExposure({ hostCtx, store, manager, logger = () => {} }) {
  /** @type {Map<string, { preset?: string, servers: string[], tools: string[], disposers: (() => void)[] }>} */
  const bindings = new Map();
  let refreshScheduled = false;
  let disposed = false;

  /**
   * Dispose every registration owned by one session.
   * @param {string} sessionId - Session identity.
   * @returns {void}
   */
  const unbind = (sessionId) => {
    const binding = bindings.get(sessionId);
    if (binding === undefined) return;
    bindings.delete(sessionId);
    for (const dispose of binding.disposers) {
      try {
        dispose();
      } catch (error) {
        logger('warn', `better-mcp-manager: releasing a tool registration failed: ${error?.message ?? error}`);
      }
    }
  };

  /**
   * Register every admitted server's live tools on one agent.
   * @param {Record<string, any>} agent - Live agent.
   * @returns {void}
   */
  const bindAgent = (agent) => {
    if (disposed) return;
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined;
    if (sessionId === undefined) return;
    unbind(sessionId);
    const tools = agentTools(agent);
    if (tools === undefined) return;
    const preset = composedPreset(hostCtx, agent);
    /** @type {(() => void)[]} */
    const disposers = [];
    const servers = [];
    const exposedTools = [];
    /** @type {{ key: string, text: string }[]} */
    const serverInstructions = [];
    for (const server of store.list()) {
      if (!server.enabled) continue;
      if (!presetAllows(server, preset)) continue;
      const connection = manager.get(server.id);
      if (connection === undefined || connection.snapshot().state !== 'connected') continue;
      const liveTools = connection.tools();
      if (liveTools.length === 0) continue;
      let registeredForServer = 0;
      for (const tool of liveTools) {
        if (!toolEnabled(server, tool.rawName)) continue;
        try {
          const definition = createMcpToolDefinition({
            hostCtx,
            server,
            tool,
            approvalRequired: toolNeedsApproval(server, tool.rawName),
            call: (args, execution) => manager.callTool(server.id, tool.rawName, args, execution),
          });
          disposers.push(tools.register(definition));
          exposedTools.push(definition.name);
          registeredForServer += 1;
        } catch (error) {
          logger('warn', `better-mcp-manager: registering tool "${tool.publicName}" from "${server.name}" failed: ${error?.message ?? error}`);
        }
      }
      // A server whose tools are all disabled contributes neither tools nor an
      // instruction section: the model is not told about behavior it cannot use.
      if (registeredForServer === 0) continue;
      servers.push(server.key);
      const text = connection.instructions();
      if (text.trim().length > 0) serverInstructions.push({ key: server.key, text: text.trim() });
    }
    if (serverInstructions.length > 0) {
      try {
        const systemPrompt = agent.ctx?.get?.('systemPrompt');
        if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
          // One section per server, exactly the official MCP bridge's shape:
          // a server that updates its instructions only rewrites its own text.
          const order = typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('MCP_SERVERS') : 130;
          for (const server of serverInstructions) {
            disposers.push(systemPrompt.section({
              name: `mcp-manager:${server.key}`,
              order,
              interpolate: false,
              text: () => server.text,
            }));
          }
        }
      } catch (error) {
        logger('warn', `better-mcp-manager: adding MCP server instructions failed: ${error?.message ?? error}`);
      }
    }
    bindings.set(sessionId, { preset, servers, tools: exposedTools, disposers });
  };

  /**
   * Live agents from the registry, when that service is mounted.
   * @returns {Record<string, any>[]} the agents.
   */
  const liveAgents = () => {
    try {
      const agents = hostCtx.get('agents');
      if (agents === undefined || typeof agents.list !== 'function') return [];
      return agents.list();
    } catch {
      return [];
    }
  };

  /**
   * Rebind every live agent and prune bindings for agents that left.
   * @returns {void}
   */
  const bindAll = () => {
    if (disposed) return;
    const agents = liveAgents();
    const live = new Set();
    for (const agent of agents) {
      if (typeof agent?.id === 'string') live.add(agent.id);
      bindAgent(agent);
    }
    for (const sessionId of [...bindings.keys()]) {
      if (!live.has(sessionId)) unbind(sessionId);
    }
  };

  /**
   * Coalesce a burst of change notifications into one rebind pass.
   * @returns {void}
   */
  const refreshSoon = () => {
    if (disposed || refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      try {
        bindAll();
      } catch (error) {
        logger('warn', `better-mcp-manager: refreshing tool exposure failed: ${error?.message ?? error}`);
      }
    });
  };

  /**
   * Handle one agent lifecycle event.
   * @param {Record<string, any>} agent - Live agent.
   * @returns {void}
   */
  const onAgentCreated = (agent) => {
    bindAgent(agent);
  };

  /**
   * Handle one agent disposal.
   * @param {Record<string, any>} agent - Agent that left the registry.
   * @returns {void}
   */
  const onAgentDisposed = (agent) => {
    if (typeof agent?.id === 'string') unbind(agent.id);
  };

  /**
   * Handle a committed preset selection for a session.
   * @param {string} sessionId - Session identity.
   * @returns {void}
   */
  const onPresetSelected = (sessionId) => {
    const agent = liveAgents().find((candidate) => candidate?.id === sessionId);
    if (agent === undefined) {
      unbind(sessionId);
      return;
    }
    bindAgent(agent);
  };

  /**
   * Detached diagnostics of the current exposure (panel + E2E).
   * @returns {{ sessionId: string, preset?: string, servers: string[], tools: string[] }[]} the bindings.
   */
  const list = () => [...bindings.entries()].map(([sessionId, binding]) => ({
    sessionId,
    preset: binding.preset,
    servers: [...binding.servers],
    tools: [...binding.tools],
  }));

  /**
   * Release every binding.
   * @returns {void}
   */
  const dispose = () => {
    disposed = true;
    for (const sessionId of [...bindings.keys()]) unbind(sessionId);
  };

  return { bindAgent, bindAll, unbind, refreshSoon, list, dispose, onAgentCreated, onAgentDisposed, onPresetSelected };
}
