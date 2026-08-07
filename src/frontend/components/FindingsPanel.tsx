import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import {
  MIN_BOTTOM_SECTIONS_HEIGHT,
  clampBottomSectionsHeight,
  loadBottomSectionsHeight,
  saveBottomSectionsHeight,
  clearBottomSectionsHeight,
} from '../store/bottom-sections-height-prefs.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { track } from '../telemetry.js';
import { formatCompactDateTime } from '../presentation.js';
import { ReapWarningBanners } from './ReapWarningBanner.js';
import { ScheduleSection } from './ScheduleSection.js';
import type { SchedulePrefill } from './SchedulesDialog.js';
import { usePersistedCollapsed, useAutoExpandOnItemGain } from '../hooks/usePersistedCollapsed.js';
import { compareCompletedAgents } from '../agent-buckets.js';
import {
  HEALTHY_SECTION_COLLAPSED_KEY,
  PENDING_SECTION_COLLAPSED_KEY,
  SNOOZED_SECTION_COLLAPSED_KEY,
  COMPLETED_SECTION_COLLAPSED_KEY,
  isSelectedAgent,
  agentRowKey,
  buildFindingDisplayItems,
  groupHealthyAgents,
  maxBottomSectionsHeightFor,
  type QueueDeleteTaskHandler,
  type QueueClearCompletedHandler,
} from './FindingsPanel/shared.js';
import { FindingCard } from './FindingsPanel/FindingCard.js';
import { RootCauseFindingGroup } from './FindingsPanel/RootCauseFindingGroup.js';
import { FindingGroup } from './FindingsPanel/FindingGroup.js';
import { HealthyRow } from './FindingsPanel/HealthyRow.js';
import { PlaybookGroup } from './FindingsPanel/PlaybookGroup.js';
import { PendingRow } from './FindingsPanel/PendingRow.js';
import { SnoozedRow } from './FindingsPanel/SnoozedRow.js';
import { CompletedRow } from './FindingsPanel/CompletedRow.js';
import { ClearCompletedButton } from './FindingsPanel/ClearCompletedButton.js';
import { AbortActiveButton } from './FindingsPanel/AbortActiveButton.js';
import { SectionToggleButton } from './FindingsPanel/SectionToggleButton.js';
import { BottomSectionsResizer } from './FindingsPanel/BottomSectionsResizer.js';

// Re-export the section-collapsed storage keys so existing importers
// (App.tsx, the collapsed/keyboard tests) keep resolving them from this module.
export {
  HEALTHY_SECTION_COLLAPSED_KEY,
  PENDING_SECTION_COLLAPSED_KEY,
  SNOOZED_SECTION_COLLAPSED_KEY,
  COMPLETED_SECTION_COLLAPSED_KEY,
} from './FindingsPanel/shared.js';

const FINDINGS_SECTION_COLLAPSED_KEYS = [
  HEALTHY_SECTION_COLLAPSED_KEY,
  PENDING_SECTION_COLLAPSED_KEY,
  SNOOZED_SECTION_COLLAPSED_KEY,
  COMPLETED_SECTION_COLLAPSED_KEY,
] as const;

interface Props {
  findings: AgentState[];
  healthy: AgentState[];
  pending: AgentState[];
  completed: AgentState[];
  snoozed: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
  /**
   * Counts used by the "Clear completed" confirm dialog. They must match the
   * server-side clear scope: all projects from the all-projects view, or the
   * selected project from a project panel.
   */
  clearCompletedFinishedCount: number;
  clearCompletedTerminatedCount: number;
  clearCompletedFinishedTaskIds?: string[];
  clearCompletedTerminatedTaskIds?: string[];
  clearCompletedProjectId?: string;
  /**
   * Task IDs of the active (non-terminal) tasks in the current scope, used by
   * the control-room "Abort all" action (issue #1325). One batch request
   * interrupts every live session and cancels these tasks — no per-agent prose.
   */
  abortActiveTaskIds?: string[];
  pendingDeletionTaskIds?: ReadonlySet<string>;
  onQueueDeleteTask?: QueueDeleteTaskHandler;
  onQueueClearCompleted?: QueueClearCompletedHandler;
  /**
   * Open the Schedules dialog pre-seeded to schedule a playbook-backed task.
   * Optional so non-App call sites (tests) can omit it; when absent the
   * per-row schedule button is simply not wired.
   */
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}

