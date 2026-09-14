import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRecentRelayLogs } from './relay-log-reader.js';
import { redactRelaySecret } from './relay-secret-redaction.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const CHUNK_BYTES = 64 * 1024;

function previousResult(text: string, maxLines = 80): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(redactRelaySecret);
}

describe('readRecentRelayLogs', () => {
  let directory: string;
  let logPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-log-reader-'));
    logPath = join(directory, 'relay.log');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('reads only bounded suffix chunks from a multi-megabyte log', async () => {
    const text = '[relay] historical connection\n'.repeat(350_000)
      + Array.from({ length: 150 }, (_, i) => `recent ${i}\r\n\n`).join('')
      + 'final unterminated line';
    await writeFile(logPath, text);
    const handle = await open(logPath, 'r');
    vi.mocked(open).mockResolvedValueOnce(handle);
    const read = vi.spyOn(handle, 'read');
    const close = vi.spyOn(handle, 'close');

    expect(await readRecentRelayLogs(logPath, 30)).toEqual(previousResult(text, 30));
    expect(readFile).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
    let requestedBytes = 0;
    for (const [{ buffer, length = 0, position } = {}] of read.mock.calls) {
      expect(buffer?.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(length).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(position).toBeGreaterThan(0);
      requestedBytes += length;
    }
    expect(requestedBytes).toBeLessThanOrEqual(CHUNK_BYTES * 2);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([undefined, 1, 120, 200, 0, -2, 2.9, Number.NaN, Infinity])(
    'preserves the default and slice semantics for limit %s', async (limit) => {
      const text = Array.from({ length: 130 }, (_, i) => `line ${i}\n`).join('');
      await writeFile(logPath, text);
      expect(await readRecentRelayLogs(logPath, limit)).toEqual(previousResult(text, limit));
    },
  );

  it.each(['', '\n\r\n\n', 'first\r\n\r\n \n\t\nlast\r', 'first\nlast'])(
    'preserves empty lines, whitespace, and unterminated line semantics: %j', async (text) => {
      await writeFile(logPath, text);
      expect(await readRecentRelayLogs(logPath)).toEqual(previousResult(text));
    },
  );

  it('decodes UTF-8 characters and CRLF split across chunk boundaries', async () => {
    for (const [prefix, suffix] of [
      ['first\r', '\n' + 'x'.repeat(CHUNK_BYTES - 1)],
      ['first é', 'x'.repeat(CHUNK_BYTES - 1)],
      ...[1, 2, 3].map((bytes) => ['first 🙂', 'x'.repeat(CHUNK_BYTES - bytes)]),
    ]) {
      const text = prefix + suffix;
      await writeFile(logPath, text);
      expect(await readRecentRelayLogs(logPath)).toEqual(previousResult(text));
    }
  });

  it('skips multiple chunks of blank lines and preserves a line longer than a chunk', async () => {
    const text = 'older\n' + 'é🙂'.repeat(CHUNK_BYTES) + '\r\n'
      + '\r\n'.repeat(CHUNK_BYTES) + 'latest';
    await writeFile(logPath, text);
    expect(await readRecentRelayLogs(logPath, 2)).toEqual(previousResult(text, 2));
  });

  it('redacts secrets after reassembling a line split across chunks', async () => {
    const text = 'older\nKOOKR_RELAY_TOKEN=test-token-1234\nAuthorization: Bearer test-secret-1234 '
      + 'x'.repeat(CHUNK_BYTES - 7);
    await writeFile(logPath, text);
    const result = await readRecentRelayLogs(logPath, 2);
    expect(result).toEqual(previousResult(text, 2));
    expect(result.join('\n')).not.toContain('test-secret-1234');
    expect(result.join('\n')).not.toContain('test-token-1234');
  });

  it('returns an empty result for missing or unreadable files', async () => {
    expect(await readRecentRelayLogs(logPath)).toEqual([]);
    await writeFile(logPath, 'readable');
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await readRecentRelayLogs(logPath)).toEqual([]);
    expect(await readRecentRelayLogs(directory)).toEqual([]);
  });

  it('closes the file when a chunk read fails', async () => {
    await writeFile(logPath, 'line');
    const handle = await open(logPath, 'r');
    vi.mocked(open).mockResolvedValueOnce(handle);
    vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failed'));
    const close = vi.spyOn(handle, 'close');
    expect(await readRecentRelayLogs(logPath)).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('fills short reads before decoding the chunk', async () => {
    const text = 'first\r\nsecond é🙂\nlast';
    await writeFile(logPath, text);
    const handle = await open(logPath, 'r');
    vi.mocked(open).mockResolvedValueOnce(handle);
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation((options) =>
      originalRead({ ...options, length: Math.min(options?.length ?? 0, 3) }));
    expect(await readRecentRelayLogs(logPath)).toEqual(previousResult(text));
  });

  it('closes the file and returns no partial output if it is truncated during a read', async () => {
    await writeFile(logPath, 'older\n' + '\n'.repeat(CHUNK_BYTES) + 'latest');
    const handle = await open(logPath, 'r');
    vi.mocked(open).mockResolvedValueOnce(handle);
    const originalRead = handle.read.bind(handle);
    const read = vi.spyOn(handle, 'read')
      .mockImplementationOnce((options) => originalRead(options))
      .mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
    const close = vi.spyOn(handle, 'close');
    expect(await readRecentRelayLogs(logPath)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
