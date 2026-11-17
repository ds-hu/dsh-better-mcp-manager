#!/usr/bin/env node
/**
 * Isolated end-to-end test for @ds-hu/dsh-better-mcp-manager.
 *
 *   node test/e2e/run.mjs [--keep] [--verbose]
 *
 * What it proves, against a real Web page served by a real DSH instance:
 *
 *   boot       an isolated profile (fresh copy of the shipped `web` template,
 *              the packed tarball installed with `dsh plugin add`) boots in its
 *              own systemd scope and prints an authenticated URL;
 *   bundle     the sidebar row `MCP 管理` sits directly below `自动化任务` and
 *              opens the management page with no console/page errors;
 *   CRUD       stdio + streamable-HTTP servers connect with live tool counts,
 *              a wrong port surfaces a failing (重连中) card whose 详情 dialog
 *              and 测试连接 dialog carry the real error, editing to the right
 *              port recovers, the enable switch round-trips, and deleting
 *              removes the card;
 *   scoping    with a local fake OpenAI-compatible provider, a standard-preset
 *              session's model request carries `mcp__<key>__echo`, while a
 *              minimal-preset session's request does not; a tool_call for the
 *              MCP tool executes against the fixture and its result is fed back
 *              to the model on the next request;
 *   external   a preset-owned MCP server (`foreign`, mounted by the shipped
 *              `@deepseek-ai/dsh-mcp-client` inside the test preset `external`)
 *              is discovered in 其他 MCP as a compact server card (0.4.1), its
 *              per-server drill-in hides one tool from a live session's model
 *              request, approval asks only outside 完全权限, and 本插件 MCP
 *              keeps working;
 *   hygiene    cleanup removes scopes/processes/files/ports and the production
 *              dsh-web.service MainPID and cgroup are untouched.
 *
 * Safety: every long-running process (this runner included, the test DSH, the
 * fixtures) runs inside a transient systemd scope with MemoryMax, so nothing is
 * accounted in the production dsh-web.service cgroup. The runner never touches
 * the production instance beyond reading its PID/cgroup for the baseline.
 *
 * Flags:
 *   --keep      do not stop scopes or delete the run directory (debugging);
 *               prints the kept paths and leaves them running
 *   --verbose   verbose step logging and HTTP details
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Reporter, createRunId, formatBytes, redact, tailFileSync, waitFor } from './lib/util.mjs';
import { currentCgroup, inProductionCgroup, listScopes, residualScopes, reexecInScope } from './lib/scope.mjs';
import { snapshotProduction, describeSnapshot, ancestorPids } from './lib/production.mjs';
import { InstanceApi } from './lib/api.mjs';
import {
  addBundleToManifest,
  bootDsh,
  createFreshProfile,
  EXTERNAL_MCP_CLIENT_PACKAGE,
  FIXTURE_EXTERNAL_SCRIPT,
  installExternalMcpClient,
  installPackedPlugin,
  packPlugin,
  scanBootLog,
  writeProfilePatch,
} from './lib/profile.mjs';
import { requestsForMarker, startFixtures, stdioFixtureSpec } from './lib/fixtures.mjs';
import { ICONS } from '../fixtures/tiny-icons.mjs';
import { collectDiagnostics, launchBrowser } from './lib/playwright.mjs';
import * as ui from './lib/ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const FLAGS = {
  keep: args.includes('--keep'),
  verbose: args.includes('--verbose'),
};
const UNKNOWN_FLAGS = args.filter((argument) => !['--keep', '--verbose'].includes(argument));
if (UNKNOWN_FLAGS.length > 0) {
  process.stderr.write(`unknown flag(s): ${UNKNOWN_FLAGS.join(' ')}\nusage: node test/e2e/run.mjs [--keep] [--verbose]\n`);
  process.exit(2);
}

const RUN_ID = createRunId();
const RUN_DIR = `/var/tmp/dsh-mcp-e2e-${RUN_ID}`;
const DSH_HOME = join(RUN_DIR, 'home');
const HOME_DIR = join(RUN_DIR, 'userhome');
const WORKSPACE_DIR = join(HOME_DIR, 'workspace');
const PROFILE_NAME = `mcp-e2e-${RUN_ID}`;
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME);
const ARTIFACT_DIR = join(RUN_DIR, 'artifacts');
const DOCS_SCREENSHOT_DIR = join(REPO_ROOT, 'docs', 'screenshots');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = join(DSH_HOME, 'better-mcp-manager');
const ICONS_DIR = join(DATA_DIR, 'icons');
const UPLOAD_A_PATH = join(RUN_DIR, 'tmp', 'upload-a.png');
const UPLOAD_B_PATH = join(RUN_DIR, 'tmp', 'upload-b.png');
// 0.4.0: the preset-owned MCP server's script lives inside the run directory;
// the profile patch points at this absolute path (never at the repo checkout).
const EXTERNAL_FIXTURE_SOURCE = join(REPO_ROOT, FIXTURE_EXTERNAL_SCRIPT);
const EXTERNAL_FIXTURE_DIR = join(RUN_DIR, 'fixtures');
const EXTERNAL_FIXTURE_PATH = join(EXTERNAL_FIXTURE_DIR, 'mcp-external-server.mjs');
const EXTERNAL_PRESET = { presetId: 'external', presetName: '外部MCP测试', order: 99, serverName: 'foreign' };

const reporter = new Reporter({ verbose: FLAGS.verbose });
const resources = { browser: null, dsh: null, fixtures: null };
let cleanupDone = false;

/**
 * Re-exec into a private cgroup before doing anything heavy. Playwright's
 * chromium children inherit the runner's cgroup, and the runner itself may be
 * started from the production service's own cgroup (this repo's development
 * environment runs the assistant inside dsh-web.service).
 */
if (process.env.MCP_E2E_SCOPED !== '1') {
  const code = await reexecInScope({ runId: RUN_ID, argv: [resolve(process.argv[1]), ...args] });
  if (code !== undefined) process.exit(code);
}

process.stdout.write(`\nDSH plugin E2E — run ${RUN_ID}\n`);
process.stdout.write(`cgroup: ${currentCgroup()}${inProductionCgroup() ? ' (production!)' : ''}\n`);
process.stdout.write(`run dir: ${RUN_DIR}\n`);

