#!/usr/bin/env node
/**
 * Structural check of the shipped bundle.
 *
 * This is the test that catches the packaging mistakes that are invisible in
 * development: a Loader row whose `id` disagrees with the Host module's exported
 * `name`, a patch file missing from `dsh.bundle.patch`, an `exports` subpath
 * pointing at a file that does not exist, a locale missing its plugin-page
 * metadata, and — the one that would only fail on a user's machine — an
 * `@deepseek-ai/*` import anywhere in the shipped code, which a profile-install
 * cannot resolve.
 *
 * It reads files and imports two modules; it never boots a Host.
 *
 * Every check is independent: a failure prints the reason and the audit keeps
 * going, so one broken artefact never hides the rest. Missing files are
 * reported as failures (with the path that is missing), not skipped, because
 * this script is what CI runs against the packed tree.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];

/**
 * Run one labelled assertion without aborting the audit.
 * @param {string} label - What is being checked.
 * @param {() => void} fn - The check.
 * @returns {void}
 */
function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}

/**
 * Load one shipped module, reporting failure instead of crashing the audit.
 * @param {string} relative - Path below the package root.
 * @returns {Promise<{ module: any, error: Error | null }>} the import outcome.
 */
async function loadModule(relative) {
  try {
    return { module: await import(pathToFileURL(join(root, relative)).href), error: null };
  } catch (error) {
    return { module: null, error };
  }
}

/**
 * Turn an `exports` target into the files it resolves to.
 * Handles the one pattern case (`./locale/*.json`); a non-pattern target is
 * itself, present or not.
 * @param {string} target - The target string from package.json.
 * @returns {string[]} matching paths relative to the package root.
 */
function expandExportTarget(target) {
  const text = String(target);
  const normalized = text.replace(/^\.\//u, '');
  if (!normalized.includes('*')) {
    return existsSync(join(root, normalized)) ? [normalized] : [];
  }
  const directory = dirname(normalized);
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const [head, tail] = basename.split('*');
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory))
    .filter((name) => name.startsWith(head) && name.endsWith(tail ?? ''))
    .map((name) => join(directory, name));
}

/**
 * Every source file shipped inside `lib/` or `bin/`.
 * @returns {string[]} paths relative to the package root.
 */
function shippedSourceFiles() {
  const files = [];
  for (const directory of ['lib', 'bin']) {
    if (!existsSync(join(root, directory))) continue;
    for (const name of readdirSync(join(root, directory))) {
      const relative = join(directory, name);
      const absolute = join(root, relative);
      if (statSync(absolute).isFile() && /\.(?:js|mjs|cjs)$/u.test(name)) files.push(relative);
    }
  }
  return files;
}

/* ---------------------------------------------------------------- */
/* Host module                                                       */
/* ---------------------------------------------------------------- */

const host = await loadModule('lib/index.js');
const hostName = host.module?.name;
const storeModule = await loadModule('lib/store.js');
const versionModule = await loadModule('lib/version.js');

if (host.error) {
  failures.push(`lib/index.js could not be imported: ${host.error.message}`);
  process.stdout.write(`FAIL lib/index.js could not be imported\n     ${host.error.message.split('\n').join('\n     ')}\n`);
}

check('the Host module exports a name, inject and apply', () => {
  if (host.error) throw new Error(`lib/index.js could not be imported: ${host.error.message}`);
  assert.equal(typeof hostName, 'string', 'lib/index.js must export a `name` string');
  assert.equal(typeof host.module.apply, 'function', 'lib/index.js must export `apply`');
  assert.ok(Array.isArray(host.module.inject), 'lib/index.js must export an `inject` array');
});

check('the Host module name is the agreed plugin id', () => {
  assert.equal(hostName, 'dsh-better-mcp-manager', 'the Loader row id, the Host name and docs/API-CONTRACT.md §1 must all agree');
});

check('the Host half asks for the web server service', () => {
  assert.ok(hostName !== undefined, 'lib/index.js did not load');
  assert.ok(
    host.module.inject.includes('webServer') || host.module.inject.some((entry) => entry?.required?.includes?.('webServer')),
    `inject must include webServer, got ${JSON.stringify(host.module.inject)} (docs/API-CONTRACT.md §3)`,
  );
});

/* ---------------------------------------------------------------- */
/* manifest + Loader patch                                           */
/* ---------------------------------------------------------------- */

