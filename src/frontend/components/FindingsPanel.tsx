import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import {
  MIN_BOTTOM_SECTIONS_HEIGHT,
  MAX_BOTTOM_SECTIONS_HEIGHT,
  clampBottomSectionsHeight,
  loadBottomSectionsHeight,
  saveBottomSectionsHeight,
  clearBottomSectionsHeight,
} from '../store/bottom-sections-height-prefs.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { track, trackClick } from '../telemetry.js';
import {
  agentProviderPresentation,
  formatDuration,
  formatAge,
  ageColor,
  findingWaitStartedAt,
  healthyDotClass,
  healthyStatusLabel,
  formatTokenUsage,
  projectLabel,
  projectColor,
  worktreeHealthLabel,
  worktreeHealthTitle,
  turnStateLabel,
  turnStateClass,
  formatCompactDateTime,
  formatRelativeTimeAgo,
  findingTypeLabel,
} from '../presentation.js';
import {
  formatSpeakFindingTimingLine,
  formatSpeakFindingTimingTitle,
} from '../speech-presentation.js';
import { Tooltip } from './Tooltip.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { SupervisorFeedbackDialog } from './SupervisorFeedbackDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { groupFindings, groupIdenticalPendingPrompts, groupLabel } from '../group-findings.js';
import { ScheduleSection } from './ScheduleSection.js';
import type { SchedulePrefill } from './SchedulesDialog.js';
import { useDnd } from '../hooks/useDnd.js';
import { usePersistedCollapsed, useAutoExpandOnItemGain } from '../hooks/usePersistedCollapsed.js';
import { useSpeakAgent, type SpeakStatus } from '../hooks/useSpeakAgent.js';
import { TaskIdCopyButton } from './TaskIdCopyButton.js';
import { sendRalphLoopCommand, type RalphLoopCommand } from '../ralph-loop-api.js';
import { CoordinatorTaskChipView, coordinatorChipForTask } from './CoordinatorSurfaces.js';
import { ChildRollupPill } from './RelatedTasksSection.js';
import { compareCompletedAgents } from '../agent-buckets.js';
import { formatDiagnosticIdentifier } from './diagnostics-format.js';

export const HEALTHY_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.healthy';
export const PENDING_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.pending';
export const SNOOZED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.snoozed';
export const COMPLETED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.completed';

const SPEAK_FINDING_STOP_OTHERS_EVENT = 'kookr:speak-finding-stop-others';
const FINDING_GROUP_RENDER_LIMIT = 25;
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
  onQueueDeleteTask?: (args: { taskId: string; label: string }) => void;
  onQueueClearCompleted?: (args: {
    includeTerminated: boolean;
    projectId?: string;
    taskIds: string[];
    count: number;
  }) => void;
  /**
   * Open the Schedules dialog pre-seeded to schedule a playbook-backed task.
   * Optional so non-App call sites (tests) can omit it; when absent the
   * per-row schedule button is simply not wired.
   */
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}

function isSelectedAgent(agent: AgentState, selectedAgentId: string | null, selectedTaskId: string | null): boolean {
  if (agent.agentId !== selectedAgentId) return false;
  return selectedTaskId ? agent.taskId === selectedTaskId : true;
}

function agentRowKey(agent: AgentState): string {
  return `${agent.agentId}:${agent.taskId ?? ''}`;
}

/** Clock icon for the per-row "schedule this playbook" button. */
function ScheduleIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

// Compact glyph icons for the healthy-row action rail. Keeping the healthy
// controls icon-only lets the row collapse to two lines (title + info) without
// the action labels forcing a wrap — the labels live in each button's
// aria-label / title so they stay discoverable and accessible.
function ReplyIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function SnoozeIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MissedIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function PriorityIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

/**
 * Small icon button shown on playbook-backed task rows. Clicking it opens the
 * Schedules dialog pre-seeded with this task's playbook + working directory, so
 * the user only has to choose a cron. Renders nothing for tasks not launched
 * from a playbook, and nothing when no scheduler callback is wired.
 */
function SchedulePlaybookButton({ agent, onSchedule }: {
  agent: AgentState;
  onSchedule?: (prefill: SchedulePrefill) => void;
}): React.ReactElement | null {
  if (!onSchedule || !agent.playbookId) return null;
  const playbookId = agent.playbookId;
  return (
    <button
      type="button"
      className="btn-xs schedule-playbook-btn"
      title="Schedule this playbook"
      aria-label="Schedule this playbook"
      onClick={(e) => {
        e.stopPropagation();
        trackClick('schedule_playbook');
        onSchedule({
          cwd: agent.cwd ?? '',
          playbookId,
          name: agent.taskName ?? playbookId,
        });
      }}
    >
      <ScheduleIcon />
    </button>
  );
}

function agentProjectLabel(agent: AgentState): string {
  return agent.projectDisplayLabel ?? projectLabel(agent.cwd);
}

function agentProjectColor(agent: AgentState): number {
  return projectColor(agent.projectId ?? agent.cwd);
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

// ─── Ralph loop helpers ──────────────────────────────────────────────────────

function RalphLoopBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  return (
    <span
      className="ralph-loop-badge"
      title={`Ralph loop: iteration ${loop.currentIteration}/${loop.iterationCap} (${loop.status})`}
    >
      {loop.currentIteration}/{loop.iterationCap}
    </span>
  );
}

function RalphLoopControls({ agent }: { agent: AgentState }): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  const taskId = agent.taskId;
  if (!taskId) return null;
  const { handleAlert } = useKookrStore.getState();

  const isActive = loop.status === 'running' || loop.status === 'paused';

  async function runCommand(command: RalphLoopCommand) {
    try {
      await sendRalphLoopCommand(taskId, command);
    } catch (err) {
      handleAlert('', err instanceof Error ? err.message : String(err), 'error');
    }
  }

  if (!isActive) return null;

  return (
    <span className="ralph-loop-controls" onClick={(e) => e.stopPropagation()}>
      <RalphLoopBadge agent={agent} />
      {loop.status === 'running' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Pause Ralph loop"
          onClick={() => runCommand('pause')}
        >Pause</button>
      )}
      {loop.status === 'paused' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Resume Ralph loop"
          onClick={() => runCommand('resume')}
        >Resume</button>
      )}
      <button
        className="btn-xs ralph-btn"
        aria-label="Cancel Ralph loop"
        onClick={() => runCommand('cancel')}
      >Cancel</button>
    </span>
  );
}

// ─── End Ralph loop helpers ───────────────────────────────────────────────────