async function main() {
  const before = snapshotProduction();
  reporter.log(`production before: ${describeSnapshot(before)}`);

  await mkdir(join(RUN_DIR, 'logs'), { recursive: true });
  await mkdir(join(RUN_DIR, 'tmp'), { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(EXTERNAL_FIXTURE_DIR, { recursive: true });
  await copyFile(EXTERNAL_FIXTURE_SOURCE, EXTERNAL_FIXTURE_PATH);
  // The development host runs the assistant inside dsh-web.service, whose TMPDIR
  // is the shared /var/tmp/dsh scratch home. Redirect every child (test DSH,
  // fixtures, pnpm, chromium) to this run's own tmp dir so the isolated E2E
  // never writes into that shared scratch space.
  process.env.TMPDIR = join(RUN_DIR, 'tmp');
  process.env.TMP = process.env.TMPDIR;
  process.env.TEMP = process.env.TMPDIR;

  let page;
  let diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  let dsh;
  let fixtures;
  let api;
  let serverKey;
  let stdioId;
  const screenshotArtifacts = [];

  try {
    // ── phase 1: fixtures ────────────────────────────────────────────────
    await reporter.step('start fixture servers in their own scope', async () => {
      fixtures = await startFixtures({ repoRoot: REPO_ROOT, runDir: RUN_DIR, runId: RUN_ID, reporter });
      resources.fixtures = fixtures;
      reporter.check('fixture fake LLM + MCP HTTP are listening', true, `LLM :${fixtures.fakeLlmPort}, MCP :${fixtures.mcpPort}`);
    });

    // ── phase 2: package + isolated profile + install + boot ─────────────
    let pack;
    await reporter.step('pack the plugin and install it into a fresh profile', async () => {
      pack = await packPlugin({ repoRoot: REPO_ROOT, runDir: RUN_DIR });
      reporter.check('npm pack produced the installable tarball', existsSync(pack.tarball), basename(pack.tarball));

      await createFreshProfile({ repoRoot: REPO_ROOT, runDir: RUN_DIR, dshHome: DSH_HOME, homeDir: HOME_DIR, profileName: PROFILE_NAME, profileDir: PROFILE_DIR });
      const bundles = addBundleToManifest({ profileDir: PROFILE_DIR });
      reporter.check('test profile is the shipped web template plus this bundle', bundles.includes('@deepseek-ai/dsh-base') && bundles.includes('@deepseek-ai/dsh-web-app') && bundles.includes('@ds-hu/dsh-better-mcp-manager'));

      writeProfilePatch({
        profileDir: PROFILE_DIR,
        fakeBaseURL: fixtures.fakeBaseURL,
        externalPreset: { ...EXTERNAL_PRESET, nodePath: process.execPath, fixturePath: EXTERNAL_FIXTURE_PATH },
      });
      const install = await installPackedPlugin({ repoRoot: REPO_ROOT, runDir: RUN_DIR, dshHome: DSH_HOME, homeDir: HOME_DIR, profileName: PROFILE_NAME, profileDir: PROFILE_DIR, tarball: pack.tarball });
      reporter.check(
        'packed tarball installed via `dsh plugin add` with the real registry dependency',
        install.installedVersion === JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version && install.mcpClientVersion === '2.2.0',
        `plugin ${install.installedVersion}, @modelcontextprotocol/client ${install.mcpClientVersion}`,
      );

      const externalClient = await installExternalMcpClient({ runDir: RUN_DIR, dshHome: DSH_HOME, homeDir: HOME_DIR, profileName: PROFILE_NAME, profileDir: PROFILE_DIR });
      reporter.check(
        'shipped MCP client installed for the preset-owned (其他 MCP) test preset',
        externalClient.version !== '' && existsSync(join(PROFILE_DIR, 'node_modules', EXTERNAL_MCP_CLIENT_PACKAGE, 'package.json')),
        `${EXTERNAL_MCP_CLIENT_PACKAGE}@${externalClient.version} (${externalClient.mode})`,
      );
    });

    await reporter.step('boot the isolated DSH instance under its own scope', async () => {
      dsh = await bootDsh({ repoRoot: REPO_ROOT, runDir: RUN_DIR, dshHome: DSH_HOME, homeDir: HOME_DIR, profileName: PROFILE_NAME, port: await freePort(), reporter });
      resources.dsh = dsh;
      reporter.check('test instance printed an authenticated URL with a token parameter', new URL(dsh.url).searchParams.get('token') !== null, redact(dsh.url));
      reporter.check('test instance is not on the production port 3080', dsh.port !== 3080, `port ${dsh.port}`);
      api = new InstanceApi({ origin: dsh.origin, reporter });
      const login = await api.login(dsh.url);
      reporter.check('authenticated URL mints the browser-auth cookie', typeof login.status === 'number', `index HTTP ${login.status}`);
    });

    await reporter.step('Host plugin mounted and serving its HTTP API', async () => {
      const health = await api.health();
      reporter.check(`/better-mcp-manager/api/health answers ok + ${PACKAGE_VERSION}`, health?.ok === true && health?.version === PACKAGE_VERSION, JSON.stringify(health));
      const catalog = await api.servers();
      reporter.check(
        'GET /servers starts empty with the real preset roster',
        catalog?.ok === true && Array.isArray(catalog.servers) && catalog.servers.length === 0 && catalog.presets.some((preset) => preset.id === 'standard') && catalog.presets.some((preset) => preset.id === 'minimal'),
        `presets: ${(catalog?.presets ?? []).map((preset) => preset.id).join(', ')}`,
      );
      reporter.check('data directory is under the isolated DSH_HOME', catalog?.dataDir === DATA_DIR, catalog?.dataDir);

      const bootScan = await scanBootLog({ logPath: dsh.logPath, errPath: dsh.errPath });
      reporter.check(
        'no plugin mount errors or duplicate rows in the boot log',
        bootScan.suspicious.length === 0 && bootScan.duplicate.length === 0,
        redact([...bootScan.suspicious, ...bootScan.duplicate].slice(0, 3).join(' | ')),
      );

      const unknownApi = await api.request('GET', '/better-mcp-manager/api/nope', { expectOk: false });
      reporter.check(
        'unknown plugin API path answers a JSON 404 instead of a crash',
        unknownApi.status === 404 && unknownApi.payload?.ok === false,
        `HTTP ${unknownApi.status} ${redact(unknownApi.text).slice(0, 120)}`,
      );
      const unknownPage = await api.request('GET', '/better-mcp-manager/not-a-page', { expectOk: false });
      reporter.check('unknown non-API plugin path never answers 5xx', unknownPage.status < 500, `HTTP ${unknownPage.status}`);
    });

    // ── phase 3: browser — bundle loads ──────────────────────────────────
    await reporter.step('sidebar entry + management page render in the real browser', async () => {
      const browser = await launchBrowser({ reporter });
      resources.browser = browser;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
      page = await context.newPage();
      diagnostics = collectDiagnostics(page);
      await ui.openApp(page, dsh.url);

      const order = await ui.sidebarPanelOrder(page);
      reporter.check(
        'sidebar shows MCP 管理 directly below 自动化任务',
        order.automationIndex >= 0 && order.mcpIndex === order.automationIndex + 1 && order.mcpBox !== null && order.automationBox !== null && order.mcpBox.y > order.automationBox.y,
        `rows: ${order.rows.join(' | ')}`,
      );

      await ui.openMcpPage(page);
      reporter.check('clicking MCP 管理 opens the management page', (await page.locator('[data-testid="mcp-page"]').count()) === 1);
      reporter.check(
        'no console errors or page errors while opening the plugin page',
        diagnostics.consoleErrors.length === 0 && diagnostics.pageErrors.length === 0,
        redact([...diagnostics.consoleErrors, ...diagnostics.pageErrors].slice(0, 3).join(' | ')),
      );
    });

    // ── phase 4: UI CRUD ─────────────────────────────────────────────────
    const stdioSpec = stdioFixtureSpec({ repoRoot: REPO_ROOT });
    const stdioName = 'E2E 标准模式服务器';
    const httpName = 'E2E HTTP 服务器';
    const brokenName = 'E2E 故障服务器';

    await reporter.step('add the stdio fixture through the form with preset scoping', async () => {
      await ui.openAddForm(page);
      const values = await ui.fillServerForm(page, {
        name: stdioName,
        transport: 'stdio',
        command: stdioSpec.command,
        args: stdioSpec.args,
        presets: ['standard'],
      });
      reporter.check('form accepted name/command/args and 指定预设+标准模式', values.name === stdioName && values.command === stdioSpec.command && values.args === stdioSpec.args.join('\n'));

      screenshotArtifacts.push(await ui.screenshotPresetSection(page, join(ARTIFACT_DIR, 'mcp-manager-form-presets.png')));

      await ui.saveForm(page);
      await ui.waitCardState(page, stdioName, 'connected');
      const text = await ui.waitCardText(page, stdioName, '工具 2/2');
      reporter.check('saved stdio server shows 已连接 · 内置 · 工具 2/2', text.includes('已连接') && text.includes('内置') && text.includes('工具 2/2'), text.replaceAll('\n', ' '));

      const catalog = await api.servers();
      const record = catalog.servers.find((server) => server.name === stdioName);
      if (record === undefined) throw new Error('saved stdio server is missing from GET /servers');
      serverKey = record.key;
      stdioId = record.id;
      reporter.check('server record has a derived key and the chosen preset exactly', /^[a-z0-9][a-z0-9_-]{0,31}$/.test(record.key) && JSON.stringify(record.presets) === JSON.stringify(['standard']), `key ${record.key}, presets ${JSON.stringify(record.presets)}`);
      reporter.check('server record reports connected with toolCount 2', record.status?.state === 'connected' && record.status?.toolCount === 2, JSON.stringify(record.status));

      const detail = await api.serverDetail(record.id);
      const publicNames = (detail.server.tools ?? []).map((tool) => tool.publicName);
      reporter.check(
        'GET /servers/:id lists mcp__<key>__echo and mcp__<key>__fail',
        publicNames.includes(`mcp__${serverKey}__echo`) && publicNames.includes(`mcp__${serverKey}__fail`),
        publicNames.join(', '),
      );

      const dataFile = join(DATA_DIR, 'servers.json');
      const mode = (await stat(dataFile)).mode & 0o777;
      const stored = JSON.parse(await readFile(dataFile, 'utf8'));
      reporter.check('store file lives in the isolated data dir with mode 0600', mode === 0o600, `mode 0${mode.toString(8)}`);
      reporter.check('store file contains the saved server and nothing outside the data dir', stored.servers?.some((server) => server.id === record.id));

      // ── 0.2.0 icons: the server-declared (auto) icon ──
      reporter.check(
        'new server starts with icon.kind="auto" and a cache-busted iconUrl',
        record.icon?.kind === 'auto' && typeof record.iconUrl === 'string' && record.iconUrl.startsWith(`/better-mcp-manager/api/servers/${record.id}/icon?`) && record.iconUrl.includes('v='),
        JSON.stringify({ icon: record.icon, iconUrl: record.iconUrl }),
      );
      const autoIcon = await api.fetchIcon(record.iconUrl);
      const autoSize = pngSize(autoIcon.bytes);
      reporter.check(
        'auto icon serves the preferred light/no-theme MCP icon bytes (not the dark one)',
        autoIcon.status === 200 && autoIcon.contentType === 'image/png' && sameBytes(autoIcon.bytes, ICONS.stdio.bytes) && autoSize.width === 16 && autoSize.height === 16 && !sameBytes(autoIcon.bytes, ICONS.stdioDark.bytes),
        `HTTP ${autoIcon.status} ${autoIcon.contentType} ${autoSize.width}x${autoSize.height} ${autoSize.size}B`,
      );
      reporter.check(
        'icon response carries ETag + private max-age and honours If-None-Match with 304',
        typeof autoIcon.etag === 'string' && autoIcon.etag.length > 0 && /private/u.test(autoIcon.cacheControl ?? '') && /max-age=300/u.test(autoIcon.cacheControl ?? '') && (await api.fetchIcon(record.iconUrl, { ifNoneMatch: autoIcon.etag })).status === 304,
        redact(`etag=${autoIcon.etag} cache-control=${autoIcon.cacheControl}`),
      );
      const svgUpload = await api.request('POST', `/better-mcp-manager/api/servers/${record.id}/icon`, {
        body: { dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}` },
        expectOk: false,
      });
      const afterSvg = await api.serverDetail(record.id);
      reporter.check(
        'SVG icon upload is rejected and leaves the auto icon untouched',
        svgUpload.status >= 400 && svgUpload.status < 500 && svgUpload.payload?.code === 'invalid-icon' && afterSvg.server.icon?.kind === 'auto' && (await api.fetchIcon(record.iconUrl)).status === 200,
        `HTTP ${svgUpload.status} ${redact(svgUpload.text).slice(0, 140)}`,
      );
    });

    let httpId;
    await reporter.step('wrong port surfaces a failing card with 详情 + 测试连接 diagnostics', async () => {
      const deadPort = await freePort();
      await ui.openAddForm(page);
      await ui.fillServerForm(page, {
        name: httpName,
        transport: 'http',
        url: `http://127.0.0.1:${deadPort}/mcp`,
        presets: 'all',
      });
      await ui.saveForm(page);

      // Capture the record before any UI-word assertion: later steps depend on its id.
      const catalog = await api.servers();
      const record = catalog.servers.find((server) => server.name === httpName);
      if (record === undefined) throw new Error('saved HTTP server is missing from GET /servers');
      httpId = record.id;
      reporter.check(
        'Host API reports state=error, code connect-failed and a scheduled retry',
        record.status?.state === 'error' && record.status?.error?.code === 'connect-failed' && typeof record.status?.nextRetryAt === 'string',
        JSON.stringify({ state: record.status?.state, code: record.status?.error?.code, nextRetryAt: record.status?.nextRetryAt }),
      );

      const state = await ui.waitCardState(page, httpName, ['error', 'retrying'], { timeoutMs: 40_000 });
      const card = await ui.waitCardText(page, httpName, 'ECONNREFUSED');
      reporter.check(
        'failing card shows the contract word 重连中 and the real ECONNREFUSED error bubble',
        card.includes('重连中') && /ECONNREFUSED/.test(card),
        card.replaceAll('\n', ' '),
      );
      reporter.check('failing card status dot reports retrying/error', state === 'retrying' || state === 'error', `data-state=${state}`);

      const error = await ui.openErrorDetail(page, httpName);
      screenshotArtifacts.push(await ui.screenshotElement(error.dialog, join(ARTIFACT_DIR, 'mcp-manager-error-detail.png'), { maxHeight: 310 }));
      reporter.check(
        '详情 dialog shows 错误码 connect-failed, 错误信息 with ECONNREFUSED and 下次重试',
        error.text.includes('错误码') && error.text.includes('connect-failed') && error.text.includes('错误信息') && /ECONNREFUSED/.test(error.text) && error.text.includes('下次重试'),
        redact(error.text.replaceAll('\n', ' ').slice(0, 320)),
      );
      await error.close();

      const test = await ui.testServerViaCard(page, httpName);
      reporter.check(
        'menu → 测试连接 dialog shows the literal 连接失败 with the error message',
        test.text.includes('连接失败') && /ECONNREFUSED/.test(test.text),
        redact(test.text.replaceAll('\n', ' ').slice(0, 260)),
      );
      await test.close();
    });

    await reporter.step('editing the URL to the live port recovers to 已连接 + 工具 3/3', async () => {
      await ui.editServer(page, httpName);
      await ui.updateUrl(page, fixtures.mcpUrl);
      await ui.saveForm(page);
      await ui.waitCardState(page, httpName, 'connected');
      const text = await ui.waitCardText(page, httpName, '工具 3/3');
      reporter.check('edited HTTP server shows 已连接 · HTTP · 工具 3/3', text.includes('已连接') && text.includes('HTTP') && text.includes('工具 3/3'), text.replaceAll('\n', ' '));

      if (httpId === undefined) throw new Error('no HTTP server id captured for the edit step');
      const detail = await api.serverDetail(httpId);
      reporter.check('Host API reconnected the same record and discovered 3 tools', detail.server.status?.state === 'connected' && detail.server.status?.toolCount === 3 && (detail.server.tools ?? []).length === 3);

      const httpRecord = (await api.servers()).servers.find((server) => server.id === httpId);
      const httpIcon = await api.fetchIcon(httpRecord.iconUrl);
      reporter.check(
        'HTTP server icon is proxied by the Host from the absolute http URL and matches the fixture bytes',
        httpRecord.icon?.kind === 'auto' && typeof httpRecord.iconUrl === 'string' && httpIcon.status === 200 && httpIcon.contentType === 'image/png' && sameBytes(httpIcon.bytes, ICONS.http.bytes),
        redact(`iconUrl=${httpRecord.iconUrl} HTTP ${httpIcon.status} ${httpIcon.bytes.length}B`),
      );
    });

    await reporter.step('the enable switch round-trips through 已停用 and back to 已连接', async () => {
      await ui.toggleServer(page, httpName);
      await ui.waitCardState(page, httpName, 'disabled');
      await ui.waitCardText(page, httpName, '已停用');
      let catalog = await api.servers();
      reporter.check('disabling the server persists enabled=false', catalog.servers.find((server) => server.name === httpName)?.enabled === false);

      await ui.toggleServer(page, httpName);
      await ui.waitCardState(page, httpName, 'connected');
      await ui.waitCardText(page, httpName, '工具 3/3');
      catalog = await api.servers();
      reporter.check('re-enabling the server reconnects it and persists enabled=true', catalog.servers.find((server) => server.name === httpName)?.enabled === true && catalog.servers.find((server) => server.name === httpName)?.status?.state === 'connected');

      // Leave it disabled for the mixed-state screenshot below.
      await ui.toggleServer(page, httpName);
      await ui.waitCardState(page, httpName, 'disabled');
    });

    await reporter.step('mixed-state list screenshot + delete removes the card', async () => {
      const deadPort = await freePort();
      await ui.openAddForm(page);
      await ui.fillServerForm(page, {
        name: brokenName,
        transport: 'http',
        url: `http://127.0.0.1:${deadPort}/mcp`,
        presets: 'all',
      });
      await ui.saveForm(page);
      await ui.waitCardState(page, brokenName, ['error', 'retrying'], { timeoutMs: 40_000 });

      const names = await ui.cardNames(page);
      reporter.check('list holds connected + disabled + failing servers side by side', names.includes(stdioName) && names.includes(httpName) && names.includes(brokenName), names.join(' | '));
      const summary = await page.locator('[data-testid="mcp-page"]').innerText();
      reporter.check(
        'list header counts 3 servers / 1 connected',
        summary.includes('共 3 个服务器') && summary.includes('1 个已连接'),
        summary.replaceAll('\n', ' ').slice(0, 160),
      );
      reporter.check(
        'list renders 已连接 + 已停用 + 重连中 with the failing ECONNREFUSED bubble side by side',
        summary.includes('已连接') && summary.includes('已停用') && summary.includes('重连中') && /ECONNREFUSED/.test(summary),
        summary.replaceAll('\n', ' ').slice(0, 260),
      );
      await ui.dismissBanners(page);
      screenshotArtifacts.push(await ui.screenshotPageSurface(page, join(ARTIFACT_DIR, 'mcp-manager-list.png')));
      // Whole viewport: sidebar with 自动化任务 directly above the active MCP 管理 row.
      screenshotArtifacts.push(await ui.screenshotViewport(page, join(ARTIFACT_DIR, 'mcp-manager-sidebar.png')));

      await ui.deleteServerViaCard(page, brokenName);
      const remaining = await ui.cardNames(page);
      reporter.check('deleting a server removes its card from the list', !remaining.includes(brokenName) && remaining.includes(stdioName), remaining.join(' | '));
      const catalog = await api.servers();
      reporter.check('Host API lists two servers after the delete', catalog.servers.length === 2 && !catalog.servers.some((server) => server.name === brokenName));
    });

    // ── phase 5: preset scoping and a real MCP tool call ────────────────

    await reporter.step('icon controls: upload, replace and 恢复自动 through the form', async () => {
      if (stdioId === undefined) throw new Error('no stdio server id captured for the icon phase');
      await mkdir(dirname(UPLOAD_A_PATH), { recursive: true });
      await writeFile(UPLOAD_A_PATH, ICONS.uploadA.bytes);
      await writeFile(UPLOAD_B_PATH, ICONS.uploadB.bytes);

      await ui.editServer(page, stdioName);
      const controls = await ui.formIconControls(page);
      reporter.check(
        'edit form has icon-preview + icon-upload + icon-file and no emoji palette',
        controls.preview > 0 && controls.upload > 0 && controls.file > 0 && controls.emoji === 0,
        JSON.stringify(controls),
      );
      screenshotArtifacts.push(await ui.screenshotIconSection(page, join(ARTIFACT_DIR, 'mcp-manager-form-icon.png')));

      await ui.chooseIconFile(page, UPLOAD_A_PATH);
      await ui.closeFormIfOpen(page);
      const uploadedA = await waitFor(
        async () => {
          const detail = await api.serverDetail(stdioId);
          return detail.server.icon?.kind === 'upload' ? detail.server : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'icon upload A to be recorded' },
      );
      const filesA = await iconFilesForId(stdioId);
      const fileA = filesA.length === 1 ? await stat(join(ICONS_DIR, filesA[0])) : undefined;
      const fetchedA = await api.fetchIcon(uploadedA.iconUrl);
      reporter.check(
        'uploaded icon is one 0600 file in a 0700 dir and is served back byte-for-byte',
        uploadedA.icon.mimeType === 'image/png' && filesA.length === 1 && fileA !== undefined && (fileA.mode & 0o777) === 0o600 && sameBytes(fetchedA.bytes, ICONS.uploadA.bytes) && (await iconsDirListing()).mode === 0o700,
        `${filesA.join(',')} mode=${fileA === undefined ? '-' : (fileA.mode & 0o777).toString(8)} served=${fetchedA.bytes.length}B`,
      );
      const cardA = await ui.cardIcon(page, stdioName);
      reporter.check(
        'card renders the uploaded icon as a loaded <img data-testid="server-icon">',
        cardA.imageCount === 1 && cardA.naturalWidth > 0 && cardA.complete === true && String(cardA.src).includes(`/servers/${stdioId}/icon`),
        JSON.stringify(cardA),
      );

      await ui.editServer(page, stdioName);
      await ui.chooseIconFile(page, UPLOAD_B_PATH);
      await ui.closeFormIfOpen(page);
      const uploadedB = await waitFor(
        async () => {
          const detail = await api.serverDetail(stdioId);
          const fetched = await api.fetchIcon(detail.server.iconUrl);
          return detail.server.icon?.kind === 'upload' && sameBytes(fetched.bytes, ICONS.uploadB.bytes) ? detail.server : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'icon upload B to replace upload A' },
      );
      const filesB = await iconFilesForId(stdioId);
      const diskB = filesB.length === 1 ? await readFile(join(ICONS_DIR, filesB[0])) : undefined;
      reporter.check(
        'replacing the icon keeps exactly one file, on disk and on the wire',
        filesB.length === 1 && uploadedB.icon.file === filesB[0] && diskB !== undefined && sameBytes(diskB, ICONS.uploadB.bytes) && sameBytes((await api.fetchIcon(uploadedB.iconUrl)).bytes, ICONS.uploadB.bytes),
        filesB.join(','),
      );

      await ui.editServer(page, stdioName);
      const beforeReset = await ui.formIconControls(page);
      reporter.check('an uploaded icon exposes the 恢复自动 (icon-remove) control', beforeReset.remove > 0, JSON.stringify({ remove: beforeReset.remove }));
      await ui.resetIconToAuto(page);
      await ui.closeFormIfOpen(page);
      const restored = await waitFor(
        async () => {
          const detail = await api.serverDetail(stdioId);
          return detail.server.icon?.kind === 'auto' ? detail.server : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'icon reset to auto' },
      );
      const fetchedAuto = await api.fetchIcon(restored.iconUrl);
      reporter.check(
        '恢复自动 removes the stored file and serves the fixture icon again',
        (await iconFilesForId(stdioId)).length === 0 && sameBytes(fetchedAuto.bytes, ICONS.stdio.bytes),
        `files=${(await iconFilesForId(stdioId)).join(',') || '(none)'} bytes=${fetchedAuto.bytes.length}`,
      );
      const cardAuto = await ui.cardIcon(page, stdioName);
      reporter.check('card icon returns to the server-provided icon after the reset', cardAuto.imageCount === 1 && cardAuto.naturalWidth > 0 && sameBytes((await api.fetchIcon(restored.iconUrl)).bytes, ICONS.stdio.bytes), JSON.stringify(cardAuto));
    });

    await reporter.step('deleting a server removes its uploaded icon file (no orphan)', async () => {
      if (httpId === undefined) throw new Error('no HTTP server id captured for the icon delete phase');
      const uploaded = await api.uploadIcon(httpId, `data:image/png;base64,${ICONS.uploadA.base64}`);
      const files = await iconFilesForId(httpId);
      reporter.check('uploaded icon file exists before the delete', files.length === 1 && uploaded.server.icon?.kind === 'upload', files.join(','));
      await ui.deleteServerViaCard(page, httpName);
      reporter.check('deleting the server removes its icon file from dataDir/icons', (await iconFilesForId(httpId)).length === 0, (await iconsDirListing()).entries.join(',') || '(icons dir empty)');
      const gone = await api.request('GET', `/better-mcp-manager/api/servers/${httpId}/icon`, { expectOk: false });
      reporter.check('icon endpoint for the deleted server answers a JSON 404', gone.status === 404 && gone.payload?.ok === false, `HTTP ${gone.status} ${redact(gone.text).slice(0, 120)}`);
      reporter.check('remaining servers left no icon files behind', (await iconsDirListing()).entries.length === 0, (await iconsDirListing()).entries.join(',') || '(icons dir empty)');
    });

    await reporter.step('a server that declares no icon falls back to its first letter', async () => {
      const draft = {
        name: 'E2E 无图标服务器',
        transport: 'stdio',
        command: stdioSpec.command,
        args: stdioSpec.args,
        env: { MCP_FIXTURE_LABEL: 'fallback', MCP_FIXTURE_NO_ICONS: '1' },
        presets: 'all',
      };
      const created = await api.createServer(draft);
      const fallbackId = created.server.id;
      await waitFor(
        async () => {
          const catalog = await api.servers();
          return catalog.servers.find((server) => server.id === fallbackId)?.status?.state === 'connected' ? true : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 300, label: 'no-icon fixture server to connect' },
      );
      const noIcon = await api.request('GET', created.server.iconUrl, { expectOk: false });
      reporter.check('GET icon for a connected server without icons answers a JSON 404', noIcon.status === 404 && noIcon.payload?.ok === false, `HTTP ${noIcon.status} ${redact(noIcon.text).slice(0, 140)}`);
      const fallbackCard = await waitFor(
        async () => {
          const state = await ui.cardIcon(page, 'E2E 无图标服务器');
          return state.fallbackCount > 0 ? state : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 500, label: 'first-letter fallback tile' },
      );
      reporter.check('card shows the first-letter fallback element (16x16 auto icon unavailable)', fallbackCard.fallbackCount > 0 && (fallbackCard.imageCount === 0 || fallbackCard.naturalWidth === 0), JSON.stringify(fallbackCard));
      await api.deleteServer(fallbackId);
      reporter.check('deleting the no-icon server leaves no icon file', (await iconFilesForId(fallbackId)).length === 0 && (await iconsDirListing()).entries.length === 0);
    });

    await reporter.step('tools tab: cards, params, disable fail and per-tool approval persist', async () => {
      if (stdioId === undefined || serverKey === undefined) throw new Error('no stdio server id/key captured for the tools phase');
      const publicName = (name) => `mcp__${serverKey}__${name}`;
      await ui.openEditToolsTab(page, stdioName);
      const countText = await ui.waitToolsCount(page, '已启用 2/2');
      reporter.check('tools tab opens with 已启用 2/2 and both fixture tools listed', countText.includes('已启用 2/2'), countText);
      const echoCard = await ui.toolCardState(page, 'echo');
      const failCard = await ui.toolCardState(page, 'fail');
      reporter.check(
        'echo card carries its MCP description, is enabled and marks text as required',
        echoCard.enabled === 'true' && echoCard.approval === 'false' && echoCard.description.includes('Echo the given text back') && echoCard.params.some((param) => param.text.includes('text') && param.required === 'true'),
        JSON.stringify({ echo: echoCard.description, params: echoCard.params }),
      );
      reporter.check(
        'fail card carries its MCP description and marks message as optional',
        failCard.enabled === 'true' && failCard.description.includes('Always answer with an MCP tool error') && failCard.params.some((param) => param.text.includes('message') && param.required === 'false'),
        JSON.stringify({ fail: failCard.description, params: failCard.params }),
      );
      screenshotArtifacts.push(await ui.screenshotToolsTab(page, join(ARTIFACT_DIR, 'mcp-manager-form-tools.png')));

      const liveTools = await api.tools(stdioId);
      reporter.check(
        'GET /servers/:id/tools returns live descriptors with the default settings',
        liveTools.ok === true && liveTools.connected === true && Array.isArray(liveTools.tools) && liveTools.tools.length === 2 &&
          liveTools.tools.every((tool) => tool.enabled === true && tool.approval === false) &&
          liveTools.tools.some((tool) => tool.name === 'echo' && tool.publicName === publicName('echo') && tool.params.some((param) => param.name === 'text' && param.required === true)),
        redact(JSON.stringify(liveTools).slice(0, 320)),
      );

      await ui.setToolSwitch(page, 'fail', 'tool-enabled', false);
      await ui.saveTools(page);
      await ui.waitToolsCount(page, '已启用 1/2');
      const disabledTools = await api.tools(stdioId);
      const storedDisabled = JSON.parse(await readFile(join(DATA_DIR, 'servers.json'), 'utf8')).servers.find((server) => server.id === stdioId);
      const disabledStatus = (await api.servers()).servers.find((server) => server.id === stdioId)?.status;
      reporter.check(
        'disabling fail persists toolOverrides.fail.enabled=false in the store and the counter drops to 已启用 1/2',
        storedDisabled?.toolOverrides?.fail?.enabled === false && disabledStatus?.enabledToolCount === 1 && disabledStatus?.toolCount === 2 && disabledTools.tools.find((tool) => tool.name === 'fail')?.enabled === false,
        redact(JSON.stringify({ overrides: storedDisabled?.toolOverrides, status: disabledStatus, tools: (disabledTools.tools ?? []).map((tool) => `${tool.name}:${tool.enabled}`) })),
      );
      await ui.closeFormViaBack(page);
      const cardText = await ui.waitCardText(page, stdioName, '工具 1/2');
      reporter.check('the card status line reflects the disabled tool as 工具 1/2', cardText.includes('工具 1/2'), cardText.replaceAll('\n', ' '));

      // A standard-preset model request must no longer advertise the disabled tool.
      await fixtures.reset();
      const disabledMarker = `E2E-DISABLED-${RUN_ID}`;
      await fixtures.configure({
        defaultText: `fixture-llm: reply-${RUN_ID}`,
        afterToolText: `fixture-llm: tool-result-${RUN_ID}`,
        markers: [{ match: disabledMarker, reply: { kind: 'text', text: `fixture-llm: disabled-${RUN_ID}` } }],
      });
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'standard');
      await ui.sendMessage(page, `${disabledMarker} 禁用工具后的请求`);
      const disabledRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          const matches = requestsForMarker(state, disabledMarker);
          return matches.length > 0 ? matches[0] : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 500, label: 'standard-preset request after disabling fail' },
      );
      reporter.check(
        'a disabled tool disappears from the standard-preset model catalog',
        disabledRequest.tools.includes(publicName('echo')) && !disabledRequest.tools.includes(publicName('fail')),
        disabledRequest.tools.filter((name) => name.startsWith(`mcp__${serverKey}__`)).join(', '),
      );
      await ui.waitForBodyText(page, `fixture-llm: disabled-${RUN_ID}`);

      // Re-enable fail and turn approval on for echo.
      await ui.openMcpPage(page);
      await ui.openEditToolsTab(page, stdioName);
      await ui.setToolSwitch(page, 'fail', 'tool-enabled', true);
      await ui.setToolSwitch(page, 'echo', 'tool-approval', true);
      await ui.saveTools(page);
      await ui.waitToolsCount(page, '已启用 2/2');
      const storedApproval = JSON.parse(await readFile(join(DATA_DIR, 'servers.json'), 'utf8')).servers.find((server) => server.id === stdioId);
      const approvalTools = await api.tools(stdioId);
      reporter.check(
        're-enabling fail and toggling echo 需要审批 stores exactly the non-default echo override',
        storedApproval?.toolOverrides?.echo?.approval === true && storedApproval?.toolOverrides?.fail === undefined && Object.keys(storedApproval?.toolOverrides ?? {}).length === 1 &&
          approvalTools.tools.find((tool) => tool.name === 'echo')?.approval === true && approvalTools.tools.find((tool) => tool.name === 'fail')?.enabled === true,
        redact(JSON.stringify({ overrides: storedApproval?.toolOverrides, tools: (approvalTools.tools ?? []).map((tool) => `${tool.name}:enabled=${tool.enabled},approval=${tool.approval}`) })),
      );
      await ui.closeFormViaBack(page);
      const restored = await ui.waitCardText(page, stdioName, '工具 2/2');
      reporter.check('the card status line returns to 工具 2/2 after re-enabling fail', restored.includes('工具 2/2'), restored.replaceAll('\n', ' '));
    });

    await reporter.step('approval-gated tool asks in a restricted session and runs after 允许一次', async () => {
      if (serverKey === undefined) throw new Error('no stdio server key captured for the approval phase');
      const marker = `E2E-APPROVE-${RUN_ID}`;
      const echoArgument = `approval-echo-${RUN_ID}`;
      await fixtures.reset();
      await fixtures.configure({
        defaultText: `fixture-llm: reply-${RUN_ID}`,
        afterToolText: `fixture-llm: tool-result-${RUN_ID}`,
        markers: [{ match: marker, reply: { kind: 'tool', toolName: `mcp__${serverKey}__echo`, arguments: { text: echoArgument } } }],
      });
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'standard');
      const restrictedLabel = await ui.currentPermission(page);
      reporter.check('a fresh session starts outside 完全权限 so approval applies', restrictedLabel !== '完全权限', `permission: ${restrictedLabel}`);
      await ui.sendMessage(page, `${marker} 请调用需要审批的 MCP echo 工具`);
      const prompt = await ui.waitApprovalPrompt(page, { timeoutMs: 120_000 });
      reporter.check(
        'the approval composer shows 等待审批 with the MCP tool reason',
        prompt.text.includes('等待审批') && prompt.text.includes('需要审批') && prompt.text.includes(`mcp__${serverKey}__echo`),
        redact(prompt.text.replaceAll('\n', ' ').slice(0, 320)),
      );
      const pendingState = await fixtures.state();
      reporter.check(
        'the tool has not run while the approval is pending',
        requestsForMarker(pendingState, marker).every((request) => (request.toolResultTexts ?? []).length === 0),
        `requests: ${requestsForMarker(pendingState, marker).length}`,
      );
      await ui.answerApproval(page, 'allow');
      const followUp = await waitFor(
        async () => {
          const state = await fixtures.state();
          const matches = requestsForMarker(state, marker);
          return matches.find((request) => (request.toolResultTexts ?? []).some((text) => text.includes(`echo: ${echoArgument}`)));
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request containing the approved echo result' },
      );
      reporter.check(
        '允许一次 lets the approval-gated tool run and return its result to the model',
        followUp.toolResultTexts.some((text) => text.includes(`echo: ${echoArgument}`)),
        followUp.toolResultTexts.map((text) => text.slice(0, 60)).join(' | '),
      );
      await ui.waitForBodyText(page, `fixture-llm: tool-result-${RUN_ID}`);
      reporter.check('the approval composer is gone after the decision', (await ui.approvalPromptCount(page)) === 0);
    });

    await reporter.step('a 完全权限 session runs the approval-gated tool without asking', async () => {
      if (serverKey === undefined) throw new Error('no stdio server key captured for the full-access phase');
      const marker = `E2E-FULLACCESS-${RUN_ID}`;
      const echoArgument = `full-access-echo-${RUN_ID}`;
      const state = await fixtures.state();
      await fixtures.configure({
        ...state.config,
        markers: [
          ...(state.config.markers ?? []).filter((rule) => !String(rule.match).includes(marker)),
          { match: marker, reply: { kind: 'tool', toolName: `mcp__${serverKey}__echo`, arguments: { text: echoArgument } } },
        ],
      });
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'standard');
      const label = await ui.switchPermission(page, '完全权限');
      reporter.check('the new session runs in 完全权限', label === '完全权限', `permission: ${label}`);
      await ui.sendMessage(page, `${marker} 请调用 MCP echo 工具`);
      const followUp = await waitFor(
        async () => {
          const current = await fixtures.state();
          const matches = requestsForMarker(current, marker);
          return matches.find((request) => (request.toolResultTexts ?? []).some((text) => text.includes(`echo: ${echoArgument}`)));
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request containing the full-access echo result' },
      );
      reporter.check(
        '完全权限 skips approval and the tool runs directly',
        followUp.toolResultTexts.some((text) => text.includes(`echo: ${echoArgument}`)),
        followUp.toolResultTexts.map((text) => text.slice(0, 60)).join(' | '),
      );
      const body = await page.locator('body').innerText();
      reporter.check('no approval composer is rendered in 完全权限', (await ui.approvalPromptCount(page)) === 0 && !body.includes('等待审批'));
      await ui.waitForBodyText(page, `fixture-llm: tool-result-${RUN_ID}`);
    });

    await reporter.step('restore echo approval off through the tools tab', async () => {
      if (stdioId === undefined) throw new Error('no stdio server id captured for restoring tool settings');
      await ui.openMcpPage(page);
      await ui.openEditToolsTab(page, stdioName);
      await ui.setToolSwitch(page, 'echo', 'tool-approval', false);
      await ui.saveTools(page);
      await ui.waitToolsCount(page, '已启用 2/2');
      const storedRestored = JSON.parse(await readFile(join(DATA_DIR, 'servers.json'), 'utf8')).servers.find((server) => server.id === stdioId);
      const tools = await api.tools(stdioId);
      reporter.check(
        'turning 需要审批 back off normalizes the override away',
        storedRestored?.toolOverrides?.echo === undefined && Object.keys(storedRestored?.toolOverrides ?? {}).length === 0 && tools.tools.find((tool) => tool.name === 'echo')?.approval === false,
        redact(JSON.stringify({ overrides: storedRestored?.toolOverrides, tools: (tools.tools ?? []).map((tool) => `${tool.name}:approval=${tool.approval}`) })),
      );
      await ui.closeFormViaBack(page);
    });

    await reporter.step('preset scoping: standard sees the MCP tools, minimal does not', async () => {
      if (serverKey === undefined) throw new Error('no stdio server key available for the scoping phase');
      const standardMarker = `E2E-STD-${RUN_ID}`;
      const minimalMarker = `E2E-MIN-${RUN_ID}`;
      await fixtures.reset();
      await fixtures.configure({
        defaultText: `fixture-llm: reply-${RUN_ID}`,
        afterToolText: `fixture-llm: tool-result-${RUN_ID}`,
        markers: [
          { match: standardMarker, reply: { kind: 'text', text: `fixture-llm: standard-${RUN_ID}` } },
          { match: minimalMarker, reply: { kind: 'text', text: `fixture-llm: minimal-${RUN_ID}` } },
        ],
      });

      await ui.startNewSession(page);
      await ui.selectPreset(page, 'standard');
      await ui.sendMessage(page, `${standardMarker} 标准模式请求`);
      const standardRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          const matches = requestsForMarker(state, standardMarker);
          return matches.length > 0 ? matches[0] : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 500, label: 'standard-preset model request' },
      );
      const standardTools = standardRequest.tools;
      reporter.check(
        'standard-preset model request has mcp__<key>__echo and mcp__<key>__fail in tools[]',
        standardTools.includes(`mcp__${serverKey}__echo`) && standardTools.includes(`mcp__${serverKey}__fail`),
        `${standardTools.length} tools, MCP: ${standardTools.filter((name) => name.startsWith('mcp__')).join(', ')}`,
      );
      await ui.waitForBodyText(page, `fixture-llm: standard-${RUN_ID}`);

      await ui.startNewSession(page);
      await ui.selectPreset(page, 'minimal');
      await ui.sendMessage(page, `${minimalMarker} 极简模式请求`);
      const minimalRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          const matches = requestsForMarker(state, minimalMarker);
          return matches.length > 0 ? matches[0] : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 500, label: 'minimal-preset model request' },
      );
      reporter.check(
        'minimal-preset model request carries none of the MCP tools',
        !minimalRequest.tools.some((name) => name.startsWith(`mcp__${serverKey}__`) || name.startsWith('mcp__')),
        `${minimalRequest.tools.length} tools: ${minimalRequest.tools.join(', ')}`,
      );
      reporter.check(
        'minimal-preset request is a strict subset of the standard tool catalog',
        minimalRequest.tools.length < standardTools.length,
        `${minimalRequest.tools.length} vs ${standardTools.length}`,
      );
      await ui.waitForBodyText(page, `fixture-llm: minimal-${RUN_ID}`);

      const diagnosticsPayload = await api.agents();
      const standardAgents = diagnosticsPayload.agents.filter((agent) => agent.preset === 'standard');
      const minimalAgents = diagnosticsPayload.agents.filter((agent) => agent.preset === 'minimal');
      reporter.check(
        'GET /agents exposes the server only on the standard-preset agent',
        standardAgents.some((agent) => agent.servers.includes(serverKey) && agent.tools.includes(`mcp__${serverKey}__echo`)) && minimalAgents.some((agent) => agent.servers.length === 0 && agent.tools.length === 0),
        `standard: ${JSON.stringify(standardAgents.map((agent) => agent.tools.length))}, minimal: ${JSON.stringify(minimalAgents.map((agent) => agent.tools.length))}`,
      );
    });

    await reporter.step('tool call round-trip: model -> MCP fixture -> tool result -> model', async () => {
      const toolMarker = `E2E-TOOL-${RUN_ID}`;
      const echoArgument = `fixture-echo-${RUN_ID}`;
      const state = await fixtures.state();
      await fixtures.configure({
        ...state.config,
        markers: [
          ...(state.config.markers ?? []).filter((rule) => !String(rule.match).includes(toolMarker)),
          { match: toolMarker, reply: { kind: 'tool', toolName: `mcp__${serverKey}__echo`, arguments: { text: echoArgument } } },
        ],
      });
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'standard');
      await ui.sendMessage(page, `${toolMarker} 请调用 MCP echo 工具`);

      const followUp = await waitFor(
        async () => {
          const current = await fixtures.state();
          const matches = requestsForMarker(current, toolMarker);
          const withResult = matches.find((request) => (request.toolResultTexts ?? []).some((text) => text.includes(`echo: ${echoArgument}`)));
          return withResult ?? undefined;
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request that contains the MCP tool result' },
      );
      reporter.check(
        'the fixture echo tool actually ran and its output was sent back to the model',
        followUp.toolResultTexts.some((text) => text.includes(`echo: ${echoArgument}`)),
        followUp.toolResultTexts.map((text) => text.slice(0, 80)).join(' | '),
      );
      const assistantToolCalls = (followUp.messages ?? []).flatMap((message) => message.tool_calls ?? []);
      reporter.check(
        'the tool call named the plugin public tool name mcp__<key>__echo',
        assistantToolCalls.some((call) => call.name === `mcp__${serverKey}__echo`),
        assistantToolCalls.map((call) => call.name).join(', '),
      );
      reporter.check('tool result travelled as an OpenAI role=tool message', (followUp.messages ?? []).some((message) => message.role === 'tool'));
      await ui.waitForBodyText(page, `fixture-llm: tool-result-${RUN_ID}`);

      const after = await api.agents();
      reporter.check(
        'after the tool call the standard agent still exposes both MCP tools',
        after.agents.some((agent) => agent.preset === 'standard' && agent.tools.includes(`mcp__${serverKey}__echo`)),
      );
    });

    // ── phase 4: 其他 MCP (preset-owned servers, 0.4.x) ──────────────────
    /** Replace the fake-LLM marker rules with the given ones (others are kept). */
    const configureMarkers = async (entries) => {
      const state = await fixtures.state();
      const replaced = new Set(entries.map((entry) => String(entry.match)));
      await fixtures.configure({
        ...state.config,
        markers: [...(state.config.markers ?? []).filter((rule) => !replaced.has(String(rule.match))), ...entries],
      });
    };

    /** Read one preset-owned tool's effective settings from GET /external. */
    const externalToolPayload = async (presetId, serverName, toolName) => {
      const payload = await api.external();
      const preset = (payload.presets ?? []).find((entry) => entry.id === presetId);
      const server = preset?.servers?.find((entry) => entry.name === serverName);
      return { payload, preset, server, tool: server?.tools?.find((tool) => tool.name === toolName) };
    };

    await reporter.step('其他 MCP tab: compact server list, then per-server tool view', async () => {
      // The owned list keeps working underneath the new page-level tabs.
      await ui.openMcpPage(page);
      const tabs = await ui.pageTabState(page);
      reporter.check(
        'page-level tabs expose 本插件 MCP (default) and 其他 MCP',
        tabs.ownedPressed === 'true' && tabs.externalPressed === 'false' && (await ui.card(page, stdioName).count()) === 1,
        JSON.stringify(tabs),
      );

      // A live Agent of the external preset is what lets the Host see the
      // preset's shipped mcp-client tools (discovery reads tools.view(agent)).
      const discoverMarker = `E2E-EXTERNAL-${RUN_ID}`;
      await configureMarkers([{ match: discoverMarker, reply: { kind: 'text', text: `fixture-llm: external-${RUN_ID}` } }]);
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'external');
      const presetPermission = await ui.currentPermission(page);
      reporter.check('外部MCP测试 preset session starts outside 完全权限', presetPermission !== '完全权限', presetPermission);
      await ui.sendMessage(page, `${discoverMarker} 外部预设会话`);
      const discoverRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, discoverMarker)[0];
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the external-preset model request' },
      );
      const foreignNames = (discoverRequest.tools ?? []).filter((name) => name.startsWith('mcp__foreign__')).sort();
      reporter.check(
        'external-preset session advertises the preset-owned foreign tools',
        JSON.stringify(foreignNames) === JSON.stringify(['mcp__foreign__add', 'mcp__foreign__ping']),
        foreignNames.join(', ') || '(none)',
      );
      await ui.waitForBodyText(page, `fixture-llm: external-${RUN_ID}`);

      // GET /external runs a discovery pass and caches descriptors; the API is
      // unchanged in 0.4.1, only the page defaults to a compact server list.
      const payload = await api.external();
      const presetView = (payload.presets ?? []).find((entry) => entry.id === 'external');
      const serverView = presetView?.servers?.find((entry) => entry.name === 'foreign');
      const pingPayload = serverView?.tools?.find((tool) => tool.name === 'mcp__foreign__ping');
      const addPayload = serverView?.tools?.find((tool) => tool.name === 'mcp__foreign__add');
      reporter.check(
        'GET /external reports the preset, the 预设自带 foreign server and both tools',
        payload.ok === true &&
          typeof payload.scannedAt === 'string' &&
          presetView?.name === '外部MCP测试' &&
          presetView?.hasPresetMcp === true &&
          serverView?.tools?.map((tool) => tool.name).sort().join(',') === 'mcp__foreign__add,mcp__foreign__ping',
        redact(JSON.stringify(presetView ?? null).slice(0, 400)),
      );
      reporter.check(
        'GET /external carries tool descriptions, param chips and default tool settings',
        pingPayload?.description?.includes('echo the given text') &&
          pingPayload?.enabled === true &&
          pingPayload?.approval === false &&
          pingPayload?.params?.some((param) => param.name === 'text' && param.required === true) &&
          addPayload?.enabled === true &&
          addPayload?.approval === false &&
          addPayload?.params?.length === 2 &&
          addPayload.params.every((param) => param.required === false) &&
          addPayload.params.map((param) => param.name).sort().join(',') === 'a,b',
        redact(JSON.stringify({ ping: pingPayload ?? null, add: addPayload ?? null }).slice(0, 500)),
      );

      // ── compact list: preset group -> server card, no tool controls ─────
      await ui.openMcpPage(page);
      await ui.openExternalTab(page);
      const group = ui.externalPresetGroup(page, 'external');
      await group.waitFor({ state: 'visible', timeout: 20_000 });
      const groupText = await group.innerText();
      reporter.check(
        '其他 MCP groups the server under 外部MCP测试 with the 预设自带 badge and foreign name',
        groupText.includes('外部MCP测试') && groupText.includes('预设自带') && groupText.includes('foreign') && groupText.includes('2 个工具'),
        groupText.replaceAll('\n', ' ').slice(0, 220),
      );
      const serverCard = ui.externalServerCard(page, 'external', 'foreign');
      await serverCard.waitFor({ state: 'visible', timeout: 20_000 });
      const listMeta = await ui.externalServerMeta(page, 'external', 'foreign');
      reporter.check(
        'the compact list shows only server cards with a 2/2 个工具已启用 meta (no tool cards/params in the DOM)',
        listMeta.includes('2/2 个工具已启用') &&
          (await page.locator('[data-testid="external-tool-card"]').count()) === 0 &&
          (await page.locator('[data-testid="external-tool-enabled"]').count()) === 0 &&
          (await page.locator('[data-testid="external-tool-param"]').count()) === 0,
        redact(listMeta.replaceAll('\n', ' ').slice(0, 200)),
      );
      const listPanel = page.locator('[data-testid="external-panel"]');
      reporter.check(
        'the compact list never offers add/edit/delete/test of preset-owned servers',
        (await listPanel.locator('[data-testid="add-mcp"]').count()) === 0 &&
          (await listPanel.locator('[data-testid="server-card"]').count()) === 0 &&
          (await listPanel.locator('[data-testid="form-save"]').count()) === 0 &&
          (await listPanel.locator('[data-testid="server-menu"]').count()) === 0,
        `add=${await listPanel.locator('[data-testid="add-mcp"]').count()} cards=${await listPanel.locator('[data-testid="server-card"]').count()}`,
      );
      screenshotArtifacts.push(await ui.screenshotExternalTab(page, join(ARTIFACT_DIR, 'mcp-manager-external.png')));

      // ── drill into the server: same tool cards/testids as before ────────
      await ui.openExternalServer(page, 'external', 'foreign');
      const toolView = await ui.externalToolViewState(page);
      reporter.check(
        'clicking the server card opens the per-server tool view with 已启用 2/2 and both tools',
        toolView.count === '已启用 2/2' &&
          toolView.toolNames.slice().sort().join(',') === 'mcp__foreign__add,mcp__foreign__ping' &&
          toolView.enableAllDisabled === true &&
          toolView.disableAllDisabled === false,
        JSON.stringify({ count: toolView.count, names: toolView.toolNames, enableAllDisabled: toolView.enableAllDisabled, disableAllDisabled: toolView.disableAllDisabled }),
      );
      const pingState = await ui.externalToolState(page, 'mcp__foreign__ping', { presetId: 'external', serverName: 'foreign' });
      const addState = await ui.externalToolState(page, 'mcp__foreign__add', { presetId: 'external', serverName: 'foreign' });
      reporter.check(
        'the per-server tool cards show names, descriptions and required/optional param chips',
        pingState.enabled === 'true' &&
          pingState.approval === 'false' &&
          pingState.description.includes('echo the given text') &&
          pingState.params.some((param) => param.text.includes('text') && param.required === 'true') &&
          addState.enabled === 'true' &&
          addState.params.length === 2 &&
          addState.params.every((param) => param.required === 'false'),
        JSON.stringify({ ping: pingState.params, add: addState.params }),
      );
      const detailView = page.locator('[data-testid="external-server-view"]');
      reporter.check(
        'the per-server tool view never offers add/edit/delete/test either',
        (await detailView.locator('[data-testid="add-mcp"]').count()) === 0 &&
          (await detailView.locator('[data-testid="server-card"]').count()) === 0 &&
          (await detailView.locator('[data-testid="form-save"]').count()) === 0 &&
          (await detailView.locator('[data-testid="server-menu"]').count()) === 0,
        `add=${await detailView.locator('[data-testid="add-mcp"]').count()} cards=${await detailView.locator('[data-testid="server-card"]').count()}`,
      );
      screenshotArtifacts.push(await ui.screenshotExternalTab(page, join(ARTIFACT_DIR, 'mcp-manager-external-tools.png')));
    });

    await reporter.step('其他 MCP tab: hiding a preset-owned tool reaches the live model request', async () => {
      // We are still in the per-server view; disabling a tool saves from there
      // and must keep us on the same view with updated baselines.
      await ui.setExternalToolSwitch(page, 'mcp__foreign__ping', 'enabled', false, { presetId: 'external', serverName: 'foreign' });
      await ui.saveExternalTools(page, 'external');
      const afterDisable = await ui.externalToolViewState(page);
      reporter.check(
        'saving from the per-server view stays there, updates the count to 已启用 1/2 and clears the dirty state',
        (await page.locator('[data-testid="external-server-view"]').count()) === 1 &&
          afterDisable.count === '已启用 1/2' &&
          (await page.locator('[data-testid="external-server-view"] [data-testid="external-save"]').isDisabled()) === true,
        JSON.stringify({ count: afterDisable.count }),
      );
      let settings = await externalToolPayload('external', 'foreign', 'mcp__foreign__ping');
      reporter.check(
        'disabling ping through 其他 MCP persists enabled:false for that preset',
        settings.tool?.enabled === false && settings.tool?.approval === false,
        redact(JSON.stringify(settings.tool ?? null)),
      );
      const hiddenState = await ui.externalToolState(page, 'mcp__foreign__ping', { presetId: 'external', serverName: 'foreign' });
      reporter.check(
        'the disabled external tool card reports the off switch and the disabled note',
        hiddenState.enabled === 'false' && hiddenState.text.includes('已停用'),
        hiddenState.text.replaceAll('\n', ' ').slice(0, 200),
      );

      // Back to the compact list: the server card meta must reflect 1/2.
      await ui.backToExternalList(page);
      const hiddenMeta = await ui.externalServerMeta(page, 'external', 'foreign');
      reporter.check(
        '返回 returns to the compact list with the updated 1/2 个工具已启用 meta and no tool cards',
        hiddenMeta.includes('1/2 个工具已启用') && (await page.locator('[data-testid="external-tool-card"]').count()) === 0,
        redact(hiddenMeta.replaceAll('\n', ' ').slice(0, 200)),
      );

      // Materialize a fresh external-preset Agent, then force a scan so the
      // stored restriction applies before the next model request.
      const materializeMarker = `E2E-EXT-MATERIALIZE-${RUN_ID}`;
      const hiddenMarker = `E2E-EXT-HIDDEN-${RUN_ID}`;
      // Marker rules are checked in order over the whole transcript: the
      // hidden-turn rule must precede the materialize rule, otherwise the
      // materialize text from the same transcript keeps matching first.
      await configureMarkers([
        { match: hiddenMarker, reply: { kind: 'text', text: `fixture-llm: ext-hidden-${RUN_ID}` } },
        { match: materializeMarker, reply: { kind: 'text', text: `fixture-llm: ext-materialize-${RUN_ID}` } },
      ]);
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'external');
      await ui.sendMessage(page, `${materializeMarker} 外部预设隐藏会话`);
      await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, materializeMarker)[0];
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the external-preset materialize request' },
      );
      await ui.waitForBodyText(page, `fixture-llm: ext-materialize-${RUN_ID}`);
      await api.scanExternal();
      await ui.sendMessage(page, `${hiddenMarker} 停用后的外部请求`);
      const hiddenRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, hiddenMarker)[0];
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request after hiding ping' },
      );
      reporter.check(
        'after hiding, the live external-preset model request no longer carries mcp__foreign__ping',
        !(hiddenRequest.tools ?? []).includes('mcp__foreign__ping') && (hiddenRequest.tools ?? []).includes('mcp__foreign__add'),
        (hiddenRequest.tools ?? []).filter((name) => name.startsWith('mcp__foreign__')).join(', ') || '(none)',
      );
      let hiddenBody = '';
      try {
        await ui.waitForBodyText(page, `fixture-llm: ext-hidden-${RUN_ID}`, { timeoutMs: 60_000 });
      } catch {
        hiddenBody = await page.locator('body').innerText().catch(() => '');
      }
      reporter.check(
        'the hidden-tool turn still answers in the session',
        hiddenBody === '',
        hiddenBody === '' ? '' : redact(hiddenBody.replaceAll('\n', ' ').slice(-600)),
      );

      // Re-enable through the per-server view: the compact list comes first,
      // then the foreign card, then the same tool view.
      await ui.openMcpPage(page);
      await ui.openExternalTab(page);
      await ui.openExternalServer(page, 'external', 'foreign');
      await ui.setExternalToolSwitch(page, 'mcp__foreign__ping', 'enabled', true, { presetId: 'external', serverName: 'foreign' });
      await ui.saveExternalTools(page, 'external');
      settings = await externalToolPayload('external', 'foreign', 'mcp__foreign__ping');
      const restoredState = await ui.externalToolState(page, 'mcp__foreign__ping', { presetId: 'external', serverName: 'foreign' });
      reporter.check(
        're-enabling ping through the per-server view restores enabled:true immediately (no rescan needed)',
        settings.tool?.enabled === true && restoredState.enabled === 'true',
        redact(JSON.stringify(settings.tool ?? null)),
      );
      await ui.backToExternalList(page);
      const restoredMeta = await ui.externalServerMeta(page, 'external', 'foreign');
      reporter.check(
        'the compact list meta returns to 2/2 个工具已启用 after the re-enable',
        restoredMeta.includes('2/2 个工具已启用'),
        redact(restoredMeta.replaceAll('\n', ' ').slice(0, 200)),
      );

      const restoredMarker = `E2E-EXT-RESTORED-${RUN_ID}`;
      await configureMarkers([{ match: restoredMarker, reply: { kind: 'text', text: `fixture-llm: ext-restored-${RUN_ID}` } }]);
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'external');
      await ui.sendMessage(page, `${restoredMarker} 恢复后的外部请求`);
      const restoredRequest = await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, restoredMarker)[0];
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request after re-enabling ping' },
      );
      reporter.check(
        'a fresh external-preset session advertises mcp__foreign__ping again',
        (restoredRequest.tools ?? []).includes('mcp__foreign__ping') && (restoredRequest.tools ?? []).includes('mcp__foreign__add'),
        (restoredRequest.tools ?? []).filter((name) => name.startsWith('mcp__foreign__')).join(', ') || '(none)',
      );
    });

    await reporter.step('其他 MCP tab: approval for a preset-owned tool (restricted asks, 完全权限 skips)', async () => {
      // Approvals are enabled from the per-server view as well.
      await ui.openMcpPage(page);
      await ui.openExternalTab(page);
      await ui.openExternalServer(page, 'external', 'foreign');
      await ui.setExternalToolSwitch(page, 'mcp__foreign__add', 'approval', true, { presetId: 'external', serverName: 'foreign' });
      await ui.saveExternalTools(page, 'external');
      let settings = await externalToolPayload('external', 'foreign', 'mcp__foreign__add');
      reporter.check(
        'enabling approval for the foreign add tool persists approval:true',
        settings.tool?.approval === true && settings.tool?.enabled === true,
        redact(JSON.stringify(settings.tool ?? null)),
      );

      // Restricted session: the Host-wide pre-execute policy must ask.
      const approvalMarker = `E2E-EXT-APPROVAL-${RUN_ID}`;
      await configureMarkers([{ match: approvalMarker, reply: { kind: 'tool', toolName: 'mcp__foreign__add', arguments: { a: 2, b: 3 } } }]);
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'external');
      const restrictedPermission = await ui.currentPermission(page);
      reporter.check('the approval external-preset session is restricted (not 完全权限)', restrictedPermission !== '完全权限', restrictedPermission);
      await ui.sendMessage(page, `${approvalMarker} 请调用需要审批的外部 add 工具`);
      const prompt = await ui.waitApprovalPrompt(page, { timeoutMs: 120_000 });
      reporter.check(
        'restricted external-preset session shows the DSH approval composer with the external tool reason',
        prompt.text.includes('等待审批') && prompt.text.includes('需要审批（当前不是完全权限）') && prompt.text.includes('mcp__foreign__add'),
        redact(prompt.text.replaceAll('\n', ' ').slice(0, 320)),
      );
      const pendingState = await fixtures.state();
      reporter.check(
        'the preset-owned tool has not run while the approval is pending',
        requestsForMarker(pendingState, approvalMarker).every((request) => (request.toolResultTexts ?? []).length === 0),
        `requests: ${requestsForMarker(pendingState, approvalMarker).length}`,
      );
      await ui.answerApproval(page, 'allow');
      const approved = await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, approvalMarker).find((request) =>
            (request.toolResultTexts ?? []).some((text) => text.includes('external-add: 5')),
          );
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request containing the approved external-add result' },
      );
      reporter.check(
        '允许一次 executes the preset-owned tool and returns external-add: 5 to the model',
        approved.toolResultTexts.some((text) => text.includes('external-add: 5')),
        approved.toolResultTexts.map((text) => text.slice(0, 60)).join(' | '),
      );
      await ui.waitForBodyText(page, `fixture-llm: tool-result-${RUN_ID}`);
      reporter.check('the approval composer is gone after the decision', (await ui.approvalPromptCount(page)) === 0);

      // 完全权限: the same tool runs without the approval composer.
      const fullMarker = `E2E-EXT-FULL-${RUN_ID}`;
      await configureMarkers([{ match: fullMarker, reply: { kind: 'tool', toolName: 'mcp__foreign__add', arguments: { a: 4, b: 6 } } }]);
      await ui.startNewSession(page);
      await ui.selectPreset(page, 'external');
      await ui.switchPermission(page, '完全权限');
      const fullPermission = await ui.currentPermission(page);
      reporter.check('the second external-preset session runs with 完全权限', fullPermission === '完全权限', fullPermission);
      await ui.sendMessage(page, `${fullMarker} 完全权限直接调用外部 add 工具`);
      const direct = await waitFor(
        async () => {
          const state = await fixtures.state();
          return requestsForMarker(state, fullMarker).find((request) =>
            (request.toolResultTexts ?? []).some((text) => text.includes('external-add: 10')),
          );
        },
        { timeoutMs: 120_000, intervalMs: 500, label: 'the model request containing the direct external-add result' },
      );
      reporter.check(
        '完全权限 skips the approval composer and runs the preset-owned tool directly',
        direct.toolResultTexts.some((text) => text.includes('external-add: 10')) && (await ui.approvalPromptCount(page)) === 0,
        direct.toolResultTexts.map((text) => text.slice(0, 60)).join(' | '),
      );
      await ui.waitForBodyText(page, `fixture-llm: tool-result-${RUN_ID}`);

      // Leave the external settings at their defaults, from the same drill-in.
      await ui.openMcpPage(page);
      await ui.openExternalTab(page);
      await ui.openExternalServer(page, 'external', 'foreign');
      await ui.setExternalToolSwitch(page, 'mcp__foreign__add', 'approval', false, { presetId: 'external', serverName: 'foreign' });
      await ui.saveExternalTools(page, 'external');
      settings = await externalToolPayload('external', 'foreign', 'mcp__foreign__add');
      reporter.check('approval can be turned back off through the per-server view', settings.tool?.approval === false && settings.tool?.enabled === true, redact(JSON.stringify(settings.tool ?? null)));
      await ui.backToExternalList(page);
      const finalMeta = await ui.externalServerMeta(page, 'external', 'foreign');
      reporter.check(
        'the compact list ends at the default state: 2/2 个工具已启用 and no tool cards',
        finalMeta.includes('2/2 个工具已启用') && (await page.locator('[data-testid="external-tool-card"]').count()) === 0,
        redact(finalMeta.replaceAll('\n', ' ').slice(0, 200)),
      );

      // Own-tab regression after the whole external round-trip.
      await ui.openOwnedTab(page);
      const ownedTabs = await ui.pageTabState(page);
      reporter.check(
        '本插件 MCP tab still renders the owned cards after the external round-trip',
        ownedTabs.ownedPressed === 'true' && (await ui.card(page, stdioName).count()) === 1 && (await page.locator('[data-testid="add-mcp"]').count()) === 1,
        JSON.stringify(ownedTabs),
      );
    });

    const icon404s = diagnostics.httpErrors.filter((entry) => entry.status === 404 && /\/better-mcp-manager\/api\/servers\/[^/]+\/icon/.test(entry.url));
    const unexpectedHttp = diagnostics.httpErrors.filter((entry) => !icon404s.includes(entry));
    const explainedConsole = diagnostics.consoleErrors.filter(
      (text) => icon404s.length > 0 && /Failed to load resource: the server responded with a status of 404/.test(text),
    );
    const unexpectedConsole = diagnostics.consoleErrors.filter((text) => !explainedConsole.includes(text));
    reporter.check(
      'no unexpected console/page/network errors (icon 404 fallbacks are the only allowed noise)',
      unexpectedConsole.length === 0 && diagnostics.pageErrors.length === 0 && unexpectedHttp.length === 0,
      redact(
        [
          ...unexpectedConsole,
          ...diagnostics.pageErrors,
          ...unexpectedHttp.map((entry) => `HTTP ${entry.status} ${entry.url}`),
          `expected icon 404s: ${icon404s.length}`,
        ].slice(0, 4).join(' | '),
      ),
    );
  } catch (error) {
    reporter.check('E2E scenario completed without an unexpected error', false, redact(error instanceof Error ? `${error.message}` : String(error)));
    const logs = await collectFailureEvidence({ dsh, fixtures, diagnostics, page });
    if (logs !== '') process.stdout.write(`\n--- failure evidence ---\n${redact(logs)}\n--- end evidence ---\n`);
  } finally {
    await finish({ before, dsh, fixtures, page, diagnostics, screenshotArtifacts });
  }
}

