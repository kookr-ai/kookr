import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { cutStreamingAttachSeed } from './streaming-attach-seed.js';
import { LiveScreenModelSet, type LiveScreenJobResult } from './terminal-live-screen.js';
import { diffRenderedAgentStream, SPINNER_ONLY_FRAMES } from './__fixtures__/diff-rendered-agent-stream.js';

const COLS = 80;
const ROWS = 24;
const encode = (text: string) => new TextEncoder().encode(text);
const write = (terminal: Terminal, bytes: Uint8Array) => new Promise<void>((resolve) => terminal.write(bytes, resolve));

/** Paint chunks into a fresh terminal the way the browser does after a seed reset. */
async function paint(...chunks: Uint8Array[]) {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  try {
    for (const chunk of chunks) await write(terminal, chunk);
    const buffer = terminal.buffer.active;
    return {
      rows: Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''),
      cursor: [buffer.cursorX, buffer.cursorY],
    };
  } finally { terminal.dispose(); }
}

function seedBytes(result: LiveScreenJobResult): Uint8Array {
  if (result.kind !== 'seed') throw new Error(`no seed: ${JSON.stringify(result)}`);
  return result.bytes;
}

const sets: LiveScreenModelSet[] = [];
function newSet() { const set = new LiveScreenModelSet(); sets.push(set); return set; }
afterEach(() => { for (const set of sets.splice(0)) set.dispose(); });

/** Feed `bytes` from position `start` in chunks of the given sizes, cycling. */
async function feedChunked(set: LiveScreenModelSet, key: string, bytes: Uint8Array, start: number, sizes: number[], geometry = { cols: COLS, rows: ROWS }) {
  let offset = 0;
  for (let i = 0; offset < bytes.byteLength; i++) {
    const size = sizes[i % sizes.length]!;
    const chunk = bytes.subarray(offset, offset + size);
    const result = await set.run({ op: 'feed', sessionKey: key, epoch: 'e', start: start + offset, end: start + offset + chunk.byteLength, ...geometry }, chunk);
    expect(result.kind).toBe('done');
    offset += chunk.byteLength;
  }
}

