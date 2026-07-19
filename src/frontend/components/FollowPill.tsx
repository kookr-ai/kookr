import React, { useEffect, useRef, useState } from 'react';
import {
  detectShortcutPlatform,
  formatShortcutBinding,
  getDefaultShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { useKookrStore } from '../store/useStore.js';
import {
  describeSwitchCause,
  describeTickReason,
} from '../store/slices/auto-advance-slice.js';

function timeAgo(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 5) return 'just now';
  if (totalSec < 60) return `${totalSec}s ago`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

interface Props {
  /** Resolved platform/user binding map; defaults match OverviewEmptyState. */
  shortcutBindings?: ShortcutBindingMap;
}

/**
 * TopBar pill that toggles Auto-Advance mode and surfaces its current
 * decision state via a caret popover. Mirrors `DndPill` visually and
 * structurally for consistency. Hidden on mobile via CSS.
 */
export function FollowPill({
  shortcutBindings = getDefaultShortcutBindings(detectShortcutPlatform()),
}: Props) {
  const enabled = useKookrStore((s) => s.autoAdvanceEnabled);
  const lastReason = useKookrStore((s) => s.lastTickReason);
  const lastSwitch = useKookrStore((s) => s.lastAutoSwitch);
  const error = useKookrStore((s) => s.autoAdvanceError);
  const toggle = useKookrStore((s) => s.toggleAutoAdvance);

  const [menuOpen, setMenuOpen] = useState(false);
  const [, setTick] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

  // Re-render every 15 s while a popover is open so "Ns ago" stays fresh.
  useEffect(() => {
    if (!menuOpen) return;
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, [menuOpen]);

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

  // Escape closes the popover and returns focus to the caret (dialog pattern).
  useEffect(() => {
    if (!menuOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
        caretRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [menuOpen]);

  const stateClass = enabled ? 'follow-pill-on' : 'follow-pill-off';
  const shortcutLabel = formatShortcutBinding(shortcutBindings.toggle_auto_advance);
  const title = enabled
    ? `Auto-Advance is on. The dashboard may switch to a higher-priority project. Press ${shortcutLabel} to turn off.`
    : `Auto-Advance is off. Press ${shortcutLabel} to let the dashboard follow priority automatically.`;

  const reasonLabel = enabled ? describeTickReason(lastReason) : 'Off';
  const lastSwitchLabel = lastSwitch
    ? `${lastSwitch.from ?? '—'} → ${lastSwitch.to} · ${describeSwitchCause(lastSwitch.cause)} · ${timeAgo(Date.now() - lastSwitch.ts)}`
    : 'No switches yet';
  const errorLabel = error
    ? `Internal error — first seen ${timeAgo(Date.now() - error.firstSeenTs)}. Will resume on next state change.`
    : null;

  return (
    <div className="follow-pill-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className={`follow-pill ${stateClass}`}
        onClick={toggle}
        aria-label={title}
        aria-pressed={enabled}
        title={title}
      >
        <span className="follow-pill-icon" aria-hidden="true">
          {enabled ? '●' : '○'}
        </span>
        <span className="follow-pill-label">FOLLOW</span>
      </button>
      <button
        ref={caretRef}
        type="button"
        className="follow-pill-caret"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Auto-Advance details"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        title="Auto-Advance details"
      >
        <span aria-hidden="true">{'▾'}</span>
      </button>
      {menuOpen && (
        // Disclosure panel of static info + one action. Not a menu — its
        // children are info rows, not menuitems. Use role="dialog" so screen
        // readers expose the rows in reading order, not in menu-navigation mode.
        <div className="follow-pill-menu" role="dialog" aria-label="Auto-Advance details">
          <div className="follow-pill-menu-row">
            <span className="follow-pill-menu-label">Status</span>
            <span className="follow-pill-menu-value">
              {enabled ? 'On' : 'Off'}
            </span>
          </div>
          {enabled && (
            <div className="follow-pill-menu-row">
              <span className="follow-pill-menu-label">Why no switch?</span>
              <span className="follow-pill-menu-value">{reasonLabel}</span>
            </div>
          )}
          <div className="follow-pill-menu-row">
            <span className="follow-pill-menu-label">Last switch</span>
            <span className="follow-pill-menu-value">{lastSwitchLabel}</span>
          </div>
          {errorLabel && (
            <div className="follow-pill-menu-row follow-pill-menu-error">
              <span className="follow-pill-menu-value">{errorLabel}</span>
            </div>
          )}
          <button
            type="button"
            className="follow-pill-menu-item"
            onClick={() => {
              toggle();
              setMenuOpen(false);
            }}
          >
            {enabled ? 'Turn off Auto-Advance' : 'Turn on Auto-Advance'}
          </button>
        </div>
      )}
    </div>
  );
}
