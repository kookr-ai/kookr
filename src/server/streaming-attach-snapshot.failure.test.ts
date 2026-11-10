import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Failure paths that need the emulator itself to misbehave. The module caches
 * the loaded emulator, so each case imports a fresh copy against its own mock.
 */
async function loadWith(headless: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@xterm/headless', () => headless);
  return import('./streaming-attach-snapshot.js');
}

const bytes = new TextEncoder().encode('some terminal output\r\n'.repeat(50));

describe('snapshotStreamingAttachSeed when the emulator misbehaves', () => {
  afterEach(() => {
    vi.doUnmock('@xterm/headless');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('reports a load failure once and keeps answering without retrying the import', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { snapshotStreamingAttachSeed } = await loadWith({ notTheTerminal: true });
    expect(await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24 })).toMatchObject({ kind: 'unavailable', reason: 'load-failed' });
    expect(await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24 })).toMatchObject({ kind: 'unavailable', reason: 'load-failed' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('terminal emulator unavailable');
  });

  it('gives up on a replay whose parser never reports back, and frees the slot for the next attach', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispose = vi.fn();
    // xterm parses inside its own timer; an exception there means the write callback never fires.
    class StuckTerminal { loadAddon() {} write() {} dispose = dispose; }
    const { snapshotStreamingAttachSeed } = await loadWith({ Terminal: StuckTerminal });

    const result = await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24, maxMs: 5 });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'failed' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('replay stalled'));
    expect(dispose).toHaveBeenCalledTimes(1);

    // A wedged slot would answer `busy`; a freed one starts (and stalls) a new replay.
    const next = await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24, maxMs: 5, maxQueueWaitMs: 0 });
    expect(next).toMatchObject({ kind: 'unavailable', reason: 'failed' });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('turns an emulator exception into a soft failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    class ThrowingTerminal { constructor() { throw new Error('emulator blew up'); } }
    const { snapshotStreamingAttachSeed } = await loadWith({ Terminal: ThrowingTerminal });
    expect(await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24 })).toMatchObject({ kind: 'unavailable', reason: 'failed' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('replay failed'), expect.any(Error));
    // The slot was released on the exception path too.
    expect(await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24, maxQueueWaitMs: 0 })).toMatchObject({ reason: 'failed' });
  });
});
