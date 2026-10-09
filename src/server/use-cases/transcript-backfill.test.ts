import { describe, expect, it, vi } from 'vitest';
import { runTranscriptBackfill } from './transcript-backfill.js';

describe('runTranscriptBackfill', () => {
  const ledgers = ['s-ok', 's-done', 's-orphan', 's-nopointer', 's-ok2'];
  const owners: Record<string, string> = { 's-ok': 't1', 's-done': 't2', 's-nopointer': 't3', 's-ok2': 't4' };
  const mkDeps = (capture: ReturnType<typeof vi.fn>, extra = {}) => ({
    hooksDir: 'h', transcriptsDir: 't',
    listSessionLedgers: async () => ledgers,
    taskIdForSession: (s: string) => owners[s],
    resolvePointer: async (_d: string, s: string) => (s === 's-nopointer' ? {} : { transcriptPath: `/v/${s}` }),
    hasSnapshot: async (_d: string, _t: string, s: string) => s === 's-done',
    capture, ...extra,
  });

  it('captures attributable sessions and skips captured/unattributable/pointerless', async () => {
    const capture = vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
    const s = await runTranscriptBackfill(mkDeps(capture));
    expect(capture.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ taskId: 't1', sessionId: 's-ok', vendorTranscriptPath: '/v/s-ok' }),
      expect.objectContaining({ taskId: 't4', sessionId: 's-ok2' }),
    ]);
    expect(s).toEqual({ scanned: 5, captured: 2, skipped: 3, errors: 0 });
  });
  it('is bounded by maxTasks', async () => {
    const capture = vi.fn(async () => ({ outcome: 'captured' as const, messageCount: 1, bytes: 1 }));
    const s = await runTranscriptBackfill(mkDeps(capture, { maxTasks: 1 }));
    expect(s.captured).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('counts vendor_absent as skipped and thrown errors as errors', async () => {
    const outs = [{ outcome: 'vendor_absent' as const }, 'throw'] as const;
    let i = 0;
    const capture = vi.fn(async () => { const o = outs[i++]; if (o === 'throw') throw new Error('x'); return o; });
    const s = await runTranscriptBackfill(mkDeps(capture));
    expect(s).toMatchObject({ skipped: 4, errors: 1, captured: 0 });
  });
  it('returns zeros when ledger listing fails', async () => {
    const s = await runTranscriptBackfill(mkDeps(vi.fn(), { listSessionLedgers: async () => { throw new Error('ENOENT'); } }));
    expect(s).toEqual({ scanned: 0, captured: 0, skipped: 0, errors: 0 });
  });
});
