#!/usr/bin/env node
/**
 * Check what `npm publish` would actually upload.
 *
 * The published tarball is the only artefact an installer ever sees, so a file
 * that is used at runtime but missing from `files[]` is a broken release, and a
 * file that is only used in development must not be in it. This runs
 * `npm pack --dry-run --json` and audits the result, including the executable
 * bit npm would preserve on the cleanup CLI.
 *
 * Offline: `npm pack --dry-run` only reads the working tree.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run `npm pack --dry-run --json`, with a readable failure if npm is absent.
 * @returns {object} the single report entry.
 */
function packReport() {
  let raw;
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.stderr.write(`package: npm pack --dry-run failed\n${error.stderr ?? error.message}\n`);
    process.exitCode = 1;
    return null;
  }
  const reports = JSON.parse(raw);
  assert.equal(reports.length, 1, `expected one pack report, got ${reports.length}`);
  return reports[0];
}

const report = packReport();
if (report === null) process.exit(1);

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const paths = report.files.map((file) => file.path).sort();
const entries = new Map(report.files.map((file) => [file.path, file]));
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
 * Whether the tarball carries a path.
 * @param {string} path - Path inside the package.
 * @returns {boolean} the answer.
 */
const has = (path) => paths.includes(path);

/* ---------------------------------------------------------------- */

check('the tarball describes the package that was packed', () => {
  assert.equal(report.name, manifest.name, `packed ${report.name}, manifest says ${manifest.name}`);
  assert.equal(report.version, manifest.version, `packed ${report.version}, manifest says ${manifest.version}`);
  assert.match(report.filename, /^ds-hu-dsh-better-mcp-manager-\d+\.\d+\.\d+\.tgz$/u, `unexpected tarball name ${report.filename}`);
});

check('the tarball carries every runtime module', () => {
  for (const path of [
    'lib/index.js',
    'lib/client.js',
    'lib/store.js',
    'lib/model.js',
    'lib/mcp.js',
    'lib/tool-definition.js',
    'lib/result-projection.js',
    'lib/presets.js',
    'lib/api.js',
    'lib/http.js',
    'lib/icons.js',
    'lib/version.js',
    'bin/mcp-manager.mjs',
  ]) {
    assert.ok(has(path), `${path} is missing from the tarball`);
  }
});

check('the tarball carries the bundle, locale and artwork', () => {
  for (const path of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'package.json']) {
    assert.ok(has(path), `${path} is missing from the tarball`);
  }
});

check('the tarball carries the legal and documentation files', () => {
  for (const path of ['LICENSE', 'NOTICE', 'README.md', 'docs/API-CONTRACT.md']) {
    assert.ok(has(path), `${path} is missing from the tarball`);
  }
  if ((manifest.files ?? []).includes('README.zh-CN.md')) {
    assert.ok(has('README.zh-CN.md'), 'files[] promises README.zh-CN.md but the tarball does not carry it');
  }
});

check('every exports subpath is packed', () => {
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const text = String(target).replace(/^\.\//u, '');
    if (text.includes('*')) {
      const directory = dirname(text);
      const basename = text.slice(text.lastIndexOf('/') + 1);
      const [head, tail] = basename.split('*');
      const matches = paths.filter((path) => dirname(path) === directory && path.slice(path.lastIndexOf('/') + 1).startsWith(head) && path.endsWith(tail ?? ''));
      assert.ok(matches.length > 0, `exports["${subpath}"] -> ${target} has no packed file`);
      continue;
    }
    assert.ok(has(text), `exports["${subpath}"] -> ${text} is not in the tarball`);
  }
});

check('the cleanup CLI is packed with its executable bit', () => {
  const cli = Object.values(manifest.bin ?? {}).find((path) => String(path).includes('mcp-manager'));
  assert.ok(cli, 'package.json declares no bin entry for mcp-manager');
  const entry = entries.get(String(cli).replace(/^\.\//u, ''));
  assert.ok(entry, `${cli} is missing from the tarball`);
  assert.equal(typeof entry.mode, 'number', `npm pack did not report a mode for ${cli}`);
  assert.equal((entry.mode & 0o111) !== 0, true, `${cli} is not executable in the tarball (mode ${entry.mode.toString(8)})`);
  const onDisk = statSync(join(root, String(cli)));
  assert.equal((onDisk.mode & 0o111) !== 0, true, `${cli} has no executable bit on disk; npm would pack it non-executable`);
});

check('development files stay out of the tarball', () => {
  for (const prefix of ['test/', 'node_modules/', '.github/', '.git/', 'e2e-artifacts/', 'docs/internal/']) {
    assert.equal(paths.some((path) => path.startsWith(prefix)), false, `${prefix} leaked into the tarball`);
  }
  for (const path of ['eslint.config.js', 'package-lock.json', '.gitignore', 'npm-debug.log']) {
    assert.equal(has(path), false, `${path} leaked into the tarball`);
  }
});

check('no stray backup or quarantine files are shipped', () => {
  const strays = paths.filter((path) => /\.corrupt-|\.tmp-|\.swp$|~$|\.orig$|\.rej$/u.test(path));
  assert.deepEqual(strays, [], `stray files in the tarball: ${strays.join(', ')}`);
});

check('the tarball is not empty and carries no huge blob', () => {
  assert.ok(paths.length >= 15, `only ${paths.length} files in the tarball`);
  const huge = report.files.filter((file) => file.size > 2 * 1024 * 1024).map((file) => `${file.path} (${file.size} bytes)`);
  assert.deepEqual(huge, [], `unexpectedly large files: ${huge.join(', ')}`);
});

/* ---------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} package check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\npackage: ${paths.length} files, all checks passed\n`);
}
