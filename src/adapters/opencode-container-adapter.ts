/**
 * opencode in a worker container (RFC #3541, S2d). Sibling of `OpenCodeAdapter` (host TUI): same agent type, profiles and
 * task metadata, different runtime. Chosen per task by `OpenCodeRoutingAdapter`; behind `KOOKR_OPENCODE_CONTAINERS`.
 *
 * What lives where (so nothing here has to be re-derived from a Kookr restart):
 *  - the handle ("tmux name") is the container name `kookr-oc-<task8>-<token>`; a derived `docker logs -f` terminal
 *    session carries it, so the existing liveness/reap machinery sees the worker die when the container does;
 *  - everything needed to control a running container (A2A bearer token, published port, context id) is in a private
 *    0600 `runtime.json`, NOT in task metadata (which is served over the API). `stop`/`sendInput` read it from disk, so
 *    a restarted Kookr still controls an adopted container.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { AdapterLaunchOptions, ResumeContext } from './agent-adapter.js';
import type { SendInputOptions } from '../core/ports/agent-interaction-port.js';
import type { TaskStore } from '../core/tasks.js';
import { cloneForWorker } from '../containers/clone-extract.js';
import { containerSessionKey, ledgerLocation, type ContainerLedgerIngest } from '../containers/ledger-ingest.js';
import type { IntentStore } from '../containers/intent-store.js';
import { LABEL_INSTANCE, LABEL_LAUNCH, LABEL_TASK, CONTAINER_NAME_PREFIX, type A2aClientPort, type ContainerRunSpec, type DockerRunnerPort } from '../containers/ports.js';
import { resolveGateBaseEnv } from './opencode-gate-base.js';
import { composeOpenCodeSession, type ComposeOpenCodeSessionOptions } from './opencode-home-composer.js';
import {
  buildContainerLedgerCommand, CONTAINER_HOOKS_ROOT, CONTAINER_PATHS, CONTAINER_SPOOL_ROOT, stageContainerHooks,
} from './opencode-container-hooks.js';
import { defaultKookrClaudeHooks, type OpenCodeProfile } from './opencode-kookr-hooks.js';
import { resolveSessionPolicy } from './opencode-session-policy.js';
import type { ShelfShowRunner } from './opencode-shelf-memory.js';
import {
  inspectOpenCodeSession, isAbsentOrEmptyDir, isMarkedTaskDir, markTaskDir, openCodeTaskDataHome, openCodeTaskDir,
  readGateBase, readOpenCodeSessionId, removeMarkedTaskDir, touchTaskDir,
} from './opencode-task-data.js';
import { mapOpenCodeUsageToTokenUsage, readOpenCodeDataHomeUsage } from './opencode-usage-scanner.js';
import type { TerminalBackend } from './terminal-backend.js';

type ModelConfig = ComposeOpenCodeSessionOptions['model'];

export type ContainerLaunchFailure =
  | 'docker_down' | 'image_missing' | 'health_timeout' | 'plugin_not_loaded' | 'a2a_unauth' | 'container_cap_reached'
  | 'provider_key_missing' | 'hook_assets_missing' | 'pr_lint_unresolvable' | 'clone_failed';

/** A refused or failed container launch; `reason` is the stable code surfaced to the operator. */
export class ContainerLaunchError extends Error {
  constructor(readonly reason: ContainerLaunchFailure, detail: string) {
    super(`opencode container launch refused (${reason}): ${detail}`);
    this.name = 'ContainerLaunchError';
  }
}

/** Container sessions have no terminal to type into (RFC: `sendKeystroke` is a typed Unsupported). */
export class ContainerUnsupportedError extends Error {
  readonly code = 'unsupported';
  constructor(what: string) {
    super(`${what} is not supported for opencode container workers (non-interactive; use sendInput or stop)`);
    this.name = 'ContainerUnsupportedError';
  }
}

export interface ContainerRuntimeRecord {
  taskId: string;
  containerName: string;
  launchToken: string;
  port: number;
  a2aToken: string;
  image: string;
  contextId?: string;
  a2aTaskId?: string;
  startedAt: string;
}

