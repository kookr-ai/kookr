import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LlmClient } from '../core/llm-client.js';
import type { FindingEvidenceAuditRecord } from '../shared/contracts/anomalies.js';
import {
  buildFindingEvidenceReviewInputV1,
  computeReviewInputHashV1,
  estimateFindingEvidenceReviewTokens,
  isM1FindingEvidenceReviewCandidate,
} from '../core/finding-evidence-review.js';
import {
  estimateReviewCostCents,
  FindingEvidenceReviewService,
  type FindingEvidenceCandidateReader,
  type FindingEvidenceReviewModelRunner,
  type FindingEvidenceReviewServiceConfig,
} from './finding-evidence-review-service.js';
import type { ReviewLogStore } from './review-log-store.js';

export const FINDING_EVIDENCE_REVIEW_QUEUE_FILE = 'finding-evidence-review-queue.json';
export const FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION = 'finding-evidence-review-queue.v1';

export type ReviewCandidateState = 'queued' | 'in_progress' | 'reviewed' | 'failed_retryable' | 'failed_terminal';

export interface FindingEvidenceReviewQueueEntryV1 {
  candidateId: string;
  inputHash: string;
  state: ReviewCandidateState;
  anomalyType: string;
  estimatedTokens: number;
  estimatedCostCents: number;
  attemptCount: number;
  enqueuedAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  runId?: string;
  leasedUntil?: string;
  lastError?: string;
}

export interface FindingEvidenceReviewQueueLedgerV1 {
  schemaVersion: typeof FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION;
  entries: FindingEvidenceReviewQueueEntryV1[];
  budgetDays: Record<string, { spentCostCents: number; spentTokens: number }>;
}

export interface FindingEvidenceReviewSamplerConfig {
  enabled: boolean;
  intervalMs: number;
  minCandidateAgeMs: number;
  minObservations: number;
  maxCandidatesPerInterval: number;
  maxPerDetectorPerInterval: number;
  maxEstimatedTokensPerCandidate: number;
  dailyTokenBudget: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  candidateReadLimit: number;
}

export interface FindingEvidenceReviewSamplerDeps {
  candidateReader: FindingEvidenceCandidateReader;
  llmClient: LlmClient | null;
  serviceConfig: FindingEvidenceReviewServiceConfig;
  samplerConfig: FindingEvidenceReviewSamplerConfig;
  reviewLogStore: Pick<ReviewLogStore, 'readAll' | 'appendReview' | 'appendInvalidAttempt'>;
  queueStore: FindingEvidenceReviewQueueStore;
  now?: () => Date;
  modelRunner?: FindingEvidenceReviewModelRunner;
}

export interface FindingEvidenceReviewSamplerRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  sampled: number;
  enqueued: number;
  reviewed: number;
  skipped: Record<string, number>;
  modelCallsAttempted: number;
  modelCallsSucceeded: number;
  modelCallsFailed: number;
  invalidOutputs: number;
  storageFailures: number;
  budgetExhausted: boolean;
}

export interface FindingEvidenceReviewSamplerStatusV1 {
  schemaVersion: 'finding-evidence-review-sampler-status.v1';
  enabled: boolean;
  running: boolean;
  providerAvailable: boolean;
  lastRun: FindingEvidenceReviewSamplerRunSummary | null;
  nextRunAt: string | null;
  queue: Record<ReviewCandidateState, number>;
  budget: {
    date: string;
    dailyCostCents: number;
    spentCostCents: number;
    remainingCostCents: number;
    dailyTokenBudget: number;
    spentTokens: number;
    remainingTokens: number;
  };
}

const DEFAULT_SAMPLER_CONFIG: FindingEvidenceReviewSamplerConfig = {
  enabled: false,
  intervalMs: 15 * 60_000,
  minCandidateAgeMs: 30_000,
  minObservations: 2,
  maxCandidatesPerInterval: 3,
  maxPerDetectorPerInterval: 1,
  maxEstimatedTokensPerCandidate: 2_000,
  dailyTokenBudget: 20_000,
  leaseMs: 5 * 60_000,
  maxAttempts: 3,
  retryBaseMs: 60_000,
  candidateReadLimit: 50,
};

