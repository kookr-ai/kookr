import React, { useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { ClientMessage, CircuitBreakerSnapshot } from '../../shared/protocol.js';

interface Props {
  send: (msg: ClientMessage) => void;
}

const STATE_LABEL: Record<string, string> = {
  closed: 'Closed',
  open: 'Open',
  'half-open': 'Half-Open',
};

const STATE_CLASS: Record<string, string> = {
  closed: 'cb-state-closed',
  open: 'cb-state-open',
  'half-open': 'cb-state-half-open',
};

function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 1000) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatTimeUntilRearm(snapshot: CircuitBreakerSnapshot): string | null {
  if (snapshot.state !== 'open') return null;
  const elapsed = Date.now() - snapshot.lastStateChange;
  const remaining = snapshot.resetTimeoutMs - elapsed;
  if (remaining <= 0) return 'imminent';
  const sec = Math.ceil(remaining / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.ceil(sec / 60)}m`;
}

function BreakerRow({ breaker, send }: { breaker: CircuitBreakerSnapshot; send: Props['send'] }) {
  const timeUntilRearm = formatTimeUntilRearm(breaker);
  return (
    <div className="cb-row">
      <span className={`cb-state-dot ${STATE_CLASS[breaker.state]}`} />
      <span className="cb-name">{breaker.name}</span>
      <span className={`cb-state-label ${STATE_CLASS[breaker.state]}`}>
        {STATE_LABEL[breaker.state]}
      </span>
      {breaker.failureCount > 0 && (
        <span className="cb-failures">{breaker.failureCount} fail{breaker.failureCount !== 1 ? 's' : ''}</span>
      )}
      {breaker.lastFailureTime && (
        <span className="cb-last-failure">{formatTimeAgo(breaker.lastFailureTime)}</span>
      )}
      {timeUntilRearm && (
        <span className="cb-rearm-countdown">rearm in {timeUntilRearm}</span>
      )}
      {breaker.state !== 'closed' && (
        <button
          className="cb-rearm-btn"
          onClick={() => send({ type: 'rearmCircuitBreaker', name: breaker.name })}
          title={`Manually rearm the ${breaker.name} circuit breaker`}
        >
          Rearm
        </button>
      )}
    </div>
  );
}

export function CircuitBreakerPanel({ send }: Props) {
  const [expanded, setExpanded] = useState(false);
  const breakers = useKookrStore((s) => s.circuitBreakers);

  if (breakers.length === 0) return null;

  const openCount = breakers.filter(b => b.state !== 'closed').length;

  return (
    <div className="circuit-breaker-section">
      <div className="section-header" onClick={() => setExpanded(!expanded)}>
        <span className="section-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="stats-label">
          Circuit Breakers
          <span className="stats-summary">
            {openCount > 0
              ? `${openCount} tripped`
              : 'all healthy'}
          </span>
        </span>
      </div>
      {expanded && (
        <div className="cb-body">
          {breakers.map((b) => (
            <BreakerRow key={b.name} breaker={b} send={send} />
          ))}
        </div>
      )}
    </div>
  );
}
