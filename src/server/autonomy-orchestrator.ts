import type { TaskStore, Task } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AutoProceedService } from './auto-proceed.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';

/**
 * AutonomyOrchestrator — single owner of all autonomy/auto-proceed policy.
 *
 * Other modules (event-pipeline, ws.ts MessageRouter, routes, index.ts) delegate
 * autonomy decisions here instead of inlining policy logic.
 *
 * The underlying AutoProceedService retains the low-level timer/fire mechanics;
 * this orchestrator owns when to schedule, cancel, reset retries, and re-arm.
 */
export interface AutonomyOrchestratorDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  queue: AttentionQueue;
  autoProceedService: AutoProceedService;
  interactionLog?: DeferredInteractionLogWriter;
}

export class AutonomyOrchestrator {
  private taskStore: TaskStore;
  private monitor: Monitor;
  private queue: AttentionQueue;
  private svc: AutoProceedService;
  private interactionLog?: DeferredInteractionLogWriter;

  constructor(deps: AutonomyOrchestratorDeps) {
    this.taskStore = deps.taskStore;
    this.monitor = deps.monitor;
    this.queue = deps.queue;
    this.svc = deps.autoProceedService;
    this.interactionLog = deps.interactionLog;
  }

  // --- Scheduling ---

  /**
   * Schedule auto-proceed if the agent's task is autonomous and the anomaly is
   * a stop-type needs_input. Called by the event pipeline after processing events.
   */
  scheduleIfNeeded(agentId: string): void {
    const agentState = this.monitor.getSnapshot().find((s) => s.agentId === agentId);
    if (agentState?.anomaly?.type !== 'needs_input' || agentState.anomaly.subType !== 'stop') return;

    const task = this.taskStore.findTaskBySession(agentId);
    if (task?.autonomy !== 'autonomous') return;
    if (this.svc.hasTimer(agentId)) return;

    this.svc.schedule(agentId);
  }

  // --- User interaction handlers ---

  /**
   * Called when a user responds to an agent (respond message).
   * Cancels timer and resets retry count.
   */
  onUserRespond(agentId: string): void {
    this.svc.cancel(agentId, 'manual_respond');
    const task = this.taskStore.findTaskBySession(agentId);
    if (task) {
      this.taskStore.resetAutoProceedRetries(task.id);
    }
  }

  /**
   * Called when user sends a direct reply (directReply message).
   * Cancels timer only — retries are not reset because directReply
   * doesn't clear the anomaly.
   */
  onDirectReply(agentId: string): void {
    this.svc.cancel(agentId, 'direct_reply');
  }

  /**
   * Called when user stops an agent.
   */
  onAgentStopped(agentId: string): void {
    this.svc.cancel(agentId, 'agent_stopped');
  }

  /**
   * Called when user sends a permission choice.
   * Cancels timer (user is actively interacting).
   */
  onPermissionChoice(agentId: string): void {
    this.svc.cancel(agentId, 'manual_respond');
  }

  /**
   * Called when user sends input via the REST API.
   */
  onRestInput(agentId: string): void {
    this.svc.cancel(agentId, 'rest_api');
  }

  /**
   * Called during session cleanup (agent lifecycle teardown).
   * Cancels any pending timer for the agent being cleaned up.
   */
  onSessionCleanup(agentId: string): void {
    this.svc.cancel(agentId, 'session_cleanup');
  }

  /**
   * User-initiated cancel of auto-proceed from the UI. Logs finding resolution.
   */
  async cancelByUser(agentId: string): Promise<void> {
    const cancelled = this.svc.cancel(agentId, 'user');
    if (cancelled) {
      await this.interactionLog?.append({
        type: 'finding_resolved',
        agentId,
        anomalyType: this.queue.getAnomaly(agentId)?.type ?? 'needs_input',
        method: 'auto_proceed_cancelled',
        durationMs: 0,
        timestamp: nowISO(),
        cancelledBy: 'user',
      });
    }
  }

  /**
   * Called when autonomy level changes.
   * Cancels all timers for the task when switching to supervised.
   */
  onAutonomyChanged(taskId: string, newLevel: string): void {
    if (newLevel === 'supervised') {
      this.svc.cancelAllForTask(taskId, 'level_change');
    }
  }

  // --- Startup re-arming ---

  /**
   * Re-arm auto-proceed timers for autonomous tasks that were auto-proceeding
   * before a crash/restart. Called once during server startup after hook replay.
   */
  rearmAfterRestart(): void {
    let reArmed = 0;
    let skippedSubtype = 0;
    let skippedRetries = 0;

    for (const task of this.taskStore.getAllTasks()) {
      if (task.autonomy !== 'autonomous' || task.status !== 'inProgress') continue;

      for (const session of task.sessions) {
        if (session.lastStatus === 'completed' || session.lastStatus === 'aborted' || session.crashRecovered) continue;

        const snapshot = this.monitor.getSnapshot();
        const agentState = snapshot.find((s) => s.agentId === session.tmuxSession);
        if (!agentState?.anomaly || agentState.anomaly.type !== 'needs_input') continue;

        if (agentState.anomaly.subType !== 'stop') {
          skippedSubtype++;
          continue;
        }

        if ((task.autoProceedRetries ?? 0) >= 2) {
          skippedRetries++;
          continue;
        }

        this.svc.schedule(session.tmuxSession);
        reArmed++;
      }
    }

    if (reArmed > 0 || skippedSubtype > 0 || skippedRetries > 0) {
      console.log(
        `[auto-proceed] Re-armed ${reArmed}, skipped ${skippedSubtype} (subtype), skipped ${skippedRetries} (retries)`,
      );
    }
  }

  // --- Delegated accessors ---

  /** Check if auto-proceed fire() is in progress (prevents double input). */
  isFiring(agentId: string): boolean {
    return this.svc.isFiring(agentId);
  }

  /** Get the ISO timestamp when auto-proceed will fire for an agent, or undefined. */
  getActiveProceedAt(agentId: string): string | undefined {
    return this.svc.getActiveProceedAt(agentId);
  }

  /** Cancel all timers (for shutdown). */
  dispose(): void {
    this.svc.dispose();
  }
}
