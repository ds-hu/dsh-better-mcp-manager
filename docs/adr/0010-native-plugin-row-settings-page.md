# 10. The manager's default entry is the native plugin row settings page

Date: 2026-11-19
Status: accepted

Supersedes [ADR 9](0009-settings-entry-with-optional-sidebar-module.md), which superseded
[ADR 1](0001-sidebar-panel-entry.md).

## Context

0.5.0 moved the default entry from the sidebar into a generic DSH **Settings** section
(`settings.section`, `settings.section.icon`, id `mcp-manager`, order 30). That solved discoverability
but chose the wrong surface. A Settings section is a Harness-wide configuration entry: it is not the
plugin's own page, it does not open from the plugin's card in the Plugins page, and it carries none of
the plugin's identity, title, icon or lifecycle. DSH already has the native mechanism for a plugin's
own configuration: the Plugins page (the shipped `@deepseek-ai/dsh-client-ui-plugin-manager`) renders
one page per bundle and one page per module row, and a bundle registers its configuration through the
`plugins.row.config` slot, keyed by `<package name>#<row id>`. That is the mechanism
`@ds-hu/dsh-better-workspaces` uses for its feature rows. A user configuring a plugin starts from the
plugin, so the entry belongs there:

- sidebar **插件** → the **MCP 管理** plugin card → the bundle detail page → the **MCP 管理** module
  row → the configure control (**配置 MCP 管理** / *Configure MCP Manager*) or the row name → the
  row's settings page.

The 0.6.0 requirement was therefore to put the manager on that native page, remove the generic
Settings registration, and keep everything else — the manager UI, the optional sidebar module and its
Host-side preference — intact. The constraints from ADR 9 stay in force: a fresh install adds no
sidebar row; the sidebar entry is an independent, optional, live-switchable module; the preference is
Host-side in the plugin's own data directory; no MCP behavior changes.

The page's owner props are `{ view: 'summary' | 'page', form? }`. The Plugins page draws the page
title, icon and breadcrumb itself; the contribution renders the body. It renders `view: 'summary'`
for a one-liner when the row has no description, and `view: 'page'` — the page the configure control
opens. `form` is supplied only for entries that declare editable configuration fields; this row does
not, so the component ignores it. A bundle that is switched off contributes no client module, so its
row has no configure control; the registration's lifetime is the bundle's client lifetime, not a
separate preference.

## Decision

**1. The only always-registered surface is `plugins.row.config`.**
`lib/client.js` registers exactly one client slot at apply time:

```js
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@ds-hu/dsh-better-mcp-manager#dsh-better-mcp-manager',
  locale: 'mcpManager',
}, MCPManagerModulePage));
```

The key is the bundle package name plus `#` plus the row id declared in `cordis.patch.yml`. Both parts
are constants in the client (`BUNDLE_NAME`, `ROW_ID`, `ROW_CONFIG_KEY`) and are parity-checked against
the manifest and the patch by `test/mount-check.mjs`, so a rename cannot silently orphan the page.
There is no `settings.section` or `settings.section.icon` registration anywhere.

**2. The row settings page contains the switch and the full manager.**
`MCPManagerModulePage` renders the one-line summary for `view: 'summary'` (管理 MCP 服务器、工具暴露与
Agent 预设授权。/ *Manage MCP servers, tool exposure and agent-preset access.*) and, for
`view: 'page'`, the existing manager component in its embedded presentation: root
`data-mode="module"` (no fixed-viewport scroll container, no initial focus grab, transparent
background), a switch card first, then a compact **MCP 服务器** / **MCP servers** heading with the
server count subtitle, version tag and **添加 MCP** button, followed by the unchanged 本插件 MCP /
其他 MCP tabs, cards, forms, tool settings, approval and external-MCP views.

**3. The switch lives on the plugin settings page only.**
The row card contains the `role="switch"` control labelled **在侧边栏显示 MCP 管理入口** /
**Show MCP Manager in the sidebar**, off by default, disabled while the initial preference read or a
write is in flight, with an inline error when either fails. The optional sidebar page does not render
the switch. The hint text says the plugin settings page entry is always available.