function severityClass(agent: AgentState): string {
  if (!agent.anomaly) return '';
  switch (agent.anomaly.type) {
    case 'permission_blocked': return 'permission';
    case 'repeated_error': return 'error';
    // A normal completed turn is a review-ready signal, not a hung turn — tone it down vs an explicit
    // mid-turn AskUserQuestion, which still reads as `input`. See issue #358.
    case 'needs_input': return agent.turnState === 'completed_turn' ? 'turn-complete' : 'input';
  }
}

function severityLabel(agent: AgentState): string {
  return findingTypeLabel(agent);
}

function EditableName({ agent, send, onBeforeEdit }: {
  agent: AgentState;
  send: (msg: ClientMessage) => void;
  onBeforeEdit?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing(e: React.MouseEvent) {
    e.stopPropagation();
    onBeforeEdit?.();
    setDraft(agent.taskName ?? agent.agentId);
    setEditing(true);
  }

  function commit() {
    if (agent.taskId && draft.trim()) {
      send({ type: 'renameTask', taskId: agent.taskId, name: draft.trim() });
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="finding-task-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div className="finding-task" onDoubleClick={agent.taskId ? startEditing : undefined}>
      {agent.taskName ?? agent.agentId}
    </div>
  );
}

function AgentProviderMark({
  agent,
  state,
}: {
  agent: AgentState;
  state: 'running' | 'done' | 'pending' | 'snoozed' | 'completed' | 'cancelled' | 'terminated' | 'finding';
}): React.ReactElement {
  if (!agent.agentType) {
    return <span className={`agent-provider-mark agent-provider-mark--fallback agent-provider-mark--${state}`} aria-hidden="true" />;
  }

  const provider = agentProviderPresentation(agent.agentType);
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`agent-provider-mark agent-provider-mark--${agent.agentType} agent-provider-mark--${state}`}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg className="agent-provider-mark-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
    </span>
  );
}

function PriorityBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (agent.priority !== 'high') return null;
  return (
    <span className="task-priority-badge" title="High priority">
      High
    </span>
  );
}

/**
 * Compact stuckReason label (issue #1526 Phase B / FM9). During the
 * 2026-07-24 deadlock, tasks that had actually finished (awaiting the user's
 * ack) or gone silent for hours all showed as plain "running" on this exact
 * row — nothing distinguished them from a task genuinely doing work. This
 * badge surfaces the server's classification (`agent.stuckReason`) so a
 * healthy-looking row can say why it isn't.
 */
const STUCK_REASON_LABEL: Record<NonNullable<AgentState['stuckReason']>, { label: string; title: string }> = {
  awaiting_completion_ack: { label: 'Awaiting ack', title: 'Agent signaled completion — awaiting your review' },
  provider_paused: {
    label: 'Billing pause',
    title: 'Agent is stalled on a provider/CI billing or quota limit — not delivered, not hung (issue #1667)',
  },
  hung_suspect: { label: 'Hung?', title: 'Watchdog suspects this agent has gone silent — may be stuck' },
  waiting_on_input: { label: 'Needs input', title: 'Agent is waiting on a response' },
  permission_blocked: { label: 'Permission', title: 'Agent is blocked on a permission prompt' },
};

function StuckReasonBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (!agent.stuckReason) return null;
  const { label, title } = STUCK_REASON_LABEL[agent.stuckReason];
  return (
    <span className={`stuck-reason-badge stuck-reason-badge--${agent.stuckReason}`} title={title}>
      {label}
    </span>
  );
}

