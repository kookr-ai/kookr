import { useEffect, useState } from 'react';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

interface ReapWarningBannersProps {
  agents: AgentState[];
  send: (msg: ClientMessage) => void | boolean;
}

/**
 * Grace-period reap warnings (RFC rfc-reap-grace-warning.md). Renders a
 * countdown banner with a "Keep it alive" veto for every active task the server
 * has warned is about to be reaped. The warning rides in the snapshot on
 * `AgentState.reapWarning`, so a reconnecting client rehydrates it; the
 * countdown itself ticks locally from the server-provided `remainingMs` (which
 * is skew-free — the server computed deadline − now).
 */
export function ReapWarningBanners({ agents, send }: ReapWarningBannersProps) {
  const warned = agents.filter((a) => a.taskId && a.reapWarning);
  if (warned.length === 0) return null;
  return (
    <div className="reap-warning-banners" role="region" aria-label="Tasks about to be terminated">
      {warned.map((agent) => (
        <ReapWarningBanner key={agent.taskId} agent={agent} send={send} />
      ))}
    </div>
  );
}

function ReapWarningBanner({
  agent,
  send,
}: {
  agent: AgentState;
  send: (msg: ClientMessage) => void | boolean;
}) {
  const warning = agent.reapWarning!;
  const taskId = agent.taskId!;
  const label = agent.taskName?.trim() || agent.description?.slice(0, 60) || 'This task';

  // Local countdown: anchor a client-side deadline from the server-provided
  // remainingMs at receipt, then tick each second. When heldByPresence, the
  // server keeps pushing the deadline, so we show a held state instead of a
  // ticking countdown that would appear to freeze.
  const [deadline, setDeadline] = useState(() => Date.now() + warning.remainingMs);
  useEffect(() => {
    setDeadline(Date.now() + warning.remainingMs);
  }, [warning.remainingMs, warning.keptAliveCount, warning.heldByPresence]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, deadline - now);
  // issue #2170: the FAA ack-path reaper reuses this banner for a FINISHED task
  // being closed to free its slot. Nothing is lost (the work is done, only the
  // ack is missing), so the copy is "finished, closing" rather than "hung,
  // terminating"; `silentForMs` carries the unacknowledged age in minutes.
  const isFaa = warning.kind === 'finished_awaiting_ack';
  const hours = Math.round(warning.silentForMs / 3_600_000);
  const waitingMin = Math.max(1, Math.round(warning.silentForMs / 60_000));
  const actionVerb = isFaa ? 'closed' : 'terminated';

  return (
    <div className="reap-warning-banner" role="alert">
      <span className="reap-warning-icon" aria-hidden="true">⚠️</span>
      <div className="reap-warning-body">
        <div className="reap-warning-headline">
          {isFaa ? (
            <>
              <strong>“{label}” finished</strong>
              {` — waiting to be acknowledged for ${waitingMin}m.`}
            </>
          ) : (
            <>
              <strong>“{label}” looks hung</strong>
              {hours >= 1 ? ` — no activity for ${hours}h.` : ' — no recent activity.'}
            </>
          )}
        </div>
        <div className="reap-warning-detail">
          {warning.heldByPresence ? (
            isFaa ? (
              <>Auto-close is paused while you have this task open. Acknowledge or reopen it to keep it around.</>
            ) : (
              <>Termination is paused while you have this task open. <strong>Send it a message</strong> to keep working on it.</>
            )
          ) : warning.vetoCapReached ? (
            <>Will be {actionVerb} in <strong>{formatCountdown(remainingMs)}</strong> to free the slot. It has been kept alive {warning.keptAliveCount}× already — {isFaa ? <><strong>acknowledge it</strong> to keep it</> : <><strong>type a message and send it</strong> to keep working on this task</>}.</>
          ) : (
            <>Will be {actionVerb} in <strong>{formatCountdown(remainingMs)}</strong> to free the slot.
              {warning.keptAliveCount > 0 ? ` (kept alive ${warning.keptAliveCount}×)` : ''}</>
          )}
        </div>
      </div>
      <button
        type="button"
        className="reap-warning-keepalive"
        disabled={warning.vetoCapReached}
        onClick={() => send({ type: 'keepTaskAlive', taskId })}
        title={warning.vetoCapReached
          ? 'Keep-alive limit reached — send the task a message instead'
          : 'Cancel the scheduled termination and give yourself more time'}
      >
        Keep it alive
      </button>
    </div>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