export interface OpenCodeContainerAdapterDeps {
  docker: DockerRunnerPort;
  a2a: A2aClientPort;
  taskStore: TaskStore;
  backend: TerminalBackend;
  ledger: ContainerLedgerIngest;
  intents: IntentStore;
  instanceId: string;
}

export interface OpenCodeContainerAdapterConfig {
  image: string;
  /** Hard cap on live containers for this server (S2d: 1 until the S4 measurement). */
  cap: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** `~/.kookr/opencode-containers`: private per-task runtime dirs (secrets, staged hooks, clone) and the spool. */
  runtimeRoot: string;
  /** Per-task persistent data root (the same one the TUI adapter uses). */
  dataRoot: string;
  hostBinDir?: string;
  hostPluginHooksDir?: string;
  model: ModelConfig;
  permission?: 'allow' | 'ask';
  profile?: OpenCodeProfile;
  profilesDir?: string;
  shelfShow?: ShelfShowRunner;
  env?: NodeJS.ProcessEnv;
  /** `uid:gid` the worker runs as. Default: this process's. */
  user?: string;
  readyTimeoutMs?: number;
  canaryTimeoutMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cloneRepo?: (source: string, dest: string) => Promise<void>;
  newToken?: () => string;
  composeSession?: typeof composeOpenCodeSession;
  /** Reads the ledger size for the canary (default: stat). */
  ledgerSize?: (file: string) => Promise<number>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LIVE_STATES = new Set(['running', 'created', 'restarting', 'paused']);
const CONTINUE_PROMPT = 'Continue the task from where you left off.';

export const PROVIDER_KEY_SECRET = 'provider_key';

export class OpenCodeContainerAdapter {
  readonly agentType = 'opencode';
  private records = new Map<string, ContainerRuntimeRecord>();
  private launching = new Set<string>();
  private readonly cfg: Required<Pick<OpenCodeContainerAdapterConfig, 'memory' | 'cpus' | 'pidsLimit' | 'readyTimeoutMs' | 'canaryTimeoutMs' | 'user'>> & OpenCodeContainerAdapterConfig;

  constructor(private readonly d: OpenCodeContainerAdapterDeps, config: OpenCodeContainerAdapterConfig) {
    this.cfg = {
      memory: '2g', cpus: '2', pidsLimit: 512, readyTimeoutMs: 60_000, canaryTimeoutMs: 60_000,
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      ...config,
    };
  }

  private get now(): number { return (this.cfg.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.cfg.sleep ?? defaultSleep)(ms); }
  private get env(): NodeJS.ProcessEnv { return this.cfg.env ?? process.env; }
  private taskRuntimeDir(taskId: string): string { return join(this.cfg.runtimeRoot, 'tasks', taskId); }
  private get spoolRoot(): string { return join(this.cfg.runtimeRoot, 'spool'); }

  // ---- launch -----------------------------------------------------------------------------------------------

