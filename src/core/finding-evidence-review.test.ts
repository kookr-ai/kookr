import { describe, expect, test } from 'vitest';
import type { FindingEvidenceAuditRecord } from '../shared/contracts/anomalies.js';
import {
  buildFindingEvidenceReviewInputV1,
  parseFindingEvidenceReviewOutputV1,
  projectFindingEvidenceReviewDryRunCandidateV1,
  selectM1FindingEvidenceReviewCandidates,
} from './finding-evidence-review.js';

const HMAC_KEY = Buffer.from('0123456789abcdef0123456789abcdef');

function record(overrides: Partial<FindingEvidenceAuditRecord> = {}): FindingEvidenceAuditRecord {
  return {
    id: 'finding-1',
    agentId: 'agent-1',
    anomalyType: 'needs_input',
    explanation: 'User prompt contained secret token=abc123 and private instructions',
    detectedAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:12.000Z',
    status: 'active',
    verdict: 'possible_false_positive',
    observations: [
      {
        sampledAt: '2026-05-18T10:00:00.000Z',
        ageMs: 0,
        source: 'event',
        anomalyStillPresent: true,
        lastEventType: 'stop',
        eventCount: 4,
        lastEventSeq: 10,
        paneHash: 'raw-pane-hash',
        paneExcerpt: 'raw terminal text that must not be sent',
      },
      {
        sampledAt: '2026-05-18T10:00:12.000Z',
        ageMs: 12_000,
        source: 'watchdog_tick',
        anomalyStillPresent: true,
        lastEventType: 'tool_use',
        eventCount: 7,
        lastEventSeq: 13,
        paneChangedSincePrevious: true,
        paneHash: 'second-pane-hash',
        paneExcerpt: 'more raw terminal text',
      },
    ],
    notes: ['Latest event no longer matches the finding.'],
    ...overrides,
  };
}

