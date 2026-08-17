import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LlmClient } from '../core/llm-client.js';
import type { FindingEvidenceAuditRecord } from '../shared/contracts/anomalies.js';
import {
  FINDING_EVIDENCE_REVIEW_PROMPT_VERSION,
  buildFindingEvidenceReviewInputV1,
  canonicalizeReviewInputV1,
  computeReviewInputHashV1,
  estimateFindingEvidenceReviewTokens,
  parseFindingEvidenceReviewOutputV1,
  projectFindingEvidenceReviewDryRunCandidateV1,
  selectM1FindingEvidenceReviewCandidates,
  type FindingEvidenceReviewDryRunResponseV1,
  type FindingEvidenceReviewInputV1,
  type FindingEvidenceReviewParseResult,
} from '../core/finding-evidence-review.js';
import type { FindingEvidenceReviewLogTargetV1, ReviewLogStore } from './review-log-store.js';

export type FindingEvidenceReviewMode = 'estimate_only' | 'model_review' | 'persisted_review';

export interface FindingEvidenceCandidateReader {
  listReviewCandidates(limit: number): FindingEvidenceAuditRecord[];
}

export interface FindingEvidenceReviewModelRunner {
  review(request: FindingEvidenceReviewRequest): Promise<FindingEvidenceReviewResponseV1>;
}

export interface FindingEvidenceReviewServiceConfig {
  enabled: boolean;
  maxCandidates: number;
  timeoutMs: number;
  dailyCostCents: number;
  hmacKey: Buffer;
  appGitSha?: string;
}

export interface FindingEvidenceReviewServiceDeps {
  candidateReader: FindingEvidenceCandidateReader;
  llmClient: LlmClient | null;
  config: FindingEvidenceReviewServiceConfig;
  reviewLogStore?: Pick<ReviewLogStore, 'appendReview' | 'appendInvalidAttempt'>;
  now?: () => Date;
}

export interface FindingEvidenceReviewRequest {
  mode?: FindingEvidenceReviewMode;
  limit?: number;
}

export interface FindingEvidenceReviewResponseV1 {
  schemaVersion: 'finding-evidence-review-response.v1';
  mode: FindingEvidenceReviewMode;
  dryRun: FindingEvidenceReviewDryRunResponseV1;
  results?: FindingEvidenceReviewParseResult[];
  budget: {
    dailyCostCents: number;
    spentTodayCents: number;
    remainingTodayCents: number;
  };
  reviewLog?: {
    appendedRecords: number;
  };
}