function persistAllSectionsCollapsed(collapsed: boolean): void {
  try {
    for (const key of FINDINGS_SECTION_COLLAPSED_KEYS) {
      localStorage.setItem(key, collapsed ? '1' : '0');
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); preference is best-effort.
  }
}

export function FindingsPanel({
  findings,
  healthy,
  pending,
  completed,
  snoozed,
  selectedAgentId,
  selectedTaskId,
  send,
  clearCompletedFinishedCount,
  clearCompletedTerminatedCount,
  clearCompletedFinishedTaskIds = [],
  clearCompletedTerminatedTaskIds = [],
  clearCompletedProjectId,
  abortActiveTaskIds = [],
  pendingDeletionTaskIds = new Set<string>(),
  onQueueDeleteTask,
  onQueueClearCompleted,
  onSchedulePlaybook,
}: Props) {
  const { standalone, groups } = useMemo(() => groupHealthyAgents(healthy), [healthy]);
  const totalAgents = findings.length + healthy.length + pending.length + completed.length + snoozed.length;
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomSectionsRef = useRef<HTMLDivElement>(null);
  const prevFindingIds = useRef<Set<string>>(new Set());
  // User-set height of the bottom sections (Healthy/Pending/Snoozed/Completed).
  // `null` means "use the CSS default"; a number is an explicit, persisted px
  // height set via the drag handle.
  const [bottomSectionsHeight, setBottomSectionsHeight] = useState<number | null>(() => loadBottomSectionsHeight());
  const currentBottomHeight = useCallback(
    () => bottomSectionsHeight ?? bottomSectionsRef.current?.getBoundingClientRect().height ?? MIN_BOTTOM_SECTIONS_HEIGHT,
    [bottomSectionsHeight],
  );
  const commitBottomHeight = useCallback((height: number) => {
    setBottomSectionsHeight(height);
    saveBottomSectionsHeight(height);
  }, []);
  const resetBottomHeight = useCallback(() => {
    setBottomSectionsHeight(null);
    clearBottomSectionsHeight();
  }, []);
  // Re-clamp the explicit height to the live panel size on mount and whenever the
  // panel resizes (window shrink, detail pane opening, etc.). A height persisted
  // on a tall window must not survive onto a short one and collapse the findings
  // list — the interactive drag guards this, but the mount/apply path otherwise
  // would not. Mirrors the findings-panel width resizer's ResizeObserver.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const reclamp = () => {
      const liveMax = maxBottomSectionsHeightFor(panel);
      setBottomSectionsHeight((current) => {
        if (current == null) return current;
        const clamped = clampBottomSectionsHeight(current, liveMax);
        return clamped === current ? current : clamped;
      });
    };
    reclamp();
    const observer = new ResizeObserver(reclamp);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const [healthyCollapsed, toggleHealthy] = usePersistedCollapsed(HEALTHY_SECTION_COLLAPSED_KEY, false);
  const [pendingCollapsed, togglePending, expandPending] = usePersistedCollapsed(PENDING_SECTION_COLLAPSED_KEY, false);
  const [snoozedCollapsed, toggleSnoozed] = usePersistedCollapsed(SNOOZED_SECTION_COLLAPSED_KEY, true);
  const [completedCollapsed, toggleCompleted] = usePersistedCollapsed(COMPLETED_SECTION_COLLAPSED_KEY, true);
  // The Pending group is where "waiting on you" tasks live (taskStatus
  // 'pending' — e.g. an agent that signaled complete and needs the user's
  // input). When it gains items, auto-expand so the thing blocking the user
  // is never hidden inside a collapsed group; the user can still re-collapse
  // afterwards. needs_input findings render in the always-visible findings
  // list above, which is not collapsible, so this is the only group needing
  // the treatment. (F19)
  useAutoExpandOnItemGain(pending.length, expandPending);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const hasBottomSections = healthy.length > 0 || pending.length > 0 || snoozed.length > 0 || completed.length > 0;
  const renderedSectionCollapsedStates = [
    ...(healthy.length > 0 ? [healthyCollapsed] : []),
    ...(pending.length > 0 ? [pendingCollapsed] : []),
    ...(snoozed.length > 0 ? [snoozedCollapsed] : []),
    ...(completed.length > 0 ? [completedCollapsed] : []),
  ];
  const allRenderedSectionsCollapsed = renderedSectionCollapsedStates.length > 0
    && renderedSectionCollapsedStates.every(Boolean);

  // Single tick counter to refresh age badges across all cards (every 60s)
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to top when a genuinely new finding arrives (ID-set comparison)
  // Suppressed during initial load so the user sees oldest-first without jarring scroll
  useEffect(() => {
    const currentIds = new Set(findings.map(f => f.agentId));
    const hasNew = findings.some(f => !prevFindingIds.current.has(f.agentId));
    prevFindingIds.current = currentIds;

    if (hasNew && !isInitialLoad) {
      const timer = setTimeout(() => {
        scrollAreaRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [findings, isInitialLoad]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const timer = window.setTimeout(() => {
      scrollAreaRef.current
        ?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedAgentId]);

  const findingDisplayItems = useMemo(
    () => buildFindingDisplayItems(findings),
    [findings],
  );
  const sortedCompleted = useMemo(
    () => [...completed].sort(compareCompletedAgents),
    [completed],
  );
  const latestCompletedLabel = sortedCompleted[0]?.finishedAt
    ? formatCompactDateTime(sortedCompleted[0].finishedAt)
    : '';

  function handlePanelClick(e: React.MouseEvent) {
    if (isInitialLoad) setIsInitialLoad(false);
    // Only deselect if clicking directly on the panel background, not on a child card/row
    if (e.target === e.currentTarget && selectedAgentId) {
      track({ type: 'agent_deselected', method: 'panel_click' });
      useKookrStore.getState().selectAgent(null);
    }
  }

  function toggleAllSections() {
    const nextCollapsed = !allRenderedSectionsCollapsed;
    persistAllSectionsCollapsed(nextCollapsed);
    if (healthyCollapsed !== nextCollapsed) toggleHealthy();
    if (pendingCollapsed !== nextCollapsed) togglePending();
    if (snoozedCollapsed !== nextCollapsed) toggleSnoozed();
    if (completedCollapsed !== nextCollapsed) toggleCompleted();
  }

  return (
    <div ref={panelRef} className="findings-panel kookr-tour-target-findings kookr-tour-target-layout" onClick={handlePanelClick}>
      <div className="findings-header">
        <span className="findings-header-title">Supervisor Findings</span>
        <span className="findings-header-actions">
          <AbortActiveButton taskIds={abortActiveTaskIds} send={send} />
          <button
            type="button"
            className="findings-collapse-all-button"
            onClick={toggleAllSections}
            disabled={!hasBottomSections}
            aria-label={allRenderedSectionsCollapsed ? 'Expand all findings sections' : 'Collapse all findings sections'}
          >
            {allRenderedSectionsCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
          <span className={`findings-count${findings.length === 0 ? ' findings-count-empty' : ''}`}>
            {findings.length} active
          </span>
        </span>
      </div>
      <ReapWarningBanners agents={[...findings, ...healthy]} send={send} />
      <div className="findings-scroll-area" ref={scrollAreaRef}>
        {findings.length === 0 && totalAgents === 0 && (
          <div className="findings-empty">
            No agents running yet — launch one to begin.
          </div>
        )}
        {findingDisplayItems.map((item) => {
          if (item.kind === 'rootCauseGroup') {
            return (
              <RootCauseFindingGroup
                key={`root-cause-${agentRowKey(item.root)}`}
                root={item.root}
                related={item.related}
                selectedAgentId={selectedAgentId}
                selectedTaskId={selectedTaskId}
                send={send}
              />
            );
          }
          if (item.kind === 'duplicateGroup') {
            return (
              <FindingGroup
                key={`group-${item.key}`}
                type={item.type}
                agents={item.agents}
                selectedAgentId={selectedAgentId}
                selectedTaskId={selectedTaskId}
                send={send}
              />
            );
          }
          return (
            <FindingCard
              key={agentRowKey(item.agent)}
              agent={item.agent}
              selected={isSelectedAgent(item.agent, selectedAgentId, selectedTaskId)}
              send={send}
            />
          );
        })}
      </div>
      {hasBottomSections && (
        <BottomSectionsResizer
          panelRef={panelRef}
          getHeight={currentBottomHeight}
          onResize={setBottomSectionsHeight}
          onCommit={commitBottomHeight}
          onReset={resetBottomHeight}
        />
      )}
      <div
        ref={bottomSectionsRef}
        className={`bottom-sections${hasBottomSections ? '' : ' bottom-sections-reserved'}${hasBottomSections && bottomSectionsHeight != null ? ' bottom-sections-resized' : ''}`}
        aria-hidden={hasBottomSections ? undefined : true}
        // The explicit height applies only while there are sections to size; an
        // empty reserved placeholder stays at its thin default, not the last
        // dragged height.
        style={hasBottomSections && bottomSectionsHeight != null ? { height: `${bottomSectionsHeight}px`, maxHeight: 'none' } : undefined}
      >
        {hasBottomSections && (
          <>
          {healthy.length > 0 && (
            <div className="healthy-section">
              <SectionToggleButton
                collapsed={healthyCollapsed}
                label="Healthy"
                count={healthy.length}
                labelClassName="healthy-label"
                onToggle={toggleHealthy}
              />
              {!healthyCollapsed && (
                <>
                  {Array.from(groups.entries()).map(([playbookId, agents]) => (
                    <PlaybookGroup
                      key={playbookId}
                      playbookId={playbookId}
                      agents={agents}
                      selectedAgentId={selectedAgentId}
                      selectedTaskId={selectedTaskId}
                      send={send}
                      onSchedulePlaybook={onSchedulePlaybook}
                    />
                  ))}
                  {standalone.map((agent) => (
                    <HealthyRow
                      key={agentRowKey(agent)}
                      agent={agent}
                      selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
                      send={send}
                      onSchedulePlaybook={onSchedulePlaybook}
                    />
                  ))}
                </>
              )}
            </div>
          )}
          {pending.length > 0 && (
            <div className="pending-section">
              <SectionToggleButton
                collapsed={pendingCollapsed}
                label="Pending"
                count={pending.length}
                labelClassName="pending-label"
                onToggle={togglePending}
              />
              {!pendingCollapsed && pending.map((agent) => (
                <PendingRow
                  key={agentRowKey(agent)}
                  agent={agent}
                  selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
                  send={send}
                  onSchedulePlaybook={onSchedulePlaybook}
                />
              ))}
            </div>
          )}
          {snoozed.length > 0 && (
            <div className="snoozed-section">
              <SectionToggleButton
                collapsed={snoozedCollapsed}
                label="Snoozed"
                count={snoozed.length}
                labelClassName="snoozed-label"
                onToggle={toggleSnoozed}
              />
              {!snoozedCollapsed && snoozed.map((agent) => (
                <SnoozedRow
                  key={agentRowKey(agent)}
                  agent={agent}
                  selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
                  send={send}
                />
              ))}
            </div>
          )}
          {completed.length > 0 && (
            <div className="completed-section">
              <div className="completed-section-header-row">
                <SectionToggleButton
                  collapsed={completedCollapsed}
                  label="Completed"
                  count={completed.length}
                  labelClassName="completed-label"
                  onToggle={toggleCompleted}
                />
                <span className="completed-sort-hint">
                  Newest first{latestCompletedLabel ? ` · latest ${latestCompletedLabel}` : ''}
                </span>
                <ClearCompletedButton
                  finishedCount={clearCompletedFinishedCount}
                  terminatedCount={clearCompletedTerminatedCount}
                  finishedTaskIds={clearCompletedFinishedTaskIds}
                  terminatedTaskIds={clearCompletedTerminatedTaskIds}
                  projectId={clearCompletedProjectId}
                  onQueueClearCompleted={onQueueClearCompleted}
                />
              </div>
              {!completedCollapsed && sortedCompleted.map((agent) => (
                <CompletedRow
                  key={agentRowKey(agent)}
                  agent={agent}
                  selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
                  send={send}
                  pendingDeletion={Boolean(agent.taskId && pendingDeletionTaskIds.has(agent.taskId))}
                  onQueueDeleteTask={onQueueDeleteTask}
                  onSchedulePlaybook={onSchedulePlaybook}
                />
              ))}
            </div>
          )}
          </>
        )}
      </div>
      <ScheduleSection schedules={useKookrStore((s) => s.schedules)} />
    </div>
  );
}
