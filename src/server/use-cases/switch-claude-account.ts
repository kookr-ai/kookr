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
 *   3. release the reservation and run promotion. With a free slot the task
 *      relaunches at once; with a full fleet it waits in the queue like any
 *      pending task, and the result says so.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Task, TaskStore } from '../../core/tasks.js';
import { TaskCleanupInProgressError } from '../../core/tasks.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  assertKnownAccount,
  effectiveClaudeAccount,
  type ClaudeAccountRegistry,
} from '../../core/claude-accounts.js';
import type { LifecycleDeps } from '../agent-lifecycle.js';
import { cleanupSessionResources } from '../agent-lifecycle.js';
import { hasResumableSession } from '../resume-context.js';

export interface SwitchClaudeAccountDeps {
  taskStore: TaskStore;
  loadClaudeAccounts: () => ClaudeAccountRegistry;
  getLifecycleDeps: () => LifecycleDeps;
  tryPromotePending?: () => Promise<void>;
  auditLogPath?: string;
}

export type SwitchClaudeAccountResult =
  /** The task was already on that account; nothing changed. */
  | { outcome: 'unchanged'; task: Task; from: string; to: string }
  /** Not running: the pin changed and applies at the task's next launch. */
  | { outcome: 'pinned'; task: Task; from: string; to: string }
  /** Running: stopped and relaunched on the new account, resuming its conversation. */
  | { outcome: 'relaunched'; task: Task; from: string; to: string }
  /** Running: stopped and queued on the new account; it relaunches when a slot frees. */
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

  // A task that never launched under the registry has no pin; it is on
  // whatever the default resolves to now.
  const from = effectiveClaudeAccount(registry, task.metadata?.claudeAccount);
  if (from === account && task.metadata?.claudeAccount !== undefined) {
    return { outcome: 'unchanged', task, from, to: account };
  }

  if (task.status !== 'inProgress') {
    const pinned = taskStore.setClaudeAccount(taskId, account);
    return { outcome: from === account ? 'unchanged' : 'pinned', task: pinned, from, to: account };
  }

  if (task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused') {
    return {
      outcome: 'invalid',
      code: 'ralph_loop_active',
      error: `Task ${taskId} is an active Ralph loop; every iteration starts fresh, so there is no conversation to move`,
    };
  }
  if (!hasResumableSession(task)) {
    // Relaunching without a conversation id would start over from the prompt
    // and throw away the agent's progress. The operator can still stop and
    // reopen the task deliberately.
    return {
      outcome: 'invalid',
      code: 'not_resumable',
      error: `Task ${taskId} has no recorded Claude conversation yet, so it cannot continue on another account; try again once it has started`,
    };
  }

  // Step 1 — synchronous, so the transitions and the fence are atomic.
  taskStore.setClaudeAccount(taskId, account);
  try {
    taskStore.reopenTask(taskId); // inProgress -> open
  } catch (err) {
    taskStore.setClaudeAccount(taskId, task.metadata?.claudeAccount);
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
    for (const session of task.sessions) {
      if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
      await cleanupSessionResources(session.tmuxSession, lifecycleDeps);
      taskStore.updateSession(taskId, session.tmuxSession, { lastStatus: 'aborted' });
    }
  } finally {
    // Step 3 — let promotion launch the new session.
    if (reservation) taskStore.endLaunch(taskId, reservation);
  }
  console.log(`[claude-accounts] task ${taskId} switched from Claude account "${from}" to "${account}"`);
  await deps.tryPromotePending?.();

  const after = taskStore.getTask(taskId) ?? task;
  if (after.status === 'cancelled' && after.terminalReceipt?.reason === 'launch_failure') {
    return {
      outcome: 'invalid',
      code: 'relaunch_failed',
      error: `Task ${taskId} was stopped for the switch but its relaunch on "${account}" failed: ${after.terminalReceipt.detail ?? 'unknown launch error'}`,
    };
  }
  return { outcome: after.status === 'pending' ? 'queued' : 'relaunched', task: after, from, to: account };
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

