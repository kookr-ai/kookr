import { watch, type FSWatcher, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookEventInjector } from './hook-ingestion.js';

/** Default poll interval for the backup polling mechanism (ms). */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

export function splitHookRecords(content: string): { records: string[]; consumedChars: number } {
  const records: string[] = [];
  let consumedChars = 0;
  let i = 0;

  while (i < content.length) {
    while (i < content.length && /\s/.test(content[i])) i += 1;
    consumedChars = i;
    if (i >= content.length) break;

    const start = i;
    if (content[i] !== '{') {
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) break;
      records.push(content.slice(start, lineEnd));
      i = lineEnd + 1;
      consumedChars = i;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let complete = false;

    for (; i < content.length; i += 1) {
      const ch = content[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          records.push(content.slice(start, i));
          consumedChars = i;
          complete = true;
          break;
        }
      }
    }

    if (!complete) break;
  }

  return { records, consumedChars };
}

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
  private pollIntervalMs: number;
  private adapter: HookEventInjector;

  constructor(
    private hooksDir: string,
    adapter: HookEventInjector,
    options?: { pollIntervalMs?: number },
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.adapter = adapter;
  }

  /** Start watching a hook file for a tmux session.
   *  When replayExisting is true (e.g. after restart), reads from offset 0
   *  to rebuild anomaly state from all prior events. */
  watch(tmuxName: string, options?: { replayExisting?: boolean }): void {
    if (this.watchers.has(tmuxName)) return;

    const filePath = join(this.hooksDir, `${tmuxName}.jsonl`);
    const replay = options?.replayExisting ?? false;

    // Initialize offset: 0 to replay existing events, or file size to skip them
    if (replay) {
      this.offsets.set(tmuxName, 0);
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

      this.watchers.set(tmuxName, watcher);

      // Start backup poll alongside fs.watch
      this.startBackupPoll(tmuxName, filePath);

      // If replaying, immediately read existing content
      if (replay) {
        this.readNewLines(tmuxName, filePath);
      }
    } catch {
      // File might not exist yet — poll until it appears. Preserve the
      // caller's replay intent: when the file finally appears it almost
      // certainly already contains a SessionStart line that the agent
      // emitted between adapter.launch returning and this watch() call.
      // Without forcing replay on the retry, that line would be skipped
      // (offset = stats.size), leaving SessionInfo.claudeSessionId null
      // forever and silently breaking the Ralph cycler's Stop acceptance.
      this.pollUntilExists(tmuxName, filePath, { replayExisting: replay });
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
    if (!this.offsets.has(tmuxName)) return;
    const filePath = join(this.hooksDir, `${tmuxName}.jsonl`);
    await this.readNewLines(tmuxName, filePath);
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
  private async readNewLines(tmuxName: string, filePath: string): Promise<void> {
    if (this.reading.has(tmuxName)) return;
    this.reading.add(tmuxName);

    try {
      const content = await readFile(filePath, 'utf-8');
      const offset = this.offsets.get(tmuxName) ?? 0;
      const newContent = content.slice(offset);
      const { records, consumedChars } = splitHookRecords(newContent);
      this.offsets.set(tmuxName, offset + consumedChars);

      if (records.length === 0) return;

      for (const line of records) {
        if (!line.trim()) continue;
        try {
          this.adapter.injectHookEvent(tmuxName, line);
        } catch (err) {
          console.error(`Error parsing hook event for ${tmuxName}:`, err);
        }
      }
    } catch (err) {
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
        const fileStat = await stat(filePath);
        const knownOffset = this.offsets.get(tmuxName) ?? 0;
        if (fileStat.size > knownOffset) {
          // File grew but fs.watch didn't fire (or hasn't fired yet) — read now
          await this.readNewLines(tmuxName, filePath);
        }
      } catch {
        // File doesn't exist or I/O error — not critical, will retry
      }
    }, this.pollIntervalMs);

    this.pollIntervals.set(tmuxName, interval);
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
    options?: { replayExisting?: boolean },
  ): void {
    if (this.watchers.has(tmuxName)) return;

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
}