/**
 * Screenshot publishing and cleanup:
 *  - copy the sanitized screenshots into docs/screenshots (< 400 KiB each);
 *  - close the browser, stop both scopes, delete the run directory;
 *  - verify no scopes/processes/listeners/files remain;
 *  - verify production MainPID/cgroup are untouched.
 */
async function finish({ before, dsh, fixtures, page, screenshotArtifacts }) {
  const clean = FLAGS.keep !== true;
  if (clean) {
    await guard('close browser', async () => {
      if (page !== null && page !== undefined) await page.context().close().catch(() => {});
      if (resources.browser !== null) await resources.browser.close().catch(() => {});
      resources.browser = null;
    });
    await guard('stop the isolated DSH scope', async () => {
      if (resources.dsh !== null) await resources.dsh.stop();
      resources.dsh = null;
    });
    await guard('stop the fixture scope', async () => {
      if (resources.fixtures !== null) await resources.fixtures.stop();
      resources.fixtures = null;
    });
  }

  // Publish screenshots only from a fully successful UI pass (the caller has
  // already recorded failures; a missing artifact is a failure, not silence).
  await reporter.step('publish sanitized screenshots to docs/screenshots', async () => {
    const wanted = ['mcp-manager-list.png', 'mcp-manager-sidebar.png', 'mcp-manager-error-detail.png', 'mcp-manager-form-presets.png', 'mcp-manager-form-icon.png', 'mcp-manager-form-tools.png', 'mcp-manager-external.png', 'mcp-manager-external-tools.png'];
    const published = [];
    for (const name of wanted) {
      const source = screenshotArtifacts.find((file) => basename(file) === name);
      if (source === undefined || !existsSync(source)) throw new Error(`missing screenshot artifact ${name}`);
      const { size } = await stat(source);
      if (size > 400 * 1024) throw new Error(`screenshot ${name} is ${formatBytes(size)}, over the 400 KiB budget`);
      await mkdir(DOCS_SCREENSHOT_DIR, { recursive: true });
      const target = join(DOCS_SCREENSHOT_DIR, name);
      await copyFile(source, target);
      published.push(`${name} (${formatBytes(size)})`);
    }
    reporter.check('eight sanitized screenshots published under docs/screenshots', published.length === 8, published.join(', '));
  });

  if (clean) {
    await guard('delete the test DSH_HOME and artifacts', async () => {
      await rm(RUN_DIR, { recursive: true, force: true });
    });
    await reporter.step('residue proof: no scopes, processes, listeners or files left behind', async () => {
      const residual = residualScopes(`mcp-e2e-${RUN_ID}`);
      reporter.check(
        'no transient systemd scope of this run is active or holds processes',
        residual.length === 0,
        residual.map((entry) => `${entry.unit} ${entry.activeState} [${entry.procs.join(',')}]`).join(' | ') || '(none)',
      );
      reporter.debug(`scopes known to systemd for this run: ${listScopes(`mcp-e2e-${RUN_ID}`).join(', ') || '(none)'}`);

      const runProcesses = findProcessesMentioning([RUN_DIR, RUN_ID, PROFILE_NAME]);
      reporter.check('no process mentions the test run id or its paths', runProcesses.length === 0, runProcesses.slice(0, 3).join(' | '));

      const ports = [dsh?.port, fixtures?.fakeLlmPort, fixtures?.mcpPort].filter((port) => Number.isInteger(port));
      const open = [];
      for (const port of ports) if (!(await portClosed(port))) open.push(port);
      reporter.check('all test TCP ports are closed', open.length === 0, open.length === 0 ? `checked ${ports.join(', ')}` : `still listening: ${open.join(', ')}`);

      reporter.check('the test DSH_HOME/run directory is gone', !existsSync(RUN_DIR), RUN_DIR);
    });
  } else {
    reporter.log(`\n--keep: leaving the run for debugging`);
    reporter.log(`  run dir:   ${RUN_DIR}`);
    reporter.log(`  dsh log:   ${dsh?.logPath ?? '(none)'}`);
    reporter.log(`  fixtures log: ${fixtures?.logPath ?? '(none)'}`);
    reporter.log(`  scopes:    ${[...listScopes(`mcp-e2e-${RUN_ID}`), ...listScopes(`mcp-e2e-run-${RUN_ID}`)].join(', ') || '(none)'}`);
    reporter.log('  (the authenticated URL token is only in the dsh log; do not share it)');
    reporter.log(`  stop manually: systemctl stop mcp-e2e-${RUN_ID}-dsh.scope mcp-e2e-${RUN_ID}-fixtures.scope; rm -rf ${RUN_DIR}`);
  }

  await reporter.step('production instance untouched (PID, cgroup, no test processes)', async () => {
    const after = snapshotProduction();
    reporter.log(`production after:  ${describeSnapshot(after)}`);
    reporter.check('production dsh-web.service MainPID unchanged', before.mainPid === after.mainPid && after.mainPid > 0, `${before.mainPid} -> ${after.mainPid}`);
    reporter.check('production dsh-web.service still active', after.activeState === 'active', `${after.activeState}/${after.subState}`);
    reporter.check('production dsh-web.service NRestarts unchanged', before.nRestarts === after.nRestarts, `${before.nRestarts} -> ${after.nRestarts}`);
    reporter.check('production dsh-web.service was not restarted (same ActiveEnterTimestamp)', before.activeEnterTimestamp !== '' && before.activeEnterTimestamp === after.activeEnterTimestamp, `${before.activeEnterTimestamp} -> ${after.activeEnterTimestamp}`);
    const ancestors = ancestorPids();
    const foreign = after.entries.filter(
      (entry) => !ancestors.has(entry.pid) && [RUN_DIR, RUN_ID, 'mcp-e2e-'].some((marker) => entry.cmdline.includes(marker)),
    );
    reporter.check('no test process is charged to the production cgroup', foreign.length === 0, foreign.map((entry) => `${entry.pid} ${entry.cmdline.slice(0, 80)}`).join(' | '));
    reporter.check('production cgroup stays below its MemoryMax', !Number.isFinite(after.memoryMax) || after.memoryCurrent < after.memoryMax, `${formatBytes(after.memoryCurrent)} / ${formatBytes(after.memoryMax)}`);
    reporter.log(`production memory delta: cgroup memory.current ${formatBytes(after.memoryCurrent - before.memoryCurrent)}, PSS ${formatBytes(after.pss - before.pss)}`);
  });

  cleanupDone = true;
  const passed = reporter.summary();
  process.exitCode = passed ? 0 : 1;
}

