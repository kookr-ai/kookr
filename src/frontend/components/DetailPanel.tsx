import React, { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage, PermissionRequestBinding } from '../../shared/protocol.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { track, trackClick } from '../telemetry.js';
import type { DiffClickTarget } from './ActivityPanel.js';
import { formatDuration, formatCost, formatTokens, projectLabel, projectColor, formatBranch, agentProviderPresentation, worktreeHealthLabel, worktreeHealthTitle, deriveTaskNextStepRecommendations } from '../presentation.js';
import type { NextStepRecommendation } from '../presentation.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { shouldAutoFocusReply, anomalyTransitionKey } from './detail-panel-focus.js';
import { computeTerminalVisible } from './detail-panel-visibility.js';
import { TaskIdCopyButton } from './TaskIdCopyButton.js';
import { TaskShareModal } from './TaskShareModal.js';
import type { TaskShareSummary } from '../../shared/contracts/remote-share.js';
import { getSettingsSnapshot, getTask, getTaskShares } from '../api/index.js';
import { deriveTaskShareHeaderStatus } from './task-share-header-status.js';
import { TaskDependencyEditor } from './TaskDependencyEditor.js';
import { TaskDependencyRail } from './TaskDependencyRail.js';
import type { ReplySnippet } from '../../shared/contracts/reply-snippets.js';
import { CoordinatorChainStripView } from './CoordinatorSurfaces.js';
import { clearDetailReplyDraft, loadDetailReplyDraft, saveDetailReplyDraft } from '../store/detail-reply-draft.js';
import {
  detectShortcutPlatform,
  getDefaultShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { OverviewEmptyState } from './OverviewEmptyState.js';
import type { DetailPaneMode, RelaunchTask } from '../store/store-types.js';
import { MigrateTaskControl } from './DetailPanel/MigrateTaskControl.js';

type LazyModule = Record<string, unknown> & { default?: Record<string, unknown> };

function pickLazyExport<T>(module: unknown, exportName: string): T {
  const lazyModule = module as LazyModule;
  return (lazyModule[exportName] ?? lazyModule.default?.[exportName]) as T;
}

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: pickLazyExport<typeof m.VoiceInputButton>(m, 'VoiceInputButton') })));
const TerminalPanel = lazy(() => import('./TerminalPanel.js').then((m) => ({ default: pickLazyExport<typeof m.TerminalPanel>(m, 'TerminalPanel') })));
const GitHubPanel = lazy(() => import('./GitHubPanel.js').then((m) => ({ default: pickLazyExport<typeof m.GitHubPanel>(m, 'GitHubPanel') })));
const ActivityPanel = lazy(() => import('./ActivityPanel.js').then((m) => ({ default: pickLazyExport<typeof m.ActivityPanel>(m, 'ActivityPanel') })));
const DiffPane = lazy(() => import('./DiffPane.js').then((m) => ({ default: pickLazyExport<typeof m.DiffPane>(m, 'DiffPane') })));
const EvolutionPanel = lazy(() => import('./EvolutionPanel.js').then((m) => ({ default: pickLazyExport<typeof m.EvolutionPanel>(m, 'EvolutionPanel') })));
const FileViewerPane = lazy(() => import('./FileViewerPane.js').then((m) => ({ default: pickLazyExport<typeof m.FileViewerPane>(m, 'FileViewerPane') })));
const EffectiveHookSettingsModal = lazy(() => import('./EffectiveHookSettingsModal.js').then((m) => ({ default: pickLazyExport<typeof m.EffectiveHookSettingsModal>(m, 'EffectiveHookSettingsModal') })));
const NARROW_DETAIL_BREAKPOINT_PX = 1200;
/** Max auto-grow height of the reply textarea (~6 rows incl. padding). */
const REPLY_MAX_HEIGHT_PX = 140;

/**
 * Exhaustive terminal-status check tolerant of the optional taskStatus.
 * Using the core helper here forces compile errors if TaskStatus grows.
 */
function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return status !== undefined && isTerminalStatus(status);
}

function agentProjectLabel(agent: AgentState): string {
  return agent.projectDisplayLabel ?? projectLabel(agent.cwd);
}

/** Strip markdown formatting artifacts from suggestion text */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic*
    .replace(/`(.+?)`/g, '$1')         // `code`
    .replace(/^#+\s*/gm, '')           // # headings
    .replace(/^\s*[-*]\s+/gm, '')      // - bullet points
    .trim();
}

/** Truncate text with ellipsis */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function criterionCountLabel(count: number, suffix: string): string {
  return `${count} ${count === 1 ? 'criterion' : 'criteria'} ${suffix}`;
}

function criterionVerdictLabel(verdict: 'pass' | 'fail' | 'unknown'): string {
  switch (verdict) {
    case 'pass': return 'Passed';
    case 'fail': return 'Failed';
    case 'unknown': return 'Unknown';
  }
}

