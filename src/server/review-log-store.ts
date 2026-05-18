import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  FINDING_EVIDENCE_REVIEW_CONFIDENCES,
  FINDING_EVIDENCE_REVIEW_FAILURE_KINDS,
  FINDING_EVIDENCE_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION,
  FINDING_EVIDENCE_REVIEW_PROMPT_VERSION,
  FINDING_EVIDENCE_REVIEW_SCHEMA_VERSION,
  FINDING_EVIDENCE_REVIEW_VERDICTS,
  sanitizeDiagnosticText,
  type FindingEvidenceReviewInvalidAttemptV1,
  type FindingEvidenceReviewV1,
} from '../core/finding-evidence-review.js';

export const FINDING_EVIDENCE_REVIEW_LOG_FILE = 'finding-evidence-reviews.jsonl';
export const FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION = 'finding-evidence-review-log-record.v1';

export type FindingEvidenceReviewLogRecordV1 =
  | {
      schemaVersion: typeof FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION;
      kind: 'valid_review';
      appendedAt: string;
      inputHash: string;
      review: FindingEvidenceReviewV1;
    }
  | {
      schemaVersion: typeof FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION;
      kind: 'invalid_attempt';
      appendedAt: string;
      inputHash: string;
      attempt: FindingEvidenceReviewInvalidAttemptV1;
    };

export interface ReviewLogReadDiagnostic {
  lineNumber: number;
  failureKind: 'malformed_json' | 'invalid_record';
  message: string;
}

export interface ReviewLogReadResult {
  records: FindingEvidenceReviewLogRecordV1[];
  diagnostics: ReviewLogReadDiagnostic[];
}

export class ReviewLogStore {
  private appendChain = Promise.resolve();

  constructor(private readonly path: string) {}

  static forKookrDir(kookrDir: string): ReviewLogStore {
    return new ReviewLogStore(join(kookrDir, FINDING_EVIDENCE_REVIEW_LOG_FILE));
  }

  append(record: FindingEvidenceReviewLogRecordV1): Promise<void> {
    const safeRecord = sanitizeRecord(record);
    this.appendChain = this.appendChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(safeRecord)}\n`, 'utf8');
    });
    return this.appendChain;
  }

  appendReview(review: FindingEvidenceReviewV1, inputHash: string, appendedAt = new Date()): Promise<void> {
    return this.append({
      schemaVersion: FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION,
      kind: 'valid_review',
      appendedAt: appendedAt.toISOString(),
      inputHash,
      review,
    });
  }

  appendInvalidAttempt(attempt: FindingEvidenceReviewInvalidAttemptV1, inputHash: string, appendedAt = new Date()): Promise<void> {
    return this.append({
      schemaVersion: FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION,
      kind: 'invalid_attempt',
      appendedAt: appendedAt.toISOString(),
      inputHash,
      attempt,
    });
  }

  async readAll(): Promise<ReviewLogReadResult> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return { records: [], diagnostics: [] };
      throw err;
    }

    const records: FindingEvidenceReviewLogRecordV1[] = [];
    const diagnostics: ReviewLogReadDiagnostic[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        diagnostics.push({
          lineNumber: index + 1,
          failureKind: 'malformed_json',
          message: 'line was not valid JSON',
        });
        continue;
      }
      if (!isFindingEvidenceReviewLogRecord(value)) {
        diagnostics.push({
          lineNumber: index + 1,
          failureKind: 'invalid_record',
          message: 'line did not match finding evidence review log schema',
        });
        continue;
      }
      records.push(sanitizeRecord(value));
    }
    return { records, diagnostics };
  }

}

function sanitizeRecord(record: FindingEvidenceReviewLogRecordV1): FindingEvidenceReviewLogRecordV1 {
  if (record.kind === 'valid_review') {
    return {
      ...record,
      review: {
        ...record.review,
        rationale: sanitizeModelText(record.review.rationale),
      },
    };
  }
  return {
    ...record,
    attempt: {
      ...record.attempt,
      error: sanitizeModelText(record.attempt.error),
    },
  };
}

function sanitizeModelText(value: string): string {
  return sanitizeDiagnosticText(value);
}

function isFindingEvidenceReviewLogRecord(value: unknown): value is FindingEvidenceReviewLogRecordV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION) return false;
  if (typeof value.appendedAt !== 'string' || !isIsoDate(value.appendedAt)) return false;
  if (typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.inputHash)) return false;
  if (value.kind === 'valid_review') return isFindingEvidenceReview(value.review);
  if (value.kind === 'invalid_attempt') return isFindingEvidenceReviewInvalidAttempt(value.attempt);
  return false;
}

function isFindingEvidenceReview(value: unknown): value is FindingEvidenceReviewV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== FINDING_EVIDENCE_REVIEW_SCHEMA_VERSION) return false;
  if (typeof value.candidateId !== 'string') return false;
  if (!(FINDING_EVIDENCE_REVIEW_VERDICTS as readonly unknown[]).includes(value.verdict)) return false;
  if (!(FINDING_EVIDENCE_REVIEW_CONFIDENCES as readonly unknown[]).includes(value.confidence)) return false;
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every((ref) => typeof ref === 'string')) return false;
  if (typeof value.rationale !== 'string') return false;
  if (typeof value.reviewedAt !== 'string' || !isIsoDate(value.reviewedAt)) return false;
  return isReviewer(value.reviewer);
}

function isFindingEvidenceReviewInvalidAttempt(value: unknown): value is FindingEvidenceReviewInvalidAttemptV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== FINDING_EVIDENCE_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION) return false;
  if (typeof value.candidateId !== 'string') return false;
  if (typeof value.attemptedAt !== 'string' || !isIsoDate(value.attemptedAt)) return false;
  if (!isReviewer(value.reviewer)) return false;
  if (!(FINDING_EVIDENCE_REVIEW_FAILURE_KINDS as readonly unknown[]).includes(value.failureKind)) return false;
  if (typeof value.rawOutputHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.rawOutputHash)) return false;
  return typeof value.error === 'string';
}

function isReviewer(value: unknown): value is FindingEvidenceReviewV1['reviewer'] {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.model === 'string'
    && value.promptVersion === FINDING_EVIDENCE_REVIEW_PROMPT_VERSION;
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrno(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}
