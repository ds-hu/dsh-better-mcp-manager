# 7. Per-tool enablement and restricted-mode approval

Date: 2026-11-16
Status: accepted

## Context

0.2.0 exposed every tool a connected server listed: exposing a server was all-or-nothing. That is
wrong for real MCP servers, which mix harmless read tools with destructive writers, and noisy tools
that waste model context. The requirement for 0.3.0 was:

- hide individual tools from every agent while keeping the rest of the server;
- mark individual tools so a call asks the user for permission — but not in sessions that already
  run with full access;
- keep the list manageable while the server is disconnected (no live `tools/list` available);
- never lose these choices on reconnect or restart.

The Host already has a permission system and an approval service. A plugin must not invent a second
one, and approval must never be granted silently when the Host cannot ask.

## Decision

Each stored server gains two fields (store schema version 3):

```jsonc
"toolOverrides": { "file_sharelink_set": { "approval": true }, "make_dir": { "enabled": false } },
"toolCache": { "at": "…", "tools": [{ "name", "publicName", "description", "params" }] }
```

`toolOverrides` is keyed by the **raw** MCP tool name and stores only deviations from the defaults:
`{enabled:false}` hides a tool, `{approval:true}` makes it ask. Anything that restates the defaults
is normalised away. The tools tab writes the batch through `PUT /servers/:id/tools`; save drafts
drop both fields, so an ordinary server save can neither re-enable a tool nor forge a default
override.

**Enablement is exposure.** A disabled tool is skipped by the preset binder and never registered on
any `agent.ctx`; it simply does not exist for the model. Discovery keeps running, so the tab and the
cache stay accurate. A server whose tools are all disabled contributes neither tools nor its
system-prompt instruction section — the model is not told about behavior it cannot use.

**Approval is a per-call Host decision.** `approval:true` means "ask in restricted modes". The tool
body reads the calling session's permission preset through the Host's `permissionPresets` service:
exactly `danger-full-access` (UI 完全权限) runs directly; every other preset asks the Host approval
service once. `allowed-once` proceeds; `rejected`, `cancelled` and `unavailable` fail the call; a
missing approval service, permission service, agent or execution context **denies** the call. The
MCP server is contacted only after approval. The request carries a human reason
(`MCP 工具 "mcp__<key>__<tool>" 需要审批（当前不是完全权限）`), and DSH renders it as its normal
等待审批 composer with 拒绝 / 允许一次.

**The cache is a convenience, not truth.** `toolCache` holds the last descriptors (raw name, public
name, description ≤2000 chars, parameter names/requiredness; ≤300 tools, ≤64 params each) and is
written through the serialized `store.patch` when a connected server's list changes or when the tab
reads a connected server. It carries no credentials, lets the tab render offline, and is explicitly
stale while disconnected. The tool list itself is still discovered from `tools/list`; nothing about
the MCP tool schema is user-editable here.

The page gets a second form tab, 基础设置 / 工具: per-tool cards with description, parameter chips,
enable and 需要审批 switches, 全部开启/全部关闭, 更新于 … for cached lists, and 保存工具设置. Saving
re-binds live agents and refreshes the card counts (`enabledToolCount / toolCount`).

## Consequences

- **Operators can trim a server without splitting it.** One connection, one preset exposure, but
  only the useful tools reach the model. Card counts make the effective surface visible.
- **Approval is a speed bump, not a sandbox.** It only runs when the operator asked for it, it
  delegates to the Host, and it never weakens the Host's permission rules. Restricted sessions ask
  every time; full-access sessions are deliberately not interrupted.
- **Offline management works with honest staleness.** The tab shows the last known descriptors and
  labels them; a reconnect or a tab read on a connected server refreshes them.
- **Costs:** two more fields per record, a schema-3 migration (v1/v2 loaded in memory, rewritten on
  the next save), one extra endpoint pair, and a binder that must filter per tool. Disabling a tool
  is not reversible from session history: the tool disappears from the model's list, and re-enabling
  re-binds live agents, so old transcripts keep calling what they already used.
- **Alternatives rejected:** disabling the whole server (too blunt), per-tool preset rules (the
  matrix explodes and duplicates preset exposure), a plugin-owned allow/deny policy (a second
  permission system the Host cannot audit), requiring approval for everything (noisy and it would
  bypass the point of 完全权限), and storing full tool schemas as configuration (they belong to the
  server and must not be forkable into stale local state).
