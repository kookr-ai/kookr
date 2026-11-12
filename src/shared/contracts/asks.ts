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

export interface AskRecord {
  /** 12 hex chars — short enough to fit Telegram's 64-byte callback_data. */
  id: string;
  taskId: string;
  question: string;
  context?: string;
  options: string[];
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
  /** Outcome of typing the answer into the asking task's session. */
  taskDelivery?: 'delivered' | 'failed' | 'skipped';
}

/** The record as returned over HTTP: the nonce is server-internal. */
export type AskView = Omit<AskRecord, 'nonce'>;

/** Hard limits, enforced server-side (the CLI mirrors the shape, not the numbers). */
export const ASK_LIMITS = {
  maxOptions: 4,
  maxLabelChars: 48,
  maxQuestionChars: 600,
  maxContextChars: 1500,
  maxPendingPerTask: 3,
  maxPerTaskPerHour: 6,
  maxGlobalPerHour: 20,
  defaultTimeoutSec: 30 * 60,
  minTimeoutSec: 30,
  maxTimeoutSec: 24 * 60 * 60,
  maxIdempotencyKeyChars: 128,
  /** Terminal asks are kept this long for `--wait` pollers and audit, then pruned. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface CreateAskInput {
  taskId: string;
  question: string;
  context?: string;
  options: string[];
  allowText?: boolean;
  timeoutSec?: number;
  idempotencyKey?: string;
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
  | 'task_gone';

export type AnswerResult =
  | { ok: true; ask: AskRecord }
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
  question: string;
  context?: string;
  options: string[];
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
/** Most asks sent to the dashboard at once (newest first). Pending asks are never cut; closed ones fill the rest. */
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
  /** Edit the original message to its final state (keyboard removed). */
  finalizeAsk(ask: AskRecord, text: string): Promise<void>;
}
