# MCP Manager — technical notes

Everything the README deliberately leaves out. Read this before changing the store, the connection
manager, the preset binder or the HTTP surface. The frozen internal contract is
[docs/API-CONTRACT.md](API-CONTRACT.md); when this file and the contract disagree, the contract wins
and one of them is a bug.

- [Shape of the plugin](#shape-of-the-plugin)
- [Architecture](#architecture)
- [Native plugin row settings page and the sidebar module](#native-plugin-row-settings-page-and-the-sidebar-module)
- [Connection manager](#connection-manager)
- [Result projection](#result-projection)
- [Data model](#data-model)
- [Icons](#icons)
- [Tools](#tools)
- [Other MCP (preset-owned)](#other-mcp-preset-owned)
- [Preset exposure](#preset-exposure)
- [Tool naming and definitions](#tool-naming-and-definitions)
- [HTTP API](#http-api)
- [Security](#security)
- [Client half](#client-half)
- [Lifecycle and dispose](#lifecycle-and-dispose)
- [Uninstall](#uninstall)
- [Testing](#testing)
- [Failure modes](#failure-modes)
- [What we did not build](#what-we-did-not-build)

---

## Shape of the plugin

One npm package ships three things:

| Piece | Module | Mounted by | Talks to |
|---|---|---|---|
| Host | `lib/index.js` (`name = 'dsh-better-mcp-manager'`) | the profile bundle patch, `cordis.patch.yml` | DSH Host services and MCP servers |
| Client | `lib/client.js` (`window.__ModuleLoader__`, `id = '@ds-hu/dsh-better-mcp-manager'`) | the Web shell, via `package.json` → `dsh.client`; always the native plugin row settings page, optionally the sidebar module | the Host over same-origin `/better-mcp-manager/api/*` |
| Cleanup CLI | `bin/mcp-manager.mjs` | the user, after removing the bundle | the data directory only |

The bundle patch inserts exactly one row, and its `id` equals the `name` exported by
`lib/index.js`; `test/mount-check.mjs` guards that parity. The plugin publishes no Cordis service
and inserts no other rows, so it sits loose in the Host root realm.

The Host half never writes `cordis.patch.yml`, never mounts Loader rows, never edits agent-preset
YAML, and imports no `@deepseek-ai/*` module. Everything the user configures — and the one UI
preference — lives in three JSON files plus at most one icon file per server under
`$DSH_HOME/better-mcp-manager/`. The only runtime dependency is
`@modelcontextprotocol/client` (2.2.0, MIT) for the MCP wire protocol.
See [ADR 2](adr/0002-own-mcp-connection-manager.md),
[ADR 5](adr/0005-hand-built-tool-definition.md),
[ADR 6](adr/0006-server-and-upload-icons.md),
[ADR 7](adr/0007-tool-enablement-and-approval.md),
[ADR 8](adr/0008-preset-owned-mcp-management.md), and
[ADR 9](adr/0009-settings-entry-with-optional-sidebar-module.md) (superseded) /
[ADR 10](adr/0010-native-plugin-row-settings-page.md) for the entry surface.

## Architecture

```
Host (lib/index.js)
├── store ........ servers.json + external.json + preferences.json: load, validate,
│                  atomic save, serialized patch (servers schema v3)
├── manager ...... one connection supervisor per enabled server + auto-icon fetch/cache
├── binder ....... registers each allowed server's enabled tools on live agents
├── icons ........ uploaded-icon decoding, raster checks, icons/ storage (0600)
├── external ..... preset-owned MCP discovery, restrictions, pre-execute approval, external.json
├── api .......... /better-mcp-manager/api/* (one prefix route, incl. icon/tool/external/preferences endpoints)
└── dispose ...... close connections, release agent registrations, unregister route
```

Mounting the Host half:

`apply` builds the store, connection manager, exposure controller, external controller and API,
then:

1. starts loading the data directory's documents (the load ensures the data directory exists in mode
   `0700`; a missing `servers.json` is an empty store; a file that is not JSON or has an unknown
   shape/version is quarantined as `servers.json.corrupt-<iso>` and the store starts empty, while
   individually malformed records are dropped and their valid siblings kept; a version-1 or
   version-2 file migrates in memory to version 3 — legacy emoji-string icons become automatic,
   missing `toolOverrides`/`toolCache` become `{}`/`null`; `preferences.json` is loaded at the same
   time, a missing or damaged one meaning the default `{ sidebarEntry: false }` without a
   quarantine);
2. starts the external controller (`external.start()`), which loads `external.json`, registers its
   five Host listeners and schedules the first discovery scan;
3. registers the HTTP prefix route and the `agent/created` / `agent/disposed` /
   `agent-preset/selected` listeners synchronously as effects;
4. converges in the background once loading finishes: one supervisor per **enabled** server, then a
   bind of every live agent; a later-mounting `agents` service gets its own bind sweep and external
   scan through `ctx.inject(['agents'])`.

A startup failure is logged and reported through individual server cards; it never rejects plugin
activation. The panel can poll while convergence is still in progress — a server simply appears
`connecting` until its first attempt settles.

The manager is the only owner of MCP clients. The preset binder never connects anything itself; it
reads the manager's cached tool list and registers tool definitions that call back into the owning
connection. The API reads both sides: stored records from the store, derived status from the
manager.

Saving a server is **store first, then connection**: the draft is validated and written atomically,
and only then is the connection started/restarted/stopped and live agents re-bound. A server whose
connection fails still saved and still lists — its status explains the failure. This ordering means
a bad URL cannot lose the rest of the edit, and a failed connection cannot roll back a save.

## Native plugin row settings page and the sidebar module

Since 0.6.0 the manager has one required surface and one optional one. The decision and the rejected
alternatives are in [ADR 10](adr/0010-native-plugin-row-settings-page.md), which supersedes
[ADR 9](adr/0009-settings-entry-with-optional-sidebar-module.md) (the generic Settings section used in
0.5.0) and [ADR 1](adr/0001-sidebar-panel-entry.md) (the sidebar row as the only entry).

**Always registered — the native plugin row settings page.** `lib/client.js` registers exactly one
root-scoped slot at apply time, unconditionally:

- `plugins.row.config` — `key: '@ds-hu/dsh-better-mcp-manager#dsh-better-mcp-manager'`
  (`BUNDLE_NAME` + `#` + `ROW_ID` from `cordis.patch.yml`), `locale: 'mcpManager'`, rendering
  `MCPManagerModulePage`. No `settings.section`/`settings.section.icon` registration exists any more.
  The key's two halves are constants in the client and are parity-checked against `package.json` and
  the patch by `test/mount-check.mjs`.

The slot is declared by DSH's native Plugins page
(`@deepseek-ai/dsh-client-ui-plugin-manager`). The page draws the row detail — breadcrumb back to the
bundle, the plugin icon, the row title and the row description — and the contribution renders only
the body. The page asks the entry for one of two views:

- `view: 'summary'` — a one-liner used when the row has no description
  (`data-testid="mcp-module-summary"`; copy 管理 MCP 服务器、工具暴露与 Agent 预设授权。 / "Manage MCP
  servers, tool exposure and agent-preset access.").
- `view: 'page'` — the body the configure control opens. `MCPManagerModulePage` renders
  `MCPManagerPage` with `mode: 'module'`: the root keeps `data-testid="mcp-page"` /
  `data-testid="mcp-list"`, gains `data-mode="module"`, and the embedded presentation neutralises the
  full-page scroll container (auto height, visible overflow, transparent background) and skips the
  initial focus grab (the Plugins page keeps focus). The body
  order is: the sidebar-entry switch card, then the compact section head — `h2` **MCP 服务器** /
  **MCP servers**, the `共 N 个服务器 · N 个已连接` / `N server(s) · N connected` subtitle with the
  plugin version tag, and the **添加 MCP** button — then the unchanged page tabs, list, cards, forms,
  tool settings and 其他 MCP views.

The owner props are `{ view: 'summary' | 'page', form? }`; `form` is supplied only for entries with
editable configuration fields and this row ignores it. The registration lives in its
`ctx.slots.inject` cleanup and is released on dispose. The page title, description, icon and
breadcrumb are drawn by the Plugins page, not by the component.

**Default entry and route.** A fresh install opens the manager through the Plugins page: sidebar
**插件** → the **MCP 管理** plugin card → the bundle detail page → the **MCP 管理** module row → the
configure control (**配置 MCP 管理** / *Configure MCP Manager*) or the row name. The card title, row
title and page title all come from the package's `locale/*.json` metadata; the row id and icon come
from the Loader row (`cordis.patch.yml`) and the package `icon`.

**Deployment requirement.** The row config page only renders inside DSH's native Plugins page, which
the shipped Web app composes. A deployment that composes no Plugins page gets no default entry: it
still serves the HTTP API and the optional sidebar page is unaffected, and the optional module, once
enabled, still opens the manager on its own page. There is deliberately no generic `settings.section`
fallback.

**Optional — the sidebar module.** The old sidebar row and its page are now an independent module
that exists only while the Host preference `sidebarEntry` is `true`:

- `sidebar.panellist` — `id: 'mcp-manager'`, `order: 20`, `locale`, `label: () => t('panel')`.
  自动化任务 registers order 10 and Plugins order 0, so 20 puts the row directly below 自动化任务.
- `main` — `key: 'mcp-manager'`, rendering the same component with `data-mode="panel"`: the
  full-page presentation (`h1` title, subtitle, add button) with no switch card.

Both are registered by `mountSidebarEntry()` and unregistered by `unmountSidebarEntry()`; turning the
switch off disposes both live, so the row disappears and, if its page was open, DSH falls back to the
Conversation. The module's registrations are also disposed on plugin dispose. Nothing is registered
while the module is off; that is what makes a fresh install show exactly one entry (the Plugins page).

**Preference transport.** The client reads `GET /better-mcp-manager/api/preferences` once at apply
(one shared in-flight request) and writes changes with `PUT /preferences`. The answer is
`{ ok, preferences: { sidebarEntry } }`; on a successful write the client applies the answered value,
not the requested one. A failed read keeps the module off and reports the error in the switch card; a
failed write leaves the live module on the last applied value and reports the reason — there is no
optimistic local-only state. The preference is **Host-side**: it lives in `$DSH_HOME/better-mcp-manager/preferences.json`
via the store, is shared by every browser and every profile under that DSH home, and is deliberately
not mirrored to `localStorage`/`sessionStorage` or to a profile settings document.

**The switch.** On the plugin settings page only, a card `[data-testid="sidebar-entry-row"]` renders
before the section head. It contains a `role="switch"` button
`[data-testid="sidebar-entry-toggle"]` with `aria-checked`, the label **在侧边栏显示 MCP 管理入口** /
**Show MCP Manager in the sidebar**, a one-line hint that the module is off by default while the
plugin settings page entry is always available, and an inline alert for load/save failures. The
switch is disabled while the initial read or a save is in flight. The sidebar page never renders the
card.

**One component, two shells.** Both surfaces render `MCPManagerPage`; there is no forked manager. The
plugin page passes `mode: 'module'`, the sidebar page `mode: 'panel'`. Each mount owns its own poll
timer, so the plugin page and an open sidebar page can poll concurrently; each unmount clears its own
timer. Both surfaces share the module-scope preference state and the same sidebar registrations, so
toggling the switch updates every mounted view.

## Connection manager

`lib/mcp.js` owns one supervisor per server. Its public surface for the rest of the Host is
deliberately small: start, stop, reconfigure, status, cached tools and instructions (including the
descriptors the tool cache is built from), resolve the automatic icon, and
`callTool(rawName, args, execution)`.

**States.** The supervisor's own values are `disabled`, `connecting`, `connected` and `error`; while
an `error` server is waiting for its next attempt, `nextRetryAt` is set, which the page presents as
**重连中**. Each snapshot also carries `attempts`, `connectedAt`, `lastAttemptAt`, `nextRetryAt`,
`toolCount`/`discoveredCount`, `enabledToolCount` and the last `error`
(`{ code, message, detail, at }`). The state is derived, never stored.

```
disabled ──enable──▶ connecting ──ok──▶ connected
                        │                  │
                        │ fail             │ dropped
                        ▼                  ▼
                      error ──backoff──▶ connecting …
```

- **Connect** — build the transport (20s budget), `initialize`, then `tools/list` (20s budget) when
  the server declares the `tools` capability; cache tools, instructions, the transport label and the
  server's advertised icons. Only then is the state `connected` and the tool set exposed.
- **Retry** — a failed or dropped connection clears the tool set and retries with backoff 1s, 2s,
  4s, 8s, 16s, 30s (cap), forever, until the server is disabled/removed or the plugin is disposed.
  There is no "give up" state: a laptop MCP server that comes back after lunch recovers on its own.
  A manual reconnect resets the attempt counter and attempts immediately.
- **Tool-list changes** — the SDK's `tools/list_changed` notification delivers a fresh list; the
  supervisor re-adopts and re-exposes every live agent, and `lib/index.js` writes the new descriptors
  to `toolCache` through the serialized `store.patch` (skipped when the descriptors are unchanged). A
  refresh error keeps the previous set, and a public-name collision keeps the first tool and logs a
  warning.
- **Disable** — stop retrying, close the transport, drop cached tools, remove the server's tools and
  instructions from every live agent, status becomes `disabled`.
- **Delete** — same as disable, then the record is removed from the store.
- **Dispose** — close every client/transport with a 5s budget, clear every timer, drop all state.

A save only restarts the connection when the **connection configuration** changed: transport, URL,
command, args, env, cwd, headers or OAuth. Renaming, regrouping, changing the icon, changing the
timeout, changing preset exposure or saving tool settings updates the record (and re-binds agents)
without dropping the socket.

**Transports.** `http` is Streamable HTTP, `sse` is the older HTTP+SSE transport, `stdio` starts a
local process. `http`/`sse` send the configured custom headers on every request; `stdio` runs
`command` with `args`, `cwd` (empty = inherit) and `env` merged over the Host's default environment.
Child stderr is captured (last 4 KiB) and attached to the error detail; a failed spawn or early exit
is a `connect-failed`/`closed` error, not a silent empty tool list.

**OAuth.** Before an HTTP/SSE connect:

- `bearer` adds `Authorization: Bearer <token>` unless the user already configured an
  `Authorization` custom header — custom headers win.
- `client_credentials` POSTs form-encoded
  `grant_type=client_credentials&client_id=…&client_secret=…&scope=…` to `tokenUrl` (15s budget),
  caches the access token until `expires_in - 60s` (5 minutes when the provider omits `expires_in`),
  and retries the connection once with a fresh token when the attempt looks unauthorized. A failed
  token fetch is a connection error with code `auth-failed` whose message names the endpoint status.

There is no authorization-code flow. See [ADR 2](adr/0002-own-mcp-connection-manager.md).

**Timeouts.** `timeoutMs` (1000–600000, default 60000) bounds one `tools/call`. A call that times
out fails that tool call (the transport error reaches the model as a tool error), not the
connection; `timeoutMs` is read at call time, so changing it needs no reconnect.

## Result projection

An MCP tool result is projected into the tool-result content the model sees, preserving block
order:

- text runs are coalesced into newline-joined text blocks;
- `resource_link` blocks become `Resource link: <name> (<uri>)` text; a malformed link becomes a
  readable diagnostic instead of disappearing;
- `audio` and embedded `resource` blocks project to a short diagnostic (`audio result unsupported`,
  `embedded resource unsupported`) — the raw value remains available to programmatic callers;
- an unknown block type or a non-object block becomes `[unsupported MCP content …]`, and an empty
  result becomes `(<tool> returned no model-visible content)`;
- **images** are admitted only when the result is canonical base64 in PNG/JPEG/WebP/GIF, the Host has
  an attachment store, and the current model route declares image input. Admitted images are saved
  through the Host's attachment service; otherwise every image in that result projects to
  `[image unavailable: <mime>; <reason>; raw image data remains available …]`. A tool call never
  silently loses an image.
- a result whose `isError` is true rejects the tool call with the projected text — the model sees a
  tool error, never a fake success. The raw result is validated with the MCP SDK's own
  `CallToolResult` spec schema first; a spec-invalid result is reported as an invalid MCP result.

The canonical value keeps the MCP `content` array and any `structuredContent`; when images were
admitted, the tool definition's `projectContent` swaps in the attachment-backed content for that
exact execution. There is no `@deepseek-ai/*` import here: the Host services are looked up on the
plugin context at call time, so a profile without an attachment or LLM service degrades to the image
diagnostic instead of failing to load. The projection follows `@deepseek-ai/dsh-mcp-client`,
adapted for this plugin's single-connection model; attribution is in [NOTICE](../NOTICE).

## Data model

Three JSON files plus an icon directory under `$DSH_HOME/better-mcp-manager/`; the directory is mode
`0700`, `servers.json`, `external.json` and `preferences.json` are mode `0600`, and uploaded icons
live in `icons/` (mode `0700`, each file `0600`). Creating a store ensures the data directory exists
(mode `0700`) on mount; `servers.json` appears on the first owned-server save, `external.json` on the
first save on the 其他 MCP tab, `preferences.json` on the first sidebar-switch change, `icons/` on the
first upload, and mounting without configuring writes no file.

The resolver understands one test/scratch override: `DSH_MCP_MANAGER_DATA_DIR` (absolute path) wins
over `$DSH_HOME`; without either, the directory is `~/.dsh/better-mcp-manager`. The directory is
**per DSH home, not per profile**: two profiles under the same `$DSH_HOME` share one server list and
one UI preference. Each Host process that mounts the plugin keeps its own connections against that
shared list and neither instance coordinates with the other beyond the atomic file replace. The Host and the
`bin/mcp-manager.mjs` CLI use the same resolver, so `clean` and `status` always target the directory
the Host would use for the same environment. `test/mount-check.mjs` asserts the default resolution
and the override.

```jsonc
{ "version": 3, "servers": [{
  "id": "srv_1f3c9a2b70", "key": "mylocal", "name": "My MCP",
  "enabled": true, "transport": "http", "url": "http://localhost:3000/mcp",
  "command": "", "args": [], "cwd": "", "env": {},
  "headers": [{ "name": "Authorization", "value": "Bearer sk-..." }],
  "oauth": { "mode": "none" },
  "icon": { "kind": "auto" },
  // or: "icon": { "kind": "upload", "file": "srv_1f3c9a2b70.png",
  //               "mimeType": "image/png", "updatedAt": "2026-11-16T10:00:00.000Z" }
  "color": "blue", "group": "",
  "presets": "all", "timeoutMs": 60000,
  "toolOverrides": { "fail": { "enabled": false } },
  "toolCache": { "at": "2026-11-16T10:00:00.000Z", "tools": [
    { "name": "echo", "publicName": "mcp__mylocal__echo", "description": "Echo the text back.",
      "params": [{ "name": "text", "required": true }] }
  ] },
  "createdAt": "2026-11-16T10:00:00.000Z", "updatedAt": "2026-11-16T10:00:00.000Z"
}] }
```

Validation happens before any write; failures are `400 { ok:false, code, error }` and change
nothing. The rules are listed in [API-CONTRACT §2.1](API-CONTRACT.md#21-server-record-stored); the
ones a change is most likely to break:

| Rule | Why it matters |
|---|---|
| `key` unique, allocated once, 1..32 `[A-Za-z0-9_-]` | tool names; see [Tool naming](#tool-naming-and-definitions) |
| `name` 1..80, trimmed; duplicate names allowed | rename must not affect identity |
| `transport` ∈ {http, sse, stdio}; http/sse need absolute http(s) URL, stdio a non-empty command | no half-configured servers |
| headers: unique case-insensitively, ≤20, name matches the HTTP token grammar, value ≤4096 chars | duplicate or invalid headers are rejected at save, not at connect |
| `presets` is `"all"` or ≤40 **known** preset ids (roster in the error) | unknown ids would silently expose nothing |
| `icon` is **not accepted in drafts**; it is `{kind:"auto"}` or `{kind:"upload",file,mimeType,updatedAt}` and changes only through the icon endpoints | image bytes never enter `servers.json`, and no save can clear an upload |
| `toolOverrides` only stores deviations (`{enabled:false}` / `{approval:true}`, ≤500 raw names); `toolCache` holds ≤300 descriptors, each with a description ≤2000 chars and ≤64 parameters | a save cannot silently re-enable a tool or forge a default override |
| `color` from a fixed palette, `group` ≤60 chars | UI storage, not semantics |
| `timeoutMs` integer 1000..600000, `enabled` boolean | one call cannot hang forever |
| unknown fields are dropped | forward compatibility is explicit |

Drafts are normalised into a stored record; the Host allocates `id`/`key` and timestamps. An
edit replaces the record but **never** the key. Live status is joined into API responses and never
written back.

Writes are atomic and serialized: a snapshot is JSON-stringified, written to a uniquely named
temporary file in the same directory with mode `0600`, then `rename`d over `servers.json` (the mode
is re-applied afterwards in case the rename target already existed). `store.patch(id, fn)` applies a
read-modify-write inside the same queue, which is how the Host persists a new `toolCache` without
clobbering a concurrent settings save. Reads accept schema `version` 1, 2 or 3. A version-1 file
(emoji-string icons) or version-2 file migrates **in memory** on load — every legacy icon string
becomes `{ "kind": "auto" }`, and missing tool settings become `{}`/`null` — and is rewritten as
version 3 by the next save; reads never rewrite the file. An icon value that does not match the
stored shape is reset to `auto` for that record, and the record is kept. A file that is not JSON or
has an unknown shape/version moves aside as `servers.json.corrupt-<iso>` and the store starts empty;
a record whose identity fields are malformed is dropped individually and the remaining valid records
are kept, with a warning in the Host log. A bad file therefore cannot keep the Host from booting.

**UI preferences.** `preferences.json` is the third document, schema version 1, mode `0600`, written
through the same serialized queue and atomic temp-file + `rename` discipline:

```jsonc
{ "version": 1, "sidebarEntry": false }
```

It currently carries one key: `sidebarEntry` (boolean, default `false`), whether the optional sidebar
module exists in the client. The default is what a fresh install and a missing file mean. Unlike the
server and external stores, a damaged, unparseable or unknown-shape preferences file is **not**
quarantined: the store logs a warning, starts from the default and lets the next write replace the
file, because the value is a UI preference and a stale copy has no recovery value. `store.load()`
loads it with the other documents; `store.preferences()` returns the normalized
`{ sidebarEntry }` view, `store.setPreferences()` serializes a write and returns that view, and
`store.preferencesPath()` is used by the CLI and tests. `GET`/`PUT /preferences` are the only ways
the browser reads or changes it (see [HTTP API](#http-api)); `bin/mcp-manager.mjs status` prints it
and `clean --yes` deletes it with the directory.

## Icons

The stored `icon` is a tiny discriminated object; the page never sees the file name except through
`iconUrl`. [ADR 6](adr/0006-server-and-upload-icons.md) records why.

**Automatic (`{ "kind": "auto" }`, the default).** On `initialize`, the manager reads
`serverInfo.icons` (MCP `Implementation.icons`, at most 8 entries, each
`{ src, mimeType?, sizes?, theme? }`). It picks the first icon with no theme or `theme: "light"`,
otherwise the first one. `src` may be a `data:` URI (canonical base64, declared type one of the four
accepted raster types) or an absolute `http(s)` URL. For HTTP(S) sources the **Host**, not the
browser, fetches the bytes:

- 5 s timeout, `Accept` limited to the four raster types, redirects followed;
- the server's own custom headers and OAuth `Authorization` are attached (a stdio server has none);
- the response must declare `image/png`, `image/jpeg`, `image/webp` or `image/gif`, must be at most
  512 KiB, and must pass the magic-byte check; anything else is treated as "no icon";
- results are cached in memory per server + `src` for 10 minutes, failures for 60 seconds, and
  concurrent requests for one `src` share one in-flight fetch. Dropping or re-initializing the
  connection clears the cache and re-reads the advertised icons.

If no icon resolves — not connected, no declared icon, bad data URI, failed fetch, wrong type or size
— `GET /servers/:id/icon` answers `404` and the page draws the first letter of the server name.
Nothing about the fallback is stored; a later successful fetch replaces it.

**Upload (`{ "kind": "upload", ... }`).** `POST /servers/:id/icon` takes
`{ "dataUrl": "data:image/png;base64,…" }` and stores exactly one raster file. The Host:

1. caps the JSON envelope at 1 MiB (`MAX_ICON_JSON_BYTES`) — the only endpoint above the normal
   64 KiB body limit — and the decoded bytes at 512 KiB (`MAX_ICON_BYTES`);
2. requires canonical base64 and a declared type in PNG/JPEG/WebP/GIF; the decoded bytes must match
   the format's magic number, so a mislabeled payload is rejected;
3. writes `$DSH_HOME/better-mcp-manager/icons/<id>.<ext>` through a unique temporary file and a
   `rename` (directory `0700`, file `0600`), then deletes any other `<id>.*` file, so a format change
   leaves exactly one file and a crash leaves either the old or the new image;
4. updates the record to `{ kind:"upload", file, mimeType, updatedAt }` and answers the full server.

`DELETE /servers/:id/icon` deletes every `<id>.*` file, resets the record to `{ kind:"auto" }` and
answers the full server. Replacing an upload overwrites through the same path; deleting the server
removes its files (a cleanup failure is logged, not fatal). A stored record whose file disappeared
answers `404` (the page falls back to the first letter); the record is not silently rewritten.

`GET /servers/:id/icon` serves the bytes with their `Content-Type`, a strong `ETag` computed from
`sha1(bytes + versionTag)`, `Cache-Control: private, max-age=300` and
`X-Content-Type-Options: nosniff`; `If-None-Match` answering the current ETag returns `304`.
`versionTag` is the upload's `updatedAt` or the literal `auto`, and `iconUrl` carries it as
`?v=…` so a replaced icon is a new URL for the browser cache. `iconUrl` is added by the API view
(`withStatus`), not by `serverView`; list, get, create, update, enable and reconnect answers all
carry it.

**No built-in artwork.** 0.2.0 removed the emoji picker and the string `icon` field entirely: the
source contains no emoji glyphs, there is no stock icon set, and SVG is rejected on upload (a
same-origin SVG document can execute script). See [ADR 6](adr/0006-server-and-upload-icons.md).

## Tools

A server's tool list is discovered, not configured: the page only decides **which discovered tools
are exposed** and **whether a tool asks for approval**. [ADR 7](adr/0007-tool-enablement-and-approval.md)
records why; the stored shape is in
[API-CONTRACT §2.7](API-CONTRACT.md#27-tool-list-and-per-tool-settings).

**Stored settings.** `toolOverrides` is keyed by the **raw** MCP tool name and holds only deviations:

```jsonc
"toolOverrides": { "fail": { "enabled": false }, "echo": { "approval": true } }
```

`{ enabled: false }` hides a tool; `{ approval: true }` makes it ask; an entry that restates the
defaults is stripped before it is stored (`normalizeToolOverrides`). `toolEnabled`/`toolNeedsApproval`
read the map with the defaults "enabled" and "no approval", so a server nobody configured carries
`{}`. A save never accepts either map from the request: `POST`/`PUT /servers` copy the values from
the stored record (`normalizeDraft`), so a draft can neither re-enable a tool nor forge an
approval flag.

**Tool cache.** `toolCache` is the last discovered descriptor set:

```jsonc
"toolCache": { "at": "…", "tools": [{
  "name": "echo", "publicName": "mcp__mylocal__echo",
  "description": "Echo the text back.", "params": [{ "name": "text", "required": true }]
}] }
```

It is written by `lib/index.js` whenever a connected server's tool list changes (the manager's
`onToolsChange` hook calls `persistToolCache`) and by `GET /servers/:id/tools` when the server is
connected; both go through `store.patch`, compare the descriptor list, and skip an unchanged write.
`description` is capped at 2000 chars, at most 300 tools and 64 parameters per tool are kept, and the
cache holds no headers, tokens or other credentials. It exists so the **工具** tab works while the
server is disconnected; it is not evidence that the server still offers those tools.

**Endpoints.** `GET /servers/:id/tools` answers
`{ ok, connected, cachedAt, tools: [{ name, publicName, description, params, enabled, approval }] }`
— live descriptors plus the stored settings when connected, the cache plus settings otherwise;
`cachedAt` is `null` when nothing has ever been discovered. `PUT /servers/:id/tools` takes
`{ tools: [{ name, enabled, approval }] }` (every entry needs both booleans, names unique, ≤500),
normalises the batch into `toolOverrides`, saves through `store.patch`, re-syncs the manager record
and re-binds every live agent. Card counts come from the manager snapshot
(`enabledToolCount / toolCount`, exposed as `工具 2/3`); a tool settings save refreshes them
immediately.

**Exposure filter.** `lib/presets.js` walks each allowed server's live tools and skips
`toolEnabled(server, rawName) === false`; disabled tools are never registered on any `agent.ctx`.
If no tool of a server is registered, the binder also skips that server's instruction section —
an all-disabled server contributes neither tools nor system-prompt text. Discovery (and therefore
the cache) keeps running regardless of the per-tool switches.

**Approval seam.** `approval: true` means "ask in restricted modes"; the check lives in
`lib/result-projection.js` (`enforceApproval`) and runs inside the tool body **before** the MCP call:

1. read `exec.agent` and the calling session's permission preset via
   `hostCtx.get('permissionPresets').current(agent.session)`;
2. if the preset is exactly `danger-full-access` (UI 完全权限), proceed without asking;
3. otherwise request the Host approval service once with
   `{ agent, toolName, callId, reason: 'MCP 工具 "mcp__<key>__<tool>" 需要审批（当前不是完全权限）', signal }`;
4. `allowed-once` proceeds; `rejected`, `cancelled` and `unavailable` fail the call with a readable
   tool error; a missing approval service, permission service, agent or execution context **denies**
   the call. The MCP server is not contacted unless approval was granted.

The UI presents the waiting request as the DSH composer **等待审批** with **拒绝 / 允许一次**, and
the tool card's hint reads **非完全权限时会要求你批准**. Approval is a per-call confirmation, not a
sandbox and not a second permission system: the Host's own permission rules still apply to the
session, and the manager adds no allowlist of its own.

**Page.** The edit sheet has two tabs, **基础设置** and **工具**. The tools tab lists every tool as
a card: raw name, clamped description, parameter chips (**必填** / **可选**), the enable switch and
the **需要审批** switch (disabled while the tool itself is disabled), plus the hint. It shows
**已启用 n/m**, **全部开启**/**全部关闭**, **更新于 …** for cached lists, **先保存并连接服务器，再管理
工具** for an unsaved server, and the **保存工具设置** footer; a save keeps the tab open, reports
**工具设置已保存** or the failure, and leaves the draft form untouched.

## Other MCP (preset-owned)

Not every MCP server in a profile belongs to this plugin. Another plugin or an agent preset can
mount its own `@deepseek-ai/dsh-mcp-client` rows; their tools are inherited by Agents of that preset.
The **其他 MCP** page tab manages exactly the two levers a Host plugin can reach at runtime — remove
an inherited tool from the model-facing tool list, and ask for approval before a call — without
editing preset YAML, starting/stopping those connections, or touching their credentials.
[ADR 8](adr/0008-preset-owned-mcp-management.md) records the decision; the contract is
[API-CONTRACT §2.8](API-CONTRACT.md#28-preset-owned-external-mcp-tools).

**Discovery algorithm** (`lib/external.js`). A scan walks live Agents
(`hostCtx.get('agents').list()`) and, per Agent:

1. resolves `presetId = composedPreset(hostCtx, agent)` and reads
   `agent.ctx.tools.view(agent)` (`visible` Map plus `restrictableNames` Set);
2. builds the candidate set from `restrictableNames` — names matching
   `mcp__<serverName>__<raw>` — minus `exposure.ownToolNames()`, so this plugin's own tools can never
   be classified as external;
3. applies the stored restrictions **before** reading the visible list (a tool just re-enabled is
   still absent while the old restriction is alive, and `restrictableNames` is stable under
   restrictions), then re-reads the view;
4. groups the visible external names by server namespace (the first `__` terminates the server name;
   it is ≤32 `[A-Za-z0-9_-]`), describes each tool from its live definition
   (`description` ≤2000 chars, parameter names/requiredness from the input schema, ≤64), and merges
   over the previous cache. A disabled tool is kept in the cache while its `enabled:false` override
   exists, so it stays visible in the panel across rescans; a cached tool that is no longer listed
   and has no disabled override is dropped, and `discoveredAt` is refreshed on change;
5. adds a placeholder preset when `agentPresets.inspectCompositions()` shows an
   `@deepseek-ai/dsh-mcp-client` module but no Agent of that preset is live yet
   (`hasPresetMcp: true`, `servers: []`), and sorts presets by the roster's `order`.

Scans are coalesced (microtask by default, 25 ms for `tools/change`) and triggered by startup,
`agent/created`, `agent/disposed`, `agent-preset/selected`, `tools/change`, a late `agents` service,
`GET /external`, `POST /external/scan`, and after every settings save. `scannedAt` advances on every
scan; `external.json` is written when discovery changed or settings were saved.

**Restrictions.** For each Agent the controller computes a deny list from
`overrides[name].enabled === false` over that Agent's restrictable external names and calls
`agent.ctx.tools.restrict({ deny })`. The restriction replaces the previous one when its signature
changes (same preset, same deny set → no-op), is applied only to Agents of the owning preset, and is
disposed when the Agent is disposed or the controller shuts down. This removes the tool from the
model-facing tool set — it is not a call-time rejection — and it is recomputed on agent creation,
preset switch and tool-registry changes.

**Approval seam.** `external.start()` registers a Host-wide `tools/pre-execute` listener. For a
candidate name it checks, in order: `mcp__` namespace → live Agent → owning preset →
`overrides[name].approval === true` → not one of this plugin's own names → the name is in the
Agent's restrictable set → the session is not exactly `danger-full-access`. If all hold it returns
`{ kind: 'ask', reason: 'MCP 工具 "<name>" 需要审批（当前不是完全权限）' }`; otherwise it calls the
next policy. The shared DSH pipeline runs the approval service and only dispatches on
`allowed-once`; rejected/cancelled/unavailable or a missing approval channel deny before the MCP
call. This plugin's own tools return `next()` here and keep their existing approval body, so nothing
is double-gated. The Host's approval policy still decides whether an ask can be displayed: with a
`never` policy the ask is denied rather than shown, and the plugin cannot override that.

**State file.** `$DSH_HOME/better-mcp-manager/external.json` (schema version 1, mode `0600` inside
the `0700` data directory, atomic temp-file + rename):

```jsonc
{ "version": 1, "presets": {
  "<presetId>": {
    "updatedAt": "…",
    "overrides": { "mcp__foreign__ping": { "approval": true },
                   "mcp__foreign__add": { "enabled": false } },
    "servers": { "foreign": { "discoveredAt": "…", "tools": [{ "name": "mcp__foreign__ping",
      "description": "…", "params": [{ "name": "text", "required": true }] }] } }
  }
} }
```

Only deviations from "enabled, no approval" are stored. Caps: 100 presets, 200 servers per preset,
300 tools per server, 2000 override entries per preset, description 2000 chars, 64 params per tool.
Only valid `mcp__` names and preset ids are accepted; a corrupt or unknown-version file is moved to
`external.json.corrupt-<iso>` and the state starts empty. No credentials, headers or tokens are ever
written. `clean --yes` deletes the file with the whole directory; deleting it resets every choice to
the default.

**API.** `GET /external` refreshes discovery then returns
`{ ok, scannedAt, presets: [{ id, name, hasPresetMcp, servers: [{ name, discoveredAt, tools: [{ name,
description, params, enabled, approval }] }] }] }`; `POST /external/scan` is the same after an
explicit rescan (same-origin checked); `PUT /external/tools` takes
`{ presetId, tools: [{ name, enabled, approval }] }`, stores only deviations, re-applies restrictions
and returns the refreshed payload. Validation failures are `400 invalid-body` / `400 invalid-preset` /
`400 invalid-tools` / `400 invalid-tool-name`; a missing controller answers
`500 unavailable`; unsupported methods on these paths fall through to `404 not-found`.

**External tab.** The main page has two level-1 tabs, **本插件 MCP** and **其他 MCP**. The external
tab shows the intro caveat, **上次扫描：…** and **重新扫描**; one group per preset with its id and the
**预设自带** badge, and a **该预设自带 MCP，但工具列表还未同步** placeholder plus the hint to open
a session or rescan when a preset has an MCP client but no discovered server. Each discovered server
is a compact, clickable card (`external-server-card`) with a letter tile, its name, **x/y 个工具已
启用** and, when known, **发现于 …**; descriptions and parameters are not expanded in this list.
Opening a card shows the per-server view (`external-server-view`, back via `external-back`) with the
server name and **{preset} · {presetId} · 预设自带**. Its **工具列表** section
(`external-tools-panel`) shows **已启用 x/y** (`external-count`), **全部开启 / 全部关闭**
(`external-enable-all` / `external-disable-all`), the full tool cards (description, parameter chips,
per-tool switches `external-tool-enabled` / `external-tool-approval`; approval is disabled while the
tool itself is disabled), the footer hint and a dirty-gated **保存工具设置** (`external-save`).
Saving stays in the view, and **返回** goes back to the compact list with refreshed meta. The list
footer also carries a dirty-gated **保存工具设置**. The tab never offers add/edit/delete/test/
reconnect for these servers.

## Preset exposure

`presets` answers one question: **which agents get this server's tools?**

- `"all"` — every agent, including an agent with no preset id.
- an array — only an agent whose composed preset id is in the array. `[]` exposes the server to
  nobody; it is legal and means "configured but not handed to any agent".
- Unknown ids are rejected at save time. The roster is read from `ctx.agentPresets.list()`; when
  that service is absent the roster is empty and the UI explains that per-preset selection needs
  agent presets.

The binder (`lib/presets.js`) works at agent lifecycle boundaries, never on a timer:

1. **`agent/created`** — read the composed preset id, register the tools and instruction sections of
   every allowed, connected server on `agent.ctx`.
2. **Configuration change or plugin mount** — re-bind every live agent: add/remove registrations to
   match the new state. This is how a save or a toggle affects an open session without a restart.
3. **`agent-preset/selected`** — before an agent's first turn, re-bind it for the selected preset.
   A preset switch after the first turn is not re-bound: DSH fixes the preset once the session
   starts, and the plugin does not fight that.
4. **`agent/disposed`** — release every registration made for that agent. Registrations live on
   `agent.ctx`, so they disappear with the agent even if a cleanup is missed, but the binder
   releases them explicitly and drops its bookkeeping.

Server `instructions`, when present, become **one `systemPrompt.section` per server** on the same
`agent.ctx`, named `mcp-manager:<key>`, with order `getSectionOrder('MCP_SERVERS')` (fallback 130)
and `interpolate: false`; each server keeps its own text closure, so a server that updates its
instructions rewrites only its own section. Only servers with at least one **enabled** tool actually
exposed contribute prompt text: a disconnected server, or one whose tools are all disabled or
rejected by the preset, contributes no instructions. The injected text is capped at 32,768 UTF-8
bytes (cut on a code-point boundary); the status reports the server's original byte count. Sections
are added and removed with the tool registrations, so an agent never keeps instructions for a server
it cannot call. See [ADR 3](adr/0003-preset-scoped-tool-registration.md).

Two agents can be exposed to the same server: they share the one connection, each has its own
registrations, and one agent's disposal does not affect the other.

## Tool naming and definitions

Public name: `mcp__<key>__<rawName>`, then normalised to DSH's function-name contract
(`[A-Za-z0-9_-]`, ≤ 64 chars). When normalisation changes the string, a 12-hex SHA-256 of
`(key, rawName)` is appended, so two distinct MCP tools can never collapse into one name.

- The public name is a pure function of the immutable `key` and the server's raw tool name.
  Renaming a server does not rename tools; deleting and re-adding a server allocates a new key and
  therefore new tool names.
- The **raw** name is what goes on the MCP wire. The public name is never parsed back.
- A server that lists the same raw name twice is collapsed to one registration (the first wins,
  with a warning in the Host log) — a duplicate is never exposed as two tools.

`lib/tool-definition.js` builds the `ToolDefinition` by hand — `name`, `description`, `parameters`
(the MCP input schema verbatim), `output`, `timeoutMs`, `execute` and `projectContent` — because a
profile-installed plugin cannot resolve the Harness packages that export the tool helpers.
`test/mount-check.mjs` fails the build if any `lib/` file imports `@deepseek-ai/*`.

The advertised MCP `outputSchema` is deliberately **not** embedded in the canonical output schema:
it may use vocabulary the Harness schema subset rejects, which would fail registration for the whole
tool. The canonical schema is a fixed object with a `content` array and an opaque optional
`structuredContent`; `structuredContent` is preserved in the value and only its text projection is
model-visible. A tool that declares `execution.taskSupport: "required"` is exposed but every call
fails with a clear error; the manager does not run the MCP task protocol.

Tool errors are reported as tool errors (the model sees them), not as HTTP errors: the panel's HTTP
API never executes MCP tools. Tool permissions and sandboxing remain the Host's, decided for the
agent that calls the tool; the manager adds no second permission system. The one opt-in the plugin
adds is the per-tool **approval** check described in [Tools](#tools), which delegates to the Host
approval service and never allows a call the Host would deny.

## HTTP API

Base: `/better-mcp-manager/api`, one `prefix` route on `ctx.webServer`, same-origin only. The full
route table, envelopes and error codes are frozen in
[API-CONTRACT §3](API-CONTRACT.md#3-host-http-api). Summary:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/servers` | server list (each with live status), preset roster, groups, version, data dir |
| `POST` | `/servers` | create |
| `GET` | `/servers/:id` | one server, its status and discovered tool names |
| `PUT` | `/servers/:id` | replace (full draft) |
| `DELETE` | `/servers/:id` | delete |
| `POST` | `/servers/:id/enabled` | enable/disable |
| `POST` | `/servers/:id/reconnect` | start a fresh attempt now |
| `POST` | `/servers/test` | test an unsaved draft (15s cap, not stored) |
| `GET` | `/servers/:id/tools` | live or cached tool descriptors plus each tool's `enabled`/`approval` settings |
| `PUT` | `/servers/:id/tools` | save per-tool enable/approval settings, rebinding live agents |
| `GET` | `/servers/:id/icon` | the current icon as image bytes; `404` when there is none |
| `POST` | `/servers/:id/icon` | upload a `data:` URL, store it and set `icon.kind = "upload"` |
| `DELETE` | `/servers/:id/icon` | delete the stored file and reset `icon = { kind: "auto" }` |
| `GET` | `/presets` | agent-preset roster |
| `GET` | `/agents` | live exposure diagnostics |
| `GET` | `/preferences` | UI preferences (`{ sidebarEntry }`); defaults when the file is absent or damaged |
| `PUT` | `/preferences` | write `{ sidebarEntry: boolean }`, persisted before answering; `400 invalid-preferences` |
| `GET` | `/external` | preset-owned MCP groups/tools after a discovery refresh |
| `POST` | `/external/scan` | re-run discovery now, same payload; no body, same-origin checked |
| `PUT` | `/external/tools` | save one preset's tool enable/approval settings and re-apply exposure |
| `GET` | `/health` | version, pid, uptime |

Responses are JSON: success `{ ok: true, ... }`, failure `{ ok: false, code, error }` with 400/404/
405/413/415/500. The icon GET is the exception: it answers image bytes on success, a `304`, or a
JSON `404` when no icon is available. Every mutation is same-origin checked. Body-bearing mutations
additionally require `Content-Type: application/json` and a body ≤ 64 KiB; the **icon upload is the
one exception** — its JSON envelope may reach 1 MiB (`MAX_ICON_JSON_BYTES`) for at most 512 KiB of
decoded image. `DELETE` and `/reconnect` carry no body, so they are same-origin checked but do not
require a JSON content type. Reads are plain `GET`; there is no authentication beyond the Harness's
own web auth.

`GET /servers` also returns the `groups` used by the panel (first-seen order, ungrouped not listed)
and the resolved `dataDir`. Preset rows are `{ id, name, description, order }` plus an optional
`broken` diagnostic when the Host reports that the preset failed to activate; when the agent-preset
service is absent the roster is empty and the UI explains that per-preset selection needs presets.

`GET /preferences` answers `{ ok, preferences: { sidebarEntry } }` from
`preferences.json` — never an error for a missing or damaged file, which mean the defaults. The
`PUT` body must be a JSON object with a boolean `sidebarEntry`; unknown extra keys are ignored, and a
missing or non-boolean value is `400 invalid-preferences` and writes nothing (a non-object body is
`400 invalid-body`, malformed JSON `400 invalid-json`). The write goes through the store's serialized
queue and is awaited before the response, and the client applies the answered value rather than the
requested one. The preference is shared per `$DSH_HOME`, not per browser.

The three external routes answer the payload
`{ ok, scannedAt, presets: [{ id, name, hasPresetMcp, servers: [{ name, discoveredAt, tools }] }] }`
(§[Other MCP](#other-mcp-preset-owned)); `scannedAt` records the last scan (it is `null` only before
the controller's first scan). `PUT` validates with `400 invalid-body` / `400 invalid-preset` /
`400 invalid-tools` / `400 invalid-tool-name`; a missing external controller answers
`500 unavailable`; any other method under `/external*` falls through to `404 not-found`. None of
them accepts a preset's credentials and none writes preset YAML.

## Security

- **Same-origin JSON fence.** Every mutation must either carry no `Origin` (curl, tests) or an
  `Origin` whose authority equals the `Host` the request arrived on. A page on another site always
  announces its own origin, so a cross-site form post is refused with `403 cross-origin`. For
  body-bearing mutations the JSON content-type requirement is the second half of the fence: a
  cross-origin HTML form cannot set it. Behind a reverse proxy the proxy must preserve the original
  `Host` header, otherwise writes are refused as cross-origin.
- **Body cap.** `readBody` stops at 64 KiB and answers `413 body-too-large`; the connection is
  destroyed rather than draining an unbounded upload. The icon upload passes a 1 MiB limit for its
  base64 envelope and then enforces 512 KiB on the decoded bytes, so a large image costs at most one
  bounded read plus one bounded decode.
- **Icon handling.** Auto icons are fetched by the Host with the server's own headers/OAuth, so an
  icon URL can see exactly the credentials the server already sees; the fetch is bounded by 5 s,
  512 KiB and a four-type raster allowlist, and the result is served back only to the same-origin
  panel. Uploads are decoded, magic-byte-checked and written as one `0600` file under `icons/`;
  SVG is rejected because a same-origin `image/svg+xml` document can execute script. Image answers
  carry `nosniff` and `Cache-Control: private, max-age=300`, never the JSON `no-store` policy.
- **Approval is delegated, not simulated.** A tool marked **需要审批** only asks the Host's approval
  service; with no service the call is denied. Approval never elevates the session's permissions and
  creates no plugin-owned policy that a later call could reuse.
- **External MCP stays external.** The preset-owned controller never reads, writes or starts a
  preset's MCP connection and never touches its YAML or credentials. It operates on the Agent's
  runtime tool registry only: discover inherited names, remove them with a restriction, and add an
  approval ask through the Host's `tools/pre-execute` policy. Its file holds descriptors and
  deviations, never secrets.
- **Secret handling.** Custom header values, an OAuth bearer token and a `client_credentials` secret
  are stored as plaintext in `servers.json` (mode `0600`). They are never written to logs, never
  echoed in a status error, and the OAuth token/client-secret inputs render as password fields. The
  API returns stored values to the same-origin panel because it must round-trip an edit; it is not a
  public API, and a custom header value is shown as configured because the panel cannot know which
  header is secret.
- **No shell interpolation.** stdio servers are spawned from `command` + `args` as an argv array;
  the plugin never builds a shell string from user input.
- **No filesystem writes outside the data directory.** No profile patch, no preset YAML, no session
  files. `test/mount-check.mjs` audits the shipped sources for stray paths.
- **Response hygiene.** Every JSON response is sent with `cache-control: no-store` and
  `x-content-type-options: nosniff`.

The fence is a browser-trust guard, not a process boundary: a local process that can reach the
loopback port could also edit `servers.json` directly. The Harness's own web authentication is the
outer boundary.

## Client half

`lib/client.js` is a browser module loaded by the Web shell. The two surfaces it registers are
described in
[Native plugin row settings page and the sidebar module](#native-plugin-row-settings-page-and-the-sidebar-module);
the rest of the component:

- always registers one slot, `plugins.row.config` (`key: '@ds-hu/dsh-better-mcp-manager#dsh-better-mcp-manager'`,
  `locale: 'mcpManager'`) rendering `MCPManagerModulePage`, and — only while the Host preference says
  so — the `sidebar.panellist` entry (`id: 'mcp-manager'`, `order: 20`) and the `main` slot page
  (`key: 'mcp-manager'`). There is no `settings.section` registration;
- polls `GET /servers` every 2.5 s while a manager view is mounted, and immediately after each
  mutation, so a connection that drops updates without a manual refresh;
- renders the manager on the plugin settings page in its embedded presentation
  (`data-mode="module"`: no full-page scroll container, no initial focus grab, the sidebar-entry
  switch card before the compact section head) or as the full sidebar page (`data-mode="panel"`),
  from the same component;
- renders the main page as two level-1 tabs, **本插件 MCP** (`page-tab-owned`) and **其他 MCP**
  (`page-tab-external`); the owned tab keeps the header, add button, cards and form, while the
  external tab renders the preset-owned surface described in
  [Other MCP](#other-mcp-preset-owned) and hides the add button;
- renders the external tab as a compact list: intro caveat, **上次扫描：…** + **重新扫描**, one group
  per preset with the **预设自带** badge and tool count, a placeholder for a preset with an MCP
  client but no live session, and one clickable server card per discovered server
  (`external-server-card`, letter tile, name, **x/y 个工具已启用**, **发现于 …**, chevron). Tool
  descriptions and parameter chips are not expanded there;
- opens a per-server tool view from a card (`external-server-view`): back button (`external-back`),
  header with the server name and **{preset} · {presetId} · 预设自带**, a **工具列表** section with
  **已启用 x/y** (`external-count`), **全部开启**/**全部关闭**, full tool cards with description/
  parameter chips and per-tool **启用**/**需要审批** switches (approval disabled while the tool is
  disabled), the footer hint, **保存工具设置** (`external-save`) and inline saved/failed notices;
  saving stays in the view and **返回** returns to the list with refreshed meta. A dirty-gated
  **保存工具设置** is also available in the list footer. It never shows add/edit/delete/test/reconnect
  for external servers;
- renders the server cards grouped by `group` (ungrouped last, as **其他（未分组）**), each with an
  icon tile (the `iconUrl` image, falling back to the name's first letter when it fails to load),
  name, status dot and status line, and the `···` menu (编辑 / 测试连接 / 重新连接 / 启用或停用 /
  删除);
- shows errors inline with the first two lines of the message and a **详情** dialog with the detail;
- on the plugin settings page renders the sidebar-entry card (`sidebar-entry-row`, switch
  `sidebar-entry-toggle`) and applies `GET`/`PUT /preferences` as described in
  [Native plugin row settings page and the sidebar module](#native-plugin-row-settings-page-and-the-sidebar-module);
  the card is never rendered on the sidebar page;
- renders the add/edit form as two tabs, **基础设置** and **工具**: the basic tab has the enable
  switch, **服务器图标** preview with **上传图标** / **恢复自动** and color swatches — no emoji
  palette; group, name, transport segmented control, address or command/args/env, OAuth dialog,
  custom-header rows, preset exposure, save and delete. The tools tab lists the discovered tools with
  description, parameter chips, per-tool enable and **需要审批** switches, **全部开启**/**全部关闭**,
  **更新于 …** for a cached offline list, **保存工具设置** and inline saved/failed notices, and stays
  on the tab after a save;
- validates an icon file client-side (PNG/JPEG/WebP/GIF, ≤512 KiB) before uploading it as a data URL
  after the server record exists; a failed icon upload keeps the saved server and reports the
  reason;
- uses plugin instance-scoped `<style data-plugin-css>` and theme tokens only, and clears its timers
  and removes its stylesheet on dispose; the optional module's two slot registrations are disposed on
  toggle-off and on plugin dispose.

All copy comes from `ctx.locale.register('mcpManager', { zh, en })` inside `lib/client.js`; the
dictionaries are checked key-by-key by `test/client-smoke.mjs`. The `locale/en.json` and
`locale/zh.json` files are the plugin metadata that the Plugins page reads without activating the
plugin: `meta.title` is the bundle card title, the module row title and the row page title
(**MCP 管理** in Chinese, **MCP Manager** in English), and `meta.description` is the description under
both the card and the row. The switch label is **在侧边栏显示 MCP 管理入口** /
**Show MCP Manager in the sidebar**; the module page's section heading is **MCP 服务器** /
**MCP servers**.

Sanitized screenshots of the shipped UI live in `docs/screenshots/`: the
[plugin settings hero](screenshots/mcp-manager-plugin-settings.png), the
[optional sidebar module](screenshots/mcp-manager-sidebar.png), the
[mixed-state list](screenshots/mcp-manager-list.png), the
[preset-exposure form section](screenshots/mcp-manager-form-presets.png), the
[服务器图标 form row](screenshots/mcp-manager-form-icon.png), the
[工具 tab](screenshots/mcp-manager-form-tools.png), the
[其他 MCP compact list](screenshots/mcp-manager-external.png), the
[per-server external tool view](screenshots/mcp-manager-external-tools.png) and the
[连接错误 详情 dialog](screenshots/mcp-manager-error-detail.png). The plugin settings hero shows the
row's page with the switch card and the manager; the sidebar shot shows the optional module switched
on; the remaining manager shots show the same manager views. The README embeds the plugin settings
hero, the optional sidebar module, the list, the presets, the icon row, the tools tab and both
external views.

## Lifecycle and dispose

Mount ensures the data directory exists (mode `0700`) and starts no work for disabled servers; it
writes no store file and creates no `icons/` directory until the first save/upload. A connected
server's first tool discovery does write `toolCache` even without a user save, through the same
serialized store queue, and the first save on 其他 MCP or the first scan that discovers a tool
creates `external.json`. The Host half owns one prefix route, one store, one manager, one binder, the
icon/tool helpers and the preset-owned controller. Dispose runs in reverse, with bounded closes:

1. unregister the HTTP prefix route;
2. dispose the external controller: remove its five Host listeners, release every
   `tools.restrict` restriction, and wait for its load/persist queue;
3. release every `agent.ctx` tool registration and system-prompt section and clear the binder's
   bookkeeping;
4. await the startup load/converge chain so no half-initialised manager survives;
5. dispose every connection: bump the attempt generation, clear retry timers, close clients and
   transports (5 s cap each), drop cached tools, status and the in-memory icon cache;
6. wait for queued store writes (including a pending tool-cache refresh, external state write or
   preferences write) to land.

Dispose never deletes icon files, `external.json` or `preferences.json`: they belong to the store and survive a plugin
restart, exactly like the server records. Deleting a server/resetting its icon and saving external
tool settings (or deleting `external.json`) are the only things that change that state.

The agent-lifecycle listeners are removed by their own effect disposer, and the client half removes
its locale namespace, stylesheet, the `plugins.row.config` registration, the optional sidebar
row/page registrations and every timer on dispose. Disabling the plugin in the Plugin Manager is a
live operation with HMR enabled: the route disappears, the plugin's row page (and with it the
configure control) and — if it was on — the optional sidebar entry disappear in every open window,
and connections are closed. After a restart without the plugin, nothing of it runs.

## Uninstall

Removing the package leaves no residue in the profile: the bundle row and its patch layer disappear
with the bundle, no install scripts run, no services or timers are registered, and nothing is
written outside `$DSH_HOME/better-mcp-manager/`.

```bash
# 1. remove the bundle (any of the three routes)
dsh plugin --profile web remove @ds-hu/dsh-better-mcp-manager
#    or: Plugins page → the bundle → Remove
#    or: ask the agent, plugin_manager remove_bundle

# 2. delete the one data directory
#    (servers.json, external.json, preferences.json, per-tool settings and icons/)
node bin/mcp-manager.mjs clean --yes
#    or, when running the published package:
npx -y @ds-hu/dsh-better-mcp-manager clean --yes
```

`clean` **requires `--yes`** (missing it exits 2 without touching anything), refuses a path that is
not a `better-mcp-manager` data directory — unless it is exactly the `DSH_MCP_MANAGER_DATA_DIR`
override — and prints the path it removed. `status` (the default) prints the directory, its mode, the
schema version, the server count, one line per server, and the sidebar-entry module state
(`sidebar entry module: on` / `off (default)`); it exits 1 when the store is damaged.
`path` prints the directory. Neither read command writes anything, and none of them need the Host
running. The manual equivalent is `rm -rf "$DSH_HOME/better-mcp-manager"`.

**Verified on a throwaway profile** (not the production home): installing the packed tarball with
`dsh plugin --profile <t> add <tgz>` and booting it writes only the data directory when a server is
created (`0700` directory, `0600` file); `dsh plugin --profile <t> remove
@ds-hu/dsh-better-mcp-manager` removes the dependency, the `dsh.profile.bundles` row and the
`node_modules` entry itself, leaves no `.better*` residue in the profile, and the profile boots again
without a dangling-bundle error. `bin/mcp-manager.mjs clean --yes` then removes the data directory
including `icons/`, `external.json` and, when present, `preferences.json`. No install scripts run, no
service or timer is created, and `$DSH_HOME/storages` and `.plugin-manager` never carry this plugin's
name.

Two honest caveats:

1. **Open pages keep a dead plugin page and sidebar entry until the browser reloads.** The client
   unregisters its slots on dispose, but after the bundle is removed its code never loads again, so
   nothing runs to close the plugin's row page or a sidebar entry that a stale page remembers. Reload
   the page.
2. **Sessions built with MCP tools keep their history.** Tool calls that already happened remain in
   the transcript; the tools themselves are gone. Deleting and re-adding a server through the page
   allocates a new `key` (and therefore new tool names); restoring a backup of `servers.json` keeps
   the old keys, which is why the key is immutable within a record's life.

## Testing

```bash
npm run lint        # eslint over the shipped sources and tests
npm test            # the unit, mount-check and client-smoke suites
npm run test:pack   # the `npm pack --dry-run` audit
npm run check       # all of the above; the same gate prepublishOnly runs
npm run e2e         # isolated DSH instance + Playwright (opt-in, see below)
```

| Suite | What it proves |
|---|---|
| `test/model.test.mjs` | server-id/key allocation, validation and normalisation of every field (urls, headers, presets, icon/color/group/timeout, OAuth), `icon`/`toolOverrides`/`toolCache` dropped from every draft, stored icon narrowing, per-tool override normalisation and defaults, tool-cache build/narrowing, update freezing `id`/`key`/`createdAt`, tool-name derivation and collisions, `presetAllows` |
| `test/store.test.mjs` | data-dir resolution (including the override), empty-directory mount writes nothing, reload round-trip and list order, atomic mode-`0600` write with no temp left behind, serialized concurrent writes and `patch`, corrupt/unknown-shape quarantine, per-record drop, v1/v2→v3 migration without a read-time rewrite, write-error propagation; `preferences.json` defaults/round-trip/corrupt-tolerance/0600 shape and that `servers.json` stays schema v3 |
| `test/mcp.test.mjs` | OAuth `client_credentials` form/caching/refresh and its failure mapping, bearer/custom-header precedence, failure-code classification and stderr-tail detail, UTF-8 truncation, manager snapshots for unknown/disabled servers (`toolCount`/`enabledToolCount`), auto-icon selection/fetch/cache/failure-fallback |
| `test/presets.test.mjs` | `"all"` vs id-array exposure (including preset-less agents), disabled/disconnected/empty servers, per-tool enable filtering and all-disabled instruction suppression, rebinding without duplicate registrations, multi-server order, one instruction section per server and zero-tool skip, missing `tools`/`systemPrompt` services, preset-selected re-exposure, bindAll pruning, dispose, refresh coalescing |
| `test/api.test.mjs` | every route against mock `req`/`res`: envelopes and statuses, JSON content type, cross-origin fence, invalid JSON/drafts, 64 KiB rejection, create/update-in-place (frozen key)/delete/enable/reconnect, unsaved draft probe never stores, icon GET/304/404/POST/DELETE and their caps/validation, tools GET live/cached + PUT overrides/rebind/validation and cache write-through, external GET/scan/PUT payloads, deviations-only persistence and `invalid-preset`/`invalid-tools`/`invalid-tool-name`/`unavailable` errors, `GET`/`PUT /preferences` round-trip and `invalid-preferences` (missing field, non-boolean, non-object) plus its same-origin requirement, preset/agent read surfaces, group order, 404 and trailing-slash normalisation |
| `test/cli.test.mjs` | `path`/`status`/`clean` against throwaway homes and `DSH_MCP_MANAGER_DATA_DIR`: absence, count/enabled output, the `sidebar entry module: on` / `off (default)` line, damaged-store exit 1, `--yes` requirement, refusal of a foreign directory, unknown command/help exit codes |
| `test/index.test.mjs` | Host mount: the prefix route, agent-lifecycle listeners, tool-cache persistence hook, external controller startup and disposal are registered through effects (fake Cordis context) |
| `test/external.test.mjs` | the preset-owned controller: `external.json` normalisation (versions, caps, unsafe keys, invalid names), load/quarantine/atomic save, live-agent discovery and server/tool grouping, disabled-tool cache retention through a rescan, `restrict({deny})` compute/replace/release, approval `tools/pre-execute` conditions and full-access skip, `hasPresetMcp` placeholders, save/scan coalescing and payload shape |
| `test/projection.test.mjs` | MCP content projection (text, resource links, unsupported blocks, empty result), canonical output schema and tool-definition shape, `isError` rejection, spec-invalid results, image admission/fallback diagnostics (attachment service, model modality, malformed base64, attachment rejection), `structuredContent`, task-required refusal, approval gating (full access skip, allowed-once, rejected/cancelled/unavailable, missing services) |
| `test/mount-check.mjs` | patch row id = Host `name`, exports and `bin` resolve, locale metadata and icon present, no `@deepseek-ai/*` import in `lib/`/`bin/`, no profile/absolute-path writes, data-dir resolver, frozen constants (including the external schema version and caps), version `0.6.0` and the contract's "frozen for 0.6.0" line, and structural checks that the client registers `plugins.row.config` with a key equal to the package `name` + `#` + the first `cordis.patch.yml` insert row id, that it registers no `settings.section`/`settings.section.icon`, and that `sidebar.panellist`/`main` stay gated behind the preference |
| `test/client-smoke.mjs` | `lib/client.js` runs in a `vm` with a fake `window.__ModuleLoader__` + React: the default registration set is exactly one `plugins.row.config` entry with the locked key (no `main`, no `sidebar.panellist`, no `settings.section`/`.icon`), a `sidebarEntry: true` answer adds the sidebar module (three registrations), `setSidebarEntryPreference(true/false)` registers/unregisters it live and PUTs the right body, `MCPManagerModulePage` renders the one-line summary for `view: 'summary'` and the manager for `view: 'page'` (`data-mode="module"`, `module-summary`/`sidebar-entry-row`/`sidebar-entry-toggle` testids and new locale keys), the panel mode stays `data-mode="panel"` without the switch row, two page tabs (本插件 MCP / 其他 MCP) with the external compact server list, the per-server tool view hooks/testids and scan/save/badge copy, and no add/edit/delete/test controls, zh/en dictionaries cover the same non-empty keys, no foreign API paths or imports, the edit sheet has two tabs and the tools tab exposes the per-tool switches/save copy, the icon row exposes 上传图标 / 恢复自动 with no emoji palette, one owned `<style>` removed on dispose, every timer cleared |
| `test/package.mjs` | `npm pack --dry-run` audit: the `files` list covers every runtime artefact (bin/lib/locale/icon/docs/legal incl. the screenshot directory) and excludes tests/dev config; dependency and lifecycle-script rules |
| `test/e2e/run.mjs` | boot (fresh `web` profile + the real packed tarball in transient systemd scopes, authenticated URL), plugins-page entry (no sidebar MCP 管理 row by default, the native **插件** page lists the **MCP 管理** bundle, its module row opens the plugin settings page, the switch card is off by default and the manager renders `data-mode="module"` without console/page errors, first stdio server created there), optional sidebar module (switch on -> row directly below 自动化任务, `aria-checked=true`, `GET /preferences` and `preferences.json` updated, row survives a reload; switch off -> row gone and page falls back; on again for the rest of the run), CRUD (stdio + HTTP servers, live tool counts, wrong-port 连接失败 + 详情, edit-to-recover, enable round-trip, delete), icons (fixture-declared server icon renders in the card, the form has no emoji palette, an upload changes the card bytes, 恢复自动 returns to the server icon, deleting the server removes the stored file), tools (工具 tab lists live/cached descriptors, disabling removes the tool from a real model request's `tools[]`, re-enabling restores it, card counts change 2/2→1/2, 需要审批 persists then clears to `{}`), approvals (a restricted session shows the 等待审批 composer, the tool has not run while pending, 允许一次 executes it and the result reaches the model; a 完全权限 session runs the same tool with no composer), other MCP (a real preset mounts `foreign` through `@deepseek-ai/dsh-mcp-client`; after one live external-preset session `GET /external` reports the 预设自带 preset and server; the tab first shows a compact server card with the `2/2 个工具已启用` meta and no tool cards/params in the DOM; opening it shows the per-server tool view with both tool cards, descriptions and parameter chips; disabling one tool and saving stays in the view, and back shows the updated `1/2` meta; re-enabling restores it; an approval ask under a restricted preset is approved once and the tool result reaches the model; the same tool runs directly under 完全权限; settings reset to defaults; no add/edit/delete/test controls anywhere; the owned tab still works), scoping (fake OpenAI-compatible provider: `mcp__<key>__echo` present for a standard-preset session and absent for a minimal-preset session, plus a scripted tool-call round-trip), hygiene (cleanup of scopes/processes/files/ports, production MainPID/cgroup untouched) |

The unit suites are offline and finish in seconds; they need no Host. `test/e2e/fixture-selftest.mjs`
is a standalone check (21 checks) that drives the fixture MCP servers with the same
`@modelcontextprotocol/client` version the plugin depends on — run it directly after changing a
fixture or the SDK. The e2e fixtures live in `test/fixtures/`: a stdio MCP server with echo/fail
tools and instructions, a Streamable HTTP MCP server with add/echo/fail tools and instructions, an
external preset server (`foreign` with add/ping tools) mounted through `@deepseek-ai/dsh-mcp-client`
for the preset-owned scenario, and a fake OpenAI-compatible endpoint that records every request
(notably `tools[].function.name` and the messages) and can answer with a scripted tool call. The e2e
suite is the only one that boots DSH: it uses a fresh `$DSH_HOME` and profile under `/var/tmp`, runs
the runner, the test DSH and the fixtures in transient systemd scopes (`MemoryMax=1G` for the
runner/DSH, `256M` for the fixtures, `MemorySwapMax=0`), installs the real packed tarball, and never
touches the user's running instance or `/root/.dsh`. The fixture MCP servers declare icons (a
`data:` PNG over stdio, an HTTP URL over Streamable HTTP) and expose separate tools for the per-tool
checks; the approval scenarios switch a real session's permission preset and wait for the DSH
approval composer. On success it publishes nine sanitized screenshots to `docs/screenshots/`,
including `mcp-manager-plugin-settings.png` (the plugin settings hero) and
`mcp-manager-sidebar.png` (the optional module switched on); the retired
`mcp-manager-settings.png` is deleted by the run.
`--keep` leaves the scopes and the run directory for debugging; `--verbose` adds step logging. It is
opt-in — not part of `npm run check` — and needs Playwright with Chromium plus registry access for
the profile install. That isolation is a property of the test harness, not of the plugin.

## Failure modes

| Symptom | Likely cause | What the plugin does |
|---|---|---|
| Card says **连接失败**, code `connect-failed` | wrong URL, server down, TLS error | keeps the server saved, retries with backoff; detail has the transport error |
| code `auth-failed` | 401 from the MCP server, token endpoint refused, bad client credentials | error bubble; fix the OAuth settings or headers, reconnect |
| code `timeout` | a connection or token fetch exceeded its budget (20s connect, 15s token) | retrying / auth-failed as appropriate; `timeoutMs` only bounds tool calls, not retries |
| code `protocol` | endpoint speaks something that is not MCP, protocol version mismatch, SSE handshake failure | retrying; detail has the protocol error |
| code `invalid-config` | stored record cannot be used as configured (e.g. transport/command mismatch) | no connection attempt until edited |
| code `closed` | transport closed locally or remotely | retrying; a normal reconnect |
| No **MCP 管理** row in the sidebar | that row belongs to the optional sidebar module, off by default (fresh install) | open the plugin settings page (**插件** → **MCP 管理** card → **MCP 管理** module row → **配置 MCP 管理**) and switch **在侧边栏显示 MCP 管理入口** on; the preference is Host-side |
| No **MCP 管理** card, row or configure control in the Plugins page | the deployment composes no native Plugins page (`ui-plugin-manager`), the bundle is switched off (a row shows its page only while the bundle is on), or the Host half is not mounted | the shipped Web app composes the Plugins page; enable the bundle and check `GET /better-mcp-manager/api/health` answers. Without the Plugins page there is no default entry — enable the optional sidebar module instead |
| The sidebar switch is already on in another browser | the preference is Host-side and shared per `$DSH_HOME` | expected; there is no per-browser copy to diverge |
| Switching the module off while its page is open shows the Conversation | its `main` page registration is disposed live | expected fallback; reopen from the plugin settings page (or via the optional module once re-enabled) |
| `PUT /preferences` answers `400 invalid-preferences` | the JSON object has no boolean `sidebarEntry` (missing field or non-boolean) | send `{ "sidebarEntry": true }` or `{ "sidebarEntry": false }`; nothing is written on a rejected body. A non-object body answers `400 invalid-body` and malformed JSON `400 invalid-json` |
| The sidebar-entry switch shows a load/save error | `GET /preferences` or `PUT /preferences` failed (Host down, network) | the module stays off after a failed read and the live view keeps the last applied value after a failed save; the row reports the reason and retrying is safe |
| Tool absent in an agent | server disabled/failing, its preset list does not include this agent's preset, the tool is disabled in the **工具** tab, or the agent predates the server and has not been re-bound yet (saving the server again re-binds every live agent) | `GET /agents` lists each live agent's exposed servers and tool names |
| Approval-required tool runs without asking | the session's permission preset is exactly `danger-full-access` (完全权限) | by design: approval is skipped only there; other presets ask |
| Approval-required call fails without a composer | no approval service, no permission service, no agent/execution context, or the request was rejected/cancelled | the call is denied before the MCP server is contacted; the model gets a readable error |
| **工具** tab shows an old list | the server is disconnected and the tab is rendering `toolCache` (`更新于 …`) | reconnect or open the tab on a connected server; settings themselves are current |
| **保存工具设置** answers `404` | the server was deleted in another window | nothing is written; reload the page |
| **其他 MCP** tab is empty | no preset mounts `@deepseek-ai/dsh-mcp-client`, or discovery saw no external tools yet | open a session of such a preset, then press **重新扫描**; presets with an MCP client are listed with `hasPresetMcp` only after `inspectCompositions()` sees one |
| A preset in **其他 MCP** shows the placeholder instead of tools | it mounts an MCP client but has no live Agent yet, so `tools.view` cannot list inherited tools | the placeholder is correct: open one session using that preset, or rescan after one exists |
| An external tool is disabled on the page but a fresh session still advertises it | the per-preset settings were not saved, or the new Agent was created before the restrict recompute landed | press **保存工具设置**, then start a new session or rescan; only Agents of the owning preset are affected |
| An external **需要审批** tool is denied without a composer | the Host's approval policy is `never`, or the call has no approval channel/session | the ask is passed to the Host and denied by policy; the plugin cannot override `never` |
| External routes answer `500 unavailable` | the Host half mounted without a working external controller (older/corrupt state) | reload after fixing the data directory; discovery and settings are unavailable until it mounts |
| `400 invalid-tool-name` / `invalid-preset` on external save | the page sent a non-`mcp__` name, a tool name from another preset, or a preset id that disappeared | reload the page and reopen the tab; only names in that preset's discovered set are accepted |
| Card shows the name's first letter | server not connected, declares no `serverInfo.icons`, the icon URL failed its 5 s/512 KiB/raster checks, or the upload file is missing | draws the fallback letter; the next successful fetch or an upload replaces it |
| Icon upload answers `400 invalid-icon` | wrong data-URL shape, non-canonical base64, decoded bytes over 512 KiB, or bytes that do not match the declared raster type | nothing is stored; the page shows the reason and keeps the saved server |
| Icon GET answers `404 no-icon` | no upload and no usable auto icon | the page falls back to the first letter; never treated as a connection error |
| `403 cross-origin` on save | proxy rewrote `Host`, or a non-browser client sent a foreign `Origin` | preserve the original `Host`; browser writes need no header workaround |
| `413 body-too-large` | a draft over 64 KiB | reduce headers/args; drafts are small by design |
| `400` with `unknown-preset` | the preset checkbox roster went stale between page load and save | reload the page; the error lists the current preset ids |
| `405 method-not-allowed` | a state-changing verb other than `POST` used for enable/reconnect, or a verb the route does not support | the panel sends `POST`; scripts must use the documented method |
| Empty panel, no error | Host route not mounted (bundle disabled/missing) or data directory unreadable | `GET /better-mcp-manager/api/health` tells whether the Host half is up |
| Page shows old status | polling stopped (tab hidden/page unmounted) | the next mount fetches immediately; status is never cached |

MCP tool calls that fail after the tool was registered are tool-level errors inside the agent's
turn: the connection is retried in the background, and the model sees a readable tool error rather
than a silent success.

## What we did not build

- **MCP resources, resource templates, prompt templates and sampling.** The manager handles tools
  and server instructions only. A server that offers only resources has nothing to expose here (a
  `resource_link` or embedded resource returned *inside* a tool result is projected as text or a
  diagnostic, not managed as a resource).
- **MCP task-based tool execution.** A tool whose execution declares `taskSupport: "required"` is
  registered with a definition that fails the call with a clear message; the manager does not run
  the MCP task protocol.
- **Per-tool policies beyond enable and approval.** A tool can be hidden and can ask for approval;
  there are no per-tool preset rules, per-tool timeouts, per-tool schemas or a plugin-owned allowlist.
  Approval delegates to the Host and never replaces its permission system.
- **OAuth authorization-code / PKCE flows.** Only a static bearer token and the client-credentials
  grant. A server that requires an interactive browser login cannot be connected here.
- **Built-in artwork or emoji icons.** The icon is either declared by the MCP server or uploaded by
  the operator (ADR 6). There is no emoji picker, no bundled icon set, no SVG upload, and no
  user-entered emoji string.
- **Per-agent or per-session icons.** An icon belongs to the server, not to the viewer or the
  session; every agent sees the same tile.
- **Importing, reading or migrating YAML-configured MCP servers.** `@deepseek-ai/dsh-mcp-client`
  rows in the profile keep working untouched and are never edited here. The **其他 MCP** tab may
  hide or gate their tools at runtime, but it never imports, owns or rewrites the rows, their
  connections or their credentials (ADR 2, ADR 8).
- **Managing preset-owned servers.** The external tab has no add/edit/delete/test/reconnect path,
  and the plugin never starts, stops or authenticates a preset's MCP connection.
- **Configuring the Host's approval policy.** For an external tool marked **需要审批** the plugin
  only emits an ask through `tools/pre-execute`; whether the ask can be displayed (for example with
  a `never` policy) is decided by DSH, not here.
- **Editing presets for the user.** The plugin reads the preset roster and registers tools on
  agents; it never creates or rewrites a preset.
- **Per-session exposure.** Exposure is decided per agent preset, not per session or per message.
- **A CRUD CLI.** `bin/mcp-manager.mjs` is maintenance only (`status`, `path`, `clean`); server
  management is the manager page and its HTTP API.
- **Per-browser UI preferences.** The sidebar-entry choice is a Host-side document shared per
  `$DSH_HOME`; there is no `localStorage` mirror and no per-browser override. A second browser sees
  the same choice, which is deliberate.
- **A second manager for the sidebar.** Both surfaces render the same component; there is no
  sidebar-specific page implementation to keep in sync. The native plugin row settings page is not
  optional — only the sidebar module is.
- **A generic Settings fallback.** A deployment that composes no native Plugins page gets no default
  entry; registering the old `settings.section` alongside `plugins.row.config` was rejected (ADR 10)
  rather than kept as a fallback, so there is one canonical page per plugin.
- **Custom placement of the entries.** The plugin page entry is owned by the Plugins page; the
  optional sidebar row is order `20`. Neither is user-configurable, exactly like the old sidebar
  position.
- **Tool-level permission mapping.** The manager adds no sandbox of its own: a tool call is
  dispatched to the connected server, and the Host's own tool-execution and permission path decides
  what is allowed. The one exception is the external **需要审批** ask, which is delegated to the
  Host's approval pipeline rather than enforced locally. A stdio server runs as a child of the Host,
  with the Host user's privileges.
- **Multiple connections per server, load balancing or health probing beyond the one supervisor.**
  One enabled server means one connection.
