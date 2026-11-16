/**
 * Contract for `kookr ask`: an agent asks the operator a multiple-choice
 * question and the answer is routed back to the asking task. The question goes
 * out on Telegram and, when the dashboard is open, Lucy (the avatar panel) asks
 * it too. Both channels read and write the same record, so an answer given on
 * one closes the question on the other. See docs/rfc/rfc-kookr-ask.md.
 */

export type AskState = 'pending' | 'answered' | 'expired' | 'cancelled';

/** Why an ask reached its current state (more specific than `state`). */
export type AskResolution = 'answered' | 'expired' | 'cancelled' | 'task_gone' | 'delivery_failed';

/** Where the operator answered: the Telegram chat, or Lucy's panel in the dashboard. */
export type AskChannel = 'telegram' | 'dashboard';

export type AskAnswer =
  | { kind: 'option'; index: number; label: string }
  | { kind: 'text'; text: string };

/**
 * A page the question is about (a mockup, a write-up, a pull request). The dashboard card shows it as
 * a button that opens a new tab and Telegram as a URL button, so the operator never has to copy a URL
 * out of the question text. Lucy does not read it aloud.
 */
export interface AskLink {
  /** An `https://` URL, at most {@link ASK_LIMITS.maxLinkUrlChars} characters. */
  url: string;
  /** The button text, e.g. "Open mockups". Absent: "Open link". */
  label?: string;
}

/** The button text for a link that has no label. */
export const DEFAULT_ASK_LINK_LABEL = 'Open link';

export interface AskRecord {
  /** 12 hex chars — short enough to fit Telegram's 64-byte callback_data. */
  id: string;
  taskId: string;
  question: string;
  context?: string;
  options: string[];
  /** Pages to open from the question (`kookr ask --link`). Absent on asks without links and on older records. */
  links?: AskLink[];
  /** Whether a free-text reply to the Telegram message counts as an answer. */
  allowText: boolean;
  state: AskState;
  createdAt: number;
  expiresAt: number;
  /** Per-ask random value mixed into the callback HMAC. Never sent to Telegram or the API. */
  nonce: string;
  idempotencyKey?: string;
  /** The Telegram message carrying the buttons. */
  delivery?: { chatId: number; messageId: number };
  answer?: AskAnswer;
  answeredAt?: number;
  /** Telegram user id of the operator who answered. Absent for an answer given in the dashboard. */
  answeredBy?: number;
  /** The channel the answer came from. Absent on asks answered before this field existed (all Telegram). */
  answeredVia?: AskChannel;
  /** When the ask left `pending`, whatever the reason. Absent on older records. */
  resolvedAt?: number;
  resolution?: AskResolution;
  /**
   * The task's live session when the ask was created (its `tmuxSession` id). The answer and the
   * expiry notice are typed only while this session, or one that resumed its conversation, is live:
   * a relaunched task's fresh session never saw the question. Absent on older records and when the
   * task had no live session at ask time; those are delivered to whatever session is live.
   */
  sessionId?: string;
  /**
   * Outcome of typing the answer into the asking task's session. `delivered`: typed in, or read by
   * the task's own `kookr ask --wait`, in which case it is not typed as well. `skipped`: the answer is
   * recorded but nothing was typed, because the task had ended or was relaunched in a fresh session
   * by then. Absent for up to `ASK_WAIT_FALLBACK_MS` while an answer waits for an attached `--wait` poll.
   */
  taskDelivery?: 'delivered' | 'failed' | 'skipped';
  /**
   * Reminders sent while the question waited (issue #3929), oldest first. Stored with the question so
   * a restart never repeats one. `at` is written before the message is sent; `messageId` is added once
   * Telegram accepted it, so a text reply to the reminder answers the question too.
   */
  reminders?: AskReminderSent[];
}

export interface AskReminderSent {
  at: number;
  /** `before_close`: the one reminder shortly before the question closes. Absent: a reminder of the schedule. */
  kind?: 'before_close';
  messageId?: number;
}

/**
 * When an unanswered question is brought back to the operator's attention on Telegram (the
 * `askReminders` setting). Each reminder is a reply to the question's message. Reminders are held
 * back during quiet hours and at most one is sent when they end.
 */
