import { sanitizeDiagnosticText, type FindingEvidenceReviewConfidence, type FindingEvidenceReviewVerdict } from '../core/finding-evidence-review.js';
import type { FindingEvidenceReviewLogRecordV1, FindingEvidenceReviewLogTargetV1, ReviewLogReadDiagnostic } from './review-log-store.js';

export const DETECTOR_PROPOSAL_REPORT_SCHEMA_VERSION = 'detector-proposal-report.v1';

export type DetectorProposalPopulation =
  | 'false_positive'
  | 'false_negative'
  | 'invalid'
  | 'unclear'
  | 'supports_finding';

export interface DetectorProposalReportOptions {
  minPopulationReviews?: number;
  minHighConfidenceReviews?: number;
  maxEvidencePerReport?: number;
}

export interface DetectorProposalEvidenceV1 {
  candidateId: string;
  inputHash: string;
  appendedAt: string;
  population: DetectorProposalPopulation;
  confidence?: FindingEvidenceReviewConfidence;
  verdict?: FindingEvidenceReviewVerdict;
  evidenceRefs: string[];
  rationaleEscapedText: string;
}

export interface DetectorProposalReportV1 {
  schemaVersion: typeof DETECTOR_PROPOSAL_REPORT_SCHEMA_VERSION;
  detectorTarget: string;
  candidateKind: 'false_positive' | 'false_negative' | 'unknown';
  versions: {
    inputSchemaVersion: string;
    promptVersion: string;
    appGitSha?: string;
  };
  reviewCounts: {
    total: number;
    falsePositive: number;
    falseNegative: number;
    invalid: number;
    unclear: number;
    supportsFinding: number;
  };
  confidenceDistribution: Record<FindingEvidenceReviewConfidence, number>;
  inputHashes: string[];
  evidence: DetectorProposalEvidenceV1[];
  proposal: {
    status: 'candidate' | 'insufficient_evidence';
    advisoryOnly: true;
    canExecuteCommands: false;
    canMutateDetectorConfig: false;
    summary: string;
  };
}

export interface DetectorProposalReportResponseV1 {
  schemaVersion: 'detector-proposal-report-response.v1';
  reports: DetectorProposalReportV1[];
  diagnostics: ReviewLogReadDiagnostic[];
}

const DEFAULT_MIN_POPULATION_REVIEWS = 2;
const DEFAULT_MIN_HIGH_CONFIDENCE_REVIEWS = 1;
const DEFAULT_MAX_EVIDENCE_PER_REPORT = 5;
const UNKNOWN_TARGET: FindingEvidenceReviewLogTargetV1 = {
  candidateKind: 'false_positive',
  detectorTarget: 'unknown',
  inputSchemaVersion: 'unknown',
  promptVersion: 'unknown',
};

interface GroupAccumulator {
  target: FindingEvidenceReviewLogTargetV1;
  records: DetectorProposalEvidenceV1[];
  counts: DetectorProposalReportV1['reviewCounts'];
  confidenceDistribution: Record<FindingEvidenceReviewConfidence, number>;
  inputHashes: Set<string>;
}

export function buildDetectorProposalReportResponseV1(
  records: FindingEvidenceReviewLogRecordV1[],
  diagnostics: ReviewLogReadDiagnostic[] = [],
  options: DetectorProposalReportOptions = {},
): DetectorProposalReportResponseV1 {
  return {
    schemaVersion: 'detector-proposal-report-response.v1',
    reports: buildDetectorProposalReportsV1(records, options),
    diagnostics,
  };
}

