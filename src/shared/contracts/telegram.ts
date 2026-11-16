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

/** What the Telegram card for a waiting permission prompt shows (issue #3925). */
export interface PermissionPromptCardInfo {
  /** Short prompt identity both buttons are bound to. */
  promptId: string;
  taskName?: string;
  project?: string;
  toolName: string;
  /** Whole command, file path or URL, secrets already hidden; empty when unknown. */
  command: string;
  /** Whether the pane shows an option the option reader classes as "deny". */
  canDeny: boolean;
}

/** Why a prompt that was on a card went away without a tap on the card. */
export type PermissionPromptClosedReason = 'answered' | 'task_ended';

/**
 * Telegram card for a permission prompt that has waited past the page
 * threshold (issue #3925). Driven by the permission-prompt wait alerter.
 */
export interface PermissionPromptCardPort {
  /**
   * Put the card in front of the operator. Resolves true when Telegram holds a
   * message with buttons for this prompt (the card was sent, or the task was
   * launched from Telegram and its immediate notice already has them), so the
   * plain-text page is not also sent. Never rejects.
   */
  offer(taskId: string, waitedMs: number): Promise<boolean>;
  /** The prompt is gone (answered anywhere, or the task ended): edit the card, drop its buttons. */
  close(taskId: string): void;
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
  /** Present when approval routing is wired (the reply bridge was passed in). */
  permissionCard?: PermissionPromptCardPort;
}
