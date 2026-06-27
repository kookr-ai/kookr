export interface ReplySnippet {
  label: string;
  text: string;
}

export const MAX_REPLY_SNIPPETS = 20;

export function validateReplySnippets(raw: unknown): { snippets: ReplySnippet[]; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { snippets: [], warnings };
  if (!Array.isArray(raw)) {
    warnings.push('Invalid replySnippets (expected an array); ignored');
    return { snippets: [], warnings };
  }

  const snippets: ReplySnippet[] = [];
  raw.forEach((entry, index) => {
    if (snippets.length >= MAX_REPLY_SNIPPETS) return;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`Invalid replySnippets[${index}] (expected an object); ignored`);
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    if (!label || !text) {
      warnings.push(`Invalid replySnippets[${index}] (label and text must be non-empty strings); ignored`);
      return;
    }
    snippets.push({ label, text });
  });

  if (raw.length > MAX_REPLY_SNIPPETS) {
    warnings.push(`replySnippets capped at ${MAX_REPLY_SNIPPETS} entries`);
  }

  return { snippets, warnings };
}

