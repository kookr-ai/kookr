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
import { stat } from 'node:fs/promises';

const INPUT_HASH = 'a'.repeat(64);
const TARGET = {
  candidateKind: 'false_positive' as const,
  detectorTarget: 'permission_blocked',
  inputSchemaVersion: 'finding-evidence-review-input.v1',
  promptVersion: 'finding-evidence-review-prompt.v1',
  appGitSha: 'abc123',
};

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

  test('appends and reads detector target metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-target-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir);

      await store.appendReview(validReview(), INPUT_HASH, new Date('2026-05-18T10:06:00.000Z'), TARGET);
      await store.appendInvalidAttempt(invalidAttempt(), INPUT_HASH, new Date('2026-05-18T10:07:00.000Z'), TARGET);

      const read = await store.readAll();
      expect(read.diagnostics).toEqual([]);
      expect(read.records).toEqual([
        expect.objectContaining({
          kind: 'valid_review',
          target: TARGET,
        }),
        expect.objectContaining({
          kind: 'invalid_attempt',
          target: TARGET,
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('skips lines with invalid detector target metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-invalid-target-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir);
      await store.appendReview(validReview({ candidateId: 'kept' }), INPUT_HASH, new Date('2026-05-18T10:06:00.000Z'), TARGET);
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_LOG_FILE), [
        JSON.stringify((await store.readAll()).records[0]),
        JSON.stringify({
          schemaVersion: 'finding-evidence-review-log-record.v1',
          kind: 'valid_review',
          appendedAt: '2026-05-18T10:06:00.000Z',
          inputHash: INPUT_HASH,
          target: { ...TARGET, detectorTarget: '' },
          review: validReview({ candidateId: 'invalid-target' }),
        }),
      ].join('\n'), 'utf8');

      const read = await store.readAll();
      expect(read.records).toHaveLength(1);
      expect(read.records[0]?.kind).toBe('valid_review');
      expect(read.diagnostics).toEqual([
        { lineNumber: 2, failureKind: 'invalid_record', message: 'line did not match finding evidence review log schema' },
      ]);
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

  test('rotates the log so the on-disk file stays size-capped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-rotate-'));
    try {
      // One record serializes to ~500 bytes; a tiny cap forces frequent rotation.
      const store = ReviewLogStore.forKookrDir(dir, { maxBytes: 2048, rotatedGenerations: 2 });
      const logPath = join(dir, FINDING_EVIDENCE_REVIEW_LOG_FILE);

      for (let i = 0; i < 50; i += 1) {
        await store.appendReview(validReview({ candidateId: `finding-${i}` }), INPUT_HASH);
      }

      // The active file never grows past the cap (plus one final append).
      const activeSize = (await stat(logPath)).size;
      expect(activeSize).toBeLessThanOrEqual(2048 + 512);

      // Rotation shifted older history into the retained `.1` and `.2` generations.
      expect((await stat(`${logPath}.1`)).size).toBeGreaterThan(0);
      expect((await stat(`${logPath}.2`)).size).toBeGreaterThan(0);

      // Beyond the retained generations nothing lingers.
      await expect(stat(`${logPath}.3`)).rejects.toMatchObject({ code: 'ENOENT' });

      // After real rotation the active file still reads back cleanly and the
      // most-recent record is preserved.
      const read = await store.readAll();
      expect(read.diagnostics).toEqual([]);
      const last = read.records.at(-1);
      expect(last?.kind).toBe('valid_review');
      if (last?.kind === 'valid_review') expect(last.review.candidateId).toBe('finding-49');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readAll cost does not scale with total history since boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-bounded-'));
    try {
      // Large rotation cap keeps everything in one file; a small read window
      // bounds what readAll tails regardless of how much history accrues.
      const store = ReviewLogStore.forKookrDir(dir, {
        maxBytes: 64 * 1024 * 1024,
        readMaxBytes: 4096,
      });

      for (let i = 0; i < 40; i += 1) {
        await store.appendReview(validReview({ candidateId: `finding-${i}` }), INPUT_HASH);
      }
      const afterForty = await store.readAll();

      for (let i = 40; i < 200; i += 1) {
        await store.appendReview(validReview({ candidateId: `finding-${i}` }), INPUT_HASH);
      }
      const afterTwoHundred = await store.readAll();

      // The read window bounds record count well below total history, and adding
      // 5x more history does not grow what a single read returns.
      expect(afterForty.records.length).toBeLessThan(40);
      expect(afterTwoHundred.records.length).toBeLessThanOrEqual(afterForty.records.length + 1);
      expect(afterTwoHundred.records.length).toBeLessThan(200);

      // The most-recent record is always preserved, and the dropped partial
      // leading line never surfaces as a spurious diagnostic.
      const last = afterTwoHundred.records.at(-1);
      expect(last?.kind).toBe('valid_review');
      if (last?.kind === 'valid_review') expect(last.review.candidateId).toBe('finding-199');
      expect(afterTwoHundred.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('drops the partial leading line but still surfaces genuine diagnostics in a truncated window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-log-store-truncated-'));
    try {
      const store = ReviewLogStore.forKookrDir(dir, { readMaxBytes: 2048 });
      const logPath = join(dir, FINDING_EVIDENCE_REVIEW_LOG_FILE);

      // A canonical serialized valid line, taken from a real append.
      await store.appendReview(validReview({ candidateId: 'canonical' }), INPUT_HASH);
      const validLine = JSON.stringify((await store.readAll()).records[0]);

      // Build a file many windows larger than 2048 bytes so readAll tails only
      // the last window and drops its partial first line. Place a genuinely
      // malformed line near the end, well inside the window and after the
      // dropped partial line, followed by a trailing valid record.
      const filler = Array.from({ length: 30 }, () => validLine);
      const lines = [...filler, '{not-json-in-window', validLine];
      await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');

      const read = await store.readAll();

      // The window was actually truncated (far fewer than the 32 written lines).
      expect(read.records.length).toBeLessThan(30);
      // The dropped partial leading line produces no spurious diagnostic, but
      // the genuine malformed line inside the window is still reported once.
      expect(read.diagnostics).toHaveLength(1);
      expect(read.diagnostics[0]?.failureKind).toBe('malformed_json');
      expect(read.diagnostics[0]?.lineNumber).toBeGreaterThan(0);
      // The valid record after the malformed line still survives.
      expect(read.records.at(-1)?.kind).toBe('valid_review');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
