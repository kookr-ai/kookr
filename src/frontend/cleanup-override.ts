import type { WorktreeCleanupVerdict } from '../shared/contracts/worktree-cleanup-verdict.js';

/**
 * Decide what `completeTask` should say about worktree cleanup.
 *
 * Three-valued on purpose: `true`/`false` are explicit instructions, and
 * `undefined` omits the field so the server's own `cleanupWorktreeOnComplete`
 * setting decides. The rule is that the wire must never contradict what the
 * dialog told the user — and must never invent a claim the dialog couldn't make.
 */
export function resolveCleanupOverride(input: {
  /** null while the probe is in flight. */
  verdicts: WorktreeCleanupVerdict[] | null;
  inspectFailed: boolean;
  ralphActive: boolean;
  touched: boolean;
  savedDefault: boolean | undefined;
  checkboxValue: boolean;
}): boolean | undefined {
  // Known client-side without any probe, so it decides immediately rather than
  // waiting on one. (The server also refuses to complete an active loop's task
  // outright, so this is belt-and-braces rather than the only guard.)
  if (input.ralphActive) return false;
  // Still probing: the dialog has made no claim, so neither do we.
  if (input.verdicts === null) return undefined;
  // The inspection failed, so removability is unknown. Honour an explicit
  // choice; otherwise defer to the server's setting exactly as it did before
  // this dialog showed a verdict at all. Sending `false` here would let a
  // transient git failure silently switch off a user's saved cleanup.
  if (input.inspectFailed) return input.touched ? input.checkboxValue : undefined;
  // The dialog said every worktree is kept. Say so, rather than letting the
  // server's default contradict what the user just read.
  if (!input.verdicts.some((v) => v.removable)) return false;
  // Removable: honour the checkbox, but only once we know what its default
  // should have been — otherwise defer to the server as before.
  return input.touched || input.savedDefault !== undefined ? input.checkboxValue : undefined;
}
