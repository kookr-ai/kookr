/**
 * Attach dropped / pasted images to the agent in the dashboard terminal.
 *
 * The browser gives us the image *bytes* but never a usable file path (and the
 * agent may live on a different filesystem than the browser — Chrome on
 * Windows, Kookr in WSL). So: upload the bytes to the Kookr server, which saves
 * them on the host and returns the path, then paste that path into the agent's
 * prompt. Claude Code and Codex CLI both turn a pasted image path into an image
 * attachment. Contract and rationale: `shared/contracts/terminal-image.ts`.
 *
 * Everything here is DOM-free (it takes `File`s and callbacks) so it can be
 * unit-tested; `TerminalPanel` owns the drag/paste events and the notice UI.
 */
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_MAX_PER_DROP,
  TERMINAL_IMAGE_TYPES,
  TERMINAL_IMAGE_UPLOAD_PATH,
  type TerminalImageUploadError,
  type TerminalImageUploadResponse,
} from '../shared/contracts/terminal-image.js';

const EXTENSION_TYPES: Readonly<Record<string, true>> = { png: true, jpg: true, jpeg: true, gif: true, webp: true };
const MAX_MB = TERMINAL_IMAGE_MAX_BYTES / (1024 * 1024);

/** True when a drag carries files (as opposed to dragged text or a page link). */
export function dragCarriesFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files');
}

/**
 * A file we are willing to send. Trusts the browser's MIME type when it gave
 * one; falls back to the extension only when the type is blank (some Windows
 * setups leave it empty). The server re-checks the real bytes either way.
 */
export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type) return (TERMINAL_IMAGE_TYPES as readonly string[]).includes(file.type);
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXTENSION_TYPES[extension] === true;
}

/**
 * Images on the clipboard, for Ctrl+V. Returns nothing when the clipboard also
 * carries text: copying spreadsheet cells or a web selection puts a rendered
 * picture next to the text, and the text paste is what the user meant.
 */
export function imageFilesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data || data.getData('text')) return [];
  return Array.from(data.files ?? []).filter(isSupportedImageFile);
}

export interface ImageAttachPlan {
  accepted: File[];
  /** Human-readable reasons some dropped files were not attached. */
  skipped: string[];
}

/** Decide which dropped files to upload, and say why any are left out. */
export function planImageAttach(files: readonly File[]): ImageAttachPlan {
  const skipped: string[] = [];
  const accepted: File[] = [];
  for (const file of files) {
    if (!isSupportedImageFile(file)) {
      skipped.push(`${file.name || 'file'}: not a PNG, JPEG, GIF or WebP image`);
    } else if (file.size > TERMINAL_IMAGE_MAX_BYTES) {
      skipped.push(`${file.name || 'image'}: larger than ${MAX_MB} MB`);
    } else if (accepted.length >= TERMINAL_IMAGE_MAX_PER_DROP) {
      skipped.push(`${file.name || 'image'}: only ${TERMINAL_IMAGE_MAX_PER_DROP} images can be attached at once`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, skipped };
}

/**
 * The text pasted for ONE image: its path plus a trailing space, so the user
 * can keep typing after the attachment.
 *
 * Each image must be its own paste. Checked against the real TUIs: Codex CLI
 * only attaches a paste that is exactly one image path — two space-separated
 * paths in a single paste stay plain text — while Claude Code accepts either.
 * Separate back-to-back pastes attach every image in both.
 */
export function formatImagePathForPaste(path: string): string {
  return `${path} `;
}

function describeUploadFailure(status: number, error: TerminalImageUploadError | null): string {
  if (status === 413) return `larger than ${MAX_MB} MB`;
  if (status === 415) return 'not a PNG, JPEG, GIF or WebP image';
  if (status === 401 || status === 403) return 'not allowed (read-only or signed-out session)';
  return error?.message ?? `upload failed (HTTP ${status})`;
}

/** Upload one image; resolves with the host path or rejects with a readable message. */
export async function uploadTerminalImage(
  file: File,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<TerminalImageUploadResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TERMINAL_IMAGE_UPLOAD_PATH, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error(`${file.name || 'image'}: could not reach the Kookr server`);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as TerminalImageUploadError | null;
    throw new Error(`${file.name || 'image'}: ${describeUploadFailure(response.status, error)}`);
  }
  return await response.json() as TerminalImageUploadResponse;
}

export type ImageAttachOutcome =
  | { status: 'attached'; attached: number; failures: string[] }
  | { status: 'failed'; failures: string[] }
  /** The agent/terminal changed or disconnected while uploading; nothing was pasted. */
  | { status: 'stale' };

export interface ImageAttachIo {
  upload: (file: File) => Promise<TerminalImageUploadResponse>;
  /** Still the same visible, connected terminal the user dropped onto? */
  isStillTarget: () => boolean;
  /** Paste into the terminal; false if it refused (not ready). */
  paste: (text: string) => boolean;
}

/**
 * Upload `files`, then paste each path into the terminal — but only if it is
 * still the terminal the user dropped onto. Uploading takes time, and the
 * dashboard can switch to another agent meanwhile (auto-advance, a click);
 * pasting then would put an image into the wrong agent's prompt.
 */
export async function attachImagesToTerminal(
  files: readonly File[],
  io: ImageAttachIo,
): Promise<ImageAttachOutcome> {
  const results = await Promise.allSettled(files.map((file) => io.upload(file)));
  const paths: string[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') paths.push(result.value.path);
    else failures.push(result.reason instanceof Error ? result.reason.message : 'upload failed');
  }
  if (paths.length === 0) return { status: 'failed', failures };
  if (!io.isStillTarget()) return { status: 'stale' };
  // One paste per image, in drop order (see formatImagePathForPaste for why).
  let pasted = 0;
  for (const path of paths) {
    if (!io.paste(formatImagePathForPaste(path))) break;
    pasted += 1;
  }
  if (pasted === 0) return { status: 'stale' };
  if (pasted < paths.length) {
    const missed = paths.length - pasted;
    failures.push(`${missed} image${missed === 1 ? '' : 's'} not attached: the terminal disconnected`);
  }
  return { status: 'attached', attached: pasted, failures };
}
