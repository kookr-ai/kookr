import { describe, expect, it, vi } from 'vitest';
import { waitForTerminalAttachExit } from './terminal-host-owner.js';

describe('NFR-TERM-001: positive attach-owner retirement', () => {
  it('waits for old attach clients to exit without signaling another session', async () => {
    const list = vi.fn().mockReturnValueOnce([{ pid: 10, command: 'dtach -a /tmp/instance/s.sock -E' }])
      .mockReturnValue([{ pid: 20, command: 'dtach -a /tmp/other/s.sock -E' }]);
    const sleep = vi.fn(async () => {});
    expect(await waitForTerminalAttachExit('/tmp/instance', { list, sleep, attempts: 2 })).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
  });
  it('blocks replacement when any previous attach owner is unverified', async () => {
    const list = () => [{ pid: 10, command: 'dtach -a /tmp/instance/s.sock -E' }];
    expect(await waitForTerminalAttachExit('/tmp/instance', { list, sleep: async () => {}, attempts: 2 })).toBe(false);
  });
});
