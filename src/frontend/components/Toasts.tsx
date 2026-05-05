import React, { useEffect, useRef } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { Alert } from '../store/useStore.js';

export const AUTO_DISMISS_INFO_MS = 8_000;
export const AUTO_DISMISS_ERROR_MS = 15_000;

function alertKey(alert: Alert): string {
  return `${alert.agentId}-${alert.timestamp.getTime()}`;
}

export function Toasts() {
  const { alerts, dismissAlert } = useKookrStore();
  const timersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const scheduled = timersRef.current;
    for (const alert of alerts) {
      const key = alertKey(alert);
      if (!scheduled.has(key)) {
        scheduled.add(key);
        const delay = alert.severity === 'error' ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_INFO_MS;
        setTimeout(() => {
          scheduled.delete(key);
          const current = useKookrStore.getState().alerts;
          const idx = current.findIndex((a) => alertKey(a) === key);
          if (idx >= 0) useKookrStore.getState().dismissAlert(idx);
        }, delay);
      }
    }
  }, [alerts]);

  if (alerts.length === 0) return null;

  return (
    <div className="toasts">
      {alerts.map((alert, i) => (
        <div
          key={alertKey(alert)}
          className={`toast ${alert.severity === 'error' ? 'toast-error' : 'toast-info'}`}
        >
          <span className="toast-message">{alert.summary}</span>
          <button className="toast-dismiss" onClick={() => dismissAlert(i)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
