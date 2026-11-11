import React, { useEffect, useRef, useState } from 'react';
import type { AgentType } from '../../../shared/protocol.js';
import type { TaskStatus } from '../../../shared/contracts/task-status.js';
import { useKookrStore } from '../../store/useStore.js';
import { deriveDetailHeaderActions, type DetailHeaderActionId } from './detail-header-actions.js';
import { MigrateTaskControl, migrationTargetOptions } from './MigrateTaskControl.js';

export interface DetailHeaderActionHandlers {
  complete: () => void;
  markDone: () => void;
  relaunch: () => void;
  reopen: () => void;
  reflect: () => void;
  cancel: () => void;
}

interface ActionSpec {
  label: string;
  testId: string;
  title?: string;
  className: string;
  danger?: boolean;
}

const SPECS: Record<Exclude<DetailHeaderActionId, 'migrate'>, ActionSpec> = {
  complete: { label: 'Complete', testId: 'action-complete', className: 'action-btn action-btn--success' },
  markDone: {
    label: 'Mark as done',
    testId: 'action-mark-done',
    title: 'Mark this unexpectedly terminated task as done',
    className: 'action-btn action-btn--success',
  },
  relaunch: { label: 'Relaunch', testId: 'action-relaunch', title: 'Start a new task from this prompt', className: 'action-btn action-btn--neutral' },
  reopen: {
    label: 'Reopen',
    testId: 'action-reopen',
    title: 'Resume this task where it left off (continues the prior conversation when recoverable)',
    className: 'action-btn action-btn--neutral',
  },
  reflect: { label: 'Reflect…', testId: 'action-reflect', title: 'Analyze this task without changing its status', className: 'action-btn action-btn--neutral' },
  cancel: { label: 'Cancel task…', testId: 'action-cancel', title: 'Stop the agent and cancel this task', className: 'action-btn action-btn--danger', danger: true },
};

/**
 * One main action plus a "More actions" menu for the reading-pane header
 * (issue #3561 slice 4b). The menu follows the rail's slice 2 menu: Escape and
 * an outside click close it, and focus returns to the trigger.
 */
export function DetailHeaderActions({
  taskId,
  taskStatus,
  agentType,
  signalCompleteReady,
  handlers,
}: {
  taskId?: string;
  taskStatus?: TaskStatus;
  agentType?: AgentType;
  signalCompleteReady: boolean;
  handlers: DetailHeaderActionHandlers;
}) {
  const availableAgentTypes = useKookrStore((state) => state.availableAgentTypes);
  const canMigrate = migrationTargetOptions(availableAgentTypes, agentType).length > 0;
  const { primary, menu } = deriveDetailHeaderActions({ taskId, taskStatus, canMigrate });
  const [menuOpen, setMenuOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  // A different task, or a status change that drops the menu, closes it.
  useEffect(() => { setMenuOpen(false); }, [taskId, taskStatus]);

  useEffect(() => {
    if (!menuOpen) return;
    firstItemRef.current?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpen]);

  if (!taskId || (primary === null && menu.length === 0)) return null;

  function choose(id: DetailHeaderActionId) {
    setMenuOpen(false);
    triggerRef.current?.focus();
    if (id === 'migrate') {
      setMigrateOpen(true);
      return;
    }
    // Let the menu close before Cancel's confirm() or Reflect's prompt() blocks.
    window.setTimeout(() => handlers[id](), 0);
  }

  return (
    <div className="detail-header-actions" ref={wrapRef}>
      {primary && primary !== 'migrate' && (
        <button
          type="button"
          data-testid={SPECS[primary].testId}
          className={`${SPECS[primary].className}${primary === 'complete' && signalCompleteReady ? ' action-btn--signal-ready' : ''}`}
          title={SPECS[primary].title}
          onClick={() => handlers[primary]()}
        >
          {SPECS[primary].label}
        </button>
      )}
      {menu.length > 0 && (
        <div className="detail-more-actions">
          <button
            ref={triggerRef}
            type="button"
            className="action-btn action-btn--neutral detail-more-actions-trigger"
            data-testid="detail-more-actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            title="More actions"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menuOpen && (
            <div className="detail-more-actions-popup" role="menu" aria-label="More actions">
              {menu.map((id, index) => {
                const spec = id === 'migrate'
                  ? { label: 'Migrate to…', testId: 'action-migrate', title: "Continue this task's work under a different agent", danger: false }
                  : SPECS[id];
                return (
                  <button
                    key={id}
                    ref={index === 0 ? firstItemRef : undefined}
                    type="button"
                    role="menuitem"
                    data-testid={spec.testId}
                    className={`detail-more-actions-item${spec.danger ? ' detail-more-actions-item--danger' : ''}`}
                    title={spec.title}
                    onClick={() => choose(id)}
                  >
                    {spec.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {menu.includes('migrate') && (
        <MigrateTaskControl
          taskId={taskId}
          currentAgentType={agentType}
          open={migrateOpen}
          onOpenChange={(open) => {
            setMigrateOpen(open);
            if (!open) triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
