/**
 * Isolated profile lifecycle for the E2E.
 *
 * Everything lives under a unique /var/tmp/dsh-mcp-e2e-<runid> directory:
 *
 *   home/            DSH_HOME (profiles, sessions, plugin data)
 *   userhome/        HOME of the test instance (workspace picker root)
 *   tmp/             packed tarball destination
 *   logs/            test-instance and install logs
 *
 * The profile is a fresh copy of the shipped `web` template. The plugin is
 * installed from the *packed tarball* with `dsh plugin add`, exactly like a
 * production install, so `@modelcontextprotocol/client` resolves from the
 * registry inside the profile rather than from this repo or the DSH install.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { waitFor, redact } from './util.mjs';
import { startScoped, readLog } from './scope.mjs';

const execFileAsync = promisify(execFile);

export const PACKAGE_NAME = '@ds-hu/dsh-better-mcp-manager';
export const PROFILE_TEMPLATE = 'web';

/** Resolve the `dsh` CLI once (symlink on PATH, otherwise the documented install). */
export function resolveDshBin() {
  try {
    return execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
  } catch {
    return '/usr/local/bin/dsh';
  }
}

/** Child environment for the test instance: no inherited profile/home pointers. */
export function isolatedEnv({ dshHome, homeDir, extra = {} }) {
  const env = { ...process.env };
  delete env.DSH_PROFILE;
  delete env.DSH_PROFILE_DIR;
  delete env.DSH_WEB_URL;
  delete env.DSH_HOME;
  delete env.DSH_WEB_PORT;
  env.HOME = homeDir;
  env.DSH_HOME = dshHome;
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  const tmpDir = join(dshHome, '..', 'tmp');
  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;
  return { ...env, ...extra };
}

/**
 * Pack the repo under test into `<runDir>/tmp/pack`. Always repacks: a stale
 * tarball would test the previous run's code instead of the working tree.
 */
export async function packPlugin({ repoRoot, runDir }) {
  const destination = join(runDir, 'tmp', 'pack');
  await mkdir(destination, { recursive: true });
  const { stdout, stderr } = await execFileAsync('npm', ['pack', '--pack-destination', destination], {
    cwd: repoRoot,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: 'warn' },
  });
  const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '');
  const filename = lines.at(-1)?.trim();
  const tarball = filename === undefined ? undefined : join(destination, filename);
  if (tarball === undefined || !existsSync(tarball)) {
    throw new Error(`npm pack did not produce a tarball. stdout=${redact(stdout)}\nstderr=${redact(stderr)}`);
  }
  return { tarball, filename, stdout: redact(stdout), stderr: redact(stderr) };
}

/** Create a fresh custom profile from the shipped web template. */
export async function createFreshProfile({ repoRoot, runDir, dshHome, homeDir, profileName, profileDir }) {
  await mkdir(homeDir, { recursive: true });
  const env = isolatedEnv({ dshHome, homeDir });
  const dsh = resolveDshBin();
  const { stdout, stderr } = await execFileAsync(
    dsh,
    ['--profile', profileName, '--from-default-profile', PROFILE_TEMPLATE, '--dump-config'],
    { cwd: repoRoot, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  // `--dump-config` prints the composed tree; keep a copy for failure triage.
  writeFileSync(join(runDir, 'logs', 'composed-profile.yaml'), stdout);
  if (stderr.trim() !== '') writeFileSync(join(runDir, 'logs', 'composed-profile.stderr.log'), stderr);
  for (const required of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    if (!existsSync(join(profileDir, required))) throw new Error(`fresh profile is missing ${required} in ${profileDir}`);
  }
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('@deepseek-ai/dsh-base') || !bundles.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error(`fresh profile is not the shipped web template: bundles=${JSON.stringify(bundles)}`);
  }
  return { bundles };
}

/**
 * The test profile's user patch layer: route the default model at the fake
 * local OpenAI-compatible endpoint. Written before boot; the provider needs no
 * credential because the Authorization header is supplied by the provider
 * profile itself (documented "deliberately unauthenticated route" path).
 */
export function writeProfilePatch({ profileDir, fakeBaseURL, externalPreset }) {
  const externalRow = externalPreset === undefined ? '' : `
# 0.4.0: a preset-owned MCP server ("其他 MCP"). The row mounts the shipped
# MCP client plugin against the fixture copied into the run directory; our own
# plugin must discover it through the preset, never spawn it itself.
- insert:
    - id: preset-external
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${externalPreset.presetId}
        name: ${externalPreset.presetName}
        order: ${externalPreset.order}
        plugins:
          - id: mcp-foreign
            name: '${EXTERNAL_MCP_CLIENT_PACKAGE}'
            config:
              serverName: ${externalPreset.serverName}
              transport: stdio
              command: ${JSON.stringify(externalPreset.nodePath)}
              args:
                - ${JSON.stringify(externalPreset.fixturePath)}
              failOnStartupError: true
`;
  const patch = `# Isolated E2E profile patch — generated by test/e2e/run.mjs, do not reuse.
# Routes the default model at the local fake OpenAI-compatible fixture.
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      fake-local:
        displayName: Fake Local (e2e)
        api: openai-completions
        baseURL: ${fakeBaseURL}
        headers:
          Authorization: Bearer fixture-key
        models:
          - id: fixture-model
            name: fixture-model
            contextWindow: 262144
            input:
              - text
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: fake-local
    model: fixture-model
${externalRow}`;
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch);
}

