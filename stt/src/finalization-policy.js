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
 * @param {number} [params.maxUnprocessedTailSeconds=0.25]
 * @returns {boolean}
 */
export function shouldFinalizeFromCache(params) {
  const {
    lastEmittedTranscription,
    audioSeconds,
    lastProcessedAudioSeconds,
    maxUnprocessedTailSeconds = 0.25,
  } = params;

  if (!lastEmittedTranscription || lastEmittedTranscription.trim().length === 0) {
    return false;
  }

  const unprocessedTailSeconds = Math.max(0, audioSeconds - lastProcessedAudioSeconds);
  return unprocessedTailSeconds < maxUnprocessedTailSeconds;
}

