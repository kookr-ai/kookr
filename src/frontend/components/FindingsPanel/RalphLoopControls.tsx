import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { sendRalphLoopCommand, type RalphLoopCommand } from '../../ralph-loop-api.js';
import { RalphLoopBadge } from './RalphLoopBadge.js';

export function RalphLoopControls({
  agent,
  showBadge = true,
}: {
  agent: AgentState;
  /** False where the caller already shows the iteration badge elsewhere. */
  showBadge?: boolean;
}): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  const taskId = agent.taskId;
  if (!taskId) return null;
  const { handleAlert } = useKookrStore.getState();

  const isActive = loop.status === 'running' || loop.status === 'paused';

  async function runCommand(command: RalphLoopCommand) {
    try {
      await sendRalphLoopCommand(taskId, command);
    } catch (err) {
      handleAlert('', err instanceof Error ? err.message : String(err), 'error');
    }
  }

  if (!isActive) return null;

  return (
    <span className="ralph-loop-controls" onClick={(e) => e.stopPropagation()}>
      {showBadge && <RalphLoopBadge agent={agent} />}
      {loop.status === 'running' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Pause Ralph loop"
          onClick={() => runCommand('pause')}
        >Pause</button>
      )}
      {loop.status === 'paused' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Resume Ralph loop"
          onClick={() => runCommand('resume')}
        >Resume</button>
      )}
      <button
        className="btn-xs ralph-btn"
        aria-label="Cancel Ralph loop"
        onClick={() => runCommand('cancel')}
      >Cancel</button>
    </span>
  );
}
