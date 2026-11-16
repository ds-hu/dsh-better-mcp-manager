/**
 * Playwright acquisition and page diagnostics.
 *
 * The repo does not depend on Playwright: the E2E uses this machine's global
 * Playwright 1.64 (or a local install when present), resolved at run time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function candidateEntries() {
  const entries = [];
  for (const variable of ['PW_PLAYWRIGHT_ENTRY']) if (process.env[variable]) entries.push(process.env[variable]);
  if (process.env.PW_GLOBAL_ROOT) entries.push(join(process.env.PW_GLOBAL_ROOT, 'playwright', 'index.mjs'));
  entries.push('/usr/local/lib/node_modules/playwright/index.mjs');
  entries.push('/usr/lib/node_modules/playwright/index.mjs');
  return entries;
}

/** Import Playwright, local dependency first, then the global install. */
export async function loadPlaywright() {
  try {
    return { module: await import('playwright'), source: 'local dependency' };
  } catch {
    // fall through to the global runtime
  }
  for (const entry of candidateEntries()) {
    if (!existsSync(entry)) continue;
    const directory = join(entry, '..');
    let version = 'unknown';
    try {
      version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
    } catch {
      // keep "unknown"
    }
    return { module: await import(entry), source: `global ${entry} (${version})` };
  }
  throw new Error(
    'Playwright is not installed. Install playwright and its chromium (the machine-wide /usr/local/lib/node_modules/playwright is detected automatically), or set PW_PLAYWRIGHT_ENTRY to its index.mjs.',
  );
}

/** Launch one headless chromium; the caller closes it in cleanup. */
export async function launchBrowser({ reporter } = {}) {
  const { module, source } = await loadPlaywright();
  reporter?.debug(`playwright: ${source}`);
  return module.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

/**
 * Collect browser diagnostics for the whole run. Any entry here fails the
 * "no slot crash / no console error" assertions unless explicitly waived.
 */
export function collectDiagnostics(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} — ${failure?.errorText ?? 'failed'}`);
  });
  return diagnostics;
}