const manifest = JSON.parse(read('package.json'));
const patchPath = 'cordis.patch.yml';
const hostPatch = existsSync(join(root, patchPath)) ? read(patchPath) : '';

check('the Loader patch is declared in dsh.bundle.patch', () => {
  const patches = manifest.dsh?.bundle?.patch;
  assert.ok(Array.isArray(patches) && patches.length > 0, 'dsh.bundle.patch is missing');
  assert.ok(patches.includes(`./${patchPath}`) || patches.includes(patchPath), `dsh.bundle.patch must list ./${patchPath}, got ${JSON.stringify(patches)}`);
  for (const patch of patches) {
    assert.ok(existsSync(join(root, patch)), `dsh.bundle.patch lists ${patch}, which does not exist`);
  }
});

check('the patch inserts exactly one root-level row', () => {
  assert.ok(existsSync(join(root, patchPath)), `${patchPath} is missing`);
  assert.match(hostPatch, /^- insert:$/mu, `${patchPath} must insert at the root`);
  const rows = hostPatch.split('\n').filter((line) => /^\s*-\s+id:/u.test(line));
  assert.equal(rows.length, 1, `expected one Loader row, found ${rows.length}`);
  assert.doesNotMatch(hostPatch, /^\s+isolate:/mu, 'the plugin sits loose in the Host realm; no isolate group');
});

check('the Loader row id equals the Host module name', () => {
  const id = /^\s*-\s+id:\s*(.+)$/mu.exec(hostPatch);
  assert.ok(id, `no row id in ${patchPath}`);
  assert.equal(id[1].trim(), hostName, 'patch id must equal lib/index.js `name`');
});

check('the Loader row name is the package name', () => {
  const row = /^\s+name:\s*'?([^'\n]+)'?\s*$/mu.exec(hostPatch);
  assert.ok(row, `no row name in ${patchPath}`);
  assert.equal(row[1].trim(), manifest.name, 'patch name must equal package.json name');
  assert.equal(hostName, 'dsh-better-mcp-manager', 'the plugin id is frozen by docs/API-CONTRACT.md §1');
});

/* ---------------------------------------------------------------- */
/* package.json exports / client entry / files                       */
/* ---------------------------------------------------------------- */

check('every exports subpath resolves to a real file', () => {
  const exportsMap = manifest.exports;
  assert.ok(exportsMap && typeof exportsMap === 'object', 'package.json has no exports map');
  for (const [subpath, target] of Object.entries(exportsMap)) {
    const matches = expandExportTarget(target);
    assert.ok(matches.length > 0, `exports["${subpath}"] -> ${target} resolves to no file`);
  }
});

