import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';

export function FindingTranscriptContext({ agent }: { agent: AgentState }): React.ReactElement | null {
  const message = agent.anomaly?.transcriptContext?.lastAssistantMessage;
  if (!message) return null;
  return (
    <div className="finding-transcript-context" data-testid="finding-transcript-context">
      <div className="finding-transcript-context-label">Last agent message</div>
      <div className="finding-transcript-context-text">
        {message.excerpt}{message.truncated ? '...' : ''}
      </div>
    </div>
  );
}
