import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpPushTracker } from './http-push-tracker.js';

describe('HttpPushTracker', () => {
  let tracker: HttpPushTracker;

  beforeEach(() => {
    tracker = new HttpPushTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  test('records HTTP arrival and returns hash', () => {
    const hash = tracker.recordHttpArrival('agent-1', '{"event":"stop"}');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  test('same content produces same hash', () => {
    const hash1 = tracker.recordHttpArrival('agent-1', '{"event":"stop"}');
    tracker.dispose();
    tracker = new HttpPushTracker();
    const hash2 = tracker.recordHttpArrival('agent-1', '{"event":"stop"}');
    expect(hash1).toBe(hash2);
  });

  test('different content produces different hash', () => {
    const hash1 = tracker.recordHttpArrival('agent-1', '{"event":"stop"}');
    const hash2 = tracker.recordHttpArrival('agent-1', '{"event":"start"}');
    expect(hash1).not.toBe(hash2);
  });

  test('checkAndComputeDelta returns delta for known event', () => {
    const rawJson = '{"event":"stop","session_id":"abc"}';
    tracker.recordHttpArrival('agent-1', rawJson);

    // Simulate some time passing
    const result = tracker.checkAndComputeDelta(rawJson);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-1');
    expect(result!.deltaMs).toBeGreaterThanOrEqual(0);
  });

  test('checkAndComputeDelta returns null for unknown event', () => {
    const result = tracker.checkAndComputeDelta('{"unknown":"event"}');
    expect(result).toBeNull();
  });

  test('checkAndComputeDelta consumes the entry (one-time use)', () => {
    const rawJson = '{"event":"stop"}';
    tracker.recordHttpArrival('agent-1', rawJson);

    const result1 = tracker.checkAndComputeDelta(rawJson);
    expect(result1).not.toBeNull();

    const result2 = tracker.checkAndComputeDelta(rawJson);
    expect(result2).toBeNull(); // Already consumed
  });

  test('hasHttpArrival returns true for recorded events', () => {
    const rawJson = '{"event":"stop"}';
    tracker.recordHttpArrival('agent-1', rawJson);
    expect(tracker.hasHttpArrival(rawJson)).toBe(true);
  });

  test('hasHttpArrival returns false for unknown events', () => {
    expect(tracker.hasHttpArrival('{"unknown":"event"}')).toBe(false);
  });

  test('pendingCount tracks unmatched arrivals', () => {
    expect(tracker.pendingCount).toBe(0);

    tracker.recordHttpArrival('agent-1', '{"event":"stop"}');
    expect(tracker.pendingCount).toBe(1);

    tracker.recordHttpArrival('agent-1', '{"event":"start"}');
    expect(tracker.pendingCount).toBe(2);

    tracker.checkAndComputeDelta('{"event":"stop"}');
    expect(tracker.pendingCount).toBe(1);
  });

  test('dispose stops cleanup interval', () => {
    tracker.dispose();
    // Should not throw on double dispose
    tracker.dispose();
  });
});
