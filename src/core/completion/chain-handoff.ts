/**
 * Server-side chain-break marker (issue #3678).
 *
 * A self-continuation task does one unit of work and then either spawns the
 * next task of its chain or records why the chain stops (a completion signal
 * such as `kookr signal completion-ready --note "chain end: <reason>"`). The
 * agent-side Stop hook `plugin/hooks/chain-handoff-stop.mjs` asks for this, but
 * a task can still be completed without either: by the delivered-completion
 * sweep after its PR merges, or by an operator. That task then looks like a
 * crash. These pure rules let the completion path record that the chain ended
 * there, with no successor and no stop reason.
 *
 * The rules mirror the hook's `isSelfContinuationTask` and `hasHandedOff`, so
 * the hook and the marker agree on which tasks are chain links and what counts
 * as a handoff: any child task, or any recorded signal.
 */

import type { Task } from '../task-read-model.js';
import { isActiveRalphLoop } from './completion-ready-cleanup.js';

/** Digest bullet and audit wording for a chain that ended with no handoff. */
export const CHAIN_ENDED_WITHOUT_HANDOFF_BULLET = 'Chain ended without successor or stop reason';

/**
 * True when the task is one link of a self-continuation chain: the playbook
 * parameter `selfContinuation` decides when present; otherwise the prompt
 * markers the playbook and the continuation envelope render.
 */
export function isSelfContinuationTask(
  task: Pick<Task, 'prompt' | 'userPrompt' | 'playbookParameterValues'>,
): boolean {
  const param = task.playbookParameterValues?.selfContinuation;
  if (typeof param === 'string') return param === 'true' || param === '1';
  const text = `${task.prompt ?? ''}\n${task.userPrompt ?? ''}`;
  return (
    /^\s*-\s*self-continuation:\s*`?true`?\s*$/im.test(text)
    || /\*\*Self-continuation\*\*\s*[—–-]+\s*`true`/.test(text)
    || /^You are continuing a sequential Kookr task chain \(continuation envelope v\d+\)/m.test(text)
  );
}

/** True once the task spawned a child or recorded a signal (the hook's `hasHandedOff`). */
export function hasHandedOff(task: Pick<Task, 'childTaskIds' | 'pendingSignal' | 'finishedSignalAt'>): boolean {
  if (Array.isArray(task.childTaskIds) && task.childTaskIds.length > 0) return true;
  return Boolean(task.pendingSignal || task.finishedSignalAt);
}

/**
 * True when completing this task now ends its self-continuation chain with no
 * successor and no stop reason. Playbook-chain iterations (`task.chain`, which
 * Kookr chains itself) and active Ralph loops are never chain breaks.
 *
 * Callers must pass the task as it was before any completion signal they
 * raise themselves: the delivered-completion sweep raises `completion_ready`
 * before it completes the task, and that signal is not the task's stop reason.
 */
export function endsChainWithoutHandoff(
  task: Pick<
    Task,
    | 'prompt'
    | 'userPrompt'
    | 'playbookParameterValues'
    | 'chain'
    | 'ralphLoop'
    | 'childTaskIds'
    | 'pendingSignal'
    | 'finishedSignalAt'
  >,
): boolean {
  if (task.chain) return false;
  if (isActiveRalphLoop(task)) return false;
  if (!isSelfContinuationTask(task)) return false;
  return !hasHandedOff(task);
}
