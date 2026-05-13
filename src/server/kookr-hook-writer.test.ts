// Tests the bundled hook writer at bin/kookr-hook-writer.js. Lives under
// src/server/ so it picks up the regular test glob; the script under test is
// a pure-ESM JavaScript file shipped alongside the other bin/ scripts.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module without bundled types; runtime contract is the public API surface.
import { appendRecord } from '../../bin/kookr-hook-writer.js';

describe('kookr-hook-writer.appendRecord', () => {
  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), 'kookr-hook-writer-'));
  }

  it('writes one newline-terminated record when payload lacks trailing newline', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'hooks.jsonl');
      await appendRecord(file, '{"session_id":"a"}');
      expect(readFileSync(file, 'utf8')).toBe('{"session_id":"a"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an existing trailing newline rather than doubling it', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'hooks.jsonl');
      await appendRecord(file, '{"session_id":"a"}\n');
      expect(readFileSync(file, 'utf8')).toBe('{"session_id":"a"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes large concurrent writes into valid newline-delimited records', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'hooks.jsonl');
      // Force payloads above the 4096-byte PIPE_BUF atomic-append threshold
      // so plain O_APPEND would interleave without the writer's lock.
      const big = (id: string) => JSON.stringify({ session_id: id, payload: 'x'.repeat(8000) });
      const ids = ['p1', 'c1', 'c2', 'c3', 'c4'];
      await Promise.all(ids.map((id) => appendRecord(file, big(id))));

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(ids.length);
      const seen = new Set<string>();
      for (const line of lines) {
        const parsed = JSON.parse(line) as { session_id: string };
        seen.add(parsed.session_id);
      }
      expect([...seen].sort()).toEqual([...ids].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
