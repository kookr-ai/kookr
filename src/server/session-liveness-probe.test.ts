import { describe, expect, test, vi } from 'vitest';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalSessionDiagnosticsSource } from '../adapters/terminal-session-diagnostics.js';
import { createSessionLivenessProbe } from './session-liveness-probe.js';

type DiagnosticsBackend = TerminalBackend & Partial<TerminalSessionDiagnosticsSource>;

function fakeBackend(overrides: Partial<DiagnosticsBackend> = {}): DiagnosticsBackend {
  return {
    isAlive: vi.fn(async () => false),
    getSessionDiagnostics: vi.fn(() => null),
    ...overrides,
  } as unknown as DiagnosticsBackend;
}

describe('createSessionLivenessProbe', () => {
  test('reports dead when backend isAlive is false', async () => {
    const backend = fakeBackend({ isAlive: vi.fn(async () => false) });
    const probe = createSessionLivenessProbe(backend);
    await expect(probe('kookr-abc')).resolves.toEqual({
      panePid: null,
      cmdline: null,
      isClaude: false,
      isAlive: false,
    });
  });

  test('reports live agent when backend is alive without diagnostics', async () => {
    const backend = fakeBackend({
      isAlive: vi.fn(async () => true),
      getSessionDiagnostics: vi.fn(() => null),
    });
    const probe = createSessionLivenessProbe(backend);
    await expect(probe('kookr-abc')).resolves.toEqual({
      panePid: null,
      cmdline: null,
      isClaude: true,
      isAlive: true,
    });
  });

  test('uses masterPid from diagnostics when agentPid is null', async () => {
    const backend = fakeBackend({
      isAlive: vi.fn(async () => true),
      getSessionDiagnostics: vi.fn(() => ({
        sessionId: 'kookr-abc',
        socketPresent: true,
        identityVerified: true,
        masterPid: process.pid,
        agentPid: null,
        attachChildAlive: true,
        attachGeneration: 1,
        reattachCount: 0,
        ringHead: 0,
        lastByteAt: null,
        lastAttachAt: null,
      })),
    });
    const probe = createSessionLivenessProbe(backend);
    const info = await probe('kookr-abc');
    expect(info.isAlive).toBe(true);
    expect(info.panePid).toBe(process.pid);
    // Current test process cmdline is unlikely to be claude — that's fine;
    // isClaude is derived from the real cmdline when a pid is available.
    expect(typeof info.isClaude).toBe('boolean');
  });
});
