/**
 * Contract for attaching an image to an agent from the dashboard terminal
 * (`POST /api/terminal-images`).
 *
 * Why this exists: the browser can hand the dashboard the *bytes* of a dropped
 * or pasted image but never its location on the user's disk, and the agent
 * runs on the Kookr host (which may be a different filesystem than the browser
 * — e.g. Chrome on Windows, Kookr in WSL). So the dashboard uploads the bytes
 * here, the server saves them to a file on the host, and the dashboard then
 * pastes that host path into the agent's prompt. Claude Code and Codex CLI both
 * turn a pasted image path into an image attachment (one path per paste: Codex
 * ignores a paste that holds several paths).
 *
 * The request body is the raw image (not JSON / multipart), so the route has
 * its own size cap instead of the 1 MB JSON limit the other `/api/*` routes use.
 */

export const TERMINAL_IMAGE_UPLOAD_PATH = '/api/terminal-images';

/** Largest image the upload route accepts (screenshots of a 4K display fit). */
export const TERMINAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Most images attached by a single drop or paste; extras are ignored with a notice. */
export const TERMINAL_IMAGE_MAX_PER_DROP = 8;

/**
 * Formats the agents are known to attach from a pasted path. SVG is excluded on
 * purpose: it is text that can carry script, and neither agent treats it as an image.
 */
export const TERMINAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type TerminalImageType = (typeof TERMINAL_IMAGE_TYPES)[number];

export interface TerminalImageUploadResponse {
  /**
   * Absolute path on the Kookr host. The file name has no spaces or shell-special
   * characters; the directory part is the Kookr state dir (normally `~/.kookr`).
   */
  path: string;
  /** Format the server detected from the file's leading bytes (not the client's claim). */
  mime: TerminalImageType;
  size: number;
}

export interface TerminalImageUploadError {
  error: 'empty_body' | 'unsupported_image_type' | 'request-body-too-large' | 'storage_failed';
  message: string;
  limitBytes?: number;
}
