import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HookEventInjector } from './hook-ingestion.js';
import { splitHookRecords } from './hook-record-framing.js';

/** Default poll interval for the backup polling mechanism (ms). */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const REPLAY_CHECKPOINT_TAIL_CHARS = 4_096;

interface WatchOptions {
  replayExisting?: boolean;
  suppressParseAlertsForExisting?: boolean;
  useReplayCheckpoint?: boolean;
}

interface HookReplayCheckpointFile {
  schemaVersion: 'hook-replay-checkpoints.v1';
  sessions: Record<string, HookReplayCheckpoint>;
}

interface HookReplayCheckpoint {
  filePath: string;
  dev: number;
  ino: number;
  sizeBytes: number;
  offsetChars: number;
  offsetTail: string;
}

export type HookWatcherMode = 'fs_watch' | 'poll_until_exists' | 'poll_fallback';

export interface HookWatcherSessionHealth {
  tmuxName: string;
  mode: HookWatcherMode;
  offset: number;
  pollBackupActive: boolean;
  replayExisting: boolean;
  transitionCount: number;
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  readCount: number;
  recordCount: number;
  replayRecordCount: number;
  pollTickCount: number;
  pollChangeDetectedCount: number;
  drainNowCount: number;
  drainNowSkippedCount: number;
  lastPollDriftMs: number | null;
  maxPollDriftMs: number | null;
  p95PollDriftMs: number | null;
  lastDrainLatencyMs: number | null;
  maxDrainLatencyMs: number | null;
  p95DrainLatencyMs: number | null;
  lastReadAt: string | null;
  lastError: string | null;
}

export interface HookWatcherHealthSnapshot {
  schemaVersion: 'hook-watcher-health.v1';
  generatedAt: string;
  sessionCount: number;
  sessions: HookWatcherSessionHealth[];
}

interface MutableHookWatcherSessionHealth {
  tmuxName: string;
  mode: HookWatcherMode;
  pollBackupActive: boolean;
  replayExisting: boolean;
  transitionCount: number;
  lastTransitionAtMs: number | null;
  lastTransitionReason: string | null;
  readCount: number;
  recordCount: number;
  replayRecordCount: number;
  pollTickCount: number;
  pollChangeDetectedCount: number;
  drainNowCount: number;
  drainNowSkippedCount: number;
  lastPollTickAtMs: number | null;
  lastPollDriftMs: number | null;
  maxPollDriftMs: number | null;
  pollDriftSamples: number[];
  lastDrainLatencyMs: number | null;
  maxDrainLatencyMs: number | null;
  drainLatencySamples: number[];
  lastReadAtMs: number | null;
  lastError: string | null;
}

const HEALTH_SAMPLE_LIMIT = 128;

/**
 * Watches hook JSONL files for new lines and feeds them into the adapter.
 * Each agent's hooks are appended to ~/.kookr/hooks/<tmux-name>.jsonl by
 * Claude Code hook scripts.
 *
 * Uses dual-mode watching for resilience:
 * - Primary: fs.watch (low-latency, but unreliable on WSL2/macOS edge cases)
 * - Backup: interval poll every 3s (guaranteed delivery, catches missed fs.watch events)
 *
 * Both run simultaneously. Offset tracking ensures each line is processed exactly once.
 */
export class HookFileWatcher {
  private watchers = new Map<string, FSWatcher>();
  private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private offsets = new Map<string, number>();
  private reading = new Set<string>(); // Mutex: prevent concurrent reads for same agent
  private healthBySession = new Map<string, MutableHookWatcherSessionHealth>();
  private pollIntervalMs: number;
  private adapter: HookEventInjector;
  private replayCheckpointPath: string | null;
  private replayCheckpoints: HookReplayCheckpointFile;

  constructor(
    private hooksDir: string,
    adapter: HookEventInjector,
    options?: { pollIntervalMs?: number; replayCheckpointPath?: string },
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.adapter = adapter;
    this.replayCheckpointPath = options?.replayCheckpointPath ?? null;
    this.replayCheckpoints = this.loadReplayCheckpoints();
  }

