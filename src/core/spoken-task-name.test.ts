import { describe, expect, test } from 'vitest';
import { makeSpeakable } from './speakable-text.js';
import {
  GENERIC_TASK_NAME,
  isGenericTaskName,
  MAX_SPOKEN_TASK_NAME_CHARS,
  spokenTaskName,
} from './spoken-task-name.js';

describe('spokenTaskName', () => {
  test('the generic phrase is "This task"', () => {
    expect(GENERIC_TASK_NAME).toBe('This task');
    expect(isGenericTaskName('This task')).toBe(true);
    expect(isGenericTaskName('Fix auth')).toBe(false);
  });

  test('keeps a short, complete title as it is', () => {
    expect(spokenTaskName('Repository Idea Scout')).toBe('Repository Idea Scout');
    expect(spokenTaskName('Fix auth')).toBe('Fix auth');
    expect(spokenTaskName('T')).toBe('T');
    expect(spokenTaskName('3')).toBe('3');
  });

  test('flattens whitespace and trims', () => {
    expect(spokenTaskName('  Fix \n  auth  ')).toBe('Fix auth');
  });

  describe('word boundary: 6 words are spoken, 7 are not', () => {
    test('6 words', () => {
      expect(spokenTaskName('one two three four five six')).toBe('one two three four five six');
    });
    test('7 words', () => {
      expect(spokenTaskName('one two three four five six seven')).toBe(GENERIC_TASK_NAME);
    });
  });

  describe('character boundary: 48 are spoken, 49 are not', () => {
    const word = (n: number) => 'a'.repeat(n);
    test('48 characters', () => {
      const title = `${word(23)} ${word(24)}`; // 23 + 1 + 24 = 48
      expect(title).toHaveLength(MAX_SPOKEN_TASK_NAME_CHARS);
      expect(spokenTaskName(title)).toBe(title);
    });
    test('49 characters', () => {
      const title = `${word(24)} ${word(24)}`;
      expect(title).toHaveLength(MAX_SPOKEN_TASK_NAME_CHARS + 1);
      expect(spokenTaskName(title)).toBe(GENERIC_TASK_NAME);
    });
  });

  describe('a cut title is never spoken', () => {
    test.each(['Fix the login...', 'Fix the login…', 'Fix the login ...', 'Fix the login.....', '...', '…'])('%j', (title) => {
      expect(spokenTaskName(title)).toBe(GENERIC_TASK_NAME);
    });
    test('an ellipsis in the middle is not a cut', () => {
      expect(spokenTaskName('Wait... what')).toBe('Wait... what');
    });
    test('a trailing full stop is not a cut', () => {
      expect(spokenTaskName('Fix auth.')).toBe('Fix auth.');
    });
  });

  describe('empty or placeholder titles', () => {
    test.each([undefined, null, '', '   ', '\n\t '])('%j', (title) => {
      expect(spokenTaskName(title)).toBe(GENERIC_TASK_NAME);
    });
    test.each(['Untitled task', 'untitled task.', 'Untitled'])('placeholder %j', (title) => {
      expect(spokenTaskName(title)).toBe(GENERIC_TASK_NAME);
    });
  });

  describe('titles the speakable rewrite would change are not spoken', () => {
    test('a UUID-looking title', () => {
      expect(spokenTaskName('123e4567-e89b-12d3-a456-426614174000')).toBe(GENERIC_TASK_NAME);
    });
    test('a path-looking title', () => {
      expect(spokenTaskName('src/core/speakable-text.ts')).toBe(GENERIC_TASK_NAME);
    });
    test('an issue number and a snake_case identifier', () => {
      expect(spokenTaskName('Fix #123')).toBe(GENERIC_TASK_NAME);
      expect(spokenTaskName('fix_the_bug')).toBe(GENERIC_TASK_NAME);
    });
    test('the redaction placeholder', () => {
      expect(spokenTaskName('Secret [redacted]')).toBe(GENERIC_TASK_NAME);
    });
  });

  test('a spoken title is a fixed point of the speakable step (modulo the final period)', () => {
    for (const title of ['Repository Idea Scout', 'Fix auth', 'Refactor auth.', 'Wait... what']) {
      const spoken = spokenTaskName(title);
      expect(makeSpeakable(spoken).replace(/\.$/, '')).toBe(spoken.replace(/\.$/, ''));
    }
  });
});
