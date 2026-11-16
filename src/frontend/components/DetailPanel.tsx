import React, { useState, useRef, useEffect, useCallback, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { ChangesPanel as ChangesPanelComponent } from './ChangesPanel.js';
import type { ChangesEdit } from './ChangesPanel.js';
import { splitOwnPullRequests } from '../../shared/task-own-pull-requests.js';
import { lazyWithReload } from '../lazy-with-reload.js';
import { useShallow } from 'zustand/react/shallow';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage, PermissionRequestBinding } from '../../shared/protocol.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { track, trackClick } from '../telemetry.js';
import type { DiffClickTarget } from './ActivityPanel.js';
import { projectLabel, deriveTaskNextStepRecommendations, findingKindClass } from '../presentation.js';
import type { NextStepRecommendation } from '../presentation.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { shouldAutoFocusReply, anomalyTransitionKey } from './detail-panel-focus.js';
import { computeTerminalVisible, resolveDetailPaneLayout } from './detail-panel-visibility.js';
import { TaskShareModal } from './TaskShareModal.js';
import type { TaskShareSummary } from '../../shared/contracts/remote-share.js';
import { getSettingsSnapshot, getTaskShares } from '../api/index.js';
import { deriveTaskShareHeaderStatus } from './task-share-header-status.js';
import type { ReplySnippet } from '../../shared/contracts/reply-snippets.js';
import { CoordinatorChainStripView } from './CoordinatorSurfaces.js';
import { clearDetailReplyDraft, loadDetailReplyDraft, saveDetailReplyDraft } from '../store/detail-reply-draft.js';
import {
  detectShortcutPlatform,
  getDefaultShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { OverviewEmptyState } from './OverviewEmptyState.js';
import type { DetailPaneMode, LeftPane, NarrowTab } from '../store/store-types.js';
import { relaunchFromAgent } from '../relaunch-from-agent.js';
import { DetailHeaderActions } from './DetailPanel/DetailHeaderActions.js';
import { DetailMetaLine } from './DetailPanel/DetailMetaLine.js';
import { DecisionCard } from './DetailPanel/DecisionCard.js';
import { AgentSignalNotice, OperatorNeededNotice, type NoticePlacement } from './DetailPanel/AgentNotices.js';
import { TaskFactsColumn } from './DetailPanel/TaskFactsColumn.js';
import { usePaneAtLeast, FACTS_DOCK_MIN_PANE_PX } from './DetailPanel/use-pane-at-least.js';
import { appendDictation } from '../append-dictation.js';
import type { EmptyEnterAdvanceScreen } from '../terminal-input-draft.js';
import { useTerminalEmptyEnterAdvance } from '../store/terminal-empty-enter-pref.js';
import { TaskCompletionDigest } from './TaskCompletionDigest.js';
import { TranscriptView, TranscriptToggle } from './TranscriptView.js';

type LazyModule = Record<string, unknown> & { default?: Record<string, unknown> };

function pickLazyExport<T>(module: unknown, exportName: string): T {
  const lazyModule = module as LazyModule;
  return (lazyModule[exportName] ?? lazyModule.default?.[exportName]) as T;
}

const VoiceInputButton = lazyWithReload(() => import('./VoiceInputButton.js').then(m => ({ default: pickLazyExport<typeof m.VoiceInputButton>(m, 'VoiceInputButton') })));
const TerminalPanel = lazyWithReload(() => import('./TerminalPanel.js').then((m) => ({ default: pickLazyExport<typeof m.TerminalPanel>(m, 'TerminalPanel') })));
const GitHubPanel = lazyWithReload(() => import('./GitHubPanel.js').then((m) => ({ default: pickLazyExport<typeof m.GitHubPanel>(m, 'GitHubPanel') })));
// Typed through ComponentType<unknown> and back, so this lazy import adds no
// entry to the frontend type-error baseline (the gate counts the older ones).
const ChangesPanel = lazyWithReload(() => import('./ChangesPanel.js').then((m) => ({
  default: pickLazyExport<ComponentType<unknown>>(m, 'ChangesPanel'),
}))) as unknown as LazyExoticComponent<typeof ChangesPanelComponent>;
const ActivityPanel = lazyWithReload(() => import('./ActivityPanel.js').then((m) => ({ default: pickLazyExport<typeof m.ActivityPanel>(m, 'ActivityPanel') })));
const EvolutionPanel = lazyWithReload(() => import('./EvolutionPanel.js').then((m) => ({ default: pickLazyExport<typeof m.EvolutionPanel>(m, 'EvolutionPanel') })));
const FileViewerPane = lazyWithReload(() => import('./FileViewerPane.js').then((m) => ({ default: pickLazyExport<typeof m.FileViewerPane>(m, 'FileViewerPane') })));
const EffectiveHookSettingsModal = lazyWithReload(() => import('./EffectiveHookSettingsModal.js').then((m) => ({ default: pickLazyExport<typeof m.EffectiveHookSettingsModal>(m, 'EffectiveHookSettingsModal') })));
/** Max auto-grow height of the reply textarea (~6 rows incl. padding). */
const REPLY_MAX_HEIGHT_PX = 140;
/** Visible chip count in the response box; extras stay in the overflow dropdown. */
const REPLY_SNIPPET_CHIP_LIMIT = 8;

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

interface Props {
  agent: AgentState | null;
  send: (msg: ClientMessage) => boolean;
  onLaunch: () => void;
  /** Opens Launch on the Manual tab with a starter prompt filled (overview chips). */
  onLaunchSample?: (prompt: string) => void;
  /** Opens Launch on the Playbooks tab (overview pinned/recent chips). */
  onLaunchPlaybooks?: (playbookId?: string) => void;
  /** Opens the existing Schedules dialog from the overview next-run row. */
  onOpenSchedules?: () => void;
  /** Opens Diagnostics from the first-run empty-state "Check setup" control. */
  onCheckSetup?: () => void;
  /**
   * Open Cost Comparison from the overview live-spend chip (issue #3391).
   * Threads App's existing modal opener — the same `openModal('costComparison')`
   * path the status-bar 24h chip already uses.
   */
  onOpenCostComparison?: () => void;
  /**
   * Expand the Completed rail from the overview overflow (issue #3392).
   * Threads App's existing `expandCompletedRail` opener — the same nonce
   * the status-bar 24h completed chip already uses.
   */
  onExpandCompleted?: () => void;
  /**
   * Expand the Healthy rail from the overview running overflow (issue #3406).
   * Threads App's `expandHealthyRail` opener — the sibling nonce of
   * {@link onExpandCompleted}.
   */
  onExpandHealthy?: () => void;
  onRequestComplete: () => void;
  detailPaneMode?: DetailPaneMode;
  wideDetailActive?: boolean;
  terminalFocusMode?: boolean;
  shortcutBindings?: ShortcutBindingMap;
  /**
   * #2754: monotonic nonce from the command-palette "Share this task" action.
   * Each bump opens the per-task {@link TaskShareModal} for the selected task,
   * matching the header Share button. Undefined/0 means no request yet.
   */
  shareRequestNonce?: number;
  /**
   * Rail bucket data for the no-selection overview (F8). Passed down from
   * App's buildAgentBuckets result so the overview matches the rail exactly
   * instead of reclassifying agents here.
   */
  overview?: {
    waiting: AgentState[];
    running: AgentState[];
    completed: AgentState[];
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

export function DetailPanel({ agent, send, onLaunch, onLaunchSample, onLaunchPlaybooks, onOpenSchedules, onCheckSetup, onOpenCostComparison, onExpandCompleted, onExpandHealthy, onRequestComplete, detailPaneMode, wideDetailActive = true, terminalFocusMode = false, shortcutBindings = defaultShortcutBindings(), shareRequestNonce = 0, overview }: Props) {
  const [input, setInput] = useState('');
  const [showSnooze, setShowSnooze] = useState(false);
  const [showHookSettings, setShowHookSettings] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareHeaderShares, setShareHeaderShares] = useState<TaskShareSummary[]>([]);
  const [replySnippets, setReplySnippets] = useState<ReplySnippet[]>([]);
  const hookSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationTabRef = useRef<HTMLButtonElement>(null);
  // #3561 4b: the facts column docks beside the conversation on a wide pane
  // and opens over the pane from the header's Details button otherwise.
  const panelRef = useRef<HTMLDivElement>(null);
  const paneWide = usePaneAtLeast(panelRef, FACTS_DOCK_MIN_PANE_PX, agent === null);
  const [factsOpen, setFactsOpen] = useState(false);
  const factsToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setFactsOpen(false); }, [agent?.agentId]);
  const [permissionButtonsDisabled, setPermissionButtonsDisabled] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { selectAgent, nextBottleneck, advanceEmptyEnter, snoozeAgent, setRelaunchTask, showSentOverlay, githubState, leftPane, setLeftPane, narrowTab, setNarrowTab, detailPaneMode: storedDetailPaneMode, setDetailPaneMode, setTerminalFocusMode, handleAlert, suggestions, clearSuggestion, setFocusZone, focusZone, sttUrl, respondAllAgentIds, setRespondAllAgentIds, shortcutsArmed, armShortcuts } = useKookrStore(useShallow((state) => ({
    selectAgent: state.selectAgent,
    nextBottleneck: state.nextBottleneck,
    advanceEmptyEnter: state.advanceEmptyEnter,
    snoozeAgent: state.snoozeAgent,
    setRelaunchTask: state.setRelaunchTask,
    showSentOverlay: state.showSentOverlay,
    githubState: state.githubState,
    leftPane: state.leftPane,
    setLeftPane: state.setLeftPane,
    narrowTab: state.narrowTab,
    setNarrowTab: state.setNarrowTab,
    detailPaneMode: state.detailPaneMode,
    setDetailPaneMode: state.setDetailPaneMode,
    setTerminalFocusMode: state.setTerminalFocusMode,
    handleAlert: state.handleAlert,
    suggestions: state.suggestions,
    clearSuggestion: state.clearSuggestion,
    setFocusZone: state.setFocusZone,
    focusZone: state.focusZone,
    sttUrl: state.sttUrl,
    respondAllAgentIds: state.respondAllAgentIds,
    setRespondAllAgentIds: state.setRespondAllAgentIds,
    shortcutsArmed: state.shortcutsArmed,
    armShortcuts: state.armShortcuts,
  })));
  const hasAgent = agent !== null;
  // #3561 4a: split view and terminal focus need a wide window; everything
  // else, and every narrow window, renders one tab at a time.
  const requestedDetailPaneMode: DetailPaneMode = detailPaneMode ?? (terminalFocusMode ? 'right' : storedDetailPaneMode);
  const splitRenderingTaskVisible = !(agent && isTerminalTaskStatus(agent.taskStatus) && agent.completionDigest);
  const layout = resolveDetailPaneLayout({
    requestedMode: requestedDetailPaneMode,
    wideDetailActive,
    panesVisible: splitRenderingTaskVisible,
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Once docked, a later undock starts closed instead of reopening the overlay.
  const factsDockedNow = paneWide && layout === 'tabs';
  useEffect(() => { if (factsDockedNow) setFactsOpen(false); }, [factsDockedNow]);
  const serverStartedAt = useKookrStore((s) => s.serverStartedAt);
  const replyDraftScope = { taskId: agent?.taskId, agentId: agent?.agentId };

  // Right-pane mode: the terminal, or a file opened from a terminal link.
  const [rightPane, setRightPane] = useState<'terminal' | 'file'>('terminal');
  // #4024 item 4 slice 2: an Edit or Write row clicked in the conversation
  // opens that edit's patch at the top of the Changes tab.
  const [changesEdit, setChangesEdit] = useState<ChangesEdit | null>(null);
  const [activeFile, setActiveFile] = useState<
    { filePath: string; openedAt: string | null } | null
  >(null);
  // Element that had focus when the edit opened — restored on close for a11y.
  const editTriggerRef = useRef<HTMLElement | null>(null);
  // Same for the file viewer pane.
  const fileTriggerRef = useRef<HTMLElement | null>(null);
  // #3561 4a: in the tabbed layout a file opened from a terminal link
  // switches to the Terminal tab so it is visible; closing it returns here.
  const tabBeforeRightPaneRef = useRef<NarrowTab | null>(null);
  // #4024: the tab an opened edit switched away from, so closing the edit
  // returns there. Split view keeps its own left-pane choice, hence the layout.
  const tabBeforeEditRef = useRef<{ layout: 'tabs'; tab: NarrowTab } | { layout: 'split'; tab: LeftPane } | null>(null);
  // #2754: highest palette share-request nonce already acted on. Seeded from
  // the incoming nonce rather than 0 so a remount (App keeps DetailPanel in
  // two layout subtrees and behind the mobile findings/task tabs, and the
  // ever-incrementing App-side nonce is never reset) treats the current value
  // as already-seen — otherwise a fresh 0 < an elevated nonce would spring the
  // modal open with no user action. Only a genuine later bump reopens it.
  const lastShareNonceRef = useRef(shareRequestNonce);

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

  // #2754: open the per-task share modal when the command palette bumps the
  // nonce. Consume every increase (advance the high-water mark unconditionally)
  // so a bump that lands with no selected task can never open the modal later
  // when a task reappears; open only when a task is actually selected. A task
  // switch re-fires this effect with an unchanged nonce, so it stays a no-op.
  useEffect(() => {
    if (shareRequestNonce <= lastShareNonceRef.current) return;
    lastShareNonceRef.current = shareRequestNonce;
    if (agent?.taskId) setShowShareModal(true);
  }, [shareRequestNonce, agent?.taskId]);

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

  // Bring the right pane (terminal or file) on screen in the tabbed
  // layout, remembering the tab to return to. Reads the tab from the store
  // directly so the callbacks below keep a stable identity (FR-TERM-005).
  const revealRightPane = useCallback(() => {
    if (layoutRef.current !== 'tabs') return;
    const currentTab = useKookrStore.getState().narrowTab;
    if (currentTab === 'terminal') return;
    tabBeforeRightPaneRef.current = currentTab;
    setNarrowTab('terminal');
  }, [setNarrowTab]);

  const restoreTabAfterRightPane = useCallback(() => {
    const previousTab = tabBeforeRightPaneRef.current;
    tabBeforeRightPaneRef.current = null;
    if (previousTab && useKookrStore.getState().narrowTab === 'terminal') setNarrowTab(previousTab);
  }, [setNarrowTab]);

  // Bring the Changes tab on screen for an opened edit, remembering the tab
  // to return to. In split view the left pane switches; in the tabbed layout
  // the one visible tab does (#4024).
  const revealChangesTab = useCallback(() => {
    const currentLayout = layoutRef.current;
    if (currentLayout !== 'tabs' && currentLayout !== 'split') return;
    const state = useKookrStore.getState();
    if (currentLayout === 'split') {
      if (state.leftPane === 'changes') return;
      tabBeforeEditRef.current = { layout: 'split', tab: state.leftPane };
      setLeftPane('changes');
    } else {
      if (state.narrowTab === 'changes') return;
      tabBeforeEditRef.current = { layout: 'tabs', tab: state.narrowTab };
      setNarrowTab('changes');
    }
  }, [setLeftPane, setNarrowTab]);

  const restoreTabAfterEdit = useCallback(() => {
    const previous = tabBeforeEditRef.current;
    tabBeforeEditRef.current = null;
    if (!previous) return;
    const state = useKookrStore.getState();
    if (previous.layout === 'split') {
      if (state.leftPane === 'changes') setLeftPane(previous.tab);
    } else if (state.narrowTab === 'changes') {
      setNarrowTab(previous.tab);
    }
  }, [setLeftPane, setNarrowTab]);

  // Leaving the Terminal tab ends the file viewer's claim on it, and leaving
  // the Changes tab ends an opened edit's claim on it: if the operator comes
  // back later, that is their own pick, so closing must then stay put rather
  // than jump to the tab it was opened from (#3618).
  useEffect(() => {
    if (narrowTab !== 'terminal') tabBeforeRightPaneRef.current = null;
  }, [narrowTab]);
  const shownLeftTab = layout === 'split' ? leftPane : narrowTab;
  useEffect(() => {
    if (shownLeftTab !== 'changes') tabBeforeEditRef.current = null;
  }, [shownLeftTab]);

  // The opened view and the memory of the tab it came from both live in this
  // component, but the tab lives in the store. If the pane unmounts while a
  // file holds the Terminal tab or an edit holds the Changes tab (on mobile,
  // picking another task goes through the Findings view, which unmounts it),
  // hand the tab back now, or the next task would open on it by accident
  // (#3618).
  useEffect(() => () => {
    restoreTabAfterRightPane();
    restoreTabAfterEdit();
  }, [restoreTabAfterRightPane, restoreTabAfterEdit]);

  // Clear edit/file state when the selected agent changes. Avoids showing stale
  // content bound to a different agent's toolUseId or worktree. If only the
  // file viewer put the pane on the Terminal tab, the next task opens on
  // Conversation, as any task switch does when the operator did not pick
  // Terminal themselves (`tabAfterTaskSwitch`), instead of keeping Terminal by
  // accident (#3618). Likewise an edit that put the pane on Changes.
  useEffect(() => {
    setChangesEdit(null);
    setActiveFile(null);
    setRightPane('terminal');
    editTriggerRef.current = null;
    fileTriggerRef.current = null;
    const editHeldChanges = tabBeforeEditRef.current !== null;
    tabBeforeEditRef.current = null;
    const fileHeldTerminal = tabBeforeRightPaneRef.current !== null;
    tabBeforeRightPaneRef.current = null;
    const state = useKookrStore.getState();
    if (fileHeldTerminal && state.narrowTab === 'terminal') setNarrowTab('activity');
    if (editHeldChanges && state.narrowTab === 'changes') setNarrowTab('activity');
    if (editHeldChanges && state.leftPane === 'changes') setLeftPane('activity');
  }, [agent?.agentId, setNarrowTab, setLeftPane]);

  function handleOpenDiff(target: DiffClickTarget) {
    if (!agent) return;
    // Capture the trigger so we can restore focus when the edit closes.
    const active = document.activeElement;
    editTriggerRef.current = active instanceof HTMLElement ? active : null;
    setChangesEdit({
      agentId: agent.agentId,
      toolUseId: target.toolUseId,
      filePath: target.filePath,
      openedAt: serverStartedAt,
    });
    revealChangesTab();
  }

  const handleOpenFile = useCallback((filePath: string) => {
    if (!hasAgent) return;
    const active = document.activeElement;
    fileTriggerRef.current = active instanceof HTMLElement ? active : null;
    setActiveFile({ filePath, openedAt: serverStartedAt });
    setRightPane('file');
    revealRightPane();
  }, [hasAgent, serverStartedAt, revealRightPane]);

  // Return focus to the element that opened the edit or file. In the tabbed
  // layout that element sits in the conversation pane, which is still hidden
  // until React re-renders the restored tab, and a browser ignores focus() on
  // a hidden element; so focus on the next frame (#3561 4a).
  function restoreFocusAfterRightPane(trigger: HTMLElement | null) {
    window.requestAnimationFrame(() => {
      if (trigger && document.body.contains(trigger)) trigger.focus();
    });
  }

  function handleCloseFile() {
    setRightPane('terminal');
    restoreTabAfterRightPane();
    restoreFocusAfterRightPane(fileTriggerRef.current);
  }

  function handleCloseEdit() {
    setChangesEdit(null);
    restoreTabAfterEdit();
    restoreFocusAfterRightPane(editTriggerRef.current);
  }

  // While an opened edit or the File pane is on screen, intercept Escape at
  // capture phase so it closes that view (our intent) instead of reaching the
  // window-level handler in App.tsx that would deselect the agent. When
  // neither is shown, Escape reverts to its normal global behavior.
  //
  // Route through the matching close handler so focus restoration runs for
  // keyboard dismissals the same way it does for the close button.
  const handleCloseEditRef = useRef(handleCloseEdit);
  handleCloseEditRef.current = handleCloseEdit;
  const handleCloseFileRef = useRef(handleCloseFile);
  handleCloseFileRef.current = handleCloseFile;
  // An open view can sit behind another tab; Escape then keeps its global
  // meaning instead of closing something off screen.
  const fileOnScreen = rightPane === 'file' && (layout !== 'tabs' || narrowTab === 'terminal');
  const editOnScreen = changesEdit !== null && (layout === 'tabs' || layout === 'split') && shownLeftTab === 'changes';
  useEffect(() => {
    if (!fileOnScreen && !editOnScreen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (fileOnScreen) handleCloseFileRef.current();
        else handleCloseEditRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [fileOnScreen, editOnScreen]);

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
    // #3561 4b: docking or folding the facts column changes the reply width.
  }, [input, paneWide]);

  // Reset permission button disabled state when agent or suggestions change
  const suggestion = agent ? suggestions[agent.agentId] ?? null : null;
  useEffect(() => {
    setPermissionButtonsDisabled(false);
  }, [agent?.agentId, suggestion]);

  // `screen` is what the terminal's screen check saw; the reply box runs no
  // screen check. Recording it with the turn state makes an advance that
  // should have answered a menu visible in telemetry (#3568).
  const handleEmptyEnterAdvance = useCallback((screen: EmptyEnterAdvanceScreen | 'not_checked') => {
    if (!hasAgent) return;
    // Empty Enter is pure navigation — it never dismisses a finding. The
    // finding-vs-healthy cursor rule lives in the store (advanceEmptyEnter) so
    // the reply input, the terminal, and the global window handler stay in sync.
    // Local dashboard navigation must not depend on terminal readiness: the
    // server-side terminal-input coordinator can lag until an idle notification
    // arrives, which made empty Enter appear to work once and then stall.
    track({
      type: 'shortcut_used',
      key: 'Enter',
      action: 'advance_empty_input',
      context: 'input_focused',
      source: screen === 'not_checked' ? 'reply_box' : 'terminal',
      screen,
      turnState: agent?.turnState ?? null,
    });
    advanceEmptyEnter();
  }, [hasAgent, advanceEmptyEnter, agent?.turnState]);
  // The operator can turn off the terminal's empty-Enter advance in Settings;
  // the terminal then sends every Enter to the agent (#3568).
  const terminalEmptyEnterAdvance = useTerminalEmptyEnterAdvance();

  if (!agent) {
    return (
      <div className="detail-panel kookr-tour-target-layout">
        <OverviewEmptyState
          waiting={overview?.waiting ?? []}
          running={overview?.running ?? []}
          completed={overview?.completed ?? []}
          onLaunch={onLaunch}
          onLaunchSample={onLaunchSample}
          onLaunchPlaybooks={onLaunchPlaybooks}
          onOpenSchedules={onOpenSchedules}
          onCheckSetup={onCheckSetup}
          onOpenCostComparison={onOpenCostComparison}
          onExpandCompleted={onExpandCompleted}
          onExpandHealthy={onExpandHealthy}
          shortcutBindings={shortcutBindings}
        />
      </div>
    );
  }

  function setReplyInput(update: React.SetStateAction<string>) {
    setInput((current) => {
      const nextInput = typeof update === 'function' ? update(current) : update;
      saveDetailReplyDraft(replyDraftScope, nextInput);
      return nextInput;
    });
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
    await relaunchFromAgent(agent, setRelaunchTask);
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
        handleEmptyEnterAdvance('not_checked');
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
  // notice while the task is active (in the decision card, see #4024); only emphasise Complete (pulse) when the
  // agent is actually idle (completed_turn) so a signal raised mid-work never
  // invites premature completion.
  const pendingSignal = agent.pendingSignal;
  // Operator-needed flag (issue #1562): an unattended agent tried a denied
  // interactive tool. Surfaced as a header badge + notice so the block is
  // visible instead of the agent hanging on an unanswerable prompt.
  const operatorNeeded = agent.operatorNeeded;
  const hasDerivedCompletionSignal = !!agent.latestCompletionSignal && isCompletedTurn;
  const showSignalBanner = (!!pendingSignal || hasDerivedCompletionSignal)
    && agent.taskStatus !== 'pending'
    && !isTerminalTaskStatus(agent.taskStatus);
  const signalCompleteReady = showSignalBanner && isCompletedTurn;
  const badgeClass = agent.anomaly ? findingKindClass(agent.anomaly.type, agent.turnState) : '';
  const badgeLabel = agent.anomaly
    ? isCompletedTurn ? 'SIGNALED COMPLETE' : agent.anomaly.type.replace('_', ' ').toUpperCase()
    : 'RUNNING';
  const taskGitHubState = agent.taskId ? githubState[agent.taskId] : undefined;
  const nextStepRecommendations = deriveTaskNextStepRecommendations(agent, taskGitHubState?.prs ?? []);
  const shareHeaderStatus = deriveTaskShareHeaderStatus(agent.taskId, shareHeaderShares);
  const rightOnlyMode = layout === 'focus';
  const tabbedLayout = layout === 'tabs';
  // Split view and terminal focus keep the width for the panes: there the
  // column opens over the pane from the Details button, like a narrow pane.
  const factsDocked = paneWide && tabbedLayout;
  const showFactsToggle = !factsDocked;
  const factsVisible = factsDocked || factsOpen;
  function closeFacts() {
    setFactsOpen(false);
    factsToggleRef.current?.focus();
  }
  // #3561 4b: a finding docks its decision card at the foot of the
  // conversation pane, right above the reply box. In split view that keeps the
  // terminal's full height. On the Terminal tab the conversation pane is
  // hidden, so a compact card sits in the reply area instead (#4024). Terminal
  // focus and a completion digest keep only the answer buttons, in the reply
  // area, as before: focus is the operator asking for every line of terminal.
  const completionDigestShown = isTerminalTaskStatus(agent.taskStatus) && !!agent.completionDigest;
  const decisionCardAllowed = !completionDigestShown && !rightOnlyMode;
  // A finding card takes the answer buttons and Skip/Snooze out of the reply row.
  const findingCardAllowed = !!agent.anomaly && decisionCardAllowed;
  // #4024: the agent's signal and operator-needed notices join the decision
  // card, and show a card of their own without a finding. Where no card can
  // show, they keep their banner above the tabs.
  const signalNoticeShown = showSignalBanner && !!agent.taskId;
  const hasAgentNotices = signalNoticeShown || !!operatorNeeded;
  const noticesInCard = hasAgentNotices && decisionCardAllowed;
  const terminalTabShown = tabbedLayout && narrowTab === 'terminal';
  const anyDecisionCardVisible = findingCardAllowed || noticesInCard;
  const decisionCardVisible = anyDecisionCardVisible && !terminalTabShown;
  const terminalDecisionCardVisible = anyDecisionCardVisible && terminalTabShown;
  const renderAgentNotices = (placement: NoticePlacement) => (
    <>
      {signalNoticeShown && (
        <AgentSignalNotice
          placement={placement}
          ready={signalCompleteReady}
          note={pendingSignal?.note}
          onDismiss={pendingSignal && !hasDerivedCompletionSignal
            ? () => send({ type: 'dismissAgentSignal', taskId: agent.taskId! })
            : undefined}
        />
      )}
      {operatorNeeded && <OperatorNeededNotice placement={placement} message={operatorNeeded.message} />}
    </>
  );
  const cardNotices = noticesInCard ? {
    nodes: renderAgentNotices('card'),
    label: operatorNeeded ? 'Operator needed' : 'Agent signal',
    tone: operatorNeeded ? 'bad' as const : 'need' as const,
  } : null;
  const showEvolutionPanel = Boolean(agent.taskId && agent.playbookId === 'autonomous-evolution.md');
  // Skip and Snooze decide what happens to the finding, so they sit in the
  // decision card when it shows; the reply row keeps input, voice and Send.
  const findingTriageButtons = (
    <>
      <button type="button" className="btn-secondary" data-testid="finding-skip" onClick={() => handleSkip()}>Skip</button>
      <button type="button" className="btn-secondary" data-testid="finding-snooze" onClick={() => setShowSnooze(true)}>Snooze</button>
    </>
  );
  const quickActionButtons = quickActions.length > 0 ? (
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
  ) : null;

  function focusNextFrame(ref: React.RefObject<HTMLElement | null>) {
    window.requestAnimationFrame(() => ref.current?.focus());
  }

  function selectConversationTab() {
    track({ type: 'tab_switched', from: narrowTab, to: 'activity' });
    setNarrowTab('activity');
    setLeftPane('activity');
  }

  function showConversationFromFocus() {
    // Return to the layout terminal focus was entered from (#3618).
    setTerminalFocusMode(false);
    selectConversationTab();
    focusNextFrame(conversationTabRef);
  }

  function toggleSplitView() {
    setDetailPaneMode(layout === 'split' ? 'tabs' : 'split');
  }

  function handleNextStepAction(recommendation: NextStepRecommendation) {
    track({
      type: 'quick_action_clicked',
      agentId: agent.agentId,
      actionLabel: `next_step:${recommendation.id}`,
    });
  }

  return (
    <div ref={panelRef} className={`detail-panel kookr-tour-target-layout${rightOnlyMode ? ' terminal-focus' : ''}${tabbedLayout ? ' detail-tabbed' : ''}`} data-testid="detail-panel">
      <div className="detail-header">
        {/* #3561 4b: title over one meta line; one main action plus a menu */}
        <div className="detail-header-left">
          <EditableHeading agent={agent} send={send} />
          <DetailMetaLine
            agent={agent}
            projectLabel={agentProjectLabel(agent)}
            shareBadge={shareHeaderStatus.badgeLabel}
            badges={<>
              {agent.anomaly && <span className={`detail-badge ${badgeClass}`}>{badgeLabel}</span>}
              {agent.playbookId && <span className="detail-badge playbook">Playbook</span>}
              {agent.launchPermissionPosture?.bypassAllPermissions && (
                <span
                  className="detail-badge permission-bypassed"
                  title="This task was launched while KOOKR_BYPASS_ALL_PERMISSIONS was active"
                  data-testid="task-permission-bypass-badge"
                >
                  Permissions bypassed
                </span>
              )}
              {operatorNeeded && (
                <span
                  className="detail-badge permission"
                  title={operatorNeeded.message}
                  data-testid="task-operator-needed-badge"
                >
                  Operator needed
                </span>
              )}
            </>}
          />
        </div>
        <div className="detail-header-right">
          {showFactsToggle && (
            <button
              ref={factsToggleRef}
              type="button"
              className={`action-btn action-btn--neutral detail-facts-toggle${factsOpen ? ' active' : ''}`}
              data-testid="detail-facts-toggle"
              aria-expanded={factsOpen}
              aria-controls="detail-facts"
              onClick={() => setFactsOpen((open) => !open)}
            >
              Details
            </button>
          )}
          <DetailHeaderActions
            taskId={agent.taskId}
            taskStatus={agent.taskStatus}
            agentType={agent.agentType}
            signalCompleteReady={signalCompleteReady}
            handlers={{
              complete: handleComplete,
              markDone: () => send({ type: 'ackTerminatedTask', taskId: agent.taskId! }),
              relaunch: () => { void handleRelaunch(); },
              reopen: () => send({ type: 'reopenTask', taskId: agent.taskId! }),
              reflect: handleReflect,
              cancel: handleCancel,
            }}
          />
        </div>
      </div>
      <div className="detail-body">
      <div className="detail-body-main">
      {hasAgentNotices && !noticesInCard && renderAgentNotices('banner')}
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

      {/* Reading pane body: tabs, split view or terminal focus (#3561 slice 4a) */}
      {(() => {
        const gh = taskGitHubState;
        const ghCount = (gh?.prs.length ?? 0) + (gh?.issues.length ?? 0);
        // #4024 item 4: the tab is the task's own pull request when it has
        // one, with every other PR and issue under "Mentioned".
        const ownPrs = splitOwnPullRequests(gh?.prs ?? [], {
          branch: agent.gitBranch,
          createdAt: agent.taskCreatedAt,
        }).own;
        const ghTabLabel = ownPrs.length === 0
          ? `Mentioned (${ghCount})`
          : ownPrs.length === 1 ? 'Pull request' : `Pull requests (${ownPrs.length})`;
        const isCompleted = isTerminalTaskStatus(agent.taskStatus);
        const terminalVisible = computeTerminalVisible({ rightPane, layout, activeTab: narrowTab });
        // In split view the tabs choose what the left pane shows; in the tabbed
        // layout they choose the one pane on screen.
        const requestedTab: NarrowTab = layout === 'split' ? leftPane : narrowTab;
        // A remembered GitHub tab outlives the task's GitHub references: when
        // they go away the tab disappears and the pane already falls back to the
        // conversation, so highlight Conversation too instead of no tab (#3618).
        // The Changes tab needs a task to diff, or an opened edit to show; an
        // agent with neither falls back the same way.
        const changesAvailable = Boolean(agent.taskId) || changesEdit !== null;
        const selectedTab: NarrowTab =
          (requestedTab === 'github' && ghCount === 0) || (requestedTab === 'changes' && !changesAvailable)
            ? 'activity'
            : requestedTab;
        const leftPaneHidden = tabbedLayout && narrowTab === 'terminal';
        const rightPaneHidden = tabbedLayout && narrowTab !== 'terminal';
        const showRightPaneHeader = !tabbedLayout;

        // Completion digest replaces both panes. Pane selection stays here;
        // the digest's rendering + verification hydration lives in the
        // extracted TaskCompletionDigest component.
        if (isCompleted && agent.completionDigest) {
          return (
            <>
              <TaskCompletionDigest agent={agent} />
              {agent.taskId && <TranscriptToggle key={agent.taskId} taskId={agent.taskId} />}
            </>
          );
        }

        return (
          <>
            {/* #3561 4a: one tab bar at every width; Split view on wide windows */}
            {!rightOnlyMode && <div className="detail-tabs" data-testid="detail-tabs">
              <button
                ref={conversationTabRef}
                type="button"
                className={`detail-tab ${selectedTab === 'activity' ? 'active' : ''}`}
                aria-pressed={selectedTab === 'activity'}
                onClick={selectConversationTab}
              >
                Conversation
              </button>
              {tabbedLayout && (
                <button
                  type="button"
                  className={`detail-tab ${narrowTab === 'terminal' ? 'active' : ''}`}
                  aria-pressed={narrowTab === 'terminal'}
                  data-testid="detail-tab-terminal"
                  onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'terminal' }); setNarrowTab('terminal'); }}
                >
                  Terminal
                </button>
              )}
              {/* #4024 item 4: what the task changed, and an opened edit */}
              {changesAvailable && (
                <button
                  type="button"
                  className={`detail-tab ${selectedTab === 'changes' ? 'active' : ''}`}
                  aria-pressed={selectedTab === 'changes'}
                  data-testid="detail-tab-changes"
                  onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'changes' }); setNarrowTab('changes'); setLeftPane('changes'); }}
                >
                  Changes
                </button>
              )}
              {ghCount > 0 && (
                <button
                  type="button"
                  className={`detail-tab ${selectedTab === 'github' ? 'active' : ''}`}
                  aria-pressed={selectedTab === 'github'}
                  data-testid="detail-tab-github"
                  onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'github' }); setNarrowTab('github'); setLeftPane('github'); }}
                >
                  {ghTabLabel}
                </button>
              )}
              {wideDetailActive && (
                <button
                  type="button"
                  className={`detail-tab detail-split-toggle ${layout === 'split' ? 'active' : ''}`}
                  aria-pressed={layout === 'split'}
                  data-testid="detail-split-toggle"
                  title="Show the conversation and the terminal side by side"
                  onClick={toggleSplitView}
                >
                  Split view
                </button>
              )}
              {/* Which zone holds the keyboard (#3561 5b: moved from the status bar) */}
              {focusZone !== 'none' && (
                <span className="focus-zone-pill" data-testid="focus-zone-cue">
                  {focusZone === 'terminal' ? 'Terminal' : 'Response'}
                </span>
              )}
            </div>}

            {/* Pane container: one pane in the tabbed layout, two in split view */}
            <div className={`detail-split${rightOnlyMode ? ' detail-split-terminal-focus' : ''}${tabbedLayout ? ' detail-split-tabbed' : ''}`}>
              {/* Left pane: Conversation, Changes or Pull request */}
              {!rightOnlyMode && <div className={`detail-split-left${leftPaneHidden ? ' pane-hidden-tab' : ''}`}>
                {selectedTab === 'github' ? (
                  <Suspense fallback={null}>
                    <GitHubPanel prs={gh?.prs ?? []} issues={gh?.issues ?? []} ownPrs={ownPrs} />
                  </Suspense>
                ) : (
                  <>
                    {selectedTab === 'changes' && changesAvailable && (
                      <Suspense fallback={null}>
                        <ChangesPanel
                          key={agent.taskId ?? agent.agentId}
                          taskId={agent.taskId}
                          edit={changesEdit}
                          onCloseEdit={handleCloseEdit}
                        />
                      </Suspense>
                    )}
                    {/* The conversation stays mounted behind Changes, so closing an
                        opened edit finds the row that opened it (focus, expanded
                        tool group and scroll position survive) (#4024). */}
                    <div
                      className="detail-conversation-slot"
                      data-testid="detail-conversation-slot"
                      style={{ display: selectedTab === 'changes' && changesAvailable ? 'none' : 'contents' }}
                    >
                    <Suspense fallback={null}>
                      <ActivityPanel
                        agentId={agent.agentId}
                        events={agent.events}
                        description={agent.description}
                        cwd={agent.cwd}
                        onOpenDiff={handleOpenDiff}
                        activityMeta={agent.activityMeta}
                        taskId={agent.taskId}
                        isActive={agent.turnState === 'running'}
                        userInputDeliveries={agent.userInputDeliveries}
                      />
                    </Suspense>
                    </div>
                  </>
                )}
                {decisionCardVisible && (
                  <DecisionCard
                    agent={agent}
                    actions={quickActionButtons}
                    triage={findingTriageButtons}
                    notices={cardNotices}
                  />
                )}
              </div>}

              {/* Right pane: Terminal or File (terminal stays mounted for UI
                  state, but byte-stream subscription follows visibility) */}
              <div className={`detail-split-right${rightPaneHidden ? ' pane-hidden-tab' : ''}`}>
                {showRightPaneHeader && <div className="detail-pane-header">
                  <button
                    type="button"
                    className={`pane-tab ${rightPane === 'terminal' ? 'active' : ''}`}
                    aria-pressed={rightPane === 'terminal'}
                    onClick={() => {
                      // Choosing the terminal here makes the Terminal tab the
                      // operator's own pick, so closing the file later must not
                      // jump back to the tab the file was opened from (#3618).
                      tabBeforeRightPaneRef.current = null;
                      setRightPane('terminal');
                    }}
                  >
                    Terminal
                  </button>
                  {rightOnlyMode && (
                    <button
                      type="button"
                      className="pane-control"
                      aria-label="Show conversation"
                      title="Leave terminal focus and show the conversation"
                      onClick={showConversationFromFocus}
                    >
                      Show conversation
                    </button>
                  )}
                </div>}
                <div className={`right-pane-stack right-pane-${rightPane}`}>
                  <div
                    className="right-pane-slot right-pane-slot-terminal"
                    style={{ display: rightPane === 'terminal' ? 'flex' : 'none' }}
                  >
                    {isCompleted && agent.taskId ? (
                      <TranscriptView key={agent.taskId} taskId={agent.taskId} />
                    ) : (
                      <Suspense fallback={null}>
                        <TerminalPanel
                          tmuxName={agent.agentId}
                          agentType={agent.agentType}
                          visible={terminalVisible}
                          onEmptySubmit={terminalEmptyEnterAdvance ? handleEmptyEnterAdvance : undefined}
                          turnState={agent.turnState ?? null}
                          onOpenFile={handleOpenFile}
                        />
                      </Suspense>
                    )}
                  </div>
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
        {/* #3561 4b: while the decision card shows, the answer buttons live in it */}
        {terminalDecisionCardVisible && (
          <DecisionCard
            agent={agent}
            actions={quickActionButtons}
            triage={findingTriageButtons}
            compact
            notices={cardNotices}
          />
        )}
        {!findingCardAllowed && quickActionButtons}
        {replySnippets.length > 0 && (
          <div className="reply-snippet-picker">
            <span className="reply-snippet-picker-label" id="reply-snippet-chips-label">
              Saved replies
            </span>
            <div className="sample-prompt-chips" role="group" aria-labelledby="reply-snippet-chips-label">
              {replySnippets.slice(0, REPLY_SNIPPET_CHIP_LIMIT).map((snippet, index) => (
                <button
                  key={`${snippet.label}-${index}`}
                  type="button"
                  className="sample-prompt-chip"
                  title={snippet.text}
                  onClick={() => insertReplySnippet(snippet.text)}
                >
                  {snippet.label}
                </button>
              ))}
            </div>
            {replySnippets.length > REPLY_SNIPPET_CHIP_LIMIT && (
              <select
                id="reply-snippet-picker"
                className="reply-snippet-picker-select"
                value=""
                aria-label="More saved replies"
                onChange={(e) => {
                  const snippet = replySnippets[Number(e.target.value)];
                  if (snippet) insertReplySnippet(snippet.text);
                }}
              >
                <option value="" disabled>Insert snippet...</option>
                {replySnippets.slice(REPLY_SNIPPET_CHIP_LIMIT).map((snippet, overflowIndex) => {
                  const index = overflowIndex + REPLY_SNIPPET_CHIP_LIMIT;
                  return (
                    <option key={`${snippet.label}-${index}`} value={index}>{snippet.label}</option>
                  );
                })}
              </select>
            )}
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
                key={`${agent.taskId ?? ''}:${agent.agentId}`}
                inputId="response-input"
                recoveryKey={`reply:${agent.taskId ?? agent.agentId}:${agent.agentId}`}
                recoveryLabel="reply"
                onRecoveryResolved={() => inputRef.current?.focus()}
                onTranscript={(text) => setReplyInput((current) => appendDictation(current, text))}
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
          {!isDirectReply && !findingCardAllowed && findingTriageButtons}
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
      {factsVisible && (
        <TaskFactsColumn
          agent={agent}
          projectLabel={agentProjectLabel(agent)}
          prs={taskGitHubState?.prs ?? []}
          shareStatus={shareHeaderStatus}
          onShare={() => setShowShareModal(true)}
          hookSettingsTriggerRef={hookSettingsTriggerRef}
          onShowHookSettings={() => setShowHookSettings(true)}
          overlay={!factsDocked}
          onClose={closeFacts}
        />
      )}
      </div>
    </div>
  );
}
