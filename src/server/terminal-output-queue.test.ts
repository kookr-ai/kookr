import { afterEach, describe, expect, test, vi } from 'vitest';
import { TerminalOutputFleet, TerminalOutputQueue } from './terminal-output-queue.js';

function setup(fleet = new TerminalOutputFleet(), id = 'test') {
  const tasks: Array<() => void> = [];
  const send = vi.fn();
  const close = vi.fn();
  const queue = new TerminalOutputQueue({ id, generation: 'g', fleet, send, close, defer: (task) => tasks.push(task) });
  return { queue, send, close, turn: () => tasks.shift()?.(), drain: () => { while (tasks.length) tasks.shift()?.(); } };
}

describe('NFR-TERM-001: rendering-aware output credit', () => {
  afterEach(() => vi.useRealTimers());

  test('chunks seed and live data through the same window and ordered controls', () => {
    const h = setup();
    h.queue.control({ type: 'seed-begin' });
    h.queue.enqueue(new Uint8Array(140 * 1024));
    h.queue.control({ type: 'seed-end' });
    h.drain();
    const binary = h.send.mock.calls.map(([data]) => data).filter((data) => data instanceof Uint8Array);
    expect(binary.every((data) => data.length <= 8192)).toBe(true);
    expect(binary.reduce((sum, data) => sum + data.length, 0)).toBe(128 * 1024);
    expect(h.send.mock.calls.some(([data]) => typeof data === 'string' && data.includes('seed-end'))).toBe(false);
    expect(h.queue.acknowledge('g', 32 * 1024)).toBe(true);
    h.drain();
    expect(h.send.mock.lastCall?.[0]).toBe(JSON.stringify({ type: 'seed-end' }));
    h.queue.dispose();
  });

  test('duplicates are harmless; invalid, future, and wrong-generation credit is rejected', () => {
    const h = setup();
    h.queue.enqueue(new Uint8Array(10)); h.drain();
    for (const [generation, bytes] of [['g', -1], ['g', 0.5], ['g', NaN], ['g', 11], ['old', 5]] as const) {
      expect(h.queue.acknowledge(generation, bytes)).toBe(false);
    }
    expect(h.queue.acknowledge('g', 10)).toBe(true);
    expect(h.queue.acknowledge('g', 10)).toBe(true);
    expect(h.queue.acknowledge('g', 5)).toBe(true);
    expect(h.queue.outstandingBytes).toBe(0);
    h.queue.dispose();
  });

  test('ack stall retires only the lagging viewer and releases its reservation', () => {
    vi.useFakeTimers();
    const fleet = new TerminalOutputFleet();
    const slow = setup(fleet, 'slow');
    const fast = setup(fleet, 'fast');
    slow.queue.enqueue(new Uint8Array(10)); slow.drain();
    fast.queue.enqueue(new Uint8Array(10)); fast.drain();
    fast.queue.acknowledge('g', 10);
    vi.advanceTimersByTime(5000);
    expect(slow.close).toHaveBeenCalledWith('ack-stalled');
    expect(fast.close).not.toHaveBeenCalled();
    expect(fleet.reservedBytes).toBe(0);
    slow.queue.dispose(); fast.queue.dispose();
  });

  test('rejects oversized payload before retaining it', () => {
    const h = setup();
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    const copy = vi.spyOn(oversized, 'subarray');
    expect(h.queue.enqueue(oversized)).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith('viewer-budget');
  });

  test('fleet pressure evicts the largest lag holder, not a new healthy viewer', () => {
    const fleet = new TerminalOutputFleet(24 * 1024);
    const slow = setup(fleet, 'slow');
    const entrant = setup(fleet, 'new');
    slow.queue.enqueue(new Uint8Array(24 * 1024)); slow.drain();
    expect(entrant.queue.enqueue(new Uint8Array(1))).toBe(true);
    expect(slow.close).toHaveBeenCalledWith('fleet-budget');
    expect(entrant.close).not.toHaveBeenCalled();
    expect(fleet.reservedBytes).toBe(8192);
    entrant.queue.dispose();
  });

  test('tiny chunks share owned segments and control envelopes are bounded', () => {
    const fleet = new TerminalOutputFleet();
    const h = setup(fleet);
    for (let i = 0; i < 8000; i++) expect(h.queue.enqueue(new Uint8Array(1))).toBe(true);
    expect(fleet.reservedBytes).toBe(8192);
    expect(h.queue.control({ type: 'too-big', data: 'x'.repeat(4096) })).toBe(false);
    expect(h.close).toHaveBeenCalledWith('control-budget');
    expect(fleet.reservedBytes).toBe(0);
  });

  test('preserves source ranges per binary frame without counting metadata as credit', () => {
    const h = setup();
    h.queue.enqueue(new Uint8Array(9000), { epoch: 'e', start: 100, end: 9100, geometryRevision: 1, cols: 80, rows: 24 });
    h.drain();
    expect(JSON.parse(h.send.mock.calls[0][0])).toMatchObject({ type: 'source', start: 100, end: 8292 });
    expect(JSON.parse(h.send.mock.calls[2][0])).toMatchObject({ type: 'source', start: 8292, end: 9100 });
    expect(h.queue.acknowledge('g', 9000)).toBe(true);
    expect(h.queue.outstandingBytes).toBe(0);
    h.queue.dispose();
  });

  test('orders an atomic seed before retained live bytes and removes captured duplicates by position', () => {
    const h = setup();
    const range = { epoch: 'e', start: 10, end: 20, geometryRevision: 1, cols: 80, rows: 24 };
    h.queue.setPaused(true);
    h.queue.enqueue(new TextEncoder().encode('0123456789'), range);
    expect(h.queue.seed({ ...range, start: 0, end: 15 }, new TextEncoder().encode('SEED'),
      { type: 'seed-begin' }, { type: 'seed-end' })).toBe(true);
    h.drain();
    expect(h.send).not.toHaveBeenCalled();
    h.queue.setPaused(false); h.drain();
    const frames = h.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data).type : new TextDecoder().decode(data));
    expect(frames).toEqual(['seed-begin', 'SEED', 'seed-end', 'source', '56789']);
    expect(h.queue.acknowledge('g', 9)).toBe(true);
    expect(h.queue.outstandingBytes).toBe(0);
    h.queue.dispose();
  });

  test('never infers continuity across epochs or missing source positions', () => {
    const h = setup();
    const snapshot = { epoch: 'e', start: 0, end: 15, geometryRevision: 1, cols: 80, rows: 24 };
    h.queue.setPaused(true);
    h.queue.enqueue(new Uint8Array(10), { ...snapshot, start: 20, end: 30 });
    expect(h.queue.seed(snapshot, new Uint8Array(0), {}, {})).toBe(false);
    h.queue.dispose();
  });
});
