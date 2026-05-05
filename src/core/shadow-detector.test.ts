import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ShadowDetectorRegistry,
  type ShadowStrategy,
  type ShadowInputs,
  type ShadowLogEntry,
  type ShadowHeartbeat,
  type ShadowTransition,
} from './shadow-detector.js';
import type { Anomaly } from './types.js';

function makeAnomaly(
  agentId: string,
  type: 'needs_input' | 'permission_blocked' | 'stale_agent' = 'needs_input',
  confidence?: 'high' | 'medium' | 'low',
): Anomaly {
  return {
    agentId,
    type,
    severity: type === 'needs_input' ? 'info' : 'warning',
    explanation: `Test ${type}`,
    detectedAt: new Date('2026-03-28T10:00:00Z'),
    ...(confidence ? { confidence } : {}),
  };
}

/** A simple test strategy that returns whatever anomaly is configured. */
class TestStrategy implements ShadowStrategy {
  source: 'pane_semantics' | 'process_liveness' | 'http_push' | 'combined';
  private result: Anomaly | null = null;

  constructor(source: 'pane_semantics' | 'process_liveness' | 'http_push' | 'combined' = 'pane_semantics') {
    this.source = source;
  }

  setResult(anomaly: Anomaly | null): void {
    this.result = anomaly;
  }

  evaluate(_agentId: string, _inputs: ShadowInputs): Anomaly | null {
    return this.result;
  }
}

