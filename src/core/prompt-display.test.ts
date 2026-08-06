import { describe, test, expect } from 'vitest';
import { displayPromptForTask, stripWorktreeGuardrailPrefix } from './prompt-display.js';
import {
  GUARDRAIL_PREFIXED_USER_PROMPT,
  GUARDRAIL_PREFIXED_USER_PROMPT_BODY,
} from './__fixtures__/prompt-intake-fixtures.js';

// The `git worktree` alternation of the anchor line (the shared fixture covers
// the `main checkout` alternation), with `*` bullets to exercise the `[-*]`
// bullet class. Kept inline so the two anchor shapes sit side by side.
const WORKTREE_GUARDED_PROMPT = [
  'You are currently in the git worktree `/path/to/wt` on branch `feat-x`. Do NOT commit to main.',
  "* Refresh the remote base first: `git fetch origin 'main'`.",
  "* Create one: `git worktree add ../kookr-x -b feat-x 'origin/main'`",
  '',
  'Harden the retrieval scorer against empty shelves.',
].join('\n');
const WORKTREE_GUARDED_PROMPT_BODY = 'Harden the retrieval scorer against empty shelves.';

// A prompt that is nothing but the guardrail preamble — the body after the
// blank line is empty. Strips to '' so the `|| original` fallback fires.
const GUARDRAIL_ONLY_PROMPT = 'You are currently in the main checkout `/repo` on branch `main`.\n- Refresh the remote base first: `git fetch origin main`.\n\n';

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

  test('strips the git worktree alternation of the anchor line', () => {
    expect(displayPromptForTask({ prompt: WORKTREE_GUARDED_PROMPT }))
      .toBe(WORKTREE_GUARDED_PROMPT_BODY);
  });

  // A whitespace-only userPrompt is falsy after trim, so it must fall through to
  // the legacy prompt path rather than being displayed as a blank string.
  test('falls through to the prompt when userPrompt is whitespace-only', () => {
    expect(displayPromptForTask({ prompt: WORKTREE_GUARDED_PROMPT, userPrompt: '   \n\t' }))
      .toBe(WORKTREE_GUARDED_PROMPT_BODY);
  });

  // When the guardrail body strips to empty, the `|| original` fallback returns
  // the full prompt rather than an empty display string.
  test('returns the full prompt when the guardrail body is empty', () => {
    expect(displayPromptForTask({ prompt: GUARDRAIL_ONLY_PROMPT }))
      .toBe(GUARDRAIL_ONLY_PROMPT);
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

  test('strips the git worktree anchor with asterisk bullets', () => {
    expect(stripWorktreeGuardrailPrefix(WORKTREE_GUARDED_PROMPT))
      .toBe(WORKTREE_GUARDED_PROMPT_BODY);
  });

  // A bullet block is required: an anchor line followed straight by a blank line
  // (no "- " bullets) is not a guardrail preamble and must pass through.
  test('leaves an anchor line with no bullet block unchanged', () => {
    const noBullets = 'You are currently in the main checkout `/repo` on branch `main`.\n\nBody.';
    expect(stripWorktreeGuardrailPrefix(noBullets)).toBe(noBullets);
  });

  test('returns an empty string when the guardrail body is empty', () => {
    expect(stripWorktreeGuardrailPrefix(GUARDRAIL_ONLY_PROMPT)).toBe('');
  });
});
