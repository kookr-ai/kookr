/**
 * Ports for opencode worker containers (RFC #3541, S2b). Everything the container adapter and reconciler need from
 * the outside world sits behind these interfaces so tests run against fakes and no test needs a Docker daemon.
 */

export const CONTAINER_NAME_PREFIX = 'kookr-oc-';
export const LABEL_INSTANCE = 'kookr.instance';
export const LABEL_TASK = 'kookr.task';
export const LABEL_LAUNCH = 'kookr.launch';

export interface ContainerInfo {
  id: string;
  name: string;
  /** Docker's `State.Status`: running | exited | created | paused | restarting | dead | removing. */
  state: string;
  createdAt: Date;
  labels: Record<string, string>;
  exitCode?: number;
  oomKilled?: boolean;
  restartCount?: number;
}

export interface NetworkInfo {
  id: string;
  name: string;
  /** Docker's `Created`; a missing or invalid date is treated as brand new (inside grace). */
  createdAt?: Date;
  labels: Record<string, string>;
}

export interface ContainerMount { source: string; target: string; readOnly: boolean }

/** Everything `docker run` needs for one worker. The runner turns it into an argv array; it never builds a shell string. */
export interface ContainerRunSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** `uid:gid` the worker runs as (the host user, so bind mounts and 0600 secrets work for any host user). */
  user: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  mounts: ContainerMount[];
  tmpfs: string[];
  /** Container port published on 127.0.0.1 only, with an ephemeral host port. */
  publishPort: number;
  env: Record<string, string>;
}

/** Docker operations the reconciler, `kookr containers` and the container adapter need. */
export interface DockerRunnerPort {
  /** `docker run -d` with the hardening flags (read-only root, no caps, no-new-privileges). Returns the container id. */
  runContainer(spec: ContainerRunSpec): Promise<string>;
  /** Host port Docker bound for `containerPort` (loopback), or throws when none is published. */
  publishedPort(name: string, containerPort: number): Promise<number>;
  /** Docker `State.Health.Status` (`starting|healthy|unhealthy`), or undefined when the image has no healthcheck. */
  healthStatus(name: string): Promise<string | undefined>;
  /** `docker rm -f`: removes a running container (readiness failure and stop). */
  forceRemoveContainer(name: string): Promise<void>;
  /** Containers (any state) whose label `key` equals `value`. */
  listContainers(label: { key: string; value: string }): Promise<ContainerInfo[]>;
  /** Stop with a grace period, then leave the container in place. */
  stopContainer(name: string, graceSeconds: number): Promise<void>;
  removeContainer(name: string): Promise<void>;
  listNetworks(label: { key: string; value: string }): Promise<NetworkInfo[]>;
  removeNetwork(name: string): Promise<void>;
}

export type A2aTaskState = 'SUBMITTED' | 'WORKING' | 'INPUT_REQUIRED' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'UNKNOWN';

/** The worker's A2A endpoint. The client owns protocol quirks (RFC F5); callers see only these shapes. */
export interface A2aClientPort {
  /** Health of the worker process; rejects on timeout or transport failure. */
  health(endpoint: string, timeoutMs: number): Promise<'ok' | 'degraded'>;
  /** State of the single task this worker runs; rejects on timeout or transport failure. */
  taskState(endpoint: string, token: string, timeoutMs: number): Promise<A2aTaskState>;
  /**
   * Send a user message. Without `contextId` it opens a new conversation; with one it continues it (a finished task
   * cannot be messaged again, so a follow-up is a NEW task in the same context). Returns right away (`returnImmediately`).
   */
  sendMessage(endpoint: string, token: string, msg: { text: string; contextId?: string }, timeoutMs: number): Promise<{ taskId: string; contextId: string; state: A2aTaskState }>;
  /** Cancel a task, then read its state back after the call settles (RFC F5: a stream close can flip it to FAILED). */
  cancelTask(endpoint: string, token: string, taskId: string, timeoutMs: number): Promise<A2aTaskState>;
  /** Id of the task currently WORKING (or the newest one), if any. */
  currentTask(endpoint: string, token: string, timeoutMs: number): Promise<{ taskId: string; state: A2aTaskState } | undefined>;
}

export type KookrTaskLiveness =
  | { state: 'live' }
  | { state: 'terminal'; endedAt: Date }
  | { state: 'unknown' }
  /** The task store could not be read: the reconciler must do nothing to the container. */
  | { state: 'store_unreadable' };

/** How the reconciler asks Kookr about a task. `unknown` means the store was read and has no such task. */
export type TaskLookupPort = (taskId: string) => KookrTaskLiveness;
