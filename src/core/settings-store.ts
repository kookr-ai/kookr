import { readFile, writeFile, rename } from 'node:fs/promises';
import {
  DEFAULT_AGENT_TYPE,
  normalizeAgentSelection,
  isValidEffortForAgent,
  effortLevelsForAgent,
  AVAILABLE_AGENT_TYPES,
  type AgentSelection,
  type AgentType,
  type AgentEffortMap,
} from './agent-types.js';
import {
  validateShortcutBindingOverrides,
  type PlatformShortcutBindingOverrides,
} from '../shared/contracts/shortcut-bindings.js';
import { validateQuietHours, type QuietHoursWindow } from '../shared/contracts/quiet-hours.js';
import {
  validateReplySnippets,
  type ReplySnippet,
} from '../shared/contracts/reply-snippets.js';
import type { VerbosityScale } from '../shared/contracts/speech.js';

export type { QuietHoursWindow } from '../shared/contracts/quiet-hours.js';
export { isWithinQuietHours } from '../shared/contracts/quiet-hours.js';
export type { ReplySnippet } from '../shared/contracts/reply-snippets.js';
export { MAX_REPLY_SNIPPETS } from '../shared/contracts/reply-snippets.js';

const VERBOSITY_VALUES: readonly VerbosityScale[] = ['terse', 'brief', 'medium', 'detailed'];
const DEFAULT_VERBOSITY: VerbosityScale = 'medium';

export interface KookrSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  /** Default checkbox value for task-owned worktree cleanup on completion. */
  cleanupWorktreeOnComplete: boolean;
  /**
   * Pre-selected agent for new tasks when no explicit agent is supplied. May
   * be the `round-robin` sentinel — the launch service resolves that to a
   * concrete agent per launch (see {@link roundRobinIndex}).
   */
  defaultAgentType: AgentSelection;
  /**
   * Rotation cursor for the `round-robin` default agent. Holds the index of
   * the *next* launch in the rotation; advanced and persisted on every
   * round-robin launch so the alternation survives a server restart.
   */
  roundRobinIndex: number;
  /**
   * Sparse keyboard shortcut overrides by frontend platform bucket. Missing
   * actions use platform defaults; empty/invalid values are ignored.
   */
  shortcutBindings: PlatformShortcutBindingOverrides;
  /**
   * Default verbosity level for speak-agent summaries. Out-of-range values
   * clamp to `'medium'` and emit a warning. Consumed by the speak route's
   * summarizer (see docs/rfc/rfc-speak-agent-summary-v2.md).
   */
  speakVerbosity: VerbosityScale;
  /**
   * Per-agent-type reasoning-effort default (#681). Maps an agent type to the
   * effort level its spawned sessions launch at (claude-code → `--effort`;
   * codex-cli → `-c model_reasoning_effort`). Sparse by design: a missing
   * agent key means "no override" — the agent CLI / model uses its own default
   * effort. A per-task `effort` override (POST /api/tasks / `kookr-spawn
   * --effort`) wins over this map. Invalid (agent, level) pairs are dropped
   * with a warning during validation.
   */
  agentEffort: AgentEffortMap;
  /**
   * Recurring quiet-hours windows. While local time falls inside any window the
   * frontend auto-suppresses chimes and desktop notifications (reusing the DND
   * path) and resumes automatically afterward. Empty = no scheduled silencing.
   */
  quietHours: QuietHoursWindow[];
  /**
   * User-managed canned replies for the response composer. The frontend only
   * inserts these into the draft; it never sends them automatically.
   */
  replySnippets: ReplySnippet[];
  /**
   * Delay, in minutes, that an opted-in task's `completion_ready` signal stays
   * pending before Kookr auto-closes the task (see
   * docs/reference/auto-close-on-signal.md). Only affects tasks with
   * `autoCloseOnSignal` enabled; the manual-review banner is unaffected. The
   * liveness tick reads this live, so a change takes effect without a restart.
   */
  autoCloseCompletionReadyDelayMin: number;
  /**
   * TTL (minutes), issue #1526 Phase A / FM5: how long a `completion_ready`
   * signal can sit unacknowledged — including ask-first tasks that
   * {@link autoCloseCompletionReadyDelayMin} deliberately never touches —
   * before Kookr escalates and closes the task anyway so it stops holding a
   * concurrency slot forever. Distinct from `autoCloseCompletionReadyDelayMin`
   * on purpose: that setting's documented contract is "only affects
   * autoCloseOnSignal tasks", so a short value there must never silently
   * start closing ask-first review-required work. See
   * docs/adr and completion-ready-cleanup.ts `classifyCompletionReadyClosePolicy`.
   */
  completionReadyTtlMinutes: number;
  /**
   * Hung-task reaper (issue #1526 Phase A / FM6). When enabled, a task whose
   * agent has had zero hook events, zero pane-content change, and zero token
   * activity for {@link hungTaskReapMinutes} is treated as hung: its session
   * is killed, the task transitions to `terminated`, and its slot is freed.
   * Excludes any task with a pending signal or that the watchdog classifies
   * as waiting on the user/a permission — see hung-task-reaper.ts.
   */
  hungTaskReapEnabled: boolean;
  /** Minutes of total silence (all liveness channels) before a task is reaped. */
  hungTaskReapMinutes: number;
}

