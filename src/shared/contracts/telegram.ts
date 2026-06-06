export interface TelegramHandle {
  stop(): Promise<void>;
  /**
   * Callback wired into wireEventPipeline for remote Telegram task permission
   * blocks. Implementations should handle send failures internally.
   */
  onPermissionBlocked: (taskId: string, promptText: string) => void;
}