check('the runtime entry points are exported', () => {
  assert.equal(manifest.main?.replace(/^\.\//u, ''), 'lib/index.js', 'main must point at lib/index.js');
  assert.equal(manifest.exports?.['.'], './lib/index.js');
  assert.equal(manifest.exports?.['./client'], './lib/client.js', 'the Web shell loads the browser half through exports["./client"]');
  assert.equal(manifest.exports?.['./icon'], './icon.svg');
});

check('the web client entry is declared', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"');
  assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject must be an array');
  assert.ok(manifest.dsh.client.inject.length > 0, 'dsh.client.inject must not be empty');
  assert.ok(
    manifest.dsh.client.inject.some((entry) => String(entry).includes('sidebar')),
    `dsh.client.inject must name the sidebar package, got ${JSON.stringify(manifest.dsh.client.inject)}`,
  );
  assert.ok(
    manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'),
    `dsh.client.inject must include the locale client package, got ${JSON.stringify(manifest.dsh.client.inject)}`,
  );
});

check('files[] covers every runtime artefact', () => {
  const files = manifest.files;
  assert.ok(Array.isArray(files) && files.length > 0, 'files[] is missing');
  for (const entry of ['lib', 'bin', 'locale', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh-CN.md', 'docs', 'LICENSE', 'NOTICE']) {
    assert.ok(files.includes(entry), `files[] must include ${entry}`);
  }
});

check('files[] excludes tests and development config', () => {
  for (const entry of manifest.files ?? []) {
    assert.doesNotMatch(String(entry), /(?:^|\/)test(?:\/|$)/u, `files[] must not include ${entry}`);
    assert.doesNotMatch(String(entry), /\.test\.mjs$/u, `files[] must not include ${entry}`);
    assert.notEqual(entry, 'eslint.config.js', 'eslint.config.js must not be published');
    assert.notEqual(entry, 'package-lock.json', 'package-lock.json must not be published');
  }
});

check('the published package cannot import a Harness package', () => {
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    assert.doesNotMatch(name, /^@deepseek-ai\//u, `dependencies must not contain ${name}; a profile install cannot resolve it`);
    assert.equal(typeof range, 'string', `dependency ${name} has no version`);
  }
});

check('there is no install lifecycle script', () => {
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    assert.equal(manifest.scripts?.[hook], undefined, `${hook} must not be defined; installing the bundle must not execute code`);
  }
});

check('the CLI is declared and starts with a shebang', () => {
  const entries = Object.values(manifest.bin ?? {});
  assert.ok(entries.length > 0, 'package.json must declare bin/mcp-manager.mjs (docs/API-CONTRACT.md §1)');
  const cli = entries.find((path) => String(path).includes('mcp-manager'));
  assert.ok(cli, `bin must point at bin/mcp-manager.mjs, got ${JSON.stringify(manifest.bin)}`);
  const absolute = join(root, String(cli));
  assert.ok(existsSync(absolute), `bin target ${cli} does not exist`);
  assert.ok(read(String(cli)).startsWith('#!/usr/bin/env node'), `${cli} needs a node shebang`);
});

/* ---------------------------------------------------------------- */
/* locale + icon                                                     */
/* ---------------------------------------------------------------- */

check('both locale files carry meaningful plugin-page metadata', () => {
  for (const locale of ['en', 'zh']) {
    const absolute = join(root, 'locale', `${locale}.json`);
    assert.ok(existsSync(absolute), `locale/${locale}.json is missing`);
    const parsed = JSON.parse(read(`locale/${locale}.json`));
    const title = parsed.meta?.title;
    const description = parsed.meta?.description;
    assert.equal(typeof title, 'string', `locale/${locale}.json needs meta.title`);
    assert.ok(title.trim().length >= 2, `locale/${locale}.json meta.title is empty or a placeholder`);
    assert.equal(typeof description, 'string', `locale/${locale}.json needs meta.description`);
    assert.ok(description.trim().length >= 8, `locale/${locale}.json meta.description is not meaningful`);
  }
});

check('the two locale files describe the plugin in both languages', () => {
  const en = JSON.parse(read('locale/en.json')).meta;
  const zh = JSON.parse(read('locale/zh.json')).meta;
  assert.notEqual(en.title, zh.title, 'the zh and en titles should not be identical');
  assert.notEqual(en.description, zh.description, 'the zh and en descriptions should not be identical');
});

check('icon.svg is a parseable SVG no larger than 256 KiB', () => {
  const absolute = join(root, 'icon.svg');
  assert.ok(existsSync(absolute), 'icon.svg is missing');
  const stats = statSync(absolute);
  assert.ok(stats.size > 0, 'icon.svg is empty');
  assert.ok(stats.size <= 256 * 1024, `icon.svg is ${stats.size} bytes; the limit is 262144`);
  const text = read('icon.svg');
  assert.match(text, /<svg[\s>]/u, 'icon.svg has no <svg> root element');
  assert.match(text, /<\/svg>\s*$/u, 'icon.svg is not closed with </svg>');
  assert.ok(/viewBox\s*=|<svg[^>]*\swidth=/u.test(text), 'icon.svg needs a viewBox or a width so it scales');
  assert.doesNotMatch(text, /<script[\s>]/iu, 'icon.svg must not carry a script');
});

/* ---------------------------------------------------------------- */
/* dependencies on the Harness                                       */
/* ---------------------------------------------------------------- */

check('lib/ and bin/ import no @deepseek-ai package', () => {
  const sources = shippedSourceFiles();
  assert.ok(sources.length >= 2, `expected shipped source files under lib/ and bin/, found ${sources.length}`);
  for (const relative of sources) {
    const text = read(relative);
    assert.doesNotMatch(text, /import\s[^;]*?from\s+['"]@deepseek-ai\//u, `${relative} imports an @deepseek-ai/ package`);
    assert.doesNotMatch(text, /import\s*\(\s*['"]@deepseek-ai\//u, `${relative} dynamically imports an @deepseek-ai/ package`);
    assert.doesNotMatch(text, /export\s[^;]*?from\s+['"]@deepseek-ai\//u, `${relative} re-exports an @deepseek-ai/ package`);
    assert.doesNotMatch(text, /require\(\s*['"]@deepseek-ai\//u, `${relative} requires an @deepseek-ai/ package`);
  }
});

/* ---------------------------------------------------------------- */
/* write scope: only $DSH_HOME/better-mcp-manager                    */
/* ---------------------------------------------------------------- */

/**
 * Every static path a write/delete API is handed, as source text windows.
 * @param {string} text - Source file contents.
 * @returns {string[]} the argument windows.
 */
function writeCallArguments(text) {
  const windows = [];
  const pattern = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|open|openSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|chmod|chmodSync)\s*\(([\s\S]{0,320})/gu;
  for (const match of text.matchAll(pattern)) windows.push(match[1]);
  return windows;
}

/**
 * Remove comments so a rule about code cannot trip over documentation that
 * mentions a forbidden filename.
 * @param {string} text - Source file contents.
 * @returns {string} the code without block or line comments.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

check('shipped code never writes the Loader patch or other profile files', () => {
  for (const relative of shippedSourceFiles()) {
    const text = stripComments(read(relative));
    assert.doesNotMatch(text, /cordis\.patch\.yml/u, `${relative} references cordis.patch.yml in code; the Host never writes the Loader patch`);
    for (const window of writeCallArguments(text)) {
      assert.doesNotMatch(window, /package\.json|node_modules|eslint\.config|cordis\.patch|presets?\//u, `${relative} writes into the package/profile tree`);
    }
  }
});

check('shipped code has no hard-coded system paths', () => {
  for (const relative of shippedSourceFiles()) {
    const text = read(relative);
    assert.doesNotMatch(text, /\/root\//u, `${relative} hard-codes /root/`);
    assert.doesNotMatch(text, /['"`]\/(?:etc|usr|var|opt|home|srv)\//u, `${relative} hard-codes an absolute system path`);
    assert.doesNotMatch(text, /['"`]~(?:\/|\\)/u, `${relative} hard-codes a home-relative path`);
  }
});

check('every write target is computed from the data directory', () => {
  for (const relative of shippedSourceFiles()) {
    const text = read(relative);
    for (const window of writeCallArguments(text)) {
      assert.doesNotMatch(window, /process\.cwd\(\)/u, `${relative} writes relative to the process cwd`);
      assert.doesNotMatch(window, /['"`]\/(?!\/)/u, `${relative} hands a write API an absolute path literal; writes must resolve below $DSH_HOME/better-mcp-manager`);
    }
  }
});

check('the shared constants match package.json and the contract', () => {
  if (versionModule.error) throw new Error(`lib/version.js could not be imported: ${versionModule.error.message}`);
  const constants = versionModule.module;
  assert.equal(constants.PLUGIN_VERSION, manifest.version, 'PLUGIN_VERSION must equal package.json version');
  assert.equal(constants.DATA_DIR_NAME, 'better-mcp-manager', 'DATA_DIR_NAME must be the frozen data directory name');
  assert.equal(constants.API_PREFIX, '/better-mcp-manager/api', 'API_PREFIX must match the frozen API base');
  assert.equal(constants.PANEL_ID, 'mcp-manager', 'PANEL_ID must be the frozen sidebar id');
  assert.equal(constants.CLIENT_LOCALE_NS, 'mcpManager', 'CLIENT_LOCALE_NS must be the frozen locale namespace');
});

check('the data directory resolver keeps everything under $DSH_HOME/better-mcp-manager', () => {
  if (storeModule.error) throw new Error(`lib/store.js could not be imported: ${storeModule.error.message}`);
  const resolver = ['resolveDataDir', 'dataDir', 'resolveDataDirectory'].map((name) => storeModule.module[name]).find((fn) => typeof fn === 'function');
  assert.equal(typeof resolver, 'function', 'lib/store.js must export a data-directory resolver so the CLI and Host agree');
  assert.equal(resolver({ DSH_HOME: '/srv/dsh' }), '/srv/dsh/better-mcp-manager');
  assert.equal(resolver({ DSH_MCP_MANAGER_DATA_DIR: '/var/tmp/mcp-manager-test' }), '/var/tmp/mcp-manager-test');
  assert.equal(resolver({}), join(homedir(), '.dsh', 'better-mcp-manager'), 'without DSH_HOME the store lives under ~/.dsh');
});

/* ---------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} mount check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nmount-check: all checks passed\n');
}
