import React, { useEffect, useState } from 'react';
import type { EvolutionRunProjection } from '../../shared/protocol.js';
import { EVOLUTION_TRIAL_OUTCOMES } from '../../shared/contracts/evolution.js';

type EvolutionPanelState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: EvolutionRunProjection; error: null }
  | { status: 'error'; data: null; error: string };

interface Props {
  taskId: string;
}

export function EvolutionPanel({ taskId }: Props) {
  const [state, setState] = useState<EvolutionPanelState>({ status: 'loading', data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    let firstLoad = true;
    setState({ status: 'loading', data: null, error: null });

    const load = () => {
      fetch(`/api/tasks/${encodeURIComponent(taskId)}/evolution`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Request failed with ${res.status}`);
          }
          return res.json() as Promise<EvolutionRunProjection>;
        })
        .then((data) => {
          firstLoad = false;
          setState({ status: 'ready', data, error: null });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (firstLoad) {
            setState({ status: 'error', data: null, error: err instanceof Error ? err.message : String(err) });
          }
        });
    };

    load();
    const interval = window.setInterval(load, 5_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [taskId]);

  if (state.status === 'loading') {
    return <div className="evolution-panel evolution-panel-state">Loading evolution run...</div>;
  }
  if (state.status === 'error') {
    return <div className="evolution-panel evolution-panel-state error">{state.error}</div>;
  }

  const { champion, bestScore, outcomeCounts, trajectory, stopReason, trialCount, malformedTrialLines } = state.data;

  return (
    <section className="evolution-panel" aria-label="Evolution champion and trajectory">
      <div className="evolution-panel-header">
        <h3>Champion</h3>
        {stopReason && <span className="evolution-stop-reason">Stopped: {stopReason}</span>}
      </div>
      <div className="evolution-summary-grid">
        <SummaryItem label="Best score" value={formatScore(bestScore)} />
        <SummaryItem label="Trials" value={`${trialCount}`} />
        <SummaryItem label="Champion iter" value={champion?.iteration === undefined ? 'Unavailable' : `${champion.iteration}`} />
        <SummaryItem label="Artifact" value={champion?.artifactRef ?? 'Unavailable'} />
      </div>
      <div className="evolution-outcomes" aria-label="Trial outcomes">
        {EVOLUTION_TRIAL_OUTCOMES.map((outcome) => (
          <span key={outcome} className={`evolution-outcome evolution-outcome-${outcome}`}>
            {outcome}: <strong>{outcomeCounts[outcome]}</strong>
          </span>
        ))}
      </div>
      {trajectory.length === 0 ? (
        <div className="evolution-empty">No scored trials recorded yet.</div>
      ) : (
        <div className="evolution-trajectory" aria-label="Score trajectory">
          {trajectory.slice(-20).map((point) => (
            <span
              key={`${point.iteration}-${point.outcome}-${point.score}`}
              className={`evolution-point evolution-point-${point.outcome}`}
              title={`Iteration ${point.iteration}: ${formatScore(point.score)} (${point.outcome})`}
            >
              <span>{point.iteration}</span>
              <strong>{formatScore(point.score)}</strong>
            </span>
          ))}
        </div>
      )}
      {malformedTrialLines > 0 && (
        <div className="evolution-warning">
          {malformedTrialLines} malformed trial log line{malformedTrialLines === 1 ? '' : 's'} skipped
        </div>
      )}
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="evolution-summary-item">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return 'Unavailable';
  return Number.isInteger(score) ? String(score) : score.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
