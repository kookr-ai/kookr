import type { TaskStore } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import type { ServerMessage } from '../shared/protocol.js';

const MAX_RETRIES = 2;
const DEFAULT_DELAY_MS = 180_000; // 3 minutes

export interface AutoProceedDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  queue: AttentionQueue;
  adapter: AgentAdapter;
  interactionLog?: DeferredInteractionLogWriter;
  broadcastToAll: (msg: ServerMessage) => void;
  serverCwd: string;
  /** Override for testing — checks if a user has a tmux client attached. */
  hasAttachedClients?: (agentId: string) => boolean;
}

/**
 * Autonomy Phase B: schedules and fires auto-proceed timers for autonomous tasks.
 *
 * When an autonomous task's agent reaches stop-type needs_input, the event pipeline
 * calls schedule(). After the configured delay, fire() sends "yes" to the agent.
 * Any user input (respond, directReply, REST, UI cancel) calls cancel() first.
 *
 * Server-layer service — never imported by core modules.
 */
export class AutoProceedService {
  private timers = new Map<string, NodeJS.Timeout>();
  /** ISO timestamp when auto-proceed will fire, per agent. */
  private proceedAt = new Map<string, string>();
  /** Guards against fire/respond race — set during sendInput await. */
  private firing = new Set<string>();

  constructor(private deps: AutoProceedDeps) {}

  /**
   * Schedule auto-proceed for an agent. Idempotent — replaces existing timer.
   * Refuses if retry count >= MAX_RETRIES.
   */
  schedule(agentId: string, delayMs?: number): void {
    const task = this.deps.taskStore.findTaskBySession(agentId);
    if (!task) return;

    // Refuse if retries exhausted
    if ((task.autoProceedRetries ?? 0) >= MAX_RETRIES) {
      console.log(
        `[auto-proceed] Refusing schedule for ${agentId}: retries exhausted (${task.autoProceedRetries}/${MAX_RETRIES})`,
      );
      return;
    }

    const effectiveDelay = delayMs ?? task.autoProceedDelayMs ?? DEFAULT_DELAY_MS;

    // Cancel existing timer (idempotent replacement)
    this.cancelTimer(agentId);

    const proceedAtTs = new Date(Date.now() + effectiveDelay).toISOString();
    this.proceedAt.set(agentId, proceedAtTs);

    const timer = setTimeout(() => void this.fire(agentId), effectiveDelay);
    this.timers.set(agentId, timer);

    console.log(
      JSON.stringify({
        event: 'auto_proceed_scheduled',
        agentId,
        taskId: task.id,
        scheduledAt: nowISO(),
        proceedAt: proceedAtTs,
        delayMs: effectiveDelay,
      }),
    );

    // Broadcast so frontend picks up the countdown
    this.broadcastSnapshot();
  }

  /**
   * Cancel auto-proceed timer for an agent.
   * Returns true if a timer was actually cancelled.
   */
  cancel(agentId: string, cancelledBy?: string): boolean {
    const had = this.cancelTimer(agentId);
    if (had) {
      console.log(
        JSON.stringify({
          event: 'auto_proceed_cancelled',
          agentId,
          cancelledBy: cancelledBy ?? 'unknown',
        }),
      );
      // Broadcast immediately to clear autoProceedingAt on frontend
      this.broadcastSnapshot();
    }
    return had;
  }

  /**
   * Cancel all timers for agents belonging to a task.
   * Used when autonomy changes to supervised.
   */
  cancelAllForTask(taskId: string, cancelledBy?: string): void {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return;
    let cancelled = false;
    for (const session of task.sessions) {
      if (this.cancelTimer(session.tmuxSession)) {
        console.log(
          JSON.stringify({
            event: 'auto_proceed_cancelled',
            agentId: session.tmuxSession,
            cancelledBy: cancelledBy ?? 'level_change',
          }),
        );
        cancelled = true;
      }
    }
    if (cancelled) {
      this.broadcastSnapshot();
    }
  }

  /** Check if fire() is currently in progress for an agent. */
  isFiring(agentId: string): boolean {
    return this.firing.has(agentId);
  }

  /** Get the ISO timestamp when auto-proceed will fire, or undefined. */
  getActiveProceedAt(agentId: string): string | undefined {
    return this.proceedAt.get(agentId);
  }

  /** Get all active proceed-at timestamps (for snapshot enrichment). */
  getAllProceedAt(): Map<string, string> {
    return this.proceedAt;
  }

  /** Check if any timer is active for an agent. */
  hasTimer(agentId: string): boolean {
    return this.timers.has(agentId);
  }

  /** Cancel all timers (for shutdown). */
  dispose(): void {
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.proceedAt.clear();
  }

