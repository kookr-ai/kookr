import React, { useEffect, useMemo, useState } from 'react';
import type { FindingEvidenceAuditRecord } from '../../shared/contracts/anomalies.js';

type ReviewCandidateState = 'queued' | 'in_progress' | 'reviewed' | 'failed_retryable' | 'failed_terminal';

interface ReviewLogDiagnostic {
  lineNumber: number;
  failureKind: 'malformed_json' | 'invalid_record';
  message: string;
}

interface ReviewLogRecord {
  kind: 'valid_review' | 'invalid_attempt';
  appendedAt: string;
  inputHash: string;
  target?: {
    candidateKind: 'false_positive' | 'false_negative';
    detectorTarget: string;
  };
  review?: {
    candidateId: string;
    verdict: string;
    confidence: string;
  };
  attempt?: {
    candidateId: string;
    failureKind: string;
  };
}

interface ReviewLogResponse {
  schemaVersion?: string;
  records?: ReviewLogRecord[];
  diagnostics?: ReviewLogDiagnostic[];
}

interface AuditResponse {
  records?: FindingEvidenceAuditRecord[];
  reviewCandidates?: FindingEvidenceAuditRecord[];
}

interface DetectorProposalReport {
  detectorTarget: string;
  candidateKind: 'false_positive' | 'false_negative' | 'unknown';
  reviewCounts: {
    total: number;
    falsePositive: number;
    falseNegative: number;
    invalid: number;
    unclear: number;
    supportsFinding: number;
  };
  proposal: {
    status: 'candidate' | 'insufficient_evidence';
    summary: string;
  };
}

interface DetectorProposalResponse {
  schemaVersion?: string;
  reports?: DetectorProposalReport[];
  diagnostics?: ReviewLogDiagnostic[];
}

interface SamplerStatus {
  schemaVersion?: string;
  enabled: boolean;
  running: boolean;
  providerAvailable: boolean;
  lastRun: {
    sampled: number;
    reviewed: number;
    modelCallsFailed: number;
    budgetExhausted: boolean;
  } | null;
  nextRunAt: string | null;
  queue: Record<ReviewCandidateState, number>;
  budget: {
    dailyCostCents: number;
    spentCostCents: number;
    remainingCostCents: number;
    dailyTokenBudget: number;
    spentTokens: number;
    remainingTokens: number;
  };
}

type EndpointResult<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; message: string };

interface DiagnosticsState {
  audit: EndpointResult<AuditResponse>;
  reviewLog: EndpointResult<ReviewLogResponse>;
  sampler: EndpointResult<SamplerStatus>;
  proposals: EndpointResult<DetectorProposalResponse>;
}

const INITIAL_STATE: DiagnosticsState = {
  audit: { status: 'loading' },
  reviewLog: { status: 'loading' },
  sampler: { status: 'loading' },
  proposals: { status: 'loading' },
};

async function readEndpoint<T>(url: string): Promise<EndpointResult<T>> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: 'unavailable', message: `HTTP ${res.status}` };
    return { status: 'ready', data: await res.json() as T };
  } catch (err) {
    return { status: 'unavailable', message: err instanceof Error ? err.message : 'network error' };
  }
}

function useFindingEvidenceDiagnostics(): DiagnosticsState {
  const [state, setState] = useState<DiagnosticsState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [audit, reviewLog, sampler, proposals] = await Promise.all([
        readEndpoint<AuditResponse>('/api/finding-evidence-audit'),
        readEndpoint<ReviewLogResponse>('/api/finding-evidence-review-log?limit=5'),
        readEndpoint<SamplerStatus>('/api/finding-evidence-review-sampler'),
        readEndpoint<DetectorProposalResponse>('/api/finding-evidence-review-detector-proposals?minReviews=2&maxEvidence=3'),
      ]);
      if (!cancelled) setState({ audit, reviewLog, sampler, proposals });
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  return state;
}

function recordsFromAudit(result: EndpointResult<AuditResponse>): FindingEvidenceAuditRecord[] {
  return result.status === 'ready' && Array.isArray(result.data.records) ? result.data.records : [];
}

