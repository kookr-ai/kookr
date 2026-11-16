/**
 * The operator's inbox (issue #3931): one list of everything that waits on the
 * operator, across every project. The server builds it once
 * (`src/server/operator-inbox.ts`) and three surfaces show it: `GET
 * /api/operator/inbox`, `kookr brief` and `/brief` on Telegram.
 */

/** What kind of thing waits on the operator. */
export type OperatorInboxItemKind = 'permission' | 'question' | 'flagged' | 'review' | 'train';

/** Display and totals order of the kinds. */
export const OPERATOR_INBOX_KINDS: readonly OperatorInboxItemKind[] = [
  'permission',
  'question',
  'flagged',
  'review',
  'train',
];

export interface OperatorInboxItem {
  kind: OperatorInboxItemKind;
  /**
   * What it is, in plain words, built only from fixed phrases and the tool
   * name, so it never carries a command, an error message or a secret
   * ("wants permission to use Bash", "says it is finished and wants your review").
   */
  summary: string;
  /** When it started waiting (ISO). */
  since: string;
  /** How to answer it, in plain words. */
  howToAnswer: string;
  taskId?: string;
  taskName?: string;
  /** Project the task belongs to (its project id, else the last part of its directory). */
  project?: string;
  /** The task's working directory; Telegram uses it to tell which projects are enabled there. */
  cwd?: string;
  /** Dashboard path that opens the task (`/?task=<id>`); the surfaces prefix their base URL. */
  link?: string;
  /** permission: the tool the agent asked for. */
  toolName?: string;
  /** permission: the command, path or URL, secrets hidden. Never shown on Telegram. */
  command?: string;
  /** question: the `kookr ask` id. */
  askId?: string;
  /** question: the question text, secrets hidden. */
  question?: string;
  /** question: the answer buttons. */
  options?: string[];
  /** flagged: the finding type (`needs_input`, `repeated_error`, …). */
  findingType?: string;
  /** train: the halt reason code (`base-red`, …), or `stalled`. */
  trainState?: string;
}

export interface OperatorInbox {
  schema: 'kookr.operator-inbox.v1';
  generatedAt: string;
  /**
   * First line, the same on every surface: "5 waiting: 2 permission prompts,
   * 1 question, 1 review, train halted", or, when empty, "Nothing is waiting
   * on you. 8 tasks are working in 2 projects."
   */
  summary: string;
  totals: Record<OperatorInboxItemKind, number>;
  /** Oldest first. */
  items: OperatorInboxItem[];
  /** In-progress tasks and how many projects they span. */
  working: { tasks: number; projects: number };
}

/** "<1 min", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatInboxAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}
