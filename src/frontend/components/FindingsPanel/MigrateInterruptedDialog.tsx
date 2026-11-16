import React, { useEffect, useState } from 'react';
import { type AgentType } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AgentTypeSelector, type AgentTypeSelectorValue } from '../AgentTypeSelector.js';
import { getMigratableTasks, migrateTasks } from '../../api/tasks.js';

/**
 * Control-room batch migration (RFC: rfc-cross-agent-task-migration) —
 * continue every interrupted task in scope under a different, user-chosen
 * agent in one confirmed action. Opened from the rail's "More actions" menu
 * (`RailActionsMenu`, #3617), next to "Abort all": same "one dialog, one
 * summary toast" shape, but a launch (POST /api/tasks/migrate scope:'all')
 * rather than a cancellation. Mounted only while open, so every opening
 * starts from the defaults.
 */
export function MigrateInterruptedDialog({ onClose }: { onClose: () => void }) {
  const { availableAgentTypes, handleAlert } = useKookrStore();
  const [target, setTarget] = useState<AgentTypeSelectorValue>(() => availableAgentTypes[0]?.type ?? '');
  const [fromAgent, setFromAgent] = useState<AgentType | ''>('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [onlyIsolated, setOnlyIsolated] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Live candidate count: refetch whenever the target/source/scope filters change.
  useEffect(() => {
    if (!target) {
      setCount(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setCountLoading(true);
    getMigratableTasks(
      { targetAgent: target as AgentType, fromAgent: fromAgent || undefined, includeCancelled, onlyIsolated },
      controller.signal,
    )
      .then((res) => {
        if (!active) return;
        if (res.ok && res.body && 'candidates' in res.body) {
          setCount(res.body.candidates.filter((c) => c.eligible).length);
        } else {
          setCount(null);
        }
      })
      .catch(() => {
        if (active) setCount(null);
      })
      .finally(() => {
        if (active) setCountLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [target, fromAgent, includeCancelled, onlyIsolated]);

  async function confirmMigrate() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const res = await migrateTasks({
        targetAgent: target as AgentType,
        scope: { kind: 'all', ...(fromAgent ? { fromAgent } : {}), includeCancelled },
        setAsDefault,
        onlyIsolated,
      });
      const body = res.body;
      if (!res.ok || !('results' in body)) {
        const msg = 'error' in body ? body.error : `HTTP ${res.status}`;
        handleAlert('', `Migrate failed: ${msg}`, 'error');
        return;
      }
      const migrated = body.results.filter((r) => r.outcome === 'migrated').length;
      const queued = body.results.filter((r) => r.outcome === 'queued').length;
      const blocked = body.results.filter((r) => r.outcome === 'blocked').length;
      const parts = [`Migrated ${migrated}`, `queued ${queued}`, `blocked ${blocked}`];
      if (setAsDefault) {
        parts.push(
          body.defaultUpdated
            ? 'default agent updated'
            : `default not updated${body.defaultUpdateReason ? ` (${body.defaultUpdateReason})` : ''}`,
        );
      }
      const anySuccess = migrated > 0 || queued > 0;
      handleAlert('', parts.join(', '), anySuccess ? 'info' : 'error');
    } catch (err) {
      handleAlert('', `Migrate failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <ConfirmDialog
      title="Migrate interrupted tasks"
      message="Continue matching tasks under a different agent. Each migrated task keeps its source task as an immutable record and launches a linked continuation."
      confirmLabel={busy ? 'Migrating…' : 'Migrate'}
      confirmClass="btn-primary"
      onConfirm={confirmMigrate}
      onClose={onClose}
    >
      <AgentTypeSelector value={target} onChange={setTarget} options={availableAgentTypes} label="Migrate to" />
      <label className="schedule-form-field">
        <span>Only from</span>
        <select value={fromAgent} onChange={(e) => setFromAgent(e.target.value as AgentType | '')}>
          <option value="">Any agent</option>
          {availableAgentTypes.map((a) => (
            <option key={a.type} value={a.type}>{a.label}</option>
          ))}
        </select>
      </label>
      <label className="confirm-dialog-checkbox">
        <input
          type="checkbox"
          checked={includeCancelled}
          onChange={(e) => setIncludeCancelled(e.target.checked)}
        />
        Include cancelled tasks
      </label>
      <label className="confirm-dialog-checkbox">
        <input type="checkbox" checked={onlyIsolated} onChange={(e) => setOnlyIsolated(e.target.checked)} />
        Only isolated worktrees
      </label>
      <label className="confirm-dialog-checkbox">
        <input type="checkbox" checked={setAsDefault} onChange={(e) => setSetAsDefault(e.target.checked)} />
        Make this the default agent
      </label>
      <div className="schedule-preview" aria-live="polite">
        {!target
          ? ''
          : countLoading
            ? 'Checking migratable tasks…'
            : count === null
              ? 'Could not check migratable tasks'
              : `${count} task${count === 1 ? '' : 's'} migratable`}
      </div>
    </ConfirmDialog>
  );
}
