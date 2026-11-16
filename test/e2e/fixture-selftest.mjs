#!/usr/bin/env node
/**
 * Standalone fixture check: drives `test/fixtures/` MCP servers with the real
 * `@modelcontextprotocol/client` version the plugin depends on (2.2.0), before
 * the plugin is involved. Run it whenever a fixture or the MCP SDK changes:
 *
 *   node test/e2e/fixture-selftest.mjs
 *
 * The client package is resolved from the installed DSH CLI (the same copy the
 * production instance uses); the plugin's profile install brings its own.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HTTP_ICON_PNG_BASE64,
  STDIO_DARK_ICON_PNG_BASE64,
  STDIO_ICON_PNG_BASE64,
  UPLOAD_ICON_A_PNG_BASE64,
  iconBytes,
} from '../fixtures/tiny-icons.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtures = join(repoRoot, 'test', 'fixtures');

function resolveMcpClient() {
  const candidates = [];
  for (const variable of ['MCP_CLIENT_DIR']) if (process.env[variable]) candidates.push(process.env[variable]);
  try {
    const dshBin = execFileSync('readlink', ['-f', execFileSync('which', ['dsh']).toString().trim()], {
      encoding: 'utf8',
    }).trim();
    candidates.push(join(dirname(dirname(dshBin)), 'node_modules', '@modelcontextprotocol', 'client'));
    candidates.push(join(dirname(dshBin), '..', 'node_modules', '@modelcontextprotocol', 'client'));
  } catch {
    // fall through to the known installation path
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@modelcontextprotocol/client');
  for (const directory of candidates) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pick = (condition) => {
      if (typeof condition === 'string') return condition;
      if (condition === null || typeof condition !== 'object') return undefined;
      return pick(condition.import) ?? pick(condition.default) ?? pick(condition.require);
    };
    const entry = pick(manifest?.exports?.['.']);
    const stdio = pick(manifest?.exports?.['./stdio']);
    if (typeof entry !== 'string' || typeof stdio !== 'string') continue;
    return {
      directory,
      version: manifest.version,
      index: pathToFileURL(join(directory, entry)).href,
      stdio: pathToFileURL(join(directory, stdio)).href,
    };
  }
  throw new Error('could not locate @modelcontextprotocol/client (set MCP_CLIENT_DIR to its package directory)');
}

function startFixture(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(fixtures, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MCP_FIXTURE_DEBUG: process.env.MCP_FIXTURE_DEBUG ?? '' },
    });
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`${script} did not report its port in 15s`)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve({ child, info: JSON.parse(buffer.slice(0, newline)) });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => reject(new Error(`${script} exited early (code=${code})`)));
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}

/** Minimal PNG sanity: signature, IHDR dimensions, non-empty IDAT. */
function pngInfo(bytes) {
  const signature = bytes.subarray(0, 8).toString('hex');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const valid = signature === '89504e470d0a1a0a' && width > 0 && height > 0 && bytes.includes(Buffer.from('IDAT'));
  return { valid, width, height, size: bytes.length };
}

function sameBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

const mcp = resolveMcpClient();
process.stdout.write(`using @modelcontextprotocol/client ${mcp.version} from ${mcp.directory}\n`);
const { Client, StreamableHTTPClientTransport } = await import(mcp.index);
const { StdioClientTransport } = await import(mcp.stdio);
const clientInfo = { name: 'mcp-e2e-fixture-selftest', version: '1.0.0' };

// ── stdio fixture ─────────────────────────────────────────────────────────
const stdioEnv = { ...process.env, MCP_FIXTURE_LABEL: 'selftest' };
const stdioClient = new Client(clientInfo, { capabilities: {} });
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(fixtures, 'mcp-stdio-server.mjs')],
  env: stdioEnv,
  stderr: 'pipe',
});
await stdioClient.connect(stdioTransport);
try {
  const tools = await stdioClient.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  check('stdio tools/list returns echo+fail', JSON.stringify(names) === JSON.stringify(['echo', 'fail']), names.join(','));
  const echo = await stdioClient.callTool({ name: 'echo', arguments: { text: 'fixture-self-test' } });
  const echoText = echo.content?.find((part) => part.type === 'text')?.text;
  check('stdio tools/call echo returns fixture text', echoText === 'echo: fixture-self-test', String(echoText));
  const fail = await stdioClient.callTool({ name: 'fail', arguments: { message: 'expected' } });
  check('stdio tools/call fail is an MCP error result', fail.isError === true, JSON.stringify(fail.content));
  const instructions = stdioClient.getInstructions();
  check('stdio initialize carries instructions', typeof instructions === 'string' && instructions.length > 0);
  const serverVersion = stdioClient.getServerVersion();
  const icons = serverVersion?.icons;
  check(
    'stdio initialize declares dark+light theme PNG icons, dark first',
    Array.isArray(icons) &&
      icons.length === 2 &&
      icons[0]?.theme === 'dark' &&
      icons[0]?.mimeType === 'image/png' &&
      icons[1]?.src === `data:image/png;base64,${STDIO_ICON_PNG_BASE64}` &&
      JSON.stringify(icons[1]?.sizes) === JSON.stringify(['16x16']),
    JSON.stringify(icons?.map((icon) => ({ theme: icon.theme, mimeType: icon.mimeType, sizes: icon.sizes })) ?? null),
  );
  const darkInfo = pngInfo(iconBytes(STDIO_DARK_ICON_PNG_BASE64));
  const lightInfo = pngInfo(iconBytes(STDIO_ICON_PNG_BASE64));
  check('stdio fixture icon payloads are valid 16x16 PNGs with different bytes', darkInfo.valid && lightInfo.valid && !sameBytes(STDIO_DARK_ICON_PNG_BASE64, STDIO_ICON_PNG_BASE64), `${darkInfo.width}x${darkInfo.height}/${darkInfo.size}B vs ${lightInfo.width}x${lightInfo.height}/${lightInfo.size}B`);
} finally {
  await stdioClient.close();
}

