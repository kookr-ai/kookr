import { readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';

export interface FileSnapshot {
  entries: Map<string, { type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>;
}

export function snapshotDir(root: string): FileSnapshot {
  const entries = new Map<string, { type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>();

  function walk(dir: string): void {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      const rel = relative(root, path);
      const stat = statSync(path);
      entries.set(rel, {
        type: name.isDirectory() ? 'dir' : name.isFile() ? 'file' : 'other',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (name.isDirectory()) walk(path);
    }
  }

  try {
    walk(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  return { entries };
}

export function assertKookrDiff(before: FileSnapshot, after: FileSnapshot): void {
  const forbiddenBasenames = new Set([
    'audit.db',
    'audit.jsonl',
    'command-journal.jsonl',
    'node-epoch',
    'policy-cache.json',
  ]);
  const isAllowedLocalOnlyChange = (entry: string, type: 'file' | 'dir' | 'other'): boolean => {
    // These files remain after a normal SQLite-backed startup and shutdown.
    // Match the migration writer's filename format without admitting arbitrary backups.
    if (type === 'file' && (
      entry === 'tasks.sqlite'
      || entry === 'server.lock.sqlite'
      || entry === 'last-good-health.json'
      || entry === 'timer-health.state.json'
      // The plugin auto-update store is written at server startup (auto-update-store.ts).
      || entry === 'plugin-auto-update.json'
      // The task-namer health snapshot is written after the first naming call (task-namer-health.ts, #3616).
      || entry === 'task-namer-health.json'
      // Written when the first achievement unlocks, after the launch that unlocked it has returned
      // (achievement-watcher.ts, saveAchievements). A slow run on a loaded host sees it; a fast one does not.
      || entry === 'achievements.json'
      // Written by the resource watchdog once it has taken a sample under pressure
      // (resource-watchdog-state.ts and resource-watchdog-audit.ts), so only on a loaded host.
      || entry === 'resource-watchdog.state.json'
      || entry === 'resource-watchdog-audit.jsonl'
      // The smoke restart kills its task, so startup recovery parks it for the operator's resume
      // decision (issue #4215): interrupted-tasks-service.ts writes the batch here.
      || entry === 'interrupted-tasks.json'
      || /^tasks\.json\.pre-sqlite-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry)
    )) return true;
    return entry === 'tasks.json'
      || /^tasks\.json\.daily\.\d{8}$/.test(entry)
      || entry === 'disposition.jsonl'
      || entry === 'oss-attempts.json'
      || entry === 'project-configs.json'
      || entry === 'detection-stats.json'
      || entry === 'schedules.json'
      || entry === 'schedule-rollups.json'
      || entry === 'hook-replay-checkpoints.json'
      || entry === 'activity'
      || entry.startsWith('activity/')
      || entry === 'hooks'
      || entry.startsWith('hooks/')
      || entry === 'sessions'
      || entry.startsWith('sessions/')
      || entry === 'settings'
      || entry.startsWith('settings/');
  };
  const errors: string[] = [];
  for (const [entry, meta] of after.entries) {
    const base = entry.split('/').at(-1) ?? entry;
    if (forbiddenBasenames.has(base) || entry.startsWith('remote/') || entry.startsWith('relay/')) {
      errors.push(`forbidden ${meta.type}: ${entry}`);
      continue;
    }
    const previous = before.entries.get(entry);
    if (!previous && !isAllowedLocalOnlyChange(entry, meta.type)) {
      errors.push(`new ${meta.type}: ${entry}`);
      continue;
    }
    if (previous && !isAllowedLocalOnlyChange(entry, meta.type) && (previous.type !== meta.type || previous.size !== meta.size || previous.mtimeMs !== meta.mtimeMs)) {
      errors.push(`changed ${meta.type}: ${entry}`);
    }
  }
  for (const [entry, meta] of before.entries) {
    if (!after.entries.has(entry) && !isAllowedLocalOnlyChange(entry, meta.type)) {
      errors.push(`removed: ${entry}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `~/.kookr contains unexpected state outside allowed local startup artifacts (SQLite, JSON, and session files):\n${errors.join('\n')}\n`
      + 'If the server is meant to write this file, add it to isAllowedLocalOnlyChange in scripts/local-only-smoke-files.ts '
      + '(with a comment naming the code that writes it). Otherwise find the code that writes it outside the allowed state.',
    );
  }
}
