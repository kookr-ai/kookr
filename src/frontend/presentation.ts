import type { AgentEvent, TokenUsage, AgentType, TurnState, AgentState, GitHubPRState } from '../shared/protocol.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { AGENT_TYPES } from '../shared/contracts/agent-types.js';
import { toolLabel } from '../shared/contracts/activity-summary.js';

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

// Brand glyphs render as currentColor so task cards can use local status colors.
// Claude / Codex paths: Simple Icons (CC0-1.0). Grok path: monochrome Grok mark
// from lobehub/lobe-icons (MIT), matching the official product logo on grok.com.
// Marks remain trademarks of their respective owners.
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
  // Grok Build (xAI). Official Grok product mark (curve glyph), not the xAI
  // wordmark — matches Claude/Codex using product-family glyphs.
  'grok-build': {
    label: 'Grok Build',
    provider: 'xAI',
    iconPath: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815Z',
  },
};

export function agentProviderPresentation(agentType: AgentType): AgentProviderPresentation {
  return AGENT_PROVIDER_PRESENTATION[agentType];
}

/**
 * Short one-word runtime names for the no-selection overview mix line
 * (issue #2670). Deliberately terser than {@link AGENT_PROVIDER_PRESENTATION}'s
 * `label` ("Claude Code", "Codex CLI", "Grok Build") so several fit on one
 * compact line: `Claude 6 · Codex 2 · Grok 1`.
 */
const AGENT_RUNTIME_SHORT_LABEL: Record<AgentType, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'grok-build': 'Grok',
};

/** One runtime's tally in the overview mix line. */
export interface RuntimeMixEntry {
  /** Raw agentType key — also the React list key. */
  agentType: string;
  /** Display name: short label for a known runtime, raw agentType otherwise. */
  label: string;
  /** Number of live agents on this runtime (always > 0). */
  count: number;
}

/**
 * Tally the runtime composition of a set of live agents for the no-selection
 * overview (issue #2670). Known agent types come first in canonical order
 * (Claude → Codex → Grok) with a short label; unknown or legacy `agentType`
 * values keep their raw string and sort after, alphabetically — surfaced, not
 * dropped. Agents with no `agentType` are skipped (there is no runtime to
 * name), and a runtime with zero agents never appears.
 */
export function buildRuntimeMix(agents: AgentState[]): RuntimeMixEntry[] {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const type = agent.agentType;
    if (type === undefined) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const known: RuntimeMixEntry[] = [];
  for (const type of AGENT_TYPES) {
    const count = counts.get(type);
    if (count) {
      known.push({ agentType: type, label: AGENT_RUNTIME_SHORT_LABEL[type], count });
      counts.delete(type);
    }
  }

  const unknown: RuntimeMixEntry[] = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => ({ agentType: type, label: type, count }));

  return [...known, ...unknown];
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
      return 'worktree missing';
    case 'cleaned_up':
      return 'cleaned up';
    case 'missing':
      return 'worktree missing';
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
      return "Worktree directory is missing unexpectedly — the agent's working copy may have been deleted. Check the session before sending new work.";
    case 'cleaned_up':
      return 'Worktree was cleaned up after successful completion';
    case 'missing':
      return "Worktree directory is missing — the agent's working copy may have been deleted. Check the session before sending new work.";
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
 * Compact current-tool label for a healthy rail row.
 *
 * Only the latest event counts: a live `tool_use` is what the operator
 * wants at a glance, and a later stop / session-end would otherwise leave
 * a stale tool name on an idle row.
 */
export function healthyCurrentToolLabel(events: AgentEvent[]): string {
  const last = events[events.length - 1];
  if (!last || last.type !== 'tool_use') return '';
  return toolLabel(last.toolName, last.toolInput);
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
 * Human-readable label for a task status. Accepts a loose string (some
 * surfaces carry the status as `string | undefined`) and falls back to the
 * raw value for unknown statuses so new enum members degrade gracefully
 * instead of disappearing.
 */
export function taskStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'open': return 'Open';
    case 'pending': return 'Pending';
    case 'inProgress': return 'In progress';
    case 'completed': return 'Completed';
    case 'terminated': return 'Terminated';
    case 'cancelled': return 'Cancelled';
    case undefined: return '';
    default: return status;
  }
}

