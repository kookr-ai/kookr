/**
 * Achievement definitions — the catalog of all achievements in Kookr.
 * Pure data, no logic. Used by both server (detection) and frontend (display).
 */

export interface AchievementDefinition {
  id: string;
  name: string;
  emoji: string;
  description: string;
  category: 'first-steps' | 'feature-discovery' | 'multi-agent' | 'easter-egg';
  hint?: string;
}

export const ACHIEVEMENT_CATALOG: readonly AchievementDefinition[] = [
  // First Steps
  { id: 'first-agent', name: 'First Contact', emoji: '👋', description: 'Monitor your first AI agent', category: 'first-steps', hint: 'Launch a task or let Kookr detect a running Claude Code agent' },
  { id: 'first-anomaly-resolved', name: 'Good Eye', emoji: '👁', description: 'Resolve your first detected anomaly', category: 'first-steps', hint: 'When an anomaly appears, review it and send a response' },
  { id: 'first-response', name: 'Whisperer', emoji: '💬', description: 'Send your first message to an agent', category: 'first-steps', hint: 'Select a task and type a response in the input area' },

  // Feature Discovery
  { id: 'first-shortcut', name: 'Keyboard Warrior', emoji: '⌨', description: 'Use a keyboard shortcut', category: 'feature-discovery', hint: 'Press ? to see available keyboard shortcuts' },
  { id: 'smart-response-used', name: 'AI Assist', emoji: '🤖', description: 'Accept a smart response suggestion', category: 'feature-discovery', hint: 'When Kookr suggests a response, click to accept it' },
  { id: 'task-launched', name: 'Mission Control', emoji: '🚀', description: 'Launch an agent task from the UI', category: 'feature-discovery', hint: 'Click "Launch Task" in the sidebar or press L' },

  // Multi-Agent Mastery
  { id: 'five-agents', name: 'Squadron Leader', emoji: '✈', description: 'Run 5 agents simultaneously', category: 'multi-agent', hint: 'Launch multiple tasks to run 5 agents at once' },
  { id: 'ten-agents', name: 'Fleet Commander', emoji: '🚢', description: 'Run 10 agents simultaneously', category: 'multi-agent', hint: 'Keep scaling — 10 simultaneous agents earns this' },

  // Easter Eggs
  { id: 'the-loop', name: 'The Loop', emoji: '🔄', description: 'Kookr monitors an agent working on Kookr itself', category: 'easter-egg' },
] as const;

/** Map for O(1) lookup by ID. */
export const ACHIEVEMENT_BY_ID = new Map(
  ACHIEVEMENT_CATALOG.map((a) => [a.id, a]),
);
