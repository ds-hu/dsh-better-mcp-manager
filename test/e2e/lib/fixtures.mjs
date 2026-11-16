/**
 * Local fixture endpoints for the E2E.
 *
 * `test/fixtures/serve.mjs` starts two dependency-free HTTP servers inside one
 * transient scope:
 *
 *   fake LLM        OpenAI-compatible `/v1/chat/completions` + `/v1/models`,
 *                   recording every request's `tools[].function.name` and
 *                   `messages`, with an `/__e2e/*` control surface.
 *   MCP HTTP        Streamable HTTP MCP server with three tools
 *                   (echo/add/fail), used by the plugin's HTTP transport.
 *
 * The stdio MCP fixture is not started here: the plugin spawns it as the
 * server command, exactly like a user-configured stdio server.
 */
import { join } from 'node:path';
import { startScoped } from './scope.mjs';
import { waitForJsonLine } from './util.mjs';

const HTTP_TIMEOUT_MS = 10_000;

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

export async function startFixtures({ repoRoot, runDir, runId, reporter }) {
  const unit = `mcp-e2e-${runId}-fixtures`;
  const logPath = join(runDir, 'logs', 'fixtures.log');
  const errPath = join(runDir, 'logs', 'fixtures.stderr.log');
  const handle = startScoped({
    unit,
    memoryMax: '256M',
    command: process.execPath,
    args: [join(repoRoot, 'test', 'fixtures', 'serve.mjs')],
    env: {},
    cwd: repoRoot,
    logPath,
    errPath,
  });

  let info;
  try {
    info = await waitForJsonLine(async () => undefined, logPath, { timeoutMs: 30_000, label: 'fixture ports' }).catch(async () => {
      const { readLog } = await import('./scope.mjs');
      const text = await readLog(logPath, 256 * 1024);
      const line = text.split('\n').find((candidate) => candidate.trim().startsWith('{'));
      if (line === undefined) throw new Error(`fixture supervisor did not report its ports:\n${text.slice(-2000)}`);
      return JSON.parse(line);
    });
  } catch (error) {
    await handle.stop().catch(() => {});
    throw error;
  }
  const fakeLlmPort = info?.fakeLlm?.port;
  const mcpPort = info?.mcpHttp?.port;
  if (!Number.isInteger(fakeLlmPort) || !Number.isInteger(mcpPort)) {
    await handle.stop().catch(() => {});
    throw new Error(`fixture supervisor reported invalid ports: ${JSON.stringify(info)}`);
  }
  const fakeBaseURL = `http://127.0.0.1:${fakeLlmPort}/v1`;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  await Promise.all([
    waitForJsonLine(async () => undefined, logPath, { timeoutMs: 1, label: 'noop' }).catch(() => undefined),
  ]).catch(() => {});

  const fixtures = {
    ...handle,
    fakeLlmPort,
    mcpPort,
    fakeBaseURL,
    mcpUrl,
    fakeOrigin: `http://127.0.0.1:${fakeLlmPort}`,
    async health() {
      return jsonFetch(`http://127.0.0.1:${fakeLlmPort}/__e2e/health`);
    },
    /** Replace marker rules; see test/fixtures/fake-llm.mjs for the shape. */
    async configure(config) {
      return jsonFetch(`http://127.0.0.1:${fakeLlmPort}/__e2e/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
    },
    async reset() {
      return jsonFetch(`http://127.0.0.1:${fakeLlmPort}/__e2e/reset`, { method: 'POST' });
    },
    async state() {
      return jsonFetch(`http://127.0.0.1:${fakeLlmPort}/__e2e/state`);
    },
  };

  // Readiness: the fake LLM must answer its own health endpoint.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fixtures.health();
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        await handle.stop().catch(() => {});
        throw new Error(`fake LLM fixture never became healthy: ${String(error)}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  reporter?.debug(`fixtures listening: fake LLM :${fakeLlmPort}, MCP HTTP :${mcpPort} (unit ${unit})`);
  return fixtures;
}

/** Absolute command/args that launch the stdio fixture from a server record. */
export function stdioFixtureSpec({ repoRoot }) {
  return {
    command: process.execPath,
    args: [join(repoRoot, 'test', 'fixtures', 'mcp-stdio-server.mjs')],
  };
}

/**
 * Requests recorded by the fake LLM whose `tools` array carries the marker's
 * exact public names. The marker text identifies which DSH session produced a
 * request even when several sessions are in flight.
 */
export function requestsForMarker(state, marker) {
  return (state?.requests ?? []).filter((request) => Array.isArray(request.userTexts) && request.userTexts.some((text) => text.includes(marker)) && Array.isArray(request.tools) && request.tools.length > 0);
}
