export type UserInputDeliveryStatus = 'queued' | 'submitted_by_agent' | 'failed';

/**
 * `lucy_operator`: a reply Lucy typed for the operator after they confirmed its card (`lucy-action.ts`).
 * `sentinel`: a line the supervisor sentinel's guard typed on its own (issue #4239).
 * `operator-via-sentinel`: an operator answer to a sentinel ask that the guard relayed into the lead;
 * it counts as operator activity, while `sentinel` does not.
 */
export type UserInputDeliverySource =
  | 'respond'
  | 'directReply'
  | 'github_watcher'
  | 'lucy_operator'
  | 'sentinel'
  | 'operator-via-sentinel';

export const DELIVERY_SOURCE_LABEL: Record<UserInputDeliverySource, string> = {
  respond: 'You',
  directReply: 'You',
  github_watcher: 'Kookr watcher',
  lucy_operator: 'Lucy',
  sentinel: 'Kookr sentinel',
  'operator-via-sentinel': 'You (via sentinel)',
};

export interface UserInputDeliverySnapshot {
  deliveryId: string;
  sessionId: string;
  deliverySeq: number;
  source: UserInputDeliverySource;
  text: string;
  status: UserInputDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  ptyAcceptedAt?: string;
  submittedHookLineId?: string;
  terminalReason?: 'session_ended_before_submit_hook';
  error?: string;
  /** Bare-Enter retries sent because the submit hook did not confirm. */
  enterRetries?: number;
  /** Timestamp of the most recent bare-Enter retry. */
  lastRetryAt?: string;
}

export const USER_INPUT_DELIVERY_TEXT_MAX_CHARS = 2_000;

export function projectUserInputDeliveryForClient(
  delivery: UserInputDeliverySnapshot,
): UserInputDeliverySnapshot {
  if (delivery.text.length <= USER_INPUT_DELIVERY_TEXT_MAX_CHARS) return delivery;
  return {
    ...delivery,
    text: `${delivery.text.slice(0, USER_INPUT_DELIVERY_TEXT_MAX_CHARS).trimEnd()}...<${delivery.text.length} chars total>`,
  };
}