export interface AskReminderSchedule {
  /** Minutes after the question was sent, ascending (default 10 and 60). Empty: no reminders at all. */
  afterMinutes: number[];
  /** After the last of `afterMinutes`, one more every this many minutes (default 240). 0: no repeat. */
  thenEveryMinutes: number;
  /** One last reminder this many minutes before the question closes (default 10). 0: none. */
  beforeCloseMinutes: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_ASK_REMINDERS: AskReminderSchedule = { afterMinutes: [10, 60], thenEveryMinutes: 240, beforeCloseMinutes: 10 };

/**
 * Hard bounds on reminders, whatever the setting says, so a question left open for days, or many
 * questions at once, cannot flood the operator's phone.
 */
export const ASK_REMINDER_LIMITS = {
  /** Reminders of the schedule per question. The one before it closes comes on top. */
  maxPerQuestion: 6,
  /** Two reminders for the same question are at least this far apart. */
  minGapMinutes: 10,
  /** Reminders for all questions together, per rolling hour. The rest wait for a later sweep. */
  maxPerHour: 6,
  maxAfterEntries: 6,
  /** Smallest `thenEveryMinutes` other than 0. */
  minEveryMinutes: 30,
  /** Largest value of any field: seven days, the longest a question can stay open. */
  maxMinutes: 7 * 24 * 60,
} as const;

/** Normalise a raw `askReminders` setting. Never throws: bad parts fall back to the default, with a warning. */
export function validateAskReminders(raw: unknown): { schedule: AskReminderSchedule; warnings: string[] } {
  if (raw === undefined) return { schedule: { ...DEFAULT_ASK_REMINDERS, afterMinutes: [...DEFAULT_ASK_REMINDERS.afterMinutes] }, warnings: [] };
  const warnings: string[] = [];
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!obj) warnings.push('askReminders must be an object; using the default schedule');
  const max = ASK_REMINDER_LIMITS.maxMinutes;
  const isMinutes = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

  let afterMinutes = [...DEFAULT_ASK_REMINDERS.afterMinutes];
  if (obj && obj.afterMinutes !== undefined) {
    if (Array.isArray(obj.afterMinutes) && obj.afterMinutes.every((v) => isMinutes(v, 1))) {
      afterMinutes = [...new Set(obj.afterMinutes as number[])].sort((a, b) => a - b);
      if (afterMinutes.length > ASK_REMINDER_LIMITS.maxAfterEntries) {
        warnings.push(`askReminders.afterMinutes keeps its first ${ASK_REMINDER_LIMITS.maxAfterEntries} entries`);
        afterMinutes = afterMinutes.slice(0, ASK_REMINDER_LIMITS.maxAfterEntries);
      }
    } else {
      warnings.push(`askReminders.afterMinutes must be a list of whole minutes 1..${max}; using the default`);
    }
  }
  let thenEveryMinutes = DEFAULT_ASK_REMINDERS.thenEveryMinutes;
  if (obj && obj.thenEveryMinutes !== undefined) {
    if (obj.thenEveryMinutes === 0 || isMinutes(obj.thenEveryMinutes, ASK_REMINDER_LIMITS.minEveryMinutes)) {
      thenEveryMinutes = obj.thenEveryMinutes as number;
    } else {
      warnings.push(`askReminders.thenEveryMinutes must be 0 or ${ASK_REMINDER_LIMITS.minEveryMinutes}..${max}; using the default`);
    }
  }
  let beforeCloseMinutes = DEFAULT_ASK_REMINDERS.beforeCloseMinutes;
  if (obj && obj.beforeCloseMinutes !== undefined) {
    if (obj.beforeCloseMinutes === 0 || isMinutes(obj.beforeCloseMinutes, 1)) {
      beforeCloseMinutes = obj.beforeCloseMinutes as number;
    } else {
      warnings.push(`askReminders.beforeCloseMinutes must be 0..${max}; using the default`);
    }
  }
  return { schedule: { afterMinutes, thenEveryMinutes, beforeCloseMinutes }, warnings };
}

/**
 * Which reminder, if any, a pending question is owed at `now`. Several points of the schedule that
 * passed unsent (quiet hours, a restart, the hourly bound) are owed as one reminder, never a burst:
 * the next reminder is owed only for a point later than the last one sent.
 */
