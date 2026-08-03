import React from 'react';

import { useKookrStore } from '../store/useStore.js';

export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  const deploying = useKookrStore((state) => state.deploying);
  if (connected) return null;

  if (deploying) {
    return (
      <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
        <span className="connection-banner__badge">Redeploying</span>
        <span className="connection-banner__text">
          Redeploying production — API should return within a few seconds
        </span>
      </div>
    );
  }

  return (
    <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
      <span className="connection-banner__badge">Reconnecting</span>
      <span className="connection-banner__text">
        Dashboard data may be stale until the main connection is restored.
      </span>
    </div>
  );
}
