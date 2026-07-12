/**
 * TerminalBackend — the session I/O hub.
 *
 * V8 (rfc-v8-tmux-removal.md) consolidates responsibilities that were
 * previously split across `SessionBridge` (ring buffer), `CircuitBreakerTerminalManager`
 * (error wrapping), and the legacy `TerminalManager` (per-session ops):
 *
 *   - Session lifecycle (create, kill, list, isAlive).
 *   - Persistent per-session attach (hidden; one internal attach per session).
 *   - Per-session write mutex (serializes all write paths against each other).
 *   - Per-session ring buffer (push via `onData`; pull via `captureBytes`).
 *   - Transport-level error surfacing via `onBackendError`.
 *
 * Cohesion test for future additions: "is this a session-I/O concern (yes →
 * here) or a supervisor/observability concern (no → elsewhere)?"
 *
 * See: docs/rfc/rfc-v8-tmux-removal.md
 * See: docs/adr/014-local-dtach-backend.md
 */

import type { TerminalSessionStreamPort } from '../core/ports/terminal-session-stream-port.js';

/** Opaque session identifier. Same value used for the dtach socket filename. */
export type SessionId = string;

/** Parameters for creating a new session. */
export interface SessionSpec {
  id: SessionId;
  /** Absolute path to the binary to launch. Never a shell string. */
  command: string;
  /** Argv array for the binary. Shell features require a wrapper script. */
  args: string[];
  env?: Record<string, string>;
  /**
   * How {@link env} relates to the Kookr server's own `process.env`:
   *   - `'inherit'` (default): child env is `{ ...process.env, ...env }` — the
   *     long-standing behavior for Claude Code / Codex CLI.
   *   - `'replace'`: child env is EXACTLY `env` (a fully-resolved allowlist);
   *     `process.env` is NOT merged in. Used by the Grok Build adapter so
   *     unrelated provider/GitHub/deploy secrets in the server environment never
   *     reach the Grok child (RFC "allowlisted child environment"). The caller
   *     is responsible for including everything the child needs (PATH, HOME,
   *     TERM, locale, …).
   */
  envMode?: 'inherit' | 'replace';
  cwd?: string;
  /** Initial size; subsequent resizes flow through `resize`. */
  size?: { cols: number; rows: number };
}

/**
 * Structured transport-level error emitted by the backend. Consumers subscribe
 * via `onBackendError` and decide whether to log, page, or broadcast. The
 * backend does not import supervisor types.
 */
export type BackendError =
  | { kind: 'dtach-unavailable'; binary: string }
  | { kind: 'session-attach-failed'; id: SessionId; retries: number }
  | { kind: 'session-gone'; id: SessionId }
  | { kind: 'session-attach-recovered'; id: SessionId; attempt: number }
  | { kind: 'write-timed-out'; id: SessionId; durationMs: number }
  | { kind: 'manifest-corrupt'; recoveredCount: number }
  /**
   * Post-restart recovery repaired a wedged attach transport by recycling only
   * the internal attach child (kookr-ai/kookr#1345). Informational — the agent
   * and its conversation were preserved.
   */
  | { kind: 'session-recovery-repaired'; id: SessionId; attempts: number }
  /**
   * Post-restart recovery could not make a session that was expected to be
   * working observably live even after the bounded repair attempts
   * (kookr-ai/kookr#1345). This is a distinct, actionable finding — NOT the
   * watchdog's generic `stale_agent`: the dtach master and agent process are
   * still alive, but Kookr's attach transport to them could not be revived.
   */
  | { kind: 'session-recovery-unverified'; id: SessionId; attempts: number; failureReason: string };

/**
 * Snapshot of backend internals used by `/api/health.terminalBackend`.
 * `status` derivation lives in the server; this struct reports raw counts.
 */
export interface BackendStats {
  attachedSessions: number;
  reattachCounts: Record<SessionId, number>;
  pendingWriters: number;
  lastError: BackendError | null;
  errorCount: number;
}