export function buildDetectorProposalReportsV1(
  records: FindingEvidenceReviewLogRecordV1[],
  options: DetectorProposalReportOptions = {},
): DetectorProposalReportV1[] {
  const minPopulationReviews = options.minPopulationReviews ?? DEFAULT_MIN_POPULATION_REVIEWS;
  const minHighConfidenceReviews = options.minHighConfidenceReviews ?? DEFAULT_MIN_HIGH_CONFIDENCE_REVIEWS;
  const maxEvidencePerReport = options.maxEvidencePerReport ?? DEFAULT_MAX_EVIDENCE_PER_REPORT;
  const groups = new Map<string, GroupAccumulator>();

  for (const record of records) {
    const target = record.target ?? UNKNOWN_TARGET;
    const key = groupKey(target);
    const group = groups.get(key) ?? emptyGroup(target);
    groups.set(key, group);

    const evidence = projectEvidence(record, target);
    group.records.push(evidence);
    group.inputHashes.add(record.inputHash);
    group.counts.total += 1;
    incrementPopulation(group.counts, evidence.population);
    if (evidence.confidence) group.confidenceDistribution[evidence.confidence] += 1;
  }

  return [...groups.values()]
    .map((group) => buildReport(group, minPopulationReviews, minHighConfidenceReviews, maxEvidencePerReport))
    .sort((a, b) => {
      const candidateDelta = Number(b.proposal.status === 'candidate') - Number(a.proposal.status === 'candidate');
      if (candidateDelta !== 0) return candidateDelta;
      return b.reviewCounts.total - a.reviewCounts.total || a.detectorTarget.localeCompare(b.detectorTarget);
    });
}

function emptyGroup(target: FindingEvidenceReviewLogTargetV1): GroupAccumulator {
  return {
    target,
    records: [],
    counts: {
      total: 0,
      falsePositive: 0,
      falseNegative: 0,
      invalid: 0,
      unclear: 0,
      supportsFinding: 0,
    },
    confidenceDistribution: { low: 0, medium: 0, high: 0 },
    inputHashes: new Set(),
  };
}

function buildReport(
  group: GroupAccumulator,
  minPopulationReviews: number,
  minHighConfidenceReviews: number,
  maxEvidencePerReport: number,
): DetectorProposalReportV1 {
  const population = dominantProposalPopulation(group.counts);
  const populationCount = countForPopulation(group.counts, population);
  const highConfidencePopulationCount = group.records
    .filter((record) => record.population === population && record.confidence === 'high')
    .length;
  const isCandidate = group.target.detectorTarget !== 'unknown'
    && population !== 'invalid'
    && population !== 'unclear'
    && population !== 'supports_finding'
    && populationCount >= minPopulationReviews
    && highConfidencePopulationCount >= minHighConfidenceReviews;
  const sortedEvidence = sortEvidenceForReport(group.records, isCandidate ? population : null)
    .slice(0, Math.max(0, maxEvidencePerReport));

  return {
    schemaVersion: DETECTOR_PROPOSAL_REPORT_SCHEMA_VERSION,
    detectorTarget: group.target.detectorTarget,
    candidateKind: group.target.detectorTarget === 'unknown' ? 'unknown' : group.target.candidateKind,
    versions: {
      inputSchemaVersion: group.target.inputSchemaVersion,
      promptVersion: group.target.promptVersion,
      ...(group.target.appGitSha ? { appGitSha: group.target.appGitSha } : {}),
    },
    reviewCounts: group.counts,
    confidenceDistribution: group.confidenceDistribution,
    inputHashes: [...group.inputHashes].sort(),
    evidence: sortedEvidence,
    proposal: {
      status: isCandidate ? 'candidate' : 'insufficient_evidence',
      advisoryOnly: true,
      canExecuteCommands: false,
      canMutateDetectorConfig: false,
      summary: proposalSummary(group.target.detectorTarget, population, populationCount, highConfidencePopulationCount, isCandidate),
    },
  };
}

