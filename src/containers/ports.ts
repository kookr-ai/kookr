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

/** Docker operations the reconciler and `kookr containers` need. `run` arrives with the launch slice (S2d). */
export interface DockerRunnerPort {
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
}

export type KookrTaskLiveness =
  | { state: 'live' }
  | { state: 'terminal'; endedAt: Date }
  | { state: 'unknown' }
  /** The task store could not be read: the reconciler must do nothing to the container. */
  | { state: 'store_unreadable' };

/** How the reconciler asks Kookr about a task. `unknown` means the store was read and has no such task. */
export type TaskLookupPort = (taskId: string) => KookrTaskLiveness;
