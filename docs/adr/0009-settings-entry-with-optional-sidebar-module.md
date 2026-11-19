# 9. Settings is the default entry; the sidebar page is an optional module

Date: 2026-11-18
Status: superseded by [ADR 10](0010-native-plugin-row-settings-page.md)

Supersedes [ADR 1](0001-sidebar-panel-entry.md).

> **Superseded in 0.6.0.** The generic DSH **Settings** section described here was the wrong surface:
> it was not a plugin's own configuration page, so it did not follow the plugin from the Plugins page
> and carried none of the plugin page's identity or lifecycle. The default entry is now DSH's native
> **plugin row settings page** (`plugins.row.config`), and the generic Settings registration is gone.
> The optional sidebar module, its Host-side preference and everything else in this ADR remain in
> force; see [ADR 10](0010-native-plugin-row-settings-page.md).

## Context

ADR 1 put the manager in the sidebar as a global panel entry (`sidebar.panellist` + `main`), directly
below 自动化任务. That was the only entry: installing the bundle added a permanent sidebar row, and a
user who only needed to adjust a server had to give up the conversation area to do it.

DSH now has a stable Settings surface for exactly this kind of page. `settings.section` is a
root-scoped list slot: a feature registers one navigation entry (`id`, `order`, label thunk) plus a
matching `settings.section.icon` by the same `id`, and the Settings shell (`ui-settings-general`)
renders the entries in its navigation and the selected section in its content column. Opening Settings
is a modal operation, so the conversation stays in place behind it, and the shell owns close/Escape,
focus return and the narrow-viewport navigation strip. The entry is discoverable in the same place as
other configuration, which is what users expect for a settings page.

The 0.5.0 requirement was therefore the opposite of ADR 1's decision:

- the **default** entry is a DSH **Settings** section; a fresh install must add no sidebar row;
- the old sidebar row stays available, but as an **independent, optional module** that can be switched
  on and off **live** from inside the manager, with no page reload;
- the choice must **persist** for the installation, not for one browser tab: the same user opening the
  Web GUI in another browser — or another profile under the same `$DSH_HOME` — must see the same
  choice, because the server list itself is shared that way;
- the plugin's clean-uninstall property must hold: the choice lives in the plugin's own data
  directory, never in profile configuration files;
- **no MCP behavior changes**: server records, connections, tools, preset exposure, approval, OAuth,
  icons, the external MCP tab and the existing data documents stay exactly as they were.

DSH's slot ledger is dynamic — a slot registration is a disposer, and a contribution can be added or
removed while the page runs — so a live register/unregister is supported without reloading anything.
The Settings shell is a client package that the shipped Web app composes; a deployment can compose a
different shell or none, which is a limitation to document rather than a plugin bug.

## Decision

**1. The Settings section is the default entry and is always registered.**
`lib/client.js` registers `settings.section` with `id: 'mcp-manager'`, `order: 30`, locale
`mcpManager` and `label: () => t('panel')`, plus `settings.section.icon` with the same `id`/`order`.
The section renders the existing manager component in an embedded presentation
(`data-mode="settings"`: no full-page scroll container, no initial focus grab, the same
`mcp-page`/`mcp-list` test ids) inside the Settings content column. Registration does not depend on
the preference or on stored data.

**2. The sidebar entry becomes an independent optional module, off by default.**
Only while the preference is on does the client register `sidebar.panellist` (`id: 'mcp-manager'`,
`order: 20`, localized label) and the matching `main` page (`key: 'mcp-manager'`). The row keeps its
old position directly below 自动化任务 (order 10; Plugins is order 0). Turning the switch off disposes
both registrations immediately: the row disappears and, if its page is open, DSH falls back to the
Conversation. Both registrations are disposed again on plugin dispose.

**3. The choice is a Host-side preference in the plugin's own data directory.**
A new `preferences.json` in `$DSH_HOME/better-mcp-manager/` (schema version 1, mode `0600`, the same
atomic temp-file + `rename` and serialized write queue as the other documents):

```jsonc
{ "version": 1, "sidebarEntry": false }
```

