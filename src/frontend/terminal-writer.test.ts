import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTerminalWriteScheduler, createTerminalWriter } from './terminal-writer.js';

function harness() {
  const tasks: Array<() => void> = [];
  const scheduler = createTerminalWriteScheduler((task) => tasks.push(task));
  const callbacks: Array<() => void> = [];
  const screen: string[] = [];
  const terminal = {
    write: vi.fn((data: Uint8Array, done: () => void) => {
      callbacks.push(() => { screen.push(new TextDecoder().decode(data)); done(); });
    }),
    reset: vi.fn(() => { screen.length = 0; }),
  };
  const onStall = vi.fn();
  const writer = createTerminalWriter({ terminal, scheduler, onStall });
  return { writer, terminal, callbacks, tasks, scheduler, screen, onStall,
    turn: () => tasks.shift()?.(), parse: () => callbacks.shift()?.() };
}

describe('FR-TERM-003: terminal writer', () => {
  afterEach(() => vi.useRealTimers());

  test('contains an asynchronous parse-completion failure and retires the damaged owner', () => {
    const h = harness();
    const session = h.writer.begin();
    session.write(Uint8Array.of(65), () => { throw new Error('completion failed'); });
    h.turn();
    expect(() => h.parse()).not.toThrow();
    expect(h.onStall).toHaveBeenCalledOnce();
    expect(session.write(Uint8Array.of(66))).toBe(false);
    h.writer.dispose();
  });

  test('limits submissions to eight KiB and waits for each parser callback', () => {
    const h = harness();
    const session = h.writer.begin();
    const parsed = vi.fn();
    const bytes = new Uint8Array(20_000).map((_, index) => index % 256);
    expect(session.write(bytes, parsed)).toBe(true);
    h.turn();
    expect(h.terminal.reset).toHaveBeenCalledOnce();
    expect(h.terminal.write).toHaveBeenCalledOnce();
    expect(h.terminal.write.mock.calls[0][0]).toHaveLength(8192);
    expect(h.tasks).toHaveLength(0);
    expect(parsed).not.toHaveBeenCalled();
    h.parse(); h.turn(); h.parse(); h.turn(); h.parse();
    expect(parsed).toHaveBeenCalledExactlyOnceWith(20_000);
    const received = h.terminal.write.mock.calls.flatMap(([data]) => [...data]);
    expect(received).toEqual([...bytes]);
    h.writer.dispose();
  });

  test('drains the old parser before resetting and never acknowledges its bytes', () => {
    const h = harness();
    const old = h.writer.begin();
    const oldAck = vi.fn();
    old.write(new TextEncoder().encode('OLD'), oldAck);
    h.turn();
    old.write(new TextEncoder().encode('DROPPED'));
    const next = h.writer.begin();
    const ready = vi.fn();
    next.write(new TextEncoder().encode('NEW'));
    next.barrier(ready);
    h.turn();
    expect(h.terminal.reset).toHaveBeenCalledOnce();
    expect(h.terminal.write).toHaveBeenCalledOnce();
    h.parse(); h.turn(); h.parse(); h.turn();
    expect(h.screen.join('')).toBe('NEW');
    expect(oldAck).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
    expect(old.write(new Uint8Array(1))).toBe(false);
    h.writer.dispose();
  });

  test('keeps seed-ready behind every seed chunk, including an empty seed', () => {
    const h = harness();
    const session = h.writer.begin();
    const ready = vi.fn();
    session.write(new Uint8Array(9000));
    session.barrier(ready);
    h.turn(); h.parse(); h.turn();
    expect(ready).not.toHaveBeenCalled();
    h.parse(); h.turn();
    expect(ready).toHaveBeenCalledOnce();
    h.writer.begin().barrier(ready);
    h.turn();
    expect(ready).toHaveBeenCalledTimes(2);
    h.writer.dispose();
  });

  test('round-robins panes without waiting for a slow parser', () => {
    const h = harness();
    const other = { write: vi.fn((_bytes: Uint8Array, done: () => void) => done()), reset: vi.fn() };
    const second = createTerminalWriter({ terminal: other, scheduler: h.scheduler, onStall: vi.fn() });
    h.writer.begin().write(new Uint8Array(16_384));
    second.begin().write(new Uint8Array(16_384));
    h.turn();
    expect(h.terminal.write).toHaveBeenCalledOnce();
    expect(other.write).not.toHaveBeenCalled();
    h.turn();
    expect(other.write).toHaveBeenCalledOnce();
    h.turn();
    expect(other.write).toHaveBeenCalledTimes(2);
    expect(h.terminal.write).toHaveBeenCalledOnce();
    h.writer.dispose(); second.dispose();
  });

  test('retires a stalled instance instead of resetting a running parser', () => {
    vi.useFakeTimers();
    const h = harness();
    h.writer.begin().write(new Uint8Array(1));
    h.turn();
    const next = h.writer.begin();
    next.write(new Uint8Array(1));
    vi.advanceTimersByTime(1999);
    expect(h.onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.onStall).toHaveBeenCalledOnce();
    h.parse(); h.turn();
    expect(h.terminal.reset).toHaveBeenCalledOnce();
    expect(next.write(new Uint8Array(1))).toBe(false);
  });

  test('retires a parser that throws synchronously without escaping the scheduler', () => {
    const h = harness();
    h.terminal.write.mockImplementationOnce(() => { throw new Error('parser failure'); });
    const session = h.writer.begin();
    session.write(new Uint8Array(1));
    expect(h.turn).not.toThrow();
    expect(h.onStall).toHaveBeenCalledOnce();
    expect(session.write(new Uint8Array(1))).toBe(false);
  });

  test('bounds payload and control queue admission before retaining work', () => {
    const h = harness();
    const session = h.writer.begin();
    expect(session.write(new Uint8Array(2 * 1024 * 1024))).toBe(true);
    expect(session.write(new Uint8Array(1))).toBe(false);
    const next = h.writer.begin();
    for (let i = 0; i < 64; i++) expect(next.barrier(() => {})).toBe(true);
    expect(next.barrier(() => {})).toBe(false);
    h.writer.dispose();
  });

  test('retirement and disposal suppress pending controls and scheduled writes', () => {
    const h = harness();
    const session = h.writer.begin();
    const ready = vi.fn();
    session.write(new Uint8Array(1));
    session.barrier(ready);
    session.retire();
    h.turn();
    expect(h.terminal.write).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    h.writer.begin().write(new Uint8Array(1));
    h.writer.dispose();
    h.turn();
    expect(h.terminal.write).not.toHaveBeenCalled();
  });
});
