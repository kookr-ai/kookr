// Tests the bundled hook writer at bin/kookr-hook-writer.js. Lives under
// src/server/ so it picks up the regular test glob; the script under test is
// a pure-ESM JavaScript file shipped alongside the other bin/ scripts.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module without bundled types; runtime contract is the public API surface.
import { appendRecord, resolveRotationConfig, rotateHookFile } from '../../bin/kookr-hook-writer.js';

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

describe('kookr-hook-writer rotation (issue #1433)', () => {
  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), 'kookr-hook-writer-rot-'));
  }

  function records(file: string): string[] {
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  }

  it('caps the active file and rolls overflow into numbered generations', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      // ~120-byte records with a 512-byte cap → rotates every few writes.
      const rec = (n: number) => JSON.stringify({ session_id: 'kookr-abc', n, pad: 'x'.repeat(90) });
      const total = 40;
      for (let n = 0; n < total; n += 1) {
        await appendRecord(file, rec(n), { maxBytes: 512, keep: 4 });
      }

      // The active file never exceeds the cap.
      expect(statSync(file).size).toBeLessThanOrEqual(512);

      // No record is lost or duplicated across the base + retained generations.
      const all = [
        ...records(file),
        ...records(`${file}.1`),
        ...records(`${file}.2`),
        ...records(`${file}.3`),
        ...records(`${file}.4`),
      ];
      const ns = all.map((line) => (JSON.parse(line) as { n: number }).n).sort((a, b) => a - b);
      // The retained records form a CONTIGUOUS tail ending at the newest write:
      // rotation may drop the oldest generations, but it must never punch a hole
      // in the middle (an off-by-one in the rename shift would).
      expect(ns.length).toBeGreaterThan(0);
      expect(ns[ns.length - 1]).toBe(total - 1);
      expect(ns).toEqual(Array.from({ length: ns.length }, (_v, i) => ns[0] + i));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains at most `keep` rotated generations (bounded disk)', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      const rec = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(200) });
      for (let n = 0; n < 60; n += 1) {
        await appendRecord(file, rec(n), { maxBytes: 256, keep: 2 });
      }
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(existsSync(`${file}.2`)).toBe(true);
      // Nothing beyond the keep window survives.
      expect(existsSync(`${file}.3`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-caps to a single generation when keep is 0', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      const rec = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(200) });
      for (let n = 0; n < 10; n += 1) {
        await appendRecord(file, rec(n), { maxBytes: 256, keep: 0 });
      }
      // With no retained generations, rotation deletes the active file outright
      // rather than renaming it — only the newest record survives, and no
      // numbered generation is ever created.
      expect(existsSync(`${file}.1`)).toBe(false);
      const active = records(file);
      expect(active.length).toBeGreaterThan(0);
      expect((JSON.parse(active[active.length - 1]) as { n: number }).n).toBe(9);
      expect(statSync(file).size).toBeLessThanOrEqual(256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never drops a single record larger than the cap', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      const huge = JSON.stringify({ session_id: 'kookr-abc', pad: 'y'.repeat(2000) });
      await appendRecord(file, 'seed', { maxBytes: 256, keep: 2 });
      await appendRecord(file, huge, { maxBytes: 256, keep: 2 });
      // The oversized record lands in its own fresh generation, intact.
      const active = records(file);
      expect(active).toHaveLength(1);
      expect(JSON.parse(active[0])).toMatchObject({ session_id: 'kookr-abc' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables rotation when maxBytes <= 0 (legacy pure-append)', async () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      for (let n = 0; n < 20; n += 1) {
        await appendRecord(file, JSON.stringify({ n, pad: 'z'.repeat(200) }), { maxBytes: 0 });
      }
      expect(existsSync(`${file}.1`)).toBe(false);
      expect(records(file)).toHaveLength(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveRotationConfig honors explicit options over env over defaults', () => {
    expect(resolveRotationConfig({ maxBytes: 123, keep: 7 })).toEqual({ maxBytes: 123, keep: 7 });
    const prevMax = process.env.KOOKR_HOOK_MAX_BYTES;
    const prevKeep = process.env.KOOKR_HOOK_ROTATE_KEEP;
    try {
      process.env.KOOKR_HOOK_MAX_BYTES = '999';
      process.env.KOOKR_HOOK_ROTATE_KEEP = '3';
      expect(resolveRotationConfig()).toEqual({ maxBytes: 999, keep: 3 });
    } finally {
      if (prevMax === undefined) delete process.env.KOOKR_HOOK_MAX_BYTES;
      else process.env.KOOKR_HOOK_MAX_BYTES = prevMax;
      if (prevKeep === undefined) delete process.env.KOOKR_HOOK_ROTATE_KEEP;
      else process.env.KOOKR_HOOK_ROTATE_KEEP = prevKeep;
    }
    // Defaults are a positive cap with several retained generations.
    const def = resolveRotationConfig();
    expect(def.maxBytes).toBeGreaterThan(0);
    expect(def.keep).toBeGreaterThan(0);
  });

  it('resolveRotationConfig treats empty/whitespace/non-numeric env as unset (not 0)', () => {
    const prevMax = process.env.KOOKR_HOOK_MAX_BYTES;
    const prevKeep = process.env.KOOKR_HOOK_ROTATE_KEEP;
    try {
      // `Number('')` is 0; an empty override must NOT silently disable rotation
      // or hard-truncate history — it falls back to the defaults instead.
      process.env.KOOKR_HOOK_MAX_BYTES = '';
      process.env.KOOKR_HOOK_ROTATE_KEEP = '   ';
      const empty = resolveRotationConfig();
      expect(empty.maxBytes).toBeGreaterThan(0);
      expect(empty.keep).toBeGreaterThan(0);

      process.env.KOOKR_HOOK_MAX_BYTES = 'not-a-number';
      expect(resolveRotationConfig().maxBytes).toBeGreaterThan(0);
    } finally {
      if (prevMax === undefined) delete process.env.KOOKR_HOOK_MAX_BYTES;
      else process.env.KOOKR_HOOK_MAX_BYTES = prevMax;
      if (prevKeep === undefined) delete process.env.KOOKR_HOOK_ROTATE_KEEP;
      else process.env.KOOKR_HOOK_ROTATE_KEEP = prevKeep;
    }
  });

  it('rotateHookFile shifts generations and drops the oldest beyond keep', () => {
    const dir = makeTmp();
    try {
      const file = join(dir, 'kookr-abc.jsonl');
      writeFileSync(file, 'gen0\n');
      rotateHookFile(file, 2); // gen0 -> .1
      writeFileSync(file, 'gen1\n');
      rotateHookFile(file, 2); // gen1 -> .1, prior .1 -> .2
      writeFileSync(file, 'gen2\n');
      rotateHookFile(file, 2); // gen2 -> .1, prior .1 -> .2, prior .2 dropped
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('gen2\n');
      expect(readFileSync(`${file}.2`, 'utf8')).toBe('gen1\n');
      expect(existsSync(`${file}.3`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
