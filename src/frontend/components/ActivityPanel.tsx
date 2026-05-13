import React, { useMemo, useRef, useEffect, useState } from 'react';
import type {
  AgentActivityMeta,
  AgentEvent,
  ActivityDisclosure,
  ActivityItem,
  ToolGroup,
  ToolGroupEntry,
} from '../../shared/protocol.js';
import { buildActivityDisclosure, summarizeActivity, compactToolSummary } from '../../shared/protocol.js';
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
}

function ToolIcon({ entry }: { entry: ToolGroupEntry }) {
  const iconMap: Record<string, { letter: string; cls: string }> = {
    read: { letter: 'R', cls: 'act-icon-read' },
    edit: { letter: 'E', cls: 'act-icon-edit' },
    bash: { letter: '$', cls: 'act-icon-bash' },
    git: { letter: 'G', cls: 'act-icon-git' },
    agent: { letter: 'A', cls: 'act-icon-agent' },
    search: { letter: 'S', cls: 'act-icon-search' },
    other: { letter: '?', cls: 'act-icon-other' },
  };
  const { letter, cls } = iconMap[entry.category] ?? iconMap.other;
  return <span className={`act-tool-icon ${cls}`}>{letter}</span>;
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
                <ToolIcon entry={entry} />
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
      );
    }

    case 'agent_message':
      return (
        <div className="act-msg act-msg-agent">
          <div className="act-msg-header">
            <span className="act-msg-label act-label-agent">Agent</span>
          </div>
          <div className="act-msg-text">{renderMarkdown(item.text)}</div>
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
        <div className="act-disclosure-line act-disclosure-malformed">
          Activity warning:{' '}
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
              <a className="act-disclosure-link" href={diagHref}>
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

export function ActivityPanel({ events, anomalyExplanation, onOpenDiff, activityMeta, taskId }: Props) {
  const items = useMemo(() => summarizeActivity(events), [events]);
  const disclosure = useMemo(
    () => buildActivityDisclosure(events.length, activityMeta),
    [events.length, activityMeta],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight) return;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distance <= 64) {
      el.scrollTop = el.scrollHeight;
      setHasUnreadBelow(false);
    } else {
      setHasUnreadBelow(true);
    }
  }, [items.length]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distance <= 8) setHasUnreadBelow(false);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setHasUnreadBelow(false);
  }

  if (items.length === 0) {
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