export class FindingEvidenceReviewQueueStore {
  constructor(private readonly path: string) {}

  static forKookrDir(kookrDir: string): FindingEvidenceReviewQueueStore {
    return new FindingEvidenceReviewQueueStore(join(kookrDir, FINDING_EVIDENCE_REVIEW_QUEUE_FILE));
  }

  async load(): Promise<FindingEvidenceReviewQueueLedgerV1> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return emptyLedger();
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isQueueLedger(parsed)) return parsed;
    } catch {
      // Fall through to an empty ledger. A malformed scheduler checkpoint must
      // not affect live supervision or manual review diagnostics.
    }
    return emptyLedger();
  }

  async save(ledger: FindingEvidenceReviewQueueLedgerV1): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.path);
  }

  async runExclusive<T>(staleMs: number, fn: () => Promise<T>): Promise<{ status: 'acquired'; value: T } | { status: 'busy' }> {
    const lockPath = `${this.path}.lock`;
    const acquired = await this.tryAcquireLock(lockPath, staleMs);
    if (!acquired) return { status: 'busy' };
    try {
      return { status: 'acquired', value: await fn() };
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async tryAcquireLock(lockPath: string, staleMs: number): Promise<boolean> {
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      await mkdir(lockPath, { recursive: false });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }), 'utf8');
      return true;
    } catch (err) {
      if (!isNodeErrno(err, 'EEXIST')) throw err;
    }

    if (staleMs > 0) {
      try {
        const stats = await stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          return this.tryAcquireLock(lockPath, 0);
        }
      } catch (err) {
        if (isNodeErrno(err, 'ENOENT')) return this.tryAcquireLock(lockPath, 0);
        throw err;
      }
    }
    return false;
  }
}

export class FindingEvidenceReviewSampler {
  private ledger: FindingEvidenceReviewQueueLedgerV1 = emptyLedger();
  private initialized: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private nextRunAt: string | null = null;
  private lastRun: FindingEvidenceReviewSamplerRunSummary | null = null;

  constructor(private readonly deps: FindingEvidenceReviewSamplerDeps) {}

  start(): void {
    if (!this.deps.samplerConfig.enabled || this.timer) return;
    this.nextRunAt = new Date(this.now().getTime() + this.deps.samplerConfig.intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(this.now().getTime() + this.deps.samplerConfig.intervalMs).toISOString();
      void this.runOnce();
    }, this.deps.samplerConfig.intervalMs);
    void this.ensureInitialized();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  async runOnce(): Promise<FindingEvidenceReviewSamplerRunSummary> {
    const started = this.now();
    const summary: FindingEvidenceReviewSamplerRunSummary = {
      runId: randomUUID(),
      startedAt: started.toISOString(),
      finishedAt: started.toISOString(),
      sampled: 0,
      enqueued: 0,
      reviewed: 0,
      skipped: {},
      modelCallsAttempted: 0,
      modelCallsSucceeded: 0,
      modelCallsFailed: 0,
      invalidOutputs: 0,
      storageFailures: 0,
      budgetExhausted: false,
    };
    if (this.running) {
      increment(summary.skipped, 'sampler_locked');
      summary.finishedAt = this.now().toISOString();
      this.lastRun = summary;
      return summary;
    }
    this.running = true;
    try {
      const locked = await this.deps.queueStore.runExclusive(this.deps.samplerConfig.leaseMs, async () => {
        this.ledger = await this.deps.queueStore.load();
        if (!this.deps.samplerConfig.enabled) {
          increment(summary.skipped, 'sampler_disabled');
          return;
        }
        if (!this.deps.llmClient) {
          increment(summary.skipped, 'llm_unavailable');
          return;
        }
        if (!this.deps.serviceConfig.enabled) {
          increment(summary.skipped, 'review_service_disabled');
          return;
        }
        if (this.deps.serviceConfig.dailyCostCents <= 0) {
          summary.budgetExhausted = true;
          increment(summary.skipped, 'budget_required');
          return;
        }

        this.recoverExpiredLeases(started);
        await this.reconcileFromReviewLog(summary);
        this.sampleCandidates(summary);
        await this.processQueue(summary);
        await this.saveLedger(summary);
      });
      if (locked.status === 'busy') increment(summary.skipped, 'sampler_locked');
      return this.finish(summary);
    } finally {
      this.running = false;
    }
  }

