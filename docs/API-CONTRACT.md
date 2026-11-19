# Internal contract — Host HTTP API, data model, and exposure rules

This file is the single source of truth shared by the Host half (`lib/index.js` and friends),
the Client half (`lib/client.js`) and the tests (`test/`). Change it before changing either side.

Status: **frozen for 0.6.0**. Everything below is what 0.6.0 ships.

---

## 1. Where the plugin sits

| Piece | File | Mounted by | Talks to |
|---|---|---|---|
| Host | `lib/index.js` (`name = 'dsh-better-mcp-manager'`) | the profile patch row in `cordis.patch.yml` | DSH Host services + MCP servers |
| Client | `lib/client.js` (`window.__ModuleLoader__`, `id = '@ds-hu/dsh-better-mcp-manager'`) | the Web shell, via `package.json` → `dsh.client` | the Host over same-origin `/better-mcp-manager/api/*` |
| Cleanup CLI | `bin/mcp-manager.mjs` | the user, after `remove_bundle` | the data directory only |

The Host half never writes `cordis.patch.yml`, never mounts Loader rows and never edits agent-preset
YAML. Everything the user configures — and the one UI preference — lives in three JSON documents
under `$DSH_HOME/better-mcp-manager/` (each mode `0600`, atomic replace): `servers.json` (§2.1),
`external.json` (§2.8) and `preferences.json` (§2.9).

## 2. Data model

### 2.1 Server record (stored)

```jsonc
{
  "id": "srv_1f3c9a2b70",          // immutable, `srv_` + 10 lowercase hex
  "key": "mylocal",                // immutable tool namespace, `[A-Za-z0-9_-]{1,32}`, unique
  "name": "My MCP",                // user-facing, 1..80 chars, unique is NOT enforced
  "enabled": true,
  "transport": "http",             // "http" | "sse" | "stdio"
  "url": "http://localhost:3000/mcp", // http/sse only
  "command": "",                   // stdio only: executable
  "args": [],                      // stdio only
  "cwd": "",                       // stdio only, "" = inherit
  "env": {},                       // stdio only, string → string
  "headers": [                     // http/sse only, ordered, names unique (case-insensitive)
    { "name": "Authorization", "value": "Bearer sk-..." }
  ],
  "oauth": { "mode": "none" },     // see 2.2
  "icon": { "kind": "auto" },      // see 2.6: auto = MCP server icon else first letter; upload = stored file
  "toolOverrides": {},             // see 2.7: raw tool name -> { enabled?: false, approval?: true }; absent = enabled, no approval
  "toolCache": null,               // see 2.7: last discovered tool descriptors, or null before the first successful tools/list
  "color": "blue",                 // one of: blue, violet, teal, green, amber, rose, slate
  "group": "",                     // "" = ungrouped; otherwise 1..60 chars, free text
  "presets": "all",                // "all" | string[] of agent-preset ids (may be [])
  "timeoutMs": 60000,              // 1000..600000, per tools/call
  "createdAt": "2026-11-16T10:00:00.000Z",
  "updatedAt": "2026-11-16T10:00:00.000Z"
}
```

Store file:

```jsonc
{ "version": 3, "servers": [ /* Server records, stable order = list order */ ] }
```

Rules enforced before any write (the API answers `400` with `{ ok:false, code, error }`):

- `name` trimmed, 1..80 chars.
- `key` derives from `name` by ASCII slug (`[^A-Za-z0-9_-]` → `-`, collapse dashes, lowercase,
  trim to 32); an empty slug becomes `mcp-<id suffix>`; a duplicate key appends `-<4 hex>`. The key
  is frozen at creation and never changes on rename.
- `transport` must be one of the three; `http`/`sse` need an absolute `http:`/`https:` URL; `stdio`
  needs a non-empty `command`.
