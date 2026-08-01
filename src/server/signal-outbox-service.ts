/**
 * Background drain for the durable agent-side signal outbox (issue #1541).
 *
 * When agents raise `kookr signal <verb>` while the daemon is down, the CLI
 * write-behinds the signal under `~/.kookr/playbook-state/signal-outbox/`.
 * This service flushes that spool on boot and on a short interval by applying
 * each entry directly against the local TaskStore (no HTTP hop — same process).
 *
 * Permanent failures (unknown / terminal task) drop the entry; transient
 * internal errors leave it for a later tick.
 */

import { isTerminalStatus } from '../core/task-status.js';
import type { TaskStore } from '../core/tasks.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import {
  defaultSignalOutboxDir,
  drainSignalOutbox,
  readPendingSignals,
  type DrainSignalResult,
  type SignalOutboxEntry,
} from '../core/signal-outbox.js';
import {
  evaluateLessonDecisionGate,
  hooksDirFromKookrDir,
  isLessonDecisionGateEnabled,
  resolveTaskLessonDecision,
} from '../core/lesson-decision.js';
import {
  isMergeRequiredGateEnabled,
  resolveMergeRequiredGate,
} from '../core/merge-required.js';

/** Default drain interval: 30 seconds — signals are more time-sensitive than lessons. */
export const DEFAULT_SIGNAL_OUTBOX_DRAIN_INTERVAL_MS = 30_000;

/** Initial drain shortly after boot so a pre-existing spool does not wait a full interval. */
export const DEFAULT_SIGNAL_OUTBOX_BOOT_DELAY_MS = 5_000;

export interface SignalOutboxServiceOptions {
  taskStore: TaskStore;
  spoolDir?: string;
  intervalMs?: number;
  bootDelayMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /**
   * Optional hook fired when a completion_ready signal is newly applied
   * (mirrors the HTTP route's onTaskOutcome). Not fired on pure signalId
   * replays.
   */
  onTaskOutcome?: (
    taskId: string,
    outcome: { kind: 'completion_ready'; note?: string },
  ) => void;
  /** Optional snapshot broadcast after any successful deliver. */
  onDelivered?: () => void;
  /**
   * Kookr data dir (contains `hooks/`). When set, completion_ready drains
   * enforce the same lesson-decision gate as the HTTP signal route so the
   * outbox cannot silently bypass issue #1538 / #1608.
   */
  kookrDir?: string;
}

export interface SignalOutboxTickResult {
  pendingBefore: number;
  drained: DrainSignalResult;
}

