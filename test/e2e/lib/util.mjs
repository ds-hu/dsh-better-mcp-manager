/**
 * Small shared utilities for the isolated E2E runner.
 *
 * Nothing in here touches the network or the file system beyond its arguments.
 */
import { randomBytes } from 'node:crypto';

/** Short unique run id used for scope units, DSH_HOME names and fixture markers. */
export function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `fn` until it returns a truthy value, then return that value.
 * Throws with the last error (or a timeout message) when the deadline passes.
 */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError === undefined ? '' : `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/** Strip the authenticated URL token from anything that may be printed or saved. */
export function redact(text) {
  return String(text ?? '').replace(/(token=)[A-Za-z0-9_-]+/g, '$1<redacted>');
}

/** Last `bytes` of a text file as a string; missing files answer ''. */
export function tailFileSync(readFile, path, bytes = 4096) {
  try {
    const text = readFile(path, 'utf8');
    return text.length > bytes ? `…${text.slice(-bytes)}` : text;
  } catch {
    return '';
  }
}

/** 1.2 MiB style formatting for the production-memory report. */
export function formatBytes(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

/** Parse one JSON line from a growing log file, waiting for it to appear. */
export async function waitForJsonLine(readFile, path, { timeoutMs = 20_000, label = 'JSON line' } = {}) {
  return waitFor(
    () => {
      const text = readFile(path, 'utf8');
      const line = text.split('\n').find((candidate) => candidate.trim().startsWith('{'));
      if (line === undefined) return undefined;
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    },
    { timeoutMs, label },
  );
}

/**
 * Collects named checks and prints a PASS/FAIL summary. A thrown error inside
 * {@link Reporter#step} marks that step failed and records the message.
 */
export class Reporter {
  constructor({ verbose = false } = {}) {
    this.verbose = verbose;
    this.checks = [];
    this.steps = 0;
  }

  log(...parts) {
    process.stdout.write(`${parts.join(' ')}\n`);
  }

  debug(...parts) {
    if (this.verbose) process.stdout.write(`[debug] ${parts.join(' ')}\n`);
  }

  check(name, condition, detail = '') {
    const ok = condition === true;
    this.checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}\n`);
    if (!ok) this.failures ??= [];
    if (!ok) (this.failures ??= []).push({ name, detail });
    return ok;
  }

  /** Run one named step; a throw records a failure instead of aborting the run. */
  async step(name, fn) {
    this.steps += 1;
    process.stdout.write(`\n[${this.steps}] ${name}\n`);
    try {
      const detail = await fn();
      if (detail !== undefined) this.debug(redact(String(detail)));
      return { ok: true, value: detail };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.check(name, false, redact(message));
      return { ok: false, error };
    }
  }

  get failed() {
    return this.checks.filter((check) => !check.ok);
  }

  summary() {
    const passed = this.checks.length - this.failed.length;
    process.stdout.write(`\n${'─'.repeat(72)}\n`);
    if (this.failed.length === 0) {
      process.stdout.write(`PASS: ${passed}/${this.checks.length} checks passed\n`);
      return true;
    }
    process.stdout.write(`FAIL: ${this.failed.length}/${this.checks.length} checks failed\n`);
    for (const failure of this.failed) {
      process.stdout.write(`  ✗ ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}\n`);
    }
    return false;
  }
}
