import { createHash, createHmac } from 'node:crypto';
import type { FindingEvidenceAuditRecord, FindingEvidenceObservation } from '../shared/contracts/anomalies.js';

export const FINDING_EVIDENCE_REVIEW_INPUT_SCHEMA_VERSION = 'finding-evidence-review-input.v1';
export const FINDING_EVIDENCE_REVIEW_SCHEMA_VERSION = 'finding-evidence-review.v1';
export const FINDING_EVIDENCE_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION = 'finding-evidence-review-invalid-attempt.v1';
export const FINDING_EVIDENCE_REVIEW_PROMPT_VERSION = 'finding-evidence-review-prompt.v1';
export const FINDING_EVIDENCE_REVIEW_VERDICTS = ['supports_finding', 'timing_false_positive', 'likely_false_positive', 'unclear'] as const;
export const FINDING_EVIDENCE_REVIEW_CONFIDENCES = ['low', 'medium', 'high'] as const;
export const FINDING_EVIDENCE_REVIEW_FAILURE_KINDS = [
  'empty_output',
  'malformed_json',
  'invalid_shape',
  'candidate_mismatch',
  'invalid_verdict',
  'invalid_confidence',
  'invalid_evidence_refs',
  'invalid_semantics',
  'invalid_rationale',
] as const;

export type FindingEvidenceReviewInputSchemaVersion = typeof FINDING_EVIDENCE_REVIEW_INPUT_SCHEMA_VERSION;
export type FindingEvidenceReviewSchemaVersion = typeof FINDING_EVIDENCE_REVIEW_SCHEMA_VERSION;
export type FindingEvidenceReviewPromptVersion = typeof FINDING_EVIDENCE_REVIEW_PROMPT_VERSION;

export type FindingEvidenceReviewVerdict = typeof FINDING_EVIDENCE_REVIEW_VERDICTS[number];

export type FindingEvidenceReviewConfidence = typeof FINDING_EVIDENCE_REVIEW_CONFIDENCES[number];

export type FindingEvidenceReviewFailureKind = typeof FINDING_EVIDENCE_REVIEW_FAILURE_KINDS[number];

export interface FindingEvidenceReviewObservationInputV1 {
  observationId: string;
  sampledAt: string;
  ageMs: number;
  source: 'event' | 'watchdog_tick';
  anomalyStillPresent: boolean;
  lastEventType: string | null;
  lastEventSeq?: number;
  eventCount?: number;
  paneChangedSincePrevious?: boolean;
}

export interface FindingEvidenceReviewInputV1 {
  schemaVersion: FindingEvidenceReviewInputSchemaVersion;
  candidateId: string;
  candidateKind: 'false_positive';
  agentId: string;
  finding: {
    type: string;
    subType?: string;
    explanationHash: string;
    detectedAt: string;
    status: 'active' | 'resolved';
    auditVerdict: string;
  };
  observations: FindingEvidenceReviewObservationInputV1[];
  versions: {
    inputBuilder: FindingEvidenceReviewInputSchemaVersion;
    evidenceAuditor: 'finding-evidence-audit.v1';
    detector?: string;
    appGitSha?: string;
  };
}

export interface FindingEvidenceReviewV1 {
  schemaVersion: FindingEvidenceReviewSchemaVersion;
  candidateId: string;
  verdict: FindingEvidenceReviewVerdict;
  confidence: FindingEvidenceReviewConfidence;
  evidenceRefs: string[];
  rationale: string;
  reviewedAt: string;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: FindingEvidenceReviewPromptVersion;
  };
}

export interface FindingEvidenceReviewInvalidAttemptV1 {
  schemaVersion: typeof FINDING_EVIDENCE_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION;
  candidateId: string;
  attemptedAt: string;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: FindingEvidenceReviewPromptVersion;
  };
  failureKind: FindingEvidenceReviewFailureKind;
  rawOutputHash: string;
  error: string;
}

export type FindingEvidenceReviewParseResult =
  | { status: 'valid'; review: FindingEvidenceReviewV1 }
  | { status: 'invalid_attempt'; attempt: FindingEvidenceReviewInvalidAttemptV1 };

export interface FindingEvidenceReviewInputBuildOptions {
  hmacKey: Buffer;
  detectorVersion?: string;
  appGitSha?: string;
}

export interface FindingEvidenceReviewInputBuildResult {
  input: FindingEvidenceReviewInputV1;
  privacyOmissions: string[];
}

export interface FindingEvidenceReviewDryRunCandidateV1 {
  candidateId: string;
  anomalyType: string;
  auditVerdict: string;
  observationCount: number;
  ageMs: number;
  privacyOmissions: string[];
  inputHash: string;
}

export interface FindingEvidenceReviewDryRunResponseV1 {
  schemaVersion: 'finding-evidence-review-dry-run.v1';
  candidates: FindingEvidenceReviewDryRunCandidateV1[];
  wouldCallModel: false;
  estimatedTokens: number;
  estimatedCostCents?: number;
}

