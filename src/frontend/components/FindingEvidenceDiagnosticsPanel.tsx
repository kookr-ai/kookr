import React, { useEffect, useMemo, useState } from 'react';
import { formatDiagnosticIdentifier } from './diagnostics-format.js';

interface FindingEvidenceReviewSamplerStatus {
  enabled?: boolean;
  running?: boolean;
  providerAvailable?: boolean;
  lastRun?: {
    finishedAt?: string;
    sampled?: number;
    enqueued?: number;
    reviewed?: number;
    modelCallsFailed?: number;
    invalidOutputs?: number;
    skipped?: Record<string, number>;
  } | null;
  nextRunAt?: string | null;
  queue?: Record<string, number>;
  budget?: {
    dailyCostCents?: number;
    spentCostCents?: number;
    remainingCostCents?: number;
    dailyTokenBudget?: number;
    spentTokens?: number;
    remainingTokens?: number;
  };
}

interface DetectorProposalReport {
  detectorTarget?: string;
  candidateKind?: string;
  reviewCounts?: {
    total?: number;
    falsePositive?: number;
    falseNegative?: number;
    invalid?: number;
    unclear?: number;
    supportsFinding?: number;
  };
  proposal?: {
    status?: string;
    summary?: string;
  };
}

interface FindingEvidenceOperationsDiagnosticsResponse {
  audit?: {
    recordsCount?: number;
    reviewCandidatesCount?: number;
  };
  reviewLog?: {
    recordsCount?: number;
    validReviews?: number;
    invalidAttempts?: number;
    diagnosticsCount?: number;
    verdictCounts?: Record<string, number>;
  };
  sampler?: {
    status?: 'available' | 'unavailable';
    value?: FindingEvidenceReviewSamplerStatus;
    error?: string;
  };
  proposals?: {
    reports?: DetectorProposalReport[];
    diagnosticsCount?: number;
  };
}

interface FindingEvidenceDiagnosticsState {
  diagnostics: FindingEvidenceOperationsDiagnosticsResponse | null;
  errors: string[];
}

const EMPTY_STATE: FindingEvidenceDiagnosticsState = {
  diagnostics: null,
  errors: [],
};

const OPERATIONS_DIAGNOSTICS_URL = '/api/finding-evidence-operations-diagnostics';

