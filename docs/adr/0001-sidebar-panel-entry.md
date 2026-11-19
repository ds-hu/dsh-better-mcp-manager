# 1. MCP 管理 is a sidebar panel entry with a main page, directly under 自动化任务

Date: 2026-11-16
Status: superseded by [ADR 9](0009-settings-entry-with-optional-sidebar-module.md), then by
[ADR 10](0010-native-plugin-row-settings-page.md)

> **Superseded in 0.5.0.** The sidebar entry described here is no longer the only entry. This sidebar
> row became an independent optional module, off by default, configured by a Host-side preference, and
> the default entry moved to a DSH **Settings** section (always registered). The reasoning below is
> kept as history; [ADR 9](0009-settings-entry-with-optional-sidebar-module.md) records the decision
> that replaced it.

> **Superseded again in 0.6.0.** The generic Settings section from ADR 9 was replaced by DSH's native
> **plugin row settings page** (`plugins.row.config`), so the default entry is now reached from the
> Plugins page. The optional sidebar module described here is unchanged and still governed by the
> Host-side preference; see [ADR 10](0010-native-plugin-row-settings-page.md).

## Context

DSH offers several places to put a new surface: a `sidebar.panellist` entry that opens a page in
the `main` slot (the pattern **Plugins** and **自动化任务** use), a per-session right-sidebar tab,
a header button, or a settings sub-page. The MCP servers managed here are profile-wide: they do
not belong to one conversation, and the user asked for the entry *directly below* 自动化任务.

The positions are already fixed by the shipped clients: Plugins registers `order: 0`,
自动化任务 (`dsh-client-ui-schedule`) registers `order: 10`, and the sidebar sorts entries by
`order` ascending.

## Decision

Register a **global panel entry**, not a right-sidebar tab:

- `sidebar.panellist` registration with `id: 'mcp-manager'`, `order: 20`, `label: () => t('panel')`;
- `main` slot registration with `key: 'mcp-manager'` rendering the full management page.

No right-sidebar tab, no header button, no settings sub-page, no keyboard shortcut.

## Consequences

- **MCP 管理 appears immediately below 自动化任务** in the sidebar, above anything that registers a
  later order, because 自动化任务 is 10 and this plugin is 20. Order `20` is the contract; the
  label text comes from the locale dictionaries.
- The page is global: opening the panel does not depend on a session, a workspace or a selected
  agent preset. That matches the data, which is profile-wide.
- The full main area is used. There is no conversation next to the manager, which is fine because
  editing servers is not a conversational task — but it also means the page cannot be shown
  side-by-side with a chat by design.
- If a future plugin also picks `order: 20`, the sidebar's sort is stable but the visual position
  of the two entries is not guaranteed. Panel order is not user-configurable in 0.3.0.
