import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Append one JSON row to the shared `audit.jsonl` audit log (same file and
 * append pattern `TaskLifecycleCommands` uses for deletion/batch-abort audit
 * rows — see src/server/use-cases/task-lifecycle-commands.ts). Extracted here
 * so system-initiated lifecycle actions (issue #1526 Phase A: completion-ready
 * TTL escalation, hung-task reaping) can write to the same durable trail
 * without depending on that class.
 *
 * Never throws — an audit-write failure must not block the lifecycle action
 * it is describing; failures are logged and swallowed, matching the existing
 * `writeTaskDeletionAudit` / `writeBatchAbortAudit` behavior.
 */
export async function appendAuditRow(auditLogPath: string | undefined, row: Record<string, unknown>): Promise<void> {
  if (!auditLogPath) return;
  try {
    await mkdir(dirname(auditLogPath), { recursive: true });
    await appendFile(auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch (err) {
    console.warn('[audit-log] failed to append audit row:', err);
  }
}
