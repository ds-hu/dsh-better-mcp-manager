/**
 * systemd-scope plumbing for the isolated E2E.
 *
 * Every long-running process the E2E starts (the test DSH instance, the
 * fixture HTTP servers) runs inside its own transient scope with
 * `MemoryMax=1G`/`MemoryMax=256M` and `MemorySwapMax=0`, so none of it is
 * accounted in the production `dsh-web.service` cgroup (MemoryMax=4G). The
 * runner itself re-executes into a scope for the same reason: Playwright's
 * chromium children are charged to their parent's cgroup.
 *
 * All units are named `mcp-e2e-<runid>-…`, which makes residue checks exact.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep, waitFor } from './util.mjs';

const SYSTEMD_RUN = '/usr/bin/systemd-run';

/** The caller's own cgroup path from /proc/self/cgroup (`0::/…`). */
export function currentCgroup() {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    return line === undefined ? '' : line.slice(3);
  } catch {
    return '';
  }
}

/** True when this process is accounted in the production DSH service cgroup. */
export function inProductionCgroup() {
  return currentCgroup().includes('/system.slice/dsh-web.service');
}

function haveSystemdRun() {
  return existsSync(SYSTEMD_RUN);
}

/**
 * Re-exec the runner inside a fresh `systemd-run --scope` unit when it is not
 * already scoped. Returns the child's exit code when a re-exec happened, and
 * `undefined` when the current process should continue.
 */
export async function reexecInScope({ runId, argv }) {
  if (process.env.MCP_E2E_SCOPED === '1') return undefined;
  if (process.env.MCP_E2E_NO_SCOPE === '1') {
    process.stderr.write('[e2e] MCP_E2E_NO_SCOPE=1: staying in the caller cgroup (unsafe near production)\n');
    return undefined;
  }
  if (!haveSystemdRun()) {
    process.stderr.write('[e2e] systemd-run not found; continuing without a private cgroup\n');
    return undefined;
  }
  const unit = `mcp-e2e-run-${runId}`;
  const child = spawn(
    SYSTEMD_RUN,
    [
      '--scope',
      '-p',
      'MemoryMax=1G',
      '-p',
      'MemorySwapMax=0',
      '-p',
      'TimeoutStopSec=10',
      '--unit',
      unit,
      '--quiet',
      '--setenv=MCP_E2E_SCOPED=1',
      '--setenv=MCP_E2E_RUN_UNIT=' + unit,
      '--',
      process.execPath,
      ...argv,
    ],
    { stdio: 'inherit', env: { ...process.env, MCP_E2E_SCOPED: '1', MCP_E2E_RUN_UNIT: unit } },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
  // The runner's own transient scope can stay `active (Tasks: 0)` after the
  // child exits when systemd failed to install its cgroup inotify watch (seen on
  // this host under watch pressure). Stop it from the outside so no zombie scope
  // accumulates between runs; the unit name is exact, so this is safe.
  for (const command of ['stop', 'reset-failed']) {
    try {
      execFileSync('systemctl', [command, `${unit}.scope`], { stdio: 'ignore', timeout: 10_000 });
    } catch {
      // already gone
    }
  }
  return exitCode;
}

/**
 * Start a command inside its own transient scope.
 *
 * @returns {{ unit: string, child: import('node:child_process').ChildProcess, logPath: string, errPath: string, stop: () => Promise<void>, waitExit: () => Promise<void> }}
 */
export function startScoped({ unit, memoryMax = '1G', command, args = [], env = {}, logPath, errPath, cwd }) {
  if (!haveSystemdRun()) throw new Error('systemd-run is required for the isolated E2E but was not found at /usr/bin/systemd-run');
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(dirname(errPath), { recursive: true });
  const outFd = openSync(logPath, 'w');
  const errFd = openSync(errPath, 'w');
  const child = spawn(
    SYSTEMD_RUN,
    [
      '--scope',
      '-p',
      `MemoryMax=${memoryMax}`,
      '-p',
      'MemorySwapMax=0',
      '-p',
      'TimeoutStopSec=5',
      '--unit',
      unit,
      '--quiet',
      '--',
      command,
      ...args,
    ],
    { cwd, env: { ...process.env, ...env }, stdio: ['ignore', outFd, errFd] },
  );
  closeSync(outFd);
  closeSync(errFd);
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => resolve({ code: 1, signal: null, error }));
  });
  return {
    unit,
    child,
    logPath,
    errPath,
    waitExit: () => exitPromise,
    stop: () => stopUnit(unit),
    /** PIDs currently charged to the scope (empty after it is gone). */
    pids: () => cgroupProcs(unit),
  };
}

