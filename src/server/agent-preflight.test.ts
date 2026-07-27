import { describe, test, expect } from 'vitest';
import { AdapterRegistry, type AgentAdapter, type PreflightResult } from '../adapters/agent-adapter.js';
import { runAdapterPreflights, type AgentPreflightSnapshot, type PreflightLogger } from './agent-preflight.js';

function stubAdapter(agentType: 'claude-code' | 'codex-cli', preflight: () => Promise<PreflightResult>): AgentAdapter {
  return {
    agentType,
    launch: async () => 't',
    sendInput: async () => {},
    sendKeystroke: async () => {},
    stop: async () => {},
    captureDisplay: async () => '',
    onEvent: () => {},
    onRefreshNeeded: () => {},
    injectHookEvent: () => {},
    getEffectiveHookSettings: () => undefined,
    preflight,
  };
}

function adapterWithoutPreflight(agentType: 'claude-code' | 'codex-cli'): AgentAdapter {
  return {
    agentType,
    launch: async () => 't',
    sendInput: async () => {},
    sendKeystroke: async () => {},
    stop: async () => {},
    captureDisplay: async () => '',
    onEvent: () => {},
    onRefreshNeeded: () => {},
    injectHookEvent: () => {},
    getEffectiveHookSettings: () => undefined,
  };
}

function recordingLogger(): { logger: PreflightLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (msg) => lines.push(`LOG ${msg}`),
      warn: (msg) => lines.push(`WARN ${msg}`),
      error: (msg) => lines.push(`ERR ${msg}`),
    },
  };
}

class FatalReached extends Error {
  constructor(public snapshot: AgentPreflightSnapshot & { status: 'absent' }) {
    super('fatal-reached');
  }
}

const onFatal = (snapshot: AgentPreflightSnapshot & { status: 'absent' }): never => {
  throw new FatalReached(snapshot);
};

describe('runAdapterPreflights', () => {
  test('logs an info line and returns ok snapshot when adapter probe succeeds', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('claude-code', async () => ({ kind: 'ok', resolvedPath: '/usr/bin/claude', version: '1.0.86' })));
    const { logger, lines } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(result['claude-code']).toEqual({
      agentType: 'claude-code',
      status: 'ok',
      resolvedPath: '/usr/bin/claude',
      version: '1.0.86',
    });
    expect(lines).toEqual([
      'LOG [startup] adapter=claude-code binary=/usr/bin/claude version=1.0.86',
    ]);
  });

  test('surfaces the probe path in the ok snapshot and startup log line', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('claude-code', async () => ({
      kind: 'ok',
      resolvedPath: '/usr/bin/claude',
      version: 'unknown',
      probePath: '--help',
    })));
    const { logger, lines } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(result['claude-code']).toMatchObject({ status: 'ok', version: 'unknown', probePath: '--help' });
    expect(lines).toEqual([
      'LOG [startup] adapter=claude-code binary=/usr/bin/claude version=unknown probe=--help',
    ]);
  });

  test('warns and continues when default-PATH binary is absent', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('codex-cli', async () => ({
      kind: 'absent',
      reason: 'binary "codex" not found on PATH',
      configuredVia: 'default',
      envVarName: 'KOOKR_CODEX_BIN',
    })));
    const { logger, lines } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(result['codex-cli']).toMatchObject({ status: 'absent', configuredVia: 'default' });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).toContain('codex-cli binary not found on PATH');
  });

  test('invokes onFatal and stops processing when env-configured binary is absent', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('claude-code', async () => ({
      kind: 'absent',
      reason: 'binary "/nonexistent" not found on PATH',
      configuredVia: 'env',
      envVarName: 'KOOKR_AGENT_BIN',
    })));
    const { logger, lines } = recordingLogger();

    await expect(runAdapterPreflights(registry, { onFatal, logger })).rejects.toBeInstanceOf(FatalReached);
    const errLine = lines.find((l) => l.startsWith('ERR'));
    expect(errLine).toBeDefined();
    expect(errLine!).toContain('claude-code binary unreachable');
    expect(errLine!).toContain('Set KOOKR_AGENT_BIN=<path>');
  });

  test('skips adapters that do not implement preflight', async () => {
    const registry = new AdapterRegistry();
    registry.register(adapterWithoutPreflight('claude-code'));
    registry.register(stubAdapter('codex-cli', async () => ({ kind: 'ok', resolvedPath: 'codex', version: '0.5.0' })));
    const { logger, lines } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(Object.keys(result)).toEqual(['codex-cli']);
    expect(lines).toEqual([
      'LOG [startup] adapter=codex-cli binary=codex version=0.5.0',
    ]);
  });

  test('catches throws from preflight() and treats them as default-absent', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('codex-cli', async () => {
      throw new Error('boom');
    }));
    const { logger, lines } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(result['codex-cli']).toMatchObject({
      status: 'absent',
      configuredVia: 'default',
    });
    expect(result['codex-cli']).toHaveProperty('reason');
    if (result['codex-cli']!.status === 'absent') {
      expect(result['codex-cli']!.reason).toContain('preflight() threw: boom');
    }
    expect(lines[0]).toContain('WARN');
  });

  test('runs preflights for all registered adapters when env-configured fatal does not fire', async () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter('claude-code', async () => ({ kind: 'ok', resolvedPath: 'claude', version: '1.0.0' })));
    registry.register(stubAdapter('codex-cli', async () => ({
      kind: 'absent', reason: 'not on PATH', configuredVia: 'default', envVarName: 'KOOKR_CODEX_BIN',
    })));
    const { logger } = recordingLogger();

    const result = await runAdapterPreflights(registry, { onFatal, logger });

    expect(Object.keys(result).sort()).toEqual(['claude-code', 'codex-cli']);
  });
});
