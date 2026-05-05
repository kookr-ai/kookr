import { wasmBackend } from './wasm-backend.js';
import { whisperBackend } from './whisper-backend.js';
import { STT_BACKEND_FLAG, STT_WASM_FALLBACK_FLAG } from './feature-flags.js';

/**
 * Create the active transcription backend based on STT_BACKEND.
 *
 * @returns {import('./types.js').TranscriptionBackend}
 */
export function createTranscriptionBackend() {
  const backend = process.env[STT_BACKEND_FLAG.envVar] || STT_BACKEND_FLAG.defaultValue;
  const wasmFallbackEnabled =
    (process.env[STT_WASM_FALLBACK_FLAG.envVar] ?? STT_WASM_FALLBACK_FLAG.defaultValue) === 'true';

  switch (backend) {
    case 'whisper':
      return whisperBackend;
    case 'wasm':
      if (!wasmFallbackEnabled) {
        console.warn(
          `Ignoring ${STT_BACKEND_FLAG.envVar}="wasm" because ${STT_WASM_FALLBACK_FLAG.envVar} is not true; using whisper`,
        );
        return whisperBackend;
      }
      return wasmBackend;
    default:
      console.warn(
        `Unknown ${STT_BACKEND_FLAG.envVar} "${backend}", falling back to whisper`,
      );
      return whisperBackend;
  }
}

export { wasmBackend, whisperBackend };
