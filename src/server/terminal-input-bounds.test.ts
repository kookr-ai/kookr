import { describe, expect, it, vi } from 'vitest';
import { TerminalInputCoordinator } from './terminal-input-coordinator.js';

describe('NFR-TERM-001: bounded input and retired-session fencing', () => {
  function setup() {
    let release!: () => void;
    const backend = { write: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
      writeSequence: vi.fn(async () => {}), isAlive: async () => true };
    const coordinator = new TerminalInputCoordinator(backend);
    return { backend, coordinator, release: () => release() };
  }
  it('rejects oversized and excessive queued input without retaining it', async () => {
    const h = setup();
    await expect(h.coordinator.writeInput('s', new Uint8Array(9 * 1024 * 1024))).rejects.toThrow(/capacity/);
    const requests = Array.from({ length: 256 }, () => h.coordinator.writeInput('s', Uint8Array.of(65)));
    const settled = Promise.allSettled(requests);
    await expect(h.coordinator.writeInput('s', Uint8Array.of(66))).rejects.toThrow(/capacity/);
    h.coordinator.cleanupSession('s'); h.release();
    await settled;
    expect(h.backend.write).toHaveBeenCalledOnce();
  });
  it('owns queued bytes and does not deliver old queued input to a replacement session', async () => {
    const h = setup(); const bytes = Uint8Array.of(65);
    const first = h.coordinator.writeInput('s', bytes); bytes[0] = 90;
    const second = h.coordinator.writeInput('s', Uint8Array.of(66));
    const rejected = expect(second).rejects.toThrow(/retired/);
    await Promise.resolve();
    expect(h.backend.write).toHaveBeenCalledWith('s', Uint8Array.of(65));
    h.coordinator.cleanupSession('s'); h.coordinator.registerSession('s'); h.release();
    await first; await rejected;
    expect(h.backend.write).toHaveBeenCalledOnce();
  });
  it('does not send the Enter half of a paced paste after ownership is retired', async () => {
    let release!: () => void;
    const backend = { write: vi.fn(async () => {}), writeSequence: vi.fn(async () => {}), isAlive: async () => true };
    const input = new TerminalInputCoordinator(backend, () => new Promise<void>((resolve) => { release = resolve; }));
    const result = input.writeInputSequence('s', [Uint8Array.of(65), Uint8Array.of(13)], { interPayloadDelayMs: 30 });
    const rejected = expect(result).rejects.toThrow(/retired/);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    input.cleanupSession('s'); release(); await rejected;
    expect(backend.write).toHaveBeenCalledOnce();
  });

  it('disposal fences every queued session and refuses new input', async () => {
    const h = setup(); const first = h.coordinator.writeInput('s', Uint8Array.of(65));
    const queued = h.coordinator.writeInput('s', Uint8Array.of(66));
    const rejected = expect(queued).rejects.toThrow(/retired/);
    await Promise.resolve(); h.coordinator.dispose(); h.release();
    await first; await rejected;
    await expect(h.coordinator.writeInput('s', Uint8Array.of(67))).rejects.toThrow(/retired/);
    expect(h.backend.write).toHaveBeenCalledOnce();
  });
});
