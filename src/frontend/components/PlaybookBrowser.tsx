import React, { useState, useRef, useEffect, useMemo } from 'react';
import { AVAILABLE_AGENT_TYPES, type Playbook, type ClientMessage, type AutonomyLevel, type AgentType } from '../../shared/protocol.js';
import type { PlaybookParameterOption } from '../../core/playbook.js';
import type { ProjectSummary } from '../../core/project-summary.js';
import { useKookrStore } from '../store/useStore.js';
import { projectLabel, projectColor } from '../presentation.js';
import { PlaybookUsageTracker } from '../store/playbook-usage.js';
import { mergeParamDefaults } from '../store/playbook-params.js';
import { resolveParameterSource, mergeSourceAndStaticOptions } from '../store/playbook-source-resolver.js';
import { RecentPaths } from '../store/recent-paths.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { FilterableSelect } from './FilterableSelect.js';
import { ConfirmDialog } from './ConfirmDialog.js';

const usageTracker = new PlaybookUsageTracker();
const recentPaths = new RecentPaths();

/** Shape of the 409 body when the launch hits an active loop with the same key. */
interface RalphLoopConflict {
  taskId: string;
  currentIteration: number;
  /** Epoch ms; 0 means the loop never started its first iteration. */
  lastIterationStartedAt: number;
  loopStatus: 'running' | 'paused';
}

/** Extract a typed conflict from a 409 response body. Returns null if the
 *  shape isn't recognized so old backends fall through to the generic toast. */
function parseRalphLoopConflict(body: unknown): RalphLoopConflict | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (obj.conflictKind !== 'duplicate_active_loop') return null;
  if (typeof obj.taskId !== 'string') return null;
  const ralphLoop = obj.ralphLoop as Record<string, unknown> | null | undefined;
  if (!ralphLoop || typeof ralphLoop !== 'object') return null;
  const status = ralphLoop.status;
  if (status !== 'running' && status !== 'paused') return null;
  const currentIteration = typeof ralphLoop.currentIteration === 'number'
    ? ralphLoop.currentIteration
    : 0;
  const lastIterationStartedAt = typeof ralphLoop.lastIterationStartedAt === 'number'
    ? ralphLoop.lastIterationStartedAt
    : 0;
  return { taskId: obj.taskId, currentIteration, lastIterationStartedAt, loopStatus: status };
}

/** Render a friendly relative-time string from an epoch-ms timestamp. */
function formatRelativeTime(ms: number, nowMs = Date.now()): string {
  if (ms === 0) return 'iteration 0 (not yet started)';
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Threshold: use filterable dropdown when option count exceeds this */
const FILTERABLE_THRESHOLD = 5;

/**
 * Playbook id (relative path) that gates the other-author warning. The
 * playbook itself enforces the author filter; this UI gate exists to make sure
 * the user has acknowledged the prompt-injection risk before opting in.
 */
const IMPLEMENT_GITHUB_ISSUE_ID = 'implement-github-issue.md';
const SUPPRESS_OTHER_AUTHOR_WARNING_KEY = 'kookr:suppressOtherAuthorWarning';

function TagIcon({ tag }: { tag: 'workflow' | 'loopable' }): React.ReactElement {
  if (tag === 'loopable') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.1 5.1A4.5 4.5 0 0 1 12.3 4" />
        <path d="M12.3 4V1.8" />
        <path d="M12.3 4h-2.2" />
        <path d="M11.9 10.9A4.5 4.5 0 0 1 3.7 12" />
        <path d="M3.7 12v2.2" />
        <path d="M3.7 12h2.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="8" cy="12" r="1.6" />
      <path d="M5.4 4h5.2" />
      <path d="M4.9 5.2 7.1 10.6" />
      <path d="M11.1 5.2 8.9 10.6" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={pinned ? 'filled' : ''}>
      <path d="M5.4 2.4h5.2l-.8 3 2.2 2.2v1.2H8.8L8 14 6.8 8.8H4V7.6l2.2-2.2-.8-3Z" />
    </svg>
  );
}

