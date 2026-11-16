/**
 * Telegram → running-agent reply bridge.
 *
 * Lets the operator answer a task from Telegram without opening the dashboard:
 *  - `sendText(taskId, text)` delivers a free-text instruction to the task's
 *    live agent session (same path as the dashboard's `directReply`).
 *  - `approvePermission(taskId)` approves the task's *current* permission prompt
 *    via the validated, anti-stale keystroke path (`RemotePermissionBroker`).
 *  - `denyPermission(taskId, promptId)` presses the prompt's "No" option, read
 *    from the pane (issue #3925).
 *  - `describePermissionPrompt(taskId)` is what the Telegram card shows for a
 *    prompt that waited past the page threshold (issue #3925).
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
import type {
  PermissionPromptCardInfo,
  PermissionPromptClosedReason,
  TelegramReplyResult,
} from '../shared/contracts/telegram.js';
import { findPermissionOptionKey } from '../core/permission-actions.js';
import { redactSecrets } from '../core/redact-secrets.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { AgentEvent } from '../shared/contracts/agent-events.js';
import {
  buildPermissionRequestBinding,
  latestPermissionRequestEvent,
  validatePermissionApprovalBinding,
  type PermissionRequestBinding,
} from './permission-request-binding.js';

type PermissionRequestEvent = Extract<AgentEvent, { type: 'permission_request' }>;

/**
 * The text of a tool input the operator decides on: the command, file path,
 * path or URL, whole and unchanged (redaction is the caller's job).
 */
export function toolInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url']) {
      const value = obj[key];
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

function basenameOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

/** Length of the short prompt identity embedded in the Approve button. */
const PROMPT_ID_LEN = 12;

/** Who answered a prompt from Telegram, for the interaction log. */
export interface TelegramDecisionActor {
  telegramUserId: number;
}

type PermissionDecision = 'approve' | 'deny';

export interface TelegramTaskBridge {
  /**
   * Deliver a free-text instruction to the task's live agent session. With `expectedSessionId`,
   * refuse unless the live session is that one or resumed its conversation (see
   * {@link liveSessionContinues}): a fresh relaunch never saw what the expected session saw.
   */
  sendText(taskId: string, text: string, expectedSessionId?: string): Promise<TelegramReplyResult>;
  /**
   * Approve the task's current permission prompt (keystroke '1'), anti-stale.
   * When `expectedPromptId` is given (from the button that was shown), refuses
   * if the live prompt is no longer that one — so a stale Approve button cannot
   * approve a *different* prompt that appeared since.
   */
  approvePermission(
    taskId: string,
    expectedPromptId?: string,
    actor?: TelegramDecisionActor,
  ): Promise<TelegramReplyResult>;
  /**
   * Deny the task's current permission prompt: press the option the pane's
   * option reader classes as "deny". Needs the prompt id from the button and
   * refuses when no deny option is on screen (issue #3925).
   */
  denyPermission(
    taskId: string,
    expectedPromptId: string,
    actor?: TelegramDecisionActor,
  ): Promise<TelegramReplyResult>;
  /**
   * A short identity for the task's current permission prompt (or null when not
   * blocked). Embedded in the Approve button so a tap approves only that prompt.
   */
  permissionPromptId(taskId: string): string | null;
  /**
   * What the Telegram card shows for the task's open prompt, read from the same
   * event the buttons are bound to. Null when there is no prompt the buttons
   * could be bound to (issue #3925).
   */
  describePermissionPrompt(taskId: string): Promise<PermissionPromptCardInfo | null>;
  /** Why a prompt that was on a card is gone: the task ended, or it was answered. */
  permissionPromptClosedReason(taskId: string): PermissionPromptClosedReason;
}

