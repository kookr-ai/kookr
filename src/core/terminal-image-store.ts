/**
 * Host-side storage for images the user drops or pastes into the dashboard
 * terminal (see `shared/contracts/terminal-image.ts` for the why).
 *
 * Images live under `<kookrDir>/terminal-images/`, deliberately OUTSIDE any
 * agent worktree: a file inside a worktree would show up as an untracked change
 * (tripping dirty-worktree checks and risking an accidental commit). Both Claude
 * Code and Codex CLI attach an image from an absolute path outside their cwd.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TerminalImageType } from '../shared/contracts/terminal-image.js';

export const TERMINAL_IMAGE_DIR_NAME = 'terminal-images';

/**
 * Saved images older than this are deleted the next time any image is saved.
 * The agent reads the file when the prompt is submitted and keeps its own copy
 * in its transcript, so a week is ample and keeps the directory bounded.
 */
export const TERMINAL_IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const EXTENSION_BY_TYPE: Record<TerminalImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Names this module creates. Pruning touches only these, never anything else in the dir. */
const OWNED_NAME = /^kookr-image-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp)$/;

/**
 * Identify an image by its leading "magic" bytes rather than trusting the
 * client's Content-Type or file name. Returns null for anything that is not
 * one of the supported raster formats (including SVG and truncated input).
 */
export function sniffImageType(bytes: Uint8Array): TerminalImageType | null {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // "GIF87a" / "GIF89a"
  if (startsWith([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // "RIFF" <4-byte size> "WEBP"
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

function timestampSegment(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** Best-effort: a failure to prune must never fail the upload that triggered it. */
async function pruneExpiredImages(dir: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((name) => OWNED_NAME.test(name)).map(async (name) => {
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = await stat(file);
      if (now.getTime() - mtimeMs > TERMINAL_IMAGE_RETENTION_MS) await unlink(file);
    } catch {
      /* already gone, or not ours to remove */
    }
  }));
}

export interface SavedTerminalImage {
  path: string;
  mime: TerminalImageType;
  size: number;
}

/**
 * Save an already-validated image and return its absolute path.
 *
 * The file name is generated here, never taken from the client: it is
 * timestamp + random, contains no spaces or shell-special characters (so the
 * name pastes into an agent prompt without quoting), and cannot collide with or
 * traverse out of the directory. Files are owner-only (0600) in a 0700 dir.
 */
export async function saveTerminalImage(
  kookrDir: string,
  bytes: Uint8Array,
  mime: TerminalImageType,
  now: Date = new Date(),
): Promise<SavedTerminalImage> {
  const dir = path.resolve(kookrDir, TERMINAL_IMAGE_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await pruneExpiredImages(dir, now);
  const name = `kookr-image-${timestampSegment(now)}-${randomBytes(4).toString('hex')}.${EXTENSION_BY_TYPE[mime]}`;
  const file = path.join(dir, name);
  // 'wx' refuses to overwrite: a (vanishingly unlikely) name collision fails loudly.
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  return { path: file, mime, size: bytes.byteLength };
}