function TaskPriorityButton({ agent, send, variant = 'text' }: {
  agent: AgentState;
  send: (msg: ClientMessage) => void;
  /** `icon` renders a compact glyph for the healthy-row rail; `text` keeps the
   *  labeled button used in the roomier finding-card action row. */
  variant?: 'text' | 'icon';
}): React.ReactElement | null {
  if (!agent.taskId) return null;
  const high = agent.priority === 'high';
  const isIcon = variant === 'icon';
  return (
    <button
      className={`btn-xs task-priority-button${high ? ' active' : ''}${isIcon ? ' btn-icon' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'setTaskPriority', taskId: agent.taskId!, priority: high ? 'normal' : 'high' });
      }}
      title={high ? 'Mark task as normal priority' : 'Mark task as high priority'}
      aria-label={high ? `Mark ${agent.taskName ?? agent.agentId} normal priority` : `Mark ${agent.taskName ?? agent.agentId} high priority`}
    >
      {isIcon ? <PriorityIcon /> : (high ? 'Normal' : 'Priority')}
    </button>
  );
}

function speakTaskSummaryLabel(status: SpeakStatus, agentLabel: string, errorReason?: string): string {
  switch (status) {
    case 'generating':
      return `Cancel task summary for ${agentLabel}`;
    case 'playing':
      return `Stop spoken task summary for ${agentLabel}`;
    case 'suppressed':
      return errorReason === 'audio-context-suspended'
        ? `Audio suppressed for ${agentLabel}; bring this tab to the foreground and press to reset`
        : `Audio suppressed for ${agentLabel} by sound or Do Not Disturb settings; press to reset`;
    case 'error':
      return `Speak task summary for ${agentLabel} failed (${errorReason ?? 'unknown'}); press to retry`;
    case 'idle':
      return `Speak task summary for ${agentLabel}`;
  }
}

function SpeakTaskSummaryControl({ agent, selected }: { agent: AgentState; selected: boolean }): React.ReactElement | null {
  const ttsAvailable = useKookrStore((s) => Boolean(s.ttsUrl));
  const speakAgent = useSpeakAgent({
    agentId: agent.agentId,
    anomalyType: agent.anomaly?.type ?? null,
    ttsAvailable,
    endpoint: agent.taskId ? `/api/tasks/${encodeURIComponent(agent.taskId)}/speak-summary` : null,
  });
  const agentLabel = agent.taskName ?? agent.agentId;
  const { status } = speakAgent.state;

  useEffect(() => {
    if (!selected && (status === 'generating' || status === 'playing')) {
      speakAgent.stop();
    }
  }, [selected, status, speakAgent.stop]);

  useEffect(() => {
    function handleStopOthers(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId !== agent.agentId && (status === 'generating' || status === 'playing')) {
        speakAgent.stop();
      }
    }

    window.addEventListener(SPEAK_FINDING_STOP_OTHERS_EVENT, handleStopOthers);
    return () => window.removeEventListener(SPEAK_FINDING_STOP_OTHERS_EVENT, handleStopOthers);
  }, [agent.agentId, status, speakAgent.stop]);

  if ((!agent.taskId && !agent.anomaly) || !ttsAvailable) return null;

  const timingLine = formatSpeakFindingTimingLine(speakAgent.state.timings);
  const timingTitle = formatSpeakFindingTimingTitle(speakAgent.state.timings);
  const buttonLabel = speakTaskSummaryLabel(status, agentLabel, speakAgent.state.errorReason);
  const title = timingTitle ? `${buttonLabel}\n\n${timingTitle}` : buttonLabel;
  const inFlight = status === 'generating' || status === 'playing';
  const suppressed = status === 'suppressed';

  return (
    <span className="finding-speech-control" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`btn-speak-finding btn-speak-finding-card ${status}`}
        data-testid="speak-button"
        data-agent-id={agent.agentId}
        aria-label={buttonLabel}
        title={title}
        onClick={() => {
          useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
          track({ type: 'shortcut_used', key: 'click', action: 'speak_agent', context: 'task_card' });
          if (inFlight) {
            speakAgent.speak();
            return;
          }
          if (suppressed) {
            speakAgent.stop();
            return;
          }
          window.dispatchEvent(new CustomEvent(SPEAK_FINDING_STOP_OTHERS_EVENT, { detail: { agentId: agent.agentId } }));
          speakAgent.speak();
        }}
      >
        <span className="btn-speak-finding-icon" aria-hidden="true">
          {status === 'generating' && '⏳'}
          {status === 'playing' && '⏸'}
          {status === 'suppressed' && '🔇'}
          {status === 'error' && '⚠'}
          {status === 'idle' && '🔊'}
          {status === 'generating' && <span className="btn-speak-finding-ring" aria-hidden="true" />}
          {status === 'playing' && (
            <span className="btn-speak-finding-eq" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
        {inFlight && (
          <span className="btn-speak-finding-stop" aria-hidden="true">×</span>
        )}
      </button>
      {timingLine && (
        <span className="finding-speech-timing" title={timingTitle}>
          {timingLine}
        </span>
      )}
    </span>
  );
}

function LikelyRootCauseBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (!agent.anomaly?.likelyRootCause) return null;
  const relatedCount = agent.anomaly.relatedFindingIds?.length ?? 0;
  const relatedLabel = relatedCount === 1 ? '1 related finding' : `${relatedCount} related findings`;
  return (
    <span className="root-cause-badge" title={agent.anomaly.causalityReason ?? 'Likely root cause for related findings'}>
      Likely root cause - {relatedLabel}
    </span>
  );
}

function FindingTranscriptContext({ agent }: { agent: AgentState }): React.ReactElement | null {
  const message = agent.anomaly?.transcriptContext?.lastAssistantMessage;
  if (!message) return null;
  return (
    <div className="finding-transcript-context" data-testid="finding-transcript-context">
      <div className="finding-transcript-context-label">Last agent message</div>
      <div className="finding-transcript-context-text">
        {message.excerpt}{message.truncated ? '...' : ''}
      </div>
    </div>
  );
}

type FindingDisplayItem =
  | { kind: 'single'; agent: AgentState }
  | { kind: 'rootCauseGroup'; root: AgentState; related: AgentState[] }
  | { kind: 'duplicateGroup'; key: string; type: string; agents: AgentState[] };

function visibleFindingAgents(
  agents: AgentState[],
  selectedAgentId: string | null,
  selectedTaskId: string | null,
  showAll: boolean,
): AgentState[] {
  if (showAll || agents.length <= FINDING_GROUP_RENDER_LIMIT) return agents;

  const visible = agents.slice(0, FINDING_GROUP_RENDER_LIMIT);
  if (selectedAgentId && !visible.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId))) {
    const selected = agents.find((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));
    // Keep keyboard/current selection visible even when it falls outside the default flood cap.
    if (selected) return [...visible, selected];
  }
  return visible;
}

function FindingGroupRenderCap({
  visibleCount,
  totalCount,
  label,
  onShowAll,
}: {
  visibleCount: number;
  totalCount: number;
  label: string;
  onShowAll: () => void;
}): React.ReactElement | null {
  if (visibleCount >= totalCount) return null;
  return (
    <button
      type="button"
      className="btn-xs finding-group-show-all"
      aria-label={`Show all ${totalCount} ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onShowAll();
      }}
    >
      Showing {visibleCount} of {totalCount} - show all
    </button>
  );
}

function buildFindingDisplayItems(findings: AgentState[]): FindingDisplayItem[] {
  const byAgentId = new Map(findings.map((agent) => [agent.agentId, agent]));
  const causalityKeys = new Set<string>();
  const rootRelatedByKey = new Map<string, AgentState[]>();

  for (const root of findings) {
    if (!root.anomaly?.likelyRootCause) continue;
    const related = (root.anomaly.relatedFindingIds ?? [])
      .map((id) => byAgentId.get(id))
      .filter((agent): agent is AgentState => Boolean(agent) && agentRowKey(agent) !== agentRowKey(root));
    if (related.length === 0) continue;

    rootRelatedByKey.set(agentRowKey(root), related);
    causalityKeys.add(agentRowKey(root));
    for (const agent of related) causalityKeys.add(agentRowKey(agent));
  }

  const nonCausalFindings = findings.filter((agent) => !causalityKeys.has(agentRowKey(agent)));
  const identicalPromptGroups = groupIdenticalPendingPrompts(nonCausalFindings);
  const promptGroupByKey = new Map<string, { key: string; type: string; agents: AgentState[] }>();
  const promptGroupedKeys = new Set<string>();
  for (const group of identicalPromptGroups) {
    const type = group.agents[0]?.anomaly?.type ?? 'needs_input';
    const displayGroup = { key: `prompt:${group.key}`, type, agents: group.agents };
    for (const agent of group.agents) {
      const key = agentRowKey(agent);
      promptGroupByKey.set(key, displayGroup);
      promptGroupedKeys.add(key);
    }
  }

  const { groups: duplicateGroups } = groupFindings(nonCausalFindings.filter((agent) => !promptGroupedKeys.has(agentRowKey(agent))));
  const duplicateGroupByKey = new Map<string, { key: string; type: string; agents: AgentState[] }>();
  for (const [type, agents] of duplicateGroups) {
    const displayGroup = { key: `type:${type}`, type, agents };
    for (const agent of agents) duplicateGroupByKey.set(agentRowKey(agent), displayGroup);
  }

  const items: FindingDisplayItem[] = [];
  const consumed = new Set<string>();
  const emittedGroupKeys = new Set<string>();

  for (const agent of findings) {
    const key = agentRowKey(agent);
    if (consumed.has(key)) continue;

    const related = (rootRelatedByKey.get(key) ?? [])
      .filter((candidate) => !consumed.has(agentRowKey(candidate)));
    if (related.length > 0) {
      items.push({ kind: 'rootCauseGroup', root: agent, related });
      consumed.add(key);
      for (const relatedAgent of related) consumed.add(agentRowKey(relatedAgent));
      continue;
    }

    const promptGroup = promptGroupByKey.get(key);
    if (promptGroup && !emittedGroupKeys.has(promptGroup.key)) {
      items.push({ kind: 'duplicateGroup', key: promptGroup.key, type: promptGroup.type, agents: promptGroup.agents });
      emittedGroupKeys.add(promptGroup.key);
      for (const groupedAgent of promptGroup.agents) consumed.add(agentRowKey(groupedAgent));
      continue;
    }

    const duplicateGroup = duplicateGroupByKey.get(key);
    if (duplicateGroup && !emittedGroupKeys.has(duplicateGroup.key)) {
      items.push({ kind: 'duplicateGroup', key: duplicateGroup.key, type: duplicateGroup.type, agents: duplicateGroup.agents });
      emittedGroupKeys.add(duplicateGroup.key);
      for (const groupedAgent of duplicateGroup.agents) consumed.add(agentRowKey(groupedAgent));
      continue;
    }

    items.push({ kind: 'single', agent });
    consumed.add(key);
  }

  return items;
}

function handleRailRowKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  activate: () => void,
) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  activate();
}

function RailRowSelectionTarget({ label, selected, disabled = false, onActivate }: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onActivate: () => void;
}) {
  return (
    <div
      className="rail-row-selection-target"
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={(event) => handleRailRowKeyDown(event, onActivate)}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      <span className="sr-only">Select {label}</span>
    </div>
  );
}

const FindingCard = React.memo(function FindingCard({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}): React.ReactElement {
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFlagFP, setShowFlagFP] = useState(false);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const nextBottleneck = useKookrStore((s) => s.nextBottleneck);
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const dnd = useDnd();
  const cls = severityClass(agent);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitStartedAt = findingWaitStartedAt(agent);
  const waitAge = formatAge(waitStartedAt);
  const arrivedDuringDnd =
    dnd.enabled &&
    dnd.startedAt !== null &&
    waitStartedAt !== undefined &&
    new Date(waitStartedAt).getTime() >= dnd.startedAt;

  // Clean up pending click timer on unmount
  useEffect(() => {
    return () => { if (clickTimer.current) clearTimeout(clickTimer.current); };
  }, []);

  function handleSkip() {
    track({ type: 'finding_skipped', agentId: agent.agentId, anomalyType: agent.anomaly?.type ?? null, method: 'button' });
    trackClick('skip');
    send({ type: 'skip', agentId: agent.agentId });
    nextBottleneck();
  }

  function submitFlagFP(userReason: string) {
    if (!agent.anomaly) return;
    trackClick('flag_fp_submitted');
    send({
      type: 'findingFeedback',
      agentId: agent.agentId,
      anomalyType: agent.anomaly.type,
      explanation: agent.anomaly.explanation,
      verdict: 'false_positive',
      ...(userReason ? { userReason } : {}),
    });
    setShowFlagFP(false);
    nextBottleneck();
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  const tooltipText = [agent.description, agent.anomaly?.explanation].filter(Boolean).join('\n\n');
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;
  const coordinator = useKookrStore((s) => s.coordinator);
  const coordinatorChip = useMemo(
    () => coordinatorChipForTask(coordinator, agent.taskId),
    [coordinator, agent.taskId],
  );

  function selectFinding() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'finding_card', anomalyType: agent.anomaly?.type ?? null });
    selectAgent(agent.agentId, agent.taskId);
  }

  function selectFindingImmediately() {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    selectFinding();
  }

  return (
    <Tooltip text={tooltipText}>
      <div
        className={`finding-card ${cls} ${selected ? 'selected' : ''}`}
        onClick={() => {
          if (selected || clickTimer.current) {
            // Already selected or a prior click is pending — no new timer needed.
            // Fire immediately if selected (no layout shift risk).
            if (selected) {
              selectFinding();
            }
            return;
          }
          // Delay selectAgent to allow dblclick on .finding-task to cancel it.
          // Without this, the first click causes a layout shift (detail panel appears)
          // that moves the card, breaking the second click of the dblclick.
          clickTimer.current = setTimeout(() => {
            selectFinding();
            clickTimer.current = null;
          }, 200);
        }}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectFindingImmediately}
        />
        <div className="finding-header">
          <span className="finding-header-left">
            <AgentProviderMark agent={agent} state="finding" />
            <span className={`finding-severity ${cls}`} aria-label={`${severityLabel(agent)}${waitAge ? `, waiting ${waitAge}` : ''}`}>{severityLabel(agent)}</span>
            {arrivedDuringDnd && (
              <span
                className="dnd-arrived-badge"
                title="Arrived while Do Not Disturb was on"
                aria-label="Arrived while Do Not Disturb was on"
              >
                while away
              </span>
            )}
            <LikelyRootCauseBadge agent={agent} />
          </span>
          <span className="finding-meta">
            <SpeakTaskSummaryControl agent={agent} selected={selected} />
            {waitStartedAt && waitAge && (
              <span className={`age-badge ${ageColor(waitStartedAt)}`}>
                waiting {waitAge}
              </span>
            )}
          </span>
        </div>
        <EditableName agent={agent} send={send} onBeforeEdit={() => {
          if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
        }} />
        <PriorityBadge agent={agent} />
        <ChildRollupPill agent={agent} />
        <div className="finding-context">
          <TaskIdCopyButton taskId={agent.taskId} compact />
          {showProjectBadge && agentProjectLabel(agent) && (
            <span className={`project-badge color-${agentProjectColor(agent)}`} title={agent.cwd}>
              {agentProjectLabel(agent)}
            </span>
          )}
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          {/* Branch / worktree is intentionally omitted here — it's detail-panel
              context, too granular for the card. See the detail panel's
              `.detail-branch` row. */}
        </div>
        {agent.ralphLoop && (
          <div className="finding-loop-row" onClick={(e) => e.stopPropagation()}>
            <RalphLoopControls agent={agent} />
            {!agent.ralphLoop || (agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused') ? (
              <RalphLoopBadge agent={agent} />
            ) : null}
          </div>
        )}
        {turnStateLabel(agent.turnState) && (
          <div
            className={`finding-turn-state turn-state--${turnStateClass(agent.turnState)}`}
            data-testid="finding-turn-state"
          >
            {turnStateLabel(agent.turnState)}
          </div>
        )}
        {agent.anomaly && (
          <div className="finding-explanation">{agent.anomaly.explanation}</div>
        )}
        {(agent.anomaly?.type === 'stale_agent' || agent.anomaly?.type === 'hook_disconnected') && agent.sessionHealth && (
          <div className="finding-health-evidence">
            Health: {formatDiagnosticIdentifier(agent.sessionHealth.classification)}
            {agent.sessionHealth.evidence.length > 0 ? ` — ${agent.sessionHealth.evidence.join(' · ')}` : ''}
          </div>
        )}
        <FindingTranscriptContext agent={agent} />
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
        {(agent.tokenUsage || agent.startedAt) && (
          <div className="finding-cost">
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' · ' : ''}
            {formatDuration(agent.startedAt)}
          </div>
        )}
        <div className="finding-actions">
          <TaskPriorityButton agent={agent} send={send} />
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); handleSkip(); }}>Skip</button>
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}>Snooze</button>
          <button className="btn-xs btn-fp" onClick={(e) => { e.stopPropagation(); setShowFlagFP(true); }} title="Flag this finding as a false positive">Not a real issue</button>
        </div>
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showFlagFP && agent.anomaly && (
          <SupervisorFeedbackDialog
            mode="false_positive"
            agentName={agent.taskName ?? agent.agentId}
            supervisorExplanation={agent.anomaly.explanation}
            onSubmit={({ userReason }) => submitFlagFP(userReason)}
            onClose={() => setShowFlagFP(false)}
          />
        )}
      </div>
    </Tooltip>
  );
});

