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
  | { kind: 'manifest-corrupt'; recoveredCount: number };

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