**4. The optional sidebar module is unchanged.**
Only while the Host preference `sidebarEntry` is true does the client register `sidebar.panellist`
(id `mcp-manager`, order `20`, directly below 自动化任务) plus the matching `main` page
(key `mcp-manager`), and dispose both live when the preference turns false. That page keeps the
full-page presentation (`data-mode="panel"`, own `h1` title, no switch row). The preference remains
Host-side: `$DSH_HOME/better-mcp-manager/preferences.json` (schema `{ "version": 1, "sidebarEntry":
false }`), read and written through `GET`/`PUT /better-mcp-manager/api/preferences`, removed by the
`clean` CLI; it is never mirrored into `localStorage` or a profile file. The CLI `status` still prints
`sidebar entry module: on` / `off (default)`.

**5. The page needs DSH's native Plugins page; there is no fallback.**
The default entry requires the shipped Web app's Plugins page (`ui-plugin-manager`). A deployment that
composes no Plugins page has no default entry at all; if the optional sidebar module is enabled it
still opens the manager on its own page. Deliberately **not** provided: registering the old generic
`settings.section` as a fallback — two default entries with different owners would drift and would
break the "one native page per plugin" model.

## Consequences

- **The manager opens where a plugin's configuration belongs.** The route from the plugin card to the
  row page is the same one users know from other DSH plugins; the page has the plugin's title and
  description, and the row's own configure control.
- **Deployment requirement documented.** README, CONTEXT and TECHNICAL state that the native Plugins
  page is required and that the optional sidebar module is the only fallback. A deployment without
  `ui-plugin-manager` is a documented limitation, not a plugin bug.
- **Row identity parity is guarded.** The row config key, the manifest `name` and the
  `cordis.patch.yml` row id must agree; `test/mount-check.mjs` parses both files and fails on drift.
  The client-smoke suite asserts the default registration set is exactly the one row config entry and
  that no settings-section registration exists.
- **Lifecycle follows the bundle.** The page exists while the bundle's client module is loaded; a
  switched-off bundle shows no configure control. The switch registration/unregistration for the
  optional sidebar module remains dynamic and unchanged, and plugin dispose clears it.
- **The frozen contract moves to 0.6.0.** `API-CONTRACT.md` §5 now specifies the row config surface,
  the summary/page contract and the module-page contents; the e2e run drives the Plugins page route
  and publishes `docs/screenshots/mcp-manager-plugin-settings.png` as the hero (the old Settings
  screenshot is retired).
- **No MCP behavior changes.** Server records, connections, tools, preset exposure, approval, OAuth,
  icons, the external MCP tab, `servers.json` (schema version 3), `external.json` and
  `preferences.json` are untouched.
- **Costs:** one slot instead of two, one fewer registration lifecycle to test, but a dependency on a
  second shipped client package and a plugin-page route that the e2e run must learn.
- **Alternatives rejected:**
  - *Keep the generic `settings.section` (the 0.5.0 approach).* The explicit correction: it is not the
    plugin's own page, it does not open from the plugin's card, and it carries none of the plugin's
    identity; it also duplicates a mechanism DSH already provides for plugins.
  - *Register both surfaces (Settings section and plugin row page).* Two default entries for one
    manager drift in copy, state and tests, and users cannot tell which one is canonical.
  - *Use `plugins.bundle.config` instead of the row config.* That slot renders bundle-level
    configuration on the bundle page; the switch and the manager belong to the module row's own page,
    which is what the configure control opens.
  - *A client-only preference or a per-browser `localStorage` switch.* Already rejected in ADR 9: it
    diverges across browsers and profiles while the server list is shared per `$DSH_HOME`, and the
    Host/CLI could not report it.
  - *A separate manager implementation for the plugin page.* The same `MCPManagerPage` with an
    embedded presentation is what keeps one behavioral surface; a fork would drift.
