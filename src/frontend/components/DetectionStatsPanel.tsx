import React, { useState, useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { DiagnosticFinding } from '../store/store-types.js';
import { formatDetectionStatsSummary } from './detection-stats-format.js';

interface DetectionStats {
  checks: Record<string, number>;
  fires: Record<string, number>;
  falsePositives: Record<string, number>;
}

const LABEL: Record<string, string> = {
  needs_input: 'Needs Input',
  permission_blocked: 'Permission',

  repeated_error: 'Repeated Error',
  merge_conflict: 'Merge Conflict',
  stale_agent: 'Stale Agent',
  hook_disconnected: 'Hook Disconnected',
  hook_missing: 'Hook Missing',
  tmux_unresponsive: 'Tmux Unresponsive',
  api_error: 'API Error',
};

function useDetectionStats(intervalMs = 30_000): DetectionStats | null {
  const [stats, setStats] = useState<DetectionStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetch_() {
      try {
        const res = await fetch('/api/anomaly-stats');
        if (!cancelled && res.ok) setStats(await res.json());
      } catch { /* ignore network errors */ }
    }
    fetch_();
    const id = setInterval(fetch_, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return stats;
}

function DiagnosticFindingRow({ finding }: { finding: DiagnosticFinding }) {
  const [showDetail, setShowDetail] = useState(false);
  const icon = finding.severity === 'critical' ? '\u274C' : '\u26A0\uFE0F';

  return (
    <div
      className={`diagnostic-finding diagnostic-finding--${finding.severity}`}
      onClick={() => setShowDetail(!showDetail)}
    >
      <div className="diagnostic-finding-header">
        <span className="diagnostic-finding-icon">{icon}</span>
        <span className="diagnostic-finding-title">{finding.title}</span>
      </div>
      {showDetail && (
        <div className="diagnostic-finding-detail">
          <div className="diagnostic-finding-description">{finding.description}</div>
          <div className="diagnostic-finding-meta">
            Scope: {finding.scope} | Observed: {finding.observed.toLocaleString()} | Threshold: {finding.threshold.toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticSection() {
  const diagnosticReport = useKookrStore((s) => s.diagnosticReport);
  const [lastError, setLastError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const findings = diagnosticReport?.findings ?? [];
  const hasFindings = findings.length > 0;
  const hasCritical = findings.some((f) => f.severity === 'critical');

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await fetch('/api/diagnostic/run', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        useKookrStore.getState().handleDiagnosticReport(data.report);
        setLastError(null);
      } else {
        setLastError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="diagnostic-section">
      <div className="diagnostic-status-row">
        {hasFindings ? (
          <span className={`diagnostic-badge diagnostic-badge--${hasCritical ? 'critical' : 'warning'}`}>
            {findings.length} issue{findings.length !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="diagnostic-badge diagnostic-badge--healthy">System healthy</span>
        )}
        {diagnosticReport && (
          <span className="diagnostic-timestamp">
            {new Date(diagnosticReport.timestamp).toLocaleTimeString()}
          </span>
        )}
        <button
          className="diagnostic-run-btn"
          onClick={handleRunNow}
          disabled={running}
          title="Run self-diagnostic now"
        >
          {running ? 'Running...' : 'Run diagnostic'}
        </button>
      </div>
      {lastError && (
        <div className="diagnostic-error">Diagnostic error: {lastError}</div>
      )}
      {hasFindings && (
        <div className="diagnostic-findings">
          {findings.map((f, i) => (
            <DiagnosticFindingRow key={`${f.checkId}-${f.scope}-${i}`} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}

interface DetectionStatsPanelProps {
  defaultExpanded?: boolean;
  showEmpty?: boolean;
}

export function DetectionStatsPanel({ defaultExpanded = false, showEmpty = false }: DetectionStatsPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const stats = useDetectionStats();
  const serverStartedAt = useKookrStore((s) => s.serverStartedAt);
  const diagnosticReport = useKookrStore((s) => s.diagnosticReport);

  if (!stats) {
    if (!showEmpty) return null;
    return (
      <div className="detection-stats-section">
        <div className="section-header">
          <span className="section-chevron"> </span>
          <span className="stats-label">Detection Stats</span>
        </div>
        <div className="detection-stats-body">
          <div className="stats-row muted">Loading detection stats...</div>
        </div>
      </div>
    );
  }

  const totalFires = Object.values(stats.fires).reduce((a, b) => a + b, 0);
  const totalChecks = Object.values(stats.checks).reduce((a, b) => a + b, 0);

  // Nothing detected yet — don't clutter the panel
  if (totalChecks === 0 && !showEmpty) return null;

  // Only show types that have fired at least once
  const firedTypes = Object.entries(stats.fires)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  const diagnosticFindings = diagnosticReport?.findings ?? [];
  const hasDiagnosticIssues = diagnosticFindings.length > 0;
  const hasCritical = diagnosticFindings.some((f) => f.severity === 'critical');

  return (
    <div className="detection-stats-section">
      <div className="section-header" onClick={() => setExpanded(!expanded)}>
        <span className="section-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="stats-label">
          Detection Stats
          {hasDiagnosticIssues && (
            <span className={`diagnostic-header-badge diagnostic-header-badge--${hasCritical ? 'critical' : 'warning'}`}>
              {diagnosticFindings.length} {hasCritical ? 'critical' : 'warning'}
            </span>
          )}
          <span className="stats-summary">
            {formatDetectionStatsSummary(totalFires, serverStartedAt)}
          </span>
        </span>
      </div>
      {expanded && (
        <div className="detection-stats-body">
          <DiagnosticSection />
          {totalChecks === 0 ? (
            <div className="stats-row muted">No detection checks recorded yet</div>
          ) : firedTypes.length === 0 && (
            <div className="stats-row muted">No anomalies detected yet ({totalChecks} checks run)</div>
          )}
          {firedTypes.map(([type, fires]) => {
            const checks = stats.checks[type] ?? 0;
            const fp = stats.falsePositives?.[type] ?? 0;
            const rate = checks > 0 ? ((fires / checks) * 100).toFixed(1) : '0';
            return (
              <div key={type} className="stats-row">
                <span className="stats-type">{LABEL[type] ?? type}</span>
                <span className="stats-count">{fires}</span>
                {fp > 0 && <span className="stats-fp">{fp} FP</span>}
                <span className="stats-rate">{rate}% fire rate</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
