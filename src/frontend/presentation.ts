import type { AgentEvent, TokenUsage, AgentType, TurnState, AgentState, GitHubPRState } from '../shared/protocol.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';

/**
 * A small palette of muted background/text color pairs for project badges.
 * Each entry is a CSS class suffix applied as .project-badge.color-{N}.
 */
const PROJECT_COLOR_COUNT = 8;

interface AgentProviderPresentation {
  label: string;
  provider: string;
  iconPath: string;
}

export type NextStepAction =
  | { type: 'open-pr'; href: string }
  | { type: 'relaunch' }
  | { type: 'snapshot-reflect' };

export interface NextStepRecommendation {
  id: string;
  title: string;
  detail: string;
  actionLabel: string;
  action: NextStepAction;
}

// Brand glyphs are sourced from Simple Icons (CC0-1.0) and render as
// currentColor so task cards can use local status colors.
const AGENT_PROVIDER_PRESENTATION: Record<AgentType, AgentProviderPresentation> = {
  'claude-code': {
    label: 'Claude Code',
    provider: 'Anthropic',
    iconPath: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  },
  'codex-cli': {
    label: 'Codex CLI',
    provider: 'OpenAI',
    iconPath: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  },
};

export function agentProviderPresentation(agentType: AgentType): AgentProviderPresentation {
  return AGENT_PROVIDER_PRESENTATION[agentType];
}

export function deriveTaskNextStepRecommendations(
  agent: AgentState,
  prs: GitHubPRState[] = [],
): NextStepRecommendation[] {
  if (!agent.taskId || !agent.taskStatus || !isTerminalStatus(agent.taskStatus)) return [];

  const recommendations: NextStepRecommendation[] = [];
  const mergedPr = prs.find((pr) => pr.status === 'merged');
  const completedOrMerged = agent.taskStatus === 'completed' || Boolean(mergedPr);

  if (mergedPr) {
    recommendations.push({
      id: `merged-pr-${mergedPr.ref.owner}-${mergedPr.ref.repo}-${mergedPr.ref.number}`,
      title: `PR #${mergedPr.ref.number} merged`,
      detail: `Merged into ${mergedPr.baseBranch}. Open the PR if you need the merge record or follow-up context.`,
      actionLabel: `Open PR #${mergedPr.ref.number}`,
      action: { type: 'open-pr', href: mergedPr.ref.url },
    });
  }

  if (completedOrMerged && agent.playbookId) {
    recommendations.push({
      id: `continue-playbook-${agent.playbookId}`,
      title: 'Continue the playbook',
      detail: 'Launch a follow-up run using this task\'s playbook and saved parameters.',
      actionLabel: 'Launch follow-up',
      action: { type: 'relaunch' },
    });
  } else if (completedOrMerged && agent.description) {
    recommendations.push({
      id: 'launch-follow-up-task',
      title: 'Start a follow-up task',
      detail: 'Open the launch dialog prefilled from this task instead of typing the next directive manually.',
      actionLabel: 'Relaunch from task',
      action: { type: 'relaunch' },
    });
  }

  recommendations.push({
    id: 'snapshot-reflect',
    title: 'Capture a task snapshot',
    detail: 'Run snapshot reflection now to preserve what happened and surface reusable follow-up notes.',
    actionLabel: 'Run snapshot',
    action: { type: 'snapshot-reflect' },
  });

  return recommendations;
}

export function worktreeHealthLabel(health: string | undefined, registryStale?: boolean): string {
  if (registryStale) return 'git stale';
  switch (health) {
    case 'missing_unexpectedly':
      return 'missing unexpectedly';
    case 'cleaned_up':
      return 'cleaned up';
    case 'missing':
      return 'missing';
    case 'stale':
      return 'stale';
    case 'ok':
    case undefined:
      return '';
    default:
      return health;
  }
}

export function worktreeHealthTitle(health: string | undefined, registryStale?: boolean): string {
  if (registryStale) return 'Worktree registry refresh failed; showing stale git state';
  switch (health) {
    case 'missing_unexpectedly':
      return 'Worktree is missing unexpectedly';
    case 'cleaned_up':
      return 'Worktree was cleaned up after successful completion';
    case 'missing':
      return 'Worktree is missing';
    case 'stale':
      return 'Worktree registry entry is stale';
    default:
      return health ? `Worktree is ${health}` : '';
  }
}

/**
 * Extract a short project label from an absolute CWD path.
 * Returns the last non-empty segment (e.g., "/workspace/kookr" → "kookr").
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
 * Human-readable label for an agent's current turn state. Empty string when
 * the turn state is absent or indeterminate so callers can skip rendering.
 * See issue #358 — `completed_turn` must read as an idle, review-ready turn
 * rather than an actively-running or hung session.
 */
export function turnStateLabel(turnState: TurnState | undefined): string {
  switch (turnState) {
    case 'running':
      return 'Running';
    case 'waiting_for_input':
      return 'Waiting for your input';
    case 'completed_turn':
      return 'Signaled complete — waiting for review';
    case 'blocked':
      return 'Blocked';
    case 'unknown':
    case undefined:
      return '';
  }
}

/**
 * CSS class suffix for the turn-state line — applied as
 * `.finding-turn-state.turn-state--{suffix}`. Returns '' when there is
 * nothing to render.
 */
export function turnStateClass(turnState: TurnState | undefined): string {
  switch (turnState) {
    case 'running':
      return 'running';
    case 'waiting_for_input':
      return 'waiting';
    case 'completed_turn':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'unknown':
    case undefined:
      return '';
  }
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
