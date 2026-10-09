import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../core/tasks.js';
import { runTranscriptCaptureSweep, runTranscriptRetentionSweep } from './capture-transcript-sweep.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function mk(id: string, status: string, tmux: string, ageMin: number, agentType = 'claude-code'): Task {
  const t = new Date(NOW.getTime() - ageMin * 60_000);
  return {
    id, status, createdAt: t, updatedAt: t,
    sessions: [{ tmuxSession: tmux, agentType, createdAt: t }],
  } as unknown as Task;
}

const ptr = async (_d: string, tmux: string) => ({ transcriptPath: `/v/${tmux}.jsonl` });

describe('runTranscriptCaptureSweep', () => {
  const base = { hooksDir: 'h', transcriptsDir: 't', now: () => NOW };
  it('selects only terminal claude-code tasks with pointer and no snapshot', async () => {
    const capture = vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
    const tasks = [
      mk('a', 'completed', 's-a', 100), mk('b', 'inProgress', 's-b', 100),
      mk('c', 'completed', 's-c', 100, 'codex-cli'), mk('d', 'completed', 's-d', 100), mk('e', 'completed', 's-e', 100),
    ];
    const s = await runTranscriptCaptureSweep({
      ...base, tasks, config: { scope: 'all', maxTasksPerTick: 10 }, capture,
      resolvePointer: async (_d, t) => (t === 's-d' ? {} : { transcriptPath: `/v/${t}` }),
      hasSnapshot: async (_d, id) => id === 'e',
    });
    expect(capture.mock.calls.map((c) => (c as unknown[])[0]).map((p) => (p as { taskId: string }).taskId)).toEqual(['a']);
    expect(s).toEqual({ candidates: 1, captured: 1, alreadyCaptured: 0, vendorAbsent: 0, errors: 0 });
  });
  it('respects maxTasksPerTick, oldest first', async () => {
    const capture = vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
    const tasks = [mk('new', 'completed', 's1', 30), mk('old', 'completed', 's2', 300), mk('mid', 'completed', 's3', 100)];
    const s = await runTranscriptCaptureSweep({
      ...base, tasks, config: { scope: 'all', maxTasksPerTick: 2 }, capture, resolvePointer: ptr, hasSnapshot: async () => false,
    });
    expect(s.candidates).toBe(2);
    expect(capture.mock.calls.map((c) => (c as unknown[])[0]).map((p) => (p as { taskId: string }).taskId)).toEqual(['old', 'mid']);
  });
  it('captures nothing when scope off or scopeAllows is false', async () => {
    const capture = vi.fn();
    const tasks = [mk('a', 'completed', 's', 100)];
    const common = { ...base, tasks, capture, resolvePointer: ptr, hasSnapshot: async () => false };
    await runTranscriptCaptureSweep({ ...common, config: { scope: 'off', maxTasksPerTick: 5 } });
    await runTranscriptCaptureSweep({ ...common, config: { scope: 'own-repos', maxTasksPerTick: 5 }, scopeAllows: () => false });
    expect(capture).not.toHaveBeenCalled();
  });
  it('honours the grace period', async () => {
    const capture = vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
    const s = await runTranscriptCaptureSweep({
      ...base, tasks: [mk('a', 'completed', 's', 5)], config: { scope: 'all', maxTasksPerTick: 5, graceMs: 600_000 },
      capture, resolvePointer: ptr, hasSnapshot: async () => false,
    });
    expect(s.candidates).toBe(0);
  });
  it('counts outcomes and swallows errors', async () => {
    const outcomes = [
      { outcome: 'captured', messageCount: 1, bytes: 1 }, { outcome: 'already_captured' },
      { outcome: 'vendor_absent' }, 'throw', { outcome: 'invalid_id' },
    ] as const;
    let i = 0;
    const capture = vi.fn(async () => {
      const o = outcomes[i++];
      if (o === 'throw') throw new Error('boom');
      return o;
    });
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id, n) => mk(id, 'completed', `s-${id}`, 100 + n));
    const s = await runTranscriptCaptureSweep({
      ...base, tasks, config: { scope: 'all', maxTasksPerTick: 10 }, capture, resolvePointer: ptr, hasSnapshot: async () => false,
    });
    expect(s).toEqual({ candidates: 5, captured: 1, alreadyCaptured: 1, vendorAbsent: 1, errors: 2 });
  });
});

describe('runTranscriptRetentionSweep', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ret-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function snap(taskId: string, capturedAt: Date) {
    await mkdir(join(dir, taskId), { recursive: true });
    await writeFile(join(dir, taskId, 's.meta.json'), JSON.stringify({
      schemaVersion: 1, complete: true, consumedVendorOffsetBytes: 0, vendor: null,
      capturedAt: capturedAt.toISOString(), messageCount: 0, source: 'vendor',
    }));
  }
  it('removes only expired dirs', async () => {
    await snap('oldtask', new Date(NOW.getTime() - 40 * 86_400_000));
    await snap('newtask', new Date(NOW.getTime() - 1 * 86_400_000));
    const n = await runTranscriptRetentionSweep(dir, 30, () => NOW);
    expect(n).toBe(1);
    expect(await readdir(dir)).toEqual(['newtask']);
  });
  it('returns 0 for a missing dir', async () => {
    expect(await runTranscriptRetentionSweep(join(dir, 'nope'), 30, () => NOW)).toBe(0);
  });
});
