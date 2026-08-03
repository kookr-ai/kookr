import React from 'react';
import type { ScheduleResponse } from '../../shared/protocol.js';
import { usePersistedCollapsed } from '../hooks/usePersistedCollapsed.js';

interface Props {
  schedules: ScheduleResponse[];
}

export const SCHEDULE_SECTION_COLLAPSED_KEY = 'kookr:scheduleSectionCollapsed';

function formatRelativeTime(iso: string | null): string {
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
  const when = latest.triggeredAt ?? latest.evaluatedAt;
  const suffix = latest.message ? ` \u00B7 ${latest.message}` : '';
  return `${latestExecutionOutcomeLabel(latest.outcome)} ${formatRelativeTime(when)}${suffix}`;
}

function latestExecutionOutcomeLabel(outcome: NonNullable<ScheduleResponse['latestExecution']>['outcome']): string {
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

function statusClass(schedule: ScheduleResponse): string {
  switch (schedule.latestExecution?.outcome) {
    case 'completed':
      return 'schedule-status-ok';
    case 'cancelled':
    case 'dispatch_failed':
    case 'skipped_active':
    case 'skipped_capacity':
    case 'skipped_coalesced':
    case 'skipped_draining':
    case 'skipped_server_restarting':
    case 'skipped_safe_mode':
    case 'skipped_manual':
    case 'skipped_stale':
    case 'skipped_relaunch_locked':
    case 'skipped_provider_paused':
    case 'unknown_after_restart':
      return 'schedule-status-fail';
    default:
      return '';
  }
}

export function ScheduleSection({ schedules }: Props) {
  const [collapsed, toggle] = usePersistedCollapsed(SCHEDULE_SECTION_COLLAPSED_KEY, true);
  const hasSchedules = schedules.length > 0;

  return (
    <div
      className={`schedule-section${hasSchedules ? '' : ' schedule-section-reserved'}`}
      aria-hidden={hasSchedules ? undefined : true}
    >
      {hasSchedules && (
        <>
        <div className="section-header" onClick={toggle} aria-expanded={!collapsed}>
          <span className="section-chevron">{collapsed ? '\u25B8' : '\u25BE'}</span>
          <span className="schedule-label">Schedules ({schedules.length})</span>
        </div>
        {!collapsed && schedules.map((s) => (
          <div key={s.id} className={`schedule-row${s.enabled ? '' : ' schedule-disabled'}`}>
            <div className="schedule-row-top">
              <span className="schedule-name" title={s.name}>{s.name}</span>
              <span className="schedule-cron-desc">{s.cronDescription}</span>
            </div>
            <div className="schedule-row-bottom">
              <span className={`schedule-last-run ${statusClass(s)}`}>
                Last: {latestExecutionLabel(s)}
              </span>
              <span className="schedule-quota">
                {quotaLabel(s)}
              </span>
              <span className="schedule-next-run">
                Next: {nextRunLabel(s)}
              </span>
            </div>
          </div>
        ))}
        </>
      )}
    </div>
  );
}
