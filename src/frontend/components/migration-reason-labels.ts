/**
 * Human-readable labels for the stable machine-readable reasons the migration
 * endpoints (`GET /api/tasks/migratable`, `POST /api/tasks/migrate`) return
 * when a task can't be migrated. Mirrors `NotMigratableReason` (src/core/
 * migration/migratability.ts) and `MigrateBlockReason` (src/server/use-cases/
 * migrate-tasks.ts) — kept as plain strings on the frontend side of the wire
 * boundary rather than importing those server-only types.
 */
const MIGRATION_REASON_LABELS: Record<string, string> = {
  status_not_migratable: "Task status doesn't support migration",
  workflow_owner_unsupported: 'Managed by an unsupported workflow (Ralph loop)',
  already_migrated: 'Already has an active migration',
  same_agent_use_restore: 'Same agent — use Restore instead',
  target_agent_unavailable: "Target agent isn't available right now",
  live_session_exists: 'Task has a live session',
  missing_cwd: 'No working directory on record',
  cwd_gone: 'Working directory no longer exists',
  git_unavailable: "Working directory isn't a usable git repo",
  missing_intent: 'No prompt to reconstruct from',
  worktree_contended: 'Worktree is shared or already migrating',
  queue_full: 'Launch queue is full',
  spawn_burst: 'Too many launches in a short window',
  launch_failed: 'Launch failed',
  migration_in_progress: 'Migration already in progress',
  not_found: 'Task not found',
};

/** Human-readable label for a migration block reason; falls back to the raw code. */
export function migrationReasonLabel(reason: string | undefined): string {
  if (!reason) return 'Not eligible';
  return MIGRATION_REASON_LABELS[reason] ?? reason;
}
