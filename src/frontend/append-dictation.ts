/** Append a completed recording without changing text already in the draft. */
export function appendDictation(draft: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return draft;
  const separator = draft && !/\s$/.test(draft) ? ' ' : '';
  return `${draft}${separator}${text}`;
}
