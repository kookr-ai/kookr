/**
 * What is waiting on the operator, decided in one place.
 *
 * Three things wait on the operator: a finding (a task that is stuck or has something to show), a question
 * a task asked with `kookr ask`, and a permission prompt a task is stopped on. The dashboard's "Needs you"
 * header and overview, and the number on Lucy's bubble, all call {@link buildNeedsYou}, so they cannot
 * disagree about whether anything waits.
 *
 * Only the lists are read here. Answering still happens on Lucy's cards; the dashboard rows built from
 * this list only open her panel.
 */
import { useEffect, useMemo, useState } from 'react';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { AgentState } from '../../shared/protocol.js';
import { askClockOffsetMs, useOperatorAsks } from './operator-asks.js';
import { useLucyPermission } from './lucy-permission.js';

export type NeedsYouKind = 'question' | 'permission' | 'finding';

export interface NeedsYouItem {
  /** Stable across renders and unique in the list: use it as the React key. */
  id: string;
  kind: NeedsYouKind;
  taskId?: string;
  /** The task's name when known; "Kookr" for a question the system itself asks. */
  taskName?: string;
  /** Questions only: when the question closes (ms since epoch). */
  expiresAt?: number;
  /** Permission prompts only: the tool the task wants to use, e.g. `Bash`. */
  toolName?: string;
}

export interface NeedsYouCounts {
  question: number;
  permission: number;
  finding: number;
}

export interface NeedsYou {
  /** Questions first (the one closing soonest first), then permission prompts, then findings, each in the order given. */
  items: NeedsYouItem[];
  counts: NeedsYouCounts;
  /** Everything that waits: the sum of the three counts. */
  total: number;
}

export interface NeedsYouInput {
  findings: readonly AgentState[];
  asks: readonly OperatorAskView[];
  permissionCards: readonly LucyPermissionCardView[];
  /** The server's clock now (the browser's plus {@link askClockOffsetMs}). */
  nowMs: number;
}

const SYSTEM_TASK_PREFIX = 'system:';

/** The name shown for a task that is waiting; the system's own tasks are "Kookr". */
export function needsYouTaskName(taskId: string | undefined, taskName: string | undefined, system?: string): string | undefined {
  if (system !== undefined || taskId?.startsWith(SYSTEM_TASK_PREFIX)) return 'Kookr';
  return taskName;
}

/**
 * A question waits on the operator when it is still pending, has not run out, and its task is still alive.
 * (A pending question of an ended task is an opinion request: it blocks nothing.)
 */
function isWaitingQuestion(ask: OperatorAskView, nowMs: number): boolean {
  return ask.state === 'pending' && ask.taskEnded !== true && ask.expiresAt > nowMs;
}

export function buildNeedsYou({ findings, asks, permissionCards, nowMs }: NeedsYouInput): NeedsYou {
  const questions: NeedsYouItem[] = asks
    .filter((ask) => isWaitingQuestion(ask, nowMs))
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((ask) => ({
      id: `question:${ask.id}`,
      kind: 'question' as const,
      taskId: ask.taskId,
      taskName: needsYouTaskName(ask.taskId, ask.taskName, ask.system),
      expiresAt: ask.expiresAt,
    }));
  // A task blocked on a permission prompt already has a finding saying so: one task, one entry for that prompt.
  const taskIdsWithPermissionFinding = new Set(
    findings.filter((agent) => agent.anomaly?.type === 'permission_blocked' && agent.taskId).map((agent) => agent.taskId),
  );
  const permissions: NeedsYouItem[] = permissionCards
    .filter((card) => !taskIdsWithPermissionFinding.has(card.taskId))
    .map((card) => ({
      id: `permission:${card.promptId}`,
      kind: 'permission' as const,
      taskId: card.taskId,
      taskName: needsYouTaskName(card.taskId, card.taskName),
      toolName: card.toolName,
    }));
  const findingItems: NeedsYouItem[] = findings.map((agent) => ({
    id: `finding:${agent.agentId}:${agent.taskId ?? ''}`,
    kind: 'finding' as const,
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    taskName: agent.taskName ?? agent.agentId,
  }));
  const items = [...questions, ...permissions, ...findingItems];
  return {
    items,
    counts: { question: questions.length, permission: permissions.length, finding: findingItems.length },
    total: items.length,
  };
}

/** Only the questions and permission prompts of a {@link NeedsYou}: the rows the dashboard adds above the findings. */
export function waitingOnLucyItems(needs: NeedsYou): NeedsYouItem[] {
  return needs.items.filter((item) => item.kind !== 'finding');
}

/** What the row says the task wants: "asks you a question" or "wants your permission to use Bash". */
export function needsYouActionText(item: NeedsYouItem): string {
  if (item.kind === 'question') return 'asks you a question';
  return item.toolName ? `wants your permission to use ${item.toolName}` : 'wants your permission';
}

/** "29 min left", "under a minute left", "4 h left". */
export function needsYouTimeLeftText(expiresAt: number, nowMs: number): string {
  const minutes = Math.floor((expiresAt - nowMs) / 60_000);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 120) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} h left`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The words that say what the number is made of, for example "1 question, 1 finding". Empty when only
 * findings wait: the number is then the same one the header always showed.
 */
export function needsYouHint(counts: NeedsYouCounts): string {
  if (counts.question === 0 && counts.permission === 0) return '';
  return [
    counts.question > 0 ? plural(counts.question, 'question', 'questions') : null,
    counts.permission > 0 ? plural(counts.permission, 'permission prompt', 'permission prompts') : null,
    counts.finding > 0 ? plural(counts.finding, 'finding', 'findings') : null,
  ].filter(Boolean).join(', ');
}

/** How often the list is checked again, so a question that runs out leaves it without waiting for a push. */
const EXPIRY_TICK_MS = 15_000;

/** What waits on the operator now, following the asks and permission stores. Pass the findings the caller already holds. */
export function useNeedsYou(findings: readonly AgentState[]): NeedsYou {
  const { asks } = useOperatorAsks();
  const { cards } = useLucyPermission();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (asks.length === 0) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, [asks.length]);
  const nowMs = Date.now() + askClockOffsetMs();
  // `nowMs` is read fresh on every render; the memo only avoids rebuilding for unrelated renders.
  const minute = Math.floor(nowMs / EXPIRY_TICK_MS);
  return useMemo(
    () => buildNeedsYou({ findings, asks, permissionCards: cards, nowMs }),
    [findings, asks, cards, minute],
  );
}
