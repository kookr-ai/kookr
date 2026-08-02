/**
 * Post-task lesson decision gate + yield metric (issues #1538, #1608).
 *
 * The learning flywheel was offline because lesson authoring was voluntary
 * policy text — agents finished and signaled completion-ready without emitting
 * either a `kb remember` write or the explicit skip marker. This module:
 *
 *  1. Scans a task's pre-tool shell hook logs for a lesson decision
 *     (reuses {@link classifyKbCommand} / {@link aggregateLessonDecision}).
 *  2. Declares whether a `completion_ready` signal may proceed.
 *  3. Aggregates a per-window "lesson yield" (decided / completed tasks) so
 *     reflections can audit the flywheel without grepping the KB shelf.
 *
 * Detection source of truth: `~/.kookr/hooks/<tmuxSession>.jsonl` pre-tool
 * shell commands — same as `scripts/kb-usage-report.ts` / issue #227.
 *
 * Dual agent schemas (issue #1608): Claude Code writes snake_case
 * (`hook_event_name: PreToolUse`, `tool_name: Bash`, `tool_input.command`);
 * Grok Build writes camelCase (`hookEventName: pre_tool_use`,
 * `toolName: run_terminal_command`, `toolInput.command`). Scanning only the
 * Claude shape made every Grok completion look like `noKbActivity` even when
 * the agent wrote a lesson or printed the skip marker — the silent-bypass
 * hole that reopened the flywheel gap.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  aggregateLessonDecision,
  classifyKbCommand,
  KB_LESSON_SKIP_MARKER,
  type LessonDecisionCounts,
  type LessonDecisionState,
} from './kb-lesson-classifier.js';

export { KB_LESSON_SKIP_MARKER };
export type { LessonDecisionCounts, LessonDecisionState };

/** Machine-readable 409 body code when completion-ready is refused (logs present). */
export const LESSON_DECISION_REQUIRED_CODE = 'lesson_decision_required' as const;

/**
 * Distinct 409 code when every session hook log is missing on disk
 * (pruned/rotated or never written) so operators can distinguish
 * maintenance prune from a missed lesson step (issue #1868). Still
 * fail-closed — same lifecycle block, different diagnosis.
 */
export const LESSON_DECISION_HOOKS_MISSING_CODE = 'lesson_decision_hooks_missing' as const;

export type LessonDecisionGateCode =
  | typeof LESSON_DECISION_REQUIRED_CODE
  | typeof LESSON_DECISION_HOOKS_MISSING_CODE;

/** v2 adds per-completion-path buckets + gateExempt accounting (issue #1608). */
export const LESSON_YIELD_SCHEMA_VERSION = 'lesson-yield.v2' as const;

/**
 * How a task reached terminal-complete. Stamped at completion time so yield
 * can join decision buckets onto the path that produced them (issue #1608).
 *
 * - `normal` — completion_ready via HTTP signal path (gated), then auto-close
 *   or manual ack.
 * - `outbox_drained` — completion_ready applied by the #1541 outbox drain
 *   (in-process, not HTTP), then auto-close/ack.
 * - `recovery` — system reaper / TTL / hung-task paths.
 * - `api_complete` — `POST /api/tasks/:id/complete` without a prior signal
 *   (self-complete / zombie reaps from orchestrating agents).
 * - `ui_complete` — dashboard/WS Complete.
 * - `other` / `unknown` — unstamped historical rows or unclassified actors.
 */
export const COMPLETION_PATHS = [
  'normal',
  'outbox_drained',
  'recovery',
  'api_complete',
  'ui_complete',
  'other',
  'unknown',
] as const;
export type CompletionPath = (typeof COMPLETION_PATHS)[number];

export function isCompletionPath(value: unknown): value is CompletionPath {
  return typeof value === 'string' && (COMPLETION_PATHS as readonly string[]).includes(value);
}

/**
 * Infer the completion path from actor + pending-signal provenance. Pure —
 * callers stamp the result onto the task at complete time.
 */
