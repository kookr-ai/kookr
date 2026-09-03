import { describe, test, expect } from 'vitest';
import { selectRecentManualPrompts, type RecentPromptTask } from './recent-manual-prompts.js';
import type { TaskProvenanceKind } from '../shared/contracts/task.js';

interface TaskParts {
  prompt?: string;
  userPrompt?: string;
  cwd?: string;
  createdAt: number; // epoch ms, for readable fixtures
  kind?: TaskProvenanceKind;
}

function task(parts: TaskParts): RecentPromptTask {
  return {
    prompt: parts.prompt ?? parts.userPrompt ?? '',
    ...(parts.userPrompt !== undefined ? { userPrompt: parts.userPrompt } : {}),
    cwd: parts.cwd ?? '/repo',
    createdAt: new Date(parts.createdAt),
    ...(parts.kind !== undefined ? { provenance: { kind: parts.kind } } : {}),
  } as RecentPromptTask;
}

describe('selectRecentManualPrompts', () => {
  test('returns only manual-provenance tasks with a non-empty prompt', () => {
    const tasks = [
      task({ userPrompt: 'manual one', createdAt: 3, kind: 'manual' }),
      task({ userPrompt: 'scheduled', createdAt: 2, kind: 'schedule' }),
      task({ userPrompt: 'child', createdAt: 1, kind: 'parent' }),
      task({ userPrompt: '   ', createdAt: 4, kind: 'manual' }), // blank → dropped
    ];
    const out = selectRecentManualPrompts(tasks, { limit: 20 });
    expect(out.map((e) => e.prompt)).toEqual(['manual one']);
  });

  test('excludes legacy unknown-provenance tasks (documented backfill horizon)', () => {
    const tasks = [
      task({ userPrompt: 'pre-1583', createdAt: 2, kind: 'unknown' }),
      task({ userPrompt: 'modern', createdAt: 1, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { limit: 20 });
    expect(out.map((e) => e.prompt)).toEqual(['modern']);
  });

  test('orders most-recent first', () => {
    const tasks = [
      task({ userPrompt: 'older', createdAt: 1, kind: 'manual' }),
      task({ userPrompt: 'newer', createdAt: 2, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { limit: 20 });
    expect(out.map((e) => e.prompt)).toEqual(['newer', 'older']);
  });

  test('dedups on trimmed display text; newest occurrence supplies cwd/at', () => {
    const tasks = [
      task({ userPrompt: 'review the diff', cwd: '/a', createdAt: 1, kind: 'manual' }),
      task({ userPrompt: 'review the diff', cwd: '/b', createdAt: 5, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { limit: 20 });
    expect(out).toHaveLength(1);
    expect(out[0].cwd).toBe('/b'); // most recent
    expect(out[0].at).toBe(5);
  });

  test('cwdMatch is true if ANY occurrence used the query cwd, before the cap (F3)', () => {
    // Prompt run 3× in /a, then most recently once in /b. Query cwd = /a.
    const tasks = [
      task({ userPrompt: 'my review prompt', cwd: '/a', createdAt: 1, kind: 'manual' }),
      task({ userPrompt: 'my review prompt', cwd: '/a', createdAt: 2, kind: 'manual' }),
      task({ userPrompt: 'my review prompt', cwd: '/a', createdAt: 3, kind: 'manual' }),
      task({ userPrompt: 'my review prompt', cwd: '/b', createdAt: 9, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { cwd: '/a', limit: 20 });
    expect(out).toHaveLength(1);
    expect(out[0].cwdMatch).toBe(true);
    // Display cwd is still the most-recent occurrence's (/b) — the tag says "elsewhere".
    expect(out[0].cwd).toBe('/b');
  });

  test('cwd-matched prompts rank ahead of non-matches (before the cap)', () => {
    const tasks = [
      task({ userPrompt: 'unrelated newer', cwd: '/other', createdAt: 100, kind: 'manual' }),
      task({ userPrompt: 'repo prompt older', cwd: '/target', createdAt: 1, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { cwd: '/target', limit: 1 });
    // Even though 'unrelated newer' is more recent, the cwd match wins the single slot.
    expect(out.map((e) => e.prompt)).toEqual(['repo prompt older']);
  });

  test('normalizeCwd is applied to both query and task cwd (trailing slash)', () => {
    const tasks = [
      task({ userPrompt: 'p', cwd: '/work/proj', createdAt: 1, kind: 'manual' }),
    ];
    // Trailing slash on the query; the default normalizer strips it, so it matches.
    const out = selectRecentManualPrompts(tasks, { cwd: '/work/proj/', limit: 20 });
    expect(out[0].cwdMatch).toBe(true);
  });

  test('an injected normalizeCwd can canonicalize (e.g. ~ expansion)', () => {
    const tasks = [
      task({ userPrompt: 'p', cwd: '/work/proj', createdAt: 1, kind: 'manual' }),
    ];
    const normalizeCwd = (c: string) => c.replace(/^~/, '/work');
    const out = selectRecentManualPrompts(tasks, { cwd: '~/proj', limit: 20, normalizeCwd });
    expect(out[0].cwdMatch).toBe(true);
  });

  test('legacy prompt with injected guardrail converges with the clean userPrompt (F10)', () => {
    // Matches the structural guardrail preamble stripWorktreeGuardrailPrefix
    // recognizes: anchor line + one or more "- " bullets + blank line + body.
    const guarded =
      'You are currently in the git worktree `/x`.\n' +
      '- Do NOT commit to main.\n\n' +
      'fix the auth bug';
    const tasks = [
      // Legacy record: no userPrompt, prompt carries the guardrail preamble.
      task({ prompt: guarded, cwd: '/x', createdAt: 1, kind: 'manual' }),
      // New record: clean userPrompt of the same instruction.
      task({ userPrompt: 'fix the auth bug', cwd: '/x', createdAt: 2, kind: 'manual' }),
    ];
    const out = selectRecentManualPrompts(tasks, { limit: 20 });
    // Both strip to 'fix the auth bug' → one entry, no injected guidance shown.
    expect(out).toHaveLength(1);
    expect(out[0].prompt).toBe('fix the auth bug');
  });

  test('caps at limit', () => {
    const tasks = Array.from({ length: 30 }, (_, i) =>
      task({ userPrompt: `p${i}`, createdAt: i, kind: 'manual' }),
    );
    expect(selectRecentManualPrompts(tasks, { limit: 5 })).toHaveLength(5);
  });

  test('limit is clamped to the hard max (50)', () => {
    const tasks = Array.from({ length: 80 }, (_, i) =>
      task({ userPrompt: `p${i}`, createdAt: i, kind: 'manual' }),
    );
    expect(selectRecentManualPrompts(tasks, { limit: 999 })).toHaveLength(50);
  });

  test('limit 0 returns empty', () => {
    const tasks = [task({ userPrompt: 'p', createdAt: 1, kind: 'manual' })];
    expect(selectRecentManualPrompts(tasks, { limit: 0 })).toEqual([]);
  });

  test('empty input returns empty', () => {
    expect(selectRecentManualPrompts([], { limit: 20 })).toEqual([]);
  });
});
