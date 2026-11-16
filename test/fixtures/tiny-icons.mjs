#!/usr/bin/env node
/**
 * Tiny, stable PNG payloads shared by the MCP fixtures and the E2E runner.
 *
 * They are 16×16 images built from a minimal hand-rolled PNG encoder (zlib +
 * CRC only, no dependencies). The bytes are asserted by the E2E:
 *
 *   - the stdio fixture declares both a dark-theme icon and a light icon, so
 *     the Host's theme preference (no theme / light first) can be proven by
 *     comparing the proxied bytes;

 *   - the HTTP fixture serves `HTTP_ICON` from `GET /icon.png`, proving the
 *     Host-side proxy for `http(s)` icon sources;
 *   - the E2E uploads `UPLOAD_ICON_A` / `UPLOAD_ICON_B`, proving the upload path
 *     and the atomic replace of a previously stored file.
 *
 * Do not regenerate these casually: the E2E compares exact bytes and the card
 * screenshot is expected to show these colors.
 */

/** stdio fixture's preferred icon: #FF7A18 orange (light / no theme). */
export const STDIO_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4XyVBEmIY1TCqYfhqAAAWGZEQEZfsqQAAAABJRU5ErkJggg==';

/** stdio fixture's dark-theme icon: #1E40AF blue (must lose to the light one). */
export const STDIO_DARK_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mOQc1hPEmIY1TCqYfhqAAByJQ0QIEyIVgAAAABJRU5ErkJggg==';

/** HTTP fixture's icon: #16A34A green, served from GET /icon.png. */
export const HTTP_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mMQW+xFEmIY1TCqYfhqAAB+RAMQac+IlwAAAABJRU5ErkJggg==';

/** First uploaded icon: #DC2626 red checkers, deliberately unlike any server icon. */
export const UPLOAD_ICON_A_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIklEQVR42mO4o6YGR/+RAC5xhkGogRhFyOKDUcNoPAwKDQDhpBKf6D+9oAAAAABJRU5ErkJggg==';

/** Second uploaded icon: #7C3AED purple quadrants, replaces the first one. */
export const UPLOAD_ICON_B_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAH0lEQVR42mOosXqLFf3HARhGNdBEAy4JXAaNaqCJBgB/plAfFB5P4QAAAABJRU5ErkJggg==';

/** data: URI form expected in MCP `serverInfo.icons[].src`. */
export const STDIO_ICON_DATA_URI = `data:image/png;base64,${STDIO_ICON_PNG_BASE64}`;
export const STDIO_DARK_ICON_DATA_URI = `data:image/png;base64,${STDIO_DARK_ICON_PNG_BASE64}`;

/** Decoded bytes for a base64 constant above. */
export function iconBytes(base64) {
  return Buffer.from(base64, 'base64');
}

export const ICONS = {
  stdio: { base64: STDIO_ICON_PNG_BASE64, bytes: iconBytes(STDIO_ICON_PNG_BASE64), label: 'stdio-light' },
  stdioDark: { base64: STDIO_DARK_ICON_PNG_BASE64, bytes: iconBytes(STDIO_DARK_ICON_PNG_BASE64), label: 'stdio-dark' },
  http: { base64: HTTP_ICON_PNG_BASE64, bytes: iconBytes(HTTP_ICON_PNG_BASE64), label: 'http' },
  uploadA: { base64: UPLOAD_ICON_A_PNG_BASE64, bytes: iconBytes(UPLOAD_ICON_A_PNG_BASE64), label: 'upload-a' },
  uploadB: { base64: UPLOAD_ICON_B_PNG_BASE64, bytes: iconBytes(UPLOAD_ICON_B_PNG_BASE64), label: 'upload-b' },
};
