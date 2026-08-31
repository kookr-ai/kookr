import { appendJsonlWithRotation } from './jsonl-rotation.js';

/**
 * Rotate shared `audit.jsonl` before an append would exceed this size.
 * Conservative default in the 8–16 MB range used by other JSONL sinks.
 */
export const DEFAULT_AUDIT_LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Rotated generations retained by default (keeps `.1` and `.2`). */
export const DEFAULT_AUDIT_LOG_ROTATED_GENERATIONS = 2;

export interface AppendAuditRowOptions {
  /** Override default maxBytes (tests / specialized sinks). */
  maxBytes?: number;
  /** Override default rotatedGenerations (tests / specialized sinks). */
  rotatedGenerations?: number;
  /** Observe a swallowed write failure without changing the no-throw contract. */
  onError?: (error: unknown) => void;
}

/**
 * Append one JSON row to the shared `audit.jsonl` audit log (same file and
 * append pattern `TaskLifecycleCommands` uses for deletion/batch-abort audit
 * rows — see src/server/use-cases/task-lifecycle-commands.ts). Extracted here
 * so system-initiated lifecycle actions (issue #1526 Phase A: completion-ready
 * TTL escalation, hung-task reaping) can write to the same durable trail
 * without depending on that class.
 *
 * Size-capped via {@link appendJsonlWithRotation} so a long-running server
 * cannot accumulate an arbitrarily large audit trail (issue #1942).
 *
 * Never throws — an audit-write failure must not block the lifecycle action
 * it is describing; failures are logged and swallowed, matching the existing
 * `writeTaskDeletionAudit` / `writeBatchAbortAudit` behavior.
 */
export async function appendAuditRow(
  auditLogPath: string | undefined,
  row: Record<string, unknown>,
  options: AppendAuditRowOptions = {},
): Promise<void> {
  if (!auditLogPath) return;
  try {
    await appendJsonlWithRotation(auditLogPath, `${JSON.stringify(row)}\n`, {
      maxBytes: options.maxBytes ?? DEFAULT_AUDIT_LOG_MAX_BYTES,
      rotatedGenerations: options.rotatedGenerations ?? DEFAULT_AUDIT_LOG_ROTATED_GENERATIONS,
    });
  } catch (err) {
    console.warn('[audit-log] failed to append audit row:', err);
    try {
      options.onError?.(err);
    } catch (observerError) {
      console.warn('[audit-log] failure observer threw:', observerError);
    }
  }
}
