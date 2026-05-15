import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { Monitor } from '../core/monitor.js';

export interface RemotePermissionBrokerDeps {
  adapter: Pick<AgentAdapter, 'sendKeystroke'>;
  monitor: Pick<Monitor, 'isPermissionBlocked' | 'markInputReceived'>;
  queue: Pick<AttentionQueue, 'getAnomaly' | 'respondAndAdvance'>;
  interactionLog?: DeferredInteractionLogWriter;
  onRespond?: (agentId: string, outcome?: 'used' | 'cleared') => void;
  isOwnerLocal?: (identity: { actorId?: string; ownerId?: string; local?: boolean }) => boolean;
}

export class RemotePermissionBroker {
  constructor(private readonly deps: RemotePermissionBrokerDeps) {}

  async approve(sessionId: string, keystroke = '1', actorId?: string): Promise<{ keystroke: string }> {
    if (this.deps.isOwnerLocal && !this.deps.isOwnerLocal({ actorId })) {
      throw new Error('owner identity required');
    }
    if (!/^[1-9yna]$/.test(keystroke)) throw new Error('invalid permission approval keystroke');
    if (!this.deps.monitor.isPermissionBlocked(sessionId)) {
      throw new Error('session is not permission-blocked');
    }
    const anomaly = this.deps.queue.getAnomaly(sessionId);
    await this.deps.adapter.sendKeystroke(sessionId, keystroke);
    this.deps.monitor.markInputReceived(sessionId);
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
    return { keystroke };
  }
}