describe('ShadowDetectorRegistry', () => {
  let registry: ShadowDetectorRegistry;
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'shadow-test-'));
    logPath = join(tmpDir, 'shadow-detection.jsonl');
    registry = new ShadowDetectorRegistry(logPath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('registers and lists strategies', () => {
    const strategy = new TestStrategy('pane_semantics');
    registry.register(strategy);
    expect(registry.getStrategies()).toHaveLength(1);
    expect(registry.getStrategies()[0].source).toBe('pane_semantics');
  });

  test('returns log file path', () => {
    expect(registry.getLogFilePath()).toBe(logPath);
  });

  describe('evaluate — heartbeats', () => {
    test('logs heartbeat on every tick', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      const now = new Date('2026-03-28T12:00:00Z');
      const entries = registry.evaluate('agent-1', { paneText: 'test', realAnomaly: null }, now);

      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0].agentId).toBe('agent-1');
      expect(heartbeats[0].source).toBe('pane_semantics');
      expect(heartbeats[0].shadowState).toBeNull();
      expect(heartbeats[0].realState).toBeNull();
      expect(heartbeats[0].timestamp).toBe('2026-03-28T12:00:00.000Z');
    });

    test('heartbeat reflects real anomaly state', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      const realAnomaly = makeAnomaly('agent-1', 'needs_input');
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly });

      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats[0].realState).toBe('needs_input');
    });

    test('heartbeat reflects shadow anomaly state', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'permission_blocked'));
      registry.register(strategy);

      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats[0].shadowState).toBe('permission_blocked');
    });
  });

  describe('evaluate — transitions', () => {
    test('logs entered_anomaly transition when shadow detects new anomaly', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      // First tick: healthy
      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      // Second tick: anomaly detected
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      expect(transitions).toHaveLength(1);
      expect(transitions[0].transition).toBe('entered_anomaly');
      expect(transitions[0].anomalyType).toBe('needs_input');
      expect(transitions[0].realState.anomaly).toBeNull();
    });

    test('logs cleared_anomaly transition when shadow anomaly clears', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.register(strategy);

      // First tick: anomaly
      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      // Second tick: cleared
      strategy.setResult(null);
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      expect(transitions).toHaveLength(1);
      expect(transitions[0].transition).toBe('cleared_anomaly');
      expect(transitions[0].anomalyType).toBe('needs_input');
    });

    test('logs both entered and cleared when anomaly type changes', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      // Change to different anomaly type
      strategy.setResult(makeAnomaly('agent-1', 'permission_blocked'));
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      expect(transitions).toHaveLength(2);
      expect(transitions[0].transition).toBe('entered_anomaly');
      expect(transitions[0].anomalyType).toBe('permission_blocked');
      expect(transitions[1].transition).toBe('cleared_anomaly');
      expect(transitions[1].anomalyType).toBe('needs_input');
    });

    test('no transition when state is unchanged', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      // Same anomaly on next tick
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      expect(transitions).toHaveLength(0);
    });

    test('transition includes real state for comparison', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      const realAnomaly = makeAnomaly('agent-1', 'permission_blocked');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      expect(transitions[0].realState.anomaly).toBe('permission_blocked');
      expect(transitions[0].realState.since).toBe('2026-03-28T10:00:00.000Z');
    });
  });

  describe('confidence propagation', () => {
    test('heartbeat carries strategy confidence when shadowState is set', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input', 'high'));
      registry.register(strategy);

      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });
      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats[0].confidence).toBe('high');
    });

    test('heartbeat omits confidence when shadowState is null', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });
      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats[0].confidence).toBeUndefined();
    });

    test('heartbeat omits confidence when strategy returns anomaly without confidence', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.register(strategy);

      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });
      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats[0].shadowState).toBe('needs_input');
      expect(heartbeats[0].confidence).toBeUndefined();
    });

    test('entered_anomaly transition carries strategy confidence', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      strategy.setResult(makeAnomaly('agent-1', 'permission_blocked', 'medium'));
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      const entered = transitions.find((t) => t.transition === 'entered_anomaly');
      expect(entered?.confidence).toBe('medium');
    });

    test('cleared_anomaly transition does not carry confidence', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input', 'high'));
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      strategy.setResult(null);
      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const transitions = entries.filter((e): e is ShadowTransition => e.kind === 'transition');
      const cleared = transitions.find((t) => t.transition === 'cleared_anomaly');
      expect(cleared?.confidence).toBeUndefined();
    });
  });

  describe('multiple strategies', () => {
    test('evaluates all registered strategies independently', () => {
      const strat1 = new TestStrategy('pane_semantics');
      const strat2 = new TestStrategy('process_liveness');
      strat1.setResult(makeAnomaly('agent-1', 'needs_input'));
      strat2.setResult(null);

      registry.register(strat1);
      registry.register(strat2);

      const entries = registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      const heartbeats = entries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
      expect(heartbeats).toHaveLength(2);
      expect(heartbeats[0].source).toBe('pane_semantics');
      expect(heartbeats[0].shadowState).toBe('needs_input');
      expect(heartbeats[1].source).toBe('process_liveness');
      expect(heartbeats[1].shadowState).toBeNull();
    });
  });

  describe('multiple agents', () => {
    test('tracks state independently per agent', () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      // Agent 1: detect anomaly
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });

      // Agent 2: healthy
      strategy.setResult(null);
      const entries = registry.evaluate('agent-2', { paneText: '', realAnomaly: null });

      expect(registry.getState('agent-1', 'pane_semantics')).toBe('needs_input');
      expect(registry.getState('agent-2', 'pane_semantics')).toBeNull();
    });
  });

  describe('unregisterAgent', () => {
    test('clears state for unregistered agent', () => {
      const strategy = new TestStrategy('pane_semantics');
      strategy.setResult(makeAnomaly('agent-1', 'needs_input'));
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null });
      expect(registry.getState('agent-1', 'pane_semantics')).toBe('needs_input');

      registry.unregisterAgent('agent-1');
      expect(registry.getState('agent-1', 'pane_semantics')).toBeNull();
    });
  });

  describe('fire-and-forget logging', () => {
    test('writes entries to JSONL file', async () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      const now = new Date('2026-03-28T12:00:00Z');
      registry.evaluate('agent-1', { paneText: 'test', realAnomaly: null }, now);

      // Wait for async write
      await vi.waitFor(async () => {
        const content = await readFile(logPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(1);
      }, { timeout: 2000 });

      const content = await readFile(logPath, 'utf-8');
      const entry = JSON.parse(content.trim()) as ShadowLogEntry;
      expect(entry.kind).toBe('heartbeat');
      expect(entry.agentId).toBe('agent-1');
      expect(entry.timestamp).toBe('2026-03-28T12:00:00.000Z');
    });

    test('does not throw on write failure', () => {
      // Use an impossible path
      const badRegistry = new ShadowDetectorRegistry('/nonexistent/path/shadow.jsonl');
      const strategy = new TestStrategy('pane_semantics');
      badRegistry.register(strategy);

      // Should not throw
      expect(() => {
        badRegistry.evaluate('agent-1', { paneText: '', realAnomaly: null });
      }).not.toThrow();
    });

    test('accumulates entries across multiple evaluations', async () => {
      const strategy = new TestStrategy('pane_semantics');
      registry.register(strategy);

      registry.evaluate('agent-1', { paneText: '', realAnomaly: null }, new Date('2026-03-28T12:00:00Z'));
      registry.evaluate('agent-1', { paneText: '', realAnomaly: null }, new Date('2026-03-28T12:00:05Z'));

      await vi.waitFor(async () => {
        const content = await readFile(logPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(2);
        // Verify each line is valid parseable JSONL
        for (const line of lines) {
          const entry = JSON.parse(line) as ShadowLogEntry;
          expect(entry.kind).toBe('heartbeat');
          expect(entry.agentId).toBe('agent-1');
        }
      }, { timeout: 2000 });
    });
  });
});
