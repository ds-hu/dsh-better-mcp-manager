# MCP Manager — context for agents working on this repo

The words this codebase uses, what they mean here, and the rules a change must not break. Read this
before editing the Host or Client half; read [docs/API-CONTRACT.md](docs/API-CONTRACT.md) before
changing either side of the API.

## Vocabulary

### Server

One saved MCP server: **how to reach it** (transport, URL or command), **how to authenticate**
(headers, OAuth), and **who may use it** (preset exposure). A server is a record in
`$DSH_HOME/better-mcp-manager/servers.json`, not an external service; deleting it deletes the
record and closes the connection, but never touches the external MCP server.

A server has two identities:

- **`id`** — `srv_` + ten lowercase hex. Immutable for life, used in URLs. It is the record identity.
- **`key`** — `[A-Za-z0-9_-]{1,32}`, unique across servers, allocated from the name at creation.
  **Immutable**; it is the tool namespace and appears in every tool name. Renaming the server must
  never change the key, because tool names are promises to session history.

`name` is user-facing and editable. Names are deliberately not unique — two servers may both be
called "local", the UI can tell them apart by transport and status.

### Transport

One of three, chosen per server: `http` (a Streamable HTTP endpoint), `sse` (the older HTTP+SSE
transport), `stdio` (a local process, shown as **内置** in the UI). The UI label is **传输类型**.
The transport is editable; `http` and `sse` use `url`, `stdio` uses `command`, `args`, `cwd`, `env`.

### Status

The **live, derived state** of one server: `disabled`, `connecting`, `connected`, or `error`, plus
`toolCount` and `discoveredCount` (the same discovered total), `enabledToolCount` (tools not
disabled by a per-tool override), `instructionsBytes`, `error`, `attempts`, `connectedAt`,
`lastAttemptAt`, `nextRetryAt`. There is no separate `retrying` state: a scheduled retry keeps the
state `error` with `nextRetryAt` set, and the page presents that as **重连中**. Status is never
stored: after a restart a server is `connecting` again until it succeeds, and a disabled server
never opens a connection.

An `error` carries `{ code, message, detail, at }`; `code` is one of `connect-failed`,
`auth-failed`, `timeout`, `protocol`, `invalid-config`, `closed`. The UI shows the first two lines
of `message` and puts `detail` behind **详情**.

### Connection supervisor

The internal actor that owns one server's connection from first connect to dispose: connect,
initialize, `tools/list`, cache tools and instructions, keep the connection, and retry a dropped
connection with backoff 1s, 2s, 4s, 8s, 16s, 30s (cap) until disabled, removed, or the plugin is
disposed. A manual **重新连接** resets the attempt budget. One server has exactly one connection.

### Preset exposure

Which agent presets receive a server's tools. Stored as `"all"` or an array of agent-preset ids
(`[]` means no preset). The UI section is **预设暴露**, with a choice of **全部预设** / **指定预设**.

- `"all"` — every agent, including agents without a preset id.
- an id list — only agents whose composed preset id is in the list.

Exposure is not a second configuration file. It is evaluated by the **preset binder** at
`agent/created`, and re-evaluated for live agents when the plugin mounts or the configuration
changes. Tools are registered on that agent's own `agent.ctx`; that is why two agents can use the
same server without colliding, and why removing a server takes its tools away from every agent.

### Preset

An agent preset: the tool and instruction composition a session runs with. The roster comes from
the Host (`ctx.agentPresets.list()`), so a profile can define its own presets. This plugin never
writes a preset; it only reads the id an agent composed from. A preset is not a template for
servers.

### Group

A free-text label on a server (`group`), used only for ordering the page. An empty group is
**其他（未分组）** and is shown last. Groups have no id, no order, and no life of their own; they
exist as long as at least one server uses the label.

### Icon

