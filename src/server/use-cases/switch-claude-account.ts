/**
 * Move a claude-code task to another named Claude account (account switching).
 *
 * The account is pinned on the task (`metadata.claudeAccount`) and read by
 * the Claude adapter at every launch, so for a task that is not running the
 * switch is only that pin: the next launch (promotion, reopen) uses it.
 *
 * A running task is relaunched in place on the new account, continuing its own
 * conversation (`claude --resume <id> --fork-session`; transcripts live in the
 * shared `~/.claude/projects`, so they are readable whichever account resumes
 * them). This is deliberately not cancel + reopen: cancelling releases the
 * task's worktree leases and issue claims, cleans its worktrees, records a
 * schedule outcome and notifies the parent. The switch keeps all of that and
 * only replaces the agent process:
 *
 *   1. synchronously: `inProgress -> open -> pending`, request a resume, and
 *      take a launch reservation so no promoter can start the new session
 *      while the old one is still alive. Pending is exempt from reconcile's
 *      "all sessions done -> terminate" rule, so stopping the old session
 *      below cannot end the task;
 *   2. stop every live session (tail persisted first, as on cancel);
 *   3. release the reservation and run promotion with this task first, so it
 *      takes back the slot it freed (issue #4235). Plain FIFO promotion would
 *      hand that slot to an older pending task on a full host, leaving this
 *      one queued with a resume request that lives only in memory: a restart
 *      would then launch it fresh from its prompt. The release and the pick
 *      happen in one synchronous run, so no other promoter can take the slot
 *      in between. The task still ends up queued if promotion cannot launch
 *      it (dependency admission parks it, or the cap was lowered meanwhile),
 *      and the result says so.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Task, TaskStore } from '../../core/tasks.js';
import { TaskCleanupInProgressError } from '../../core/tasks.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  HOST_CLAUDE_ACCOUNT,
  assertKnownAccount,
  effectiveClaudeAccount,
  type ClaudeAccountRegistry,
} from '../../core/claude-accounts.js';
import type { LifecycleDeps, TryPromotePending } from '../agent-lifecycle.js';
import { cleanupSessionResources } from '../agent-lifecycle.js';
import { describeReopenResume } from '../resume-context.js';

export interface SwitchClaudeAccountDeps {
  taskStore: TaskStore;
  loadClaudeAccounts: () => ClaudeAccountRegistry;
  getLifecycleDeps: () => LifecycleDeps;
  /** Must pass `firstTaskId` on to the promotion pass (see step 3 above). */
  tryPromotePending?: TryPromotePending;
  auditLogPath?: string;
}

export type SwitchClaudeAccountResult =
  /** The task was already on that account; nothing changed. */
  | { outcome: 'unchanged'; task: Task; from: string; to: string }
  /** Not running: the pin changed and applies at the task's next launch. */
  | { outcome: 'pinned'; task: Task; from: string; to: string }
  /** Running: stopped and relaunched on the new account, resuming its conversation. */
  | { outcome: 'relaunched'; task: Task; from: string; to: string }
  /**
   * Running: stopped and queued on the new account, because promotion could
   * not launch it straight away (no slot, or dependency admission parked it);
   * it relaunches when a slot frees.
   */
  | { outcome: 'queued'; task: Task; from: string; to: string }
  | { outcome: 'not_found'; error: string }
  | { outcome: 'invalid'; code: string; error: string };

export interface SwitchClaudeAccountOpts {
  actor?: { source: string; actorId?: string };
}

export async function switchClaudeAccount(
  deps: SwitchClaudeAccountDeps,
  taskId: string,
  account: string,
  opts: SwitchClaudeAccountOpts = {},
): Promise<SwitchClaudeAccountResult> {
  const result = await switchInner(deps, taskId, account);
  await writeAudit(deps, taskId, account, result, opts);
  return result;
}

