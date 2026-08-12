/**
 * Pure host-stale dtach selection policy (issues #2352, #2356, #2384).
 *
 * Host-stale masters — process-table `kookr-dtach` that are not live-attached
 * and whose socket is gone — accumulate outside both `staleProcesses.dtach`
 * visibility and the session reaper (#1720), which only reaps sessions the
 * backend still reports as live.
 *
 * This module is pure: it classifies already-observed facts into a reap
 * verdict and plans a bounded sweep. No process kill, no `/proc` I/O. The
 * server janitor (`host-stale-dtach-reaper`) calls
 * {@link planHostStaleDtachReap} and acts only on `toReap` pids.
 *
 * Fail-closed rules (exhaustive):
 *  1. Live session id present → never
 *  2. Socket still present → never (session reaper / attach lifecycle own those)
 *  3. Unknown age → skip (cannot prove a teardown race is past)
 *  4. Missing socket + aged past minAge → candidate (`missing_socket_aged`)
 *  5. Missing socket but too young → skip (teardown race)
 *  6. Unparseable session id is allowed when other signals are strong; live-set
 *     checks only apply when a session id is known
 *
 * Always-select class (#2384): `missing_socket_aged` is already fail-closed
 * (not live, socket gone, past min age). It is selected even when the host
 * dtach count is below the soft bound — proven zombies must not wait for
 * unrelated concurrent load. Soft-bound pressure gating is reserved for any
 * future more-aggressive classes. Rate limit: at most `maxReapsPerSweep`
 * pids per plan (always applies).
 */

import { isKookrDtachMasterCmdline } from './orphan-process-scanner.js';
import { DEFAULT_DTACH_PRESSURE_SOFT_BOUND } from './resource-watchdog-eval.js';

/** Default minimum age (ms) before a missing-socket master may be selected. */
export const DEFAULT_DTACH_ORPHAN_MIN_AGE_MS = 60_000;

/** Default max masters a single host-stale sweep may select (issue #2356). */
export const DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP = 5;

/**
 * Observed facts about one kookr-dtach master process, as assembled by a
 * future scanner/janitor (or a test fixture). All fields are pure inputs —
 * the policy never re-probes the host.
 */
export interface DtachOrphanCandidate {
  pid: number;
  /**
   * Session id derived from the socket basename (e.g. `kookr-abc` from
   * `…/kookr-abc.sock`), or `null` when the cmdline could not be parsed.
   */
  sessionId: string | null;
  /** Absolute socket path when known, else null. */
  socketPath: string | null;
  /** Whether the socket file still exists on disk. */
  socketExists: boolean;
  /**
   * Whether `sessionId` is present in the live session inventory (backend
   * list / TaskStore live set). When `sessionId` is null this MUST be false —
   * an unknown id cannot prove liveness.
   */
  liveSessionPresent: boolean;
  /** Age in ms (now − process start), or null when start time is unknown. */
  ageMs: number | null;
}

export interface DtachOrphanReapPolicy {
  /**
   * Minimum age (ms) before a missing-socket master may be reaped. Defaults to
   * {@link DEFAULT_DTACH_ORPHAN_MIN_AGE_MS}. Protects against a teardown race
   * where the socket is briefly unlinked before the master exits.
   */
  minAgeMs?: number;
}

/** Stable skip / select reasons for audit and counters. */
export type DtachOrphanReapReason =
  | 'live_session'
  | 'socket_present'
  | 'unknown_age'
  | 'too_young'
  | 'missing_socket_aged';

export interface DtachOrphanReapVerdict {
  shouldReap: boolean;
  reason: DtachOrphanReapReason;
  /** Echo of the candidate pid for audit correlation. */
  pid: number;
  /** Effective age used for the age gate, or null when unknown. */
  ageMs: number | null;
  /** Human-readable justification (audit / dry-run logs). */
  detail: string;
}

/**
 * Extract a kookr-dtach socket path from a process command line.
 * Returns null when no `…/kookr-dtach/…/*.sock` token is present.
 */
