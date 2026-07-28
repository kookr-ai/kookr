import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { inspectTaskWorktrees } from '../adapters/git-worktree.js';
import {
  formatDirtySummary,
  totalDirtyCount,
} from '../shared/contracts/worktree-cleanup-verdict.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';

/**
 * Surface a finding when a task completes **headlessly** (agent-signalled
 * auto-close, no human at the completion dialog) while one of its worktrees
 * still holds uncommitted work.
 *
 * Motivation (issue #1580 / umbrella #1548): the interactive completion dialog
 * already shows the worktree-removal verdict — a human clicking Complete sees
 * the dirty summary before deciding. The headless auto-close sweep bypasses
 * that dialog, so a task can reach `completed` with a heavily-dirty worktree
 * and nobody notices (the #1548 retro observed 213 dirty files completed
 * silently). Cleanup already *preserves* a dirty worktree (blocker
 * `uncommitted-changes`), so the work is not destroyed — but the preservation
 * is silent. This closes the visibility gap without a second dirty-detection
 * path: it reuses the exact `inspectTaskWorktrees` verdict the dialog reads.
 *
 * Chosen behavior — **surface, do not block.** Blocking a headless close would
 * wedge the slot the auto-close sweep exists to free, and the operator who
 * enabled auto-close asked for exactly that teardown. So this emits a finding a
 * human sees without opening the dialog: an `audit.jsonl` row plus a broadcast
 * `alert` (severity `warning`) on the existing alert channel — the same
 * audit+alert surface the TTL-escalation close already uses.
 *
 * Runs BEFORE the completion transition so the inspection observes the worktree
 * while the task still owns it, and never throws — surfacing a finding must not
 * fail the completion it is reporting on.
 *
 * @returns `true` when a dirty worktree was found and a finding surfaced.
 */
export async function surfaceDirtyWorktreeOnHeadlessCompletion(
  task: Task,
  deps: {
    taskStore: TaskStore;
    /** Path to the shared audit.jsonl log; skipped when absent (tests). */
    auditLogPath?: string;
    /** Broadcast for the alert — reuses the existing 'alert' channel. */
    broadcastToAll?: (msg: ServerMessage) => void;
  },
): Promise<boolean> {
  let dirty: Array<{ name: string; summary: string; count: number }>;
  try {
    const verdicts = await inspectTaskWorktrees(deps.taskStore, task.id);
    dirty = verdicts
      .filter((v) => totalDirtyCount(v.evidence.dirty) > 0)
      .map((v) => ({
        name: v.worktreeName,
        summary: formatDirtySummary(v.evidence.dirty),
        count: totalDirtyCount(v.evidence.dirty),
      }));
  } catch (err) {
    console.warn(
      `[dirty-worktree-guard] inspection failed for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  if (dirty.length === 0) return false;

  const totalDirty = dirty.reduce((sum, d) => sum + d.count, 0);
  const perWorktree = dirty.map((d) => `${d.name}: ${d.summary}`).join('; ');

  try {
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.completedWithDirtyWorktree',
      timestamp: nowISO(),
      actor: 'system:dirty-worktree-guard',
      taskId: task.id,
      totalDirtyCount: totalDirty,
      worktrees: dirty,
    });
  } catch (err) {
    console.warn(
      `[dirty-worktree-guard] audit append failed for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
      summary: `Completed with dirty worktree: ${task.name ?? 'Task'}`,
      details:
        `Headless completion left ${totalDirty} uncommitted change(s) in the worktree ` +
        `(${perWorktree}). The worktree was kept, not discarded — review or commit the ` +
        `changes before it is cleaned up.`,
      severity: 'warning',
    });
  } catch (err) {
    console.warn(
      `[dirty-worktree-guard] broadcast failed for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return true;
}
