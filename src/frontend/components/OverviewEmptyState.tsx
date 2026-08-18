import React from 'react';
import type { AgentState } from '../../shared/protocol.js';
import {
  commandPaletteHintKeys,
  detectShortcutPlatform,
  getDefaultShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { useKookrStore } from '../store/useStore.js';
import { open as openOnboardingTour } from '../store/onboarding-store.js';
import {
  PlaybookUsageTracker,
  resolveRecentPlaybookLabel,
  usageKeysOverlap,
} from '../store/playbook-usage.js';
import { compareCompletedAgents } from '../agent-buckets.js';
import { buildRuntimeMix, findingTypeLabel, findingWaitStartedAt, formatAge, formatDuration, formatRelativeTimeAgo, projectLabel } from '../presentation.js';
import { relaunchFromAgent } from '../relaunch-from-agent.js';
import { pickNextOverviewSchedule, scheduleNextRunLabel } from '../schedule-format.js';
import { track } from '../telemetry.js';
import { ShortcutKeys } from './ShortcutKeys.js';

/** Rows shown in the "Waiting on you" list; the rest stay in the findings rail. */
const MAX_WAITING_ROWS = 6;

/** Rows shown in the "Running" list; the rest stay in the healthy rail. */
export const OVERVIEW_RUNNING_LIMIT = 6;

/** Recent playbooks shown on the overview; the tracker itself keeps up to five. */
export const OVERVIEW_RECENT_PLAYBOOK_LIMIT = 3;

/** Pinned playbooks shown on the overview; Launch still lists the full pin set. */
export const OVERVIEW_PINNED_PLAYBOOK_LIMIT = 3;

/** Recently finished tasks shown on the overview; the rail keeps the rest. */
export const OVERVIEW_RECENT_COMPLETED_LIMIT = 3;

/** Published install + first-agent walkthrough (docs-only; no in-app copy). */
export const GETTING_STARTED_GUIDE_URL =
  'https://github.com/kookr-ai/kookr/blob/main/docs/getting-started.md';

interface Props {
  /**
   * Agents currently needing input — App's rail `findings` bucket
   * (buildAgentBuckets), already classified and priority-ordered. Passed
   * through rather than recomputed so the overview always matches the rail.
   */
  waiting: AgentState[];
  /**
   * Healthy running agents — App's rail `healthy` bucket
   * (buildAgentBuckets / isHealthyRunning). Passed through so the
   * overview count and the short running list share one source.
   */
  running: AgentState[];
  /**
   * Agents in a terminal task state — App's rail `completed` bucket
   * (buildAgentBuckets), already newest-first. Passed through so the
   * overview count and the short recent list share one source.
   */
  completed: AgentState[];
  onLaunch: () => void;
  /** Opens Launch on the Playbooks tab (pinned and recent chips). */
  onLaunchPlaybooks?: () => void;
  /** Opens the existing Schedules dialog (first-run CTA or next-scheduled row). */
  onOpenSchedules?: () => void;
  /**
   * Opens the Diagnostics / Operations panel (same surface as the command
   * palette). First-run empty state only — returning "All clear" hides it.
   */
  onCheckSetup?: () => void;
  shortcutBindings?: ShortcutBindingMap;
}

/**
 * Overview rendered in the detail area when no task is selected (issue F8).
 * Previously the detail panel was hidden entirely, leaving the right ~70% of
 * the viewport blank until the user clicked a task in the rail.
 */
export function OverviewEmptyState({
  waiting,
  running,
  completed,
  onLaunch,
  onLaunchPlaybooks,
  onOpenSchedules,
  onCheckSetup,
  shortcutBindings = getDefaultShortcutBindings(detectShortcutPlatform()),
}: Props) {
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const setRelaunchTask = useKookrStore((s) => s.setRelaunchTask);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const playbooks = useKookrStore((s) => s.playbooks);
  const schedules = useKookrStore((s) => s.schedules);
  const nextSchedule = pickNextOverviewSchedule(schedules);
  const nextRun = nextSchedule ? scheduleNextRunLabel(nextSchedule) : null;
  const runningCount = running.length;
  const completedCount = completed.length;
  const hasAnyTask = waiting.length > 0 || runningCount > 0 || completedCount > 0;
  // Composition across every live bucket, not just what needs input — answers
  // "what am I running?" at a glance (issue #2670).
  const runtimeMix = buildRuntimeMix([...waiting, ...running, ...completed]);
  const showCreateScheduleCta = !hasAnyTask && schedules.length === 0;
  const recentCompleted = [...completed]
    .sort(compareCompletedAgents)
    .slice(0, OVERVIEW_RECENT_COMPLETED_LIMIT);
  // Read localStorage on every render. Same-tab recordLaunch / togglePin
  // do not fire `storage`, and the overview stays mounted after a playbook
  // launch from this screen (new tasks do not auto-select), so a
  // playbooks-only memo would keep the pre-launch order.
  const usage = new PlaybookUsageTracker();
  const pinnedKeys = [...usage.getPinned()];
  const pinnedPlaybooks = pinnedKeys
    .slice(0, OVERVIEW_PINNED_PLAYBOOK_LIMIT)
    .map((key) => ({
      key,
      label: resolveRecentPlaybookLabel(key, playbooks),
    }));
  const recentPlaybooks = usage.getRecent()
    .filter((key) => !pinnedKeys.some((pinned) => usageKeysOverlap(key, pinned)))
    .slice(0, OVERVIEW_RECENT_PLAYBOOK_LIMIT)
    .map((key) => ({
      key,
      label: resolveRecentPlaybookLabel(key, playbooks),
    }));

  return (
    <div className="overview-empty" data-testid="overview-empty-state">
      <div className="overview-empty-inner">
        <div className="overview-counts">
          <div className="overview-count">
            <span className="overview-count-value">{runningCount}</span>
            <span className="overview-count-label">running</span>
          </div>
          <div className={`overview-count${waiting.length > 0 ? ' overview-count-attention' : ''}`}>
            <span className="overview-count-value">{waiting.length}</span>
            <span className="overview-count-label">needs input</span>
          </div>
          <div className="overview-count">
            <span className="overview-count-value">{completedCount}</span>
            <span className="overview-count-label">completed</span>
          </div>
        </div>

        {runtimeMix.length > 0 && (
          <p className="overview-runtime-mix" data-testid="overview-runtime-mix">
            {runtimeMix.map((entry, index) => (
              <React.Fragment key={entry.agentType}>
                {index > 0 && <span className="overview-runtime-mix-sep"> · </span>}
                <span className="overview-runtime-mix-entry">
                  {entry.label} {entry.count}
                </span>
              </React.Fragment>
            ))}
          </p>
        )}

        {waiting.length > 0 ? (
          <div className="overview-waiting">
            <h3 className="overview-waiting-title">Waiting on you</h3>
            <ul className="overview-waiting-list">
              {waiting.slice(0, MAX_WAITING_ROWS).map((agent) => {
                const age = formatAge(findingWaitStartedAt(agent));
                return (
                  <li key={agent.agentId}>
                    <button
                      type="button"
                      className="overview-waiting-row"
                      onClick={() => selectAgent(agent.agentId)}
                    >
                      <span className="overview-waiting-kind">{findingTypeLabel(agent)}</span>
                      <span className="overview-waiting-name">{agent.taskName ?? agent.agentId}</span>
                      <span className="overview-waiting-meta">
                        {agent.projectDisplayLabel ?? projectLabel(agent.cwd)}
                        {age && <> · waiting {age}</>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {waiting.length > MAX_WAITING_ROWS && (
              <p className="overview-waiting-more">
                +{waiting.length - MAX_WAITING_ROWS} more in the findings rail
              </p>
            )}
          </div>
        ) : (
          <p className={hasAnyTask ? 'findings-all-clear' : undefined}>
            {hasAnyTask ? 'All clear — agents working autonomously.' : 'No agents running.'}
          </p>
        )}

        {runningCount > 0 && (
          <div className="overview-running" data-testid="overview-running">
            <h3 className="overview-waiting-title">Running</h3>
            <ul className="overview-waiting-list">
              {running.slice(0, OVERVIEW_RUNNING_LIMIT).map((agent) => {
                const duration = formatDuration(agent.startedAt);
                return (
                  <li key={agent.agentId}>
                    <button
                      type="button"
                      className="overview-waiting-row"
                      onClick={() => selectAgent(agent.agentId, agent.taskId)}
                    >
                      <span className="overview-waiting-name">{agent.taskName ?? agent.agentId}</span>
                      <span className="overview-waiting-meta">
                        {agent.projectDisplayLabel ?? projectLabel(agent.cwd)}
                        {duration && <> · running {duration}</>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {runningCount > OVERVIEW_RUNNING_LIMIT && (
              <p className="overview-waiting-more">
                +{runningCount - OVERVIEW_RUNNING_LIMIT} more in Healthy
              </p>
            )}
          </div>
        )}

        {recentCompleted.length > 0 && (
          <div className="overview-completed" data-testid="overview-recent-completed">
            <h3 className="overview-waiting-title">Recently completed</h3>
            <ul className="overview-completed-list">
              {recentCompleted.map((agent) => {
                const name = agent.taskName ?? agent.agentId;
                const finishedAgo = formatRelativeTimeAgo(agent.finishedAt);
                const canRelaunch = Boolean(
                  agent.taskId || (agent.playbookId && agent.playbookParameterValues),
                );
                return (
                  <li key={agent.agentId} className="overview-completed-row">
                    <span className="overview-completed-name">{name}</span>
                    {finishedAgo && (
                      <span className="overview-completed-meta">{finishedAgo}</span>
                    )}
                    <span className="overview-completed-actions">
                      <button
                        type="button"
                        className="btn-xs"
                        data-testid="overview-completed-open"
                        aria-label={`Open ${name}`}
                        onClick={() => selectAgent(agent.agentId, agent.taskId)}
                      >
                        Open
                      </button>
                      {canRelaunch && (
                        <button
                          type="button"
                          className="btn-xs"
                          data-testid="overview-completed-relaunch"
                          aria-label={`Relaunch ${name}`}
                          onClick={() => {
                            track({ type: 'task_relaunched', agentId: agent.agentId });
                            void relaunchFromAgent(agent, setRelaunchTask);
                          }}
                        >
                          Relaunch
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {completed.length > OVERVIEW_RECENT_COMPLETED_LIMIT && (
              <p className="overview-waiting-more">
                +{completed.length - OVERVIEW_RECENT_COMPLETED_LIMIT} more in Completed
              </p>
            )}
          </div>
        )}

        <div className="overview-launch-actions">
          <button type="button" className="btn-primary" onClick={onLaunch}>Launch New Task</button>
          {showCreateScheduleCta && (
            <button
              type="button"
              className="btn-secondary"
              data-testid="overview-create-schedule"
              onClick={() => onOpenSchedules?.()}
            >
              Create a schedule
            </button>
          )}
        </div>

        {pinnedPlaybooks.length > 0 && (
          <div className="overview-recent-playbooks" data-testid="overview-pinned-playbooks">
            <h3 className="overview-waiting-title">Pinned playbooks</h3>
            <div className="overview-recent-playbooks-list">
              {pinnedPlaybooks.map((playbook) => (
                <button
                  type="button"
                  key={playbook.key}
                  className="btn-secondary overview-recent-playbook"
                  data-testid="overview-pinned-playbook"
                  data-playbook-key={playbook.key}
                  onClick={() => onLaunchPlaybooks?.()}
                >
                  {playbook.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {recentPlaybooks.length > 0 && (
          <div className="overview-recent-playbooks" data-testid="overview-recent-playbooks">
            <h3 className="overview-waiting-title">Recent playbooks</h3>
            <div className="overview-recent-playbooks-list">
              {recentPlaybooks.map((playbook) => (
                <button
                  type="button"
                  key={playbook.key}
                  className="btn-secondary overview-recent-playbook"
                  data-testid="overview-recent-playbook"
                  data-playbook-key={playbook.key}
                  onClick={() => onLaunchPlaybooks?.()}
                >
                  {playbook.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {nextSchedule && nextRun && (
          <div className="overview-next-schedule" data-testid="overview-next-schedule">
            <h3 className="overview-waiting-title">Next scheduled</h3>
            <button
              type="button"
              className="overview-waiting-row"
              data-testid="overview-next-schedule-row"
              aria-label={`Open schedules: ${nextSchedule.name}, ${nextRun}`}
              onClick={() => onOpenSchedules?.()}
            >
              <span className="overview-waiting-name">{nextSchedule.name}</span>
              <span className="overview-waiting-meta">{nextRun}</span>
            </button>
          </div>
        )}

        {!hasAnyTask && (
          <p className="overview-tour-reentry">
            New to Kookr?{' '}
            <button
              type="button"
              className="overview-tour-link"
              onClick={() => openOnboardingTour()}
            >
              Take the tour
            </button>
            {' · '}
            <a
              className="overview-tour-link"
              href={GETTING_STARTED_GUIDE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Getting Started
            </a>
            {' · '}
            <button
              type="button"
              className="overview-tour-link"
              onClick={() => onCheckSetup?.()}
            >
              Check setup
            </button>
            <span className="overview-setup-fallback">
              {' '}
              (<code>pnpm run doctor</code>)
            </span>
          </p>
        )}

        <p className="detail-empty-hint">
          {/* Palette chord is fixed in App.tsx keydown — not in SHORTCUT_ACTIONS. */}
          <ShortcutKeys keys={commandPaletteHintKeys(detectShortcutPlatform())} /> palette
          {' · '}
          <ShortcutKeys binding={shortcutBindings.quick_launch} /> quick launch
          {sttUrl !== '' && (
            <> · <ShortcutKeys binding={shortcutBindings.stt_toggle} /> voice</>
          )}
          {hasAnyTask && (
            <> · <ShortcutKeys binding={shortcutBindings.next_task} />/<ShortcutKeys binding={shortcutBindings.previous_task} /> cycle tasks</>
          )}
          {waiting.length > 0 && (
            <> · <ShortcutKeys binding={shortcutBindings.next_bottleneck} /> next finding</>
          )}
        </p>
      </div>
    </div>
  );
}
