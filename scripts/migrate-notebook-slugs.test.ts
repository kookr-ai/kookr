import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSlugAliases } from '../plugin/hooks/lib/notebook-layers.mjs';
import { runMigration, planMigration, DEFAULT_TAG } from './migrate-notebook-slugs.mjs';
import { createNbClient, snapshotStore } from './lib/nb-client.mjs';
import {
  RAW_NB,
  cleanEnv,
  commitAll,
  destroy,
  dirContents,
  fileExists,
  git,
  makeStore,
  readDescription,
  readLessons,
  writeShelf,
  type Lesson,
} from './lib/nb-test-helpers';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestShelves: Record<string, string> = JSON.parse(readFileSync(join(repoRoot, 'plugin', 'notebooks', 'shelves.json'), 'utf-8')).shelves;
const aliases = loadSlugAliases();
const CANON = 'jeanibarz-agent-notebook';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) destroy(dirs.pop());
});

function store(opts: { git?: boolean } = {}): string {
  const dir = makeStore(opts);
  dirs.push(dir);
  return dir;
}

interface RunOpts {
  apply?: boolean;
  forceLow?: boolean;
  cap?: number;
  shim?: boolean;
  stopAfter?: number;
  stopAfterStage?: 'reap' | null;
  env?: Record<string, string>;
}
function run(dir: string, opts: RunOpts = {}) {
  const cap = opts.cap ?? 50;
  // The shim (default) commits every mutation, which the git assertions rely on; the raw CLI is faster for the rest.
  const client = createNbClient({ dir, nb: opts.shim ? undefined : RAW_NB, env: cleanEnv({ NB_MAX_LINES: String(cap), ...(opts.env ?? {}) }) });
  const lines: string[] = [];
  const result = runMigration({
    client,
    aliases,
    manifestShelves,
    apply: opts.apply ?? false,
    forceLow: opts.forceLow ?? false,
    cap,
    stopAfter: opts.stopAfter,
    stopAfterStage: opts.stopAfterStage ?? null,
    log: (l: string) => lines.push(l),
  });
  return { result, lines, text: lines.join('\n') };
}

const L = (...pairs: Array<[number, string]>): Lesson[] => pairs;

describe('migrate-notebook-slugs: dry-run', { timeout: 120_000 }, () => {
  test('changes nothing and prints the plan, highest-scored lesson first', () => {
    const dir = store();
    writeShelf(dir, `tester@agent-notebook`, L([1, 'low lesson'], [7, 'high lesson']));
    commitAll(dir);
    const before = dirContents(dir);
    const headBefore = git(dir, 'rev-parse', 'HEAD');
    const { result, text } = run(dir);
    expect(result.ok).toBe(true);
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(dir, 'tag')).toBe('');
    expect(text).toContain(`tester@agent-notebook (2) -> tester@${CANON}  [new shelf]`);
    expect(text.indexOf('(+7) high lesson')).toBeLessThan(text.indexOf('(+1) low lesson'));
    expect(text).toContain('DRY RUN');
  });

  test('predicts the evictions and the aging that a full target causes, and totals the lessons lost', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([3, 't3'], [4, 't4'], [5, 't5'], [6, 't6']));
    writeShelf(dir, 'code-review@agent-notebook', L([5, 'hi']));
    const { text } = run(dir, { cap: 4 });
    expect(text).toMatch(/target full: evicts \w{6} \(\+3\) t3/);
    expect(text).toMatch(/docks \w{6} \+4 -> \+3/);
    expect(text).toContain('existing lessons evicted from full targets (lost): 1');
  });
});

