import React, { useEffect, useMemo, useState } from 'react';
import type { AgentSelection, Playbook, ScheduleResponse } from '../../shared/protocol.js';
import { buildAgentSelectionOptions } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { PlaybookSelector } from './PlaybookSelector.js';
import { PlaybookParameterForm } from './PlaybookParameterForm.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  createSchedule,
  deleteSchedule,
  listPlaybooksForCwd,
  listSchedules,
  previewScheduleCron,
  runScheduleNow,
  setScheduleEnabled,
  type ScheduleApiErrorBody,
  type SchedulePreviewResponse,
} from '../schedule-api.js';

/**
 * Seed data for opening the dialog straight into a pre-filled create form,
 * e.g. from the task-panel "schedule this playbook" button. `playbookId` is the
 * playbook's relative path (=== `AgentState.playbookId`), which the picker
 * matches on once the project playbook list for `cwd` loads.
 */
export interface SchedulePrefill {
  cwd: string;
  playbookId: string;
  name?: string;
}

interface Props {
  onClose: () => void;
  /** When present, opens the create form pre-seeded from a task's playbook. */
  prefill?: SchedulePrefill;
  /**
   * Called after a schedule is successfully created. `fromPrefill` is true when
   * the create came from the seeded task-panel flow — the App uses this to show
   * the one-time "where your scheduled tasks live" hint only in that case (a
   * manual create from the command palette shouldn't trigger the discovery hint).
   */
  onCreated?: (fromPrefill: boolean) => void;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  const diff = new Date(iso).getTime() - Date.now();
  const absDiff = Math.abs(diff);
  const minutes = Math.floor(absDiff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  if (days > 0) label = `${days}d`;
  else if (hours > 0) label = `${hours}h`;
  else if (minutes > 0) label = `${minutes}m`;
  else label = '<1m';

  return diff < 0 ? `${label} ago` : `in ${label}`;
}

function latestExecutionLabel(schedule: ScheduleResponse): string {
  const latest = schedule.latestExecution;
  if (!latest) return 'never';
  const message = latest.message ? ` · ${latest.message}` : '';
  return `${outcomeLabel(latest.outcome)} ${formatRelativeTime(latest.triggeredAt ?? latest.evaluatedAt)}${message}`;
}

function nextRunLabel(schedule: ScheduleResponse): string {
  if (schedule.stopReason === 'trigger_limit_reached') return 'exhausted';
  if (!schedule.enabled) return 'paused';
  return formatRelativeTime(schedule.nextRunAt);
}

function quotaLabel(schedule: ScheduleResponse): string {
  if (schedule.maxTriggers === undefined) return 'Scheduled runs: unlimited';
  if (schedule.stopReason === 'trigger_limit_reached') return `Scheduled runs: exhausted (${schedule.maxTriggers}/${schedule.maxTriggers})`;
  return `Scheduled runs: ${schedule.remainingTriggers ?? schedule.maxTriggers} left of ${schedule.maxTriggers}`;
}

function ledgerDecisionLabel(entry: ScheduleResponse['executionLedger'][number]): string {
  switch (entry.decision) {
    case 'catch_up':
      return 'Catch-up';
    case 'manual_catch_up':
      return 'Missed run';
    case 'stale_catch_up':
      return 'Stale catch-up';
    case 'manual_run':
      return 'Manual';
    case 'cron_due':
      return 'Cron';
  }
}

function ledgerSummary(entry: ScheduleResponse['executionLedger'][number]): string {
  const subject = entry.scheduledFor
    ? `due ${formatRelativeTime(entry.scheduledFor)}`
    : `checked ${formatRelativeTime(entry.evaluatedAt)}`;
  const task = entry.taskId ? ` · task ${entry.taskId.slice(0, 8)}` : '';
  const blocker = entry.blockingTaskId ? ` · blocked by ${entry.blockingTaskId.slice(0, 8)}` : '';
  const reason = entry.reasonCode && entry.reasonCode !== 'none' ? ` · ${reasonLabel(entry.reasonCode)}` : '';
  return `${ledgerDecisionLabel(entry)} ${subject}: ${outcomeLabel(entry.outcome)}${reason}${task}${blocker}`;
}

function outcomeLabel(outcome: ScheduleResponse['executionLedger'][number]['outcome']): string {
  switch (outcome) {
    case 'queued':
    case 'queued_capacity':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'deduplicated':
      return 'deduplicated';
    case 'dispatch_failed':
      return 'dispatch failed';
    case 'skipped_active':
      return 'skipped: active run';
    case 'skipped_capacity':
      return 'skipped: capacity';
    case 'skipped_coalesced':
      return 'skipped: already queued';
    case 'skipped_draining':
      return 'skipped: draining';
    case 'skipped_manual':
      return 'manual run available';
    case 'skipped_stale':
      return 'skipped: stale';
    case 'unknown_after_restart':
      return 'unknown after restart';
  }
}

function reasonLabel(reason: NonNullable<ScheduleResponse['executionLedger'][number]['reasonCode']>): string {
  switch (reason) {
    case 'none':
      return 'none';
    case 'capacity':
      return 'capacity';
    case 'draining':
      return 'draining';
    case 'previous_run_active':
      return 'previous run active';
    case 'previous_run_pending':
      return 'previous run already queued';
    case 'manual_catch_up_required':
      return 'Run Now to recover';
    case 'missing_cwd':
      return 'missing working directory';
    case 'missing_playbook':
      return 'missing playbook';
    case 'validation':
      return 'validation';
    case 'deduplicated':
      return 'deduplicated';
    case 'launch_error':
      return 'launch error';
    case 'stale_catch_up':
      return 'stale catch-up';
    case 'reconciled_after_restart':
      return 'reconciled after restart';
    case 'unknown_after_restart':
      return 'unknown after restart';
  }
}

export function SchedulesDialog({ onClose, prefill, onCreated }: Props) {
  useEscapeToClose(onClose);
  const {
    schedules,
    scheduleStatus,
    serverCwd,
    availableAgentTypes,
    defaultAgentType,
    handleSchedules,
  } = useKookrStore();
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
  const [showCreate, setShowCreate] = useState(schedules.length === 0 || Boolean(prefill));
  const [cwd, setCwd] = useState(prefill?.cwd?.trim() || serverCwd);
  const [name, setName] = useState(prefill?.name ?? '');
  const [cron, setCron] = useState('0 9 * * *');
  const [maxTriggers, setMaxTriggers] = useState('');
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [playbooksLoading, setPlaybooksLoading] = useState(false);
  const [playbookId, setPlaybookId] = useState('');
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  // Playbook to pre-select once the project list for `cwd` loads. Cleared after
  // one attempt so manual edits aren't fought. Null once resolved or absent.
  const [pendingPlaybookId, setPendingPlaybookId] = useState<string | null>(prefill?.playbookId ?? null);
  // True after the pending playbook couldn't be matched in the project list
  // (non-project playbook, or a different source cwd) — drives an inline note.
  const [prefillUnmatched, setPrefillUnmatched] = useState(false);
  const [agentType, setAgentType] = useState<AgentSelection>(() =>
    defaultAgentType ?? 'claude-code'
  );
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<SchedulePreviewResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleResponse | null>(null);
  const selectedPlaybook = useMemo(
    () => playbooks.find((playbook) => playbook.id === playbookId) ?? null,
    [playbooks, playbookId],
  );

  useEffect(() => {
    listSchedules()
      .then(handleSchedules)
      .catch(() => {});
  }, [handleSchedules]);

  useEffect(() => {
    // Clear any stale "couldn't pre-select" note when the directory changes —
    // the prefill was evaluated against the previous cwd, not this one.
    setPrefillUnmatched(false);
    if (!cwd.trim()) {
      setPlaybooks([]);
      setPlaybookId('');
      return;
    }
    const timeout = setTimeout(() => {
      setPlaybooksLoading(true);
      listPlaybooksForCwd(cwd.trim())
        .then((items: Playbook[]) => {
          // Schedules now resolve from an explicit pinned scope (project | user
          // | plugin), so offer playbooks from all three tiers and persist the
          // selected scope on create. See rfc-schedule-playbook-resolution R8.
          setPlaybooks(items);
          // Resolve a one-shot prefill against the freshly-loaded list. Done here
          // (not in a separate effect) so we never evaluate against the initial
          // empty list before the fetch returns and falsely report "unmatched".
          setPendingPlaybookId((pending) => {
            if (!pending) {
              setPlaybookId((current) => (current && items.some((item) => item.id === current)) ? current : '');
              return null;
            }
            const matched = items.some((item) => item.id === pending);
            setPlaybookId(matched ? pending : '');
            setPrefillUnmatched(!matched);
            return null;
          });
        })
        .catch(() => {
          setPlaybooks([]);
          setPlaybookId('');
          setPendingPlaybookId((pending) => {
            if (pending) setPrefillUnmatched(true);
            return null;
          });
        })
        .finally(() => setPlaybooksLoading(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [cwd]);

  useEffect(() => {
    if (!selectedPlaybook) {
      setParameterValues({});
      return;
    }
    setParameterValues((prev) => {
      const next: Record<string, string> = {};
      for (const param of selectedPlaybook.parameters) {
        next[param.name] = prev[param.name] ?? param.default ?? '';
      }
      return next;
    });
    if (!name.trim()) {
      setName(selectedPlaybook.name);
    }
  }, [selectedPlaybook]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cron.trim()) {
      setPreview(null);
      return;
    }
    const timeout = setTimeout(() => {
      previewScheduleCron(cron)
        .then((data) => setPreview(data))
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timeout);
  }, [cron]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlaybook) {
      setFormError('Select a playbook');
      return;
    }

    try {
      setFormError(null);
      setFieldErrors({});
      const created = await createSchedule({
        name: name.trim() || selectedPlaybook.name,
        cron: cron.trim(),
        ...(maxTriggers.trim() ? { maxTriggers: Number(maxTriggers) } : {}),
        cwd: cwd.trim(),
        enabled,
        agentType,
        playbook: {
          path: selectedPlaybook.id,
          parameters: parameterValues,
          scope: selectedPlaybook.scope,
        },
      });
      if (created) {
        setShowCreate(false);
        setName('');
        setMaxTriggers('');
        setFormError(null);
        // Only the seeded (task-panel) flow surfaces the "where to find your
        // scheduled tasks" hint — a manual create from the command palette
        // shouldn't trigger the discovery nudge.
        onCreated?.(Boolean(prefill));
      }
    } catch (err) {
      const body = err as ScheduleApiErrorBody;
      setFormError(body.error ?? 'Failed to create schedule');
      setFieldErrors(body.fieldErrors ?? {});
    }
  }

  async function toggleEnabled(schedule: ScheduleResponse) {
    try {
      setActionError(null);
      await setScheduleEnabled(schedule.id, !schedule.enabled);
    } catch (err) {
      const body = err as ScheduleApiErrorBody;
      setActionError(body.error ?? 'Failed to update schedule');
    }
  }

  async function runNow(schedule: ScheduleResponse) {
    try {
      setActionError(null);
      await runScheduleNow(schedule.id);
    } catch (err) {
      const body = err as ScheduleApiErrorBody;
      setActionError(body.error ?? 'Failed to run schedule');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      setActionError(null);
      await deleteSchedule(id);
    } catch (err) {
      const body = err as ScheduleApiErrorBody;
      setActionError(body.error ?? 'Failed to delete schedule');
    }
  }

  function renderScheduleStatus() {
    if (!scheduleStatus) return null;
    if (scheduleStatus.loadError) {
      return <div className="settings-error">{scheduleStatus.loadError}</div>;
    }
    if (!scheduleStatus.schedulerHealthy) {
      return (
        <div className="settings-warning">
          Scheduler degraded.
          {scheduleStatus.lastError ? ` ${scheduleStatus.lastError}` : ''}
        </div>
      );
    }
    if (scheduleStatus.catchUpMode === 'off') {
      return <div className="settings-warning">Startup catch-up is disabled for this session.</div>;
    }
    if (scheduleStatus.catchUpMode === 'manual' || !scheduleStatus.catchUpEnabled) {
      return <div className="settings-warning">Automatic catch-up is off. Missed runs are recorded and can be started with Run Now.</div>;
    }
    return null;
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog schedules-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="schedules-dialog-header">
          <h3>Schedules</h3>
          <button type="button" className="btn-secondary" onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? 'Hide Form' : 'Create Schedule'}
          </button>
          <button className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {renderScheduleStatus()}
        {actionError && <div className="settings-error">{actionError}</div>}

        {showCreate && (
          <form className="schedule-create-form" onSubmit={handleCreate}>
            <div className="schedule-form-grid">
              <label className="schedule-form-field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly triage" />
                {fieldErrors.name && <span className="schedule-field-error">{fieldErrors.name}</span>}
              </label>

              <label className="schedule-form-field">
                <span>Working Directory</span>
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={serverCwd} />
                {fieldErrors.cwd && <span className="schedule-field-error">{fieldErrors.cwd}</span>}
              </label>

              <label className="schedule-form-field">
                <span>Cron</span>
                <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
                {fieldErrors.cron && <span className="schedule-field-error">{fieldErrors.cron}</span>}
              </label>

              <label className="schedule-form-field">
                <span>Stop after N scheduled runs (optional)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={maxTriggers}
                  onChange={(e) => setMaxTriggers(e.target.value)}
                  placeholder="Unlimited"
                />
                {fieldErrors.maxTriggers && <span className="schedule-field-error">{fieldErrors.maxTriggers}</span>}
              </label>

              <PlaybookSelector playbooks={playbooks} value={playbookId} onChange={setPlaybookId} />
            </div>

            {prefillUnmatched && !playbookId && !playbooksLoading && (
              <div className="schedule-preview schedule-prefill-note">
                Couldn&rsquo;t pre-select{prefill?.name ? <> <strong>{prefill.name}</strong></> : ' that playbook'} under <code>{cwd.trim() || serverCwd}</code>.
                Pick it from the list below.
              </div>
            )}

            {playbooksLoading && <div className="schedule-preview">Loading playbooks…</div>}
            {!playbooksLoading && playbooks.length === 0 && cwd.trim() && (
              <div className="schedule-preview">No playbooks found in <code>{cwd}</code>.</div>
            )}
            {fieldErrors.playbook && <div className="schedule-field-error">{fieldErrors.playbook}</div>}

            <PlaybookParameterForm
              playbook={selectedPlaybook}
              values={parameterValues}
              onChange={(paramName, value) => setParameterValues((prev) => ({ ...prev, [paramName]: value }))}
            />
            {fieldErrors.parameters && <div className="schedule-field-error">{fieldErrors.parameters}</div>}

            <AgentTypeSelector
              value={agentType}
              onChange={setAgentType}
              options={agentOptions}
            />

            <label className="schedule-enable-checkbox">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Start enabled
            </label>

            {preview && (
              <div className="schedule-preview">
                <div>{preview.cronDescription}</div>
                <div>Timezone: {preview.timezone}</div>
                <div>Next runs: {preview.nextRuns.map((item) => formatRelativeTime(item)).join(', ')}</div>
              </div>
            )}

            {formError && <div className="settings-error">{formError}</div>}

            <div className="dialog-actions">
              <button type="submit" className="btn-primary" disabled={!selectedPlaybook}>
                Save Schedule
              </button>
            </div>
          </form>
        )}

        <div className="schedule-list">
          {schedules.length === 0 && !showCreate && (
            <div className="schedule-empty">
              No schedules yet. Create one from an existing playbook.
            </div>
          )}
          {schedules.map((schedule) => (
            <div key={schedule.id} className={`schedule-manager-row${schedule.enabled ? '' : ' paused'}`}>
              <div className="schedule-manager-main">
                <div className="schedule-manager-title">{schedule.name}</div>
                <div className="schedule-manager-meta">
                  <span>{schedule.cronDescription}</span>
                  <span>Next: {nextRunLabel(schedule)}</span>
                  <span>{quotaLabel(schedule)}</span>
                  <span>Last: {latestExecutionLabel(schedule)}</span>
                  {schedule.latestExecution?.taskId && (
                    <span className="schedule-task-ref">Task {schedule.latestExecution.taskId.slice(0, 8)}</span>
                  )}
                </div>
                {schedule.executionLedger.length > 0 && (
                  <div className="schedule-ledger">
                    {schedule.executionLedger.slice(-3).reverse().map((entry) => (
                      <div key={entry.id} className="schedule-ledger-entry" title={entry.message}>
                        <span className="schedule-ledger-time">{formatRelativeTime(entry.completedAt ?? entry.evaluatedAt)}</span>
                        <span>{ledgerSummary(entry)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="schedule-manager-actions">
                <button
                  type="button"
                  className={`btn-secondary${!schedule.enabled && schedule.stopReason !== 'trigger_limit_reached' ? ' teal' : ''}`}
                  onClick={() => toggleEnabled(schedule)}
                  disabled={schedule.stopReason === 'trigger_limit_reached'}
                >
                  {schedule.stopReason === 'trigger_limit_reached' ? 'Exhausted' : (schedule.enabled ? 'Pause' : 'Resume')}
                </button>
                <button type="button" className="btn-secondary" onClick={() => runNow(schedule)}>
                  Run Now
                </button>
                <button type="button" className="btn-secondary danger" onClick={() => setPendingDelete(schedule)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        {pendingDelete && (
          <ConfirmDialog
            title="Delete Schedule"
            message={`Delete schedule "${pendingDelete.name}"?`}
            confirmLabel="Delete"
            confirmClass="btn-danger"
            onConfirm={confirmDelete}
            onClose={() => setPendingDelete(null)}
          />
        )}
      </div>
    </div>
  );
}