function CriteriaVerdictBlock({ digest }: { digest: NonNullable<AgentState['completionDigest']> }) {
  const verdict = digest.criteriaVerdict;
  if (!verdict || verdict.items.length === 0) return null;
  const failed = verdict.summary.fail > 0;
  const allPassed = verdict.summary.pass === verdict.items.length;
  const label = failed
    ? criterionCountLabel(verdict.summary.fail, 'failed')
    : allPassed
      ? 'Criteria passed'
      : criterionCountLabel(verdict.summary.unknown, 'unknown');

  return (
    <div className={`criteria-verdict criteria-verdict--${failed ? 'fail' : allPassed ? 'pass' : 'unknown'}`} data-testid="criteria-verdict">
      <div className="criteria-verdict-header">
        <span className="criteria-verdict-title">Criteria</span>
        <span className="criteria-verdict-badge">{label}</span>
      </div>
      <ul className="criteria-verdict-list">
        {verdict.items.map((item, i) => (
          <li key={`${item.criterion}-${i}`} className={`criteria-verdict-item criteria-verdict-item--${item.verdict}`}>
            <span className="criteria-verdict-mark" aria-hidden="true">
              {item.verdict === 'pass' ? '✓' : item.verdict === 'fail' ? '!' : '?'}
            </span>
            <span className="criteria-verdict-text">
              <span className="sr-only">{criterionVerdictLabel(item.verdict)}: </span>
              <span className="criteria-verdict-criterion">{item.criterion}</span>
              <span className="criteria-verdict-reason">{item.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  agent: AgentState | null;
  send: (msg: ClientMessage) => boolean;
  onLaunch: () => void;
  onRequestComplete: () => void;
  detailPaneMode?: DetailPaneMode;
  wideDetailActive?: boolean;
  terminalFocusMode?: boolean;
  shortcutBindings?: ShortcutBindingMap;
  /**
   * Rail bucket data for the no-selection overview (F8). Passed down from
   * App's buildAgentBuckets result so the overview matches the rail exactly
   * instead of reclassifying agents here.
   */
  overview?: {
    waiting: AgentState[];
    runningCount: number;
    completedCount: number;
  };
}

function defaultShortcutBindings(): ShortcutBindingMap {
  return getDefaultShortcutBindings(detectShortcutPlatform());
}

function EditableHeading({ agent, send }: { agent: AgentState; send: (msg: ClientMessage) => boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing() {
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
        className="detail-heading-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <h2 onDoubleClick={agent.taskId ? startEditing : undefined}>
      {agent.taskName ?? agent.agentId}
    </h2>
  );
}

function AgentProviderBadge({
  agentType,
  provider,
}: {
  agentType: NonNullable<AgentState['agentType']>;
  provider: ReturnType<typeof agentProviderPresentation>;
}) {
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`detail-agent-provider detail-agent-provider--${agentType}`}
      title={title}
    >
      <svg className="detail-agent-provider-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
      <span className="detail-agent-provider-label">{provider.label}</span>
      <span className="sr-only"> by {provider.provider}</span>
    </span>
  );
}

function TaskNextActionsPanel({
  agentId,
  recommendations,
  onRelaunch,
  onReflect,
  onAction,
}: {
  agentId: string;
  recommendations: NextStepRecommendation[];
  onRelaunch: () => void | Promise<void>;
  onReflect: () => void;
  onAction: (recommendation: NextStepRecommendation) => void;
}) {
  const recommendationKey = recommendations.map((recommendation) => recommendation.id).join('|');

  useEffect(() => {
    if (recommendations.length === 0) return;
    track({
      type: 'suggestion_lifecycle',
      agentId,
      action: 'next_steps_shown',
      recommendationIds: recommendations.map((recommendation) => recommendation.id),
    });
  }, [agentId, recommendationKey]);

  if (recommendations.length === 0) return null;

  function renderAction(recommendation: NextStepRecommendation) {
    const { action } = recommendation;
    if (action.type === 'open-pr') {
      return (
        <a
          className="action-btn action-btn--neutral detail-next-action-link"
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onAction(recommendation)}
        >
          {recommendation.actionLabel}
        </a>
      );
    }

    return (
      <button
        type="button"
        className={action.type === 'snapshot-reflect' ? 'action-btn action-btn--reflect' : 'action-btn action-btn--success'}
        onClick={() => {
          onAction(recommendation);
          if (action.type === 'snapshot-reflect') onReflect();
          if (action.type === 'relaunch') void onRelaunch();
        }}
      >
        {recommendation.actionLabel}
      </button>
    );
  }

  return (
    <section className="detail-next-actions" aria-labelledby="detail-next-actions-title">
      <div className="detail-next-actions-header">
        <h3 id="detail-next-actions-title">Next actions</h3>
        <span>{recommendations.length}</span>
      </div>
      <div className="detail-next-actions-list">
        {recommendations.map((recommendation) => (
          <div className="detail-next-action" key={recommendation.id}>
            <div className="detail-next-action-copy">
              <strong>{recommendation.title}</strong>
              <p>{recommendation.detail}</p>
            </div>
            {renderAction(recommendation)}
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailMetadataMenu({
  agent,
  provider,
  hookSettingsTriggerRef,
  onShowHookSettings,
}: {
  agent: AgentState;
  provider: ReturnType<typeof agentProviderPresentation> | null;
  hookSettingsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onShowHookSettings: () => void;
}) {
  const hasUsageCost = agent.tokenUsage && agent.tokenUsage.costUsd > 0;
  const hasTokenCount = agent.tokenUsage && (agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens) > 0;
  const hasProject = Boolean(agentProjectLabel(agent));
  const hasBranch = Boolean(agent.gitBranch || agent.gitCommit);
  const hasAgentType = Boolean(agent.agentType && provider);
  const hasAnyDetail = hasUsageCost || hasTokenCount || hasProject || hasBranch || hasAgentType;

  if (!hasAnyDetail) return null;

  return (
    <details className="detail-meta-menu">
      <summary>Details</summary>
      <div className="detail-meta-popover">
        {hasAgentType && agent.agentType && provider && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Agent</span>
            <span className="detail-agent-type-group">
              <AgentProviderBadge agentType={agent.agentType} provider={provider} />
              <button
                ref={hookSettingsTriggerRef}
                type="button"
                className="detail-hook-settings-btn"
                aria-label={`Hooks: view effective hook settings for ${provider.label} session`}
                title={`Hooks: view effective hook settings for ${provider.label} session`}
                onClick={onShowHookSettings}
              >
                hooks
              </button>
            </span>
          </div>
        )}
        {hasProject && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Project</span>
            <span className={`project-badge color-${projectColor(agent.projectId ?? agent.cwd)}`} title={agent.cwd}>
              {agentProjectLabel(agent)}
            </span>
          </div>
        )}
        {agent.gitBranch && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Branch</span>
            <span className="detail-branch" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : 'Git branch'}>
              {'\u2387'} {formatBranch(agent.gitBranch)}
              {agent.gitIsWorktree && <span className="worktree-badge">worktree</span>}
            </span>
          </div>
        )}
        {!agent.gitBranch && agent.gitCommit && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Revision</span>
            <span className="detail-branch detached" title="Detached HEAD">
              {'\u2387'} ({agent.gitCommit})
            </span>
          </div>
        )}
        {hasUsageCost && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Cost</span>
            <span className="detail-cost" title={`In: ${formatTokens(agent.tokenUsage!.inputTokens)} / Out: ${formatTokens(agent.tokenUsage!.outputTokens)}`}>
              {formatCost(agent.tokenUsage!.costUsd)}
            </span>
          </div>
        )}
        {hasTokenCount && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Tokens</span>
            <span className="detail-tokens">
              {formatTokens(agent.tokenUsage!.inputTokens + agent.tokenUsage!.outputTokens)} tok
            </span>
          </div>
        )}
      </div>
    </details>
  );
}

export function DetailPanel({ agent, send, onLaunch, onRequestComplete, detailPaneMode, wideDetailActive = true, terminalFocusMode = false, shortcutBindings = defaultShortcutBindings(), overview }: Props) {
  const [input, setInput] = useState('');
  const [showSnooze, setShowSnooze] = useState(false);
  const [showHookSettings, setShowHookSettings] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareHeaderShares, setShareHeaderShares] = useState<TaskShareSummary[]>([]);
  const [replySnippets, setReplySnippets] = useState<ReplySnippet[]>([]);
  const hookSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const showRightPaneButtonRef = useRef<HTMLButtonElement>(null);
  const hideRightPaneButtonRef = useRef<HTMLButtonElement>(null);
  const [permissionButtonsDisabled, setPermissionButtonsDisabled] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= NARROW_DETAIL_BREAKPOINT_PX : false,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { selectAgent, nextBottleneck, advanceEmptyEnter, snoozeAgent, setRelaunchTask, showSentOverlay, githubState, leftPane, setLeftPane, narrowTab, setNarrowTab, detailPaneMode: storedDetailPaneMode, setDetailPaneMode, handleAlert, suggestions, clearSuggestion, setFocusZone, focusZone, sttUrl, respondAllAgentIds, setRespondAllAgentIds, shortcutsArmed, armShortcuts } = useKookrStore();
  const serverStartedAt = useKookrStore((s) => s.serverStartedAt);
  const replyDraftScope = { taskId: agent?.taskId, agentId: agent?.agentId };

  // Right-pane mode for the Activity+Terminal|Diff|File split.
  const [rightPane, setRightPane] = useState<'terminal' | 'diff' | 'file'>('terminal');
  const [activeDiff, setActiveDiff] = useState<
    { agentId: string; toolUseId: string; filePath: string; openedAt: string | null } | null
  >(null);
  const [activeFile, setActiveFile] = useState<
    { filePath: string; openedAt: string | null } | null
  >(null);
  // Element that had focus when the diff opened — restored on close for a11y.
  const diffTriggerRef = useRef<HTMLElement | null>(null);
  // Same for the file viewer pane.
  const fileTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function updateViewportMode() {
      setIsNarrowViewport(window.innerWidth <= NARROW_DETAIL_BREAKPOINT_PX);
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    return () => window.removeEventListener('resize', updateViewportMode);
  }, []);

  useEffect(() => {
    function normalizeReplySnippets(raw: unknown): ReplySnippet[] {
      if (!Array.isArray(raw)) return [];
      return raw.filter((entry): entry is ReplySnippet => (
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as { label?: unknown }).label === 'string' &&
        typeof (entry as { text?: unknown }).text === 'string' &&
        (entry as { label: string }).label.trim().length > 0 &&
        (entry as { text: string }).text.trim().length > 0
      ));
    }

    let cancelled = false;
    async function loadReplySnippets() {
      try {
        const { ok, body } = await getSettingsSnapshot<{ replySnippets?: unknown }>();
        if (!ok) return;
        if (!cancelled) setReplySnippets(normalizeReplySnippets(body?.replySnippets));
      } catch {
        if (!cancelled) setReplySnippets([]);
      }
    }

    function handleSettingsUpdated(event: Event) {
      const detail = event instanceof CustomEvent ? detailFromCustomEvent(event) : undefined;
      setReplySnippets(normalizeReplySnippets(detail?.replySnippets));
    }

    function detailFromCustomEvent(event: CustomEvent): { replySnippets?: unknown } | undefined {
      return typeof event.detail === 'object' && event.detail !== null
        ? event.detail as { replySnippets?: unknown }
        : undefined;
    }

    void loadReplySnippets();
    window.addEventListener('kookr:settings-updated', handleSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('kookr:settings-updated', handleSettingsUpdated);
    };
  }, []);

  useEffect(() => {
    // The header is a lightweight hint; if sharing is unavailable or the
    // status refresh fails, keep the primary Share action available.
    if (!agent?.taskId || typeof fetch !== 'function') {
      setShareHeaderShares((current) => current.length === 0 ? current : []);
      return;
    }

    let cancelled = false;
    setShareHeaderShares((current) => current.length === 0 ? current : []);
    async function loadShareHeader() {
      try {
        const { ok, status, body } = await getTaskShares();
        if (cancelled) return;
        if (status === 409) {
          setShareHeaderShares((current) => current.length === 0 ? current : []);
          return;
        }
        if (!ok) throw new Error(`share-list-${status}`);
        const shares = body?.shares;
        setShareHeaderShares(Array.isArray(shares) ? shares : []);
      } catch {
        if (!cancelled) setShareHeaderShares((current) => current.length === 0 ? current : []);
      }
    }

    void loadShareHeader();
    const timer = window.setInterval(() => {
      void loadShareHeader();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agent?.taskId]);

  // Clear diff/file state when the selected agent changes. Avoids showing stale
  // content bound to a different agent's toolUseId or worktree.
  useEffect(() => {
    setActiveDiff(null);
    setActiveFile(null);
    setRightPane('terminal');
    diffTriggerRef.current = null;
    fileTriggerRef.current = null;
  }, [agent?.agentId]);

  function handleOpenDiff(target: DiffClickTarget) {
    if (!agent) return;
    // Capture the trigger so we can restore focus when the diff closes.
    const active = document.activeElement;
    diffTriggerRef.current = active instanceof HTMLElement ? active : null;
    setActiveDiff({
      agentId: agent.agentId,
      toolUseId: target.toolUseId,
      filePath: target.filePath,
      openedAt: serverStartedAt,
    });
    setRightPane('diff');
  }

  function handleOpenFile(filePath: string) {
    if (!agent) return;
    const active = document.activeElement;
    fileTriggerRef.current = active instanceof HTMLElement ? active : null;
    setActiveFile({ filePath, openedAt: serverStartedAt });
    setRightPane('file');
  }

  function handleCloseFile() {
    setRightPane('terminal');
    const trigger = fileTriggerRef.current;
    if (trigger && document.body.contains(trigger)) {
      trigger.focus();
    }
  }

  function handleCloseDiff() {
    setRightPane('terminal');
    // Restore focus to the triggering element if it's still in the DOM.
    // Falls back to the Diff mode button if not.
    const trigger = diffTriggerRef.current;
    if (trigger && document.body.contains(trigger)) {
      trigger.focus();
    }
  }

  // While the Diff or File pane is active, intercept Escape at capture phase so
  // it closes that pane (our intent) instead of reaching the window-level
  // handler in App.tsx that would deselect the agent. When neither is shown,
  // Escape reverts to its normal global behavior.
  //
  // Route through the matching close handler so focus restoration runs for
  // keyboard dismissals the same way it does for the close button.
  const handleCloseDiffRef = useRef(handleCloseDiff);
  handleCloseDiffRef.current = handleCloseDiff;
  const handleCloseFileRef = useRef(handleCloseFile);
  handleCloseFileRef.current = handleCloseFile;
  useEffect(() => {
    if (rightPane !== 'diff' && rightPane !== 'file') return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (rightPane === 'file') handleCloseFileRef.current();
        else handleCloseDiffRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [rightPane]);

  // Auto-focus the reply input only on a real anomaly *transition* (null→type,
  // type-change, or agent-switch), and never while the user has an active text
  // selection. See `shouldAutoFocusReply` for the rule table.
  const prevAnomalyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const currentKey = anomalyTransitionKey(agent?.agentId, agent?.anomaly?.type);
    const prevKey = prevAnomalyKeyRef.current;
    prevAnomalyKeyRef.current = currentKey;
    const selectionLength = window.getSelection()?.toString().length ?? 0;
    if (shouldAutoFocusReply({ currentKey, prevKey, selectionLength, activeElement: document.activeElement })) {
      inputRef.current?.focus();
    }
  }, [agent?.agentId, agent?.anomaly?.type]);

  useEffect(() => {
    setInput(agent ? loadDetailReplyDraft(replyDraftScope) : '');
  }, [agent?.taskId, agent?.agentId]);

  // Auto-grow the reply textarea with its content (1 row up to ~6 rows), then
  // scroll internally. Runs on every input change so drafts, typing, and voice
  // transcripts all resize consistently.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, REPLY_MAX_HEIGHT_PX)}px`;
  }, [input]);

  // Reset permission button disabled state when agent or suggestions change
  const suggestion = agent ? suggestions[agent.agentId] ?? null : null;
  useEffect(() => {
    setPermissionButtonsDisabled(false);
  }, [agent?.agentId, suggestion]);

  if (!agent) {
    return (
      <div className="detail-panel kookr-tour-target-layout">
        <OverviewEmptyState
          waiting={overview?.waiting ?? []}
          runningCount={overview?.runningCount ?? 0}
          completedCount={overview?.completedCount ?? 0}
          onLaunch={onLaunch}
          shortcutBindings={shortcutBindings}
        />
      </div>
    );
  }

  function setReplyInput(nextInput: string) {
    setInput(nextInput);
    saveDetailReplyDraft(replyDraftScope, nextInput);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setReplyInput(e.target.value);
  }

  function insertReplySnippet(snippetText: string) {
    const textarea = inputRef.current;
    const start = textarea?.selectionStart ?? input.length;
    const end = textarea?.selectionEnd ?? start;
    const nextInput = `${input.slice(0, start)}${snippetText}${input.slice(end)}`;
    const nextCursor = start + snippetText.length;
    setReplyInput(nextInput);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  // Combine pattern-matched quick actions and AI suggestions into a unified button list
  const quickActions = suggestion
    ? [
        ...suggestion.quickActions.map(qa => ({ ...qa, isAi: false })),
        ...suggestion.suggestions
          .filter(s => !suggestion.quickActions.some(qa => qa.value === s))
          .map((s, i) => ({ label: stripMarkdown(truncate(s, 100)), value: s, isAi: true, shortcut: undefined as string | undefined })),
      ]
    : [];

  function handleQuickAction(value: string, isAi: boolean = false, shortcutKey?: string) {
    if (!agent) return;
    const agentName = agent.taskName ?? agent.agentId;
    const method = shortcutKey ? 'shortcut' : isAi ? 'suggestion' : 'quick_action';
    track({ type: 'response_sent', agentId: agent.agentId, method, charCount: value.length, anomalyType: agent.anomaly?.type ?? null });
    if (isAi) {
      track({ type: 'suggestion_accepted', agentId: agent.agentId });
    } else {
      track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: value.slice(0, 50) });
    }
    if (shortcutKey) {
      track({ type: 'shortcut_used', key: shortcutKey, action: 'quick_action', context: 'input_focused' });
    }
    let sent: boolean;
    if (respondAllAgentIds) {
      sent = send({ type: 'respondAll', agentIds: respondAllAgentIds, input: value });
      setRespondAllAgentIds(null);
    } else if (isDirectReply) {
      sent = send({ type: 'directReply', agentId: agent.agentId, input: value });
    } else {
      sent = send({ type: 'respond', agentId: agent.agentId, input: value });
    }
    if (!sent) {
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    setInput('');
    clearDetailReplyDraft(replyDraftScope);
    clearSuggestion(agent.agentId);
    showSentOverlay(agentName);
    if (!isDirectReply) {
      nextBottleneck();
    }
  }

  // Check if quick actions are permission-type (have keystroke field)
  const isPermissionActions = quickActions.length > 0 && 'keystroke' in (suggestion?.quickActions[0] ?? {});

  function handlePermissionChoice(action: { keystroke?: string; permissionRequest?: PermissionRequestBinding }) {
    const { keystroke, permissionRequest } = action;
    if (!agent || permissionButtonsDisabled) return;
    if (!keystroke) return;
    if (!permissionRequest) return;
    setPermissionButtonsDisabled(true);
    track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: `permission:${keystroke}` });
    const sent = send({ type: 'permissionChoice', agentId: agent.agentId, keystroke, permissionRequest });
    if (!sent) {
      setPermissionButtonsDisabled(false);
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    clearSuggestion(agent.agentId);
    const agentName = agent.taskName ?? agent.agentId;
    showSentOverlay(agentName);
    nextBottleneck();
  }

  const isDirectReply = !agent?.anomaly;

  /**
   * Send the composed reply. The Send button stays on the current task; Enter
   * and Send & Next advance after a finding reply. Direct replies to healthy
   * tasks always stay on the current task.
   */
  function handleSend(opts: { viaShortcut?: boolean; andNext?: boolean; shortcutKey?: string } = {}) {
    const { viaShortcut = false, andNext = false, shortcutKey } = opts;
    if (!input.trim() || !agent) return;
    const agentName = agent.taskName ?? agent.agentId;
    track({ type: 'response_sent', agentId: agent.agentId, method: viaShortcut ? 'shortcut' : 'input_box', charCount: input.trim().length, anomalyType: agent.anomaly?.type ?? null });
    if (viaShortcut) {
      track({
        type: 'shortcut_used',
        key: shortcutKey ?? (andNext ? 'Ctrl+Enter' : 'Enter'),
        action: isDirectReply ? 'direct_reply' : andNext ? 'send_and_next' : 'send_stay',
        context: 'input_focused',
      });
    }
    // If suggestion text was available but user typed their own, track as ignored
    if (suggestion && suggestion.suggestions.length > 0) {
      track({ type: 'suggestion_ignored', agentId: agent.agentId });
    }
    let sent: boolean;
    if (respondAllAgentIds) {
      sent = send({ type: 'respondAll', agentIds: respondAllAgentIds, input: input.trim() });
      setRespondAllAgentIds(null);
    } else if (isDirectReply) {
      sent = send({ type: 'directReply', agentId: agent.agentId, input: input.trim() });
    } else {
      sent = send({ type: 'respond', agentId: agent.agentId, input: input.trim() });
    }
    if (!sent) {
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    setInput('');
    clearDetailReplyDraft(replyDraftScope);
    clearSuggestion(agent.agentId);
    showSentOverlay(agentName);
    if (andNext && !isDirectReply) {
      nextBottleneck();
    }
  }

  function handleSkip() {
    if (!agent) return;
    track({ type: 'finding_skipped', agentId: agent.agentId, anomalyType: agent.anomaly?.type ?? null, method: 'button' });
    trackClick('skip');
    send({ type: 'skip', agentId: agent.agentId });
    nextBottleneck();
  }

  function handleSnooze(durationMs: number) {
    if (!agent) return;
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, durationMs });
    snoozeAgent(agent.agentId, durationMs);
  }

  async function handleRelaunch() {
    if (!agent) return;
    track({ type: 'task_relaunched', agentId: agent.agentId });

    // For playbook tasks, include playbook context so the launch dialog
    // can open the playbook form pre-filled with original parameter values
    if (agent.playbookId && agent.playbookParameterValues) {
      setRelaunchTask({
        prompt: agent.description ?? '',
        cwd: agent.cwd ?? '',
        agentType: agent.agentType,
        playbookId: agent.playbookId,
        playbookParameterValues: agent.playbookParameterValues,
      });
      return;
    }

    try {
      // Relaunch needs the full prompt/criteria bodies, so fetch this one task's
      // detail (GET /api/tasks/:id) rather than the whole list. The list endpoint
      // now serves a compact projection that omits prompt bodies.
      if (!agent.taskId) return;
      const task = await getTask<RelaunchTask & { error?: unknown }>(agent.taskId);
      if (task && !task.error) {
        setRelaunchTask({ prompt: task.prompt, cwd: task.cwd, criteria: task.criteria, agentType: task.agentType });
      }
    } catch { /* ignore fetch errors */ }
  }

  function handleComplete() {
    if (!agent?.taskId) return;
    trackClick('complete_task');
    onRequestComplete();
  }

  function handleReflect() {
    if (!agent?.taskId) return;
    trackClick('task_snapshot_reflect');
    // Optional steering hint: why the user is reflecting (e.g. "liked being
    // asked for e2e tests"). Blank or cancelled input reflects with no hint,
    // preserving the previous one-click behavior.
    const raw = prompt('Why are you reflecting? Add an optional hint to steer the analysis (leave blank to skip):');
    const hint = raw?.trim();
    send({ type: 'requestTaskSnapshotReflect', taskId: agent.taskId, ...(hint ? { hint } : {}) });
  }

  function handleCancel() {
    if (!agent?.taskId) return;
    if (!confirm(`Cancel task "${agent.taskName ?? agent.agentId}"? The agent session will be terminated.`)) return;
    track({ type: 'task_cancelled', agentId: agent.agentId, method: 'button' });
    trackClick('cancel_task');
    send({ type: 'cancelTask', taskId: agent.taskId });
  }

  function handleEmptyEnterAdvance() {
    if (!agent) return;
    // Empty Enter is pure navigation — it never dismisses a finding. The
    // finding-vs-healthy cursor rule lives in the store (advanceEmptyEnter) so
    // the reply input, the terminal, and the global window handler stay in sync.
    // Local dashboard navigation must not depend on terminal readiness: the
    // server-side terminal-input coordinator can lag until an idle notification
    // arrives, which made empty Enter appear to work once and then stall.
    track({ type: 'shortcut_used', key: 'Enter', action: 'advance_empty_input', context: 'input_focused' });
    advanceEmptyEnter();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Ctrl/Cmd+Enter: send and jump to the next finding.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!input.trim()) return;
      handleSend({ viaShortcut: true, andNext: true });
      return;
    }
    // Guard: skip Enter during IME composition (e.g., CJK input) or browser
    // autocomplete acceptance — these fire keydown with key='Enter' but the user
    // intends to confirm the composition, not to send the message.
    // Shift+Enter falls through to insert a newline in the textarea.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!input.trim()) {
        handleEmptyEnterAdvance();
        return;
      }
      // Plain Enter advances after a finding reply, but healthy direct replies
      // stay on the current task.
      handleSend({ viaShortcut: true, andNext: !isDirectReply && !respondAllAgentIds, shortcutKey: 'Enter' });
      return;
    }
    // Number keys 1-5 trigger quick actions (only when input is empty AND shortcuts armed)
    if (!input && quickActions.length > 0 && shortcutsArmed && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= quickActions.length) {
        e.preventDefault();
        if (isPermissionActions) {
          handlePermissionChoice(quickActions[num - 1]);
        } else {
          handleQuickAction(quickActions[num - 1].value, quickActions[num - 1].isAi, String(num));
        }
        return;
      }
    }
    // Any non-number keypress = deliberate interaction → arm shortcuts
    armShortcuts();
  }

  // A `needs_input` finding derived from a normal Stop is a completion signal,
  // not an explicit question — keep the detail badge consistent with the
  // finding card's "Signaled Complete" presentation. See issue #358.
  const isCompletedTurn = agent.anomaly?.type === 'needs_input'
    && agent.turnState === 'completed_turn';

  // Agent → user signal (RFC: rfc-agent-signal-surface). Show a non-modal
  // banner while the task is active; only emphasise Complete (pulse) when the
  // agent is actually idle (completed_turn) so a signal raised mid-work never
  // invites premature completion.
  const pendingSignal = agent.pendingSignal;
  // Operator-needed flag (issue #1562): an unattended agent tried a denied
  // interactive tool. Surfaced as a header badge + banner so the block is
  // visible instead of the agent hanging on an unanswerable prompt.
  const operatorNeeded = agent.operatorNeeded;
  const hasDerivedCompletionSignal = !!agent.latestCompletionSignal && isCompletedTurn;
  const showSignalBanner = (!!pendingSignal || hasDerivedCompletionSignal)
    && agent.taskStatus !== 'pending'
    && !isTerminalTaskStatus(agent.taskStatus);
  const signalCompleteReady = showSignalBanner && isCompletedTurn;
  const badgeClass = agent.anomaly
    ? agent.anomaly.type === 'permission_blocked' ? 'permission'
      : agent.anomaly.type === 'repeated_error' ? 'error'
      : isCompletedTurn ? 'turn-complete'
      : 'input'
    : '';
  const badgeLabel = agent.anomaly
    ? isCompletedTurn ? 'SIGNALED COMPLETE' : agent.anomaly.type.replace('_', ' ').toUpperCase()
    : 'RUNNING';
  const agentProvider = agent.agentType ? agentProviderPresentation(agent.agentType) : null;
  const taskGitHubState = agent.taskId ? githubState[agent.taskId] : undefined;
  const nextStepRecommendations = deriveTaskNextStepRecommendations(agent, taskGitHubState?.prs ?? []);
  const shareHeaderStatus = deriveTaskShareHeaderStatus(agent.taskId, shareHeaderShares);
  const requestedDetailPaneMode = detailPaneMode ?? (terminalFocusMode ? 'right' : storedDetailPaneMode);
  const splitRenderingTaskVisible = !(isTerminalTaskStatus(agent.taskStatus) && agent.completionDigest);
  const effectiveDetailPaneMode: DetailPaneMode = wideDetailActive && splitRenderingTaskVisible ? requestedDetailPaneMode : 'split';
  const rightOnlyMode = effectiveDetailPaneMode === 'right';
  const leftOnlyMode = effectiveDetailPaneMode === 'left';
  const showLeftPane = !rightOnlyMode;
  const showRightPane = !leftOnlyMode;
  const showEvolutionPanel = Boolean(agent.taskId && agent.playbookId === 'autonomous-evolution.md');

  function focusNextFrame(ref: React.RefObject<HTMLElement | null>) {
    window.requestAnimationFrame(() => ref.current?.focus());
  }

  function hideRightPane() {
    setDetailPaneMode('left');
    focusNextFrame(showRightPaneButtonRef);
  }

  function showBothPanesFromLeft() {
    setDetailPaneMode('split');
    focusNextFrame(hideRightPaneButtonRef);
  }

  function showBothPanesFromRight() {
    setDetailPaneMode('split');
    focusNextFrame(hideRightPaneButtonRef);
  }

  function handleNextStepAction(recommendation: NextStepRecommendation) {
    track({
      type: 'quick_action_clicked',
      agentId: agent.agentId,
      actionLabel: `next_step:${recommendation.id}`,
    });
  }

  return (
    <div className={`detail-panel kookr-tour-target-layout${rightOnlyMode ? ' terminal-focus' : ''}${leftOnlyMode ? ' detail-left-only' : ''}`} data-testid="detail-panel">
      <div className="detail-header">
        <div className="detail-header-left">
          <EditableHeading agent={agent} send={send} />
          {agent.playbookId && <span className="detail-badge playbook">Playbook</span>}
          {agent.taskStatus === 'pending' && <span className="detail-badge pending">Pending</span>}
          {agent.launchPermissionPosture?.bypassAllPermissions && (
            <span
              className="detail-badge permission-bypassed"
              title="This task was launched while KOOKR_BYPASS_ALL_PERMISSIONS was active"
              data-testid="task-permission-bypass-badge"
            >
              Permissions bypassed
            </span>
          )}
          {agent.anomaly && <span className={`detail-badge ${badgeClass}`}>{badgeLabel}</span>}
          {operatorNeeded && (
            <span
              className="detail-badge permission"
              title={operatorNeeded.message}
              data-testid="task-operator-needed-badge"
            >
              Operator needed
            </span>
          )}
        </div>
        <div className="detail-header-right">
          <TaskIdCopyButton taskId={agent.taskId} />
          {agent.taskId && (
            <button
              type="button"
              data-testid="task-share-button"
              className={`action-btn action-btn--neutral task-share-header-button task-share-header-button--${shareHeaderStatus.kind}`}
              title={shareHeaderStatus.title}
              aria-label={shareHeaderStatus.title}
              onClick={() => setShowShareModal(true)}
            >
              <span>{shareHeaderStatus.buttonLabel}</span>
              {shareHeaderStatus.badgeLabel && (
                <span className="task-share-header-badge">{shareHeaderStatus.badgeLabel}</span>
              )}
            </button>
          )}
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`detail-header-warning worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          {agent.startedAt && <span>{formatDuration(agent.startedAt)}</span>}
          <DetailMetadataMenu
            agent={agent}
            provider={agentProvider}
            hookSettingsTriggerRef={hookSettingsTriggerRef}
            onShowHookSettings={() => setShowHookSettings(true)}
          />
          {agent.taskId && agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && (
            <>
              <button data-testid="action-complete" className={`action-btn action-btn--success${signalCompleteReady ? ' action-btn--signal-ready' : ''}`} onClick={handleComplete}>Complete</button>
              <button
                data-testid="action-reflect"
                className="action-btn action-btn--reflect"
                title="Analyze this task without changing its status"
                onClick={handleReflect}
              >
                Reflect
              </button>
              <button data-testid="action-cancel" className="action-btn action-btn--danger" onClick={handleCancel}>Cancel</button>
            </>
          )}
          {agent.taskId && agent.taskStatus === 'pending' && (
            <button className="action-btn action-btn--danger" onClick={handleCancel}>Cancel</button>
          )}
          {/* Terminated means the session died before the user marked it done. Keep that flow separate from ordinary Complete. */}
          {agent.taskId && agent.taskStatus === 'terminated' && (
            <button
              className="action-btn action-btn--success"
              title="Mark this unexpectedly terminated task as done"
              onClick={() => send({ type: 'ackTerminatedTask', taskId: agent.taskId! })}
            >
              Mark as done
            </button>
          )}
          {agent.taskId && isTerminalTaskStatus(agent.taskStatus) && (
            <>
              <button
                data-testid="action-reflect"
                className="action-btn action-btn--reflect"
                title="Analyze this task without changing its status"
                onClick={handleReflect}
              >
                Reflect
              </button>
              <button className="action-btn action-btn--neutral" onClick={() => send({ type: 'reopenTask', taskId: agent.taskId! })}>Reopen</button>
              <button className="action-btn action-btn--neutral" onClick={handleRelaunch}>Relaunch</button>
            </>
          )}
          {/* Cross-agent migration (RFC: rfc-cross-agent-task-migration): terminated,
              cancelled, or inProgress-but-interrupted tasks — not completed, and not
              actively running (the server rejects a live session with a clear reason). */}
          {agent.taskId
            && (agent.taskStatus === 'terminated' || agent.taskStatus === 'cancelled' || agent.taskStatus === 'inProgress') && (
            <MigrateTaskControl taskId={agent.taskId} currentAgentType={agent.agentType} />
          )}
        </div>
      </div>
      {showSignalBanner && agent.taskId && (
        <div
          className={`detail-signal-banner${signalCompleteReady ? ' detail-signal-banner--ready' : ''}`}
          role="status"
          aria-live="polite"
          data-testid="agent-signal-banner"
        >
          <span className="detail-signal-banner__text">
            <strong>Agent:</strong>{' '}
            {signalCompleteReady
              ? 'ready for review — complete this task?'
              : 'flagged ready (still working — review when idle)'}
            {pendingSignal?.note ? ` — ${pendingSignal.note}` : ''}
          </span>
          {pendingSignal && !hasDerivedCompletionSignal && (
            <button
              type="button"
              className="action-btn action-btn--neutral"
              data-testid="agent-signal-dismiss"
              onClick={() => send({ type: 'dismissAgentSignal', taskId: agent.taskId! })}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {operatorNeeded && (
        <div
          className="detail-signal-banner detail-signal-banner--attention"
          role="status"
          aria-live="polite"
          data-testid="agent-operator-needed-banner"
        >
          <span className="detail-signal-banner__text">
            <strong>Operator needed:</strong> {operatorNeeded.message}
          </span>
        </div>
      )}
      {agent.anomaly?.transcriptContext?.lastAssistantMessage && (
        <div className="detail-transcript-context" data-testid="detail-transcript-context">
          <div className="detail-transcript-context-label">Last agent message</div>
          <div className="detail-transcript-context-text">
            {agent.anomaly.transcriptContext.lastAssistantMessage.excerpt}
            {agent.anomaly.transcriptContext.lastAssistantMessage.truncated ? '...' : ''}
          </div>
        </div>
      )}
      {agent.taskId && (
        <TaskShareModal
          taskId={agent.taskId}
          taskLabel={agent.taskName ?? agent.agentId}
          open={showShareModal}
          onClose={() => setShowShareModal(false)}
          onSharesChanged={setShareHeaderShares}
        />
      )}
      {!rightOnlyMode && agent.taskId && <CoordinatorChainStripView agent={agent} />}
      {!rightOnlyMode && agent.taskId && <TaskDependencyEditor agent={agent} />}
      {!rightOnlyMode && agent.taskId && <TaskDependencyRail agent={agent} />}
      <TaskNextActionsPanel
        agentId={agent.agentId}
        recommendations={nextStepRecommendations}
        onRelaunch={handleRelaunch}
        onReflect={handleReflect}
        onAction={handleNextStepAction}
      />
      {!rightOnlyMode && showEvolutionPanel && (
        <Suspense fallback={null}>
          <EvolutionPanel taskId={agent.taskId!} />
        </Suspense>
      )}

      {/* Side-by-side split (wide) + tab fallback (narrow) */}
      {(() => {
        const gh = taskGitHubState;
        const ghCount = (gh?.prs.length ?? 0) + (gh?.issues.length ?? 0);
        const isCompleted = isTerminalTaskStatus(agent.taskStatus);
        const terminalVisible = showRightPane && (
          rightOnlyMode ? rightPane === 'terminal' : computeTerminalVisible({ rightPane, isNarrowViewport, narrowTab })
        );

        // Completion digest replaces both panes
        if (isCompleted && agent.completionDigest) {
          const digestHeading = agent.taskStatus === 'cancelled'
            ? 'Cancelled'
            : agent.taskStatus === 'terminated'
              ? 'Terminated'
              : 'Completed';
          return (
            <div className="detail-content">
              <div className="detail-digest">
                <h3>{digestHeading}</h3>
                <ul>
                  {agent.completionDigest.bullets.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
                {agent.completionDigest.filesChanged.length > 0 && (
                  <div className="detail-digest-files">
                    <strong>Files changed:</strong> {agent.completionDigest.filesChanged.join(', ')}
                  </div>
                )}
                <CriteriaVerdictBlock digest={agent.completionDigest} />
              </div>
            </div>
          );
        }

        return (
          <>
            {/* Narrow-mode tab bar (hidden on wide viewports via CSS) */}
            {!rightOnlyMode && <div className="detail-tabs-narrow">
              <button
                className={`detail-tab ${narrowTab === 'activity' ? 'active' : ''}`}
                aria-pressed={narrowTab === 'activity'}
                onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'activity' }); setNarrowTab('activity'); setLeftPane('activity'); }}
              >
                Activity
              </button>
              <button
                className={`detail-tab ${narrowTab === 'terminal' ? 'active' : ''}`}
                aria-pressed={narrowTab === 'terminal'}
                onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'terminal' }); setNarrowTab('terminal'); }}
              >
                Terminal
              </button>
              {ghCount > 0 && (
                <button
                  className={`detail-tab ${narrowTab === 'github' ? 'active' : ''}`}
                  aria-pressed={narrowTab === 'github'}
                  onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'github' }); setNarrowTab('github'); setLeftPane('github'); }}
                >
                  GitHub ({ghCount})
                </button>
              )}
            </div>}

            {/* Side-by-side split container */}
            <div className={`detail-split${rightOnlyMode ? ' detail-split-terminal-focus' : ''}${leftOnlyMode ? ' detail-split-left-only' : ''}`}>
              {/* Left pane: Activity or GitHub */}
              {showLeftPane && <div className={`detail-split-left${narrowTab !== 'activity' && narrowTab !== 'github' ? ' pane-hidden-narrow' : ''}`}>
                <div className="detail-pane-header">
                  <button
                    className={`pane-tab ${leftPane === 'activity' ? 'active' : ''}`}
                    aria-pressed={leftPane === 'activity'}
                    onClick={() => { track({ type: 'tab_switched', from: leftPane, to: 'activity' }); setLeftPane('activity'); setNarrowTab('activity'); }}
                  >
                    Activity
                  </button>
                  {ghCount > 0 && (
                    <button
                      className={`pane-tab ${leftPane === 'github' ? 'active' : ''}`}
                      aria-pressed={leftPane === 'github'}
                      onClick={() => { track({ type: 'tab_switched', from: leftPane, to: 'github' }); setLeftPane('github'); setNarrowTab('github'); }}
                    >
                      GitHub ({ghCount})
                    </button>
                  )}
                  {leftOnlyMode && (
                    <button
                      ref={showRightPaneButtonRef}
                      type="button"
                      className="pane-control"
                      aria-label="Show terminal/diff pane"
                      title="Show terminal/diff pane"
                      onClick={showBothPanesFromLeft}
                    >
                      Show terminal/diff
                    </button>
                  )}
                </div>
                {leftPane === 'github' && ghCount > 0 ? (
                  <Suspense fallback={null}>
                    <GitHubPanel prs={gh?.prs ?? []} issues={gh?.issues ?? []} />
                  </Suspense>
                ) : (
                  <Suspense fallback={null}>
                    <ActivityPanel
                      agentId={agent.agentId}
                      events={agent.events}
                      description={agent.description}
                      cwd={agent.cwd}
                      anomalyExplanation={agent.anomaly?.explanation}
                      onOpenDiff={handleOpenDiff}
                      activityMeta={agent.activityMeta}
                      taskId={agent.taskId}
                      isActive={agent.turnState === 'running'}
                      userInputDeliveries={agent.userInputDeliveries}
                    />
                  </Suspense>
                )}
              </div>}

              {/* Right pane: Terminal or Diff (terminal stays mounted for UI
                  state, but byte-stream subscription follows visibility) */}
              <div className={`detail-split-right${!rightOnlyMode && narrowTab !== 'terminal' ? ' pane-hidden-narrow' : ''}${!showRightPane ? ' pane-hidden-wide' : ''}`}>
                <div className="detail-pane-header">
                  <button
                    type="button"
                    className={`pane-tab ${rightPane === 'terminal' ? 'active' : ''}`}
                    aria-pressed={rightPane === 'terminal'}
                    onClick={() => setRightPane('terminal')}
                  >
                    Terminal
                  </button>
                  {activeDiff && (
                    <button
                      type="button"
                      className={`pane-tab ${rightPane === 'diff' ? 'active' : ''}`}
                      aria-pressed={rightPane === 'diff'}
                      onClick={() => setRightPane('diff')}
                    >
                      Diff
                    </button>
                  )}
                  {rightOnlyMode ? (
                    <button
                      type="button"
                      className="pane-control"
                      aria-label="Show Activity/GitHub pane"
                      title="Show Activity/GitHub pane"
                      onClick={showBothPanesFromRight}
                    >
                      Show Activity/GitHub
                    </button>
                  ) : (
                    <button
                      ref={hideRightPaneButtonRef}
                      type="button"
                      className="pane-control"
                      aria-label="Hide terminal/diff pane"
                      title="Hide terminal/diff pane"
                      onClick={hideRightPane}
                    >
                      Hide terminal/diff
                    </button>
                  )}
                </div>
                <div className={`right-pane-stack right-pane-${rightPane}`}>
                  <div
                    className="right-pane-slot right-pane-slot-terminal"
                    style={{ display: rightPane === 'terminal' ? 'flex' : 'none' }}
                  >
                    <Suspense fallback={null}>
                      <TerminalPanel
                        tmuxName={agent.agentId}
                        agentType={agent.agentType}
                        visible={terminalVisible}
                        onEmptySubmit={handleEmptyEnterAdvance}
                        onOpenFile={handleOpenFile}
                      />
                    </Suspense>
                  </div>
                  {activeDiff && (
                    <div
                      className="right-pane-slot right-pane-slot-diff"
                      style={{ display: rightPane === 'diff' ? 'flex' : 'none' }}
                    >
                      <Suspense fallback={null}>
                        <DiffPane
                          agentId={activeDiff.agentId}
                          toolUseId={activeDiff.toolUseId}
                          filePath={activeDiff.filePath}
                          openedAt={activeDiff.openedAt}
                          onClose={handleCloseDiff}
                        />
                      </Suspense>
                    </div>
                  )}
                  {activeFile && (
                    <div
                      className="right-pane-slot right-pane-slot-file"
                      style={{ display: rightPane === 'file' ? 'flex' : 'none' }}
                    >
                      <Suspense fallback={null}>
                        <FileViewerPane
                          filePath={activeFile.filePath}
                          openedAt={activeFile.openedAt}
                          onClose={handleCloseFile}
                        />
                      </Suspense>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Response area */}
      <div className={`response-area${focusZone === 'response-input' ? ' zone-active' : ''}${agent.anomaly?.type === 'needs_input' ? ' awaiting-input' : ''}`}>
        {respondAllAgentIds && (
          <div className="respond-all-banner">
            Responding to {respondAllAgentIds.length} agents
            <button className="btn-xs" onClick={() => setRespondAllAgentIds(null)}>Cancel</button>
          </div>
        )}
        {quickActions.length > 0 && (
          <div className="quick-actions">
            {isPermissionActions
              ? quickActions.map((action) => (
                <button
                  key={action.value}
                  className="btn-quick-action permission-action"
                  onClick={() => handlePermissionChoice(action)}
                  disabled={permissionButtonsDisabled}
                  title={action.value}
                >
                  <span>{action.label}</span>
                </button>
              ))
              : quickActions.map((action, i) => (
                <button
                  key={action.value}
                  className={`btn-quick-action${action.isAi ? ' ai-suggestion' : ''}`}
                  onClick={() => handleQuickAction(action.value, action.isAi)}
                  title={action.value.length > 100 ? action.value : undefined}
                >
                  <kbd>{action.shortcut ?? String(i + 1)}</kbd>
                  <span>{action.label}</span>
                </button>
              ))
            }
          </div>
        )}
        {replySnippets.length > 0 && (
          <div className="reply-snippet-picker">
            <label className="reply-snippet-picker-label" htmlFor="reply-snippet-picker">
              Saved replies
            </label>
            <select
              id="reply-snippet-picker"
              className="reply-snippet-picker-select"
              value=""
              onChange={(e) => {
                const snippet = replySnippets[Number(e.target.value)];
                if (snippet) insertReplySnippet(snippet.text);
              }}
            >
              <option value="" disabled>Insert snippet...</option>
              {replySnippets.map((snippet, index) => (
                <option key={`${snippet.label}-${index}`} value={index}>{snippet.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="response-row">
          <textarea
            ref={inputRef}
            rows={1}
            className=""
            autoComplete="off"
            placeholder={
              isDirectReply
                ? `Message ${agent.taskName ?? agent.agentId}...`
                : agent.turnState === 'completed_turn'
                  ? `Signaled complete — review or send a follow-up to ${agent.taskName ?? agent.agentId}...`
                  : agent.anomaly?.type === 'needs_input'
                    ? `${agent.taskName ?? agent.agentId} is waiting — send a hint...`
                    : `Send a hint to ${agent.taskName ?? agent.agentId}...`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onMouseDown={armShortcuts}
            onFocus={() => { track({ type: 'focus_zone_changed', from: focusZone, to: 'response-input' }); setFocusZone('response-input'); }}
            onBlur={() => { if (focusZone === 'response-input') { track({ type: 'focus_zone_changed', from: 'response-input', to: 'none' }); setFocusZone('none'); } }}
          />
          {sttUrl && (
            <Suspense fallback={null}>
              <VoiceInputButton
                inputId="response-input"
                onTranscript={setReplyInput}
                disabled={!agent}
                shortcutBinding={shortcutBindings.stt_toggle}
              />
            </Suspense>
          )}
          <button
            className="btn-primary"
            data-testid="send-button"
            onClick={() => handleSend()}
            disabled={!input.trim()}
            title={!isDirectReply && !respondAllAgentIds ? 'Send and stay on this task' : undefined}
          >
            {respondAllAgentIds ? `Send to All (${respondAllAgentIds.length})` : 'Send'}
          </button>
          {!isDirectReply && !respondAllAgentIds && (
            <button
              className="btn-secondary"
              data-testid="send-next-button"
              onClick={() => handleSend({ andNext: true })}
              disabled={!input.trim()}
              title="Send and jump to the next finding (Ctrl+Enter)"
            >
              Send & Next
            </button>
          )}
          {!isDirectReply && <button className="btn-secondary" onClick={() => handleSkip()}>Skip</button>}
          {!isDirectReply && <button className="btn-secondary" onClick={() => setShowSnooze(true)}>Snooze</button>}
        </div>
        {showSnooze && agent && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showHookSettings && agent && (
          <Suspense fallback={null}>
            <EffectiveHookSettingsModal
              sessionId={agent.agentId}
              onClose={() => {
                setShowHookSettings(false);
                hookSettingsTriggerRef.current?.focus();
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