export const DEFAULT_SETTINGS: KookrSettings = {
  githubPollingEnabled: true,
  githubPollingIntervalSec: 60,
  autoWatchOssSources: true,
  watchdogStaleThresholdSec: 30,
  repeatedErrorThreshold: 3,
  maxActiveTasks: 10,
  cleanupWorktreeOnComplete: true,
  defaultAgentType: DEFAULT_AGENT_TYPE,
  roundRobinIndex: 0,
  shortcutBindings: {},
  speakVerbosity: DEFAULT_VERBOSITY,
  agentEffort: {},
  quietHours: [],
  replySnippets: [],
  autoCloseCompletionReadyDelayMin: 30,
  completionReadyTtlMinutes: 120,
  hungTaskReapEnabled: true,
  hungTaskReapMinutes: 180,
};

const MIN_POLLING_INTERVAL = 15;
const MAX_POLLING_INTERVAL = 600;
const MIN_STALE_THRESHOLD = 15;
const MAX_STALE_THRESHOLD = 90;
const MIN_ERROR_THRESHOLD = 2;
const MAX_ERROR_THRESHOLD = 10;
const MIN_ACTIVE_TASKS = 1;
const MAX_ACTIVE_TASKS = 25;
// Auto-close delay bounds (minutes). Floor of 1 keeps at least a brief
// human-review window; ceiling of 1440 (24h) prevents a fat-fingered value
// from effectively disabling the sweep forever.
const MIN_AUTO_CLOSE_DELAY_MIN = 1;
const MAX_AUTO_CLOSE_DELAY_MIN = 1440;
// Completion-ready TTL bounds (minutes). Floor of 5 keeps escalation from
// firing near-instantly; ceiling of 10080 (7 days) is a generous outer bound.
const MIN_COMPLETION_READY_TTL_MIN = 5;
const MAX_COMPLETION_READY_TTL_MIN = 10_080;
// Hung-task reap bounds (minutes). Floor of 15 stays comfortably above the
// watchdog's own stale_agent + max-tool-execution thresholds so the reaper
// never races normal stuck-detection; ceiling of 10080 (7 days) mirrors the TTL.
const MIN_HUNG_TASK_REAP_MIN = 15;
const MAX_HUNG_TASK_REAP_MIN = 10_080;

/** Validate and clamp a raw settings object, filling in defaults for missing/invalid values. */
export function validateSettings(raw: Record<string, unknown>): KookrSettings {
  return validateSettingsWithWarnings(raw).settings;
}

