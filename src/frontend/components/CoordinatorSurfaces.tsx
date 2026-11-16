import React, { useId, useMemo, useState } from 'react';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import type {
  CoordinatorChainMember,
  CoordinatorChainStrip,
  CoordinatorFinding,
  CoordinatorSnapshotState,
  CoordinatorTaskChip,
} from '../../shared/contracts/coordinator.js';
import { markPriorTasksDone, suppressCoordinatorChip } from '../api/index.js';
import { useKookrStore } from '../store/useStore.js';
import { isTerminalStatus, type TaskStatus } from '../../shared/contracts/task-status.js';

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
      await suppressCoordinatorChip(scope, {
        taskId: agent.taskId,
        detectorId: chip.detectorId,
        agentType: chip.agentType,
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

/**
 * Above this many related tasks the chain strip starts collapsed (#3939): a
 * coordinating task with dozens of children otherwise fills the detail pane
 * with chips and pushes the terminal off screen.
 */
export const CHAIN_STRIP_COLLAPSE_THRESHOLD = 6;
const CHAIN_STRIP_EXPANDED_KEY_PREFIX = 'kookr-chain-strip-expanded:';

/**
 * A terminated task failed unless it was stopped on purpose by the operator
 * (`manual`) or by a supervisor (`supervisor`). A terminated member with no
 * reason (an older server) counts as failed, so it stays visible (#3946).
 */
function isFailedMember(member: CoordinatorChainMember): boolean {
  return member.status === 'terminated'
    && member.terminationReason !== 'manual'
    && member.terminationReason !== 'supervisor';
}

function isFinishedMember(member: CoordinatorChainMember): boolean {
  // Statuses outside TaskStatus are not known to be finished, so they stay visible.
  // A failed task still needs attention, so it stays visible too (#3939 item 2).
  return isTerminalStatus(member.status as TaskStatus) === true && !isFailedMember(member);
}

const RELATION_NOUNS: Record<CoordinatorChainMember['relation'], [string, string]> = {
  parent: ['parent', 'parents'],
  child: ['child', 'children'],
  blocks: ['blocked task', 'blocked tasks'],
  blocked_by: ['blocker', 'blockers'],
};

function statusGroupLabel(member: CoordinatorChainMember): string {
  if (isFailedMember(member)) return 'failed';
  switch (member.status) {
    case 'inProgress': return 'in progress';
    case 'open':
    case 'pending': return 'not started';
    case 'completed': return 'completed';
    case 'cancelled':
    case 'terminated': return 'cancelled or terminated';
    default: return member.status;
  }
}

/**
 * One-line summary of a collapsed chain strip, for example
 * "55 children · 3 in progress · 49 completed · 3 cancelled or terminated".
 */
export function summarizeChainMembers(members: readonly CoordinatorChainMember[]): string {
  const relationCounts = new Map<CoordinatorChainMember['relation'], number>();
  for (const member of members) relationCounts.set(member.relation, (relationCounts.get(member.relation) ?? 0) + 1);
  const relationParts = (['parent', 'child', 'blocks', 'blocked_by'] as const)
    .filter((relation) => relationCounts.has(relation))
    .map((relation) => {
      const count = relationCounts.get(relation)!;
      const [singular, plural] = RELATION_NOUNS[relation];
      return `${count} ${count === 1 ? singular : plural}`;
    });
  const statusCounts = new Map<string, number>();
  for (const member of members) {
    const label = statusGroupLabel(member);
    statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);
  }
  const knownOrder = ['in progress', 'not started', 'failed', 'completed', 'cancelled or terminated'];
  const statusParts = [...statusCounts.keys()]
    .sort((a, b) => {
      const ai = knownOrder.indexOf(a);
      const bi = knownOrder.indexOf(b);
      return (ai === -1 ? knownOrder.length : ai) - (bi === -1 ? knownOrder.length : bi);
    })
    .map((label) => `${statusCounts.get(label)} ${label}`);
  return [...relationParts, ...statusParts].join(' · ');
}

function readChainStripExpanded(taskId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(CHAIN_STRIP_EXPANDED_KEY_PREFIX + taskId) === 'true';
  } catch {
    return false;
  }
}

function writeChainStripExpanded(taskId: string, expanded: boolean): void {
  try {
    if (expanded) globalThis.localStorage?.setItem(CHAIN_STRIP_EXPANDED_KEY_PREFIX + taskId, 'true');
    else globalThis.localStorage?.removeItem(CHAIN_STRIP_EXPANDED_KEY_PREFIX + taskId);
  } catch {
    // Storage can be unavailable (private window, blocked site data); the choice then lasts until reload.
  }
}