/** Append the plugin bundle to `dsh.profile.bundles` (idempotent). */
export function addBundleToManifest({ profileDir }) {
  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error(`profile manifest has no dsh.profile.bundles: ${manifestPath}`);
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return bundles;
}

/**
 * Install the packed tarball with the profile's package manager, the same way
 * a user installs a plugin. Network access for `@modelcontextprotocol/client`
 * goes through the machine's proxy (already in the environment).
 */
export async function installPackedPlugin({ repoRoot, runDir, dshHome, homeDir, profileName, profileDir, tarball }) {
  const env = isolatedEnv({ dshHome, homeDir });
  const dsh = resolveDshBin();
  const logPath = join(runDir, 'logs', 'plugin-install.log');
  let result;
  try {
    result = await execFileAsync(dsh, ['plugin', '--profile', profileName, 'add', tarball], {
      cwd: repoRoot,
      env,
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = redact(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? error}`);
    writeFileSync(logPath, detail);
    throw new Error(`dsh plugin add failed (network install of @modelcontextprotocol/client may be blocked):\n${detail.slice(-4000)}`, { cause: error });
  }
  writeFileSync(logPath, redact(`${result.stdout}\n${result.stderr}`));

  const installedManifest = join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json');
  if (!existsSync(installedManifest)) throw new Error(`plugin package is not installed at ${installedManifest}`);
  const installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
  if (installed.version !== JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version) {
    throw new Error(`installed version ${installed.version} does not match the working tree package.json`);
  }
  const mcpClientManifest = join(profileDir, 'node_modules', '@modelcontextprotocol', 'client', 'package.json');
  if (!existsSync(mcpClientManifest)) {
    throw new Error(`@modelcontextprotocol/client is not installed in the profile (${mcpClientManifest})`);
  }
  const mcpVersion = JSON.parse(readFileSync(mcpClientManifest, 'utf8')).version;
  if (mcpVersion !== installed.dependencies?.['@modelcontextprotocol/client'] && installed.dependencies?.['@modelcontextprotocol/client'] !== undefined) {
    throw new Error(`@modelcontextprotocol/client version ${mcpVersion} does not satisfy ${installed.dependencies['@modelcontextprotocol/client']}`);
  }
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  if (!(manifest.dependencies ?? {})[PACKAGE_NAME]) {
    throw new Error('dsh plugin add did not record the dependency in the test profile package.json');
  }
  return { installedVersion: installed.version, mcpClientVersion: mcpVersion, logPath, stdout: redact(result.stdout) };
}

export const FIXTURE_STDIO_SCRIPT = 'test/fixtures/mcp-stdio-server.mjs';
export const FIXTURE_EXTERNAL_SCRIPT = 'test/fixtures/mcp-external-server.mjs';

/** The shipped MCP client plugin preset-owned servers ride on (0.4.0). */
export const EXTERNAL_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/**
 * Install the shipped MCP client package into the isolated profile. Unlike the
 * agent-preset/llm plugins it is not part of the shipped web bundles, so the
 * external-preset row cannot resolve it until it is a profile dependency.
 * @param {{repoRoot?: string, runDir: string, dshHome: string, homeDir: string, profileName: string, profileDir: string}} options - install context.
 * @returns {Promise<{version: string}>} installed version.
 */
export async function installExternalMcpClient({ runDir, dshHome, homeDir, profileName, profileDir }) {
  const env = isolatedEnv({ dshHome, homeDir });
  const dsh = resolveDshBin();
  let version;
  try {
    version = execFileSync(dsh, ['--version'], { encoding: 'utf8', env, timeout: 30_000 }).trim().split('\n')[0].trim();
  } catch (error) {
    throw new Error(`could not read the dsh version needed for ${EXTERNAL_MCP_CLIENT_PACKAGE}: ${error?.message ?? error}`, { cause: error });
  }
  if (version === '') throw new Error('dsh --version printed nothing');
  const bundled = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client';
  const logPath = join(runDir, 'logs', 'external-mcp-client-install.log');
  /** Try the exact registry version first, then the published fallback, then a local link. */
  const attempts = [
    { mode: 'registry', spec: `${EXTERNAL_MCP_CLIENT_PACKAGE}@${version}` },
    { mode: 'registry-fallback', spec: `${EXTERNAL_MCP_CLIENT_PACKAGE}@0.2.1-rc.5` },
    { mode: 'link', spec: `link:${bundled}` },
  ];
  const failures = [];
  let installedManifest;
  let mode = '';
  for (const attempt of attempts) {
    try {
      const result = await execFileAsync(dsh, ['plugin', '--profile', profileName, 'add', attempt.spec], {
        cwd: dshHome,
        env,
        timeout: 240_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      writeFileSync(logPath, redact(`mode: ${attempt.mode} (${attempt.spec})\n${result.stdout}\n${result.stderr}`));
      installedManifest = join(profileDir, 'node_modules', EXTERNAL_MCP_CLIENT_PACKAGE, 'package.json');
      if (existsSync(installedManifest)) {
        mode = attempt.mode;
        break;
      }
      failures.push(`${attempt.mode}: installed command succeeded but ${installedManifest} is missing`);
    } catch (error) {
      const detail = redact(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? error}`);
      failures.push(`${attempt.mode} (${attempt.spec}): ${detail.slice(-1200)}`);
    }
  }
  if (mode === '' || installedManifest === undefined || !existsSync(installedManifest)) {
    writeFileSync(logPath, failures.join('\n---\n'));
    throw new Error(`installing ${EXTERNAL_MCP_CLIENT_PACKAGE} into the test profile failed; tried registry, fallback and link:\n${failures.join('\n---\n').slice(-4000)}`);
  }
  const installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
  if (mode === 'link' && installed.version === undefined) throw new Error('linked MCP client package has no version');
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  if (!(manifest.dependencies ?? {})[EXTERNAL_MCP_CLIENT_PACKAGE]) {
    throw new Error(`${EXTERNAL_MCP_CLIENT_PACKAGE} was not recorded in the test profile package.json`);
  }
  return { version: installed.version, mode };
}

