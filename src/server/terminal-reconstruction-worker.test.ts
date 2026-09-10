import { afterEach, describe, expect, it } from 'vitest';
import { TerminalReconstructionWorker } from './terminal-reconstruction-worker.js';

const workers: TerminalReconstructionWorker[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); });

describe('NFR-TERM-001: isolated terminal reconstruction', () => {
  it('walks real VT bytes in one worker and preserves source and completeness metadata', async () => {
    const worker = new TerminalReconstructionWorker(); workers.push(worker);
    const bytes = new TextEncoder().encode('\x1b[HHello terminal\x1b[2;1HSecond line');
    const source = { epoch: 'e', start: 0, end: bytes.length, geometryRevision: 1, cols: 80, rows: 24 };
    const result = await worker.reconstruct(bytes, { cols: 80, rows: 24, minPrintableCells: 1, source });
    expect(result).toMatchObject({ kind: 'display-only', completeness: 'complete', source, consumedBytes: bytes.length });
    expect(new TextDecoder().decode(result.bytes!)).toContain('Second line');
    expect(bytes.length).toBeGreaterThan(0); // The caller's capture was not detached.
    expect(worker.getStats().completed).toBe(1);
  });

  it('rejects oversized snapshots before retaining a worker job', async () => {
    const worker = new TerminalReconstructionWorker(); workers.push(worker);
    const result = await worker.reconstruct(new Uint8Array(1024 * 1024 + 1));
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'busy' });
    expect(worker.pendingBytes).toBe(0);
  });

  it('fences pending results on close and refuses work after disposal', async () => {
    const worker = new TerminalReconstructionWorker(); workers.push(worker);
    const pending = worker.reconstruct(new TextEncoder().encode('hello '.repeat(100)));
    await worker.close();
    expect(await pending).toMatchObject({ kind: 'unavailable' });
    expect(await worker.reconstruct(Uint8Array.of(65))).toMatchObject({ kind: 'unavailable' });
    expect(worker.pendingBytes).toBe(0);
  });
});
