/**
 * Feature flag metadata for STT backend routing.
 */
export const STT_BACKEND_FLAG = Object.freeze({
  key: 'ops.stt_backend',
  envVar: 'STT_BACKEND',
  defaultValue: 'whisper',
  allowedValues: ['whisper', 'wasm'],
});

export const STT_WASM_FALLBACK_FLAG = Object.freeze({
  key: 'ops.stt_wasm_fallback',
  envVar: 'STT_ENABLE_WASM_FALLBACK',
  defaultValue: 'false',
});