/**
 * Server-only per-session transport diagnostics. The session-health service
 * projects this raw adapter shape to a privacy-safe wire DTO; callers must not
 * forward this interface directly to browser clients.
 */
export interface TerminalSessionDiagnostics {
  sessionId: SessionId;
  socketPresent: boolean | null;
  identityVerified: boolean | null;
  masterPid: number | null;
  agentPid: number | null;
  attachChildAlive: boolean | null;
  /** True while startup/restart recovery is actively repairing this session. */
  recoveryInProgress?: boolean;
  attachGeneration: number;
  reattachCount: number;
  ringHead: number;
  lastByteAt: number | null;
  lastAttachAt: number | null;
}

/**
 * Options for {@link TerminalBackend.reconnectTransport}.
 */
export interface ReconnectTransportOptions {
  /**
   * Bounded window (ms) to wait for a fresh-liveness signal — the first byte
   * emitted by the freshly-respawned internal attach child (typically the
   * dtach master's redraw). Reaching it → `success`; exceeding it while the
   * attach is still alive → `inconclusive`. Defaults to the backend's own
   * `DEFAULT_RECONNECT_LIVENESS_TIMEOUT_MS`.
   */
  livenessTimeoutMs?: number;
  /** Free-text operator reason, recorded in the audit line. */
  reason?: string;
  /** Actor label for the audit line (e.g. 'owner', a token id). */
  actor?: string;
}

/** Coarse verdict of a reconnect-transport attempt. */
export type ReconnectTransportOutcome = 'success' | 'inconclusive' | 'failure';

/**
 * Machine-readable cause of a reconnect-transport result. Exactly one is set.
 *   - `reconnected`         → success: fresh attach spawned + liveness observed.
 *   - `liveness-timeout`    → inconclusive: fresh attach is alive but emitted no
 *                             bytes within the bounded window.
 *   - `session-unknown`     → failure: no manifest entry for the session.
 *   - `socket-missing`      → failure: the dtach socket is gone.
 *   - `identity-unverified` → failure: the master pid/socket could not be
 *                             confirmed to still be our session (pid recycle /
 *                             wrong process).
 *   - `attach-spawn-failed` → failure: the fresh internal attach could not be
 *                             opened (or exited immediately).
 *   - `backend-closed`       → failure: shutdown won the race with recovery.
 *   - `cooldown`            → failure: another reconnect happened too recently.
 *   - `retry-cap`           → failure: too many reconnects in the rolling window.
 */
export type ReconnectTransportReason =
  | 'reconnected'
  | 'liveness-timeout'
  | 'session-unknown'
  | 'socket-missing'
  | 'identity-unverified'
  | 'attach-spawn-failed'
  | 'backend-closed'
  | 'cooldown'
  | 'retry-cap';

/**
 * Result of a reconnect-transport attempt. The operation NEVER writes terminal
 * input and NEVER kills the agent; the dtach master pid and agent pid are
 * captured before and after so callers can prove they were preserved.
 */
export interface ReconnectTransportResult {
  outcome: ReconnectTransportOutcome;
  reason: ReconnectTransportReason;
  /** Whether the master pid + socket identity was positively verified. */
  identityVerified: boolean;
  /** dtach master pid (unchanged by the operation). -1 if unresolved. */
  masterPid: number;
  /** Agent (claude/codex) pid under the master, best-effort. null if unresolved. */
  agentPid: number | null;
  /** Internal attach generation before this attempt (0 if none was open). */
  previousGeneration: number;
  /** Internal attach generation after this attempt. Equal to previous on failure. */
  newGeneration: number;
  /** ms spent waiting for the fresh-liveness signal (0 when not reached). */
  livenessWaitedMs: number;
}

