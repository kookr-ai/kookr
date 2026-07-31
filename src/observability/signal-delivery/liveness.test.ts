import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LIVENESS_REEMIT_INTERVAL_MS,
  checkLiveness,
  type LivenessRegistryEntry,
  type LivenessState,
} from './liveness.js';

const HOUR = 60 * 60 * 1000;
const gate: LivenessRegistryEntry = { name: 'gate-heartbeat', maxAgeMs: 60 * 60 * 1000, path: '/state/gate.json' };

describe('checkLiveness — AC: stale emits one signal, one more after 6h', () => {
  test('a stale artifact emits exactly one signal', () => {
    const { signals, nextState } = checkLiveness({
      registry: [gate],
      ageMsOf: () => 90 * 60 * 1000, // 90m > 60m budget
      now: 0,
      prevState: {},
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('alert');
    expect(signals[0]!.key).toBe('liveness:gate-heartbeat:stale');
    expect(nextState['gate-heartbeat']).toEqual({ stale: true, lastEmittedAt: 0 });
  });

  test('still-stale before 6h does NOT re-emit', () => {
    const prevState: LivenessState = { 'gate-heartbeat': { stale: true, lastEmittedAt: 0 } };
    const { signals, nextState } = checkLiveness({
      registry: [gate],
      ageMsOf: () => 90 * 60 * 1000,
      now: 5 * HOUR,
      prevState,
    });
    expect(signals).toHaveLength(0);
    expect(nextState['gate-heartbeat']).toEqual({ stale: true, lastEmittedAt: 0 });
  });

  test('still-stale at 6h re-emits once', () => {
    const prevState: LivenessState = { 'gate-heartbeat': { stale: true, lastEmittedAt: 0 } };
    const { signals, nextState } = checkLiveness({
      registry: [gate],
      ageMsOf: () => 90 * 60 * 1000,
      now: DEFAULT_LIVENESS_REEMIT_INTERVAL_MS,
      prevState,
    });
    expect(signals).toHaveLength(1);
    expect(nextState['gate-heartbeat']!.lastEmittedAt).toBe(DEFAULT_LIVENESS_REEMIT_INTERVAL_MS);
  });

  test('a missing artifact is treated as stale', () => {
    const { signals } = checkLiveness({ registry: [gate], ageMsOf: () => null, now: 0, prevState: {} });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.title).toContain('missing');
  });

  test('recovery from stale emits one clear and re-arms', () => {
    const prevState: LivenessState = { 'gate-heartbeat': { stale: true, lastEmittedAt: 0 } };
    const { signals, nextState } = checkLiveness({
      registry: [gate],
      ageMsOf: () => 10 * 60 * 1000, // fresh
      now: 7 * HOUR,
      prevState,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('clear');
    expect(nextState['gate-heartbeat']).toEqual({ stale: false, lastEmittedAt: null });
  });

  test('fresh with no prior alert emits nothing', () => {
    const { signals } = checkLiveness({ registry: [gate], ageMsOf: () => 0, now: 0, prevState: {} });
    expect(signals).toHaveLength(0);
  });

  test('disabled entries are skipped and carry state forward', () => {
    const disabled: LivenessRegistryEntry = { ...gate, enabled: false };
    const prevState: LivenessState = { 'gate-heartbeat': { stale: true, lastEmittedAt: 123 } };
    const { signals, nextState } = checkLiveness({
      registry: [disabled],
      ageMsOf: () => { throw new Error('should not be called'); },
      now: 10 * HOUR,
      prevState,
    });
    expect(signals).toHaveLength(0);
    expect(nextState['gate-heartbeat']).toEqual({ stale: true, lastEmittedAt: 123 });
  });
});
