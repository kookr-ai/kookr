// @vitest-environment jsdom

import { describe, test, expect } from 'vitest';
import {
  evaluateChime,
  RECHIME_COOLDOWN_MS,
  type ChimeRecord,
} from './useAudibleAlert.js';
import type { AgentState, AnomalySeverity, AnomalyType } from '../../shared/protocol.js';
import type { Anomaly } from '../../core/types.js';

// Default detectedAt for tests that do not care about the timestamp's exact
// value — tests that exercise dedup or flicker pin their own dates explicitly.
const DEFAULT_DETECTED_AT = new Date('2026-05-08T12:00:00Z');

function mkAgent(opts: {
  agentId: string;
  anomaly?: Partial<Anomaly> & { type: AnomalyType; severity: AnomalySeverity };
  snoozedUntil?: number;
  suppressed?: boolean;
  taskStatus?: AgentState['taskStatus'];
}): AgentState {
  const anomaly: Anomaly | null = opts.anomaly
    ? {
        agentId: opts.agentId,
        explanation: 'mock',
        detectedAt: DEFAULT_DETECTED_AT,
        ...opts.anomaly,
      }
    : null;
  return {
    agentId: opts.agentId,
    events: [],
    anomaly,
    snoozedUntil: opts.snoozedUntil,
    suppressed: opts.suppressed,
    taskStatus: opts.taskStatus,
  };
}

describe('evaluateChime — appears-in-findings semantics', () => {
  const T0 = 1_700_000_000_000;

  test('chimes on first warning finding for an agent', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({ agentId: 'a', anomaly: { type: 'permission_blocked', severity: 'warning' } }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(true);
  });

  test('chimes on critical findings', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({ agentId: 'a', anomaly: { type: 'budget_exceeded', severity: 'critical' } }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(true);
  });

  test('does not chime for info severity (e.g. needs_input from stop)', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({ agentId: 'a', anomaly: { type: 'needs_input', severity: 'info' } }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(false);
  });

  test('does not chime for snoozed or suppressed agents', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({
        agentId: 'a',
        anomaly: { type: 'permission_blocked', severity: 'warning' },
        snoozedUntil: T0 + 60_000,
      }),
      mkAgent({
        agentId: 'b',
        anomaly: { type: 'permission_blocked', severity: 'warning' },
        suppressed: true,
      }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(false);
  });

  test('does not chime for pending tasks (matches Findings panel filter)', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({
        agentId: 'a',
        anomaly: { type: 'permission_blocked', severity: 'warning' },
        taskStatus: 'pending',
      }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(false);
  });
});

