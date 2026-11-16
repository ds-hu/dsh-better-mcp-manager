/**
 * Read-only production guard.
 *
 * The E2E never starts, stops or reconfigures `dsh-web.service`; it takes a
 * snapshot before and after the run and asserts the production instance is
 * the same process, still active, and holds none of the test's processes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { formatBytes } from './util.mjs';

const UNIT = 'dsh-web.service';
const CGROUP = '/sys/fs/cgroup/system.slice/dsh-web.service';

function systemctlShow(properties) {
  try {
    const args = ['show', ...properties.map((property) => `-p${property}`), '--', UNIT];
    const text = execFileSync('systemctl', args, { encoding: 'utf8', timeout: 10_000 });
    const values = {};
    for (const line of text.split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
    }
    return values;
  } catch {
    return {};
  }
}

function readCgroupNumber(name) {
  try {
    const text = readFileSync(`${CGROUP}/${name}`, 'utf8').trim();
    return text === 'max' ? Infinity : Number.parseInt(text, 10);
  } catch {
    return NaN;
  }
}

/** PIDs in the production cgroup and the /proc identities behind them. */
export function productionProcesses() {
  let pids;
  try {
    pids = readFileSync(`${CGROUP}/cgroup.procs`, 'utf8')
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return { pids: [], entries: [] };
  }
  const entries = pids.map((pid) => {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      return { pid, cmdline };
    } catch {
      return { pid, cmdline: '' };
    }
  });
  return { pids, entries };
}

/** Sum of PSS across production processes (what the service really uses). */
function productionPss(entries) {
  let total = 0;
  for (const entry of entries) {
    try {
      const text = readFileSync(`/proc/${entry.pid}/smaps_rollup`, 'utf8');
      const match = text.match(/^Pss:\s+(\d+) kB/m);
      if (match !== null) total += Number.parseInt(match[1], 10) * 1024;
    } catch {
      // process exited between snapshot and read
    }
  }
  return total;
}

export function snapshotProduction() {
  const show = systemctlShow(['MainPID', 'ActiveState', 'SubState', 'MemoryCurrent', 'MemoryMax', 'MemoryHigh']);
  const { pids, entries } = productionProcesses();
  return {
    at: new Date().toISOString(),
    unit: UNIT,
    mainPid: show.MainPID === undefined ? NaN : Number.parseInt(show.MainPID, 10),
    activeState: show.ActiveState ?? 'unknown',
    subState: show.SubState ?? 'unknown',
    memoryCurrent: readCgroupNumber('memory.current'),
    memoryHigh: readCgroupNumber('memory.high'),
    memoryMax: readCgroupNumber('memory.max'),
    pss: productionPss(entries),
    pids,
    entries,
  };
}

/** Human-readable one-liner for the run report. */
export function describeSnapshot(snapshot) {
  return `pid ${snapshot.mainPid} ${snapshot.activeState}/${snapshot.subState}, cgroup memory.current ${formatBytes(snapshot.memoryCurrent)}, PSS ${formatBytes(snapshot.pss)}, ${snapshot.pids.length} PIDs`;
}

/**
 * Assert the production instance was not disturbed:
 *  - same MainPID, still active;
 *  - none of its cgroup processes belong to the test run (no test path in cmdline);
 *  - cgroup memory.current is below memory.max (never driven into OOM).
 *
 * Returns the list of failed conditions as strings (empty = pass).
 */
export function productionProblems(before, after, { runDir }) {
  const problems = [];
  if (!Number.isInteger(before.mainPid) || before.mainPid <= 0) {
    problems.push(`could not read production MainPID before the run (${before.mainPid})`);
  }
  if (after.mainPid !== before.mainPid) {
    problems.push(`production MainPID changed: ${before.mainPid} -> ${after.mainPid}`);
  }
  if (after.activeState !== 'active') {
    problems.push(`production service is ${after.activeState}, expected active`);
  }
  const markers = [runDir, 'mcp-e2e-'];
  const foreign = after.entries.filter((entry) => markers.some((marker) => marker !== undefined && entry.cmdline.includes(marker)));
  if (foreign.length > 0) {
    problems.push(`test processes found inside production cgroup: ${foreign.map((entry) => `${entry.pid} ${entry.cmdline.slice(0, 120)}`).join('; ')}`);
  }
  if (Number.isFinite(after.memoryMax) && after.memoryCurrent >= after.memoryMax) {
    problems.push(`production cgroup at/above MemoryMax (${formatBytes(after.memoryCurrent)} / ${formatBytes(after.memoryMax)})`);
  }
  return problems;
}
