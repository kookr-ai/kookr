/**
 * Lucy writes a word when something happens to a task she did not launch.
 *
 * Five events are worth one: a task failed, a task went quiet (`stale_agent`), Kookr lost contact
 * with a task (`hook_disconnected`), a task went over its spend warning (`budget_exceeded`), and a
 * task says it is finished and wants a review (`completion_ready`). Each becomes one line in her
 * thread on every open owner dashboard (`lucy_says`). Nothing is spoken.
 *
 * The rules that keep this from being a stream of noise, all decided here so every tab agrees:
 *
 * - "Finished, wants your review" is never written at once. Kookr closes almost every task that
 *   signals it is finished by itself, within minutes, so the line would be untrue almost every
 *   time. The event is held for {@link LUCY_SAYS_REVIEW_HOLD_MS} and enters the rules below only
 *   if the task is then still open and still carries the signal. The three other events enter at once.
 * - The first event is written at once, as one sentence naming the task ("Docs link audit
 *   failed."). It opens a window of {@link LUCY_SAYS_GROUP_WINDOW_MS}.
 * - Events that arrive while the window is open wait. When it closes they are written together in
 *   one line ("Two more tasks want your review: A and B."), and a new window opens. So at most one
 *   line every two minutes, however many tasks end at once. An event that is no longer true when
 *   the window closes (the task picked up again, the review was taken) is left out.
 * - The same task and the same kind of event are never written twice within
 *   {@link LUCY_SAYS_REPEAT_MS}. A finding that comes and goes keeps that clock running: each
 *   occurrence inside the ten minutes restarts it, so a flapping task is mentioned once, not every
 *   ten minutes.
 * - A task she launched herself is left out: the launch controller reports it, in the conversation
 *   that asked for it.
 * - Going over budget is one line per task. The budget checker raises its finding at the project's
 *   warning threshold and again at twice it; the second, inside the ten minutes, is the same kind
 *   for the same task and adds nothing. The line says the two amounts the finding carries ("is at
 *   $51.25, over its $50.00 alert"), and drops them, keeping the name, when either is missing or
 *   not a positive number: it never writes $0 or NaN. A snoozed task's finding never reaches the attention queue, so it gets
 *   no line. The budget checker's memory, like this one, is lost on a server restart: a running task
 *   already over budget is reported once more on the first token scan after start (one line, or one
 *   grouped line for several), which is still true and is kept on purpose rather than hidden by a
 *   quiet period that would also hide a real first breach.
 * - Nothing is kept for later. A line is sent to the dashboards open at that moment; a dashboard
 *   that connects or reloads afterwards is sent nothing, and a line that reached nobody is dropped
 *   without opening a window (the briefing she writes when the panel opens covers that case).
 *
 * The sentences are fixed patterns. A task is named when its title may be said aloud (the rules of
 * the board's names), cut to its first words when it is only too long; a task whose title cannot be
 * said at all is named by its project and the first characters of its id, so no line names nothing.
 * State lives in process memory.
 */
import { randomUUID } from 'node:crypto';

import { boardText } from '../core/lucy-operator/board.js';
import { countWord, sayableTaskName } from '../core/lucy-operator/operator-briefing.js';
import {
  LUCY_SAYS_GROUP_WINDOW_MS,
  LUCY_SAYS_REPEAT_MS,
  LUCY_SAYS_REVIEW_HOLD_MS,
  type LucySaysKind,
  type LucySaysMessage,
} from '../shared/contracts/lucy-says.js';
import type { Actor } from './auth.js';

/** What happened to a task. */
export type LucyTaskEventKind = 'failed' | 'lost_contact' | 'stalled' | 'over_budget' | 'wants_review';

/** What a budget finding says, as numbers: what the task had cost and the alert it passed. */
export interface LucyBudgetDetail {
  costUsd?: number;
  alertUsd?: number;
  /** The second firing, at twice the alert. */
  twice?: boolean;
}