export function validateSettingsWithWarnings(raw: Record<string, unknown>): { settings: KookrSettings; warnings: string[] } {
  const enabled = typeof raw.githubPollingEnabled === 'boolean'
    ? raw.githubPollingEnabled
    : DEFAULT_SETTINGS.githubPollingEnabled;

  let interval = DEFAULT_SETTINGS.githubPollingIntervalSec;
  if (typeof raw.githubPollingIntervalSec === 'number' && Number.isFinite(raw.githubPollingIntervalSec)) {
    interval = Math.max(MIN_POLLING_INTERVAL, Math.min(MAX_POLLING_INTERVAL, Math.round(raw.githubPollingIntervalSec)));
  }

  const autoWatchOssSources = typeof raw.autoWatchOssSources === 'boolean'
    ? raw.autoWatchOssSources
    : DEFAULT_SETTINGS.autoWatchOssSources;

  let staleThreshold = DEFAULT_SETTINGS.watchdogStaleThresholdSec;
  if (typeof raw.watchdogStaleThresholdSec === 'number' && Number.isFinite(raw.watchdogStaleThresholdSec)) {
    staleThreshold = Math.max(MIN_STALE_THRESHOLD, Math.min(MAX_STALE_THRESHOLD, Math.round(raw.watchdogStaleThresholdSec)));
  }

  let errorThreshold = DEFAULT_SETTINGS.repeatedErrorThreshold;
  if (typeof raw.repeatedErrorThreshold === 'number' && Number.isFinite(raw.repeatedErrorThreshold)) {
    errorThreshold = Math.max(MIN_ERROR_THRESHOLD, Math.min(MAX_ERROR_THRESHOLD, Math.round(raw.repeatedErrorThreshold)));
  }

  let maxTasks = DEFAULT_SETTINGS.maxActiveTasks;
  if (typeof raw.maxActiveTasks === 'number' && Number.isFinite(raw.maxActiveTasks)) {
    maxTasks = Math.max(MIN_ACTIVE_TASKS, Math.min(MAX_ACTIVE_TASKS, Math.round(raw.maxActiveTasks)));
  }

  let autoCloseDelayMin = DEFAULT_SETTINGS.autoCloseCompletionReadyDelayMin;
  if (typeof raw.autoCloseCompletionReadyDelayMin === 'number' && Number.isFinite(raw.autoCloseCompletionReadyDelayMin)) {
    autoCloseDelayMin = Math.max(
      MIN_AUTO_CLOSE_DELAY_MIN,
      Math.min(MAX_AUTO_CLOSE_DELAY_MIN, Math.round(raw.autoCloseCompletionReadyDelayMin)),
    );
  }

  let completionReadyTtlMinutes = DEFAULT_SETTINGS.completionReadyTtlMinutes;
  if (typeof raw.completionReadyTtlMinutes === 'number' && Number.isFinite(raw.completionReadyTtlMinutes)) {
    completionReadyTtlMinutes = Math.max(
      MIN_COMPLETION_READY_TTL_MIN,
      Math.min(MAX_COMPLETION_READY_TTL_MIN, Math.round(raw.completionReadyTtlMinutes)),
    );
  }

  const hungTaskReapEnabled = typeof raw.hungTaskReapEnabled === 'boolean'
    ? raw.hungTaskReapEnabled
    : DEFAULT_SETTINGS.hungTaskReapEnabled;

  let hungTaskReapMinutes = DEFAULT_SETTINGS.hungTaskReapMinutes;
  if (typeof raw.hungTaskReapMinutes === 'number' && Number.isFinite(raw.hungTaskReapMinutes)) {
    hungTaskReapMinutes = Math.max(
      MIN_HUNG_TASK_REAP_MIN,
      Math.min(MAX_HUNG_TASK_REAP_MIN, Math.round(raw.hungTaskReapMinutes)),
    );
  }

  const cleanupWorktreeOnComplete = typeof raw.cleanupWorktreeOnComplete === 'boolean'
    ? raw.cleanupWorktreeOnComplete
    : DEFAULT_SETTINGS.cleanupWorktreeOnComplete;

  const defaultAgentType =
    typeof raw.defaultAgentType === 'string'
      ? normalizeAgentSelection(raw.defaultAgentType)
      : DEFAULT_SETTINGS.defaultAgentType;

  let roundRobinIndex = DEFAULT_SETTINGS.roundRobinIndex;
  if (
    typeof raw.roundRobinIndex === 'number' &&
    Number.isInteger(raw.roundRobinIndex) &&
    raw.roundRobinIndex >= 0
  ) {
    roundRobinIndex = raw.roundRobinIndex;
  }

  const shortcutValidation = validateShortcutBindingOverrides(raw.shortcutBindings);

  const quietHoursValidation = validateQuietHours(raw.quietHours);

  const verbosityWarnings: string[] = [];
  let speakVerbosity: VerbosityScale = DEFAULT_VERBOSITY;
  if (raw.speakVerbosity !== undefined) {
    if (
      typeof raw.speakVerbosity === 'string' &&
      (VERBOSITY_VALUES as readonly string[]).includes(raw.speakVerbosity)
    ) {
      speakVerbosity = raw.speakVerbosity as VerbosityScale;
    } else {
      verbosityWarnings.push(
        `Unknown speakVerbosity value ${JSON.stringify(raw.speakVerbosity)}; clamped to "${DEFAULT_VERBOSITY}"`,
      );
    }
  }

  // Missing or empty agentEffort means "no configured defaults" — each agent
  // uses its own CLI/model default effort. Explicit keys are validated and
  // kept; unknown agents / invalid levels are dropped with warnings.
  const configuredAgentEffort = isEmptyAgentEffortMap(raw.agentEffort)
    ? DEFAULT_SETTINGS.agentEffort
    : raw.agentEffort;
  const validatedAgentEffort = validateAgentEffort(configuredAgentEffort);
  const agentEffort = validatedAgentEffort.agentEffort;
  const agentEffortWarnings = validatedAgentEffort.warnings;
  const replySnippetValidation = validateReplySnippets(raw.replySnippets);

  return {
    warnings: [
      ...shortcutValidation.warnings,
      ...verbosityWarnings,
      ...agentEffortWarnings,
      ...quietHoursValidation.warnings,
      ...replySnippetValidation.warnings,
    ],
    settings: {
      githubPollingEnabled: enabled,
      githubPollingIntervalSec: interval,
      autoWatchOssSources,
      watchdogStaleThresholdSec: staleThreshold,
      repeatedErrorThreshold: errorThreshold,
      maxActiveTasks: maxTasks,
      cleanupWorktreeOnComplete,
      defaultAgentType,
      roundRobinIndex,
      shortcutBindings: shortcutValidation.overrides,
      speakVerbosity,
      agentEffort,
      quietHours: quietHoursValidation.windows,
      replySnippets: replySnippetValidation.snippets,
      autoCloseCompletionReadyDelayMin: autoCloseDelayMin,
      completionReadyTtlMinutes,
      hungTaskReapEnabled,
      hungTaskReapMinutes,
    },
  };
}