const RootCauseFindingGroup = React.memo(function RootCauseFindingGroup({ root, related, selectedAgentId, selectedTaskId, send }: {
  root: AgentState;
  related: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [showAllRelated, setShowAllRelated] = useState(false);
  const visibleRelated = visibleFindingAgents(related, selectedAgentId, selectedTaskId, showAllRelated);
  const selectedInRelated = related.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));

  useEffect(() => {
    if (selectedInRelated) setExpanded(true);
  }, [selectedInRelated]);

  return (
    <div className="root-cause-group">
      <div className="root-cause-root">
        <FindingCard
          agent={root}
          selected={isSelectedAgent(root, selectedAgentId, selectedTaskId)}
          send={send}
        />
        <button
          type="button"
          className="root-cause-toggle"
          aria-label={expanded ? 'Hide related findings' : 'Show related findings'}
          title={expanded ? 'Hide related findings' : 'Show related findings'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded && (
        <div className="root-cause-related">
          {visibleRelated.map((agent) => (
            <FindingCard
              key={agentRowKey(agent)}
              agent={agent}
              selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
              send={send}
            />
          ))}
          <FindingGroupRenderCap
            visibleCount={visibleRelated.length}
            totalCount={related.length}
            label="related findings"
            onShowAll={() => setShowAllRelated(true)}
          />
        </div>
      )}
    </div>
  );
});

