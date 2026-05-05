import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { Monitor } from '../../core/monitor.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';
import { nowISO } from '../../core/interaction-log.js';
import { recordFalsePositive } from '../../core/anomaly-detector.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';

/**
 * Narrow dependency bag for anomaly-response messages.
 *
 * Groups agent-level triage operations: sending input/keystrokes, clearing
 * or snoozing findings, permission choices, auto-proceed cancellation, and
 * false-positive feedback. These all mutate per-agent state — none of them
 * touch task-level lifecycle or workspace state.
 */
export interface AnomalyHandlerDeps {
  send: (msg: ServerMessage) => void;
  adapter: AgentAdapter;
  monitor: Monitor;
  queue: AttentionQueue;
  interactionLog?: DeferredInteractionLogWriter;
  suppressionTracker?: SnoozeSuppressionTracker;
  autonomyOrchestrator?: AutonomyOrchestrator;
  onRespond?: (agentId: string, outcome?: 'used' | 'cleared') => void;
}

type AnomalyMessage = Extract<ClientMessage, {
  type:
    | 'respond'
    | 'respondAll'
    | 'directReply'
    | 'skip'
    | 'skipAll'
    | 'snooze'
    | 'cancelSnooze'
    | 'findingFeedback'
    | 'permissionChoice'
    | 'cancelAutoProceed'
}>;

/**
 * Handles anomaly/triage client messages.
 *
 * `respondAll` and `skipAll` fan out into individual `respond`/`skip`
 * messages; callers pass a dispatcher so the recursion stays on the main
 * router (which is also responsible for the `_lastLaunchDuplicate` reset
 * on every top-level message).
 */
export class AnomalyHandler {
  constructor(private readonly deps: AnomalyHandlerDeps) {}

