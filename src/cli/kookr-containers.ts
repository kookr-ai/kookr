import { join } from 'node:path';
import { DockerCliRunner } from '../containers/docker-cli-runner.js';
import { readInstanceId } from '../containers/instance-id.js';
import { IntentStore } from '../containers/intent-store.js';
import { CONTAINER_NAME_PREFIX, LABEL_INSTANCE, LABEL_LAUNCH, LABEL_TASK, type DockerRunnerPort } from '../containers/ports.js';
import { ContainerReconciler, DEFAULT_GRACE_MS, type ReconcileAction } from '../containers/reconciler.js';
import { loadTaskLiveness } from '../containers/task-liveness.js';
import { resolveKookrDataDir } from './kookr-maintenance.js';

export const CONTAINERS_HELP_TEXT = `kookr containers — inspect and clean up opencode worker containers.

Usage:
  kookr containers ls [--json] [--dir PATH]
  kookr containers prune --instance [--yes] [--force] [--dir PATH]

ls     Lists this Kookr instance's worker containers (label kookr.instance) with the
       decision the reconciler would take: adopt, grace, keep_terminal, stop_remove,
       quarantine_stop, quarantine_keep, remove_quarantined, hold. Read-only.
prune  Stops and removes EVERY container and network labelled with this instance's
       id (and named kookr-oc-*). Dry run unless --yes. Use it to clean up after
       reverting the container feature. Other Kookr instances' objects are never touched.

Options:
  --json      Machine-readable output (ls).
  --instance  Required for prune: scope to this instance's label.
  --yes       Actually remove (prune); without it prune only lists.
  --force     Prune even containers whose task is still live (kills running workers).
  --dir PATH  Use an explicit data directory (e.g. ~/.kookr-4801).
  -h, --help  Show this help.`;

export interface ContainersDeps {
  env?: NodeJS.ProcessEnv;
  out?: Pick<Console, 'log'>;
  err?: Pick<Console, 'error'>;
  docker?: DockerRunnerPort;
  now?: () => Date;
}

interface Parsed { verb?: 'ls' | 'prune'; json: boolean; instance: boolean; yes: boolean; force: boolean; dir?: string; help: boolean; error?: string }

export function parseContainersArgs(argv: string[]): Parsed {
  const p: Parsed = { json: false, instance: false, yes: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') p.help = true;
    else if (a === '--json') p.json = true;
    else if (a === '--instance') p.instance = true;
    else if (a === '--yes') p.yes = true;
    else if (a === '--force') p.force = true;
    else if (a === '--dir') {
      const v = argv[++i];
      if (!v) return { ...p, error: '--dir requires a path' };
      p.dir = v;
    } else if (!p.verb && (a === 'ls' || a === 'prune')) p.verb = a;
    else return { ...p, error: `unexpected argument ${JSON.stringify(a)}` };
  }
  if (!p.help && !p.verb) p.error = 'missing subcommand (ls | prune)';
  if (!p.help && p.verb === 'prune' && !p.instance) p.error = 'prune requires --instance (scopes removal to this instance)';
  return p;
}