function HealthyRow({ agent, selected, send, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFlagMissed, setShowFlagMissed] = useState(false);
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;
  // Both live-updating values; render each (with its leading separator) only
  // when it has content, so a row without token usage never trails a stray "·".
  const durText = healthyStatusLabel(agent.events, agent.startedAt);
  const costText = agent.tokenUsage ? formatTokenUsage(agent.tokenUsage) : '';

  function handleReply(e: React.MouseEvent) {
    e.stopPropagation();
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'reply_button', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area textarea') as HTMLTextAreaElement | null;
      input?.focus();
    });
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  function selectHealthyAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'healthy_row', anomalyType: null });
    track({ type: 'healthy_agent_inspected', agentId: agent.agentId });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`healthy-row${colorIdx >= 0 ? ` project-color-${colorIdx}` : ''}${selected ? ' selected' : ''}${healthyDotClass(agent.events) === 'running' ? ' running-accent' : ''}`}
        onClick={selectHealthyAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectHealthyAgent}
        />
        {/* Title Lead: the task name owns its own full-width line; the info row
            below leads with stable-width fields (avatar, project) so the
            live-updating duration/cost that trail never shove them or the
            right-pinned action rail as their widths change. The click-to-copy id
            sits (icon-only) in that rail; the branch/worktree lives in the detail
            panel, not the card. */}
        <div className="healthy-row-name" title={agent.taskName ?? agent.agentId}>
          {agent.taskName ?? agent.agentId}
        </div>
        <div className="healthy-row-info">
          <div className="healthy-row-meta">
            <AgentProviderMark agent={agent} state={healthyDotClass(agent.events)} />
            {showProjectBadge && projectLabelText && (
              <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
                {projectLabelText}
              </span>
            )}
            {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
              <span className={`worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
                {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
              </span>
            )}
            <PriorityBadge agent={agent} />
            <StuckReasonBadge agent={agent} />
            <ChildRollupPill agent={agent} />
            {durText && (
              <>
                <span className="healthy-row-sep" aria-hidden="true">·</span>
                <span className="healthy-row-dur">{durText}</span>
              </>
            )}
            {costText && (
              <>
                <span className="healthy-row-sep" aria-hidden="true">·</span>
                <span className="healthy-row-cost">{costText}</span>
              </>
            )}
          </div>
          <div className="healthy-row-controls">
            <TaskIdCopyButton taskId={agent.taskId} iconOnly />
            <SpeakTaskSummaryControl agent={agent} selected={selected} />
            <TaskPriorityButton agent={agent} send={send} variant="icon" />
            <button
              className="btn-reply btn-icon"
              data-testid="reply-button"
              onClick={handleReply}
              title={`Send message to ${agent.taskName ?? agent.agentId}`}
              aria-label={`Send message to ${agent.taskName ?? agent.agentId}`}
            >
              <ReplyIcon />
            </button>
            <button
              className="btn-icon btn-snooze"
              onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}
              title={`Snooze ${agent.taskName ?? agent.agentId}`}
              aria-label={`Snooze ${agent.taskName ?? agent.agentId}`}
            >
              <SnoozeIcon />
            </button>
            <button
              className="btn-icon btn-fn"
              onClick={(e) => { e.stopPropagation(); setShowFlagMissed(true); }}
              title="Report that Kookr missed a real issue on this agent"
              aria-label={`Missed a real issue — report for ${agent.taskName ?? agent.agentId}`}
            >
              <MissedIcon />
            </button>
            <RalphLoopControls agent={agent} />
            {agent.ralphLoop && agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused' && (
              <RalphLoopBadge agent={agent} />
            )}
            <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          </div>
        </div>
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showFlagMissed && (
          <SupervisorFeedbackDialog
            mode="false_negative"
            agentName={agent.taskName ?? agent.agentId}
            onSubmit={({ userReason, suspectedType }) => {
              trackClick('flag_missed_submitted');
              send({
                type: 'missedFinding',
                agentId: agent.agentId,
                userReason,
                ...(suspectedType ? { suspectedType } : {}),
              });
              setShowFlagMissed(false);
            }}
            onClose={() => setShowFlagMissed(false)}
          />
        )}
      </div>
    </Tooltip>
  );
}

function PlaybookGroup({ playbookId, agents, selectedAgentId, selectedTaskId, send, onSchedulePlaybook }: {
  playbookId: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = agents[0]; // Most recent iteration (agents sorted by startedAt descending)

  return (
    <div className="playbook-group">
      <div
        className="playbook-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="playbook-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className="playbook-group-name">{latest.taskName ?? playbookId}</span>
        <span className="playbook-group-count">{agents.length} runs</span>
        <SchedulePlaybookButton agent={latest} onSchedule={onSchedulePlaybook} />
      </div>
      {/* Rows inside a group don't repeat the schedule button — the group header
          already carries one for the shared playbook. */}
      {expanded && agents.map((agent) => (
        <HealthyRow
          key={agentRowKey(agent)}
          agent={agent}
          selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
          send={send}
        />
      ))}
      {!expanded && (
        <HealthyRow
          agent={latest}
          selected={isSelectedAgent(latest, selectedAgentId, selectedTaskId)}
          send={send}
        />
      )}
    </div>
  );
}

const FindingGroup = React.memo(function FindingGroup({ type, agents, selectedAgentId, selectedTaskId, send }: {
  type: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const setRespondAllAgentIds = useKookrStore((s) => s.setRespondAllAgentIds);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const selectedInGroup = agents.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));
  // A `needs_input` group can mix completed turns and explicit AskUserQuestion
  // waits. The header should only read as a completed turn when every member
  // is one — otherwise pick a non-completed member so it stays "Needs Input".
  // See issue #358.
  const headerAgent = agents.find((a) => a.turnState !== 'completed_turn') ?? agents[0];
  const cls = headerAgent ? severityClass(headerAgent) : '';
  const visibleAgents = visibleFindingAgents(agents, selectedAgentId, selectedTaskId, showAllAgents);
  const identicalPromptGroups = useMemo(() => groupIdenticalPendingPrompts(agents), [agents]);

  useEffect(() => {
    if (selectedInGroup) setExpanded(true);
  }, [selectedInGroup]);

  function handleRespondAll(e: React.MouseEvent, targetAgents = agents, trackingTarget = 'respond_all') {
    e.stopPropagation();
    if (targetAgents.length === 0) return;
    const agentIds = targetAgents.map(a => a.agentId);
    setRespondAllAgentIds(agentIds);
    // Select the first agent so the detail panel has context
    selectAgent(targetAgents[0].agentId, targetAgents[0].taskId);
    // Re-set respondAllAgentIds since selectAgent clears it
    useKookrStore.getState().setRespondAllAgentIds(agentIds);
    trackClick(trackingTarget);
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area textarea') as HTMLTextAreaElement | null;
      input?.focus();
    });
  }

  function handleSkipAll(e: React.MouseEvent) {
    e.stopPropagation();
    trackClick('skip_all');
    send({ type: 'skipAll', agentIds: agents.map(a => a.agentId) });
  }

  function handleApproveIdenticalPrompt(
    e: React.MouseEvent,
    targetAgents: AgentState[],
    approvalResponse: string,
  ) {
    e.stopPropagation();
    if (targetAgents.length === 0) return;
    trackClick('approve_identical_prompt');
    send({ type: 'respondAll', agentIds: targetAgents.map((agent) => agent.agentId), input: approvalResponse });
  }

  function handleIdenticalPromptAction(
    e: React.MouseEvent,
    group: ReturnType<typeof groupIdenticalPendingPrompts>[number],
  ) {
    if (group.approvalResponse) {
      handleApproveIdenticalPrompt(e, group.agents, group.approvalResponse);
      return;
    }

    handleRespondAll(e, group.agents, 'respond_identical_prompt');
  }

  return (
    <div className={`finding-group ${cls}`}>
      <div
        className="finding-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="finding-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className={`finding-severity ${cls}`}>{severityLabel(headerAgent)}</span>
        <span className="finding-group-label">
          {agents.length} agents {groupLabel(type)}
        </span>
        <span className="finding-group-actions">
          <button className="btn-xs" onClick={handleSkipAll}>Skip All</button>
          <button className="btn-xs btn-primary-xs" onClick={handleRespondAll}>Respond to All</button>
        </span>
      </div>
      {identicalPromptGroups.length > 0 && (
        <div className="finding-identical-prompts" aria-label="Identical pending prompts">
          {identicalPromptGroups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`btn-xs finding-identical-prompt-action${group.approvalResponse ? ' finding-identical-prompt-action--approve' : ''}`}
              aria-label={`${group.approvalResponse ? 'Approve' : 'Reply to'} matching prompt "${group.prompt}" for ${group.agents.length} agents`}
              title={group.prompt}
              onClick={(e) => handleIdenticalPromptAction(e, group)}
            >
              {group.approvalResponse ? 'Approve' : 'Reply to'} matching ({group.agents.length})
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <>
          {visibleAgents.map((agent) => (
            <FindingCard
              key={agentRowKey(agent)}
              agent={agent}
              selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
              send={send}
            />
          ))}
          <FindingGroupRenderCap
            visibleCount={visibleAgents.length}
            totalCount={agents.length}
            label="findings in this group"
            onShowAll={() => setShowAllAgents(true)}
          />
        </>
      )}
    </div>
  );
});

function formatCountdown(snoozedUntil: number): string {
  const remaining = Math.max(0, snoozedUntil - Date.now());
  if (remaining === 0) return 'resuming...';
  const totalSec = Math.ceil(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `resumes in ${h}h ${m}m`;
  if (m > 0) return `resumes in ${m}m ${s}s`;
  return `resumes in ${s}s`;
}

function PendingRow({ agent, selected, send, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  function selectPendingAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'pending_row', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }
  return (
    <Tooltip text={agent.description}>
      <div
        className={`pending-row${selected ? ' selected' : ''}`}
        onClick={selectPendingAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectPendingAgent}
        />
        <div className="pending-row-top">
          <AgentProviderMark agent={agent} state="pending" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="pending-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
        </div>
        <div className="pending-row-meta">
          Queued · waiting for slot
          <TaskPriorityButton agent={agent} send={send} />
          <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          {agent.taskId && (
            <button className="btn-xs btn-danger-xs" onClick={(e) => {
              e.stopPropagation();
              send({ type: 'cancelTask', taskId: agent.taskId! });
            }}>Cancel</button>
          )}
        </div>
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
      </div>
    </Tooltip>
  );
}

function SnoozedRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const [, setTick] = useState(0);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;

  // Update countdown every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function selectSnoozedAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'snoozed_row', anomalyType: agent.anomaly?.type ?? null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`snoozed-row${selected ? ' selected' : ''}`}
        onClick={selectSnoozedAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectSnoozedAgent}
        />
        <div className="snoozed-row-top">
          <AgentProviderMark agent={agent} state="snoozed" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="snoozed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
        </div>
        <div className="snoozed-countdown">
          {agent.suppressed ? 'Paused' : `Snoozed · ${formatCountdown(agent.snoozedUntil!)}`}
          <TaskPriorityButton agent={agent} send={send} />
          {!agent.suppressed && (
            <button
              className="btn-xs"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: 'cancelSnooze', agentId: agent.agentId, taskId: agent.taskId });
              }}
            >
              Resume now
            </button>
          )}
        </div>
      </div>
    </Tooltip>
  );
}

// Clear-completed control lives inside the Completed section header so the
// action is co-located with the content it acts on. Confirmation uses the
// shared modal ConfirmDialog — the familiar OK/Cancel shape matches the rest
// of the app (cancel/complete task dialogs) and gives Enter/Escape bindings
// for free. Default scope sweeps user-initiated terminal states (completed +
// cancelled); terminated is opt-in via the checkbox inside the dialog. See
// rfc-task-loss-prevention.md D2.
//
function ClearCompletedButton({
  finishedCount,
  terminatedCount,
  finishedTaskIds,
  terminatedTaskIds,
  projectId,
  onQueueClearCompleted,
}: {
  finishedCount: number;
  terminatedCount: number;
  finishedTaskIds: string[];
  terminatedTaskIds: string[];
  projectId?: string;
  onQueueClearCompleted?: Props['onQueueClearCompleted'];
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeTerminated, setIncludeTerminated] = useState(false);

  // Hide when there is nothing we would sweep by default. The "Clear completed"
  // label would otherwise promise an action that produces a silent no-op —
  // the exact failure mode this PR set out to eliminate. Terminated-only cases
  // are handled by the per-row Ack / Reopen flow, not by bulk sweep.
  if (finishedCount === 0) return null;

  const openConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIncludeTerminated(false);
    setConfirmOpen(true);
  };
  const cancelConfirm = () => setConfirmOpen(false);
  const confirmClear = () => {
    const taskIds = includeTerminated
      ? [...finishedTaskIds, ...terminatedTaskIds]
      : finishedTaskIds;
    onQueueClearCompleted?.({
      includeTerminated,
      ...(projectId ? { projectId } : {}),
      taskIds,
      count: taskIds.length,
    });
    setConfirmOpen(false);
  };

  return (
    <>
      <button
        className="btn-clear-completed"
        onClick={openConfirm}
        aria-label="Clear completed tasks"
        title="Remove finished tasks (completed and cancelled) from the list"
      >
        Clear
      </button>
      {confirmOpen && (
        <ConfirmDialog
          title="Clear completed tasks"
          message={`Delete ${finishedCount} finished task${finishedCount === 1 ? '' : 's'}?`}
          confirmLabel="Delete"
          confirmClass="btn-danger"
          onConfirm={confirmClear}
          onClose={cancelConfirm}
        >
          {terminatedCount > 0 && (
            <label className="clear-completed-include-terminated">
              <input
                type="checkbox"
                checked={includeTerminated}
                onChange={(e) => setIncludeTerminated(e.target.checked)}
              />
              Also delete {terminatedCount} terminated task{terminatedCount === 1 ? '' : 's'}
            </label>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

// Control-room bulk shutdown (issue #1325). One confirmed action interrupts
// every live session and cancels every active task in scope — replacing the
// old pattern of fanning out "abort your work" prose to each agent. The server
// answers with a concise result toast (aborted / already-finished / failed);
// retries are idempotent, so a double-click never double-cancels.
function AbortActiveButton({
  taskIds,
  send,
}: {
  taskIds: string[];
  send: (msg: ClientMessage) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Nothing active to abort → hide, so the label never promises a no-op.
  if (taskIds.length === 0) return null;

  const count = taskIds.length;
  const openConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };
  const confirmAbort = () => {
    send({ type: 'batchAbortTasks', taskIds });
    setConfirmOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="btn-abort-active"
        onClick={openConfirm}
        aria-label="Abort all active tasks"
        title="Interrupt live sessions and cancel all active tasks"
      >
        Abort all
      </button>
      {confirmOpen && (
        <ConfirmDialog
          title="Abort active tasks"
          message={`Abort ${count} active task${count === 1 ? '' : 's'}? Live sessions are interrupted and the tasks are cancelled.`}
          confirmLabel="Abort"
          confirmClass="btn-danger"
          onConfirm={confirmAbort}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

function CompletedRow({ agent, selected, send, pendingDeletion, onQueueDeleteTask, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  pendingDeletion: boolean;
  onQueueDeleteTask?: Props['onQueueDeleteTask'];
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const isCancelled = agent.taskStatus === 'cancelled';
  const isTerminated = agent.taskStatus === 'terminated';
  // A reaped task that had already delivered a merged PR before it hung (issue
  // #1559) — surfaced distinctly from a plain `terminated` so a successful
  // delivery isn't read as failure.
  const isDeliveredThenHung = isTerminated && agent.reapOutcome === 'delivered_then_hung';
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  // The row's style variant: cancelled (user stopped), terminated (session died
  // without ack), or completed (default / user acknowledged). Keep CSS variants
  // aligned with rfc-task-loss-prevention D1. AgentProviderMark only knows the
  // base variants, so delivered-then-hung reuses the terminated mark and adds a
  // distinct row class + label of its own.
  const rowVariant = isCancelled ? 'cancelled' : isTerminated ? 'terminated' : 'completed';
  const deliveredThenHungClass = isDeliveredThenHung ? ' delivered-then-hung' : '';
  const terminalLabel = isCancelled
    ? 'Cancelled'
    : isDeliveredThenHung
      ? 'Delivered then hung'
      : isTerminated
        ? 'Terminated'
        : 'Completed';
  const finishedAt = formatCompactDateTime(agent.finishedAt);
  const finishedAgo = formatRelativeTimeAgo(agent.finishedAt);
  const finishedTitle = finishedAt
    ? `${terminalLabel} ${finishedAt}${finishedAgo ? ` (${finishedAgo})` : ''}`
    : terminalLabel;

  function selectCompletedAgent() {
    if (pendingDeletion) return;
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'completed_row', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`completed-row${selected ? ' selected' : ''} ${rowVariant}${deliveredThenHungClass}${pendingDeletion ? ' pending-deletion' : ''}`}
        onClick={selectCompletedAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          disabled={pendingDeletion}
          onActivate={selectCompletedAgent}
        />
        <div className="completed-row-top">
          <AgentProviderMark agent={agent} state={rowVariant} />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="completed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
          <span className="completed-row-meta">
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' · ' : ''}
            {formatDuration(agent.startedAt)}
          </span>
          <span className="completed-row-finished" title={finishedTitle} aria-label={finishedTitle}>
            <span className="completed-row-status-label">{terminalLabel}</span>
            {finishedAt && <time dateTime={agent.finishedAt}>{finishedAt}</time>}
          </span>
          {agent.taskId && (
            <button className="btn-xs" disabled={pendingDeletion} onClick={(e) => {
              e.stopPropagation();
              send({ type: 'reopenTask', taskId: agent.taskId! });
            }}>Reopen</button>
          )}
          <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          {agent.taskId && (
            <button
              className="btn-xs btn-danger-xs"
              disabled={pendingDeletion}
              aria-label={`Delete ${agent.taskName ?? agent.agentId}`}
              onClick={(e) => {
                e.stopPropagation();
                onQueueDeleteTask?.({
                  taskId: agent.taskId!,
                  label: agent.taskName ?? agent.agentId,
                });
              }}
            >
              Delete
            </button>
          )}
          {pendingDeletion && (
            <span className="completed-row-pending-delete">deleting soon</span>
          )}
        </div>
        {agent.ralphLoop && (
          <RalphLoopBadge agent={agent} />
        )}
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
        {agent.completionDigest && agent.completionDigest.bullets.length > 0 && (
          <ul className="completed-digest">
            {agent.completionDigest.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
      </div>
    </Tooltip>
  );
}

/** Group healthy agents: playbook iterations are collapsed, standalone agents shown individually. */
function groupHealthyAgents(agents: AgentState[]): { standalone: AgentState[]; groups: Map<string, AgentState[]> } {
  const groups = new Map<string, AgentState[]>();
  const standalone: AgentState[] = [];

  for (const agent of agents) {
    if (agent.playbookId) {
      const list = groups.get(agent.playbookId) ?? [];
      list.push(agent);
      groups.set(agent.playbookId, list);
    } else {
      standalone.push(agent);
    }
  }

  // Only group if there are 2+ agents with the same playbookId
  const realGroups = new Map<string, AgentState[]>();
  for (const [id, list] of groups) {
    if (list.length >= 2) {
      // Sort by startedAt descending (most recent first)
      list.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      realGroups.set(id, list);
    } else {
      standalone.push(...list);
    }
  }

  return { standalone, groups: realGroups };
}

function SectionToggleButton({
  collapsed,
  label,
  count,
  labelClassName,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  count: number;
  labelClassName: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="section-header findings-section-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <span className="section-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      <span className={labelClassName}>{label} ({count})</span>
    </button>
  );
}

/**
 * Drag handle that sets the height of the `.bottom-sections` scroll box so the
 * user can grow the Healthy/Pending/Completed area (to see more at once) or
 * shrink it (to give the findings list more room), replacing the old fixed
 * `max-height: 30%` cap. Dragging up grows the area; the height is clamped to
 * the live panel height (keeping the findings list usable) and, on release,
 * persisted so it survives reloads. Mirrors the findings-panel width resizer.
 */
// Headroom kept above the bottom sections for the findings header + at least a
// couple of findings, so neither the drag nor a persisted height can grow the
// bottom area to the point of hiding the list it sits below.
const BOTTOM_SECTIONS_RESERVED_ABOVE_PX = 160;

/** Live upper bound for the bottom-sections height, given the current panel size. */
function maxBottomSectionsHeightFor(panel: HTMLElement | null): number {
  if (!panel) return MAX_BOTTOM_SECTIONS_HEIGHT;
  return Math.max(
    MIN_BOTTOM_SECTIONS_HEIGHT,
    panel.getBoundingClientRect().height - BOTTOM_SECTIONS_RESERVED_ABOVE_PX,
  );
}

function BottomSectionsResizer({
  panelRef,
  getHeight,
  onResize,
  onCommit,
  onReset,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  getHeight: () => number;
  onResize: (height: number) => void;
  onCommit: (height: number) => void;
  /** Double-click / Escape: drop the explicit height and revert to the CSS default. */
  onReset: () => void;
}): React.ReactElement {
  const dragCleanup = useRef<(() => void) | null>(null);

  const maxAvailable = useCallback((): number => maxBottomSectionsHeightFor(panelRef.current), [panelRef]);

  // Tear down any in-flight drag on unmount (e.g. the sections empty out while
  // the user is dragging), so window listeners never leak.
  useEffect(() => () => dragCleanup.current?.(), []);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = getHeight();
    // The handle sits above the bottom sections, so dragging it UP (smaller y)
    // should grow them.
    const computeNext = (clientY: number) =>
      clampBottomSectionsHeight(startHeight + (startY - clientY), maxAvailable());
    const handleMove = (moveEvent: PointerEvent) => onResize(computeNext(moveEvent.clientY));
    const teardown = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      dragCleanup.current = null;
    };
    function handleUp(upEvent: PointerEvent) {
      const next = computeNext(upEvent.clientY);
      teardown();
      onCommit(next);
    }
    dragCleanup.current = teardown;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    let next: number;
    switch (event.key) {
      case 'ArrowUp': next = getHeight() + step; break;
      case 'ArrowDown': next = getHeight() - step; break;
      case 'Home': next = MIN_BOTTOM_SECTIONS_HEIGHT; break;
      case 'End': next = maxAvailable(); break;
      case 'Escape': event.preventDefault(); onReset(); return;
      default: return;
    }
    event.preventDefault();
    const clamped = clampBottomSectionsHeight(next, maxAvailable());
    onResize(clamped);
    onCommit(clamped);
  };

  return (
    <div
      className="bottom-sections-resizer"
      data-testid="bottom-sections-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize the healthy and completed task sections (double-click to reset)"
      aria-valuenow={Math.round(getHeight())}
      aria-valuemin={MIN_BOTTOM_SECTIONS_HEIGHT}
      aria-valuemax={Math.round(maxAvailable())}
      title="Drag to resize · double-click to reset"
      onPointerDown={beginDrag}
      onDoubleClick={(e) => { e.preventDefault(); onReset(); }}
      onKeyDown={handleKeyDown}
    >
      <span className="bottom-sections-grip" aria-hidden="true" />
    </div>
  );
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
