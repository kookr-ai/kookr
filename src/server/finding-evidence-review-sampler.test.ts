import { describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AttentionMissSamplingResult } from '../core/attention-miss-review.js';
import type { FindingEvidenceAuditRecord } from '../shared/contracts/anomalies.js';
import type { FindingEvidenceReviewModelRunner, FindingEvidenceReviewResponseV1 } from './finding-evidence-review-service.js';
import {
  FINDING_EVIDENCE_REVIEW_QUEUE_FILE,
  FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
  FindingEvidenceReviewQueueStore,
  FindingEvidenceReviewSampler,
  readFindingEvidenceReviewSamplerConfigFromEnv,
  type FindingEvidenceReviewSamplerConfig,
} from './finding-evidence-review-sampler.js';

const HMAC_KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const NOW = new Date('2026-05-18T10:05:00.000Z');

function candidate(overrides: Partial<FindingEvidenceAuditRecord> = {}): FindingEvidenceAuditRecord {
  return {
    id: 'finding-1',
    agentId: 'agent-1',
    anomalyType: 'permission_blocked',
    explanation: 'Permission prompt appeared',
    detectedAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:45.000Z',
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
        sampledAt: '2026-05-18T10:00:45.000Z',
        ageMs: 45_000,
        source: 'watchdog_tick',
        anomalyStillPresent: true,
        lastEventType: 'tool_use',
        eventCount: 5,
      },
    ],
    notes: [],
    ...overrides,
  };
}

function config(overrides: Partial<FindingEvidenceReviewSamplerConfig> = {}): FindingEvidenceReviewSamplerConfig {
  return {
    ...readFindingEvidenceReviewSamplerConfigFromEnv({
      KOOKR_FINDING_REVIEW_SAMPLER_ENABLED: 'true',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_INTERVAL: '10',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_DETECTOR: '10',
      KOOKR_FINDING_REVIEW_SAMPLER_MIN_AGE_MS: '30000',
      KOOKR_FINDING_REVIEW_SAMPLER_MIN_OBSERVATIONS: '2',
    }),
    ...overrides,
  };
}

function response(candidateId = 'finding-1'): FindingEvidenceReviewResponseV1 {
  return {
    schemaVersion: 'finding-evidence-review-response.v1',
    mode: 'persisted_review',
    dryRun: {
      schemaVersion: 'finding-evidence-review-dry-run.v1',
      candidates: [],
      wouldCallModel: false,
      estimatedTokens: 0,
    },
    results: [
      {
        status: 'valid',
        review: {
          schemaVersion: 'finding-evidence-review.v1',
          candidateId,
          verdict: 'likely_false_positive',
          confidence: 'medium',
          evidenceRefs: [`${candidateId}:observation:2`],
          rationale: 'metadata advanced after the finding',
          reviewedAt: NOW.toISOString(),
          reviewer: {
            provider: 'fake-provider',
            model: 'fake-model',
            promptVersion: 'finding-evidence-review-prompt.v1',
          },
        },
      },
    ],
    budget: {
      dailyCostCents: 10,
      spentTodayCents: 1,
      remainingTodayCents: 9,
    },
    reviewLog: { appendedRecords: 1 },
  };
}

async function makeSampler(options: {
  dir: string;
  records?: FindingEvidenceAuditRecord[];
  samplerConfig?: Partial<FindingEvidenceReviewSamplerConfig>;
  dailyCostCents?: number;
  serviceEnabled?: boolean;
  llmAvailable?: boolean;
  runner?: FindingEvidenceReviewModelRunner;
  reviewRecords?: unknown[];
  attentionMissSampler?: { sampleMissCandidates(): AttentionMissSamplingResult };
  now?: () => Date;
}) {
  const reviewLogStore = {
    readAll: vi.fn(async () => ({ records: options.reviewRecords ?? [], diagnostics: [] })),
    appendReview: vi.fn(async () => undefined),
    appendInvalidAttempt: vi.fn(async () => undefined),
  };
  const runner = options.runner ?? { review: vi.fn(async () => response()) };
  const sampler = new FindingEvidenceReviewSampler({
    candidateReader: { listReviewCandidates: vi.fn(() => options.records ?? [candidate()]) },
    llmClient: options.llmAvailable === false ? null : { provider: 'fake-provider', model: 'fake-model', complete: vi.fn() },
    serviceConfig: {
      enabled: options.serviceEnabled ?? true,
      maxCandidates: 5,
      timeoutMs: 1000,
      dailyCostCents: options.dailyCostCents ?? 10,
      hmacKey: HMAC_KEY,
    },
    samplerConfig: config(options.samplerConfig),
    reviewLogStore,
    queueStore: FindingEvidenceReviewQueueStore.forKookrDir(options.dir),
    ...(options.attentionMissSampler ? { attentionMissSampler: options.attentionMissSampler } : {}),
    now: options.now ?? (() => NOW),
    modelRunner: runner,
  });
  return { sampler, runner, reviewLogStore };
}

