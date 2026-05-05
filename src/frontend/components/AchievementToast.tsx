import React, { useEffect, useRef } from 'react';
import { useKookrStore } from '../store/useStore.js';

const AUTO_DISMISS_MS = 5_000;

export function AchievementToasts() {
  const { achievementToasts, achievementsEnabled } = useKookrStore();
  const timersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const scheduled = timersRef.current;
    for (const toast of achievementToasts) {
      const key = `${toast.id}-${toast.timestamp}`;
      if (!scheduled.has(key)) {
        scheduled.add(key);
        setTimeout(() => {
          scheduled.delete(key);
          const store = useKookrStore.getState();
          store.dismissAchievementToast(toast.id);
        }, AUTO_DISMISS_MS);
      }
    }
  }, [achievementToasts]);

  if (!achievementsEnabled || achievementToasts.length === 0) return null;

  // Coalesce multiple simultaneous toasts
  if (achievementToasts.length > 1) {
    return (
      <div className="achievement-toasts">
        <div className="achievement-toast">
          <span className="achievement-toast-emoji">🏆</span>
          <div className="achievement-toast-content">
            <span className="achievement-toast-name">{achievementToasts.length} achievements unlocked!</span>
            <span className="achievement-toast-desc">
              {achievementToasts.map((t) => t.name).join(', ')}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const toast = achievementToasts[0];
  return (
    <div className="achievement-toasts">
      <div className="achievement-toast">
        <span className="achievement-toast-emoji">{toast.emoji}</span>
        <div className="achievement-toast-content">
          <span className="achievement-toast-name">{toast.name}</span>
          <span className="achievement-toast-desc">{toast.description}</span>
        </div>
      </div>
    </div>
  );
}
