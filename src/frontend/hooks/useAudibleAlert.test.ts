// @vitest-environment jsdom

import React, { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import {
  __resetAudibleAlertForTests,
  evaluateChime,
  evaluateFindingChime,
  RECHIME_COOLDOWN_MS,
  useAudibleAlert,
  type ChimeRecord,
} from './useAudibleAlert.js';
import { __resetAudioAlertLogForTests, getAudioAlertSnapshot } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import { __resetDndForTests, disableDnd } from './useDnd.js';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, AnomalySeverity, AnomalyType } from '../../shared/protocol.js';
import type { Anomaly } from '../../shared/contracts/anomalies.js';

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

describe('evaluateFindingChime — audio context payload', () => {
  const T0 = 1_700_000_000_000;

  test('returns deterministic primary candidate and candidate count for one chime attempt', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({
        agentId: 'warning-agent',
        anomaly: {
          type: 'permission_blocked',
          severity: 'warning',
          detectedAt: new Date('2026-05-08T12:00:03Z'),
        },
        taskStatus: 'inProgress',
      }),
      mkAgent({
        agentId: 'critical-agent',
        anomaly: {
          type: 'budget_exceeded',
          severity: 'critical',
          detectedAt: new Date('2026-05-08T12:00:05Z'),
        },
        taskStatus: 'inProgress',
      }),
    ];

    const result = evaluateFindingChime(agents, state, T0);

    expect(result.shouldChime).toBe(true);
    expect(result.candidateCount).toBe(2);
    expect(result.context).toMatchObject({
      source: 'finding',
      reason: 'budget_exceeded critical on critical-agent (+1 more)',
      agentId: 'critical-agent',
      anomalyType: 'budget_exceeded',
      severity: 'critical',
      candidateCount: 2,
      primaryCause: 'highest_severity',
      activeFindingsCount: 2,
    });
    expect(result.context?.dedupeKey).toBe('critical-agent:budget_exceeded:2026-05-08T12:00:05.000Z');
  });

  test('ties primary candidate by earliest detectedAt then agent id', () => {
    const state = new Map<string, ChimeRecord>();
    const agents = [
      mkAgent({
        agentId: 'b-agent',
        anomaly: {
          type: 'stale_agent',
          severity: 'warning',
          detectedAt: new Date('2026-05-08T12:00:03Z'),
        },
      }),
      mkAgent({
        agentId: 'a-agent',
        anomaly: {
          type: 'permission_blocked',
          severity: 'warning',
          detectedAt: new Date('2026-05-08T12:00:03Z'),
        },
      }),
    ];

    const result = evaluateFindingChime(agents, state, T0);

    expect(result.context).toMatchObject({
      agentId: 'a-agent',
      anomalyType: 'permission_blocked',
      primaryCause: 'highest_severity',
      candidateCount: 2,
    });
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

describe('useAudibleAlert — runtime hook behavior', () => {
  let root: Root;
  let container: HTMLDivElement;
  let audioContextCtor: ReturnType<typeof vi.fn>;
  let store: Map<string, string>;

  function Wrapper() {
    useAudibleAlert();
    return null;
  }

  function mount(strict = false): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      const tree = strict
        ? React.createElement(StrictMode, null, React.createElement(Wrapper))
        : React.createElement(Wrapper);
      root.render(tree);
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    __resetAudioAlertLogForTests();
    __resetAudibleAlertForTests();
    __resetSoundPreferenceForTests();
    __resetDndForTests();
    disableDnd();

    audioContextCtor = vi.fn().mockImplementation(function () {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        close: vi.fn(),
        createOscillator: () => ({
          connect: vi.fn(),
          frequency: { value: 0 },
          type: '',
          start: vi.fn(),
          stop: vi.fn(),
        }),
        createGain: () => ({
          connect: vi.fn(),
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        }),
      };
    });
    vi.stubGlobal('AudioContext', audioContextCtor);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    __resetAudioAlertLogForTests();
    __resetAudibleAlertForTests();
    __resetSoundPreferenceForTests();
    __resetDndForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  test('records one scheduled finding decision with context under StrictMode', () => {
    const finding = mkAgent({
      agentId: 'agent-a',
      taskStatus: 'inProgress',
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        detectedAt: new Date('2026-05-08T12:00:00Z'),
      },
    });
    useKookrStore.setState({ agents: [finding] });

    mount(true);

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'finding',
      outcome: 'scheduled',
      agentId: 'agent-a',
      anomalyType: 'permission_blocked',
      severity: 'warning',
      candidateCount: 1,
      activeFindingsCount: 1,
    });

    act(() => {
      useKookrStore.setState({ agents: [{ ...finding }] });
    });

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().entries).toHaveLength(1);
  });

  test('reacts when a warning finding appears after mount', () => {
    useKookrStore.setState({ agents: [] });
    mount();

    expect(audioContextCtor).not.toHaveBeenCalled();

    act(() => {
      useKookrStore.setState({
        agents: [
          mkAgent({
            agentId: 'agent-after-mount',
            taskStatus: 'inProgress',
            anomaly: {
              type: 'stale_agent',
              severity: 'warning',
              detectedAt: new Date('2026-05-08T13:00:00Z'),
            },
          }),
        ],
      });
    });

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'finding',
      outcome: 'scheduled',
      agentId: 'agent-after-mount',
      anomalyType: 'stale_agent',
      severity: 'warning',
      candidateCount: 1,
    });
  });
});