  /** Start watching a hook file for a tmux session.
   *  When replayExisting is true (e.g. after restart), reads from offset 0
   *  to rebuild anomaly state from all prior events. */
  watch(tmuxName: string, options?: WatchOptions): void {
    if (this.watchers.has(tmuxName)) return;

    const filePath = join(this.hooksDir, `${tmuxName}.jsonl`);
    const replay = options?.replayExisting ?? false;
    this.getOrCreateHealth(tmuxName).replayExisting = replay;

    // Initialize offset: either resume a verified startup replay checkpoint,
    // replay existing events from zero, or seek to file size for tail-only mode.
    if (replay) {
      this.offsets.set(
        tmuxName,
        options?.useReplayCheckpoint === true ? this.resolveReplayOffset(tmuxName, filePath) : 0,
      );
    } else {
      try {
        const stats = statSync(filePath);
        this.offsets.set(tmuxName, stats.size);
      } catch {
        this.offsets.set(tmuxName, 0);
      }
    }

    try {
      const watcher = watch(filePath, { persistent: false }, () => {
        this.readNewLines(tmuxName, filePath);
      });
      watcher.on('error', (err) => {
        this.recordHealthError(tmuxName, err);
        this.transitionMode(tmuxName, 'poll_fallback', 'fs_watch_error');
        watcher.close();
        this.watchers.delete(tmuxName);
      });

      this.watchers.set(tmuxName, watcher);
      this.transitionMode(tmuxName, 'fs_watch', 'watch_started');

      // Start backup poll alongside fs.watch
      this.startBackupPoll(tmuxName, filePath);

      // If replaying, immediately read existing content
      if (replay) {
        this.readNewLines(tmuxName, filePath, {
          startupReplay: options?.suppressParseAlertsForExisting === true,
          replay: true,
        });
      }
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      // File might not exist yet — poll until it appears. Preserve the
      // caller's replay intent: when the file finally appears it almost
      // certainly already contains a SessionStart line that the agent
      // emitted between adapter.launch returning and this watch() call.
      // Without forcing replay on the retry, that line would be skipped
      // (offset = stats.size), leaving SessionInfo.claudeSessionId null
      // forever and silently breaking the Ralph cycler's Stop acceptance.
      this.pollUntilExists(tmuxName, filePath, options);
    }
  }

  /** Get the current tracked offset for a session (for testing/debugging). */
  getOffset(tmuxName: string): number | undefined {
    return this.offsets.get(tmuxName);
  }

  /**
   * Force a read of any new lines since the last known offset. Used by the
   * watchdog tick as a "recovery read" so a single reader/offset map serves
   * both the fs.watch-driven tail and the periodic probe. Safe to call for a
   * session that is not actively watched: the method short-circuits if no
   * offset has been registered yet.
   *
   * Callers get no return value — recovered events propagate through the
   * adapter's `onEvent` pipeline (monitor + watchdog + event-pipeline), which
   * is the same path the fs.watch listener uses. This guarantees we never
   * double-process a line regardless of which path observed it first.
   */
  async drainNow(tmuxName: string): Promise<void> {
    const health = this.healthBySession.get(tmuxName);
    if (!this.offsets.has(tmuxName)) {
      if (health) health.drainNowSkippedCount += 1;
      return;
    }
    const filePath = join(this.hooksDir, `${tmuxName}.jsonl`);
    const startedAt = Date.now();
    await this.readNewLines(tmuxName, filePath);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const sessionHealth = this.getOrCreateHealth(tmuxName);
    sessionHealth.drainNowCount += 1;
    sessionHealth.lastDrainLatencyMs = latencyMs;
    sessionHealth.maxDrainLatencyMs = sessionHealth.maxDrainLatencyMs === null
      ? latencyMs
      : Math.max(sessionHealth.maxDrainLatencyMs, latencyMs);
    pushBounded(sessionHealth.drainLatencySamples, latencyMs, HEALTH_SAMPLE_LIMIT);
  }

  /** Check if a session is being watched. */
  isWatching(tmuxName: string): boolean {
    return this.watchers.has(tmuxName);
  }

  /** Stop watching a specific session's hook file. */
  stop(tmuxName: string): void {
    const watcher = this.watchers.get(tmuxName);
    if (watcher) {
      watcher.close();
      this.watchers.delete(tmuxName);
    }
    const poll = this.pollIntervals.get(tmuxName);
    if (poll) {
      clearInterval(poll);
      this.pollIntervals.delete(tmuxName);
    }
    this.offsets.delete(tmuxName);
    this.reading.delete(tmuxName);
    this.healthBySession.delete(tmuxName);
  }

