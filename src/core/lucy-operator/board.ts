/**
 * The board: the compact picture of the operator's work that Lucy reads before she
 * answers, and the way she points at one task when she looks something up.
 *
 * Two rules shape it:
 *
 * 1. She must be able to name a task aloud. Each task gets the short name that the
 *    spoken summaries already use; a long, cut-off or unpronounceable title becomes a
 *    description ("an unnamed task in kookr") instead.
 * 2. She must be able to point at a task without saying an id. Each task also gets a
 *    short code in square brackets, derived from its id, that only her tools read.
 *    The prompt tells her never to say it.
 *
 * Every string that came from a task goes through the same secret redaction as the
 * spoken summaries, because this text is sent to a model provider outside the machine.
 */

import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import { isGenericTaskName, spokenTaskName } from '../spoken-task-name.js';
import { redactedTaskName } from '../task-speech-summary.js';
import { cleanTaskText } from './task-text.js';

type TimeValue = Date | string | number;

/** The task fields the board reads. The server maps its full task record onto this. */
export interface LucyBoardTask {
  id: string;
  name?: string;
  status: TaskStatus;
  updatedAt: TimeValue;
  finishedAt?: TimeValue;
  terminatedAt?: TimeValue;
  terminationReason?: string;
  /** Display name of the project the task works in. */
  project?: string;
  /** What the task has cost so far, in US dollars. */
  costUsd?: number;
  /** Why the task is waiting on the operator, as a short phrase Kookr produced; absent when it is not. */
  attention?: string;
}

export interface LucyQuotaWindow {
  /** Share of the quota used, 0 to 100. */
  utilization: number;
  resetsAt: string;
}

export interface LucyBoardInput {
  tasks: readonly LucyBoardTask[];
  /** All-time agent spend recorded by this Kookr server, in US dollars; null when unknown. */
  lifetimeSpendUsd: number | null;
  quota: { fiveHour: LucyQuotaWindow | null; sevenDay: LucyQuotaWindow | null } | null;
}

/** Longest board, in characters. The task lists are cut to fit; the totals, spend and quota never are. */
export const MAX_BOARD_CHARS = 8000;
export const MAX_BOARD_NEEDS_YOU = 12;
export const MAX_BOARD_WORKING = 15;
export const MAX_BOARD_FINISHED = 6;
const MIN_HANDLE_CHARS = 4;

const STATUS_WORDS: Record<TaskStatus, string> = {
  open: 'open',
  pending: 'pending',
  inProgress: 'working',
  completed: 'completed',
  terminated: 'stopped',
  cancelled: 'cancelled',
};

