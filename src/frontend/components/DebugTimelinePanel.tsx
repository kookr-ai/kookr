import React, { useEffect, useMemo, useState } from 'react';
import type { DebugTimelineEntry, DebugTimelineKind } from '../debug-timeline.js';
import {
  clearDebugTimeline,
  getDebugTimelineEntries,
  subscribeDebugTimeline,
} from '../debug-timeline.js';

interface Props {
  onExport: () => void;
}

type KindFilter = 'all' | DebugTimelineKind;

export function DebugTimelinePanel({ onExport }: Props) {
  const [entries, setEntries] = useState<DebugTimelineEntry[]>(() => getDebugTimelineEntries());
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => subscribeDebugTimeline(() => setEntries(getDebugTimelineEntries())), []);

  const handleClear = () => {
    clearDebugTimeline();
    setEntries([]);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (kind !== 'all' && entry.kind !== kind) return false;
      if (!needle) return true;
      return `${entry.summary} ${entry.tags.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [entries, kind, query]);

  return (
    <section className="debug-timeline-panel" aria-label="Debug timeline">
      <div className="debug-timeline-header">
        <div>
          <h2>Debug Timeline</h2>
          <span>{entries.length} captured</span>
        </div>
        <div className="debug-timeline-actions">
          <button type="button" className="btn-secondary" onClick={handleClear}>
            Clear
          </button>
          <button type="button" className="btn-primary" onClick={onExport}>
            Export trace
          </button>
        </div>
      </div>
      <div className="debug-timeline-filters">
        <select
          aria-label="Debug timeline kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as KindFilter)}
        >
          <option value="all">All</option>
          <option value="websocket">WebSocket</option>
          <option value="store">Store</option>
          <option value="finding-lifecycle">Finding lifecycle</option>
          <option value="longtask">Long task</option>
        </select>
        <input
          aria-label="Debug timeline filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
        />
      </div>
      <ol className="debug-timeline-list">
        {filtered.map((entry) => (
          <li key={entry.sequence} className={`debug-timeline-entry debug-timeline-entry--${entry.kind}`}>
            <time>{formatTime(entry.t)}</time>
            <div>
              <strong>{entry.summary}</strong>
              <span>{entry.tags.slice(0, 6).join(' · ')}</span>
            </div>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="debug-timeline-empty">No matching trace events</li>
        )}
      </ol>
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
