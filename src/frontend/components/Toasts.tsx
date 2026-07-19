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

  if (alerts.length === 0) return null;

  return (
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
          role={alert.severity === 'error' ? 'alert' : 'status'}
          aria-live={alert.severity === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <span className="toast-message">
            <span>{alert.summary}</span>
            {alert.details && <span className="toast-details">{alert.details}</span>}
          </span>
          <button className="toast-dismiss" onClick={() => dismissAlert(i)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
