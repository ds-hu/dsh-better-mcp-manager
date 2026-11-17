# 8. Runtime management of preset-owned MCP tools

Date: 2026-11-17
Status: accepted

## Context

DSH does not have one MCP configuration surface: a plugin can mount
`@deepseek-ai/dsh-mcp-client` rows for itself, and an **agent preset** can mount its own rows in
its composition. Those servers connect under the preset's ownership, with the preset's credentials,
and their tools are inherited by every Agent of that preset.

0.3.0 only managed the servers this plugin owns. The other preset-owned tools were visible to the
model but not to the operator: a noisy tool could not be hidden, and a dangerous one could not be
made to ask for approval, without editing the preset's YAML — which is the preset owner's file, not
this plugin's, and which would leave residue behind when this bundle is removed.

The requirement for 0.4.0 (with the page UI refined in 0.4.1) was therefore:

- list preset-owned MCP servers and their tools, grouped by owning preset;
- hide an individual inherited tool from the model, and mark an individual tool so a call asks for
  approval outside full access;
- never edit the preset's YAML, never start/stop/reconnect its connection, never read or store its
  credentials;
- keep the plugin's clean-uninstall property: everything it writes stays inside its own data
  directory, and removing that directory leaves nothing behind;
- delegate permission decisions to DSH rather than inventing a second permission system.

Two Host constraints shaped the design. First, the public tool registry is scope-aware: another
scope's inherited names (`visible`) are only materialized for a **live Agent**, so there is no
global tool catalog to read at rest. Second, a plugin cannot edit another plugin's registrations
directly; the supported runtime levers are the Agent's `tools.view`/`tools.restrict` and the
Host-wide `tools/pre-execute` policy.

## Decision

**Ownership is determined at runtime and never assumed.** The external controller scans
`agents.list()`. For each live Agent it resolves the owning preset with
`agentPresets.composedPreset(agent.ctx)` and reads `agent.ctx.tools.view(agent)` (the `visible` map
and the `restrictableNames` set). A name is treated as preset-owned only when it matches
`mcp__<serverName>__<raw>` **and** is not in `exposure.ownToolNames()`; this plugin's own tools can
therefore never be classified as external. Presets whose standing composition mounts
`@deepseek-ai/dsh-mcp-client` (`agentPresets.inspectCompositions()`) but which have no live Agent
yet are listed as placeholders (`hasPresetMcp: true`, no servers) instead of being silently
reported as absent.

**Disable means exposure, enforced with `restrict`.** For each Agent the controller computes a deny
list from the stored `enabled:false` overrides over that Agent's restrictable external names and
calls `agent.ctx.tools.restrict({ deny })`. The restriction is recomputed when an Agent is created,
when its preset is selected, when `tools/change` fires, and after a scan/save; it is replaced when
the deny set changes, released when the Agent is disposed or the controller shuts down, and it is
only applied to Agents of the owning preset. The disabled tool is absent from the model-facing tool
list — a call-time rejection would leave it in context and invite failed calls.

**Approval is delegated through `tools/pre-execute`.** A Host-wide pre-execute listener recognises
an external, restrictable `mcp__` name whose preset stores `approval:true`, excludes this plugin's
own names, and — unless the calling session is exactly `danger-full-access` — returns
`{ kind: 'ask', reason: 'MCP 工具 "<name>" 需要审批（当前不是完全权限）' }`. The shared DSH pipeline
runs the approval service and only dispatches the call after `allowed-once`; rejected, cancelled,
unavailable, or a missing approval channel denies before the MCP server is contacted. This
plugin's own tools return `next()` here and keep their existing in-body approval gate, so nothing
is asked twice.

**Only descriptors and deviations are persisted, in a second file.**
`$DSH_HOME/better-mcp-manager/external.json` (schema version 1, mode `0600`, atomic replace,
quarantined as `external.json.corrupt-<iso>` if unreadable) stores:

```jsonc
{ "version": 1, "presets": {
  "<presetId>": {
    "updatedAt": "…",
    "overrides": { "mcp__foreign__ping": { "approval": true } },
    "servers": { "foreign": { "discoveredAt": "…", "tools": [ /* name, description, params */ ] } }
  }
} }
```

Overrides are keyed by public tool name and store only deviations from "enabled, no approval". The
server records are the last discovered descriptors, a cache for rendering while no live Agent
exists — never an authoritative connection configuration, and never credentials. Caps (100 presets,
200 servers per preset, 300 tools per server, 2000 overrides per preset, description 2000 chars,
64 params) keep the file bounded. Deleting the file resets every choice; `clean --yes` deletes it
with the data directory.

**The page gets two tabs: 本插件 MCP and 其他 MCP, with a compact list and a drill-in tool view.**
The external tab defaults to the same card-list shape as the owned servers: one clickable card per
discovered server (letter tile, server name, `x/y` enabled count, discovery time) under its preset
group, with no tool descriptions or parameters expanded. Opening a card shows a per-server tool view
with the full tool cards, descriptions, parameter chips, `启用`/`需要审批` switches and
**保存工具设置**; **返回** goes back to the list with refreshed counts. The list footer also keeps a
dirty-gated preset save. **重新扫描** and explicit copy that the connection cannot be edited here
remain. It still offers no add, edit, delete, test or reconnect path.

## Consequences

- **No duplicate connections or credentials.** The controller piggybacks on the preset's existing
  MCP connection and never sees its headers, tokens or client secret. It starts no process and
  closes nothing.
- **Discovery needs a live Agent of that preset.** Tools are only visible in a live Agent's scope,
  so a preset with no session shows the placeholder until one runs (or a rescan sees one). This is
  a documented limitation, not an error state; the cached descriptors from earlier sessions still
  render.
- **Restrictions are per Agent of the owning preset.** All Agents of that preset converge on the
  same deny list, but a preset's decision does not restrict another preset that inherits the same
  server under a different scope. Each Agent recomputes on creation/preset switch/registry change,
  and a session whose Agent predates a save converges on the next relevant event or a fresh
  session.
- **Approval depends on the Host's approval policy.** The pre-execute result is an ask; DSH decides
  whether an ask can be shown. With the production policy set to `never`, the ask is denied rather
  than displayed and the plugin cannot override that. Full-access sessions are deliberately not
  interrupted.
- **External settings are not preset configuration.** They are runtime state in this plugin's data
  directory; uninstalling the bundle leaves the preset's own YAML untouched and removes only this
  directory. There is no migration from or to preset YAML.
- **Costs:** a second schema/file, five Host listeners, a coalesced scan path, a restriction
  signature per Agent, and tests for normalisation, discovery, restrict/release, approval
  conditions and the placeholder state. The UI grows one tab and one request lifecycle
  (`GET /external`, `POST /external/scan`, `PUT /external/tools`).
- **Alternatives rejected:**
  - *Editing the preset's YAML or Loader rows.* That is another owner's configuration; the edit
    would not be reverted when this bundle is removed, could race the preset owner, and breaks the
    "only writes its own data directory" invariant.
  - *Re-hosting the preset's MCP connection inside this plugin.* It would duplicate processes,
    credentials and tool names, require reading secrets, and contradict the one-connection model
    already reserved for owned servers.
  - *A call-time rejection instead of `restrict`.* The tool would stay in the model's tool list,
    wasting context and producing calls that always fail; **enable/disable must mean exposure**.
  - *Reading the preset config or a global catalog at rest.* There is no live tool schema without
    an Agent's view; a static config read would be stale and could not describe the actual tools.
  - *A plugin-owned approval policy.* That would be a second permission system the Host cannot
    audit; the Host's pre-execute pipeline is the only supported place to ask.
