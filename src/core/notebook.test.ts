import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addEntry,
  assertSafeRole,
  dedupKey,
  entryId,
  logUsage,
  maxChars,
  merge,
  readEntries,
  remove,
  render,
  sanitizeLesson,
  stats,
  vote,
} from './notebook.js';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-'));
});
afterEach(() => {
  for (const k of ['NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_USAGE_RING', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S', 'NB_SILENT_H', 'NB_ERR_MIN', 'NB_ERR_RATE']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('add / read / render', () => {
  test('adds a lesson and reads it back with score +1', async () => {
    const r = await addEntry(dir, 'patcher', 'prefer execFileSync, array args');
    expect(r.added).toBe(true);
    expect(r.size).toBe(1);
    const entries = readEntries(dir, 'patcher');
    expect(entries).toEqual([{ score: 1, text: 'prefer execFileSync, array args' }]);
  });

  test('persists on disk as "<score>\\t<lesson>"', async () => {
    await addEntry(dir, 'patcher', 'run pnpm lint before done');
    const raw = readFileSync(join(dir, 'patcher.md'), 'utf-8');
    expect(raw).toBe('+1\trun pnpm lint before done\n');
  });

  test('render shows a stable id + score, highest score first', async () => {
    await addEntry(dir, 'v', 'aaa');
    await addEntry(dir, 'v', 'bbb');
    await vote(dir, 'v', 'bbb', 1); // bbb -> +2, ranks first
    const out = render(dir, 'v');
    expect(out.split('\n')[0]).toBe(`${entryId('bbb')}  [+2]  bbb`);
    expect(out.split('\n')[1]).toBe(`${entryId('aaa')}  [+1]  aaa`);
  });

  test('empty notebook renders a friendly message', () => {
    expect(render(dir, 'nobody')).toContain('is empty');
  });
});

describe('dedup', () => {
  test('skips a near-identical lesson (case/punctuation-insensitive)', async () => {
    await addEntry(dir, 'c', 'Prefer execFileSync, array args.');
    const r = await addEntry(dir, 'c', 'prefer execfilesync array args');
    expect(r.added).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(readEntries(dir, 'c')).toHaveLength(1);
  });

  test('dedupKey normalizes case, punctuation, whitespace', () => {
    expect(dedupKey('Use   execFileSync!!')).toBe(dedupKey('use execfilesync'));
  });

  test('distinct lessons are both kept', async () => {
    await addEntry(dir, 'c', 'lesson one');
    await addEntry(dir, 'c', 'lesson two');
    expect(readEntries(dir, 'c')).toHaveLength(2);
  });
});

describe('caps', () => {
  test('sanitizeLesson collapses to one line but does NOT truncate', () => {
    process.env.NB_MAX_CHARS = '20';
    const s = sanitizeLesson('this is\n a very   long\tlesson that exceeds the cap by a lot');
    expect(s).not.toContain('\n');
    expect(s).not.toContain('\t');
    expect(s.length).toBeGreaterThan(20); // full length preserved, not cut to the cap
    expect(maxChars()).toBe(20);
  });

  test('rejects an over-length lesson instead of truncating it', async () => {
    process.env.NB_MAX_CHARS = '30';
    const r = await addEntry(dir, 'c', 'x'.repeat(50));
    expect(r.added).toBe(false);
    expect(r.reason).toBe('too-long');
    expect(r.length).toBe(50);
    expect(readEntries(dir, 'c')).toHaveLength(0); // nothing stored
    const ok = await addEntry(dir, 'c', 'y'.repeat(30)); // exactly at the cap
    expect(ok.added).toBe(true);
    expect(readEntries(dir, 'c')[0].text).toHaveLength(30); // stored in full
  });

  test('evicts the LOWEST-scored line when full (ties: oldest)', async () => {
    process.env.NB_MAX_LINES = '3';
    await addEntry(dir, 'r', 'oldest');   // +1
    await addEntry(dir, 'r', 'middle');   // +1
    await addEntry(dir, 'r', 'useful');   // +1
    await vote(dir, 'r', 'useful', 1);    // useful -> +2
    const r = await addEntry(dir, 'r', 'newcomer'); // now 4 > cap 3 -> evict lowest, ties oldest
    expect(r.evicted?.text).toBe('oldest'); // +1 tie with 'middle', 'oldest' is older
    const texts = readEntries(dir, 'r').map((e) => e.text).sort();
    expect(texts).toEqual(['middle', 'newcomer', 'useful']);
  });

  test('a downvoted line is evicted before useful ones', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'harmful');
    await addEntry(dir, 'r', 'good');
    await vote(dir, 'r', 'harmful', -1); // harmful -> 0
    await vote(dir, 'r', 'good', 1);     // good -> +2
    const r = await addEntry(dir, 'r', 'fresh'); // evict lowest = harmful(0)
    expect(r.evicted?.text).toBe('harmful');
    expect(readEntries(dir, 'r').map((e) => e.text).sort()).toEqual(['fresh', 'good']);
  });

  test('rejects a new lesson when full and every entry outranks it', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'alpha');
    await addEntry(dir, 'r', 'bravo');
    await vote(dir, 'r', 'alpha', 1);
    await vote(dir, 'r', 'bravo', 1); // both +2 (non-hex substrings, unambiguous)
    const res = await addEntry(dir, 'r', 'charlie'); // +1 is the strict lowest -> not stored
    expect(res.added).toBe(false);
    expect(res.reason).toBe('rejected-full');
    expect(readEntries(dir, 'r').map((e) => e.text).sort()).toEqual(['alpha', 'bravo']);
  });
});