export interface TelegramTaskBridgeDeps {
  taskStore: Pick<TaskStore, 'getTask'>;
  monitor: Pick<Monitor, 'isPermissionBlocked' | 'markInputReceived' | 'getAgentEvents'>;
  queue: Pick<AttentionQueue, 'getAnomaly' | 'respondAndAdvance'>;
  adapter: Pick<AgentInteractionPort, 'sendKeystroke'>;
  /**
   * Reads the task's terminal so Deny can find the prompt's "No" option, and
   * Approve can check that it presses the one-time "Yes" (never "always
   * allow"). Without it Deny is unavailable and Approve presses `1`.
   */
  capturePane?: (sessionId: string) => Promise<string>;
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

/**
 * Whether the task's live session is `sessionId` or continues its conversation. Crash recovery and
 * an operator Reopen launch a new session that resumes the provider conversation (Claude Code
 * `--resume --fork-session`, opencode `--session`). The adapter records the conversation it resumed
 * (`resumedConversationId`), so the chain is followed back through any number of resumes. A fresh
 * relaunch has no such link and does not continue `sessionId`.
 *
 * Each step looks only at sessions launched before the current one, newest first: opencode keeps
 * one conversation id across resumes, so several sessions can carry the same `claudeSessionId`.
 */
export function liveSessionContinues(task: Task, sessionId: string): boolean {
  const live = latestLiveSession(task);
  let index = live ? task.sessions.indexOf(live) : -1;
  while (index >= 0) {
    const current = task.sessions[index] as Task['sessions'][number];
    if (current.tmuxSession === sessionId) return true;
    const resumed = current.resumedConversationId;
    if (!resumed) return false;
    let previous = index - 1;
    while (previous >= 0 && task.sessions[previous]?.claudeSessionId !== resumed) previous--;
    index = previous;
  }
  return false;
}

/** The task-side functions `AskService` needs (see `AskServiceDeps`), built from the task store and the reply bridge. */
export interface AskTaskPorts {
  deliverToTask: (taskId: string, text: string, sessionId?: string) => Promise<TelegramReplyResult>;
  liveSession: (taskId: string) => string | undefined;
  sessionContinues: (taskId: string, sessionId: string) => boolean;
}

/**
 * Wire `kookr ask` to the tasks. The bridge is resolved lazily because the ask service is built
 * before the Telegram integration and its reply bridge exist.
 */
export function createAskTaskPorts(deps: {
  taskStore: Pick<TaskStore, 'getTask'>;
  bridge: () => Pick<TelegramTaskBridge, 'sendText'> | undefined;
}): AskTaskPorts {
  return {
    deliverToTask: async (taskId, text, sessionId) => {
      const bridge = deps.bridge();
      if (!bridge) return { ok: false, reason: 'reply bridge not ready' };
      return sessionId === undefined ? bridge.sendText(taskId, text) : bridge.sendText(taskId, text, sessionId);
    },
    liveSession: (taskId) => {
      const task = deps.taskStore.getTask(taskId);
      return task ? latestLiveSession(task)?.tmuxSession : undefined;
    },
    sessionContinues: (taskId, sessionId) => {
      const task = deps.taskStore.getTask(taskId);
      return task ? liveSessionContinues(task, sessionId) : false;
    },
  };
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


  /** The open prompt's event and binding, or null when the session is not blocked on one. */
  function liveBinding(sessionId: string): { event: PermissionRequestEvent; anomaly: Anomaly; requestId: string; binding: PermissionRequestBinding } | null {
    if (!deps.monitor.isPermissionBlocked(sessionId)) return null;
    const anomaly = deps.queue.getAnomaly(sessionId);
    const event = latestPermissionRequestEvent(deps.monitor.getAgentEvents(sessionId));
    if (!anomaly || anomaly.type !== 'permission_blocked' || !event) return null;
    const binding = buildPermissionRequestBinding({ sessionId, event, detectedAt: anomaly.detectedAt });
    return { event, anomaly, requestId: binding.requestId, binding };
  }

  async function readPane(sessionId: string): Promise<string | undefined> {
    if (!deps.capturePane) return undefined;
    try {
      return await deps.capturePane(sessionId);
    } catch {
      return undefined;
    }
  }

  async function decide(
    decision: PermissionDecision,
    taskId: string,
    expectedPromptId: string | undefined,
    actor: TelegramDecisionActor | undefined,
  ): Promise<TelegramReplyResult> {
    const sessionId = resolveSession(taskId);
    if (!sessionId) return { ok: false, reason: 'no live session for this task' };
    if (!deps.monitor.isPermissionBlocked(sessionId)) {
      return { ok: false, reason: 'task is no longer waiting for approval' };
    }
    const live = liveBinding(sessionId);
    if (!live) return { ok: false, reason: 'no active permission prompt' };
    if (decision === 'deny' && !expectedPromptId) {
      return { ok: false, reason: 'a Deny button must name the prompt it was shown for' };
    }
    // Identity guard: if the operator tapped a button shown for a *different*
    // prompt than the one live now, refuse — don't answer the wrong thing.
    if (expectedPromptId && live.requestId.slice(0, PROMPT_ID_LEN) !== expectedPromptId) {
      return { ok: false, reason: 'the prompt changed since this message — open the dashboard to review' };
    }
    if (!expectedPromptId) {
      // A button that names no prompt (older notices) keeps the time limit:
      // it answers whatever prompt is live, so it must be a recent one.
      const validation = validatePermissionApprovalBinding({
        sessionId,
        events: deps.monitor.getAgentEvents(sessionId),
        anomaly: live.anomaly,
        payload: { permissionRequest: live.binding },
        now: now(),
      });
      if (!validation.ok) return { ok: false, reason: validation.reason };
    }
    // A button bound to a prompt id is answered whenever it is tapped: the
    // identity check above is what keeps it from answering another prompt, and
    // the card is only sent once the prompt has waited 3 minutes, which is
    // already close to the 5-minute dashboard binding limit (issue #3925).
    const consumeKey = `${sessionId}\u0000${live.requestId}`;
    if (consumedApprovals.has(consumeKey)) {
      return { ok: false, reason: 'this prompt was already answered' };
    }
    // Claim the prompt before the pane read so a second tap racing this one
    // cannot send a second key.
    consumedApprovals.add(consumeKey);

    const pane = await readPane(sessionId);
    if (liveBinding(sessionId)?.requestId !== live.requestId) {
      consumedApprovals.delete(consumeKey);
      return { ok: false, reason: 'the prompt changed since this message — open the dashboard to review' };
    }
    const found = findPermissionOptionKey(pane, decision === 'approve' ? 'allow-once' : 'deny');
    let key: string;
    if (decision === 'deny') {
      if (typeof found !== 'string') {
        consumedApprovals.delete(consumeKey);
        return { ok: false, reason: 'no Deny option on screen — answer it in the dashboard' };
      }
      key = found;
    } else if (found === null) {
      // A menu is on screen but none of its options is a plain one-time "Yes".
      consumedApprovals.delete(consumeKey);
      return { ok: false, reason: 'no one-time Yes option on screen — answer it in the dashboard' };
    } else {
      key = found ?? '1';
    }

    try {
      await deps.adapter.sendKeystroke(sessionId, key);
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
      content: decision === 'approve' ? `[telegram approve once: ${key}]` : `[telegram deny: ${key}]`,
      timestamp: now().toISOString(),
      ...(actor ? { actor: `telegram:${actor.telegramUserId}` } : {}),
    });
    return { ok: true };
  }

