import React, { useMemo, useState } from 'react';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import type {
  CoordinatorChainStrip,
  CoordinatorFinding,
  CoordinatorSnapshotState,
  CoordinatorTaskChip,
} from '../../shared/contracts/coordinator.js';
import { useKookrStore } from '../store/useStore.js';

const GLYPHS: Record<string, string> = {
  chain: '⛓',
  clock: '◷',
  match: '≡',
  check: '✓',
};
const SNOOZE_BACKOFF_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

export function coordinatorChipForTask(
  coordinator: CoordinatorSnapshotState | null,
  taskId: string | undefined,
): CoordinatorTaskChip | null {
  if (!coordinator || !taskId) return null;
  return coordinator.chips.find((chip) => chip.taskId === taskId) ?? null;
}

export function CoordinatorTaskChipView({
  chip,
  agent,
  send,
}: {
  chip: CoordinatorTaskChip | null;
  agent: AgentState;
  send: (msg: ClientMessage) => boolean | void;
}): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  if (!chip) return null;

  async function suppressChip(scope: 'class' | 'task'): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(scope === 'task' ? '/api/coordinator/acknowledgements' : '/api/coordinator/suppressions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: agent.taskId,
          detectorId: chip.detectorId,
          agentType: chip.agentType,
        }),
      });
    } finally {
      setBusy(false);
    }
  }

  function runAction(e: React.MouseEvent) {
    e.stopPropagation();
    if (!agent.taskId) return;
    switch (chip.action) {
      case 'nudge':
        send({
          type: 'directReply',
          agentId: agent.agentId,
          input: 'Please provide a concise status update and the next concrete step.',
        });
        return;
      case 'compare': {
        const peerId = chip.peerTaskIds?.[0];
        const peer = useKookrStore.getState().agents.find((candidate) => candidate.taskId === peerId);
        if (peer) useKookrStore.getState().selectAgent(peer.agentId);
        return;
      }
      case 'acknowledge':
        void suppressChip('task');
        return;
      case 'snooze': {
        const durationMs = nextCoordinatorSnoozeDuration(chip);
        send({
          type: 'snooze',
          agentId: agent.agentId,
          taskId: agent.taskId,
          durationMs,
          reason: `coordinator:${chip.detectorId}`,
          resumeMonitoring: true,
        });
        recordCoordinatorSnooze(chip);
        return;
      }
    }
  }

  async function suppress(e: React.MouseEvent) {
    e.stopPropagation();
    await suppressChip('class');
  }

  return (
    <div className="coordinator-chip" title={chip.title} data-testid={`coordinator-chip-${chip.detectorId}`}>
      <button
        type="button"
        className="coordinator-chip-action"
        aria-label={`${chip.verb}, ${chip.evidenceCount} evidence item${chip.evidenceCount === 1 ? '' : 's'}`}
        onClick={runAction}
      >
        <span className="coordinator-chip-verb">{chip.verb}</span>
        <span className="coordinator-chip-evidence" aria-label={`${chip.evidenceCount} evidence item(s)`}>
          {GLYPHS[chip.evidenceGlyph] ?? chip.evidenceGlyph} {chip.evidenceCount}
        </span>
      </button>
      <button
        type="button"
        className="coordinator-chip-dismiss"
        aria-label={`Suppress ${chip.detectorId} recommendations for ${chip.agentType}`}
        disabled={busy}
        onClick={suppress}
      >
        ×
      </button>
    </div>
  );
}

function coordinatorSnoozeKey(chip: CoordinatorTaskChip): string {
  return `kookr:coordinator-snooze:${chip.detectorId}:${chip.agentType}`;
}

function nextCoordinatorSnoozeDuration(chip: CoordinatorTaskChip): number {
  if (typeof window === 'undefined') return SNOOZE_BACKOFF_MS[0]!;
  const count = Number.parseInt(window.localStorage.getItem(coordinatorSnoozeKey(chip)) ?? '0', 10);
  return SNOOZE_BACKOFF_MS[Math.min(Number.isFinite(count) ? count : 0, SNOOZE_BACKOFF_MS.length - 1)]!;
}

function recordCoordinatorSnooze(chip: CoordinatorTaskChip): void {
  if (typeof window === 'undefined') return;
  const key = coordinatorSnoozeKey(chip);
  const count = Number.parseInt(window.localStorage.getItem(key) ?? '0', 10);
  window.localStorage.setItem(key, String((Number.isFinite(count) ? count : 0) + 1));
}

