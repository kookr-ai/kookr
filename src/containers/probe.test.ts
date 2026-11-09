import { describe, expect, test } from 'vitest';
import { ContainerProber } from './probe.js';
import type { A2aClientPort } from './ports.js';

const fake = (script: Array<'ok' | 'fail'>): A2aClientPort => {
  let i = 0;
  return {
    async health() { if (script[i++] === 'fail') throw new Error('timeout'); return 'ok'; },
    async taskState() { return 'WORKING'; },
  };
};

describe('ContainerProber', () => {
  test('counts consecutive misses and a success resets them', async () => {
    const p = new ContainerProber(fake(['fail', 'fail', 'ok', 'fail']));
    const t = { endpoint: 'http://127.0.0.1:1', token: 'x' };
    expect((await p.probe('c', t)).consecutiveMisses).toBe(1);
    expect((await p.probe('c', t)).consecutiveMisses).toBe(2);
    const ok = await p.probe('c', t);
    expect(ok).toMatchObject({ ok: true, consecutiveMisses: 0, a2aState: 'WORKING' });
    expect((await p.probe('c', t)).consecutiveMisses).toBe(1);
  });
  test('misses are tracked per container and forget() clears them', async () => {
    const p = new ContainerProber(fake(['fail', 'fail', 'fail']));
    const t = { endpoint: 'e', token: 't' };
    await p.probe('a', t);
    expect((await p.probe('b', t)).consecutiveMisses).toBe(1);
    p.forget('a');
    expect((await p.probe('a', t)).consecutiveMisses).toBe(1);
  });
});