describe('vote', () => {
  test('votes by stable id and by substring query', async () => {
    await addEntry(dir, 'v', 'alpha lesson');
    await addEntry(dir, 'v', 'beta lesson');
    const byQuery = await vote(dir, 'v', 'alpha', 1); // unique substring
    expect(byQuery.score).toBe(2);
    const r = await vote(dir, 'v', entryId('alpha lesson'), 1); // by stable id
    expect(r.text).toBe('alpha lesson');
    expect(r.score).toBe(3);
  });

  test('a stable id keeps pointing at the same entry after reordering (regression)', async () => {
    await addEntry(dir, 'v', 'alpha'); // file index 0
    await addEntry(dir, 'v', 'beta'); // file index 1
    const idBeta = entryId('beta');
    await vote(dir, 'v', idBeta, 1); // beta -> +2 (now ranks first)
    await vote(dir, 'v', idBeta, 1); // same id still hits beta despite the reorder -> +3
    expect(readEntries(dir, 'v').find((e) => e.text === 'beta')!.score).toBe(3);
    expect(readEntries(dir, 'v').find((e) => e.text === 'alpha')!.score).toBe(1); // untouched
  });

  test('an id prefix shorter than the full id still resolves when unique', async () => {
    await addEntry(dir, 'v', 'solo lesson');
    const full = entryId('solo lesson');
    const r = await vote(dir, 'v', full.slice(0, 2), 1); // 2-char unique prefix
    expect(r.text).toBe('solo lesson');
    expect(r.score).toBe(2);
  });

  test('a hex-looking word falls through to a text match when it is not an id', async () => {
    await addEntry(dir, 'v', 'dead letter queue retries thrice'); // "dead" is hex but a real word here
    await addEntry(dir, 'v', 'unrelated note');
    const r = await vote(dir, 'v', 'dead', 1); // not an id prefix (6-hex) -> resolves as substring
    expect(r.text).toBe('dead letter queue retries thrice');
    expect(r.score).toBe(2);
  });

  test('an ambiguous selector refuses and mutates nothing (never a wrong-lesson vote)', async () => {
    await addEntry(dir, 'v', 'widget cache warm path');
    await addEntry(dir, 'v', 'widget cache cold path');
    await expect(vote(dir, 'v', 'widget', 1)).rejects.toThrow(/matches 2/);
    // the error must also LIST the candidate ids so the agent can disambiguate by id
    await expect(vote(dir, 'v', 'widget', 1)).rejects.toThrow(new RegExp(entryId('widget cache warm path')));
    expect(readEntries(dir, 'v').every((e) => e.score === 1)).toBe(true); // both untouched
  });

  test('a failed vote lists candidate ids so the agent can retry by id', async () => {
    await addEntry(dir, 'v', 'use npm ci --ignore-scripts after lockfile regen');
    await addEntry(dir, 'v', 'diff lockfile vs origin/main for dropped deps');
    // agent guesses a topic word absent from the stored text -> no match, but the
    // error must surface the real entries' ids so it can re-vote correctly.
    await expect(vote(dir, 'v', 'lint', 1)).rejects.toThrow(
      new RegExp(entryId('use npm ci --ignore-scripts after lockfile regen')),
    );
  });

  test('downvote lowers score', async () => {
    await addEntry(dir, 'v', 'x');
    const r = await vote(dir, 'v', 'x', -1);
    expect(r.score).toBe(0);
  });

  test('rejects a delta other than +1/-1', async () => {
    await addEntry(dir, 'v', 'x');
    await expect(vote(dir, 'v', 'x', 2)).rejects.toThrow(/\+1 or -1/);
  });

  test('ambiguous query throws, no match throws', async () => {
    await addEntry(dir, 'v', 'shared token one');
    await addEntry(dir, 'v', 'shared token two');
    await expect(vote(dir, 'v', 'shared', 1)).rejects.toThrow(/matches 2/);
    await expect(vote(dir, 'v', 'zzz', 1)).rejects.toThrow(/no entry matches/);
  });
});

