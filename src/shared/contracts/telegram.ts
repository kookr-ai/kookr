import type { AskNotifier } from './asks.js';

export type TelegramTaskOutcome =
  | { kind: 'completion_ready'; note?: string }
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/** Result of routing an operator's Telegram reply/decision back to a task. */
export interface TelegramReplyResult {
  ok: boolean;
  reason?: string;
}

export interface TelegramHandle {
  stop(): Promise<void>;
  /**
   * Callback wired into wireEventPipeline for remote Telegram task permission
   * blocks. Implementations should handle send failures internally.
   */
  onPermissionBlocked: (taskId: string, promptText: string) => void;
  /**
   * Callback wired into task lifecycle/signal paths for remote Telegram task
   * outcomes. Implementations should handle send failures internally. Callers
   * may await completion when they need to observe the routed notification.
   */
  onTaskOutcome: (taskId: string, outcome: TelegramTaskOutcome) => void | Promise<void>;
  /**
   * Transport for `kookr ask`: posts questions with buttons and edits them to
   * their final state. Present only when the integration was started with an
   * ask service, so the sender and the callback handler are registered together.
   */
  ask?: AskNotifier;
}