export class FindingEvidenceReviewServiceError extends Error {
  constructor(
    public readonly code:
      | 'finding-review-disabled'
      | 'finding-review-llm-unavailable'
      | 'finding-review-budget-required'
      | 'finding-review-budget-exhausted'
      | 'finding-review-invalid-mode'
      | 'finding-review-log-unavailable',
    public readonly status: 400 | 403 | 404 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_MODEL_REVIEW_MAX_TOKENS = 600;
const REVIEW_HMAC_KEY_FILE = 'finding-evidence-review-hmac-key';

export class FindingEvidenceReviewService {
  private spentTodayCents = 0;
  private spentDate = '';

  constructor(private readonly deps: FindingEvidenceReviewServiceDeps) {}

  async review(request: FindingEvidenceReviewRequest): Promise<FindingEvidenceReviewResponseV1> {
    const mode = request.mode ?? 'estimate_only';
    if (mode !== 'estimate_only' && mode !== 'model_review' && mode !== 'persisted_review') {
      throw new FindingEvidenceReviewServiceError('finding-review-invalid-mode', 400, 'mode must be estimate_only, model_review, or persisted_review');
    }
    this.assertBaseGuards();

    const limit = this.normalizeLimit(request.limit);
    const records = selectM1FindingEvidenceReviewCandidates(
      this.deps.candidateReader.listReviewCandidates(Math.max(this.deps.config.maxCandidates * 4, limit * 4, 20)),
      limit,
    );
    const builtInputs = records.map((record) => buildFindingEvidenceReviewInputV1(record, this.inputOptions()));
    const inputs = builtInputs.map((built) => built.input);
    const inputHashes = inputs.map((input) => computeReviewInputHashV1(input, this.deps.config.hmacKey));
    const estimatedTokens = estimateFindingEvidenceReviewTokens(inputs);
    const estimatedCostCents = estimateReviewCostCents(estimatedTokens);
    const dryRun: FindingEvidenceReviewDryRunResponseV1 = {
      schemaVersion: 'finding-evidence-review-dry-run.v1',
      candidates: records.map((record, index) => projectFindingEvidenceReviewDryRunCandidateV1(
        record,
        builtInputs[index]!,
        this.deps.config.hmacKey,
      )),
      wouldCallModel: false,
      estimatedTokens,
      estimatedCostCents,
    };

    if (mode === 'estimate_only') {
      return this.response(mode, dryRun);
    }

    if (mode === 'persisted_review' && !this.deps.reviewLogStore) {
      throw new FindingEvidenceReviewServiceError('finding-review-log-unavailable', 503, 'persisted_review requires a review log store');
    }
    if (this.deps.config.dailyCostCents <= 0) {
      throw new FindingEvidenceReviewServiceError('finding-review-budget-required', 403, `${mode} requires a positive daily budget`);
    }
    this.resetDailySpendIfNeeded();
    if (this.spentTodayCents + estimatedCostCents > this.deps.config.dailyCostCents) {
      throw new FindingEvidenceReviewServiceError('finding-review-budget-exhausted', 429, 'finding evidence review budget exhausted');
    }
    this.spentTodayCents += estimatedCostCents;

    const results: FindingEvidenceReviewParseResult[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!;
      const raw = await this.deps.llmClient!.complete({
        useCase: 'finding_evidence_review',
        maxTokens: DEFAULT_MODEL_REVIEW_MAX_TOKENS,
        system: REVIEW_SYSTEM_PROMPT,
        userMessage: buildReviewUserPrompt(input),
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'finding_evidence_review_v1',
            schema: REVIEW_OUTPUT_JSON_SCHEMA,
          },
        },
        timeoutMs: this.deps.config.timeoutMs,
      });
      const parsed = parseFindingEvidenceReviewOutputV1(
        raw,
        input,
        { provider: this.deps.llmClient!.provider, model: this.deps.llmClient!.model },
        this.now(),
      );
      results.push(parsed);
      if (mode === 'persisted_review') {
        const inputHash = inputHashes[index]!;
        const target = reviewLogTargetForInput(input);
        if (parsed.status === 'valid') {
          await this.deps.reviewLogStore!.appendReview(parsed.review, inputHash, this.now(), target);
        } else {
          await this.deps.reviewLogStore!.appendInvalidAttempt(parsed.attempt, inputHash, this.now(), target);
        }
      }
    }

    return this.response(mode, dryRun, results, mode === 'persisted_review' ? results.length : undefined);
  }

  private assertBaseGuards(): void {
    if (!this.deps.config.enabled) {
      throw new FindingEvidenceReviewServiceError('finding-review-disabled', 404, 'finding evidence review is disabled');
    }
    if (!this.deps.llmClient) {
      throw new FindingEvidenceReviewServiceError('finding-review-llm-unavailable', 503, 'LLM provider is not configured');
    }
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return this.deps.config.maxCandidates;
    if (!Number.isFinite(limit) || limit < 1) return 1;
    return Math.min(Math.floor(limit), this.deps.config.maxCandidates);
  }

  private inputOptions() {
    return {
      hmacKey: this.deps.config.hmacKey,
      appGitSha: this.deps.config.appGitSha,
    };
  }