describe('merge', () => {
  test('consolidates two entries into one, inheriting the higher score', async () => {
    await addEntry(dir, 'm', 'tests live in __tests__');
    await addEntry(dir, 'm', 'run vitest for a single file');
    await vote(dir, 'm', 'vitest', 1); // that one -> +2
    const r = await merge(dir, 'm', entryId('tests live in __tests__'), 'vitest', 'tests: __tests__, pnpm vitest run <file>');
    expect(r.added).toBe(true);
    const entries = readEntries(dir, 'm');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('tests: __tests__, pnpm vitest run <file>');
    expect(entries[0].score).toBe(2); // max(+1, +2)
  });

  test('refuses to merge an entry with itself', async () => {
    await addEntry(dir, 'm', 'only one');
    const id = entryId('only one');
    await expect(merge(dir, 'm', id, id, 'x')).rejects.toThrow(/two different/);
  });

  test('rejects an over-length merged lesson and leaves both source entries intact', async () => {
    process.env.NB_MAX_CHARS = '30';
    await addEntry(dir, 'm', 'alpha');
    await addEntry(dir, 'm', 'beta');
    await expect(merge(dir, 'm', entryId('alpha'), entryId('beta'), 'z'.repeat(50))).rejects.toThrow(/max is 30/);
    expect(readEntries(dir, 'm').map((e) => e.text).sort()).toEqual(['alpha', 'beta']); // nothing mutated
  });
});

describe('rm', () => {
  test('removes an entry by substring', async () => {
    await addEntry(dir, 'd', 'keep me');
    await addEntry(dir, 'd', 'delete me');
    const r = await remove(dir, 'd', 'delete');
    expect(r.text).toBe('delete me');
    expect(readEntries(dir, 'd').map((e) => e.text)).toEqual(['keep me']);
  });

  test('removes an entry by its stable id', async () => {
    await addEntry(dir, 'd', 'keep this one');
    await addEntry(dir, 'd', 'drop this one');
    const r = await remove(dir, 'd', entryId('drop this one'));
    expect(r.text).toBe('drop this one');
    expect(readEntries(dir, 'd').map((e) => e.text)).toEqual(['keep this one']);
  });
});

