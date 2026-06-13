import React from 'react';

import { useKookrStore } from '../store/useStore.js';

export function DrainModeBanner() {
  const drainStatus = useKookrStore((state) => state.drainStatus);
  if (!drainStatus.draining) return null;

  return (
    <div className="drain-mode-banner" role="status" aria-live="polite" data-testid="drain-mode-banner">
      <span className="drain-mode-banner__badge">Drain mode</span>
      <span className="drain-mode-banner__text">
        New launches and scheduled starts are paused. Running agents continue. Resume with{' '}
        <code>kookr resume</code>.
      </span>
    </div>
  );
}
