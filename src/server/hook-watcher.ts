import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HookEventInjector } from './hook-ingestion.js';
import { splitHookRecords } from './hook-record-framing.js';

/** Default poll interval for the backup polling mechanism (ms). */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Byte length of the tail stored in a replay checkpoint for integrity checks. */
const REPLAY_CHECKPOINT_TAIL_BYTES = 4_096;

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
  /**
   * Resume offset. Historically named `offsetChars` (JS string index) when
   * `readNewLines` decoded the whole file; since the #1612 incremental-read
   * fix it stores a **byte** offset into the on-disk JSONL. Field name kept
   * for on-disk schema compatibility; older char-based checkpoints fail the
   * tail check and safely fall back to offset 0.
   */
  offsetChars: number;
  /** Exact trailing bytes at `offsetChars`, encoded as latin1 for 1:1 byte fidelity. */
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
  /** Records recovered from a rotated-out generation (`<file>.1`), issue #1566. */
  rotatedTailRecoveredCount: number;
  pollTickCount: number;
  pollChangeDetectedCount: number;
  /**
   * Backup-poll ticks suppressed because a prior tick was still in flight
   * (issue #2776). A rising count means disk reads are overrunning the poll
   * interval and overlap is being fenced instead of amplifying ingestion lag.
   */
  pollSkippedCount: number;
  /**
   * Backup-poll ticks whose body ran longer than the poll interval
   * (issue #2776). Distinguishes a genuine overrun (slow read) from a merely
   * late tick (event-loop drift), which `pollDrift*` already tracks.
   */
  pollOverrunCount: number;
  /** Duration of the most recent overrun tick, ms (issue #2776); null if none. */
  lastPollOverrunMs: number | null;
  /** Longest observed overrun tick, ms (issue #2776); null if none. */
  maxPollOverrunMs: number | null;
  drainNowCount: number;
  drainNowSkippedCount: number;
  lastPollDriftMs: number | null;
  maxPollDriftMs: number | null;
  p95PollDriftMs: number | null;
  lastDrainLatencyMs: number | null;
  maxDrainLatencyMs: number | null;
  p95DrainLatencyMs: number | null;
  lastReadAt: string | null;
  /**
   * The *current* error, or `null` when the watcher is healthy right now — the
   * authoritative current-status signal (the timestamps below are advisory). A
   * successful disk read clears this (issue #2811) so a recovered watcher that
   * resumed reading no longer looks actively degraded from a stale error (e.g.
   * a transient ENOENT while `fs.watch` fell back to polling). Recurring or
   * partial failures re-set it, so a genuinely broken watcher stays visible.
   * The clear is gated on a *proven* read (fresh bytes off disk), not a no-op
   * stat, so an idle watcher with no new hook activity keeps its last error
   * until it demonstrably reads again — the conservative "only a real read
   * proves health" choice.
   */
  lastError: string | null;
  /**
   * Cumulative count of every error recorded for this watcher across the
   * process lifetime. Retained even after `lastError` is cleared so recovery
   * never erases the diagnostic history that a watcher has been flapping
   * (issue #2811).
   */
  errorCount: number;
  /** ISO timestamp of the most recent recorded error, or `null` if none. */
  lastErrorAt: string | null;
  /**
   * ISO timestamp of the most recent recovery — when a successful read last
   * cleared a non-null `lastError`. `null` until the watcher has recovered from
   * at least one error. `lastErrorAt` newer than this means the current error
   * is fresh, not a stale leftover.
   */
  lastRecoveredAt: string | null;
}

export interface HookWatcherHealthSnapshot {
  schemaVersion: 'hook-watcher-health.v1';
  generatedAt: string;
  sessionCount: number;
  sessions: HookWatcherSessionHealth[];
}

/**
 * Cheap replay-checkpoint file gauges for `/api/health` + `kookr status`
 * (issue #2281). Intentionally avoids parsing the on-disk JSON — session count
 * comes from the in-memory envelope already held by the watcher; file size is
 * a single `stat`.
 */
export interface HookReplayCheckpointStats {
  sessionCount: number;
  fileBytes: number;
}

/**
 * Inputs for pure stale-checkpoint selection (issue #2385).
 * Kept free of I/O so unit tests can cover the policy without a filesystem.
 */
