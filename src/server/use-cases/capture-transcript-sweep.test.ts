import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../core/tasks.js';
import { runTranscriptCaptureSweep, runTranscriptRetentionSweep, selectCaptureSession } from './capture-transcript-sweep.js';

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

describe('runTranscriptCaptureSweep: opencode tasks (issue #3537)', () => {
  const base = { hooksDir: 'h', transcriptsDir: 't', now: () => NOW, opencodeDataRoot: '/ocdata' };
  const ok = () => vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
  function oc(id: string, ageMin: number, extra: Partial<Record<string, unknown>> = {}): Task {
    const t = new Date(NOW.getTime() - ageMin * 60_000);
    return {
      id, status: 'completed', createdAt: t, updatedAt: t,
      sessions: [{ tmuxSession: `s-${id}`, agentType: 'opencode', claudeSessionId: `ses_${id}`, createdAt: t, ...extra }],
    } as unknown as Task;
  }

  it('captures from the task DB under the route key (tmuxSession) with the opencode session id', async () => {
    const captureOpenCode = ok();
    const capture = vi.fn();
    const s = await runTranscriptCaptureSweep({
      ...base, tasks: [oc('a', 100)], config: { scope: 'all', maxTasksPerTick: 5 },
      capture, captureOpenCode, fileExists: () => true, hasSnapshot: async () => false,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(captureOpenCode).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'a', sessionId: 's-a', opencodeSessionId: 'ses_a', dbPath: '/ocdata/a/data/opencode/opencode.db',
    }));
    expect(s).toEqual({ candidates: 1, captured: 1, alreadyCaptured: 0, vendorAbsent: 0, errors: 0 });
  });

  it('skips a task whose DB is gone without spending a cap slot, and skips captured ones', async () => {
    const captureOpenCode = ok();
    const s = await runTranscriptCaptureSweep({
      ...base, tasks: [oc('gone', 300), oc('done', 200), oc('live', 100)], config: { scope: 'all', maxTasksPerTick: 1 },
      captureOpenCode, fileExists: (p) => !p.includes('/gone/'), hasSnapshot: async (_d, id) => id === 'done',
    });
    expect(captureOpenCode.mock.calls.map((c) => (c as unknown[])[0]).map((p) => (p as { taskId: string }).taskId)).toEqual(['live']);
    expect(s.candidates).toBe(1);
  });

  it('captures the opencode session when it is the newest, even if the task also ran claude-code', async () => {
    const old = new Date(NOW.getTime() - 300 * 60_000);
    const task = oc('mix', 100);
    task.sessions.unshift({ tmuxSession: 's-claude', agentType: 'claude-code', createdAt: old } as never);
    const captureOpenCode = ok();
    const capture = vi.fn();
    await runTranscriptCaptureSweep({
      ...base, tasks: [task], config: { scope: 'all', maxTasksPerTick: 5 },
      capture, captureOpenCode, fileExists: () => true, resolvePointer: ptr, hasSnapshot: async () => false,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(captureOpenCode).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-mix' }));
  });

  it('providers limits the tick to opencode; scope and grace still apply', async () => {
    const captureOpenCode = ok();
    const capture = ok();
    const common = { ...base, capture, captureOpenCode, fileExists: () => true, resolvePointer: ptr, hasSnapshot: async () => false };
    await runTranscriptCaptureSweep({
      ...common, tasks: [mk('cl', 'completed', 's-cl', 100), oc('o', 100), oc('fresh', 5)], providers: ['opencode'],
      config: { scope: 'all', maxTasksPerTick: 5, graceMs: 600_000 },
    });
    expect(capture).not.toHaveBeenCalled();
    expect(captureOpenCode.mock.calls.map((c) => (c as unknown[])[0]).map((p) => (p as { taskId: string }).taskId)).toEqual(['o']);
    await runTranscriptCaptureSweep({ ...common, tasks: [oc('o2', 100)], config: { scope: 'own-repos', maxTasksPerTick: 5 }, scopeAllows: () => false });
    await runTranscriptCaptureSweep({ ...common, tasks: [oc('o3', 100)], config: { scope: 'off', maxTasksPerTick: 5 } });
    expect(captureOpenCode).toHaveBeenCalledTimes(1);
  });
});

describe('selectCaptureSession', () => {
  it('prefers the newest session when it is opencode, else the newest claude-code session', () => {
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const t = (sessions: unknown[]) => ({ sessions } as unknown as Task);
    expect(selectCaptureSession(t([
      { tmuxSession: 'c1', agentType: 'claude-code', createdAt: at(10) },
      { tmuxSession: 'o1', agentType: 'opencode', createdAt: at(5) },
    ]))).toMatchObject({ provider: 'opencode', session: { tmuxSession: 'o1' } });
    expect(selectCaptureSession(t([
      { tmuxSession: 'o1', agentType: 'opencode', createdAt: at(10) },
      { tmuxSession: 'c1', agentType: 'claude-code', createdAt: at(8) },
      { tmuxSession: 'x1', agentType: 'codex-cli', createdAt: at(5) },
    ]))).toMatchObject({ provider: 'claude-code', session: { tmuxSession: 'c1' } });
    expect(selectCaptureSession(t([{ tmuxSession: 'x1', agentType: 'codex-cli', createdAt: at(5) }]))).toBeUndefined();
    expect(selectCaptureSession(t([]))).toBeUndefined();
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
