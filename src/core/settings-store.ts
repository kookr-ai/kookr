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
   * docs/adr and core/completion/completion-ready-cleanup.ts `classifyCompletionReadyClosePolicy`.
   *
   * Accepted risk (issue #1526 Phase A review): this deliberately overrides
   * ask-first review for ANY task past the TTL, including one a human
   * happens to be mid-review on. Accepted for this incident — the operator
   * explicitly wants the drained tasks closed, and worktree cleanup already
   * preserves dirty/unmerged worktrees, so no work is lost even if review
   * hadn't finished.
   */
  completionReadyTtlMinutes: number;
  /**
   * Hung-task reaper (issue #1526 Phase A / FM6). When enabled, a task whose
   * agent has had zero hook events, zero pane-content change, and zero token
   * activity for {@link hungTaskReapMinutes} is treated as hung: its session
   * is killed, the task transitions to `terminated`, and its slot is freed.
   * Excludes any task with a pending signal or that the watchdog classifies
   * as waiting on the user/a permission — see hung-task-reaper.ts.
   *
   * Accepted risk (issue #1526 Phase A review): this ships enabled-by-default
   * directly onto the live incident. Accepted — a 3h all-channels-silent bar
   * is conservative, and the operator wants the hung task (20e2ddbd) reaped
   * automatically rather than requiring a manual opt-in first.
   */
  hungTaskReapEnabled: boolean;
  /** Minutes of total silence (all liveness channels) before a task is reaped. */
  hungTaskReapMinutes: number;
  /**
   * Hard ceiling (seconds) on a single adapter launch (issue #1526 Phase C /
   * #1528). `launchTaskCore` races `adapter.launch()` against this timeout;
   * on expiry the launch is failed with `LaunchTimeoutError`, the task record
   * is deleted and its `beginLaunch` reservation released — so a wedged
   * launcher (e.g. the 2026-07-25 CPU-saturation hang) can never hold a
   * capacity slot and a schedule's `reserved` execution for hours. Read via a
   * live getter, so a settings change applies to the next launch without a
   * restart.
   */
  launchTimeoutSeconds: number;
  /**
   * Dead-man switch window (minutes) for scheduled-task starvation (issue
   * #1526 Phase C). If fires were due within this window but no scheduled
   * execution was dispatched or completed — or any enabled schedule's last 3
   * consecutive outcomes are capacity/dispatch failures — the scheduler tick
   * raises one operational `alert` (severity warning) per starvation episode.
   * Alert-only by design in this phase: no self-heal action is taken.
   */
  deadManScheduleMinutes: number;
  /**
   * Per-schedule consecutive-failure alert threshold (issue #1665). When a
   * schedule's `consecutiveFailures` counter crosses this value (each terminal
   * run whose `lastRunStatus` is not `completed` increments it; a `completed`
   * run resets it), the schedule service emits one operational `alert`
   * (severity warning) through the dashboard alert channel, and a matching
   * `info` recovery alert when the schedule next completes. Read via a live
   * getter so a settings change applies to the next recorded run.
   */
  scheduleFailureAlertThreshold: number;
  /**
   * Pending-queue depth limit (issue #1526 Phase C / C3, FM3). During the
   * 2026-07-24 deadlock POST /api/tasks accepted unbounded creation: every
   * over-cap launch silently pended, so a runaway burst looked successful to
   * the caller while its tasks starved forever. When a launch would pend at
   * capacity AND the pending count is already at this limit, the launch is
   * rejected with HTTP 429 (REST) / a structured error (WS + CLI) carrying
   * the capacity-ledger snapshot, and a schedule fire records
   * `dispatch_failed` with reasonCode `pending_queue_full`. Read via a live
   * getter, so a settings change applies to the next launch.
   */
  maxPendingTasks: number;
  /**
   * Pending-task TTL (minutes), issue #1526 Phase C / C3. A task that has sat
   * in `pending` longer than this without ever launching is expired on the
   * liveness tick: cancelled (existing terminal status) with a structured
   * reason and an audit row (actor `system:pending-ttl`), freeing queue
   * depth. Applies equally to parented/chain tasks (`parentTaskId` set) —
   * a starving child of a live parent still expires.
   */
  pendingTaskTtlMinutes: number;
  /**
   * Per-source spawn budget (issue #1526 Phase C / C3): max task creations
   * allowed per launch source (cli/api/websocket/…, actor-qualified when the
   * `X-Kookr-Actor` header is present) within a sliding
   * {@link spawnBurstWindowMinutes} window. Exceeding it rejects the launch
   * with the same 429-with-ledger shape under code `spawn_burst_limit`.
   * Schedule-fired launches are exempt — they are operator-configured cadence
   * with their own coalescing (one outstanding queued fire per schedule) and
   * dead-man alerting, so a burst there indicates schedule config, not a
   * runaway caller, and rate-limiting them would convert planned periodic
   * work into dispatch failures.
   */
  spawnBurstLimit: number;
  /** Sliding-window size (minutes) for {@link spawnBurstLimit}. */
  spawnBurstWindowMinutes: number;
  /**
   * Reserved self-maintenance capacity (issue #1564). Number of
   * {@link maxActiveTasks} concurrency slots held back for privileged
   * launch sources listed in {@link reservedSlotSources}. A launch whose
   * source/actor is NOT privileged is admitted only while the active count is
   * below `maxActiveTasks - reservedActiveSlots`; at or above that it pends
   * instead of consuming a reserved slot. Privileged launches use the full
   * `maxActiveTasks`, so `reservedActiveSlots` slots are always available for
   * kookr self-maintenance even when a lucy-style burst has saturated the rest.
   * Read via a live getter, so a settings change applies to the next launch.
   * Clamped to 0..12; 0 disables the reservation.
   */
  reservedActiveSlots: number;
  /**
   * Launch source / actor identifiers privileged to consume the
   * {@link reservedActiveSlots} reserved slots (issue #1564). A launch is
   * privileged when its `launchSource` OR its attributed `launchActorId`
   * (the `X-Kookr-Actor` header) matches an entry here. Default `['kookr']`:
   * kookr self-maintenance batches attribute themselves as actor `kookr`, so
   * they keep the reservation while anonymous/lucy bursts do not. Entries are
   * trimmed; empty/blank entries and non-string values are dropped.
   */
  reservedSlotSources: string[];
  /**
   * Post-merge cleanup budget (minutes), issue #1560. A running task whose PR
   * has merged but whose post-merge cleanup tail (branch-delete push, CI-rerun
   * loops, waiting on input) drags on is auto-completed once this budget —
   * measured from when the merge was first observed — is exceeded, by raising
   * a `completion_ready` signal through the #1541 outbox and running the normal
   * completion lifecycle. Fires well before the hung-task reaper (~10-15m vs
   * hours), which stays the backstop. Read via a live getter, so a settings
   * change applies on the next liveness tick without a restart.
   */
  postMergeCleanupBudgetMinutes: number;
  /**
   * Global automation kill-switch (issue #1710 / #1699 WS0.4). When true,
   * autonomous actuation (schedule fires + schedule-sourced launches) is
   * halted; manual launches remain accepted. Distinct from drain mode (#659),
   * which refuses all new launches. Read via a live getter so engage/disengage
   * takes effect on the next schedule tick / launch without a restart.
   */
  automationKillSwitch: boolean;
  /**
   * ISO timestamp when the current SAFE MODE period began. Null while the
   * kill-switch is disengaged. Set on engage and preserved across unrelated
   * settings saves; cleared on disengage. Surfaces as
   * `SAFE MODE since <ts>` on `/api/health`, the dashboard banner, and the
   * status digest line.
   */
  safeModeSince: string | null;
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
  launchTimeoutSeconds: 180,
  deadManScheduleMinutes: 120,
  scheduleFailureAlertThreshold: 3,
  maxPendingTasks: 24,
  pendingTaskTtlMinutes: 240,
  spawnBurstLimit: 30,
  spawnBurstWindowMinutes: 10,
  reservedActiveSlots: 2,
  reservedSlotSources: ['kookr'],
  postMergeCleanupBudgetMinutes: 10,
  automationKillSwitch: false,
  safeModeSince: null,
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
// Launch timeout bounds (seconds), issue #1526 Phase C / #1528. Floor of 30
// keeps a slow-but-working cold launch (dtach spawn + agent boot + prompt
// delivery, worst observed ~20s) from being killed spuriously; ceiling of 900
// bounds even the most generous operator override — the incident's launches
// starved for HOURS, and 15 minutes is already far past any legitimate spawn.
const MIN_LAUNCH_TIMEOUT_SEC = 30;
const MAX_LAUNCH_TIMEOUT_SEC = 900;
// Dead-man schedule-starvation window bounds (minutes). Floor of 30 stays
// above the runner's 60s tick plus one schedule cadence so a single slow fire
// can't trip it; ceiling of 1440 (24h) keeps the switch meaningful.
const MIN_DEAD_MAN_SCHEDULE_MIN = 30;
const MAX_DEAD_MAN_SCHEDULE_MIN = 1440;
// Per-schedule consecutive-failure alert threshold (issue #1665). Floor of 1
// lets an operator alert on the very first failure; ceiling of 100 stops a
// fat-fingered value from silencing the alert entirely.
const MIN_SCHEDULE_FAILURE_ALERT_THRESHOLD = 1;
const MAX_SCHEDULE_FAILURE_ALERT_THRESHOLD = 100;
// Pending-queue depth bounds (issue #1526 Phase C / C3). Floor of 4 keeps the
// queue useful (a depth-0/1 queue would reject legitimate short bursts the cap
// absorbs within minutes); ceiling of 200 stops a fat-fingered value from
// re-creating the unbounded-queue failure mode this setting exists to fix.
const MIN_PENDING_TASKS = 4;
const MAX_PENDING_TASKS = 200;
// Pending-TTL bounds (minutes). Floor of 15 stays above a normal drain cycle
// (a healthy queue promotes within minutes) so the TTL never races routine
// promotion; ceiling of 2880 (48h) bounds how long a starving task can hold
// queue depth.
const MIN_PENDING_TTL_MIN = 15;
const MAX_PENDING_TTL_MIN = 2880;
// Per-source spawn-budget bounds (issue #1526 Phase C / C3). Limit floor of 5
// keeps interactive use workable; ceiling of 500 keeps the budget meaningful.
// Window floor of 1 minute, ceiling of 120 minutes (2h).
const MIN_SPAWN_BURST_LIMIT = 5;
const MAX_SPAWN_BURST_LIMIT = 500;
const MIN_SPAWN_BURST_WINDOW_MIN = 1;
const MAX_SPAWN_BURST_WINDOW_MIN = 120;
// Reserved self-maintenance slot bounds (issue #1564). Floor of 0 disables the
// reservation; ceiling of 12 keeps a fat-fingered value from swallowing an
// entire realistic `maxActiveTasks` (capped at 25) and starving general work.
// The launch admission path additionally clamps the effective reservation to
// `maxActiveTasks` at read time, so a reservation can never exceed the pool.
const MIN_RESERVED_ACTIVE_SLOTS = 0;
const MAX_RESERVED_ACTIVE_SLOTS = 12;
// Cap on the number of privileged reserved-slot source identifiers, mirroring
// the defensive bounds on other operator-supplied lists (e.g. reply snippets).
const MAX_RESERVED_SLOT_SOURCES = 20;
// Post-merge cleanup budget bounds (minutes), issue #1560. Floor of 1 keeps a
// minimum tail window (a merged PR's branch-delete push + snapshot settle);
// ceiling of 120 (2h) stays comfortably below the hung-task reaper's 180m
// default so this delivery-aware completion always fires first, and stops a
// fat-fingered value from effectively disabling it.
const MIN_POST_MERGE_CLEANUP_BUDGET_MIN = 1;
const MAX_POST_MERGE_CLEANUP_BUDGET_MIN = 120;

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

  let launchTimeoutSeconds = DEFAULT_SETTINGS.launchTimeoutSeconds;
  if (typeof raw.launchTimeoutSeconds === 'number' && Number.isFinite(raw.launchTimeoutSeconds)) {
    launchTimeoutSeconds = Math.max(
      MIN_LAUNCH_TIMEOUT_SEC,
      Math.min(MAX_LAUNCH_TIMEOUT_SEC, Math.round(raw.launchTimeoutSeconds)),
    );
  }

  let deadManScheduleMinutes = DEFAULT_SETTINGS.deadManScheduleMinutes;
  if (typeof raw.deadManScheduleMinutes === 'number' && Number.isFinite(raw.deadManScheduleMinutes)) {
    deadManScheduleMinutes = Math.max(
      MIN_DEAD_MAN_SCHEDULE_MIN,
      Math.min(MAX_DEAD_MAN_SCHEDULE_MIN, Math.round(raw.deadManScheduleMinutes)),
    );
  }

  let scheduleFailureAlertThreshold = DEFAULT_SETTINGS.scheduleFailureAlertThreshold;
  if (typeof raw.scheduleFailureAlertThreshold === 'number' && Number.isFinite(raw.scheduleFailureAlertThreshold)) {
    scheduleFailureAlertThreshold = Math.max(
      MIN_SCHEDULE_FAILURE_ALERT_THRESHOLD,
      Math.min(MAX_SCHEDULE_FAILURE_ALERT_THRESHOLD, Math.round(raw.scheduleFailureAlertThreshold)),
    );
  }

  let maxPendingTasks = DEFAULT_SETTINGS.maxPendingTasks;
  if (typeof raw.maxPendingTasks === 'number' && Number.isFinite(raw.maxPendingTasks)) {
    maxPendingTasks = Math.max(
      MIN_PENDING_TASKS,
      Math.min(MAX_PENDING_TASKS, Math.round(raw.maxPendingTasks)),
    );
  }

  let pendingTaskTtlMinutes = DEFAULT_SETTINGS.pendingTaskTtlMinutes;
  if (typeof raw.pendingTaskTtlMinutes === 'number' && Number.isFinite(raw.pendingTaskTtlMinutes)) {
    pendingTaskTtlMinutes = Math.max(
      MIN_PENDING_TTL_MIN,
      Math.min(MAX_PENDING_TTL_MIN, Math.round(raw.pendingTaskTtlMinutes)),
    );
  }

  let spawnBurstLimit = DEFAULT_SETTINGS.spawnBurstLimit;
  if (typeof raw.spawnBurstLimit === 'number' && Number.isFinite(raw.spawnBurstLimit)) {
    spawnBurstLimit = Math.max(
      MIN_SPAWN_BURST_LIMIT,
      Math.min(MAX_SPAWN_BURST_LIMIT, Math.round(raw.spawnBurstLimit)),
    );
  }

  let spawnBurstWindowMinutes = DEFAULT_SETTINGS.spawnBurstWindowMinutes;
  if (typeof raw.spawnBurstWindowMinutes === 'number' && Number.isFinite(raw.spawnBurstWindowMinutes)) {
    spawnBurstWindowMinutes = Math.max(
      MIN_SPAWN_BURST_WINDOW_MIN,
      Math.min(MAX_SPAWN_BURST_WINDOW_MIN, Math.round(raw.spawnBurstWindowMinutes)),
    );
  }

  let reservedActiveSlots = DEFAULT_SETTINGS.reservedActiveSlots;
  if (typeof raw.reservedActiveSlots === 'number' && Number.isFinite(raw.reservedActiveSlots)) {
    reservedActiveSlots = Math.max(
      MIN_RESERVED_ACTIVE_SLOTS,
      Math.min(MAX_RESERVED_ACTIVE_SLOTS, Math.round(raw.reservedActiveSlots)),
    );
  }

  let reservedSlotSources = DEFAULT_SETTINGS.reservedSlotSources;
  if (Array.isArray(raw.reservedSlotSources)) {
    const cleaned = raw.reservedSlotSources
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // De-duplicate (order-preserving) and cap the list length.
    reservedSlotSources = [...new Set(cleaned)].slice(0, MAX_RESERVED_SLOT_SOURCES);
  }

  let postMergeCleanupBudgetMinutes = DEFAULT_SETTINGS.postMergeCleanupBudgetMinutes;
  if (typeof raw.postMergeCleanupBudgetMinutes === 'number' && Number.isFinite(raw.postMergeCleanupBudgetMinutes)) {
    postMergeCleanupBudgetMinutes = Math.max(
      MIN_POST_MERGE_CLEANUP_BUDGET_MIN,
      Math.min(MAX_POST_MERGE_CLEANUP_BUDGET_MIN, Math.round(raw.postMergeCleanupBudgetMinutes)),
    );
  }

  const automationKillSwitch = typeof raw.automationKillSwitch === 'boolean'
    ? raw.automationKillSwitch
    : DEFAULT_SETTINGS.automationKillSwitch;

  // safeModeSince is only meaningful while engaged. Accept a parseable ISO
  // string; anything else collapses to null (or, when engaged without a
  // timestamp, leave null and let the update-path bookkeeping fill it in).
  let safeModeSince: string | null = null;
  if (automationKillSwitch && typeof raw.safeModeSince === 'string') {
    const parsed = Date.parse(raw.safeModeSince);
    if (Number.isFinite(parsed)) {
      safeModeSince = new Date(parsed).toISOString();
    }
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
      launchTimeoutSeconds,
      deadManScheduleMinutes,
      scheduleFailureAlertThreshold,
      maxPendingTasks,
      pendingTaskTtlMinutes,
      spawnBurstLimit,
      spawnBurstWindowMinutes,
      reservedActiveSlots,
      reservedSlotSources,
      postMergeCleanupBudgetMinutes,
      automationKillSwitch,
      safeModeSince,
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
