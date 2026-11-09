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
