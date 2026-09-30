/**
 * First-agent starter prompts (issues #2582, #3397).
 *
 * Shared by the Launch dialog Manual tab and the empty overview so both
 * surfaces offer the same three suggestions. A click fills the description
 * only — cwd and Launch stay operator-controlled. Keep the set tiny,
 * local-first, and non-destructive.
 */
export const SAMPLE_LAUNCH_PROMPTS = [
  {
    id: 'review-diff',
    label: 'Review the latest diff',
    prompt: 'Review the diff since origin/main and summarize risks',
  },
  {
    id: 'run-tests',
    label: 'Run tests and fix failures',
    prompt: 'Run tests and fix failures',
  },
  {
    id: 'explain-status',
    label: 'Explain git status',
    prompt: 'Explain git status and the last few commits',
  },
] as const;
