import React, { useEffect, useState } from 'react';

import {
  deployIntentRemainingMs,
  loadDeployIntent,
} from '../store/deploy-intent-storage.js';
import { useKookrStore } from '../store/useStore.js';

/** Compact "12s" / "1m 5s" / "3m" elapsed-time label for the banner. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * A quiet inbound stream is normal, so only after this long without a valid
 * message do we surface a freshness state (#2803). Coarse on purpose: a healthy
 * but idle fleet must not be presented as failed.
 */
export const FRESHNESS_STALE_MS = 60_000;

/**
 * How often the coarse freshness label is refreshed once data is stale (or while
 * reconnecting). Deliberately far above 1s: the label is minute-grained, so a
 * per-second render loop would buy nothing and the acceptance criteria forbid it.
 */
export const FRESHNESS_RECHECK_MS = 30_000;

/**
 * Minute-grained, neutrally worded age for the last valid inbound message.
 * Only shown once past FRESHNESS_STALE_MS, so this always reports at least 1m.
 */
export function formatFreshnessAge(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `last update ${minutes}m ago`;
}

/**
 * Connection status strip. While disconnected, prefer calm redeploy copy when
 * a short-lived client deploy-window flag is active (sessionStorage + store),
 * so intentional prod:update blackouts are not treated as incidents (#1974, #1982).
 * When a deploy is known, surface how long ago it started (#2410).
 *
 * While the socket is *connected*, the strip is normally hidden — but if no valid
 * inbound message has arrived for a while it shows a neutral "data may be stale"
 * freshness notice with a coarse last-update age (#2803), so a technically
 * connected but silently stalled stream no longer looks current. Reconnect policy
 * is untouched; this is display-only.
 *
 * The banner intentionally does NOT render a "failed deploy" verdict: the
 * browser can't see the server's real restart deadline and the sticky deploy
 * window is capped at 2 min (#1982), so any such claim here would false-alarm on
 * a legitimately slow deploy. The failed-deploy verdict lives on the `kookr`
 * CLI, which reads the marker's own `staleAfterMs` budget.
 */
export function ConnectionBanner() {
  const connected = useKookrStore((state) => state.connected);
  const deploying = useKookrStore((state) => state.deploying);
  const setDeploying = useKookrStore((state) => state.setDeploying);
  const lastInboundAt = useKookrStore((state) => state.lastInboundAt);
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

  const inboundAgeMs = lastInboundAt !== null ? Math.max(0, now - lastInboundAt) : null;
  const isStale = inboundAgeMs !== null && inboundAgeMs >= FRESHNESS_STALE_MS;

  // Coarse freshness clock (#2803). Never a per-second loop:
  //   • connected + fresh  → a single one-shot that fires exactly when the stale
  //     threshold is crossed, flipping the banner on without polling meanwhile;
  //   • connected + stale, or disconnected → a slow interval that advances the
  //     minute-grained age label.
  // A connected socket that has never received a message needs no timer.
  useEffect(() => {
    if (connected && lastInboundAt === null) return;
    if (connected && !isStale && lastInboundAt !== null) {
      const remaining = FRESHNESS_STALE_MS - (Date.now() - lastInboundAt);
      const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }
    const timer = setInterval(() => setNow(Date.now()), FRESHNESS_RECHECK_MS);
    return () => clearInterval(timer);
  }, [connected, lastInboundAt, isStale]);

  // Connected: hidden while data is fresh; a neutral freshness notice once stale.
  // No reconnect flash despite `lastInboundAt` being sticky across a disconnect:
  // the socket uses establishOn:'first-message', so `connected` only flips true
  // on the same first frame that (re)stamps freshness — there is no tick where
  // we are connected but still showing an old timestamp.
  if (connected) {
    if (!isStale || inboundAgeMs === null) return null;
    return (
      <div
        className="connection-banner connection-banner--stale"
        role="status"
        aria-live="polite"
        data-testid="connection-banner"
      >
        <span className="connection-banner__badge">Stale</span>
        <span className="connection-banner__text">
          Dashboard data may be stale — no updates received recently.
        </span>
        <span className="connection-banner__elapsed" aria-hidden="true">
          {` · ${formatFreshnessAge(inboundAgeMs)}`}
        </span>
      </div>
    );
  }

  const intent = deploying ? loadDeployIntent(now) : null;
  const elapsedMs = intent ? Math.max(0, now - intent.stampedAt) : null;

  // `badge` + `text` change only on a state transition (reconnecting ↔
  // redeploying), so the polite live region announces once per transition. The
  // per-second elapsed counter is rendered separately and marked aria-hidden —
  // otherwise, because role="status" is implicitly aria-atomic, every 1s tick
  // would re-announce the whole sentence and flood the screen-reader queue
  // (a11y review, issue #2410).
  const badge = deploying ? 'Redeploying' : 'Reconnecting';
  const text = deploying
    ? 'Redeploying production — API should return within a few seconds'
    : 'Dashboard data may be stale until the main connection is restored.';
  const elapsedLabel = deploying && elapsedMs !== null ? `started ${formatElapsed(elapsedMs)} ago` : null;
  // While reconnecting (not deploying), report how stale the data is if we ever
  // received a message — a coarse last-update age advanced by the freshness
  // clock above (#2803).
  const freshnessLabel = !deploying && isStale && inboundAgeMs !== null
    ? formatFreshnessAge(inboundAgeMs)
    : null;

  return (
    <div className="connection-banner" role="status" aria-live="polite" data-testid="connection-banner">
      <span className="connection-banner__badge">{badge}</span>
      <span className="connection-banner__text">{text}</span>
      {elapsedLabel !== null && (
        <span className="connection-banner__elapsed" aria-hidden="true">{` · ${elapsedLabel}`}</span>
      )}
      {freshnessLabel !== null && (
        <span className="connection-banner__elapsed" aria-hidden="true">{` · ${freshnessLabel}`}</span>
      )}
    </div>
  );
}
