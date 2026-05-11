/**
 * Achievement definitions — the catalog of all achievements in Kookr.
 * Pure data, no logic. Used by both server (detection) and frontend (display).
 *
 * Category IDs are stable; display labels live in the frontend (see
 * AchievementsPanel.tsx CATEGORY_LABELS) and may change without breaking
 * persisted unlocks.
 *
 * Trigger wiring for the IDs marked "Phase 1c" in the RFC lives in
 * achievement-watcher.ts; Phase 1a ships them as catalog entries only so the
 * panel can render the full locked grid while the wiring is staged.
 */

/**
 * Counter keys recognized by the watcher. Tier achievements reference one of
 * these; the watcher persists the integer counts. Keep in sync with
 * AchievementCounters in achievement-watcher.ts.
 */
export type AchievementCounterKey =
  | 'repeated_error_resolutions'
  | 'permission_blocked_resolutions'
  | 'merge_conflict_resolutions'
  | 'api_error_resolutions'
  | 'needs_input_resolutions'
  | 'session_start_total';

export interface AchievementDefinition {
  id: string;
  name: string;
  emoji: string;
  description: string;
  category: 'first-steps' | 'feature-discovery' | 'multi-agent' | 'easter-egg';
  hint?: string;
  /**
   * Tier achievements track progress toward an integer target. The watcher
   * exposes a counter on the snapshot keyed by `tier.counterKey`; the panel
   * renders an X / target progress bar. Phase 1a ships the type; Phase 1c
   * wires the counters and unlock logic.
   */
  tier?: {
    counterKey: AchievementCounterKey;
    target: number;
  };
}

export const ACHIEVEMENT_CATALOG: readonly AchievementDefinition[] = [
  // First Steps
  { id: 'first-agent', name: 'First Contact', emoji: '👋', description: 'Monitor your first AI agent', category: 'first-steps', hint: 'Launch a task or let Kookr detect a running Claude Code agent' },
  { id: 'first-anomaly-resolved', name: 'Good Eye', emoji: '👁', description: 'Resolve your first detected anomaly', category: 'first-steps', hint: 'When an anomaly appears, review it and send a response' },
  { id: 'first-response', name: 'Whisperer', emoji: '💬', description: 'Send your first message to an agent', category: 'first-steps', hint: 'Select a task and type a response in the input area' },

  // Field Guide (category id: feature-discovery)
  { id: 'first-shortcut', name: 'Keyboard Warrior', emoji: '⌨', description: 'Use a keyboard shortcut', category: 'feature-discovery', hint: 'Press ? to see available keyboard shortcuts' },
  { id: 'smart-response-used', name: 'AI Assist', emoji: '🤖', description: 'Accept a smart response suggestion', category: 'feature-discovery', hint: 'When Kookr suggests a response, click to accept it' },
  { id: 'task-launched', name: 'Mission Control', emoji: '🚀', description: 'Launch an agent task from the UI', category: 'feature-discovery', hint: 'Click "Launch Task" in the sidebar or press L' },
  { id: 'first-cron', name: 'Crontab Curator', emoji: '🕰', description: 'Schedule your first recurring agent', category: 'feature-discovery', hint: 'Open the Schedules panel and create a cron task' },
  { id: 'first-codex', name: 'Polyglot', emoji: '🌐', description: 'Launch your first Codex CLI agent', category: 'feature-discovery', hint: 'Pick the Codex agent in the launch dialog' },
  { id: 'first-multi-project', name: 'Two Worlds', emoji: '🪐', description: 'Register a second project directory', category: 'feature-discovery', hint: 'Add another project from the project switcher' },
  { id: 'first-feedback', name: 'Honest Critic', emoji: '👍', description: 'Submit thumbs-up or thumbs-down on a task', category: 'feature-discovery', hint: 'Rate a completed task to help Kookr learn' },
  { id: 'first-snooze', name: 'Not Now', emoji: '💤', description: 'Snooze a finding', category: 'feature-discovery', hint: 'Snooze a finding to silence it for a while' },
  { id: 'first-direct-reply', name: 'Backseat Driver', emoji: '🎤', description: 'Send a direct reply mid-stream', category: 'feature-discovery', hint: 'Use direct reply to inject a message while the agent is busy' },

  // Battle Honors (category id: multi-agent)
  { id: 'five-agents', name: 'Squadron Leader', emoji: '✈', description: 'Run 5 agents simultaneously', category: 'multi-agent', hint: 'Launch multiple tasks to run 5 agents at once' },
  { id: 'ten-agents', name: 'Fleet Commander', emoji: '🚢', description: 'Run 10 agents simultaneously', category: 'multi-agent', hint: 'Keep scaling — 10 simultaneous agents earns this' },
  { id: 'loop-buster-i', name: 'Loop Buster', emoji: '🔓', description: 'Resolve 10 stuck-loop anomalies', category: 'multi-agent', hint: 'Send a non-trivial response when a repeated-error finding is active', tier: { counterKey: 'repeated_error_resolutions', target: 10 } },
  { id: 'loop-buster-ii', name: 'Loop Crusher', emoji: '🔨', description: 'Resolve 50 stuck-loop anomalies', category: 'multi-agent', hint: 'Keep the loop count climbing', tier: { counterKey: 'repeated_error_resolutions', target: 50 } },
  { id: 'permission-whisperer', name: 'Permission Whisperer', emoji: '🗝', description: 'Resolve 25 permission-block anomalies', category: 'multi-agent', hint: 'Step in when an agent needs a permission decision', tier: { counterKey: 'permission_blocked_resolutions', target: 25 } },
  { id: 'iron-streak', name: 'Iron Streak', emoji: '🔥', description: '7 consecutive days with at least one user-resolved anomaly', category: 'multi-agent', hint: 'Resolve at least one anomaly each day for a week' },

  // Folklore (category id: easter-egg)
  { id: 'the-loop', name: 'The Loop', emoji: '🔄', description: 'Kookr supervises an agent working on Kookr itself', category: 'easter-egg' },
  { id: 'stuck-together', name: 'Stuck Together', emoji: '🤝', description: 'Resolve the same anomaly 3 times within an hour', category: 'easter-egg' },
  { id: 'tab-hoarder', name: 'Tab Hoarder', emoji: '📑', description: 'Have 10+ unsnoozed findings queued at once', category: 'easter-egg' },
  { id: 'afk', name: 'Welcome Back', emoji: '🐻', description: 'Resolve an anomaly more than 30 minutes after it fired', category: 'easter-egg' },
  { id: 'forty-two', name: 'The Answer', emoji: '🌌', description: 'Reach 42 lifetime agent sessions', category: 'easter-egg' },
  { id: 'self-aware', name: 'Self-Aware', emoji: '🪞', description: 'Launch a task with "kookr" in its subject', category: 'easter-egg' },
] as const;

/** Map for O(1) lookup by ID. */
export const ACHIEVEMENT_BY_ID = new Map(
  ACHIEVEMENT_CATALOG.map((a) => [a.id, a]),
);
