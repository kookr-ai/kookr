import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildShelfLessonsSection, SHELF_TRUNCATION_MARKER } from './opencode-shelf-memory.js';

const fake = (shelves: Record<string, string | Error>) => async (shelf: string) => {
  const v = shelves[shelf];
  if (v instanceof Error) throw v;
  if (v === undefined) throw new Error('no such shelf');
  return v;
};

describe('buildShelfLessonsSection', () => {
  it('includes only the requested shelves', async () => {
    const show = vi.fn(fake({ a: 'lesson A-1111', b: 'lesson B-2222' }));
    const out = await buildShelfLessonsSection(['a'], { show });
    expect(out).toContain('## Lessons from your shelves');
    expect(out).toContain('### a');
    expect(out).toContain('A-1111');
    expect(out).not.toContain('B-2222');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('is fail-open: missing shelves/timeouts are skipped, none => empty string', async () => {
    const warn = vi.fn();
    expect(await buildShelfLessonsSection(['ghost'], { show: fake({}), warn })).toBe('');
    expect(warn).toHaveBeenCalled();
    const out = await buildShelfLessonsSection(['ghost', 'a'], { show: fake({ a: 'ok-1' }), warn });
    expect(out).toContain('ok-1');
    expect(out).not.toContain('ghost\n');
    expect(await buildShelfLessonsSection([], { show: fake({}) })).toBe('');
    expect(await buildShelfLessonsSection(['e'], { show: fake({ e: '  \n' }) })).toBe('');
  });

  it('truncates a long shelf at a line boundary with a marker', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i} ${'x'.repeat(40)}`).join('\n');
    const out = await buildShelfLessonsSection(['big'], { show: fake({ big: lines }), perShelfMaxBytes: 1000 });
    expect(out).toContain(SHELF_TRUNCATION_MARKER);
    expect(out).toContain('line-0 ');
    expect(out).not.toContain('line-399');
    expect(Buffer.byteLength(out)).toBeLessThan(1000 + 600);
  });

  it('keeps the highest-scored AND the newest lessons of an oversized shelf, with a shelf-named marker', async () => {
    const lesson = (id: string, score: number, label: string) => `${id}  [${score >= 0 ? '+' : ''}${score}]  ${label} ${'z'.repeat(80)}`;
    const old = Array.from({ length: 60 }, (_, i) => lesson(`a${String(i).padStart(5, '0')}`, i < 10 ? 5 : 1, `OLD-${i}`));
    const listing = ['# desc: big shelf', ...old, lesson('f00001', 1, 'NEWEST-CANARY'), lesson('f00002', -1, 'DOWNVOTED'), '# vote by id: nb vote big <id> +1|-1'].join('\n');
    const out = await buildShelfLessonsSection(['big'], { show: fake({ big: listing }), perShelfMaxBytes: 3000 });
    expect(out).toContain('# desc: big shelf');
    expect(out).toContain('OLD-0 '); // top-scored head survives
    expect(out).toContain('NEWEST-CANARY'); // newest score-1 lesson survives
    expect(out).not.toContain('DOWNVOTED');
    expect(out).not.toContain('OLD-30 ');
    expect(out).toMatch(/\[\.\.\. truncated: \d+ of 62 lessons omitted .* run `nb show big` for the rest \.\.\.\]/);
    expect(Buffer.byteLength(out)).toBeLessThan(3000 + 600);
  });

  it('does not alter a shelf that fits the cap', async () => {
    const listing = ['# desc: d', 'a00001  [+2]  one', 'b00002  [+1]  two', '# vote by id: x'].join('\n');
    const out = await buildShelfLessonsSection(['small'], { show: fake({ small: listing }) });
    expect(out).toContain(listing);
    expect(out).not.toContain('truncated');
  });

  it('real nb: a planted newest lesson on a large shelf reaches the injected text', async () => {
    let nbOk = true;
    try { execFileSync('nb', ['--version'], { stdio: 'ignore' }); } catch { nbOk = false; }
    if (!nbOk) return;
    const dir = mkdtempSync(join(tmpdir(), 'oc-nb-big-'));
    try {
      const env = { ...process.env, NB_DIR: dir };
      for (let i = 0; i < 25; i += 1) execFileSync('nb', ['add', 'bigshelf', `filler lesson number ${i} ${'q'.repeat(90)} ${i}`], { env });
      const ids = execFileSync('nb', ['show', 'bigshelf', '--json'], { env, encoding: 'utf8' });
      const first = (JSON.parse(ids) as { entries: Array<{ id: string }> }).entries.slice(0, 5).map((e) => e.id).join(',');
      execFileSync('nb', ['vote', 'bigshelf', first, '+1'], { env });
      execFileSync('nb', ['add', 'bigshelf', 'PLANTED-CANARY newest lesson'], { env });
      const out = await buildShelfLessonsSection(['bigshelf'], { env, perShelfMaxBytes: 1500 });
      expect(out).toContain('PLANTED-CANARY');
      expect(out).toContain('run `nb show bigshelf` for the rest');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces the total budget across shelves', async () => {
    const big = 'y'.repeat(900);
    const out = await buildShelfLessonsSection(['a', 'b', 'c'], { show: fake({ a: big, b: big, c: 'C-LAST' }), perShelfMaxBytes: 1000, totalMaxBytes: 1200 });
    expect(out.match(new RegExp(SHELF_TRUNCATION_MARKER.replace(/[[\]`.*]/g, '\\$&'), 'g'))!.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('C-LAST');
  });

  it('missing nb binary is fail-open (real exec path)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'oc-nonb-'));
    try {
      expect(await buildShelfLessonsSection(['a'], { env: { PATH: empty } })).toBe('');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('with real nb and two temp shelves, each profile sees only its own marker', async () => {
    let nbOk = true;
    try { execFileSync('nb', ['--version'], { stdio: 'ignore' }); } catch { nbOk = false; }
    if (!nbOk) return; // nb not installed on this host
    const dir = mkdtempSync(join(tmpdir(), 'oc-nb-'));
    try {
      const env = { ...process.env, NB_DIR: dir };
      execFileSync('nb', ['add', 'shelf-alpha', 'alpha lesson MARK-ALPHA-1'], { env });
      execFileSync('nb', ['add', 'shelf-beta', 'beta lesson MARK-BETA-2'], { env });
      const a = await buildShelfLessonsSection(['shelf-alpha'], { env });
      expect(a).toContain('MARK-ALPHA-1');
      expect(a).not.toContain('MARK-BETA-2');
      const b = await buildShelfLessonsSection(['shelf-beta'], { env });
      expect(b).toContain('MARK-BETA-2');
      expect(b).not.toContain('MARK-ALPHA-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
