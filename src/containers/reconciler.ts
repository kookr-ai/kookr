import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CONTAINER_NAME_PREFIX,
  LABEL_INSTANCE,
  LABEL_LAUNCH,
  LABEL_TASK,
  type ContainerInfo,
  type DockerRunnerPort,
  type NetworkInfo,
  type TaskLookupPort,
} from './ports.js';
import type { IntentStore } from './intent-store.js';

export const DEFAULT_GRACE_MS = 120_000;
export const DEFAULT_TERMINAL_RETENTION_MS = 24 * 3_600_000;
export const DEFAULT_QUARANTINE_MS = 24 * 3_600_000;
export const DEFAULT_STOP_GRACE_S = 10;

export type ReconcileActionKind =
  | 'adopt' // task live: leave the container alone, it is the task's worker
  | 'grace' // too young or launch in flight: never touched
  | 'hold' // task store unreadable: do nothing
  | 'keep_terminal' // task finished, still within retention
  | 'stop_remove' // task finished, retention elapsed
  | 'quarantine_stop' // no such task: stop (not delete) and start the quarantine clock
  | 'quarantine_keep' // already quarantined, clock still running
  | 'remove_quarantined' // quarantine elapsed
  | 'remove_network'
  | 'ignore'; // not provably ours

export interface ReconcileAction {
  kind: ReconcileActionKind;
  /** Container or network name. */
  name: string;
  taskId?: string;
  reason: string;
}

export interface ReconcilerDeps {
  docker: DockerRunnerPort;
  tasks: TaskLookupPort;
  intents: IntentStore;
  instanceId: string;
  /** Durable action log (JSON lines). */
  logFile: string;
  /** Quarantine clock state (JSON object name -> ISO first-seen). */
  quarantineFile: string;
  now?: () => Date;
  graceMs?: number;
  terminalRetentionMs?: number;
  quarantineMs?: number;
}

export interface ReconcileResult {
  actions: ReconcileAction[];
  errors: number;
  at: string;
}

/**
 * Brings Docker's view of this Kookr instance's worker containers in line with Kookr's task records.
 *
 * Safety rules (RFC #3541, "Reconcile, not just adopt"):
 *  - only objects with `kookr.instance == this instance` AND a `kookr-oc-` name AND a `kookr.task` label are ever
 *    acted on; everything else is `ignore`d even if the listing returned it;
 *  - containers younger than the grace period, or whose launch has an open intent, are never touched;
 *  - an unknown task is quarantined (stopped, kept) for a day before anything is removed;
 *  - every action and its outcome is appended to the durable log.
 */
export class ContainerReconciler {
  lastReconcileAt?: Date;
  consecutiveFailures = 0;
  private readonly now: () => Date;

