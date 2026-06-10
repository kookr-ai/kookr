import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from '../launch-service.js';
import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { nowISO, readInteractionLog } from '../../core/interaction-log.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
import { buildReflectionRecommendationResponse, buildReflectionTaskPrompt } from '../reflection-task.js';

/**
 * Narrow dependency bag for the `reflect` message.
 *
 * Reflection reads the interaction log, analyzes session friction, and — when
 * the threshold is crossed — launches a new supervisor task. Those side
 * effects are why the handler needs `launchTask`, `taskStore`, `monitor`, and
 * `serverCwd` that the rest of the config family does not.
 */
export interface ReflectionHandlerDeps {
  send: (msg: ServerMessage) => void;
  taskStore: TaskStore;
  monitor: Monitor;
  serverCwd: string;
  interactionLog?: DeferredInteractionLogWriter;
  launchTask?: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
}

type ReflectMessage = Extract<ClientMessage, { type: 'reflect' }>;

/**
 * Handles the session-reflection message. Extracted from `ConfigHandler`
 * so the config family no longer has to carry task-launch dependencies.
 */
export class ReflectionHandler {
  constructor(private readonly deps: ReflectionHandlerDeps) {}

  async handle(_msg: ReflectMessage): Promise<void> {
    const logPath = this.deps.interactionLog?.getFilePath() ?? null;
    const events = logPath ? await readInteractionLog(logPath) : [];
    const report = analyzeSession(events);
    const recommendation = buildReflectionRecommendationResponse(logPath, report);

    if (!this.deps.launchTask || !logPath) {
      this.deps.send({
        type: 'alert',
        agentId: '',
        summary: 'No supervision session is available to reflect on yet.',
        details: 'Launch and supervise at least one task before starting reflection.',
        severity: 'info',
      });
      return;
    }

    if (!recommendation.recommendation.shouldSuggest) {
      this.deps.send({
        type: 'alert',
        agentId: '',
        summary: 'This session stayed below the reflection threshold.',
        details: recommendation.recommendation.rationale.join(' '),
        severity: 'info',
      });
      return;
    }

    const launchResult = await this.deps.launchTask({
      prompt: buildReflectionTaskPrompt({
        interactionLogPath: logPath,
        report,
        taskStore: this.deps.taskStore,
        monitor: this.deps.monitor,
      }),
      cwd: this.deps.serverCwd,
      name: 'Reflect on session friction',
    });

    await this.deps.interactionLog?.append({
      type: 'reflect_triggered',
      timestamp: nowISO(),
    });

    this.deps.send({
      type: 'alert',
      agentId: launchResult.task.sessions[0]?.tmuxSession ?? '',
      summary: 'Reflection task created for the latest high-friction session.',
      details: recommendation.recommendation.summary,
      severity: 'info',
    });
  }
}