function candidatesFromAudit(result: EndpointResult<AuditResponse>): FindingEvidenceAuditRecord[] {
  return result.status === 'ready' && Array.isArray(result.data.reviewCandidates) ? result.data.reviewCandidates : [];
}

function recordsFromReviewLog(result: EndpointResult<ReviewLogResponse>): ReviewLogRecord[] {
  return result.status === 'ready' && Array.isArray(result.data.records) ? result.data.records : [];
}

function diagnosticsFromReviewLog(result: EndpointResult<ReviewLogResponse>): ReviewLogDiagnostic[] {
  return result.status === 'ready' && Array.isArray(result.data.diagnostics) ? result.data.diagnostics : [];
}

function reportsFromProposals(result: EndpointResult<DetectorProposalResponse>): DetectorProposalReport[] {
  return result.status === 'ready' && Array.isArray(result.data.reports) ? result.data.reports : [];
}

function diagnosticsFromProposals(result: EndpointResult<DetectorProposalResponse>): ReviewLogDiagnostic[] {
  return result.status === 'ready' && Array.isArray(result.data.diagnostics) ? result.data.diagnostics : [];
}

function samplerFromResult(result: EndpointResult<SamplerStatus>): SamplerStatus | null {
  if (result.status !== 'ready') return null;
  return result.data.schemaVersion === 'finding-evidence-review-sampler-status.v1' ? result.data : null;
}