function formatCompactDate(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCents(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  return `$${(value / 100).toFixed(2)}`;
}

function sumRecord(values: Record<string, number> | undefined): number {
  if (!values) return 0;
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function topEntries(values: Record<string, number> | undefined, limit = 4): Array<[string, number]> {
  if (!values) return [];
  return Object.entries(values)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'good' | 'warn' | 'neutral' }) {
  return <span className={`finding-evidence-pill finding-evidence-pill--${tone}`}>{label}</span>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="finding-evidence-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function FindingEvidenceDiagnosticsPanel() {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<FindingEvidenceDiagnosticsState>(EMPTY_STATE);

  useEffect(() => {
    const controller = new AbortController();
    async function load(showLoading: boolean) {
      if (showLoading) setLoading(true);
      const diagnostics = await readJson<FindingEvidenceOperationsDiagnosticsResponse>(
        OPERATIONS_DIAGNOSTICS_URL,
        controller.signal,
      );
      setState({ diagnostics, errors: [] });
      setLoading(false);
    }

    load(true).catch((err: unknown) => {
      if (isAbortError(err)) return;
      setState({ ...EMPTY_STATE, errors: [`Finding evidence diagnostics returned ${err instanceof Error ? err.message : String(err)}`] });
      setLoading(false);
    });
    const id = setInterval(() => {
      void load(false).catch((err: unknown) => {
        if (isAbortError(err)) return;
        setState((current) => ({
          ...current,
          errors: [`Finding evidence diagnostics returned ${err instanceof Error ? err.message : String(err)}`],
        }));
      });
    }, 30_000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  const summary = useMemo(() => buildSummary(state), [state]);
  const sampler = state.diagnostics?.sampler?.status === 'available'
    ? state.diagnostics.sampler.value ?? null
    : null;
  const hasData = Boolean(state.diagnostics || state.errors.length > 0);
  const hasReviewFailures = summary.invalidAttempts > 0 || summary.reviewLogDiagnostics > 0 || summary.errors > 0;
  const reviewerStatus = reviewerModelStatus(sampler);

  return (
    <div className="finding-evidence-section">
      <button
        type="button"
        className="section-header finding-evidence-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="section-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="stats-label">
          Finding Evidence
          <span className="stats-summary">
            {loading ? 'loading' : `${summary.candidates} candidates, ${summary.reviews} reviews`}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="finding-evidence-body" aria-live="polite">
          {loading ? (
            <div className="stats-row muted">Loading finding evidence diagnostics...</div>
          ) : !hasData ? (
            <div className="stats-row muted">No finding evidence diagnostics available</div>
          ) : (
            <>
              <div className="finding-evidence-status-row">
                <StatusPill label={samplerLabel(state.diagnostics?.sampler)} tone={sampler?.running ? 'good' : 'neutral'} />
                <StatusPill label={reviewerStatus.label} tone={reviewerStatus.tone} />
                {hasReviewFailures && <StatusPill label="Review attention" tone="warn" />}
              </div>

              <div className="finding-evidence-metrics">
                <Metric label="Audit records" value={summary.auditRecords} />
                <Metric label="Review candidates" value={summary.candidates} />
                <Metric label="Persisted reviews" value={summary.reviews} />
                <Metric label="Proposal reports" value={summary.proposalReports} />
              </div>

              <div className="finding-evidence-subgrid">
                <div className="finding-evidence-block">
                  <span className="finding-evidence-block-title">Review Queue</span>
                  <div className="finding-evidence-inline-stats">
                    {queueEntries(sampler).length === 0 ? (
                      <span className="muted">empty</span>
                    ) : queueEntries(sampler).map(([stateName, count]) => (
                      <span key={stateName}>{formatDiagnosticIdentifier(stateName)} {count}</span>
                    ))}
                  </div>
                  <span className="finding-evidence-note">
                    Last run {formatCompactDate(sampler?.lastRun?.finishedAt)}
                    {sampler?.lastRun ? `, reviewed ${sampler.lastRun.reviewed ?? 0}` : ''}
                  </span>
                </div>

                <div className="finding-evidence-block">
                  <span className="finding-evidence-block-title">Review Log</span>
                  <div className="finding-evidence-inline-stats">
                    <span>valid {summary.validReviews}</span>
                    <span>invalid {summary.invalidAttempts}</span>
                    <span>diagnostics {summary.reviewLogDiagnostics}</span>
                  </div>
                  <span className="finding-evidence-note">
                    Budget {formatCents(sampler?.budget?.spentCostCents)} / {formatCents(sampler?.budget?.dailyCostCents)}
                  </span>
                </div>
              </div>

              {topEntries(summary.verdictCounts).length > 0 && (
                <div className="finding-evidence-chip-row" aria-label="Finding evidence review verdict counts">
                  {topEntries(summary.verdictCounts).map(([verdict, count]) => (
                    <span key={verdict} className="finding-evidence-chip">{formatDiagnosticIdentifier(verdict)} {count}</span>
                  ))}
                </div>
              )}

              {state.diagnostics?.proposals?.reports && state.diagnostics.proposals.reports.length > 0 && (
                <div className="finding-evidence-proposals">
                  {state.diagnostics.proposals.reports.slice(0, 3).map((report, index) => (
                    <div key={`${report.detectorTarget ?? 'unknown'}-${index}`} className="finding-evidence-proposal-row">
                      <span className="finding-evidence-proposal-target">{formatDiagnosticIdentifier(report.detectorTarget)}</span>
                      <span className="finding-evidence-proposal-status">{formatDiagnosticIdentifier(report.proposal?.status)}</span>
                      <span className="finding-evidence-proposal-summary">{report.proposal?.summary ?? `${report.reviewCounts?.total ?? 0} reviews`}</span>
                    </div>
                  ))}
                </div>
              )}

              {state.errors.length > 0 && (
                <div className="finding-evidence-error">
                  {state.errors.join('; ')}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function buildSummary(state: FindingEvidenceDiagnosticsState) {
  const diagnostics = state.diagnostics;
  const reviewLogDiagnostics = (diagnostics?.reviewLog?.diagnosticsCount ?? 0)
    + (diagnostics?.proposals?.diagnosticsCount ?? 0);

  return {
    auditRecords: diagnostics?.audit?.recordsCount ?? 0,
    candidates: diagnostics?.audit?.reviewCandidatesCount ?? 0,
    reviews: diagnostics?.reviewLog?.recordsCount ?? 0,
    validReviews: diagnostics?.reviewLog?.validReviews ?? 0,
    invalidAttempts: diagnostics?.reviewLog?.invalidAttempts ?? 0,
    proposalReports: diagnostics?.proposals?.reports?.length ?? 0,
    reviewLogDiagnostics,
    errors: state.errors.length,
    verdictCounts: diagnostics?.reviewLog?.verdictCounts ?? {},
  };
}

function samplerLabel(sampler: FindingEvidenceOperationsDiagnosticsResponse['sampler'] | null | undefined): string {
  if (!sampler) return 'Sampler unavailable';
  if (sampler.status === 'unavailable') return 'Sampler unavailable';
  if (sampler.value?.running) return 'Sampler running';
  if (sampler.value?.enabled) return 'Sampler enabled';
  return 'Sampler disabled';
}

function reviewerModelStatus(sampler: FindingEvidenceReviewSamplerStatus | null): {
  label: string;
  tone: 'good' | 'warn' | 'neutral';
} {
  if (!sampler) return { label: 'Reviewer model unknown', tone: 'neutral' };
  if (sampler.providerAvailable === false) return { label: 'No reviewer model', tone: 'warn' };
  return { label: 'Reviewer model ready', tone: 'good' };
}

function queueEntries(sampler: FindingEvidenceReviewSamplerStatus | null): Array<[string, number]> {
  const entries = topEntries(sampler?.queue, 5);
  if (entries.length > 0) return entries;
  const total = sumRecord(sampler?.queue);
  return total > 0 ? [['total', total]] : [];
}