  constructor(private readonly d: ReconcilerDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private ours(name: string, labels: Record<string, string>): boolean {
    return name.startsWith(CONTAINER_NAME_PREFIX) && labels[LABEL_INSTANCE] === this.d.instanceId && !!labels[LABEL_TASK];
  }

  private async readQuarantine(): Promise<Record<string, string>> {
    try {
      const v = JSON.parse(await readFile(this.d.quarantineFile, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async writeQuarantine(q: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.d.quarantineFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.d.quarantineFile}.tmp`;
    await writeFile(tmp, JSON.stringify(q), { mode: 0o600 });
    await rename(tmp, this.d.quarantineFile);
  }

  /** What `reconcile()` would do. Reads Docker and Kookr state; changes nothing. */
  async plan(): Promise<ReconcileAction[]> {
    const now = this.now().getTime();
    const grace = this.d.graceMs ?? DEFAULT_GRACE_MS;
    const retention = this.d.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    const quarantineMs = this.d.quarantineMs ?? DEFAULT_QUARANTINE_MS;
    const containers = await this.d.docker.listContainers({ key: LABEL_INSTANCE, value: this.d.instanceId });
    const quarantine = await this.readQuarantine();
    const actions: ReconcileAction[] = [];
    const removing = new Set<string>(); // container names slated for removal
    const survivingTasks = new Set<string>(); // task ids that still have a container after this pass

    for (const c of containers) {
      const taskId = c.labels[LABEL_TASK];
      if (!this.ours(c.name, c.labels)) {
        actions.push({ kind: 'ignore', name: c.name, reason: 'not labelled/named as this instance\'s worker' });
        continue;
      }
      const act = (kind: ReconcileActionKind, reason: string) => {
        actions.push({ kind, name: c.name, taskId, reason });
        if (kind === 'stop_remove' || kind === 'remove_quarantined') removing.add(c.name);
        else survivingTasks.add(taskId!);
      };
      const launch = c.labels[LABEL_LAUNCH];
      if (!(now - c.createdAt.getTime() >= grace)) { act('grace', 'younger than the grace period'); continue; }
      if (launch && (await this.d.intents.isOpen(launch))) { act('grace', 'launch intent still open'); continue; }
      const live = this.d.tasks(taskId!);
      if (live.state === 'store_unreadable') {
        act('hold', 'task store unreadable; refusing to act');
      } else if (live.state === 'live') {
        act('adopt', c.state === 'running' ? 'task live, container running' : `task live but container is ${c.state}`);
      } else if (live.state === 'terminal') {
        act(now - live.endedAt.getTime() >= retention ? 'stop_remove' : 'keep_terminal',
          now - live.endedAt.getTime() >= retention ? 'task terminal, retention elapsed' : 'task terminal, within retention');
      } else {
        const since = quarantine[c.name];
        if (!since) act('quarantine_stop', 'no task record for this container');
        else if (now - Date.parse(since) >= quarantineMs) act('remove_quarantined', 'quarantine elapsed');
        else act('quarantine_keep', 'quarantined, clock running');
      }
    }

    const networks = await this.d.docker.listNetworks({ key: LABEL_INSTANCE, value: this.d.instanceId });
    for (const n of networks) {
      const taskId = n.labels[LABEL_TASK];
      if (!n.name.startsWith(CONTAINER_NAME_PREFIX) || n.labels[LABEL_INSTANCE] !== this.d.instanceId || !taskId) {
        actions.push({ kind: 'ignore', name: n.name, reason: 'network not provably this instance\'s' });
        continue;
      }
      const launch = n.labels[LABEL_LAUNCH];
      if (survivingTasks.has(taskId)) continue;
      if (!n.createdAt || !(now - n.createdAt.getTime() >= grace)) continue; // young or undated: inside grace
      if (launch && (await this.d.intents.isOpen(launch))) continue;
      const liveness = this.d.tasks(taskId);
      if (liveness.state === 'store_unreadable' || liveness.state === 'live') continue; // a live task's network is never removed
      actions.push({ kind: 'remove_network', name: n.name, taskId, reason: 'no container of this task remains' });
    }
    return actions;
  }

  /** Plan, apply, and log. Never throws for a single failed action; counts it instead. */
  async reconcile(): Promise<ReconcileResult> {
    const at = this.now();
    let actions: ReconcileAction[];
    try {
      actions = await this.plan();
    } catch (err) {
      this.consecutiveFailures++;
      await this.log({ at: at.toISOString(), kind: 'plan_failed', error: String(err) });
      return { actions: [], errors: 1, at: at.toISOString() };
    }
    const quarantine = await this.readQuarantine();
    let qDirty = false;
    let errors = 0;
    const grace = DEFAULT_STOP_GRACE_S;
    // Drop quarantine entries for containers that are no longer quarantine candidates.
    const live = new Set(actions.filter((a) => a.kind === 'quarantine_stop' || a.kind === 'quarantine_keep' || a.kind === 'remove_quarantined').map((a) => a.name));
    for (const name of Object.keys(quarantine)) if (!live.has(name)) { delete quarantine[name]; qDirty = true; }

    for (const a of actions) {
      let result: 'ok' | 'error' | 'noop' = 'noop';
      let error: string | undefined;
      try {
        if (a.kind === 'quarantine_stop') {
          await this.d.docker.stopContainer(a.name, grace);
          quarantine[a.name] = at.toISOString();
          qDirty = true;
          result = 'ok';
        } else if (a.kind === 'stop_remove' || a.kind === 'remove_quarantined') {
          await this.d.docker.stopContainer(a.name, grace);
          await this.d.docker.removeContainer(a.name);
          delete quarantine[a.name];
          qDirty = true;
          result = 'ok';
        } else if (a.kind === 'remove_network') {
          await this.d.docker.removeNetwork(a.name);
          result = 'ok';
        }
      } catch (err) {
        result = 'error';
        error = String(err);
        errors++;
      }
      // Routine no-op decisions are not logged every 60 s; only changes and errors are.
      if (result !== 'noop') await this.log({ at: at.toISOString(), ...a, result, ...(error ? { error } : {}) });
    }
    if (qDirty) await this.writeQuarantine(quarantine);
    this.lastReconcileAt = at;
    this.consecutiveFailures = errors > 0 ? this.consecutiveFailures + 1 : 0;
    return { actions, errors, at: at.toISOString() };
  }

  private async log(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.d.logFile), { recursive: true, mode: 0o700 });
      await appendFile(this.d.logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // The log is evidence, not control flow: a full disk must not stop reconciliation.
    }
  }
}

export type { ContainerInfo, NetworkInfo };
