/**
 * Version and shared constants.
 *
 * `PLUGIN_VERSION` is duplicated from package.json because a profile-installed
 * bundle may be loaded from a linked directory where reading its own manifest is
 * fine but unnecessary at runtime; `test/mount-check.mjs` keeps the two in sync.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/version
 */

/** Semver of the shipped bundle; must equal package.json `version`. */
export const PLUGIN_VERSION = '0.5.0';

/** Same-origin HTTP prefix owned by this plugin (registered as a `prefix` route). */
export const API_PREFIX = '/better-mcp-manager/api';

/** Directory name under `$DSH_HOME` that owns every byte this plugin writes. */
export const DATA_DIR_NAME = 'better-mcp-manager';

/** Client locale dictionary namespace. */
export const CLIENT_LOCALE_NS = 'mcpManager';

/** Sidebar panel id, also the key of the `main` slot entry and the tab/panel identity. */
export const PANEL_ID = 'mcp-manager';
