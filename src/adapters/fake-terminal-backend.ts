import {
  type BackendError,
  type BackendStats,
  type SessionId,
  type SessionSpec,
  type TerminalBackend,
  SessionGoneError,
} from './terminal-backend.js';
import type { TerminalInputWriteResult, TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

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
  dataSubscribers: Set<(data: Uint8Array) => void>;
  /** Raw byte record of every `write` call, in submission order. */
  written: Uint8Array[];
  /** Draft text accumulated by separate write() calls until Enter submits it. */
  inputDraft: string;
}

export class FakeTerminalBackend implements TerminalBackend, TerminalInputWriterPort {
  readonly sessions = new Map<SessionId, FakeSession>();
  lastKeystroke: { name: string; key: string } | null = null;

  private readonly errorSubscribers = new Set<(err: BackendError) => void>();
  private lastError: BackendError | null = null;
  private errorCount = 0;

  /** Per-session write queue — preserves submission order across writes. */
  private writeQueues = new Map<SessionId, Promise<void>>();

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
      const text = decoder.decode(data);
      if (text.endsWith('\r') || text.endsWith('\n')) {
        const s = this.sessions.get(id);
        if (s) {
          s.keysReceived.push(s.inputDraft + text.replace(/[\r\n]+$/, ''));
          s.inputDraft = '';
        }
      } else {
        const s = this.sessions.get(id);
        if (s) s.inputDraft += text;
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
      const concatText = decoder.decode(concat);
      if (concatText.endsWith('\r') || concatText.endsWith('\n')) {
        const s = this.sessions.get(id);
        if (s) {
          s.keysReceived.push(concatText.replace(/[\r\n]+$/, ''));
          s.inputDraft = '';
        }
      }
    });
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

  onData(id: SessionId, cb: (data: Uint8Array) => void): () => void {
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
  emit(id: SessionId, bytes: Uint8Array | string): void {
    const u8 = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
    const s = this.sessions.get(id);
    if (!s) throw new SessionGoneError(id);
    s.paneContent += decoder.decode(u8);
    for (const cb of s.dataSubscribers) {
      try {
        cb(u8);
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
    const text = decoder.decode(data);
    s.written.push(new Uint8Array(data));
    // Update `paneContent` and `lastKeystroke` per payload. `keysReceived` is
    // emitted by the calling write/writeSequence wrappers so that a single
    // logical submission produces one entry even when adapters split it into
    // multiple payloads. See #57.
    if (text.endsWith('\r') || text.endsWith('\n')) {
      s.paneContent += text.replace(/[\r\n]+$/, '') + '\n';
    } else {
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
