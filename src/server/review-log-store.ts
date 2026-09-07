import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonlWithRotation } from '../core/jsonl-rotation.js';
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

/**
 * Rotate `finding-evidence-reviews.jsonl` before an append would exceed this
 * size. Without rotation the file grew without bound and every {@link
 * ReviewLogStore.readAll} re-read and re-parsed all review history since boot
 * (issue #3047). Sits in the 8–16 MB range used by the other JSONL sinks.
 */
export const DEFAULT_REVIEW_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Rotated generations retained by default (keeps `.1` and `.2`). */
export const DEFAULT_REVIEW_LOG_ROTATED_GENERATIONS = 2;
/**
 * Cap the number of bytes {@link ReviewLogStore.readAll} tails from the end of
 * the log. Bounds read + parse cost on the diagnostics endpoints and the
 * sampler so it no longer scales with total history since boot. Kept well above
 * the sampler's working set and the diagnostics read limits (100–1000 records),
 * so a ~2 MiB window of the most-recent records is more than enough context.
 */
export const DEFAULT_REVIEW_LOG_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface ReviewLogStoreOptions {
  /** Override the rotation size cap (tests / specialized sinks). */
  maxBytes?: number;
  /** Override the retained rotated generations (tests / specialized sinks). */
  rotatedGenerations?: number;
  /** Override the bounded tail-read window (tests / specialized sinks). */
  readMaxBytes?: number;
}

export interface FindingEvidenceReviewLogTargetV1 {
  candidateKind: 'false_positive' | 'false_negative';
  detectorTarget: string;
  inputSchemaVersion: string;
  promptVersion: string;
  appGitSha?: string;
}

export type FindingEvidenceReviewLogRecordV1 =
  | {
      schemaVersion: typeof FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION;
      kind: 'valid_review';
      appendedAt: string;
      inputHash: string;
      target?: FindingEvidenceReviewLogTargetV1;
      review: FindingEvidenceReviewV1;
    }
  | {
      schemaVersion: typeof FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION;
      kind: 'invalid_attempt';
      appendedAt: string;
      inputHash: string;
      target?: FindingEvidenceReviewLogTargetV1;
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
  private readonly maxBytes: number;
  private readonly rotatedGenerations: number;
  private readonly readMaxBytes: number;

  constructor(private readonly path: string, options: ReviewLogStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_REVIEW_LOG_MAX_BYTES;
    this.rotatedGenerations = options.rotatedGenerations ?? DEFAULT_REVIEW_LOG_ROTATED_GENERATIONS;
    this.readMaxBytes = options.readMaxBytes ?? DEFAULT_REVIEW_LOG_READ_MAX_BYTES;
  }

  static forKookrDir(kookrDir: string, options?: ReviewLogStoreOptions): ReviewLogStore {
    return new ReviewLogStore(join(kookrDir, FINDING_EVIDENCE_REVIEW_LOG_FILE), options);
  }

  append(record: FindingEvidenceReviewLogRecordV1): Promise<void> {
    const safeRecord = sanitizeRecord(record);
    // Serialize appends within the process so two writers cannot race on the
    // rotation helper's stat/rotate/append sequence (its intra-process contract).
    this.appendChain = this.appendChain.catch(() => undefined).then(async () => {
      await appendJsonlWithRotation(this.path, `${JSON.stringify(safeRecord)}\n`, {
        maxBytes: this.maxBytes,
        rotatedGenerations: this.rotatedGenerations,
      });
    });
    return this.appendChain;
  }

  appendReview(
    review: FindingEvidenceReviewV1,
    inputHash: string,
    appendedAt = new Date(),
    target?: FindingEvidenceReviewLogTargetV1,
  ): Promise<void> {
    return this.append({
      schemaVersion: FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION,
      kind: 'valid_review',
      appendedAt: appendedAt.toISOString(),
      inputHash,
      ...(target ? { target } : {}),
      review,
    });
  }

  appendInvalidAttempt(
    attempt: FindingEvidenceReviewInvalidAttemptV1,
    inputHash: string,
    appendedAt = new Date(),
    target?: FindingEvidenceReviewLogTargetV1,
  ): Promise<void> {
    return this.append({
      schemaVersion: FINDING_EVIDENCE_REVIEW_LOG_SCHEMA_VERSION,
      kind: 'invalid_attempt',
      appendedAt: appendedAt.toISOString(),
      inputHash,
      ...(target ? { target } : {}),
      attempt,
    });
  }

  /**
   * Read the most-recent window of the log. Rotation caps the file on disk and
   * this tails at most {@link readMaxBytes} from the end, so read + parse cost
   * stays bounded regardless of total history since boot (issue #3047). When the
   * file fits within the window the whole file is read and behavior is identical
   * to an unbounded read; when it is larger the leading partial line is dropped
   * and line-number diagnostics are numbered from the first complete line read.
   */
  async readAll(): Promise<ReviewLogReadResult> {
    let tail: { text: string; truncated: boolean };
    try {
      tail = await this.readBoundedTail();
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return { records: [], diagnostics: [] };
      throw err;
    }

    const records: FindingEvidenceReviewLogRecordV1[] = [];
    const diagnostics: ReviewLogReadDiagnostic[] = [];
    const lines = tail.text.split('\n');
    // A tailed window almost always begins mid-record; drop the partial first
    // line so we never emit spurious malformed-JSON diagnostics for it.
    if (tail.truncated) lines.shift();
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

  private async readBoundedTail(): Promise<{ text: string; truncated: boolean }> {
    const handle = await open(this.path, 'r');
    try {
      const { size } = await handle.stat();
      const truncated = size > this.readMaxBytes;
      const length = truncated ? this.readMaxBytes : size;
      if (length === 0) return { text: '', truncated: false };
      const position = truncated ? size - this.readMaxBytes : 0;
      const buffer = Buffer.alloc(length);
      // Decode only the bytes actually read: `Buffer.alloc` zero-fills, so a
      // short read would otherwise append trailing NUL bytes to (and corrupt)
      // the most-recent line. A single pread fills to EOF for a regular file,
      // but the range is not contractually guaranteed, so slice defensively.
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return { text: buffer.toString('utf8', 0, bytesRead), truncated };
    } finally {
      await handle.close();
    }
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
  if (value.target !== undefined && !isFindingEvidenceReviewLogTarget(value.target)) return false;
  if (value.kind === 'valid_review') return isFindingEvidenceReview(value.review);
  if (value.kind === 'invalid_attempt') return isFindingEvidenceReviewInvalidAttempt(value.attempt);
  return false;
}

function isFindingEvidenceReviewLogTarget(value: unknown): value is FindingEvidenceReviewLogTargetV1 {
  if (!isRecord(value)) return false;
  if (value.candidateKind !== 'false_positive' && value.candidateKind !== 'false_negative') return false;
  if (typeof value.detectorTarget !== 'string' || value.detectorTarget.trim() === '') return false;
  if (typeof value.inputSchemaVersion !== 'string' || value.inputSchemaVersion.trim() === '') return false;
  if (typeof value.promptVersion !== 'string' || value.promptVersion.trim() === '') return false;
  return value.appGitSha === undefined || typeof value.appGitSha === 'string';
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
