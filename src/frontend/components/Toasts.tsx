import React, { useEffect, useRef } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { Alert } from '../store/useStore.js';

export const AUTO_DISMISS_INFO_MS = 8_000;
export const AUTO_DISMISS_ERROR_MS = 15_000;

type PauseReason = 'hover' | 'focus';

interface DismissTimer {
  timeoutId: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
  pauseReasons: Set<PauseReason>;
}

function alertKey(alert: Alert): string {
  return `${alert.agentId}-${alert.timestamp.getTime()}`;
}

function alertAnnouncementText(alert: Alert): string {
  return alert.details ? `${alert.summary}. ${alert.details}` : alert.summary;
}

/**
 * Persistent live regions for toast announcements.
 *
 * Screen readers only announce content changes in regions that already exist
 * in the accessibility tree. Mounting a region with its message already present
 * (the previous `return null` when empty) routinely drops the announcement.
 * Keep polite/assertive regions mounted and inject text into them instead.
 * Visible toasts intentionally omit role/aria-live so the same text is not
 * double-read.
 */
export function Toasts() {
  const { alerts, dismissAlert } = useKookrStore();
  const timersRef = useRef<Map<string, DismissTimer>>(new Map());

  const scheduleTimer = (key: string, timer: DismissTimer) => {
    timer.startedAt = Date.now();
    timer.timeoutId = setTimeout(() => {
      timersRef.current.delete(key);
      const current = useKookrStore.getState().alerts;
      const idx = current.findIndex((alert) => alertKey(alert) === key);
      if (idx >= 0) useKookrStore.getState().dismissAlert(idx);
    }, timer.remainingMs);
  };

  const pauseTimer = (key: string, reason: PauseReason) => {
    const timer = timersRef.current.get(key);
    if (!timer || timer.pauseReasons.has(reason)) return;

    timer.pauseReasons.add(reason);
    if (timer.timeoutId !== null) {
      clearTimeout(timer.timeoutId);
      timer.timeoutId = null;
      timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
    }
  };

  const resumeTimer = (key: string, reason: PauseReason) => {
    const timer = timersRef.current.get(key);
    if (!timer) return;

    timer.pauseReasons.delete(reason);
    if (timer.pauseReasons.size === 0 && timer.timeoutId === null) {
      scheduleTimer(key, timer);
    }
  };

  useEffect(() => {
    const scheduled = timersRef.current;
    const currentKeys = new Set(alerts.map(alertKey));

    for (const [key, timer] of scheduled) {
      if (!currentKeys.has(key)) {
        if (timer.timeoutId !== null) clearTimeout(timer.timeoutId);
        scheduled.delete(key);
      }
    }

    for (const alert of alerts) {
      const key = alertKey(alert);
      if (!scheduled.has(key)) {
        const delay = alert.severity === 'error' ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_INFO_MS;
        const timer: DismissTimer = {
          timeoutId: null,
          remainingMs: delay,
          startedAt: Date.now(),
          pauseReasons: new Set(),
        };
        scheduled.set(key, timer);
        scheduleTimer(key, timer);
      }
    }
  }, [alerts]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        if (timer.timeoutId !== null) clearTimeout(timer.timeoutId);
      }
      timersRef.current.clear();
    },
    [],
  );

  const politeText = alerts
    .filter((alert) => alert.severity !== 'error')
    .map(alertAnnouncementText)
    .join(' ');
  const assertiveText = alerts
    .filter((alert) => alert.severity === 'error')
    .map(alertAnnouncementText)
    .join(' ');

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="toast-live-polite">
        {politeText}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-testid="toast-live-assertive">
        {assertiveText}
      </div>
      {alerts.length > 0 && (
        <div className="toasts">
          {alerts.map((alert, i) => (
            <div
              key={alertKey(alert)}
              className={`toast ${alert.severity === 'error' ? 'toast-error' : 'toast-info'}`}
              onMouseEnter={() => pauseTimer(alertKey(alert), 'hover')}
              onMouseLeave={() => resumeTimer(alertKey(alert), 'hover')}
              onFocus={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  pauseTimer(alertKey(alert), 'focus');
                }
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  resumeTimer(alertKey(alert), 'focus');
                }
              }}
            >
              <span className="toast-message">
                <span>{alert.summary}</span>
                {alert.details && <span className="toast-details">{alert.details}</span>}
              </span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label={`Dismiss: ${alert.summary}`}
                onClick={() => dismissAlert(i)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
