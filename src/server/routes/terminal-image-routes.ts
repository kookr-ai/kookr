import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_UPLOAD_PATH,
  type TerminalImageUploadError,
  type TerminalImageUploadResponse,
} from '../../shared/contracts/terminal-image.js';
import { saveTerminalImage, sniffImageType } from '../../core/terminal-image-store.js';
import type { TerminalImageRouteDeps } from './shared.js';

/**
 * `POST /api/terminal-images` — save an image the user dropped or pasted into the
 * dashboard terminal and return its host path (contract:
 * `shared/contracts/terminal-image.ts`).
 *
 * This route only stores the file. It never writes to a terminal: the dashboard
 * pastes the returned path over its own terminal WebSocket, which already has
 * the owner, session-generation and attach-readiness checks a REST write
 * would bypass.
 *
 * Access: it sits under `/api/*`, so the standard actor gate applies — owner
 * only; viewer/share credentials are denied by default (not in the viewer
 * allow-list), and browser-origin / CSRF guards run before this handler.
 */
export function registerTerminalImageRoutes(app: Hono, deps: TerminalImageRouteDeps): void {
  app.post(
    TERMINAL_IMAGE_UPLOAD_PATH,
    // The global 1 MB JSON limit skips this path (see routes.ts); the raw image
    // body gets its own, larger cap enforced while the body streams in.
    bodyLimit({
      maxSize: TERMINAL_IMAGE_MAX_BYTES,
      onError: (c) => c.json<TerminalImageUploadError>({
        error: 'request-body-too-large',
        message: `Image exceeds the ${TERMINAL_IMAGE_MAX_BYTES} byte limit`,
        limitBytes: TERMINAL_IMAGE_MAX_BYTES,
      }, 413),
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) {
        return c.json<TerminalImageUploadError>(
          { error: 'empty_body', message: 'Request body is empty; send the raw image bytes.' }, 400);
      }
      const mime = sniffImageType(bytes);
      if (!mime) {
        return c.json<TerminalImageUploadError>(
          { error: 'unsupported_image_type', message: 'Only PNG, JPEG, GIF and WebP images are supported.' }, 415);
      }
      try {
        const saved = await saveTerminalImage(deps.kookrDir, bytes, mime);
        return c.json<TerminalImageUploadResponse>(saved, 201);
      } catch (error) {
        console.error('[terminal-images] failed to save image', error);
        return c.json<TerminalImageUploadError>(
          { error: 'storage_failed', message: 'The server could not save the image.' }, 500);
      }
    },
  );
}
