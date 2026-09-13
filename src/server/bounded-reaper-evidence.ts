import { appendAuditRow } from '../core/audit-log.js';
import { withTimeout } from '../core/with-timeout.js';

/** One second per ancillary append; lifecycle persistence has no such deadline. */
export const REAPER_EVIDENCE_TIMEOUT_MS = 1_000;

type EvidenceKind = 'disposition' | 'audit';

/**
 * `ok` preserves the underlying writer's success contract (including fsync for
 * dispositions). `timeout` means durability is unknown, `busy` means no write
 * was attempted, and `skipped` means the sink was not configured.
 */
export type ReaperEvidenceStatus = 'ok' | 'skipped' | 'error' | 'timeout' | 'busy';

/**
 * Keep stalled evidence writes from blocking reaps or accumulating a queue.
 * Each kind gets one outstanding write, shared across both reapers. Timing out
 * releases the caller, but keeps the slot occupied until the actual I/O settles.
 * No retries are queued; failures remain visible in logs and the reap alert.
 */
export class BoundedReaperEvidence {
  private readonly pending = new Set<EvidenceKind>();

  constructor(private readonly timeoutMs = REAPER_EVIDENCE_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Reaper evidence timeout must be finite and positive');
    }
  }

  async write(kind: EvidenceKind, write: () => Promise<void>, logPrefix: string): Promise<ReaperEvidenceStatus> {
    if (this.pending.has(kind)) {
      console.error(`${logPrefix}${describeReaperEvidenceFailure(kind, 'busy')}`);
      return 'busy';
    }
    this.pending.add(kind);
    let timedOut = false;
    // Attach both handlers before the deadline, including for synchronous
    // throws. Only actual settlement frees the slot, even after a timeout.
    const settled = Promise.resolve().then(write).then<ReaperEvidenceStatus, ReaperEvidenceStatus>(
      () => {
        this.pending.delete(kind);
        return 'ok';
      },
      (err: unknown) => {
        this.pending.delete(kind);
        console.error(
          `${logPrefix} ${kind} evidence ${timedOut ? 'late failure' : 'write failed'}; ` +
          `evidence may be missing: ${String(err).slice(0, 512)}`,
        );
        return 'error';
      },
    );
    const status = await withTimeout<ReaperEvidenceStatus>(settled, this.timeoutMs, 'timeout');
    if (status === 'timeout') {
      timedOut = true;
      console.error(`${logPrefix}${describeReaperEvidenceFailure(kind, status)} Wait budget: ${this.timeoutMs}ms.`);
    }
    return status;
  }
}

// Process-wide, not tied to the per-tick deps objects. At most two ancillary
// writes remain unresolved across the hard reaper and the hung-suspect sweep.
export const reaperEvidence = new BoundedReaperEvidence();

/** Empty on success/unconfigured sinks, otherwise suitable for the existing alert. */
export function describeReaperEvidenceFailure(kind: EvidenceKind, status: ReaperEvidenceStatus): string {
  switch (status) {
    case 'timeout': return ` ${kind} evidence write timed out; durability unknown.`;
    case 'busy': return ` ${kind} evidence write not attempted: a previous write is still unresolved.`;
    case 'error': return ` ${kind} evidence write failed; evidence may be missing.`;
    case 'ok':
    case 'skipped': return '';
  }
}

/** Preserve the audit helper's error signal for the bounded caller, including late failures. */
export async function writeReaperAuditRow(path: string, row: Record<string, unknown>): Promise<void> {
  let failure: { error: unknown } | undefined;
  await appendAuditRow(path, row, { onError: (error) => { failure = { error }; } });
  if (failure) throw failure.error;
}
