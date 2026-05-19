import { describe, expect, test } from 'vitest';
import type { FindingEvidenceReviewLogRecordV1, FindingEvidenceReviewLogTargetV1 } from './review-log-store.js';
import { buildDetectorProposalReportResponseV1, buildDetectorProposalReportsV1 } from './detector-proposal-report.js';

const INPUT_HASH_A = 'a'.repeat(64);
const INPUT_HASH_B = 'b'.repeat(64);
const INPUT_HASH_C = 'c'.repeat(64);

const NEEDS_INPUT_TARGET: FindingEvidenceReviewLogTargetV1 = {
  candidateKind: 'false_positive',
  detectorTarget: 'needs_input',
  inputSchemaVersion: 'finding-evidence-review-input.v1',
  promptVersion: 'finding-evidence-review-prompt.v1',
  appGitSha: 'sha-a',
};

function validReview(
  overrides: {
    candidateId?: string;
    inputHash?: string;
    appendedAt?: string;
    target?: FindingEvidenceReviewLogTargetV1;
    omitTarget?: boolean;
    verdict?: 'supports_finding' | 'timing_false_positive' | 'likely_false_positive' | 'unclear';
    confidence?: 'low' | 'medium' | 'high';
    rationale?: string;
  } = {},
): FindingEvidenceReviewLogRecordV1 {
  const candidateId = overrides.candidateId ?? 'finding-1';
  return {
    schemaVersion: 'finding-evidence-review-log-record.v1',
    kind: 'valid_review',
    appendedAt: overrides.appendedAt ?? '2026-05-18T10:00:00.000Z',
    inputHash: overrides.inputHash ?? INPUT_HASH_A,
    ...(overrides.omitTarget ? {} : { target: overrides.target ?? NEEDS_INPUT_TARGET }),
    review: {
      schemaVersion: 'finding-evidence-review.v1',
      candidateId,
      verdict: overrides.verdict ?? 'likely_false_positive',
      confidence: overrides.confidence ?? 'high',
      evidenceRefs: [`${candidateId}:observation:1`],
      rationale: overrides.rationale ?? 'terminal advanced after the finding',
      reviewedAt: '2026-05-18T10:00:00.000Z',
      reviewer: {
        provider: 'fake-provider',
        model: 'fake-model',
        promptVersion: 'finding-evidence-review-prompt.v1',
      },
    },
  };
}

function invalidAttempt(overrides: {
  target?: FindingEvidenceReviewLogTargetV1;
  inputHash?: string;
  candidateId?: string;
} = {}): FindingEvidenceReviewLogRecordV1 {
  return {
    schemaVersion: 'finding-evidence-review-log-record.v1',
    kind: 'invalid_attempt',
    appendedAt: '2026-05-18T10:03:00.000Z',
    inputHash: overrides.inputHash ?? INPUT_HASH_C,
    target: overrides.target ?? NEEDS_INPUT_TARGET,
    attempt: {
      schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
      candidateId: overrides.candidateId ?? 'finding-invalid',
      attemptedAt: '2026-05-18T10:03:00.000Z',
      reviewer: {
        provider: 'fake-provider',
        model: 'fake-model',
        promptVersion: 'finding-evidence-review-prompt.v1',
      },
      failureKind: 'malformed_json',
      rawOutputHash: 'd'.repeat(64),
      error: 'model output was not valid JSON',
    },
  };
}

