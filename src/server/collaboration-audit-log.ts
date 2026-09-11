import { appendFile, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  COLLABORATION_AUDIT_SCHEMA_VERSION,
  type CollaborationAuditActor,
  type CollaborationAuditEvent,
  type CollaborationAuditEventKind,
  type CollaborationAuditFailure,
  type CollaborationAuditTransportKind,
} from '../shared/contracts/collaboration-audit.js';

/** File name of the append-only collaboration-audit log under the data dir. */
export const COLLABORATION_AUDIT_FILE_NAME = 'collaboration-audit.jsonl';

/**
 * Measure the on-disk size of the active `collaboration-audit.jsonl` (issue
 * #3158). This append-only log has no rotation and no prune sweep reaches it,
 * so surfacing its size on `/api/health` makes otherwise-silent growth visible
 * before it can fill the disk. `stat`-only — never reads the file contents.
 * Returns null when the file is absent.
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
  private lastFailure: CollaborationAuditFailure | undefined;
  private appendFailureCount = 0;

  constructor(opts: {
    kookrDir?: string;
    filePath?: string | null;
    now?: () => Date;
    idGenerator?: () => string;
    ownerNodeId?: string | (() => string);
  } = {}) {
    this.filePath = opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, COLLABORATION_AUDIT_FILE_NAME) : null);
    this.now = opts.now ?? (() => new Date());
    this.idGenerator = opts.idGenerator ?? (() => randomUUID());
    const configuredOwnerNodeId = opts.ownerNodeId;
    this.ownerNodeId = typeof configuredOwnerNodeId === 'function'
      ? configuredOwnerNodeId
      : () => configuredOwnerNodeId ?? 'local-owner-node';
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

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
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
}
