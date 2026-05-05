/**
 * Group word-level timestamps into sentence-level groups.
 *
 * Splits on terminal punctuation (.!?) to approximate sentence boundaries.
 * Parakeet provides word-level alignments; this groups them for progressive
 * streaming window management.
 *
 * FR-STT-015: Progressive Streaming Transcription
 *
 * @param {Array<{text: string, start_time: number, end_time: number}>} words
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function groupWordsIntoSentences(words) {
  if (!words || words.length === 0) {
    return [];
  }

  const sentences = [];
  let currentWords = [];
  let currentStart = words[0].start_time || 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    currentWords.push(word.text);

    const endsWithTerminalPunctuation = /[.!?]$/.test(word.text);

    if (endsWithTerminalPunctuation || i === words.length - 1) {
      sentences.push({
        text: currentWords.join(' ').trim(),
        start: currentStart,
        end: word.end_time || word.start_time || 0,
      });

      if (i < words.length - 1) {
        currentWords = [];
        currentStart = words[i + 1].start_time || word.end_time || 0;
      }
    }
  }

  return sentences;
}
