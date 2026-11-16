/**
 * Lucy speaks up when a task has waited on a permission prompt (issue #3932).
 *
 * The 3-minute operator page and the Telegram card (`permission-prompt-wait-alert.ts`) are for an
 * operator who is away. This is for one at the dashboard with Lucy's panel on: once a prompt has
 * waited a minute (setting `lucyPermissionNoticeAfterSeconds`, default 60, `0` turns it off), her
 * panel shows a card with the task, the whole command and Approve once / Deny, and she says one
 * sentence about it. It reads the same list of blocked tasks as the page, on the same liveness tick.
 *
 * Rules, all decided here so every tab and every reload agrees:
 *
 * - The sentence is written from a fixed pattern ("The task X is waiting for your permission to use
 *   Bash. The command is on my card."). The task name gets the cleaning the board's speech uses, the
 *   tool name is spoken only when it is a plain word, and the command is never spoken.
 * - At most one spoken notice every {@link LUCY_PERMISSION_NOTICE_GAP_MS}. Cards that arrive in the
 *   meantime are said together once the gap is over ("Two more tasks are waiting for you."); one that
 *   was answered before then is left out.
 * - A card goes when its prompt does (answered anywhere, or the task stopped). The browser stops a
 *   sentence once none of the prompts it is about is on the list.
 * - A reload or a reconnect gets the list without a sentence, so she does not repeat herself. A
 *   sentence is used up only when at least one dashboard received it. Notice ids are derived from the
 *   prompts, so the browser's list of already-spoken ids also catches a sentence sent twice. (After a
 *   server restart the monitor detects the prompts again, with new ids: she may say them once more.)
 *
 * The buttons send the dashboard's existing `permissionChoice` message, bound to the prompt with the
 * same binding as the finding card, so the server's stale-prompt check applies unchanged. Their keys
 * are read from the pane; a button whose option is not on screen is left out, and a prompt seen only
 * on the pane (no hook event, so nothing to bind to) gets a card without buttons.
 *
 * State lives in process memory, like the page's.
 */
import { createHash } from 'node:crypto';

import type { AgentEvent } from '../core/agent-events.js';
import { findPermissionOptionKey } from '../core/permission-actions.js';
import { redactSecrets } from '../core/redact-secrets.js';
import { isGenericTaskName, spokenTaskName } from '../core/spoken-task-name.js';
import { redactedTaskName } from '../core/task-speech-summary.js';
import type { Actor } from './auth.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  DEFAULT_LUCY_PERMISSION_NOTICE_AFTER_SECONDS,
  LUCY_PERMISSION_NOTICE_GAP_MS,
  type LucyPermissionAnnouncement,
  type LucyPermissionCardView,
} from '../shared/contracts/lucy-permission.js';
import type { PermissionPromptWait } from './permission-prompt-wait-alert.js';
import { buildPermissionRequestBinding, latestPermissionRequestEvent } from './permission-request-binding.js';
import { toolInputText } from './telegram-task-bridge.js';

/** Spoken notices kept for the speak route; older ones answer 404. */
const MAX_REMEMBERED_NOTICES = 50;

export interface LucyPermissionNotifierDeps {
  /**
   * Send the whole card list to the owner's dashboards, with the sentence to say when there is one.
   * Returns how many dashboards it reached (a sentence nobody received is said later). Must not throw.
   */
  push: (cards: LucyPermissionCardView[], announce?: LucyPermissionAnnouncement) => number;
  /** The attention queue's finding for a session: the one the `permissionChoice` check validates against. */
  getAnomaly: (sessionId: string) => Anomaly | null;
  getAgentEvents: (sessionId: string) => AgentEvent[];
  /** The session's terminal, to find the menu keys of "Yes" and "No". */
  capturePane: (sessionId: string) => Promise<string>;
  /** Live setting in milliseconds; 0 turns the notices off. Defaults to 60 s. */
  getAfterMs?: () => number;
  now?: () => number;
}

interface Episode {
  sinceMs: number;
  /** A card is being built (the pane read is async). */
  building: boolean;
  card?: LucyPermissionCardView;
  /** The card was in a spoken notice. */
  spoken: boolean;
}

interface Notice {
  text: string;
  promptIds: string[];
  taskId?: string;
  taskName?: string;
}

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * The tool as she says it. Built-in tool names are plain words (`Bash`, `Edit`, `WebFetch`); an MCP
 * tool's name is chosen by whoever configured the server, and anything else is not read out.
 */
export function spokenToolName(toolName: string): string {
  if (/^[A-Z][A-Za-z]{1,30}$/.test(toolName)) return toolName;
  if (toolName.startsWith('mcp__')) return 'an MCP tool';
  return 'a tool';
}