A missing file means the default, off. A damaged or unknown-shape file is logged and reset to the
default; it is not a server store, so it does not get a quarantine file and the next write replaces
it. The Host exposes `GET`/`PUT /better-mcp-manager/api/preferences` with
`{ ok, preferences: { sidebarEntry } }`; a `PUT` body must be a JSON object with a boolean
`sidebarEntry` (unknown extras ignored), a missing/non-boolean value is `400 invalid-preferences`,
and a body that is not a JSON object fails earlier as `400 invalid-body`. The write is persisted
before the answer; the client applies the answered value, never the requested one. The `clean` CLI
removes the file with the directory.

**4. The switch lives in the manager, in Settings mode only.**
A row in the Settings-mode page (`sidebar-entry-row`) contains a `role="switch"` button
(`sidebar-entry-toggle`) labelled **在侧边栏显示 MCP 管理入口** / **Show MCP Manager in the sidebar**,
with a hint that the module is off by default and the Settings entry is always available. It is
disabled while the initial read or a write is in flight and reports load/save failures inline. The
sidebar page itself does not render the row.

**5. The preference is Host-side, not per browser.**
The client does not mirror it to `localStorage`, `sessionStorage` or a profile settings document. The
writing view applies the change immediately; every other browser or profile picks the choice up when
it loads the page, and every view under the same `$DSH_HOME` therefore converges on the same value.

## Consequences

- **A fresh install no longer touches the sidebar.** The only added entry is **MCP 管理** in Settings,
  which matches what a configuration page is expected to look like and keeps the conversation-first
  sidebar clean. Existing users can turn the old row back on in one click.
- **The sidebar row keeps its exact old position and behavior** when enabled: order `20`, directly
  below 自动化任务, same icon and label, full-page manager. The Settings section is the only required
  surface; the sidebar module is genuinely optional.
- **The preference is consistent across browsers and profiles**, because it is stored next to the
  shared server list rather than in a browser. That also means it is not per-viewer: one user turning
  the module on turns it on for every browser on this `$DSH_HOME` (at their next page load). This is
  documented, and the alternative — per-browser storage — was rejected for the inconsistency it
  would create with the rest of the plugin state.
- **Deployment requirement:** the Settings section needs the DSH Settings shell. The shipped Web app
  composes it; a deployment that composes no settings shell has no navigation entry for the section
  (the HTTP API and the optional sidebar page are unaffected). This is documented in the README,
  CONTEXT and TECHNICAL rather than worked around.
- **One component, two shells.** Both surfaces render the same `MCPManagerPage`; the Settings
  presentation is a wrapper (`data-mode="settings"`), not a fork. Two mounted views poll
  independently, and both follow the shared preference state. That keeps the feature surface small
  but means the client has two registration lifecycles to test.
- **Costs:** one more data document and its load/write/validation path, two API routes, a preference
  controller with a switch row, two dynamic slot registrations with live disposal, and client-smoke
  coverage for the default/enabled/toggled registration sets. The frozen contract moves to 0.5.0
  (`API-CONTRACT.md`), and the e2e run gains the Settings flow, the toggle round-trip and the two new
  screenshots.
- **No MCP behavior changes.** Servers, connections, tools, preset binding, approval, OAuth, icons,
  external MCP handling and `servers.json`/`external.json` are untouched; the new document is
  independent of them and `servers.json` remains schema version 3.
- **Alternatives rejected:**
  - *Keep the sidebar entry as the only entry.* It was the explicit request to replace, and a
    configuration page belongs in Settings.
  - *Register both entries unconditionally.* A permanent, duplicative sidebar row is exactly what the
    requirement removed; the row must be switchable.
  - *Per-browser `localStorage` for the sidebar entry.* It would diverge between browsers and
    profiles while the server list is shared per `$DSH_HOME`, and would vanish with browser data —
    inconsistent with a Host-owned plugin.
  - *Store the preference in the profile's settings document or another plugin's configuration.* The
    plugin's clean-uninstall rule is one owned data directory (ADR 4); the preference is plugin state,
    not deployment configuration, and profile composition is owned by the deployment.
  - *A separate manager implementation for the Settings section.* Two implementations would drift in
    copy, behavior and API use; reuse with an embedded presentation costs only layout CSS.
  - *Toggle the module without a Host API.* A client-only switch could not persist across reloads or
    browsers, and would make the CLI/Host unaware of the state.
  - *A Settings page without keeping the optional sidebar entry.* Existing users would lose the
    full-page workflow they had before 0.5.0; keeping it costs one gated registration.