export interface LucyTaskEvent {
  taskId: string;
  taskName?: string;
  /** The display name of the task's project, for a line about a task whose title cannot be said. */
  projectName?: string;
  kind: LucyTaskEventKind;
  /** Only for `over_budget`, from the finding. */
  budget?: LucyBudgetDetail;
}

/** The budget figures of a finding, for the event about it; undefined for any other finding. */
export function budgetDetailOfFinding(anomaly: { type: string; severity?: string; costUsd?: number; alertUsd?: number }): LucyBudgetDetail | undefined {
  if (anomaly.type !== 'budget_exceeded') return undefined;
  return {
    ...(anomaly.costUsd !== undefined ? { costUsd: anomaly.costUsd } : {}),
    ...(anomaly.alertUsd !== undefined ? { alertUsd: anomaly.alertUsd } : {}),
    ...(anomaly.severity === 'critical' ? { twice: true } : {}),
  };
}

/**
 * The finding that makes a task "over budget", "gone quiet" or "lost contact"; undefined for every
 * other finding. Going over budget counts even for a task that has said it is finished: the money is
 * spent either way. The two others do not count for such a task (`pendingSignalKind` is
 * `completion_ready`): it is quiet because it is waiting for its review, which she writes about.
 */
export function taskEventForFinding(anomalyType: string, pendingSignalKind?: string): LucyTaskEventKind | undefined {
  if (anomalyType === 'budget_exceeded') return 'over_budget';
  if (pendingSignalKind === 'completion_ready') return undefined;
  if (anomalyType === 'stale_agent') return 'stalled';
  if (anomalyType === 'hook_disconnected') return 'lost_contact';
  return undefined;
}

/**
 * The event for a task outcome: it failed, or it says it is finished and wants a review. A task that
 * completed or was cancelled is not news here. Neither is a failure the operator caused (`manual`)
 * or one a server restart caused (`server-restart`: such a task is resumed, or was already known).
 */
export function taskEventForOutcome(outcomeKind: string, terminationReason?: string): LucyTaskEventKind | undefined {
  if (outcomeKind === 'completion_ready') return 'wants_review';
  if (outcomeKind === 'failed' && terminationReason !== 'manual' && terminationReason !== 'server-restart') return 'failed';
  return undefined;
}

/** The task fields {@link taskEventStillTrue} reads; Kookr's task record satisfies it. */
export interface LucySaysTask {
  status: string;
  sessions: ReadonlyArray<{ tmuxSession: string }>;
  pendingSignal?: { kind: string };
}

/**
 * Whether an event that waited in a window is still true when the window closes: the task is still
 * failed (not resumed), still open after going over budget (the money stays spent; only a finished
 * task is no longer news), still waiting for its review, or still has the finding on one of its
 * sessions. `findingOf` gives the type of the finding raised on a session, if any.
 */
export function taskEventStillTrue(
  event: Pick<LucyTaskEvent, 'kind'>,
  task: LucySaysTask | undefined,
  findingOf: (sessionId: string) => string | undefined,
): boolean {
  if (!task) return false;
  if (event.kind === 'failed') return task.status === 'terminated';
  if (task.status === 'completed' || task.status === 'terminated' || task.status === 'cancelled') return false;
  if (event.kind === 'over_budget') return true;
  const wantsReview = task.pendingSignal?.kind === 'completion_ready';
  if (event.kind === 'wants_review') return wantsReview;
  // It said it is finished while the event waited: quiet is expected now.
  if (wantsReview) return false;
  const wanted = event.kind === 'stalled' ? 'stale_agent' : 'hook_disconnected';
  return task.sessions.some((session) => findingOf(session.tmuxSession) === wanted);
}

