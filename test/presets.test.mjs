/**
 * Per-preset exposure unit tests (docs/API-CONTRACT.md §2.4).
 *
 * `createExposure` owns the only mapping between a stored server and the tools
 * a given agent may see. The tests drive it with a fake store, manager and agent
 * registry: no Host, no MCP connection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExposure } from '../lib/presets.js';

/** One stored server record with the fields exposure reads. */
function server(overrides = {}) {
  return {
    id: `srv_${overrides.key ?? 'alpha'}`,
    key: 'alpha',
    name: 'Alpha',
    enabled: true,
    transport: 'http',
    url: 'http://127.0.0.1:3000/mcp',
    timeoutMs: 60_000,
    presets: 'all',
    ...overrides,
  };
}

/** One live MCP tool descriptor. */
function tool(rawName, key = 'alpha') {
  return {
    rawName,
    publicName: `mcp__${key}__${rawName}`,
    description: `${rawName} tool`,
    inputSchema: { type: 'object' },
    outputSchema: undefined,
    taskRequired: false,
  };
}

/** One fake connection supervisor. */
function connection({ state = 'connected', tools = [], instructions = '' } = {}) {
  return {
    snapshot: () => ({ state }),
    tools: () => tools,
    instructions: () => instructions,
  };
}

/**
 * Build an exposure controller over fake Host services.
 * @returns {object} the controller plus the registration logs.
 */
function harness({
  servers = [server()],
  connections = new Map([[`srv_alpha`, connection({ tools: [tool('echo')] })]]),
  presets = new Map(),
  agents = [],
  withTools = true,
  withSystemPrompt = true,
  withApproval = true,
} = {}) {
  const registered = [];
  const removed = [];
  const sections = [];
  const sectionRemoved = [];
  const sectionOrders = [];
  const callToolCalls = [];

  const toolsService = {
    register(definition) {
      registered.push(definition);
      return () => removed.push(definition.name);
    },
  };
  const systemPrompt = {
    getSectionOrder(name) {
      sectionOrders.push(name);
      return 130;
    },
    section(definition) {
      sections.push(definition);
      return () => sectionRemoved.push(definition.name);
    },
  };

  const approvalRequests = [];
  const approval = {
    request: async (input) => {
      approvalRequests.push(input);
      return 'allowed-once';
    },
  };
  const hostCtx = {
    get(name) {
      if (name === 'approval') return withApproval ? approval : undefined;
      if (name === 'permissionPresets') return withApproval ? { current: () => 'standard' } : undefined;
      if (name === 'agentPresets') {
        return {
          composedPreset(agentCtx) {
            return presets.get(agentCtx);
          },
        };
      }
      if (name === 'agents') return { list: () => agents };
      return undefined;
    },
  };
  const store = { list: () => servers };
  const manager = {
    get: (id) => connections.get(id),
    async callTool(...args) {
      callToolCalls.push(args);
      return { content: [{ type: 'text', text: 'tool result' }] };
    },
  };

  /** Create one fake agent whose context resolves the fake services. */
  function agent(id = 'sess-1') {
    const ctx = {
      id,
      get(name) {
        if (name === 'tools') return withTools ? toolsService : undefined;
        if (name === 'systemPrompt') return withSystemPrompt ? systemPrompt : undefined;
        return undefined;
      },
    };
    const record = { id, ctx };
    agents.push(record);
    return record;
  }

  const exposure = createExposure({ hostCtx, store, manager, logger: () => {} });
  return {
    exposure,
    agent,
    registered,
    removed,
    sections,
    sectionRemoved,
    sectionOrders,
    callToolCalls,
    approvalRequests,
    presets,
    agents,
  };
}

/* ---------------------------------------------------------------- */

test('presets: a connected "all" server exposes its tools on one agent', async () => {
  const { exposure, agent, registered, callToolCalls } = harness();
  const record = agent('sess-1');
  exposure.bindAgent(record);

  assert.deepEqual(registered.map((definition) => definition.name), ['mcp__alpha__echo']);
  assert.deepEqual(exposure.list(), [{
    sessionId: 'sess-1',
    preset: undefined,
    servers: ['alpha'],
    tools: ['mcp__alpha__echo'],
  }]);

  const value = await registered[0].execute({ query: 'x' }, {});
  assert.deepEqual(value, { content: [{ type: 'text', text: 'tool result' }] });
  assert.deepEqual(callToolCalls, [['srv_alpha', 'echo', { query: 'x' }, {}]]);
});

