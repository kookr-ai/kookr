import React, { useEffect, useState } from 'react';
import { type AgentType } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AgentTypeSelector, type AgentTypeSelectorValue } from '../AgentTypeSelector.js';
import { getMigratableTasks, migrateTasks } from '../../api/tasks.js';

/**
 * Control-room batch migration (RFC: rfc-cross-agent-task-migration) —
 * continue every interrupted task in scope under a different, user-chosen
 * agent in one confirmed action. Lives next to `AbortActiveButton`: same
 * "one dialog, one summary toast" shape, but a launch (POST /api/tasks/migrate
 * scope:'all') rather than a cancellation.
 */
export function MigrateInterruptedButton() {
  const { availableAgentTypes, handleAlert } = useKookrStore();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AgentTypeSelectorValue>('');
  const [fromAgent, setFromAgent] = useState<AgentType | ''>('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [onlyIsolated, setOnlyIsolated] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const openDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTarget(availableAgentTypes[0]?.type ?? '');
    setFromAgent('');
    setIncludeCancelled(false);
    setOnlyIsolated(false);
    setSetAsDefault(false);
    setOpen(true);
  };
  const closeDialog = () => setOpen(false);

  // Live candidate count: refetch whenever the target/source/scope filters change.
  useEffect(() => {
    if (!open || !target) {
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
  }, [open, target, fromAgent, includeCancelled, onlyIsolated]);

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
      setOpen(false);
    }
  }

  // Cross-agent migration needs at least two launchable agent types. This gate
  // MUST come after every hook above (Rules of Hooks): an early return placed
  // between useState and useEffect changes the hook count when
  // availableAgentTypes updates over the websocket (empty → populated), which
  // crashes the whole panel with React error #310. The useEffect is a safe
  // no-op while the dialog is closed, so always calling it costs nothing.
  if (availableAgentTypes.length < 2) return null;

  return (
    <>
      <button
        type="button"
        className="btn-migrate-interrupted"
        onClick={openDialog}
        aria-label="Migrate interrupted tasks to a different agent"
        title="Continue interrupted tasks under a different agent"
      >
        Migrate interrupted…
      </button>
      {open && (
        <ConfirmDialog
          title="Migrate interrupted tasks"
          message="Continue matching tasks under a different agent. Each migrated task keeps its source task as an immutable record and launches a linked continuation."
          confirmLabel={busy ? 'Migrating…' : 'Migrate'}
          confirmClass="btn-primary"
          onConfirm={confirmMigrate}
          onClose={closeDialog}
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
      )}
    </>
  );
}
