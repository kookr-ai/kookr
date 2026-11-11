import { afterEach, describe, expect, test } from 'vitest';
import { applyMove, cloneStore, decideStep, dedupKey, entryId, exactKey, maxLines, predictMove, shelfNameProblem } from './nb-sim.mjs';
import { createNbClient, nbMove, readShelf, reapZeroByteShelf, readFileOrderIds } from './nb-client.mjs';
import { RAW_NB, cleanEnv, destroy, makeStore, readLessons, writeShelf, type Lesson } from './nb-test-helpers';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mk = (id: string, score: number, text = id) => ({ id, score, text });

describe('shelfNameProblem', () => {
  test('accepts ordinary and odd-but-valid names', () => {
    for (const n of ['code-review@kookr-ai-kookr', 'a@b@c', 'a@@c', 'Code-Review@Kookr-AI-Kookr']) {
      expect(shelfNameProblem(n), n).toBeNull();
    }
  });
  test('rejects over 128 chars, bad characters, reserved names', () => {
    expect(shelfNameProblem('x'.repeat(129))).toMatch(/too long/);
    expect(shelfNameProblem('x'.repeat(128))).toBeNull();
    expect(shelfNameProblem('bad name')).toMatch(/invalid characters/);
    expect(shelfNameProblem('a..b')).toMatch(/invalid characters/);
    expect(shelfNameProblem('README')).toMatch(/reserved/);
    expect(shelfNameProblem('nul')).toMatch(/reserved/);
  });
});

describe('keys', () => {
  test('dedupKey ignores case and punctuation; exactKey only case and whitespace', () => {
    expect(dedupKey('Run  tests, THEN build!')).toBe(dedupKey('run tests then build'));
    expect(exactKey('  Run   tests\tthen build ')).toBe('run tests then build');
    expect(exactKey('run tests, then build')).not.toBe(exactKey('run tests then build'));
  });
  test('entryId is 6 hex chars and stable across case/punctuation', () => {
    expect(entryId('Hello, World')).toMatch(/^[0-9a-f]{6}$/);
    expect(entryId('Hello, World')).toBe(entryId('hello world'));
  });
  test('maxLines honors NB_MAX_LINES with nb clamping', () => {
    expect(maxLines({})).toBe(50);
    expect(maxLines({ NB_MAX_LINES: '7' })).toBe(7);
    expect(maxLines({ NB_MAX_LINES: '0' })).toBe(1);
    expect(maxLines({ NB_MAX_LINES: '999999' })).toBe(5000);
    expect(maxLines({ NB_MAX_LINES: 'abc' })).toBe(50);
  });
});

describe('predictMove (pure model)', () => {
  test('a non-full target admits the lesson with no eviction and no aging', () => {
    const store = new Map([
      ['a', [mk('m1', 4)]],
      ['t', [mk('t1', 1), mk('t2', 2)]],
    ]);
    const p = predictMove(store, 'a', 't', 'm1', 5);
    expect(p).toMatchObject({ outcome: 'moved', evicted: null, docked: null, targetFull: false });
  });

  test('a full target evicts its lowest-scored line (ties: stalest) and docks the stalest survivor', () => {
    const store = new Map([
      ['a', [mk('m1', 9)]],
      ['t', [mk('t1', 5), mk('t2', 1), mk('t3', 1), mk('t4', 3)]], // file order: t1 stalest
    ]);
    const p = predictMove(store, 'a', 't', 'm1', 4);
    expect(p.evicted?.id).toBe('t2'); // lowest score 1, stalest of the two
    expect(p.docked).toMatchObject({ id: 't1', from: 5, to: 4 }); // first surviving line in file order
    applyMove(store, 'a', 't', 'm1', 4);
    expect(store.get('t')!.map((e) => [e.id, e.score])).toEqual([
      ['t1', 4],
      ['t3', 1],
      ['t4', 3],
      ['m1', 9],
    ]);
    expect(store.get('a')).toEqual([]);
  });

  test('the dock can hit the very line that would otherwise be evicted next', () => {
    const store = new Map([
      ['a', [mk('m1', 1), mk('m2', 1)]],
      ['t', [mk('t1', 1), mk('t2', 1), mk('t3', 1)]],
    ]);
    applyMove(store, 'a', 't', 'm1', 3); // evicts t1, docks t2: 1 -> 0
    const second = predictMove(store, 'a', 't', 'm2', 3);
    expect(second.evicted?.id).toBe('t2'); // now the lowest at 0
  });

  test('a duplicate (by nb dedup key) is refused and predicts no side effect', () => {
    const store = new Map([
      ['a', [mk('m1', 2, 'Use Foo, always')]],
      ['t', [mk('t1', 1, 'use foo always')]],
    ]);
    expect(predictMove(store, 'a', 't', 'm1', 5)).toMatchObject({ outcome: 'duplicate', collidedId: 't1' });
    const before = cloneStore(store);
    applyMove(store, 'a', 't', 'm1', 5);
    expect(store).toEqual(before);
  });

  test('missing, ambiguous and same-shelf outcomes', () => {
    const store = new Map([
      ['a', [mk('x', 1), mk('x', 2, 'other text')]],
      ['t', []],
    ]);
    expect(predictMove(store, 'a', 't', 'nope').outcome).toBe('missing');
    expect(predictMove(store, 'a', 't', 'x').outcome).toBe('ambiguous');
    expect(predictMove(store, 'a', 'a', 'x').outcome).toBe('same-shelf');
  });
});