function unavailableMessage(label: string, result: EndpointResult<unknown>): string | null {
  if (result.status === 'unavailable') return `${label}: ${result.message}`;
  return null;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

function formatStatus(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return 'n/a';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatSamplerQueue(queue: Record<ReviewCandidateState, number>): string {
  const failed = (queue.failed_retryable ?? 0) + (queue.failed_terminal ?? 0);
  return `${queue.queued ?? 0} queued, ${queue.in_progress ?? 0} running, ${queue.reviewed ?? 0} reviewed, ${failed} failed`;
}

function statusLabel(record: ReviewLogRecord): string {
  if (record.kind === 'valid_review') return record.review?.verdict ? formatStatus(record.review.verdict) : 'valid review';
  return record.attempt?.failureKind ? formatStatus(record.attempt.failureKind) : 'invalid attempt';
}

export function FindingEvidenceDiagnosticsPanel() {
  const [expanded, setExpanded] = useState(true);
  const state = useFindingEvidenceDiagnostics();
  const bodyId = 'finding-evidence-body';

  const auditRecords = recordsFromAudit(state.audit);
  const reviewCandidates = candidatesFromAudit(state.audit);
  const reviewRecords = recordsFromReviewLog(state.reviewLog);
  const reviewDiagnostics = diagnosticsFromReviewLog(state.reviewLog);
  const proposalReports = reportsFromProposals(state.proposals);
  const proposalDiagnostics = diagnosticsFromProposals(state.proposals);
  const sampler = samplerFromResult(state.sampler);
  const activeAuditCount = auditRecords.filter((record) => record.status === 'active').length;
  const auditVerdicts = useMemo(
    () => countBy(auditRecords.map((record) => record.verdict)),
    [auditRecords],
  );
  const candidateReports = proposalReports.filter((report) => report.proposal.status === 'candidate');
  const loading = Object.values(state).some((result) => result.status === 'loading');
  const unavailable = [
    unavailableMessage('audit', state.audit),
    unavailableMessage('review log', state.reviewLog),
    unavailableMessage('sampler', state.sampler),
    unavailableMessage('proposals', state.proposals),
  ].filter((message): message is string => Boolean(message));
  const summary = loading
    ? 'loading'
    : `${activeAuditCount} active, ${reviewRecords.length} reviews, ${candidateReports.length} proposals`;

  return (
    <div className="finding-evidence-section">
      <button
        type="button"
        className="section-header section-header-button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="section-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="stats-label">
          Finding Evidence
          <span className="stats-summary">{summary}</span>
        </span>
      </button>
      <div id={bodyId} className="finding-evidence-body" hidden={!expanded}>
        {expanded && (loading ? (
          <div className="stats-row muted">Loading finding-evidence diagnostics...</div>
        ) : (
          <>
            <div className="finding-evidence-summary-grid">
              <span>Audit records</span>
              <strong>{auditRecords.length}</strong>
              <span>Active</span>
              <strong>{activeAuditCount}</strong>
              <span>Review candidates</span>
              <strong>{reviewCandidates.length}</strong>
              <span>Persisted reviews</span>
              <strong>{reviewRecords.length}</strong>
            </div>

            <div className="finding-evidence-chips">
              {Object.keys(auditVerdicts).length === 0 ? (
                <span className="finding-evidence-chip finding-evidence-chip--muted">no audit verdicts</span>
              ) : Object.entries(auditVerdicts).map(([verdict, count]) => (
                <span key={verdict} className="finding-evidence-chip">
                  {formatStatus(verdict)} {count}
                </span>
              ))}
            </div>

            {sampler ? (
              <div className="finding-evidence-sampler">
                <span className={`finding-evidence-state-dot ${sampler.enabled ? 'finding-evidence-state-dot--on' : ''}`} />
                <span>{sampler.enabled ? 'Sampler enabled' : 'Sampler disabled'}</span>
                <span>{sampler.running ? 'running' : 'idle'}</span>
                <span>{sampler.providerAvailable ? 'provider ready' : 'provider unavailable'}</span>
                <span>{formatSamplerQueue(sampler.queue)}</span>
                <span>{formatCents(sampler.budget.remainingCostCents)} budget left</span>
              </div>
            ) : (
              <div className="stats-row muted">Sampler status unavailable</div>
            )}

            {reviewRecords.length > 0 ? (
              <div className="finding-evidence-list">
                {reviewRecords.slice(-5).reverse().map((record) => (
                  <div key={`${record.inputHash}-${record.appendedAt}`} className="finding-evidence-review-row">
                    <span className={`finding-evidence-review-kind finding-evidence-review-kind--${record.kind}`}>
                      {record.kind === 'valid_review' ? 'review' : 'invalid'}
                    </span>
                    <span className="finding-evidence-target">{record.target?.detectorTarget ?? 'unknown detector'}</span>
                    <span className="finding-evidence-review-status">{statusLabel(record)}</span>
                    <span className="finding-evidence-time">{formatTime(record.appendedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="stats-row muted">No persisted finding-evidence reviews yet</div>
            )}

            {candidateReports.length > 0 ? (
              <div className="finding-evidence-proposals">
                {candidateReports.slice(0, 3).map((report) => (
                  <div key={`${report.candidateKind}:${report.detectorTarget}`} className="finding-evidence-proposal-row">
                    <span className="finding-evidence-target">{report.detectorTarget}</span>
                    <span className="finding-evidence-review-status">{report.reviewCounts.total} reviews</span>
                    <span className="finding-evidence-proposal-summary">{report.proposal.summary}</span>
                    <a
                      className="finding-evidence-proposal-link"
                      href="/api/finding-evidence-review-detector-proposals?minReviews=2&maxEvidence=3"
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open detector proposal report for ${report.detectorTarget}`}
                    >
                      report
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <div className="stats-row muted">No detector proposal candidates yet</div>
            )}

            {(reviewDiagnostics.length > 0 || proposalDiagnostics.length > 0 || unavailable.length > 0) && (
              <div className="finding-evidence-warnings">
                {[...unavailable, ...reviewDiagnostics.map((diagnostic) => `review log line ${diagnostic.lineNumber}: ${diagnostic.failureKind}`),
                  ...proposalDiagnostics.map((diagnostic) => `proposal input line ${diagnostic.lineNumber}: ${diagnostic.failureKind}`)]
                  .slice(0, 4)
                  .map((message) => (
                    <span key={message} className="finding-evidence-warning">{message}</span>
                  ))}
                </div>
              )}
          </>
        ))}
      </div>
    </div>
  );
}
