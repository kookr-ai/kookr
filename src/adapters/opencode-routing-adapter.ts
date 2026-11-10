/**
 * The single `opencode` adapter the registry sees when `KOOKR_OPENCODE_CONTAINERS` is on (RFC #3541 §2a "Dispatch").
 * `AdapterRegistry` is keyed by agent type with no task context, so the TUI and container adapters cannot both register;
 * this wrapper owns the only mode-aware code and delegates everything else.
 *
 *  - launch: the persisted `opencodeLaunchMode` wins (a relaunch never changes mode); with none, the flag decides once and
 *    the answer is persisted after the launch succeeds;
 *  - handles: a container worker's handle is its container name (`kookr-oc-...`), so stop/sendInput/sendKeystroke route
 *    by the handle alone and keep working after a Kookr restart with no in-memory map;
 *  - hook events are mode-agnostic (the ledger carries the same Claude-shaped records as the TUI plugin), so parsing,
 *    parentage and event handlers stay in the TUI adapter's `injectHookEvent`.
 */
import type { SendInputOptions } from '../core/ports/agent-interaction-port.js';
import type { TaskStore } from '../core/tasks.js';
import type { AdapterLaunchOptions, AgentAdapter, EffectiveHookSettings, ResumeContext } from './agent-adapter.js';
import type { OpenCodeAdapter } from './opencode-adapter.js';
import type { OpenCodeContainerAdapter } from './opencode-container-adapter.js';
import { resolveOpenCodeLaunchMode } from './opencode-launch-policy.js';

export const CONTAINER_HANDLE_PREFIX = 'kookr-oc-';
export const isContainerHandle = (handle: string): boolean => handle.startsWith(CONTAINER_HANDLE_PREFIX);

export class OpenCodeRoutingAdapter implements AgentAdapter {
  readonly agentType = 'opencode';

  constructor(
    private readonly tui: OpenCodeAdapter,
    private readonly container: OpenCodeContainerAdapter,
    private readonly taskStore: TaskStore,
  ) {}

  async launch(taskId: string, prompt: string, cwd: string, resume?: ResumeContext, opts?: AdapterLaunchOptions): Promise<string> {
    const task = this.taskStore.getTask(taskId);
    // A task that already ran (has sessions) before any mode was recorded is a pre-flag host-TUI task: it must stay TUI.
    const persisted = task?.metadata?.opencodeLaunchMode ?? (task && task.sessions.length > 0 ? 'tui' : undefined);
    const policy = resolveOpenCodeLaunchMode({ persisted, containersAvailable: true, containersRequested: true });
    if (!policy.ok) throw new Error(policy.message);
    if (policy.mode === 'tui') {
      const handle = await this.tui.launch(taskId, prompt, cwd, resume, opts);
      this.taskStore.recordOpenCodeLaunchMode(taskId, 'tui');
      return handle;
    }
    // Decided once, BEFORE anything can fail: a container launch that dies after registering its session (canary,
    // A2A auth) must not leave a task that a retry would read as a pre-flag host task and run on the host TUI.
    this.taskStore.recordOpenCodeLaunchMode(taskId, 'container');
    return this.container.launch(taskId, prompt, cwd, resume, opts);
  }

  stop(handle: string): Promise<void> {
    return isContainerHandle(handle) ? this.container.stop(handle) : this.tui.stop(handle);
  }

  sendInput(handle: string, text: string, opts?: SendInputOptions): Promise<void> {
    return isContainerHandle(handle) ? this.container.sendInput(handle, text, opts) : this.tui.sendInput(handle, text, opts);
  }

  sendKeystroke(handle: string, key: string): Promise<void> {
    return isContainerHandle(handle) ? this.container.sendKeystroke(handle, key) : this.tui.sendKeystroke(handle, key);
  }

  captureDisplay(handle: string): Promise<string> {
    return this.tui.captureDisplay(handle); // both modes render the terminal backend's session (the container's is `docker logs -f`)
  }

  onEvent(handler: Parameters<AgentAdapter['onEvent']>[0]): void {
    this.tui.onEvent(handler);
  }

  onRefreshNeeded(handler: () => void): void {
    this.tui.onRefreshNeeded(handler);
  }

  injectHookEvent: AgentAdapter['injectHookEvent'] = (handle, raw, seq, options) => this.tui.injectHookEvent(handle, raw, seq, options);

  getEffectiveHookSettings(handle: string): EffectiveHookSettings | undefined {
    return isContainerHandle(handle) ? undefined : this.tui.getEffectiveHookSettings(handle);
  }

  getActiveHookSettings(handle: string): EffectiveHookSettings | undefined {
    return isContainerHandle(handle) ? undefined : this.tui.getActiveHookSettings(handle);
  }
}