describe('evaluateChime — dedup and flicker suppression', () => {
  const T0 = 1_700_000_000_000;
  const detectedAt = new Date('2026-05-08T12:00:00Z');

  test('does not re-chime when the same finding (same detectedAt) re-evaluates', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({
        agentId: 'a',
        anomaly: { type: 'permission_blocked', severity: 'warning', detectedAt },
      }),
    ];
    expect(evaluateChime(agents, state, T0)).toBe(true);
    expect(evaluateChime(agents, state, T0 + 1_000)).toBe(false);
    expect(evaluateChime(agents, state, T0 + 5_000)).toBe(false);
  });

  test('suppresses re-chime when anomaly briefly clears and re-appears within cooldown', () => {
    const state = new Map<string, ChimeRecord>();
    const initial = mkAgent({
      agentId: 'a',
      anomaly: { type: 'stale_agent', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([initial], state, T0)).toBe(true);

    expect(evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + 100)).toBe(false);

    const reFired = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'stale_agent',
        severity: 'warning',
        detectedAt: new Date(detectedAt.getTime() + 5_000),
      },
    });
    expect(evaluateChime([reFired], state, T0 + 5_000)).toBe(false);
  });

  test('allows re-chime after the cooldown window elapses', () => {
    const state = new Map<string, ChimeRecord>();
    const initial = mkAgent({
      agentId: 'a',
      anomaly: { type: 'stale_agent', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([initial], state, T0)).toBe(true);

    expect(evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + 100)).toBe(false);

    expect(
      evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + RECHIME_COOLDOWN_MS + 1_000),
    ).toBe(false);

    const newFinding = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        detectedAt: new Date(detectedAt.getTime() + RECHIME_COOLDOWN_MS + 2_000),
      },
    });
    expect(
      evaluateChime([newFinding], state, T0 + RECHIME_COOLDOWN_MS + 2_000),
    ).toBe(true);
  });

  test('does not re-chime when cooldown ends with the same flickering finding still active', () => {
    const state = new Map<string, ChimeRecord>();

    expect(
      evaluateChime(
        [mkAgent({ agentId: 'a', anomaly: { type: 'stale_agent', severity: 'warning', detectedAt } })],
        state,
        T0,
      ),
    ).toBe(true);

    expect(evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + 100)).toBe(false);

    const flickerKey = new Date(detectedAt.getTime() + 5_000);
    const flickering = mkAgent({
      agentId: 'a',
      anomaly: { type: 'stale_agent', severity: 'warning', detectedAt: flickerKey },
    });
    expect(evaluateChime([flickering], state, T0 + 5_000)).toBe(false);

    expect(
      evaluateChime([flickering], state, T0 + RECHIME_COOLDOWN_MS + 1_000),
    ).toBe(false);
  });

  test('different agent in finding state still chimes independently', () => {
    const state = new Map<string, ChimeRecord>();
    const a = mkAgent({
      agentId: 'a',
      anomaly: { type: 'permission_blocked', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([a], state, T0)).toBe(true);

    const b = mkAgent({
      agentId: 'b',
      anomaly: { type: 'permission_blocked', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([a, b], state, T0 + 1_000)).toBe(true);
  });

  test('anomaly type change for the same agent (no clear in between) chimes', () => {
    const state = new Map<string, ChimeRecord>();
    const initial = mkAgent({
      agentId: 'a',
      anomaly: { type: 'stale_agent', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([initial], state, T0)).toBe(true);

    const escalated = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        detectedAt: new Date(detectedAt.getTime() + 1_000),
      },
    });
    expect(evaluateChime([escalated], state, T0 + 1_000)).toBe(true);
  });

  test('same anomaly type re-chimes after agent fully clears past the cooldown', () => {
    const state = new Map<string, ChimeRecord>();
    const initial = mkAgent({
      agentId: 'a',
      anomaly: { type: 'stale_agent', severity: 'warning', detectedAt },
    });
    expect(evaluateChime([initial], state, T0)).toBe(true);

    // Anomaly clears and stays cleared past the cooldown — entry evicted.
    expect(evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + 100)).toBe(false);
    expect(
      evaluateChime([mkAgent({ agentId: 'a' })], state, T0 + RECHIME_COOLDOWN_MS + 1_000),
    ).toBe(false);

    // Same anomaly type returns later with a fresh detectedAt — chime allowed.
    const recurring = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'stale_agent',
        severity: 'warning',
        detectedAt: new Date(detectedAt.getTime() + RECHIME_COOLDOWN_MS + 60_000),
      },
    });
    expect(
      evaluateChime([recurring], state, T0 + RECHIME_COOLDOWN_MS + 60_000),
    ).toBe(true);
  });

  test('detectedAt delivered as ISO string (the production WS shape) is keyed correctly', () => {
    const state = new Map<string, ChimeRecord>();
    const isoString = '2026-05-08T12:00:00.000Z';
    // Cast through unknown — matches what JSON.parse produces over the wire,
    // before any Date revival. The hook must treat string and Date with the
    // same shape so dedup holds end-to-end.
    const wireShape = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        detectedAt: isoString as unknown as Date,
      },
    });

    expect(evaluateChime([wireShape], state, T0)).toBe(true);
    // Re-evaluation with the same string-typed detectedAt must not re-chime.
    expect(evaluateChime([wireShape], state, T0 + 1_000)).toBe(false);
  });

  test('agent missing detectedAt is excluded from the chime path entirely', () => {
    const state = new Map<string, ChimeRecord>();
    const undated = mkAgent({
      agentId: 'a',
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        detectedAt: undefined as unknown as Date,
      },
    });
    expect(evaluateChime([undated], state, T0)).toBe(false);
    expect(state.size).toBe(0);
  });
});
