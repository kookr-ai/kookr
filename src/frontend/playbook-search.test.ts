import { describe, expect, test } from 'vitest';
import {
  matchPlaybookSearch,
  playbookSearchWords,
  PLAYBOOK_MATCH_BODY,
  PLAYBOOK_MATCH_CARD,
} from './playbook-search.js';

const retrofit = {
  id: 'notebook-lesson-retrofit.md',
  name: 'Notebook Lesson Retrofit Review',
  description: 'Read what the agent-notebook lessons say and find the ones a hook could make unnecessary.',
  tags: ['workflow', 'analysis', 'memory'],
  body: 'Take a snapshot of every shelf, then group the entries across shelves.',
};

function match(query: string) {
  return matchPlaybookSearch(retrofit, playbookSearchWords(query));
}

describe('playbookSearchWords', () => {
  test('splits on whitespace, lowercases, and drops blanks', () => {
    expect(playbookSearchWords('  Notebook   SHELF ')).toEqual(['notebook', 'shelf']);
  });

  test('a blank query has no words', () => {
    expect(playbookSearchWords('   ')).toEqual([]);
  });
});

describe('matchPlaybookSearch', () => {
  test('a word in the name or description is a card match', () => {
    expect(match('retrofit')).toBe(PLAYBOOK_MATCH_CARD);
    expect(match('HOOK')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('a tag is a card match', () => {
    expect(match('memory')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('the file name is a card match', () => {
    expect(match('lesson-retrofit.md')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('a word found only in the instructions is a body match', () => {
    expect(match('shelf')).toBe(PLAYBOOK_MATCH_BODY);
  });

  test('words may be in any order and in different card fields', () => {
    // "review" is in the name, "memory" is a tag, "hook" is in the description.
    expect(match('memory review hook')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('one word on the card and one in the instructions is a body match', () => {
    expect(match('notebook shelf')).toBe(PLAYBOOK_MATCH_BODY);
  });

  test('no match when any word appears nowhere', () => {
    expect(match('notebook kubernetes')).toBeNull();
  });

  test('a trailing space does not hide a match', () => {
    expect(match('review ')).toBe(PLAYBOOK_MATCH_CARD);
  });
});