/**
 * Post-restart recovery classification of a session whose dtach master survived
 * a Kookr restart (kookr-ai/kookr#1345).
 *
 *   - `recovered-live`       → a fresh byte was observed within the grace window;
 *                              the attach transport is healthy (no repair, or a
 *                              repair brought it back).
 *   - `recovered-idle`       → no bytes observed, but the session was NOT expected
 *                              to be producing output (idle / completed-turn /
 *                              blocked). Silence is normal; no repair is attempted.
 *   - `recovered-unverified` → the session was expected to be working yet stayed
 *                              silent even after the bounded attach recycles. A
 *                              distinct, actionable finding (see BackendError).
 */
export type RecoveredSessionClassification =
  | 'recovered-live'
  | 'recovered-idle'
  | 'recovered-unverified';

/** Machine-readable reason a recovery ended `recovered-unverified`. Exactly one is set. */
export type RecoveredSessionFailureReason =
  | 'session-unknown' // no manifest entry for the session.
  | 'socket-missing' // the dtach socket is gone.
  | 'identity-unverified' // master pid/socket could not be confirmed (pid recycle / wrong process).
  | 'attach-spawn-failed' // a fresh internal attach could not be opened during repair.
  | 'backend-closed' // backend shutdown won the race with recovery.
  | 'no-liveness-after-repair'; // attaches spawned fine but never emitted a byte within the caps.

/** Options for {@link TerminalBackend.verifyRecoveredSession}. */
export interface VerifyRecoveredSessionOptions {
  /**
   * Whether the session's agent was actively producing output (mid-turn) at the
   * instant Kookr restarted. The caller derives this from the last observed turn
   * state. When true, a session that stays silent through the grace window is
   * treated as a wedged attach transport and its internal attach child is
   * recycled (bounded). When false — idle, completed-turn, blocked — silence is
   * expected: NO repair is attempted and the session is classified
   * `recovered-idle`. This is the guard that stops known-idle sessions from being
   * repeatedly repaired.
   */
  expectWorking: boolean;
  /**
   * Grace window (ms) to observe *ongoing* agent output (ring-head progress)
   * before (re)classifying. Defaults to the backend's own value.
   */
  graceWindowMs?: number;
  /**
   * Settle window (ms) to let the dtach on-attach redraw/replay flush before the
   * progress baseline is snapshotted, so a one-shot redraw is never mistaken for
   * live agent output. Defaults to the backend's own value. Tests set it small.
   */
  settleWindowMs?: number;
  /**
   * Maximum internal-attach recycles before giving up. Bounds the attach storm so
   * a permanently-wedged transport cannot spin forever. Defaults to the backend's
   * own value. 0 disables repair (classify-only).
   */
  maxRepairAttempts?: number;
  /**
   * Restart epoch (ms since epoch) recorded in the structured diagnostics so an
   * operator can correlate every recovery attempt with one restart. Defaults to
   * the moment the verification starts.
   */
  restartEpoch?: number;
}

/**
 * Result of {@link TerminalBackend.verifyRecoveredSession}. The operation NEVER
 * writes terminal input and NEVER relaunches or signals the agent; the dtach
 * master pid and agent pid are captured so callers can prove they were preserved.
 */
export interface VerifyRecoveredSessionResult {
  sessionId: SessionId;
  classification: RecoveredSessionClassification;
  /** Restart epoch (ms) recorded for this verification. */
  restartEpoch: number;
  /** Number of internal-attach recycles performed (0 when none were needed). */
  repairAttempts: number;
  /** Whether the dtach master pid + socket identity was positively verified. */
  identityVerified: boolean;
  /** dtach master pid (unchanged by the operation). -1 if unresolved. */
  masterPid: number;
  /** Agent (claude/codex) pid under the master, best-effort. null if unresolved. */
  agentPid: number | null;
  /** True when a fresh byte was observed at any point (initial probe or a repair). */
  livenessObserved: boolean;
  /** Wall-clock ms spent classifying + repairing. */
  elapsedMs: number;
  /** Set only when `classification === 'recovered-unverified'`. */
  failureReason?: RecoveredSessionFailureReason;
}

