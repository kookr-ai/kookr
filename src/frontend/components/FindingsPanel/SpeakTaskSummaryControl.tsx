import React, { useEffect } from 'react';
import type { AgentState } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { track } from '../../telemetry.js';
import { useSpeakAgent, type SpeakStatus } from '../../hooks/useSpeakAgent.js';
import {
  formatSpeakFindingTimingLine,
  formatSpeakFindingTimingTitle,
} from '../../speech-presentation.js';

const SPEAK_FINDING_STOP_OTHERS_EVENT = 'kookr:speak-finding-stop-others';

function speakTaskSummaryLabel(status: SpeakStatus, agentLabel: string, errorReason?: string): string {
  switch (status) {
    case 'generating':
      return `Cancel task summary for ${agentLabel}`;
    case 'playing':
      return `Stop spoken task summary for ${agentLabel}`;
    case 'suppressed':
      return errorReason === 'audio-context-suspended'
        ? `Audio suppressed for ${agentLabel}; bring this tab to the foreground and press to reset`
        : `Audio suppressed for ${agentLabel} by sound or Do Not Disturb settings; press to reset`;
    case 'error':
      return `Speak task summary for ${agentLabel} failed (${errorReason ?? 'unknown'}); press to retry`;
    case 'idle':
      return `Speak task summary for ${agentLabel}`;
  }
}

export function SpeakTaskSummaryControl({ agent, selected }: { agent: AgentState; selected: boolean }): React.ReactElement | null {
  const ttsAvailable = useKookrStore((s) => Boolean(s.ttsUrl));
  const speakAgent = useSpeakAgent({
    agentId: agent.agentId,
    anomalyType: agent.anomaly?.type ?? null,
    ttsAvailable,
    endpoint: agent.taskId ? `/api/tasks/${encodeURIComponent(agent.taskId)}/speak-summary` : null,
  });
  const agentLabel = agent.taskName ?? agent.agentId;
  const { status } = speakAgent.state;

  useEffect(() => {
    if (!selected && (status === 'generating' || status === 'playing')) {
      speakAgent.stop();
    }
  }, [selected, status, speakAgent.stop]);

  useEffect(() => {
    function handleStopOthers(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId !== agent.agentId && (status === 'generating' || status === 'playing')) {
        speakAgent.stop();
      }
    }

    window.addEventListener(SPEAK_FINDING_STOP_OTHERS_EVENT, handleStopOthers);
    return () => window.removeEventListener(SPEAK_FINDING_STOP_OTHERS_EVENT, handleStopOthers);
  }, [agent.agentId, status, speakAgent.stop]);

  if ((!agent.taskId && !agent.anomaly) || !ttsAvailable) return null;

  const timingLine = formatSpeakFindingTimingLine(speakAgent.state.timings);
  const timingTitle = formatSpeakFindingTimingTitle(speakAgent.state.timings);
  const buttonLabel = speakTaskSummaryLabel(status, agentLabel, speakAgent.state.errorReason);
  const title = timingTitle ? `${buttonLabel}\n\n${timingTitle}` : buttonLabel;
  const inFlight = status === 'generating' || status === 'playing';
  const suppressed = status === 'suppressed';

  return (
    <span className="finding-speech-control" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`btn-speak-finding btn-speak-finding-card ${status}`}
        data-testid="speak-button"
        data-agent-id={agent.agentId}
        aria-label={buttonLabel}
        title={title}
        onClick={() => {
          useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
          track({ type: 'shortcut_used', key: 'click', action: 'speak_agent', context: 'task_card' });
          if (inFlight) {
            speakAgent.speak();
            return;
          }
          if (suppressed) {
            speakAgent.stop();
            return;
          }
          window.dispatchEvent(new CustomEvent(SPEAK_FINDING_STOP_OTHERS_EVENT, { detail: { agentId: agent.agentId } }));
          speakAgent.speak();
        }}
      >
        <span className="btn-speak-finding-icon" aria-hidden="true">
          {status === 'generating' && '⏳'}
          {status === 'playing' && '⏸'}
          {status === 'suppressed' && '🔇'}
          {status === 'error' && '⚠'}
          {status === 'idle' && '🔊'}
          {status === 'generating' && <span className="btn-speak-finding-ring" aria-hidden="true" />}
          {status === 'playing' && (
            <span className="btn-speak-finding-eq" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
        {inFlight && (
          <span className="btn-speak-finding-stop" aria-hidden="true">×</span>
        )}
      </button>
      {timingLine && (
        <span className="finding-speech-timing" title={timingTitle}>
          {timingLine}
        </span>
      )}
    </span>
  );
}
