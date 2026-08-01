import type { AttentionQueue } from '../core/attention-queue.js';
import { isActiveStatus, type TaskStore } from '../core/tasks.js';

/**
 * Snooze-expiry restore job (extracted from `lifecycle-timers.ts`, issue
 * #1822). Called on the snooze-expiry tick: pull every attention-queue entry
 * whose snooze just elapsed and decide where it belongs now —
 *
 * - agent-scoped anomaly (`key === agentId`): re-enqueue as-is;
 * - task-scoped anomaly whose task is still active with a live session:
 *   re-enqueue against that live session;
 * - task-scoped anomaly whose task is terminal or has no live session:
 *   dropped (or re-imported as a still-snoozed placeholder when the task is
 *   active but between sessions).
 *
 * Returns true when the queue changed, so the caller can broadcast a snapshot.
 */
export function restoreExpiredSnoozes(queue: AttentionQueue, taskStore: TaskStore): boolean {
  const expired = queue.expireDue();
  if (expired.length === 0) return false;
  let changed = false;

  for (const entry of expired) {
    if (!entry.anomaly) {
      changed = true;
      continue;
    }

    if (entry.key === entry.agentId) {
      queue.enqueue(entry.agentId, entry.anomaly);
      changed = true;
      continue;
    }

    const task = taskStore.getTask(entry.key);
    if (!task || !isActiveStatus(task.status)) {
      changed = true;
      continue;
    }

    const liveSession = [...task.sessions].reverse().find(
      (session) => session.lastStatus !== 'completed'
        && session.lastStatus !== 'aborted'
        && !session.crashRecovered,
    );
    if (liveSession) {
      queue.enqueue(liveSession.tmuxSession, { ...entry.anomaly, agentId: liveSession.tmuxSession });
      changed = true;
    } else {
      queue.importSnoozed([{ ...entry, expiredPendingRestore: true }]);
    }
  }

  return changed;
}
