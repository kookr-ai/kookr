/**
 * Recognise a shell command that merges a pull request.
 *
 * Shared by the merge-required gate (`merge-required.ts`) and the
 * merge-to-finished metric in the lesson-yield scan (`lesson-decision.ts`,
 * issue #3695). It lives in its own module because `merge-required.ts`
 * already imports `lesson-decision.ts`; importing back would form a cycle.
 */
export function isPrMergeCommand(command: string): boolean {
  // Merge wrappers used by autonomous delivery on kookr-ai/kookr and forks.
  return /\bgh\s+pr\s+merge\b/i.test(command)
    || /\bpnpm\s+merge\b/i.test(command)
    || /\bkookr-merge\.sh\b/i.test(command);
}
