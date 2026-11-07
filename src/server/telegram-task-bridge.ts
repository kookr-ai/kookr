/**
 * Telegram → running-agent reply bridge.
 *
 * Lets the operator answer a task from Telegram without opening the dashboard:
 *  - `sendText(taskId, text)` delivers a free-text instruction to the task's
 *    live agent session (same path as the dashboard's `directReply`).
 *  - `approvePermission(taskId)` approves the task's *current* permission prompt
 *    via the validated, anti-stale keystroke path (`RemotePermissionBroker`).
 *
 * The Telegram integration depends only on these three plain functions (wired in
 * `start-remote-chat-trigger.ts`), so it never imports server/core internals —
 * the boundary stays one-directional (server → integration).
 */

import type { Task, TaskStore } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentInteractionPort } from '../core/ports/agent-interaction-port.js';
import type { Watchdog } from '../core/watchdog.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { RemotePermissionBroker } from '../remote/permission-broker.js';
import {
  buildPermissionRequestBinding,
  latestPermissionRequestEvent,
} from './permission-request-binding.js';

export interface TelegramReplyResult {
  ok: boolean;
  reason?: string;
}

export interface TelegramTaskBridge {
  /** Deliver a free-text instruction to the task's live agent session. */
  sendText(taskId: string, text: string): Promise<TelegramReplyResult>;
  /** Approve the task's current permission prompt (keystroke '1'), anti-stale. */
  approvePermission(taskId: string): Promise<TelegramReplyResult>;
  /** True when the task's live session is currently permission-blocked. */
  isPermissionBlocked(taskId: string): boolean;
}

export interface TelegramTaskBridgeDeps {
  taskStore: Pick<TaskStore, 'getTask'>;
  monitor: Pick<Monitor, 'isPermissionBlocked' | 'markInputReceived' | 'getAgentEvents'>;
  queue: Pick<AttentionQueue, 'getAnomaly' | 'respondAndAdvance'>;
  adapter: Pick<AgentInteractionPort, 'sendKeystroke'>;
  /** Delivers free text to a live session (dashboard uses the same service). */
  submitMessage: (sessionId: string, text: string, source: 'directReply') => Promise<unknown>;
  watchdog?: Pick<Watchdog, 'recordInputReceived'>;
  interactionLog?: DeferredInteractionLogWriter;
  now?: () => Date;
}

/** The task's most recent still-live session (mirrors the dashboard selector). */
function latestLiveSession(task: Task): Task['sessions'][number] | undefined {
  return [...task.sessions].reverse().find(
    (session) => session.lastStatus !== 'completed'
      && session.lastStatus !== 'aborted'
      && !session.crashRecovered,
  );
}

export function createTelegramTaskBridge(deps: TelegramTaskBridgeDeps): TelegramTaskBridge {
  const broker = new RemotePermissionBroker({
    adapter: deps.adapter,
    monitor: deps.monitor,
    queue: deps.queue,
    ...(deps.watchdog ? { watchdog: deps.watchdog } : {}),
    ...(deps.interactionLog ? { interactionLog: deps.interactionLog } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  function resolveSession(taskId: string): string | null {
    const task = deps.taskStore.getTask(taskId);
    if (!task) return null;
    return latestLiveSession(task)?.tmuxSession ?? null;
  }

  return {
    async sendText(taskId, text): Promise<TelegramReplyResult> {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: 'empty message' };
      const sessionId = resolveSession(taskId);
      if (!sessionId) return { ok: false, reason: 'no live session for this task' };
      try {
        await deps.submitMessage(sessionId, trimmed, 'directReply');
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async approvePermission(taskId): Promise<TelegramReplyResult> {
      const sessionId = resolveSession(taskId);
      if (!sessionId) return { ok: false, reason: 'no live session for this task' };
      if (!deps.monitor.isPermissionBlocked(sessionId)) {
        return { ok: false, reason: 'task is no longer waiting for approval' };
      }
      const anomaly = deps.queue.getAnomaly(sessionId);
      const event = latestPermissionRequestEvent(deps.monitor.getAgentEvents(sessionId));
      if (!anomaly || anomaly.type !== 'permission_blocked' || !event) {
        return { ok: false, reason: 'no active permission prompt' };
      }
      // Re-derive the binding from the live prompt so the broker's TTL + prompt
      // checks guard against approving a prompt that already advanced.
      const permissionRequest = buildPermissionRequestBinding({
        sessionId,
        event,
        detectedAt: anomaly.detectedAt,
      });
      try {
        await broker.approve(sessionId, '1', 'telegram', { permissionRequest });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    isPermissionBlocked(taskId): boolean {
      const sessionId = resolveSession(taskId);
      return sessionId ? deps.monitor.isPermissionBlocked(sessionId) : false;
    },
  };
}
