import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ServerMessage } from '../shared/contracts/messages.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

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
 */
export class OperationalAlertSink {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private readonly logger: Pick<typeof console, 'error'>;
  private lastFailure: OperationalAlertSinkFailure | undefined;

  constructor(
    opts: {
      kookrDir?: string;
      filePath?: string | null;
      now?: () => Date;
      logger?: Pick<typeof console, 'error'>;
    } = {},
  ) {
    this.filePath =
      opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, 'operational-alerts.jsonl') : null);
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
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

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf-8');
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
}

/**
 * Fire-and-forget binding for injecting into edge-triggered alert emitters
 * (e.g. {@link ScheduleDeadManSwitch}). Failures are already logged inside
 * {@link OperationalAlertSink.append}, so the returned promise is deliberately
 * swallowed here.
 */
export function bindOperationalAlertSink(
  sink: OperationalAlertSink,
): (alert: AlertMessage) => void {
  return (alert: AlertMessage): void => {
    void sink.append(alert);
  };
}