export function extractKookrDtachSocketPath(cmdline: string): string | null {
  if (!cmdline || !cmdline.includes('kookr-dtach')) return null;
  for (const token of cmdline.split(/\s+/)) {
    if (token.includes('kookr-dtach') && token.endsWith('.sock')) {
      return token;
    }
  }
  return null;
}

/**
 * Derive a session id from a kookr-dtach socket path basename
 * (`…/port-4800/kookr-abc.sock` → `kookr-abc`). Returns null when the path
 * does not end in `.sock` or the basename is empty.
 */
export function sessionIdFromDtachSocketPath(socketPath: string): string | null {
  const base = socketPath.split('/').pop() ?? '';
  if (!base.endsWith('.sock')) return null;
  const id = base.slice(0, -'.sock'.length);
  return id.length > 0 ? id : null;
}

/**
 * Evaluate one host-stale dtach candidate. Pure and fail-closed.
 *
 * Order of checks is intentional: live session and present socket short-circuit
 * before age, so a live agent can never be selected even with a null age.
 */
export function evaluateDtachOrphanReap(
  candidate: DtachOrphanCandidate,
  policy: DtachOrphanReapPolicy = {},
): DtachOrphanReapVerdict {
  const minAgeMs = policy.minAgeMs ?? DEFAULT_DTACH_ORPHAN_MIN_AGE_MS;
  const base = { pid: candidate.pid, ageMs: candidate.ageMs };

  if (candidate.liveSessionPresent) {
    return {
      ...base,
      shouldReap: false,
      reason: 'live_session',
      detail: 'session id is present in the live session inventory; never select',
    };
  }

  if (candidate.socketExists) {
    return {
      ...base,
      shouldReap: false,
      reason: 'socket_present',
      detail: 'socket file still exists; host-stale path does not own live masters',
    };
  }

  if (candidate.ageMs === null || !Number.isFinite(candidate.ageMs)) {
    return {
      ...base,
      shouldReap: false,
      reason: 'unknown_age',
      detail: 'process start time unknown; skip to avoid racing a mid-teardown master',
    };
  }

  if (candidate.ageMs < minAgeMs) {
    return {
      ...base,
      shouldReap: false,
      reason: 'too_young',
      detail: `age ${candidate.ageMs}ms is below minAge ${minAgeMs}ms (teardown race floor)`,
    };
  }

  return {
    ...base,
    shouldReap: true,
    reason: 'missing_socket_aged',
    detail: `socket missing and age ${candidate.ageMs}ms ≥ minAge ${minAgeMs}ms`,
  };
}

/**
 * Select every host-stale dtach candidate a janitor may reap.
 * Filters {@link evaluateDtachOrphanReap} results to `shouldReap: true` only.
 * Does not kill anything — selection only.
 */
export function selectDtachOrphansToReap(
  candidates: readonly DtachOrphanCandidate[],
  policy: DtachOrphanReapPolicy = {},
): DtachOrphanCandidate[] {
  return candidates.filter((c) => evaluateDtachOrphanReap(c, policy).shouldReap);
}

/**
 * Test/fixture builder for {@link DtachOrphanCandidate}. Defaults describe a
 * positive host-stale candidate (missing socket, aged, not live) so tests
 * only override the dimension under assertion.
 */
export function buildDtachOrphanCandidate(
  overrides: Partial<DtachOrphanCandidate> & { pid: number },
): DtachOrphanCandidate {
  return {
    sessionId: 'kookr-stale-sess',
    socketPath: '/tmp/kookr-dtach/1000/port-4800/kookr-stale-sess.sock',
    socketExists: false,
    liveSessionPresent: false,
    ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS + 1,
    ...overrides,
  };
}

/** Minimal process facts needed to assemble a {@link DtachOrphanCandidate}. */
export interface DtachProcessFacts {
  pid: number;
  cmdline: string;
  /** Wall-clock start (ms), or null when unknown. */
  startTimeMs: number | null;
}

/**
 * Build a host-stale candidate from a process-table row + live session set.
 * Returns null when the cmdline is not a kookr-dtach *master* (`dtach -n` /
 * `-N` + `kookr-dtach` path; attach clients excluded — issue #2383). Pure
 * aside from the injected `socketExists`.
 */
