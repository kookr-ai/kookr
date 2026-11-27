export const TELEMETRY_EVENT_TYPES = [
  'agent_clicked',
  'agent_deselected',
  'auto_advance_overridden',
  'auto_advance_enabled',
  'auto_advance_disabled',
  'auto_advance_switch',
  'tab_switched',
  'response_sent',
  'quick_action_clicked',
  'suggestion_accepted',
  'suggestion_ignored',
  'launch_dialog_opened',
  'launch_dialog_closed',
  'launch_dialog_draft_restored',
  'launch_dialog_draft_discarded',
  'launch_dialog_cwd_field_used',
  /** A recalled recent manual-launch prompt was selected to refill the description. */
  'launch_prompt_recall_used',
  'launch_submitted',
  'task_completed',
  'task_cancelled',
  'task_relaunched',
  'task_renamed',
  'finding_skipped',
  'finding_snoozed',
  'shortcut_used',
  'focus_zone_changed',
  'rapid_repeat_click',
  'healthy_agent_inspected',
  'session_started',
  'websocket_reconnect',
  'websocket_stale_event',
  'selection_flicker_incident',
  'suggestion_lifecycle',
  /**
   * Terminal attach milestones on the client clock. Version two separates
   * completed parsing and the next render opportunity. Unversioned records
   * called asynchronous write enqueueing "first paint"; never blend the series.
   */
  'terminal_switch_latency',
  /** Renderer selection and subsequent GPU context-loss fallback. */
  'terminal_renderer_changed',
  /**
   * Avatar panel ("Lucy") interaction events. Each carries a `clipId` that
   * matches the `clipId` on the speak response and on the server-side record
   * in `lucy-interactions.jsonl`, so what she said and what the operator did
   * can be joined. Shapes:
   * - lucy_clip_started: { clipId, trigger: 'click' | 'replay' | 'ask', panelState: 'open' | 'minimized' | 'off', tabVisible: boolean }
   * - lucy_clip_ended: { clipId, endedBy: 'finished' | 'user_stop' | 'superseded' | 'barge_in', playedMs, totalMs } (`barge_in`: the operator talked over it with Talk on)
   * - lucy_clip_unheard: { clipId, reason: 'muted' | 'dnd' | 'audio_suspended' | 'error' }
   * - lucy_panel_action: { action: 'enable' | 'disable' | 'minimize' | 'restore' | 'move' | 'replay' | 'expand' | 'collapse' | 'bubble_card_shown' | 'bubble_card_answered' | 'bubble_card_dismissed' | 'bubble_card_opened', clipId?: string }
   *   (`expand` / `collapse`: she was given the whole window, "Lucy's room", or went back to the column;
   *   `bubble_card_*`: the minimised bubble grew into a card for a waiting question or permission prompt, and the
   *   operator answered from it, put it off with "Later", or opened Lucy from it)
   * - lucy_live_timing: { kind: 'end_to_first_audio' | 'barge_in_duck' | 'barge_in_stop' | 'barge_in_rejected', ms: number }, measured in the browser during hands-free talk
   */
  'lucy_clip_started',
  'lucy_clip_ended',
  'lucy_clip_unheard',
  'lucy_panel_action',
  'lucy_live_timing',
] as const;

export type TelemetryEventType = typeof TELEMETRY_EVENT_TYPES[number];

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  sessionId: string;
  platform: 'linux' | 'darwin' | 'wsl2' | 'unknown';
  [key: string]: unknown;
}
