/**
 * Operator page when a task's agent has waited on a permission prompt for
 * more than a few minutes (issue #3872).
 *
 * A Claude Code permission prompt ("Claude needs your permission") stops the
 * agent until someone answers it. The dashboard shows the `permission_blocked`
 * finding, but nobody watching an unattended run sees the dashboard: on
 * 15 Nov 2026 two worker tasks waited 76 and 52 minutes on such a prompt and
 * nothing reached the operator's phone.
 *
 * In both incidents the hook log ends on a subagent's `PermissionRequest`
 * hook event (Bash), followed about 7 seconds later by a
 * `Notification(permission_prompt)`. The monitor already turns that pair into
 * a `permission_blocked` anomaly: notifications are trailing overlays, and
 * `permission_blocked` is not suppressed while subagents run. This module
 * reads that anomaly; it does not add a second detector.
 *
 * Neither incident task carried `unattended: true` (they were spawned by a
 * parent task without the flag), so the page covers every live task. An
 * operator at the dashboard answers long before the threshold, so attended
 * tasks rarely page.
 *
 * This module is **page-only**: it never answers a prompt or touches a task.
 * Per task it:
 *
 * - fires one operational alert (key `permission_prompt:<taskId>`) once the
 *   current prompt has waited 3 minutes;
 * - never re-pages the same prompt;
 * - emits the matching `recovered` clear when the prompt is answered or the
 *   task stops being a live, in-progress task.
 *
 * Episode state lives in process memory, like the hungSuspect residual
 * alerter (#1993): a server restart resets the wait clock, so a prompt that
 * outlives a restart pages again 3 minutes after the restart.
 *
 * Known limit (issue #3911): the recovered clear can arrive while the prompt
 * is still open. It follows the `permission_blocked` finding, which ends on
 * later activity from the session, such as a sibling subagent's tool call.
 * Ending the episode only on the prompt's own answer would need the
 * `permission_request` event to carry the tool-use id of the call it is
 * about, and the events Kookr records carry none. See
 * docs/reference/offline-recovery-card.md §3b.
 *
 * Wire via detectorBroadcast (index.ts) so fire/clear edges spool to the
 * operator-signal outbox (Telegram/Discord).
 *
 * Telegram card (issue #3925): when a `card` port is wired, the threshold
 * first offers the prompt to it. The Telegram integration then sends the
 * operator one message with the whole command and Approve once / Deny
 * buttons. When that message is in place the plain-text page (and its
 * recovered clear) is not sent, so the operator gets one message, not two;
 * the page is still sent when the card could not be (Telegram off, no prompt
 * the buttons can be bound to, send failure). When the prompt goes away the
 * card is told, so it can say what happened and drop its buttons.
 */

import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { AgentEvent } from '../core/agent-events.js';
import { redactSecrets } from '../core/redact-secrets.js';
import type { PermissionPromptCardPort } from '../shared/contracts/telegram.js';
import { closesPendingPermission } from '../core/watchdog.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert key prefix; the task id follows the colon. */
export const PERMISSION_PROMPT_ALERT_KEY_PREFIX = 'permission_prompt' as const;

export const PERMISSION_PROMPT_METRIC = 'permission_prompt_wait' as const;

/** How long a prompt must wait before the page fires (issue #3872). */
export const PERMISSION_PROMPT_WAIT_THRESHOLD_MS = 3 * 60_000;

/** Longest command text quoted in the page. */
export const PERMISSION_PROMPT_COMMAND_MAX_CHARS = 200;

export function permissionPromptAlertKey(taskId: string): string {
  return `${PERMISSION_PROMPT_ALERT_KEY_PREFIX}:${taskId}`;
}

/** One task whose agent is currently stopped on a permission prompt. */
export interface PermissionPromptWait {
  taskId: string;
  /** Task display name; the page falls back to the id. */
  taskName?: string;
  /** Tool the agent asked permission for, e.g. `Bash`. */
  toolName: string;
  /** Command, file path or URL from the tool input; empty when unknown. */
  command: string;
  /**
   * When the monitor first saw this prompt (ms since epoch). It also
   * identifies the prompt: a different value on the same task is a new
   * prompt, which closes the previous episode.
   */
  sinceMs: number;
}

export interface PermissionPromptWaitAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox. Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Telegram permission card (issue #3925); the page is the fallback. */
  card?: PermissionPromptCardPort;
}