export interface LucySaysNotifierDeps {
  /** Send the line to the owner's open dashboards. Returns how many it reached. Must not throw. */
  push: (message: LucySaysMessage) => number;
  /** True for a task Lucy launched herself; its events are left to the launch controller. */
  isOwnLaunch?: (taskId: string) => boolean;
  /** Asked when a window closes, and when a held "wants review" comes due: is this still true of the task? Absent means yes. */
  stillTrue?: (event: LucyTaskEvent) => boolean;
  /**
   * Called once for each line that reached a dashboard, with the tasks it is about, so her next turn
   * knows what she just wrote (issue #4143). Must not throw; a failure is ignored.
   */
  onWritten?: (written: { id: string; text: string; tasks: Array<{ id: string; name?: string }> }) => void;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The order kinds are told in a grouped line: the worst news first. */
const KIND_ORDER: readonly LucyTaskEventKind[] = ['failed', 'lost_contact', 'stalled', 'over_budget', 'wants_review'];
const WIRE_KIND: Record<LucyTaskEventKind, LucySaysKind> = {
  failed: 'task_failed',
  lost_contact: 'task_lost_contact',
  stalled: 'task_stalled',
  over_budget: 'task_over_budget',
  wants_review: 'task_wants_review',
};
/** At most this many tasks are named in a grouped line; the others are counted. */
const MAX_NAMED = 3;
/** Remembered "said about this task" times; older ones are forgotten first. */
const MAX_REMEMBERED = 500;

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** US dollars as written in a sentence: "$51.25", "$1,234.50". */
function dollars(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isAmount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number(value.toFixed(2)) > 0;
}

/**
 * Who the sentence is about: the task's title when it may be said, otherwise its project and the first
 * characters of its id, and only when the event carries neither, "a task".
 */
function subjectOf(event: Partial<Pick<LucyTaskEvent, 'taskName' | 'taskId' | 'projectName'>>): { text: string; title: boolean } {
  const name = sayableTaskName(event.taskName);
  if (name !== undefined) return { text: name, title: true };
  return { text: fallbackSubject(event), title: false };
}

function fallbackSubject(event: Partial<Pick<LucyTaskEvent, 'taskId' | 'projectName'>>): string {
  // A project name with markup characters is not used, like a title with them.
  const project = /[<>`]/.test(event.projectName ?? '') ? '' : boardText(event.projectName, 40);
  const shortId = (event.taskId ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
  if (project && shortId) return `a task in ${project} (${shortId})`;
  if (project) return `a task in ${project}`;
  if (shortId) return `task ${shortId}`;
  return 'a task';
}

/** The sentence for one event. */
export function singleEventSentence(event: Pick<LucyTaskEvent, 'kind'> & Partial<Pick<LucyTaskEvent, 'taskName' | 'taskId' | 'projectName' | 'budget'>>): string {
  const { text: subject, title } = subjectOf(event);
  // A real title is written as it is ("iOS build"); only the fallback phrase starts a sentence.
  const head = title ? subject : capital(subject);
  switch (event.kind) {
    case 'failed':
      return `${head} failed.`;
    case 'stalled':
      return `${head} has gone quiet.`;
    case 'lost_contact':
      return `Kookr lost contact with ${subject}.`;
    case 'over_budget': {
      const { costUsd, alertUsd, twice } = event.budget ?? {};
      if (!isAmount(costUsd) || !isAmount(alertUsd)) return `${head} has gone over its budget.`;
      return `${head} is at ${dollars(costUsd)}, ${twice ? 'at least twice' : 'over'} its ${dollars(alertUsd)} alert.`;
    }
    case 'wants_review':
      return `${head} says it is finished and wants your review.`;
  }
}

/** ": A, B and two others" for the tasks that can be named; empty when none can. */
function nameList(events: readonly LucyTaskEvent[]): string {
  const names = events.map((event) => sayableTaskName(event.taskName)).filter((name): name is string => name !== undefined);
  if (names.length === 0) return '';
  const shown = names.slice(0, MAX_NAMED);
  const others = events.length - shown.length;
  const items = others > 0 ? [...shown, `${countWord(others)} ${others === 1 ? 'other' : 'others'}`] : shown;
  const listed = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `: ${listed}`;
}

/** The sentence for several events of one kind that followed an earlier line. */
export function groupedEventSentence(kind: LucyTaskEventKind, events: readonly LucyTaskEvent[]): string {
  const count = countWord(events.length);
  const names = nameList(events);
  switch (kind) {
    case 'failed':
      return `${capital(count)} more tasks failed${names}.`;
    case 'stalled':
      return `${capital(count)} more tasks have gone quiet${names}.`;
    case 'lost_contact':
      return `Kookr lost contact with ${count} more tasks${names}.`;
    case 'over_budget':
      return `${capital(count)} more tasks have gone over their budget${names}.`;
    case 'wants_review':
      return `${capital(count)} more tasks want your review${names}.`;
  }
}

/** The one line for everything that waited in a window: a sentence per kind, the worst news first. */
export function windowLine(events: readonly LucyTaskEvent[]): { text: string; kind: LucySaysKind; taskIds: string[] } {
  const sentences: string[] = [];
  const taskIds: string[] = [];
  const kinds: LucyTaskEventKind[] = [];
  for (const kind of KIND_ORDER) {
    const ofKind = events.filter((event) => event.kind === kind);
    if (ofKind.length === 0) continue;
    kinds.push(kind);
    sentences.push(ofKind.length === 1 ? singleEventSentence(ofKind[0]!) : groupedEventSentence(kind, ofKind));
    for (const event of ofKind) if (!taskIds.includes(event.taskId)) taskIds.push(event.taskId);
  }
  return { text: sentences.join(' '), kind: kinds.length === 1 ? WIRE_KIND[kinds[0]!] : 'several', taskIds };
}

export class LucySaysNotifier {
  private readonly deps: LucySaysNotifierDeps;
  /** `taskId:kind` -> when that was last written, or last seen again while still inside the repeat time. */
  private readonly lastSaid = new Map<string, number>();
  /** Events waiting for the open window to close, in arrival order. */
  private waiting: LucyTaskEvent[] = [];
  /** The timer of the open window; undefined when no window is open. */
  private windowTimer: unknown;
  private windowOpen = false;
  /** `taskId:kind` -> a "wants review" event waiting out {@link LUCY_SAYS_REVIEW_HOLD_MS}, with its timer. */
  private readonly heldReviews = new Map<string, { event: LucyTaskEvent; timer: unknown }>();

  constructor(deps: LucySaysNotifierDeps) {
    this.deps = deps;
  }

  /** Something happened to a task. Safe to call for every event: the rules in the file header decide. */
  note(event: LucyTaskEvent): void {
    if (this.isOwnLaunch(event.taskId)) return;
    const key = keyOf(event);
    const nowMs = this.now();
    const last = this.lastSaid.get(key);
    if (last !== undefined && nowMs - last < LUCY_SAYS_REPEAT_MS) {
      // Still the same trouble coming and going: the ten minutes start again.
      this.remember(key, nowMs);
      return;
    }
    if (event.kind === 'wants_review') this.holdReview(key, event);
    else this.admit(key, event);
  }

  /** Stop every timer (shutdown, tests). Events still waiting or held are dropped. */
  dispose(): void {
    if (this.windowTimer !== undefined) this.clearTimer(this.windowTimer);
    this.windowTimer = undefined;
    this.windowOpen = false;
    this.waiting = [];
    for (const held of this.heldReviews.values()) this.clearTimer(held.timer);
    this.heldReviews.clear();
  }

  /**
   * Keep a "wants review" event back for {@link LUCY_SAYS_REVIEW_HOLD_MS}. When the time is up it is
   * written like any other event, but only if it is still true: most tasks have been closed by then.
   * The same signal arriving again while it is held changes nothing; the wait runs from the first.
   */
  private holdReview(key: string, event: LucyTaskEvent): void {
    if (this.heldReviews.has(key)) return;
    const held: { event: LucyTaskEvent; timer: unknown } = { event, timer: undefined };
    held.timer = this.setTimer(() => {
      if (this.heldReviews.get(key) !== held) return;
      this.heldReviews.delete(key);
      if (this.stillTrue(event)) this.admit(key, event);
    }, LUCY_SAYS_REVIEW_HOLD_MS);
    this.heldReviews.set(key, held);
  }

  /** Write the event at once, or let it wait for the open window to close. */
  private admit(key: string, event: LucyTaskEvent): void {
    if (this.windowOpen) {
      if (!this.waiting.some((other) => keyOf(other) === key)) this.waiting.push(event);
      return;
    }
    this.write([event], { text: singleEventSentence(event), kind: WIRE_KIND[event.kind], taskIds: [event.taskId] });
  }

  private closeWindow(): void {
    this.windowTimer = undefined;
    this.windowOpen = false;
    const events = this.waiting.filter((event) => this.stillTrue(event));
    this.waiting = [];
    if (events.length > 0) this.write(events, windowLine(events));
  }

  /** Send one line. Only a line that reached a dashboard counts as written and opens the next window. */
  private write(events: readonly LucyTaskEvent[], line: { text: string; kind: LucySaysKind; taskIds: string[] }): void {
    const nowMs = this.now();
    const message: LucySaysMessage = { type: 'lucy_says', id: (this.deps.newId ?? randomUUID)(), kind: line.kind, text: line.text, taskIds: line.taskIds, at: nowMs };
    let reached = 0;
    try {
      reached = this.deps.push(message);
    } catch (err) {
      console.warn('[lucy-says] push threw (ignored):', err instanceof Error ? err.message : String(err));
    }
    if (reached === 0) return;
    try {
      const tasks = line.taskIds.map((id) => {
        const name = events.find((event) => event.taskId === id)?.taskName;
        return { id, ...(name ? { name } : {}) };
      });
      this.deps.onWritten?.({ id: message.id, text: line.text, tasks });
    } catch (err) {
      console.warn('[lucy-says] onWritten threw (ignored):', err instanceof Error ? err.message : String(err));
    }
    for (const event of events) this.remember(keyOf(event), nowMs);
    this.windowOpen = true;
    this.windowTimer = this.setTimer(() => this.closeWindow(), LUCY_SAYS_GROUP_WINDOW_MS);
  }

  private remember(key: string, at: number): void {
    // Re-inserted so the map stays ordered by last use, and the oldest entry is the first to go.
    this.lastSaid.delete(key);
    this.lastSaid.set(key, at);
    while (this.lastSaid.size > MAX_REMEMBERED) {
      const oldest = this.lastSaid.keys().next().value;
      if (oldest === undefined) break;
      this.lastSaid.delete(oldest);
    }
  }

  private isOwnLaunch(taskId: string): boolean {
    try {
      return this.deps.isOwnLaunch?.(taskId) === true;
    } catch {
      return false;
    }
  }

  private stillTrue(event: LucyTaskEvent): boolean {
    try {
      return this.deps.stillTrue?.(event) !== false;
    } catch {
      return true;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as NodeJS.Timeout);
  }
}

function keyOf(event: Pick<LucyTaskEvent, 'taskId' | 'kind'>): string {
  return `${event.taskId}:${event.kind}`;
}

const WS_OPEN = 1;

/** One dashboard socket and who holds it. */
export interface LucySaysConnection {
  ws: { readyState: number; send(data: string): void };
  actor: Actor;
}

/**
 * Send a line to every open owner connection, and to no viewer: it names tasks. Returns how many
 * connections were sent to.
 */
export function pushLucySays(connections: Iterable<LucySaysConnection>, message: LucySaysMessage): number {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const { ws, actor } of connections) {
    if (actor.kind !== 'owner' || ws.readyState !== WS_OPEN) continue;
    try {
      ws.send(data);
      sent += 1;
    } catch (err) {
      console.warn('[lucy-says] could not push to a dashboard connection:', err);
    }
  }
  return sent;
}
