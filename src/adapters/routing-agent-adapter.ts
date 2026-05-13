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

  injectHookEvent(tmuxName: string, rawJson: string): void {
    this.resolve(tmuxName).injectHookEvent(tmuxName, rawJson);
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    return this.resolve(tmuxName).getEffectiveHookSettings(tmuxName);
  }

  private resolve(tmuxName: string): AgentAdapter {
    const task = this.taskStore.findTaskBySession(tmuxName);
    const session = task?.sessions.find((item) => item.tmuxSession === tmuxName);
    if (!session) {
      return this.registry.getDefault();
    }
    return this.registry.get(session.agentType);
  }
}