export const M1_REVIEWABLE_AUDIT_VERDICTS = ['possible_false_positive', 'transient_too_fast'] as const;

const MAX_SAFE_STRING_CHARS = 256;
const MAX_RATIONALE_CHARS = 600;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9_]{16,}/,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i,
];

export function isM1FindingEvidenceReviewCandidate(record: FindingEvidenceAuditRecord): boolean {
  return (M1_REVIEWABLE_AUDIT_VERDICTS as readonly string[]).includes(record.verdict);
}

export function selectM1FindingEvidenceReviewCandidates(
  records: FindingEvidenceAuditRecord[],
  limit: number,
): FindingEvidenceAuditRecord[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  return records
    .filter(isM1FindingEvidenceReviewCandidate)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, boundedLimit);
}

export function buildFindingEvidenceReviewInputV1(
  record: FindingEvidenceAuditRecord,
  options: FindingEvidenceReviewInputBuildOptions,
): FindingEvidenceReviewInputBuildResult {
  if (!isM1FindingEvidenceReviewCandidate(record)) {
    throw new Error(`finding evidence record ${record.id} is not reviewable by M1`);
  }

  const privacyOmissions = privacyOmissionsForRecord(record);
  const input: FindingEvidenceReviewInputV1 = {
    schemaVersion: FINDING_EVIDENCE_REVIEW_INPUT_SCHEMA_VERSION,
    candidateId: safeMetadataString(record.id, 'candidateId', privacyOmissions),
    candidateKind: 'false_positive',
    agentId: safeMetadataString(record.agentId, 'agentId', privacyOmissions),
    finding: {
      type: safeMetadataString(record.anomalyType, 'finding.type', privacyOmissions),
      ...(record.anomalySubType ? { subType: safeMetadataString(record.anomalySubType, 'finding.subType', privacyOmissions) } : {}),
      explanationHash: hmacString(record.explanation, options.hmacKey),
      detectedAt: record.detectedAt,
      status: record.status,
      auditVerdict: record.verdict,
    },
    observations: record.observations.map((observation, index) => buildObservationInput(record.id, observation, index, privacyOmissions)),
    versions: {
      inputBuilder: FINDING_EVIDENCE_REVIEW_INPUT_SCHEMA_VERSION,
      evidenceAuditor: 'finding-evidence-audit.v1',
      ...(options.detectorVersion ? { detector: safeMetadataString(options.detectorVersion, 'versions.detector', privacyOmissions) } : {}),
      ...(options.appGitSha ? { appGitSha: safeMetadataString(options.appGitSha, 'versions.appGitSha', privacyOmissions) } : {}),
    },
  };

  return { input, privacyOmissions: [...new Set(privacyOmissions)].sort() };
}

export function projectFindingEvidenceReviewDryRunCandidateV1(
  record: FindingEvidenceAuditRecord,
  built: FindingEvidenceReviewInputBuildResult,
  hmacKey: Buffer,
): FindingEvidenceReviewDryRunCandidateV1 {
  const latestObservation = record.observations.at(-1);
  return {
    candidateId: built.input.candidateId,
    anomalyType: built.input.finding.type,
    auditVerdict: built.input.finding.auditVerdict,
    observationCount: built.input.observations.length,
    ageMs: latestObservation?.ageMs ?? 0,
    privacyOmissions: built.privacyOmissions,
    inputHash: computeReviewInputHashV1(built.input, hmacKey),
  };
}

export function canonicalizeReviewInputV1(input: FindingEvidenceReviewInputV1): string {
  return JSON.stringify(sortJsonValue(input));
}

export function computeReviewInputHashV1(input: FindingEvidenceReviewInputV1, hmacKey: Buffer): string {
  return createHmac('sha256', hmacKey)
    .update(canonicalizeReviewInputV1(input))
    .digest('hex');
}