  /** Stop all watchers. */
  stopAll(): void {
    for (const [name, watcher] of this.watchers) {
      watcher.close();
      this.offsets.delete(name);
    }
    this.watchers.clear();
    for (const [, poll] of this.pollIntervals) {
      clearInterval(poll);
    }
    this.pollIntervals.clear();
    this.reading.clear();
    this.healthBySession.clear();
  }

  getHealthSnapshot(): HookWatcherHealthSnapshot {
    const sessions = [...this.healthBySession.values()]
      .map((health) => projectWatcherHealth(health, this.offsets.get(health.tmuxName) ?? 0))
      .sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
    return {
      schemaVersion: 'hook-watcher-health.v1',
      generatedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      sessions,
    };
  }

  /**
   * Read new lines since last offset. Serialized per agent to prevent duplicates.
   *
   * Mutex is intentionally **skip-if-busy**, not queue-and-wait. If a caller
   * (drainNow, poll, or fs.watch) arrives while another read is in flight,
   * that caller no-ops and the in-flight read delivers the same data. This
   * keeps the watchdog tick from serializing behind a long readFile — a
   * future refactorer should not "fix" it to queue-and-wait without
   * re-evaluating watchdog-tick latency.
   */
  private async readNewLines(
    tmuxName: string,
    filePath: string,
    options?: { startupReplay?: boolean; replay?: boolean },
  ): Promise<void> {
    if (this.reading.has(tmuxName)) return;
    this.reading.add(tmuxName);

    try {
      const fileStat = await stat(filePath).catch(() => undefined);
      const content = await readFile(filePath, 'utf-8');
      let offset = this.offsets.get(tmuxName) ?? 0;

      // Truncation / rotation recovery. The offset only ever grows, so if it
      // now sits past end-of-file the hook file was truncated, rotated, or
      // replaced with a smaller one. Left unhandled, `slice(offset)` returns
      // '' forever and every record written below the stale offset is silently
      // dropped until the process restarts (issue #703). Reset to 0 and
      // re-read from the start of the new file. Overlap with already-consumed
      // records is absorbed by HookIngestion's content-hash dedup; the common
      // truncate-to-0 / rotate-to-fresh-file case has no overlap at all.
      //
      // Size-based shrink is the portable baseline. Inode-identity detection
      // for a same-size rotation is intentionally out of scope: a rotated file
      // is born at size 0, which trips this guard on its first observation.
      if (offset > content.length) {
        offset = 0;
      }

      const newContent = content.slice(offset);
      const { records, consumedChars } = splitHookRecords(newContent);
      this.offsets.set(tmuxName, offset + consumedChars);
      const health = this.getOrCreateHealth(tmuxName);
      health.readCount += 1;
      health.lastReadAtMs = Date.now();
      health.recordCount += records.filter((line) => line.trim()).length;
      if (options?.replay === true) {
        health.replayRecordCount += records.filter((line) => line.trim()).length;
      }

      for (const line of records) {
        if (!line.trim()) continue;
        try {
          this.adapter.injectHookEvent(tmuxName, line, undefined, {
            startupReplay: options?.startupReplay === true,
            fileMtimeMs: fileStat?.mtimeMs,
          });
        } catch (err) {
          this.recordHealthError(tmuxName, err);
          console.error(`Error parsing hook event for ${tmuxName}:`, err);
        }
      }

      if (options?.replay === true) {
        await this.writeReplayCheckpoint(tmuxName, filePath, content);
      }
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      console.error(`Error reading hook file for ${tmuxName}:`, err);
    } finally {
      this.reading.delete(tmuxName);
    }
  }

  /**
   * Start a backup polling interval for a hook file.
   * Checks file size vs offset every pollIntervalMs — if they diverge,
   * reads missed events. This catches fs.watch failures on all platforms.
   */
  private startBackupPoll(tmuxName: string, filePath: string): void {
    if (this.pollIntervals.has(tmuxName)) return;

    const interval = setInterval(async () => {
      try {
        this.recordPollTick(tmuxName);
        const fileStat = await stat(filePath);
        const knownOffset = this.offsets.get(tmuxName) ?? 0;
        if (fileStat.size !== knownOffset) {
          // The file size diverged from our offset. Growth means fs.watch
          // missed an append; shrink means the file was truncated, rotated, or
          // replaced (issue #703), and fs.watch may not fire for an in-place
          // truncate. Either way, defer to readNewLines — the single authority
          // on framing: it re-reads from the offset and, when the offset now
          // sits past EOF, resets to 0 first. Routing both directions through
          // one read keeps this size-vs-offset check a coarse change trigger,
          // not a correctness gate, so the byte/char unit mismatch here can
          // never drop a record on its own.
          this.getOrCreateHealth(tmuxName).pollChangeDetectedCount += 1;
          await this.readNewLines(tmuxName, filePath);
        }
      } catch {
        // File doesn't exist or I/O error — not critical, will retry
      }
    }, this.pollIntervalMs);

    this.pollIntervals.set(tmuxName, interval);
    this.getOrCreateHealth(tmuxName).pollBackupActive = true;
  }

