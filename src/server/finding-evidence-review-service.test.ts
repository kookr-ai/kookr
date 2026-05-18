import { describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LlmClient } from '../core/llm-client.js';
import type { FindingEvidenceAuditRecord } from '../shared/contracts/anomalies.js';
import {
  FindingEvidenceReviewService,
  FindingEvidenceReviewServiceError,
  getOrCreateFindingEvidenceReviewHmacKey,
  readFindingEvidenceReviewConfigFromEnv,
  type FindingEvidenceCandidateReader,
} from './finding-evidence-review-service.js';

const HMAC_KEY = Buffer.from('fedcba9876543210fedcba9876543210');

function candidate(overrides: Partial<FindingEvidenceAuditRecord> = {}): FindingEvidenceAuditRecord {
  return {
    id: 'finding-1',
    agentId: 'agent-1',
    anomalyType: 'permission_blocked',
    explanation: 'Permission prompt appeared',
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
        lastEventType: 'permission_request',
        eventCount: 3,
      },
      {
        sampledAt: '2026-05-18T10:00:12.000Z',
        ageMs: 12_000,
        source: 'watchdog_tick',
        anomalyStillPresent: true,
        lastEventType: 'tool_use',
        eventCount: 5,
        paneChangedSincePrevious: true,
      },
    ],
    notes: [],
    ...overrides,
  };
}

function reader(records: FindingEvidenceAuditRecord[]): FindingEvidenceCandidateReader {
  return {
    listReviewCandidates: vi.fn(() => records),
  };
}

function llm(output: string | null): LlmClient {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    complete: vi.fn(async () => output),
  };
}

