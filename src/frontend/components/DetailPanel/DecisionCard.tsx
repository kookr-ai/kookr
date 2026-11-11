import React, { useEffect, useState } from 'react';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import { findingKindClass, findingTypeLabel, formatDuration } from '../../presentation.js';

/**
 * The decision card docked above the reply box (issue #3561 slice 4b): what
 * the agent is waiting on, the agent's last message, and the buttons that
 * answer it, plus Skip and Snooze. DetailPanel docks it at the foot of the
 * conversation pane, right above the reply box. A leaf component owns the
 * minute clock for "waiting 4m", so the tick does not re-render the terminal.
 */
export function DecisionCard({
  agent,
  actions,
  triage,
}: {
  agent: AgentState;
  /** The finding's quick-action buttons (the existing `.quick-actions` block). */
  actions: React.ReactNode;
  /** Skip and Snooze for the finding. */
  triage: React.ReactNode;
}) {
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const anomaly = agent.anomaly;
  if (!anomaly) return null;
  const kind = findingKindClass(anomaly.type, agent.turnState);
  const tone = kind === 'error' || kind === 'stuck' ? 'bad' : 'need';
  const detectedAt = typeof anomaly.detectedAt === 'string' ? anomaly.detectedAt : new Date(anomaly.detectedAt).toISOString();
  const waiting = formatDuration(detectedAt);
  const lastMessage = anomaly.transcriptContext?.lastAssistantMessage;

  return (
    <section
      className={`decision-card decision-card--${tone}`}
      data-testid="decision-card"
      aria-label="What the agent needs"
    >
      <div className="decision-card-head">
        <i className="decision-card-mark" aria-hidden="true" />
        <span>{findingTypeLabel(agent)}</span>
        {waiting && <span className="decision-card-wait">waiting {waiting}</span>}
      </div>
      {anomaly.explanation && <p className="decision-card-ask">{anomaly.explanation}</p>}
      {lastMessage && (
        <div className="detail-transcript-context" data-testid="detail-transcript-context">
          <div className="detail-transcript-context-label">Last agent message</div>
          <div className="detail-transcript-context-text">
            {lastMessage.excerpt}
            {lastMessage.truncated ? '...' : ''}
          </div>
        </div>
      )}
      {actions}
      <div className="decision-card-acts">
        {triage}
        <span className="decision-card-hint">or reply below</span>
      </div>
    </section>
  );
}
