export type TelegramTaskOutcome =
  | { kind: 'completion_ready'; note?: string }
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

export interface TelegramHandle {
  stop(): Promise<void>;
  /**
   * Callback wired into wireEventPipeline for remote Telegram task permission
   * blocks. Implementations should handle send failures internally.
   */
  onPermissionBlocked: (taskId: string, promptText: string) => void;
  /**
   * Callback wired into task lifecycle/signal paths for remote Telegram task
   * outcomes. Implementations should handle send failures internally.
   */
  onTaskOutcome: (taskId: string, outcome: TelegramTaskOutcome) => void;
}
