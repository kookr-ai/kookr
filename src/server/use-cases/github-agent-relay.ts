import type { GitHubReference, GitHubStateChange } from '../../core/github-types.js';
import type { GitHubStateStore } from '../../core/github-state-store.js';
import type { SessionInfo, Task, TaskStore } from '../../core/tasks.js';
import type { UserInputDeliveryService } from '../user-input-delivery-service.js';

export type GitHubAgentRelayMode = 'off' | 'shadow' | 'active';
type GitHubAgentRelayDropReason =
  | 'ownership_miss'
  | 'no_live_session'
  | 'rate_cap'
  | 'dedup'
  | 'delivery_failed';

type RelayChangeType = 'pr_merged' | 'pr_conflicting';

interface PendingDelivery {
  key: string;
  taskId: string;
  ref: GitHubReference;
  changeType: RelayChangeType;
  attempts: number;
}

interface GitHubChangeAgentRelayDeps {
  taskStore: Pick<TaskStore, 'getTask'>;
  githubStateStore: Pick<GitHubStateStore, 'getPRState'>;
  userInputDelivery: Pick<UserInputDeliveryService, 'submitMessage'>;
  isIdleForInput: (sessionId: string) => boolean;
  getMode: () => GitHubAgentRelayMode;
  now?: () => Date;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const RELAY_CHANGE_TYPES: ReadonlySet<GitHubStateChange['type']> = new Set([
  'pr_merged',
  'pr_conflicting',
]);
const MAX_ACCEPTED_DELIVERIES_PER_TASK_PER_HOUR = 4;
const MAX_WRITE_ATTEMPTS = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export class GitHubChangeAgentRelay {
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly deliveredKeys = new Set<string>();
  private readonly acceptedDeliveryTimesByTask = new Map<string, number[]>();

  constructor(private readonly deps: GitHubChangeAgentRelayDeps) {}

  onChanges(taskId: string, changes: GitHubStateChange[]): void {
    try {
      if (this.deps.getMode() === 'off') return;
      for (const change of changes) {
        if (!isRelayChange(change)) continue;
        const ref = change.ref;
        const key = deliveryKey(taskId, ref, change.type);
        if (this.pendingDeliveries.has(key)) continue;

        const resolution = this.resolveDeliveryTarget(taskId, ref);
        if (resolution.kind === 'drop') {
          this.logDrop(taskId, ref, change.type, resolution.reason);
          continue;
        }

        this.pendingDeliveries.set(key, {
          key,
          taskId,
          ref,
          changeType: change.type,
          attempts: 0,
        });
      }
    } catch (error) {
      this.deps.logger?.warn('[github-agent-relay] onChanges failed', error);
    }
  }

  async tick(): Promise<void> {
    if (this.deps.getMode() === 'off') {
      this.pendingDeliveries.clear();
      return;
    }

    for (const pending of [...this.pendingDeliveries.values()]) {
      await this.tryDeliver(pending);
    }
  }

  getPendingCount(): number {
    return this.pendingDeliveries.size;
  }

  private async tryDeliver(pending: PendingDelivery): Promise<void> {
    const resolution = this.resolveDeliveryTarget(pending.taskId, pending.ref);
    if (resolution.kind === 'drop') {
      this.dropPending(pending, resolution.reason);
      return;
    }

    const { task, session } = resolution;
    if (!this.deps.isIdleForInput(session.tmuxSession)) return;

    if (this.deliveredKeys.has(pending.key)) {
      this.dropPending(pending, 'dedup');
      return;
    }

    if (this.isRateCapped(task.id)) {
      this.dropPending(pending, 'rate_cap');
      return;
    }

    const message = this.buildMessage(pending);
    const mode = this.deps.getMode();
    if (mode === 'shadow') {
      // Shadow mode exercises dedup and rate-cap behavior without writing to the agent.
      this.logWouldDeliver(task.id, session.tmuxSession, pending);
      this.markAccepted(task.id, pending.key);
      this.pendingDeliveries.delete(pending.key);
      return;
    }

    try {
      await this.deps.userInputDelivery.submitMessage(session.tmuxSession, message, 'github_watcher');
      this.markAccepted(task.id, pending.key);
      this.pendingDeliveries.delete(pending.key);
    } catch (error) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_WRITE_ATTEMPTS) {
        this.dropPending(pending, 'delivery_failed');
      } else {
        this.deps.logger?.warn('[github-agent-relay] delivery attempt failed', error);
      }
    }
  }

  private resolveDeliveryTarget(
    taskId: string,
    ref: GitHubReference,
  ): { kind: 'deliver'; task: Task; session: SessionInfo } | { kind: 'drop'; reason: GitHubAgentRelayDropReason } {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task || task.status !== 'inProgress') return { kind: 'drop', reason: 'ownership_miss' };

    const prState = this.deps.githubStateStore.getPRState({
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      taskId,
    });
    if (!prState) return { kind: 'drop', reason: 'ownership_miss' };

    const sessions = liveSessions(task);
    if (sessions.length === 0) return { kind: 'drop', reason: 'no_live_session' };

    const branchMatch = sessions.find((session) => session.gitBranch === prState.branch);
    // Fallback covers sessions that predate branch metadata or run detached.
    return {
      kind: 'deliver',
      task,
      session: branchMatch ?? mostRecentlyCreatedSession(sessions),
    };
  }

  private buildMessage(pending: PendingDelivery): string {
    const prState = this.deps.githubStateStore.getPRState({
      owner: pending.ref.owner,
      repo: pending.ref.repo,
      number: pending.ref.number,
      taskId: pending.taskId,
    });
    const head = prState?.branch ?? '';
    const base = prState?.baseBranch ?? '';

    if (pending.changeType === 'pr_conflicting') {
      return `Kookr GitHub watcher: PR #${pending.ref.number} (head ${head}, base ${base}) is now CONFLICTING with its base. Rebase your worktree branch onto the base branch, resolve conflicts, and force-push with --force-with-lease.`;
    }

    return `Kookr GitHub watcher: PR #${pending.ref.number} (head ${head}) was merged. If your task is complete, signal completion-ready; otherwise continue with any remaining post-merge steps.`;
  }

  private markAccepted(taskId: string, key: string): void {
    this.deliveredKeys.add(key);
    const now = this.nowMs();
    const current = this.acceptedDeliveryTimesByTask.get(taskId) ?? [];
    this.acceptedDeliveryTimesByTask.set(taskId, [...current.filter((time) => now - time < RATE_WINDOW_MS), now]);
  }

  private isRateCapped(taskId: string): boolean {
    const now = this.nowMs();
    const recent = (this.acceptedDeliveryTimesByTask.get(taskId) ?? [])
      .filter((time) => now - time < RATE_WINDOW_MS);
    this.acceptedDeliveryTimesByTask.set(taskId, recent);
    return recent.length >= MAX_ACCEPTED_DELIVERIES_PER_TASK_PER_HOUR;
  }

  private dropPending(pending: PendingDelivery, reason: GitHubAgentRelayDropReason): void {
    this.pendingDeliveries.delete(pending.key);
    this.logDrop(pending.taskId, pending.ref, pending.changeType, reason);
  }

  private logDrop(
    taskId: string,
    ref: GitHubReference,
    changeType: RelayChangeType,
    dropReason: GitHubAgentRelayDropReason,
  ): void {
    this.deps.logger?.log(JSON.stringify({
      event: 'github_agent_relay.drop',
      taskId,
      prRef: prRefString(ref),
      changeType,
      dropReason,
    }));
  }

  private logWouldDeliver(taskId: string, tmuxSession: string, pending: PendingDelivery): void {
    this.deps.logger?.log(JSON.stringify({
      event: 'github_agent_relay.would_deliver',
      taskId,
      tmuxSession,
      prRef: prRefString(pending.ref),
      changeType: pending.changeType,
      mode: 'shadow',
    }));
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }
}

function isRelayChange(change: GitHubStateChange): change is Extract<GitHubStateChange, { type: RelayChangeType }> {
  return RELAY_CHANGE_TYPES.has(change.type);
}

function liveSessions(task: Task): SessionInfo[] {
  return task.sessions.filter((session) => (
    session.lastStatus !== 'completed'
    && session.lastStatus !== 'aborted'
    && !session.crashRecovered
  ));
}

function mostRecentlyCreatedSession(sessions: SessionInfo[]): SessionInfo {
  return [...sessions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

function deliveryKey(taskId: string, ref: GitHubReference, changeType: RelayChangeType): string {
  return `${taskId}:${ref.owner}/${ref.repo}#${ref.number}:${changeType}`;
}

function prRefString(ref: GitHubReference): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