function projectEvidence(record: FindingEvidenceReviewLogRecordV1, target: FindingEvidenceReviewLogTargetV1): DetectorProposalEvidenceV1 {
  if (record.kind === 'invalid_attempt') {
    return {
      candidateId: record.attempt.candidateId,
      inputHash: record.inputHash,
      appendedAt: record.appendedAt,
      population: 'invalid',
      evidenceRefs: [],
      rationaleEscapedText: sanitizeForDiagnostics(record.attempt.error),
    };
  }

  const population = populationForReview(target, record.review.verdict);
  return {
    candidateId: record.review.candidateId,
    inputHash: record.inputHash,
    appendedAt: record.appendedAt,
    population,
    confidence: record.review.confidence,
    verdict: record.review.verdict,
    evidenceRefs: [...record.review.evidenceRefs],
    rationaleEscapedText: sanitizeForDiagnostics(record.review.rationale),
  };
}

function sortEvidenceForReport(
  records: DetectorProposalEvidenceV1[],
  primaryPopulation: DetectorProposalPopulation | null,
): DetectorProposalEvidenceV1[] {
  return [...records].sort((a, b) => {
    if (primaryPopulation) {
      const aPrimary = a.population === primaryPopulation;
      const bPrimary = b.population === primaryPopulation;
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    }
    return b.appendedAt.localeCompare(a.appendedAt);
  });
}

function populationForReview(target: FindingEvidenceReviewLogTargetV1, verdict: FindingEvidenceReviewVerdict): DetectorProposalPopulation {
  if (verdict === 'unclear') return 'unclear';
  if (target.candidateKind === 'false_negative') return 'false_negative';
  if (verdict === 'likely_false_positive' || verdict === 'timing_false_positive') return 'false_positive';
  return 'supports_finding';
}

function incrementPopulation(counts: DetectorProposalReportV1['reviewCounts'], population: DetectorProposalPopulation): void {
  if (population === 'false_positive') counts.falsePositive += 1;
  else if (population === 'false_negative') counts.falseNegative += 1;
  else if (population === 'invalid') counts.invalid += 1;
  else if (population === 'unclear') counts.unclear += 1;
  else counts.supportsFinding += 1;
}

function dominantProposalPopulation(counts: DetectorProposalReportV1['reviewCounts']): DetectorProposalPopulation {
  const ranked: Array<[DetectorProposalPopulation, number]> = [
    ['false_positive', counts.falsePositive],
    ['false_negative', counts.falseNegative],
    ['invalid', counts.invalid],
    ['unclear', counts.unclear],
    ['supports_finding', counts.supportsFinding],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? 'unclear';
}

function countForPopulation(counts: DetectorProposalReportV1['reviewCounts'], population: DetectorProposalPopulation): number {
  if (population === 'false_positive') return counts.falsePositive;
  if (population === 'false_negative') return counts.falseNegative;
  if (population === 'invalid') return counts.invalid;
  if (population === 'unclear') return counts.unclear;
  return counts.supportsFinding;
}

function proposalSummary(
  detectorTarget: string,
  population: DetectorProposalPopulation,
  populationCount: number,
  highConfidencePopulationCount: number,
  isCandidate: boolean,
): string {
  if (!isCandidate) {
    return `${detectorTarget} has ${populationCount} repeated ${populationLabel(population)} review(s), including ${highConfidencePopulationCount} high-confidence review(s); keep collecting evidence before proposing a detector change.`;
  }
  return `${detectorTarget} has repeated ${populationLabel(population)} review outcomes; inspect the linked evidence and implement any detector change through a normal PR with deterministic tests.`;
}

function populationLabel(population: DetectorProposalPopulation): string {
  return population.replace(/_/g, ' ');
}

function groupKey(target: FindingEvidenceReviewLogTargetV1): string {
  return JSON.stringify({
    candidateKind: target.candidateKind,
    detectorTarget: target.detectorTarget,
    inputSchemaVersion: target.inputSchemaVersion,
    promptVersion: target.promptVersion,
    appGitSha: target.appGitSha ?? null,
  });
}

function sanitizeForDiagnostics(value: string): string {
  return sanitizeDiagnosticText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 600);
}