interface PromptEpisode {
  sinceMs: number;
  /** The plain-text page was emitted (its recovered clear is owed). */
  firing: boolean;
  /** The threshold was reached and the operator was (or is being) told. */
  notified: boolean;
  /** The prompt was offered to the Telegram card. */
  cardOffered: boolean;
  taskName?: string;
  toolName: string;
}

/** Monitor reads used to find blocked tasks. */
export interface PermissionPromptMonitorView {
  getCurrentAnomaly(agentId: string): Anomaly | null;
  getAgentEvents(agentId: string): AgentEvent[];
}

/** Task fields used to find blocked tasks. */
export interface PermissionPromptTaskView {
  id: string;
  name?: string;
  status: string;
  sessions: ReadonlyArray<{ tmuxSession: string }>;
}

/**
 * Text quoted in the page for a tool input: the command, file path, path or
 * URL, whitespace collapsed, secrets redacted, capped at `maxChars`.
 */
export function describePermissionToolInput(
  input: unknown,
  maxChars: number = PERMISSION_PROMPT_COMMAND_MAX_CHARS,
): string {
  let raw = '';
  if (typeof input === 'string') {
    raw = input;
  } else if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url']) {
      const value = obj[key];
      if (typeof value === 'string') {
        raw = value;
        break;
      }
    }
  }
  const text = redactSecrets(raw.replace(/\s+/g, ' ').trim());
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The `permission_request` event that is still waiting for an answer, so its
 * command can be quoted. Quoting a request that was already answered would
 * send the operator the wrong command, so each rule below gives up rather
 * than guess.
 *
 * - The finding names a tool (the hook finding "Agent is blocked on
 *   permission for tool: X", or the watchdog's "Permission request pending
 *   for tool: X"): the latest request, when no later event answers it under
 *   the watchdog's rule ({@link closesPendingPermission}) and it is for that
 *   tool. Events such as a sibling subagent starting do not answer it
 *   (issue #3911).
 * - The finding names no tool (seen on the pane): the last event of the
 *   window once trailing notifications and subagent stops are skipped, the
 *   same trim the anomaly detector applies.
 */
function openPermissionRequest(
  events: ReadonlyArray<AgentEvent>,
  findingToolName: string | undefined,
): Extract<AgentEvent, { type: 'permission_request' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'permission_request') {
      return findingToolName === undefined || event.toolName === findingToolName ? event : undefined;
    }
    if (findingToolName !== undefined) {
      if (closesPendingPermission(event)) return undefined;
    } else if (event.type !== 'notification' && event.type !== 'subagent_stop') {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Build the alerter input from the task store and the monitor: every live,
 * in-progress task whose latest session currently has a `permission_blocked`
 * finding. The tool and command come from the open `permission_request`
 * event. When no open event can be found (for example a block seen only on
 * the pane), the task still pages, with the tool named from the finding when
 * the finding names one, and no command.
 */
export function collectPermissionPromptWaits(
  tasks: Iterable<PermissionPromptTaskView>,
  monitor: PermissionPromptMonitorView,
): PermissionPromptWait[] {
  const waits: PermissionPromptWait[] = [];
  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const sessionName = task.sessions[task.sessions.length - 1]?.tmuxSession;
    if (!sessionName) continue;
    const anomaly = monitor.getCurrentAnomaly(sessionName);
    if (anomaly?.type !== 'permission_blocked') continue;
    const sinceMs = new Date(anomaly.detectedAt).getTime();
    if (!Number.isFinite(sinceMs)) continue;

    const findingToolName = /for tool: (\S+)/.exec(anomaly.explanation)?.[1];
    const request = openPermissionRequest(monitor.getAgentEvents(sessionName), findingToolName);
    const toolName = request?.toolName ?? findingToolName ?? 'unknown tool';
    waits.push({
      taskId: task.id,
      ...(task.name ? { taskName: task.name } : {}),
      toolName,
      command: request ? describePermissionToolInput(request.toolInput) : '',
      sinceMs,
    });
  }
  return waits;
}

/**
 * Edge-triggered page for permission prompts that wait too long. One alert
 * per prompt, one clear per alert. Safe to call every liveness tick.
 */
export class PermissionPromptWaitAlerter {
  private readonly episodes = new Map<string, PromptEpisode>();
  private readonly deps: PermissionPromptWaitAlerterDeps;

  constructor(deps: PermissionPromptWaitAlerterDeps) {
    this.deps = deps;
  }

  /**
   * `waits` is the full list of tasks blocked right now. A task that was
   * paged and is absent from the list gets its clear.
   */
  evaluate(waits: ReadonlyArray<PermissionPromptWait>): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const present = new Set<string>();

    for (const wait of waits) {
      present.add(wait.taskId);
      let episode = this.episodes.get(wait.taskId);
      if (episode && episode.sinceMs !== wait.sinceMs) {
        // The earlier prompt was answered and a new one is open.
        this.closeEpisode(wait.taskId, episode);
        episode = undefined;
      }
      if (!episode) {
        episode = { sinceMs: wait.sinceMs, firing: false, notified: false, cardOffered: false, toolName: wait.toolName };
        this.episodes.set(wait.taskId, episode);
      }
      episode.toolName = wait.toolName;
      if (wait.taskName) episode.taskName = wait.taskName;

      const waitedMs = nowMs - wait.sinceMs;
      if (!episode.notified && waitedMs >= PERMISSION_PROMPT_WAIT_THRESHOLD_MS) {
        episode.notified = true;
        this.notify(wait, episode, waitedMs);
      }
    }

    for (const [taskId, episode] of this.episodes) {
      if (present.has(taskId)) continue;
      this.closeEpisode(taskId, episode);
    }
  }

  /** Task ids with an open (paged, not yet cleared) prompt. Tests / diagnostics. */
  firingTaskIds(): string[] {
    return [...this.episodes].filter(([, ep]) => ep.firing).map(([id]) => id);
  }

  /** Offer the prompt to the Telegram card; page when the card is not in place. */
  private notify(wait: PermissionPromptWait, episode: PromptEpisode, waitedMs: number): void {
    const card = this.deps.card;
    const page = (): void => {
      episode.firing = true;
      this.emit(buildPermissionPromptAlert(wait, waitedMs));
    };
    if (!card) {
      page();
      return;
    }
    episode.cardOffered = true;
    let offered: Promise<boolean>;
    try {
      offered = card.offer(wait.taskId, waitedMs);
    } catch {
      offered = Promise.resolve(false);
    }
    void offered.catch(() => false).then((inPlace) => {
      // Page only while this prompt is still open: a prompt answered while the
      // card was being sent needs no page.
      if (!inPlace && this.episodes.get(wait.taskId) === episode) page();
    });
  }

  private closeEpisode(taskId: string, episode: PromptEpisode): void {
    this.episodes.delete(taskId);
    if (episode.cardOffered) {
      try {
        this.deps.card?.close(taskId);
      } catch (err) {
        console.warn(
          '[permission-prompt-wait] card close threw (ignored):',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (episode.firing) {
      this.emit(buildPermissionPromptRecoveryAlert({
        taskId,
        ...(episode.taskName ? { taskName: episode.taskName } : {}),
        toolName: episode.toolName,
      }));
    }
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[permission-prompt-wait] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function taskLabel(args: { taskId: string; taskName?: string }): string {
  return args.taskName ? `"${args.taskName}" (${args.taskId})` : args.taskId;
}

export function buildPermissionPromptAlert(
  wait: PermissionPromptWait,
  waitedMs: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const waitedMin = Math.max(1, Math.floor(waitedMs / 60_000));
  const request = wait.command ? `${wait.toolName}: ${wait.command}` : wait.toolName;
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Task ${taskLabel(wait)} has waited ${waitedMin}m on a permission prompt (${request})`,
    details:
      `The agent is stopped on a permission prompt for ${wait.toolName}`
      + (wait.command ? ` (${wait.command})` : '')
      + ` and has waited ${waitedMin} minute(s). Nothing moves until the prompt is answered: `
      + 'approve or deny it from the dashboard or Telegram, or answer it in the task terminal. '
      + 'This page clears when the prompt is answered or the task ends.',
    severity: 'warning',
    operationalAlert: {
      key: permissionPromptAlertKey(wait.taskId),
      metric: PERMISSION_PROMPT_METRIC,
      state: 'fired',
    },
  };
}

export function buildPermissionPromptRecoveryAlert(args: {
  taskId: string;
  taskName?: string;
  toolName: string;
}): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: task ${taskLabel(args)} is no longer waiting on a permission prompt`,
    details:
      `The ${args.toolName} permission prompt was answered, or the task is no longer running.`,
    severity: 'info',
    operationalAlert: {
      key: permissionPromptAlertKey(args.taskId),
      metric: PERMISSION_PROMPT_METRIC,
      state: 'recovered',
    },
  };
}
