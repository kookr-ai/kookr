/**
 * Decides whether a final transcript from the speech recogniser is worth answering.
 *
 * On near-silence the recogniser invents text. Observed in practice: "Merci.",
 * "Sous-titrage ST' 501", "Thank you." Answering those would make Lucy reply to nobody,
 * so the turn ends as "empty" instead. The price is that a lone "thank you" is ignored.
 */

/** Known silence hallucinations, lower-case with punctuation removed. */
const HALLUCINATIONS = new Set([
  'merci', 'merci beaucoup', 'merci a tous', 'thank you', 'thanks', 'thank you very much',
  'thanks for watching', 'thank you for watching', 'merci d avoir regarde cette video',
  'you', 'bye', 'bye bye', 'au revoir', 'okay', 'ok',
]);

/** Subtitle-credit boilerplate the model learned from video captions. */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^sous titr/,
  /^subtitles? by\b/,
  /^amara org/,
  /^transcribed by\b/,
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the transcript has fewer than two letters or is a known silence hallucination. */
export function isEmptyTranscript(text: string): boolean {
  const trimmed = text.trim();
  if ((trimmed.match(/\p{L}/gu) ?? []).length < 2) return true;
  const norm = normalise(trimmed);
  if (HALLUCINATIONS.has(norm)) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(norm));
}
