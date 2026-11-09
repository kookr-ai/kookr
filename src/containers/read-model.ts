import type { A2aTaskState, ContainerInfo } from './ports.js';

export type ContainerHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';
export type ContainerDivergence =
  | 'none'
  | 'a2a_ahead_of_ledger'
  | 'container_dead_task_live'
  | 'task_terminal_container_live'
  | 'probe_stale';

export const PROBE_INTERVAL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_MISSES_FOR_UNKNOWN = 3;
export const HOOKS_BLIND_LAG_MS = 120_000;

export interface ContainerReadModelInput {
  launchMode: 'container';
  /** Kookr's view: is the task still live? */
  taskLive: boolean;
  container?: ContainerInfo;
  a2aState?: A2aTaskState;
  /** True when the host has ingested a terminal event for the task from the hook ledger. */
  ledgerTerminal?: boolean;
  lastHookAt?: Date;
  lastProbeAt?: Date;
  consecutiveProbeMisses: number;
  ingestLagMs?: number;
  memBytes?: number;
  diskBytes?: number;
  imageDigest?: string;
  launchToken?: string;
  now: Date;
}

/** One record per container task, shown by `kookr containers ls` and, later, status/peek and the UI. */
export interface ContainerReadModel {
  launchMode: 'container';
  kookrState: 'live' | 'terminal';
  containerState: string;
  a2aState: A2aTaskState | 'unknown';
  health: ContainerHealth;
  divergence: ContainerDivergence;
  hooksBlind: boolean;
  lastHookAt?: string;
  lastProbeAt?: string;
  ingestLagMs?: number;
  restarts?: number;
  oomKilled?: boolean;
  memBytes?: number;
  diskBytes?: number;
  imageDigest?: string;
  launchToken?: string;
}

const A2A_TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED']);

/**
 * Pure derivation of health and divergence. Precedence when signals disagree: container state > ledger > A2A.
 * Three missed probes make health `unknown` — never `healthy`; a worker we cannot see is not assumed fine.
 */
export function buildContainerReadModel(i: ContainerReadModelInput): ContainerReadModel {
  const c = i.container;
  const containerState = c?.state ?? 'missing';
  const running = containerState === 'running';
  const hooksBlind = running && i.ingestLagMs !== undefined && i.ingestLagMs > HOOKS_BLIND_LAG_MS;
  const probeStale = running && (i.consecutiveProbeMisses >= PROBE_MISSES_FOR_UNKNOWN
    || !i.lastProbeAt || i.now.getTime() - i.lastProbeAt.getTime() > PROBE_INTERVAL_MS * 3);

  let divergence: ContainerDivergence = 'none';
  if (!running && i.taskLive) divergence = 'container_dead_task_live';
  else if (running && !i.taskLive) divergence = 'task_terminal_container_live';
  else if (running && i.a2aState && A2A_TERMINAL.has(i.a2aState) && !i.ledgerTerminal) divergence = 'a2a_ahead_of_ledger';
  else if (probeStale) divergence = 'probe_stale';

  let health: ContainerHealth;
  if (!running) health = c && (c.oomKilled || (c.exitCode ?? 0) !== 0 || i.taskLive) ? 'failed' : 'unknown';
  else if (probeStale) health = 'unknown';
  else if (hooksBlind || i.a2aState === 'FAILED' || (c?.restartCount ?? 0) > 0) health = 'degraded';
  else health = 'healthy';

  return {
    launchMode: 'container',
    kookrState: i.taskLive ? 'live' : 'terminal',
    containerState,
    a2aState: i.a2aState ?? 'unknown',
    health,
    divergence,
    hooksBlind,
    ...(i.lastHookAt ? { lastHookAt: i.lastHookAt.toISOString() } : {}),
    ...(i.lastProbeAt ? { lastProbeAt: i.lastProbeAt.toISOString() } : {}),
    ...(i.ingestLagMs !== undefined ? { ingestLagMs: i.ingestLagMs } : {}),
    ...(c?.restartCount !== undefined ? { restarts: c.restartCount } : {}),
    ...(c?.oomKilled !== undefined ? { oomKilled: c.oomKilled } : {}),
    ...(i.memBytes !== undefined ? { memBytes: i.memBytes } : {}),
    ...(i.diskBytes !== undefined ? { diskBytes: i.diskBytes } : {}),
    ...(i.imageDigest ? { imageDigest: i.imageDigest } : {}),
    ...(i.launchToken ? { launchToken: i.launchToken } : {}),
  };
}