  async getStatus(): Promise<FindingEvidenceReviewSamplerStatusV1> {
    await this.ensureInitialized();
    const today = this.today();
    const budget = this.ledger.budgetDays[today] ?? { spentCostCents: 0, spentTokens: 0 };
    const queue = countByState(this.ledger.entries);
    return {
      schemaVersion: 'finding-evidence-review-sampler-status.v1',
      enabled: this.deps.samplerConfig.enabled,
      running: this.running,
      providerAvailable: this.deps.llmClient !== null,
      lastRun: this.lastRun,
      nextRunAt: this.nextRunAt,
      queue,
      budget: {
        date: today,
        dailyCostCents: this.deps.serviceConfig.dailyCostCents,
        spentCostCents: budget.spentCostCents,
        remainingCostCents: Math.max(0, this.deps.serviceConfig.dailyCostCents - budget.spentCostCents),
        dailyTokenBudget: this.deps.samplerConfig.dailyTokenBudget,
        spentTokens: budget.spentTokens,
        remainingTokens: Math.max(0, this.deps.samplerConfig.dailyTokenBudget - budget.spentTokens),
      },
    };
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      const locked = await this.deps.queueStore.runExclusive(this.deps.samplerConfig.leaseMs, async () => {
        this.ledger = await this.deps.queueStore.load();
        await this.reconcileFromReviewLog();
        await this.deps.queueStore.save(this.ledger);
      });
      if (locked.status === 'busy') this.initialized = null;
    })();
    return this.initialized;
  }

  private sampleCandidates(summary: FindingEvidenceReviewSamplerRunSummary): void {
    const records = this.deps.candidateReader.listReviewCandidates(this.deps.samplerConfig.candidateReadLimit);
    const nowMs = this.now().getTime();
    summary.sampled = records.length;
    for (const record of records) {
      if (!isM1FindingEvidenceReviewCandidate(record)) {
        increment(summary.skipped, 'not_reviewable');
        continue;
      }
      const candidateAgeMs = candidateAgeMsAt(record, nowMs);
      if (candidateAgeMs < this.deps.samplerConfig.minCandidateAgeMs) {
        increment(summary.skipped, 'too_young');
        continue;
      }
      if (record.observations.length < this.deps.samplerConfig.minObservations) {
        increment(summary.skipped, 'too_few_observations');
        continue;
      }
      const built = buildFindingEvidenceReviewInputV1(record, {
        hmacKey: this.deps.serviceConfig.hmacKey,
        appGitSha: this.deps.serviceConfig.appGitSha,
      });
      const inputHash = computeReviewInputHashV1(built.input, this.deps.serviceConfig.hmacKey);
      if (this.ledger.entries.some((entry) => entry.candidateId === record.id && entry.inputHash === inputHash)) {
        increment(summary.skipped, 'duplicate');
        continue;
      }
      const estimatedTokens = estimateFindingEvidenceReviewTokens([built.input]);
      if (estimatedTokens > this.deps.samplerConfig.maxEstimatedTokensPerCandidate) {
        increment(summary.skipped, 'token_cap');
        continue;
      }
      const now = this.now().toISOString();
      this.ledger.entries.push({
        candidateId: record.id,
        inputHash,
        state: 'queued',
        anomalyType: record.anomalyType,
        estimatedTokens,
        estimatedCostCents: estimateReviewCostCents(estimatedTokens),
        attemptCount: 0,
        enqueuedAt: now,
        updatedAt: now,
      });
      summary.enqueued += 1;
    }
  }

  private async processQueue(summary: FindingEvidenceReviewSamplerRunSummary): Promise<void> {
    const detectorCounts = new Map<string, number>();
    const now = this.now();
    for (const entry of this.ledger.entries) {
      if (summary.modelCallsAttempted >= this.deps.samplerConfig.maxCandidatesPerInterval) break;
      if (entry.state !== 'queued' && entry.state !== 'failed_retryable') continue;
      if (entry.nextRetryAt && Date.parse(entry.nextRetryAt) > now.getTime()) {
        increment(summary.skipped, 'backoff_active');
        continue;
      }
      const detectorCount = detectorCounts.get(entry.anomalyType) ?? 0;
      if (detectorCount >= this.deps.samplerConfig.maxPerDetectorPerInterval) {
        increment(summary.skipped, 'per_detector_cap');
        continue;
      }
      const record = this.resolveCurrentRecord(entry, summary);
      if (!record) continue;
      if (!this.reserveBudget(entry, summary)) break;
      detectorCounts.set(entry.anomalyType, detectorCount + 1);
      await this.processEntry(entry, record, summary);
    }
  }

  private async processEntry(
    entry: FindingEvidenceReviewQueueEntryV1,
    record: FindingEvidenceAuditRecord,
    summary: FindingEvidenceReviewSamplerRunSummary,
  ): Promise<void> {
    const started = this.now();
    const runId = randomUUID();
    entry.state = 'in_progress';
    entry.runId = runId;
    entry.leasedUntil = new Date(started.getTime() + this.deps.samplerConfig.leaseMs).toISOString();
    entry.lastAttemptAt = started.toISOString();
    entry.attemptCount += 1;
    entry.updatedAt = started.toISOString();
    try {
      await this.deps.queueStore.save(this.ledger);
    } catch (err) {
      this.releaseBudget(entry);
      entry.runId = undefined;
      entry.leasedUntil = undefined;
      entry.lastError = sanitizeError(err);
      entry.updatedAt = this.now().toISOString();
      summary.storageFailures += 1;
      this.markRetryState(entry);
      return;
    }

    summary.modelCallsAttempted += 1;
    try {
      const result = await this.runnerForEntry(record).review({ mode: 'persisted_review', limit: 1 });
      const parsed = result.results?.[0];
      if (!parsed) throw new Error('review service returned no result');
      entry.state = 'reviewed';
      entry.runId = undefined;
      entry.leasedUntil = undefined;
      entry.nextRetryAt = undefined;
      entry.lastError = undefined;
      entry.updatedAt = this.now().toISOString();
      summary.reviewed += 1;
      summary.modelCallsSucceeded += 1;
      if (parsed.status === 'invalid_attempt') summary.invalidOutputs += 1;
    } catch (err) {
      entry.runId = undefined;
      entry.leasedUntil = undefined;
      entry.lastError = sanitizeError(err);
      entry.updatedAt = this.now().toISOString();
      summary.modelCallsFailed += 1;
      this.markRetryState(entry);
    }
  }

  private runnerForEntry(record: FindingEvidenceAuditRecord): FindingEvidenceReviewModelRunner {
    if (this.deps.modelRunner) return this.deps.modelRunner;
    return new FindingEvidenceReviewService({
      candidateReader: { listReviewCandidates: () => [record] },
      llmClient: this.deps.llmClient,
      config: this.deps.serviceConfig,
      reviewLogStore: this.deps.reviewLogStore,
      now: this.deps.now,
    });
  }

  private resolveCurrentRecord(
    entry: FindingEvidenceReviewQueueEntryV1,
    summary: FindingEvidenceReviewSamplerRunSummary,
  ): FindingEvidenceAuditRecord | null {
    const record = this.deps.candidateReader
      .listReviewCandidates(this.deps.samplerConfig.candidateReadLimit)
      .find((candidate) => candidate.id === entry.candidateId);
    if (!record) {
      entry.state = 'failed_terminal';
      entry.lastError = 'candidate was no longer available';
      entry.nextRetryAt = undefined;
      entry.updatedAt = this.now().toISOString();
      increment(summary.skipped, 'candidate_missing');
      return null;
    }
    if (!isM1FindingEvidenceReviewCandidate(record)) {
      entry.state = 'failed_terminal';
      entry.lastError = 'candidate was no longer reviewable';
      entry.nextRetryAt = undefined;
      entry.updatedAt = this.now().toISOString();
      increment(summary.skipped, 'candidate_not_reviewable');
      return null;
    }
    const built = buildFindingEvidenceReviewInputV1(record, {
      hmacKey: this.deps.serviceConfig.hmacKey,
      appGitSha: this.deps.serviceConfig.appGitSha,
    });
    const currentHash = computeReviewInputHashV1(built.input, this.deps.serviceConfig.hmacKey);
    if (currentHash !== entry.inputHash) {
      entry.state = 'failed_terminal';
      entry.lastError = 'candidate input hash changed before review';
      entry.nextRetryAt = undefined;
      entry.updatedAt = this.now().toISOString();
      increment(summary.skipped, 'stale_input_hash');
      return null;
    }
    return record;
  }

  private reserveBudget(entry: FindingEvidenceReviewQueueEntryV1, summary: FindingEvidenceReviewSamplerRunSummary): boolean {
    const today = this.today();
    const budget = this.ledger.budgetDays[today] ?? { spentCostCents: 0, spentTokens: 0 };
    if (budget.spentCostCents + entry.estimatedCostCents > this.deps.serviceConfig.dailyCostCents) {
      summary.budgetExhausted = true;
      increment(summary.skipped, 'daily_cost_budget');
      return false;
    }
    if (budget.spentTokens + entry.estimatedTokens > this.deps.samplerConfig.dailyTokenBudget) {
      summary.budgetExhausted = true;
      increment(summary.skipped, 'daily_token_budget');
      return false;
    }
    budget.spentCostCents += entry.estimatedCostCents;
    budget.spentTokens += entry.estimatedTokens;
    this.ledger.budgetDays[today] = budget;
    return true;
  }

  private releaseBudget(entry: FindingEvidenceReviewQueueEntryV1): void {
    const budget = this.ledger.budgetDays[this.today()];
    if (!budget) return;
    budget.spentCostCents = Math.max(0, budget.spentCostCents - entry.estimatedCostCents);
    budget.spentTokens = Math.max(0, budget.spentTokens - entry.estimatedTokens);
  }

  private recoverExpiredLeases(now: Date): void {
    for (const entry of this.ledger.entries) {
      if (entry.state !== 'in_progress' || !entry.leasedUntil || Date.parse(entry.leasedUntil) > now.getTime()) continue;
      entry.runId = undefined;
      entry.leasedUntil = undefined;
      entry.lastError = 'expired review lease recovered on startup';
      this.markRetryState(entry);
    }
  }

  private async reconcileFromReviewLog(summary?: FindingEvidenceReviewSamplerRunSummary): Promise<void> {
    try {
      const read = await this.deps.reviewLogStore.readAll();
      const completed = new Set(read.records.map((record) => `${record.kind === 'valid_review' ? record.review.candidateId : record.attempt.candidateId}:${record.inputHash}`));
      for (const entry of this.ledger.entries) {
        if (completed.has(`${entry.candidateId}:${entry.inputHash}`)) {
          entry.state = 'reviewed';
          entry.runId = undefined;
          entry.leasedUntil = undefined;
          entry.nextRetryAt = undefined;
          entry.updatedAt = this.now().toISOString();
        }
      }
    } catch {
      if (summary) summary.storageFailures += 1;
    }
  }

  private markRetryState(entry: FindingEvidenceReviewQueueEntryV1): void {
    if (entry.attemptCount >= this.deps.samplerConfig.maxAttempts) {
      entry.state = 'failed_terminal';
      entry.nextRetryAt = undefined;
      return;
    }
    entry.state = 'failed_retryable';
    const delayMs = this.deps.samplerConfig.retryBaseMs * (2 ** Math.max(0, entry.attemptCount - 1));
    entry.nextRetryAt = new Date(this.now().getTime() + delayMs).toISOString();
  }

  private async saveLedger(summary: FindingEvidenceReviewSamplerRunSummary): Promise<void> {
    try {
      await this.deps.queueStore.save(this.ledger);
    } catch {
      summary.storageFailures += 1;
    }
  }

  private finish(summary: FindingEvidenceReviewSamplerRunSummary): FindingEvidenceReviewSamplerRunSummary {
    summary.finishedAt = this.now().toISOString();
    this.lastRun = summary;
    return summary;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export function readFindingEvidenceReviewSamplerConfigFromEnv(env: NodeJS.ProcessEnv): FindingEvidenceReviewSamplerConfig {
  return {
    enabled: env.KOOKR_FINDING_REVIEW_SAMPLER_ENABLED === 'true',
    intervalMs: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_INTERVAL_MS, DEFAULT_SAMPLER_CONFIG.intervalMs),
    minCandidateAgeMs: readNonNegativeInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MIN_AGE_MS, DEFAULT_SAMPLER_CONFIG.minCandidateAgeMs),
    minObservations: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MIN_OBSERVATIONS, DEFAULT_SAMPLER_CONFIG.minObservations),
    maxCandidatesPerInterval: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_INTERVAL, DEFAULT_SAMPLER_CONFIG.maxCandidatesPerInterval),
    maxPerDetectorPerInterval: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_DETECTOR, DEFAULT_SAMPLER_CONFIG.maxPerDetectorPerInterval),
    maxEstimatedTokensPerCandidate: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MAX_TOKENS_PER_CANDIDATE, DEFAULT_SAMPLER_CONFIG.maxEstimatedTokensPerCandidate),
    dailyTokenBudget: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_DAILY_TOKEN_BUDGET, DEFAULT_SAMPLER_CONFIG.dailyTokenBudget),
    leaseMs: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_LEASE_MS, DEFAULT_SAMPLER_CONFIG.leaseMs),
    maxAttempts: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_MAX_ATTEMPTS, DEFAULT_SAMPLER_CONFIG.maxAttempts),
    retryBaseMs: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_RETRY_BASE_MS, DEFAULT_SAMPLER_CONFIG.retryBaseMs),
    candidateReadLimit: readPositiveInt(env.KOOKR_FINDING_REVIEW_SAMPLER_CANDIDATE_READ_LIMIT, DEFAULT_SAMPLER_CONFIG.candidateReadLimit),
  };
}