describe('finding evidence review core', () => {
  test('builds metadata-only input without raw explanations, pane hashes, excerpts, or notes', () => {
    const built = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY, appGitSha: 'abc123' });

    expect(built.input).toEqual(expect.objectContaining({
      schemaVersion: 'finding-evidence-review-input.v1',
      candidateId: 'finding-1',
      candidateKind: 'false_positive',
      agentId: 'agent-1',
    }));
    expect(built.input.finding).toEqual({
      type: 'needs_input',
      explanationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      detectedAt: '2026-05-18T10:00:00.000Z',
      status: 'active',
      auditVerdict: 'possible_false_positive',
    });
    expect(built.input.observations).toEqual([
      {
        observationId: 'finding-1:observation:1',
        sampledAt: '2026-05-18T10:00:00.000Z',
        ageMs: 0,
        source: 'event',
        anomalyStillPresent: true,
        lastEventType: 'stop',
        lastEventSeq: 10,
        eventCount: 4,
      },
      {
        observationId: 'finding-1:observation:2',
        sampledAt: '2026-05-18T10:00:12.000Z',
        ageMs: 12000,
        source: 'watchdog_tick',
        anomalyStillPresent: true,
        lastEventType: 'tool_use',
        lastEventSeq: 13,
        eventCount: 7,
        paneChangedSincePrevious: true,
      },
    ]);

    const serialized = JSON.stringify(built.input);
    expect(serialized).not.toContain('private instructions');
    expect(serialized).not.toContain('raw-pane-hash');
    expect(serialized).not.toContain('raw terminal text');
    expect(serialized).not.toContain('Latest event no longer matches');
    expect(built.privacyOmissions).toEqual(['finding.explanation', 'notes', 'observations.paneExcerpt', 'observations.paneHash']);
  });

  test('dry-run projection is safe and does not expose compact model input', () => {
    const auditRecord = record();
    const projection = projectFindingEvidenceReviewDryRunCandidateV1(
      auditRecord,
      buildFindingEvidenceReviewInputV1(auditRecord, { hmacKey: HMAC_KEY }),
      HMAC_KEY,
    );

    expect(projection).toEqual({
      candidateId: 'finding-1',
      anomalyType: 'needs_input',
      auditVerdict: 'possible_false_positive',
      observationCount: 2,
      ageMs: 12000,
      privacyOmissions: ['finding.explanation', 'notes', 'observations.paneExcerpt', 'observations.paneHash'],
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('observationId');
    expect(serialized).not.toContain('explanationHash');
    expect(serialized).not.toContain('raw terminal text');
  });

  test('selects only M1 false-positive-oriented candidates', () => {
    const candidates = selectM1FindingEvidenceReviewCandidates([
      record({ id: 'supported', verdict: 'supports_finding', updatedAt: '2026-05-18T10:02:00.000Z' }),
      record({ id: 'transient', verdict: 'transient_too_fast', updatedAt: '2026-05-18T10:01:00.000Z' }),
      record({ id: 'possible', verdict: 'possible_false_positive', updatedAt: '2026-05-18T10:03:00.000Z' }),
    ], 5);

    expect(candidates.map((candidate) => candidate.id)).toEqual(['possible', 'transient']);
  });

  test('validates evidence refs against compact observation ids', () => {
    const input = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY }).input;
    const result = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'likely_false_positive',
      confidence: 'high',
      evidenceRefs: ['finding-1:observation:2'],
      rationale: 'latest event advanced while finding stayed active',
    }), input, { provider: 'fake', model: 'reviewer' }, new Date('2026-05-18T10:05:00.000Z'));

    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.review).toEqual(expect.objectContaining({
        schemaVersion: 'finding-evidence-review.v1',
        candidateId: 'finding-1',
        verdict: 'likely_false_positive',
        reviewedAt: '2026-05-18T10:05:00.000Z',
      }));
    }
  });

  test('invalid model output returns invalid attempt instead of a review verdict', () => {
    const input = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY }).input;
    const result = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'likely_false_positive',
      confidence: 'high',
      evidenceRefs: ['missing-observation'],
      rationale: 'bad ref',
    }), input, { provider: 'fake', model: 'reviewer' }, new Date('2026-05-18T10:05:00.000Z'));

    expect(result).toEqual({
      status: 'invalid_attempt',
      attempt: expect.objectContaining({
        schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
        candidateId: 'finding-1',
        failureKind: 'invalid_evidence_refs',
        rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        error: 'evidenceRefs contained unknown observation id missing-observation',
      }),
    });
  });

  test('caps model-controlled invalid-attempt diagnostics before returning them', () => {
    const input = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY }).input;
    const result = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'likely_false_positive',
      confidence: 'high',
      evidenceRefs: [`bad-ref\n${'x'.repeat(1000)}`],
      rationale: 'bad ref',
    }), input, { provider: 'fake', model: 'reviewer' });

    expect(result.status).toBe('invalid_attempt');
    if (result.status === 'invalid_attempt') {
      expect(result.attempt.error).toHaveLength(600);
      expect(result.attempt.error).not.toContain('\n');
    }
  });

  test('caps model rationale text and strips control characters', () => {
    const input = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY }).input;
    const result = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'likely_false_positive',
      confidence: 'high',
      evidenceRefs: ['finding-1:observation:2'],
      rationale: `line one\n${'x'.repeat(800)}`,
    }), input, { provider: 'fake', model: 'reviewer' });

    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.review.rationale).toHaveLength(600);
      expect(result.review.rationale).not.toContain('\n');
    }
  });

  test('timing false positive verdict is only accepted for transient timing candidates', () => {
    const possibleInput = buildFindingEvidenceReviewInputV1(record(), { hmacKey: HMAC_KEY }).input;
    const invalid = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'timing_false_positive',
      confidence: 'medium',
      evidenceRefs: ['finding-1:observation:1'],
      rationale: 'too quick',
    }), possibleInput, { provider: 'fake', model: 'reviewer' });

    expect(invalid).toEqual({
      status: 'invalid_attempt',
      attempt: expect.objectContaining({
        error: 'timing_false_positive is only valid for transient timing candidates',
      }),
    });

    const transientInput = buildFindingEvidenceReviewInputV1(record({
      verdict: 'transient_too_fast',
      status: 'resolved',
    }), { hmacKey: HMAC_KEY }).input;
    const valid = parseFindingEvidenceReviewOutputV1(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'timing_false_positive',
      confidence: 'medium',
      evidenceRefs: ['finding-1:observation:1'],
      rationale: 'resolved quickly after the initial finding',
    }), transientInput, { provider: 'fake', model: 'reviewer' });

    expect(valid.status).toBe('valid');
    if (valid.status === 'valid') {
      expect(valid.review.verdict).toBe('timing_false_positive');
    }
  });
});
