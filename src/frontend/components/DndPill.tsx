import React, { useEffect, useRef, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useDnd, DND_DURATIONS } from '../hooks/useDnd.js';

function formatRemaining(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s left`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m left`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `${hours}h left` : `${hours}h ${minutes}m left`;
}

/**
 * Counts findings whose anomaly was detected after DND was enabled.
 * Used to surface "you have N new findings since you stepped away" on the pill.
 */
function pendingDuringDnd(agents: ReturnType<typeof useKookrStore.getState>['agents'], startedAt: number | null): number {
  if (startedAt === null) return 0;
  let count = 0;
  for (const agent of agents) {
    const detected = agent.anomaly?.detectedAt;
    if (!detected) continue;
    if (new Date(detected).getTime() >= startedAt) count += 1;
  }
  return count;
}

export function DndPill() {
  const dnd = useDnd();
  const agents = useKookrStore((s) => s.agents);
  const [menuOpen, setMenuOpen] = useState(false);
  const [, setRemainingTick] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Re-render every 30s while DND is on with a deadline so the "Xm left" label updates.
  useEffect(() => {
    if (!dnd.enabled || dnd.expiresAt === null) return;
    const id = setInterval(() => setRemainingTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [dnd.enabled, dnd.expiresAt]);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const pending = dnd.enabled ? pendingDuringDnd(agents, dnd.startedAt) : 0;
  const remainingMs = dnd.enabled && dnd.expiresAt !== null ? dnd.expiresAt - Date.now() : null;
  const remainingLabel = remainingMs !== null ? formatRemaining(remainingMs) : null;

  function togglePill() {
    if (dnd.enabled) {
      dnd.disable();
    } else {
      dnd.enable(null);
    }
  }

  function selectDuration(durationMs: number | null) {
    dnd.enable(durationMs);
    setMenuOpen(false);
  }

  const stateClass = dnd.enabled ? (pending > 0 ? 'dnd-pill-pending' : 'dnd-pill-on') : 'dnd-pill-off';
  const title = dnd.enabled
    ? pending > 0
      ? `Do Not Disturb on${remainingLabel ? ` · ${remainingLabel}` : ''} · ${pending} new finding${pending !== 1 ? 's' : ''} arrived. Click to turn off.`
      : `Do Not Disturb on${remainingLabel ? ` · ${remainingLabel}` : ''}. Click to turn off.`
    : 'Do Not Disturb is off. Click to silence findings while you step away.';

  return (
    <div className="dnd-pill-wrapper" ref={wrapperRef}>
      <button
        className={`dnd-pill ${stateClass}`}
        onClick={togglePill}
        aria-label={title}
        aria-pressed={dnd.enabled}
        title={title}
      >
        <span className="dnd-pill-icon" aria-hidden="true">
          {dnd.enabled ? '●' : '○'}
        </span>
        <span className="dnd-pill-label">DND</span>
        {dnd.enabled && pending > 0 && (
          <span className="dnd-pill-count" aria-label={`${pending} new`}>{pending}</span>
        )}
        {dnd.enabled && remainingLabel && pending === 0 && (
          <span className="dnd-pill-remaining">{remainingLabel}</span>
        )}
      </button>
      <button
        className="dnd-pill-caret"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Choose Do Not Disturb duration"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Choose duration"
      >
        <span aria-hidden="true">{'▾'}</span>
      </button>
      {menuOpen && (
        <div className="dnd-pill-menu" role="menu" ref={popoverRef}>
          <div className="dnd-pill-menu-header">Silence findings for…</div>
          {DND_DURATIONS.map((preset) => (
            <button
              key={preset.label}
              role="menuitem"
              className="dnd-pill-menu-item"
              onClick={() => selectDuration(preset.durationMs)}
            >
              {preset.label}
            </button>
          ))}
          {dnd.enabled && (
            <button
              role="menuitem"
              className="dnd-pill-menu-item dnd-pill-menu-disable"
              onClick={() => {
                dnd.disable();
                setMenuOpen(false);
              }}
            >
              Turn off Do Not Disturb
            </button>
          )}
        </div>
      )}
    </div>
  );
}
