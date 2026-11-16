#!/usr/bin/env node
/**
 * Cleanup and inspection CLI for @ds-hu/dsh-better-mcp-manager.
 *
 * The plugin writes exactly one directory (`$DSH_HOME/better-mcp-manager/`).
 * Removing the bundle removes every registration and route; this command removes
 * the last byte of residue — the server list itself — so an uninstall leaves
 * nothing behind.
 *
 * ```sh
 * node bin/mcp-manager.mjs status
 * node bin/mcp-manager.mjs path
 * node bin/mcp-manager.mjs clean --yes
 * ```
 *
 * @module @ds-hu/dsh-better-mcp-manager/bin/mcp-manager
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DATA_DIR_NAME = 'better-mcp-manager';
const STORE_FILE = 'servers.json';

/**
 * Resolve the data directory exactly like `lib/store.js`.
 * @returns {string} absolute directory path.
 */
function dataDir() {
  const explicit = process.env.DSH_MCP_MANAGER_DATA_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const home = process.env.DSH_HOME?.trim();
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh');
  return join(root, DATA_DIR_NAME);
}

/**
 * Read the store file, returning a reason instead of throwing on damage.
 * @param {string} file - Store path.
 * @returns {{ state: "missing" } | { state: "invalid", reason: string } | { state: "ok", version: number, servers: any[] }} the read result.
 */
function readStore(file) {
  if (!existsSync(file)) return { state: 'missing' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { state: 'invalid', reason: error.message };
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.servers)) {
      return { state: 'invalid', reason: 'the file is not a { version, servers[] } store' };
    }
    return { state: 'ok', version: parsed.version, servers: parsed.servers };
  } catch (error) {
    return { state: 'invalid', reason: error.message };
  }
}

/**
 * Print usage.
 * @returns {void}
 */
function usage() {
  process.stdout.write([
    'usage: dsh-better-mcp-manager <command> [options]',
    '',
    'commands:',
    '  status          show the data directory and the stored server count (default)',
    '  path            print the data directory only',
    '  clean --yes     delete the data directory (refuses without --yes)',
    '',
    'environment:',
    '  DSH_HOME                        root that contains better-mcp-manager/ (default: ~/.dsh)',
    '  DSH_MCP_MANAGER_DATA_DIR        exact data directory override',
    '',
  ].join('\n'));
}

/**
 * Command: status.
 * @param {string} dir - Data directory.
 * @returns {number} exit status.
 */
function status(dir) {
  const file = join(dir, STORE_FILE);
  process.stdout.write(`data directory: ${dir}\n`);
  if (!existsSync(dir)) {
    process.stdout.write('state: absent (the plugin has never stored a server, or clean already ran)\n');
    return 0;
  }
  let mode = '';
  try {
    mode = (statSync(dir).mode & 0o777).toString(8);
  } catch {
    /* reported by the read below */
  }
  process.stdout.write(`directory mode: ${mode || 'unknown'}\n`);
  const read = readStore(file);
  if (read.state === 'missing') {
    process.stdout.write(`store: ${file} does not exist\n`);
    return 0;
  }
  if (read.state === 'invalid') {
    process.stdout.write(`store: ${file} is damaged (${read.reason})\n`);
    return 1;
  }
  const enabled = read.servers.filter((server) => server?.enabled === true).length;
  process.stdout.write(`store: ${file} (schema v${read.version})\n`);
  process.stdout.write(`servers: ${read.servers.length} (${enabled} enabled)\n`);
  for (const server of read.servers) {
    const state = server?.enabled === true ? 'enabled' : 'disabled';
    process.stdout.write(`  - ${String(server?.id ?? '?')}  ${String(server?.name ?? '?')}  [${String(server?.transport ?? '?')}, ${state}]\n`);
  }
  return 0;
}

/**
 * Command: clean.
 * @param {string} dir - Data directory.
 * @param {string[]} args - Remaining arguments.
 * @returns {number} exit status.
 */
function clean(dir, args) {
  if (!args.includes('--yes')) {
    process.stderr.write(`refusing to delete ${dir} without --yes\nrun: dsh-better-mcp-manager clean --yes\n`);
    return 2;
  }
  const resolved = resolve(dir);
  if (!resolved.endsWith(`/${DATA_DIR_NAME}`) && resolved !== process.env.DSH_MCP_MANAGER_DATA_DIR) {
    process.stderr.write(`refusing to delete ${resolved}: it is not a better-mcp-manager data directory\n`);
    return 2;
  }
  if (!existsSync(resolved)) {
    process.stdout.write(`nothing to remove: ${resolved} does not exist\n`);
    return 0;
  }
  rmSync(resolved, { recursive: true, force: true });
  process.stdout.write(`removed ${resolved}\n`);
  return 0;
}

const [command = 'status', ...rest] = process.argv.slice(2);
const dir = dataDir();

switch (command) {
  case 'status':
    process.exit(status(dir));
    break;
  case 'path':
    process.stdout.write(`${dir}\n`);
    process.exit(0);
    break;
  case 'clean':
    process.exit(clean(dir, rest));
    break;
  case 'help':
  case '--help':
  case '-h':
    usage();
    process.exit(0);
    break;
  default:
    process.stderr.write(`unknown command: ${command}\n`);
    usage();
    process.exit(2);
}
