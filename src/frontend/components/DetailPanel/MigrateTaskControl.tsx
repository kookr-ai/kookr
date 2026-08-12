import React, { useState } from 'react';
import type { AgentType } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { AgentTypeSelector, type AgentTypeSelectorValue } from '../AgentTypeSelector.js';
import { migrateTasks } from '../../api/tasks.js';
import { migrationReasonLabel } from '../migration-reason-labels.js';

/**
 * Per-task "Migrate to…" action (RFC: rfc-cross-agent-task-migration). Shown
 * for a task whose work can plausibly be continued under a different agent —
 * terminated, cancelled, or an inProgress task whose session died (the server
 * is the authority on the live-session check; a click on an actually-running
 * task simply comes back `blocked: live_session_exists`). Picks a target agent
 * (excluding the task's own current agent — same-agent continuation is
 * Restore, not Migrate) and POSTs a single-task `scope: {kind:'ids'}` request.
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

  const options = availableAgentTypes.filter((a) => a.type !== currentAgentType);
  if (options.length === 0) return null;

  function openPicker(e: React.MouseEvent) {
    e.stopPropagation();
    setTarget(options[0]?.type ?? '');
    setOpen(true);
  }

  function cancel(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(false);
  }

  async function confirm(e: React.MouseEvent) {
    e.stopPropagation();
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
          handleAlert('', `Migrated to ${target}${result.newTaskId ? ` — ${result.newTaskId}` : ''}${queuedNote}`, 'info');
        }
      }
    } catch (err) {
      handleAlert('', `Migrate failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="action-btn action-btn--neutral"
        title="Continue this task's work under a different agent"
        onClick={openPicker}
      >
        Migrate to…
      </button>
    );
  }

  return (
    <span className="detail-migrate-control" onClick={(e) => e.stopPropagation()}>
      <AgentTypeSelector value={target} onChange={setTarget} options={options} label="Migrate to" compact />
      <button type="button" className="action-btn action-btn--success" disabled={busy || !target} onClick={confirm}>
        {busy ? 'Migrating…' : 'Go'}
      </button>
      <button type="button" className="action-btn action-btn--neutral" disabled={busy} onClick={cancel}>
        Cancel
      </button>
    </span>
  );
}
