export type UserInputDeliveryStatus = 'queued' | 'submitted_by_agent' | 'failed';

export type UserInputDeliverySource = 'respond' | 'directReply' | 'github_watcher';

export const DELIVERY_SOURCE_LABEL: Record<UserInputDeliverySource, string> = {
  respond: 'You',
  directReply: 'You',
  github_watcher: 'Kookr watcher',
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