export function askReminderDue(
  ask: Pick<AskRecord, 'createdAt' | 'expiresAt' | 'reminders'>,
  schedule: AskReminderSchedule,
  now: number,
): 'schedule' | 'before_close' | undefined {
  if (schedule.afterMinutes.length === 0 || now >= ask.expiresAt) return undefined;
  const sent = ask.reminders ?? [];
  const last = sent.length > 0 ? sent[sent.length - 1].at : ask.createdAt;
  if (sent.length > 0 && now - last < ASK_REMINDER_LIMITS.minGapMinutes * MINUTE_MS) return undefined;

  if (schedule.beforeCloseMinutes > 0 && !sent.some((r) => r.kind === 'before_close')) {
    const point = ask.expiresAt - schedule.beforeCloseMinutes * MINUTE_MS;
    // `last` is never before `createdAt`, so this also skips a question shorter than `beforeCloseMinutes`.
    if (now >= point && point > last) return 'before_close';
  }

  if (sent.filter((r) => r.kind === undefined).length >= ASK_REMINDER_LIMITS.maxPerQuestion) return undefined;
  const points = schedule.afterMinutes.map((m) => ask.createdAt + m * MINUTE_MS);
  let latest: number | undefined;
  for (const p of points) if (p <= now) latest = p;
  const lastPoint = points[points.length - 1];
  if (schedule.thenEveryMinutes > 0 && now >= lastPoint) {
    const every = schedule.thenEveryMinutes * MINUTE_MS;
    latest = lastPoint + Math.floor((now - lastPoint) / every) * every;
  }
  return latest !== undefined && latest > last ? 'schedule' : undefined;
}

/** The record as returned over HTTP: the nonce is server-internal. */
export type AskView = Omit<AskRecord, 'nonce'>;

/**
 * How often `kookr ask --wait` polls `GET /api/asks/:id?wait=1`. The server counts a waiter as attached
 * for a few of these intervals after its last poll, so the answer is printed by the CLI rather than also typed.
 */
export const ASK_WAIT_POLL_INTERVAL_MS = 2_000;

