import React, { useEffect, useRef, useState } from 'react';
import { formatDiagnosticIdentifier } from './diagnostics-format.js';

interface LiveCalibrationSignal {
  kind:
    | 'skipped_finding'
    | 'snoozed_finding'
    | 'false_positive_feedback'
    | 'direct_intervention_without_finding';
  target: string;
  count: number;
  agentCount: number;
  evidence: string[];
}

interface LiveCalibrationRecommendation {
  id: string;
  target: string;
  direction:
    | 'down_weight_candidate'
    | 'defer_candidate'
    | 'coverage_gap_candidate';
  reason: string;
  evidence: string[];
  affectedActiveAgentIds: string[];
  wouldMutateQueue: false;
}

interface LiveFrictionCalibrationSnapshot {
  schemaVersion: 'live-friction-calibration.v1';
  mode: 'diagnostics_only';
  generatedAt: string;
  routingMutationAllowed: false;
  interactionCount: number;
  activeFindingCount: number;
  signalCount: number;
  signals: LiveCalibrationSignal[];
  recommendations: LiveCalibrationRecommendation[];
}

interface LiveFrictionCalibrationState {
  snapshot: LiveFrictionCalibrationSnapshot | null;
  error: string | null;
}

const EMPTY_STATE: LiveFrictionCalibrationState = {
  snapshot: null,
  error: null,
};

function summary(snapshot: LiveFrictionCalibrationSnapshot | null, loading: boolean): string {
  if (loading) return 'loading';
  if (!snapshot) return 'unavailable';
  const recommendations = snapshot.recommendations ?? [];
  if (recommendations.length > 0) {
    return `${recommendations.length} ${recommendations.length === 1 ? 'advisory' : 'advisories'}`;
  }
  const signalCount = snapshot.signalCount ?? snapshot.signals?.length ?? 0;
  if (signalCount > 0) return `${signalCount} signal${signalCount === 1 ? '' : 's'}`;
  return 'no live friction';
}

export function LiveFrictionCalibrationPanel() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<LiveFrictionCalibrationState>(EMPTY_STATE);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchSnapshot() {
      if (!hasLoadedRef.current) setLoading(true);
      try {
        const res = await fetch('/api/live-friction-calibration');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snapshot = await res.json() as LiveFrictionCalibrationSnapshot;
        if (!cancelled) {
          hasLoadedRef.current = true;
          setState({ snapshot, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setState({
            snapshot: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const snapshot = state.snapshot;
  const recommendations = snapshot?.recommendations ?? [];
  const signals = snapshot?.signals ?? [];
  const signalCount = snapshot?.signalCount ?? signals.length;
  const activeFindingCount = snapshot?.activeFindingCount ?? 0;

  return (
    <div className="live-calibration-section">
      <button
        type="button"
        className="section-header live-calibration-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="section-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="stats-label">
          Friction Calibration
          <span className="stats-summary">{summary(snapshot, loading)}</span>
        </span>
      </button>
      {expanded && (
        <div className="live-calibration-body" aria-live="polite">
          {loading ? (
            <div className="stats-row muted">Loading live friction calibration...</div>
          ) : state.error ? (
            <div className="live-calibration-error">Live friction calibration returned {state.error}</div>
          ) : !snapshot ? (
            <div className="stats-row muted">No calibration snapshot available</div>
          ) : (
            <>
              <div className="live-calibration-status-row">
                <span className="live-calibration-pill">Diagnostics only</span>
                <span className="live-calibration-pill">Does not reorder findings</span>
                <span className="live-calibration-pill">{activeFindingCount} active</span>
              </div>

              {recommendations.length === 0 && signalCount === 0 ? (
                <div className="stats-row muted">No live skip, snooze, false-positive, or missed-finding signals yet</div>
              ) : (
                <div className="live-calibration-list">
                  {recommendations.slice(0, 4).map((recommendation) => (
                    <div key={recommendation.id} className="live-calibration-row">
                      <span className="live-calibration-target">{formatDiagnosticIdentifier(recommendation.target)}</span>
                      <span className="live-calibration-action">{formatDiagnosticIdentifier(recommendation.direction)}</span>
                      <span className="live-calibration-reason">{recommendation.reason}</span>
                    </div>
                  ))}
                  {recommendations.length === 0 && signals.slice(0, 4).map((signal) => (
                    <div key={`${signal.kind}-${signal.target}`} className="live-calibration-row">
                      <span className="live-calibration-target">{formatDiagnosticIdentifier(signal.target)}</span>
                      <span className="live-calibration-action">{formatDiagnosticIdentifier(signal.kind)}</span>
                      <span className="live-calibration-reason">
                        {signal.count} signal{signal.count === 1 ? '' : 's'} across {signal.agentCount} agent{signal.agentCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