- Header names match `^[A-Za-z0-9!#$%&'*+.^_`|~-]+$`, unique case-insensitively, each value ≤ 4096
  chars, at most 20 headers.
- `presets`: `"all"`, or an array of known preset ids (unknown ids are rejected with the roster in
  the message), at most 40 entries.
- `icon` is not accepted in save drafts: a new server starts `{ "kind": "auto" }`, and the icon is
  changed only through the icon endpoints in §3. `color` from the fixed palette; `group` ≤ 60 chars.
  A store written by an older build is migrated in memory when it is loaded: version 1 legacy string
  icons become `{ "kind": "auto" }`; every record from any readable version gets `toolOverrides: {}`
  and `toolCache: null` when it has no valid value. The file is rewritten with `"version": 3` by the
  next successful write (the plugin never rewrites a file it was only asked to read).
- `timeoutMs` integer 1000..600000; `enabled` boolean.
- Unknown fields are dropped, not stored.

### 2.2 OAuth object

```jsonc
{ "mode": "none" }
{ "mode": "bearer", "token": "opaque-token" }
{ "mode": "client_credentials", "tokenUrl": "https://idp/token", "clientId": "...", "clientSecret": "...", "scope": "mcp.read" }
```

- `bearer` adds `Authorization: Bearer <token>` unless the user already set an `Authorization`
  header (custom headers win).
- `client_credentials` POSTs `grant_type=client_credentials&client_id=...&client_secret=...&scope=...`
  (`application/x-www-form-urlencoded`) to `tokenUrl` before an HTTP/SSE connect, caches the access
  token until `expires_in - 60s`, and retries once with a fresh token when a request answers 401.
  A failed token fetch is a connection error with `code: "auth-failed"`.
- Every field is optional-but-validated as above; `clientSecret`/`token` are never written into logs.

### 2.3 Live status (derived, never stored)

```jsonc
{
  "serverId": "srv_1f3c9a2b70",
  "state": "disabled",   // "disabled" | "connecting" | "connected" | "error"
  "transportLabel": "HTTP",          // "HTTP" | "SSE" | "内置"
  "toolCount": 19,                   // discovered tools on the live connection
  "enabledToolCount": 17,            // discovered tools the operator has left enabled (contract 2.7)
  "discoveredCount": 19,             // alias of toolCount, kept for the panel
  "instructionsBytes": 412,
  "error": null,                     // or { "code": "...", "message": "...", "detail": "...", "at": "ISO" }
  "attempts": 0,                     // consecutive failed attempts
  "connectedAt": null,               // ISO or null
  "lastAttemptAt": "2026-11-16T10:00:00.000Z",
  "nextRetryAt": null                // ISO or null
}
```

`error.code` is one of: `connect-failed`, `auth-failed`, `timeout`, `protocol`, `invalid-config`,
`closed`. While a retry is scheduled the state stays `error` and `nextRetryAt` names the next
attempt; the panel presents that as 重连中.

### 2.4 Preset exposure

- `server.presets === "all"` → the server's tools are exposed to every agent, including agents with
  no preset id.
- `server.presets === [...]` → exposed only when
  `ctx.agentPresets.composedPreset(agent.ctx)` (or `agent/created`'s inherited preset) is in the list.
- Exposure happens at `agent/created` and for already-live agents when the plugin mounts or the
  configuration changes. A session that selects another preset before its first turn is re-exposed
  on `agent-preset/selected`.
- Tools are registered on `agent.ctx`, so they live and die with that agent (that is also what makes
  two agents able to use the same server without colliding).
- MCP `instructions` (if the server returns any) are added as one `systemPrompt.section` per server
  on that same `agent.ctx`, name `mcp-manager:<key>`, order `getSectionOrder('MCP_SERVERS')`.
  Only servers whose tools are actually exposed contribute prompt text: a connected server with
  zero discovered tools contributes no instructions.

### 2.5 Tool naming

Public tool name: `mcp__<key>__<rawName>`, then normalized to DSH's function-name contract
(`[A-Za-z0-9_-]`, ≤ 64 chars). If normalization changes the string, a 12-hex SHA-256 of
`(key, rawName)` is appended, exactly like `@deepseek-ai/dsh-mcp-client`. The raw name is what goes
on the MCP wire; the public name is never parsed back.

### 2.6 Server icon

An icon is shown in the card tile; it has exactly two sources:

```jsonc
{ "kind": "auto" }   // default: the first icon the MCP server declares, else the name's first letter
{ "kind": "upload",  // set only through POST /servers/:id/icon
  "file": "srv_1f3c9a2b70.png",
  "mimeType": "image/png",
  "updatedAt": "2026-11-16T10:00:00.000Z" }
