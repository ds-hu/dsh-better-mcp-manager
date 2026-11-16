# MCP Manager — technical notes

Everything the README deliberately leaves out. Read this before changing the store, the connection
manager, the preset binder or the HTTP surface. The frozen internal contract is
[docs/API-CONTRACT.md](API-CONTRACT.md); when this file and the contract disagree, the contract wins
and one of them is a bug.

- [Shape of the plugin](#shape-of-the-plugin)
- [Architecture](#architecture)
- [Connection manager](#connection-manager)
- [Result projection](#result-projection)
- [Data model](#data-model)
- [Icons](#icons)
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
| Client | `lib/client.js` (`window.__ModuleLoader__`, `id = '@ds-hu/dsh-better-mcp-manager'`) | the Web shell, via `package.json` → `dsh.client` | the Host over same-origin `/better-mcp-manager/api/*` |
| Cleanup CLI | `bin/mcp-manager.mjs` | the user, after removing the bundle | the data directory only |

The bundle patch inserts exactly one row, and its `id` equals the `name` exported by
`lib/index.js`; `test/mount-check.mjs` guards that parity. The plugin publishes no Cordis service
and inserts no other rows, so it sits loose in the Host root realm.

The Host half never writes `cordis.patch.yml`, never mounts Loader rows, never edits agent-preset
YAML, and imports no `@deepseek-ai/*` module. Everything the user configures lives in one JSON file
plus at most one icon file per server under `$DSH_HOME/better-mcp-manager/`. The only runtime
dependency is `@modelcontextprotocol/client` (2.2.0, MIT) for the MCP wire protocol.
See [ADR 2](adr/0002-own-mcp-connection-manager.md),
[ADR 5](adr/0005-hand-built-tool-definition.md) and
[ADR 6](adr/0006-server-and-upload-icons.md).

## Architecture

```
Host (lib/index.js)
├── store ........ servers.json: load, validate, atomic save (schema v2)
├── manager ...... one connection supervisor per enabled server + auto-icon fetch/cache
├── binder ....... registers the allowed servers' tools on each live agent
├── icons ........ uploaded-icon decoding, raster checks, icons/ storage (0600)
├── api .......... /better-mcp-manager/api/* (one prefix route, incl. icon endpoints)
└── dispose ...... close connections, release agent registrations, unregister route
```

Mounting the Host half:

`apply` builds the store, connection manager, exposure controller and API, then:

1. starts loading `servers.json` (the load ensures the data directory exists in mode `0700`; a missing
   file is an empty store; a file that is not JSON or has an unknown shape/version is quarantined as
   `servers.json.corrupt-<iso>` and the store starts empty, while individually malformed records are
   dropped and their valid siblings kept; schema-version-1 icons migrate in memory);
2. registers the HTTP prefix route and the `agent/created` / `agent/disposed` /
   `agent-preset/selected` listeners synchronously as effects;
3. converges in the background once loading finishes: one supervisor per **enabled** server, then a
   bind of every live agent; a later-mounting `agents` service gets its own bind sweep through
   `ctx.inject(['agents'])`.

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

## Connection manager

`lib/mcp.js` owns one supervisor per server. Its public surface for the rest of the Host is
deliberately small: start, stop, reconfigure, status, cached tools, cached instructions, resolve the
automatic icon, and `callTool(rawName, args, execution)`.

**States.** The supervisor's own values are `disabled`, `connecting`, `connected` and `error`; while
an `error` server is waiting for its next attempt, `nextRetryAt` is set, which the page presents as
**重连中**. Each snapshot also carries `attempts`, `connectedAt`, `lastAttemptAt`, `nextRetryAt` and
the last `error` (`{ code, message, detail, at }`). The state is derived, never stored.

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
  supervisor re-adopts and re-exposes every live agent. A refresh error keeps the previous set, and
  a public-name collision keeps the first tool and logs a warning.
- **Disable** — stop retrying, close the transport, drop cached tools, remove the server's tools and
  instructions from every live agent, status becomes `disabled`.
- **Delete** — same as disable, then the record is removed from the store.
- **Dispose** — close every client/transport with a 5s budget, clear every timer, drop all state.

A save only restarts the connection when the **connection configuration** changed: transport, URL,
command, args, env, cwd, headers or OAuth. Renaming, regrouping, changing the icon, changing the
timeout, or changing preset exposure updates the record (and re-binds agents) without dropping the
socket.

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

There is no authorization-code flow in 0.2.0. See [ADR 2](adr/0002-own-mcp-connection-manager.md).

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

One JSON file plus an icon directory under `$DSH_HOME/better-mcp-manager/`; the directory is mode
`0700`, `servers.json` is mode `0600`, and uploaded icons live in `icons/` (mode `0700`, each file
`0600`). Creating the store ensures the data directory exists (mode `0700`) on mount; `servers.json`
appears on the first save, `icons/` on the first upload, and mounting without configuring writes no
file.

The resolver understands one test/scratch override: `DSH_MCP_MANAGER_DATA_DIR` (absolute path) wins
over `$DSH_HOME`; without either, the directory is `~/.dsh/better-mcp-manager`. The directory is
**per DSH home, not per profile**: two profiles under the same `$DSH_HOME` share one server list.
Each Host process that mounts the plugin keeps its own connections against that shared list and
neither instance coordinates with the other beyond the atomic file replace. The Host and the
`bin/mcp-manager.mjs` CLI use the same resolver, so `clean` and `status` always target the directory
the Host would use for the same environment. `test/mount-check.mjs` asserts the default resolution
and the override.

```jsonc
{ "version": 2, "servers": [{
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
| `color` from a fixed palette, `group` ≤60 chars | UI storage, not semantics |
| `timeoutMs` integer 1000..600000, `enabled` boolean | one call cannot hang forever |
| unknown fields are dropped | forward compatibility is explicit |

Drafts are normalised into a stored record; the Host allocates `id`/`key` and timestamps. An
edit replaces the record but **never** the key. Live status is joined into API responses and never
written back.

Writes are atomic and serialized: a snapshot is JSON-stringified, written to a uniquely named
temporary file in the same directory with mode `0600`, then `rename`d over `servers.json` (the mode
is re-applied afterwards in case the rename target already existed). Reads accept schema `version` 1
or 2. A version-1 file (emoji-string icons) is migrated **in memory** on load — every legacy string
becomes `{ "kind": "auto" }` — and rewritten as version 2 by the next save; reads never rewrite the
file. A version-2 icon that does not match the stored shape is reset to `auto` for that record, and
the record is kept. A file that is not JSON or has an unknown shape/version moves aside as
`servers.json.corrupt-<iso>` and the store starts empty; a record whose identity fields are malformed
is dropped individually and the remaining valid records are kept, with a warning in the Host log. A
bad file therefore cannot keep the Host from booting.

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
instructions rewrites only its own section. Only servers whose tools are actually exposed contribute
prompt text: a connected server with zero discovered tools contributes no instructions. The injected
text is capped at 32,768 UTF-8 bytes (cut on a code-point boundary); the status reports the server's
original byte count. Sections are added and removed with the tool registrations, so an agent never
keeps instructions for a server it cannot call. See
[ADR 3](adr/0003-preset-scoped-tool-registration.md).

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
API never executes MCP tools. Tool permissions, sandboxing and approval remain the Host's, decided
for the agent that calls the tool; the manager does not run a second permission system.

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
| `GET` | `/servers/:id/icon` | the current icon as image bytes; `404` when there is none |
| `POST` | `/servers/:id/icon` | upload a `data:` URL, store it and set `icon.kind = "upload"` |
| `DELETE` | `/servers/:id/icon` | delete the stored file and reset `icon = { kind: "auto" }` |
| `GET` | `/presets` | agent-preset roster |
| `GET` | `/agents` | live exposure diagnostics |
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

`lib/client.js` is a browser module loaded by the Web shell. It:

- registers the `sidebar.panellist` entry (`id: 'mcp-manager'`, `order: 20`, localized label) and the
  `main` slot page (`key: 'mcp-manager'`);
- polls `GET /servers` every 2.5 s while the page is mounted, and immediately after each mutation,
  so a connection that drops updates without a manual refresh;
- renders the server cards grouped by `group` (ungrouped last, as **其他（未分组）**), each with an
  icon tile (the `iconUrl` image, falling back to the name's first letter when it fails to load),
  name, status dot and status line, and the `···` menu (编辑 / 测试连接 / 重新连接 / 启用或停用 /
  删除);
- shows errors inline with the first two lines of the message and a **详情** dialog with the detail;
- renders the add/edit form (enable switch, **服务器图标** preview with **上传图标** / **恢复自动**
  and color swatches — no emoji palette; group, name, transport segmented control, address or
  command/args/env, OAuth dialog, custom-header rows, preset exposure, save and delete) with inline
  validation and a saving state;
- validates an icon file client-side (PNG/JPEG/WebP/GIF, ≤512 KiB) before uploading it as a data URL
  after the server record exists; a failed icon upload keeps the saved server and reports the
  reason;
- uses plugin instance-scoped `<style data-plugin-css>` and theme tokens only, and clears its timers
  and removes its stylesheet on dispose.

All copy comes from `ctx.locale.register('mcpManager', { zh, en })` inside `lib/client.js`; the
dictionaries are checked key-by-key by `test/client-smoke.mjs`. The `locale/en.json` and
`locale/zh.json` files are the plugin-page metadata (title and description) that the Plugin Manager
reads without activating the plugin. The sidebar label and page title are **MCP 管理** in Chinese and
**MCP Manager** in English.

Sanitized screenshots of the shipped UI live in `docs/screenshots/`: the
[sidebar placement](screenshots/mcp-manager-sidebar.png), the
[mixed-state list](screenshots/mcp-manager-list.png), the
[preset-exposure form section](screenshots/mcp-manager-form-presets.png), the
[服务器图标 form row](screenshots/mcp-manager-form-icon.png) and the
[连接错误 详情 dialog](screenshots/mcp-manager-error-detail.png). The README embeds the first four.

## Lifecycle and dispose

Mount ensures the data directory exists (mode `0700`) and starts no work for disabled servers; it
writes no store file and creates no `icons/` directory until the first save/upload. The Host half
owns one prefix route, one store, one manager, one binder and the icon helpers. Dispose runs in
reverse, with bounded closes:

1. unregister the HTTP prefix route;
2. release every `agent.ctx` tool registration and system-prompt section and clear the binder's
   bookkeeping;
3. await the startup load/converge chain so no half-initialised manager survives;
4. dispose every connection: bump the attempt generation, clear retry timers, close clients and
   transports (5 s cap each), drop cached tools, status and the in-memory icon cache;
5. wait for queued store writes to land.

Dispose never deletes icon files: they belong to the store and survive a plugin restart, exactly
like the server records. Deleting a server or resetting its icon is the only thing that removes an
uploaded file.

The agent-lifecycle listeners are removed by their own effect disposer, and the client half removes
its locale namespace, stylesheet, slot registrations and every timer on dispose. Disabling the
plugin in the Plugin Manager is a live operation with HMR enabled: the route disappears, the
sidebar entry closes in every open window, and connections are closed. After a restart without the
plugin, nothing of it runs.

## Uninstall

Removing the package leaves no residue in the profile: the bundle row and its patch layer disappear
with the bundle, no install scripts run, no services or timers are registered, and nothing is
written outside `$DSH_HOME/better-mcp-manager/`.

```bash
# 1. remove the bundle (any of the three routes)
dsh plugin --profile web remove @ds-hu/dsh-better-mcp-manager
#    or: Plugins page → the bundle → Remove
#    or: ask the agent, plugin_manager remove_bundle

# 2. delete the one data directory (servers.json and icons/)
node bin/mcp-manager.mjs clean --yes
#    or, when running the published package:
npx -y @ds-hu/dsh-better-mcp-manager clean --yes
```

`clean` **requires `--yes`** (missing it exits 2 without touching anything), refuses a path that is
not a `better-mcp-manager` data directory — unless it is exactly the `DSH_MCP_MANAGER_DATA_DIR`
override — and prints the path it removed. `status` (the default) prints the directory, its mode, the
schema version, the server count and one line per server; it exits 1 when the store is damaged.
`path` prints the directory. Neither read command writes anything, and none of them need the Host
running. The manual equivalent is `rm -rf "$DSH_HOME/better-mcp-manager"`.

**Verified on a throwaway profile** (not the production home): installing the packed tarball with
`dsh plugin --profile <t> add <tgz>` and booting it writes only the data directory when a server is
created (`0700` directory, `0600` file); `dsh plugin --profile <t> remove
@ds-hu/dsh-better-mcp-manager` removes the dependency, the `dsh.profile.bundles` row and the
`node_modules` entry itself, leaves no `.better*` residue in the profile, and the profile boots again
without a dangling-bundle error. `bin/mcp-manager.mjs clean --yes` then removes the data directory
including `icons/`. No install scripts run, no service or timer is created, and `$DSH_HOME/storages`
and `.plugin-manager` never carry this plugin's name.

Two honest caveats:

1. **Open pages keep a dead sidebar entry until the browser reloads.** The client unregisters its
   slot on dispose, but after the bundle is removed its code never loads again, so nothing runs to
   close an entry that a stale page remembers. Reload the page.
2. **Sessions built with MCP tools keep their history.** Tool calls that already happened remain in
   the transcript; the tools themselves are gone. Deleting and re-adding a server through the page
   allocates a new `key` (and therefore new tool names); restoring a backup of `servers.json` keeps
   the old keys, which is why the key is immutable within a record's life.

## Testing

```bash
npm run lint        # eslint over the shipped sources and tests
npm test            # 147 unit tests + 24 mount checks + 24 client-smoke checks
npm run test:pack   # the 9-check `npm pack --dry-run` audit (36 files)
npm run check       # all of the above; the same gate prepublishOnly runs
npm run e2e         # isolated DSH instance + Playwright (opt-in, see below)
```

| Suite | What it proves |
|---|---|
| `test/model.test.mjs` | server-id/key allocation, validation and normalisation of every field (urls, headers, presets, icon/color/group/timeout, OAuth), `icon` dropped from every draft, stored icon narrowing, update freezing `id`/`key`/`createdAt`, tool-name derivation and collisions, `presetAllows` |
| `test/store.test.mjs` | data-dir resolution (including the override), empty-directory mount writes nothing, reload round-trip and list order, atomic mode-`0600` write with no temp left behind, serialized concurrent writes, corrupt/unknown-shape quarantine, per-record drop, v1→v2 icon migration without a read-time rewrite, write-error propagation |
| `test/mcp.test.mjs` | OAuth `client_credentials` form/caching/refresh and its failure mapping, bearer/custom-header precedence, failure-code classification and stderr-tail detail, UTF-8 truncation, manager snapshots for unknown/disabled servers, auto-icon selection/fetch/cache/failure-fallback |
| `test/presets.test.mjs` | `"all"` vs id-array exposure (including preset-less agents), disabled/disconnected/empty servers, rebinding without duplicate registrations, multi-server order, one instruction section per server and zero-tool skip, missing `tools`/`systemPrompt` services, preset-selected re-exposure, bindAll pruning, dispose, refresh coalescing |
| `test/api.test.mjs` | every route against mock `req`/`res`: envelopes and statuses, JSON content type, cross-origin fence, invalid JSON/drafts, 64 KiB rejection, create/update-in-place (frozen key)/delete/enable/reconnect, unsaved draft probe never stores, icon GET/304/404/POST/DELETE and their caps/validation, preset/agent read surfaces, group order, 404 and trailing-slash normalisation |
| `test/cli.test.mjs` | `path`/`status`/`clean` against throwaway homes and `DSH_MCP_MANAGER_DATA_DIR`: absence, count/enabled output, damaged-store exit 1, `--yes` requirement, refusal of a foreign directory, unknown command/help exit codes |
| `test/index.test.mjs` | Host mount: the prefix route, agent-lifecycle listeners and disposal are registered through effects (fake Cordis context) |
| `test/projection.test.mjs` | MCP content projection (text, resource links, unsupported blocks, empty result), canonical output schema and tool-definition shape, `isError` rejection, spec-invalid results, image admission/fallback diagnostics (attachment service, model modality, malformed base64, attachment rejection), `structuredContent`, task-required refusal |
| `test/mount-check.mjs` | patch row id = Host `name`, exports and `bin` resolve, locale metadata and icon present, no `@deepseek-ai/*` import in `lib/`/`bin/`, no profile/absolute-path writes, data-dir resolver, frozen constants |
| `test/client-smoke.mjs` | `lib/client.js` runs in a `vm` with a fake `window.__ModuleLoader__` + React: exactly the two slots and their ids/orders, zh/en dictionaries cover the same non-empty keys, no foreign API paths or imports, the icon row exposes 上传图标 / 恢复自动 with no emoji palette, one owned `<style>` removed on dispose, every timer cleared |
| `test/package.mjs` | `npm pack --dry-run` audit: the `files` list covers every runtime artefact (bin/lib/locale/icon/docs/legal incl. the screenshot directory) and excludes tests/dev config; dependency and lifecycle-script rules |
| `test/e2e/run.mjs` | 76 checks in about 2.5 minutes: boot (fresh `web` profile + the real packed tarball in transient systemd scopes, authenticated URL), bundle (sidebar row directly below 自动化任务, page opens without console/page errors), CRUD (stdio + HTTP servers, live tool counts, wrong-port 连接失败 + 详情, edit-to-recover, enable round-trip, delete), icons (fixture-declared server icon renders in the card, the form has no emoji palette, an upload changes the card bytes, 恢复自动 returns to the server icon, deleting the server removes the stored file), scoping (fake OpenAI-compatible provider: `mcp__<key>__echo` present for a standard-preset session and absent for a minimal-preset session, plus a scripted tool-call round-trip), hygiene (cleanup of scopes/processes/files/ports, production MainPID/cgroup untouched) |

The unit suites are offline and finish in seconds; they need no Host. `test/e2e/fixture-selftest.mjs`
is a standalone check that drives the fixture MCP servers with the same `@modelcontextprotocol/client`
version the plugin depends on — run it directly after changing a fixture or the SDK. The e2e fixtures
live in `test/fixtures/`: a stdio MCP server with echo/fail tools and instructions, a Streamable HTTP
MCP server with add/echo/fail tools and instructions, and a fake OpenAI-compatible endpoint that
records every request (notably `tools[].function.name` and the messages) and can answer with a scripted
tool call. The e2e suite is the only one that boots DSH: it uses a fresh `$DSH_HOME` and profile under
`/var/tmp`, runs the runner, the test DSH and the fixtures in transient systemd scopes (`MemoryMax=1G`
for the runner/DSH, `256M` for the fixtures, `MemorySwapMax=0`), installs the real packed tarball, and
never touches the user's running instance or `/root/.dsh`. The fixture MCP servers declare icons (a
`data:` PNG over stdio, an HTTP URL over Streamable HTTP), which is what the icon checks drive. On
success it publishes five sanitized screenshots to `docs/screenshots/`. `--keep` leaves the scopes and
the run directory for debugging; `--verbose` adds step logging. It is opt-in — not part of
`npm run check` — and needs Playwright with Chromium plus registry access for the profile install.
That isolation is a property of the test harness, not of the plugin.

## Failure modes

| Symptom | Likely cause | What the plugin does |
|---|---|---|
| Card says **连接失败**, code `connect-failed` | wrong URL, server down, TLS error | keeps the server saved, retries with backoff; detail has the transport error |
| code `auth-failed` | 401 from the MCP server, token endpoint refused, bad client credentials | error bubble; fix the OAuth settings or headers, reconnect |
| code `timeout` | a connection or token fetch exceeded its budget (20s connect, 15s token) | retrying / auth-failed as appropriate; `timeoutMs` only bounds tool calls, not retries |
| code `protocol` | endpoint speaks something that is not MCP, protocol version mismatch, SSE handshake failure | retrying; detail has the protocol error |
| code `invalid-config` | stored record cannot be used as configured (e.g. transport/command mismatch) | no connection attempt until edited |
| code `closed` | transport closed locally or remotely | retrying; a normal reconnect |
| Tool absent in an agent | server disabled/failing, its preset list does not include this agent's preset, or the agent predates the server and has not been re-bound yet (saving the server again re-binds every live agent) | `GET /agents` lists each live agent's exposed servers and tool names |
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

- **MCP resources, resource templates, prompt templates and sampling.** 0.2.0 manages tools and
  server instructions only. A server that offers only resources has nothing to expose here (a
  `resource_link` or embedded resource returned *inside* a tool result is projected as text or a
  diagnostic, not managed as a resource).
- **MCP task-based tool execution.** A tool whose execution declares `taskSupport: "required"` is
  registered with a definition that fails the call with a clear message; the manager does not run
  the MCP task protocol.
- **Per-tool enable/disable or per-tool preset rules.** Exposure is per server; the whole tool set
  follows the server.
- **OAuth authorization-code / PKCE flows.** Only a static bearer token and the client-credentials
  grant. A server that requires an interactive browser login cannot be connected in 0.2.0.
- **Built-in artwork or emoji icons.** The icon is either declared by the MCP server or uploaded by
  the operator (ADR 6). There is no emoji picker, no bundled icon set, no SVG upload, and no
  user-entered emoji string.
- **Per-agent or per-session icons.** An icon belongs to the server, not to the viewer or the
  session; every agent sees the same tile.
- **Importing, reading or migrating YAML-configured MCP servers.** `@deepseek-ai/dsh-mcp-client`
  rows in the profile keep working untouched and are not shown in the panel (ADR 2).
- **Editing presets for the user.** The plugin reads the preset roster and registers tools on
  agents; it never creates or rewrites a preset.
- **Per-session exposure.** Exposure is decided per agent preset, not per session or per message.
- **A CRUD CLI.** `bin/mcp-manager.mjs` is maintenance only (`status`, `path`, `clean`); server
  management is the Web page and its HTTP API.
- **Tool-level permission mapping.** The manager adds no approval layer and no sandbox of its own:
  a tool call is dispatched to the connected server, and the Host's own tool-execution and
  permission path decides what is allowed. A stdio server runs as a child of the Host, with the
  Host user's privileges.
- **Multiple connections per server, load balancing or health probing beyond the one supervisor.**
  One enabled server means one connection.