  /**
   * Poll for the hook file to appear, then re-enter `watch()`.
   *
   * `options` is forwarded verbatim — most importantly `replayExisting`, so
   * the original caller's intent survives the file-appears fallback. Without
   * this forwarding the retry would default to skip-mode and silently lose
   * any line already written before the file became watchable (notably
   * `SessionStart`, which the agent's hook script tees as its very first
   * action — so it nearly always lands here in production).
   */
  private pollUntilExists(
    tmuxName: string,
    filePath: string,
    options?: WatchOptions,
  ): void {
    if (this.watchers.has(tmuxName)) return;
    this.transitionMode(tmuxName, 'poll_until_exists', 'watch_file_missing');

    const interval = setInterval(async () => {
      try {
        await stat(filePath);
        clearInterval(interval);
        // Remove sentinel before re-watching
        this.watchers.delete(tmuxName);
        this.watch(tmuxName, options);
      } catch {
        // File doesn't exist yet, keep polling
      }
    }, 1000);

    // Sentinel entry so isWatching returns true and stopAll cleans up
    const sentinel = {
      close: () => clearInterval(interval),
    } as FSWatcher;
    this.watchers.set(tmuxName, sentinel);
  }

  private getOrCreateHealth(tmuxName: string): MutableHookWatcherSessionHealth {
    const existing = this.healthBySession.get(tmuxName);
    if (existing) return existing;
    const created: MutableHookWatcherSessionHealth = {
      tmuxName,
      mode: 'poll_until_exists',
      pollBackupActive: false,
      replayExisting: false,
      transitionCount: 0,
      lastTransitionAtMs: null,
      lastTransitionReason: null,
      readCount: 0,
      recordCount: 0,
      replayRecordCount: 0,
      pollTickCount: 0,
      pollChangeDetectedCount: 0,
      drainNowCount: 0,
      drainNowSkippedCount: 0,
      lastPollTickAtMs: null,
      lastPollDriftMs: null,
      maxPollDriftMs: null,
      pollDriftSamples: [],
      lastDrainLatencyMs: null,
      maxDrainLatencyMs: null,
      drainLatencySamples: [],
      lastReadAtMs: null,
      lastError: null,
    };
    this.healthBySession.set(tmuxName, created);
    return created;
  }

  private transitionMode(tmuxName: string, mode: HookWatcherMode, reason: string): void {
    const health = this.getOrCreateHealth(tmuxName);
    if (health.mode === mode && health.lastTransitionReason === reason) return;
    health.mode = mode;
    health.transitionCount += 1;
    health.lastTransitionAtMs = Date.now();
    health.lastTransitionReason = reason;
    console.info('[hook-watcher] mode transition', { tmuxName, mode, reason });
  }

  private recordPollTick(tmuxName: string): void {
    const health = this.getOrCreateHealth(tmuxName);
    const now = Date.now();
    if (health.lastPollTickAtMs !== null) {
      const elapsedMs = now - health.lastPollTickAtMs;
      const driftMs = Math.max(0, elapsedMs - this.pollIntervalMs);
      health.lastPollDriftMs = driftMs;
      health.maxPollDriftMs = health.maxPollDriftMs === null ? driftMs : Math.max(health.maxPollDriftMs, driftMs);
      pushBounded(health.pollDriftSamples, driftMs, HEALTH_SAMPLE_LIMIT);
    }
    health.lastPollTickAtMs = now;
    health.pollTickCount += 1;
  }

  private recordHealthError(tmuxName: string, err: unknown): void {
    this.getOrCreateHealth(tmuxName).lastError = err instanceof Error ? err.message : String(err);
  }

