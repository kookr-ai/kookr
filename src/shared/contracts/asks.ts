/**
 * Contract for `kookr ask`: an agent asks the operator a multiple-choice
 * question (delivered over Telegram) and the answer is routed back to the
 * asking task. See docs/rfc/rfc-kookr-ask.md.
 */

export type AskState = 'pending' | 'answered' | 'expired' | 'cancelled';

/** Why an ask reached its current state (more specific than `state`). */
export type AskResolution = 'answered' | 'expired' | 'cancelled' | 'task_gone' | 'delivery_failed';

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
  answeredBy?: number;
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

/**
 * What the ask service offers the Telegram integration: record an answer, and
 * recognise which ask a Telegram message belongs to. Plain functions only, so
 * `src/integrations` never imports server internals.
 */
export interface AskAnswerPort {
  answer(input: AnswerInput): Promise<AnswerResult>;
  /** The ask whose Telegram message is (chatId, messageId), in any state. */
  findByMessage(chatId: number, messageId: number): Pick<AskRecord, 'id' | 'state'> | undefined;
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