describe('FindingEvidenceReviewService', () => {
  test('estimate_only returns safe projections and does not call the model', async () => {
    const model = llm(JSON.stringify({}));
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([candidate()]),
      llmClient: model,
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 0,
        hmacKey: HMAC_KEY,
      },
      now: () => new Date('2026-05-18T10:05:00.000Z'),
    });

    const response = await service.review({});

    expect(response.mode).toBe('estimate_only');
    expect(response.dryRun.candidates).toHaveLength(1);
    expect(response.dryRun.candidates[0]).toEqual(expect.objectContaining({
      candidateId: 'finding-1',
      observationCount: 2,
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(model.complete).not.toHaveBeenCalled();
  });

  test('model_review validates output and returns valid review results', async () => {
    const model = llm(JSON.stringify({
      candidateId: 'finding-1',
      verdict: 'likely_false_positive',
      confidence: 'medium',
      evidenceRefs: ['finding-1:observation:2'],
      rationale: 'metadata shows activity after the permission request',
    }));
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([candidate()]),
      llmClient: model,
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 5,
        hmacKey: HMAC_KEY,
      },
      now: () => new Date('2026-05-18T10:05:00.000Z'),
    });

    const response = await service.review({ mode: 'model_review', limit: 1 });

    expect(response.results).toEqual([
      {
        status: 'valid',
        review: expect.objectContaining({
          schemaVersion: 'finding-evidence-review.v1',
          candidateId: 'finding-1',
          verdict: 'likely_false_positive',
          reviewer: {
            provider: 'fake-provider',
            model: 'fake-model',
            promptVersion: 'finding-evidence-review-prompt.v1',
          },
        }),
      },
    ]);
    expect(model.complete).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 15000,
      responseFormat: expect.objectContaining({ type: 'json_schema' }),
    }));
    const prompt = vi.mocked(model.complete).mock.calls[0]?.[0].userMessage ?? '';
    expect(prompt).not.toContain('Permission prompt appeared');
  });

  test('invalid model output returns invalid-attempt result', async () => {
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([candidate()]),
      llmClient: llm('not-json'),
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 5,
        hmacKey: HMAC_KEY,
      },
      now: () => new Date('2026-05-18T10:05:00.000Z'),
    });

    const response = await service.review({ mode: 'model_review' });

    expect(response.results).toEqual([
      {
        status: 'invalid_attempt',
        attempt: expect.objectContaining({
          schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
          candidateId: 'finding-1',
          failureKind: 'malformed_json',
          rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          error: 'model output was not valid JSON',
        }),
      },
    ]);
  });

  test('persisted_review appends each valid review or invalid attempt to the review log', async () => {
    const appendReview = vi.fn(async () => undefined);
    const appendInvalidAttempt = vi.fn(async () => undefined);
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([
        candidate({ id: 'finding-1', updatedAt: '2026-05-18T10:01:00.000Z' }),
        candidate({ id: 'finding-2', updatedAt: '2026-05-18T10:02:00.000Z' }),
      ]),
      llmClient: {
        provider: 'fake-provider',
        model: 'fake-model',
        complete: vi.fn(async ({ userMessage }) => {
          return userMessage.includes('"candidateId":"finding-2"')
            ? JSON.stringify({
              candidateId: 'finding-2',
              verdict: 'likely_false_positive',
              confidence: 'medium',
              evidenceRefs: ['finding-2:observation:2'],
              rationale: 'activity advanced',
            })
            : 'not-json';
        }),
      },
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 5,
        hmacKey: HMAC_KEY,
      },
      reviewLogStore: { appendReview, appendInvalidAttempt },
      now: () => new Date('2026-05-18T10:05:00.000Z'),
    });

    const response = await service.review({ mode: 'persisted_review', limit: 2 });

    expect(response.reviewLog).toEqual({ appendedRecords: 2 });
    expect(appendReview).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'finding-2', verdict: 'likely_false_positive' }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date('2026-05-18T10:05:00.000Z'),
    );
    expect(appendInvalidAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'finding-1', failureKind: 'malformed_json' }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date('2026-05-18T10:05:00.000Z'),
    );
  });

  test('model_review refuses to run without positive daily budget', async () => {
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([candidate()]),
      llmClient: llm(null),
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 0,
        hmacKey: HMAC_KEY,
      },
    });

    await expect(service.review({ mode: 'model_review' }))
      .rejects.toMatchObject(new FindingEvidenceReviewServiceError(
        'finding-review-budget-required',
        403,
        'model_review requires a positive daily budget',
      ));
  });

  test('reserves budget before awaited model calls so concurrent reviews cannot overspend', async () => {
    let releaseFirstCall: (() => void) | undefined;
    let markFirstCallStarted: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      markFirstCallStarted = resolve;
    });
    const model: LlmClient = {
      provider: 'fake-provider',
      model: 'fake-model',
      complete: vi.fn(async () => {
        markFirstCallStarted?.();
        await new Promise<void>((release) => {
          releaseFirstCall = release;
        });
        return JSON.stringify({
          candidateId: 'finding-1',
          verdict: 'likely_false_positive',
          confidence: 'medium',
          evidenceRefs: ['finding-1:observation:2'],
          rationale: 'activity advanced',
        });
      }),
    };
    const service = new FindingEvidenceReviewService({
      candidateReader: reader([candidate()]),
      llmClient: model,
      config: {
        enabled: true,
        maxCandidates: 5,
        timeoutMs: 15_000,
        dailyCostCents: 1,
        hmacKey: HMAC_KEY,
      },
    });

    const first = service.review({ mode: 'model_review' });

    await firstCallStarted;
    await expect(service.review({ mode: 'model_review' }))
      .rejects.toMatchObject({ code: 'finding-review-budget-exhausted' });
    releaseFirstCall?.();
    await first;
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  test('reads finding review config defaults and environment overrides', () => {
    expect(readFindingEvidenceReviewConfigFromEnv({}, HMAC_KEY)).toEqual({
      enabled: false,
      maxCandidates: 5,
      timeoutMs: 15000,
      dailyCostCents: 0,
      hmacKey: HMAC_KEY,
    });

    expect(readFindingEvidenceReviewConfigFromEnv({
      KOOKR_FINDING_REVIEW_ENABLED: 'true',
      KOOKR_FINDING_REVIEW_MAX_CANDIDATES: '3',
      KOOKR_FINDING_REVIEW_TIMEOUT_MS: '2500',
      KOOKR_FINDING_REVIEW_DAILY_COST_CENTS: '7',
    }, HMAC_KEY, 'abc123')).toEqual({
      enabled: true,
      maxCandidates: 3,
      timeoutMs: 2500,
      dailyCostCents: 7,
      hmacKey: HMAC_KEY,
      appGitSha: 'abc123',
    });
  });

  test('creates, reuses, and replaces the review HMAC key file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-key-'));
    try {
      const keyPath = join(dir, 'finding-evidence-review-hmac-key');
      const created = getOrCreateFindingEvidenceReviewHmacKey(dir);
      expect(created).toHaveLength(32);
      expect(existsSync(keyPath)).toBe(true);
      expect(readFileSync(keyPath, 'utf8').trim()).toMatch(/^[a-f0-9]{64}$/);

      const reused = getOrCreateFindingEvidenceReviewHmacKey(dir);
      expect(reused.equals(created)).toBe(true);

      writeFileSync(keyPath, 'not-a-valid-key');
      const replaced = getOrCreateFindingEvidenceReviewHmacKey(dir);
      expect(replaced).toHaveLength(32);
      expect(replaced.equals(created)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