function emptyLedger(): FindingEvidenceReviewQueueLedgerV1 {
  return {
    schemaVersion: FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION,
    entries: [],
    budgetDays: {},
  };
}

function candidateAgeMsAt(record: FindingEvidenceAuditRecord, nowMs: number): number {
  const detectedAtMs = Date.parse(record.detectedAt);
  if (Number.isFinite(detectedAtMs)) return Math.max(0, nowMs - detectedAtMs);
  return record.observations.at(-1)?.ageMs ?? 0;
}

function countByState(entries: FindingEvidenceReviewQueueEntryV1[]): Record<ReviewCandidateState, number> {
  return {
    queued: entries.filter((entry) => entry.state === 'queued').length,
    in_progress: entries.filter((entry) => entry.state === 'in_progress').length,
    reviewed: entries.filter((entry) => entry.state === 'reviewed').length,
    failed_retryable: entries.filter((entry) => entry.state === 'failed_retryable').length,
    failed_terminal: entries.filter((entry) => entry.state === 'failed_terminal').length,
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sanitizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function isQueueLedger(value: unknown): value is FindingEvidenceReviewQueueLedgerV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== FINDING_EVIDENCE_REVIEW_QUEUE_SCHEMA_VERSION) return false;
  if (!Array.isArray(value.entries) || !value.entries.every(isQueueEntry)) return false;
  if (!isRecord(value.budgetDays)) return false;
  return Object.values(value.budgetDays).every((budget) => (
    isRecord(budget)
    && typeof budget.spentCostCents === 'number'
    && typeof budget.spentTokens === 'number'
  ));
}

function isQueueEntry(value: unknown): value is FindingEvidenceReviewQueueEntryV1 {
  if (!isRecord(value)) return false;
  return typeof value.candidateId === 'string'
    && typeof value.inputHash === 'string'
    && /^[a-f0-9]{64}$/i.test(value.inputHash)
    && isReviewCandidateState(value.state)
    && typeof value.anomalyType === 'string'
    && typeof value.estimatedTokens === 'number'
    && typeof value.estimatedCostCents === 'number'
    && typeof value.attemptCount === 'number'
    && typeof value.enqueuedAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isReviewCandidateState(value: unknown): value is ReviewCandidateState {
  return value === 'queued'
    || value === 'in_progress'
    || value === 'reviewed'
    || value === 'failed_retryable'
    || value === 'failed_terminal';
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrno(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}
