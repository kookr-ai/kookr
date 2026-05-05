import type { HookEventName } from './types.js';

/**
 * Ordered list of every hook event Kookr may inject into an agent. Both the
 * Claude Code and Codex CLI adapters emit a subset of these (Codex CLI does
 * not currently subscribe to SubagentStart / SubagentStop). The list is
 * shared so the settings dialog can render a single inventory without drift.
 *
 * Matcher selection is intentionally NOT shared: Claude Code uses '' for
 * Notification, Codex CLI uses '*'. See docs/rfc/rfc-hook-inventory-panel.md
 * section "Why matcher tables stay per-adapter".
 */
export const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
];

/**
 * Hooks the supervisor relies on for anomaly detection. Disabling any of
 * them silently degrades supervision; see docs/rfc/rfc-hook-state-detection.md.
 * Used by the inventory UI to render the lock indicator.
 */
export const LOAD_BEARING_HOOKS: ReadonlySet<HookEventName> = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionEnd',
]);

/**
 * One-sentence, plain-language description of what Kookr uses each hook
 * for. Surfaced in the read-only hook inventory section of SettingsDialog.
 */
export const HOOK_DESCRIPTIONS: Record<HookEventName, string> = {
  SessionStart: 'Session identity, cwd, and transcript path.',
  PreToolUse: 'Per-tool event stream used for anomaly detection.',
  PostToolUse: 'Tool results feed repeated-error and stuck detection.',
  PostToolUseFailure: 'Tool failure logging; non-critical.',
  PermissionRequest: 'Permission prompts drive auto-proceed and the attention queue.',
  Stop: 'Needs-input detection and task completion.',
  StopFailure: 'API error anomaly (rate limit, auth, billing).',
  Notification: 'Idle detection and permission prompt surfacing.',
  UserPromptSubmit: 'Idle-to-active transition when the user submits a prompt.',
  SubagentStart: 'Subagent inventory display; non-critical.',
  SubagentStop: 'Subagent inventory display; non-critical.',
  SessionEnd: 'Session teardown and watchdog unregister.',
};
