import React, { useMemo, useRef, useEffect, useState } from 'react';
import type { AgentEvent, ActivityItem, ToolGroup, ToolGroupEntry } from '../../shared/protocol.js';
import { summarizeActivity, compactToolSummary } from '../../shared/protocol.js';
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
  switch (item.type) {
    case 'user_message':
      return (
        <div className="act-msg act-msg-user">
          <div className="act-msg-header">
            <span className="act-msg-label act-label-user">You</span>
          </div>
          <div className="act-msg-text">{renderMarkdown(item.text)}</div>
        </div>
      );

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

export function ActivityPanel({ events, anomalyExplanation, onOpenDiff }: Props) {
  const items = useMemo(() => summarizeActivity(events), [events]);
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
