import React, { useEffect, useId, useMemo, useState } from 'react';
import type { AgentSelection, AgentState, Playbook, ScheduleResponse, ScheduleRollup } from '../../shared/protocol.js';
import { buildAgentSelectionOptions } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { isTerminalTaskStatus } from '../agent-buckets.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { PlaybookSelector } from './PlaybookSelector.js';
import { PlaybookParameterForm } from './PlaybookParameterForm.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  createSchedule,
  deleteSchedule,
  listPlaybooksForCwd,
  listScheduleRollups,
  listSchedules,
  previewScheduleCron,
  runScheduleNow,
  setScheduleEnabled,
  type ScheduleApiErrorBody,
  type SchedulePreviewResponse,
} from '../schedule-api.js';
import {
  formatScheduleRelativeTime,
  formatScheduleRollupLine,
  scheduleNextRunLabel,
  scheduleRollupTooltip,
} from '../schedule-format.js';

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

/**
 * Cron preset chips shown under the Cron field so a user can create a common
 * schedule without knowing cron syntax. Clicking a chip sets the field to
 * `expression`; the live `cronDescription` preview confirms the choice.
 */
const CRON_PRESETS: ReadonlyArray<{ label: string; expression: string }> = [
  { label: 'Daily 9am', expression: '0 9 * * *' },
  { label: 'Hourly', expression: '0 * * * *' },
  { label: 'Weekdays 9am', expression: '0 9 * * 1-5' },
  { label: 'Weekly Mon', expression: '0 9 * * 1' },
];

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

function latestExecutionLabel(schedule: ScheduleResponse): string {
  const latest = schedule.latestExecution;
  if (!latest) return 'never';
  const message = latest.message ? ` · ${latest.message}` : '';
  return `${outcomeLabel(latest.outcome)} ${formatScheduleRelativeTime(latest.triggeredAt ?? latest.evaluatedAt)}${message}`;
}

function scheduleAgentLabel(schedule: ScheduleResponse): string {
  // `agentType` is an optional per-schedule pin; when omitted each fire uses the
  // live `settings.defaultAgentType`, so surface that as `default` on the row.
  let label: string = schedule.agentType ?? 'default';
  if (schedule.effort) label += ` · ${schedule.effort}`;
  if (schedule.model) label += ` · ${schedule.model}`;
  return label;
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
    ? `due ${formatScheduleRelativeTime(entry.scheduledFor)}`
    : `checked ${formatScheduleRelativeTime(entry.evaluatedAt)}`;
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
    case 'parked_dependency':
      return 'parked: dependency';
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
    case 'skipped_server_restarting':
      return 'skipped: server restarting';
    case 'skipped_safe_mode':
      return 'skipped: SAFE MODE';
    case 'skipped_manual':
      return 'manual run available';
    case 'skipped_stale':
      return 'skipped: stale';
    case 'skipped_relaunch_locked':
      return 'skipped: relaunch locked';
    case 'skipped_provider_paused':
      return 'skipped: provider paused';
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
    case 'dependency_degraded':
      return 'dependency degraded';
    case 'draining':
      return 'draining';
    case 'server_restarting':
      return 'server restarting';
    case 'safe_mode':
      return 'SAFE MODE';
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
    case 'pending_queue_full':
      return 'pending queue full';
    case 'stale_catch_up':
      return 'stale catch-up';
    case 'relaunch_lease_held':
      return 'relaunch lease held';
    case 'agent_substituted':
      return 'agent substituted';
    case 'provider_paused':
      return 'provider paused';
    case 'auth_expired':
      return 'Grok auth expired';
    case 'reconciled_after_restart':
      return 'reconciled after restart';
    case 'unknown_after_restart':
      return 'unknown after restart';
    case 'probe_quiet':
      return 'probe completed (no agent)';
    case 'probe_blip':
      return 'probe failed (no agent)';
  }
}

/**
 * The task a schedule's latest run produced (issue #2721). Clickable — a button
 * that opens the task — only while that task is still live in the current
 * snapshot: present AND non-terminal. Terminal tasks (completed / terminated /
 * cancelled) are retained in the snapshot as synthetic entries, so presence
 * alone is not enough — a terminal or absent task stays a non-actionable span
 * rather than gating navigation on a readiness signal.
 */
function ScheduleTaskRef({
  taskId,
  agents,
  onOpen,
}: {
  taskId: string;
  agents: AgentState[];
  onOpen: (agent: AgentState) => void;
}) {
  const label = `Task ${taskId.slice(0, 8)}`;
  const liveAgent = agents.find(
    (agent) => agent.taskId === taskId && !isTerminalTaskStatus(agent.taskStatus),
  );
  if (!liveAgent) {
    return <span className="schedule-task-ref">{label}</span>;
  }
  return (
    <button
      type="button"
      className="schedule-task-ref schedule-task-ref-link"
      title="Open this task"
      onClick={() => onOpen(liveAgent)}
    >
      {label}
    </button>
  );
}