export function buildDtachOrphanCandidateFromProcess(
  proc: DtachProcessFacts,
  deps: {
    now: number;
    liveSessionIds: ReadonlySet<string>;
    socketExists: (path: string) => boolean;
  },
): DtachOrphanCandidate | null {
  if (!isKookrDtachMasterCmdline(proc.cmdline)) {
    return null;
  }
  const socketPath = extractKookrDtachSocketPath(proc.cmdline);
  const sessionId = socketPath ? sessionIdFromDtachSocketPath(socketPath) : null;
  const liveSessionPresent =
    sessionId !== null && deps.liveSessionIds.has(sessionId);
  return {
    pid: proc.pid,
    sessionId,
    socketPath,
    socketExists: socketPath !== null ? deps.socketExists(socketPath) : false,
    liveSessionPresent,
    ageMs:
      proc.startTimeMs === null || !Number.isFinite(proc.startTimeMs)
        ? null
        : Math.max(0, deps.now - proc.startTimeMs),
  };
}

/** Assemble candidates for every kookr-dtach row in a process snapshot. */
export function buildDtachOrphanCandidatesFromProcesses(
  processes: readonly DtachProcessFacts[],
  deps: {
    now: number;
    liveSessionIds: ReadonlySet<string>;
    socketExists: (path: string) => boolean;
  },
): DtachOrphanCandidate[] {
  const out: DtachOrphanCandidate[] = [];
  for (const proc of processes) {
    const c = buildDtachOrphanCandidateFromProcess(proc, deps);
    if (c) out.push(c);
  }
  return out;
}

export interface HostStaleDtachReapPlanOptions extends DtachOrphanReapPolicy {
  /**
   * Host-wide kookr-dtach master count (`staleProcesses.dtach.count`). The
   * pressure gate compares this to {@link softBound} for **pressure-gated**
   * classes only (none today — see issue #2384).
   */
  dtachCount: number;
  /**
   * Soft pressure bound. Defaults to
   * {@link DEFAULT_DTACH_PRESSURE_SOFT_BOUND} (20). Reserved for future
   * more-aggressive eligibility classes that must not run during quiet
   * operation. `missing_socket_aged` always selects regardless of this bound
   * (#2384). `<= 0` treats the host as always under pressure.
   */
  softBound?: number;
  /**
   * Max pids selected per plan. Defaults to
   * {@link DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP}. Values `<= 0` mean
   * select nobody (rate-limit fully closed).
   */
  maxReapsPerSweep?: number;
}

/**
 * Result of a pure host-stale sweep plan (issues #2356, #2384). Actuators
 * execute `toReap` only — never invent extra pids. Counters are last-plan only.
 */
export interface HostStaleDtachReapPlan {
  /** True when `dtachCount >= softBound` (or softBound disabled). */
  underPressure: boolean;
  softBound: number;
  dtachCount: number;
  maxReapsPerSweep: number;
  /** Candidates selected for kill / dry-run (already rate-limited). */
  toReap: DtachOrphanCandidate[];
  /** Per-candidate verdicts for audit / dry-run logs. */
  verdicts: DtachOrphanReapVerdict[];
  /**
   * Total positive candidates (always-select + pressure-gated), before rate
   * limit and pressure gating. "How many zombies exist," not "how many are
   * selectable this sweep."
   */
  eligibleCount: number;
  /** Count of candidates skipped because session was live-attached. */
  skippedLiveAttached: number;
  /**
   * Pressure-gated eligible candidates not selected because the host was
   * under the soft bound. Always-select (`missing_socket_aged`) never
   * increments this (#2384).
   */
  skippedUnderBound: number;
  /** Selectable candidates past maxReapsPerSweep. */
  skippedRateLimited: number;
  skippedSocketPresent: number;
  skippedUnknownAge: number;
  skippedTooYoung: number;
  /**
   * How many of `toReap` came from the always-select class
   * (`missing_socket_aged`). Issue #2384 observability.
   */
  selectedAlways: number;
  /**
   * How many of `toReap` came from pressure-gated classes (none today;
   * reserved for future aggressive classes).
   */
  selectedUnderPressure: number;
}