export interface TerminalBackend extends TerminalSessionStreamPort {
  /**
   * Launch a new child process under a persistence layer (dtach). The backend
   * opens a persistent internal attach so subsequent `write` / `captureBytes` /
   * `onData` calls succeed immediately. The child survives Kookr restart.
   */
  createSession(spec: SessionSpec): Promise<void>;

  /** Enumerate currently-known sessions this backend owns. */
  listSessions(): Promise<SessionId[]>;

  /** Cheap liveness probe. Does not attach. */
  isAlive(id: SessionId): Promise<boolean>;

  /**
   * Terminate the child process and clean up resources (attach, socket,
   * manifest entry, subscribers). Follows TERM → wait → KILL escalation.
   */
  killSession(id: SessionId): Promise<void>;

  /**
   * Write bytes to the session's PTY stdin. Byte-transparent.
   *
   * Serialization: acquires a per-session mutex; concurrent callers queue.
   * Multi-byte writes within one `write()` call are atomic relative to other
   * concurrent `write()` calls. For two-payload atomicity (e.g. Codex's
   * paste + Enter split), use `writeSequence`.
   *
   * Backpressure: the underlying `pty.write` may block if the child is not
   * reading. `write` enforces a bounded timeout (default 2 s); exceeding it
   * rejects with `WriteTimeoutError`, emits `write-timed-out` on the
   * error stream, and releases the mutex so `captureBytes` / `onData` /
   * other writers are not starved.
   */
  write(id: SessionId, data: Uint8Array): Promise<void>;

  /**
   * Write a sequence of byte payloads atomically — one mutex acquisition,
   * multiple distinct `pty.write` syscalls. Used by Codex CLI's `sendInput`
   * to preserve the paste-burst heuristic's two-syscall split while keeping
   * concurrent writers out.
   */
  writeSequence(id: SessionId, payloads: Uint8Array[]): Promise<void>;

  /**
   * Return a lock-free snapshot of the last N bytes emitted by the session,
   * up to the backend-enforced ring-buffer size. Non-destructive;
   * does NOT acquire the write mutex. Multiple concurrent `captureBytes`
   * callers are allowed.
   *
   * Consistency: the returned buffer is a copy taken at a single frozen
   * `head` observation — no torn reads across wraparound. Consumers that
   * need rendered-screen text (not raw bytes including ANSI escapes) must
   * post-process.
   */
  captureBytes(id: SessionId, maxBytes?: number): Promise<Uint8Array>;

  /**
   * Subscribe to bytes emitted by the session as they arrive. Returns an
   * unsubscribe function. Subscribers do NOT receive history — they see
   * bytes from subscription time forward. To get history, call
   * `captureBytes()` first, then subscribe.
   *
   * Lifetime: subscribers are held by strong reference for the subscription's
   * lifetime. Callers MUST invoke the unsubscribe function on client
   * disconnect (failure = listener leak). The backend scrubs subscribers on
   * `killSession` / session exit.
   */
  onData(id: SessionId, cb: (data: Uint8Array) => void): () => void;

  /**
   * Subscribe to transport-level error events. Returns an unsubscribe
   * function. Used by the server to wire backend errors to the anomaly
   * queue and `/api/health` without making the backend import supervisor
   * types.
   */
  onBackendError(cb: (err: BackendError) => void): () => void;

  /** Propagate viewport size to the session's PTY. */
  resize(id: SessionId, cols: number, rows: number): Promise<void>;

  /** Snapshot of internal counters for `/api/health.terminalBackend`. */
  getStats(): BackendStats;

  /** Optional per-session transport diagnostics for cross-signal health. */
  getSessionDiagnostics?(id: SessionId): TerminalSessionDiagnostics | null;