describe('role safety', () => {
  test('rejects path-traversal and unsafe role names', () => {
    expect(() => assertSafeRole('../etc/passwd')).toThrow();
    expect(() => assertSafeRole('a/b')).toThrow();
    expect(() => assertSafeRole('')).toThrow();
    expect(() => assertSafeRole('patcher')).not.toThrow();
    expect(() => assertSafeRole('cartographer@kookr-ai-kookr')).not.toThrow();
  });
});

describe('usage log + stats', () => {
  test('logUsage appends and stats rolls up per command', () => {
    logUsage(dir, 'p', 'add', true, 5);
    logUsage(dir, 'p', 'add', true, 7);
    logUsage(dir, 'p', 'vote', false, 3);
    const rep = stats(dir, { now: Date.now() });
    expect(rep.totalCalls).toBe(3);
    const add = rep.perCommand.find((c) => c.command === 'add')!;
    expect(add.calls).toBe(2);
    const voteStat = rep.perCommand.find((c) => c.command === 'vote')!;
    expect(voteStat.errors).toBe(1);
    expect(voteStat.errorRate).toBe(1);
  });

  test('usage log is a bounded ring (oldest dropped)', () => {
    process.env.NB_USAGE_RING = '100';
    for (let i = 0; i < 150; i++) logUsage(dir, 'p', 'show', true, 1);
    const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(100);
  });

  test('flags a loop anomaly (many calls in a tight window)', () => {
    process.env.NB_LOOP_N = '5';
    process.env.NB_LOOP_WINDOW_S = '60';
    const base = Date.parse('2026-10-23T10:00:00Z');
    const rows = Array.from({ length: 6 }, (_, i) =>
      `${new Date(base + i * 5000).toISOString()}\tpatcher\tadd\tok\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now: base + 60_000 });
    expect(rep.anomalies.some((a) => a.kind === 'loop' && a.command === 'add')).toBe(true);
  });

  test('flags a went-silent anomaly (used historically, silent recently)', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const old = new Date(now - 100 * 3600_000).toISOString(); // 100h ago
    writeFileSync(join(dir, '.nb-usage.log'), `${old}\tp\tmerge\tok\t4ms\n`, 'utf-8');
    const rep = stats(dir, { now, windowMs: 48 * 3600_000 }); // merge not in window
    expect(rep.anomalies.some((a) => a.kind === 'went-silent' && a.command === 'merge')).toBe(true);
  });

  test('flags a high-error-rate anomaly', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    const rows: string[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(`${new Date(now - i * 1000).toISOString()}\tp\tvote\t${i < 4 ? 'err' : 'ok'}\t2ms`);
    }
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    expect(rep.anomalies.some((a) => a.kind === 'high-error-rate' && a.command === 'vote')).toBe(true);
  });

  test('no anomalies on quiet, healthy usage', () => {
    logUsage(dir, 'p', 'show', true, 1);
    logUsage(dir, 'p', 'add', true, 2);
    const rep = stats(dir, { now: Date.now() });
    expect(rep.anomalies).toHaveLength(0);
  });

  test('labels a sub-hour window in minutes (not rounded to 1h)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const rep = stats(dir, { now: Date.now(), windowMs: 30 * 60_000 });
    expect(rep.window).toBe('30m');
  });

  test('a malformed NB_ERR_RATE falls back to the default, not NaN (which would disable detection)', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = 'abc';
    const now = Date.now();
    const rows: string[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(`${new Date(now - i * 1000).toISOString()}\tp\tvote\t${i < 4 ? 'err' : 'ok'}\t2ms`);
    }
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    expect(rep.anomalies.some((a) => a.kind === 'high-error-rate')).toBe(true);
  });
});

describe('core smoke (full learn cycle)', () => {
  test('a full learn cycle leaves a consistent file', async () => {
    await addEntry(dir, 'cartographer', 'tests: pnpm vitest run <file>');
    await addEntry(dir, 'cartographer', 'app entry: src/index.ts');
    await vote(dir, 'cartographer', 'tests', 1);
    expect(existsSync(join(dir, 'cartographer.md'))).toBe(true);
    const entries = readEntries(dir, 'cartographer');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.text.startsWith('tests'))!.score).toBe(2);
  });
});