describe('migrate-notebook-slugs: --apply', { timeout: 120_000 }, () => {
  test('folds legacy shelves into canonical ones, keeping scores, one commit per move, and reaps the 0-byte files', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one'], [5, 'tester two']));
    writeShelf(dir, `code-review@${CANON}`, L([3, 'existing review lesson']));
    writeShelf(dir, 'code-review@agent-notebook', L([4, 'legacy review lesson']));
    writeShelf(dir, 'code-review@other-owner-repo', L([1, 'another repo']), 'kept as is');
    writeShelf(dir, 'planner', L([1, 'a bare domain shelf']));
    commitAll(dir);
    const preMigration = git(dir, 'rev-parse', 'HEAD');

    const { result, text } = run(dir, { apply: true, shim: true });
    expect(result.ok, text).toBe(true);
    expect(readLessons(dir, `tester@${CANON}`)).toEqual([
      [5, 'tester two'],
      [2, 'tester one'],
    ]);
    expect(readLessons(dir, `code-review@${CANON}`)).toEqual([
      [3, 'existing review lesson'],
      [4, 'legacy review lesson'],
    ]);
    expect(fileExists(dir, 'tester@agent-notebook')).toBe(false);
    expect(fileExists(dir, 'code-review@agent-notebook')).toBe(false);
    expect(result.reaped.sort()).toEqual(['code-review@agent-notebook', 'tester@agent-notebook']);

    // Rollback anchor and history: the tag is the pre-migration commit; each move and each deletion is a commit.
    expect(git(dir, 'rev-list', '-n1', DEFAULT_TAG)).toBe(preMigration);
    const log = git(dir, 'log', '--format=%s', `${DEFAULT_TAG}..HEAD`).split('\n');
    expect(log.filter((s) => s.startsWith('nb move'))).toHaveLength(3);
    expect(log.filter((s) => s.startsWith('slug migration: delete empty legacy shelf'))).toHaveLength(2);
    expect(git(dir, 'status', '--porcelain')).toBe('');

    // Unrelated shelves are untouched.
    expect(readLessons(dir, 'code-review@other-owner-repo')).toEqual([[1, 'another repo']]);
    expect(readDescription(dir, 'code-review@other-owner-repo')).toBe('kept as is');
    expect(readLessons(dir, 'planner')).toEqual([[1, 'a bare domain shelf']]);
  });

  test('re-runs the description seed for the migrated repo only, and never touches another repo\'s shelf', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    writeShelf(dir, 'code-review@other-owner-repo', L([1, 'another repo'])); // undescribed, other repo
    commitAll(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(true);
    expect(readDescription(dir, `tester@${CANON}`)).toBe(`${manifestShelves.tester} (only in ${CANON})`);
    expect(readDescription(dir, 'code-review@other-owner-repo')).toBeNull();
  });

  test('a full target with a low-scored mover: the weak lesson stays, nothing better is evicted', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([3, 't3'], [4, 't4'], [5, 't5'], [6, 't6'])); // file order: t3 is stalest
    writeShelf(dir, 'code-review@agent-notebook', L([1, 'weak'], [5, 'strong']));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true, cap: 4 });
    // strong (+5) moves first: evicts the lowest (t3) and docks the stalest survivor (t4: 4 -> 3).
    expect(readLessons(dir, `code-review@${CANON}`)).toEqual([
      [3, 't4'],
      [5, 't5'],
      [6, 't6'],
      [5, 'strong'],
    ]);
    // weak (+1) is below the full target's minimum (+3): refused, still on its legacy shelf.
    expect(readLessons(dir, 'code-review@agent-notebook')).toEqual([[1, 'weak']]);
    expect(text).toContain('SKIP low-score');
    expect(result.ok).toBe(false); // a legacy shelf still holds a lesson
    expect(result.remaining.map((r) => r.shelf)).toEqual(['code-review@agent-notebook']);
    expect(fileExists(dir, 'code-review@agent-notebook')).toBe(true); // never reaped while it has a lesson
  });

  test('lessons that merely tie the full target\'s lowest do not push anything out: they stay put, and a re-run decides the same way', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([9, 'n1'], [9, 'n2'], [1, 'n3 weakest']));
    writeShelf(dir, 'code-review@agent-notebook', L([1, 'weak a'], [1, 'weak b']));
    commitAll(dir);
    const dry = run(dir, { cap: 3 });
    expect(dry.text).toContain('SKIP low score');
    expect(dry.text).toContain('does not score above');
    for (let i = 0; i < 2; i++) {
      const { result } = run(dir, { apply: true, cap: 3 });
      expect(result.ok).toBe(false); // two lessons await a manual decision
      expect(readLessons(dir, `code-review@${CANON}`).map(([, t]) => t)).toEqual(['n1', 'n2', 'n3 weakest']);
      expect(readLessons(dir, 'code-review@agent-notebook').map(([, t]) => t)).toEqual(['weak a', 'weak b']);
    }
  });

  test('a strong lesson moves first, replacing the weakest; the weak ones behind it are then refused, not shuffled in', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([9, 'n1'], [9, 'n2'], [1, 'n3 weakest']));
    writeShelf(dir, 'code-review@agent-notebook', L([1, 'weak a'], [3, 'strong'], [1, 'weak b']));
    commitAll(dir);
    run(dir, { apply: true, cap: 3 });
    // 'strong' (+3) evicts n3 and ages n1 (9 -> 8); the +1 lessons are below the new minimum (+3).
    expect(readLessons(dir, `code-review@${CANON}`)).toEqual([
      [8, 'n1'],
      [9, 'n2'],
      [3, 'strong'],
    ]);
    expect(readLessons(dir, 'code-review@agent-notebook').map(([, t]) => t).sort()).toEqual(['weak a', 'weak b']);
  });

  test('a target already over the cap is refused (a move would evict several lessons at once) unless --force-low', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']));
    writeShelf(dir, 'code-review@agent-notebook', L([9, 'incoming']));
    commitAll(dir);
    const dry = run(dir, { cap: 3 });
    expect(dry.text).toContain('SKIP over-cap');
    run(dir, { apply: true, cap: 3 });
    expect(readLessons(dir, `code-review@${CANON}`)).toHaveLength(5); // untouched
    expect(readLessons(dir, 'code-review@agent-notebook')).toEqual([[9, 'incoming']]);
    const forced = run(dir, { cap: 3, forceLow: true });
    expect(forced.text).toContain('existing lessons evicted from full targets (lost): 3');
  });

  test('--force-low moves the weak lesson anyway, evicting the target\'s lowest', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([3, 't3'], [4, 't4'], [5, 't5'], [6, 't6']));
    writeShelf(dir, 'code-review@agent-notebook', L([1, 'weak']));
    commitAll(dir);
    const { result } = run(dir, { apply: true, cap: 4, forceLow: true });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, `code-review@${CANON}`)).toEqual([
      [3, 't4'],
      [5, 't5'],
      [6, 't6'],
      [1, 'weak'],
    ]);
    expect(fileExists(dir, 'code-review@agent-notebook')).toBe(false);
  });

  test('the minimum-score refusal applies only to a FULL target', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([3, 't3'], [4, 't4'], [5, 't5'])); // 3 of cap 4: not full
    writeShelf(dir, 'code-review@agent-notebook', L([-2, 'very weak']));
    commitAll(dir);
    const { result } = run(dir, { apply: true, cap: 4 });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, `code-review@${CANON}`)).toContainEqual([-2, 'very weak']);
  });

  test('a target name over 128 characters is reported before starting and its lessons stay put', () => {
    const dir = store();
    const longBase = 'b'.repeat(110); // legacy name = 110 + 1 + 14 = 125 chars (valid); target = 135 (invalid)
    writeShelf(dir, `${longBase}@agent-notebook`, L([2, 'cannot move']));
    writeShelf(dir, 'tester@agent-notebook', L([2, 'can move']));
    commitAll(dir);

    const dry = run(dir);
    expect(dry.result.plan.invalid).toHaveLength(1);
    expect(dry.text).toContain('REFUSED before starting');
    expect(dry.text).toMatch(/too long: 135 chars, max 128/);

    const { result } = run(dir, { apply: true });
    expect(readLessons(dir, `${longBase}@agent-notebook`)).toEqual([[2, 'cannot move']]);
    expect(readLessons(dir, `tester@${CANON}`)).toEqual([[2, 'can move']]);
    expect(result.ok).toBe(false);
    expect(result.remaining.map((r) => r.shelf)).toEqual([`${longBase}@agent-notebook`]);
  });

  test('a target name of exactly 128 characters is allowed', () => {
    const dir = store();
    const base = 'b'.repeat(103); // 103 + 1 + 24 = 128
    writeShelf(dir, `${base}@agent-notebook`, L([2, 'fits']));
    commitAll(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, `${base}@${CANON}`)).toEqual([[2, 'fits']]);
  });

  test('resume after a partial run reaches the same end state as one uninterrupted run, with the same rollback tag', () => {
    const seed = (dir: string) => {
      writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one'], [5, 'tester two']));
      writeShelf(dir, 'planner@agent-notebook', L([3, 'planner one']));
      writeShelf(dir, `code-review@${CANON}`, L([1, 'existing']));
      writeShelf(dir, 'code-review@agent-notebook', L([4, 'review one'], [2, 'review two']));
      commitAll(dir);
    };
    const whole = store();
    seed(whole);
    expect(run(whole, { apply: true }).result.ok).toBe(true);

    const resumed = store();
    seed(resumed);
    const first = run(resumed, { apply: true, stopAfter: 2 });
    expect(first.result.performed).toHaveLength(2);
    expect(fileExists(resumed, 'tester@agent-notebook')).toBe(true); // half-migrated
    const tagAfterFirst = git(resumed, 'rev-list', '-n1', DEFAULT_TAG);
    const second = run(resumed, { apply: true });
    expect(second.result.ok, second.text).toBe(true);
    expect(second.text).toContain('already existed: kept');
    expect(git(resumed, 'rev-list', '-n1', DEFAULT_TAG)).toBe(tagAfterFirst); // anchor never moves
    expect(second.result.performed).toHaveLength(5 - 2);

    for (const shelf of [`tester@${CANON}`, `planner@${CANON}`, `code-review@${CANON}`]) {
      expect(readLessons(resumed, shelf), shelf).toEqual(readLessons(whole, shelf));
      expect(readDescription(resumed, shelf), shelf).toEqual(readDescription(whole, shelf));
    }
    for (const legacy of ['tester@agent-notebook', 'planner@agent-notebook', 'code-review@agent-notebook']) {
      expect(fileExists(resumed, legacy), legacy).toBe(false);
    }
  });

  test('resume after a run interrupted between the 0-byte cleanup and the description seed still describes the new shelves', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    commitAll(dir);
    run(dir, { apply: true, stopAfterStage: 'reap' });
    expect(fileExists(dir, 'tester@agent-notebook')).toBe(false);
    expect(readDescription(dir, `tester@${CANON}`)).toBeNull();
    const again = run(dir, { apply: true });
    expect(again.result.ok, again.text).toBe(true);
    expect(readDescription(dir, `tester@${CANON}`)).toContain('(only in jeanibarz-agent-notebook)');
  });

  test('resume cleans up a 0-byte leftover from an earlier interrupted run', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L()); // 0 bytes, already hidden from nb list
    writeShelf(dir, `tester@${CANON}`, L([1, 'moved earlier']), `${manifestShelves.tester} (only in ${CANON})`);
    commitAll(dir);
    expect(git(dir, 'ls-files')).toContain('tester@agent-notebook.md');
    const { result } = run(dir, { apply: true, shim: true });
    expect(result.reaped).toEqual(['tester@agent-notebook']);
    expect(fileExists(dir, 'tester@agent-notebook')).toBe(false);
    expect(git(dir, 'ls-files')).not.toContain('tester@agent-notebook.md'); // the deletion is committed
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  test('a second run after completion is a no-op: no commits, nothing performed', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    commitAll(dir);
    expect(run(dir, { apply: true, shim: true }).result.ok).toBe(true);
    const head = git(dir, 'rev-parse', 'HEAD');
    const before = dirContents(dir);
    const second = run(dir, { apply: true, shim: true });
    expect(second.result.ok).toBe(true);
    expect(second.result.performed).toEqual([]);
    expect(second.result.reaped).toEqual([]);
    expect(second.text).toContain('Nothing to do');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(dirContents(dir)).toEqual(before);
  });

  test('slugs are matched case-insensitively and the existing canonical shelf is reused, not shadowed', () => {
    const dir = store();
    writeShelf(dir, 'x@Agent-Notebook', L([3, 'from a case-different legacy slug']));
    writeShelf(dir, 'x@Jeanibarz-Agent-Notebook', L([1, 'already here']));
    commitAll(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, 'x@Jeanibarz-Agent-Notebook')).toContainEqual([3, 'from a case-different legacy slug']);
    expect(fileExists(dir, `x@${CANON}`)).toBe(false); // no differently-cased twin created
    expect(fileExists(dir, 'x@Agent-Notebook')).toBe(false);
  });

  test('names with several @ are classified on the LAST one: a@b@agent-notebook and a@@agent-notebook', () => {
    const dir = store();
    writeShelf(dir, 'a@b@agent-notebook', L([2, 'multi at']));
    writeShelf(dir, 'a@@agent-notebook', L([2, 'double at']));
    writeShelf(dir, 'a@b@other', L([2, 'not legacy']));
    commitAll(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, `a@b@${CANON}`)).toEqual([[2, 'multi at']]);
    expect(readLessons(dir, `a@@${CANON}`)).toEqual([[2, 'double at']]);
    expect(readLessons(dir, 'a@b@other')).toEqual([[2, 'not legacy']]);
  });

  test('a lesson the target already holds is skipped and reported: nb exits 0 on it, nothing is removed, the legacy shelf survives', () => {
    const dir = store();
    writeShelf(dir, `tester@${CANON}`, L([1, 'Run the tests, then build.']));
    writeShelf(dir, 'tester@agent-notebook', L([4, 'run the tests then build'], [2, 'a unique lesson']));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true });
    expect(text).toContain('SKIP duplicate');
    expect(result.skipped.map((s) => s.reason)).toEqual(['duplicate']);
    expect(readLessons(dir, 'tester@agent-notebook')).toEqual([[4, 'run the tests then build']]); // kept for a manual decision
    expect(readLessons(dir, `tester@${CANON}`)).toContainEqual([1, 'Run the tests, then build.']); // untouched
    expect(readLessons(dir, `tester@${CANON}`)).toContainEqual([2, 'a unique lesson']);
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([{ shelf: 'tester@agent-notebook', lessons: 1, reason: 'listed by nb list' }]);
    expect(text).toContain('nb rm tester@agent-notebook'); // the manual command is suggested, never run
  });

  test('a legacy shelf that still has a description is never deleted: it is reported', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']), 'a human described this legacy shelf');
    commitAll(dir);
    const { result } = run(dir, { apply: true });
    expect(readLessons(dir, `tester@${CANON}`)).toEqual([[2, 'tester one']]);
    expect(fileExists(dir, 'tester@agent-notebook')).toBe(true);
    expect(readDescription(dir, 'tester@agent-notebook')).toBe('a human described this legacy shelf');
    expect(result.ok).toBe(false);
    expect(result.remaining[0]).toMatchObject({ shelf: 'tester@agent-notebook', lessons: 0 });
  });
});

