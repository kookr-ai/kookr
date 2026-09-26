/**
 * Decide whether stop finalization can safely reuse cached progressive text.
 *
 * Reusing cache avoids an extra model pass in the stop handler, which can be
 * fragile in some ORT/parakeet.js combinations.
 *
 * @param {object} params
 * @param {string} params.lastEmittedTranscription
 * @param {number} params.audioSeconds
 * @param {number} params.lastProcessedAudioSeconds
 * @returns {boolean}
 */
export function shouldFinalizeFromCache(params) {
  const {
    lastEmittedTranscription,
    audioSeconds,
    lastProcessedAudioSeconds,
  } = params;

  if (!lastEmittedTranscription || lastEmittedTranscription.trim().length === 0) {
    return false;
  }

  // Even a short unprocessed tail can contain the final word. Both positions
  // are session-relative, including samples trimmed from the rolling buffer.
  return audioSeconds === lastProcessedAudioSeconds;
}