/** The task name as she may say it, or undefined when it may not be read aloud. */
function sayableTaskName(name: string | undefined): string | undefined {
  const spoken = name ? spokenTaskName(redactedTaskName(name)) : '';
  return spoken && !isGenericTaskName(spoken) ? spoken : undefined;
}

/** The sentence for one card. Never contains the command. */
export function singleNoticeSentence(card: Pick<LucyPermissionCardView, 'taskName' | 'toolName'>): string {
  const name = sayableTaskName(card.taskName);
  const subject = name ? `The task "${name}"` : 'A task';
  return `${subject} is waiting for your permission to use ${spokenToolName(card.toolName)}. The command is on my card.`;
}

/** The sentence for several cards said together; `more` when she has already spoken about another card on the list. */
export function groupedNoticeSentence(count: number, more: boolean): string {
  if (more) return `${countWord(count)} more ${count === 1 ? 'task is' : 'tasks are'} waiting for you.`;
  return `${countWord(count)} tasks are waiting for your permission. The commands are on my cards.`;
}

function noticeIdFor(promptIds: readonly string[]): string {
  const key = [...promptIds].sort().join('\n');
  return `perm-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export class LucyPermissionNotifier {
  private readonly episodes = new Map<string, Episode>();
  private readonly notices = new Map<string, Notice>();
  private lastSpokenAt: number | undefined;
  private readonly deps: LucyPermissionNotifierDeps;

  constructor(deps: LucyPermissionNotifierDeps) {
    this.deps = deps;
  }

  /** The cards on the panel now, oldest prompt first. Sent to a dashboard when it connects. */
  list(): LucyPermissionCardView[] {
    return [...this.episodes.values()]
      .flatMap((episode) => (episode.card ? [episode.card] : []))
      .sort((a, b) => a.since - b.since);
  }

  /**
   * The sentence of a spoken notice, for the speak route. `open` is false once none of its prompts
   * is on the list; undefined for an id this server never announced (or forgot).
   */
  notice(noticeId: string): (Notice & { open: boolean }) | undefined {
    const notice = this.notices.get(noticeId);
    if (!notice) return undefined;
    const onList = new Set(this.list().map((card) => card.promptId));
    return { ...notice, open: notice.promptIds.some((id) => onList.has(id)) };
  }

  /** `waits` is every task blocked on a prompt right now (`collectPermissionPromptWaits`). Safe to call every tick. */
  evaluate(waits: ReadonlyArray<PermissionPromptWait>): void {
    const nowMs = this.now();
    const afterMs = this.afterMs();
    const present = new Set<string>();
    let changed = false;

    for (const wait of waits) {
      present.add(wait.taskId);
      let episode = this.episodes.get(wait.taskId);
      if (episode && episode.sinceMs !== wait.sinceMs) {
        // The earlier prompt was answered and a new one is open.
        if (episode.card) changed = true;
        this.episodes.delete(wait.taskId);
        episode = undefined;
      }
      if (!episode) {
        episode = { sinceMs: wait.sinceMs, building: false, spoken: false };
        this.episodes.set(wait.taskId, episode);
      }
      if (afterMs === 0) {
        if (episode.card) changed = true;
        episode.card = undefined;
        continue;
      }
      if (episode.card?.permissionRequest && wait.sessionId
        && this.currentRequestId(wait.sessionId) !== episode.card.permissionRequest.requestId) {
        // Another prompt opened under the same finding: the card is rebuilt for it.
        episode.card = undefined;
        episode.spoken = false;
        changed = true;
      }
      if (!episode.card && !episode.building && wait.sessionId && nowMs - wait.sinceMs >= afterMs) {
        this.build(wait, wait.sessionId, episode);
      }
    }

    for (const [taskId, episode] of this.episodes) {
      if (present.has(taskId)) continue;
      if (episode.card) changed = true;
      this.episodes.delete(taskId);
    }

    this.publish(nowMs, changed);
  }

  /** The binding id of the session's open prompt, or undefined when no button could be bound to it. */
  private currentRequestId(sessionId: string): string | undefined {
    const event = latestPermissionRequestEvent(this.deps.getAgentEvents(sessionId));
    const anomaly = this.deps.getAnomaly(sessionId);
    return event && anomaly?.type === 'permission_blocked'
      ? buildPermissionRequestBinding({ sessionId, event, detectedAt: anomaly.detectedAt }).requestId
      : undefined;
  }

  private build(wait: PermissionPromptWait, sessionId: string, episode: Episode): void {
    episode.building = true;
    const event = latestPermissionRequestEvent(this.deps.getAgentEvents(sessionId));
    const anomaly = this.deps.getAnomaly(sessionId);
    const binding = event && anomaly?.type === 'permission_blocked'
      ? buildPermissionRequestBinding({ sessionId, event, detectedAt: anomaly.detectedAt })
      : undefined;
    const panePromise = binding
      ? this.deps.capturePane(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);
    void panePromise.then((pane) => {
      if (this.episodes.get(wait.taskId) !== episode) return;
      episode.building = false;
      if (binding) {
        // The pane read is async: keep the keys only if they were read for the prompt still open.
        if (this.currentRequestId(sessionId) !== binding.requestId) return; // Built again on the next tick.
      }
      const approveKey = findPermissionOptionKey(pane, 'allow-once');
      const denyKey = findPermissionOptionKey(pane, 'deny');
      episode.card = {
        promptId: binding?.requestId ?? `pane:${wait.taskId}:${wait.sinceMs}`,
        taskId: wait.taskId,
        agentId: sessionId,
        ...(wait.taskName ? { taskName: wait.taskName } : {}),
        toolName: event ? event.toolName : wait.toolName,
        command: event ? redactSecrets(toolInputText(event.toolInput)) : wait.command,
        since: wait.sinceMs,
        ...(binding ? { permissionRequest: binding } : {}),
        ...(binding && typeof approveKey === 'string' ? { approveKey } : {}),
        ...(binding && typeof denyKey === 'string' ? { denyKey } : {}),
      };
      this.publish(this.now(), true);
    }).catch((err: unknown) => {
      episode.building = false;
      console.warn('[lucy-permission] card build failed (ignored):', err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Push the list when it changed or when a sentence is due: cards not yet spoken about, once the gap
   * since the last sentence is over. The sentence counts as said only if a dashboard received it.
   */
  private publish(nowMs: number, changed: boolean): void {
    const unspoken = [...this.episodes.values()].filter((ep) => ep.card && !ep.spoken);
    const due = unspoken.length > 0
      && (this.lastSpokenAt === undefined || nowMs - this.lastSpokenAt >= LUCY_PERMISSION_NOTICE_GAP_MS);
    if (!due) {
      if (changed) this.push(undefined);
      return;
    }
    const cards = unspoken.map((ep) => ep.card as LucyPermissionCardView).sort((a, b) => a.since - b.since);
    const more = [...this.episodes.values()].some((ep) => ep.card && ep.spoken);
    const only = cards.length === 1 ? cards[0] : undefined;
    const text = only ? singleNoticeSentence(only) : groupedNoticeSentence(cards.length, more);
    const promptIds = cards.map((card) => card.promptId);
    const noticeId = noticeIdFor(promptIds);
    // Recorded before the push so the speak route, called as soon as a dashboard gets the message, finds it.
    this.notices.set(noticeId, {
      text,
      promptIds,
      ...(only ? { taskId: only.taskId } : {}),
      ...(only?.taskName ? { taskName: only.taskName } : {}),
    });
    while (this.notices.size > MAX_REMEMBERED_NOTICES) {
      const oldest = this.notices.keys().next().value;
      if (oldest === undefined) break;
      this.notices.delete(oldest);
    }
    if (this.push({ noticeId, promptIds }) === 0) return; // Nobody heard it: said once a dashboard is open.
    for (const ep of unspoken) ep.spoken = true;
    this.lastSpokenAt = nowMs;
  }

  private push(announce: LucyPermissionAnnouncement | undefined): number {
    try {
      return this.deps.push(this.list(), announce);
    } catch (err) {
      console.warn('[lucy-permission] push threw (ignored):', err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private afterMs(): number {
    const value = this.deps.getAfterMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    return DEFAULT_LUCY_PERMISSION_NOTICE_AFTER_SECONDS * 1000;
  }
}

const WS_OPEN = 1;

/** One dashboard socket and who holds it. */
export interface LucyPermissionConnection {
  ws: { readyState: number; send(data: string): void };
  actor: Actor;
}

/** The message a dashboard is sent: the whole list, and the sentence to say when there is one. */
export function lucyPermissionMessage(
  cards: LucyPermissionCardView[],
  announce?: LucyPermissionAnnouncement,
): Extract<ServerMessage, { type: 'lucyPermissionCards' }> {
  return { type: 'lucyPermissionCards', cards, serverNow: Date.now(), ...(announce ? { announce } : {}) };
}

/**
 * Send the card list to every open owner connection. Owner only: a card holds a whole command and
 * buttons that answer it. Returns how many connections were sent to.
 */
export function pushLucyPermissionCards(
  connections: Iterable<LucyPermissionConnection>,
  cards: LucyPermissionCardView[],
  announce?: LucyPermissionAnnouncement,
): number {
  const data = JSON.stringify(lucyPermissionMessage(cards, announce));
  let sent = 0;
  for (const { ws, actor } of connections) {
    if (actor.kind !== 'owner' || ws.readyState !== WS_OPEN) continue;
    try {
      ws.send(data);
      sent += 1;
    } catch (err) {
      console.warn('[lucy-permission] could not push the card list to a dashboard connection:', err);
    }
  }
  return sent;
}
