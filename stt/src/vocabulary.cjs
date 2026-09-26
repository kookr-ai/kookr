'use strict';

const {
  defaultVocabulary: DEFAULT_VOCABULARY,
  maxCharacters: MAX_VOCABULARY_CHARACTERS,
} = require('../qwen/vocabulary.json');

/**
 * Share terminology overrides across dictation clients. Whisper hints are
 * opt-in; Qwen clients leave an absent hint to their service's configuration.
 * An explicit empty string disables the hint.
 * Count Unicode code points, matching Python's request validation.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{useDefault?: boolean}} [options]
 * @returns {string | undefined}
 */
function resolveVocabulary(env = process.env, { useDefault = false } = {}) {
  const vocabulary = env.STT_VOCABULARY ?? (useDefault ? DEFAULT_VOCABULARY : undefined);
  if (vocabulary !== undefined && [...vocabulary].length > MAX_VOCABULARY_CHARACTERS) {
    throw new Error(`STT_VOCABULARY must contain at most ${MAX_VOCABULARY_CHARACTERS} characters`);
  }
  return vocabulary;
}

module.exports = { DEFAULT_VOCABULARY, MAX_VOCABULARY_CHARACTERS, resolveVocabulary };