describe('LiveScreenModelSet (issue #3564, step 2)', () => {
  const stream = diffRenderedAgentStream(SPINNER_ONLY_FRAMES);

  it('seeds the true screen after the base screen has left the last 64 KiB', async () => {
    // The case step 2 exists for: the base screen was drawn long ago, and only
    // spinner diffs followed. A ring shrunk or wrapped to its last 64 KiB
    // replays to a blank pane; a model that saw every byte does not.
    const tail = cutStreamingAttachSeed(stream.bytes, 64 * 1024);
    expect(await paint(tail)).not.toEqual(await paint(stream.bytes)); // the bug, reproduced

    const set = newSet();
    const head = stream.bytes.subarray(0, 300);
    expect((await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: head.byteLength, cols: COLS, rows: ROWS }, head)).kind).toBe('done');
    // Odd chunk sizes split escape sequences and UTF-8 characters across feeds.
    await feedChunked(set, 's', stream.bytes.subarray(head.byteLength), head.byteLength, [1, 7, 333, 4096, 13]);

    const result = await set.run({ op: 'seed', sessionKey: 's', cols: COLS, rows: ROWS }, new Uint8Array(0));
    expect(result).toMatchObject({ kind: 'seed', epoch: 'e', end: stream.bytes.byteLength });
    expect(await paint(seedBytes(result))).toEqual(await paint(stream.bytes));

    // Live output continues the seeded screen exactly.
    const more = diffRenderedAgentStream(SPINNER_ONLY_FRAMES + 25).bytes.subarray(stream.bytes.byteLength);
    expect(await paint(seedBytes(result), more)).toEqual(await paint(stream.bytes, more));
  });

  it('keeps an unfinished control sequence raw, so the rest of it can arrive live', async () => {
    const set = newSet();
    const screen = encode('first line\r\nsecond line\r\n\x1b[1;31mred');
    const cut = screen.byteLength - 6; // after "\x1b[1;", inside "\x1b[1;31m"
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: cut, cols: COLS, rows: ROWS }, screen.subarray(0, cut));
    const result = await set.run({ op: 'seed', sessionKey: 's', cols: COLS, rows: ROWS }, new Uint8Array(0));
    expect(result).toMatchObject({ kind: 'seed', end: cut });
    // The seed ends with the half-read sequence, verbatim.
    expect(Buffer.from(seedBytes(result)).toString('latin1').endsWith('\x1b[1;')).toBe(true);
    expect(await paint(seedBytes(result), screen.subarray(cut))).toEqual(await paint(screen));
  });

  it('applies a geometry change in order with the bytes', async () => {
    const set = newSet();
    const before = encode(`${'x'.repeat(70)}\r\nnarrow soon\r\n`);
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: before.byteLength, cols: COLS, rows: ROWS }, before);
    const after = encode(`${'y'.repeat(50)}\r\n`);
    await set.run({ op: 'feed', sessionKey: 's', epoch: 'e', start: before.byteLength, end: before.byteLength + after.byteLength, cols: 40, rows: 10 }, after);

    const truth = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
    await write(truth, before);
    truth.resize(40, 10);
    await write(truth, after);
    const buffer = truth.buffer.active;
    const expected = Array.from({ length: 10 }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    truth.dispose();

    const result = await set.run({ op: 'seed', sessionKey: 's', cols: 40, rows: 10 }, new Uint8Array(0));
    const painted = new Terminal({ cols: 40, rows: 10, scrollback: 200, allowProposedApi: true });
    await write(painted, seedBytes(result));
    const view = painted.buffer.active;
    expect(Array.from({ length: 10 }, (_, y) => view.getLine(view.baseY + y)?.translateToString(true) ?? '')).toEqual(expected);
    painted.dispose();
  });

  it('refuses a feed that does not continue where the model stopped, and drops the model', async () => {
    const set = newSet();
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: 5, cols: COLS, rows: ROWS }, encode('hello'));
    const gap = await set.run({ op: 'feed', sessionKey: 's', epoch: 'e', start: 6, end: 8, cols: COLS, rows: ROWS }, encode('!!'));
    expect(gap).toMatchObject({ kind: 'unavailable', reason: 'desync' });
    // A model that missed bytes must never seed.
    expect(await set.run({ op: 'seed', sessionKey: 's', cols: COLS, rows: ROWS }, new Uint8Array(0)))
      .toMatchObject({ kind: 'unavailable', reason: 'no-model' });
    expect(set.size).toBe(0);
  });

  it('refuses a feed whose length does not match its range', async () => {
    const set = newSet();
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: 5, cols: COLS, rows: ROWS }, encode('hello'));
    expect(await set.run({ op: 'feed', sessionKey: 's', epoch: 'e', start: 5, end: 9, cols: COLS, rows: ROWS }, encode('!!')))
      .toMatchObject({ kind: 'unavailable', reason: 'desync' });
  });

  it('answers no-model for a session it never saw, and forgets a dropped one', async () => {
    const set = newSet();
    expect(await set.run({ op: 'feed', sessionKey: 'nope', epoch: 'e', start: 0, end: 1, cols: COLS, rows: ROWS }, encode('x')))
      .toMatchObject({ kind: 'unavailable', reason: 'no-model' });
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: 1, cols: COLS, rows: ROWS }, encode('x'));
    expect(set.size).toBe(1);
    expect((await set.run({ op: 'drop', sessionKey: 's' }, new Uint8Array(0))).kind).toBe('done');
    expect(set.size).toBe(0);
  });

  it('rejects a geometry no terminal can have', async () => {
    const set = newSet();
    expect(await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: 1, cols: 0, rows: ROWS }, encode('x')))
      .toMatchObject({ kind: 'unavailable', reason: 'invalid-geometry' });
    expect(set.size).toBe(0);
  });

  it('a reset replaces the previous model of the session', async () => {
    const set = newSet();
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: 3, cols: COLS, rows: ROWS }, encode('old'));
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'f', end: 103, cols: COLS, rows: ROWS }, encode('new'));
    const result = await set.run({ op: 'seed', sessionKey: 's', cols: COLS, rows: ROWS }, new Uint8Array(0));
    expect(result).toMatchObject({ kind: 'seed', epoch: 'f', end: 103 });
    expect((await paint(seedBytes(result))).rows[0]).toBe('new');
    expect(set.size).toBe(1);
  });

  it('trims scrollback to the byte budget but always sends the screen', async () => {
    const set = newSet();
    const lines = encode(Array.from({ length: 400 }, (_, i) => `line ${i} ${'z'.repeat(60)}\r\n`).join(''));
    await set.run({ op: 'reset', sessionKey: 's', epoch: 'e', end: lines.byteLength, cols: COLS, rows: ROWS }, lines);
    const small = seedBytes(await set.run({ op: 'seed', sessionKey: 's', cols: COLS, rows: ROWS, maxBytes: 4096 }, new Uint8Array(0)));
    expect(small.byteLength).toBeLessThanOrEqual(4096);
    expect(await paint(small)).toEqual(await paint(lines));
  });
});
