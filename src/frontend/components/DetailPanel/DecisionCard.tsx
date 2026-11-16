import React, { useEffect, useState } from 'react';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import { findingKindClass, findingTypeLabel, formatDuration } from '../../presentation.js';

/**
 * The decision card docked above the reply box (issue #3561 slice 4b): what
 * the agent is waiting on, the agent's last message, and the buttons that
 * answer it, plus Skip and Snooze. DetailPanel docks it at the foot of the
 * conversation pane, right above the reply box. On the Terminal tab it sits in
 * the reply area instead, in a compact form (issue #4024): the ask stays in
 * full, and the last agent message folds behind a disclosure, because every
 * line the card takes comes out of the terminal's height. A leaf component
 * owns the minute clock for "waiting 4m", so the tick does not re-render the
 * terminal.
 *
 * The agent's own notices (its completion signal, an operator-needed flag)
 * render as lines right under the card's head (issue #4024), above anything
 * the compact form folds or caps. They can show without a finding: the card
 * then keeps only its head and those lines, with no answers, Skip or Snooze,
 * because there is no finding to answer or set aside.
 */
export function DecisionCard({
  agent,
  actions,
  triage,
  compact = false,
  notices = null,
}: {
  agent: AgentState;
  /** The finding's quick-action buttons (the existing `.quick-actions` block). */
  actions: React.ReactNode;
  /** Skip and Snooze for the finding. */
  triage: React.ReactNode;
  /** The Terminal tab's form: last agent message folded, height capped tighter. */
  compact?: boolean;
  /**
   * The agent's notices, rendered under the head. `label` and `tone` title the
   * card when there is no finding to title it.
   */
  notices?: { nodes: React.ReactNode; label: string; tone: 'need' | 'bad' } | null;
}) {
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const anomaly = agent.anomaly;
  const compactClass = compact ? ' decision-card--compact' : '';
  if (!anomaly) {
    if (!notices) return null;
    return (
      <section
        className={`decision-card decision-card--${notices.tone} decision-card--notice${compactClass}`}
        data-testid="decision-card"
        aria-label="What the agent needs"
      >
        <div className="decision-card-head">
          <i className="decision-card-mark" aria-hidden="true" />
          <span>{notices.label}</span>
        </div>
        <div className="decision-card-notes">{notices.nodes}</div>
      </section>
    );
  }
  const kind = findingKindClass(anomaly.type, agent.turnState);
  const tone = kind === 'error' || kind === 'stuck' ? 'bad' : 'need';
  const detectedAt = typeof anomaly.detectedAt === 'string' ? anomaly.detectedAt : new Date(anomaly.detectedAt).toISOString();
  const waiting = formatDuration(detectedAt);
  const lastMessage = anomaly.transcriptContext?.lastAssistantMessage;

  return (
    <section
      className={`decision-card decision-card--${tone}${compactClass}`}
      data-testid="decision-card"
      aria-label="What the agent needs"
    >
      <div className="decision-card-head">
        <i className="decision-card-mark" aria-hidden="true" />
        <span>{findingTypeLabel(agent)}</span>
        {waiting && <span className="decision-card-wait">waiting {waiting}</span>}
      </div>
      {notices && <div className="decision-card-notes">{notices.nodes}</div>}
      {anomaly.explanation && <p className="decision-card-ask">{anomaly.explanation}</p>}
      {lastMessage && (compact ? (
        <details className="detail-transcript-context decision-card-last" data-testid="detail-transcript-context">
          <summary className="detail-transcript-context-label">Last agent message</summary>
          <div className="detail-transcript-context-text">
            {lastMessage.excerpt}
            {lastMessage.truncated ? '...' : ''}
          </div>
        </details>
      ) : (
        <div className="detail-transcript-context" data-testid="detail-transcript-context">
          <div className="detail-transcript-context-label">Last agent message</div>
          <div className="detail-transcript-context-text">
            {lastMessage.excerpt}
            {lastMessage.truncated ? '...' : ''}
          </div>
        </div>
      ))}
      {actions}
      <div className="decision-card-acts">
        {triage}
        <span className="decision-card-hint">or reply below</span>
      </div>
    </section>
  );
}