function renderPlaybookTags(tags: string[]): React.ReactNode {
  const visible = tags.filter((tag): tag is 'workflow' | 'loopable' => tag === 'workflow' || tag === 'loopable');
  if (visible.length === 0) return null;
  return (
    <span className="playbook-tags">
      {visible.map((tag) => (
        <span
          key={tag}
          className={`playbook-tag playbook-tag-${tag}`}
          title={tag === 'loopable' ? 'Loopable workflow' : 'Workflow playbook'}
        >
          <span className="playbook-tag-icon">
            <TagIcon tag={tag} />
          </span>
          {tag}
        </span>
      ))}
    </span>
  );
}

interface Props {
  send: (msg: ClientMessage) => boolean;
  onClose: () => void;
  cwd: string;
  /** When set, auto-select this playbook for relaunch. */
  relaunchPlaybookId?: string;
  /** Parameter values to pre-fill when relaunching a playbook task. */
  relaunchParameterValues?: Record<string, string>;
  /** When launched from a project detail drawer, pre-fill source-matching params */
  projectContext?: ProjectSummary;
  /**
   * Switch the parent dialog back to the manual tab so the user can edit the
   * cwd. The "Change…" link in the resolved-cwd label invokes this.
   */
  onRequestEditCwd?: () => void;
}

function ResolvedCwdLabel({
  cwd,
  overrideCwd,
  onRequestEdit,
}: {
  cwd: string;
  /** When set, the playbook's own `cwd:` overrides the dialog cwd. */
  overrideCwd?: string;
  onRequestEdit?: () => void;
}): React.ReactElement {
  const effective = overrideCwd ?? cwd;
  return (
    <div className="playbook-resolved-cwd">
      <span className="playbook-resolved-cwd-label">Running in:</span>
      <span
        className={`project-badge color-${projectColor(effective)}`}
        title={effective}
      >
        {projectLabel(effective)}
      </span>
      <span className="playbook-resolved-cwd-path" title={effective}>
        {effective}
      </span>
      {overrideCwd !== undefined ? (
        <span
          className="playbook-resolved-cwd-override"
          title={`This playbook pins its working directory to ${overrideCwd}, overriding the project default.`}
        >
          <span aria-hidden="true">ⓘ </span>overridden by playbook
        </span>
      ) : (
        onRequestEdit && (
          <button
            type="button"
            className="link-button playbook-resolved-cwd-change"
            onClick={onRequestEdit}
          >
            Change…
          </button>
        )
      )}
    </div>
  );
}