function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export async function runContainersCli(argv: string[], deps: ContainersDeps = {}): Promise<number> {
  const { env = process.env, out = console, err = console } = deps;
  const now = deps.now ?? (() => new Date());
  const p = parseContainersArgs(argv);
  if (p.help) { out.log(CONTAINERS_HELP_TEXT); return 0; }
  if (p.error) { err.error(p.error); err.error('Usage: kookr containers ls|prune --instance [--yes] [--json] [--dir PATH]'); return 2; }

  const dataDir = p.dir ?? resolveKookrDataDir(env);
  const instanceId = await readInstanceId(dataDir);
  if (!instanceId) {
    if (p.json) out.log(JSON.stringify({ instanceId: null, containers: [] }));
    else out.log(`No container instance id in ${dataDir}: this install has not launched any worker container.`);
    return 0;
  }
  const docker = deps.docker ?? new DockerCliRunner();
  try {
    const containers = await docker.listContainers({ key: LABEL_INSTANCE, value: instanceId });
    const allNetworks = await docker.listNetworks({ key: LABEL_INSTANCE, value: instanceId });
    // Look up every task id either kind of object mentions, so no object is judged on an unqueried id.
    const tasks = await loadTaskLiveness(dataDir, [...containers, ...allNetworks].map((o) => o.labels[LABEL_TASK] ?? ''), env);
    const reconciler = new ContainerReconciler({
      docker, tasks, instanceId, now,
      intents: new IntentStore(join(dataDir, 'container-intents'), now),
      logFile: join(dataDir, 'container-reconcile.jsonl'),
      quarantineFile: join(dataDir, 'container-quarantine.json'),
    });

    if (p.verb === 'ls') {
      const plan = await reconciler.plan();
      const byName = new Map(plan.map((a) => [a.name, a] as const));
      const rows = containers.map((c) => ({
        name: c.name, taskId: c.labels[LABEL_TASK] ?? null, state: c.state,
        ageMs: now().getTime() - c.createdAt.getTime(),
        decision: byName.get(c.name)?.kind ?? 'ignore', reason: byName.get(c.name)?.reason ?? '',
        orphan: ['quarantine_stop', 'quarantine_keep', 'remove_quarantined'].includes(byName.get(c.name)?.kind ?? ''),
      }));
      if (p.json) { out.log(JSON.stringify({ instanceId, containers: rows })); return 0; }
      if (rows.length === 0) { out.log('No worker containers for this instance.'); return 0; }
      out.log('NAME\tTASK\tSTATE\tAGE\tDECISION\tORPHAN');
      for (const r of rows) out.log(`${r.name}\t${r.taskId ?? '-'}\t${r.state}\t${age(r.ageMs)}\t${r.decision}\t${r.orphan ? 'yes' : 'no'}`);
      return 0;
    }

    // prune --instance: every labelled + prefixed object of THIS instance.
    const targets = containers.filter((c) => c.name.startsWith(CONTAINER_NAME_PREFIX) && c.labels[LABEL_INSTANCE] === instanceId);
    const nets = allNetworks
      .filter((n) => n.name.startsWith(CONTAINER_NAME_PREFIX) && n.labels[LABEL_INSTANCE] === instanceId);
    if (targets.length + nets.length === 0) { out.log('Nothing to prune.'); return 0; }
    for (const c of targets) out.log(`${p.yes ? 'removing' : 'would remove'} container ${c.name} (${c.state})`);
    for (const n of nets) out.log(`${p.yes ? 'removing' : 'would remove'} network ${n.name}`);
    if (!p.yes) { out.log('Dry run. Re-run with --yes to remove.'); return 0; }
    const intents = new IntentStore(join(dataDir, 'container-intents'), now);
    const protectedMarks = new Set<string>();
    for (const o of [...targets, ...nets]) {
      const st = tasks(o.labels[LABEL_TASK] ?? '').state;
      const young = !o.createdAt || !(now().getTime() - o.createdAt.getTime() >= DEFAULT_GRACE_MS);
      const launch = o.labels[LABEL_LAUNCH];
      const inFlight = launch ? await intents.isOpen(launch) : false;
      if (st === 'live' || st === 'store_unreadable' || young || inFlight) protectedMarks.add(o.name);
    }
    const liveOnes = [...targets, ...nets].filter((o) => protectedMarks.has(o.name));
    if (liveOnes.length > 0 && !p.force) {
      err.error(`refusing to prune: ${liveOnes.length} object(s) belong to live tasks, are younger than 120 s, have an open launch intent, or the task store is unreadable (${liveOnes.map((c) => c.name).join(', ')}). Re-run with --force to kill them.`);
      return 1;
    }
    let failed = 0;
    for (const c of targets) {
      try { await docker.stopContainer(c.name, 10); await docker.removeContainer(c.name); } catch (e) { failed++; err.error(`failed to remove ${c.name}: ${String(e)}`); }
    }
    for (const n of nets) {
      try { await docker.removeNetwork(n.name); } catch (e) { failed++; err.error(`failed to remove network ${n.name}: ${String(e)}`); }
    }
    return failed ? 1 : 0;
  } catch (e) {
    err.error(`kookr containers: docker unavailable or failed: ${String(e)}`);
    return 1;
  }
}

export type { ReconcileAction };