```

- **auto** reads `serverInfo.icons[]` from the MCP `initialize` result (MCP `Implementation.icons`,
  `Icon = { src, mimeType?, sizes?, theme? }`). Preference order: an icon with no theme or
  `theme: "light"`, then any; `src` may be a `data:` URI or an `http(s)` URL. The Host fetches HTTP
  sources itself with the server's configured headers/OAuth (5 s timeout, 512 KiB cap, accepted raster types only —
  PNG/JPEG/WebP/GIF; an SVG icon is skipped, never served) and caches the bytes per server + `src` for 10 minutes. A missing/invalid icon is not an
  error: the icon endpoint answers 404 and the page shows the name's first letter.
- **upload** stores exactly one file under `$DSH_HOME/better-mcp-manager/icons/<id>.<ext>` (0600,
  directory 0700, atomic replace). Accepted decoded media types: `image/png`, `image/jpeg`,
  `image/webp`, `image/gif`; max 512 KiB decoded. SVG is rejected on purpose (same-origin script
  risk). Replacing or deleting the server deletes the previous file; there is no orphan.
- `GET /servers` and every server answer expose the icon through `iconUrl`
  (`/better-mcp-manager/api/servers/<id>/icon?v=<updatedAt|auto>`; `v` is a cache-buster whose exact
  value carries no semantics beyond changing when the icon changes); the client renders that URL as
  an `<img>` and falls back to the first letter when it fails to load.
- No built-in emoji palette and no emoji string icon: 0.2.0 removed them.

### 2.7 Tool list and per-tool settings

The page can manage the tools one MCP server exposes:

```jsonc
"toolOverrides": {                 // only non-default entries are stored
  "file_sharelink_set": { "approval": true },
  "make_dir": { "enabled": false }
},
"toolCache": {                     // refreshed whenever a connected server lists its tools
  "at": "2026-11-16T21:00:00.000Z",
  "tools": [{
    "name": "file_sharelink_set",  // raw MCP wire name
    "publicName": "mcp__pan__file_sharelink_set",
    "description": "创建文件分享链接。",   // <= 2000 chars, may be ""
    "params": [{ "name": "fsid", "required": true }]   // derived from inputSchema.properties/required
  }]
}
```

- Effective setting for a tool: `enabled` unless `toolOverrides[name].enabled === false`;
  `approval` only when `toolOverrides[name].approval === true`. Forging a default entry is normalized
  away rather than stored.
- **Enabled** controls exposure only: a disabled tool is never registered on any agent/preset (and a
  server with no enabled tool contributes neither tools nor its instruction section). Disabling does
  not stop `tools/list` from refreshing the cache.
- **Approval**: `approval: true` means "ask in restricted modes". Before a call, the tool body
  reads the calling session's permission preset through the Host `permissionPresets` service: when
  the effective preset is exactly `danger-full-access` (完全权限) the call proceeds without asking;
  in every other mode it asks the Host `approval` service once (`allowed-once` proceeds; `rejected`,
  `cancelled` and `unavailable` fail the call with a clear reason). With no approval service, no
  permission service, or no agent on the execution, the call is denied — never silently allowed.
- `toolCache` is written by the Host when a connected server answers `tools/list` (and when the page
  reads the tool list), so the tools tab can still show the last known list while the server is
  disconnected. It carries descriptors only, never credentials.
- Tool settings and the cache are not accepted in save drafts; they change only through the tool
  endpoints in §3. A new server starts with `{}` / `null`.

### 2.8 Preset-owned ("external") MCP tools

A second management surface covers MCP servers this plugin does **not** own: servers mounted by
other plugins or agent presets through `@deepseek-ai/dsh-mcp-client`. The plugin never edits that
preset YAML, never starts or stops those connections and never touches their credentials; it only
manages whether an already-registered tool is exposed to the agent and whether calling it asks for
approval.

- **Ownership.** A tool is external for an Agent when its name occurs in the Agent's inherited
  scoped tool registry (the preset layer) under the `mcp__` namespace and the plugin did not
  register it. The source preset is `agentPresets.composedPreset(agent.ctx)`; the source server is
  the `mcp__<serverName>__` prefix. Descriptors come from live Agents (`tools.view(agent)`), so a
  preset's tools appear after at least one Agent of that preset exists; before that the payload
  carries a placeholder (`hasPresetMcp: true`, no servers). `hasPresetMcp` is derived from
  `agentPresets.inspectCompositions()` seeing an `@deepseek-ai/dsh-mcp-client` module.
- **Disable.** A disabled external tool is removed from that Agent's model-facing tool set with
  `agent.ctx.tools.restrict({ deny })`, not merely rejected at call time. Restrictions are
  recomputed when an Agent is created, when its preset selection changes, and when the tool
  registry changes (MCP reconnects/tool-list updates), and only affect Agents of the owning preset.
- **Approval.** Before a call to an external tool with `approval: true`, a Host-wide
  `tools/pre-execute` policy returns `{ kind: 'ask', reason }`. The shared DSH pipeline runs the
  approval service with that reason and only dispatches after `allowed-once`. Like §2.7, the exact
  `danger-full-access` (完全权限) preset skips the request; a missing approval channel or a
  non-grant denies the call before dispatch. The plugin's own tools keep their §2.7 gate and are
  never double-gated.
- **Persistence.** Decisions and descriptors live in a second file
  `$DSH_HOME/better-mcp-manager/external.json` (mode `0600`, atomic replace, schema version 1):
  `{ version, presets: { "<presetId>": { updatedAt, overrides: { "<publicName>": { enabled?: false,
  approval?: true } }, servers: { "<serverName>": { discoveredAt, tools: [{ name, description,
  params: [{ name, required }] }] } } } } }`. Only deviations from the defaults are stored
  (`enabled` defaults true, `approval` defaults false). Descriptors are capped (100 presets,
  200 servers per preset, 300 tools per server, description 2000 chars, 64 params) and carry no
  credentials. The cleanup CLI removes this file with the rest of the data directory.

### 2.9 UI preferences (sidebar entry)

A third document in the data directory stores the client's Host-owned UI preferences. Today it has
exactly one key: whether the optional sidebar module is enabled.

```jsonc
{ "version": 1, "sidebarEntry": false }
```

- **`sidebarEntry`** — boolean, default `false`. `false` means the client registers only the
  always-on `plugins.row.config` entry (§5); `true` means it also registers `sidebar.panellist` and
  the `main` page. The preference is read/written by the Host, not by browser storage.
- **Ownership and sharing.** The file is per `$DSH_HOME` (like `servers.json`), not per browser and
  not per profile: every browser and every profile under the same DSH home follows the same value.
- **Lifecycle.** A missing file means the default. A damaged, unparseable or unknown-shape file is
  logged and reset to the default without a quarantine file (the server and external stores keep
  their quarantines); the next write replaces it. Writes go through the same serialized,
  atomic temp-file + `rename` queue as the other stores and are awaited before the API answers.
- **Removal.** The `clean` CLI deletes the whole data directory, `preferences.json` included.

## 3. Host HTTP API

Base: `/better-mcp-manager/api`, same-origin only. `kind: 'prefix'` route on `ctx.webServer`.

- Every response is JSON: success `{ "ok": true, ... }`, failure
  `{ "ok": false, "code": "...", "error": "human text" }` with status 400/404/405/413/415/500.
- Every mutation is same-origin checked (no `Origin`, or an `Origin` matching the request
  `Host`). Body-bearing mutations also require `Content-Type: application/json` and a body
  ≤ 64 KiB; the icon upload is the one exception (≤ 1 MiB body, ≤ 512 KiB decoded). `DELETE` and
  `/reconnect` carry no body.
- Read requests are `GET`. No authentication beyond the Harness's own web auth.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/servers` | — | `{ ok, servers: [{ ...server, status }], presets: [Preset], groups: string[], version, dataDir }` |
| POST | `/servers` | full server draft | `201 { ok, server: { ...server, status } }` |
| GET | `/servers/:id` | — | `{ ok, server: { ...server, status, tools: [{name, publicName, description}] } }` |
| PUT | `/servers/:id` | full server draft (same shape as POST) | `{ ok, server: { ...server, status } }` |
| DELETE | `/servers/:id` | — | `{ ok, deleted: true }` |
| POST | `/servers/:id/enabled` | `{ enabled: boolean }` | `{ ok, server }` |
| POST | `/servers/:id/reconnect` | — | `{ ok, server }` (starts a fresh connection attempt now) |
| POST | `/servers/test` | full server draft (not stored) | `{ ok, status }` — 15s cap, always answers 200 unless the body is invalid |
| GET | `/servers/:id/icon` | — | image bytes with their `Content-Type`, `ETag` and `Cache-Control: private, max-age=300`; `304` on matching `If-None-Match`; JSON 404 when there is no icon |
| POST | `/servers/:id/icon` | `{ dataUrl: "data:image/png;base64,..." }` | `{ ok, server }`; stores the decoded image and sets `icon.kind = "upload"` |
| GET | `/servers/:id/tools` | — | `{ ok, connected, cachedAt, tools }` — live descriptors when connected, otherwise the record cache; each tool carries `name`, `publicName`, `description`, `params`, `enabled`, `approval` |
| PUT | `/servers/:id/tools` | `{ tools: [{ name, enabled, approval }] }` | `{ ok, server }`; stores only non-default overrides and rebinds live agents |
| GET | `/external` | — | `{ ok, scannedAt, presets: [{ id, name, hasPresetMcp, servers: [{ name, discoveredAt, tools: [{ name, description, params, enabled, approval }] }] }] }` — preset-owned MCP tools (§2.8); discovery refreshes first |
| POST | `/external/scan` | — | same payload as `GET /external`, after re-running discovery |
| PUT | `/external/tools` | `{ presetId, tools: [{ name, enabled, approval }] }` | same payload as `GET /external`; stores only non-default overrides for that preset and re-applies exposure |
| DELETE | `/servers/:id/icon` | — | `{ ok, server }`; deletes the stored file and resets `icon = { kind: "auto" }` |
| GET | `/presets` | — | `{ ok, presets: [Preset] }` where `Preset = { id, name, description, order }` |
| GET | `/agents` | — | `{ ok, agents: [{ sessionId, preset, servers: [key], tools: [publicName] }] }` — live exposure diagnostics |
| GET | `/preferences` | — | `{ ok, preferences: { sidebarEntry: boolean } }` — the UI preferences document (§2.9); defaults when the file is absent or damaged, never an error |
| PUT | `/preferences` | `{ sidebarEntry: boolean }` | `{ ok, preferences: { sidebarEntry } }`; persisted before answering, unknown keys ignored, a missing/non-boolean `sidebarEntry` → `400 invalid-preferences` |
| GET | `/health` | — | `{ ok, version, pid, uptimeMs }` |

