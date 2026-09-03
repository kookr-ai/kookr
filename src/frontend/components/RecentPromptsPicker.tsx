import React, { useMemo, useState } from 'react';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';
import { formatRelativeTimeAgo } from '../presentation.js';

interface Props {
  /** Recalled prompts, already ranked by the server (cwd-matches first, recent first). */
  entries: RecentPromptEntry[];
  /** The dialog's current working directory — decides the "in <repo>" tag. */
  currentCwd: string;
  /**
   * Fill the Task description with the chosen prompt (no submit). `meta` carries
   * telemetry dimensions: whether the entry matched the current cwd, and its
   * 0-based rank in the (filtered) list at click time.
   */
  onSelect: (prompt: string, meta: { cwdMatch: boolean; rank: number }) => void;
}

const PANEL_ID = 'recent-prompts-panel';

/** Last path segment of a directory, for the compact "in <repo>" tag. */
function repoBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** One-line excerpt of a possibly-multiline prompt, for the collapsed row. */
function excerpt(prompt: string, max = 80): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Recall picker for the Launch dialog's manual tab (RFC: rfc-launch-prompt-recall).
 *
 * Presentational + local view state only (open toggle + filter text). The fetch
 * lives in `useRecentPrompts`; selecting a row emits `onSelect(prompt)` — the same
 * "fill the field, don't submit" effect as a sample-prompt chip. Renders nothing
 * when there is no history, so there is no dead affordance (R8/R10).
 */
export function RecentPromptsPicker({ entries, currentCwd, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.prompt.toLowerCase().includes(q));
  }, [entries, filter]);

  if (entries.length === 0) return null;

  return (
    <div className="recent-prompts">
      <button
        type="button"
        className="recent-prompts-toggle"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Recent prompts ({entries.length})
      </button>
      {open && (
        // A plain list of buttons — selecting a row just fills the description
        // field (like a sample-prompt chip), so this is deliberately NOT a
        // listbox/option widget (no persistent selection, no arrow-key model).
        <div id={PANEL_ID} className="recent-prompts-panel" role="group" aria-label="Recent prompts">
          <input
            type="text"
            className="recent-prompts-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter these prompts"
            aria-label="Filter recent prompts"
          />
          {filtered.length === 0 ? (
            <p className="recent-prompts-empty" role="note">No prompts match the filter.</p>
          ) : (
            <ul className="recent-prompts-list">
              {filtered.map((entry, i) => {
                const showRepoTag = !entry.cwdMatch && entry.cwd.trim() !== currentCwd.trim();
                return (
                  <li key={`${entry.at}-${i}`}>
                    <button
                      type="button"
                      className="recent-prompts-item"
                      title={entry.prompt}
                      onClick={() => {
                        onSelect(entry.prompt, { cwdMatch: entry.cwdMatch, rank: i });
                        setOpen(false);
                      }}
                    >
                      <span className="recent-prompts-item-text">{excerpt(entry.prompt)}</span>
                      <span className="recent-prompts-item-meta">
                        {showRepoTag && (
                          <span className="recent-prompts-item-repo" title={entry.cwd}>
                            in {repoBasename(entry.cwd)}
                          </span>
                        )}
                        <span className="recent-prompts-item-time">
                          {formatRelativeTimeAgo(new Date(entry.at))}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
