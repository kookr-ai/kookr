/**
 * Lucy writes a word when something happens to a task she did not launch.
 *
 * Four events are worth one: a task failed, a task went quiet (`stale_agent`), Kookr lost contact
 * with a task (`hook_disconnected`), and a task says it is finished and wants a review
 * (`completion_ready`). Each becomes one line in her thread on every open owner dashboard
 * (`lucy_says`). Nothing is spoken.
 *
 * The rules that keep this from being a stream of noise, all decided here so every tab agrees:
 *
 * - The first event is written at once, as one sentence naming the task ("Docs link audit says it
 *   is finished and wants your review."). It opens a window of {@link LUCY_SAYS_GROUP_WINDOW_MS}.
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
 * - Nothing is kept for later. A line is sent to the dashboards open at that moment; a dashboard
 *   that connects or reloads afterwards is sent nothing, and a line that reached nobody is dropped
 *   without opening a window (the briefing she writes when the panel opens covers that case).
 *
 * The sentences are fixed patterns. A task is named only when its title may be said aloud (the
 * rules of the board's names); otherwise it is "a task". State lives in process memory.
 */
import { randomUUID } from 'node:crypto';

import { countWord, sayableTaskName } from '../core/lucy-operator/operator-briefing.js';
import {
  LUCY_SAYS_GROUP_WINDOW_MS,
  LUCY_SAYS_REPEAT_MS,
  type LucySaysKind,
  type LucySaysMessage,
} from '../shared/contracts/lucy-says.js';
import type { Actor } from './auth.js';

/** What happened to a task. */
export type LucyTaskEventKind = 'failed' | 'lost_contact' | 'stalled' | 'wants_review';

export interface LucyTaskEvent {
  taskId: string;
  taskName?: string;
  kind: LucyTaskEventKind;
}

/** The finding that makes a task "gone quiet" or "lost contact"; undefined for every other finding. */
export function taskEventForFinding(anomalyType: string): LucyTaskEventKind | undefined {
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
 * failed (not resumed), still waiting for its review, or still has the finding on one of its
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
  if (event.kind === 'wants_review') return task.pendingSignal?.kind === 'completion_ready';
  const wanted = event.kind === 'stalled' ? 'stale_agent' : 'hook_disconnected';
  return task.sessions.some((session) => findingOf(session.tmuxSession) === wanted);
}

export interface LucySaysNotifierDeps {
  /** Send the line to the owner's open dashboards. Returns how many it reached. Must not throw. */
  push: (message: LucySaysMessage) => number;
  /** True for a task Lucy launched herself; its events are left to the launch controller. */
  isOwnLaunch?: (taskId: string) => boolean;
  /** Asked when a window closes: is this still true of the task? Absent means yes. */
  stillTrue?: (event: LucyTaskEvent) => boolean;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The order kinds are told in a grouped line: the worst news first. */
const KIND_ORDER: readonly LucyTaskEventKind[] = ['failed', 'lost_contact', 'stalled', 'wants_review'];
const WIRE_KIND: Record<LucyTaskEventKind, LucySaysKind> = {
  failed: 'task_failed',
  lost_contact: 'task_lost_contact',
  stalled: 'task_stalled',
  wants_review: 'task_wants_review',
};
/** At most this many tasks are named in a grouped line; the others are counted. */
const MAX_NAMED = 3;
/** Remembered "said about this task" times; older ones are forgotten first. */
const MAX_REMEMBERED = 500;

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The sentence for one event. */
export function singleEventSentence(event: Pick<LucyTaskEvent, 'taskName' | 'kind'>): string {
  const name = sayableTaskName(event.taskName);
  switch (event.kind) {
    case 'failed':
      return `${name ?? 'A task'} failed.`;
    case 'stalled':
      return `${name ?? 'A task'} has gone quiet.`;
    case 'lost_contact':
      return `Kookr lost contact with ${name ?? 'a task'}.`;
    case 'wants_review':
      return `${name ?? 'A task'} says it is finished and wants your review.`;
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
    if (this.windowOpen) {
      if (!this.waiting.some((other) => keyOf(other) === key)) this.waiting.push(event);
      return;
    }
    this.write([event], { text: singleEventSentence(event), kind: WIRE_KIND[event.kind], taskIds: [event.taskId] });
  }

  /** Stop the window timer (shutdown, tests). Events still waiting are dropped. */
  dispose(): void {
    if (this.windowTimer !== undefined) this.clearTimer(this.windowTimer);
    this.windowTimer = undefined;
    this.windowOpen = false;
    this.waiting = [];
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
