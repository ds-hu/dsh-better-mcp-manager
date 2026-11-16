# 3. Preset exposure happens by registering tools on each agent's own context

Date: 2026-11-16
Status: accepted

## Context

The differentiator of this plugin is that one MCP server's tools can be given to some agent
presets and not others. An agent preset is a Cordis composition: the set of tools and instructions
one session runs with. There are three plausible ways to put a server's tools into presets:

1. **Rewrite preset YAML** so a preset composes an MCP tool row. Static, profile-owned, and the
   manager would have to generate and maintain compositions per preset — a profile write on every
   toggle, a restart to apply, and residue after uninstall.
2. **Register all tools on a single global tool registry**, mounted once. Every agent sees every
   server; the preset field would be a lie.
3. **Register per agent**, on the agent's own context, when the agent is created. The plugin
   already knows which preset the agent composed and can filter servers before registration.

## Decision

A **preset binder** (`lib/presets.js`) listens for `agent/created` (and `agent-preset/selected`
before an agent's first turn), resolves the agent's composed preset id, and registers the tools of
every server whose `presets` field allows that id onto `agent.ctx`. `presets: "all"` means every
agent, including agents without a preset id. Server `instructions` are added as one
`systemPrompt.section` per server on the same `agent.ctx`. When the configuration changes or the
plugin mounts, already-live agents are re-bound; on `agent/disposed`, every registration for that
agent is released.

## Consequences

- **No profile YAML is written.** Presets stay exactly as the user configured them; the manager
  only decides what is exposed to the agent that is composed from them. Uninstall has nothing to
  undo in preset files.
- **Tools appear on new and live agents** without restart. A live agent's tool list changes when
  the user saves a server or toggles a server's enabled state.
- **Two agents can share a server without colliding**: each registration lives on its own
  `agent.ctx`, so the same server's tools exist once per allowed agent and disappear with that
  agent.
- **The preset roster is read from the Host** (`ctx.agentPresets`), so a profile may invent its own
  presets and the UI still lists them. Unknown preset ids are rejected at save time with the
  current roster in the error.
- **A preset switch after the first turn is not re-bound** in 0.1.0; DSH fixes an agent's preset
  once the first turn starts, and the binder deliberately does not fight that.
- **One connection is shared by all agents.** The MCP client is connected once per enabled server;
  agents get tool definitions that call into that connection.
