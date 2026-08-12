/**
 * Pure host-stale dtach selection policy (issue #2352).
 *
 * Prep for a bounded host-stale janitor (#2356). Today `staleProcesses.dtach`
 * only counts kookr-dtach masters from `/proc`, and the session reaper (#1720)
 * only reaps sessions the backend still reports as live. Host-stale masters —
 * process-table dtach that are not live-attached and whose socket is gone —
 * accumulate outside both paths.
 *
 * This module is pure: it classifies already-observed facts into a reap
 * verdict. No process kill, no `/proc` I/O, no production wiring. A future
 * janitor calls {@link evaluateDtachOrphanReap} / {@link selectDtachOrphansToReap}
 * and acts only on `shouldReap: true` candidates.
 *
 * Fail-closed rules (exhaustive):
 *  1. Live session id present → never
 *  2. Socket still present → never (session reaper / attach lifecycle own those)
 *  3. Unknown age → skip (cannot prove a teardown race is past)
 *  4. Missing socket + aged past minAge → candidate
 *  5. Missing socket but too young → skip (teardown race)
 *  6. Unparseable session id is allowed when other signals are strong; live-set
 *     checks only apply when a session id is known
 */

/** Default minimum age (ms) before a missing-socket master may be selected. */
export const DEFAULT_DTACH_ORPHAN_MIN_AGE_MS = 60_000;

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
