# 2. The plugin owns its MCP connections instead of Loader rows or a config editor

Date: 2026-11-16
Status: accepted

## Context

DSH already ships `@deepseek-ai/dsh-mcp-client`, which connects to MCP servers configured as
Loader rows in the profile patch. There were three ways to build a manager on top of it:

1. **Edit those Loader rows** through the Plugin Manager's config editor. Storage, reconnection
   and result projection would be inherited; the manager would be a configuration UI.
2. **Add a fixed tool plugin row per server** in the profile patch, mounted into every agent.
3. **Own the connection**: read the server list from a plugin-owned store and start an MCP client
   per enabled server inside this plugin.

Options 1 and 2 fail the requirements for the same reasons. Loader rows are static profile
configuration: adding or removing one is a profile write that outlives the plugin, needs a
reload or restart to take effect, and leaves an untangle-able pile of rows behind a "clean
uninstall". They also register tools on a fixed plugin scope, so every agent gets every server's
tools — the per-preset exposure that motivates the plugin cannot be expressed by a row.

## Decision

The Host half implements its own small MCP connection manager (`lib/mcp.js`) on top of
`@modelcontextprotocol/client`. The store is the only source of truth; mounting, editing,
enabling and deleting a server takes effect at runtime, and the plugin writes no Loader row and
no profile patch entry for a server.

## Consequences

- **Per-server, per-agent behavior is possible**: the connection exists once, its tools are
  registered on selected agents only (ADR 3), and status is reported per server.
- **No profile residue**: deleting a server is a store write, not a patch edit; removing the
  plugin leaves no rows behind (ADR 4).
- We reimplement what `dsh-mcp-client` already does — connect, initialize, list tools, project
  results, reconnect with backoff. That is deliberate duplication, bounded by adapting the
  established projection/connection behavior and keeping the surface smaller (one connection per
  server, no resources, no prompt templates in 0.3.0).
- The manager and the shipped `dsh-mcp-client` rows are independent. This plugin does not read,
  migrate or manage YAML-configured MCP servers; both can be installed at once.
- Tests must cover the protocol edges ourselves: tool-list changes, dropped connections, auth
  failures, result projection.
