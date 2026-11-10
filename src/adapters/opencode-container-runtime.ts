/**
 * Wiring for opencode worker containers (RFC #3541, S2d): builds the container adapter and its collaborators from the
 * environment, behind `KOOKR_OPENCODE_CONTAINERS`. Nothing is constructed (and no Docker call is made) when the flag is
 * off, so default Kookr behaviour is unchanged.
 */
import { dirname, join } from 'node:path';
import type { TaskStore } from '../core/tasks.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { A2aHttpClient } from '../containers/a2a-http-client.js';
import { DockerCliRunner } from '../containers/docker-cli-runner.js';
import { getOrCreateInstanceId } from '../containers/instance-id.js';
import { IntentStore } from '../containers/intent-store.js';
import { ContainerLedgerIngest, type LedgerWatcherPort } from '../containers/ledger-ingest.js';
import type { DockerRunnerPort, A2aClientPort, TaskLookupPort } from '../containers/ports.js';
import { ContainerReconciler } from '../containers/reconciler.js';
import {
  DEFAULT_OPENCODE_API_KEY_ENV, DEFAULT_OPENCODE_BASE_URL, DEFAULT_OPENCODE_MODEL_ID, DEFAULT_OPENCODE_PROVIDER_ID,
} from './opencode-adapter.js';
import { OpenCodeContainerAdapter } from './opencode-container-adapter.js';
import { resolveDefaultBinDir, resolveDefaultPluginHooksDir } from './opencode-kookr-hooks.js';
import { resolveOpenCodeDataRoot } from './opencode-task-data.js';
import type { TerminalBackend } from './terminal-backend.js';

export const OPENCODE_CONTAINERS_ENV = 'KOOKR_OPENCODE_CONTAINERS';
export const OPENCODE_CONTAINER_IMAGE_ENV = 'KOOKR_OPENCODE_CONTAINER_IMAGE';
/** S2d ships a hard cap of one live container; S4 replaces it with a measured default. Deliberately not configurable. */
const OPENCODE_CONTAINER_CAP = 1;
const RECONCILE_INTERVAL_MS = 60_000;

export function isOpenCodeContainersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPENCODE_CONTAINERS_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** The watcher only exists after the hook runtime is built, which is after the adapters; bind it late. */
class LateWatcher implements LedgerWatcherPort {
  target?: LedgerWatcherPort;
  private get w(): LedgerWatcherPort {
    if (!this.target) throw new Error('hook watcher is not bound yet');
    return this.target;
  }
  watch(key: string, o: Parameters<LedgerWatcherPort['watch']>[1]): void { this.w.watch(key, o); }
  stop(key: string): void { this.target?.stop(key); }
  isWatching(key: string): boolean { return this.target?.isWatching(key) ?? false; }
}

export interface OpenCodeContainerRuntime {
  adapter: OpenCodeContainerAdapter;
  /** Give the runtime the server's hook watcher, then re-attach ledgers of running containers (adopt after restart). */
  bindWatcher(watcher: LedgerWatcherPort): Promise<string[]>;
  startReconciler(): void;
  stop(): void;
}

export interface CreateContainerRuntimeDeps {
  taskStore: TaskStore;
  backend: TerminalBackend;
  env: NodeJS.ProcessEnv;
  hooksDir: string;
  warn?: (msg: string) => void;
  /** Test seams. */
  docker?: DockerRunnerPort;
  a2a?: A2aClientPort;
  kookrDir?: string;
}

/** Undefined when the flag is off or the runtime cannot be configured (the reason is warned once, never silent). */
export async function createOpenCodeContainerRuntime(deps: CreateContainerRuntimeDeps): Promise<OpenCodeContainerRuntime | undefined> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  if (!isOpenCodeContainersEnabled(deps.env)) return undefined;
  const image = deps.env[OPENCODE_CONTAINER_IMAGE_ENV]?.trim();
  if (!image) {
    warn(`[startup] ${OPENCODE_CONTAINERS_ENV} is set but ${OPENCODE_CONTAINER_IMAGE_ENV} is not: opencode container mode is OFF (tasks use the host TUI).`);
    return undefined;
  }
  const hooksDir = deps.hooksDir.startsWith('~/') ? join(deps.env.HOME ?? process.env.HOME ?? '', deps.hooksDir.slice(2)) : deps.hooksDir;
  const kookrDir = deps.kookrDir ?? dirname(hooksDir);
  const docker = deps.docker ?? new DockerCliRunner();
  const instanceId = await getOrCreateInstanceId(kookrDir);
  const watcher = new LateWatcher();
  const intents = new IntentStore(join(kookrDir, 'container-intents'));
  const runtimeRoot = join(kookrDir, 'opencode-containers');
  const a2a = deps.a2a ?? new A2aHttpClient();
  const adapter = new OpenCodeContainerAdapter(
    { docker, a2a, taskStore: deps.taskStore, backend: deps.backend, ledger: new ContainerLedgerIngest(join(runtimeRoot, 'spool'), watcher), intents, instanceId },
    {
      image, cap: OPENCODE_CONTAINER_CAP, runtimeRoot, dataRoot: resolveOpenCodeDataRoot(deps.env, hooksDir), env: deps.env,
      hostBinDir: resolveDefaultBinDir(deps.env), hostPluginHooksDir: resolveDefaultPluginHooksDir(deps.env),
      model: {
        providerId: DEFAULT_OPENCODE_PROVIDER_ID, modelId: DEFAULT_OPENCODE_MODEL_ID,
        baseUrl: DEFAULT_OPENCODE_BASE_URL, apiKeyEnv: DEFAULT_OPENCODE_API_KEY_ENV,
      },
    },
  );
  const tasks: TaskLookupPort = (taskId) => {
    const t = deps.taskStore.getTask(taskId);
    if (!t) return { state: 'unknown' };
    return isTerminalStatus(t.status) ? { state: 'terminal', endedAt: t.updatedAt ?? new Date() } : { state: 'live' };
  };
  const reconciler = new ContainerReconciler({
    docker, tasks, intents, instanceId,
    logFile: join(kookrDir, 'container-reconcile.jsonl'), quarantineFile: join(kookrDir, 'container-quarantine.json'),
  });
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => { void reconciler.reconcile().catch((e) => warn(`[containers] reconcile failed: ${(e as Error).message}`)); };
  return {
    adapter,
    async bindWatcher(w) {
      watcher.target = w;
      return adapter.adoptRunning();
    },
    startReconciler() {
      if (timer) return;
      tick();
      timer = setInterval(tick, RECONCILE_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