async function switchInner(
  deps: SwitchClaudeAccountDeps,
  taskId: string,
  account: string,
): Promise<SwitchClaudeAccountResult> {
  const { taskStore } = deps;
  const task = taskStore.getTask(taskId);
  if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
  if (task.agentType !== 'claude-code') {
    return {
      outcome: 'invalid',
      code: 'not_claude_task',
      error: `Task ${taskId} runs ${task.agentType}; only claude-code tasks have a Claude account`,
    };
  }

  let registry: ClaudeAccountRegistry;
  try {
    registry = deps.loadClaudeAccounts();
    assertKnownAccount(registry, account);
  } catch (err) {
    return { outcome: 'invalid', code: 'invalid_claude_account', error: err instanceof Error ? err.message : String(err) };
  }

  // Where the task is now. A pin says it. A task without one that already
  // launched did so while no account was registered (launches pin otherwise,
  // see claude-account-launch.ts), so it ran on the host login. One that never
  // launched will get whatever the default resolves to.
  const pinned = task.metadata?.claudeAccount;
  const from = pinned
    ?? (task.sessions.length > 0 ? HOST_CLAUDE_ACCOUNT : effectiveClaudeAccount(registry, undefined));
  if (from === account) {
    // Nothing to move. Record the pin so later default changes keep it there.
    const current = pinned === undefined ? taskStore.setClaudeAccount(taskId, account) : task;
    return { outcome: 'unchanged', task: current, from, to: account };
  }

  if (task.status !== 'inProgress') {
    return { outcome: 'pinned', task: taskStore.setClaudeAccount(taskId, account), from, to: account };
  }

  if (task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused') {
    return {
      outcome: 'invalid',
      code: 'ralph_loop_active',
      error: `Task ${taskId} is an active Ralph loop; every iteration starts fresh, so there is no conversation to move`,
    };
  }
  // Relaunching without a conversation to resume would start over from the
  // prompt and throw away the agent's progress: refuse instead. Same check
  // as Reopen's report (an id is recorded and its transcript still exists).
  // The operator can still stop and reopen the task deliberately.
  const resume = await describeReopenResume(task, { activeRalphLoop: false });
  if (resume.mode !== 'resume') {
    return {
      outcome: 'invalid',
      code: 'not_resumable',
      error: `Task ${taskId} cannot continue its conversation on another account (${resume.reason}); try again once it has started, or stop and reopen it`,
    };
  }
  // That await may have yielded: the task can have finished or been switched
  // meanwhile. From here to pendTask nothing awaits.
  const current = taskStore.getTask(taskId);
  if (!current || current.status !== 'inProgress') {
    return {
      outcome: 'invalid',
      code: 'task_changed',
      error: `Task ${taskId} changed state during the switch (now ${current?.status ?? 'deleted'}); check it and retry`,
    };
  }

  // Step 1 — synchronous, so the transitions and the fence are atomic.
  taskStore.setClaudeAccount(taskId, account);
  try {
    taskStore.reopenTask(taskId); // inProgress -> open
  } catch (err) {
    taskStore.setClaudeAccount(taskId, current.metadata?.claudeAccount);
    if (err instanceof TaskCleanupInProgressError) {
      return { outcome: 'invalid', code: 'task_cleanup_in_progress', error: err.message };
    }
    throw err;
  }
  const reservation = taskStore.beginLaunchWithToken(taskId);
  taskStore.requestResumeOnNextLaunch(taskId);
  taskStore.pendTask(taskId); // open -> pending

  // Step 2 — stop the old agent process(es).
  const lifecycleDeps = deps.getLifecycleDeps();
  try {
    for (const session of current.sessions) {
      if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
      await cleanupSessionResources(session.tmuxSession, lifecycleDeps);
      taskStore.updateSession(taskId, session.tmuxSession, { lastStatus: 'aborted' });
    }
  } finally {
    // Step 3 — hand the slot back: release the reservation and let promotion
    // launch this task before any other pending one. Nothing awaits between
    // the release and the promotion's own pick-and-reserve.
    if (reservation) taskStore.endLaunch(taskId, reservation);
  }
  console.log(`[claude-accounts] task ${taskId} switched from Claude account "${from}" to "${account}"`);
  await deps.tryPromotePending?.({ firstTaskId: taskId });

  const after = taskStore.getTask(taskId) ?? task;
  if (after.status === 'cancelled' && after.terminalReceipt?.reason === 'launch_failure') {
    return {
      outcome: 'invalid',
      code: 'relaunch_failed',
      error: `Task ${taskId} was stopped for the switch but its relaunch on "${account}" failed: ${after.terminalReceipt.detail ?? 'unknown launch error'}`,
    };
  }
  if (after.status === 'pending') return { outcome: 'queued', task: after, from, to: account };
  if (after.status === 'inProgress') return { outcome: 'relaunched', task: after, from, to: account };
  return {
    outcome: 'invalid',
    code: 'task_changed',
    error: `Task ${taskId} was stopped for the switch but is now ${after.status}, not relaunched`,
  };
}

async function writeAudit(
  deps: SwitchClaudeAccountDeps,
  taskId: string,
  account: string,
  result: SwitchClaudeAccountResult,
  opts: SwitchClaudeAccountOpts,
): Promise<void> {
  if (!deps.auditLogPath) return;
  const row = {
    type: 'task.claudeAccountSwitch',
    timestamp: nowISO(),
    actor: opts.actor ?? { source: 'unknown' },
    taskId,
    account,
    outcome: result.outcome,
    ...('from' in result ? { from: result.from } : {}),
    ...('task' in result ? { status: result.task.status } : {}),
    ...('code' in result ? { code: result.code } : {}),
    ...('error' in result ? { error: result.error } : {}),
  };
  try {
    await mkdir(dirname(deps.auditLogPath), { recursive: true });
    await appendFile(deps.auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch (err) {
    console.warn('[task-audit] failed to append task.claudeAccountSwitch audit row:', err);
  }
}