`Preset` display names come from `ctx.agentPresets.list()` (`id`, `name ?? id`, `description`,
`order ?? 0`); presets with a failed activation are still listed, with their diagnostic in
`description`. When the service is absent, `presets` is `[]` and the UI explains that per-preset
selection needs agent presets.

Save/update mutates the store first (atomic), then applies the connection change. A server whose
connection fails still saves and lists.

`PUT /preferences` is same-origin checked and body-bearing (JSON, ≤ 64 KiB) like every other
mutation. Its body must be a JSON object with a boolean `sidebarEntry`; unknown extra keys are
ignored. A missing or non-boolean `sidebarEntry` answers `400 invalid-preferences` and writes nothing
(a body that is not a JSON object at all fails earlier with `400 invalid-body`, and malformed JSON
with `400 invalid-json`). The answered `preferences` object is the storage view — the client applies
exactly that value to the live slots. A missing/damaged preferences file is never an API error: `GET`
answers the defaults and the next `PUT` replaces the file.

## 4. Host lifecycle

- Mount: load the store (all three documents: `servers.json`, `external.json`, `preferences.json`;
  a missing or damaged preferences file means `{ sidebarEntry: false }`) → start one connection
  supervisor per **enabled** server → register the HTTP route → bind live agents → listen for
  `agent/created` / `agent/disposed` / `agent-preset/selected`. Preferences writes go through the
  store's serialized queue like every other store write.