  private response(
    mode: FindingEvidenceReviewMode,
    dryRun: FindingEvidenceReviewDryRunResponseV1,
    results?: FindingEvidenceReviewParseResult[],
    appendedRecords?: number,
  ): FindingEvidenceReviewResponseV1 {
    this.resetDailySpendIfNeeded();
    return {
      schemaVersion: 'finding-evidence-review-response.v1',
      mode,
      dryRun,
      ...(results ? { results } : {}),
      budget: {
        dailyCostCents: this.deps.config.dailyCostCents,
        spentTodayCents: this.spentTodayCents,
        remainingTodayCents: Math.max(0, this.deps.config.dailyCostCents - this.spentTodayCents),
      },
      ...(appendedRecords !== undefined ? { reviewLog: { appendedRecords } } : {}),
    };
  }

  private resetDailySpendIfNeeded(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.spentDate) {
      this.spentDate = today;
      this.spentTodayCents = 0;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function reviewLogTargetForInput(input: FindingEvidenceReviewInputV1): FindingEvidenceReviewLogTargetV1 {
  return {
    candidateKind: input.candidateKind,
    detectorTarget: input.finding.type,
    inputSchemaVersion: input.schemaVersion,
    promptVersion: FINDING_EVIDENCE_REVIEW_PROMPT_VERSION,
    ...(input.versions.appGitSha ? { appGitSha: input.versions.appGitSha } : {}),
  };
}

export function readFindingEvidenceReviewConfigFromEnv(env: NodeJS.ProcessEnv, hmacKey: Buffer, appGitSha?: string): FindingEvidenceReviewServiceConfig {
  return {
    enabled: env.KOOKR_FINDING_REVIEW_ENABLED === 'true',
    maxCandidates: readPositiveInt(env.KOOKR_FINDING_REVIEW_MAX_CANDIDATES, 5),
    timeoutMs: readPositiveInt(env.KOOKR_FINDING_REVIEW_TIMEOUT_MS, 15_000),
    dailyCostCents: readNonNegativeInt(env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS, 0),
    hmacKey,
    ...(appGitSha ? { appGitSha } : {}),
  };
}

export function getOrCreateFindingEvidenceReviewHmacKey(kookrDir: string): Buffer {
  const path = join(kookrDir, REVIEW_HMAC_KEY_FILE);
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(value)) {
      // Tighten leftover looser modes from copy/restore without rewriting key bytes.
      try {
        chmodSync(path, 0o600);
      } catch {
        // chmod is best-effort: reviews must still run if the mode cannot be tightened.
      }
      return Buffer.from(value, 'hex');
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function estimateReviewCostCents(estimatedTokens: number): number {
  if (estimatedTokens <= 0) return 0;
  return Math.max(1, Math.ceil(estimatedTokens / 10_000));
}

const REVIEW_SYSTEM_PROMPT = `You review Kookr finding-evidence audit metadata.
Classify whether the existing deterministic detector finding appears supported.
Use only the provided compact metadata. Do not propose detector changes. Return JSON only.`;

function buildReviewUserPrompt(input: FindingEvidenceReviewInputV1): string {
  return [
    `Prompt version: ${FINDING_EVIDENCE_REVIEW_PROMPT_VERSION}`,
    'Return exactly this JSON shape:',
    '{"candidateId":"...","verdict":"supports_finding|timing_false_positive|likely_false_positive|unclear","confidence":"low|medium|high","evidenceRefs":["observation-id"],"rationale":"short plain text"}',
    'Compact metadata input:',
    canonicalizeReviewInputV1(input),
  ].join('\n');
}

const REVIEW_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateId', 'verdict', 'confidence', 'evidenceRefs', 'rationale'],
  properties: {
    candidateId: { type: 'string' },
    verdict: {
      type: 'string',
      enum: ['supports_finding', 'timing_false_positive', 'likely_false_positive', 'unclear'],
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidenceRefs: { type: 'array', minItems: 1, items: { type: 'string' } },
    rationale: { type: 'string', minLength: 1, maxLength: 600 },
  },
};

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
