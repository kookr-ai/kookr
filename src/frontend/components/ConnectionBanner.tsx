import React, { useEffect } from 'react';

import {
  deployIntentRemainingMs,
  loadDeployIntent,
} from '../store/deploy-intent-storage.js';
import { useKookrStore } from '../store/useStore.js';

/**
 * Connection status strip. While disconnected, prefer calm redeploy copy when
 * a short-lived client deploy-window flag is active (sessionStorage + store),
 * so intentional prod:update blackouts are not treated as incidents (#1974, #1982).
 */
export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  const deploying = useKookrStore((state) => state.deploying);
  const setDeploying = useKookrStore((state) => state.setDeploying);

  // Live TTL: a long-lived tab that never remounts must still drop redeploy copy
  // once the deploy window expires (issue #1982: clear on timeout). Only armed
  // when sessionStorage still holds a stamped intent — if storage is unavailable
  // (private mode) the in-memory flag is left alone until buildInfo clear.
  //
  // On fire, re-read remaining instead of blindly clearing: a mid-window
  // setDeploying(true) re-stamps sessionStorage (status poll / reload) but does
  // not re-run this effect while `deploying` stays true, so a stale timer must
  // re-arm against the new stamp rather than wipe a still-valid window.
  useEffect(() => {
    if (!deploying) return;
    if (!loadDeployIntent()) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = deployIntentRemainingMs();
      if (remaining <= 0) {
        setDeploying(false);
        return;
      }
      timer = setTimeout(arm, remaining);
    };
    arm();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [deploying, setDeploying]);

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
