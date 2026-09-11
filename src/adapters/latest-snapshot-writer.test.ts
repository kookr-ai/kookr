import { describe, expect, it, vi } from 'vitest';
import { createLatestSnapshotWriter } from './latest-snapshot-writer.js';

function harness(maxBytes = 16) {
  const gates: Array<() => void> = [];
  const commits: string[] = [];
  const commit = vi.fn(async (id: string, bytes: Uint8Array) => {
    commits.push(`${id}:${new TextDecoder().decode(bytes)}`);
    await new Promise<void>((resolve) => gates.push(resolve));
  });
  const writer = createLatestSnapshotWriter({ commit, maxBytes, onError: vi.fn() });
  const enqueue = (id: string, value: string) => writer.enqueue(id, new TextEncoder().encode(value));
  const finish = async () => { gates.shift()?.(); await Promise.resolve(); await Promise.resolve(); };
  return { writer, enqueue, commits, commit, finish, gates };
}

describe('NFR-TERM-001: bounded asynchronous ring persistence', () => {
  it('retains only the latest pending snapshot and never overlaps writes for a session', async () => {
    const h = harness();
    h.enqueue('s', 'old'); h.enqueue('s', 'middle'); h.enqueue('s', 'new');
    expect(h.commits).toEqual(['s:old']);
    expect(h.writer.stats()).toMatchObject({ pendingBytes: 6, sessions: 1 });
    await h.finish();
    expect(h.commits).toEqual(['s:old', 's:new']);
    await h.finish(); await h.writer.drain();
    expect(h.writer.stats().pendingBytes).toBe(0);
  });
  it('bounds fleet bytes and allows another session to commit independently', async () => {
    const h = harness(8);
    expect(h.enqueue('a', '1234')).toBe(true);
    expect(h.enqueue('b', '5678')).toBe(true);
    expect(h.enqueue('c', 'x')).toBe(false);
    expect(h.commits).toEqual(['a:1234', 'b:5678']);
    await h.finish(); await h.finish(); await h.writer.drain();
    expect(h.writer.stats()).toMatchObject({ pendingBytes: 0, rejected: 1 });
  });
  it('blocks new snapshots while retiring a session and waits for its active write', async () => {
    const h = harness(); h.enqueue('s', 'old'); h.enqueue('s', 'never');
    const retired = vi.fn();
    const drain = h.writer.retire('s').then(retired);
    expect(h.enqueue('s', 'new')).toBe(false);
    expect(retired).not.toHaveBeenCalled();
    await h.finish(); await drain;
    expect(h.commits).toEqual(['s:old']);
    h.writer.release('s');
    expect(h.enqueue('s', 'new')).toBe(true);
    await h.finish(); await h.writer.drain();
  });
  it('contains disk failures and releases retained bytes', async () => {
    const onError = vi.fn();
    const writer = createLatestSnapshotWriter({ commit: async () => { throw new Error('disk full'); }, onError });
    writer.enqueue('s', new Uint8Array(8));
    await writer.drain();
    expect(onError).toHaveBeenCalledOnce();
    expect(writer.stats().pendingBytes).toBe(0);
  });
});