  async handle(
    msg: AnomalyMessage,
    dispatch: (msg: ClientMessage) => Promise<void>,
  ): Promise<void> {
    switch (msg.type) {
      case 'respond': {
        // Reject if auto-proceed is mid-fire (prevents double input)
        if (this.deps.autonomyOrchestrator?.isFiring(msg.agentId)) {
          this.deps.send({
            type: 'alert', agentId: msg.agentId,
            summary: 'Auto-proceed in progress, please wait',
            details: '', severity: 'info',
          });
          return;
        }
        // Cancel auto-proceed timer and reset retries
        this.deps.autonomyOrchestrator?.onUserRespond(msg.agentId);
        // Capture anomaly from the queue (persisted detectedAt) before clearing
        const preAnomaly = this.deps.queue.getAnomaly(msg.agentId);
        await this.deps.adapter.sendInput(msg.agentId, msg.input);
        this.deps.monitor.markInputReceived(msg.agentId);
        this.deps.queue.respondAndAdvance(msg.agentId);
        // Cancel in-flight suggestion generation and clear any stale suggestions
        this.deps.onRespond?.(msg.agentId, 'used');
        this.deps.send({ type: 'suggestion', agentId: msg.agentId, suggestions: [], quickActions: [] });
        // Reset suppression — user actively responded, so re-enable monitoring
        if (this.deps.suppressionTracker?.isSuppressed(msg.agentId)) {
          this.deps.suppressionTracker.reset(msg.agentId);
          await this.deps.interactionLog?.append({
            type: 'monitoring_resumed',
            agentId: msg.agentId,
            reason: 'respond',
            timestamp: nowISO(),
          });
        }
        const ts = nowISO();
        await this.deps.interactionLog?.append({
          type: 'user_input',
          agentId: msg.agentId,
          content: msg.input,
          timestamp: ts,
        });
        if (preAnomaly) {
          await this.deps.interactionLog?.append({
            type: 'finding_resolved',
            agentId: msg.agentId,
            anomalyType: preAnomaly.type,
            method: 'input',
            durationMs: Date.now() - preAnomaly.detectedAt.getTime(),
            timestamp: ts,
          });
        }
        return;
      }

      case 'respondAll': {
        // Batch-respond to multiple agents with the same input (grouped findings)
        for (const agentId of msg.agentIds) {
          await dispatch({ type: 'respond', agentId, input: msg.input });
        }
        return;
      }

      case 'directReply': {
        await sendDirectAgentInput({
          adapter: this.deps.adapter,
          interactionLog: this.deps.interactionLog,
          autonomyOrchestrator: this.deps.autonomyOrchestrator,
        }, msg.agentId, msg.input, 'direct_reply');
        return;
      }

      case 'skip': {
        const skipAnomaly = this.deps.queue.getAnomaly(msg.agentId);
        const skipType = skipAnomaly?.type ?? 'needs_input';
        this.deps.queue.skip(msg.agentId);
        const skipTs = nowISO();
        await this.deps.interactionLog?.append({
          type: 'finding_skipped',
          agentId: msg.agentId,
          anomalyType: skipType,
          timestamp: skipTs,
        });
        if (skipAnomaly) {
          await this.deps.interactionLog?.append({
            type: 'finding_resolved',
            agentId: msg.agentId,
            anomalyType: skipType,
            method: 'skip',
            durationMs: Date.now() - skipAnomaly.detectedAt.getTime(),
            timestamp: skipTs,
          });
        }
        return;
      }

      case 'skipAll': {
        for (const agentId of msg.agentIds) {
          await dispatch({ type: 'skip', agentId });
        }
        return;
      }

      case 'snooze': {
        const snoozeAnomaly = this.deps.queue.getAnomaly(msg.agentId);

        // If resumeMonitoring is set, reset suppression instead of snoozing
        if (msg.resumeMonitoring && this.deps.suppressionTracker) {
          this.deps.suppressionTracker.reset(msg.agentId);
          const resumeTs = nowISO();
          await this.deps.interactionLog?.append({
            type: 'monitoring_resumed',
            agentId: msg.agentId,
            reason: 'respond',
            timestamp: resumeTs,
          });
          return;
        }

        this.deps.queue.snooze(msg.agentId, msg.durationMs, msg.reason, snoozeAnomaly ?? undefined);
        const snoozeTs = nowISO();
        await this.deps.interactionLog?.append({
          type: 'finding_snoozed',
          agentId: msg.agentId,
          durationMs: msg.durationMs,
          anomalyType: snoozeAnomaly?.type,
          timestamp: snoozeTs,
        });
        if (snoozeAnomaly) {
          await this.deps.interactionLog?.append({
            type: 'finding_resolved',
            agentId: msg.agentId,
            anomalyType: snoozeAnomaly.type,
            method: 'snooze',
            durationMs: Date.now() - snoozeAnomaly.detectedAt.getTime(),
            timestamp: snoozeTs,
          });

          // Record in suppression tracker; emit auto_suppressed if threshold crossed
          if (this.deps.suppressionTracker) {
            const newlySuppressed = this.deps.suppressionTracker.recordSnooze(msg.agentId, snoozeAnomaly.type);
            if (newlySuppressed) {
              await this.deps.interactionLog?.append({
                type: 'auto_suppressed',
                agentId: msg.agentId,
                anomalyType: snoozeAnomaly.type,
                suppressionCount: 3,
                timestamp: snoozeTs,
              });
            }
          }
        }
        return;
      }

      case 'cancelSnooze': {
        const wasSnoozing = this.deps.queue.cancelSnooze(msg.agentId);
        if (wasSnoozing) {
          await this.deps.interactionLog?.append({
            type: 'finding_resolved',
            agentId: msg.agentId,
            anomalyType: this.deps.queue.getAnomaly(msg.agentId)?.type ?? 'needs_input',
            method: 'input',
            durationMs: 0,
            timestamp: nowISO(),
          });
        }
        return;
      }

      case 'findingFeedback': {
        const fpTs = nowISO();
        await this.deps.interactionLog?.append({
          type: 'finding_feedback',
          agentId: msg.agentId,
          anomalyType: msg.anomalyType,
          verdict: msg.verdict,
          explanation: msg.explanation,
          timestamp: fpTs,
        });
        await this.deps.interactionLog?.append({
          type: 'finding_resolved',
          agentId: msg.agentId,
          anomalyType: msg.anomalyType,
          method: 'false_positive',
          durationMs: 0,
          timestamp: fpTs,
        });
        recordFalsePositive(msg.anomalyType);
        this.deps.queue.remove(msg.agentId);
        return;
      }

      case 'permissionChoice': {
        this.deps.autonomyOrchestrator?.onPermissionChoice(msg.agentId);
        // Validate keystroke: single char from whitelist only
        if (!/^[1-9yna]$/.test(msg.keystroke)) {
          return;
        }
        // Stale guard: agent must still be permission_blocked
        const permState = this.deps.monitor.getSnapshot().find(s => s.agentId === msg.agentId);
        if (permState?.anomaly?.type !== 'permission_blocked') {
          return;
        }
        const prePermAnomaly = this.deps.queue.getAnomaly(msg.agentId);
        await this.deps.adapter.sendKeystroke(msg.agentId, msg.keystroke);
        this.deps.monitor.markInputReceived(msg.agentId);
        this.deps.queue.respondAndAdvance(msg.agentId);
        this.deps.onRespond?.(msg.agentId, 'used');
        this.deps.send({ type: 'suggestion', agentId: msg.agentId, suggestions: [], quickActions: [] });
        const permTs = nowISO();
        await this.deps.interactionLog?.append({
          type: 'user_input',
          agentId: msg.agentId,
          content: `[permission button: ${msg.keystroke}]`,
          timestamp: permTs,
        });
        if (prePermAnomaly) {
          await this.deps.interactionLog?.append({
            type: 'finding_resolved',
            agentId: msg.agentId,
            anomalyType: prePermAnomaly.type,
            method: 'input',
            durationMs: Date.now() - prePermAnomaly.detectedAt.getTime(),
            timestamp: permTs,
          });
        }
        return;
      }

      case 'cancelAutoProceed': {
        await this.deps.autonomyOrchestrator?.cancelByUser(msg.agentId);
        return;
      }
    }
  }
}