  async launch(taskId: string, prompt: string, cwd: string, resume?: ResumeContext, opts?: AdapterLaunchOptions): Promise<string> {
    const token = (this.cfg.newToken ?? (() => randomBytes(6).toString('hex')))();
    const containerName = `${CONTAINER_NAME_PREFIX}${taskId.slice(0, 8)}-${token}`;
    const sessionKey = containerSessionKey(taskId, token);
    if (sessionKey !== containerName) throw new Error(`container name ${containerName} does not match the session key ${sessionKey}`);

    // Refusals first: nothing is created until all of these pass.
    if (this.launching.size > 0) throw new ContainerLaunchError('container_cap_reached', 'another container launch is in flight');
    this.launching.add(taskId);
    let launched = false;
    let ranDocker = false;
    let sessionCreated = false;
    let taskRegistered = false;
    try {
      opts?.onPhase?.('session-create');
      const live = await this.liveContainerCount();
      if (live >= this.cfg.cap) throw new ContainerLaunchError('container_cap_reached', `${live} container(s) already running (cap ${this.cfg.cap})`);
      const apiKeyEnv = this.cfg.model.apiKeyEnv;
      const providerKey = this.env[apiKeyEnv]?.trim();
      if (!providerKey) throw new ContainerLaunchError('provider_key_missing', `${apiKeyEnv} is not set in the Kookr environment`);
      if (this.env.KOOKR_PR_LINT_CMD?.trim()) {
        throw new ContainerLaunchError('pr_lint_unresolvable', 'KOOKR_PR_LINT_CMD is a host command and cannot resolve inside the worker image; unset it for container mode');
      }
      if (!this.cfg.hostBinDir || !this.cfg.hostPluginHooksDir) {
        throw new ContainerLaunchError('hook_assets_missing', 'the Kookr bin/ or plugin/hooks directory was not found');
      }
      throwIfAborted(opts?.signal);

      const resuming = resume?.sessionId !== undefined && await this.canResume(taskId, resume);
      const taskDir = openCodeTaskDir(this.cfg.dataRoot, taskId);
      const priorGateBase = !resuming && (await isMarkedTaskDir(taskDir, taskId)) ? await readGateBase(taskDir) : undefined;
      const priorRecord = await this.readRecord(taskId);
      if (!resuming) {
        if (!(await removeMarkedTaskDir(taskDir, taskId)) && !(await isAbsentOrEmptyDir(taskDir))) {
          throw new Error(`refusing to use ${taskDir} as opencode task data: it exists and was not created by Kookr`);
        }
      }
      await mkdir(taskDir, { recursive: true, mode: 0o700 });
      await markTaskDir(taskDir, taskId, token);
      const dataHome = openCodeTaskDataHome(taskDir);
      await mkdir(dataHome, { recursive: true, mode: 0o700 });
      await touchTaskDir(taskDir);

      const rt = this.taskRuntimeDir(taskId);
      if (!resuming) await rm(rt, { recursive: true, force: true });
      await mkdir(rt, { recursive: true, mode: 0o700 });
      const workDir = join(rt, 'work');
      if (!(await exists(join(workDir, '.git')))) {
        await rm(workDir, { recursive: true, force: true });
        try {
          await (this.cfg.cloneRepo ?? cloneForWorker)(cwd, workDir);
        } catch (err) {
          throw new ContainerLaunchError('clone_failed', (err as Error).message);
        }
      }

      const secretsDir = join(rt, 'secrets');
      const a2aToken = randomBytes(24).toString('hex');
      await rm(secretsDir, { recursive: true, force: true });
      await mkdir(secretsDir, { recursive: true, mode: 0o700 });
      await writeSecret(join(secretsDir, 'opencode_password'), randomBytes(24).toString('hex'));
      await writeSecret(join(secretsDir, 'a2a_token'), a2aToken);
      await writeSecret(join(secretsDir, PROVIDER_KEY_SECRET), providerKey);

      const hooksDir = join(rt, 'hooks');
      try {
        await stageContainerHooks({ hostBinDir: this.cfg.hostBinDir, hostPluginHooksDir: this.cfg.hostPluginHooksDir, destDir: hooksDir });
      } catch (err) {
        throw new ContainerLaunchError('hook_assets_missing', (err as Error).message);
      }

      const spool = await this.d.ledger.prepare(taskId, token);
      const cfgDir = await this.composeConfig(taskId, sessionKey, rt, dataHome, taskDir, workDir, resuming, priorGateBase, opts);

      const spec: ContainerRunSpec = {
        name: containerName,
        image: this.cfg.image,
        labels: { [LABEL_TASK]: taskId, [LABEL_LAUNCH]: token, [LABEL_INSTANCE]: this.d.instanceId },
        user: this.cfg.user,
        memory: this.cfg.memory,
        cpus: this.cfg.cpus,
        pidsLimit: this.cfg.pidsLimit,
        mounts: [
          { source: cfgDir, target: '/cfg', readOnly: true },
          { source: workDir, target: '/work', readOnly: false },
          { source: taskDir, target: '/data', readOnly: false },
          { source: secretsDir, target: '/run/secrets', readOnly: true },
          { source: hooksDir, target: CONTAINER_HOOKS_ROOT, readOnly: true },
          { source: spool.dir, target: CONTAINER_SPOOL_ROOT, readOnly: false },
        ],
        tmpfs: ['/tmp:rw,size=128m', `/home/worker:rw,size=512m,uid=${this.cfg.user.split(':')[0]}`],
        publishPort: 8000,
        env: { HOME: '/home/worker', XDG_DATA_HOME: `/data/${relative(taskDir, dataHome)}`, WORKSPACE: '/work' },
      };

      throwIfAborted(opts?.signal);
      await this.d.intents.open(taskId, token, this.d.instanceId);
      opts?.onPhase?.('agent-boot');
      ranDocker = true;
      try {
        await this.d.docker.runContainer(spec);
      } catch (err) {
        throw classifyDockerError(err);
      }
      opts?.onSessionCreated?.(containerName);
      const port = await this.d.docker.publishedPort(containerName, 8000);
      await this.waitHealthy(containerName);
      const record: ContainerRuntimeRecord = {
        taskId, containerName, launchToken: token, port, a2aToken, image: this.cfg.image, startedAt: new Date(this.now).toISOString(),
        ...(resuming && priorRecord?.contextId ? { contextId: priorRecord.contextId } : {}),
      };
      await this.writeRecord(record);
      this.records.set(containerName, record);

      // The supervisor session: a derived, disposable `docker logs -f` view. It is what the rest of Kookr sees as "the
      // worker", so the worker dying (container exit) ends it through the normal dead-worker path.
      await this.d.backend.createSession({
        id: containerName, command: 'docker', args: ['logs', '-f', '--tail', '50', containerName],
        env: { PATH: this.env.PATH ?? '/usr/bin:/bin', HOME: this.env.HOME ?? '/' }, cwd, size: { cols: 200, rows: 50 },
      });
      sessionCreated = true;
      // Register the session BEFORE the prompt is sent: the first hook events (SessionStart) arrive within milliseconds
      // and are parsed against the task's session.
      this.d.taskStore.addSession(taskId, { tmuxSession: containerName, agentType: 'opencode', cwd, createdAt: new Date() });
      taskRegistered = true;
      this.d.ledger.attach(taskId, token, { adopt: true });

      opts?.onPhase?.('ack');
      const sent = await this.sendWithAuthCheck(record, resuming ? CONTINUE_PROMPT : prompt, record.contextId);
      record.contextId = sent.contextId;
      record.a2aTaskId = sent.taskId;
      await this.writeRecord(record);
      await this.waitLedgerCanary(spool.file);
      await this.d.intents.close(token);
      launched = true;
      return containerName;
    } catch (err) {
      if (!launched) await this.abortLaunch(taskId, containerName, token, { ranDocker, sessionCreated, taskRegistered });
      throw err;
    } finally {
      this.launching.delete(taskId);
    }
  }