export function PlaybookBrowser({ send, onClose, cwd, relaunchPlaybookId, relaunchParameterValues, projectContext, onRequestEditCwd }: Props) {
  const { playbooks, playbooksLoading, availableAgentTypes, defaultAgentType, projectSummaries } = useKookrStore();
  const agentOptions = availableAgentTypes.length > 0
    ? availableAgentTypes
    : AVAILABLE_AGENT_TYPES;
  const [selected, setSelected] = useState<Playbook | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [resolvedOptions, setResolvedOptions] = useState<Record<string, PlaybookParameterOption[]>>({});
  const [search, setSearch] = useState('');
  const [showLoopableOnly, setShowLoopableOnly] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [launchMode, setLaunchMode] = useState<'standard' | 'looped'>('standard');
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<RalphLoopConflict | null>(null);
  // Clear the conflict whenever a key-affecting input changes — otherwise
  // the next Replace click would send a key that doesn't match the
  // replacedTaskId and the server would 400 with replacedTaskId_key_mismatch.
  // The user has effectively "moved on" from this conflict; let them start
  // fresh with the new key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (conflict !== null) setConflict(null);
  }, [paramValues]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => usageTracker.getPinned());
  const [agentType, setAgentType] = useState<AgentType>(() =>
    (localStorage.getItem('kookr:defaultAgentType') as AgentType) || defaultAgentType || 'claude-code'
  );
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() =>
    (localStorage.getItem('kookr:defaultAutonomy') as AutonomyLevel) || 'supervised'
  );
  const [showOtherAuthorWarning, setShowOtherAuthorWarning] = useState(false);
  const [suppressOtherAuthorWarning, setSuppressOtherAuthorWarning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-select playbook when relaunching and playbooks have loaded
  const relaunchAppliedRef = useRef(false);
  useEffect(() => {
    if (relaunchPlaybookId && !playbooksLoading && playbooks.length > 0 && !relaunchAppliedRef.current) {
      const match = playbooks.find((pb) => pb.id === relaunchPlaybookId);
      if (match) {
        relaunchAppliedRef.current = true;
        setParamValues(
          mergeParamDefaults(match.parameters, relaunchParameterValues ?? {}),
        );
        setSelected(match);
        return; // skip focusing search — we're in detail view
      }
    }
  }, [relaunchPlaybookId, relaunchParameterValues, playbooksLoading, playbooks]);

  // Auto-focus search when playbooks arrive
  useEffect(() => {
    if (!playbooksLoading && !selected) {
      searchRef.current?.focus();
    }
  }, [playbooksLoading, selected]);

  // Resolve dynamic sources when a playbook is selected
  useEffect(() => {
    if (!selected) {
      setResolvedOptions({});
      return;
    }

    let cancelled = false;
    const paramsWithSource = selected.parameters.filter((p) => p.source);
    if (paramsWithSource.length === 0) {
      setResolvedOptions({});
      return;
    }

    Promise.all(
      paramsWithSource.map(async (param) => {
        const sourceOpts = await resolveParameterSource(param.source!, projectSummaries);
        const merged = mergeSourceAndStaticOptions(sourceOpts, param.options);
        return { name: param.name, options: merged };
      }),
    ).then((results) => {
      if (cancelled) return;
      const resolved: Record<string, PlaybookParameterOption[]> = {};
      for (const { name, options } of results) {
        resolved[name] = options;
      }
      setResolvedOptions(resolved);
    }).catch(() => {
      if (!cancelled) setResolvedOptions({});
    });

    return () => { cancelled = true; };
  }, [selected, projectSummaries]);

  // Sorted + filtered playbooks: pinned first, then recently used, then alphabetical
  const sortedPlaybooks = useMemo(() => {
    const recent = usageTracker.getRecent();

    let filtered = showLoopableOnly
      ? playbooks.filter((pb) => pb.tags.includes('loopable'))
      : playbooks;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (pb) => pb.name.toLowerCase().includes(q) || pb.description.toLowerCase().includes(q),
      );
    }

    return [...filtered].sort((a, b) => {
      const aPinned = pinnedIds.has(a.id);
      const bPinned = pinnedIds.has(b.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;

      const aRecent = recent.indexOf(a.id);
      const bRecent = recent.indexOf(b.id);
      const aHasRecent = aRecent !== -1;
      const bHasRecent = bRecent !== -1;
      if (aHasRecent !== bHasRecent) return aHasRecent ? -1 : 1;
      if (aHasRecent && bHasRecent) return aRecent - bRecent;

      return a.name.localeCompare(b.name);
    });
  }, [playbooks, search, pinnedIds, showLoopableOnly]);

  useEffect(() => {
    setFocusIdx(-1);
  }, [search]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIdx >= 0 && listRef.current) {
      const cards = listRef.current.querySelectorAll('.playbook-card');
      cards[focusIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusIdx]);

  /** Get effective options for a parameter (resolved source + static, or just static) */
  function getEffectiveOptions(paramName: string, staticOptions?: PlaybookParameterOption[]): PlaybookParameterOption[] | undefined {
    const resolved = resolvedOptions[paramName];
    if (resolved) return resolved; // already merged during resolution
    return staticOptions;
  }

  function handleUse(playbook: Playbook) {
    const snapshot = usageTracker.getParamSnapshot(playbook.id, playbook.sourceCwd);
    const defaults = mergeParamDefaults(playbook.parameters, snapshot);

    // Pre-fill from project context: for params with source: tracked-projects,
    // project context wins over param history (the user explicitly clicked
    // "Run playbook..." from this project's drawer)
    if (projectContext) {
      for (const param of playbook.parameters) {
        if (param.source === 'tracked-projects') {
          defaults[param.name] = projectContext.displayName;
        }
      }
    }

    setParamValues(defaults);
    setLaunchMode('standard');
    setSelected(playbook);
  }

  function handleBack() {
    setSelected(null);
    setParamValues({});
    setResolvedOptions({});
    setLaunchMode('standard');
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  /**
   * Whether to gate this launch behind the other-author warning. True when
   * the implement-github-issue playbook is opting into other-author issues
   * AND the user has not previously dismissed the warning permanently.
   */
  function needsOtherAuthorWarning(): boolean {
    if (!selected) return false;
    if (selected.id !== IMPLEMENT_GITHUB_ISSUE_ID) return false;
    if (paramValues.allowOtherAuthors !== 'true') return false;
    return localStorage.getItem(SUPPRESS_OTHER_AUTHOR_WARNING_KEY) !== '1';
  }

  function handleLaunch(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (!canLaunch()) return;
    if (needsOtherAuthorWarning()) {
      setSuppressOtherAuthorWarning(false);
      setShowOtherAuthorWarning(true);
      return;
    }
    void proceedLaunch();
  }

  async function confirmOtherAuthorWarning() {
    if (suppressOtherAuthorWarning) {
      localStorage.setItem(SUPPRESS_OTHER_AUTHOR_WARNING_KEY, '1');
    }
    setShowOtherAuthorWarning(false);
    await proceedLaunch();
  }

  async function proceedLaunch() {
    if (!selected) return;
    setSubmitting(true);
    usageTracker.recordLaunch(selected.id);
    usageTracker.recordParams(selected.id, selected.sourceCwd, paramValues);
    const trimmedCwd = cwd.trim();
    if (trimmedCwd) recentPaths.add(trimmedCwd);
    localStorage.setItem('kookr:defaultAutonomy', autonomy);
    localStorage.setItem('kookr:defaultAgentType', agentType);
    const excerpt = selected.name.slice(0, 40) + (selected.name.length > 40 ? '…' : '');
    if (launchMode === 'looped') {
      try {
        const res = await fetch('/api/playbooks/ralph-loop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
          body: JSON.stringify({
            playbookPath: selected.id,
            cwd,
            parameterValues: paramValues,
            autonomy,
            agentType,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as Record<string, unknown>;
          // 409 with a recognized conflict shape → show the in-place dialog
          // so the user can replace the old loop or attach to it. Old
          // backends won't return `conflictKind`, so we fall through.
          if (res.status === 409) {
            const detected = parseRalphLoopConflict(body);
            if (detected) {
              setConflict(detected);
              setSubmitting(false);
              return;
            }
          }
          useKookrStore.getState().handleAlert(
            '',
            `Could not start looped playbook: ${(body.error as string | undefined) ?? `HTTP ${res.status}`}. ${excerpt}`,
            'error',
          );
          setSubmitting(false);
          return;
        }
        useKookrStore.getState().handleAlert('', `Starting looped playbook: ${excerpt}`, 'info');
      } catch (err) {
        useKookrStore.getState().handleAlert(
          '',
          `Could not start looped playbook: ${err instanceof Error ? err.message : String(err)}. ${excerpt}`,
          'error',
        );
        setSubmitting(false);
        return;
      }
    } else {
      const sent = send({
        type: 'launchPlaybook',
        playbookPath: selected.id,
        cwd,
        parameterValues: paramValues,
        autonomy,
        agentType,
      });
      if (sent) {
        useKookrStore.getState().handleAlert('', `Starting task: ${excerpt}`, 'info');
      } else {
        useKookrStore.getState().handleAlert(
          '',
          `Could not start task: not connected. ${excerpt}`,
          'error',
        );
        setSubmitting(false);
        return;
      }
    }
    onClose();
  }

  async function handleReplace() {
    if (!selected || !conflict) return;
    setSubmitting(true);
    const excerpt = selected.name.slice(0, 40) + (selected.name.length > 40 ? '…' : '');
    try {
      const res = await fetch(
        `/api/tasks/${encodeURIComponent(conflict.taskId)}/ralph-loop/replace-with-new`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
          body: JSON.stringify({
            playbookPath: selected.id,
            cwd,
            parameterValues: paramValues,
            autonomy,
            agentType,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        useKookrStore.getState().handleAlert(
          '',
          `Could not replace looped playbook: ${body.error ?? `HTTP ${res.status}`}. ${excerpt}`,
          'error',
        );
        setSubmitting(false);
        return;
      }
      useKookrStore.getState().handleAlert(
        '',
        `Replaced looped playbook: ${excerpt}`,
        'info',
      );
      setConflict(null);
      onClose();
    } catch (err) {
      useKookrStore.getState().handleAlert(
        '',
        `Could not replace looped playbook: ${err instanceof Error ? err.message : String(err)}. ${excerpt}`,
        'error',
      );
      setSubmitting(false);
    }
  }

  function handleOpenExisting() {
    if (!conflict) return;
    useKookrStore.getState().selectAgent(conflict.taskId);
    setConflict(null);
    onClose();
  }

  function canLaunch(): boolean {
    if (!selected) return false;
    if (submitting) return false;
    if (launchMode === 'looped' && (!selected.tags.includes('loopable') || !selected.effectiveLoop || selected.loopValidationError)) {
      return false;
    }
    return selected.parameters
      .filter((p) => p.required)
      .every((p) => (paramValues[p.name] ?? '').trim() !== '');
  }

  function handleTogglePin(e: React.MouseEvent, playbookId: string) {
    e.stopPropagation();
    usageTracker.togglePin(playbookId);
    setPinnedIds(usageTracker.getPinned());
  }

  function handleListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((prev) => Math.min(prev + 1, sortedPlaybooks.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusIdx <= 0) {
        setFocusIdx(-1);
        searchRef.current?.focus();
      } else {
        setFocusIdx((prev) => prev - 1);
      }
    } else if (e.key === 'Enter' && focusIdx >= 0) {
      e.preventDefault();
      handleUse(sortedPlaybooks[focusIdx]);
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' && sortedPlaybooks.length > 0) {
      e.preventDefault();
      setFocusIdx(0);
      listRef.current?.focus();
    }
  }

  // --- Detail view (selected playbook) ---
  if (selected) {
    const isLoopable = selected.tags.includes('loopable');
    const loopDisabledReason = selected.loopValidationError
      ?? (!isLoopable ? 'Looping unavailable: this playbook is not tagged loopable.' : '');

    return (
      <>
      <form onSubmit={handleLaunch}>
        <div className="playbook-detail-header">
          <button type="button" className="btn-xs" onClick={handleBack}>
            Back
          </button>
          <span className="playbook-detail-name">{selected.name}</span>
          {renderPlaybookTags(selected.tags)}
        </div>
        {selected.description && <p className="playbook-detail-desc">{selected.description}</p>}
        <ResolvedCwdLabel
          cwd={cwd}
          overrideCwd={selected.cwd ?? undefined}
          onRequestEdit={onRequestEditCwd}
        />

        <div className="launch-mode-toggle playbook-launch-mode" role="group" aria-label="Playbook launch mode">
          <button
            type="button"
            className={`launch-mode-option${launchMode === 'standard' ? ' active' : ''}`}
            aria-pressed={launchMode === 'standard'}
            onClick={() => setLaunchMode('standard')}
          >
            Run
          </button>
          <button
            type="button"
            className={`launch-mode-option${launchMode === 'looped' ? ' active' : ''}`}
            aria-pressed={launchMode === 'looped'}
            disabled={Boolean(loopDisabledReason)}
            title={loopDisabledReason || 'Run this playbook in a bounded loop'}
            onClick={() => setLaunchMode('looped')}
          >
            Run looped
          </button>
        </div>

        {loopDisabledReason && (
          <div className="playbook-loop-disabled">{loopDisabledReason}</div>
        )}

        {launchMode === 'looped' && selected.effectiveLoop && (
          <div className="playbook-loop-bounds" role="group" aria-label="Loop bounds">
            <div>
              <span>Max iterations</span>
              <strong>{selected.effectiveLoop.iterationCap}</strong>
              <em>{selected.effectiveLoop.sources.iterationCap === 'playbook' ? 'From playbook' : 'Default'}</em>
            </div>
            <div>
              <span>Stop after no changes</span>
              <strong>{selected.effectiveLoop.zeroDiffConsecutiveIterations ?? 'Off'}</strong>
              <em>{selected.effectiveLoop.sources.zeroDiffConsecutiveIterations ? 'From playbook' : 'Not configured'}</em>
            </div>
            <div>
              <span>Cost cap</span>
              <strong>{selected.effectiveLoop.costCapUsd !== undefined ? `$${selected.effectiveLoop.costCapUsd}` : 'Off'}</strong>
              <em>{selected.effectiveLoop.sources.costCapUsd === 'playbook' ? 'Observed spend from playbook' : 'Default observed spend when usage is available'}</em>
            </div>
          </div>
        )}

        {selected.parameters.length > 0 && (
          <div className="playbook-params">
            {selected.parameters.map((param) => {
              const options = getEffectiveOptions(param.name, param.options);
              const isSelect = param.type === 'select' && options && options.length > 0;
              const useFilterable = isSelect && options.length > FILTERABLE_THRESHOLD;

              return (
                <label key={param.name} className="playbook-param">
                  {param.name}
                  {param.required && <span className="playbook-required">*</span>}
                  {useFilterable ? (
                    <FilterableSelect
                      options={options}
                      value={paramValues[param.name] ?? ''}
                      onChange={(v) =>
                        setParamValues((prev) => ({ ...prev, [param.name]: v }))
                      }
                      placeholder={param.description}
                    />
                  ) : isSelect ? (
                    <select
                      value={paramValues[param.name] ?? ''}
                      onChange={(e) =>
                        setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                      }
                    >
                      <option value="">— Select —</option>
                      {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : param.type === 'textarea' ? (
                    <textarea
                      rows={3}
                      value={paramValues[param.name] ?? ''}
                      onChange={(e) =>
                        setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                      }
                      placeholder={param.description}
                    />
                  ) : (
                    <input
                      type="text"
                      value={paramValues[param.name] ?? ''}
                      onChange={(e) =>
                        setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                      }
                      placeholder={param.description}
                    />
                  )}
                </label>
              );
            })}
          </div>
        )}

        {selected.checklist.length > 0 && (
          <div className="playbook-checklist">
            <span className="playbook-checklist-label">Checklist</span>
            <ul>
              {selected.checklist.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <AgentTypeSelector
          value={agentType}
          onChange={setAgentType}
          options={agentOptions}
        />

        <label className="autonomy-toggle">
          <span className="autonomy-toggle-label">Autonomy</span>
          <div className="autonomy-options">
            <button
              type="button"
              className={`autonomy-option${autonomy === 'supervised' ? ' active' : ''}`}
              onClick={() => setAutonomy('supervised')}
            >
              Supervised
            </button>
            <button
              type="button"
              className={`autonomy-option${autonomy === 'autonomous' ? ' active' : ''}`}
              onClick={() => setAutonomy('autonomous')}
            >
              Autonomous
            </button>
          </div>
          <div className="autonomy-hint">
            {autonomy === 'supervised'
              ? 'Pauses and waits for your input when the agent stops.'
              : 'Auto-proceeds after 3 min when the agent stops (max 2 retries, then switches to supervised).'}
          </div>
        </label>
        {conflict && (
          <div className="ralph-conflict-banner" role="alertdialog" aria-label="Loop already running">
            <div className="ralph-conflict-title">A loop is already running for this playbook.</div>
            <div className="ralph-conflict-detail">
              Task <code>{conflict.taskId.slice(0, 8)}</code>, iteration {conflict.currentIteration}.
              {' '}
              Last iteration started {formatRelativeTime(conflict.lastIterationStartedAt)}.
            </div>
            <div className="ralph-conflict-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={handleReplace}
                disabled={submitting}
              >
                Replace it (start fresh)
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleOpenExisting}
                disabled={submitting}
              >
                Open the running loop
              </button>
            </div>
            <div className="ralph-conflict-hint">
              <em>Replace it</em> stops the old agent and starts a new one with the same prompt; the
              previous conversation is not carried over. <em>Open the running loop</em> takes you to
              the existing task.
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={handleBack}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canLaunch() || conflict !== null}>
            {launchMode === 'looped' ? 'Launch Looped' : 'Launch Playbook'}
          </button>
        </div>
      </form>
      {showOtherAuthorWarning && (
        <ConfirmDialog
          title="Implementing issues from other authors"
          message="You're about to allow this playbook to implement issues opened by other GitHub users. Their issue body will flow into the agent's context — a known prompt-injection surface that could push the agent to take actions you did not intend. Only continue for repos and authors you trust."
          confirmLabel="Continue anyway"
          confirmClass="btn-danger"
          onConfirm={() => { void confirmOtherAuthorWarning(); }}
          onClose={() => setShowOtherAuthorWarning(false)}
        >
          <label className="confirm-dialog-checkbox">
            <input
              type="checkbox"
              checked={suppressOtherAuthorWarning}
              onChange={(e) => setSuppressOtherAuthorWarning(e.target.checked)}
            />
            Don't show this warning again
          </label>
        </ConfirmDialog>
      )}
      </>
    );
  }

  // --- Loading state ---
  if (playbooksLoading) {
    return <div className="playbook-empty">Loading playbooks...</div>;
  }

  // --- Empty state ---
  if (playbooks.length === 0) {
    return (
      <>
        <ResolvedCwdLabel cwd={cwd} onRequestEdit={onRequestEditCwd} />
        <div className="playbook-empty">
          No playbooks found.
          <br />
          Create <code>.kookr/playbooks/*.md</code> in your project.
        </div>
      </>
    );
  }

  // --- List view ---
  const recentIds = new Set(usageTracker.getRecent());
  const loopableCount = playbooks.filter((pb) => pb.tags.includes('loopable')).length;

  return (
    <div>
      <ResolvedCwdLabel cwd={cwd} onRequestEdit={onRequestEditCwd} />
      <div className="playbook-search">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search playbooks..."
          className="playbook-search-input"
        />
        {search && (
          <span className="playbook-search-count">
            {sortedPlaybooks.length} of {playbooks.length}
          </span>
        )}
      </div>
      {loopableCount > 0 && (
        <div className="playbook-filter-row">
          <button
            type="button"
            className={`playbook-filter${showLoopableOnly ? ' active' : ''}`}
            aria-pressed={showLoopableOnly}
            onClick={() => setShowLoopableOnly((value) => !value)}
          >
            <span className="playbook-filter-icon" aria-hidden="true">
              <TagIcon tag="loopable" />
            </span>
            Loopable workflows ({loopableCount})
          </button>
        </div>
      )}
      {sortedPlaybooks.length === 0 ? (
        <div className="playbook-empty">
          No playbooks match &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div
          ref={listRef}
          className="playbook-list"
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
        >
          {sortedPlaybooks.map((pb, idx) => {
            const targetCwd = pb.cwd ?? cwd;
            const isPinned = pinnedIds.has(pb.id);
            const isRecent = recentIds.has(pb.id);
            return (
              <div
                key={pb.id}
                className={`playbook-card${idx === focusIdx ? ' focused' : ''}`}
                onClick={() => handleUse(pb)}
              >
                <div className="playbook-card-header">
                  <span className="playbook-card-name">
                    {isPinned && (
                      <span className="playbook-pin-indicator" title="Pinned">
                        <PinIcon pinned />
                      </span>
                    )}
                    {pb.name}
                  </span>
                  <span className="playbook-card-meta">
                    {isRecent && <span className="playbook-recent-badge">recent</span>}
                    {renderPlaybookTags(pb.tags)}
                    <span
                      className={`project-badge color-${projectColor(targetCwd)}`}
                      title={targetCwd}
                    >
                      {projectLabel(targetCwd)}
                    </span>
                    {pb.parameters.length > 0 && (
                      <span className="playbook-card-params">
                        {pb.parameters.length} param{pb.parameters.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    <button
                      type="button"
                      className={`playbook-pin-btn${isPinned ? ' pinned' : ''}`}
                      onClick={(e) => handleTogglePin(e, pb.id)}
                      aria-label={isPinned ? 'Unpin playbook' : 'Pin playbook to top'}
                      title={isPinned ? 'Unpin' : 'Pin to top'}
                    >
                      <PinIcon pinned={isPinned} />
                    </button>
                  </span>
                </div>
                {pb.description && <div className="playbook-card-desc">{pb.description}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
