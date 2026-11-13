import { afterEach, describe, expect, it } from 'vitest';
import { renderTerminalScreenText } from './terminal-screen-text.js';
import { TerminalSnapshotWorker } from './terminal-snapshot-worker.js';
import { redactSpeechSecrets } from '../core/task-speech-summary.js';

const encode = (text: string) => new TextEncoder().encode(text);
const geometry = { cols: 80, rows: 24, maxLines: 40 };

async function text(stream: string, options: Partial<Parameters<typeof renderTerminalScreenText>[1]> = {}): Promise<string> {
  const result = await renderTerminalScreenText(encode(stream), { ...geometry, ...options });
  if (result.kind !== 'text') throw new Error(`unavailable: ${result.reason}`);
  return result.text;
}

describe('renderTerminalScreenText (issue #3683)', () => {
  it('returns a screen that was redrawn many times once', async () => {
    let stream = '';
    for (let i = 0; i < 200; i++) stream += `\x1b[2J\x1b[Hbuilding project\r\nstep ${i % 3}\r\n> waiting`;
    const out = await text(stream);
    expect(out.split('\n').filter((l) => l === 'building project')).toHaveLength(1);
    expect(out).toBe('building project\nstep 1\n> waiting');
  });

  it('leaves no terminal code in the text', async () => {
    const out = await text('\x1b[31mred\x1b[0m \x1b]0;title\x07plain\r\n\x1b[2Kdone');
    expect(out).toBe('red plain\ndone');
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it('keeps a token split by a cursor jump or colours whole on screen, so the redaction hides it', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const jumped = await text(`key: ghp_a1B2c3D4e5F6\x1b[0m\x1b[1mg7H8i9J0k1L2m3N4o5P6q7R8\r\n`);
    expect(jumped).toContain(token);
    expect(redactSpeechSecrets(jumped)).not.toContain(token);
    // A cursor move that puts the second half on screen right after the first.
    const moved = await text(`key: ghp_a1B2c3D4e5F6\x1b[7;1Hignored\x1b[1;22H\x1b[1Dg7H8i9J0k1L2m3N4o5P6q7R8`);
    expect(redactSpeechSecrets(moved)).not.toMatch(/g7H8i9J0k1L2m3N4o5P6q7R8/);
  });

  it('joins a token the terminal wrapped at the screen edge', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const out = await text(`${'x'.repeat(70)} ${token}\r\n`, { cols: 80 });
    expect(out).toContain(token);
    expect(out.split('\n')).toHaveLength(1);
    expect(redactSpeechSecrets(out)).not.toContain(token);
  });

  it('shows a token typed, deleted with backspace and retyped as what is on screen', async () => {
    const out = await text('password: wrong\b\b\b\b\b\x1b[Kghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\r\n');
    expect(out).toBe('password: ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(redactSpeechSecrets(out)).not.toContain('ghp_a1B2c3D4e5F6');
  });

  it('returns only the last lines asked for, scrollback included', async () => {
    const stream = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n');
    const out = await text(stream, { maxLines: 5 });
    expect(out).toBe('line 95\nline 96\nline 97\nline 98\nline 99');
  });

  it('reports an empty stream and bad geometry as unavailable', async () => {
    expect(await renderTerminalScreenText(new Uint8Array(), { ...geometry })).toMatchObject({ kind: 'unavailable', reason: 'empty' });
    expect(await renderTerminalScreenText(encode('x'), { ...geometry, cols: 0 })).toMatchObject({ kind: 'unavailable', reason: 'invalid-geometry' });
  });
});

describe('rendered in the isolating worker', { timeout: 40_000 }, () => {
  const workers: TerminalSnapshotWorker[] = [];
  afterEach(async () => { for (const w of workers.splice(0)) await w.close(); });

  it('renders text in the worker thread', async () => {
    const worker = new TerminalSnapshotWorker(); workers.push(worker);
    let result: Awaited<ReturnType<typeof worker.renderText>> | undefined;
    await (await import('vitest')).vi.waitFor(async () => {
      result = await worker.renderText(encode('hello\r\nworld'), geometry);
      expect(result.kind).toBe('text');
    }, { timeout: 25_000, interval: 200 });
    expect(result).toMatchObject({ kind: 'text', text: 'hello\nworld' });
  });

  it('gives "unavailable", not the raw stream, for a hostile stream that outlasts the deadline', async () => {
    const worker = new TerminalSnapshotWorker(); workers.push(worker);
    // Start the thread first so its cold start is not charged to the tight deadline below.
    await (await import('vitest')).vi.waitFor(async () => {
      expect((await worker.renderText(encode('warm\r\n'), geometry)).kind).toBe('text');
    }, { timeout: 25_000, interval: 200 });
    const poisoned = encode(`${'plain output line\r\n'.repeat(500)}x\x1b[999999999bmore text`);
    const result = await worker.renderText(poisoned, { ...geometry, maxMs: 50, maxQueueWaitMs: 50, sessionKey: 'hostile' });
    expect(result.kind).toBe('unavailable');
    // The worker was ended and a later job starts a fresh one.
    await (await import('vitest')).vi.waitFor(async () => {
      expect((await worker.renderText(encode('again\r\n'), geometry)).kind).toBe('text');
    }, { timeout: 25_000, interval: 200 });
  });
});