describe('decideStep', () => {
  const full = () =>
    new Map([
      ['a', [mk('low', 1), mk('eq', 3), mk('hi', 6)]],
      ['t', [mk('t1', 3), mk('t2', 4), mk('t3', 5)]],
    ]);
  const step = (id: string) => ({ from: 'a', to: 't', id });

  test('below a FULL target\'s minimum is refused unless forced', () => {
    expect(decideStep(full(), step('low'), { cap: 3 })).toMatchObject({ action: 'skip', reason: 'low-score' });
    expect(decideStep(full(), step('low'), { cap: 3, forceLow: true }).action).toBe('move');
  });
  test('equal to the minimum or above is allowed', () => {
    expect(decideStep(full(), step('eq'), { cap: 3 }).action).toBe('move');
    expect(decideStep(full(), step('hi'), { cap: 3 }).action).toBe('move');
  });
  test('the minimum-score rule does not apply when the target is not full', () => {
    expect(decideStep(full(), step('low'), { cap: 4 }).action).toBe('move');
  });
  test('a lesson that already left the source is "already-moved"', () => {
    expect(decideStep(full(), step('gone'), { cap: 3 })).toMatchObject({ action: 'skip', reason: 'already-moved' });
  });
});

describe('parity with the real nb binary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) destroy(dirs.pop());
  });

  // Deterministic PRNG so a failure reproduces.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  test('random full/non-full targets: the model predicts nb\'s evictions, aging and file order', () => {
    const CAP = 6;
    const env = cleanEnv({ NB_MAX_LINES: String(CAP) });
    let evictions = 0;
    let dockings = 0;
    for (let seed = 1; seed <= 14; seed++) {
      const rand = rng(seed);
      const dir = makeStore({ git: false });
      dirs.push(dir);
      const client = createNbClient({ dir, nb: RAW_NB, env });
      const lessonsFor = (prefix: string, n: number): Lesson[] =>
        Array.from({ length: n }, (_, i) => [Math.floor(rand() * 6) - 1, `${prefix} lesson number ${i} seed ${seed}`] as Lesson);
      const sourceLessons = lessonsFor('src', 1 + Math.floor(rand() * 3));
      const targetLessons = lessonsFor('tgt', Math.floor(rand() * 2) === 0 ? CAP : 2 + Math.floor(rand() * 3));
      writeShelf(dir, 'src@legacy', sourceLessons);
      writeShelf(dir, 'tgt@canon', targetLessons);

      const model = new Map([
        ['src@legacy', readShelf(client, dir, 'src@legacy').entries],
        ['tgt@canon', readShelf(client, dir, 'tgt@canon').entries],
      ]);
      expect(readShelf(client, dir, 'tgt@canon').approximateOrder).toBe(false);

      for (const e of [...model.get('src@legacy')!]) {
        const predicted = predictMove(model, 'src@legacy', 'tgt@canon', e.id, CAP);
        const real = nbMove(client, 'src@legacy', 'tgt@canon', e.id);
        expect(real.moved, `seed ${seed}`).toBe(predicted.outcome === 'moved');
        if (predicted.outcome === 'moved') {
          expect(real.evicted ? entryId(real.evicted.text) : null, `seed ${seed} evicted`).toBe(predicted.evicted?.id ?? null);
          if (predicted.evicted) evictions++;
          if (predicted.docked) dockings++;
          applyMove(model, 'src@legacy', 'tgt@canon', e.id, CAP);
        }
        const after = readShelf(client, dir, 'tgt@canon').entries.map((x) => [x.id, x.score]);
        expect(after, `seed ${seed} target after moving ${e.id}`).toEqual(model.get('tgt@canon')!.map((x) => [x.id, x.score]));
      }
    }
    // The scenarios must actually exercise the eviction and aging paths.
    expect(evictions).toBeGreaterThan(5);
    expect(dockings).toBeGreaterThan(5);
  }, 120_000);

  test('nb counts a duplicate as "duplicate" in --json while exiting 0', () => {
    const dir = makeStore({ git: false });
    dirs.push(dir);
    const client = createNbClient({ dir, nb: RAW_NB, env: cleanEnv() });
    writeShelf(dir, 's@legacy', [[2, 'Use Foo, always']]);
    writeShelf(dir, 't@canon', [[1, 'use foo always']]);
    const id = readShelf(client, dir, 's@legacy').entries[0].id;
    const raw = client.run(['move', 's@legacy', 't@canon', id, '--json']);
    expect(raw.status).toBe(0); // exit code says nothing about whether it moved
    expect(JSON.parse(raw.stdout).reason).toBe('duplicate');
    const r = nbMove(client, 's@legacy', 't@canon', id);
    expect(r).toMatchObject({ moved: false, reason: 'duplicate' });
    expect(readLessons(dir, 's@legacy')).toHaveLength(1); // nothing was written
  });

  test('moving the last lesson leaves a 0-byte file on nb 0.7.0, which only reapZeroByteShelf removes', () => {
    const dir = makeStore({ git: false });
    dirs.push(dir);
    const client = createNbClient({ dir, nb: RAW_NB, env: cleanEnv() });
    writeShelf(dir, 's@legacy', [[2, 'only lesson']]);
    const id = readShelf(client, dir, 's@legacy').entries[0].id;
    expect(nbMove(client, 's@legacy', 't@canon', id).moved).toBe(true);
    expect(existsSync(join(dir, 's@legacy.md'))).toBe(true); // still on disk...
    const listed = client.runJson(['list', '--json']);
    expect(listed.json.rows.map((r: { shelf: string }) => r.shelf)).toEqual(['t@canon']); // ...but hidden
    expect(reapZeroByteShelf(dir, 's@legacy')).toBe('deleted');
    expect(existsSync(join(dir, 's@legacy.md'))).toBe(false);
    expect(reapZeroByteShelf(dir, 's@legacy')).toBe('absent');
  });
});

