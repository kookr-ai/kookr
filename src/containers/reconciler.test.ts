import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeDocker } from './fake-docker.js';
import { IntentStore } from './intent-store.js';
import { LABEL_INSTANCE, LABEL_LAUNCH, LABEL_TASK, type ContainerInfo, type KookrTaskLiveness } from './ports.js';
import { ContainerReconciler } from './reconciler.js';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-01-10T12:00:00Z');
const H = 3_600_000;

describe('ContainerReconciler', () => {
  let dir: string;
  let docker: FakeDocker;
  let intents: IntentStore;
  let clock: Date;
  let liveness: Record<string, KookrTaskLiveness>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-recon-'));
    docker = new FakeDocker();
    clock = new Date(T0);
    intents = new IntentStore(join(dir, 'intents'), () => clock);
    liveness = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const container = (over: Partial<ContainerInfo> & { task?: string; launch?: string; instance?: string; ageMs?: number } = {}): ContainerInfo => ({
    id: 'id', name: over.name ?? 'kookr-oc-aaaaaaaa-tok1', state: over.state ?? 'running',
    createdAt: new Date(T0.getTime() - (over.ageMs ?? 48 * H)),
    labels: { [LABEL_INSTANCE]: over.instance ?? SELF, [LABEL_TASK]: over.task ?? 't1', [LABEL_LAUNCH]: over.launch ?? 'tokentoken1' },
  });
  const make = () => new ContainerReconciler({
    docker, intents, instanceId: SELF, now: () => clock,
    tasks: (id) => liveness[id] ?? { state: 'unknown' },
    logFile: join(dir, 'log.jsonl'), quarantineFile: join(dir, 'q.json'),
  });

  test('a live task is adopted and nothing is touched', async () => {
    docker.containers = [container()];
    liveness.t1 = { state: 'live' };
    const r = await make().reconcile();
    expect(r.actions.map((a) => a.kind)).toEqual(['adopt']);
    expect(docker.calls).toEqual([]);
  });

  test('containers younger than the grace period are never touched, even for unknown tasks', async () => {
    docker.containers = [container({ ageMs: 60_000 })];
    const r = await make().reconcile();
    expect(r.actions[0]!.kind).toBe('grace');
    expect(docker.calls).toEqual([]);
  });

  test('an open launch intent protects an old container; a closed or abandoned one does not', async () => {
    docker.containers = [container()];
    await intents.open('t1', 'tokentoken1', SELF);
    expect((await make().plan())[0]!.kind).toBe('grace');
    await intents.close('tokentoken1');
    expect((await make().plan())[0]!.kind).toBe('quarantine_stop');
    await intents.open('t1', 'tokentoken1', SELF);
    clock = new Date(clock.getTime() + 11 * 60_000); // abandoned
    expect((await make().plan())[0]!.kind).toBe('quarantine_stop');
  });

  test('unknown task: stop and keep, remove only after the quarantine day, and the clock survives a new reconciler', async () => {
    docker.containers = [container()];
    await make().reconcile();
    expect(docker.calls).toEqual(['stop kookr-oc-aaaaaaaa-tok1']);
    expect(docker.containers).toHaveLength(1);
    clock = new Date(clock.getTime() + 23 * H);
    expect((await make().reconcile()).actions[0]!.kind).toBe('quarantine_keep');
    expect(docker.calls).toEqual(['stop kookr-oc-aaaaaaaa-tok1']);
    clock = new Date(clock.getTime() + 2 * H);
    expect((await make().reconcile()).actions[0]!.kind).toBe('remove_quarantined');
    expect(docker.containers).toHaveLength(0);
  });

  test('a task that comes back (live) leaves quarantine', async () => {
    docker.containers = [container()];
    await make().reconcile();
    liveness.t1 = { state: 'live' };
    await make().reconcile();
    expect(JSON.parse(readFileSync(join(dir, 'q.json'), 'utf8'))).toEqual({});
  });

  test('terminal task: kept within retention, stopped and removed after', async () => {
    docker.containers = [container()];
    liveness.t1 = { state: 'terminal', endedAt: new Date(T0.getTime() - 2 * H) };
    expect((await make().reconcile()).actions[0]!.kind).toBe('keep_terminal');
    expect(docker.calls).toEqual([]);
    liveness.t1 = { state: 'terminal', endedAt: new Date(T0.getTime() - 25 * H) };
    await make().reconcile();
    expect(docker.calls).toEqual(['stop kookr-oc-aaaaaaaa-tok1', 'rm kookr-oc-aaaaaaaa-tok1']);
  });

  test('an unreadable task store makes the reconciler do nothing at all', async () => {
    docker.containers = [container(), container({ name: 'kookr-oc-bbbbbbbb-tok2', task: 't2' })];
    liveness.t1 = { state: 'store_unreadable' };
    liveness.t2 = { state: 'store_unreadable' };
    const r = await make().reconcile();
    expect(r.actions.map((a) => a.kind)).toEqual(['hold', 'hold']);
    expect(docker.calls).toEqual([]);
  });

  test('another instance and unprefixed names are never acted on, even if the listing returns them', async () => {
    docker.containers = [container({ instance: OTHER }), container({ name: 'postgres', task: 't9' })];
    const listAll = docker.listContainers.bind(docker);
    docker.listContainers = async () => (await listAll({ key: LABEL_INSTANCE, value: SELF })).concat(docker.containers);
    const r = await make().reconcile();
    expect(docker.calls).toEqual([]);
    expect(r.actions.every((a) => a.kind === 'ignore')).toBe(true);
  });

  test('networks of a task with no remaining container are removed; protected by surviving container or open intent', async () => {
    docker.networks = [
      { id: 'n1', name: 'kookr-oc-net-t1', labels: { [LABEL_INSTANCE]: SELF, [LABEL_TASK]: 't1', [LABEL_LAUNCH]: 'tokentoken1' } },
      { id: 'n2', name: 'kookr-oc-net-t2', labels: { [LABEL_INSTANCE]: SELF, [LABEL_TASK]: 't2', [LABEL_LAUNCH]: 'tokentoken2' } },
    ];
    docker.containers = [container()];
    liveness.t1 = { state: 'live' };
    await intents.open('t2', 'tokentoken2', SELF);
    await make().reconcile();
    expect(docker.calls).toEqual([]); // t1 has a surviving container, t2 an open intent
    await intents.close('tokentoken2');
    await make().reconcile();
    expect(docker.calls).toEqual(['net-rm kookr-oc-net-t2']);
  });

  test('every change and failure is logged; a failing stop is counted, not thrown', async () => {
    docker.containers = [container()];
    docker.failOn = 'stop kookr-oc-aaaaaaaa-tok1';
    const rec = make();
    const r = await rec.reconcile();
    expect(r.errors).toBe(1);
    expect(rec.consecutiveFailures).toBe(1);
    const lines = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'quarantine_stop', result: 'error' });
    expect(existsSync(join(dir, 'q.json'))).toBe(false); // clock not started when the stop failed
  });
});
