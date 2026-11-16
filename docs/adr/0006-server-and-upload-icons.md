# 6. Icons come from the MCP server or an operator upload, never from built-in artwork

Date: 2026-11-16
Status: accepted

## Context

0.1.0 gave each server a string `icon`, edited through a built-in emoji palette (plus a `color` for
the tile). That made every card look like the plugin, not like the server, and it shipped artwork
inside the plugin. The requirement for 0.2.0 is the opposite:

- **no built-in emoji icons** and no stock icon set;
- by default the card shows the icon the **MCP server declares** for itself;
- when the server declares none, show the **first letter of the server name**;
- let the operator **upload their own image** as an override.

The icon must also survive a clean uninstall: deleting the plugin's data directory must delete every
byte the plugin wrote, including uploaded images.

## Decision

The stored `icon` is a small discriminated object and nothing else:

```jsonc
{ "kind": "auto" }
{ "kind": "upload", "file": "srv_1f3c9a2b70.png", "mimeType": "image/png", "updatedAt": "…" }
```

**auto** reads `serverInfo.icons` from the MCP `initialize` result (MCP `Implementation.icons`). A
light or unthemed icon wins over a dark-only one; `src` may be a `data:` URI or an `http(s)` URL. For
HTTP(S) sources the **Host** fetches the bytes with that server's configured headers/OAuth, bounded
by 5 s, 512 KiB and a four-type raster allowlist, and caches them in memory for 10 minutes (failures
for 60 s). A missing, failed or invalid icon is not an error: the icon endpoint answers `404` and the
page draws the name's first letter.

**upload** is changed only through `POST /servers/:id/icon { dataUrl }` (1 MiB JSON envelope,
512 KiB decoded, canonical base64, magic-byte proof, PNG/JPEG/WebP/GIF) and
`DELETE /servers/:id/icon` (back to auto). Exactly one file lives at
`$DSH_HOME/better-mcp-manager/icons/<id>.<ext>` (directory `0700`, file `0600`, atomic replace, old
extension removed); replacing, resetting or deleting the server removes it. `GET
/servers/:id/icon` serves the bytes with a strong `ETag`, `304` support and
`Cache-Control: private, max-age=300`; `iconUrl` carries the version as a cache-buster.

An icon is **never accepted in a save draft**. `POST`/`PUT /servers` and every other draft path drop
the field, so a save can neither set nor clear an icon by accident, and image bytes never enter
`servers.json`. The store moves to schema version 2; a version-1 file keeps its emoji strings as
`{ "kind": "auto" }` in memory and is rewritten as version 2 by the next save. SVG is rejected on
purpose: a same-origin `image/svg+xml` document can execute script.

## Consequences

- **Cards reflect the server.** A server that declares an icon looks like itself without the operator
  configuring anything; the plugin ships no artwork beyond its own sidebar `icon.svg`.
- **The fallback is predictable and stateless.** No icon, a failed fetch or a dead upload all render
  the first letter; nothing about that decision is stored, and the next successful fetch or upload
  replaces it.
- **Uploads are owned bytes in an owned directory.** They sit inside the same data directory as
  `servers.json` (same `0700`/`0600` policy), so `clean --yes` removes them with everything else and
  no orphan files survive a replace.
- **Auto icons are best-effort.** They depend on the server advertising `serverInfo.icons` and, for
  HTTP sources, on the Host reaching that URL within 5 s / 512 KiB; a server behind an unreachable
  icon host simply shows a letter. The cache is memory-only, so a restart refetches.
- **Costs:** a second file type in the data directory, schema migration code, and an API that is not
  pure JSON (the GET answers image bytes). Browsers may cache an icon for up to 5 minutes; the
  `?v=` cache-buster makes a replacement visible immediately.
- **Alternatives rejected:** keeping the emoji picker (the explicit user requirement was no built-in
  emoji), a bundled icon library (artwork to maintain, and still not the server's identity), a
  free-text icon URL field (operator-hosted URLs complicate trust and the browser must not fetch
  cross-origin tiles), and storing data URLs in `servers.json` (bloats the atomic-write hot path and
  mixes binary data into the secrets file). Upload covers the "my own image" case without any of
  those.
