import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
  UMBRELLA_CHAIN_CLAIMS_FILE,
  UmbrellaChainClaimStore,
} from './umbrella-chain-claim-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function makeStore(now: { value: Date }) {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-chain-claim-'));
  tempDirs.push(dir);
  return new UmbrellaChainClaimStore(dir, { staleClaimMs: 1_000, now: () => now.value });
}

async function makeSharedStores(now: { value: Date }) {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-chain-claim-shared-'));
  tempDirs.push(dir);
  return [
    new UmbrellaChainClaimStore(dir, { staleClaimMs: 1_000, now: () => now.value }),
    new UmbrellaChainClaimStore(dir, { staleClaimMs: 1_000, now: () => now.value }),
  ] as const;
}

describe('UmbrellaChainClaimStore', () => {
  test('claims atomically before launch and persists the finalized task id', async () => {
    const now = { value: new Date('2026-08-23T10:00:00.000Z') };
    const store = await makeStore(now);
    const first = await store.claim('chain:2711:phase:P2');
    expect(first.kind).toBe('claimed');
    const second = await store.claim('chain:2711:phase:P2');
    expect(second.kind).toBe('busy');

    if (first.kind !== 'claimed') throw new Error('expected first claim to be acquired');
    await store.finalize('chain:2711:phase:P2', 'task-2', first.claim.ownerToken);
    expect(await store.get('chain:2711:phase:P2')).toMatchObject({ taskId: 'task-2' });
    const persisted = JSON.parse(await readFile(join(tempDirs[0]!, UMBRELLA_CHAIN_CLAIMS_FILE), 'utf8')) as {
      claims: Record<string, { taskId?: string }>;
    };
    expect(persisted.claims['chain:2711:phase:P2']?.taskId).toBe('task-2');
  });

  test('reclaims an expired claim and release removes it', async () => {
    const now = { value: new Date('2026-08-23T10:00:00.000Z') };
    const store = await makeStore(now);
    await store.claim('chain:2711:phase:P2');
    now.value = new Date('2026-08-23T10:00:02.000Z');
    const reclaimed = await store.claim('chain:2711:phase:P2');
    expect(reclaimed.kind).toBe('claimed');
    if (reclaimed.kind !== 'claimed') throw new Error('expected stale claim to be reclaimed');
    await store.release('chain:2711:phase:P2', reclaimed.claim.ownerToken);
    expect(await store.get('chain:2711:phase:P2')).toBeUndefined();
  });

  test('stale owners cannot finalize or release a replacement claim', async () => {
    const now = { value: new Date('2026-08-23T10:00:00.000Z') };
    const store = await makeStore(now);
    const first = await store.claim('chain:2711:phase:P2');
    if (first.kind !== 'claimed') throw new Error('expected first claim to be acquired');
    now.value = new Date('2026-08-23T10:00:02.000Z');
    const replacement = await store.claim('chain:2711:phase:P2');
    if (replacement.kind !== 'claimed') throw new Error('expected replacement claim to be acquired');

    await expect(store.finalize('chain:2711:phase:P2', 'old-task', first.claim.ownerToken)).rejects.toThrow('ownership lost');
    await expect(store.release('chain:2711:phase:P2', first.claim.ownerToken)).rejects.toThrow('ownership lost');
    await store.finalize('chain:2711:phase:P2', 'new-task', replacement.claim.ownerToken);
    expect(await store.get('chain:2711:phase:P2')).toMatchObject({ taskId: 'new-task' });
  });

  test('allows exactly one winner across two store instances', async () => {
    const now = { value: new Date('2026-08-23T10:00:00.000Z') };
    const [firstStore, secondStore] = await makeSharedStores(now);
    const results = await Promise.all([
      firstStore.claim('chain:2711:phase:P2'),
      secondStore.claim('chain:2711:phase:P2'),
    ]);
    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'busy')).toHaveLength(1);
  });
});