/** Run one cleanup action; a failure becomes a failed check, never a throw. */
async function guard(name, action) {
  try {
    await action();
    return true;
  } catch (error) {
    reporter.check(`cleanup: ${name}`, false, redact(error instanceof Error ? error.message : String(error)));
    return false;
  }
}

async function collectFailureEvidence({ dsh, fixtures, diagnostics, page }) {
  const parts = [];
  if (dsh !== null && dsh !== undefined) parts.push(`dsh log tail:\n${redact(tailFileSync(readFileSync, dsh.logPath, 6000))}`);
  if (fixtures !== null && fixtures !== undefined) {
    parts.push(`fixtures stderr tail:\n${redact(tailFileSync(readFileSync, fixtures.errPath, 3000))}`);
  }
  if (diagnostics !== null && diagnostics !== undefined) {
    if (diagnostics.consoleErrors.length > 0) parts.push(`console errors:\n${redact(diagnostics.consoleErrors.slice(0, 10).join('\n'))}`);
    if (diagnostics.pageErrors.length > 0) parts.push(`page errors:\n${redact(diagnostics.pageErrors.slice(0, 10).join('\n'))}`);
    if (diagnostics.failedRequests.length > 0) parts.push(`failed requests:\n${redact(diagnostics.failedRequests.slice(0, 10).join('\n'))}`);
  }
  if (page !== null && page !== undefined) {
    try {
      const body = await page.locator('body').innerText({ timeout: 2000 });
      parts.push(`page body tail:\n${redact(body.slice(-2500))}`);
    } catch {
      // browser already gone
    }
  }
  return parts.join('\n\n');
}

