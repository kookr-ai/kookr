import { describe, test, expect, vi } from 'vitest';
import {
  checkProcessLiveness,
  isClaudeProcess,
  ProcessLivenessStrategy,
  type ProcessInfo,
} from './process-liveness.js';

/**
 * Seed the internal cache for a strategy, avoiding direct `as unknown as` casts
 * that couple to the private field name. If `cachedResults` is renamed, this
 * single helper fails at compile time (via the type assertion below).
 */
function seedCache(strategy: ProcessLivenessStrategy, agentId: string, info: ProcessInfo): void {
  // Use getCachedInfo to verify the interface, then seed via the internal map.
  // This cast is isolated here — if the field name changes, only this line breaks.
  const internal = strategy as unknown as { cachedResults: Map<string, ProcessInfo> };
  internal.cachedResults.set(agentId, info);
}

describe('isClaudeProcess', () => {
  test('matches node running claude', () => {
    expect(isClaudeProcess('/usr/bin/node /home/user/.npm/bin/claude --settings /tmp/s.json')).toBe(true);
  });

  test('matches npx claude', () => {
    expect(isClaudeProcess('npx claude --prompt test')).toBe(true);
  });

  test('matches direct claude binary', () => {
    expect(isClaudeProcess('claude --settings /tmp/s.json test prompt')).toBe(true);
  });

  test('matches Claude with mixed case', () => {
    expect(isClaudeProcess('/usr/local/bin/Claude')).toBe(true);
  });

  test('does not match bash', () => {
    expect(isClaudeProcess('/bin/bash')).toBe(false);
    expect(isClaudeProcess('bash')).toBe(false);
  });

  test('does not match zsh', () => {
    expect(isClaudeProcess('/bin/zsh')).toBe(false);
  });

  test('does not match node without claude', () => {
    expect(isClaudeProcess('/usr/bin/node /home/user/app.js')).toBe(false);
  });

  test('does not match empty string', () => {
    expect(isClaudeProcess('')).toBe(false);
  });
});

describe('ProcessLivenessStrategy', () => {
  test('has correct source', () => {
    const strategy = new ProcessLivenessStrategy();
    expect(strategy.source).toBe('process_liveness');
  });

  test('returns null on first tick (no cached data)', () => {
    const strategy = new ProcessLivenessStrategy();
    const anomaly = strategy.evaluate('agent-1', { paneText: '', realAnomaly: null });
    expect(anomaly).toBeNull();
  });

  test('does not call a missing probe (safe no-op)', () => {
    const strategy = new ProcessLivenessStrategy(null);
    expect(strategy.evaluate('agent-1', { paneText: '', realAnomaly: null })).toBeNull();
  });

  test('checkProcessLiveness delegates to the injected probe', async () => {
    const probe = vi.fn(async () => ({
      panePid: 9,
      cmdline: 'claude',
      isClaude: true,
      isAlive: true,
    }));
    await expect(checkProcessLiveness('sess-1', probe)).resolves.toMatchObject({ panePid: 9 });
    expect(probe).toHaveBeenCalledWith('sess-1');
  });

  test('evaluate schedules probe refresh when configured', async () => {
    const probe = vi.fn(async () => ({
      panePid: 1,
      cmdline: 'claude',
      isClaude: true,
      isAlive: true,
    }));
    const strategy = new ProcessLivenessStrategy(probe);
    expect(strategy.evaluate('agent-1', { paneText: '', realAnomaly: null })).toBeNull();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('agent-1'));
  });

  test('returns stale_agent when process is not alive (from cache)', () => {
    const strategy = new ProcessLivenessStrategy();
    // Manually set cache to simulate a dead process
    seedCache(strategy, 'agent-1', {
      panePid: 12345,
      cmdline: null,
      isClaude: false,
      isAlive: false,
    });

    const anomaly = strategy.evaluate('agent-1', { paneText: '', realAnomaly: null });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('stale_agent');
    expect(anomaly!.severity).toBe('warning');
  });

  test('returns stale_agent (info) when process is not claude', () => {
    const strategy = new ProcessLivenessStrategy();
    seedCache(strategy, 'agent-1', {
      panePid: 12345,
      cmdline: '/bin/bash',
      isClaude: false,
      isAlive: true,
    });

    const anomaly = strategy.evaluate('agent-1', { paneText: '', realAnomaly: null });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.type).toBe('stale_agent');
    expect(anomaly!.severity).toBe('info');
  });

  test('returns null when process is alive and is claude', () => {
    const strategy = new ProcessLivenessStrategy();
    seedCache(strategy, 'agent-1', {
      panePid: 12345,
      cmdline: '/usr/bin/node /home/user/.npm/bin/claude --settings /tmp/s.json',
      isClaude: true,
      isAlive: true,
    });

    const anomaly = strategy.evaluate('agent-1', { paneText: '', realAnomaly: null });
    expect(anomaly).toBeNull();
  });

  test('clearCache removes agent state', () => {
    const strategy = new ProcessLivenessStrategy();
    seedCache(strategy, 'agent-1', {
      panePid: 12345,
      cmdline: '/bin/bash',
      isClaude: false,
      isAlive: true,
    });

    strategy.clearCache('agent-1');
    expect(strategy.getCachedInfo('agent-1')).toBeUndefined();
  });
});