export function resolveCompletionPath(input: {
  explicit?: CompletionPath;
  hadPendingCompletionReady?: boolean;
  signalSource?: 'http' | 'outbox';
  actorSource?: string;
}): CompletionPath {
  if (input.explicit && isCompletionPath(input.explicit)) return input.explicit;
  if (input.hadPendingCompletionReady) {
    return input.signalSource === 'outbox' ? 'outbox_drained' : 'normal';
  }
  const src = (input.actorSource ?? '').toLowerCase();
  if (src === 'ui' || src === 'websocket' || src.startsWith('ws')) return 'ui_complete';
  if (src.startsWith('system:') || src === 'recovery' || src === 'reaper') return 'recovery';
  if (src === 'api' || src.startsWith('api:')) return 'api_complete';
  if (!src) return 'unknown';
  return 'other';
}

/** Default gateExempt reason when a non-signal completion has no lesson decision. */
export function defaultLessonGateExempt(path: CompletionPath): string {
  switch (path) {
    case 'ui_complete':
      return 'human_complete';
    case 'recovery':
      return 'recovery_reap';
    case 'api_complete':
      return 'api_complete_ungated';
    case 'outbox_drained':
      return 'outbox_drained_undecided';
    case 'normal':
      return 'signal_auto_close_undecided';
    case 'other':
      return 'other_ungated';
    case 'unknown':
    default:
      return 'unspecified';
  }
}

/**
 * Stamp completionPath (+ optional lessonGateExempt) onto a mutable task
 * immediately before it transitions to completed. Pure field writes.
 *
 * When the task still has a pending `completion_ready` signal, the path is
 * derived from that signal's provenance (http → normal, outbox →
 * outbox_drained) and no exempt is stamped (the signal path is gated).
 * Direct completes without a signal get a path from the actor and a
 * default exempt reason so yield contractRate can count them as explained
 * rather than silent bypasses (issue #1608).
 */
export function stampTaskCompletionProvenance(
  task: {
    pendingSignal?: { kind?: string; source?: 'http' | 'outbox' };
    completionPath?: CompletionPath | string;
    lessonGateExempt?: string;
  },
  input: {
    explicitPath?: CompletionPath;
    actorSource?: string;
    /**
     * When true, the caller already verified a lesson decision — never stamp
     * an exempt reason even if the path is non-signal.
     */
    decisionSatisfied?: boolean;
    /** Override the default exempt reason for non-signal completes. */
    gateExempt?: string;
  } = {},
): { completionPath: CompletionPath; lessonGateExempt?: string } {
  const hadReady = task.pendingSignal?.kind === 'completion_ready';
  const path = resolveCompletionPath({
    explicit: input.explicitPath,
    hadPendingCompletionReady: hadReady,
    signalSource: task.pendingSignal?.source,
    actorSource: input.actorSource,
  });
  task.completionPath = path;

  if (hadReady || input.decisionSatisfied === true) {
    delete task.lessonGateExempt;
    return { completionPath: path };
  }

  const exempt = (input.gateExempt?.trim() || defaultLessonGateExempt(path));
  task.lessonGateExempt = exempt;
  return { completionPath: path, lessonGateExempt: exempt };
}

/** Shell tools whose `command` field can carry a lesson decision. */
const SHELL_TOOL_NAMES = new Set([
  'Bash', // Claude Code
  'run_terminal_command', // Grok Build
  'shell',
]);

/** Pre-tool hook event names across agent runtimes. */
const PRE_TOOL_EVENTS = new Set([
  'PreToolUse', // Claude Code (PascalCase)
  'pre_tool_use', // Grok Build (snake_case value)
]);

/**
 * Extract a shell command from one hook JSONL line, accepting both Claude
 * Code (snake_case) and Grok Build (camelCase) payload shapes.
 * Returns null when the line is not a pre-tool shell invocation.
 */
