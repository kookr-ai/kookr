import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTerminalWriteScheduler, createTerminalWriter } from './terminal-writer.js';

const SYNC_OUTPUT_ON = '\x1b[?2026h';
const SYNC_OUTPUT_OFF = '\x1b[?2026l';

function lastSyncMode(text: string, previous: boolean): boolean {
  const lastOn = text.lastIndexOf(SYNC_OUTPUT_ON);
  const lastOff = text.lastIndexOf(SYNC_OUTPUT_OFF);
  if (lastOn < 0 && lastOff < 0) return previous;
  return lastOn > lastOff;
}

function harness() {
  const tasks: Array<() => void> = [];
  const scheduler = createTerminalWriteScheduler((task) => tasks.push(task));
  const callbacks: Array<() => void> = [];
  const screen: string[] = [];
  const modes = { synchronizedOutputMode: false };
  const terminal = {
    modes,
    write: vi.fn((data: Uint8Array, done: () => void) => {
      callbacks.push(() => {
        const text = new TextDecoder().decode(data);
        modes.synchronizedOutputMode = lastSyncMode(text, modes.synchronizedOutputMode);
        screen.push(text);
        done();
      });
    }),
    reset: vi.fn(() => { screen.length = 0; modes.synchronizedOutputMode = false; }),
  };
  const onStall = vi.fn();
  const writer = createTerminalWriter({ terminal, scheduler, onStall });
  return { writer, terminal, callbacks, tasks, scheduler, screen, onStall, modes,
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

  test('closes DECSET 2026 after a parse that leaves synchronized output enabled', () => {
    const h = harness();
    const parsed = vi.fn();
    const payload = new TextEncoder().encode(
      `${SYNC_OUTPUT_ON}\x1b[10;1Hhello${SYNC_OUTPUT_OFF}${SYNC_OUTPUT_ON}`,
    );
    const session = h.writer.begin(false);
    expect(session.write(payload, parsed)).toBe(true);
    h.turn();
    expect(h.terminal.write).toHaveBeenCalledOnce();
    h.parse();
    expect(h.modes.synchronizedOutputMode).toBe(true);
    expect(parsed).not.toHaveBeenCalled();
    expect(h.terminal.write).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(h.terminal.write.mock.calls[1][0])).toBe(SYNC_OUTPUT_OFF);
    h.parse();
    expect(h.modes.synchronizedOutputMode).toBe(false);
    expect(parsed).toHaveBeenCalledExactlyOnceWith(payload.byteLength);
    h.writer.dispose();
  });

  test('does not inject a synchronized-output closer when the parse already ended in 2026l', () => {
    const h = harness();
    const payload = new TextEncoder().encode(`${SYNC_OUTPUT_ON}hi${SYNC_OUTPUT_OFF}`);
    h.writer.begin(false).write(payload);
    h.turn();
    h.parse();
    expect(h.terminal.write).toHaveBeenCalledOnce();
    expect(h.modes.synchronizedOutputMode).toBe(false);
    h.writer.dispose();
  });

  test('retires when the synchronized-output closer write throws', () => {
    const h = harness();
    const session = h.writer.begin(false);
    session.write(new TextEncoder().encode(`${SYNC_OUTPUT_ON}hi`));
    h.turn();
    h.terminal.write.mockImplementationOnce(() => { throw new Error('closer write failed'); });
    expect(h.parse).not.toThrow();
    expect(h.onStall).toHaveBeenCalledOnce();
    expect(session.write(new Uint8Array(1))).toBe(false);
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
