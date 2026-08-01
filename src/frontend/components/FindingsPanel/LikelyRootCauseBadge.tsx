import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';

export function LikelyRootCauseBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (!agent.anomaly?.likelyRootCause) return null;
  const relatedCount = agent.anomaly.relatedFindingIds?.length ?? 0;
  const relatedLabel = relatedCount === 1 ? '1 related finding' : `${relatedCount} related findings`;
  return (
    <span className="root-cause-badge" title={agent.anomaly.causalityReason ?? 'Likely root cause for related findings'}>
      Likely root cause - {relatedLabel}
    </span>
  );
}