test('presets: an array selection admits only the named preset', () => {
  const scoped = server({ presets: ['standard'] });
  {
    const { exposure, agent, registered, presets } = harness({ servers: [scoped] });
    const record = agent('sess-standard');
    presets.set(record.ctx, 'standard');
    exposure.bindAgent(record);
    assert.equal(registered.length, 1, 'the selected preset sees the tools');
  }
  {
    const { exposure, agent, presets, registered } = harness({ servers: [scoped] });
    const record = agent('sess-custom');
    presets.set(record.ctx, 'custom');
    exposure.bindAgent(record);
    assert.deepEqual(registered, []);
    assert.deepEqual(exposure.list(), [{ sessionId: 'sess-custom', preset: 'custom', servers: [], tools: [] }]);
  }
  {
    const { exposure, agent, registered } = harness({ servers: [scoped] });
    const record = agent('sess-no-preset');
    exposure.bindAgent(record);
    assert.deepEqual(registered, [], 'an agent with no preset does not see a scoped server');
    assert.equal(exposure.list()[0].preset, undefined);
  }
});

test('presets: "all" reaches an agent with no preset id', () => {
  const { exposure, agent, registered } = harness();
  exposure.bindAgent(agent());
  assert.equal(registered.length, 1);
  assert.equal(exposure.list()[0].servers.includes('alpha'), true);
});

test('presets: disabled, disconnected and empty servers never expose tools', () => {
  {
    const { exposure, agent, registered } = harness({ servers: [server({ enabled: false })] });
    exposure.bindAgent(agent());
    assert.deepEqual(registered, []);
  }
  {
    const { exposure, agent, registered } = harness({
      connections: new Map([['srv_alpha', connection({ state: 'error', tools: [tool('echo')] })]]),
    });
    exposure.bindAgent(agent());
    assert.deepEqual(registered, [], 'a dead connection must not register dead tools');
  }
  {
    const { exposure, agent, registered } = harness({
      connections: new Map([['srv_alpha', connection({ state: 'connected', tools: [] })]]),
    });
    exposure.bindAgent(agent());
    assert.deepEqual(registered, []);
  }
  {
    const { exposure, agent, registered } = harness({ connections: new Map() });
    exposure.bindAgent(agent());
    assert.deepEqual(registered, [], 'a server with no supervisor is not exposed');
  }
});

test('presets: rebinding replaces registrations instead of duplicating them', () => {
  const { exposure, agent, registered, removed } = harness();
  const record = agent();
  exposure.bindAgent(record);
  exposure.bindAgent(record);
  assert.deepEqual(registered.map((definition) => definition.name), ['mcp__alpha__echo', 'mcp__alpha__echo']);
  assert.deepEqual(removed, ['mcp__alpha__echo'], 'the first registration is disposed before the second is made');
  assert.equal(exposure.list().length, 1);
  assert.deepEqual(exposure.list()[0].tools, ['mcp__alpha__echo']);
});

test('presets: several servers expose their tools in store order', () => {
  const servers = [server({ key: 'alpha', name: 'Alpha' }), server({ id: 'srv_beta', key: 'beta', name: 'Beta' })];
  const connections = new Map([
    ['srv_alpha', connection({ tools: [tool('echo', 'alpha')] })],
    ['srv_beta', connection({ tools: [tool('search', 'beta')] })],
  ]);
  const { exposure, agent, registered } = harness({ servers, connections });
  exposure.bindAgent(agent());
  assert.deepEqual(registered.map((definition) => definition.name), ['mcp__alpha__echo', 'mcp__beta__search']);
  assert.deepEqual(exposure.list(), [{
    sessionId: 'sess-1',
    preset: undefined,
    servers: ['alpha', 'beta'],
    tools: ['mcp__alpha__echo', 'mcp__beta__search'],
  }]);
});

