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
 * Backend interface consumed by SmartProgressiveStreamingHandler.
 * @typedef {Object} TranscriptionBackend
 * @property {string} name - Backend name.
 * @property {(audioWindow: Float32Array) => Promise<{text: string, sentences: Array<{text: string, start: number, end: number}>}>} transcribe
 */

export {};
