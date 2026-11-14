import React, { useState } from 'react';
import type { AgentState } from '../../../shared/protocol.js';
import type { ChainEndReason, TaskChainState } from '../../../shared/contracts/playbook-chain.js';
import { useKookrStore } from '../../store/useStore.js';

/**
 * Playbook-chain indicator (RFC rfc-playbook-chains): shows that a task is one
 * iteration of a chain Kookr repeats by itself, its position, and what is left.
 */

const END_LABELS: Record<ChainEndReason, string> = {
  iterations_reached: 'all iterations ran',
  deadline_reached: 'time limit reached',
  safety_cap: 'iteration ceiling reached',
  stopped: 'stopped',
  iteration_cancelled: 'iteration cancelled',
  runaway: 'iterations kept failing',
  launch_failed: 'next iteration failed to launch',
};

/** "2h 14m", "45m", "<1m". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return '<1m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Is this the chain's newest task, still able to launch another iteration? */
export function isActiveChainTip(chain: TaskChainState): boolean {
  return !chain.ended && !chain.successorTaskId;
}

/** Badge text for a task's chain state. Pure, for tests. */
export function chainBadgeLabel(chain: TaskChainState, nowMs: number): string {
  const position = chain.maxIterations !== undefined
    ? `${chain.iteration}/${chain.maxIterations}`
    : `#${chain.iteration}`;
  if (chain.ended) return `⛓ ${position} · ended: ${END_LABELS[chain.ended.reason]}`;
  if (chain.successorTaskId) return `⛓ ${position}`;
  const parts = [`⛓ ${position}`];
  if (chain.deadlineAt) {
    const left = Date.parse(chain.deadlineAt) - nowMs;
    parts.push(left > 0 ? `${formatRemaining(left)} left` : 'time up, last iteration');
  }
  if (chain.stopRequest) parts.push('stopping');
  return parts.join(' · ');
}

export function chainBadgeTitle(chain: TaskChainState): string {
  const lines = [`Playbook chain — iteration ${chain.iteration}`];
  const bounds: string[] = [];
  if (chain.maxIterations !== undefined) bounds.push(`${chain.maxIterations} iterations`);
  if (chain.deadlineAt) bounds.push(`until ${new Date(chain.deadlineAt).toLocaleString()}`);
  if (bounds.length > 0) lines.push(`Runs for ${bounds.join(' or ')}, whichever comes first.`);
  if (chain.ended) {
    lines.push(`Ended: ${END_LABELS[chain.ended.reason]}${chain.ended.detail ? ` — ${chain.ended.detail}` : ''}`);
  } else if (chain.successorTaskId) {
    lines.push('A later iteration has already been launched.');
  } else {
    lines.push('Kookr launches the next iteration when this task completes.');
    if (chain.stopRequest) {
      lines.push(`Stop requested by the ${chain.stopRequest.by}${chain.stopRequest.reason ? `: ${chain.stopRequest.reason}` : ''}; this is the last iteration.`);
    }
  }
  return lines.join('\n');
}

export function ChainBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  const chain = agent.chain;
  if (!chain) return null;
  const ended = Boolean(chain.ended);
  return (
    <span
      className={`chain-badge${ended ? ' chain-badge--ended' : ''}`}
      title={chainBadgeTitle(chain)}
      data-testid="chain-badge"
    >
      {chainBadgeLabel(chain, Date.now())}
    </span>
  );
}

/** "Stop chain" button, shown only on the active tip of a chain without a pending stop. */
export function ChainStopButton({ agent }: { agent: AgentState }): React.ReactElement | null {
  const [pending, setPending] = useState(false);
  const chain = agent.chain;
  const taskId = agent.taskId;
  if (!chain || !taskId || !isActiveChainTip(chain) || chain.stopRequest) return null;

  async function stop(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId!)}/chain/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: 'operator' }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed with ${res.status}`);
      useKookrStore.getState().handleAlert('', 'The chain will stop after this iteration.', 'info');
    } catch (err) {
      useKookrStore.getState().handleAlert('', `Could not stop chain: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      className="btn-xs chain-stop-btn"
      disabled={pending}
      title="Let the current iteration finish, then launch no more"
      aria-label="Stop chain after this iteration"
      onClick={(e) => { e.stopPropagation(); void stop(); }}
    >
      Stop chain
    </button>
  );
}