test('presets: instructions become one section per admitted server', () => {
  const servers = [server({ key: 'alpha', name: 'Alpha' }), server({ id: 'srv_beta', key: 'beta', name: 'Beta' })];
  const connections = new Map([
    ['srv_alpha', connection({ tools: [tool('echo', 'alpha')], instructions: 'Alpha instructions' })],
    ['srv_beta', connection({ tools: [tool('search', 'beta')], instructions: 'Beta instructions' })],
  ]);
  const { exposure, agent, sections, sectionOrders } = harness({ servers, connections });
  exposure.bindAgent(agent());

  assert.deepEqual(sectionOrders, ['MCP_SERVERS'], 'the section order comes from the Host vocabulary');
  assert.deepEqual(sections.map((section) => section.name), ['mcp-manager:alpha', 'mcp-manager:beta']);
  for (const section of sections) {
    assert.equal(section.order, 130);
    assert.equal(section.interpolate, false);
    assert.equal(typeof section.text, 'function');
  }
  assert.equal(sections[0].text(), 'Alpha instructions');
  assert.equal(sections[1].text(), 'Beta instructions');
});

test('presets: instruction sections are scoped like tools and skipped when empty', () => {
  const scoped = server({ presets: ['standard'] });
  const connections = new Map([['srv_alpha', connection({ tools: [tool('echo')], instructions: 'Secret' })]]);
  {
    const { exposure, sections } = harness({ servers: [scoped], connections });
    exposure.bindAgent({ id: 'sess-custom', ctx: { get: () => ({ register: () => () => {} }) } });
    assert.deepEqual(sections, [], 'a preset that cannot see the server must not see its instructions');
  }
  {
    const { exposure, agent, sections } = harness({
      servers: [server()],
      connections: new Map([['srv_alpha', connection({ tools: [tool('echo')], instructions: '   ' })]]),
    });
    exposure.bindAgent(agent());
    assert.deepEqual(sections, [], 'blank instructions add no prompt section');
  }
});

test('presets: a missing tools service skips the agent without throwing', () => {
  const { exposure, agent, registered } = harness({ withTools: false });
  assert.doesNotThrow(() => exposure.bindAgent(agent()));
  assert.deepEqual(registered, []);
  assert.deepEqual(exposure.list(), []);
});

test('presets: a missing systemPrompt service still exposes tools', () => {
  const { exposure, agent, registered } = harness({
    withSystemPrompt: false,
    connections: new Map([['srv_alpha', connection({ tools: [tool('echo')], instructions: 'text' })]]),
  });
  assert.doesNotThrow(() => exposure.bindAgent(agent()));
  assert.equal(registered.length, 1);
});

test('presets: agent disposal and explicit unbind release the registrations', () => {
  const { exposure, agent, removed, sectionRemoved } = harness({
    connections: new Map([['srv_alpha', connection({ tools: [tool('echo')], instructions: 'text' })]]),
  });
  const record = agent('sess-1');
  exposure.bindAgent(record);
  exposure.onAgentDisposed(record);
  assert.deepEqual(removed, ['mcp__alpha__echo']);
  assert.deepEqual(sectionRemoved, ['mcp-manager:alpha']);
  assert.deepEqual(exposure.list(), []);

  exposure.bindAgent(record);
  exposure.unbind('sess-1');
  assert.deepEqual(exposure.list(), []);
  assert.doesNotThrow(() => exposure.unbind('never-bound'));
});

test('presets: a preset selected after creation is re-exposed on agent-preset/selected', () => {
  const scoped = server({ presets: ['standard'] });
  const connections = new Map([['srv_alpha', connection({ tools: [tool('echo')] })]]);
  const { exposure, agent, registered, presets } = harness({ servers: [scoped], connections });
  const record = agent('sess-1');
  presets.set(record.ctx, 'custom');
  exposure.onAgentCreated(record);
  assert.deepEqual(registered, []);

  presets.set(record.ctx, 'standard');
  exposure.onPresetSelected('sess-1');
  assert.equal(registered.length, 1);
  assert.deepEqual(exposure.list(), [{ sessionId: 'sess-1', preset: 'standard', servers: ['alpha'], tools: ['mcp__alpha__echo'] }]);

  exposure.onPresetSelected('sess-gone');
  assert.equal(exposure.list().length, 1, 'an unknown session selects nothing');
});