describe('nbMove result handling', () => {
  const stub = (json: unknown, ok = true) => ({ runJson: () => (ok ? { ok: true, json } : { ok: false, error: 'boom' }) }) as never;
  test('only reason "moved" counts as moved; any other reason is a skip', () => {
    expect(nbMove(stub({ reason: 'moved', evicted: null }), 'a', 'b', 'x').moved).toBe(true);
    for (const reason of ['duplicate', 'skipped', 'weird', undefined]) {
      expect(nbMove(stub({ reason }), 'a', 'b', 'x').moved, String(reason)).toBe(false);
    }
  });
  test('a failed call is an error, not a skip', () => {
    expect(nbMove(stub(null, false), 'a', 'b', 'x')).toMatchObject({ moved: false, reason: 'error' });
  });
});

describe('reapZeroByteShelf safety', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) destroy(dirs.pop());
  });
  test('never deletes a file with content, a directory, or anything outside the store', () => {
    const dir = makeStore({ git: false });
    dirs.push(dir);
    writeFileSync(join(dir, 'full.md'), '+1\tlesson\n');
    writeFileSync(join(dir, 'meta-only.md'), '# desc: described but empty\n');
    mkdirSync(join(dir, 'adir.md'));
    expect(reapZeroByteShelf(dir, 'full')).toBe('not-empty');
    expect(reapZeroByteShelf(dir, 'meta-only')).toBe('not-empty');
    expect(reapZeroByteShelf(dir, 'adir')).toBe('refused');
    expect(reapZeroByteShelf(dir, '../escape')).toBe('refused');
    expect(reapZeroByteShelf(dir, 'a/b')).toBe('refused');
    expect(reapZeroByteShelf(dir, '')).toBe('refused');
    expect(existsSync(join(dir, 'full.md'))).toBe(true);
    expect(existsSync(join(dir, 'meta-only.md'))).toBe(true);
  });
  test('a symlinked 0-byte name is not followed', () => {
    const dir = makeStore({ git: false });
    dirs.push(dir);
    const outside = mkdtempSync(join(tmpdir(), 'nb-store-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'target.md'), '');
    symlinkSync(join(outside, 'target.md'), join(dir, 'link.md'));
    expect(reapZeroByteShelf(dir, 'link')).toBe('refused');
    expect(existsSync(join(outside, 'target.md'))).toBe(true);
  });
});

describe('readFileOrderIds', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) destroy(dirs.pop());
  });
  test('returns ids in file order, skipping the description header and blank lines', () => {
    const dir = makeStore({ git: false });
    dirs.push(dir);
    writeShelf(dir, 's', [[1, 'first'], [9, 'second'], [3, 'third']], 'a description');
    expect(readFileOrderIds(dir, 's')).toEqual([entryId('first'), entryId('second'), entryId('third')]);
    expect(readFileOrderIds(dir, 'missing')).toBeNull();
  });
});