export function SchedulesDialog({ onClose, prefill, onCreated }: Props) {
  useEscapeToClose(onClose);
  const {
    schedules,
    scheduleStatus,
    serverCwd,
    availableAgentTypes,
    defaultAgentType,
    roundRobinIndex,
    handleSchedules,
    agents,
    selectAgent,
  } = useKookrStore();
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
  const [showCreate, setShowCreate] = useState(schedules.length === 0 || Boolean(prefill));
  const [cwd, setCwd] = useState(prefill?.cwd?.trim() || serverCwd);
  const [name, setName] = useState(prefill?.name ?? '');
  const [cron, setCron] = useState('0 9 * * *');
  const cronFieldId = useId();
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
  // Empty string = no pin; fire uses settings.defaultAgentType.
  const [agentType, setAgentType] = useState<AgentSelection | ''>('');
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<SchedulePreviewResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleResponse | null>(null);
  const [rollupsById, setRollupsById] = useState<ReadonlyMap<string, ScheduleRollup>>(() => new Map());
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
    let cancelled = false;
    listScheduleRollups()
      .then((rollups) => {
        if (cancelled) return;
        setRollupsById(new Map(rollups.map((rollup) => [rollup.scheduleId, rollup])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        ...(agentType ? { agentType } : {}),
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

              {/*
                This field is a plain <div>, not a wrapping <label>, on purpose:
                the preset chips below are text-bearing interactive controls, and
                inside a <label> their text would be folded into the input's
                accessible name (and a <button> is an invalid labelable descendant
                of a <label>). An explicit htmlFor label keeps the name clean.
              */}
              <div className="schedule-form-field">
                <label htmlFor={cronFieldId}>Cron</label>
                <input id={cronFieldId} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
                <div className="schedule-cron-presets" role="group" aria-label="Cron presets">
                  {CRON_PRESETS.map((preset) => (
                    <button
                      key={preset.expression}
                      type="button"
                      className="schedule-cron-preset"
                      aria-pressed={cron.trim() === preset.expression}
                      onClick={() => setCron(preset.expression)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {fieldErrors.cron && <span className="schedule-field-error">{fieldErrors.cron}</span>}
              </div>

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
              defaultOptionLabel={
                defaultAgentType
                  ? `Server default (${defaultAgentType})`
                  : 'Server default'
              }
              roundRobinIndex={roundRobinIndex}
            />

            <label className="schedule-enable-checkbox">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Start enabled
            </label>

            {preview && (
              <div className="schedule-preview">
                <div>{preview.cronDescription}</div>
                <div>Timezone: {preview.timezone}</div>
                <div>Next runs: {preview.nextRuns.map((item) => formatScheduleRelativeTime(item)).join(', ')}</div>
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
          {schedules.map((schedule) => {
            const rollup = rollupsById.get(schedule.id);
            const rollupLine = rollup ? formatScheduleRollupLine(rollup) : null;
            return (
              <div key={schedule.id} className={`schedule-manager-row${schedule.enabled ? '' : ' paused'}`}>
                <div className="schedule-manager-main">
                  <div className="schedule-manager-title">{schedule.name}</div>
                  <div className="schedule-manager-meta">
                    <span className="schedule-manager-agent">{scheduleAgentLabel(schedule)}</span>
                    <span>{schedule.cronDescription}</span>
                    <span>Next: {scheduleNextRunLabel(schedule)}</span>
                    <span>{quotaLabel(schedule)}</span>
                    <span>Last: {latestExecutionLabel(schedule)}</span>
                    {schedule.latestExecution?.taskId && (
                      <ScheduleTaskRef
                        taskId={schedule.latestExecution.taskId}
                        agents={agents}
                        onOpen={(agent) => {
                          selectAgent(agent.agentId, agent.taskId);
                          onClose();
                        }}
                      />
                    )}
                  </div>
                  {rollup && rollupLine && (
                    <div
                      className="schedule-manager-meta schedule-manager-roi"
                      title={scheduleRollupTooltip(rollup)}
                      aria-description={scheduleRollupTooltip(rollup)}
                    >
                      {rollupLine}
                    </div>
                  )}
                  {schedule.executionLedger.length > 0 && (
                    <div className="schedule-ledger">
                      {schedule.executionLedger.slice(-3).reverse().map((entry) => (
                        <div key={entry.id} className="schedule-ledger-entry" title={entry.message}>
                          <span className="schedule-ledger-time">{formatScheduleRelativeTime(entry.completedAt ?? entry.evaluatedAt)}</span>
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
            );
          })}
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