- Supervisor: connect → initialize → `tools/list` → cache tools + `getInstructions()`; keep the
  connection; a dropped connection retries with backoff 1s, 2s, 4s, 8s, 16s, 30s (cap), forever,
  until disabled/removed/disposed. A manual reconnect resets the budget.
- Any tool-list change notification re-lists tools and re-exposes live agents.
- Dispose: clear timers, close clients/transports (5s cap), unregister the route, release all
  `agent.ctx` registrations, wait for queued store writes (including a pending preferences write),
  clear derived state. Nothing survives in memory.
- Two servers can never share a `key` (enforced at save).

## 5. Client requirements

The client renders one manager component in two independent surfaces: the always-registered native
plugin row settings page and an optional sidebar module. Both render the same manager; only the shell
around it differs.

### 5.1 Always registered — the native plugin row settings page

- `plugins.row.config` — keyed `@ds-hu/dsh-better-mcp-manager#dsh-better-mcp-manager` (the bundle
  package name + `#` + the row id declared in `cordis.patch.yml`), `locale: 'mcpManager'`, rendering
  `MCPManagerModulePage`. It is the **only** slot the client registers at apply time; no
  `settings.section` or `settings.section.icon` registration exists anywhere.
- **Owner props.** The native Plugins page renders the entry with one of two views,
  `{ view: 'summary' | 'page', form? }`. `view: 'summary'` returns a single inline one-liner
  (`data-testid="mcp-module-summary"`; copy 管理 MCP 服务器、工具暴露与 Agent 预设授权。 / "Manage MCP
  servers, tool exposure and agent-preset access.") and is used when the row has no description.
  `view: 'page'` renders the manager in its embedded presentation: the same `.mm-root` /
  `data-testid="mcp-page"` / `data-testid="mcp-list"` ids as the sidebar page, with
  `data-mode="module"` on the root. `form` is supplied only for entries with editable configuration
  fields and may be ignored by this row, which has none.
- **Page contents**, in order: the sidebar-entry switch card (§5.2); a compact section head with `h2`
  **MCP 服务器** / **MCP servers**, the count subtitle `共 N 个服务器 · N 个已连接` /
  `N server(s) · N connected`, the plugin version tag, and the primary **添加 MCP** button; then the
  unchanged page tabs, server list, cards, forms, 工具 settings, approval and 其他 MCP views (§5.3).
  The page title, description, icon and breadcrumb are drawn by the Plugins page, not by the
  component.
- **Default entry.** The user route is sidebar **插件** → the **MCP 管理** plugin card → the bundle
  detail page → the **MCP 管理** module row → the configure control (**配置 MCP 管理** / *Configure
  MCP Manager*) or the row name. The entry is registered unconditionally, on a fresh install with the
  default preference, and does not depend on store data or on the sidebar preference.
- **Deployment requirement.** The entry only renders inside DSH's native Plugins page
  (`@deepseek-ai/dsh-client-ui-plugin-manager`), which the shipped Web app composes. A deployment
  that composes no Plugins page has no default entry for the plugin; the optional sidebar module,
  when enabled, still renders the manager as its own page. There is no generic-Settings fallback.

### 5.2 Optional — the sidebar module, gated by the Host preference

- While the Host preference `sidebarEntry` is `true` (§2.9), also register
  `sidebar.panellist` — `id: 'mcp-manager'`, `order: 20`, `locale`, `label: () => t('panel')`
  (自动化任务 is order 10, Plugins is 0, so 20 puts MCP 管理 directly below 自动化任务) — and
  `main` — `key: 'mcp-manager'`, rendering the same manager with `data-mode="panel"`: a full-page
  `h1` title, no switch row. When the preference turns `false`, dispose both registrations live: the
  row disappears and, if its page was open, DSH falls back to the Conversation.
- Default is **off**: a fresh install registers no `sidebar.panellist` and no `main` slot. The apply
  path reads `GET /preferences`; a failed read keeps the module off and reports the error in the
  switch card.
- The switch exists only on the plugin settings page (the `data-mode="module"` presentation): a card
  `[data-testid="sidebar-entry-row"]` containing a `role="switch"` button
  `[data-testid="sidebar-entry-toggle"]` with `aria-checked`, label **在侧边栏显示 MCP 管理入口** /
  **Show MCP Manager in the sidebar**, and a one-line hint that the module is off by default while the
  plugin settings page entry is always available. The switch is disabled while the initial read or a
  save is in flight. The sidebar page never renders the card.
- Toggling calls `PUT /preferences` and applies the **accepted** answer live; a failed save leaves
  the live module on the last applied value and reports the reason. There is no optimistic
  local-only state.
- The preference is Host-side and shared per `$DSH_HOME`; the client must not mirror it into
  `localStorage`, `sessionStorage` or a profile settings document.

### 5.3 The manager view (both surfaces)

Dark and light theme, tokens only — no literal colors outside artwork:

1. Header depends on the presentation. The plugin settings page renders the switch card first, then a
   compact section head (`h2` **MCP 服务器** / **MCP servers**, the count subtitle, the version tag
   and the **添加 MCP** button); the optional sidebar page keeps the full-page `h1` title
   (**MCP 管理** / **MCP Manager**), subtitle count and the **添加 MCP** button, and never renders the
   switch card.
2. Server cards grouped by `group` (ungrouped shown last as 其他（未分组）). Each card:
   icon tile (color + image from `iconUrl`, falling back to the name’s first letter), name, status line (`已连接 · HTTP · 工具 17/19` (enabled/discovered),
   `连接失败 · HTTP · 工具 0`, `已停用 · SSE`), status dot (green/red/gray/amber), `···` menu
   (编辑, 测试连接, 重新连接, 删除), and for errors an inline error bubble with the first 2 lines
   of the message and a 详情 link that opens a dialog with message + detail.
3. Add/edit form with two tabs, 基础设置 and 工具 (a right-hand sheet or full page level; both are fine).
   基础设置: 是否启用 switch; 服务器图标 (preview + 上传图标 file picker + 恢复自动; no emoji palette) and color; 分组 select (existing groups + free text); 名称; 传输类型
   segmented HTTP / SSE / 内置(stdio); 服务器地址 (or 命令 + 参数 + 环境变量 for stdio);
   OAuth 设置 dialog (mode none/bearer/client_credentials); 自定义请求头 rows (name, value,
   delete, `+ 添加请求头`); 预设 section (radio: 全部预设 / 指定预设, then preset checkboxes);
   保存 (and 删除 in edit mode) with inline validation errors and a saving state.
4. Page-level tabs distinguish **本插件 MCP** (`page-tab-owned`) and **其他 MCP** (`page-tab-external`).
   The owned tab keeps items 1–3 unchanged. The external tab lists preset-owned MCP servers reported
   by `GET /external`, with the explanation that this plugin cannot edit their connection and only
   controls tool exposure/approval; grouped by preset (`external-preset`), each with a 预设自带 badge,
   a placeholder hint when `hasPresetMcp` has no discovered servers yet, and a 重新扫描 button
   (`external-scan`). Like the owned list, the default view is compact: one clickable server card
   (`external-server-card`) per discovered server showing its name and `enabled/total` tool count
   (plus the preset's per-tool settings remain saveable from this view via `external-save`); its tools
   and their parameters are not expanded inline. Opening a server card shows a per-server tool view
   (`external-server-view`, back via `external-back`) with the full tool cards, descriptions,
   parameter chips, per-tool enable/approval switches (`external-tool-enabled`,
   `external-tool-approval`), 全部开启/全部关闭 (`external-enable-all`/`external-disable-all`), and a
   per-preset 保存工具设置 button (`external-save`) sending `PUT /external/tools`. Loading, empty,
   error+retry (`external-retry`) and saved/failed notices are required. The external tab never offers
   add/edit/delete/test of those servers.
5. Empty state with an add CTA; loading skeleton/spinner; retry on network failure.
6. Poll `GET /servers` every 2.5s while a manager view is mounted (and immediately after every
   mutation); stop when unmounted. The plugin settings page and the sidebar page are independent
   mounts, so both may poll while both exist.
7. All copy through `ctx.locale.register(NS, { zh, en })`; locale namespace `mcpManager`. New 0.6.0
   keys: `module.summary`, `page.serversTitle`, and the switch copy (`entry.sidebar`,
   `entry.sidebarHint`, `entry.loadFailed`, `entry.saveFailed`); zh/en stay key-parity.
8. Cleanup: one `<style data-plugin-css>` tag per plugin instance, removed on dispose; every timer
   cleared in `ctx.effect` cleanup; the optional module's two slot registrations are disposed on
   toggle-off and again on plugin dispose, and the always-on `plugins.row.config` injection is
   released in its `ctx.effect`/`ctx.slots.inject` cleanup.

## 6. Test surface

- Unit (plain `node --test`, no Host): store/validation, key allocation, preset predicate, tool
  name derivation, per-tool settings/cache, the preferences document (defaults when absent,
  corrupt-file tolerance with defaults, atomic `0600` write, schema shape), preset-owned
  discovery/restriction/pre-execute/state persistence (`test/external.test.mjs`), API router with
  mock `req`/`res` (including `GET`/`PUT /preferences` and `400 invalid-preferences`), MCP result
  projection (text/resource/image diagnostic), client-credentials refresh, CLI `status` reporting
  the sidebar-entry preference.
- Mount check: patch row id === Host `name`, exports resolve, no `@deepseek-ai/*` import in `lib/`,
  no writes outside the data dir, locale/icon exported and packed, version `0.6.0` and this
  contract's "frozen for 0.6.0" line, and structural checks that `lib/client.js` registers
  `plugins.row.config` with a key whose two halves equal `package.json` `name` and the first
  `cordis.patch.yml` insert row id, that no `settings.section` / `settings.section.icon`
  registration exists, and that `sidebar.panellist` / `main` are gated behind the preference.
- Client smoke: run `lib/client.js` in a `vm` with a fake `window.__ModuleLoader__` + fake React;
  assert the default registration set is exactly one `plugins.row.config` entry with the exact key
  (no `main`, no `sidebar.panellist`, no `settings.section`/`.icon`), that a `sidebarEntry: true`
  answer adds `main` + `sidebar.panellist` (three registrations), that
  `setSidebarEntryPreference(true/false)` registers/unregisters the module live and calls
  `PUT /preferences` with the right body, that the module page renders the summary and page views
  (`data-mode="module"`, switch testids/copy, `page.serversTitle`), that the sidebar page stays
  `data-mode="panel"` without the switch, that dictionaries cover zh/en with key parity, and that no
  timer outlives dispose.
- E2E (isolated DSH_HOME + its own systemd scope, never the production instance): install the packed
  tarball into a fresh `web` profile, boot on a free port, drive the real page with Playwright,
  verify the sidebar has no MCP 管理 row by default and that the native **插件** page lists the
  **MCP 管理** bundle whose module row opens the plugin settings page; assert the page renders the
  switch card (off by default) and the manager (`data-mode="module"`, `mcp-list`), and create the
  first stdio server there; toggle the optional module on and off (row directly below 自动化任务,
  live removal, `GET /preferences` plus `preferences.json` updated, Host persistence across a
  reload); verify connect/fail/tool-count/preset scoping against local fixture MCP servers and a fake
  OpenAI-compatible endpoint that records the tool schemas it receives; a preset-mounted fixture MCP
  drives the 其他 MCP tab, disabled-tool removal from `tools[]`, and the restricted/full-access
  approval split end to end. The run publishes nine screenshots: the new
  `mcp-manager-plugin-settings.png` hero (plugin settings page with the switch and the manager), the
  optional-sidebar-module view, and the unchanged list/form/tools/external/error views.