// ── small process/port/net helpers ─────────────────────────────────────────

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function portClosed(port) {
  return new Promise((resolveClosed) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (closed) => {
      socket.destroy();
      resolveClosed(closed);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

/** 16x16 PNG dimensions, read from the IHDR chunk. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), size: bytes.length };
}

function sameBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

/** Icon files currently stored for one server id. */
async function iconFilesForId(id) {
  const entries = await readdir(ICONS_DIR).catch(() => []);
  return entries.filter((entry) => entry.startsWith(`${id}.`));
}

async function iconsDirListing() {
  const [entries, info] = await Promise.all([readdir(ICONS_DIR).catch(() => []), stat(ICONS_DIR).catch(() => undefined)]);
  return { entries, mode: info === undefined ? undefined : info.mode & 0o777 };
}

function findProcessesMentioning(needles) {
  const hits = [];
  let entries;
  try {
    entries = readdirSync('/proc', { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (pid === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      if (cmdline !== '' && needles.some((needle) => needle !== undefined && cmdline.includes(needle))) hits.push(`${pid} ${cmdline.slice(0, 200)}`);
    } catch {
      // process exited while scanning
    }
  }
  return hits;
}

// Keep the promise rejection surface explicit: an unexpected throw inside
// finish() must still print a FAIL summary and a non-zero exit code.
main().catch(async (error) => {
  reporter.check('runner finished without an internal error', false, redact(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)));
  if (!cleanupDone) {
    await guard('emergency cleanup', async () => {
      for (const resource of [resources.dsh, resources.fixtures]) if (resource !== null) await resource.stop();
      if (resources.browser !== null) await resources.browser.close();
    });
  }
  reporter.summary();
  process.exitCode = 1;
});
