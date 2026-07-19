import {
  type BackendError,
  type BackendStats,
  type CaptureCurrentFrameOptions,
  type ReconnectTransportOptions,
  type ReconnectTransportReason,
  type ReconnectTransportResult,
  type RecoveredSessionClassification,
  type RecoveredSessionFailureReason,
  type SessionId,
  type SessionSpec,
  type TerminalBackend,
  type VerifyRecoveredSessionOptions,
  type VerifyRecoveredSessionResult,
  SessionGoneError,
} from './terminal-backend.js';
import type { TerminalInputWriteResult, TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Ctrl-U (0x15) — kill-line. Adapters prefix composer sends with it so an
 * unsubmitted terminal-typed draft cannot be fused into the message (F15).
 * The fake models the readline-style semantics: everything on the pending
 * input line before the kill char is discarded.
 */
const KILL_LINE_CHAR = '\x15';

/**
 * A real TUI consumes bracketed-paste markers while placing the body in the
 * composer. The fake keeps raw bytes for byte-level assertions, but strips
 * markers from pane/draft observables so logical tests model the real UI.
 */
function stripPasteMarkers(text: string): string {
  return text.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
}

/**
 * In-memory TerminalBackend fake for tests.
 *
 * Replaces the older fake terminal manager. Matches the production
 * `TerminalBackend` surface AND preserves the legacy per-session inspection
 * shape (`.sessions.get(id).keysReceived`, `.paneContent`, `.pastedTexts`)
 * so existing tests can migrate with minimal churn. Two `createSession`
 * signatures are accepted:
 *
 *   - `createSession(spec)` — production shape.
 *   - `createSession(name, command, options?)` — legacy call shape, used
 *     throughout the test suite.
 */
export interface FakeSession {
  name: string;
  /** Full SessionSpec passed at creation time — kept so tests can assert on argv/env. */
  spec: SessionSpec;
  command: string;
  args: string[];
  cwd?: string;
  alive: boolean;
  /** UTF-8 view of everything that has been written OR emitted for the session. */
  paneContent: string;
  /** Input lines recorded by `sendKeys`-style writes (ending in CR/LF). */
  keysReceived: string[];
  /** Multi-line text recorded by the historical `pasteText` helper. */
  pastedTexts: string[];
  dataSubscribers: Set<(data: Uint8Array, source?: TerminalSessionDataSource) => void>;
  /** Raw byte record of every `write` call, in submission order. */
  written: Uint8Array[];
  /** Draft text accumulated by separate write() calls until Enter submits it. */
  inputDraft: string;
  /** Synthetic dtach master pid reported by `reconnectTransport`. */
  masterPid: number;
  /** Synthetic agent pid reported by `reconnectTransport`. */
  agentPid: number;
  /** Internal attach generation, bumped by `reconnectTransport`. */
  attachGeneration: number;
  /**
   * When true, `reconnectTransport` models a wedged attach that never emits a
   * fresh-liveness byte — the reconnect times out to `inconclusive`. Default
   * false: the reconnect emits a synthetic redraw and reports `success`.
   */
  reconnectWedged: boolean;
  /**
   * When true, `verifyRecoveredSession` models a post-restart attach that came
   * up wedged (no bytes). If the session is also expected to be working, the
   * modeled repair loop exhausts and the session is classified
   * `recovered-unverified`. Default false: the initial probe is live and the
   * session is `recovered-live`. See kookr-ai/kookr#1345.
   */
  recoveryWedged: boolean;
  /**
   * Repair attempt at which a wedged recovery becomes live (models a fresh
   * attach clearing the wedge). Default Infinity: the wedge is permanent, so a
   * working session ends `recovered-unverified`.
   */
  recoveryRepairsUntilLive: number;
}

/** Synthetic redraw a successful fake reconnect emits (models the dtach redraw). */
const RECONNECT_REDRAW_BYTES = encoder.encode('\x1b[H');

export class FakeTerminalBackend implements TerminalBackend, TerminalInputWriterPort {
  readonly sessions = new Map<SessionId, FakeSession>();
  lastKeystroke: { name: string; key: string } | null = null;

  private readonly errorSubscribers = new Set<(err: BackendError) => void>();
  private lastError: BackendError | null = null;
  private errorCount = 0;

  /** Per-session write queue — preserves submission order across writes. */
  private writeQueues = new Map<SessionId, Promise<void>>();

  /** Per-session in-flight reconnect (idempotency/serialization modeling). */
  private reconnectInFlight = new Map<SessionId, Promise<ReconnectTransportResult>>();
  /** Per-session timestamps of recent reconnects (cooldown/cap modeling). */
  private reconnectHistory = new Map<SessionId, number[]>();
  /** Liveness wait for the modeled reconnect. */
  reconnectLivenessTimeoutMs = 50;
  /** Cooldown between reconnects. Default 0 so tests aren't rate-limited unless they opt in. */
  reconnectCooldownMs = 0;
  /** Rolling reconnect cap. Default Infinity so tests aren't capped unless they opt in. */
  reconnectCap = Number.POSITIVE_INFINITY;
  /** Window for the reconnect cap. */
  reconnectWindowMs = 60_000;
  /** Records the options of the most recent `reconnectTransport` call (test inspection). */
  lastReconnectOptions: ReconnectTransportOptions | null = null;
  /** Records the options of the most recent `captureCurrentFrame` call (test inspection). */
  lastCaptureCurrentFrameOptions: CaptureCurrentFrameOptions | null = null;
  /**
   * When set, `captureCurrentFrame` returns these bytes instead of a synthetic
   * CUP-home frame. Empty string forces an empty snapshot (reconnect fallback).
   */
  private currentFrameBySession = new Map<SessionId, string | null>();

  createSession(spec: SessionSpec): Promise<void>;
  createSession(
    name: string,
    command: string,
    options?: { cwd?: string; width?: number; height?: number },
  ): Promise<void>;
  async createSession(
    specOrName: SessionSpec | string,
    command?: string,
    options?: { cwd?: string; width?: number; height?: number },
  ): Promise<void> {
    const spec: SessionSpec =
      typeof specOrName === 'string'
        ? { id: specOrName, command: command ?? '', args: [], cwd: options?.cwd }
        : specOrName;
    this.sessions.set(spec.id, {
      name: spec.id,
      spec,
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      alive: true,
      paneContent: `$ ${spec.command}${spec.args.length > 0 ? ' ' + spec.args.join(' ') : ''}\n`,
      keysReceived: [],
      pastedTexts: [],
      dataSubscribers: new Set(),
      written: [],
      inputDraft: '',
      masterPid: 100_000 + this.sessions.size,
      agentPid: 200_000 + this.sessions.size,
      attachGeneration: 1,
      reconnectWedged: false,
      recoveryWedged: false,
      recoveryRepairsUntilLive: Number.POSITIVE_INFINITY,
    });
  }

  async listSessions(): Promise<SessionId[]> {
    const out: SessionId[] = [];
    for (const [id, s] of this.sessions) if (s.alive) out.push(id);
    return out;
  }

  async isAlive(id: SessionId): Promise<boolean> {
    return this.sessions.get(id)?.alive ?? false;
  }

  async killSession(id: SessionId): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.alive = false;
    s.dataSubscribers.clear();
    this.writeQueues.delete(id);
  }

  async write(id: SessionId, data: Uint8Array): Promise<void> {
    return this.enqueueWrite(id, async () => {
      await this.writeOne(id, data);
      const s = this.sessions.get(id);
      if (!s) return;
      const text = stripPasteMarkers(this.applyKillLine(s, decoder.decode(data)));
      if (text.endsWith('\r') || text.endsWith('\n')) {
        s.keysReceived.push(s.inputDraft + text.replace(/[\r\n]+$/, ''));
        s.inputDraft = '';
      } else {
        s.inputDraft += text;
      }
    });
  }

  async writeInput(id: SessionId, data: Uint8Array): Promise<TerminalInputWriteResult> {
    await this.write(id, data);
    return { sessionId: id, readinessVersion: 0 };
  }

  async writeSequence(id: SessionId, payloads: Uint8Array[]): Promise<void> {
    if (payloads.length === 0) return;
    return this.enqueueWrite(id, async () => {
      // Adapters' sendInput is implemented as writeSequence([text, ENTER]) —
      // two distinct payloads at the syscall level (Codex CLI's TUI relies on
      // this to distinguish paste-bursts from typed-then-submit). For the
      // test-only `keysReceived` observable we want the *logical* submission,
      // so concatenate first and emit one entry on a terminating CR/LF. Each
      // payload is still written individually so byte-level inspection
      // (getWrittenBytes / written) preserves the syscall boundaries. See #57.
      for (const p of payloads) await this.writeOne(id, p);
      const total = payloads.reduce((acc, p) => acc + p.length, 0);
      const concat = new Uint8Array(total);
      let off = 0;
      for (const p of payloads) {
        concat.set(p, off);
        off += p.length;
      }
      const s = this.sessions.get(id);
      if (!s) return;
      // Model the adapters' Ctrl-U clear-line prefix (F15): a kill char
      // discards any pending terminal-typed draft, so the logical submission
      // recorded below contains the composer message only. Without a kill
      // char, a pending draft is fused onto the submission — exactly the
      // production CLI behaviour the prefix exists to prevent.
      const concatText = stripPasteMarkers(this.applyKillLine(s, decoder.decode(concat)));
      if (concatText.endsWith('\r') || concatText.endsWith('\n')) {
        s.keysReceived.push(s.inputDraft + concatText.replace(/[\r\n]+$/, ''));
        s.inputDraft = '';
      }
    });
  }

  /**
   * Apply readline-style kill-line (Ctrl-U, 0x15) semantics: a kill char
   * clears the pending input draft and discards everything written before
   * it in `text`. Returns the residual text after the last kill char.
   */
  private applyKillLine(s: FakeSession, text: string): string {
    const killIdx = text.lastIndexOf(KILL_LINE_CHAR);
    if (killIdx === -1) return text;
    s.inputDraft = '';
    return text.slice(killIdx + 1);
  }

  async writeInputSequence(
    id: SessionId,
    payloads: Uint8Array[],
    _meta?: { reason?: string; interPayloadDelayMs?: number },
  ): Promise<TerminalInputWriteResult> {
    await this.writeSequence(id, payloads);
    return { sessionId: id, readinessVersion: 0 };
  }

  async captureBytes(id: SessionId, maxBytes: number = 64 * 1024): Promise<Uint8Array> {
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    const full = encoder.encode(s.paneContent);
    if (full.length <= maxBytes) return full;
    return full.subarray(full.length - maxBytes);
  }

  /**
   * Non-destructive current-frame snapshot. Returns a synthetic frame by
   * default so absolute-TUI SessionBridge tests exercise the preferred path
   * without calling `reconnectTransport`. Override with
   * {@link setCurrentFrameContent}.
   */
  async captureCurrentFrame(
    id: SessionId,
    options: CaptureCurrentFrameOptions = {},
  ): Promise<Uint8Array> {
    this.lastCaptureCurrentFrameOptions = options;
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    if (this.currentFrameBySession.has(id)) {
      const override = this.currentFrameBySession.get(id);
      return encoder.encode(override ?? '');
    }
    // Distinct from the dense ring so tests can assert the snapshot path.
    // Include a leading clear (dtach attach does this) so stripLeadingTerminalClear
    // is exercised, then a body large enough to count as a usable frame.
    return encoder.encode(`\x1b[H\x1b[2J[fake-current-frame]${'·'.repeat(40)}`);
  }

  onData(id: SessionId, cb: (data: Uint8Array, source?: TerminalSessionDataSource) => void): () => void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.dataSubscribers.add(cb);
    return () => s.dataSubscribers.delete(cb);
  }

  onBackendError(cb: (err: BackendError) => void): () => void {
    this.errorSubscribers.add(cb);
    return () => this.errorSubscribers.delete(cb);
  }

  async resize(_id: SessionId, _cols: number, _rows: number): Promise<void> {
    // Fake does not model viewport size.
  }

  async reconnectTransport(
    id: SessionId,
    options: ReconnectTransportOptions = {},
  ): Promise<ReconnectTransportResult> {
    this.lastReconnectOptions = options;
    const inFlight = this.reconnectInFlight.get(id);
    if (inFlight) return inFlight;
    const run = this.performReconnect(id, options);
    this.reconnectInFlight.set(id, run);
    try {
      return await run;
    } finally {
      this.reconnectInFlight.delete(id);
    }
  }

  private async performReconnect(
    id: SessionId,
    options: ReconnectTransportOptions,
  ): Promise<ReconnectTransportResult> {
    const now = Date.now();
    const s = this.sessions.get(id);
    const prevGen = s?.attachGeneration ?? 0;
    const fail = (reason: ReconnectTransportReason): ReconnectTransportResult => ({
      outcome: 'failure',
      reason,
      identityVerified: false,
      masterPid: s?.masterPid ?? -1,
      agentPid: s?.agentPid ?? null,
      previousGeneration: prevGen,
      newGeneration: prevGen,
      livenessWaitedMs: 0,
    });

    if (!s) return fail('session-unknown');
    // Identity cannot be verified for a dead session (models pid/socket gone).
    if (!s.alive) return fail('identity-unverified');

    const history = (this.reconnectHistory.get(id) ?? []).filter((t) => now - t < this.reconnectWindowMs);
    const lastAttempt = history.length > 0 ? history[history.length - 1] : Number.NEGATIVE_INFINITY;
    if (now - lastAttempt < this.reconnectCooldownMs) {
      this.reconnectHistory.set(id, history);
      return { ...fail('cooldown'), identityVerified: true, agentPid: s.agentPid };
    }
    if (history.length >= this.reconnectCap) {
      this.reconnectHistory.set(id, history);
      return { ...fail('retry-cap'), identityVerified: true, agentPid: s.agentPid };
    }

    // Dispose+respawn the internal attach child (modeled): bump generation,
    // preserve dataSubscribers (the SessionBridge stays subscribed). Never
    // writes input and never touches the (synthetic) master/agent pids.
    s.attachGeneration += 1;
    history.push(Date.now());
    this.reconnectHistory.set(id, history);

    let live: boolean;
    let waited = 0;
    if (s.reconnectWedged) {
      const start = Date.now();
      await sleep(options.livenessTimeoutMs ?? this.reconnectLivenessTimeoutMs);
      waited = Date.now() - start;
      live = false;
    } else {
      // Model the dtach redraw reaching subscribers — this is also the browser
      // reconnect/replay boundary. It is output, never input.
      this.emit(id, RECONNECT_REDRAW_BYTES);
      live = true;
    }

    return {
      outcome: live ? 'success' : 'inconclusive',
      reason: live ? 'reconnected' : 'liveness-timeout',
      identityVerified: true,
      masterPid: s.masterPid,
      agentPid: s.agentPid,
      previousGeneration: prevGen,
      newGeneration: s.attachGeneration,
      livenessWaitedMs: waited,
    };
  }

  /** Test helper: model a wedged attach so `reconnectTransport` → `inconclusive`. */
  setReconnectWedged(id: SessionId, wedged: boolean): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.reconnectWedged = wedged;
  }

  /**
   * Test helper: model a session that came up wedged after a restart. When
   * `repairsUntilLive` is given, the modeled repair loop makes it live at that
   * attempt; otherwise the wedge is permanent. See kookr-ai/kookr#1345.
   */
  setRecoveryWedged(id: SessionId, wedged: boolean, repairsUntilLive?: number): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.recoveryWedged = wedged;
    if (repairsUntilLive != null) s.recoveryRepairsUntilLive = repairsUntilLive;
  }

  async verifyRecoveredSession(
    id: SessionId,
    options: VerifyRecoveredSessionOptions,
  ): Promise<VerifyRecoveredSessionResult> {
    const restartEpoch = options.restartEpoch ?? 0;
    const cap = options.maxRepairAttempts != null && options.maxRepairAttempts >= 0
      ? options.maxRepairAttempts
      : 2;
    const s = this.sessions.get(id);
    const finish = (
      classification: RecoveredSessionClassification,
      repairAttempts: number,
      livenessObserved: boolean,
      identityVerified: boolean,
      failureReason?: RecoveredSessionFailureReason,
    ): VerifyRecoveredSessionResult => {
      const result: VerifyRecoveredSessionResult = {
        sessionId: id,
        classification,
        restartEpoch,
        repairAttempts,
        identityVerified,
        masterPid: s?.masterPid ?? -1,
        agentPid: s?.agentPid ?? null,
        livenessObserved,
        elapsedMs: 0,
        ...(failureReason ? { failureReason } : {}),
      };
      if (classification === 'recovered-unverified') {
        this.fireError({
          kind: 'session-recovery-unverified',
          id,
          attempts: repairAttempts,
          failureReason: failureReason ?? 'no-liveness-after-repair',
        });
      } else if (classification === 'recovered-live' && repairAttempts > 0) {
        this.fireError({ kind: 'session-recovery-repaired', id, attempts: repairAttempts });
      }
      return result;
    };

    if (!s) return finish('recovered-unverified', 0, false, false, 'session-unknown');
    if (!s.alive) return finish('recovered-unverified', 0, false, false, 'identity-unverified');

    // Model opening/observing the persistent attach.
    s.attachGeneration += 1;
    if (!s.recoveryWedged) {
      this.emit(id, RECONNECT_REDRAW_BYTES);
      return finish('recovered-live', 0, true, true);
    }
    // Silent. Known-idle sessions are never repaired.
    if (!options.expectWorking) return finish('recovered-idle', 0, false, true);
    // Expected working but wedged → bounded repairs.
    let attempts = 0;
    while (attempts < cap) {
      attempts += 1;
      s.attachGeneration += 1;
      if (attempts >= s.recoveryRepairsUntilLive) {
        this.emit(id, RECONNECT_REDRAW_BYTES);
        return finish('recovered-live', attempts, true, true);
      }
    }
    return finish('recovered-unverified', attempts, false, true, 'no-liveness-after-repair');
  }

  getStats(): BackendStats {
    let attached = 0;
    for (const s of this.sessions.values()) if (s.alive) attached++;
    return {
      attachedSessions: attached,
      reattachCounts: {},
      pendingWriters: 0,
      lastError: this.lastError,
      errorCount: this.errorCount,
    };
  }

  // --- Test helpers kept for older test call sites ---

  /**
   * Drive the session as if the caller had used `sendKeys` (text + Enter).
   * Records the input in `keysReceived` and appends to `paneContent`.
   */
  async sendKeys(id: SessionId, keys: string): Promise<void> {
    await this.write(id, encoder.encode(keys + '\n'));
  }

  /**
   * Paste multi-line text without Enter. Captures the text for assertions
   * that distinguish typed input from paste (Codex's bracketed-paste flow).
   */
  async pasteText(id: SessionId, text: string): Promise<void> {
    return this.enqueueWrite(id, async () => {
      const s = this.sessions.get(id);
      if (!s || !s.alive) throw new SessionGoneError(id);
      s.pastedTexts.push(text);
      s.paneContent += text;
      s.inputDraft += text;
      s.written.push(encoder.encode(text));
    });
  }

  /** Record a pressed key without appending Enter. */
  async sendKeystroke(id: SessionId, key: string): Promise<void> {
    return this.enqueueWrite(id, async () => {
      const s = this.sessions.get(id);
      if (!s || !s.alive) throw new SessionGoneError(id);
      this.lastKeystroke = { name: id, key };
    });
  }

  /** Pre-V8 `capturePane` shape — returns pane content as decoded text. */
  async capturePane(id: SessionId, _lines?: number): Promise<string> {
    const bytes = await this.captureBytes(id);
    return decoder.decode(bytes);
  }

  // ─── Test-only helpers ──────────────────────────────────────────────────

  /** Simulate bytes arriving from the agent. Fans out to `onData` subscribers. */
  emit(id: SessionId, bytes: Uint8Array | string, source?: TerminalSessionDataSource): void {
    const u8 = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.paneContent += decoder.decode(u8);
    for (const cb of s.dataSubscribers) {
      try {
        cb(u8, source);
      } catch {
        /* keep serving others */
      }
    }
  }

  /** Replace the capturable content for `id`. */
  setCaptureContent(id: SessionId, text: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.paneContent = text;
  }

  /**
   * Override `captureCurrentFrame` for `id`. Pass `''` to force empty
   * (SessionBridge should fall back to reconnectTransport).
   */
  setCurrentFrameContent(id: SessionId, text: string): void {
    this.currentFrameBySession.set(id, text);
  }

  /** All bytes the adapter wrote to this session, in submission order. */
  getWrittenBytes(id: SessionId): Uint8Array[] {
    return this.sessions.get(id)?.written.slice() ?? [];
  }

  /** Concatenated UTF-8 decoding of everything written to `id`. */
  getWrittenText(id: SessionId): string {
    return decoder.decode(concatBytes(this.getWrittenBytes(id)));
  }

  /** Inject a BackendError for subscribers — for observability tests. */
  fireError(err: BackendError): void {
    this.lastError = err;
    this.errorCount += 1;
    for (const cb of this.errorSubscribers) {
      try {
        cb(err);
      } catch {
        /* keep serving others */
      }
    }
  }

  private async writeOne(id: SessionId, data: Uint8Array): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || !s.alive) throw new SessionGoneError(id);
    const rawText = decoder.decode(data);
    s.written.push(new Uint8Array(data));
    // Kill-line chars and bracketed-paste markers are input controls, not pane
    // text. The raw bytes above still record them for byte-level assertions;
    // draft semantics are applied by write/writeSequence wrappers.
    const text = stripPasteMarkers(rawText.replaceAll(KILL_LINE_CHAR, ''));
    // Update `paneContent` and `lastKeystroke` per payload. `keysReceived` is
    // emitted by the calling write/writeSequence wrappers so that a single
    // logical submission produces one entry even when adapters split it into
    // multiple payloads. See #57.
    if (text.endsWith('\r') || text.endsWith('\n')) {
      s.paneContent += text.replace(/[\r\n]+$/, '') + '\n';
    } else if (text.length > 0) {
      s.paneContent += text;
      if (data.length <= 4) {
        this.lastKeystroke = { name: id, key: text };
      }
    }
    for (const cb of s.dataSubscribers) cb(new Uint8Array(data));
  }

  private async enqueueWrite(id: SessionId, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeQueues.set(
      id,
      next.catch(() => {
        /* keep chain alive on failure */
      }),
    );
    await next;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