test('presets: bindAll binds every live agent and prunes the ones that left', () => {
  const connections = new Map([['srv_alpha', connection({ tools: [tool('echo')] })]]);
  const { exposure, agent, agents } = harness({ connections });
  agent('sess-1');
  exposure.bindAll();
  assert.deepEqual(exposure.list(), [{
    sessionId: 'sess-1',
    preset: undefined,
    servers: ['alpha'],
    tools: ['mcp__alpha__echo'],
  }]);

  // The agent registry no longer lists it: the next sweep must release it.
  agents.length = 0;
  exposure.bindAll();
  assert.deepEqual(exposure.list(), [], 'bindings for agents that left are released');
});

test('presets: dispose releases every registration and ignores later events', () => {
  const connections = new Map([['srv_alpha', connection({ tools: [tool('echo')], instructions: 'text' })]]);
  const { exposure, agent, removed, sectionRemoved } = harness({ connections });
  const record = agent();
  exposure.bindAgent(record);
  exposure.dispose();
  assert.deepEqual(removed, ['mcp__alpha__echo']);
  assert.deepEqual(sectionRemoved, ['mcp-manager:alpha']);
  assert.deepEqual(exposure.list(), []);
  assert.doesNotThrow(() => exposure.bindAgent(record));
  assert.deepEqual(exposure.list(), [], 'a disposed controller must not rebind');
});

test('presets: refreshSoon coalesces a burst into one rebind pass', async () => {
  const connections = new Map([['srv_alpha', connection({ tools: [tool('echo')] })]]);
  const { exposure, agent, registered } = harness({ connections });
  agent('sess-1');
  exposure.refreshSoon();
  exposure.refreshSoon();
  exposure.refreshSoon();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registered.length, 1, 'three notifications must cause one bind');
  assert.equal(exposure.list().length, 1);
});

test('presets: disabled tools are never registered and an all-disabled server contributes nothing', () => {
  const mixed = harness({
    servers: [server({ toolOverrides: { beta: { enabled: false }, gamma: { approval: true } } })],
    connections: new Map([['srv_alpha', connection({ tools: [tool('alpha'), tool('beta'), tool('gamma')], instructions: 'Use these tools.' })]]),
  });
  mixed.exposure.bindAgent(mixed.agent());
  assert.deepEqual(mixed.registered.map((definition) => definition.name), ['mcp__alpha__alpha', 'mcp__alpha__gamma'], 'only enabled tools are registered');
  assert.deepEqual(mixed.exposure.list(), [{ sessionId: 'sess-1', preset: undefined, servers: ['alpha'], tools: ['mcp__alpha__alpha', 'mcp__alpha__gamma'] }]);
  assert.equal(mixed.sections.length, 1, 'the server still contributes its instructions for its remaining tools');

  const allDisabled = harness({
    servers: [server({ toolOverrides: { alpha: { enabled: false } } })],
    connections: new Map([['srv_alpha', connection({ tools: [tool('alpha')], instructions: 'Use these tools.' })]]),
  });
  allDisabled.exposure.bindAgent(allDisabled.agent());
  assert.deepEqual(allDisabled.registered, [], 'no disabled tool may leak to an agent');
  assert.deepEqual(allDisabled.sections, [], 'a server with no exposed tools contributes no prompt section');
  assert.deepEqual(allDisabled.exposure.list(), [{ sessionId: 'sess-1', preset: undefined, servers: [], tools: [] }]);
});

test('presets: approvalRequired is passed into the registered tool definition', async () => {
  const gated = harness({ servers: [server({ toolOverrides: { echo: { approval: true } } })] });
  gated.exposure.bindAgent(gated.agent());
  assert.equal(gated.registered.length, 1);
  const exec = { agent: { session: { id: 'sess-1' } }, name: 'mcp__alpha__echo' };
  await gated.registered[0].execute({}, exec);
  assert.equal(gated.approvalRequests.length, 1, 'a tool marked for approval asks before the MCP call');
  assert.equal(gated.approvalRequests[0].agent, exec.agent);
  assert.deepEqual(gated.callToolCalls, [['srv_alpha', 'echo', {}, exec]], 'the MCP call still happens after approval');

  const plain = harness();
  plain.exposure.bindAgent(plain.agent());
  await plain.registered[0].execute({}, exec);
  assert.equal(plain.approvalRequests.length, 0, 'a tool without the override does not ask');
  assert.equal(plain.callToolCalls.length, 1);
});
