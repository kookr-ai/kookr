/**
 * Normalized word-level timestamp from any backend.
 * @typedef {Object} TranscriptionWord
 * @property {string} text - The word text.
 * @property {number} start_time - Start time in seconds.
 * @property {number} end_time - End time in seconds.
 */

/**
 * Normalized transcription result from any backend.
 * @typedef {Object} TranscriptionResult
 * @property {string} text - Full transcription text.
 * @property {TranscriptionWord[]} words - Word-level timestamps.
 */

/**
 * Options belong to one inference request. Backends can be shared by clients,
 * so they must not store a client's language as mutable backend state.
 * @typedef {Object} TranscriptionOptions
 * @property {string} [language='auto'] - Spoken language code, or 'auto' to detect it.
 */

/**
 * Backend interface consumed by SmartProgressiveStreamingHandler.
 * Qwen and Whisper honor the language hint; the optional WASM backend does not pass
 * the hint to its model and keeps its existing transcription behavior.
 * @typedef {Object} TranscriptionBackend
 * @property {string} name - Backend name.
 * @property {string} [modelName] - Configured model identifier for recording provenance.
 * @property {(audioWindow: Float32Array, options?: TranscriptionOptions) => Promise<{text: string, sentences: Array<{text: string, start: number, end: number}>, recognition?: Record<string, unknown> | null}>} transcribe
 * @property {() => Promise<{ready: boolean, modelName: string, device: string, runtimeBackend: string, configId?: string}>} [getHealth] - Probe an upstream model instead of reporting the unused local WASM model.
 */

export {};
