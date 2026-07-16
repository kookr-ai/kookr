import type { EventOrigin, InjectHookEventResult } from '../core/types.js';
import type { TaskStore } from '../core/tasks.js';
import { normalizeAgentType } from '../core/agent-types.js';
import type {
  AdapterEventHandler,
  AdapterLaunchOptions,
  AgentAdapter,
  EffectiveHookSettings,
  ResumeContext,
} from './agent-adapter.js';
import { AdapterRegistry } from './agent-adapter.js';

/**
 * Session-scoped router that fans in events from all registered adapters and
 * dispatches session operations to the adapter recorded on the owning task.
 */
export class RoutingAgentAdapter implements AgentAdapter {
  readonly agentType = 'claude-code' as const;

  private eventHandlers: Array<AdapterEventHandler> = [];
  private refreshHandlers: Array<() => void> = [];

  constructor(
    private taskStore: TaskStore,
    private registry: AdapterRegistry,
  ) {
    for (const adapter of registry.getAll()) {
      adapter.onEvent((tmuxName, event, meta) => {
        for (const handler of this.eventHandlers) {
          handler(tmuxName, event, meta);
        }
      });
      adapter.onRefreshNeeded(() => {
        for (const handler of this.refreshHandlers) {
          handler();
        }
      });
    }
  }

  async launch(
    taskId: string,
    prompt: string,
    cwd: string,
    resume?: ResumeContext,
    opts?: AdapterLaunchOptions,
  ): Promise<string> {
    return this.registry.getDefault().launch(taskId, prompt, cwd, resume, opts);
  }

  async sendInput(tmuxName: string, text: string): Promise<void> {
    return this.resolve(tmuxName).sendInput(tmuxName, text);
  }

  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    return this.resolve(tmuxName).sendKeystroke(tmuxName, key);
  }

  async stop(tmuxName: string): Promise<void> {
    return this.resolve(tmuxName).stop(tmuxName);
  }

  async captureDisplay(tmuxName: string): Promise<string> {
    return this.resolve(tmuxName).captureDisplay(tmuxName);
  }

  onEvent(handler: AdapterEventHandler): void {
    this.eventHandlers.push(handler);
  }

  onRefreshNeeded(handler: () => void): void {
    this.refreshHandlers.push(handler);
  }

  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    sequence?: number,
    options?: { origin?: EventOrigin },
  ): InjectHookEventResult {
    const adapter = this.resolve(tmuxName);
    return options
      ? adapter.injectHookEvent(tmuxName, rawJson, sequence, options)
      : adapter.injectHookEvent(tmuxName, rawJson, sequence);
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    return this.resolve(tmuxName).getEffectiveHookSettings(tmuxName);
  }

  private resolve(tmuxName: string): AgentAdapter {
    const task = this.taskStore.findTaskBySession(tmuxName);
    const session = task?.sessions.find((item) => item.tmuxSession === tmuxName);
    if (!session) {
      // A provider can emit hooks while its launch() call is still waiting for
      // the first UserPromptSubmit. Adapters register their TaskStore session
      // after that handshake, so the task-based lookup is intentionally empty
      // during this window. The generated hook settings already identify the
      // owning adapter, and using them here prevents a non-default provider
      // (notably Grok's camelCase payloads) from being parsed by Claude's
      // snake_case decoder or from losing the launch confirmation event.
      const inFlightAdapter = this.registry.getAll().find((candidate) =>
        candidate.getActiveHookSettings?.(tmuxName) !== undefined,
      );
      if (inFlightAdapter) return inFlightAdapter;

      // Persisted settings are only a restart-time fallback. They share a
      // directory across providers, so use them only when no active launch
      // claims the session; normal live sessions are resolved by TaskStore.
      const persistedAdapter = this.registry.getAll().find((candidate) =>
        candidate.getEffectiveHookSettings(tmuxName) !== undefined,
      );
      return persistedAdapter ?? this.registry.getDefault();
    }
    return this.registry.get(session.agentType);
  }
}