  private loadReplayCheckpoints(): HookReplayCheckpointFile {
    if (!this.replayCheckpointPath) {
      return { schemaVersion: 'hook-replay-checkpoints.v1', sessions: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.replayCheckpointPath, 'utf-8')) as unknown;
      if (!isReplayCheckpointEnvelope(parsed)) {
        return { schemaVersion: 'hook-replay-checkpoints.v1', sessions: {} };
      }
      return parsed;
    } catch {
      // Missing/corrupt checkpoint state is intentionally non-fatal: startup
      // replay falls back to offset zero and rewrites a fresh checkpoint.
      return { schemaVersion: 'hook-replay-checkpoints.v1', sessions: {} };
    }
  }

  private resolveReplayOffset(tmuxName: string, filePath: string): number {
    const checkpoint = this.replayCheckpoints.sessions[tmuxName];
    if (!checkpoint || checkpoint.filePath !== filePath) return 0;
    if (typeof checkpoint.offsetTail !== 'string') return 0;

    try {
      const stats = statSync(filePath);
      if (stats.dev !== checkpoint.dev || stats.ino !== checkpoint.ino) return 0;
      if (stats.size < checkpoint.sizeBytes) return 0;
      const content = readFileSync(filePath, 'utf-8');
      if (checkpoint.offsetChars > content.length) return 0;
      const actualTail = content.slice(
        Math.max(0, checkpoint.offsetChars - checkpoint.offsetTail.length),
        checkpoint.offsetChars,
      );
      if (actualTail !== checkpoint.offsetTail) return 0;
      return checkpoint.offsetChars;
    } catch {
      return 0;
    }
  }

  private async writeReplayCheckpoint(
    tmuxName: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    if (!this.replayCheckpointPath) return;

    try {
      const stats = await stat(filePath);
      const offset = this.offsets.get(tmuxName) ?? 0;
      const offsetTailStart = Math.max(0, offset - REPLAY_CHECKPOINT_TAIL_CHARS);
      this.replayCheckpoints.sessions[tmuxName] = {
        filePath,
        dev: stats.dev,
        ino: stats.ino,
        sizeBytes: stats.size,
        offsetChars: offset,
        offsetTail: content.slice(offsetTailStart, offset),
      };
      mkdirSync(dirname(this.replayCheckpointPath), { recursive: true });
      const tmpPath = `${this.replayCheckpointPath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(this.replayCheckpoints, null, 2)}\n`, 'utf-8');
      renameSync(tmpPath, this.replayCheckpointPath);
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      console.warn(`[hook-watcher] failed to write replay checkpoint for ${tmuxName}:`, err);
    }
  }
}

function isReplayCheckpointEnvelope(value: unknown): value is HookReplayCheckpointFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { schemaVersion?: unknown; sessions?: unknown };
  if (candidate.schemaVersion !== 'hook-replay-checkpoints.v1') return false;
  if (!candidate.sessions || typeof candidate.sessions !== 'object') return false;
  return true;
}

function pushBounded(samples: number[], value: number, limit: number): void {
  samples.push(value);
  if (samples.length > limit) samples.splice(0, samples.length - limit);
}

function projectWatcherHealth(
  health: MutableHookWatcherSessionHealth,
  offset: number,
): HookWatcherSessionHealth {
  return {
    tmuxName: health.tmuxName,
    mode: health.mode,
    offset,
    pollBackupActive: health.pollBackupActive,
    replayExisting: health.replayExisting,
    transitionCount: health.transitionCount,
    lastTransitionAt: isoOrNull(health.lastTransitionAtMs),
    lastTransitionReason: health.lastTransitionReason,
    readCount: health.readCount,
    recordCount: health.recordCount,
    replayRecordCount: health.replayRecordCount,
    pollTickCount: health.pollTickCount,
    pollChangeDetectedCount: health.pollChangeDetectedCount,
    drainNowCount: health.drainNowCount,
    drainNowSkippedCount: health.drainNowSkippedCount,
    lastPollDriftMs: health.lastPollDriftMs,
    maxPollDriftMs: health.maxPollDriftMs,
    p95PollDriftMs: percentile(health.pollDriftSamples, 0.95),
    lastDrainLatencyMs: health.lastDrainLatencyMs,
    maxDrainLatencyMs: health.maxDrainLatencyMs,
    p95DrainLatencyMs: percentile(health.drainLatencySamples, 0.95),
    lastReadAt: isoOrNull(health.lastReadAtMs),
    lastError: health.lastError,
  };
}

function percentile(samples: number[], pct: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1);
  return sorted[index];
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
