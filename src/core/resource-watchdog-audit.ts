/**
 * Resource-watchdog JSONL audit trail (issue #1724).
 *
 * Mirrors the budget-burn diagnostics sink: size-capped rotation, fire-and-
 * forget appends that never throw into the supervision path.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendJsonlWithRotation } from './jsonl-rotation.js';
import {
  RESOURCE_WATCHDOG_AUDIT_SCHEMA_VERSION,
  type ResourceWatchdogAuditAction,
  type ResourceWatchdogAuditRecord,
  type ResourceWatchdogSample,
  type ResourceWatchdogSpawnKind,
  type ResourceWatchdogTrigger,
} from './resource-watchdog-types.js';

/** Rotate resource-watchdog-audit.jsonl before an append would exceed this size. */
export const DEFAULT_RESOURCE_WATCHDOG_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
/** Rotated generations retained by default (keeps .1 and .2). */
export const DEFAULT_RESOURCE_WATCHDOG_AUDIT_ROTATED_GENERATIONS = 2;

export function defaultResourceWatchdogAuditPath(kookrDir?: string): string {
  return join(kookrDir ?? join(homedir(), '.kookr'), 'resource-watchdog-audit.jsonl');
}

export interface ResourceWatchdogAuditSink {
  append(record: ResourceWatchdogAuditRecord): void;
}

export class JsonlResourceWatchdogAuditSink implements ResourceWatchdogAuditSink {
  private readonly maxBytes: number;
  private readonly rotatedGenerations: number;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logFilePath: string,
    options: { maxBytes?: number; rotatedGenerations?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_RESOURCE_WATCHDOG_AUDIT_MAX_BYTES;
    this.rotatedGenerations =
      options.rotatedGenerations ?? DEFAULT_RESOURCE_WATCHDOG_AUDIT_ROTATED_GENERATIONS;
  }

  append(record: ResourceWatchdogAuditRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.appendQueue = this.appendQueue
      .catch(() => { /* keep the queue alive after an earlier write failure */ })
      .then(() => appendJsonlWithRotation(this.logFilePath, line, {
        maxBytes: this.maxBytes,
        rotatedGenerations: this.rotatedGenerations,
      }))
      .catch(() => { /* audit path; never affect supervision */ });
  }
}

/** In-memory sink for unit tests. */
export class MemoryResourceWatchdogAuditSink implements ResourceWatchdogAuditSink {
  readonly records: ResourceWatchdogAuditRecord[] = [];

  append(record: ResourceWatchdogAuditRecord): void {
    this.records.push(record);
  }
}

export function buildAuditRecord(input: {
  action: ResourceWatchdogAuditAction;
  timestamp: string;
  sample?: ResourceWatchdogSample;
  triggers?: ResourceWatchdogTrigger[];
  kind?: ResourceWatchdogSpawnKind;
  taskId?: string;
  error?: string;
  throttleRemainingMs?: number;
  spawnsInWindow?: number;
}): ResourceWatchdogAuditRecord {
  return {
    schemaVersion: RESOURCE_WATCHDOG_AUDIT_SCHEMA_VERSION,
    timestamp: input.timestamp,
    action: input.action,
    ...(input.triggers ? { triggers: input.triggers } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.throttleRemainingMs !== undefined
      ? { throttleRemainingMs: input.throttleRemainingMs }
      : {}),
    ...(input.spawnsInWindow !== undefined ? { spawnsInWindow: input.spawnsInWindow } : {}),
    ...(input.sample
      ? {
          sample: {
            swapUsedPercent: input.sample.swapUsedPercent,
            memAvailableMb: input.sample.memAvailableMb,
            oomKillTotal: input.sample.oomKillTotal,
            processCounts: input.sample.processCounts,
            orphanSessionCount: input.sample.orphanSessionCount,
            terminalLeakCount: input.sample.terminalLeakCount,
          },
        }
      : {}),
  };
}