/** Known concrete agent types — the only valid keys in an `agentEffort` map. */
const KNOWN_AGENT_TYPES: readonly AgentType[] = AVAILABLE_AGENT_TYPES.map((entry) => entry.type);

/**
 * Validate the raw `agentEffort` map (#681). Drops anything that wouldn't
 * launch cleanly — unknown agent keys, non-string values, and effort levels
 * outside the agent's CLI-accepted set — emitting a warning for each so the
 * operator sees why their input was ignored. Returns a sparse, fully-valid
 * map; a malformed input collapses to `{}` after emitting a warning.
 */
function validateAgentEffort(raw: unknown): { agentEffort: AgentEffortMap; warnings: string[] } {
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`Invalid agentEffort (expected an object); ignored`);
    return { agentEffort: {}, warnings };
  }

  const agentEffort: AgentEffortMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_AGENT_TYPES.includes(key as AgentType)) {
      warnings.push(`Unknown agentEffort agent ${JSON.stringify(key)}; ignored`);
      continue;
    }
    const agent = key as AgentType;
    if (typeof value !== 'string' || !isValidEffortForAgent(agent, value)) {
      warnings.push(
        `Invalid agentEffort for ${agent}: ${JSON.stringify(value)}; ` +
        `valid: ${effortLevelsForAgent(agent).join(', ')}; ignored`,
      );
      continue;
    }
    agentEffort[agent] = value as AgentEffortMap[AgentType];
  }
  return { agentEffort, warnings };
}

function isEmptyAgentEffortMap(raw: unknown): boolean {
  return raw === undefined
    || (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0);
}

export interface SettingsLoadResult {
  settings: KookrSettings;
  loadedFromDefaults: boolean;
  warnings: string[];
}

/** Load settings from a JSON file. Returns defaults on missing/corrupt file. */
export async function loadSettings(filePath: string): Promise<SettingsLoadResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[settings] Invalid settings file (not an object), using defaults`);
      return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true, warnings: [] };
    }
    const validated = validateSettingsWithWarnings(parsed as Record<string, unknown>);
    return { settings: validated.settings, loadedFromDefaults: false, warnings: validated.warnings };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      // File doesn't exist yet — normal on first run
      return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true, warnings: [] };
    }
    console.warn(`[settings] Failed to read settings file, using defaults:`, err instanceof Error ? err.message : err);
    return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true, warnings: [] };
  }
}

/** Monotonic counter feeding {@link saveSettings} unique temp filenames. */
let saveSeq = 0;

/**
 * Save settings to a JSON file. Uses write-to-temp + rename for crash safety.
 *
 * The temp filename is unique per call (pid + sequence) rather than a fixed
 * `.tmp` suffix: round-robin launches persist the rotation cursor through this
 * function, so a per-launch write can race a concurrent settings-PUT write —
 * a shared temp path would let them corrupt each other's partial JSON.
 */
export async function saveSettings(filePath: string, settings: KookrSettings): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${++saveSeq}.tmp`;
  await writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, filePath);
}