describe('detector proposal reports', () => {
  test('groups repeated review verdicts by detector target and creates advisory candidates', () => {
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'finding-1', inputHash: INPUT_HASH_A, confidence: 'high' }),
      validReview({ candidateId: 'finding-2', inputHash: INPUT_HASH_B, appendedAt: '2026-05-18T10:01:00.000Z', confidence: 'medium' }),
      validReview({ candidateId: 'finding-3', verdict: 'unclear', confidence: 'low' }),
      invalidAttempt(),
    ]);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.objectContaining({
      schemaVersion: 'detector-proposal-report.v1',
      detectorTarget: 'needs_input',
      candidateKind: 'false_positive',
      versions: {
        inputSchemaVersion: 'finding-evidence-review-input.v1',
        promptVersion: 'finding-evidence-review-prompt.v1',
        appGitSha: 'sha-a',
      },
      reviewCounts: {
        total: 4,
        falsePositive: 2,
        falseNegative: 0,
        invalid: 1,
        unclear: 1,
        supportsFinding: 0,
      },
      confidenceDistribution: { low: 1, medium: 1, high: 1 },
      inputHashes: [INPUT_HASH_A, INPUT_HASH_B, INPUT_HASH_C],
      proposal: expect.objectContaining({
        status: 'candidate',
        advisoryOnly: true,
        canExecuteCommands: false,
        canMutateDetectorConfig: false,
      }),
    }));
    expect(reports[0]?.evidence[0]).toEqual(expect.objectContaining({
      candidateId: 'finding-2',
      inputHash: INPUT_HASH_B,
      population: 'false_positive',
    }));
  });

  test('keeps schema and prompt versions separated for the same detector', () => {
    const nextVersionTarget: FindingEvidenceReviewLogTargetV1 = {
      ...NEEDS_INPUT_TARGET,
      inputSchemaVersion: 'finding-evidence-review-input.v2',
      appGitSha: 'sha-b',
    };
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'old-1', inputHash: INPUT_HASH_A }),
      validReview({ candidateId: 'new-1', inputHash: INPUT_HASH_B, target: nextVersionTarget }),
    ], { minPopulationReviews: 1 });

    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.versions.inputSchemaVersion).sort()).toEqual([
      'finding-evidence-review-input.v1',
      'finding-evidence-review-input.v2',
    ]);
  });

  test('distinguishes false-negative, supported, unclear, and invalid populations', () => {
    const missTarget: FindingEvidenceReviewLogTargetV1 = {
      candidateKind: 'false_negative',
      detectorTarget: 'attention_miss',
      inputSchemaVersion: 'attention-miss-review-input.v1',
      promptVersion: 'attention-miss-review-prompt.v1',
    };
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'miss-1', target: missTarget, verdict: 'supports_finding', confidence: 'high' }),
      validReview({ candidateId: 'supported-1', verdict: 'supports_finding', confidence: 'medium' }),
      validReview({ candidateId: 'unclear-1', verdict: 'unclear', confidence: 'low' }),
      invalidAttempt({ candidateId: 'bad-1' }),
    ], { minPopulationReviews: 1 });

    const missReport = reports.find((report) => report.detectorTarget === 'attention_miss');
    const needsInputReport = reports.find((report) => report.detectorTarget === 'needs_input');
    expect(missReport?.reviewCounts).toEqual(expect.objectContaining({
      falseNegative: 1,
      falsePositive: 0,
      invalid: 0,
      unclear: 0,
    }));
    expect(needsInputReport?.reviewCounts).toEqual(expect.objectContaining({
      falseNegative: 0,
      supportsFinding: 1,
      unclear: 1,
      invalid: 1,
    }));
  });

  test('returns insufficient evidence below threshold', () => {
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'finding-1', confidence: 'high' }),
    ], { minPopulationReviews: 2 });

    expect(reports[0]?.proposal.status).toBe('insufficient_evidence');
  });

  test('keeps candidate evidence focused on the population that triggered the proposal', () => {
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'finding-old-1', inputHash: INPUT_HASH_A, appendedAt: '2026-05-18T10:00:00.000Z', confidence: 'high' }),
      validReview({ candidateId: 'finding-old-2', inputHash: INPUT_HASH_B, appendedAt: '2026-05-18T10:01:00.000Z', confidence: 'medium' }),
      invalidAttempt({ candidateId: 'finding-newer-invalid', inputHash: INPUT_HASH_C }),
    ], { maxEvidencePerReport: 1 });

    expect(reports[0]?.proposal.status).toBe('candidate');
    expect(reports[0]?.evidence).toEqual([
      expect.objectContaining({
        candidateId: 'finding-old-2',
        population: 'false_positive',
        evidenceRefs: ['finding-old-2:observation:1'],
      }),
    ]);
  });

  test('does not promote legacy records without target metadata into unknown detector candidates', () => {
    const reports = buildDetectorProposalReportsV1([
      validReview({ candidateId: 'legacy-1', inputHash: INPUT_HASH_A, omitTarget: true, confidence: 'high' }),
      validReview({ candidateId: 'legacy-2', inputHash: INPUT_HASH_B, omitTarget: true, confidence: 'high' }),
    ]);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.objectContaining({
      detectorTarget: 'unknown',
      proposal: expect.objectContaining({
        status: 'insufficient_evidence',
      }),
    }));
  });

  test('caps and escapes hostile model text in diagnostic evidence', () => {
    const reports = buildDetectorProposalReportsV1([
      validReview({
        rationale: `<script>alert("x")</script>\n${'a'.repeat(900)}`,
      }),
    ], { minPopulationReviews: 1, maxEvidencePerReport: 1 });

    const text = reports[0]?.evidence[0]?.rationaleEscapedText ?? '';
    expect(text).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(600);
  });

  test('wraps read diagnostics without turning them into proposals', () => {
    const response = buildDetectorProposalReportResponseV1([], [
      { lineNumber: 2, failureKind: 'malformed_json', message: 'line was not valid JSON' },
    ]);

    expect(response).toEqual({
      schemaVersion: 'detector-proposal-report-response.v1',
      reports: [],
      diagnostics: [
        { lineNumber: 2, failureKind: 'malformed_json', message: 'line was not valid JSON' },
      ],
    });
  });
});
