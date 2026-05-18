import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  FindingEvidenceReviewInvalidAttemptV1,
  FindingEvidenceReviewV1,
} from '../core/finding-evidence-review.js';
import {
  FINDING_EVIDENCE_REVIEW_LOG_FILE,
  ReviewLogStore,
} from './review-log-store.js';

const INPUT_HASH = 'a'.repeat(64);

function validReview(overrides: Partial<FindingEvidenceReviewV1> = {}): FindingEvidenceReviewV1 {
  return {
    schemaVersion: 'finding-evidence-review.v1',
    candidateId: 'finding-1',
    verdict: 'likely_false_positive',
    confidence: 'high',
    evidenceRefs: ['finding-1:observation:1'],
    rationale: 'metadata shows the terminal advanced after the finding',
    reviewedAt: '2026-05-18T10:05:00.000Z',
    reviewer: {
      provider: 'fake-provider',
      model: 'fake-model',
      promptVersion: 'finding-evidence-review-prompt.v1',
    },
    ...overrides,
  };
}

function invalidAttempt(overrides: Partial<FindingEvidenceReviewInvalidAttemptV1> = {}): FindingEvidenceReviewInvalidAttemptV1 {
  return {
    schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
    candidateId: 'finding-1',
    attemptedAt: '2026-05-18T10:05:00.000Z',
    reviewer: {
      provider: 'fake-provider',
      model: 'fake-model',
      promptVersion: 'finding-evidence-review-prompt.v1',
    },
    failureKind: 'malformed_json',
    rawOutputHash: 'b'.repeat(64),
    error: 'model output was not valid JSON',
    ...overrides,
  };
}

describe('ReviewLogStore', () => {
  test('appends and reads valid review and invalid-attempt records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir);

      await store.appendReview(validReview(), INPUT_HASH, new Date('2026-05-18T10:06:00.000Z'));
      await store.appendInvalidAttempt(invalidAttempt(), INPUT_HASH, new Date('2026-05-18T10:07:00.000Z'));

      const read = await store.readAll();
      expect(read.diagnostics).toEqual([]);
      expect(read.records).toEqual([
        expect.objectContaining({
          schemaVersion: 'finding-evidence-review-log-record.v1',
          kind: 'valid_review',
          inputHash: INPUT_HASH,
          review: expect.objectContaining({ verdict: 'likely_false_positive' }),
        }),
        expect.objectContaining({
          schemaVersion: 'finding-evidence-review-log-record.v1',
          kind: 'invalid_attempt',
          inputHash: INPUT_HASH,
          attempt: expect.objectContaining({
            failureKind: 'malformed_json',
            rawOutputHash: 'b'.repeat(64),
            reviewer: expect.objectContaining({ provider: 'fake-provider', model: 'fake-model' }),
          }),
        }),
      ]);

      const raw = await readFile(join(dir, FINDING_EVIDENCE_REVIEW_LOG_FILE), 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('skips malformed, partial, and schema-invalid lines with diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-invalid-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir);
      await store.appendReview(validReview({ candidateId: 'kept' }), INPUT_HASH);
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_LOG_FILE), [
        JSON.stringify((await store.readAll()).records[0]),
        '{not-json',
        JSON.stringify({ schemaVersion: 'finding-evidence-review-log-record.v1', kind: 'valid_review' }),
        '{"schemaVersion":"finding-evidence-review-log-record.v1"',
      ].join('\n'), 'utf8');

      const read = await store.readAll();
      expect(read.records).toHaveLength(1);
      expect(read.records[0]?.kind).toBe('valid_review');
      expect(read.diagnostics).toEqual([
        { lineNumber: 2, failureKind: 'malformed_json', message: 'line was not valid JSON' },
        { lineNumber: 3, failureKind: 'invalid_record', message: 'line did not match finding evidence review log schema' },
        { lineNumber: 4, failureKind: 'malformed_json', message: 'line was not valid JSON' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('caps untrusted model text for valid reviews and invalid attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-caps-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir);
      await store.appendReview(validReview({ candidateId: 'review', rationale: `line one\n${'x'.repeat(900)}` }), INPUT_HASH);
      await store.appendInvalidAttempt(invalidAttempt({ candidateId: 'attempt', error: `bad ref\n${'y'.repeat(900)}` }), INPUT_HASH);

      const read = await store.readAll();
      expect(read.records[0]?.kind).toBe('valid_review');
      if (read.records[0]?.kind === 'valid_review') {
        expect(read.records[0].review.rationale).toHaveLength(600);
        expect(read.records[0].review.rationale).not.toContain('\n');
      }
      expect(read.records[1]?.kind).toBe('invalid_attempt');
      if (read.records[1]?.kind === 'invalid_attempt') {
        expect(read.records[1].attempt.error).toHaveLength(600);
        expect(read.records[1].attempt.error).not.toContain('\n');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
