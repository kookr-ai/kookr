/**
 * Launch-time half of Claude account switching: which account a claude-code
 * launch runs on, and the environment that selects it.
 *
 * Called from inside `ClaudeCodeAdapter.launch`, which every launch path goes
 * through (fresh launch, queued promotion, crash-recovery resume, reopen,
 * account switch), so no path can start a Claude session on the wrong account.
 */

import type { TaskStore } from '../core/tasks.js';
import {
  HOST_CLAUDE_ACCOUNT,
  claudeAccountLaunchEnv,
  effectiveClaudeAccount,
  loadClaudeAccounts,
  type ClaudeAccountRegistry,
} from '../core/claude-accounts.js';

export interface ClaudeAccountLaunch {
  account: string;
  env: Record<string, string>;
}

/**
 * Resolve the account for `taskId` and pin it on the task.
 *
 * The first launch of an unpinned task pins the registry default, so changing
 * the default later moves only new tasks — a running task, and its later
 * relaunches, stay on the subscription they started on. Nothing is pinned on
 * a host with no registered accounts, so tasks there look as they always did.
 *
 * Throws (and so fails the launch) when the registry is unreadable or the
 * pinned account was removed: silently falling back to the host login would
 * spend a subscription the operator did not choose.
 */
export function resolveClaudeAccountLaunch(
  taskStore: Pick<TaskStore, 'getTask' | 'setClaudeAccount'>,
  taskId: string,
  load: () => ClaudeAccountRegistry,
): ClaudeAccountLaunch {
  const task = taskStore.getTask(taskId);
  const pinned = task?.metadata?.claudeAccount;
  // A host-pinned task never needs a token, so it does not depend on the
  // registry being readable.
  if (pinned === HOST_CLAUDE_ACCOUNT) return { account: HOST_CLAUDE_ACCOUNT, env: {} };
  const registry = load();
  const account = effectiveClaudeAccount(registry, pinned);
  const env = claudeAccountLaunchEnv(registry, account);
  if (task && pinned === undefined && Object.keys(registry.accounts).length > 0) {
    taskStore.setClaudeAccount(taskId, account);
  }
  return { account, env };
}

/** Production loader bound to a registry path. */
export function claudeAccountLoader(path: string): () => ClaudeAccountRegistry {
  return () => loadClaudeAccounts(path);
}
