import React, { useState } from 'react';
import type { AgentType } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AgentTypeSelector, type AgentTypeSelectorValue } from '../AgentTypeSelector.js';
import { migrateTasks } from '../../api/tasks.js';
import { migrationReasonLabel } from '../migration-reason-labels.js';

/**
 * Per-task "Migrate to…" action (RFC: rfc-cross-agent-task-migration). Shown for
 * a task whose work can be continued under a different agent — a terminated or
 * cancelled task (dead process). Actively-running (inProgress) tasks are
 * deliberately NOT offered this control by the DetailPanel, because a live
 * session cannot be migrated (the server would reject it) — stop the task first.
 *
 * Opens a small CENTERED confirmation dialog (not an inline reveal), consistent
 * with the batch "Migrate interrupted…" dialog, so the picker is a proper modal
 * rather than a cramped popover in the panel corner.
 */
export function MigrateTaskControl({
  taskId,
  currentAgentType,
}: {
  taskId: string;
  currentAgentType?: AgentType;
}) {
  const { availableAgentTypes, handleAlert } = useKookrStore();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AgentTypeSelectorValue>('');
  const [busy, setBusy] = useState(false);

  // Same-agent continuation is Restore, not Migrate — exclude the task's own agent.
  const options = availableAgentTypes.filter((a) => a.type !== currentAgentType);
  if (options.length === 0) return null;

  function openDialog(e: React.MouseEvent) {
    e.stopPropagation();
    setTarget(options[0]?.type ?? '');
    setOpen(true);
  }

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const res = await migrateTasks({
        targetAgent: target as AgentType,
        scope: { kind: 'ids', taskIds: [taskId] },
      });
      const body = res.body;
      if (!res.ok || !('results' in body)) {
        const msg = 'error' in body ? body.error : `HTTP ${res.status}`;
        handleAlert('', `Migrate failed: ${msg}`, 'error');
      } else {
        const result = body.results[0];
        if (!result || result.outcome === 'blocked') {
          handleAlert('', `Migrate blocked: ${migrationReasonLabel(result?.reason)}`, 'error');
        } else {
          const queuedNote = result.outcome === 'queued' ? ' (queued)' : '';
          handleAlert(
            '',
            `Migrated to ${target}${result.newTaskId ? ` — ${result.newTaskId}` : ''}${queuedNote}`,
            'info',
          );
        }
      }
    } catch (err) {
      handleAlert('', `Migrate failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="action-btn action-btn--neutral"
        title="Continue this task's work under a different agent"
        onClick={openDialog}
      >
        Migrate to…
      </button>
      {open && (
        <ConfirmDialog
          title="Migrate this task"
          message="Continue this task's work under a different agent. The original task is kept as an immutable record and a linked continuation is launched in the same checkout."
          confirmLabel={busy ? 'Migrating…' : 'Migrate'}
          confirmClass="btn-primary"
          onConfirm={confirm}
          onClose={() => setOpen(false)}
        >
          <AgentTypeSelector value={target} onChange={setTarget} options={options} label="Migrate to" />
        </ConfirmDialog>
      )}
    </>
  );
}
