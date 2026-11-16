/**
 * Cleanup CLI unit tests.
 *
 * `bin/mcp-manager.mjs` is what a user runs after removing the bundle, so it
 * must be safe: it prints the data directory, never deletes without `--yes`,
 * and refuses a directory that is not the plugin's own data directory. Every
 * test runs it as a child process with `DSH_HOME` pointed at a temp directory.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin/mcp-manager.mjs');

/**
 * Run the CLI with an isolated environment.
 * @param {object} options - `args`, `env`, `cwd`.
 * @returns {{ status: number, stdout: string, stderr: string }} the result.
 */
function run({ args = [], env = {}, cwd = root } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_MCP_MANAGER_DATA_DIR: '', DSH_HOME: '', ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

/**
 * One isolated home directory with its plugin data directory.
 * @param {object} t - node:test context.
 * @returns {{ base: string, home: string, dataDir: string }} the paths.
 */
async function isolatedHome(t) {
  const base = await mkdtemp(join(tmpdir(), 'mcp-manager-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  await mkdir(home, { recursive: true });
  return { base, home, dataDir: join(home, 'better-mcp-manager') };
}

/** One valid store file. */
function store(servers) {
  return `${JSON.stringify({ version: 1, servers }, null, 2)}\n`;
}

const enabled = { id: 'srv_1f3c9a2b70', key: 'alpha', name: 'Alpha', enabled: true, transport: 'http', headers: [], oauth: { mode: 'none' } };
const disabled = { id: 'srv_2a4d8e0c13', key: 'beta', name: 'Beta', enabled: false, transport: 'sse', headers: [], oauth: { mode: 'none' } };

test('cli: path prints the effective data directory', async (t) => {
  const { home, dataDir } = await isolatedHome(t);
  const result = run({ args: ['path'], env: { DSH_HOME: home } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), dataDir);
});

test('cli: status on a never-used home reports absence without failing', async (t) => {
  const { home } = await isolatedHome(t);
  const result = run({ args: ['status'], env: { DSH_HOME: home } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /state: absent/u);
});

test('cli: status reads the store and counts enabled servers', async (t) => {
  const { home, dataDir } = await isolatedHome(t);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'servers.json'), store([enabled, disabled]));
  const result = run({ args: ['status'], env: { DSH_HOME: home } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /schema v1/u);
  assert.match(result.stdout, /servers: 2 \(1 enabled\)/u);
  assert.match(result.stdout, /Alpha/u);
  assert.match(result.stdout, /Beta/u);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
});

test('cli: status reports a damaged store with exit code 1', async (t) => {
  const { home, dataDir } = await isolatedHome(t);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'servers.json'), '{ definitely not json');
  const result = run({ args: ['status'], env: { DSH_HOME: home } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /damaged/u);
});

test('cli: clean refuses without --yes and keeps the data', async (t) => {
  const { home, dataDir } = await isolatedHome(t);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'servers.json'), store([]));
  const result = run({ args: ['clean'], env: { DSH_HOME: home } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to delete/u);
  assert.equal(existsSync(dataDir), true);
});

test('cli: clean --yes removes the data directory', async (t) => {
  const { home, dataDir } = await isolatedHome(t);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'servers.json'), store([]));
  const result = run({ args: ['clean', '--yes'], env: { DSH_HOME: home } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /removed/u);
  assert.equal(existsSync(dataDir), false);
  const again = run({ args: ['clean', '--yes'], env: { DSH_HOME: home } });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to remove/u);
});

test('cli: clean refuses a directory that is not the plugin data directory', async (t) => {
  const { base } = await isolatedHome(t);
  const foreign = join(base, 'somewhere-else');
  await mkdir(foreign, { recursive: true });
  // A relative override resolves elsewhere than the raw value, so the guard
  // refuses: this is the "never delete an arbitrary directory" behaviour.
  const result = run({
    args: ['clean', '--yes'],
    env: { DSH_MCP_MANAGER_DATA_DIR: 'somewhere-else' },
    cwd: base,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to delete/u);
  assert.equal(existsSync(foreign), true);
});

test('cli: unknown commands and help are handled', async (t) => {
  const { home } = await isolatedHome(t);
  const unknown = run({ args: ['frobnicate'], env: { DSH_HOME: home } });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: frobnicate/u);
  assert.match(unknown.stdout, /usage:/u);

  const help = run({ args: ['--help'], env: { DSH_HOME: home } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /commands:/u);
  assert.match(help.stdout, /clean --yes/u);
});
