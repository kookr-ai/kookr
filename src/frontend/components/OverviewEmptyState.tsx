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
import { findingTypeLabel, findingWaitStartedAt, formatAge, projectLabel } from '../presentation.js';
import { ShortcutKeys } from './ShortcutKeys.js';

/** Rows shown in the "Waiting on you" list; the rest stay in the findings rail. */
const MAX_WAITING_ROWS = 6;

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
  /** Healthy running agents (rail `healthy` bucket length). */
  runningCount: number;
  /** Agents in a terminal task state (rail `completed` bucket length). */
  completedCount: number;
  onLaunch: () => void;
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
  runningCount,
  completedCount,
  onLaunch,
  onCheckSetup,
  shortcutBindings = getDefaultShortcutBindings(detectShortcutPlatform()),
}: Props) {
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const hasAnyTask = waiting.length > 0 || runningCount > 0 || completedCount > 0;

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

        <button className="btn-primary" onClick={onLaunch}>Launch New Task</button>

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