  return {
    async sendText(taskId, text, expectedSessionId): Promise<TelegramReplyResult> {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: 'empty message' };
      const sessionId = resolveSession(taskId);
      if (!sessionId) return { ok: false, reason: 'no live session for this task' };
      const task = deps.taskStore.getTask(taskId);
      if (expectedSessionId !== undefined && !(task && liveSessionContinues(task, expectedSessionId))) {
        return { ok: false, reason: 'the session that asked is no longer live' };
      }
      try {
        await deps.submitMessage(sessionId, trimmed, 'directReply');
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    approvePermission(taskId, expectedPromptId, actor): Promise<TelegramReplyResult> {
      return decide('approve', taskId, expectedPromptId, actor);
    },

    denyPermission(taskId, expectedPromptId, actor): Promise<TelegramReplyResult> {
      return decide('deny', taskId, expectedPromptId, actor);
    },

    async describePermissionPrompt(taskId): Promise<PermissionPromptCardInfo | null> {
      const task = deps.taskStore.getTask(taskId);
      const sessionId = resolveSession(taskId);
      if (!task || !sessionId) return null;
      const live = liveBinding(sessionId);
      if (!live) return null;
      const pane = await readPane(sessionId);
      // The pane read is async: describe only a prompt that is still the one read.
      if (liveBinding(sessionId)?.requestId !== live.requestId) return null;
      const project = task.projectId ?? basenameOf(task.cwd);
      return {
        promptId: live.requestId.slice(0, PROMPT_ID_LEN),
        ...(task.name ? { taskName: task.name } : {}),
        ...(project ? { project } : {}),
        toolName: live.event.toolName,
        command: redactSecrets(toolInputText(live.event.toolInput)),
        canDeny: typeof findPermissionOptionKey(pane, 'deny') === 'string',
      };
    },

    permissionPromptClosedReason(taskId): PermissionPromptClosedReason {
      const task = deps.taskStore.getTask(taskId);
      if (!task || task.status !== 'inProgress' || !latestLiveSession(task)) return 'task_ended';
      return 'answered';
    },

    permissionPromptId(taskId): string | null {
      const sessionId = resolveSession(taskId);
      if (!sessionId) return null;
      const requestId = liveBinding(sessionId)?.requestId;
      return requestId ? requestId.slice(0, PROMPT_ID_LEN) : null;
    },
  };
}
