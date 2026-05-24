export type TelemetryEventType =
  | 'agent_clicked'
  | 'auto_advance_overridden'
  | 'auto_advance_enabled'
  | 'auto_advance_disabled'
  | 'auto_advance_switch'
  | 'tab_switched'
  | 'response_sent'
  | 'quick_action_clicked'
  | 'suggestion_accepted'
  | 'suggestion_ignored'
  | 'launch_dialog_opened'
  | 'launch_dialog_closed'
  | 'launch_dialog_draft_restored'
  | 'launch_dialog_draft_discarded'
  | 'launch_dialog_cwd_field_used'
  | 'launch_submitted'
  | 'task_completed'
  | 'task_cancelled'
  | 'task_relaunched'
  | 'task_renamed'
  | 'finding_skipped'
  | 'finding_snoozed'
  | 'shortcut_used'
  | 'focus_zone_changed'
  | 'rapid_repeat_click'
  | 'healthy_agent_inspected'
  | 'session_started'
  | 'websocket_reconnect'
  | 'suggestion_lifecycle';

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  sessionId: string;
  platform: 'linux' | 'darwin' | 'wsl2' | 'unknown';
  [key: string]: unknown;
}