// ── streamable HTTP fixture ───────────────────────────────────────────────
const httpFixture = await startFixture('mcp-http-server.mjs', ['--port', '0']);
try {
  const httpClient = new Client(clientInfo, { capabilities: {} });
  const httpTransport = new StreamableHTTPClientTransport(new URL(httpFixture.info.url));
  await httpClient.connect(httpTransport);
  try {
    const tools = await httpClient.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    check('http tools/list returns add+echo+fail', JSON.stringify(names) === JSON.stringify(['add', 'echo', 'fail']), names.join(','));
    const echo = await httpClient.callTool({ name: 'echo', arguments: { text: 'http-fixture' } });
    check('http tools/call echo returns fixture text', echo.content?.[0]?.text === 'echo: http-fixture', String(echo.content?.[0]?.text));
    const add = await httpClient.callTool({ name: 'add', arguments: { a: 2, b: 5 } });
    check('http tools/call add returns sum', add.content?.[0]?.text === 'sum: 7', String(add.content?.[0]?.text));
    check('http initialize carries instructions', typeof httpClient.getInstructions() === 'string');
    const httpIcons = httpClient.getServerVersion()?.icons;
    const expectedIconUrl = `http://127.0.0.1:${httpFixture.info.port}/icon.png`;
    check(
      'http initialize declares the absolute icon URL with the real bound port',
      Array.isArray(httpIcons) && httpIcons.length === 1 && httpIcons[0]?.src === expectedIconUrl && httpIcons[0]?.mimeType === 'image/png',
      JSON.stringify(httpIcons ?? null),
    );
    const iconResponse = await fetch(expectedIconUrl);
    const iconPayload = Buffer.from(await iconResponse.arrayBuffer());
    check(
      'http fixture serves GET /icon.png as the expected image/png bytes',
      iconResponse.status === 200 &&
        iconResponse.headers.get('content-type') === 'image/png' &&
        sameBytes(iconPayload, iconBytes(HTTP_ICON_PNG_BASE64)) &&
        pngInfo(iconPayload).valid,
      `HTTP ${iconResponse.status} ${iconPayload.length}B`,
    );
    const uploadInfo = pngInfo(iconBytes(UPLOAD_ICON_A_PNG_BASE64));
    check('upload PNG fixture is valid and differs from every server icon', uploadInfo.valid && !sameBytes(UPLOAD_ICON_A_PNG_BASE64, HTTP_ICON_PNG_BASE64) && !sameBytes(UPLOAD_ICON_A_PNG_BASE64, STDIO_ICON_PNG_BASE64), `${uploadInfo.width}x${uploadInfo.height}/${uploadInfo.size}B`);
  } finally {
    await httpClient.close();
  }
} finally {
  httpFixture.child.kill('SIGTERM');
}

// ── stdio fixture without icons (page fallback path) ──────────────────────
{
  const noIconClient = new Client(clientInfo, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(fixtures, 'mcp-stdio-server.mjs')],
    env: { ...process.env, MCP_FIXTURE_LABEL: 'selftest-no-icons', MCP_FIXTURE_NO_ICONS: '1' },
    stderr: 'pipe',
  });
  await noIconClient.connect(transport);
  try {
    check('MCP_FIXTURE_NO_ICONS=1 omits serverInfo.icons', noIconClient.getServerVersion()?.icons === undefined, JSON.stringify(noIconClient.getServerVersion() ?? null));
  } finally {
    await noIconClient.close();
  }
}

// ── connection failure surface ────────────────────────────────────────────
{
  const failedClient = new Client(clientInfo, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'));
  let rejected = false;
  try {
    await failedClient.connect(transport);
  } catch (error) {
    rejected = true;
    check('unreachable HTTP server rejects on connect', true, String(error).slice(0, 120));
  } finally {
    if (!rejected) check('unreachable HTTP server rejects on connect', false, 'connect() resolved');
    await failedClient.close().catch(() => {});
  }
}

// ── startup failure surface for the stdio command ─────────────────────────
{
  const failedClient = new Client(clientInfo, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(fixtures, 'mcp-stdio-server.mjs')],
    env: { ...process.env, MCP_FIXTURE_EXIT_IMMEDIATELY: '1' },
    stderr: 'pipe',
  });
  let rejected = false;
  try {
    await failedClient.connect(transport);
  } catch (error) {
    rejected = true;
    check('stdio fixture that exits immediately rejects on connect', true, String(error).slice(0, 120));
  } finally {
    if (!rejected) check('stdio fixture that exits immediately rejects on connect', false, 'connect() resolved');
    await failedClient.close().catch(() => {});
  }
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${checks.length - failed.length}/${checks.length} fixture checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