export class SignalOutboxService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly taskStore: TaskStore;
  private readonly spoolDir: string;
  private readonly intervalMs: number;
  private readonly bootDelayMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly onTaskOutcome?: SignalOutboxServiceOptions['onTaskOutcome'];
  private readonly onDelivered?: () => void;
  private readonly kookrDir?: string;

  constructor(opts: SignalOutboxServiceOptions) {
    this.taskStore = opts.taskStore;
    this.spoolDir = opts.spoolDir ?? defaultSignalOutboxDir();
    this.intervalMs = opts.intervalMs ?? DEFAULT_SIGNAL_OUTBOX_DRAIN_INTERVAL_MS;
    this.bootDelayMs = opts.bootDelayMs ?? DEFAULT_SIGNAL_OUTBOX_BOOT_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.onTaskOutcome = opts.onTaskOutcome;
    this.onDelivered = opts.onDelivered;
    this.kookrDir = opts.kookrDir;
  }

  start(): void {
    if (this.timer) return;
    this.log(
      `[signal-outbox] started (interval=${this.intervalMs}ms, dir=${this.spoolDir})`,
    );
    this.bootTimer = setTimeout(() => {
      void this.tick().catch((err) => {
        this.log(`[signal-outbox] initial tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.bootDelayMs);
    if (typeof this.bootTimer === 'object' && this.bootTimer && 'unref' in this.bootTimer) {
      this.bootTimer.unref();
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log(`[signal-outbox] tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.intervalMs);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<SignalOutboxTickResult> {
    if (this.running) {
      const pending = await readPendingSignals(this.spoolDir);
      return {
        pendingBefore: pending.length,
        drained: {
          attempted: 0,
          delivered: 0,
          permanentFailed: 0,
          transientFailed: 0,
          remaining: pending.length,
          deliveredIds: [],
          failedIds: [],
        },
      };
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<SignalOutboxTickResult> {
    const pendingBefore = (await readPendingSignals(this.spoolDir)).length;
    if (pendingBefore === 0) {
      return {
        pendingBefore: 0,
        drained: {
          attempted: 0,
          delivered: 0,
          permanentFailed: 0,
          transientFailed: 0,
          remaining: 0,
          deliveredIds: [],
          failedIds: [],
        },
      };
    }

    let anyDelivered = false;
    const drained = await drainSignalOutbox({
      spoolDir: this.spoolDir,
      now: this.now(),
      deliver: async (entry) => {
        const result = await this.deliverLocal(entry);
        if (result.outcome === 'delivered') anyDelivered = true;
        return result;
      },
    });

    if (drained.attempted > 0) {
      this.log(
        `[signal-outbox] drain attempted=${drained.attempted} delivered=${drained.delivered} `
          + `permanentFailed=${drained.permanentFailed} transientFailed=${drained.transientFailed} `
          + `remaining=${drained.remaining}`,
      );
    }
    if (anyDelivered) {
      try {
        this.onDelivered?.();
      } catch (err) {
        this.log(`[signal-outbox] onDelivered threw: ${err instanceof Error ? err.message : err}`);
      }
    }

    return { pendingBefore, drained };
  }

  /**
   * Apply one outbox entry against the local TaskStore. Pure signalId replays
   * count as delivered (safe to drop from the spool).
   *
   * completion_ready entries are subject to the same lesson-decision gate as
   * the HTTP route (issue #1608) so a daemon-down spool cannot re-open the
   * silent-bypass hole #1538 closed. A gate rejection is permanent_fail so the
   * entry is dropped (mirrors the CLI treating 409 as non-retryable).
   */
  async deliverLocal(entry: SignalOutboxEntry): Promise<{
    outcome: 'delivered' | 'permanent_fail' | 'transient_fail';
    error?: string;
  }> {
    try {
      const prior = this.taskStore.getProcessedSignal(entry.signalId);
      if (prior && prior.taskId === entry.taskId && prior.kind === entry.kind) {
        return { outcome: 'delivered' };
      }

      const task = this.taskStore.getTask(entry.taskId);
      if (!task) {
        return { outcome: 'permanent_fail', error: 'Task not found' };
      }
      if (isTerminalStatus(task.status)) {
        return {
          outcome: 'permanent_fail',
          error: `Cannot signal a task in status "${task.status}"`,
        };
      }

      if (entry.kind === 'completion_ready' && isLessonDecisionGateEnabled()) {
        const hooksDir = this.kookrDir ? hooksDirFromKookrDir(this.kookrDir) : undefined;
        if (hooksDir) {
          const resolved = await resolveTaskLessonDecision(task, hooksDir);
          const gate = evaluateLessonDecisionGate({
            sessionsScanned: resolved.sessionsScanned,
            decision: resolved.decision,
          });
          if (!gate.allow) {
            this.log(
              `[signal-outbox] drop completion_ready for ${entry.taskId}: ${gate.reason}`,
            );
            return {
              outcome: 'permanent_fail',
              error: gate.reason,
            };
          }
        }
      }

      // Issue #1836: same merge-required gate as the HTTP route so a daemon-down
      // spool cannot re-open the stranded-PR completion hole.
      if (entry.kind === 'completion_ready' && isMergeRequiredGateEnabled()) {
        const hooksDir = this.kookrDir ? hooksDirFromKookrDir(this.kookrDir) : undefined;
        const mergeGate = await resolveMergeRequiredGate(task, hooksDir);
        if (!mergeGate.allow) {
          this.log(
            `[signal-outbox] drop completion_ready for ${entry.taskId}: ${mergeGate.reason}`,
          );
          return {
            outcome: 'permanent_fail',
            error: mergeGate.reason,
          };
        }
      }

      const alreadyPending = this.taskStore.getPendingSignal(entry.taskId);
      const isSameKindReplay = alreadyPending?.kind === entry.kind;

      const signal: PendingAgentSignal = {
        kind: entry.kind,
        raisedAt: this.now().toISOString(),
        ...(entry.note ? { note: entry.note } : {}),
        signalId: entry.signalId,
        source: 'outbox',
      };
      this.taskStore.setPendingSignal(entry.taskId, signal);

      // Fire outcome only on the first completion_ready for this task state —
      // same-kind replays already had their hook fired by the original raise.
      if (entry.kind === 'completion_ready' && !isSameKindReplay && !prior) {
        try {
          this.onTaskOutcome?.(entry.taskId, {
            kind: 'completion_ready',
            ...(entry.note ? { note: entry.note } : {}),
          });
        } catch (err) {
          this.log(
            `[signal-outbox] onTaskOutcome threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      return { outcome: 'delivered' };
    } catch (err) {
      return {
        outcome: 'transient_fail',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