export function parseFindingEvidenceReviewOutputV1(
  rawOutput: string | null,
  input: FindingEvidenceReviewInputV1,
  reviewer: { provider: string; model: string },
  now: Date = new Date(),
): FindingEvidenceReviewParseResult {
  const attemptedAt = now.toISOString();
  const rawOutputHash = hashReviewRawOutput(rawOutput);
  const invalid = (failureKind: FindingEvidenceReviewFailureKind, error: string): FindingEvidenceReviewParseResult => ({
    status: 'invalid_attempt',
    attempt: {
      schemaVersion: FINDING_EVIDENCE_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION,
      candidateId: input.candidateId,
      attemptedAt,
      reviewer: { ...reviewer, promptVersion: FINDING_EVIDENCE_REVIEW_PROMPT_VERSION },
      failureKind,
      rawOutputHash,
      error: sanitizeDiagnosticText(error),
    },
  });

  if (!rawOutput || !rawOutput.trim()) return invalid('empty_output', 'empty model output');

  let value: unknown;
  try {
    value = JSON.parse(rawOutput);
  } catch {
    return invalid('malformed_json', 'model output was not valid JSON');
  }

  if (!isRecord(value)) return invalid('invalid_shape', 'model output was not a JSON object');
  if (value.candidateId !== input.candidateId) return invalid('candidate_mismatch', 'candidateId did not match review input');
  if (!isFindingEvidenceReviewVerdict(value.verdict)) return invalid('invalid_verdict', 'verdict was not allowed');
  if (!isFindingEvidenceReviewConfidence(value.confidence)) return invalid('invalid_confidence', 'confidence was not allowed');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || !value.evidenceRefs.every((ref) => typeof ref === 'string')) {
    return invalid('invalid_evidence_refs', 'evidenceRefs must be a non-empty string array');
  }

  const allowedRefs = new Set(input.observations.map((observation) => observation.observationId));
  const badRef = value.evidenceRefs.find((ref) => typeof ref !== 'string' || !allowedRefs.has(ref));
  if (badRef !== undefined) return invalid('invalid_evidence_refs', `evidenceRefs contained unknown observation id ${String(badRef)}`);

  if (value.verdict === 'timing_false_positive' && input.finding.auditVerdict !== 'transient_too_fast') {
    return invalid('invalid_semantics', 'timing_false_positive is only valid for transient timing candidates');
  }

  if (typeof value.rationale !== 'string' || !value.rationale.trim()) return invalid('invalid_rationale', 'rationale must be a non-empty string');

  return {
    status: 'valid',
    review: {
      schemaVersion: FINDING_EVIDENCE_REVIEW_SCHEMA_VERSION,
      candidateId: input.candidateId,
      verdict: value.verdict,
      confidence: value.confidence,
      evidenceRefs: value.evidenceRefs,
      rationale: sanitizeRationale(value.rationale),
      reviewedAt: attemptedAt,
      reviewer: { ...reviewer, promptVersion: FINDING_EVIDENCE_REVIEW_PROMPT_VERSION },
    },
  };
}

export function estimateFindingEvidenceReviewTokens(inputs: FindingEvidenceReviewInputV1[]): number {
  const compactBytes = inputs.reduce((sum, input) => sum + Buffer.byteLength(canonicalizeReviewInputV1(input), 'utf8'), 0);
  return Math.ceil(compactBytes / 4) + inputs.length * 180;
}

function buildObservationInput(
  recordId: string,
  observation: FindingEvidenceObservation,
  index: number,
  privacyOmissions: string[],
): FindingEvidenceReviewObservationInputV1 {
  if (observation.paneHash) privacyOmissions.push('observations.paneHash');
  if (observation.paneExcerpt) privacyOmissions.push('observations.paneExcerpt');
  return {
    observationId: `${recordId}:observation:${index + 1}`,
    sampledAt: observation.sampledAt,
    ageMs: observation.ageMs,
    source: observation.source,
    anomalyStillPresent: observation.anomalyStillPresent,
    lastEventType: observation.lastEventType,
    ...(observation.lastEventSeq !== undefined ? { lastEventSeq: observation.lastEventSeq } : {}),
    eventCount: observation.eventCount,
    ...(observation.paneChangedSincePrevious !== undefined ? { paneChangedSincePrevious: observation.paneChangedSincePrevious } : {}),
  };
}

function privacyOmissionsForRecord(record: FindingEvidenceAuditRecord): string[] {
  const omissions = ['finding.explanation', 'notes'];
  if (record.observations.some((observation) => observation.paneHash)) omissions.push('observations.paneHash');
  if (record.observations.some((observation) => observation.paneExcerpt)) omissions.push('observations.paneExcerpt');
  return omissions;
}

function safeMetadataString(value: string, field: string, privacyOmissions: string[]): string {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    privacyOmissions.push(field);
    return '[filtered]';
  }
  if (value.length > MAX_SAFE_STRING_CHARS) {
    privacyOmissions.push(field);
    return `${value.slice(0, MAX_SAFE_STRING_CHARS)}...`;
  }
  return value;
}

function hmacString(value: string, hmacKey: Buffer): string {
  return createHmac('sha256', hmacKey).update(value).digest('hex');
}

function hashReviewRawOutput(value: string | null): string {
  return createHash('sha256').update(value ?? '').digest('hex');
}

function sanitizeRationale(value: string): string {
  return sanitizeDiagnosticText(value);
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RATIONALE_CHARS);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFindingEvidenceReviewVerdict(value: unknown): value is FindingEvidenceReviewVerdict {
  return (FINDING_EVIDENCE_REVIEW_VERDICTS as readonly unknown[]).includes(value);
}

function isFindingEvidenceReviewConfidence(value: unknown): value is FindingEvidenceReviewConfidence {
  return (FINDING_EVIDENCE_REVIEW_CONFIDENCES as readonly unknown[]).includes(value);
}
