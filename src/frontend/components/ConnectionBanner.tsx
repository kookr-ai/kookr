import React, { useEffect, useState } from 'react';

import {
  deployIntentRemainingMs,
  loadDeployIntent,
} from '../store/deploy-intent-storage.js';
import { useKookrStore } from '../store/useStore.js';

/**
 * A redeploy that has not come back within this window is more likely a failed
 * deploy than a routine restart, so the banner flips from calm "back shortly"
 * copy to an explicit "may be a failed deploy" warning (issue #2410). Kept
 * below DEPLOY_INTENT_TTL_MS (2 min) so the warning shows before the sticky
 * deploy window expires and the banner reverts to generic reconnect copy.
 */
export const REDEPLOY_STALLED_MS = 90_000;

/** Compact "12s" / "1m 5s" / "3m" elapsed-time label for the banner. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Connection status strip. While disconnected, prefer calm redeploy copy when
 * a short-lived client deploy-window flag is active (sessionStorage + store),
 * so intentional prod:update blackouts are not treated as incidents (#1974, #1982).
 * When a deploy is known, surface how long ago it started and — once it drags on
 * past REDEPLOY_STALLED_MS without reconnecting — warn that it may be a failed
 * deploy rather than a routine restart (#2410).
 */
export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  const deploying = useKookrStore((state) => state.deploying);
  const setDeploying = useKookrStore((state) => state.setDeploying);
  const [now, setNow] = useState(() => Date.now());

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

  // Tick once a second while a deploy blackout is visible so the "started Xs
  // ago" label advances and the copy can flip to the failed-deploy warning
  // without waiting for a reconnect. Only armed while the banner is showing a
  // deploy, so a steady connected dashboard schedules no timers.
  useEffect(() => {
    if (connected || !deploying) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connected, deploying]);

  if (connected) return null;

  const intent = deploying ? loadDeployIntent(now) : null;
  const elapsedMs = intent ? Math.max(0, now - intent.stampedAt) : null;
  const stalled = elapsedMs !== null && elapsedMs >= REDEPLOY_STALLED_MS;

  let badge: string;
  let text: string;
  if (deploying && stalled) {
    badge = 'Redeploy stalled';
    text = `Redeploy started ${formatElapsed(elapsedMs)} ago but the API hasn't returned — this may be a failed deploy.`;
  } else if (deploying) {
    badge = 'Redeploying';
    text = 'Redeploying production — API should return within a few seconds'
      + (elapsedMs !== null ? ` · started ${formatElapsed(elapsedMs)} ago` : '');
  } else {
    badge = 'Reconnecting';
    text = 'Dashboard data may be stale until the main connection is restored.';
  }

  return (
    <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
      <span className="connection-banner__badge">{badge}</span>
      <span className="connection-banner__text">{text}</span>
    </div>
  );
}
