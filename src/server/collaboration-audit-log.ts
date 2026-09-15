import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { appendJsonlWithRotation } from '../core/jsonl-rotation.js';
import {
  COLLABORATION_AUDIT_SCHEMA_VERSION,
  type CollaborationAuditActor,
  type CollaborationAuditEvent,
  type CollaborationAuditEventKind,
  type CollaborationAuditFailure,
  type CollaborationAuditTransportKind,
} from '../shared/contracts/collaboration-audit.js';
import { enforceOwnerOnlyFile } from '../shared/owner-only-mode.js';

/** File name of the append-only collaboration-audit log under the data dir. */
export const COLLABORATION_AUDIT_FILE_NAME = 'collaboration-audit.jsonl';

/**
 * Rotate `collaboration-audit.jsonl` before an append would exceed this size.
 * Conservative default in the 8–16 MB range used by the other JSONL sinks
 * (shared `audit.jsonl`, resource-watchdog audit). Without rotation this log
 * grew without bound and no prune sweep reaches it, so a long-lived file could
 * keep the node in disk-critical (issue #3252).
 */
export const DEFAULT_COLLABORATION_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
/** Rotated generations retained by default (keeps `.1` and `.2`). */
export const DEFAULT_COLLABORATION_AUDIT_ROTATED_GENERATIONS = 2;

/**
 * Measure the on-disk size of the active `collaboration-audit.jsonl` (issue
 * #3158). The active file is size-rotated (issue #3252) and no prune sweep
 * reaches the family, so surfacing this size on `/api/health` makes remaining
 * growth visible. `stat`-only — never reads the file contents. Returns null
 * when the file is absent. After a rotation this is the new active file, not
 * the retained `.N` generations.
 */
export async function statCollaborationAuditLogSize(kookrDir: string): Promise<number | null> {
  try {
    return (await stat(join(kookrDir, COLLABORATION_AUDIT_FILE_NAME))).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface CollaborationAuditStatus {
  configured: boolean;
  writable: boolean;
  appendFailureCount: number;
  lastFailure?: CollaborationAuditFailure;
}

export interface CollaborationAuditAppendInput {
  actor: CollaborationAuditActor;
  profileId?: string;
  transportKind?: CollaborationAuditTransportKind;
  event: CollaborationAuditEventKind;
  taskId?: string;
  pairingId?: string;
  shareId?: string;
  grantId?: string;
  policyVersion?: number;
  decision?: 'allowed' | 'denied';
  reason?: string;
}

export class CollaborationAuditLog {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly ownerNodeId: () => string;
  private readonly maxBytes: number;
  private readonly rotatedGenerations: number;
  private lastFailure: CollaborationAuditFailure | undefined;
  private appendFailureCount = 0;
  /**
   * Serialize appends within this process so two writers cannot race on the
   * rotation helper's stat/rotate/append sequence (its intra-process contract).
   */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    kookrDir?: string;
    filePath?: string | null;
    now?: () => Date;
    idGenerator?: () => string;
    ownerNodeId?: string | (() => string);
    /** Override the rotation size cap (tests / specialized sinks). */
    maxBytes?: number;
    /** Override the retained rotated generations (tests / specialized sinks). */
    rotatedGenerations?: number;
  } = {}) {
    this.filePath = opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, COLLABORATION_AUDIT_FILE_NAME) : null);
    this.now = opts.now ?? (() => new Date());
    this.idGenerator = opts.idGenerator ?? (() => randomUUID());
    const configuredOwnerNodeId = opts.ownerNodeId;
    this.ownerNodeId = typeof configuredOwnerNodeId === 'function'
      ? configuredOwnerNodeId
      : () => configuredOwnerNodeId ?? 'local-owner-node';
    this.maxBytes = opts.maxBytes ?? DEFAULT_COLLABORATION_AUDIT_MAX_BYTES;
    this.rotatedGenerations = opts.rotatedGenerations ?? DEFAULT_COLLABORATION_AUDIT_ROTATED_GENERATIONS;
  }

  status(): CollaborationAuditStatus {
    return {
      configured: Boolean(this.filePath),
      writable: !this.lastFailure,
      appendFailureCount: this.appendFailureCount,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  async append(input: CollaborationAuditAppendInput): Promise<boolean> {
    if (!this.filePath) return true;
    const event: CollaborationAuditEvent = {
      schemaVersion: COLLABORATION_AUDIT_SCHEMA_VERSION,
      auditEventId: `collab-audit-${this.idGenerator()}`,
      ts: this.now().toISOString(),
      ownerNodeId: this.ownerNodeId(),
      actor: input.actor,
      transportKind: input.transportKind ?? 'privateNetwork',
      event: input.event,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.pairingId ? { pairingId: input.pairingId } : {}),
      ...(input.shareId ? { shareId: input.shareId } : {}),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const line = `${JSON.stringify(event)}\n`;
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
      this.appendFailureCount += 1;
      this.lastFailure = {
        at: this.now().toISOString(),
        reason: err instanceof Error ? err.message : String(err),
      };
      return false;
    }
  }

  private async writeRotated(filePath: string, line: string): Promise<void> {
    // Do not pass `fileMode` into the rotator: its post-append chmod throws
    // and would fail a durable write on exotic filesystems. Owner-only repair
    // stays best-effort (issue #3264).
    await appendJsonlWithRotation(filePath, line, {
      maxBytes: this.maxBytes,
      rotatedGenerations: this.rotatedGenerations,
    });
    enforceOwnerOnlyFile(filePath);
    // A pre-existing world-readable active file that just rotated to `.1`
    // keeps its old mode across rename; tighten retained generations too.
    for (let generation = 1; generation <= this.rotatedGenerations; generation++) {
      enforceOwnerOnlyFile(`${filePath}.${generation}`);
    }
  }
}
