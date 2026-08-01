import React from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { PriorityIcon } from './icons.js';

export function TaskPriorityButton({ agent, send, variant = 'text' }: {
  agent: AgentState;
  send: (msg: ClientMessage) => void;
  /** `icon` renders a compact glyph for the healthy-row rail; `text` keeps the
   *  labeled button used in the roomier finding-card action row. */
  variant?: 'text' | 'icon';
}): React.ReactElement | null {
  if (!agent.taskId) return null;
  const high = agent.priority === 'high';
  const isIcon = variant === 'icon';
  return (
    <button
      className={`btn-xs task-priority-button${high ? ' active' : ''}${isIcon ? ' btn-icon' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'setTaskPriority', taskId: agent.taskId!, priority: high ? 'normal' : 'high' });
      }}
      title={high ? 'Mark task as normal priority' : 'Mark task as high priority'}
      aria-label={high ? `Mark ${agent.taskName ?? agent.agentId} normal priority` : `Mark ${agent.taskName ?? agent.agentId} high priority`}
    >
      {isIcon ? <PriorityIcon /> : (high ? 'Normal' : 'Priority')}
    </button>
  );
}
