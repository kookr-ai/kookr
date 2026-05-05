import type { AgentEvent, TokenUsage } from '../shared/protocol.js';

/**
 * A small palette of muted background/text color pairs for project badges.
 * Each entry is a CSS class suffix applied as .project-badge.color-{N}.
 */
const PROJECT_COLOR_COUNT = 8;

/**
 * Extract a short project label from an absolute CWD path.
 * Returns the last non-empty segment (e.g., "/home/jean/git/kookr" → "kookr").
 */
export function projectLabel(cwd: string | undefined): string {
  if (!cwd) return '';
  // Strip trailing slashes, then take the last segment
  const stripped = cwd.replace(/\/+$/, '');
  const lastSlash = stripped.lastIndexOf('/');
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
}

/**
 * Return a deterministic color class index (0..7) for a CWD path.
 * Uses a simple string hash so the same path always gets the same color.
 */
export function projectColor(cwd: string | undefined): number {
  if (!cwd) return 0;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  }
  return ((hash % PROJECT_COLOR_COUNT) + PROJECT_COLOR_COUNT) % PROJECT_COLOR_COUNT;
}

/**
 * Determine the CSS class for a healthy agent's status dot.
 * Green for running agents, grey for completed (last event is 'stop' with no anomaly).
 */
export function healthyDotClass(events: AgentEvent[]): string {
  if (events.length === 0) return 'running';
  const lastEvent = events[events.length - 1];
  const doneTypes: string[] = ['stop', 'stop_failure', 'session_end'];
  return doneTypes.includes(lastEvent.type) ? 'done' : 'running';
}

/**
 * Return the status label for a healthy agent row.
 * "done" if the last event is 'stop', formatted duration otherwise.
 */
export function healthyStatusLabel(events: AgentEvent[], startedAt?: string): string {
  const doneTypes: string[] = ['stop', 'stop_failure', 'session_end'];
  if (events.length > 0 && doneTypes.includes(events[events.length - 1].type)) {
    return 'done';
  }
  return formatDuration(startedAt);
}

/**
 * Generate the tmux attach command for an agent.
 */
export function getAttachCommand(agentId: string): string {
  return `tmux attach-session -t ${agentId}`;
}

/**
 * Copy the tmux attach command to clipboard and fire a toast notification.
 */
export function copyAttachCommand(
  agentId: string,
  showToast: (agentId: string, summary: string, severity?: 'info' | 'error') => void,
): void {
  const cmd = getAttachCommand(agentId);
  navigator.clipboard.writeText(cmd).then(
    () => showToast(agentId, `Copied: ${cmd}`, 'info'),
    () => showToast(agentId, `Copy failed — run: ${cmd}`, 'error'),
  );
}

/**
 * Format a duration from an ISO 8601 startedAt timestamp.
 */
export function formatDuration(startedAt?: string): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/**
 * Format a USD cost value compactly.
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Format a token count compactly (e.g., 1234 → "1.2k", 12345 → "12k").
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Format a branch name for display, truncating if too long.
 */
export function formatBranch(branch: string, maxLen = 30): string {
  if (branch.length <= maxLen) return branch;
  return branch.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Format token usage as a compact summary string.
 */
export function formatTokenUsage(usage: TokenUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.costUsd > 0) parts.push(formatCost(usage.costUsd));
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tok`);
  return parts.join(' / ');
}

/**
 * Format the age of an anomaly detection as a compact human-readable string.
 * Returns '' for age < 2 minutes (avoids flash on fresh findings).
 * Accepts Date or ISO string (JSON-serialized Date arrives as string over WebSocket).
 */
export function formatAge(detectedAt: Date | string | undefined): string {
  if (!detectedAt) return '';
  const ms = Date.now() - new Date(detectedAt).getTime();
  if (ms < 120_000) return '';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

/**
 * Return a CSS class suffix for the age badge color.
 * gray (<30m) → fresh, yellow (<2h) → aging, orange (≥2h) → stale.
 * Accepts Date or ISO string.
 */
export function ageColor(detectedAt: Date | string | undefined): string {
  if (!detectedAt) return 'fresh';
  const ms = Date.now() - new Date(detectedAt).getTime();
  const mins = ms / 60000;
  if (mins < 30) return 'fresh';
  if (mins < 120) return 'aging';
  return 'stale';
}
