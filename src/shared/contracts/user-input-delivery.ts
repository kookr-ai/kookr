export type UserInputDeliveryStatus = 'queued' | 'submitted_by_agent' | 'failed';

export type UserInputDeliverySource = 'respond' | 'directReply';

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