The artwork in a server's card tile, with exactly two sources: **automatic** (default,
`{ kind: "auto" }`) uses the first icon the MCP server declares in its `initialize` result
(`serverInfo.icons`, preferring a light or unthemed icon) and falls back to the first letter of the
server name; **upload** (`{ kind: "upload", file, mimeType, updatedAt }`) is one raster file the
operator supplied. There is no built-in emoji palette, no stock icon set, and no user-entered emoji
string; SVG is rejected. The icon is not part of a save draft — only
`POST /servers/:id/icon` (a `data:` URL) and `DELETE /servers/:id/icon` change it. The API view adds
`iconUrl` with a cache-buster for the current version; the browser renders it and falls back to the
letter when it fails.

### Tool

A model-facing function discovered from an MCP server. Its public name is
`mcp__<key>__<rawName>`, normalised to DSH's function-name contract (`[A-Za-z0-9_-]`, ≤ 64 chars),
with a 12-hex SHA-256 of `(key, rawName)` appended when normalisation changes the string. The raw
name is the only name sent on the MCP wire; the public name is never parsed back. While `key` and
the raw name are unchanged, the public name is stable — session history and permission rules depend
on that.

A tool also carries two operator settings, stored per server and edited in the **工具** tab:
**enabled** (default) and **approval** (default off). Disabled tools are never registered for any
agent; a tool with approval asks before a call outside a full-access session. See
[Tool settings](#tool-settings) and [Approval](#approval).

A **live agent** is an agent currently mounted in the Host. Its tool list is the union of its
preset's native tools and the enabled MCP tools exposed to it.

### Tool settings

The operator's per-tool choices on a server record:

- `toolOverrides` — a map keyed by the **raw** MCP tool name. Only deviations from the defaults are
  stored: `{ "enabled": false }` hides a tool, `{ "approval": true }` makes it ask. An override that
  just restates the default is stripped, so the map stays empty for a server nobody configured.
- `toolCache` — the last discovered descriptors (`{ at, tools: [{ name, publicName, description,
  params }] }`, description ≤ 2000 chars) written when the server answers `tools/list` and when the
  **工具** tab reads a connected server. It lets the tab work offline and is descriptors only — never
  headers, tokens or other credentials.

Both are changed only through `GET`/`PUT /servers/:id/tools`; save drafts drop them. The **工具** tab
shows one card per tool (description, parameter chips, enable switch, **需要审批** switch), the
**保存工具设置** footer writes the batch and re-binds live agents.

### Approval

A per-tool preference (`approval: true`, UI **需要审批**) meaning "ask before this call in restricted
modes". It is not a replacement for the Host's permission system. At call time the tool body reads
the calling session's permission preset through `permissionPresets.current(agent.session)`:

- exactly `danger-full-access` (UI **完全权限**) — the call proceeds without asking;
- every other preset — ask the Host approval service once: `allowed-once` proceeds,
  `rejected`/`cancelled`/`unavailable` fail the call, and a missing approval service, permission
  service, agent or execution context denies rather than silently allows. The MCP server is not
  contacted unless approval was granted.

The DSH UI presents that request as the **等待审批** composer with **拒绝 / 允许一次** and the reason
`MCP 工具 "mcp__<key>__<tool>" 需要审批（当前不是完全权限）`.

### Preset-owned ("external") MCP

An MCP server this plugin does **not** own: another agent preset or plugin mounts it through its own
`@deepseek-ai/dsh-mcp-client` rows. The plugin never edits that YAML, never starts/stops those
connections, never reads their credentials, and never adds, edits, deletes or tests them. It manages
only what a Host plugin can reach at runtime:

- **discovery** — the public tool registry only shows another scope's inherited names to a live
  Agent, so external tools are discovered from `tools.view(agent)` of live Agents; the owning preset
  comes from `agentPresets.composedPreset(agent.ctx)` and the server namespace from the
  `mcp__<serverName>__` prefix. A preset whose composition mounts `dsh-mcp-client`
  (`agentPresets.inspectCompositions()`) but has no live session is shown with `hasPresetMcp: true`
  and no servers yet;
- **disable** — a disabled tool is removed from that Agent's model-facing tool set with
  `agent.ctx.tools.restrict({ deny })`, not merely rejected at call time;
- **approval** — a Host-wide `tools/pre-execute` policy returns `{ kind: "ask", reason }` for an
  external tool with `approval: true`; the shared DSH pipeline runs the approval service and only
  dispatches after `allowed-once`.

"External" is always relative to this plugin's own registrations: a name is external only when it is
in the Agent's inherited, restrictable `mcp__` names and **not** in `exposure.ownToolNames()`. The
plugin's own tools use the §2.7 approval gate and are never double-gated.

### External tool settings

Per `(presetId, public tool name)` in `external.json`: only deviations from "enabled, no approval"
are stored (`{ enabled: false }` and/or `{ approval: true }`). The **其他 MCP** tab edits them per
preset and saves with `PUT /external/tools`; the payload also carries the last discovered descriptors
per server. The tab is a compact server list (one clickable card per discovered server, with an
`x/y` enabled count); its per-server tool view is where descriptions, parameter chips and the enable/
approval switches are shown and saved. Like owned tool settings, they are runtime state, not preset
configuration: nothing is written back to the preset.

### OAuth settings

Per-server authentication beyond custom headers: `none`, `bearer` (a static token, sent as an
`Authorization: Bearer` header unless a custom `Authorization` header already exists — custom
headers win), or `client_credentials` (fetch a token from `tokenUrl` with `clientId`,
`clientSecret`, `scope`, cache it until `expires_in - 60s`, retry once on a 401). There is no
authorization-code flow in 0.4.1. Secrets are stored in the data file, never written to logs.

### Store and data directory

Two JSON documents plus uploaded icon files in one directory:

```
$DSH_HOME/better-mcp-manager/     mode 0700
├── servers.json                  mode 0600, atomic replace
│   { "version": 3, "servers": [ ... ] }
├── external.json                 mode 0600, atomic replace
│   { "version": 1, "presets": { "<presetId>": { updatedAt, overrides, servers } } }
└── icons/                        mode 0700, created on the first upload
    └── <server id>.<ext>         mode 0600, exactly one file per server
```

The directory is created when the plugin mounts; `servers.json` appears on the first owned-server
save, `external.json` on the first 其他 MCP save, and `icons/` on the first upload. It is
**per DSH home, not per profile**: profiles under the same `$DSH_HOME` share one list.
`DSH_MCP_MANAGER_DATA_DIR` overrides the location (test/scratch use; the CLI resolves it the same
way). The store is the only source of truth for owned servers; live status is derived and recomputed.
A schema-version-1 or -2 `servers.json` is migrated **in memory** on load (legacy emoji-string icons
become `{ kind: "auto" }`; missing tool settings become `{}` / `null`) and is rewritten as version 3
by the next save, never by a read. `external.json` has schema version 1 and is normalized on load:
only valid `mcp__` names, valid preset ids, ≤100 presets, ≤200 servers per preset, ≤300 tools per
server, ≤2000 override entries per preset, description ≤2000 chars and ≤64 params; a corrupt or
unknown-version file is quarantined and the state starts empty. The **clean** CLI deletes the whole
directory, including `external.json` and `icons/`.

## Invariants

1. **The key is immutable and unique.** Allocation happens once, at creation; renaming a server or
   editing anything else leaves it untouched. A duplicate key is impossible after save.
2. **`presets` is either `"all"` or an array of known preset ids.** Unknown ids are rejected at save
   with the current roster in the error; `"all"` includes preset-less agents.
3. **The store is the only source of truth.** Status is derived, never persisted; nothing about a
   server is stored anywhere else, including the profile.
4. **The plugin writes only inside its data directory.** It never writes the profile's
   `cordis.patch.yml`, agent-preset YAML, `package.json`, or the sessions directory.
5. **`lib/` imports no `@deepseek-ai/*` package.** A profile install cannot resolve Harness-internal
   packages; the only Harness-provided module that may be resolved is the Cordis peer. The MCP SDK
   is the only runtime dependency.
6. **One connection per enabled server**, shared by every agent it is exposed to. Connections are
   per server, not per agent or per session.
7. **Tool identity is stable**: `mcp__<key>__<rawName>` is a pure function of the immutable key and
   the server's raw tool name. A new key means new tools.
8. **Exposure is per agent context and per enabled tool.** Registering or releasing a tool happens on
   `agent.ctx`; removing a server must release every registration it made and close its connection.
   A disabled tool is never registered for any agent or preset.
9. **The icon never comes from a save draft.** `POST`/`PUT /servers` and every other draft path drop
   an `icon` field; the icon changes only through the two icon endpoints, so a save can neither set
   nor clear an uploaded icon by accident.
10. **A server with no enabled tool contributes nothing.** If every discovered tool is disabled, the
    server contributes neither tool registrations nor its system-prompt instruction section to any
    agent.
11. **Approval is skipped exactly in `danger-full-access`.** Any other permission preset asks; a
    missing approval/permission service, agent or execution context denies the call. Approval is
    never silently granted, and the MCP server is not called before it is granted.
12. **Tool settings and the tool cache never come from a save draft.** `POST`/`PUT /servers` ignore
    `toolOverrides`/`toolCache`; they change only through the tool endpoints, so a save cannot
    overwrite a per-tool decision or corrupt the cache.
13. **Uninstall is two steps and leaves nothing else**: remove the bundle (the code, the row, the
    route, the client) and run `clean` for the one directory, which includes `icons/`. Mounting
    without configuring writes no file (the directory itself is created on mount).
14. **External names never include this plugin's own tools.** Ownership is decided by
    `exposure.ownToolNames()` plus the Agent's restrictable `mcp__` names; a name registered by this
    plugin is never treated as preset-owned, never restricted by the external controller, and never
    double-gated.
15. **Disabling an external tool is a restriction, not a call-time filter.** It must be removed from
    the Agent's model-facing tool list with `agent.ctx.tools.restrict({ deny })`, recomputed when an
    Agent is created, when its preset is selected, and when the tool registry changes; only Agents of
    the owning preset are affected.
16. **External approval asks outside `danger-full-access` only and never dispatches first.** The
    `tools/pre-execute` policy returns an ask; the shared pipeline must grant `allowed-once` before
    the call reaches the MCP server. Rejected/cancelled/unavailable or a missing approval channel
    denies, and this plugin's own tools keep their own gate.
17. **`external.json` holds descriptors and deviations only, never credentials.** It stores the last
    discovered tool descriptors plus `enabled:false`/`approval:true` overrides; losing it resets
    choices to defaults, and discovery cannot happen without a live Agent of that preset.

## File map

| Path | Role |
|---|---|
| `lib/index.js` | Host plugin entry: `apply(ctx)` / dispose, wires store, manager, binder, API, external controller, tool-cache persistence |
| `lib/store.js` | data directory resolution, load/save, atomic replace, mode `0600`, serialized `patch`, schema v1/v2→v3 migration |
| `lib/model.js` | validation and normalisation of drafts, key allocation, preset predicate, icon normalisation, per-tool overrides and cache |
| `lib/icons.js` | uploaded icons: data-URL decoding, raster magic checks, `icons/` storage (0600), deletion |
| `lib/mcp.js` | one MCP client per server: transports, OAuth, connect/list/call, backoff, status counts, auto-icon fetch/cache |
| `lib/external.js` | preset-owned MCP controller: live discovery, `external.json`, restrictions, approval pre-execute, scan/save API |
| `lib/presets.js` | `agent/created` binding, live-agent re-exposure, per-tool enable filtering, `systemPrompt.section` instructions, `ownToolNames()`, `composedPreset`/`agentTools` helpers |
| `lib/tool-definition.js` | hand-built `ToolDefinition` for a discovered MCP tool, approval flag included |
| `lib/result-projection.js` | MCP result → ordered text/image/diagnostic tool result; restricted-mode approval seam |
| `lib/api.js` | HTTP router for `/better-mcp-manager/api/*`, including icon, tool and external endpoints |
| `lib/http.js` | same-origin JSON guard, 64 KiB body cap (1 MiB for icon uploads), JSON responses |
| `lib/client.js` | browser half: `sidebar.panellist` entry, `main` page, 本插件 MCP / 其他 MCP tabs, polling, two form tabs, styles, locale dictionaries |
| `bin/mcp-manager.mjs` | maintenance CLI: `status` (default), `path`, `clean [--yes]` |
| `locale/en.json`, `locale/zh.json` | plugin-page metadata (title/description); the page's UI copy lives in `lib/client.js` |
| `icon.svg` | sidebar artwork and plugin-page icon |
| `cordis.patch.yml` | the bundle's single Host row (`id` = Host `name`) |
| `test/` | unit, structural, client-smoke, packaging and e2e checks |
| `docs/API-CONTRACT.md` | frozen internal contract; change it before changing either half |
| `docs/TECHNICAL.md` | architecture, data model, API, security, lifecycle, testing |
| `docs/adr/` | why the design is what it is |

## DSH extension points used

The plugin is a guest in the Host and uses only public context capabilities:

- **Bundle patch** — `package.json` → `dsh.bundle.patch` → `cordis.patch.yml` inserts the Host row.
  The row's `id` must equal the Host module's exported `name` (checked by `test/mount-check.mjs`).
- **Web client** — `package.json` → `dsh.client` (`platform: web`, `inject` of the shell's sidebar
  and locale services) loads `lib/client.js` as a browser module.
- **Panels** — `ctx.slots.inject('sidebar.panellist')` with `id: 'mcp-manager'`, `order: 20`,
  `label: () => t('panel')`; `ctx.slots.inject('main')` with `key: 'mcp-manager'`. 自动化任务 is
  order 10 and Plugins is order 0, which is what puts MCP 管理 directly below 自动化任务.
- **HTTP** — one `ctx.webServer` route with `kind: 'prefix'` at `/better-mcp-manager/api`, plus the
  Host's own web auth.
- **Agent events** — `agent/created`, `agent/disposed`, `agent-preset/selected`, `tools/change`,
  and the Host-wide `tools/pre-execute` policy used for external approval.
- **Agent-preset service** — `ctx.agentPresets.list()` for the roster,
  `composedPreset(agent.ctx)` for the id an agent runs, and
  `inspectCompositions()` to detect presets whose composition mounts
  `@deepseek-ai/dsh-mcp-client`.
- **Per-agent registries** — `agent.ctx` tools and `systemPrompt.section` registrations; their
  lifetime is the agent's lifetime.
- **Agent registry views** — `agents.list()` plus `agent.ctx.tools.view(agent)` for the inherited
  `visible`/`restrictableNames` sets, and `agent.ctx.tools.restrict({ deny })` to remove a
  preset-owned tool from that Agent's model-facing list.
- **Approval and permission presets** — only for tools marked **需要审批**:
  `permissionPresets.current(agent.session)` decides whether the session is full access, and
  `approval.request(...)` asks once in every other mode. Both are looked up lazily; a profile
  without them denies approval-required calls instead of failing to load.
- **Locale** — `ctx.locale.register(NS, { zh, en })`, namespace `mcpManager`, label from
  `t('panel')`.
- **Cleanup** — every timer, poll, slot, route and `<style>` registration returns a disposer; all of
  them are released in `ctx.effect` cleanups or dispose.

## Gotchas

- **The production instance is not the test bed.** `http://127.0.0.1:3080` and `/root/.dsh` belong
  to the running user; e2e runs a throwaway `$DSH_HOME` and profile in its own systemd scope. That
  isolation is a test harness property, not a plugin feature.
- **Status is not stored.** "Connected" is a live claim about a socket; a page reload asks again.
  Never persist status into the JSON store or treat a stale status as truth.
- **Two agents may share a server.** They share the one connection but not registrations. A tool
  call from either agent goes through the same client; do not build per-agent connections "to be
  safe" — the contract says one connection per enabled server.
- **Renaming does not rename tools.** Only deleting and re-adding a server allocates a new key and
  therefore new tool names. The UI shows the key but does not allow editing it.
- **The icon is not state you can save.** It is absent from server drafts by design; changing it
  means the icon endpoints, which also own the stored file. Treating it as an ordinary form field
  would reintroduce stale files and put image bytes in `servers.json`.
- **Auto icons belong to the live connection.** The server declares them at `initialize`, so a
  reconnect to a different server version can change the icon. Fetch failures are remembered for
  60 s and the page falls back to the first letter; never store that letter.
- **A disabled server keeps its record.** Disabling is not deleting: status becomes `disabled`, the
  connection closes, live agents lose its tools, and the record plus its settings stay.
- **A failing server still saves and lists.** Save is a store write first; connection failure
  becomes status, not a rollback. The user can fix the URL while the server is failing.
- **The panel polls `GET /servers` every 2.5 s while mounted** and immediately after every mutation.
  Timers must be cleared on unmount; a leaked timer keeps the browser busy after dispose.
- **`GET /servers/:id` returns raw tool names, not schemas.** The detail view is diagnostics; the
  **工具** tab reads `GET /servers/:id/tools` and never edits a tool's schema.
- **Disabling a tool is not a page filter.** The tool is absent from registration, so no agent sees
  it; a server with zero enabled tools also stops contributing its instructions. Do not keep a
  disabled tool's definition "just in case" — that would expose it.
- **The tool cache is not the live tool list.** `toolCache` is the last discovered descriptor set,
  refreshed on connect and on a tab read; while offline it can be stale. Never treat it as proof that
  the server currently offers those tools.
- **Approval is opt-in, per tool, and mode-aware.** It is checked inside the tool body on every call;
  `danger-full-access` skips it, everything else asks. With no approval or permission service the
  call is denied — never fall back to allowing it, and never contact the MCP server first.
- **Tool settings are not save-draft fields.** `toolOverrides` and `toolCache` are dropped from
  drafts; only `PUT /servers/:id/tools` changes them. Treating them as ordinary form fields would
  let a stale form silently re-enable a disabled tool.
- **Preset-owned MCP servers are not this plugin's to edit.** The **其他 MCP** tab may hide or gate
  their tools, but nothing may rewrite the preset's YAML, start/stop the connection or read its
  credentials. There is no add/edit/delete/test/reconnect path for them, and there must never be one.
- **External discovery is live-agent-bound.** Descriptors exist only while some Agent of the owning
  preset is alive; `external.json` is a cache of the last view, not a discovery source. A placeholder
  (`hasPresetMcp`, no servers) is the correct state before the first session, not an error.
- **External disable uses `restrict`, not a call-time check.** `agent.ctx.tools.restrict({ deny })`
  removes the tool from the model-facing list and must be recomputed on agent creation, preset
  selection and tool-registry changes, only for Agents of the owning preset.
- **External approval asks through the Host, and the policy may refuse.** The `tools/pre-execute`
  result is an ask; the shared pipeline decides whether it can be shown. A `never` approval policy
  denies the call instead of displaying a prompt — document and report that, never bypass it, and
  never dispatch to the MCP server before an `allowed-once`.
- **Only non-own `mcp__` names are external.** Ownership is `exposure.ownToolNames()` plus the
  Agent's restrictable set; never treat this plugin's own tools as preset-owned or double-gate them.
- **`external.json` is descriptors and deviations, never credentials.** It is safe to delete (the
  choices reset); it must never grow a token, header or password field.
- **MCP instructions are per server, one system-prompt section each** (`mcp-manager:<key>`), added
  only to agents to which the server is exposed. A server that returns none adds no section, and a
  connected server with zero discovered tools contributes no prompt text at all.
- **The manager never edits presets.** If a profile has no agent presets, the preset section of the
  form explains that per-preset selection needs them; `presets: "all"` still works.
- **The docs contract is frozen.** `docs/API-CONTRACT.md` is the shared truth for Host, Client and
  tests. Change it first in any behavior change; do not quietly change one side.
