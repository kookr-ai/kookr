import React from 'react';

import { useKookrStore } from '../store/useStore.js';

/**
 * Persistent banner while the automation kill-switch is engaged (issue #1710).
 * Mirrors DrainModeBanner but for SAFE MODE — schedule fires halted, manual
 * launches remain accepted.
 */
export function SafeModeBanner() {
  const safeMode = useKookrStore((state) => state.safeMode);
  if (!safeMode.engaged) return null;

  const sinceLabel = safeMode.since ? ` since ${safeMode.since}` : '';
  const loadErrorText = typeof safeMode.loadError === 'string' && safeMode.loadError.length > 0
    ? safeMode.loadError
    : null;

  return (
    <div className="safe-mode-banner" role="status" aria-live="polite" data-testid="safe-mode-banner">
      <span className="safe-mode-banner__badge">SAFE MODE{sinceLabel}</span>
      <span className="safe-mode-banner__text">
        {loadErrorText
          ? `Settings load error forced fail-closed SAFE MODE (${loadErrorText}). Schedule fires and autonomous launches are paused until settings recover. Manual launches still work.`
          : 'Automation kill-switch engaged — schedule fires and autonomous launches are paused. Manual launches still work. Disable via Settings → Automation kill-switch.'}
      </span>
    </div>
  );
}