export function CoordinatorChainStripView({
  agent,
}: {
  agent: AgentState;
}): React.ReactElement | null {
  const coordinator = useKookrStore((s) => s.coordinator);
  const agents = useKookrStore((s) => s.agents);
  const chain = agent.taskId ? coordinator?.chains[agent.taskId] : undefined;
  const [status, setStatus] = useState<string | null>(null);
  // The panel is reused when another task is selected, so the in-memory
  // choice only applies to the task it was made on.
  const [expandedChoice, setExpandedChoice] = useState<{ taskId: string; expanded: boolean } | null>(null);
  const membersId = useId();
  const members = chain?.members;
  const collapsible = (members?.length ?? 0) > CHAIN_STRIP_COLLAPSE_THRESHOLD;
  const ordered = useMemo(() => {
    if (!members || !collapsible) return { all: members ?? [], active: members ?? [] };
    const active = members.filter((member) => !isFinishedMember(member));
    const finished = members.filter(isFinishedMember);
    return { all: [...active, ...finished], active };
  }, [members, collapsible]);
  const agentIdByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of agents) {
      if (candidate.taskId && !map.has(candidate.taskId)) map.set(candidate.taskId, candidate.agentId);
    }
    return map;
  }, [agents]);
  if (!chain || !agent.taskId) return null;
  const taskId = agent.taskId;

  const expanded = !collapsible
    || (expandedChoice?.taskId === taskId ? expandedChoice.expanded : readChainStripExpanded(taskId));
  const shownMembers = expanded ? ordered.all : ordered.active;

  function toggleExpanded() {
    const next = !expanded;
    setExpandedChoice({ taskId, expanded: next });
    writeChainStripExpanded(taskId, next);
  }

  async function markPriorDone() {
    if (!agent.taskId || !chain || chain.priorTaskIds.length === 0) return;
    setStatus('Checking...');
    try {
      const { ok, body } = await markPriorTasksDone({
        taskId: agent.taskId,
        priorTaskIds: chain.priorTaskIds,
        concurrencyToken: chain.concurrencyToken,
      });
      setStatus(ok ? 'Marked prior tasks done' : body.error ?? 'Coordinator check failed');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section
      className={`coordinator-chain-strip${collapsible ? ' coordinator-chain-strip--collapsible' : ''}`}
      data-testid="coordinator-chain-strip"
      aria-label="Task chain"
    >
      {collapsible && (
        <div className="coordinator-chain-summary">
          <span className="coordinator-chain-summary-text" data-testid="coordinator-chain-summary">
            {summarizeChainMembers(chain.members)}
          </span>
          <button
            type="button"
            className="btn-xs coordinator-chain-toggle"
            aria-expanded={expanded}
            aria-controls={membersId}
            data-testid="coordinator-chain-toggle"
            onClick={toggleExpanded}
          >
            {expanded ? 'Show less' : `Show all ${chain.members.length}`}
          </button>
        </div>
      )}
      <div
        id={membersId}
        className={`coordinator-chain-members${collapsible ? (expanded ? ' coordinator-chain-members--expanded' : ' coordinator-chain-members--active') : ''}`}
        data-testid="coordinator-chain-members"
      >
        {shownMembers.map((member) => (
          <ChainMember
            key={`${member.relation}:${member.taskId}`}
            member={member}
            agentId={agentIdByTaskId.get(member.taskId)}
          />
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

/**
 * One related task. When the dashboard knows the task's agent, the chip is a
 * button that opens that task, like the other task links in the detail pane;
 * a task the dashboard no longer lists stays a plain label, so there is no
 * button that does nothing (#3946).
 */
function ChainMember({ member, agentId }: { member: CoordinatorChainMember; agentId: string | undefined }) {
  const failed = isFailedMember(member);
  const className = `coordinator-chain-member coordinator-chain-member--${member.relation}${failed ? ' coordinator-chain-member--failed' : ''}`;
  const state = failed && member.terminationReason ? `${member.status} (${member.terminationReason})` : member.status;
  const content = (
    <>
      <span className="coordinator-chain-relation">{relationLabel(member.relation)}</span>
      <span className="coordinator-chain-label">{member.label}</span>
      <span className="coordinator-chain-state">{state}</span>
    </>
  );
  const common = {
    className,
    title: member.taskId,
    'data-testid': 'coordinator-chain-member',
    'data-status': member.status,
    'data-failed': failed ? 'true' : undefined,
  };
  if (!agentId) return <span {...common}>{content}</span>;
  return (
    <button
      type="button"
      {...common}
      onClick={() => useKookrStore.getState().selectAgent(agentId, member.taskId)}
    >
      {content}
    </button>
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
        <span
          className="coordinator-finding-count"
          title={`${finding.evidenceCount} evidence item${finding.evidenceCount === 1 ? '' : 's'}`}
        >
          {GLYPHS[finding.evidenceGlyph] ?? finding.evidenceGlyph} {finding.evidenceCount}
        </span>
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