/**
 * Boot the isolated DSH web instance in its own scope and wait for the
 * authenticated URL it prints. The token stays in memory: callers may report
 * {@link safeOrigin} but must never log the full URL.
 */
export async function bootDsh({ repoRoot, runDir, dshHome, homeDir, profileName, port, reporter }) {
  const dsh = resolveDshBin();
  const unit = `mcp-e2e-${runDir.split('dsh-mcp-e2e-').at(-1)}-dsh`;
  const logPath = join(runDir, 'logs', 'dsh.log');
  const errPath = join(runDir, 'logs', 'dsh.stderr.log');
  const env = isolatedEnv({ dshHome, homeDir });
  const handle = startScoped({
    unit,
    memoryMax: '1G',
    command: dsh,
    args: [
      '--profile',
      profileName,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-open',
      '--trusted-host',
      `127.0.0.1:${port}`,
    ],
    env,
    cwd: repoRoot,
    logPath,
    errPath,
  });

  let url;
  try {
    url = await waitFor(
      async () => {
        const text = await readLog(logPath, 256 * 1024);
        const match = text.match(/dsh web:\s*(http:\/\/\S+)/);
        if (match !== null) return match[1];
        const exited = handle.child.exitCode;
        if (exited !== null) {
          const stderr = await readLog(errPath, 8192);
          throw new Error(`test DSH exited with code ${exited} before printing its URL:\n${redact(stderr)}`);
        }
        return undefined;
      },
      { timeoutMs: 120_000, intervalMs: 300, label: 'the isolated DSH web URL' },
    );
  } catch (error) {
    const [log, err] = await Promise.all([readLog(logPath, 8192), readLog(errPath, 8192)]);
    await handle.stop().catch(() => {});
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- dsh.log ---\n${redact(log)}\n--- dsh.stderr.log ---\n${redact(err)}`, { cause: error });
  }

  const parsed = new URL(url);
  if (parsed.searchParams.get('token') === null || parsed.searchParams.get('token') === '') {
    await handle.stop().catch(() => {});
    throw new Error('the printed DSH URL has no token query parameter');
  }
  const origin = `http://${parsed.host}`;
  if (parsed.port === '3080') {
    await handle.stop().catch(() => {});
    throw new Error('the test instance was told to bind the production port 3080');
  }
  reporter?.debug(`test DSH URL printed (token redacted): ${redact(url)}`);
  return { ...handle, url, origin, port, logPath, errPath };
}

/** Read the boot log and report error-looking lines that mention this plugin. */
export async function scanBootLog({ logPath, errPath }) {
  const [log, err] = await Promise.all([readLog(logPath, 512 * 1024), readLog(errPath, 512 * 1024)]);
  const lines = `${log}\n${err}`.split('\n');
  const suspicious = lines.filter((line) => /better-mcp-manager/i.test(line) && /(error|warn|fail|duplicate|conflict)/i.test(line));
  const duplicate = lines.filter((line) => /duplicate/i.test(line));
  return { log, err, suspicious, duplicate };
}