function parseShow(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

/** `systemctl show` state for a transient scope, without throwing when absent. */
export function unitState(unit) {
  const scoped = unit.endsWith('.scope') ? unit : `${unit}.scope`;
  try {
    const text = execFileSync('systemctl', ['show', '-p', 'LoadState', '-p', 'ActiveState', '--', scoped], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return parseShow(text);
  } catch (error) {
    return { LoadState: 'unknown', ActiveState: 'unknown', error: String(error) };
  }
}

/** Every unit currently known to systemd whose name starts with `prefix`. */
export function listScopes(prefix = 'mcp-e2e-') {
  try {
    const text = execFileSync('systemctl', ['list-units', '--all', '--no-legend', '--plain', `${prefix}*`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return text
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== undefined && name.endsWith('.scope'));
  } catch {
    return [];
  }
}

/** PIDs in a scope's cgroup, or [] when the scope is already gone. */
export function cgroupProcs(unit) {
  const scoped = unit.endsWith('.scope') ? unit : `${unit}.scope`;
  try {
    const text = readFileSync(`/sys/fs/cgroup/system.slice/${scoped}/cgroup.procs`, 'utf8');
    return text
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** Stop a transient scope and wait until its processes are gone. */
export async function stopUnit(unit, { timeoutMs = 20_000, reporter } = {}) {
  const scoped = unit.endsWith('.scope') ? unit : `${unit}.scope`;
  try {
    execFileSync('systemctl', ['stop', scoped], { encoding: 'utf8', timeout: 15_000 });
  } catch (error) {
    reporter?.debug(`systemctl stop ${scoped}: ${String(error).slice(0, 200)}`);
  }
  let state = unitState(scoped);
  try {
    await waitFor(
      () => {
        state = unitState(scoped);
        const gone = state.LoadState === 'not-found' || state.LoadState === 'unknown' || state.ActiveState === 'inactive' || state.ActiveState === 'failed';
        return gone && cgroupProcs(scoped).length === 0;
      },
      { timeoutMs, intervalMs: 200, label: `${scoped} to stop` },
    );
  } catch {
    try {
      execFileSync('systemctl', ['kill', '-s', 'SIGKILL', scoped], { encoding: 'utf8', timeout: 10_000 });
    } catch {
      // already gone
    }
    await sleep(300);
    try {
      await waitFor(
        () => cgroupProcs(scoped).length === 0 && !['active', 'activating'].includes(unitState(scoped).ActiveState ?? ''),
        { timeoutMs: 6000, intervalMs: 200, label: `${scoped} to lose its processes` },
      );
    } catch {
      // fall through to the final state check below
    }
  }
  try {
    execFileSync('systemctl', ['reset-failed', scoped], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // nothing to reset
  }
  const procs = cgroupProcs(scoped);
  if (procs.length > 0) throw new Error(`${scoped} still has PIDs after stop: ${procs.join(', ')}`);
  const final = unitState(scoped);
  if (final.ActiveState === 'active' || final.ActiveState === 'activating') {
    throw new Error(`${scoped} is still ${final.ActiveState} after stop`);
  }
  if (final.ActiveState === 'deactivating') {
    // A failed cgroup inotify watch can leave a process-less transient scope in
    // `deactivating` until its TimeoutStopSec fires. No process remains charged
    // to it, so this is systemd bookkeeping, not residue.
    reporter?.debug(`${scoped} is empty but still deactivating; systemd will collect it within TimeoutStopSec`);
  }
}

/**
 * Scopes of this run that still hold live processes or are running.
 * @param {string} prefix - unit name prefix.
 * @returns {{ unit: string, activeState: string, procs: number[] }[]} leftovers.
 */
export function residualScopes(prefix = 'mcp-e2e-') {
  const leftover = [];
  for (const unit of listScopes(prefix)) {
    const state = unitState(unit);
    const procs = cgroupProcs(unit);
    if (procs.length > 0 || ['active', 'activating', 'reloading'].includes(state.ActiveState ?? '')) {
      leftover.push({ unit, activeState: state.ActiveState ?? 'unknown', procs });
    }
  }
  return leftover;
}

/** Async tail helper for a scoped process's stderr/stdout log. */
export async function readLog(path, bytes = 8192) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > bytes ? `…${text.slice(-bytes)}` : text;
  } catch {
    return '';
  }
}
