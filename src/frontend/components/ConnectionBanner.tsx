import React from 'react';

import { useKookrStore } from '../store/useStore.js';

export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  if (connected) return null;

  return (
    <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
      <span className="connection-banner__badge">Reconnecting</span>
      <span className="connection-banner__text">
        Dashboard data may be stale until the main connection is restored.
      </span>
    </div>
  );
}
