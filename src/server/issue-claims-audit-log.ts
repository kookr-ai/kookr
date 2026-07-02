import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ClaimEvent } from '../core/issue-claim-types.js';

export interface IssueClaimsAuditFailure {
  ts: string;
  message: string;
}

export interface IssueClaimsAuditStatus {
  configured: boolean;
  writable: boolean;
  lastFailure?: IssueClaimsAuditFailure;
}

/**
 * Single-authorship audit sink for issue-ownership claim decisions (RFC
 * rfc-issue-ownership-lock, R21). Unlike `CollaborationAuditLog`, this sink
 * is written only from inside `IssueClaimRegistry` — no other caller
 * re-derives rows. A write failure must never throw to the caller and must
 * never be silent: it is error-logged and recorded on `status()` so a
 * frozen audit log is distinguishable from a quiet day.
 */
export class IssueClaimsAuditLog {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private lastFailure: IssueClaimsAuditFailure | undefined;

  constructor(opts: { kookrDir?: string; filePath?: string | null; now?: () => Date } = {}) {
    this.filePath = opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, 'issue-claims-audit.jsonl') : null);
    this.now = opts.now ?? (() => new Date());
  }

  status(): IssueClaimsAuditStatus {
    return {
      configured: Boolean(this.filePath),
      writable: !this.lastFailure,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  async append(event: ClaimEvent): Promise<boolean> {
    if (!this.filePath) return true;
    const row = {
      ts: this.now().toISOString(),
      decision: event.decision,
      repo: event.repo,
      number: event.number,
      ...(event.requestingTaskId ? { requestingTaskId: event.requestingTaskId } : {}),
      ...(event.requestingSessionId ? { requestingSessionId: event.requestingSessionId } : {}),
      ...(event.priorOwnerTaskId ? { priorOwnerTaskId: event.priorOwnerTaskId } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    };

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf-8');
      this.lastFailure = undefined;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: IssueClaimsAuditFailure = { ts: this.now().toISOString(), message };
      this.lastFailure = failure;
      console.error(`[issue-claims-audit] append failed: ${message}`);
      return false;
    }
  }
}

/**
 * Fire-and-forget emit function for injecting into `IssueClaimRegistry`
 * (RFC R21: `emit(ClaimEvent)`). Failures are already logged inside
 * `append`, so the returned promise is deliberately swallowed here.
 */
export function bindAuditSink(log: IssueClaimsAuditLog): (event: ClaimEvent) => void {
  return (event: ClaimEvent): void => {
    void log.append(event);
  };
}
