/**
 * Unit tests for FakeTerminalBridge — focused on the read-only (viewer) flag
 * introduced for the read-only shared view (kookr #807). A read-only fake
 * bridge must never wire the inbound `ws.on('message')` handler, so no
 * keystroke/resize/paste reaches the fake backend, while output still streams.
 */
import { describe, expect, it, vi } from 'vitest';

import { FakeTerminalBridge } from './fake-terminal-bridge.js';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';

class FakeWs {
  public readyState = 1;
  public OPEN = 1;
  public sent: Array<Buffer | string> = [];
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  send(payload: Buffer | string): void { this.sent.push(payload); }
  close(): void { this.readyState = 3; this.emit('close'); }
  on(event: string, cb: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

function makeWriter(): { writer: TerminalInputWriterPort; writeInput: ReturnType<typeof vi.fn> } {
  const writeInput = vi.fn().mockResolvedValue({ sessionId: 's1', readinessVersion: 1 });
  return {
    writeInput,
    writer: {
      writeInput,
      writeInputSequence: vi.fn().mockResolvedValue({ sessionId: 's1', readinessVersion: 1 }),
    } as TerminalInputWriterPort,
  } as unknown as { writer: TerminalInputWriterPort; writeInput: ReturnType<typeof vi.fn> };
}

describe('FakeTerminalBridge readOnly (#807)', () => {
  const content = { text: 'one\ntwo', mode: 'instant' as const };

  it('does not wire the inbound message handler when read-only', () => {
    const ws = new FakeWs();
    const { writer } = makeWriter();
    const bridge = new FakeTerminalBridge('s1', ws as unknown as never, content, writer, { readOnly: true });
    bridge.start();
    bridge.dispose();

    expect(ws.listenerCount('message')).toBe(0);
  });

  it('drops viewer keystroke/resize/paste input — nothing reaches the backend', () => {
    const ws = new FakeWs();
    const { writer, writeInput } = makeWriter();
    const bridge = new FakeTerminalBridge('s1', ws as unknown as never, content, writer, { readOnly: true });
    bridge.start();

    // No handler is registered, so these emits are no-ops.
    ws.emit('message', Buffer.from('hello'));
    ws.emit('message', Buffer.from('{"type":"resize","cols":80,"rows":24}'));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'paste', text: 'a\nb' })));
    bridge.dispose();

    expect(writeInput).not.toHaveBeenCalled();
  });

  it('still streams output to a read-only viewer', () => {
    const ws = new FakeWs();
    const { writer } = makeWriter();
    const bridge = new FakeTerminalBridge('s1', ws as unknown as never, content, writer, { readOnly: true });
    bridge.start();
    bridge.dispose();

    const merged = ws.sent.map((s) => (Buffer.isBuffer(s) ? s.toString('utf-8') : s)).join('');
    expect(merged).toContain('one');
    expect(merged).toContain('two');
  });

  it('owner (readOnly false / omitted) bridges accept input', () => {
    const ws = new FakeWs();
    const { writer, writeInput } = makeWriter();
    const bridge = new FakeTerminalBridge('s1', ws as unknown as never, content, writer);
    bridge.start();

    expect(ws.listenerCount('message')).toBe(1);
    ws.emit('message', Buffer.from('hi'));
    bridge.dispose();

    expect(writeInput).toHaveBeenCalledTimes(1);
    expect(Array.from(writeInput.mock.calls[0][1] as Uint8Array)).toEqual(
      Array.from(Buffer.from('hi')),
    );
  });
});
