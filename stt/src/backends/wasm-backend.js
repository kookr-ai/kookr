import { transcribe } from '../model-loader.js';
import { groupWordsIntoSentences } from '../sentence-grouper.js';

/**
 * @typedef {import('./types.js').TranscriptionBackend} TranscriptionBackend
 */

/** @type {TranscriptionBackend} */
export const wasmBackend = {
  name: 'wasm',

  async transcribe(audioWindow) {
    const result = await transcribe(audioWindow);
    const sentences = groupWordsIntoSentences(result.words);
    return { text: result.text, sentences };
  },
};
