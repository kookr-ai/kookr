import type { Playbook } from '../shared/protocol.js';

/**
 * Where a playbook matched a search query. Lower sorts first: a playbook whose
 * card text (name, description, tags, file name) holds every search word is a
 * better answer than one that only mentions a word somewhere in its
 * instructions.
 */
export const PLAYBOOK_MATCH_CARD = 0;
export const PLAYBOOK_MATCH_BODY = 1;
export type PlaybookMatchTier = typeof PLAYBOOK_MATCH_CARD | typeof PLAYBOOK_MATCH_BODY;

type SearchablePlaybook = Pick<Playbook, 'id' | 'name' | 'description' | 'tags' | 'body'>;

/** Split a search query into lowercase words. An empty or blank query has none. */
export function playbookSearchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
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
  const card = [playbook.name, playbook.description, playbook.tags.join(' '), playbook.id]
    .join('\n')
    .toLowerCase();
  if (words.every((word) => card.includes(word))) return PLAYBOOK_MATCH_CARD;

  const body = playbook.body.toLowerCase();
  if (words.every((word) => card.includes(word) || body.includes(word))) return PLAYBOOK_MATCH_BODY;
  return null;
}