/** Hard limits, enforced server-side. The CLI also checks the timeout bounds, so a bad `--timeout` exits 2 without a request. */
export const ASK_LIMITS = {
  maxOptions: 4,
  maxLabelChars: 48,
  maxQuestionChars: 600,
  maxContextChars: 1500,
  /** Open asks per task with a timeout of at most {@link ASK_LIMITS.longLivedAfterSec}: someone is usually waiting on these. */
  maxPendingPerTask: 3,
  /**
   * Open asks per task with a longer timeout, counted separately (issue #3966). A task that asks for an
   * opinion without waiting leaves the question open for a day or more; counted with the short ones,
   * three of them would refuse every later question from that task for days.
   */
  maxLongLivedPendingPerTask: 10,
  /** An ask whose timeout is longer than this (two hours) is long-lived. */
  longLivedAfterSec: 2 * 60 * 60,
  maxPerTaskPerHour: 6,
  maxGlobalPerHour: 20,
  defaultTimeoutSec: 30 * 60,
  minTimeoutSec: 30,
  /** Seven days: a task that asks for an opinion carries on, and the operator may answer days later. */
  maxTimeoutSec: 7 * 24 * 60 * 60,
  maxIdempotencyKeyChars: 128,
  /** Links per question (`--link`). */
  maxLinks: 2,
  maxLinkUrlChars: 500,
  maxLinkLabelChars: 40,
  /** Longest free-text answer, on either channel. */
  maxAnswerTextChars: 1000,
  /** Terminal asks are kept this long for `--wait` pollers and audit, then pruned. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface CreateAskInput {
  taskId: string;
  question: string;
  context?: string;
  options: string[];
  links?: AskLink[];
  allowText?: boolean;
  timeoutSec?: number;
  idempotencyKey?: string;
}

/**
 * Why a link cannot be sent with a question, or undefined when it can. Shared by the CLI (which exits 2
 * before any request) and the server (which refuses the request), so both say the same thing.
 */
export function askLinkProblem(link: AskLink): string | undefined {
  const { url, label } = link;
  if (url.length === 0 || url.length > ASK_LIMITS.maxLinkUrlChars) {
    return `a link must be 1..${ASK_LIMITS.maxLinkUrlChars} characters`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `a link must be an https:// URL (got: ${url.slice(0, 80)})`;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') return `a link must be an https:// URL (got: ${url.slice(0, 80)})`;
  if (parsed.username !== '' || parsed.password !== '') return 'a link must not carry a user name or password';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'a link must not contain spaces or control characters';
  if (label !== undefined) {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > ASK_LIMITS.maxLinkLabelChars || /[\r\n]/.test(label)) {
      return `a link label must be a single line of 1..${ASK_LIMITS.maxLinkLabelChars} characters`;
    }
  }
  return undefined;
}

export type CreateAskError =
  | { code: 'not_configured' }
  | { code: 'unknown_task' | 'terminal_task' }
  | { code: 'invalid'; message: string }
  | { code: 'redacted_option' }
  | { code: 'rate_limited'; scope: 'task_pending' | 'task_hourly' | 'global_hourly' }
  | { code: 'delivery_failed'; message: string };

export type CreateAskResult =
  | { ok: true; ask: AskRecord; deduped: boolean; redacted: Array<'question' | 'context'> }
  | { ok: false; error: CreateAskError };

export type AnswerRejection =
  | 'not_found'
  | 'forged'
  | 'already_answered'
  | 'expired'
  | 'cancelled'
  | 'wrong_chat'
  | 'bad_option'
  | 'text_not_allowed'
  /** No longer produced: an answer after the task ended is recorded (`taskDelivery: 'skipped'`). Kept for older servers. */
  | 'task_gone';

export type AnswerResult =
  /** `notTyped`: set when the answer was recorded but not typed into the task (`taskDelivery: 'skipped'`), saying why in one sentence. */
  | { ok: true; ask: AskRecord; notTyped?: string }
  | { ok: false; reason: AnswerRejection; ask?: AskRecord };

/** Input for recording an operator answer that arrived over Telegram. */
export interface AnswerInput {
  askId: string;
  senderId: number;
  chatId: number;
  messageId: number;
  /** Exactly one of the two: a button tap (with its MAC) or a free-text reply. */
  option?: { index: number; mac: string };
  text?: string;
}

/** Input for recording an operator answer given in the dashboard (Lucy's panel). Exactly one of the two. */
export interface DashboardAnswerInput {
  askId: string;
  optionIndex?: number;
  text?: string;
}

/**
 * A question as the dashboard shows it: no Telegram coordinates, no nonce, plus
 * the short task name Lucy uses. Every pending ask and the ones resolved in the last
 * few minutes are sent together, so a reload or a reconnect ends up with the
 * same list as a tab that saw every change.
 */
export interface OperatorAskView {
  id: string;
  taskId: string;
  /** Short, redacted task title for display; absent when the task has no usable title. */
  taskName?: string;
  /**
   * True when the task that asked has ended (completed, terminated or cancelled) or no longer exists:
   * nothing is waiting on the answer. Absent from older servers, which is read as "a task may be waiting".
   */
  taskEnded?: boolean;
  question: string;
  context?: string;
  options: string[];
  links?: AskLink[];
  allowText: boolean;
  state: AskState;
  createdAt: number;
  expiresAt: number;
  answer?: AskAnswer;
  answeredVia?: AskChannel;
  /** When it closed. Always present on a closed ask (the server works it out for older records). */
  resolvedAt?: number;
  resolution?: AskResolution;
  /** Whether the answer could be typed into the task's session; `failed` is shown on the card. */
  taskDelivery?: AskRecord['taskDelivery'];
}

/** How long a resolved ask stays in the dashboard list, so "answered on Telegram" can be seen. */
export const OPERATOR_ASK_RESOLVED_VISIBLE_MS = 10 * 60 * 1000;
/** Most closed asks sent to the dashboard at once (the most recently closed). Pending asks are all sent. */
export const OPERATOR_ASK_MAX_LISTED = 8;

/**
 * A change the ask service announces to listeners: a question was sent (`created`), one left `pending`
 * (`resolved`), or a closed one learned whether its answer reached the task (`updated`).
 */
export interface AskChange {
  kind: 'created' | 'resolved' | 'updated';
  ask: AskRecord;
}

/**
 * What the ask service offers the Telegram integration: record an answer, and
 * recognise which ask a Telegram message belongs to. Plain functions only, so
 * `src/integrations` never imports server internals.
 */
export interface AskAnswerPort {
  answer(input: AnswerInput): Promise<AnswerResult>;
  /** The ask whose Telegram message is (chatId, messageId), in any state. */
  findByMessage(chatId: number, messageId: number): Pick<AskRecord, 'id' | 'state' | 'answeredVia'> | undefined;
}

/**
 * What the Telegram integration implements for the ask service. Kept free of
 * Telegram types so the service never imports from `src/integrations`.
 */
export interface AskNotifier {
  /** Post the question with buttons; resolves with the message coordinates. */
  sendAsk(ask: AskRecord, callbackData: (optionIndex: number) => string): Promise<{ chatId: number; messageId: number }>;
  /** Edit the original message to its final state (keyboard removed), and delete its reminders. */
  finalizeAsk(ask: AskRecord, text: string): Promise<void>;
  /** Send `text` as a reply to the question's message; resolves with the reminder's message id. */
  sendAskReminder?(ask: AskRecord, text: string): Promise<{ messageId: number }>;
  /** Delete one reminder message. Best effort: never throws. */
  deleteAskReminder?(ask: AskRecord, messageId: number): Promise<void>;
}
