const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

// The aligner can split contractions or remove punctuation. Compare spoken
// characters while keeping the original transcript for every displayed sentence.
function spokenCharacters(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/**
 * Recover sentence boundaries from Qwen's punctuated transcript. Its aligner
 * returns bare words, so grouping those words directly would prevent the
 * progressive window from sliding. Only use timestamps when every character
 * matches in order and each sentence boundary falls between aligned words.
 * On disagreement, return no fixed sentences; the full text remains editable.
 *
 * @param {string} text
 * @param {Array<{word: string, start: number, end: number}>} words
 * @param {number} audioDuration - Maximum valid timestamp, in seconds.
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function sentencesFromQwenAlignment(text, words, audioDuration) {
  if (!text || !Array.isArray(words) || words.length === 0) return [];
  if (!Number.isFinite(audioDuration) || audioDuration < 0) return [];

  const boundaries = new Map();
  let alignedCharacters = '';
  let previousEnd = 0;
  for (const [index, word] of words.entries()) {
    if (typeof word?.word !== 'string'
      || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < previousEnd || word.end < word.start
      || word.end > audioDuration + 1e-6) return [];
    const characters = spokenCharacters(word.word);
    if (!characters) return [];
    alignedCharacters += characters;
    boundaries.set(alignedCharacters.length, index);
    previousEnd = word.end;
  }
  if (alignedCharacters !== spokenCharacters(text)) return [];

  const sentences = [];
  let characterOffset = 0;
  let wordIndex = 0;
  const segments = [...sentenceSegmenter.segment(text)].map(({ segment }) => segment);
  // ICU can place a spaced French closing guillemet at the next sentence's
  // beginning. Keep closing punctuation with the sentence it closes.
  for (let index = 1; index < segments.length; index++) {
    const closing = segments[index].match(/^[\s\p{Pe}\p{Pf}]+/u)?.[0];
    if (closing) {
      segments[index - 1] += closing;
      segments[index] = segments[index].slice(closing.length);
    }
  }
  for (const segment of segments.filter((value) => value.trim())) {
    const characters = spokenCharacters(segment);
    if (!characters) return [];
    characterOffset += characters.length;
    const endIndex = boundaries.get(characterOffset);
    if (endIndex === undefined) return [];
    sentences.push({ text: segment.trim(), start: words[wordIndex].start, end: words[endIndex].end });
    wordIndex = endIndex + 1;
  }
  return sentences;
}
