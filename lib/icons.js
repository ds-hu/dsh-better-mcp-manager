/**
 * Operator-uploaded server icons: one stored image per server.
 *
 * The icon model is frozen by contract §2.6. This module owns only the upload
 * side of it: decode a `data:` URL, prove the bytes really are the declared
 * raster format, and keep exactly one file per server under
 * `$DSH_HOME/better-mcp-manager/icons/` (directory 0700, file 0600).
 *
 * Replacing an icon writes the new file through a unique temporary name and a
 * rename, then deletes every other file for that server id, so a crash leaves
 * either the old icon or the new one — never half of both. Deleting a server
 * removes its file through the same helper.
 *
 * SVG is rejected on purpose: a same-origin `image/svg+xml` response can run
 * script when opened as a document, and an icon is not worth that risk.
 *
 * @module @ds-hu/dsh-better-mcp-manager/lib/icons
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ICON_MIME_EXT, InputError, MAX_ICON_BYTES } from './model.js';

/** Directory inside the data directory that holds uploaded icons. */
export const ICONS_DIR_NAME = 'icons';

/** Data-URL prefix shape: `data:<mime>;base64,<payload>`. */
const DATA_URL_PATTERN = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/u;

/** File names this module will ever serve. */
const SAFE_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{2,5}$/u;

/** Magic numbers proving the declared raster type. */
const MAGIC = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * Absolute path of the icons directory for one data directory.
 * @param {string} dataDir - Plugin data directory.
 * @returns {string} the icons directory.
 */
export function iconsDir(dataDir) {
  return join(dataDir, ICONS_DIR_NAME);
}

/**
 * Resolve one stored icon file name to an absolute path.
 * @param {string} dataDir - Plugin data directory.
 * @param {string} file - Stored file name.
 * @returns {string} absolute path.
 * @throws {InputError} when the file name is not one this module writes.
 */
export function iconPath(dataDir, file) {
  if (typeof file !== 'string' || !SAFE_FILE_PATTERN.test(file)) {
    throw new InputError('invalid-icon', 'the stored icon file name is invalid', 'icon');
  }
  return join(iconsDir(dataDir), file);
}

/**
 * Decode one uploaded `data:` URL into proven raster bytes.
 * @param {unknown} dataUrl - Request body value.
 * @returns {{ bytes: Buffer, mimeType: string, ext: string }} decoded image.
 * @throws {InputError} on a malformed, unsupported, non-canonical or oversized image.
 */
export function parseIconUpload(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new InputError('invalid-icon', 'dataUrl must be a data: URL carrying a PNG, JPEG, WebP or GIF image', 'icon');
  }
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (match === null) {
    throw new InputError('invalid-icon', 'dataUrl must look like data:image/png;base64,<payload>', 'icon');
  }
  const [, mimeType, payload] = match;
  const ext = ICON_MIME_EXT[mimeType];
  if (ext === undefined) {
    throw new InputError('invalid-icon', `icon type "${mimeType}" is not supported; use image/png, image/jpeg, image/webp or image/gif`, 'icon');
  }
  // Canonical base64 only: aliases and whitespace are refused instead of guessed at.
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) {
    throw new InputError('invalid-icon', 'dataUrl does not carry canonical base64', 'icon');
  }
  if (bytes.length === 0) throw new InputError('invalid-icon', 'the uploaded icon is empty', 'icon');
  if (bytes.length > MAX_ICON_BYTES) {
    throw new InputError('invalid-icon', `the uploaded icon is ${bytes.length} bytes; the limit is ${MAX_ICON_BYTES}`, 'icon');
  }
  if (!isRasterIcon(bytes, mimeType)) {
    throw new InputError('invalid-icon', `the uploaded bytes are not a valid ${mimeType} image`, 'icon');
  }
  return { bytes, mimeType, ext };
}

/**
 * Whether the leading bytes match the declared raster type.
 * @param {Buffer} bytes - Decoded payload.
 * @param {string} mimeType - Declared media type.
 * @returns {boolean} the answer.
 */
export function isRasterIcon(bytes, mimeType) {
  if (mimeType === 'image/webp') {
    return bytes.length >= 12
      && bytes.toString('latin1', 0, 4) === 'RIFF'
      && bytes.toString('latin1', 8, 12) === 'WEBP';
  }
  const magic = MAGIC.find((entry) => entry.mimeType === mimeType);
  if (magic === undefined) return false;
  return magic.bytes.every((byte, index) => bytes[index] === byte);
}

/**
 * Persist one uploaded icon as the server's only icon file.
 * @param {string} dataDir - Plugin data directory.
 * @param {string} serverId - Owning server id.
 * @param {{ bytes: Buffer, mimeType: string, ext: string }} image - Decoded image.
 * @param {() => number} [now] - Clock.
 * @returns {Promise<{ file: string, mimeType: string, updatedAt: string }>} stored metadata.
 */
export async function saveIconUpload(dataDir, serverId, image, now = () => Date.now()) {
  const dir = iconsDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const file = `${serverId}.${image.ext}`;
  const target = iconPath(dataDir, file);
  const tmp = join(dir, `.${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, image.bytes, { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => {});
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  // One file per server: a previous format (e.g. .png when the new one is .jpg)
  // must not linger beside the replacement.
  for (const entry of await readdir(dir).catch(() => [])) {
    if (entry !== file && entry.startsWith(`${serverId}.`)) {
      await rm(join(dir, entry), { force: true }).catch(() => {});
    }
  }
  return { file, mimeType: image.mimeType, updatedAt: new Date(now()).toISOString() };
}

/**
 * Read one stored icon file.
 * @param {string} dataDir - Plugin data directory.
 * @param {string} file - Stored file name.
 * @returns {Promise<Buffer | undefined>} bytes, or undefined when the file is gone.
 */
export async function readStoredIcon(dataDir, file) {
  try {
    return await readFile(iconPath(dataDir, file));
  } catch {
    return undefined;
  }
}

/**
 * Remove every icon file belonging to one server.
 * @param {string} dataDir - Plugin data directory.
 * @param {string} serverId - Server id.
 * @returns {Promise<void>} completion.
 */
export async function removeServerIcons(dataDir, serverId) {
  for (const entry of await readdir(iconsDir(dataDir)).catch(() => [])) {
    if (entry.startsWith(`${serverId}.`)) await rm(join(iconsDir(dataDir), entry), { force: true }).catch(() => {});
  }
}