export interface SelectStaleReplayCheckpointKeysInput {
  /** Session key → durable checkpoint (only `filePath` is consulted). */
  sessions: Readonly<Record<string, { filePath: string }>>;
  /** Keys for sessions currently watched / about to be retained. */
  retainSessionKeys: ReadonlySet<string>;
  /** True when the checkpoint's hook JSONL path still exists on disk. */
  fileExists: (filePath: string) => boolean;
  /**
   * When true, also drop every non-retained key even if the hook file still
   * exists. Safe only after startup recovery has re-armed live watches — used
   * to clear historical terminal-session debt without waiting for hook-file GC.
   */
  dropUnwatched?: boolean;
}

/**
 * Select replay-checkpoint session keys that are safe to drop (issue #2385).
 *
 * - Live/retained sessions are never selected.
 * - Default: drop non-retained keys whose `filePath` is missing.
 * - `dropUnwatched: true`: drop all non-retained keys (post-recovery sweep).
 */
export function selectStaleReplayCheckpointKeys(
  input: SelectStaleReplayCheckpointKeysInput,
): string[] {
  const dropUnwatched = input.dropUnwatched === true;
  const stale: string[] = [];
  for (const [tmuxName, checkpoint] of Object.entries(input.sessions)) {
    if (input.retainSessionKeys.has(tmuxName)) continue;
    if (dropUnwatched || !input.fileExists(checkpoint.filePath)) {
      stale.push(tmuxName);
    }
  }
  return stale;
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
  rotatedTailRecoveredCount: number;
  pollTickCount: number;
  pollChangeDetectedCount: number;
  pollSkippedCount: number;
  pollOverrunCount: number;
  lastPollOverrunMs: number | null;
  maxPollOverrunMs: number | null;
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
  errorCount: number;
  lastErrorAtMs: number | null;
  lastRecoveredAtMs: number | null;
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
  // Holds the currently-armed self-scheduling backup-poll timeout per session
  // (issue #2776). Name kept for continuity; each entry is a `setTimeout`
  // handle re-armed after every tick settles, not a fixed `setInterval`.
  private pollIntervals = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Byte offset into each session's active hook JSONL. Advanced only after
   * complete records are framed — partial trailing records stay unconsumed so
   * a mid-write append is re-read once the record finishes (issue #1612).
   */
  private offsets = new Map<string, number>();
  /**
   * Last-observed inode of each session's ACTIVE hook file (issue #1566). The
   * writer bounds file growth by rotating `<file>` to `<file>.1` and creating a
   * fresh `<file>` (bin/kookr-hook-writer.js). Rotation renames, so the active
   * inode changes while `<file>.1` inherits the old one. Tracking the inode lets
   * readNewLines tell a rotation (recover the unread tail from `<file>.1`) apart
   * from an in-place truncation (same inode → plain reset-to-0, issue #703).
   */
  private inodes = new Map<string, number>();
  private reading = new Set<string>(); // Mutex: prevent concurrent reads for same agent
  /**
   * Sessions whose backup poll is logically active (issue #2776). Gates the
   * self-scheduling timer: a tick only re-arms the next timeout while its
   * session is still in this set, so a body that settles after `stop()` does
   * not resurrect the poll. Separate from `pollIntervals` (the armed handle),
   * which briefly holds a spent handle mid-tick before the re-arm.
   */
  private pollActive = new Set<string>();
  /**
   * Sessions with a backup-poll body currently executing (issue #2776).
   * In-flight guard: a second tick that fires while one is still running is
   * suppressed and counted, so a slow disk read produces at most one in-flight
   * backup poll per session instead of piling up concurrent reads.
   */
  private pollInFlight = new Set<string>();
  private healthBySession = new Map<string, MutableHookWatcherSessionHealth>();
  /**
   * Cumulative bytes pulled off disk by readNewLines (issue #1612).
   * Before the incremental-read fix this counted whole-file re-reads (file_size
   * × event_count allocation churn). After the fix it counts only appended
   * ranges — `cumulativeReadChars / readCount` is the average bytes actually
   * read per event, so a soak can confirm the bound landed.
   */
  private cumulativeReadChars = 0;
  /**
   * Monotonic count of readNewLines disk reads across the process lifetime
   * (issue #1612). Stat-first no-growth skips do **not** increment this.
   * Global, unlike per-session `health.readCount` which is dropped on unwatch —
   * so `cumulativeReadChars / cumulativeReadCount` stays meaningful as sessions
   * come and go.
   */
  private cumulativeReadCount = 0;
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
    // Cheap missing-file sweep only: no watches are armed yet, so
    // dropUnwatched would wipe every key and break startup resume.
    this.pruneStaleReplayCheckpoints();
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
    // Deactivate first so an in-flight tick's `finally` cannot re-arm the poll
    // after we clear its handle (issue #2776).
    this.pollActive.delete(tmuxName);
    const poll = this.pollIntervals.get(tmuxName);
    if (poll) {
      clearTimeout(poll);
      this.pollIntervals.delete(tmuxName);
    }
    this.pollInFlight.delete(tmuxName);
    this.offsets.delete(tmuxName);
    this.inodes.delete(tmuxName);
    this.reading.delete(tmuxName);
    this.healthBySession.delete(tmuxName);
    // Session intentionally ended — drop its durable resume offset so the
    // checkpoint map does not accumulate forever (issue #2385).
    this.deleteReplayCheckpoint(tmuxName);
  }

  /**
   * Stop all watchers. Live maps are cleared; durable replay checkpoints are
   * intentionally kept so a process restart can resume offsets for sessions
   * that are re-armed during startup recovery. Terminal sessions must go
   * through {@link stop} (or {@link pruneStaleReplayCheckpoints}) so their
   * keys are removed (issue #2385).
   */
  stopAll(): void {
    for (const [name, watcher] of this.watchers) {
      watcher.close();
      this.offsets.delete(name);
    }
    this.watchers.clear();
    // Deactivate before clearing handles so any in-flight tick's `finally`
    // cannot re-arm a poll (issue #2776).
    this.pollActive.clear();
    for (const [, poll] of this.pollIntervals) {
      clearTimeout(poll);
    }
    this.pollIntervals.clear();
    this.pollInFlight.clear();
    this.inodes.clear();
    this.reading.clear();
    this.healthBySession.clear();
  }

  /**
   * Drop stale replay-checkpoint entries and persist when anything changed
   * (issue #2385).
   *
   * @param options.dropUnwatched When true, also remove non-watched keys whose
   *   hook file still exists. Call only after startup recovery has re-armed
   *   live watches so resume offsets for resumed sessions are retained.
   * @returns Number of session keys removed from the in-memory map.
   */
  pruneStaleReplayCheckpoints(options?: { dropUnwatched?: boolean }): number {
    if (!this.replayCheckpointPath) return 0;
    const retainSessionKeys = this.liveReplayCheckpointRetainKeys();
    const stale = selectStaleReplayCheckpointKeys({
      sessions: this.replayCheckpoints.sessions,
      retainSessionKeys,
      fileExists: (filePath) => {
        try {
          return existsSync(filePath);
        } catch {
          return false;
        }
      },
      dropUnwatched: options?.dropUnwatched === true,
    });
    if (stale.length === 0) return 0;
    for (const tmuxName of stale) {
      delete this.replayCheckpoints.sessions[tmuxName];
    }
    this.persistReplayCheckpoints();
    return stale.length;
  }

  /**
   * Read-only retention/throughput counts for the memory ledger (issue #1612).
   * `cumulativeReadChars / readCount` is the average bytes actually read per
   * disk read (appended ranges only after the incremental-read fix). Both
   * counters are process-lifetime monotonic (not per-session, which is dropped
   * on unwatch) so the ratio stays meaningful across session churn.
   */
  getRetentionMetrics(): Record<string, number> {
    return {
      watchedSessions: this.watchers.size,
      pollIntervals: this.pollIntervals.size,
      offsets: this.offsets.size,
      readCount: this.cumulativeReadCount,
      cumulativeReadChars: this.cumulativeReadChars,
    };
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
   * Operator gauge for the replay-checkpoint store (issue #2281).
   *
   * - `null` when checkpoints are disabled (`replayCheckpointPath` unset).
   * - Otherwise `{ sessionCount, fileBytes }` from the in-memory session map
   *   plus `stat().size` — never a full-file JSON parse on the health path.
   * - Missing checkpoint file ⇒ `fileBytes: 0` (sessionCount still reflects
   *   the in-memory envelope, which starts empty until the first write).
   */
  getReplayCheckpointStats(): HookReplayCheckpointStats | null {
    if (!this.replayCheckpointPath) return null;
    const sessionCount = Object.keys(this.replayCheckpoints.sessions).length;
    let fileBytes = 0;
    try {
      fileBytes = statSync(this.replayCheckpointPath).size;
    } catch {
      // Missing/unreadable file is non-fatal: report zero bytes so health
      // stays cheap and operators still see the in-memory session count.
    }
    return { sessionCount, fileBytes };
  }

  /**
   * Read new lines since last **byte** offset. Serialized per agent to prevent
   * duplicates.
   *
   * Mutex is intentionally **skip-if-busy**, not queue-and-wait. If a caller
   * (drainNow, poll, or fs.watch) arrives while another read is in flight,
   * that caller no-ops and the in-flight read delivers the same data. This
   * keeps the watchdog tick from serializing behind a long disk read — a
   * future refactorer should not "fix" it to queue-and-wait without
   * re-evaluating watchdog-tick latency.
   *
   * Hot path (issue #1612 / #1620 hypothesis A): **stat-first** skip when the
   * file has not grown past the offset, otherwise read only the appended byte
   * range. Pre-fix this re-decoded the whole unboundedly-growing JSONL on
   * every fs.watch fire and every backup poll (multi-MB × event rate).
   */
  private async readNewLines(
    tmuxName: string,
    filePath: string,
    options?: { startupReplay?: boolean; replay?: boolean },
  ): Promise<void> {
    if (this.reading.has(tmuxName)) return;
    this.reading.add(tmuxName);

    try {
      const prevInode = this.inodes.get(tmuxName);
      const fileStat = await stat(filePath).catch(() => undefined);
      if (fileStat === undefined) return;

      let offset = this.offsets.get(tmuxName) ?? 0;

      // Truncation / rotation recovery.
      //
      // A ROTATION is the writer renaming the active <file> to <file>.1 and
      // creating a fresh <file> (bin/kookr-hook-writer.js). rename changes the
      // active inode, so an inode change is the definitive rotation signal —
      // more robust than a size compare, which misses the case where the fresh
      // generation already regrew past our old offset before this read (then
      // a byte-range read from the old offset would cut into the middle of
      // unrelated new bytes). Records in [offset..oldEnd] left with the
      // rotated generation unread, so recover that tail from <file>.1 before
      // dropping to the fresh file — a reader lagging more than a cap behind
      // would otherwise silently skip them (issue #1566, residual of #1433).
      //
      // A same-inode shrink is an in-place TRUNCATION/replace: the offset now
      // sits past end-of-file and a ranged read would return empty forever,
      // silently dropping every later record until restart (issue #703). Reset
      // to 0 and re-read the new file — no stale generation is re-read, so no
      // phantom re-injection. HookIngestion content-hash dedup absorbs any
      // boundary overlap; the common truncate-to-0 case has none at all.
      if (prevInode !== undefined && fileStat.ino !== prevInode) {
        await this.recoverRotatedTail(tmuxName, filePath, offset, prevInode, options);
        offset = 0;
        this.offsets.set(tmuxName, 0);
      } else if (offset > fileStat.size) {
        offset = 0;
        this.offsets.set(tmuxName, 0);
      }

      // Record the active inode so the next read can classify a shrink as a
      // rotation (inode changed) vs an in-place truncation (inode unchanged).
      this.inodes.set(tmuxName, fileStat.ino);

      // Stat-first guard: no growth → no disk read, no allocation.
      if (fileStat.size === offset) {
        return;
      }

      const start = offset;
      const length = fileStat.size - start;
      const buffer = await readFileRange(filePath, start, length);
      // Meter actual bytes pulled off disk (the ledger's churn signal).
      this.cumulativeReadChars += buffer.length;
      this.cumulativeReadCount += 1;

      const newContent = buffer.toString('utf-8');
      const { records, consumedChars } = splitHookRecords(newContent);
      // Map framed char consumption back to byte consumption. A trailing
      // partial record is left unconsumed so the next append re-reads it once
      // complete. Buffer.byteLength of the consumed prefix is correct for any
      // valid UTF-8 JSONL (hook writers emit complete UTF-8 records).
      const consumedBytes = Buffer.byteLength(newContent.slice(0, consumedChars), 'utf-8');
      this.offsets.set(tmuxName, start + consumedBytes);

      const health = this.getOrCreateHealth(tmuxName);
      health.readCount += 1;
      health.lastReadAtMs = Date.now();
      // Proven healthy read: the watcher just pulled fresh bytes off disk, so a
      // prior error (e.g. a transient ENOENT that dropped us to poll fallback)
      // is stale — clear it and timestamp the recovery so diagnostics stop
      // reporting a recovered watcher as degraded (issue #2811). `errorCount`
      // and `lastErrorAt` are retained, so a flapping watcher's history stays
      // visible, and a parse failure while injecting the records below re-sets
      // `lastError` to keep partial/recurring failures surfaced.
      if (health.lastError !== null) {
        health.lastError = null;
        health.lastRecoveredAtMs = health.lastReadAtMs;
      }
      const nonEmpty = records.filter((line) => line.trim()).length;
      health.recordCount += nonEmpty;
      if (options?.replay === true) {
        health.replayRecordCount += nonEmpty;
      }

      for (const line of records) {
        if (!line.trim()) continue;
        try {
          this.adapter.injectHookEvent(tmuxName, line, undefined, {
            startupReplay: options?.startupReplay === true,
            fileMtimeMs: fileStat.mtimeMs,
          });
        } catch (err) {
          this.recordHealthError(tmuxName, err);
          console.error(`Error parsing hook event for ${tmuxName}:`, err);
        }
      }

      if (options?.replay === true) {
        await this.writeReplayCheckpoint(tmuxName, filePath);
      }
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      console.error(`Error reading hook file for ${tmuxName}:`, err);
    } finally {
      this.reading.delete(tmuxName);
    }
  }

  /**
   * Recover the unread tail a writer rotation moved out of the active file
   * (issue #1566). When the writer rotates, it renames the active `<file>` to
   * `<file>.1` and starts a fresh `<file>` (bin/kookr-hook-writer.js
   * rotateHookFile). A reader that had consumed only `offset` bytes of the old
   * file would otherwise never observe records in `[offset..end]` — they left
   * with the rotated generation, which the live tail never reads. Read
   * `<file>.1` from the byte offset, confirm it carries the pre-rotation inode
   * (so an older, already-drained generation is never re-read), and inject the
   * unread tail. HookIngestion content-hash dedup absorbs any boundary overlap.
   *
   * Bounded to the single most-recent generation (`<file>.1`). If more than one
   * cap of data was written between reads (multiple rotations), older
   * generations are not walked: that would cost O(keep) whole-file re-reads on
   * every shrink, and the HTTP-push + ledger paths remain the backstop for that
   * rare regime — the same recovery contract the incremental fast paths already
   * rely on.
   */
  private async recoverRotatedTail(
    tmuxName: string,
    filePath: string,
    offset: number,
    prevInode: number,
    options?: { startupReplay?: boolean; replay?: boolean },
  ): Promise<void> {
    const rotatedPath = `${filePath}.1`;
    try {
      const rotatedStat = await stat(rotatedPath).catch(() => undefined);
      // Only the generation carrying the pre-rotation inode is the file whose
      // tail we lagged behind. A mismatch means either no rotation produced this
      // shrink or several rotations elapsed (the wanted generation aged past
      // `.1`); either way, re-reading would risk replaying stale history.
      if (rotatedStat === undefined || rotatedStat.ino !== prevInode) return;
      if (rotatedStat.size <= offset) return; // caught up at rotation time — nothing unread

      const buffer = await readFileRange(rotatedPath, offset, rotatedStat.size - offset);
      this.cumulativeReadChars += buffer.length;
      this.cumulativeReadCount += 1;

      const { records } = splitHookRecords(buffer.toString('utf-8'));
      let recovered = 0;
      for (const line of records) {
        if (!line.trim()) continue;
        try {
          this.adapter.injectHookEvent(tmuxName, line, undefined, {
            startupReplay: options?.startupReplay === true,
            fileMtimeMs: rotatedStat.mtimeMs,
          });
          recovered += 1;
        } catch (err) {
          this.recordHealthError(tmuxName, err);
          console.error(`Error parsing rotated hook event for ${tmuxName}:`, err);
        }
      }

      if (recovered > 0) {
        const health = this.getOrCreateHealth(tmuxName);
        health.recordCount += recovered;
        health.rotatedTailRecoveredCount += recovered;
        console.info('[hook-watcher] recovered rotated tail', { tmuxName, recovered });
      }
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      console.error(`Error recovering rotated tail for ${tmuxName}:`, err);
    }
  }

  /**
   * Start a backup poll for a hook file.
   *
   * Checks file size vs offset every pollIntervalMs — if they diverge, reads
   * missed events. This catches fs.watch failures on all platforms.
   *
   * The poll is a **self-scheduling** timeout, not `setInterval` (issue #2776).
   * A fixed interval fires again while a slow `stat`/`readNewLines` is still
   * running, stacking concurrent poll bodies that compete for the same disk —
   * amplifying the very ingestion lag the poll exists to heal. Here the next
   * tick is armed only after the current one settles ({@link scheduleBackupPoll}
   * runs from the tick's `finally`), so a transient slow disk delays the next
   * poll instead of piling up. {@link pollInFlight} is the authoritative guard
   * that also makes any residual overlap countable.
   */
  private startBackupPoll(tmuxName: string, filePath: string): void {
    if (this.pollActive.has(tmuxName)) return;
    this.pollActive.add(tmuxName);
    this.getOrCreateHealth(tmuxName).pollBackupActive = true;
    this.scheduleBackupPoll(tmuxName, filePath);
  }

  /** Arm the next backup-poll tick, but only while the session is still active. */
  private scheduleBackupPoll(tmuxName: string, filePath: string): void {
    // Re-check on every re-arm, not just at start(): a tick whose body settled
    // after stop() must not resurrect the poll (KB: guard timer callbacks on
    // the active flag).
    if (!this.pollActive.has(tmuxName)) return;
    const handle = setTimeout(() => {
      void this.runBackupPollTick(tmuxName, filePath);
    }, this.pollIntervalMs);
    this.pollIntervals.set(tmuxName, handle);
  }

  /**
   * One backup-poll tick: skip-if-busy, read on divergence, record overrun,
   * then re-arm the next tick (issue #2776).
   */
  private async runBackupPollTick(tmuxName: string, filePath: string): Promise<void> {
    if (this.pollInFlight.has(tmuxName)) {
      // A prior tick is still running — suppress the overlap and count it. The
      // self-scheduling timer normally prevents this, so a non-zero count is a
      // real signal that reads are overrunning the interval.
      this.getOrCreateHealth(tmuxName).pollSkippedCount += 1;
      return;
    }
    this.pollInFlight.add(tmuxName);
    const startedAtMs = Date.now();
    try {
      this.recordPollTick(tmuxName);
      const fileStat = await stat(filePath);
      const knownOffset = this.offsets.get(tmuxName) ?? 0;
      if (fileStat.size !== knownOffset) {
        // Both sides are byte offsets (issue #1612). Growth means fs.watch
        // missed an append; shrink means the file was truncated, rotated, or
        // replaced (issue #703), and fs.watch may not fire for an in-place
        // truncate. Either way, defer to readNewLines — the single authority
        // on framing: it range-reads from the offset and, when the offset now
        // sits past EOF, resets to 0 first.
        this.getOrCreateHealth(tmuxName).pollChangeDetectedCount += 1;
        await this.readNewLines(tmuxName, filePath);
      }
    } catch {
      // File doesn't exist or I/O error — not critical, next tick retries.
    } finally {
      this.pollInFlight.delete(tmuxName);
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs > this.pollIntervalMs) {
        const health = this.getOrCreateHealth(tmuxName);
        health.pollOverrunCount += 1;
        health.lastPollOverrunMs = elapsedMs;
        health.maxPollOverrunMs =
          health.maxPollOverrunMs === null ? elapsedMs : Math.max(health.maxPollOverrunMs, elapsedMs);
      }
      // Re-arm only after this body settled — the source of the anti-overlap
      // guarantee, independent of the in-flight guard above.
      this.scheduleBackupPoll(tmuxName, filePath);
    }
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
      rotatedTailRecoveredCount: 0,
      pollTickCount: 0,
      pollChangeDetectedCount: 0,
      pollSkippedCount: 0,
      pollOverrunCount: 0,
      lastPollOverrunMs: null,
      maxPollOverrunMs: null,
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
      errorCount: 0,
      lastErrorAtMs: null,
      lastRecoveredAtMs: null,
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
    const health = this.getOrCreateHealth(tmuxName);
    health.lastError = err instanceof Error ? err.message : String(err);
    health.errorCount += 1;
    health.lastErrorAtMs = Date.now();
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
      // `offsetChars` is a byte offset (see HookReplayCheckpoint). Tail is the
      // exact preceding bytes encoded as latin1 — compare raw bytes, not a
      // UTF-8 re-decode that could diverge at multi-byte boundaries.
      const offsetBytes = checkpoint.offsetChars;
      if (offsetBytes > stats.size) return 0;
      // latin1: one code unit per byte, so string length === byte length.
      const tailByteLen = checkpoint.offsetTail.length;
      if (tailByteLen > offsetBytes) return 0;
      const actualTail = readFileRangeSync(
        filePath,
        offsetBytes - tailByteLen,
        tailByteLen,
      ).toString('latin1');
      if (actualTail !== checkpoint.offsetTail) return 0;
      return offsetBytes;
    } catch {
      return 0;
    }
  }

  private async writeReplayCheckpoint(
    tmuxName: string,
    filePath: string,
  ): Promise<void> {
    if (!this.replayCheckpointPath) return;

    try {
      const stats = await stat(filePath);
      const offset = this.offsets.get(tmuxName) ?? 0;
      const tailByteLen = Math.min(REPLAY_CHECKPOINT_TAIL_BYTES, offset);
      const offsetTail = tailByteLen === 0
        ? ''
        : (await readFileRange(filePath, offset - tailByteLen, tailByteLen)).toString('latin1');
      // After awaits: stop()/prune may have unwatched this session. Do not
      // resurrect a key that is no longer live (issue #2385 race).
      if (!this.liveReplayCheckpointRetainKeys().has(tmuxName)) return;
      this.replayCheckpoints.sessions[tmuxName] = {
        filePath,
        dev: stats.dev,
        ino: stats.ino,
        sizeBytes: stats.size,
        offsetChars: offset,
        offsetTail,
      };
      this.persistReplayCheckpoints();
    } catch (err) {
      this.recordHealthError(tmuxName, err);
      console.warn(`[hook-watcher] failed to write replay checkpoint for ${tmuxName}:`, err);
    }
  }

  /**
   * Session keys that must keep a durable resume offset: anything still
   * tracked by a live watcher, backup poll, or offset map entry.
   */
  private liveReplayCheckpointRetainKeys(): Set<string> {
    return new Set<string>([
      ...this.watchers.keys(),
      ...this.pollIntervals.keys(),
      ...this.offsets.keys(),
    ]);
  }

  /** Remove one session key and persist when the durable store is enabled. */
  private deleteReplayCheckpoint(tmuxName: string): void {
    if (!this.replayCheckpointPath) return;
    if (!(tmuxName in this.replayCheckpoints.sessions)) return;
    delete this.replayCheckpoints.sessions[tmuxName];
    this.persistReplayCheckpoints();
  }

  /**
   * Atomically rewrite the durable checkpoint envelope (issue #2298 compact,
   * issue #2365 mode 0o600). No-op when checkpoints are disabled. Failures are
   * non-fatal — next successful write rewrites the file.
   */
  private persistReplayCheckpoints(): void {
    if (!this.replayCheckpointPath) return;
    const tmpPath = `${this.replayCheckpointPath}.tmp`;
    try {
      mkdirSync(dirname(this.replayCheckpointPath), { recursive: true });
      // Compact JSON (issue #2298): pretty-print multiplies bytes and stringify
      // time on the drain hot path when sessionCount is in the thousands.
      // Owner-only mode (issue #2365): checkpoints store raw hook JSONL tails
      // (tool inputs / assistant text) — match sibling secret durable writes.
      // mode on write only applies when the temp path is created; chmod forces
      // exact bits after open (umask / leftover .tmp) before rename.
      writeFileSync(tmpPath, `${JSON.stringify(this.replayCheckpoints)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      chmodSync(tmpPath, 0o600);
      renameSync(tmpPath, this.replayCheckpointPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
      console.warn('[hook-watcher] failed to persist replay checkpoints:', err);
    }
  }
}

/** Positioned byte-range read (async). Used by the incremental hot path. */
async function readFileRange(filePath: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Positioned byte-range read (sync). Startup checkpoint verification only. */
function readFileRangeSync(filePath: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
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
    rotatedTailRecoveredCount: health.rotatedTailRecoveredCount,
    pollTickCount: health.pollTickCount,
    pollChangeDetectedCount: health.pollChangeDetectedCount,
    pollSkippedCount: health.pollSkippedCount,
    pollOverrunCount: health.pollOverrunCount,
    lastPollOverrunMs: health.lastPollOverrunMs,
    maxPollOverrunMs: health.maxPollOverrunMs,
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
    errorCount: health.errorCount,
    lastErrorAt: isoOrNull(health.lastErrorAtMs),
    lastRecoveredAt: isoOrNull(health.lastRecoveredAtMs),
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