export function CoordinatorChainStripView({
  agent,
}: {
  agent: AgentState;
}): React.ReactElement | null {
  const coordinator = useKookrStore((s) => s.coordinator);
  const chain = agent.taskId ? coordinator?.chains[agent.taskId] : undefined;
  const [status, setStatus] = useState<string | null>(null);
  if (!chain) return null;

  async function markPriorDone() {
    if (!agent.taskId || chain.priorTaskIds.length === 0) return;
    setStatus('Checking...');
    try {
      const res = await fetch('/api/coordinator/mark-prior-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: agent.taskId,
          priorTaskIds: chain.priorTaskIds,
          concurrencyToken: chain.concurrencyToken,
        }),
      });
      const body = await res.json() as { error?: string };
      setStatus(res.ok ? 'Marked prior tasks done' : body.error ?? 'Coordinator check failed');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="coordinator-chain-strip" data-testid="coordinator-chain-strip" aria-label="Task chain">
      <div className="coordinator-chain-members">
        {chain.members.map((member) => (
          <ChainMember key={`${member.relation}:${member.taskId}`} member={member} />
        ))}
      </div>
      {chain.priorTaskIds.length > 0 && (
        <button type="button" className="action-btn action-btn--neutral coordinator-chain-action" onClick={markPriorDone}>
          Mark prior {chain.priorTaskIds.length} done
        </button>
      )}
      {status && (
        <div className="coordinator-chain-status" role="status">
          {status}
        </div>
      )}
    </section>
  );
}

function ChainMember({ member }: { member: CoordinatorChainStrip['members'][number] }) {
  return (
    <span className={`coordinator-chain-member coordinator-chain-member--${member.relation}`} title={member.taskId}>
      <span className="coordinator-chain-relation">{relationLabel(member.relation)}</span>
      <span className="coordinator-chain-label">{member.label}</span>
      <span className="coordinator-chain-state">{member.status}</span>
    </span>
  );
}

function relationLabel(relation: CoordinatorChainStrip['members'][number]['relation']): string {
  switch (relation) {
    case 'parent': return 'parent';
    case 'child': return 'child';
    case 'blocks': return 'blocks';
    case 'blocked_by': return 'blocked by';
  }
}

export function CoordinatorFindingsPane({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const coordinator = useKookrStore((s) => s.coordinator);
  const agents = useKookrStore((s) => s.agents);
  const findings = coordinator?.findings ?? [];
  const tasksById = useMemo(() => {
    const map = new Map<string, AgentState>();
    for (const agent of agents) {
      if (agent.taskId && !map.has(agent.taskId)) map.set(agent.taskId, agent);
    }
    return map;
  }, [agents]);

  if (!open) return null;
  return (
    <aside className="coordinator-findings-pane" data-testid="coordinator-findings-pane" aria-label="Coordinator findings">
      <div className="coordinator-findings-header">
        <h2>Coordinator findings</h2>
        <button type="button" className="btn-icon" aria-label="Close coordinator findings" onClick={onClose}>×</button>
      </div>
      {findings.length === 0 ? (
        <div className="coordinator-finding-empty">No coordinator findings.</div>
      ) : (
        <div className="coordinator-finding-list">
          {findings.map((finding) => (
            <CoordinatorFindingCard key={finding.id} finding={finding} tasksById={tasksById} />
          ))}
        </div>
      )}
    </aside>
  );
}

function CoordinatorFindingCard({
  finding,
  tasksById,
}: {
  finding: CoordinatorFinding;
  tasksById: ReadonlyMap<string, AgentState>;
}) {
  function selectFirst() {
    const agent = finding.taskIds.map((taskId) => tasksById.get(taskId)).find(Boolean);
    if (agent) useKookrStore.getState().selectAgent(agent.agentId);
  }

  return (
    <div className={`coordinator-finding-card coordinator-finding-card--${finding.kind}`}>
      <div className="coordinator-finding-title">
        <span>{finding.title}</span>
        <span className="coordinator-finding-count">{GLYPHS[finding.evidenceGlyph] ?? finding.evidenceGlyph} {finding.evidenceCount}</span>
      </div>
      <div className="coordinator-finding-tasks">
        {finding.taskIds.map((taskId) => {
          const agent = tasksById.get(taskId);
          return <code key={taskId}>{agent?.taskName ?? taskId.slice(0, 8)}</code>;
        })}
      </div>
      <div className="coordinator-finding-actions">
        <button type="button" className="btn-xs" onClick={selectFirst}>
          Open task
        </button>
      </div>
    </div>
  );
}
