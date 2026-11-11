import { makeSpeakable } from './speakable-text.js';

/** What is spoken in place of a task title that is missing, long, cut off or not pronounceable. */
export const GENERIC_TASK_NAME = 'This task';

/** Longest title (in words) that is read aloud as it is. */
export const MAX_SPOKEN_TASK_NAME_WORDS = 6;
/** Longest title (in characters) that is read aloud as it is. */
export const MAX_SPOKEN_TASK_NAME_CHARS = 48;

/** A title that is a placeholder, not a name ("Untitled task" is what the agent context uses for a task without a title). */
const PLACEHOLDER_TITLE = /^untitled(?: task)?$/i;

function withoutEndMarks(text: string): string {
  return text.replace(/[.!?…\s]+$/u, '');
}

/**
 * The task title as it may be read aloud in a sentence ("Repository Idea Scout needs
 * your input."), or {@link GENERIC_TASK_NAME} when it may not.
 *
 * A title is spoken only when it is short, complete and already sounds like words:
 * - at most {@link MAX_SPOKEN_TASK_NAME_WORDS} words and {@link MAX_SPOKEN_TASK_NAME_CHARS}
 *   characters, because a long request pasted as a title is tiring to hear and, cut off,
 *   reads as a broken sentence ("can you check whic... is terminated unexpectedly");
 * - not cut off: a title ending in "..." or "…" was shortened by someone, so the rest
 *   of the sentence would be spliced onto half a phrase;
 * - unchanged by the speakable-text rewrite, which means it holds no identifier, path,
 *   hash, issue number or placeholder such as "[redacted]" that would be spoken as
 *   "an ID" or as a mangled word.
 *
 * Pass the title after secret redaction when one applies: the length and cut checks
 * are made on the text given.
 */
export function spokenTaskName(name: string | null | undefined): string {
  const title = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!title || PLACEHOLDER_TITLE.test(withoutEndMarks(title))) return GENERIC_TASK_NAME;
  if (/(?:\.\.\.|…)$/u.test(title)) return GENERIC_TASK_NAME;
  if (title.length > MAX_SPOKEN_TASK_NAME_CHARS) return GENERIC_TASK_NAME;
  if (title.split(' ').length > MAX_SPOKEN_TASK_NAME_WORDS) return GENERIC_TASK_NAME;
  if (withoutEndMarks(makeSpeakable(title)) !== withoutEndMarks(title)) return GENERIC_TASK_NAME;
  return title;
}

/** True for the text {@link spokenTaskName} returns when the title may not be read aloud. */
export function isGenericTaskName(spoken: string): boolean {
  return spoken === GENERIC_TASK_NAME;
}
