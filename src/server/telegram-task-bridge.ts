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
import type { TelegramReplyResult } from '../shared/contracts/telegram.js';
import {
  buildPermissionRequestBinding,
  latestPermissionRequestEvent,
  validatePermissionApprovalBinding,
} from './permission-request-binding.js';

/** Length of the short prompt identity embedded in the Approve button. */
const PROMPT_ID_LEN = 12;

export interface TelegramTaskBridge {
  /** Deliver a free-text instruction to the task's live agent session. */
  sendText(taskId: string, text: string): Promise<TelegramReplyResult>;
  /**
   * Approve the task's current permission prompt (keystroke '1'), anti-stale.
   * When `expectedPromptId` is given (from the button that was shown), refuses
   * if the live prompt is no longer that one — so a stale Approve button cannot
   * approve a *different* prompt that appeared since.
   */
  approvePermission(taskId: string, expectedPromptId?: string): Promise<TelegramReplyResult>;
  /**
   * A short identity for the task's current permission prompt (or null when not
   * blocked). Embedded in the Approve button so a tap approves only that prompt.
   */
  permissionPromptId(taskId: string): string | null;
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
  // Once-only guard so a double-tapped Approve cannot keystroke twice for the
  // same prompt (mirrors RemotePermissionBroker, kept server-local because the
  // src/remote broker must not be statically imported into the server bundle).
  const consumedApprovals = new Set<string>();
  const now = (): Date => (deps.now ? deps.now() : new Date());

  function resolveSession(taskId: string): string | null {
    const task = deps.taskStore.getTask(taskId);
    if (!task) return null;
    return latestLiveSession(task)?.tmuxSession ?? null;
  }

  /** requestId of the live permission prompt for `sessionId`, or null. */
  function livePromptRequestId(sessionId: string): string | null {
    if (!deps.monitor.isPermissionBlocked(sessionId)) return null;
    const anomaly = deps.queue.getAnomaly(sessionId);
    const event = latestPermissionRequestEvent(deps.monitor.getAgentEvents(sessionId));
    if (!anomaly || anomaly.type !== 'permission_blocked' || !event) return null;
    return buildPermissionRequestBinding({ sessionId, event, detectedAt: anomaly.detectedAt }).requestId;
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

    async approvePermission(taskId, expectedPromptId): Promise<TelegramReplyResult> {
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
      // Identity guard: if the operator tapped a button shown for a *different*
      // prompt than the one live now, refuse — don't approve the wrong thing.
      if (expectedPromptId && permissionRequest.requestId.slice(0, PROMPT_ID_LEN) !== expectedPromptId) {
        return { ok: false, reason: 'the prompt changed since this message — open the dashboard to review' };
      }
      // Anti-stale validation (TTL + prompt identity re-derivation), same server
      // helper the dashboard's permissionChoice path uses.
      const validation = validatePermissionApprovalBinding({
        sessionId,
        events: deps.monitor.getAgentEvents(sessionId),
        anomaly,
        payload: { permissionRequest },
        now: now(),
      });
      if (!validation.ok) return { ok: false, reason: validation.reason };
      const consumeKey = `${sessionId}\u0000${validation.binding.requestId}`;
      if (consumedApprovals.has(consumeKey)) {
        return { ok: false, reason: 'this prompt was already approved' };
      }
      consumedApprovals.add(consumeKey);
      try {
        await deps.adapter.sendKeystroke(sessionId, '1');
      } catch (err) {
        consumedApprovals.delete(consumeKey);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (deps.monitor.markInputReceived(sessionId)) {
        deps.watchdog?.recordInputReceived(sessionId);
      }
      deps.queue.respondAndAdvance(sessionId);
      await deps.interactionLog?.append({
        type: 'user_input',
        agentId: sessionId,
        content: '[telegram approve: 1]',
        timestamp: new Date().toISOString(),
      });
      return { ok: true };
    },

    permissionPromptId(taskId): string | null {
      const sessionId = resolveSession(taskId);
      if (!sessionId) return null;
      const requestId = livePromptRequestId(sessionId);
      return requestId ? requestId.slice(0, PROMPT_ID_LEN) : null;
    },
  };
}
