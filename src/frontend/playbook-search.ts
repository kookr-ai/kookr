import type { Playbook } from '../shared/protocol.js';

/**
 * Where a playbook matched a search query. Lower sorts first: a playbook whose
 * card text (name, description, tags, file name) holds every search word is a
 * better answer than one that needs its instructions to match.
 */
export const PLAYBOOK_MATCH_CARD = 0;
export const PLAYBOOK_MATCH_BODY = 1;
export type PlaybookMatchTier = typeof PLAYBOOK_MATCH_CARD | typeof PLAYBOOK_MATCH_BODY;

type SearchablePlaybook = Pick<Playbook, 'id' | 'name' | 'description' | 'tags' | 'body'>;

/** Every playbook file is `<name>.md`, so the extension tells playbooks apart from nothing. */
const PLAYBOOK_EXTENSION = '.md';

/** Split a search query into lowercase words. An empty or blank query has none. */
export function playbookSearchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when `word` occurs in the file name somewhere other than wholly inside
 * the `.md` extension. Without that exception the word "md" would match every
 * playbook and filter nothing. A whole file name typed with its extension
 * still matches, at every keystroke, because it starts before the extension.
 */
function fileNameHasWord(fileName: string, word: string): boolean {
  const stemLength = fileName.endsWith(PLAYBOOK_EXTENSION)
    ? fileName.length - PLAYBOOK_EXTENSION.length
    : fileName.length;
  const at = fileName.indexOf(word);
  return at !== -1 && at < stemLength;
}

/**
 * Decide whether a playbook matches every search word, and where.
 *
 * Words may appear in any order and in different fields ("notebook shelf"
 * matches a playbook named "Notebook …" whose instructions mention shelves).
 * The instructions (`body`) are searched too, because the words an operator
 * remembers a workflow by are often in its steps and not in its one-line
 * description. Returns `null` when some word appears nowhere.
 */
export function matchPlaybookSearch(
  playbook: SearchablePlaybook,
  words: readonly string[],
): PlaybookMatchTier | null {
  // Joined with newlines so a word cannot match across two fields.
  const cardText = [playbook.name, playbook.description, ...playbook.tags].join('\n').toLowerCase();
  const fileName = playbook.id.toLowerCase();
  const onCard = (word: string) => cardText.includes(word) || fileNameHasWord(fileName, word);
  if (words.every(onCard)) return PLAYBOOK_MATCH_CARD;

  const body = playbook.body.toLowerCase();
  if (words.every((word) => onCard(word) || body.includes(word))) return PLAYBOOK_MATCH_BODY;
  return null;
}