  /**
   * Optional. Tear down any backend-owned background work (timers, final
   * persistence flushes) before the process exits. Implementations that
   * persist state to disk should perform a final flush here so SIGTERM does
   * not race the periodic flush cadence. Idempotent.
   *
   * The backend MUST NOT terminate the agent processes themselves — those
   * survive Kookr restart by design (dtach masters detached via setsid).
   */
  close?(): void;

  /**
   * Safely reconnect the session's terminal *transport* without disturbing the
   * agent (kookr-ai/kookr#1347). Verifies the dtach master pid + socket still
   * belong to the expected session, disposes ONLY Kookr's internal attach
   * child, opens a fresh attach generation, reapplies the last rows/cols, keeps
   * every ring-capture + `onData` (SessionBridge) consumer subscribed, and
   * waits a bounded window for a fresh-liveness signal.
   *
   * Guarantees: it NEVER writes terminal input (no Enter / Ctrl-C / Ctrl-D /
   * prompts) and NEVER relaunches or signals the agent. Reconnects are
   * serialized per session and idempotent under duplicate requests (a
   * concurrent duplicate collapses onto the in-flight attempt); a cooldown and
   * a rolling retry cap reject storms. The dtach master pid and agent pid are
   * unchanged and reported before/after.
   *
   * Optional: backends that do not manage a detachable transport omit it.
   */
  reconnectTransport?(
    id: SessionId,
    options?: ReconnectTransportOptions,
  ): Promise<ReconnectTransportResult>;

  /**
   * Validate that a session recovered after a Kookr restart is observably live,
   * and self-heal ONLY its attach transport when it is not (kookr-ai/kookr#1345).
   *
   * A Kookr restart leaves the dtach masters and agent processes running (they
   * were detached via setsid), but the resumed internal attach can come up
   * wedged: the process and socket pass liveness while no terminal bytes,
   * transcript records, or hook events flow. This runs a bounded state machine
   * per recovered session:
   *
   *   1. Verify the dtach master pid + socket still belong to the session.
   *   2. Ensure the persistent attach is open and observe it for a fresh byte
   *      during a grace window → `recovered-live`.
   *   3. If silent AND the session was NOT expected to be working → no repair,
   *      classify `recovered-idle`.
   *   4. If silent AND expected to be working → recycle ONLY the internal attach
   *      child (fresh generation, reapplied size, preserved ring + subscribers)
   *      up to a repair cap; a fresh byte → `recovered-live`, exhaustion →
   *      `recovered-unverified`.
   *
   * Guarantees: it NEVER writes terminal input (a resize/attach recycle is
   * transport repair, not user activity) and NEVER relaunches or signals the
   * agent — the dtach master pid and agent pid are unchanged and reported. The
   * grace window and repair cap bound it so it cannot create an attach storm.
   *
   * Optional: backends that do not manage a detachable transport omit it.
   */
  verifyRecoveredSession?(
    id: SessionId,
    options: VerifyRecoveredSessionOptions,
  ): Promise<VerifyRecoveredSessionResult>;
}

/** Typed error: session manifest entry / socket is gone. */
export class SessionGoneError extends Error {
  constructor(id: SessionId, cause?: Error) {
    super(`session ${id} is gone`);
    this.name = 'SessionGoneError';
    if (cause) this.cause = cause;
  }
}

/** Typed error: lazy re-attach failed after cap exhaustion. */
export class SessionAttachFailedError extends Error {
  constructor(
    readonly id: SessionId,
    readonly retries: number,
    cause?: Error,
  ) {
    super(`session ${id} attach failed after ${retries} retries`);
    this.name = 'SessionAttachFailedError';
    if (cause) this.cause = cause;
  }
}

/** Typed error: write blocked past the backend's timeout window. */
export class WriteTimeoutError extends Error {
  constructor(
    readonly id: SessionId,
    readonly durationMs: number,
  ) {
    super(`write to session ${id} timed out after ${durationMs}ms`);
    this.name = 'WriteTimeoutError';
  }
}
