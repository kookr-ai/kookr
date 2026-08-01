import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';

/**
 * Compact stuckReason label (issue #1526 Phase B / FM9). During the
 * 2026-07-24 deadlock, tasks that had actually finished (awaiting the user's
 * ack) or gone silent for hours all showed as plain "running" on this exact
 * row — nothing distinguished them from a task genuinely doing work. This
 * badge surfaces the server's classification (`agent.stuckReason`) so a
 * healthy-looking row can say why it isn't.
 */
const STUCK_REASON_LABEL: Record<NonNullable<AgentState['stuckReason']>, { label: string; title: string }> = {
  awaiting_completion_ack: { label: 'Awaiting ack', title: 'Agent signaled completion — awaiting your review' },
  provider_paused: {
    label: 'Billing pause',
    title: 'Agent is stalled on a provider/CI billing or quota limit — not delivered, not hung (issue #1667)',
  },
  hung_suspect: { label: 'Hung?', title: 'Watchdog suspects this agent has gone silent — may be stuck' },
  waiting_on_input: { label: 'Needs input', title: 'Agent is waiting on a response' },
  permission_blocked: { label: 'Permission', title: 'Agent is blocked on a permission prompt' },
};

export function StuckReasonBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (!agent.stuckReason) return null;
  const { label, title } = STUCK_REASON_LABEL[agent.stuckReason];
  return (
    <span className={`stuck-reason-badge stuck-reason-badge--${agent.stuckReason}`} title={title}>
      {label}
    </span>
  );
}
