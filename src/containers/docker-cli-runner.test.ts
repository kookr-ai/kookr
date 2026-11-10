import { describe, expect, test } from 'vitest';
import { DockerCliRunner } from './docker-cli-runner.js';

describe('DockerCliRunner', () => {
  test('lists by label via ps + inspect and maps fields', async () => {
    const calls: string[][] = [];
    const r = new DockerCliRunner(async (args) => {
      calls.push(args);
      if (args[0] === 'ps') return 'abc\ndef\n';
      return JSON.stringify([
        { Id: 'abc', Name: '/kookr-oc-1', Created: '2026-01-01T00:00:00Z', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, RestartCount: 2, Config: { Labels: { 'kookr.task': 't' } } },
        { Id: 'def', Name: '/kookr-oc-2', Created: '2026-01-01T00:00:00Z', Config: { Labels: null } },
      ]);
    });
    const list = await r.listContainers({ key: 'kookr.instance', value: 'I' });
    expect(calls[0]).toEqual(['ps', '-a', '-q', '--no-trunc', '--filter', 'label=kookr.instance=I']);
    expect(list[0]).toMatchObject({ name: 'kookr-oc-1', state: 'running', restartCount: 2, oomKilled: false, labels: { 'kookr.task': 't' } });
    expect(list[1]).toMatchObject({ name: 'kookr-oc-2', state: 'unknown', labels: {} });
  });
  test('no ids => no inspect call', async () => {
    let n = 0;
    const r = new DockerCliRunner(async () => { n++; return ''; });
    expect(await r.listContainers({ key: 'k', value: 'v' })).toEqual([]);
    expect(n).toBe(1);
  });
  test('refuses names that could be option injection or shell syntax', async () => {
    const r = new DockerCliRunner(async () => '');
    for (const bad of ['--all', '-f', 'a b', 'a;rm', '', '$(x)']) {
      await expect(r.removeContainer(bad)).rejects.toThrow('unsafe docker object name');
      await expect(r.stopContainer(bad, 1)).rejects.toThrow('unsafe');
      await expect(r.removeNetwork(bad)).rejects.toThrow('unsafe');
    }
  });
  test('stop passes the grace period as a separate argv element', async () => {
    const calls: string[][] = [];
    await new DockerCliRunner(async (a) => { calls.push(a); return ''; }).stopContainer('kookr-oc-1', 10);
    expect(calls[0]).toEqual(['stop', '-t', '10', 'kookr-oc-1']);
  });
});

describe('DockerCliRunner container launch', () => {
  const spec = {
    name: 'kookr-oc-abcd1234-tok12345', image: 'opencode-worker-kookr:s1', labels: { 'kookr.task': 't', 'kookr.instance': 'I' },
    user: '1234:1234', memory: '2g', cpus: '2', pidsLimit: 512,
    mounts: [{ source: '/h/data', target: '/data', readOnly: false }, { source: '/h/secrets', target: '/run/secrets', readOnly: true }],
    tmpfs: ['/tmp:rw,size=128m'], publishPort: 8000, env: { HOME: '/home/worker' },
  };
  test('argv has the hardening flags, loopback-only publish, and no shell string', () => {
    const a = DockerCliRunner.runArgs(spec);
    for (const f of ['--read-only', '--init']) expect(a).toContain(f);
    expect(a.slice(a.indexOf('--cap-drop'), a.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    expect(a).toContain('no-new-privileges');
    expect(a).toContain('127.0.0.1::8000');
    expect(a).toContain('/h/secrets:/run/secrets:ro');
    expect(a).toContain('/h/data:/data:rw');
    expect(a).toContain('--user');
    expect(a[a.indexOf('--user') + 1]).toBe('1234:1234');
    expect(a.at(-1)).toBe('opencode-worker-kookr:s1');
    expect(a.join(' ')).not.toMatch(/--privileged|--network host|-v \/var\/run\/docker\.sock/);
  });
  test('refuses names outside the kookr-oc- prefix and unsafe images', () => {
    expect(() => DockerCliRunner.runArgs({ ...spec, name: 'other-1' })).toThrow('not a kookr-oc- container');
    expect(() => DockerCliRunner.runArgs({ ...spec, image: 'x --privileged' })).toThrow('unsafe image');
  });
  test('forceRemove / port / health use the prefix-checked name', async () => {
    const calls: string[][] = [];
    const r = new DockerCliRunner(async (a) => { calls.push(a); return a[0] === 'port' ? '127.0.0.1:51228\n[::1]:51228\n' : 'healthy\n'; });
    expect(await r.publishedPort('kookr-oc-a-b1', 8000)).toBe(51228);
    expect(await r.healthStatus('kookr-oc-a-b1')).toBe('healthy');
    await r.forceRemoveContainer('kookr-oc-a-b1');
    expect(calls.at(-1)).toEqual(['rm', '-f', 'kookr-oc-a-b1']);
    await expect(r.forceRemoveContainer('postgres')).rejects.toThrow('unsafe');
  });
});