function toMs(value: TimeValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function agoWords(thenMs: number | undefined, nowMs: number): string {
  if (thenMs === undefined) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * One line of text with terminal codes removed and secrets hidden, safe to place in a
 * prompt. The cleaning is the same as for a task's request (`cleanTaskText`), so a token
 * that a colour code stands next to in a task name is hidden here too.
 */
export function boardText(value: string | undefined, max = 80): string {
  const flat = cleanTaskText(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The short code that stands for each task in tool calls: the first few letters and
 * digits of its id, made longer only where two tasks would otherwise share one. It
 * depends on the id alone (plus collisions), so a task keeps its code from one turn to
 * the next.
 */
export function taskHandles(tasks: readonly { id: string }[]): Map<string, string> {
  const ids = [...new Set(tasks.map((task) => task.id))];
  const keys = ids.map((id) => id.toLowerCase().replace(/[^a-z0-9]/g, '') || 'task');
  const lengths = ids.map(() => MIN_HANDLE_CHARS);
  const current = (): string[] => keys.map((key, index) => key.slice(0, lengths[index]));
  const countOf = (handles: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const handle of handles) counts.set(handle, (counts.get(handle) ?? 0) + 1);
    return counts;
  };
  // Lengthen only the codes that clash, one character at a time, until none clash or none can grow.
  for (;;) {
    const handles = current();
    const counts = countOf(handles);
    let grew = false;
    handles.forEach((handle, index) => {
      if ((counts.get(handle) ?? 0) > 1 && lengths[index]! < keys[index]!.length) {
        lengths[index]! += 1;
        grew = true;
      }
    });
    if (!grew) break;
  }
  // Ids that differ only in punctuation still clash at full length: number them.
  const handles = current();
  const counts = countOf(handles);
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  ids.forEach((id, index) => {
    const handle = handles[index]!;
    if ((counts.get(handle) ?? 0) > 1) {
      const n = (seen.get(handle) ?? 0) + 1;
      seen.set(handle, n);
      result.set(id, `${handle}x${n}`);
    } else {
      result.set(id, handle);
    }
  });
  return result;
}

/** The task's title as it may be said aloud, or the generic name when it may not. Cleaned like everything else on the board. */
function spokenNameOf(name: string | undefined): string {
  return spokenTaskName(redactedTaskName(name === undefined ? undefined : cleanTaskText(name)));
}

/** How she may call the task aloud: its short name in quotes, or a description when it has none. */
export function spokenLabel(task: Pick<LucyBoardTask, 'name' | 'project'>): string {
  const spoken = spokenNameOf(task.name);
  if (!isGenericTaskName(spoken)) return `"${spoken}"`;
  const project = boardText(task.project, 40);
  return project ? `an unnamed task in ${project}` : 'an unnamed task';
}

function taskLine(task: LucyBoardTask, handle: string, nowMs: number, when: 'updated' | 'ended'): string {
  const parts: string[] = [`[${handle}] ${spokenLabel(task)}`];
  const project = boardText(task.project, 40);
  if (project) parts.push(`project ${project}`);
  if (when === 'ended') {
    const reason = task.status === 'terminated' && task.terminationReason ? ` (${boardText(task.terminationReason, 60)})` : '';
    const at = toMs(task.finishedAt) ?? toMs(task.terminatedAt) ?? toMs(task.updatedAt);
    parts.push(`${STATUS_WORDS[task.status]}${reason} ${agoWords(at, nowMs)}`);
  } else {
    parts.push(STATUS_WORDS[task.status], `last change ${agoWords(toMs(task.updatedAt), nowMs)}`);
  }
  if (task.attention) parts.push(`waiting on the operator: ${boardText(task.attention, 60)}`);
  if (typeof task.costUsd === 'number' && task.costUsd > 0) parts.push(`spent ${dollars(task.costUsd)}`);
  return `- ${parts.join(' · ')}`;
}

function quotaLine(label: string, window: LucyQuotaWindow | null): string | null {
  if (!window || !Number.isFinite(window.utilization)) return null;
  return `${label} quota: ${Math.round(window.utilization)} percent used`;
}

/**
 * The board as plain text: the totals, spend and quota, then what needs the operator,
 * what is working and what just finished. Lists are capped; a cap is always stated, so
 * she never takes a cut list for the whole picture.
 *
 * Spend and quota come first and are never cut: when the board is too long it is the
 * task lists, from the end, that give way.
 */
export function buildLucyBoard(input: LucyBoardInput, nowMs: number, maxChars: number = MAX_BOARD_CHARS): string {
  const handles = taskHandles(input.tasks);
  const handleOf = (task: LucyBoardTask): string => handles.get(task.id) ?? task.id;
  const byRecency = (a: LucyBoardTask, b: LucyBoardTask): number => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0);

  const needsYou = input.tasks.filter((t) => t.attention && !isTerminalStatus(t.status)).sort(byRecency);
  const working = input.tasks.filter((t) => !t.attention && !isTerminalStatus(t.status)).sort(byRecency);
  const finished = input.tasks
    .filter((t) => isTerminalStatus(t.status))
    .sort((a, b) => (toMs(b.finishedAt) ?? toMs(b.terminatedAt) ?? toMs(b.updatedAt) ?? 0) - (toMs(a.finishedAt) ?? toMs(a.terminatedAt) ?? toMs(a.updatedAt) ?? 0));

  const head: string[] = [input.tasks.length === 0 ? 'There are no tasks at all.' : `Tasks in total: ${input.tasks.length}.`];
  head.push('', 'Spend and quota:');
  head.push(
    input.lifetimeSpendUsd !== null && Number.isFinite(input.lifetimeSpendUsd)
      ? `- All-time agent spend recorded by Kookr: ${dollars(input.lifetimeSpendUsd)}`
      : '- All-time agent spend: not available',
  );
  head.push('- Spend over the last 24 hours: not available here');
  const quotaLines = [quotaLine('5-hour', input.quota?.fiveHour ?? null), quotaLine('7-day', input.quota?.sevenDay ?? null)].filter(
    (line): line is string => line !== null,
  );
  head.push(...(quotaLines.length > 0 ? quotaLines.map((line) => `- ${line}`) : ['- Quota: not available']));

  const lines: string[] = [];
  const section = (title: string, tasks: readonly LucyBoardTask[], max: number, when: 'updated' | 'ended', total = tasks.length): void => {
    lines.push('', tasks.length === 0 ? `${title}: none.` : `${title} (${total}):`);
    for (const task of tasks.slice(0, max)) lines.push(taskLine(task, handleOf(task), nowMs, when));
    if (total > max) lines.push(`- and ${total - Math.min(max, tasks.length)} more not listed`);
  };

  section('Needs the operator', needsYou, MAX_BOARD_NEEDS_YOU, 'updated');
  section('Working', working, MAX_BOARD_WORKING, 'updated');
  section('Most recently finished', finished, MAX_BOARD_FINISHED, 'ended');

  const headText = head.join('\n');
  return `${headText}\n${capLines(lines, Math.max(0, maxChars - headText.length - 1))}`.trim();
}

/** Join lines, dropping whole trailing lines rather than cutting one in half. */
function capLines(lines: readonly string[], max: number): string {
  const joined = lines.join('\n');
  if (joined.length <= max) return joined;
  // Too long: keep whole lines from the top, leaving room for the line that says so.
  const cutLine = '(task lists cut short: the board was too long)';
  const kept: string[] = [];
  let length = cutLine.length;
  for (const line of lines) {
    if (length + line.length + 1 > max) break;
    kept.push(line);
    length += line.length + 1;
  }
  kept.push(cutLine);
  return kept.join('\n');
}

export type TaskRefResult<T> = { ok: true; task: T } | { ok: false; message: string };

/**
 * Find the task a tool call points at. The model is told to pass the bracket code, but
 * it may pass the name it read on the board instead, so both are accepted:
 * the code (with or without brackets), the full id, or a spoken name that exactly one
 * task has. Anything else comes back as a sentence the model can act on.
 */
export function resolveTaskRef<T extends LucyBoardTask>(ref: unknown, tasks: readonly T[]): TaskRefResult<T> {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, message: 'No task was given. Pass the code shown in square brackets on the board.' };
  const wanted = ref.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim().toLowerCase();
  if (!wanted) return { ok: false, message: 'No task was given. Pass the code shown in square brackets on the board.' };

  const handles = taskHandles(tasks);
  const byCode = tasks.filter((t) => handles.get(t.id) === wanted || t.id.toLowerCase() === wanted);
  if (byCode.length === 1) return { ok: true, task: byCode[0]! };

  const byName = tasks.filter((t) => {
    const spoken = spokenNameOf(t.name);
    return !isGenericTaskName(spoken) && spoken.toLowerCase() === wanted;
  });
  if (byName.length === 1) return { ok: true, task: byName[0]! };
  if (byName.length > 1) {
    const codes = byName.slice(0, 5).map((t) => `[${handles.get(t.id)}]`).join(', ');
    return { ok: false, message: `${byName.length} tasks have that name (${codes}). Ask the operator which one they mean.` };
  }
  return { ok: false, message: 'No task matches that. Read the board again and pass the code shown in square brackets.' };
}
