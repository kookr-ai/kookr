import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { statCollaborationAuditLogSize } from './collaboration-audit-log.js';

/**
 * Cheap byte-size gauge for the two append-only audit logs in the
 * remote/collaboration layer (issue #3158): the command-journal audit family
 * (`audit.jsonl` + rotated `audit.*.jsonl` archives) and the collaboration
 * audit log (`collaboration-audit.jsonl`). Neither is reached by the
 * maintenance-prune sweep and neither exposes its size on any health surface,
 * so their growth is silent until the disk fills. This module measures them
 * with `stat` (plus one bounded, single-level directory listing) — never
 * reading file contents — so it is safe on the `/api/health` hot path.
 *
 * The remote command-journal owns the on-disk naming, but `src/remote/*` is a
 * purity-isolated layer that server code must not import at runtime. The two
 * naming constants below therefore mirror `CommandJournal.auditPathFor()`,
 * `AUDIT_ARCHIVE_RE`, and `nextArchivePath()` in
 * `src/remote/command-journal.ts` and must be kept in sync with them by hand.
 */

/** Active command-audit log file name; mirrors `CommandJournal.auditPathFor()`. */
const COMMAND_AUDIT_ACTIVE_FILE = 'audit.jsonl';
/**
 * Rotated command-audit archive matcher; mirrors `AUDIT_ARCHIVE_RE` and the
 * `audit.<stamp>.<pid>.<n>.jsonl` shape produced by `nextArchivePath()`. The
 * active `audit.jsonl` and the `audit.snapshot.json` sidecar do not match.
 */
const COMMAND_AUDIT_ARCHIVE_RE = /^audit\..+\.jsonl$/;

/** Byte sizes of the command-audit log family. */
export interface CommandAuditLogSizes {
  /** Byte size of the active `audit.jsonl`, or null when the file is absent. */
  activeBytes: number | null;
  /** Number of rotated `audit.*.jsonl` archive segments. */
  archiveCount: number;
  /** Total bytes across all rotated `audit.*.jsonl` archive segments. */
  archiveBytes: number;
}

/** Combined audit-log size block reported on `/api/health.auditLogSizes`. */
export interface AuditLogSizes {
  commandAudit: CommandAuditLogSizes;
  collaborationAudit: {
    /** Byte size of the active `collaboration-audit.jsonl`, or null when absent. */
    activeBytes: number | null;
  };
}

async function statSizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Measure the command-audit log family under `kookrDir`. `stat`-only plus one
 * bounded, single-level directory listing — never reads file contents. An
 * absent active file reports `activeBytes: null`; a missing data directory
 * reports zeroed archive fields. Archive entries that race a deletion between
 * the listing and the `stat` are skipped.
 */
export async function statCommandAuditLogSizes(kookrDir: string): Promise<CommandAuditLogSizes> {
  const activeBytes = await statSizeOrNull(join(kookrDir, COMMAND_AUDIT_ACTIVE_FILE));

  let entries: string[];
  try {
    entries = await readdir(kookrDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { activeBytes, archiveCount: 0, archiveBytes: 0 };
    }
    throw err;
  }

  let archiveCount = 0;
  let archiveBytes = 0;
  for (const entry of entries) {
    if (!COMMAND_AUDIT_ARCHIVE_RE.test(entry)) continue;
    const size = await statSizeOrNull(join(kookrDir, entry));
    if (size === null) continue; // raced deletion between listing and stat
    archiveCount += 1;
    archiveBytes += size;
  }
  return { activeBytes, archiveCount, archiveBytes };
}

/**
 * Measure both audit logs under `kookrDir` for the `/api/health` size gauge
 * (issue #3158). `stat`-only; degrades to null for absent files. Never
 * publishes file paths — reports bytes/counts only.
 */
export async function collectAuditLogSizes(kookrDir: string): Promise<AuditLogSizes> {
  const [commandAudit, collaborationActiveBytes] = await Promise.all([
    statCommandAuditLogSizes(kookrDir),
    statCollaborationAuditLogSize(kookrDir),
  ]);
  return {
    commandAudit,
    collaborationAudit: { activeBytes: collaborationActiveBytes },
  };
}