  /** Compose the read-only `/cfg` dir: opencode.json (provider key via a file ref), plugin, AGENTS.md. */
  private async composeConfig(
    taskId: string, sessionKey: string, rt: string, dataHome: string, taskDir: string,
    workDir: string, resuming: boolean, priorGateBase: string | undefined, opts?: AdapterLaunchOptions,
  ): Promise<string> {
    const { loaded, permission, instructions } = await resolveSessionPolicy(
      { profilesDir: this.cfg.profilesDir, defaultPermission: this.cfg.permission ?? 'allow', defaultProfile: this.cfg.profile, env: this.env, shelfShow: this.cfg.shelfShow, warn: (m) => console.warn(m) },
      { profileId: opts?.profile ?? this.d.taskStore.getTask(taskId)?.metadata?.opencodeProfile, bypassPermissions: opts?.bypassPermissions, extraEnv: opts?.extraEnv },
    );
    const issue = opts?.issue ?? this.d.taskStore.getTask(taskId)?.metadata?.opencodeIssue;
    const hookEnv = {
      KOOKR_TASK_ID: taskId,
      ...(await resolveGateBaseEnv(workDir, taskDir, resuming, priorGateBase)),
      ...(issue !== undefined ? { KOOKR_OPENCODE_ISSUE: String(issue) } : {}),
      ...(this.cfg.profile?.hookEnv ?? {}),
    };
    const claudeHooks = this.cfg.profile?.claudeHooks ?? defaultKookrClaudeHooks({
      pluginHooksDir: this.cfg.hostPluginHooksDir, binDir: this.cfg.hostBinDir, deliverable: loaded?.deliverable, containerPaths: CONTAINER_PATHS,
    });
    const sessionDir = join(rt, 'compose');
    await rm(sessionDir, { recursive: true, force: true });
    const model = opts?.model ?? loaded?.model;
    const composed = await (this.cfg.composeSession ?? composeOpenCodeSession)({
      sessionDir, sessionId: sessionKey, cwd: '/work', dataHome, hookCommand: buildContainerLedgerCommand(sessionKey),
      model: model ? { ...this.cfg.model, modelId: model.startsWith(`${this.cfg.model.providerId}/`) ? model.slice(this.cfg.model.providerId.length + 1) : model } : this.cfg.model,
      permission,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(claudeHooks ? { claudeHooks: { ...claudeHooks, env: { ...(claudeHooks.env ?? {}), ...hookEnv } } } : {}),
    });
    // The entrypoint copies /cfg and points opencode at /cfg/opencode.json. The provider key is a file reference to the
    // 0600 secret, never an env var (docker inspect / `env` would show it).
    const cfg = JSON.parse(await readFile(composed.configPath, 'utf8')) as { provider: Record<string, { options: { apiKey: string } }> };
    for (const p of Object.values(cfg.provider)) p.options.apiKey = `{file:/run/secrets/${PROVIDER_KEY_SECRET}}`;
    await writeFile(join(composed.configDir, 'opencode.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return composed.configDir;
  }

  private async canResume(taskId: string, resume: ResumeContext): Promise<boolean> {
    const preferred = resume.sessionId.startsWith('ses_') ? resume.sessionId : this.d.taskStore.getTask(taskId)?.metadata?.opencodeSessionId;
    const found = await inspectOpenCodeSession(openCodeTaskDataHome(openCodeTaskDir(this.cfg.dataRoot, taskId)), preferred);
    if (found.kind === 'unreadable') throw new Error(`cannot resume ${taskId}: its opencode database is unreadable (${found.error})`);
    return found.kind !== 'absent';
  }

  private async liveContainerCount(): Promise<number> {
    let all;
    try {
      all = await this.d.docker.listContainers({ key: LABEL_INSTANCE, value: this.d.instanceId });
    } catch (err) {
      throw new ContainerLaunchError('docker_down', (err as Error).message);
    }
    return all.filter((c) => LIVE_STATES.has(c.state)).length;
  }

  private async waitHealthy(name: string): Promise<void> {
    const deadline = this.now + this.cfg.readyTimeoutMs;
    for (;;) {
      const st = await this.d.docker.healthStatus(name);
      if (st === 'healthy') return;
      if (st === 'unhealthy') throw new ContainerLaunchError('health_timeout', 'the worker healthcheck reported unhealthy');
      // Fail fast when the entrypoint already exited (13 secret/workspace, 14 hook self-test, 10-12 child death).
      const info = (await this.d.docker.listContainers({ key: LABEL_INSTANCE, value: this.d.instanceId }).catch(() => [])).find((c) => c.name === name);
      if (info && (info.state === 'exited' || info.state === 'dead')) {
        const code = info.exitCode;
        throw new ContainerLaunchError(code === 14 ? 'hook_assets_missing' : 'health_timeout', `the worker container exited during startup (exit code ${code ?? 'unknown'})${info.oomKilled ? ', OOM-killed' : ''}`);
      }
      if (this.now >= deadline) throw new ContainerLaunchError('health_timeout', `not healthy within ${this.cfg.readyTimeoutMs} ms`);
      await this.sleep(500);
    }
  }

  private async sendWithAuthCheck(rec: ContainerRuntimeRecord, text: string, contextId?: string) {
    try {
      return await this.d.a2a.sendMessage(`http://127.0.0.1:${rec.port}`, rec.a2aToken, { text, ...(contextId ? { contextId } : {}) }, 15_000);
    } catch (err) {
      const msg = (err as Error).message;
      throw /HTTP 40[13]/.test(msg) ? new ContainerLaunchError('a2a_unauth', msg) : err;
    }
  }

  /**
   * Readiness beyond "the process answers": the plugin must have written at least one hook record (SessionStart or
   * UserPromptSubmit) to the ledger. Without it the gate would be blind, so the launch fails instead.
   */
  private async waitLedgerCanary(file: string): Promise<void> {
    const size = this.cfg.ledgerSize ?? (async (f: string) => (await stat(f).catch(() => ({ size: 0 }))).size);
    const deadline = this.now + this.cfg.canaryTimeoutMs;
    while ((await size(file)) === 0) {
      if (this.now >= deadline) throw new ContainerLaunchError('plugin_not_loaded', `no hook event reached the ledger within ${this.cfg.canaryTimeoutMs} ms`);
      await this.sleep(500);
    }
  }

  private async abortLaunch(taskId: string, name: string, token: string, st: { ranDocker: boolean; sessionCreated: boolean; taskRegistered: boolean }): Promise<void> {
    if (st.taskRegistered) {
      try { this.d.taskStore.updateSession(taskId, name, { lastStatus: 'aborted' }); } catch { /* best-effort */ }
    }
    this.d.ledger.detach(taskId, token);
    if (st.sessionCreated) await this.d.backend.killSession(name).catch(() => undefined);
    if (st.ranDocker) await this.d.docker.forceRemoveContainer(name).catch(() => undefined);
    await this.d.intents.close(token).catch(() => undefined);
    await rm(join(this.taskRuntimeDir(taskId), 'secrets'), { recursive: true, force: true }).catch(() => undefined);
    this.records.delete(name);
  }

  // ---- control (all rehydrate from disk, never from launch-time memory) --------------------------------------

  async sendInput(handle: string, text: string, _opts?: SendInputOptions): Promise<void> {
    const rec = await this.recordFor(handle);
    const sent = await this.d.a2a.sendMessage(`http://127.0.0.1:${rec.port}`, rec.a2aToken, { text, ...(rec.contextId ? { contextId: rec.contextId } : {}) }, 15_000);
    rec.contextId = sent.contextId;
    rec.a2aTaskId = sent.taskId;
    await this.writeRecord(rec);
  }

  async sendKeystroke(_handle: string, _key: string): Promise<void> {
    throw new ContainerUnsupportedError('sendKeystroke');
  }

  async captureDisplay(handle: string): Promise<string> {
    return new TextDecoder('utf-8', { fatal: false }).decode(await this.d.backend.captureBytes(handle));
  }

  /**
   * Stop = A2A cancel (best effort) -> `docker stop -t 10` -> record usage/session id from the bind-mounted DB ->
   * remove the container and the secrets. The conversation data and the clone are kept (resume, deliverable extraction).
   * A2A state is advisory: a failed cancel never skips the container stop.
   */
  async stop(handle: string): Promise<void> {
    const rec = await this.recordFor(handle).catch(() => undefined);
    const taskId = rec?.taskId ?? this.d.taskStore.findTaskBySession(handle)?.id;
    if (rec) {
      try {
        const ep = `http://127.0.0.1:${rec.port}`;
        const cur = await this.d.a2a.currentTask(ep, rec.a2aToken, 3000);
        if (cur && (cur.state === 'WORKING' || cur.state === 'SUBMITTED')) await this.d.a2a.cancelTask(ep, rec.a2aToken, cur.taskId, 5000);
      } catch { /* advisory only */ }
    }
    let stopFailed: unknown;
    try {
      await this.d.docker.stopContainer(handle, 10);
    } catch (err) {
      stopFailed = err;
    }
    if (taskId) {
      await this.recordUsageAndSession(taskId);
      if (rec) this.d.ledger.detach(taskId, rec.launchToken);
    }
    await this.d.backend.killSession(handle).catch(() => undefined);
    if (!stopFailed) await this.d.docker.removeContainer(handle).catch(() => undefined);
    else await this.d.docker.forceRemoveContainer(handle).catch(() => undefined);
    if (taskId) {
      await rm(join(this.taskRuntimeDir(taskId), 'secrets'), { recursive: true, force: true }).catch(() => undefined);
      await touchTaskDir(openCodeTaskDir(this.cfg.dataRoot, taskId)).catch(() => undefined);
    }
    this.records.delete(handle);
    if (rec) await this.d.intents.close(rec.launchToken).catch(() => undefined);
  }

  /** Usage and opencode session id come from the host-readable bind-mounted DB (same readers as the TUI adapter). */
  private async recordUsageAndSession(taskId: string): Promise<void> {
    const dataHome = openCodeTaskDataHome(openCodeTaskDir(this.cfg.dataRoot, taskId));
    try {
      const usage = await readOpenCodeDataHomeUsage(dataHome);
      if (usage.kind === 'ok' && this.d.taskStore.getTask(taskId)) this.d.taskStore.updateTokenUsage(taskId, mapOpenCodeUsageToTokenUsage(usage.usage));
      const id = await readOpenCodeSessionId(dataHome, this.d.taskStore.getTask(taskId)?.metadata?.opencodeSessionId);
      if (id && this.d.taskStore.getTask(taskId)?.metadata?.opencodeSessionId !== id) this.d.taskStore.recordOpenCodeSessionId(taskId, id);
    } catch { /* telemetry is best-effort */ }
  }

  // ---- adopt / records ---------------------------------------------------------------------------------------

  /** Re-load every running container's control record after a Kookr restart (event identity is taskId+token). */
  async adoptRunning(): Promise<string[]> {
    const adopted: string[] = [];
    for (const rec of await this.listRecords()) {
      if (!LIVE_STATES.has((await this.safeContainerState(rec.containerName)) ?? '')) continue;
      this.records.set(rec.containerName, rec);
      // A surviving supervisor session is re-armed by startup recovery (checkpoint + hydration + the ledger override).
      // Attaching here first would pin its replay mode before recovery runs, so only attach when no session survived.
      if (!(await this.d.backend.isAlive(rec.containerName).catch(() => false))) this.d.ledger.attach(rec.taskId, rec.launchToken, { adopt: true });
      adopted.push(rec.containerName);
    }
    return adopted;
  }

  private async safeContainerState(name: string): Promise<string | undefined> {
    try {
      return (await this.d.docker.listContainers({ key: LABEL_INSTANCE, value: this.d.instanceId })).find((c) => c.name === name)?.state;
    } catch {
      return undefined;
    }
  }

  /** Where the ledger of a container session lives, for the watcher override at startup recovery. */
  ledgerFor(handle: string): { filePath: string; untrusted: true } | undefined {
    const m = /^kookr-oc-([A-Za-z0-9_-]{1,8})-([A-Za-z0-9]{6,32})$/.exec(handle);
    if (!m) return undefined;
    const task = this.d.taskStore.findTaskBySession(handle);
    if (!task || task.metadata?.opencodeLaunchMode !== 'container') return undefined;
    return { filePath: ledgerLocation(this.spoolRoot, task.id, m[2]!).file, untrusted: true };
  }

  private async recordFor(handle: string): Promise<ContainerRuntimeRecord> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    const taskId = this.d.taskStore.findTaskBySession(handle)?.id;
    const rec = taskId ? await this.readRecord(taskId) : undefined;
    if (!rec || rec.containerName !== handle) throw new Error(`no container runtime record for ${handle}`);
    this.records.set(handle, rec);
    return rec;
  }

  private recordPath(taskId: string): string { return join(this.taskRuntimeDir(taskId), 'runtime.json'); }

  private async readRecord(taskId: string): Promise<ContainerRuntimeRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(taskId), 'utf8')) as ContainerRuntimeRecord;
    } catch {
      return undefined;
    }
  }

  private async writeRecord(rec: ContainerRuntimeRecord): Promise<void> {
    const p = this.recordPath(rec.taskId);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, p);
  }

  private async listRecords(): Promise<ContainerRuntimeRecord[]> {
    const dirs = await readdir(join(this.cfg.runtimeRoot, 'tasks')).catch(() => [] as string[]);
    const out: ContainerRuntimeRecord[] = [];
    for (const id of dirs) {
      const r = await this.readRecord(id);
      if (r) out.push(r);
    }
    return out;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('opencode container launch aborted');
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function writeSecret(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function classifyDockerError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/Unable to find image|No such image|pull access denied/i.test(msg)) return new ContainerLaunchError('image_missing', msg.split('\n')[0] ?? msg);
  if (/Cannot connect to the Docker daemon|docker daemon|connect: no such file|ENOENT/i.test(msg)) return new ContainerLaunchError('docker_down', msg.split('\n')[0] ?? msg);
  return err instanceof Error ? err : new Error(msg);
}
