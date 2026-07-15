import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import type { GrokInstalledState } from '../../adapters/grok-build-preflight.js';
import { TaskStore } from '../../core/tasks.js';
import { createAgentRuntime, type AgentRuntimeDeps } from './create-agent-runtime.js';

/**
 * Registration policy for the GA Grok Build adapter: registered exactly when
 * its binary preflight passes. Registration is what feeds the frontend picker
 * and the round-robin rotation, so an absent binary must keep grok-build out
 * of both (a registered-but-absent grok would wedge the rotation on a
 * guaranteed-failing slot) — without crashing startup. An explicitly
 * configured KOOKR_GROK_BIN that is unreachable stays fail-loud, matching
 * runAdapterPreflights' env-misconfig policy.
 */

function grokTestedState(): GrokInstalledState {
  return {
    kind: 'ok',
    version: '0.2.101',
    buildId: '5bc4b5dfad',
    identity: {
      configured: 'grok',
      launcherPath: '/fake/.grok/bin/grok',
      canonicalPath: '/fake/.grok/bin/grok-0.2.101',
      sha256: '2556299cded37f81e54c02420cfa7f1a2df9feab72a445869a0f5596e143b333',
      sizeBytes: 161789992,
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    },
    qualification: {
      status: 'tested',
      reason: 'matches tested build',
      evidenceBuildId: '0.2.101 (5bc4b5dfad)',
    },
  };
}

describe('createAgentRuntime — grok-build registration policy', () => {
  let settingsDir: string;
  let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'agent-runtime-test-'));
    logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });
  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<AgentRuntimeDeps> = {}): AgentRuntimeDeps {
    return {
      terminalBackend: new FakeTerminalBackend(),
      taskStore: new TaskStore(),
      hooksDir: settingsDir,
      settingsDir,
      serverPort: 0,
      // Fast, always-present stand-ins so the claude/codex preflight probes
      // never spawn a real agent binary (or time out) inside a unit test.
      agentBin: '/bin/echo',
      codexBin: '/bin/echo',
      preflightLogger: logger,
      preflightOnFatal: ((): never => {
        throw new Error('fatal preflight');
      }) as AgentRuntimeDeps['preflightOnFatal'],
      ...overrides,
    };
  }

  test('registers grok-build when the binary preflight passes', async () => {
    const runtime = await createAgentRuntime(
      baseDeps({ grokEnv: {} as NodeJS.ProcessEnv, grokInstalledState: grokTestedState() }),
    );
    expect(runtime.adapterRegistry.getTypes()).toContain('grok-build');
    expect(runtime.agentPreflight['grok-build']?.status).toBe('ok');
  });

  test('skips registration with a warning when the default grok binary is absent', async () => {
    const enoent = async () => {
      const e = new Error('spawn grok ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const runtime = await createAgentRuntime(
      baseDeps({ grokEnv: {} as NodeJS.ProcessEnv, grokProbeExec: enoent }),
    );
    expect(runtime.adapterRegistry.getTypes()).not.toContain('grok-build');
    expect(runtime.agentPreflight['grok-build']).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('grok-build is not registered'));
    // The adapter object still exists for diagnostics even when unregistered.
    expect(runtime.grokBuildAdapter).toBeDefined();
  });

  test('is fatal when KOOKR_GROK_BIN is explicitly configured but unreachable', async () => {
    const enoent = async () => {
      const e = new Error('spawn /missing/grok ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    await expect(
      createAgentRuntime(
        baseDeps({
          grokEnv: { KOOKR_GROK_BIN: '/missing/grok' } as NodeJS.ProcessEnv,
          grokProbeExec: enoent,
        }),
      ),
    ).rejects.toThrow('fatal preflight');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('grok-build binary unreachable'));
  });
});
