import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { createTerminalWriter } from './terminal-writer.js';

function screen(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return { lines: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true)),
    x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY, type: buffer.type,
    modes: terminal.modes };
}
const write = (terminal: Terminal, bytes: Uint8Array) => new Promise<void>((resolve) => terminal.write(bytes, resolve));

describe('FR-TERM-003: real xterm parsing', () => {
  it('matches monolithic parsing across split UTF-8 and subsequent buffer switches', async () => {
    const reference = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
    const streamed = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
    const writer = createTerminalWriter({ terminal: streamed, onStall: () => { throw new Error('parser stalled'); } });
    try {
      const bytes = new TextEncoder().encode('x'.repeat(8191) + '😀\r\n'
        + 'line\r\n'.repeat(500) + '\x1b[?1049h\x1b[2;4H你\x1b[?1h\x1b[?2004h'
        + '\x1b[?1049l\x1b[3;5Hend\x1b[31m!');
      await write(reference, bytes);
      const session = writer.begin(false);
      await new Promise<void>((resolve) => { session.write(bytes); session.barrier(resolve); });
      expect(screen(streamed)).toEqual(screen(reference));
    } finally { writer.dispose(); reference.dispose(); streamed.dispose(); }
  });

  it.each([
    ['CSI cursor', '\x1b[12;4H', 4],
    ['OSC title', '\x1b]2;terminal-title\x1b\\', 9],
    ['alternate buffer', '\x1b[?1049h', 5],
    ['bracketed paste mode', '\x1b[?2004h', 6],
  ] as const)('preserves a split %s sequence across actual writer chunks', async (_name, sequence, split) => {
    const reference = new Terminal({ cols: 80, rows: 24 });
    const streamed = new Terminal({ cols: 80, rows: 24 });
    const referenceTitles: string[] = [];
    const streamedTitles: string[] = [];
    reference.onTitleChange((title) => referenceTitles.push(title));
    streamed.onTitleChange((title) => streamedTitles.push(title));
    const writer = createTerminalWriter({ terminal: streamed, onStall: () => { throw new Error('parser stalled'); } });
    try {
      const bytes = new TextEncoder().encode('x'.repeat(8192 - split) + sequence + 'END');
      expect(bytes[8192 - split]).toBe(0x1b);
      await write(reference, bytes);
      const session = writer.begin(false);
      await new Promise<void>((resolve) => { session.write(bytes); session.barrier(resolve); });
      expect(screen(streamed)).toEqual(screen(reference));
      expect(streamedTitles).toEqual(referenceTitles);
    } finally { writer.dispose(); reference.dispose(); streamed.dispose(); }
  });

  it('drains OLD before resetting to NEW even with the real asynchronous write buffer', async () => {
    const terminal = new Terminal();
    const writer = createTerminalWriter({ terminal, onStall: () => { throw new Error('parser stalled'); },
      scheduler: { request: (task) => task(), cancel: () => {} } });
    try {
      const old = writer.begin();
      old.write(new TextEncoder().encode('OLD'));
      const next = writer.begin();
      await new Promise<void>((resolve) => { next.write(new TextEncoder().encode('NEW')); next.barrier(resolve); });
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('NEW');
    } finally { writer.dispose(); terminal.dispose(); }
  });

  it('xterm preserves viewed text while trimming and clamps at the oldest retained line', async () => {
    const terminal = new Terminal({ rows: 3, cols: 80, scrollback: 5 });
    try {
      await write(terminal, new TextEncoder().encode('0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6'));
      terminal.scrollLines(-2);
      const oldLine = terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true);
      await write(terminal, new TextEncoder().encode('\r\n7\r\n8'));
      expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe(oldLine);
      await write(terminal, new TextEncoder().encode('\r\n9\r\n10\r\n11'));
      expect(terminal.buffer.active.viewportY).toBe(0);
    } finally { terminal.dispose(); }
  });
});
