import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { ACHIEVEMENT_CATALOG } from '../../core/achievement-catalog.js';
import type { AchievementDefinition } from '../../core/achievement-catalog.js';
import type { ClientMessage } from '../../shared/protocol.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Props {
  onClose: () => void;
  send: (msg: ClientMessage) => void;
}

const CATEGORY_LABELS: Record<AchievementDefinition['category'], string> = {
  'first-steps': 'First Steps',
  'feature-discovery': 'Feature Discovery',
  'multi-agent': 'Multi-Agent Mastery',
  'easter-egg': 'Easter Eggs',
};

const CATEGORY_ORDER: AchievementDefinition['category'][] = [
  'first-steps',
  'feature-discovery',
  'multi-agent',
  'easter-egg',
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AchievementsPanel({ onClose, send }: Props) {
  const achievements = useKookrStore((s) => s.achievements);
  const achievementsEnabled = useKookrStore((s) => s.achievementsEnabled);
  const setAchievementsEnabled = useKookrStore((s) => s.setAchievementsEnabled);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Group catalog by category
  const grouped = useMemo(() => {
    const groups = new Map<AchievementDefinition['category'], AchievementDefinition[]>();
    for (const cat of CATEGORY_ORDER) groups.set(cat, []);
    for (const a of ACHIEVEMENT_CATALOG) {
      groups.get(a.category)!.push(a);
    }
    return groups;
  }, []);

  const unlockedCount = Object.keys(achievements).length;
  const totalCount = ACHIEVEMENT_CATALOG.length;

  useEscapeToClose(onClose);

  // Close on Alt+A (toggle shortcut)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const handleReset = useCallback(() => {
    setResetting(true);
    send({ type: 'achievement:reset' });

    // Listen for ack with timeout
    const timeout = setTimeout(() => {
      setResetting(false);
      setShowResetConfirm(false);
    }, 5000);

    function onAck(e: Event) {
      clearTimeout(timeout);
      const detail = (e as CustomEvent).detail;
      if (detail.success) {
        useKookrStore.setState({ achievements: {} });
      }
      setResetting(false);
      setShowResetConfirm(false);
      window.removeEventListener('achievement-reset-ack', onAck);
    }
    window.addEventListener('achievement-reset-ack', onAck);
  }, [send]);

  const handleToggleEnabled = useCallback(() => {
    const next = !achievementsEnabled;
    setAchievementsEnabled(next);
    send({ type: 'achievement:setEnabled', enabled: next });
  }, [achievementsEnabled, setAchievementsEnabled, send]);

  if (showResetConfirm) {
    return (
      <ConfirmDialog
        title="Reset Achievements"
        message="Reset all achievement progress? This cannot be undone."
        confirmLabel={resetting ? 'Resetting...' : 'Reset'}
        confirmClass="btn-danger"
        onConfirm={handleReset}
        onClose={() => setShowResetConfirm(false)}
      />
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="achievements-panel" onClick={(e) => e.stopPropagation()}>
        <div className="achievements-header">
          <div>
            <h3>Achievements</h3>
            <span className="achievements-progress">
              {unlockedCount} of {totalCount} unlocked
            </span>
          </div>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {!achievementsEnabled && (
          <div className="achievements-disabled-message">
            Achievements are disabled. Enable to start tracking.
          </div>
        )}

        <div className="achievements-body">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped.get(cat)!;
            if (items.length === 0) return null;
            return (
              <div key={cat} className="achievements-category">
                <h4>{CATEGORY_LABELS[cat]}</h4>
                {items.map((a) => {
                  const unlocked = a.id in achievements;
                  const isEasterEgg = a.category === 'easter-egg';
                  return (
                    <div key={a.id} className={`achievement-item ${unlocked ? 'unlocked' : 'locked'}`}>
                      <span className="achievement-emoji">{a.emoji}</span>
                      <div className="achievement-info">
                        <span className="achievement-name">{a.name}</span>
                        <span className="achievement-desc">
                          {unlocked || !isEasterEgg ? a.description : 'A surprise awaits...'}
                        </span>
                        {unlocked ? (
                          <span className="achievement-meta earned">
                            Earned {formatDate(achievements[a.id])}
                          </span>
                        ) : (
                          a.hint && (
                            <span className="achievement-meta hint">
                              Hint: {a.hint}
                            </span>
                          )
                        )}
                      </div>
                      <span className="achievement-status">
                        {unlocked ? '\u2713' : '\u{1F512}'}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="achievements-footer">
          <button
            className={`btn-toggle ${achievementsEnabled ? 'on' : 'off'}`}
            onClick={handleToggleEnabled}
          >
            Achievements: {achievementsEnabled ? 'ON' : 'OFF'}
          </button>
          <button
            className="btn-secondary"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset Progress
          </button>
        </div>

        <div className="achievements-hint">
          Press <kbd>Alt+A</kbd> or <kbd>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
