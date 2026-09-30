import React, { useEffect, useState } from 'react';
import type { AgentType } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AgentTypeSelector, type AgentTypeSelectorValue } from '../AgentTypeSelector.js';
import { getMigratableTasks, migrateTasks } from '../../api/tasks.js';
import { migrationReasonLabel } from '../migration-reason-labels.js';

/**
 * Live eligibility preview for the selected target. `blocked` is definitive (the
 * task can't migrate there — confirm is disabled); `loading`/`unknown`/`missing`
 * are non-definitive (a slow or failed probe, or the task absent from the
 * response) and leave confirm enabled so a transient hiccup never traps the
 * operator — the migrate POST is still the source of truth.
 */
type EligibilityPreview =
  | { status: 'loading' }
  | { status: 'eligible' }
  | { status: 'blocked'; reason: string }
  | { status: 'missing' }
  | { status: 'unknown' };

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
  const [preview, setPreview] = useState<EligibilityPreview | null>(null);

  // Same-agent continuation is Restore, not Migrate — exclude the task's own agent.
  const options = availableAgentTypes.filter((a) => a.type !== currentAgentType);

  // Preview this task's eligibility for the chosen target before the operator
  // confirms, so a single interrupted-task recovery no longer confirms blind and
  // only then learns the task was ineligible (issue #3380). Ids-scoped so it
  // matches exactly what the ids-scoped migrate POST would evaluate (cancelled
  // tasks opted in) rather than the default whole-store `all` classification.
  // This hook must run unconditionally (Rules of Hooks) — it is a no-op while the
  // dialog is closed — so it precedes the `options.length === 0` early return.
  useEffect(() => {
    if (!open || !target) {
      setPreview(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setPreview({ status: 'loading' });
    getMigratableTasks({ targetAgent: target as AgentType, taskIds: [taskId] }, controller.signal)
      .then((res) => {
        if (!active) return;
        if (res.ok && res.body && 'candidates' in res.body) {
          const found = res.body.candidates.find((c) => c.taskId === taskId);
          if (!found) setPreview({ status: 'missing' });
          else if (found.eligible) setPreview({ status: 'eligible' });
          else setPreview({ status: 'blocked', reason: found.reason });
        } else {
          setPreview({ status: 'unknown' });
        }
      })
      .catch(() => {
        if (active) setPreview({ status: 'unknown' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, target, taskId]);

  if (options.length === 0) return null;

  // Human label for the chosen target (matches the picker), so the preview line
  // reads "Migratable to Codex CLI" rather than the raw agent id.
  const targetLabel = target ? options.find((o) => o.type === target)?.label ?? String(target) : '';

  // Changing the target mid-dialog must not momentarily paint the previous
  // target's verdict: reset to a loading preview synchronously alongside the
  // target change (the effect re-confirms after its fetch).
  function changeTarget(next: AgentTypeSelectorValue) {
    setTarget(next);
    setPreview(next ? { status: 'loading' } : null);
  }

  function openDialog(e: React.MouseEvent) {
    e.stopPropagation();
    setTarget(options[0]?.type ?? '');
    setOpen(true);
  }

  async function confirm() {
    // Belt-and-suspenders: the confirm button is disabled while ineligible, but
    // guard the action too so a keyboard path can't fire a known-blocked migrate.
    if (!target || busy || preview?.status === 'blocked') return;
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
          confirmDisabled={preview?.status === 'blocked'}
          onConfirm={confirm}
          onClose={() => setOpen(false)}
        >
          <AgentTypeSelector value={target} onChange={changeTarget} options={options} label="Migrate to" />
          <div className="schedule-preview" aria-live="polite" data-testid="migrate-eligibility">
            {previewMessage(preview, targetLabel)}
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Operator-facing eligibility line shown under the target picker. */
function previewMessage(preview: EligibilityPreview | null, targetLabel: string): string {
  if (!targetLabel || !preview || preview.status === 'loading') return 'Checking eligibility…';
  switch (preview.status) {
    case 'eligible':
      return `Migratable to ${targetLabel}`;
    case 'blocked':
      return `Migrate blocked: ${migrationReasonLabel(preview.reason)}`;
    case 'missing':
    case 'unknown':
      return 'Could not check eligibility';
  }
}