export function extractShellCommandFromHookLine(evt: {
  hook_event_name?: unknown;
  hookEventName?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
  tool_input?: unknown;
  toolInput?: unknown;
}): string | null {
  const hookEvent = evt.hook_event_name ?? evt.hookEventName;
  const toolName = evt.tool_name ?? evt.toolName;
  if (typeof hookEvent !== 'string' || typeof toolName !== 'string') return null;
  if (!PRE_TOOL_EVENTS.has(hookEvent) || !SHELL_TOOL_NAMES.has(toolName)) return null;
  const toolInput = evt.tool_input ?? evt.toolInput;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const command = (toolInput as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

/** Env escape hatch for hermetic tests / emergency ops. Values: `0`/`false`/`off`. */
export const LESSON_DECISION_GATE_ENV = 'KOOKR_LESSON_DECISION_GATE';

export interface HookLogLessonStats extends LessonDecisionCounts {
  kbCalls: number;
  bashCalls: number;
  exists: boolean;
}

export interface TaskLessonDecisionResult {
  decision: LessonDecisionState;
  counts: LessonDecisionCounts;
  /** Sessions that listed a tmuxSession but had no hook log on disk. */
  missingLogs: number;
  /** Sessions considered (with a non-empty tmuxSession). */
  sessionsScanned: number;
  satisfied: boolean;
}

export interface LessonDecisionGateInput {
  /** When false, the gate is bypassed (env kill-switch or test seam). */
  enabled?: boolean;
  /**
   * Number of sessions with a tmuxSession name. Tasks that never launched
   * (no sessions) cannot have logged a decision — fail-open so unit fixtures
   * and pre-launch edge cases are not blocked. Real completion-ready signals
   * always have at least one session.
   */
  sessionsScanned: number;
  decision: LessonDecisionState;
  /**
   * Sessions whose hook log was missing or unsafe (from
   * {@link resolveTaskLessonDecision}). When every scanned session is missing
   * (`missingLogs === sessionsScanned > 0`), the 409 uses
   * {@link LESSON_DECISION_HOOKS_MISSING_CODE} instead of
   * {@link LESSON_DECISION_REQUIRED_CODE} so operators can tell pruned/rotated
   * logs from a missed lesson step (issue #1868). Default 0.
   */
  missingLogs?: number;
}

export interface LessonDecisionGateVerdict {
  allow: boolean;
  code?: LessonDecisionGateCode;
  reason: string;
  decision: LessonDecisionState;
  hint?: string;
  /** Echoed when set so 409 bodies can surface coverage diagnostics. */
  missingLogs?: number;
  sessionsScanned?: number;
}

export const LESSON_DECISION_HINT =
  `Emit a post-task lesson decision in the Bash hook trail, then re-signal. `
  + `Either: cat <<'EOF' | kb remember --kb=agent-task-lessons --title="<headline>" --stdin --yes … `
  + `or: printf '${KB_LESSON_SKIP_MARKER} %s\\n' '<one-line reason>'.`;

/**
 * Hint when all session hook logs are absent — points at prune/rotation
 * rather than telling the agent to re-emit a decision into a missing trail.
 */
export const LESSON_DECISION_HOOKS_MISSING_HINT =
  `All session hook logs are missing on disk (pruned, rotated, or never written). `
  + `Check hook retention/rotation under ~/.kookr/hooks and whether maintenance `
  + `swept live <session>.jsonl files. Fail-closed: re-emit a lesson decision `
  + `into a fresh shell so a live log exists, then re-signal completion-ready. `
  + `Either: cat <<'EOF' | kb remember --kb=agent-task-lessons --title="<headline>" --stdin --yes … `
  + `or: printf '${KB_LESSON_SKIP_MARKER} %s\\n' '<one-line reason>'.`;

export function isLessonDecisionSatisfied(decision: LessonDecisionState): boolean {
  return decision === 'wrote-lesson' || decision === 'explicit-skip';
}

/**
 * Pure gate. Fail-open when disabled or when the task has no sessions
 * (cannot have produced hook evidence). Fail-closed when sessions exist but
 * neither a lesson write nor an explicit skip is visible in the hook trail.
 *
 * When every scanned session has a missing log (`missingLogs ===
 * sessionsScanned > 0`), still fail-closed but with
 * {@link LESSON_DECISION_HOOKS_MISSING_CODE} so operators can distinguish
 * maintenance prune from a missed lesson step (issue #1868).
 */
export function evaluateLessonDecisionGate(
  input: LessonDecisionGateInput,
): LessonDecisionGateVerdict {
  if (input.enabled === false) {
    return {
      allow: true,
      reason: 'Lesson-decision gate disabled.',
      decision: input.decision,
    };
  }
  if (input.sessionsScanned === 0) {
    return {
      allow: true,
      reason: 'No agent sessions — lesson decision not required (fail-open).',
      decision: input.decision,
    };
  }
  if (isLessonDecisionSatisfied(input.decision)) {
    return {
      allow: true,
      reason:
        input.decision === 'wrote-lesson'
          ? 'Lesson write observed in hook trail.'
          : 'Explicit no-lesson skip observed in hook trail.',
      decision: input.decision,
    };
  }

  const missingLogs = input.missingLogs ?? 0;
  // All logs gone → distinct diagnosis (still 409 / fail-closed).
  if (missingLogs === input.sessionsScanned && missingLogs > 0) {
    return {
      allow: false,
      code: LESSON_DECISION_HOOKS_MISSING_CODE,
      reason:
        `All ${missingLogs} session hook log(s) are missing on disk `
        + `(pruned, rotated, or never written) — cannot verify a post-task lesson decision.`,
      decision: input.decision,
      hint: LESSON_DECISION_HOOKS_MISSING_HINT,
      missingLogs,
      sessionsScanned: input.sessionsScanned,
    };
  }

  return {
    allow: false,
    code: LESSON_DECISION_REQUIRED_CODE,
    reason:
      input.decision === 'search-only'
        ? 'Task used kb search but never recorded a post-task lesson decision.'
        : 'Task completed without a post-task lesson decision (no kb activity).',
    decision: input.decision,
    hint: LESSON_DECISION_HINT,
    missingLogs,
    sessionsScanned: input.sessionsScanned,
  };
}

/** Whether the env kill-switch disables the gate. Default: enabled. */
export function isLessonDecisionGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[LESSON_DECISION_GATE_ENV];
  if (raw === undefined || raw === '') return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no');
}

export function emptyHookLogLessonStats(): HookLogLessonStats {
  return {
    kbCalls: 0,
    bashCalls: 0,
    lessonWrites: 0,
    lessonSkips: 0,
    kbSearches: 0,
    exists: false,
  };
}

/** Options accepted by the hook-log scanners (issue #1553). */
export interface HookLogScanOptions {
  /**
   * Aborts the scan (rejecting with `signal.reason`, e.g. a TimeoutError from
   * `AbortSignal.timeout`). The scan result is incomplete on abort, so callers
   * must treat the rejection as "unknown", never as "no decision".
   */
  signal?: AbortSignal;
}

/**
 * Scan one hook JSONL file for lesson-decision signals.
 * Only pre-tool shell lines are considered (Claude `PreToolUse`/`Bash` and
 * Grok `pre_tool_use`/`run_terminal_command` — issue #1608). Early-exits
 * after the first decisive write (strongest signal) to bound latency on
 * large rotated-era live files.
 *
 * The underlying read stream is always destroyed, including on the
 * early-break path — `rl.close()` alone leaves the file descriptor pinned
 * open, which leaked fds on every health-poll scan (issue #1553 / prod OOM
 * of 2026-07-26).
 */
export async function scanHookLogForLessonDecision(
  path: string,
  opts: HookLogScanOptions = {},
): Promise<HookLogLessonStats> {
  opts.signal?.throwIfAborted();
  if (!existsSync(path)) return emptyHookLogLessonStats();

  let kbCalls = 0;
  let bashCalls = 0;
  let lessonWrites = 0;
  let lessonSkips = 0;
  let kbSearches = 0;

  // The signal is wired into the stream itself, not only the per-line check:
  // readline buffers a whole line before yielding, so one pathological line
  // (corrupt log, giant tool_input) would otherwise be read in full — and
  // blow the scan bound — before the loop ever sees the abort.
  const stream = createReadStream(path, { encoding: 'utf8', signal: opts.signal });
  const rl = createInterface({ input: stream });
  try {
    for await (const line of rl) {
      opts.signal?.throwIfAborted();
      if (!line) continue;
      let evt: {
        hook_event_name?: unknown;
        hookEventName?: unknown;
        tool_name?: unknown;
        toolName?: unknown;
        tool_input?: unknown;
        toolInput?: unknown;
      };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        continue;
      }
      const cmd = extractShellCommandFromHookLine(evt);
      if (cmd === null) continue;
      bashCalls++;
      if (cmd.includes('kb ')) kbCalls++;
      switch (classifyKbCommand(cmd)) {
        case 'lesson-write':
          lessonWrites++;
          break;
        case 'lesson-skip':
          lessonSkips++;
          break;
        case 'kb-search':
          kbSearches++;
          break;
        case 'none':
          break;
      }
      // Strongest signal already present — further lines cannot change the
      // aggregate decision for this file (wrote-lesson wins over skip).
      if (lessonWrites > 0) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    kbCalls,
    bashCalls,
    lessonWrites,
    lessonSkips,
    kbSearches,
    exists: true,
  };
}

export interface TaskSessionLike {
  tmuxSession?: string;
}

export interface TaskLikeForLessonDecision {
  id: string;
  sessions?: TaskSessionLike[];
  status?: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
  playbookId?: string;
  prompt?: string;
  /** Stamped at complete time (issue #1608). Absent → counted under `unknown`. */
  completionPath?: CompletionPath | string;
  /**
   * Why an undecided completion was allowed to reach terminal-complete
   * (issue #1608). Empty when the task decided (wrote/skip) or was never
   * stamped. Used for the contract-rate denominator alternative.
   */
  lessonGateExempt?: string;
}

export function hooksDirFromKookrDir(kookrDir: string): string {
  return join(kookrDir, 'hooks');
}

/**
 * Same shape as other session-id guards in the codebase (activity-ledger,
 * effective-hook-settings, LocalDtachBackend). Rejects path traversal and
 * other characters that must never reach `join(hooksDir, …)`.
 */
export const SAFE_HOOK_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeHookSessionId(tmuxSession: string): boolean {
  return SAFE_HOOK_SESSION_ID_RE.test(tmuxSession);
}

/**
 * Resolve the hook log path for a session, or `null` when the session name
 * is unsafe (would escape hooksDir or open an unexpected path).
 */
export function hookLogPath(hooksDir: string, tmuxSession: string): string | null {
  if (!isSafeHookSessionId(tmuxSession)) return null;
  return join(hooksDir, `${tmuxSession}.jsonl`);
}

/** Aggregate lesson-decision state across every session of a task. */
export async function resolveTaskLessonDecision(
  task: TaskLikeForLessonDecision,
  hooksDir: string,
  opts: HookLogScanOptions = {},
): Promise<TaskLessonDecisionResult> {
  let lessonWrites = 0;
  let lessonSkips = 0;
  let kbSearches = 0;
  let missingLogs = 0;
  let sessionsScanned = 0;

  for (const session of task.sessions ?? []) {
    opts.signal?.throwIfAborted();
    const name = session.tmuxSession?.trim();
    if (!name) continue;
    sessionsScanned++;
    const path = hookLogPath(hooksDir, name);
    if (!path) {
      // Unsafe name: treat as missing log so a crafted session id cannot
      // open arbitrary files or inject a fake decision from outside hooksDir.
      missingLogs++;
      continue;
    }
    const stats = await scanHookLogForLessonDecision(path, opts);
    if (!stats.exists) missingLogs++;
    lessonWrites += stats.lessonWrites;
    lessonSkips += stats.lessonSkips;
    kbSearches += stats.kbSearches;
  }

  const counts: LessonDecisionCounts = { lessonWrites, lessonSkips, kbSearches };
  const decision = aggregateLessonDecision(counts);
  return {
    decision,
    counts,
    missingLogs,
    sessionsScanned,
    satisfied: isLessonDecisionSatisfied(decision),
  };
}

export interface LessonYieldBucket {
  wroteLesson: number;
  explicitSkip: number;
  searchOnly: number;
  noKbActivity: number;
}

export function emptyLessonYieldBucket(): LessonYieldBucket {
  return {
    wroteLesson: 0,
    explicitSkip: 0,
    searchOnly: 0,
    noKbActivity: 0,
  };
}

/** Per-path rollup: decision buckets + counts (issue #1608). */
export interface LessonYieldPathBucket extends LessonYieldBucket {
  completed: number;
  decided: number;
  /** Undecided completions that carry an explicit `lessonGateExempt` reason. */
  gateExempt: number;
}

export function emptyLessonYieldPathBucket(): LessonYieldPathBucket {
  return {
    ...emptyLessonYieldBucket(),
    completed: 0,
    decided: 0,
    gateExempt: 0,
  };
}

export interface LessonYieldSnapshot {
  schemaVersion: typeof LESSON_YIELD_SCHEMA_VERSION;
  /** ISO timestamp when the snapshot was computed. */
  generatedAt: string;
  /** Window length in days (as requested). */
  windowDays: number;
  /** Inclusive lower bound (ms since epoch). */
  windowStartMs: number;
  /** Tasks whose updatedAt falls inside the window. */
  tasksInWindow: number;
  /**
   * Subset of tasksInWindow with terminal status completed (or completed_with_errors).
   * Yield denominator — "per completed task".
   */
  completedInWindow: number;
  /**
   * Completed tasks that had at least one session hook log we could open
   * (partial coverage still counts). Used as a softer denominator when many
   * tasks have zero sessions.
   */
  completedWithLogs: number;
  buckets: LessonYieldBucket;
  /**
   * lessons + no-lesson declarations among completed tasks.
   * Primary flywheel metric from issue #1538.
   */
  decided: number;
  /**
   * decided / completedInWindow (0 when denominator is 0).
   * Target: ≥ 1.0 (every completed task either wrote a lesson or declared skip).
   */
  yieldRate: number;
  /**
   * decided / completedWithLogs when > 0, else 0.
   * Useful when many completed tasks never launched a session.
   */
  yieldRateAmongLogged: number;
  /**
   * Per-completion-path decision buckets (issue #1608). Keys are
   * {@link CompletionPath} values; only paths observed in the window appear.
   */
  byCompletionPath: Record<string, LessonYieldPathBucket>;
  /**
   * Counts of undecided completions keyed by `lessonGateExempt` reason code.
   * Empty object when every undecided row lacks a stamp.
   */
  gateExemptReasons: Record<string, number>;
  /**
   * Undecided completions that carry any non-empty `lessonGateExempt`.
   * Together with `decided`, this is the numerator of {@link contractRate}.
   */
  explainedExceptions: number;
  /**
   * (decided + explainedExceptions) / completedInWindow.
   * Target after #1608: ≥ 0.9 — every completion either decided or named an
   * exemption reason rather than silently skipping the gate.
   */
  contractRate: number;
}

export interface ComputeLessonYieldOptions {
  /** Window length in whole days (default 1). */
  days?: number;
  nowMs?: number;
  /**
   * Which statuses count as "completed" for the yield denominator.
   * Default: completed + completed_with_errors.
   */
  completedStatuses?: ReadonlySet<string>;
  /**
   * Aborts the aggregation (rejecting with `signal.reason`). Callers on
   * request paths MUST bound the scan — e.g. `AbortSignal.timeout(...)` —
   * because the corpus under `hooksDir` can be gigabytes (issue #1553).
   */
  signal?: AbortSignal;
}

const DEFAULT_COMPLETED = new Set(['completed', 'completed_with_errors']);

function taskTimestampMs(task: TaskLikeForLessonDecision): number {
  const raw = task.updatedAt ?? task.createdAt;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/**
 * Compute lesson yield over tasks in a recent window by scanning their hook logs.
 * Pure aggregation — no network. Safe for diagnostics endpoints (bound by
 * task count × log size; callers should cache if polling frequently).
 */
export async function computeLessonYield(
  tasks: readonly TaskLikeForLessonDecision[],
  hooksDir: string,
  opts: ComputeLessonYieldOptions = {},
): Promise<LessonYieldSnapshot> {
  opts.signal?.throwIfAborted();
  const days = Math.max(1, Math.floor(opts.days ?? 1));
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - days * 86_400_000;
  const completedStatuses = opts.completedStatuses ?? DEFAULT_COMPLETED;

  const buckets = emptyLessonYieldBucket();
  const byCompletionPath: Record<string, LessonYieldPathBucket> = {};
  const gateExemptReasons: Record<string, number> = {};

  let tasksInWindow = 0;
  let completedInWindow = 0;
  let completedWithLogs = 0;
  let decided = 0;
  let explainedExceptions = 0;

  for (const task of tasks) {
    opts.signal?.throwIfAborted();
    const ts = taskTimestampMs(task);
    if (!Number.isFinite(ts) || ts < windowStartMs) continue;
    tasksInWindow++;

    const status = task.status ?? '';
    if (!completedStatuses.has(status)) continue;
    completedInWindow++;

    const resolved = await resolveTaskLessonDecision(task, hooksDir, { signal: opts.signal });
    // Count "has log" when any session log existed, or when sessionsScanned==0
    // we still attribute the decision (no-kb-activity) but do not inflate
    // completedWithLogs.
    if (resolved.sessionsScanned > 0 && resolved.missingLogs < resolved.sessionsScanned) {
      completedWithLogs++;
    }

    const pathKey = isCompletionPath(task.completionPath) ? task.completionPath : 'unknown';
    const pathBucket = byCompletionPath[pathKey] ?? emptyLessonYieldPathBucket();
    pathBucket.completed++;

    let taskDecided = false;
    switch (resolved.decision) {
      case 'wrote-lesson':
        buckets.wroteLesson++;
        pathBucket.wroteLesson++;
        decided++;
        pathBucket.decided++;
        taskDecided = true;
        break;
      case 'explicit-skip':
        buckets.explicitSkip++;
        pathBucket.explicitSkip++;
        decided++;
        pathBucket.decided++;
        taskDecided = true;
        break;
      case 'search-only':
        buckets.searchOnly++;
        pathBucket.searchOnly++;
        break;
      case 'no-kb-activity':
        buckets.noKbActivity++;
        pathBucket.noKbActivity++;
        break;
    }

    if (!taskDecided) {
      const exempt = typeof task.lessonGateExempt === 'string' ? task.lessonGateExempt.trim() : '';
      if (exempt) {
        explainedExceptions++;
        pathBucket.gateExempt++;
        gateExemptReasons[exempt] = (gateExemptReasons[exempt] ?? 0) + 1;
      }
    }

    byCompletionPath[pathKey] = pathBucket;
  }

  const yieldRate = completedInWindow > 0 ? decided / completedInWindow : 0;
  const yieldRateAmongLogged = completedWithLogs > 0 ? decided / completedWithLogs : 0;
  const contractRate =
    completedInWindow > 0 ? (decided + explainedExceptions) / completedInWindow : 0;

  return {
    schemaVersion: LESSON_YIELD_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    windowStartMs,
    tasksInWindow,
    completedInWindow,
    completedWithLogs,
    buckets,
    decided,
    yieldRate,
    yieldRateAmongLogged,
    byCompletionPath,
    gateExemptReasons,
    explainedExceptions,
    contractRate,
  };
}
