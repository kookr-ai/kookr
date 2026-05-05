import React, { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';

export function SentOverlay() {
  const { sentOverlay, clearSentOverlay } = useKookrStore();

  useEffect(() => {
    if (!sentOverlay) return;
    const timer = setTimeout(clearSentOverlay, 1500);
    return () => clearTimeout(timer);
  }, [sentOverlay, clearSentOverlay]);

  if (!sentOverlay) return null;

  return (
    <div className="sent-overlay">
      <div className="sent-overlay-content">
        <span className="sent-checkmark">✓</span>
        <span>Hint sent to {sentOverlay.agentName}</span>
      </div>
    </div>
  );
}
