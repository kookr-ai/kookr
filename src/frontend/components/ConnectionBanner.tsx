import React from 'react';

import { useKookrStore } from '../store/useStore.js';

export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  const deploying = useKookrStore((state) => state.deploying);
  if (connected) return null;

  const badge = deploying ? 'Redeploying' : 'Reconnecting';
  const text = deploying
    ? 'Redeploying production — API should return within a few seconds'
    : 'Dashboard data may be stale until the main connection is restored.';

  return (
    <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
      <span className="connection-banner__badge">{badge}</span>
      <span className="connection-banner__text">{text}</span>
    </div>
  );
}