describe('FindingEvidenceReviewSampler', () => {
  test('is disabled when sampler config is disabled and does not call the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-disabled-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        samplerConfig: { enabled: false },
        runner,
      });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual({ sampler_disabled: 1 });
      expect(runner.review).not.toHaveBeenCalled();
      expect((await sampler.getStatus()).enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('sampler config is disabled by default', () => {
    expect(readFindingEvidenceReviewSamplerConfigFromEnv({}).enabled).toBe(false);
  });

  test('does not reserve budget when the review service is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-service-disabled-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        runner,
        serviceEnabled: false,
      });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual({ review_service_disabled: 1 });
      expect(summary.modelCallsAttempted).toBe(0);
      expect((await sampler.getStatus()).budget.spentCostCents).toBe(0);
      expect(runner.review).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('samples false-negative diagnostics before model-review provider gates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-miss-no-llm-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        runner,
        llmAvailable: false,
        attentionMissSampler: {
          sampleMissCandidates: vi.fn(() => ({
            counters: {
              eligible: 2,
              sampled: 1,
              reviewable: 1,
              unreviewable: 0,
              reviewed: 0,
              miss_confirmed: 0,
            },
            strata: {},
            seeds: [],
          })),
        },
      });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual({ llm_unavailable: 1 });
      expect(summary.falseNegative).toEqual({
        eligible: 2,
        sampled: 1,
        reviewable: 1,
        unreviewable: 0,
        reviewed: 0,
        miss_confirmed: 0,
      });
      expect(summary.modelCallsAttempted).toBe(0);
      expect(runner.review).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('deduplicates by candidate id plus input hash across runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-dedupe-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({ dir, runner });

      const first = await sampler.runOnce();
      const second = await sampler.runOnce();

      expect(first.enqueued).toBe(1);
      expect(first.reviewed).toBe(1);
      expect(second.enqueued).toBe(0);
      expect(second.skipped).toEqual(expect.objectContaining({ duplicate: 1 }));
      expect(runner.review).toHaveBeenCalledTimes(1);
      expect((await sampler.getStatus()).queue.reviewed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('tracks false-negative sampling diagnostics separately from the false-positive queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-miss-diag-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        runner,
        attentionMissSampler: {
          sampleMissCandidates: vi.fn(() => ({
            counters: {
              eligible: 5,
              sampled: 3,
              reviewable: 2,
              unreviewable: 1,
              reviewed: 1,
              miss_confirmed: 1,
            },
            strata: {},
            seeds: [],
          })),
        },
      });

      const summary = await sampler.runOnce();
      const status = await sampler.getStatus();

      expect(summary.falseNegative).toEqual({
        eligible: 5,
        sampled: 3,
        reviewable: 2,
        unreviewable: 1,
        reviewed: 1,
        miss_confirmed: 1,
      });
      expect(status.falseNegative).toEqual(summary.falseNegative);
      expect(status.queue.reviewed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('stops background calls when the daily cost budget is exhausted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-budget-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const records = [
        candidate({ id: 'finding-1', anomalyType: 'permission_blocked' }),
        candidate({ id: 'finding-2', anomalyType: 'needs_input' }),
      ];
      const { sampler } = await makeSampler({ dir, records, dailyCostCents: 1, runner });

      const summary = await sampler.runOnce();

      expect(summary.modelCallsAttempted).toBe(1);
      expect(summary.budgetExhausted).toBe(true);
      expect(summary.skipped).toEqual(expect.objectContaining({ daily_cost_budget: 1 }));
      expect(runner.review).toHaveBeenCalledTimes(1);
      expect((await sampler.getStatus()).budget.remainingCostCents).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses wall-clock candidate age for resolved transient candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-transient-age-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const records = [
        candidate({
          id: 'finding-1',
          status: 'resolved',
          verdict: 'transient_too_fast',
          detectedAt: '2026-05-18T10:00:00.000Z',
          updatedAt: '2026-05-18T10:00:02.000Z',
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
              sampledAt: '2026-05-18T10:00:02.000Z',
              ageMs: 2_000,
              source: 'event',
              anomalyStillPresent: false,
              lastEventType: 'tool_use',
              eventCount: 4,
            },
          ],
        }),
      ];
      const { sampler } = await makeSampler({ dir, records, runner });

      const summary = await sampler.runOnce();

      expect(summary.enqueued).toBe(1);
      expect(summary.reviewed).toBe(1);
      expect(summary.skipped).not.toHaveProperty('too_young');
      expect(runner.review).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('persists lease and budget before awaiting model review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-precall-save-'));
    try {
      const runner = {
        review: vi.fn(async () => {
          const queue = JSON.parse(await readFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), 'utf8')) as {
            entries: Array<{ state: string; leasedUntil?: string; runId?: string }>;
            budgetDays: Record<string, { spentCostCents: number; spentTokens: number }>;
          };
          expect(queue.entries[0]).toEqual(expect.objectContaining({
            state: 'in_progress',
            leasedUntil: expect.any(String),
            runId: expect.any(String),
          }));
          expect(queue.budgetDays['2026-05-18']?.spentCostCents).toBe(1);
          expect(queue.budgetDays['2026-05-18']?.spentTokens).toBeGreaterThan(0);
          return response();
        }),
      };
      const { sampler } = await makeSampler({ dir, runner });

      const summary = await sampler.runOnce();

      expect(summary.modelCallsAttempted).toBe(1);
      expect(summary.reviewed).toBe(1);
      expect(runner.review).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('caps reviews per detector type per interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-detector-'));
    try {
      const runner = { review: vi.fn(async () => response()) };
      const records = [
        candidate({ id: 'finding-1', anomalyType: 'permission_blocked' }),
        candidate({ id: 'finding-2', anomalyType: 'permission_blocked' }),
      ];
      const { sampler } = await makeSampler({
        dir,
        records,
        samplerConfig: { maxPerDetectorPerInterval: 1 },
        runner,
      });

      const summary = await sampler.runOnce();

      expect(summary.modelCallsAttempted).toBe(1);
      expect(summary.skipped).toEqual(expect.objectContaining({ per_detector_cap: 1 }));
      expect(runner.review).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not run while another process holds the queue lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-lock-'));
    try {
      await mkdir(join(dir, `${FINDING_EVIDENCE_REVIEW_QUEUE_FILE}.lock`));
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({ dir, runner });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual({ sampler_locked: 1 });
      expect(summary.modelCallsAttempted).toBe(0);
      expect(runner.review).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('provider failures become retryable with backoff before terminal failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-retry-'));
    try {
      let currentTime = NOW;
      const runner = { review: vi.fn(async () => { throw new Error('provider unavailable'); }) };
      const { sampler } = await makeSampler({
        dir,
        samplerConfig: { maxAttempts: 2, retryBaseMs: 60_000 },
        runner,
        now: () => currentTime,
      });

      const summary = await sampler.runOnce();
      const status = await sampler.getStatus();

      expect(summary.modelCallsFailed).toBe(1);
      expect(status.queue.failed_retryable).toBe(1);
      expect(runner.review).toHaveBeenCalledTimes(1);

      const second = await sampler.runOnce();
      expect(second.skipped).toEqual(expect.objectContaining({ duplicate: 1, backoff_active: 1 }));
      expect(runner.review).toHaveBeenCalledTimes(1);

      currentTime = new Date(NOW.getTime() + 61_000);
      const third = await sampler.runOnce();
      expect(third.modelCallsFailed).toBe(1);
      expect((await sampler.getStatus()).queue.failed_terminal).toBe(1);
      expect(runner.review).toHaveBeenCalledTimes(2);
      const queue = JSON.parse(await readFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), 'utf8')) as {
        entries: Array<{ state: string; nextRetryAt?: string }>;
      };
      expect(queue.entries[0]).toEqual(expect.objectContaining({ state: 'failed_terminal' }));
      expect(queue.entries[0]?.nextRetryAt).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not review stale queued input hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-stale-hash-'));
    try {
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), JSON.stringify({
        schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
        entries: [
          {
            candidateId: 'finding-1',
            inputHash: 'a'.repeat(64),
            state: 'queued',
            anomalyType: 'permission_blocked',
            estimatedTokens: 100,
            estimatedCostCents: 1,
            attemptCount: 0,
            enqueuedAt: '2026-05-18T10:00:00.000Z',
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        ],
        budgetDays: {},
      }), 'utf8');
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        records: [candidate()],
        runner,
      });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual(expect.objectContaining({ stale_input_hash: 1 }));
      expect(summary.modelCallsAttempted).toBe(1);
      expect(runner.review).toHaveBeenCalledTimes(1);
      const queue = JSON.parse(await readFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), 'utf8')) as {
        entries: Array<{ candidateId: string; inputHash: string; state: string; lastError?: string }>;
      };
      expect(queue.entries).toHaveLength(2);
      expect(queue.entries[0]).toEqual(expect.objectContaining({
        inputHash: 'a'.repeat(64),
        state: 'failed_terminal',
        lastError: 'candidate input hash changed before review',
      }));
      expect(queue.entries[1]).toEqual(expect.objectContaining({
        candidateId: 'finding-1',
        state: 'reviewed',
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('expired in-progress leases recover to retryable without immediate replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-lease-'));
    try {
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), JSON.stringify({
        schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
        entries: [
          {
            candidateId: 'finding-1',
            inputHash: 'a'.repeat(64),
            state: 'in_progress',
            anomalyType: 'permission_blocked',
            estimatedTokens: 100,
            estimatedCostCents: 1,
            attemptCount: 1,
            enqueuedAt: '2026-05-18T10:00:00.000Z',
            updatedAt: '2026-05-18T10:00:00.000Z',
            lastAttemptAt: '2026-05-18T10:00:00.000Z',
            runId: 'stale-run',
            leasedUntil: '2026-05-18T10:01:00.000Z',
          },
        ],
        budgetDays: {},
      }), 'utf8');
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        records: [],
        samplerConfig: { maxAttempts: 3, retryBaseMs: 60_000 },
        runner,
      });

      const summary = await sampler.runOnce();

      expect(summary.skipped).toEqual(expect.objectContaining({ backoff_active: 1 }));
      expect((await sampler.getStatus()).queue.failed_retryable).toBe(1);
      expect(runner.review).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('startup reconciliation marks matching review-log entries reviewed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-reconcile-'));
    try {
      const entry = {
        candidateId: 'finding-1',
        inputHash: 'a'.repeat(64),
        state: 'in_progress',
        anomalyType: 'permission_blocked',
        estimatedTokens: 100,
        estimatedCostCents: 1,
        attemptCount: 1,
        enqueuedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:00.000Z',
        runId: 'old-run',
        leasedUntil: '2026-05-18T10:01:00.000Z',
      };
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), JSON.stringify({
        schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
        entries: [entry],
        budgetDays: {},
      }), 'utf8');
      const runner = { review: vi.fn(async () => response()) };
      const { sampler } = await makeSampler({
        dir,
        records: [],
        runner,
        reviewRecords: [
          {
            kind: 'valid_review',
            inputHash: entry.inputHash,
            review: { candidateId: entry.candidateId },
          },
        ],
      });

      await sampler.runOnce();

      expect((await sampler.getStatus()).queue.reviewed).toBe(1);
      expect(runner.review).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('status loads a persisted queue ledger even when the sampler is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-status-'));
    try {
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), JSON.stringify({
        schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
        entries: [
          {
            candidateId: 'finding-1',
            inputHash: 'a'.repeat(64),
            state: 'queued',
            anomalyType: 'permission_blocked',
            estimatedTokens: 100,
            estimatedCostCents: 1,
            attemptCount: 0,
            enqueuedAt: '2026-05-18T10:00:00.000Z',
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        ],
        budgetDays: {
          '2026-05-18': { spentCostCents: 2, spentTokens: 250 },
        },
      }), 'utf8');
      const { sampler } = await makeSampler({
        dir,
        samplerConfig: { enabled: false },
        records: [],
      });

      const status = await sampler.getStatus();

      expect(status.enabled).toBe(false);
      expect(status.queue.queued).toBe(1);
      expect(status.budget.spentCostCents).toBe(2);
      expect(status.budget.spentTokens).toBe(250);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('status retries initialization after a busy queue lock clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finding-review-sampler-status-lock-'));
    try {
      await writeFile(join(dir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE), JSON.stringify({
        schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
        entries: [
          {
            candidateId: 'finding-1',
            inputHash: 'a'.repeat(64),
            state: 'queued',
            anomalyType: 'permission_blocked',
            estimatedTokens: 100,
            estimatedCostCents: 1,
            attemptCount: 0,
            enqueuedAt: '2026-05-18T10:00:00.000Z',
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        ],
        budgetDays: {},
      }), 'utf8');
      const lockPath = join(dir, `${FINDING_EVIDENCE_REVIEW_QUEUE_FILE}.lock`);
      await mkdir(lockPath);
      const { sampler } = await makeSampler({ dir, samplerConfig: { enabled: false }, records: [] });

      expect((await sampler.getStatus()).queue.queued).toBe(0);
      await rm(lockPath, { recursive: true, force: true });
      expect((await sampler.getStatus()).queue.queued).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
