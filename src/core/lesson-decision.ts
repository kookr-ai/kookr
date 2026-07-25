/**
 * Post-task lesson decision gate + yield metric (issue #1538).
 *
 * The learning flywheel was offline because lesson authoring was voluntary
 * policy text — agents finished and signaled completion-ready without emitting
 * either a `kb remember` write or the explicit skip marker. This module:
 *
 *  1. Scans a task's PreToolUse Bash hook logs for a lesson decision
 *     (reuses {@link classifyKbCommand} / {@link aggregateLessonDecision}).
 *  2. Declares whether a `completion_ready` signal may proceed.
 *  3. Aggregates a per-window "lesson yield" (decided / completed tasks) so
 *     reflections can audit the flywheel without grepping the KB shelf.
 *
 * Detection source of truth: `~/.kookr/hooks/<tmuxSession>.jsonl` PreToolUse
 * Bash commands — same as `scripts/kb-usage-report.ts` / issue #227.
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

/** Machine-readable 409 body code when completion-ready is refused. */
export const LESSON_DECISION_REQUIRED_CODE = 'lesson_decision_required' as const;

export const LESSON_YIELD_SCHEMA_VERSION = 'lesson-yield.v1' as const;

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
}

export interface LessonDecisionGateVerdict {
  allow: boolean;
  code?: typeof LESSON_DECISION_REQUIRED_CODE;
  reason: string;
  decision: LessonDecisionState;
  hint?: string;
}

export const LESSON_DECISION_HINT =
  `Emit a post-task lesson decision in the Bash hook trail, then re-signal. `
  + `Either: cat <<'EOF' | kb remember --kb=agent-task-lessons --title="<headline>" --stdin --yes … `
  + `or: printf '${KB_LESSON_SKIP_MARKER} %s\\n' '<one-line reason>'.`;

export function isLessonDecisionSatisfied(decision: LessonDecisionState): boolean {
  return decision === 'wrote-lesson' || decision === 'explicit-skip';
}

/**
 * Pure gate. Fail-open when disabled or when the task has no sessions
 * (cannot have produced hook evidence). Fail-closed when sessions exist but
 * neither a lesson write nor an explicit skip is visible in the hook trail.
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
  return {
    allow: false,
    code: LESSON_DECISION_REQUIRED_CODE,
    reason:
      input.decision === 'search-only'
        ? 'Task used kb search but never recorded a post-task lesson decision.'
        : 'Task completed without a post-task lesson decision (no kb activity).',
    decision: input.decision,
    hint: LESSON_DECISION_HINT,
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

/**
 * Scan one hook JSONL file for lesson-decision signals.
 * Only PreToolUse Bash lines are considered (same rule as kb-usage-report).
 * Early-exits once both a write and a skip have been seen is unnecessary —
 * we stop counting after the first decisive write (strongest signal) to
 * bound latency on large rotated-era live files.
 */
export async function scanHookLogForLessonDecision(
  path: string,
): Promise<HookLogLessonStats> {
  if (!existsSync(path)) return emptyHookLogLessonStats();

  let kbCalls = 0;
  let bashCalls = 0;
  let lessonWrites = 0;
  let lessonSkips = 0;
  let kbSearches = 0;

  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let evt: {
        hook_event_name?: string;
        tool_name?: string;
        tool_input?: { command?: string };
      };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        continue;
      }
      if (evt.hook_event_name !== 'PreToolUse' || evt.tool_name !== 'Bash') continue;
      bashCalls++;
      const cmd = evt.tool_input?.command ?? '';
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
): Promise<TaskLessonDecisionResult> {
  let lessonWrites = 0;
  let lessonSkips = 0;
  let kbSearches = 0;
  let missingLogs = 0;
  let sessionsScanned = 0;

  for (const session of task.sessions ?? []) {
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
    const stats = await scanHookLogForLessonDecision(path);
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
  const days = Math.max(1, Math.floor(opts.days ?? 1));
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - days * 86_400_000;
  const completedStatuses = opts.completedStatuses ?? DEFAULT_COMPLETED;

  const buckets: LessonYieldBucket = {
    wroteLesson: 0,
    explicitSkip: 0,
    searchOnly: 0,
    noKbActivity: 0,
  };

  let tasksInWindow = 0;
  let completedInWindow = 0;
  let completedWithLogs = 0;
  let decided = 0;

  for (const task of tasks) {
    const ts = taskTimestampMs(task);
    if (!Number.isFinite(ts) || ts < windowStartMs) continue;
    tasksInWindow++;

    const status = task.status ?? '';
    if (!completedStatuses.has(status)) continue;
    completedInWindow++;

    const resolved = await resolveTaskLessonDecision(task, hooksDir);
    // Count "has log" when any session log existed, or when sessionsScanned==0
    // we still attribute the decision (no-kb-activity) but do not inflate
    // completedWithLogs.
    if (resolved.sessionsScanned > 0 && resolved.missingLogs < resolved.sessionsScanned) {
      completedWithLogs++;
    }

    switch (resolved.decision) {
      case 'wrote-lesson':
        buckets.wroteLesson++;
        decided++;
        break;
      case 'explicit-skip':
        buckets.explicitSkip++;
        decided++;
        break;
      case 'search-only':
        buckets.searchOnly++;
        break;
      case 'no-kb-activity':
        buckets.noKbActivity++;
        break;
    }
  }

  const yieldRate = completedInWindow > 0 ? decided / completedInWindow : 0;
  const yieldRateAmongLogged = completedWithLogs > 0 ? decided / completedWithLogs : 0;

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
  };
}