  /**
   * Fire auto-proceed: send "yes" to the agent.
   * Called by the timer callback — not directly by external code.
   */
  private async fire(agentId: string): Promise<void> {
    this.timers.delete(agentId);
    this.proceedAt.delete(agentId);

    const task = this.deps.taskStore.findTaskBySession(agentId);

    // Pre-fire validations
    if (!task) {
      this.logFire(agentId, undefined, false, 'task_not_found');
      return;
    }
    if (task.autonomy !== 'autonomous') {
      this.logFire(agentId, task.id, false, 'not_autonomous');
      return;
    }
    if ((task.autoProceedRetries ?? 0) >= MAX_RETRIES) {
      this.escalateToSupervised(agentId, task.id);
      return;
    }

    // Check agent still has needs_input anomaly
    const snapshot = this.deps.monitor.getSnapshot();
    const agentState = snapshot.find((s) => s.agentId === agentId);
    if (!agentState?.anomaly || agentState.anomaly.type !== 'needs_input') {
      this.logFire(agentId, task.id, false, 'no_longer_needs_input');
      return;
    }

    // Check tmux session is alive (captureDisplay throws if session is dead)
    try {
      await this.deps.adapter.captureDisplay(agentId);
    } catch {
      this.logFire(agentId, task.id, false, 'session_dead');
      return;
    }

    // Check if a user is attached to the tmux session — don't inject "yes"
    // into a terminal the user is actively typing in.
    if (this.hasAttachedClients(agentId)) {
      const effectiveDelay = task.autoProceedDelayMs ?? DEFAULT_DELAY_MS;
      this.logFire(agentId, task.id, false, 'user_attached');
      // Reschedule — user may detach later. Does not consume a retry.
      this.schedule(agentId, effectiveDelay);
      return;
    }

    // Fire! Guard with firing set to prevent concurrent respond race.
    this.firing.add(agentId);
    try {
      await this.deps.adapter.sendInput(agentId, 'yes');

      // Success — clear anomaly just like a human respond
      this.deps.monitor.markInputReceived(agentId);
      this.deps.queue.respondAndAdvance(agentId);

      // Increment retry count
      this.deps.taskStore.incrementAutoProceedRetries(task.id);

      // Log finding resolution
      const preAnomaly = agentState.anomaly;
      await this.deps.interactionLog?.append({
        type: 'finding_resolved',
        agentId,
        anomalyType: preAnomaly.type,
        method: 'auto_proceed',
        durationMs: Date.now() - preAnomaly.detectedAt.getTime(),
        timestamp: nowISO(),
        autoProceedDetail: {
          delayMs: task.autoProceedDelayMs ?? DEFAULT_DELAY_MS,
          deliveryConfirmed: true,
        },
      });

      this.logFire(agentId, task.id, true);
    } catch (err) {
      // sendInput failed — surface as auto_proceed_failure anomaly
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto-proceed] sendInput failed for ${agentId}:`, message);

      // Increment retry count even on failure
      this.deps.taskStore.incrementAutoProceedRetries(task.id);

      // Log failure
      await this.deps.interactionLog?.append({
        type: 'finding_resolved',
        agentId,
        anomalyType: 'needs_input',
        method: 'auto_proceed_failed',
        durationMs: Date.now() - (agentState.anomaly?.detectedAt?.getTime() ?? Date.now()),
        timestamp: nowISO(),
        autoProceedDetail: {
          delayMs: task.autoProceedDelayMs ?? DEFAULT_DELAY_MS,
          deliveryConfirmed: false,
        },
      });

      this.logFire(agentId, task.id, false, `send_failed: ${message}`);

      // If retries exhausted after this failure, escalate
      if ((task.autoProceedRetries ?? 0) >= MAX_RETRIES) {
        this.escalateToSupervised(agentId, task.id);
      }
    } finally {
      this.firing.delete(agentId);
      this.broadcastSnapshot();
    }
  }

  /**
   * Escalate to supervised: set task autonomy to supervised and let
   * the normal anomaly stay in the queue for user attention.
   */
  private escalateToSupervised(agentId: string, taskId: string): void {
    const from = this.deps.taskStore.setAutonomy(taskId, 'supervised');
    if (from === undefined) return;
    const task = this.deps.taskStore.getTask(taskId)!;

    console.log(
      JSON.stringify({
        event: 'auto_proceed_exhausted',
        agentId,
        taskId,
        retries: task.autoProceedRetries ?? 0,
        maxRetries: MAX_RETRIES,
      }),
    );

    // Log autonomy change
    void this.deps.interactionLog?.append({
      type: 'autonomy_changed',
      taskId,
      from,
      to: 'supervised',
      timestamp: nowISO(),
    });

    this.logFire(agentId, taskId, false, 'retries_exhausted');
    this.broadcastSnapshot();
  }

  // --- Internal helpers ---

  private cancelTimer(agentId: string): boolean {
    const timer = this.timers.get(agentId);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(agentId);
    this.proceedAt.delete(agentId);
    return true;
  }

  private logFire(agentId: string, taskId: string | undefined, deliveryConfirmed: boolean, skipReason?: string): void {
    console.log(
      JSON.stringify({
        event: 'auto_proceed_fired',
        agentId,
        taskId,
        firedAt: nowISO(),
        deliveryConfirmed,
        ...(skipReason ? { skipReason } : {}),
      }),
    );
  }

  /**
   * Returns true when a live attach client should block auto-proceed.
   *
   * Pre-V8 this called `tmux list-clients` to detect an external operator
   * on the session. V8 moved to dtach (rfc-v8-tmux-removal.md) — there is
   * no equivalent cheap probe at the backend level yet, and the WS bridge
   * itself is the only attach surface. Tests can still override via the
   * injected `hasAttachedClients` dep.
   */
  private hasAttachedClients(agentId: string): boolean {
    if (this.deps.hasAttachedClients) return this.deps.hasAttachedClients(agentId);
    return false;
  }

  private broadcastSnapshot(): void {
    const snapshot = this.deps.monitor.getSnapshot();
    // Enrich with autoProceedingAt before broadcast
    for (const agent of snapshot) {
      const proceedAt = this.proceedAt.get(agent.agentId);
      if (proceedAt && agent.anomaly) {
        agent.anomaly.autoProceedingAt = proceedAt;
      }
    }
    this.deps.broadcastToAll({
      type: 'snapshot',
      agents: snapshot,
      serverCwd: this.deps.serverCwd,
    });
  }
}

