import React, { useEffect, useMemo, useState } from 'react';
import type { AgentSelection, Playbook, ScheduleResponse } from '../../shared/protocol.js';
import { buildAgentSelectionOptions } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { PlaybookSelector } from './PlaybookSelector.js';
import { PlaybookParameterForm } from './PlaybookParameterForm.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Props {
  onClose: () => void;
}

interface PreviewResponse {
  cronDescription: string;
  nextRuns: string[];
  timezone: string;
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
  return `${latest.outcome} ${formatRelativeTime(latest.triggeredAt ?? latest.evaluatedAt)}${message}`;
}

function renderExecutionLedger(schedule: ScheduleResponse) {
  const entries = (schedule.executionLedger ?? []).slice(-3).reverse();
  if (entries.length === 0) return null;

  return (
    <div className="schedule-ledger">
      {entries.map((entry) => (
        <div key={entry.id} className="schedule-ledger-entry">
          <span className="schedule-ledger-outcome">{entry.outcome}</span>
          <span>{formatRelativeTime(entry.completedAt ?? entry.triggeredAt ?? entry.evaluatedAt)}</span>
          {entry.scheduledFor && <span>due {formatRelativeTime(entry.scheduledFor)}</span>}
          {entry.blockingTaskId && <span className="schedule-task-ref">blocked by {entry.blockingTaskId.slice(0, 8)}</span>}
          {entry.catchUp && <span>catch-up</span>}
        </div>
      ))}
    </div>
  );
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

async function parseJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw body;
  }
  return body;
}

export function SchedulesDialog({ onClose }: Props) {
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
  const [showCreate, setShowCreate] = useState(schedules.length === 0);
  const [cwd, setCwd] = useState(serverCwd);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [maxTriggers, setMaxTriggers] = useState('');
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [playbooksLoading, setPlaybooksLoading] = useState(false);
  const [playbookId, setPlaybookId] = useState('');
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [agentType, setAgentType] = useState<AgentSelection>(() =>
    defaultAgentType ?? 'claude-code'
  );
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleResponse | null>(null);
  const selectedPlaybook = useMemo(
    () => playbooks.find((playbook) => playbook.id === playbookId) ?? null,
    [playbooks, playbookId],
  );

  useEffect(() => {
    fetch('/api/schedules')
      .then((res) => res.json())
      .then(handleSchedules)
      .catch(() => {});
  }, [handleSchedules]);

  useEffect(() => {
    if (!cwd.trim()) {
      setPlaybooks([]);
      setPlaybookId('');
      return;
    }
    const timeout = setTimeout(() => {
      setPlaybooksLoading(true);
      fetch(`/api/playbooks?cwd=${encodeURIComponent(cwd.trim())}`)
        .then((res) => res.json())
        .then((items: Playbook[]) => {
          // Schedules currently key playbook lookups off `<cwd>/.kookr/playbooks/`,
          // so non-project (user/plugin) playbooks can't be scheduled yet — hide
          // them from the picker until the schedule path supports scope.
          const projectOnly = items.filter((item) => item.scope === 'project');
          setPlaybooks(projectOnly);
          setPlaybookId((current) => (current && projectOnly.some((item) => item.id === current)) ? current : '');
        })
        .catch(() => {
          setPlaybooks([]);
          setPlaybookId('');
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
      fetch('/api/schedules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron }),
      })
        .then((res) => res.ok ? res.json() : null)
        .then((data: PreviewResponse | null) => setPreview(data))
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
      const created = await parseJson(await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || selectedPlaybook.name,
          cron: cron.trim(),
          ...(maxTriggers.trim() ? { maxTriggers: Number(maxTriggers) } : {}),
          cwd: cwd.trim(),
          enabled,
          agentType,
          playbook: {
            path: selectedPlaybook.id,
            parameters: parameterValues,
          },
        }),
      }));
      if (created) {
        setShowCreate(false);
        setName('');
        setMaxTriggers('');
        setFormError(null);
      }
    } catch (err) {
      const body = err as { error?: string; fieldErrors?: Record<string, string> };
      setFormError(body.error ?? 'Failed to create schedule');
      setFieldErrors(body.fieldErrors ?? {});
    }
  }

  async function toggleEnabled(schedule: ScheduleResponse) {
    try {
      setActionError(null);
      await parseJson(await fetch(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      }));
    } catch (err) {
      const body = err as { error?: string };
      setActionError(body.error ?? 'Failed to update schedule');
    }
  }

  async function runNow(schedule: ScheduleResponse) {
    try {
      setActionError(null);
      await parseJson(await fetch(`/api/schedules/${schedule.id}/run`, { method: 'POST' }));
    } catch (err) {
      const body = err as { error?: string };
      setActionError(body.error ?? 'Failed to run schedule');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      setActionError(null);
      await parseJson(await fetch(`/api/schedules/${id}`, { method: 'DELETE' }));
    } catch (err) {
      const body = err as { error?: string };
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
    if (!scheduleStatus.catchUpEnabled) {
      return <div className="settings-warning">Catch-up is disabled for this session.</div>;
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
                {renderExecutionLedger(schedule)}
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
