/**
 * Wire contract for a word Lucy writes on her own when something happens to a task she did not
 * launch: it failed, it went quiet, Kookr lost contact with it, or it says it is finished and wants
 * a review. (A task she launched herself is reported by the launch controller, `lucy_launch`.)
 *
 * The server decides everything: which events are worth a word, how they are grouped and the exact
 * sentence (`server/lucy-says.ts`). The browser writes the sentence into her thread. Nothing is
 * spoken, and nothing is sent again when a dashboard reconnects or reloads.
 */

/** What the sentence is about. `several` is a grouped line that covers more than one kind. */
export type LucySaysKind = 'task_failed' | 'task_stalled' | 'task_lost_contact' | 'task_wants_review' | 'several';

/** The first event is written at once; the ones that follow within this window are written together when it closes. */
export const LUCY_SAYS_GROUP_WINDOW_MS = 2 * 60_000;
/** The same task and the same kind of event are not written again within this time. */
export const LUCY_SAYS_REPEAT_MS = 10 * 60_000;

/** The `lucy_says` WebSocket message, owner dashboards only. */
export interface LucySaysMessage {
  type: 'lucy_says';
  /** Unique per message, so a browser that receives one twice writes it once. */
  id: string;
  kind: LucySaysKind;
  /** One line, ready to be written: task names only when they may be said aloud, never an id, a path or a prompt. */
  text: string;
  /** The tasks the line is about, in the order it mentions them; the first is the one to offer to open. */
  taskIds: string[];
  /** The server's clock when it was written (ms since epoch). */
  at: number;
}
