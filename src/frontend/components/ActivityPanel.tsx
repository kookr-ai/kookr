import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentActivityMeta,
  AgentEvent,
  ActivityDisclosure,
  ActivityItem,
  ToolCategory,
  ToolGroup,
  ToolGroupEntry,
} from '../../shared/protocol.js';
import { buildActivityDisclosure, categorizeTool, summarizeActivity, compactToolSummary, pasteBurstLabel, toolLabel } from '../../shared/protocol.js';
import { renderMarkdown } from '../markdown.js';

/**
 * Click target data for an Edit/Write entry. Sourced from
 * `ToolGroupEntry.lastEditId` + `lastEditFilePath`, which the summarizer
 * populates per-group so clicking an entry in an older group resolves to
 * that group's edit — not the most recent edit of the same file globally.
 * See docs/rfc/rfc-activity-panel-ux.md §4.
 */
export interface DiffClickTarget {
  toolUseId: string;
  filePath: string;
}

interface Props {
  events: AgentEvent[];
  anomalyExplanation?: string;
  /** Called when the user clicks an Edit/Write file entry. */
  onOpenDiff?: (target: DiffClickTarget) => void;
  /** Counters from the Kookr-side ingestion so the panel can disclose
   *  partial-window, child-activity, and malformed-record context. */
  activityMeta?: AgentActivityMeta;
  /** Task id used to deep-link the disclosure banner to its
   *  /api/tasks/:taskId/activity-diagnostics view. */
  taskId?: string;
  /** Whether the agent's current turn is still running. When true the panel
   *  shows a live row at the foot of the stream surfacing the in-flight tool
   *  call (or a generic working state between calls), so activity is visible
   *  here and not only via the left-rail spinner. */
  isActive?: boolean;
}

/** Single-letter glyph per tool category, shared by the completed-group icon
 *  and the live-row icon so both read identically. */
const CATEGORY_LETTER: Record<ToolCategory, string> = {
  read: 'R',
  edit: 'E',
  bash: '$',
  git: 'G',
  agent: 'A',
  search: 'S',
  other: '?',
};

function ToolIcon({ category }: { category: ToolCategory }) {
  return <span className={`act-tool-icon act-icon-${category}`}>{CATEGORY_LETTER[category]}</span>;
}

/**
 * Resolve the click target for an Edit/Write group entry. The summarizer
 * already scopes `lastEditId` / `lastEditFilePath` to the entry's specific
 * tool group — no event walk needed here, and no risk that a click in an
 * older group resolves to a later group's same-file edit.
 * Returns null for non-edit tools or entries without a `toolUseId` (older
 * Codex sessions may omit it) — the UI then renders the entry as disabled.
 */
function resolveClickTarget(entry: ToolGroupEntry): DiffClickTarget | null {
  if (entry.category !== 'edit') return null;
  if (!entry.lastEditId || !entry.lastEditFilePath) return null;
  return { toolUseId: entry.lastEditId, filePath: entry.lastEditFilePath };
}

