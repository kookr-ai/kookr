import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeDocker } from '../containers/fake-docker.js';
import { LABEL_INSTANCE, LABEL_LAUNCH, LABEL_TASK } from '../containers/ports.js';
import { parseContainersArgs, runContainersCli } from './kookr-containers.js';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('kookr containers', () => {
  let dir: string;
  let docker: FakeDocker;
  let lines: string[];
  let errs: string[];
  const run = (argv: string[]) => runContainersCli([...argv, '--dir', dir], {
    env: { KOOKR_TASK_STORE: 'json' } as NodeJS.ProcessEnv,
    out: { log: (m: string) => lines.push(String(m)) }, err: { error: (m: string) => errs.push(String(m)) },
    docker, now: () => new Date('2026-01-10T00:00:00Z'),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cli-')); docker = new FakeDocker(); lines = []; errs = [];
    writeFileSync(join(dir, 'instance-id'), `${SELF}\n`);
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'live1', status: 'inProgress' }] }));
    const mk = (name: string, task: string, instance = SELF) => ({
      id: name, name, state: 'running', createdAt: new Date('2026-01-01T00:00:00Z'),
      labels: { [LABEL_INSTANCE]: instance, [LABEL_TASK]: task, [LABEL_LAUNCH]: 'tok-12345678' },
    });
    docker.containers = [mk('kookr-oc-live1-a', 'live1'), mk('kookr-oc-gone-b', 'gone'), mk('kookr-oc-theirs-c', 'x', OTHER)];
    docker.networks = [{ id: 'n', name: 'kookr-oc-net-gone', labels: { [LABEL_INSTANCE]: SELF, [LABEL_TASK]: 'gone' } }];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('arg parsing: prune without --instance is a usage error', () => {
    expect(parseContainersArgs(['prune']).error).toContain('--instance');
    expect(parseContainersArgs([]).error).toContain('missing subcommand');
    expect(parseContainersArgs(['ls', '--bogus']).error).toContain('unexpected');
  });

  test('ls shows this instance only, with the reconciler decision and orphan flag; it changes nothing', async () => {
    expect(await run(['ls'])).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('kookr-oc-live1-a');
    expect(text).toMatch(/kookr-oc-live1-a\tlive1\trunning\t\d+d\tadopt\tno/);
    expect(text).toMatch(/kookr-oc-gone-b\tgone\trunning\t\d+d\tquarantine_stop\tyes/);
    expect(text).not.toContain('theirs');
    expect(docker.calls).toEqual([]);
  });

  test('ls --json is parseable', async () => {
    await run(['ls', '--json']);
    const j = JSON.parse(lines[0]!);
    expect(j.instanceId).toBe(SELF);
    expect(j.containers.map((c: { name: string }) => c.name).sort()).toEqual(['kookr-oc-gone-b', 'kookr-oc-live1-a']);
  });

  test('prune is a dry run without --yes', async () => {
    expect(await run(['prune', '--instance'])).toBe(0);
    expect(lines.join('\n')).toContain('Dry run');
    expect(docker.calls).toEqual([]);
  });

  test('prune --instance --yes removes this instance\'s containers and networks, and only those', async () => {
    expect(await run(['prune', '--instance', '--yes'])).toBe(0);
    expect(docker.calls).toContain('rm kookr-oc-live1-a');
    expect(docker.calls).toContain('rm kookr-oc-gone-b');
    expect(docker.calls).toContain('net-rm kookr-oc-net-gone');
    expect(docker.containers.map((c) => c.name)).toEqual(['kookr-oc-theirs-c']);
  });

  test('no instance id means nothing was ever launched and docker is not consulted', async () => {
    rmSync(join(dir, 'instance-id'));
    expect(await run(['ls'])).toBe(0);
    expect(lines.join('\n')).toContain('has not launched');
  });

  test('an unreadable task store makes ls report hold, never quarantine', async () => {
    writeFileSync(join(dir, 'tasks.json'), '{broken');
    await run(['ls']);
    expect(lines.join('\n')).toContain('hold');
    expect(lines.join('\n')).not.toContain('quarantine');
  });
});
