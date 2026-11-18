/**
 * Which operator signals reach Telegram.
 *
 * Telegram is the operator's phone. Every health detector used to page it:
 * train halted, then recovered; a smoke tick failing, then recovered; a project
 * with nothing to build; schedules paused. None of those needs an answer, and
 * the stream buried the few messages that do. By default Telegram now gets only
 * the signals where an agent is stuck until the operator acts. Everything else
 * still reaches the dashboard, `operational-alerts.jsonl`, the outbox and
 * Discord. `KOOKR_SIGNAL_TELEGRAM_LEVEL=all` restores the full stream.
 *
 * Questions from `kookr ask` and the permission card's Approve / Deny message do
 * not pass through this outbox. The Telegram integration sends them directly,
 * so this filter never touches them.
 */

import type { OperatorSignal } from './operator-signal.js';

/**
 * `decisions`: only alerts from {@link DECISION_SIGNAL_SOURCES}.
 * `all`: every signal, as before.
 */
export type TelegramSignalLevel = 'decisions' | 'all';

export const DEFAULT_TELEGRAM_SIGNAL_LEVEL: TelegramSignalLevel = 'decisions';

/**
 * Signal sources where an agent cannot go on until the operator decides.
 * They are the operational-alert metric names, which the alert bridge uses as
 * the signal source.
 *
 * - `permission_prompt_wait` (src/server/permission-prompt-wait-alert.ts): a
 *   task has waited minutes on a permission prompt. It is the plain-text
 *   fallback when the Approve / Deny card could not be sent.
 * - `agent_self_report` (src/server/routes/self-report-routes.ts): an agent
 *   stopped because its instructions are unusable and needs new ones.
 *
 * The strings are copied, not imported: this module sits below src/server. The
 * tests build the real alerts and check that they still pass.
 */
export const DECISION_SIGNAL_SOURCES: ReadonlySet<string> = new Set([
  'permission_prompt_wait',
  'agent_self_report',
]);

/** True when the signal asks the operator for a decision an agent is waiting on. */
export function isDecisionSignal(signal: Pick<OperatorSignal, 'kind' | 'source'>): boolean {
  return signal.kind === 'alert' && DECISION_SIGNAL_SOURCES.has(signal.source);
}

/** Whether `signal` goes to Telegram at `level`. */
export function sendsToTelegram(
  signal: Pick<OperatorSignal, 'kind' | 'source'>,
  level: TelegramSignalLevel,
): boolean {
  return level === 'all' || isDecisionSignal(signal);
}