/**
 * Plan a bounded host-stale dtach reap. Pure and fail-closed.
 *
 * Order: evaluate every candidate → count skip reasons → always-select
 * `missing_socket_aged` (rate-limited) regardless of soft bound → append any
 * pressure-gated class only when under pressure → take the first
 * `maxReapsPerSweep` selectable pids (stable input order).
 */
export function planHostStaleDtachReap(
  candidates: readonly DtachOrphanCandidate[],
  options: HostStaleDtachReapPlanOptions,
): HostStaleDtachReapPlan {
  const softBound = options.softBound ?? DEFAULT_DTACH_PRESSURE_SOFT_BOUND;
  const maxReapsPerSweep =
    options.maxReapsPerSweep ?? DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP;
  const policy: DtachOrphanReapPolicy = { minAgeMs: options.minAgeMs };
  const dtachCount = options.dtachCount;

  let skippedLiveAttached = 0;
  let skippedSocketPresent = 0;
  let skippedUnknownAge = 0;
  let skippedTooYoung = 0;
  /** Always-select: proven zombies (missing_socket_aged). Issue #2384. */
  const alwaysEligible: DtachOrphanCandidate[] = [];
  /**
   * Pressure-gated: reserved for future more-aggressive classes. Empty today
   * because the only positive reason is `missing_socket_aged`.
   */
  const pressureGatedEligible: DtachOrphanCandidate[] = [];
  const verdicts: DtachOrphanReapVerdict[] = [];

  for (const c of candidates) {
    const verdict = evaluateDtachOrphanReap(c, policy);
    verdicts.push(verdict);
    if (verdict.shouldReap) {
      // Today every shouldReap is missing_socket_aged → always-select.
      if (verdict.reason === 'missing_socket_aged') {
        alwaysEligible.push(c);
      } else {
        // Future classes that shouldReap under pressure only.
        pressureGatedEligible.push(c);
      }
      continue;
    }
    switch (verdict.reason) {
      case 'live_session':
        skippedLiveAttached += 1;
        break;
      case 'socket_present':
        skippedSocketPresent += 1;
        break;
      case 'unknown_age':
        skippedUnknownAge += 1;
        break;
      case 'too_young':
        skippedTooYoung += 1;
        break;
      case 'missing_socket_aged':
        // shouldReap true only — unreachable
        break;
    }
  }

  // softBound <= 0 disables the pressure gate (always under pressure for planning).
  const underPressure = softBound <= 0 || dtachCount >= softBound;

  // Always-select class is never soft-bound gated (#2384). Pressure-gated
  // classes (none today) only join when under pressure.
  const selectable: DtachOrphanCandidate[] = underPressure
    ? [...alwaysEligible, ...pressureGatedEligible]
    : [...alwaysEligible];
  const skippedUnderBound = underPressure ? 0 : pressureGatedEligible.length;

  let toReap: DtachOrphanCandidate[] = [];
  let skippedRateLimited = 0;

  if (maxReapsPerSweep <= 0) {
    skippedRateLimited = selectable.length;
  } else {
    toReap = selectable.slice(0, maxReapsPerSweep);
    skippedRateLimited = Math.max(0, selectable.length - toReap.length);
  }

  // Split toReap by class for health / audit (always first in selectable).
  const alwaysCap = alwaysEligible.length;
  let selectedAlways = 0;
  let selectedUnderPressure = 0;
  for (let i = 0; i < toReap.length; i++) {
    if (i < alwaysCap) selectedAlways += 1;
    else selectedUnderPressure += 1;
  }

  return {
    underPressure,
    softBound,
    dtachCount,
    maxReapsPerSweep: Math.max(0, maxReapsPerSweep),
    toReap,
    verdicts,
    // Total positive candidates (always + pressure-gated), before rate limit /
    // pressure gating — operators use this as "how many zombies exist".
    eligibleCount: alwaysEligible.length + pressureGatedEligible.length,
    skippedLiveAttached,
    skippedUnderBound,
    skippedRateLimited,
    skippedSocketPresent,
    skippedUnknownAge,
    skippedTooYoung,
    selectedAlways,
    selectedUnderPressure,
  };
}

/** Re-export soft bound for callers that only import this module. */
export { DEFAULT_DTACH_PRESSURE_SOFT_BOUND };
