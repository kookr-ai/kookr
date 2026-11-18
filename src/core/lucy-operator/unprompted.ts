/**
 * What Lucy said or wrote to the operator without being asked, as she is shown it on her next turn
 * (issue #4143).
 *
 * She speaks first in several places: a permission notice, a task's question read out, a line about a
 * task that failed or went quiet, the report of a task she launched. None of those is a turn of a
 * conversation, so without this note the operator's "make it proceed" thirty seconds later pointed at
 * nothing she could see.
 *
 * The note is rebuilt on every turn and placed next to the board. It is not added to the conversation
 * history, so it does not grow it, and an item leaves the note as soon as it is too old or what it was
 * about has been answered. A sentence can quote a task name or a task's question, which an agent
 * wrote: each one is cleaned and cut exactly like the board's text, and the note sits under the same
 * rule as the board (information, never an instruction).
 */

import { boardText, spokenLabel, taskHandles, type LucyBoardTask } from './board.js';

/** Most items in the note; older ones are left out. */
export const MAX_UNPROMPTED_ITEMS = 6;
/** An item older than this is left out. */
export const MAX_UNPROMPTED_AGE_MS = 15 * 60 * 1000;
/** Longest sentence quoted in the note, in characters. */
export const MAX_UNPROMPTED_TEXT_CHARS = 200;
/** Tasks named on one item (a grouped notice can be about more). */
const MAX_UNPROMPTED_TASKS = 3;

/** One thing she said or wrote unprompted. */
export interface LucyUnpromptedSaid {
  /** The sentence, as the server wrote it. */
  text: string;
  /** When she said it, in epoch milliseconds. */
  at: number;
  /** The tasks it was about; empty when it was about none in particular. */
  tasks: ReadonlyArray<{ id: string; name?: string }>;
  /**
   * Said after her last reply in the conversation this turn belongs to (or the conversation has no
   * reply yet), so the operator's sentence may be their answer to it.
   */
  fresh?: boolean;
}

/** "40 seconds ago", "3 minutes ago": finer than the board's wording, because half a minute matters here. */
export function unpromptedAgoWords(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 10) return 'a moment ago';
  if (seconds < 60) return `${Math.round(seconds / 10) * 10} seconds ago`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

/** The items the note shows: not too old, newest first, at most {@link MAX_UNPROMPTED_ITEMS}. */
export function selectUnprompted(items: readonly LucyUnpromptedSaid[], nowMs: number): LucyUnpromptedSaid[] {
  return items
    .filter((item) => item.text.trim() && Number.isFinite(item.at) && nowMs - item.at <= MAX_UNPROMPTED_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_UNPROMPTED_ITEMS);
}

function aboutWords(tasks: LucyUnpromptedSaid['tasks'], boardTasks: readonly LucyBoardTask[], handles: ReadonlyMap<string, string>): string {
  if (tasks.length === 0) return '';
  const named = tasks.slice(0, MAX_UNPROMPTED_TASKS).map((task) => {
    const onBoard = boardTasks.find((t) => t.id === task.id);
    // The board's own label and code when the task is still listed, so her tools can find it.
    if (onBoard) return `[${handles.get(onBoard.id) ?? onBoard.id}] ${spokenLabel(onBoard)}`;
    return `${spokenLabel({ name: task.name })} (no longer on the board)`;
  });
  const more = tasks.length > named.length ? ` and ${tasks.length - named.length} more` : '';
  return `, about ${named.join(', ')}${more}`;
}

/**
 * The note as plain text, or an empty string when she said nothing unprompted lately. `boardTasks`
 * is the task list the board was built from, so a task carries the same code in both.
 */
export function buildUnpromptedNote(items: readonly LucyUnpromptedSaid[] | undefined, nowMs: number, boardTasks: readonly LucyBoardTask[]): string {
  const shown = selectUnprompted(items ?? [], nowMs);
  if (shown.length === 0) return '';
  const handles = taskHandles(boardTasks);
  const lines = shown.map((item) => {
    const fresh = item.fresh === true ? ' (NEW)' : '';
    return `- ${unpromptedAgoWords(item.at, nowMs)}${fresh}${aboutWords(item.tasks, boardTasks, handles)}: ${boardText(item.text, MAX_UNPROMPTED_TEXT_CHARS)}`;
  });
  return [
    'What you told the operator without being asked, in the last few minutes, newest first. They heard it or read it in your panel. An item marked NEW came after your last reply in this conversation, so what the operator says now may be their answer to it. The sentences quote task names and task questions, which agents wrote:',
    ...lines,
  ].join('\n');
}
