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

const usageTracker = new PlaybookUsageTracker();
const recentPaths = new RecentPaths();

/** Threshold: use filterable dropdown when option count exceeds this */
const FILTERABLE_THRESHOLD = 5;

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
}

export function PlaybookBrowser({ send, onClose, cwd, relaunchPlaybookId, relaunchParameterValues, projectContext }: Props) {
  const { playbooks, playbooksLoading, availableAgentTypes, defaultAgentType, projectSummaries } = useKookrStore();
  const agentOptions = availableAgentTypes.length > 0
    ? availableAgentTypes
    : AVAILABLE_AGENT_TYPES;
  const [selected, setSelected] = useState<Playbook | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [resolvedOptions, setResolvedOptions] = useState<Record<string, PlaybookParameterOption[]>>({});
  const [search, setSearch] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => usageTracker.getPinned());
  const [agentType, setAgentType] = useState<AgentType>(() =>
    (localStorage.getItem('kookr:defaultAgentType') as AgentType) || defaultAgentType || 'claude-code'
  );
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() =>
    (localStorage.getItem('kookr:defaultAutonomy') as AutonomyLevel) || 'supervised'
  );
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

    let filtered = playbooks;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = playbooks.filter(
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
  }, [playbooks, search, pinnedIds]);

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
    setSelected(playbook);
  }

  function handleBack() {
    setSelected(null);
    setParamValues({});
    setResolvedOptions({});
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function handleLaunch(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    usageTracker.recordLaunch(selected.id);
    usageTracker.recordParams(selected.id, selected.sourceCwd, paramValues);
    const trimmedCwd = cwd.trim();
    if (trimmedCwd) recentPaths.add(trimmedCwd);
    localStorage.setItem('kookr:defaultAutonomy', autonomy);
    localStorage.setItem('kookr:defaultAgentType', agentType);
    const excerpt = selected.name.slice(0, 40) + (selected.name.length > 40 ? '…' : '');
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
    }
    onClose();
  }

  function canLaunch(): boolean {
    if (!selected) return false;
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
    const effectiveCwd = selected.cwd ?? cwd;

    return (
      <form onSubmit={handleLaunch}>
        <div className="playbook-detail-header">
          <button type="button" className="btn-xs" onClick={handleBack}>
            Back
          </button>
          <span className="playbook-detail-name">{selected.name}</span>
          <span
            className={`project-badge color-${projectColor(effectiveCwd)}`}
            title={effectiveCwd}
          >
            {projectLabel(effectiveCwd)}
          </span>
        </div>
        {selected.description && <p className="playbook-detail-desc">{selected.description}</p>}
        <div className="playbook-cwd" title={effectiveCwd}>
          {effectiveCwd}
        </div>

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
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={handleBack}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canLaunch()}>
            Launch Playbook
          </button>
        </div>
      </form>
    );
  }

  // --- Loading state ---
  if (playbooksLoading) {
    return <div className="playbook-empty">Loading playbooks...</div>;
  }

  // --- Empty state ---
  if (playbooks.length === 0) {
    return (
      <div className="playbook-empty">
        No playbooks found.
        <br />
        Create <code>.kookr/playbooks/*.md</code> in your project.
      </div>
    );
  }

  // --- List view ---
  const recentIds = new Set(usageTracker.getRecent());

  return (
    <div>
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
                        *
                      </span>
                    )}
                    {pb.name}
                  </span>
                  <span className="playbook-card-meta">
                    {isRecent && <span className="playbook-recent-badge">recent</span>}
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
                      title={isPinned ? 'Unpin' : 'Pin to top'}
                    >
                      {isPinned ? 'unpin' : 'pin'}
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
