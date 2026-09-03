import { describe, test, expect } from 'vitest';
import { parseRecentPromptsResponse, type RecentPromptEntry } from './recent-prompts.js';

const good: RecentPromptEntry = { prompt: 'p', cwd: '/r', at: 123, cwdMatch: true };

describe('parseRecentPromptsResponse', () => {
  test('accepts a well-formed array and returns fresh entries', () => {
    const out = parseRecentPromptsResponse([good]);
    expect(out).toEqual([good]);
    expect(out).not.toBe(good); // shallow-copied, not aliased
  });

  test('accepts the empty array', () => {
    expect(parseRecentPromptsResponse([])).toEqual([]);
  });

  test('returns null for a non-array body', () => {
    expect(parseRecentPromptsResponse(null)).toBeNull();
    expect(parseRecentPromptsResponse({})).toBeNull();
    expect(parseRecentPromptsResponse('nope')).toBeNull();
    expect(parseRecentPromptsResponse(undefined)).toBeNull();
  });

  test('returns null when any entry has the wrong shape', () => {
    expect(parseRecentPromptsResponse([{ prompt: 'p', cwd: '/r', at: 1 }])).toBeNull(); // missing cwdMatch
    expect(parseRecentPromptsResponse([{ prompt: 'p', cwd: '/r', at: '1', cwdMatch: true }])).toBeNull(); // at not a number
    expect(parseRecentPromptsResponse([good, 42])).toBeNull(); // one bad item poisons the batch
  });
});