/**
 * Human-readable label for an anomaly type, without per-agent turn-state
 * nuance. Used by the findings-rail type-filter chips so one type is one chip.
 */
export function anomalyTypeLabel(anomalyType: string): string {
  switch (anomalyType) {
    case 'permission_blocked': return 'Permission';
    case 'repeated_error': return 'Repeated Error';
    case 'merge_conflict': return 'Merge Conflict';
    case 'stale_agent': return 'Stale Agent';
    case 'hook_disconnected': return 'Hook Disconnected';
    case 'hook_missing': return 'Hook Missing';
    case 'hook_parse_degraded': return 'Hook Parse Degraded';
    case 'backend_unreachable': return 'Backend Unreachable';
    case 'api_error': return 'API Error';
    case 'budget_exceeded': return 'Budget Exceeded';
    case 'needs_input': return 'Needs Input';
    default: return anomalyType.replace(/_/g, ' ');
  }
}

/**
 * Human-readable label for a finding's action/type. Mirrors the findings rail
 * wording so navigation surfaces describe the same condition consistently.
 */
export function findingTypeLabel(agent: AgentState): string {
  const anomalyType = agent.anomaly?.type;
  if (anomalyType === undefined) return '';
  // `completed_turn` => the agent signaled it is ready for review; `Needs Input`
  // is reserved for an explicit mid-turn question. See issue #358.
  if (anomalyType === 'needs_input' && agent.turnState === 'completed_turn') return 'Signaled Complete';
  return anomalyTypeLabel(anomalyType);
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
 *
 * When `endedAt` is provided (e.g. a task's `finishedAt`), it is used as the
 * upper bound so terminal tasks show a frozen, correct run time. When omitted
 * — or unparseable — the duration is measured against `Date.now()` and keeps
 * ticking for live tasks. An absent or unparseable `startedAt` yields `''`.
 * See issue #2737.
 */
export function formatDuration(startedAt?: string, endedAt?: string): string {
  const start = parseValidDate(startedAt);
  if (!start) return '';
  const ended = endedAt ? parseValidDate(endedAt) : null;
  const end = ended ? ended.getTime() : Date.now();
  const ms = end - start.getTime();
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
 * Two-minute floor shared by {@link formatAge} and {@link formatCostRate}.
 * Fresh launches would otherwise flash a nonsense age or dollars-per-hour.
 */
export const FRESH_SESSION_FLOOR_MS = 120_000;

/**
 * Compact dollars-per-hour from total session cost and wall-clock start.
 *
 * Rate is cost divided by hours since start, not a recent-window average.
 * Hidden when cost is missing/non-positive, start is missing/invalid, the
 * session is younger than two minutes, or the result would not be finite.
 */
export function formatCostRate(
  costUsd: number | undefined,
  startedAt: Date | string | undefined,
  nowMs: number = Date.now(),
): string {
  if (costUsd === undefined || !(costUsd > 0) || !Number.isFinite(costUsd)) return '';
  const start = parseValidDate(startedAt);
  if (!start) return '';
  const elapsedMs = nowMs - start.getTime();
  if (elapsedMs < FRESH_SESSION_FLOOR_MS) return '';
  const hours = elapsedMs / 3_600_000;
  const rate = costUsd / hours;
  if (!Number.isFinite(rate)) return '';
  return `$${rate.toFixed(2)}/h`;
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
 * Short label for a PR link. Prefers `#<number>` parsed from a GitHub-style
 * `/pull/<n>` (or `/pulls/<n>`) path; falls back to a generic "View PR" when
 * the URL doesn't carry a recognizable number. Shared by the completed-task
 * detail pane and the idle overview's Recently completed rows so both surfaces
 * derive the visible PR label identically (each may still wrap it in its own
 * accessible name).
 */
export function prLinkLabel(url: string): string {
  const match = /\/pulls?\/(\d+)/.exec(url);
  return match ? `PR #${match[1]}` : 'View PR';
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
 * Fraction of billed input tokens that were served from the prompt cache:
 * `cacheReadTokens / (inputTokens + cacheReadTokens)`, in the range [0, 1].
 *
 * Returns `null` when there is no billed input at all (both `inputTokens` and
 * `cacheReadTokens` are zero), so callers avoid a 0/0 → NaN and can render
 * cache-free sessions cleanly. A session that paid full input price with no
 * cache reads yields a well-defined `0`.
 */
export function cacheHitRatio(usage: TokenUsage | undefined): number | null {
  if (!usage) return null;
  const denominator = usage.inputTokens + usage.cacheReadTokens;
  if (denominator <= 0) return null;
  return usage.cacheReadTokens / denominator;
}

/**
 * Format the prompt-cache hit ratio as a rounded percentage (e.g. `85%`).
 * Returns `''` when {@link cacheHitRatio} is undefined (no billed input).
 */
export function formatCacheHit(usage: TokenUsage | undefined): string {
  const ratio = cacheHitRatio(usage);
  if (ratio === null) return '';
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Format the age of an anomaly detection as a compact human-readable string.
 * Returns '' for age < 2 minutes (avoids flash on fresh findings).
 * Accepts Date or ISO string (JSON-serialized Date arrives as string over WebSocket).
 */
export function formatAge(detectedAt: Date | string | undefined): string {
  if (!detectedAt) return '';
  const ms = Date.now() - new Date(detectedAt).getTime();
  if (ms < FRESH_SESSION_FLOOR_MS) return '';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms >= 86_400_000) return `${Math.floor(ms / 86_400_000)}d`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseValidDate(timestamp: Date | string | undefined): Date | null {
  if (!timestamp) return null;
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Format a timestamp for compact row display. Uses local time and includes the
 * year only when it differs from the current year.
 */
export function formatCompactDateTime(timestamp: Date | string | undefined, now: Date = new Date()): string {
  const date = parseValidDate(timestamp);
  if (!date) return '';
  const month = MONTH_NAMES[date.getMonth()] ?? '';
  const datePart = date.getFullYear() === now.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`;
  return `${datePart}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Compact relative age for title text where exact date is already visible.
 */
export function formatRelativeTimeAgo(timestamp: Date | string | undefined, nowMs = Date.now()): string {
  const date = parseValidDate(timestamp);
  if (!date) return '';
  const ms = Math.max(0, nowMs - date.getTime());
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function findingWaitStartedAt(agent: AgentState): Date | string | undefined {
  const isSignaledCompleteFinding = agent.anomaly?.type === 'needs_input'
    && agent.turnState === 'completed_turn'
    && agent.pendingSignal?.kind === 'completion_ready';
  // Completion signals survive anomaly re-stamps across server restarts; other
  // finding types must keep their own detection time for DND and urgency.
  return isSignaledCompleteFinding ? agent.pendingSignal?.raisedAt : agent.anomaly?.detectedAt;
}

/**
 * Earliest live finding wait among the same agents the status bar counts.
 * Uses {@link findingWaitStartedAt} so completion-ready signals keep the
 * original raise time instead of a restamped anomaly clock.
 */
export function oldestFindingWaitStartedAt(
  agents: readonly AgentState[],
): Date | string | undefined {
  let oldest: Date | string | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const agent of agents) {
    const started = findingWaitStartedAt(agent);
    if (started === undefined) continue;
    const ms = new Date(started).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = started;
    }
  }
  return oldest;
}

/**
 * Status-bar label for a live finding wait. Reuses {@link formatAge};
 * waits under the two-minute floor become `<2m` so the chip stays visible
 * for a brand-new finding.
 */
export function formatOldestFindingWait(
  startedAt: Date | string | undefined,
): string | null {
  if (startedAt === undefined) return null;
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const ageMs = Date.now() - startedMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return formatAge(startedAt) || '<2m';
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
