import { describe, test, expect } from 'vitest';
import { displayPromptForTask, stripWorktreeGuardrailPrefix } from './prompt-display.js';
import {
  GUARDRAIL_PREFIXED_USER_PROMPT,
  GUARDRAIL_PREFIXED_USER_PROMPT_BODY,
} from './__fixtures__/prompt-intake-fixtures.js';

describe('displayPromptForTask', () => {
  test('returns userPrompt verbatim when it carries no guardrail preamble', () => {
    expect(displayPromptForTask({ prompt: 'guarded…', userPrompt: 'Fix the auth bug' }))
      .toBe('Fix the auth bug');
  });

  // Issue #1556 (task 447580f6): a userPrompt that itself begins with the
  // worktree-guardrail preamble must be displayed without it — not verbatim.
  test('strips the guardrail preamble from userPrompt', () => {
    expect(displayPromptForTask({ prompt: 'ignored', userPrompt: GUARDRAIL_PREFIXED_USER_PROMPT }))
      .toBe(GUARDRAIL_PREFIXED_USER_PROMPT_BODY);
  });

  test('falls back to stripping the legacy prompt when userPrompt is absent', () => {
    expect(displayPromptForTask({ prompt: GUARDRAIL_PREFIXED_USER_PROMPT }))
      .toBe(GUARDRAIL_PREFIXED_USER_PROMPT_BODY);
  });

  test('returns the raw prompt when no guardrail preamble is present', () => {
    expect(displayPromptForTask({ prompt: 'Just a plain prompt' }))
      .toBe('Just a plain prompt');
  });
});

describe('stripWorktreeGuardrailPrefix', () => {
  test('strips the current preamble shape, including the "When an investigation…" bullet', () => {
    expect(stripWorktreeGuardrailPrefix(GUARDRAIL_PREFIXED_USER_PROMPT))
      .toBe(GUARDRAIL_PREFIXED_USER_PROMPT_BODY);
  });

  test('leaves non-guardrail text unchanged', () => {
    const prose = 'You are currently in the middle of a refactor.\n\nMore context here.';
    expect(stripWorktreeGuardrailPrefix(prose)).toBe(prose);
    expect(stripWorktreeGuardrailPrefix('Fix the bug')).toBe('Fix the bug');
  });
});
