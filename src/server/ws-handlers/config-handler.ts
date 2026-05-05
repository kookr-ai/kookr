import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { DeferredTelemetryLogWriter } from '../../core/telemetry.js';
import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';
import type { CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import type { ProjectConfig, ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import { nowISO } from '../../core/interaction-log.js';

/**
 * Narrow dependency bag for configuration-family messages.
 *
 * Covers settings changes and write-only logging side-effects. Task-launching
 * behaviors (session reflection) live in `ReflectionHandler`.
 */
export interface ConfigHandlerDeps {
  send: (msg: ServerMessage) => void;
  taskStore: TaskStore;
  interactionLog?: DeferredInteractionLogWriter;
  telemetryLog?: DeferredTelemetryLogWriter;
  autonomyOrchestrator?: AutonomyOrchestrator;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  /** Project config persistence for `setProjectConfig` messages. */
  projectConfigStore?: ProjectConfigStore;
  /** Rebroadcasts `projectSummaries` to all clients after config changes. */
  broadcastProjectSummaries?: () => void;
}

type ConfigMessage = Extract<ClientMessage, {
  type:
    | 'setAutonomy'
    | 'setProjectConfig'
    | 'rearmCircuitBreaker'
    | 'telemetry'
    | 'navigate'
}>;

/**
 * Handles configuration and logging-side-effect messages. Pure dispatcher —
 * all behaviors were copied verbatim from `MessageRouter.handleMessage`.
 */
export class ConfigHandler {
  constructor(private readonly deps: ConfigHandlerDeps) {}

  async handle(msg: ConfigMessage): Promise<void> {
    switch (msg.type) {
      case 'setAutonomy': {
        const from = this.deps.taskStore.setAutonomy(msg.taskId, msg.level);
        if (from !== undefined) {
          // Cancel timers if switching to supervised
          this.deps.autonomyOrchestrator?.onAutonomyChanged(msg.taskId, msg.level);
          await this.deps.interactionLog?.append({
            type: 'autonomy_changed',
            taskId: msg.taskId,
            from,
            to: msg.level,
            timestamp: nowISO(),
          });
        }
        return;
      }

      case 'setProjectConfig': {
        if (this.deps.projectConfigStore) {
          // Mirror POST /api/projects/configs: patch, persist, broadcast. Only
          // include fields that were explicitly provided so unrelated fields on
          // the existing row are preserved.
          const { project, config } = msg;
          const patch: Partial<Omit<ProjectConfig, 'project'>> = {};
          if (config.tracked !== undefined) patch.tracked = config.tracked;
          if (config.dailyPrLimit !== undefined) patch.dailyPrLimit = config.dailyPrLimit;
          if (config.weeklyPrLimit !== undefined) patch.weeklyPrLimit = config.weeklyPrLimit;
          if (config.notes !== undefined) patch.notes = config.notes;
          this.deps.projectConfigStore.setConfig(project, patch);
          await this.deps.projectConfigStore.save();
          this.deps.broadcastProjectSummaries?.();
        }
        return;
      }

      case 'rearmCircuitBreaker':
        if (this.deps.circuitBreakerRegistry) {
          this.deps.circuitBreakerRegistry.rearm(msg.name);
        }
        return;

      case 'telemetry':
        // Write-only: append telemetry events, no broadcast
        await this.deps.telemetryLog?.appendBatch(msg.events);
        return;

      case 'navigate':
        await this.deps.interactionLog?.append({
          type: 'agent_selected',
          agentId: msg.agentId,
          source: 'manual',
          timestamp: nowISO(),
        });
        return;
    }
  }
}