describe('migrate-notebook-slugs: --apply guards', { timeout: 120_000 }, () => {
  test('refuses when the store is not a git repository, and changes nothing', () => {
    const dir = store({ git: false });
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    const before = dirContents(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`--apply refused: ${dir} is not a git repository, so there is no rollback anchor and the moves would not be committed. Run \`git init\` there (and commit) first.`);
    expect(result.performed).toEqual([]);
    expect(dirContents(dir)).toEqual(before);
  });

  test('a store that merely sits inside some other git repository is not "a git repository": the parent is never tagged or committed to', () => {
    const parent = store(); // a git repo
    const dir = join(parent, 'notebooks');
    mkdirSync(dir);
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    commitAll(parent);
    const parentHead = git(parent, 'rev-parse', 'HEAD');
    const { result } = run(dir, { apply: true, shim: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^--apply refused: .* is not a git repository/);
    expect(git(parent, 'rev-parse', 'HEAD')).toBe(parentHead);
    expect(git(parent, 'tag')).toBe('');
    expect(readLessons(dir, 'tester@agent-notebook')).toEqual([[2, 'tester one']]);
  });

  test('the CLI exits 2 with that refusal, and 0 for a dry-run', () => {
    const dir = store({ git: false });
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    const script = join(repoRoot, 'scripts', 'migrate-notebook-slugs.mjs');
    const env = cleanEnv({ NB_DIR: dir });
    const refused = spawnSync(process.execPath, [script, '--apply', '--nb', RAW_NB], { encoding: 'utf-8', env });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain('not a git repository');
    const dry = spawnSync(process.execPath, [script, '--nb', RAW_NB], { encoding: 'utf-8', env });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('DRY RUN');
    expect(existsSync(join(dir, 'tester@agent-notebook.md'))).toBe(true);
  });

  test('refuses with NB_GIT_AUTOCOMMIT=0 (with the shim, moves would not be commits) and changes nothing', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    commitAll(dir);
    const before = dirContents(dir);
    const { result } = run(dir, { apply: true, shim: true, env: { NB_GIT_AUTOCOMMIT: '0' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/NB_GIT_AUTOCOMMIT=0/);
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('a tag that already exists is kept (the anchor of the first run)', () => {
    const dir = store();
    writeShelf(dir, 'tester@agent-notebook', L([2, 'tester one']));
    commitAll(dir);
    git(dir, 'tag', DEFAULT_TAG);
    const anchor = git(dir, 'rev-list', '-n1', DEFAULT_TAG);
    run(dir, { apply: true });
    expect(git(dir, 'rev-list', '-n1', DEFAULT_TAG)).toBe(anchor);
  });
});

describe('planMigration', () => {
  test('is pure: it never mutates the snapshot it reads', () => {
    const dir = store();
    writeShelf(dir, `code-review@${CANON}`, L([3, 't3'], [4, 't4']));
    writeShelf(dir, 'code-review@agent-notebook', L([5, 'hi']));
    const snap = snapshotStore(createNbClient({ dir, nb: RAW_NB, env: cleanEnv() }));
    const before = JSON.stringify([...snap.store]);
    planMigration({ snapshot: snap, aliases, cap: 2 });
    expect(JSON.stringify([...snap.store])).toBe(before);
  });
});