function ToolGroupItem({
  group,
  onOpenDiff,
}: {
  group: ToolGroup;
  onOpenDiff?: (target: DiffClickTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = compactToolSummary(group);

  return (
    <div className="act-tool-group">
      <div
        className="act-tool-summary-line"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`act-tool-chevron${expanded ? ' expanded' : ''}`}>{'▸'}</span>
        <span className="act-tool-summary-text">{summary}</span>
        {group.totalErrors > 0 && (
          <span className="act-error-pill">{group.totalErrors} fail{group.totalErrors > 1 ? 's' : ''}</span>
        )}
      </div>
      {expanded && (
        <div className="act-tool-entries">
          {group.entries.map((entry, i) => {
            const clickTarget = onOpenDiff ? resolveClickTarget(entry) : null;
            const isClickable = clickTarget !== null;
            const className = `act-tool-entry${entry.errors > 0 ? ' has-error' : ''}${isClickable ? ' is-clickable' : ''}`;
            const content = (
              <>
                <ToolIcon category={entry.category} />
                <span className="act-tool-label">
                  {entry.detail ?? entry.toolName}
                </span>
                {entry.count > 1 && <span className="act-repeat-pill">x{entry.count}</span>}
                {entry.errors > 0 && (
                  <span className="act-error-pill">
                    {entry.errors} fail{entry.errors > 1 ? 's' : ''}
                  </span>
                )}
              </>
            );
            if (isClickable) {
              return (
                <button
                  type="button"
                  key={i}
                  className={className}
                  onClick={() => onOpenDiff!(clickTarget!)}
                  title="Click to view diff"
                >
                  {content}
                </button>
              );
            }
            return (
              <div key={i} className={className}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivityItemView({
  item,
  onOpenDiff,
}: {
  item: ActivityItem;
  onOpenDiff?: (target: DiffClickTarget) => void;
}) {
  const LONG_MESSAGE_LIMIT = 900;
  switch (item.type) {
    case 'user_message': {
      const isLong = item.text.length > LONG_MESSAGE_LIMIT;
      const preview = isLong ? `${item.text.slice(0, LONG_MESSAGE_LIMIT).trimEnd()}...` : item.text;
      return (
        <div className={`act-msg act-msg-user${isLong ? ' act-msg-collapsed' : ''}`}>
          <span className="act-msg-avatar act-avatar-user" aria-hidden="true">{'Y'}</span>
          <div className="act-msg-body">
            <div className="act-msg-header">
              <span className="act-msg-label act-label-user">You</span>
            </div>
            <div className="act-msg-text">{renderMarkdown(preview)}</div>
            {isLong && (
              <details className="act-msg-full">
                <summary>Show full prompt</summary>
                <div className="act-msg-text act-msg-full-text">{renderMarkdown(item.text)}</div>
              </details>
            )}
          </div>
        </div>
      );
    }

    case 'agent_message':
      return (
        <div className="act-msg act-msg-agent">
          <span className="act-msg-avatar act-avatar-agent" aria-hidden="true">{'A'}</span>
          <div className="act-msg-body">
            <div className="act-msg-header">
              <span className="act-msg-label act-label-agent">Agent</span>
            </div>
            <div className="act-msg-text">{renderMarkdown(item.text)}</div>
          </div>
        </div>
      );

    case 'user_paste_burst':
      // A multiline paste submitted each line as its own prompt. Collapse the
      // run into one "You" item with the raw lines tucked behind a disclosure
      // so the panel does not look like dozens of interventions. See #357.
      return (
        <div className="act-msg act-msg-user act-msg-paste-burst">
          <span className="act-msg-avatar act-avatar-user" aria-hidden="true">{'Y'}</span>
          <div className="act-msg-body">
            <div className="act-msg-header">
              <span className="act-msg-label act-label-user">You</span>
            </div>
            <details className="act-paste-burst">
              <summary className="act-paste-burst-summary">
                <span className="act-paste-burst-icon" aria-hidden="true">{'📋'}</span>
                {pasteBurstLabel(item)}
              </summary>
              {/* tabIndex makes the overflowing scroll region keyboard-reachable. */}
              <pre className="act-paste-burst-lines" tabIndex={0}>{item.lines.join('\n')}</pre>
            </details>
          </div>
        </div>
      );

    case 'tool_group':
      return <ToolGroupItem group={item} onOpenDiff={onOpenDiff} />;

    case 'system_notice':
      return (
        <div className={`act-notice act-notice-${item.subType}`}>
          <span className="act-notice-text">{item.text}</span>
        </div>
      );
  }
}

function ActivityDisclosureBanner({
  disclosure,
  taskId,
}: {
  disclosure: ActivityDisclosure;
  taskId?: string;
}) {
  const diagHref = taskId ? `/api/tasks/${taskId}/activity-diagnostics` : undefined;
  return (
    <div className="act-disclosure-banner" data-testid="act-disclosure-banner">
      {disclosure.partialWindow && (
        <div className="act-disclosure-line act-disclosure-partial">
          Showing last {disclosure.partialWindow.eventsShown} of{' '}
          {disclosure.partialWindow.totalEventsSeen} events.
        </div>
      )}
      {disclosure.childActivity && (
        <div className="act-disclosure-line act-disclosure-child">
          Child agent activity:{' '}
          {disclosure.childActivity.eventCount} event
          {disclosure.childActivity.eventCount === 1 ? '' : 's'}
          {disclosure.childActivity.foreignCount > 0
            ? ` (+${disclosure.childActivity.foreignCount} foreign)`
            : ''}{' '}
          not shown.
        </div>
      )}
      {disclosure.malformed && (
        <div
          className="act-disclosure-line act-disclosure-malformed"
          role="status"
          aria-live="polite"
        >
          <span className="act-disclosure-icon" aria-hidden="true">{'⚠'}</span>
          <span className="sr-only">Warning: </span>
          <strong>Activity warning:</strong>{' '}
          {disclosure.malformed.malformedCount > 0 && (
            <>
              {disclosure.malformed.malformedCount} hook record
              {disclosure.malformed.malformedCount === 1 ? '' : 's'} malformed
            </>
          )}
          {disclosure.malformed.malformedCount > 0 && disclosure.malformed.droppedCount > 0 && ', '}
          {disclosure.malformed.droppedCount > 0 && (
            <>
              {disclosure.malformed.droppedCount} dropped
            </>
          )}
          {diagHref && (
            <>
              {' — '}
              <a
                className="act-disclosure-link"
                href={diagHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open activity diagnostics JSON in a new tab"
              >
                open diagnostics
              </a>
            </>
          )}
          .
        </div>
      )}
    </div>
  );
}

/**
 * The tool call the agent is currently running: the most recent `tool_use`
 * event that has no matching `tool_result`/`tool_error` after it. Pairs by
 * `toolUseId` when present and falls back to `toolName` for older Codex
 * sessions that omit the id (see `resolveClickTarget`). Returns null when the
 * latest tool call has already completed, so the live row only appears for a
 * genuinely open call.
 */
export interface InFlightTool {
  /** Index in `events`. Events before it are settled and summarized normally;
   *  this one is rendered as the live row instead, so it is not shown twice. */
  index: number;
  category: ToolCategory;
  label: string;
  /** Stable identity for the elapsed clock — resets the timer only when the
   *  agent advances to a different call, not on every snapshot re-render. */
  key: string;
}

export function findInFlightTool(events: AgentEvent[]): InFlightTool | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== 'tool_use') continue;
    // The most recent tool_use. Open unless a later result/error closes it.
    const closed = events.slice(i + 1).some(
      (later) =>
        (later.type === 'tool_result' || later.type === 'tool_error') &&
        (ev.toolUseId ? later.toolUseId === ev.toolUseId : later.toolName === ev.toolName),
    );
    if (closed) return null;
    return {
      index: i,
      category: categorizeTool(ev.toolName, ev.toolInput),
      label: toolLabel(ev.toolName, ev.toolInput),
      key: ev.toolUseId ?? `${ev.toolName}:${i}`,
    };
  }
  return null;
}

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Foot-of-stream indicator shown while the agent's turn is running. Surfaces
 * the in-flight tool call (icon + label) or a generic "Working…" state between
 * calls. Events carry no wall-clock timestamp, so the elapsed timer is anchored
 * client-side from when this row first observes a given call `key` and resets
 * only when the agent moves to a different call.
 */
function LiveToolRow({ inFlight }: { inFlight: InFlightTool | null }) {
  const key = inFlight?.key ?? '__working__';
  const startRef = useRef(Date.now());
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    keyRef.current = key;
    startRef.current = Date.now();
  }
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [key]);

  return (
    <div
      className="act-live-row"
      data-testid="act-live-row"
      aria-label={inFlight ? `Agent working: ${inFlight.label}` : 'Agent working'}
    >
      <span className="act-live-spinner" aria-hidden="true" />
      {inFlight && <ToolIcon category={inFlight.category} />}
      <span className="act-live-label">{inFlight ? inFlight.label : 'Working…'}</span>
      <span className="act-live-elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
    </div>
  );
}

export function ActivityPanel({ events, anomalyExplanation, onOpenDiff, activityMeta, taskId, isActive }: Props) {
  const inFlight = useMemo(
    () => (isActive ? findInFlightTool(events) : null),
    [events, isActive],
  );
  // Drop the in-flight tool_use from the summarized history — it is rendered as
  // the live row below, and summarizeActivity would otherwise fold it into the
  // last completed tool group, showing the same call twice. Remove only that one
  // event (not the tail) so a trailing result/error for an earlier parallel call
  // is still summarized and keeps its error indicator.
  const items = useMemo(
    () => summarizeActivity(inFlight ? events.filter((_, i) => i !== inFlight.index) : events),
    [events, inFlight],
  );
  const disclosure = useMemo(
    () => buildActivityDisclosure(events.length, activityMeta),
    [events.length, activityMeta],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollLockedRef = useRef(true);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoScrollLockedRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasUnreadBelow(false);
      return;
    }
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setHasUnreadBelow(distance > 8);
  }, [items, anomalyExplanation, inFlight, isActive]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const atBottom = distance <= 8;
    autoScrollLockedRef.current = atBottom;
    setHasUnreadBelow(!atBottom);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollLockedRef.current = true;
    el.scrollTop = el.scrollHeight;
    setHasUnreadBelow(false);
  }

  // Keep the empty state only when nothing is happening. If the turn is running
  // we fall through to render the live row even before any item has landed.
  if (items.length === 0 && !isActive) {
    return (
      <div className="activity-panel">
        {disclosure && <ActivityDisclosureBanner disclosure={disclosure} taskId={taskId} />}
        <div className="act-empty">
          <p>No activity yet.</p>
          <p className="act-empty-hint">Messages and tool activity will appear here as the agent works.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-panel-wrap">
      <div className="activity-panel" ref={scrollRef} onScroll={handleScroll}>
        {anomalyExplanation && (
          <div className="act-alert-banner">
            <div className="act-alert-title">Kookr</div>
            <div className="act-alert-body">{anomalyExplanation}</div>
          </div>
        )}
        {disclosure && <ActivityDisclosureBanner disclosure={disclosure} taskId={taskId} />}
        {items.map((item, i) => (
          <ActivityItemView key={i} item={item} onOpenDiff={onOpenDiff} />
        ))}
        {isActive && <LiveToolRow inFlight={inFlight} />}
      </div>
      {hasUnreadBelow && (
        <button
          className="act-jump-bottom"
          onClick={jumpToBottom}
          aria-label="Jump to latest messages"
          title="Jump to latest"
        >
          {'↓'}
        </button>
      )}
    </div>
  );
}
