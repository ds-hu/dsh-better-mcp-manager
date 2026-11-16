# 5. Tool definitions are hand-built; lib/ imports no @deepseek-ai package

Date: 2026-11-16
Status: accepted

## Context

A profile plugin is installed into a user's DSH profile and resolved with the profile's
`node_modules`: the package's own files, its declared dependencies, and the `@deepseek-ai/cordis`
peer supplied by the Harness. The Harness's internal packages (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-agent-preset`, …) are not resolvable from that profile, even though they are
installed inside the DSH installation. An `import '@deepseek-ai/dsh-tools'` in `lib/` would
therefore fail at load on a user's machine — after installation, when the plugin is mounted, which
is the worst moment to discover it.

The tool helper (`defineTool`) and the `ToolDefinition` type live in those packages. The alternative
to importing is to obtain the tool registry through the Cordis context (`ctx.tools`) and hand the
registry an ordinary object with the fields the contract requires.

## Decision

`lib/tool-definition.js` builds each `ToolDefinition` literally — `name`, `description`,
`inputSchema`, and the execute function — and registers it through the Host's tool service. It
imports nothing from `@deepseek-ai/*`. The MCP result projection (text / resource link / image or
unsupported-content diagnostic) follows the established behavior of
`@deepseek-ai/dsh-mcp-client`, adapted for this plugin's single-connection model and credited in
[NOTICE](../../NOTICE).

`test/mount-check.mjs` enforces the rule by scanning `lib/` for `@deepseek-ai/` imports; a violation
fails the test suite.

## Consequences

- **The package installs and loads in any stock profile** with only `@modelcontextprotocol/client`
  and the Cordis peer. No version coupling to internal Harness packages.
- **The definition shape is our responsibility.** If the Host's tool contract changes, a test
  checks the shape but a human must follow the Harness release. The definition is deliberately
  plain and small.
- **Results are projected the way the shipped MCP client projects them**, so the model sees MCP
  text, resource links and image diagnostics consistently across the two integrations, and session
  history keeps the same shape.
- The rule is coarse: it also forbids importing an `@deepseek-ai/*` package for a type-only
  reference. That is intentional — type imports still become runtime resolution problems once the
  source is published without a build step.
