import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentEvent } from '../core/agent-events.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { Monitor } from '../core/monitor.js';
import type { Watchdog } from '../core/watchdog.js';
import {
  validatePermissionApprovalBinding,
  type PermissionApprovalPayload,
  type PermissionRequestBinding,
} from '../shared/contracts/permission-request-binding.js';

export interface RemotePermissionBrokerDeps {
  adapter: Pick<AgentAdapter, 'sendKeystroke'>;
  monitor: Pick<Monitor, 'isPermissionBlocked' | 'markInputReceived'> & {
    getAgentEvents: (agentId: string) => AgentEvent[];
  };
  watchdog?: Pick<Watchdog, 'recordInputReceived'>;
  queue: Pick<AttentionQueue, 'getAnomaly' | 'respondAndAdvance'>;
  interactionLog?: DeferredInteractionLogWriter;
  onRespond?: (agentId: string, outcome?: 'used' | 'cleared') => void;
  isOwnerLocal?: (identity: { actorId?: string; ownerId?: string; local?: boolean }) => boolean;
  now?: () => Date;
}

export class RemotePermissionBroker {
  private readonly consumedApprovals = new Set<string>();

  constructor(private readonly deps: RemotePermissionBrokerDeps) {}

  async approve(
    sessionId: string,
    keystroke = '1',
    actorId?: string,
    payload?: PermissionApprovalPayload,
  ): Promise<{ keystroke: string; permissionRequest: PermissionRequestBinding }> {
    if (this.deps.isOwnerLocal && !this.deps.isOwnerLocal({ actorId })) {
      throw new Error('owner identity required');
    }
    if (!/^[1-9yna]$/.test(keystroke)) throw new Error('invalid permission approval keystroke');
    if (!this.deps.monitor.isPermissionBlocked(sessionId)) {
      throw new Error('session is not permission-blocked');
    }
    const anomaly = this.deps.queue.getAnomaly(sessionId);
    const binding = validatePermissionApprovalBinding({
      sessionId,
      events: this.deps.monitor.getAgentEvents(sessionId),
      anomaly,
      payload,
      now: this.deps.now?.(),
    });
    if (!binding.ok) throw new Error(binding.reason);
    const consumeKey = `${sessionId}\0${binding.binding.requestId}`;
    if (this.consumedApprovals.has(consumeKey)) {
      throw new Error('permission request approval already consumed');
    }
    this.consumedApprovals.add(consumeKey);
    try {
      await this.deps.adapter.sendKeystroke(sessionId, keystroke);
    } catch (err) {
      this.consumedApprovals.delete(consumeKey);
      throw err;
    }
    if (this.deps.monitor.markInputReceived(sessionId)) {
      this.deps.watchdog?.recordInputReceived(sessionId);
    }
    this.deps.queue.respondAndAdvance(sessionId);
    this.deps.onRespond?.(sessionId, 'used');
    const ts = new Date().toISOString();
    await this.deps.interactionLog?.append({
      type: 'user_input',
      agentId: sessionId,
      content: `[permission button: ${keystroke}]`,
      timestamp: ts,
    });
    if (anomaly) {
      await this.deps.interactionLog?.append({
        type: 'finding_resolved',
        agentId: sessionId,
        anomalyType: anomaly.type,
        method: 'input',
        durationMs: Date.now() - anomaly.detectedAt.getTime(),
        timestamp: ts,
      });
    }
    return { keystroke, permissionRequest: binding.binding };
  }
}
