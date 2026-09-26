export const DEFAULT_VOCABULARY: string;
export const MAX_VOCABULARY_CHARACTERS: number;
export function resolveVocabulary(
  env?: Record<string, string | undefined>,
  options?: { useDefault?: boolean },
): string | undefined;
