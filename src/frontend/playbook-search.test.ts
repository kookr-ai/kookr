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
  test('splits on any whitespace, lowercases, and drops blanks', () => {
    expect(playbookSearchWords('  Notebook \t SHELF\nreview ')).toEqual(['notebook', 'shelf', 'review']);
  });

  test('a blank query has no words', () => {
    expect(playbookSearchWords('   ')).toEqual([]);
  });
});

describe('matchPlaybookSearch', () => {
  test('a word in the name is a card match', () => {
    // "review" is in the name only: not in the description, tags or file name.
    expect(match('review')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('a word in the description is a card match, whatever its case', () => {
    expect(match('HOOK')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('a tag is a card match', () => {
    expect(match('memory')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('the file name is a card match, at every keystroke of typing it with its extension', () => {
    expect(match('lesson-retrofit')).toBe(PLAYBOOK_MATCH_CARD);
    expect(match('notebook-lesson-retrofit.')).toBe(PLAYBOOK_MATCH_CARD);
    expect(match('notebook-lesson-retrofit.m')).toBe(PLAYBOOK_MATCH_CARD);
    expect(match('notebook-lesson-retrofit.md')).toBe(PLAYBOOK_MATCH_CARD);
  });

  test('the file extension alone matches nothing, so "md" still filters', () => {
    expect(match('md')).toBeNull();
    expect(match('.md')).toBeNull();
  });

  test('a word naming some other file is not shortened to match', () => {
    // "shelf" is in the instructions; "shelf.md" is nowhere.
    expect(match('shelf.md')).toBeNull();
  });

  test('a word found only in the instructions is a body match, whatever its case', () => {
    expect(match('shelf')).toBe(PLAYBOOK_MATCH_BODY);
    // The instructions say "Take"; the query is lowercased.
    expect(match('take')).toBe(PLAYBOOK_MATCH_BODY);
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
    expect(match('shelf kubernetes')).toBeNull();
  });

  test('a word does not match across two fields', () => {
    // The name ends "Review" and the description starts "Read".
    expect(match('reviewread')).toBeNull();
    // "workflow" and "analysis" are neighbouring tags.
    expect(match('workflowanalysis')).toBeNull();
  });

  test('a trailing space does not hide a match', () => {
    expect(match('review ')).toBe(PLAYBOOK_MATCH_CARD);
  });
});
