#!/usr/bin/env node
/**
 * E2E fixture supervisor: starts the two local HTTP fixtures in one process
 * tree so the runner can put them in a single systemd scope.
 *
 *   fake-llm.mjs          OpenAI-compatible endpoint + request recorder
 *   mcp-http-server.mjs   MCP Streamable HTTP server (3 tools)
 *
 * Prints one JSON line on stdout once both are listening:
 *   {"fakeLlm":{"port":N,"baseURL":"..."},"mcpHttp":{"port":N,"url":"..."}}
 *
 * Child stderr is forwarded to this process's stderr (prefix preserved).
 * SIGTERM/SIGINT stops both children and exits 0.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const children = [];
let stopping = false;

const args = process.argv.slice(2);
function argOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : undefined;
}
const FAKE_PORT = argOf('--fake-port');
const MCP_PORT = argOf('--mcp-port');

function start(script, scriptArgs = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, script), ...scriptArgs], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${script} did not report its port within 15s`));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0 || settled) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // keep waiting for the JSON line; other output is noise
      }
      settled = true;
      clearTimeout(timer);
      resolve(parsed);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${script} exited before reporting its port (code=${code}, signal=${signal})`));
      } else if (!stopping) {
        process.stderr.write(`[fixtures] ${script} exited unexpectedly (code=${code}, signal=${signal})\n`);
      }
    });
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 2000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));

try {
  const [fakeLlm, mcpHttp] = await Promise.all([
    start('fake-llm.mjs', FAKE_PORT === undefined ? [] : ['--port', FAKE_PORT]),
    start('mcp-http-server.mjs', MCP_PORT === undefined ? [] : ['--port', MCP_PORT]),
  ]);
  process.stdout.write(`${JSON.stringify({ fakeLlm, mcpHttp })}\n`);
} catch (error) {
  process.stderr.write(`[fixtures] startup failed: ${String(error)}\n`);
  stop(1);
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`[fixtures] uncaught: ${String(error)}\n`);
  stop(1);
});
