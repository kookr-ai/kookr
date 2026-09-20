import { join } from 'node:path';

import { appendJsonlWithRotation } from '../core/jsonl-rotation.js';
import { enforceOwnerOnlyFile } from '../shared/owner-only-mode.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

/** File name of the append-only operational-alert log under the data dir. */
export const OPERATIONAL_ALERTS_FILE_NAME = 'operational-alerts.jsonl';

/**
 * Rotate `operational-alerts.jsonl` before an append would exceed this size.
 * Same 16 MiB cap as the other JSONL sinks (`audit.jsonl`, resource-watchdog
 * audit, collaboration-audit). Without rotation this incident log grew without
 * bound and could itself contribute to the disk-critical state it records
 * (issue #3311).
 */
export const DEFAULT_OPERATIONAL_ALERT_SINK_MAX_BYTES = 16 * 1024 * 1024;
/** Rotated generations retained by default (keeps `.1` and `.2`). */
export const DEFAULT_OPERATIONAL_ALERT_SINK_ROTATED_GENERATIONS = 2;

export interface OperationalAlertSinkFailure {
  ts: string;
  message: string;
}

export interface OperationalAlertSinkStatus {
  configured: boolean;
  writable: boolean;
  lastFailure?: OperationalAlertSinkFailure;
}

/** One durable JSONL row: an operational-alert fire/clear transition. */
export interface OperationalAlertSinkRecord {
  /** ISO timestamp the transition was recorded. */
  ts: string;
  /** Transition kind — `fired` on the healthy→degraded edge, `recovered` on the way back. */
  state: 'fired' | 'recovered';
  /** Stable key correlating a fire with its recovery (e.g. `schedule:dead_man`). */
  key: string;
  /** Metric/rule identifier for operator filtering. */
  metric: string;
  /** Human-readable cause carried on the alert. */
  summary: string;
  /** Longer operator-facing explanation, when the alert carries one. */
  details?: string;
}

/**
 * Durable JSONL sink for operational-alert fire/clear transitions (issue #1709,
 * WS0.3 of #1699). Dead-man and (future) provider-health alerts are broadcast
 * over WebSocket only, so a fire→clear that happens while no client is
 * listening leaves no trace. This append-only sink records every such
 * transition so an operator can reconstruct an incident from the on-disk log
 * alone — the same durability contract as {@link IssueClaimsAuditLog} and the
 * task-lifecycle audit.jsonl pattern.
 *
 * Any `alert` message carrying `operationalAlert` metadata is recorded; generic
 * dashboard alerts (no metadata) are ignored, mirroring
 * `ResourceStatusService.recordOperationalAlert`. A write failure never throws
 * to the caller and is never silent: it is error-logged and surfaced on
 * {@link status} so a frozen sink is distinguishable from a quiet day.
 *
 * Writes are size-capped via {@link appendJsonlWithRotation}: an append that
 * would push the active file past {@link DEFAULT_OPERATIONAL_ALERT_SINK_MAX_BYTES}
 * renames it to `.1` and starts a new active file. The rotator appends; it
 * never rewrites the live file in place, so an interrupted write cannot
 * clobber prior rows (issue #3311). After a successful append the active file
 * is tightened to owner-only mode `0o600` so incident summaries are not group-
 * or world-readable on a shared host (issue #3307). Mode repair is best-effort
 * and never fails the write.
 */
export class OperationalAlertSink {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private readonly logger: Pick<typeof console, 'error'>;
  private readonly maxBytes: number;
  private readonly rotatedGenerations: number;
  private lastFailure: OperationalAlertSinkFailure | undefined;
  /**
   * Serialize appends within this process so two writers cannot race on the
   * rotation helper's stat/rotate/append sequence (its intra-process contract).
   */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    opts: {
      kookrDir?: string;
      filePath?: string | null;
      now?: () => Date;
      logger?: Pick<typeof console, 'error'>;
      /** Override the rotation size cap (tests / specialized sinks). */
      maxBytes?: number;
      /** Override the retained rotated generations (tests / specialized sinks). */
      rotatedGenerations?: number;
    } = {},
  ) {
    this.filePath =
      opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, OPERATIONAL_ALERTS_FILE_NAME) : null);
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
    this.maxBytes = opts.maxBytes ?? DEFAULT_OPERATIONAL_ALERT_SINK_MAX_BYTES;
    this.rotatedGenerations =
      opts.rotatedGenerations ?? DEFAULT_OPERATIONAL_ALERT_SINK_ROTATED_GENERATIONS;
  }

  status(): OperationalAlertSinkStatus {
    return {
      configured: Boolean(this.filePath),
      writable: !this.lastFailure,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  /**
   * Append one transition. Returns `true` when nothing was written because the
   * sink is unconfigured or the alert carries no operational metadata, or when
   * the write succeeds; `false` only on a write failure.
   */
  async append(alert: AlertMessage): Promise<boolean> {
    const metadata = alert.operationalAlert;
    // Generic dashboard alerts share the message type but are not operational
    // rule events, so they are intentionally excluded (matches the in-memory
    // history in ResourceStatusService.recordOperationalAlert).
    if (!metadata) return true;
    if (!this.filePath) return true;

    const row: OperationalAlertSinkRecord = {
      ts: this.now().toISOString(),
      state: metadata.state,
      key: metadata.key,
      metric: metadata.metric,
      summary: alert.summary,
      ...(alert.details ? { details: alert.details } : {}),
    };

    const line = `${JSON.stringify(row)}\n`;
    const filePath = this.filePath;
    const run = this.appendQueue
      .catch(() => {
        /* keep the queue alive after an earlier write failure */
      })
      .then(() => this.writeRotated(filePath, line));
    this.appendQueue = run;

    try {
      await run;
      this.lastFailure = undefined;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: OperationalAlertSinkFailure = { ts: this.now().toISOString(), message };
      this.lastFailure = failure;
      this.logger.error(`[operational-alert-sink] append failed: ${message}`);
      return false;
    }
  }

  private async writeRotated(filePath: string, line: string): Promise<void> {
    // Do not pass `fileMode` into the rotator: its post-append chmod throws
    // and would fail a durable write on exotic filesystems. Owner-only repair
    // of the active file stays best-effort (issue #3307), using the same helper
    // as collaboration-audit.jsonl. Tightening retained `.N` generations after
    // rename is optional and out of scope here.
    await appendJsonlWithRotation(filePath, line, {
      maxBytes: this.maxBytes,
      rotatedGenerations: this.rotatedGenerations,
    });
    enforceOwnerOnlyFile(filePath);
  }
}

/**
 * Fire-and-forget binding for injecting into edge-triggered alert emitters
 * (e.g. {@link ScheduleDeadManSwitch}). Failures are already logged inside
 * {@link OperationalAlertSink.append}, so the returned promise is deliberately
 * swallowed here.
 *
 * `also` is an optional side-effect hook (e.g. the durable ops-status card,
 * issue #1995). It is invoked for every alert that reaches the binder — the
 * sink still filters on `operationalAlert` metadata internally, and the hook
 * is expected to do the same. Throws from `also` are swallowed so a bad
 * side-effect can never suppress the durable JSONL write or the WS path.
 */
export function bindOperationalAlertSink(
  sink: OperationalAlertSink,
  also?: (alert: AlertMessage) => void,
): (alert: AlertMessage) => void {
  return (alert: AlertMessage): void => {
    void sink.append(alert);
    if (!also) return;
    try {
      also(alert);
    } catch {
      // Side-effects must never take down the operational-alert path.
    }
  };
}
