import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSlugAliases } from '../plugin/hooks/lib/notebook-layers.mjs';
import { createNbClient, snapshotStore } from './lib/nb-client.mjs';
import { entryId } from './lib/nb-sim.mjs';
import {
  DEFAULT_TAG,
  findGroups,
  jaccard,
  runPromotion,
  tokenSet,
} from './promote-notebook-lessons.mjs';
import { RAW_NB, breakCommits, cleanEnv, commitAll, destroy, dirContents, fileExists, git, makeStore, readLessons, writeShelf, type Lesson } from './lib/nb-test-helpers';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const aliases = loadSlugAliases();
const CANON = 'jeanibarz-agent-notebook';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) destroy(dirs.pop());
});
const store = (opts: { git?: boolean } = {}) => {
  const d = makeStore(opts);
  dirs.push(d);
  return d;
};
const L = (...pairs: Array<[number, string]>): Lesson[] => pairs;

interface Opts {
  apply?: boolean;
  only?: string[] | null;
  toGlobal?: string[];
  threshold?: number;
  forceLow?: boolean;
  cap?: number;
  shim?: boolean;
  tag?: string;
  env?: Record<string, string>;
}
function run(dir: string, o: Opts = {}) {
  const cap = o.cap ?? 50;
  const client = createNbClient({ dir, nb: o.shim ? undefined : RAW_NB, env: cleanEnv({ NB_MAX_LINES: String(cap), ...(o.env ?? {}) }) });
  const lines: string[] = [];
  const result = runPromotion({
    client,
    aliases,
    apply: o.apply ?? false,
    only: o.only ? new Set(o.only) : null,
    toGlobal: new Set(o.toGlobal ?? []),
    threshold: o.threshold,
    forceLow: o.forceLow ?? false,
    tag: o.tag ?? null,
    cap,
    log: (l: string) => lines.push(l),
  });
  return { result, text: lines.join('\n') };
}
const groupsOf = (dir: string, threshold?: number) =>
  findGroups({ store: snapshotStore(createNbClient({ dir, nb: RAW_NB, env: cleanEnv() })).store, aliases, threshold });

const T2 = 'Pin the node version in CI: an unpinned runner upgrades under you and breaks the lockfile install again.';
const SAME = 'Run the full suite before pushing: a green unit lane alone hides integration breakage.';

describe('findGroups', () => {
  test('exact: same text (trim, whitespace, case) in two different repos', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, `  ${SAME.toUpperCase().replace(/\s+/g, '   ')} `]));
    const { groups } = groupsOf(dir);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ tier: 'exact', base: 'code-review' });
    expect(groups[0].best.shelf).toBe('code-review@repo-two'); // highest score
    expect(groups[0].id).toMatch(/^e-[0-9a-f]{6}$/);
  });

  test('a copy under a legacy slug and one under its canonical slug are the same repo: not a promotion', () => {
    const dir = store();
    writeShelf(dir, 'code-review@agent-notebook', L([3, SAME]));
    writeShelf(dir, `code-review@${CANON}`, L([5, SAME]));
    writeShelf(dir, 'code-review@Agent-Notebook', L([1, SAME]));
    expect(groupsOf(dir).groups).toEqual([]);
  });

  test('...but the same lesson in a legacy shelf plus another repo is a group, with all three copies', () => {
    const dir = store();
    writeShelf(dir, 'code-review@agent-notebook', L([3, SAME]));
    writeShelf(dir, `code-review@${CANON}`, L([5, SAME]));
    writeShelf(dir, 'code-review@some-other-repo', L([1, SAME]));
    const [g] = groupsOf(dir).groups;
    expect(g.members).toHaveLength(3);
  });

  test('case-different slugs are one repo', () => {
    const dir = store();
    writeShelf(dir, 'code-review@Owner-Repo', L([3, SAME]));
    writeShelf(dir, 'code-review@owner-repo', L([4, SAME]));
    expect(groupsOf(dir).groups).toEqual([]);
  });

  test('different bases never group together', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'orchestrator@repo-two', L([3, SAME]));
    expect(groupsOf(dir).groups).toEqual([]);
  });

  test('bare domain shelves and fleet-global are never grouped', () => {
    const dir = store();
    writeShelf(dir, 'code-review', L([3, SAME]));
    writeShelf(dir, 'fleet-global', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    expect(groupsOf(dir).groups).toEqual([]);
  });

  test('candidate: a paraphrase above the threshold, with the printed threshold respected', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([6, 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds']));
    writeShelf(dir, 'code-review@repo-two', L([2, 'gh pr merge --delete-branch fails locally in a linked worktree; the remote merge still succeeds']));
    const loose = groupsOf(dir, 0.5).groups;
    expect(loose).toHaveLength(1);
    expect(loose[0]).toMatchObject({ tier: 'candidate' });
    expect(loose[0].best.shelf).toBe('code-review@repo-one');
    expect(groupsOf(dir, 0.99).groups).toEqual([]);
  });

  test('a lesson and its negation look alike: they are only ever a CANDIDATE', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, 'always run the migration before deploying the service to production']));
    writeShelf(dir, 'code-review@repo-two', L([3, 'never run the migration before deploying the service to production']));
    const { groups } = groupsOf(dir, 0.6);
    expect(groups.map((g: { tier: string }) => g.tier)).toEqual(['candidate']);
  });

  test('a candidate whose lesson the domain shelf already holds is "covered", not offered again', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([6, 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds']));
    writeShelf(dir, 'code-review@repo-two', L([2, 'gh pr merge --delete-branch fails locally in a linked worktree; the remote merge still succeeds']));
    writeShelf(dir, 'code-review', L([6, 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds']));
    const found = groupsOf(dir, 0.5);
    expect(found.groups).toEqual([]);
    expect(found.covered).toHaveLength(1);
  });

  test('names with several @ group on their full base: a@b@one and a@b@two share base "a@b"', () => {
    const dir = store();
    writeShelf(dir, 'a@b@one', L([3, SAME]));
    writeShelf(dir, 'a@b@two', L([3, SAME]));
    writeShelf(dir, 'a@@one', L([3, SAME]));
    const { groups } = groupsOf(dir);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe('a@b');
  });

  test('group ids are stable across runs', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    expect(groupsOf(dir).groups[0].id).toBe(groupsOf(dir).groups[0].id);
  });

  test('token helpers', () => {
    expect([...tokenSet('Fix the CI, ok? Café 42')].sort()).toEqual(['café', 'fix', 'the']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('promote: dry-run', { timeout: 120_000 }, () => {
  test('prints groups and the exact commands, and changes nothing', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const before = dirContents(dir);
    const { result, text } = run(dir);
    expect(result.ok).toBe(true);
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
    const id = entryId(SAME);
    expect(text).toContain(`nb move code-review@repo-two code-review ${id} --reason consolidate`);
    expect(text).toContain(`nb rm code-review@repo-one ${id} --reason obsolete --note duplicate`);
    expect(text).toContain('DRY RUN');
  });

  test('with no exact group it says so plainly and does not claim to fill fleet-global', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, 'one lesson only here']));
    writeShelf(dir, 'code-review@repo-two', L([3, 'something else entirely']));
    const { text } = run(dir);
    expect(text).toContain('Exact groups: 0');
    expect(text).toContain('fleet-global is never filled automatically');
  });
});

describe('promote: --apply, exact groups', { timeout: 120_000 }, () => {
  test('moves the best copy to the domain shelf, THEN removes the other copies (move commit first)', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME], [1, 'unrelated one']));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    writeShelf(dir, 'code-review@repo-three', L([2, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true, shim: true });
    expect(result.ok, text).toBe(true);
    expect(readLessons(dir, 'code-review')).toEqual([[5, SAME]]); // score kept
    expect(readLessons(dir, 'code-review@repo-one')).toEqual([[1, 'unrelated one']]);
    expect(readLessons(dir, 'code-review@repo-three')).toEqual([]);
    expect(result.removed).toHaveLength(2);
    const tag = git(dir, 'tag', '-l', `${DEFAULT_TAG}-*`);
    const log = git(dir, 'log', '--format=%s', '--reverse', `${tag}..HEAD`).split('\n');
    const moveAt = log.findIndex((s) => s.startsWith('nb move'));
    const rmAt = log.findIndex((s) => s.startsWith('nb rm'));
    expect(moveAt).toBeGreaterThanOrEqual(0);
    expect(rmAt).toBeGreaterThan(moveAt); // a move always precedes any rm
  });

  test('when the domain shelf already holds the lesson, the move is refused and NOTHING is removed', () => {
    const dir = store();
    writeShelf(dir, 'code-review', L([1, SAME.toLowerCase()]));
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true });
    expect(text).toContain('SKIP duplicate');
    expect(result.removed).toEqual([]);
    expect(readLessons(dir, 'code-review@repo-one')).toHaveLength(1);
    expect(readLessons(dir, 'code-review@repo-two')).toHaveLength(1);
  });

  test('a full domain shelf: a low-scored exact group is refused (and keeps all copies) unless --force-low', () => {
    const dir = store();
    writeShelf(dir, 'code-review', L([4, 'd1'], [5, 'd2'], [6, 'd3']));
    writeShelf(dir, 'code-review@repo-one', L([1, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([2, SAME]));
    commitAll(dir);
    const refused = run(dir, { apply: true, cap: 3 });
    expect(refused.text).toContain('SKIP low-score');
    expect(readLessons(dir, 'code-review')).toEqual([[4, 'd1'], [5, 'd2'], [6, 'd3']]);
    expect(readLessons(dir, 'code-review@repo-two')).toHaveLength(1);
    const forced = run(dir, { apply: true, cap: 3, forceLow: true });
    expect(forced.result.ok).toBe(true);
    expect(readLessons(dir, 'code-review')).toContainEqual([2, SAME]);
    expect(readLessons(dir, 'code-review@repo-one')).toEqual([]);
  });

  test('a second run is a no-op', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    run(dir, { apply: true, shim: true });
    const head = git(dir, 'rev-parse', 'HEAD');
    const second = run(dir, { apply: true, shim: true });
    expect(second.result.performed).toEqual([]);
    expect(second.text).toContain('Nothing to apply');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('resume after an interrupted run: leftover copies are reported, never removed on the strength of a different move', () => {
    // State left by a run that moved the best copy and died before the removals.
    const dir = store();
    writeShelf(dir, 'code-review', L([5, SAME]));
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([2, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true });
    expect(text).toContain('SKIP duplicate'); // the destination holds it: this run moved nothing...
    expect(result.removed).toEqual([]); // ...so it removes nothing; the report names the manual command
    expect(text).toContain('Nothing is removed; decide by hand');
  });

  test('the removals are gated on the destination really holding the lesson (best copy vanished before the move)', () => {
    // The best copy is gone from its shelf (evicted/removed by someone else) and the destination never got it.
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const client = createNbClient({ dir, nb: RAW_NB, env: cleanEnv() });
    // Race: remove the best copy through nb after the plan is read but before the apply step. We simulate it
    // by wrapping the client so the first `move` finds the lesson already gone.
    const realRunJson = client.runJson.bind(client);
    let raced = false;
    const racing = {
      ...client,
      run: client.run,
      runJson: (args: string[]) => {
        if (!raced && args[0] === 'show' && args[1] === 'code-review@repo-two') {
          const out = realRunJson(args);
          if (out.ok) {
            raced = true;
            client.run(['rm', 'code-review@repo-two', entryId(SAME)]);
          }
          return out;
        }
        return realRunJson(args);
      },
    };
    const lines: string[] = [];
    // First `show` of repo-two happens during the snapshot; the racing rm lands before the apply loop re-reads it.
    const result = runPromotion({ client: racing, aliases, apply: true, cap: 50, log: (l: string) => lines.push(l) });
    const text = lines.join('\n');
    expect(text).toContain('already moved');
    expect(text).toContain('NOT REMOVING');
    expect(result.removed).toEqual([]);
    expect(readLessons(dir, 'code-review@repo-one')).toEqual([[3, SAME]]); // the surviving copy is untouched
    expect(readLessons(dir, 'code-review')).toEqual([]);
  });
});

describe('promote: candidate groups and the reviewer flags', { timeout: 120_000 }, () => {
  const A = 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds';
  const B = 'gh pr merge --delete-branch fails locally in a linked worktree; the remote merge still succeeds';
  const seed = (dir: string) => {
    writeShelf(dir, 'orchestrator@repo-one', L([6, A], [1, 'keep me']));
    writeShelf(dir, 'orchestrator@repo-two', L([2, B]));
    commitAll(dir);
  };

  test('a plain --apply never touches a candidate group', () => {
    const dir = store();
    seed(dir);
    const before = dirContents(dir);
    const { result, text } = run(dir, { apply: true, threshold: 0.5 });
    expect(text).toContain('CANDIDATE');
    expect(text).toContain('Nothing to apply');
    expect(result.performed).toEqual([]);
    expect(dirContents(dir)).toEqual(before);
  });

  test('--apply --only <id> moves the best copy up, keeps its score, and removes NOTHING', () => {
    const dir = store();
    seed(dir);
    const dry = run(dir, { threshold: 0.5 });
    const id = /\[(c-[0-9a-f]{6})\]/.exec(dry.text)![1];
    const { result, text } = run(dir, { apply: true, only: [id], threshold: 0.5 });
    expect(result.ok, text).toBe(true);
    expect(readLessons(dir, 'orchestrator')).toEqual([[6, A]]);
    expect(readLessons(dir, 'orchestrator@repo-one')).toEqual([[1, 'keep me']]);
    expect(readLessons(dir, 'orchestrator@repo-two')).toEqual([[2, B]]); // the paraphrase is NOT removed
    expect(result.removed).toEqual([]);
    expect(text).toContain('removes nothing');
  });

  test('--to-global sends only the named group to fleet-global; the default is the domain shelf', () => {
    const dir = store();
    seed(dir);
    const dry = run(dir, { threshold: 0.5 });
    const id = /\[(c-[0-9a-f]{6})\]/.exec(dry.text)![1];
    expect(dry.text).not.toContain('fleet-global (reviewer flag)');
    const { result } = run(dir, { apply: true, only: [id], toGlobal: [id], threshold: 0.5 });
    expect(result.ok).toBe(true);
    expect(readLessons(dir, 'fleet-global')).toEqual([[6, A]]);
    expect(fileExists(dir, 'orchestrator')).toBe(false);
  });

  test('a group id that no longer exists is a reported no-op (a finished --only command can be re-run), and nothing is changed', () => {
    const dir = store();
    seed(dir);
    const before = dirContents(dir);
    const { result, text } = run(dir, { apply: true, only: ['c-000000'], threshold: 0.5 });
    expect(result.ok).toBe(true);
    expect(result.nothing).toBe(true);
    expect(text).toContain('None of the --only group ids exist (c-000000)');
    expect(text).toMatch(/Groups found now: c-[0-9a-f]{6}/); // so a typo is obvious
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('re-running a finished --apply --only command changes nothing and still succeeds', () => {
    const dir = store();
    seed(dir);
    const id = /\[(c-[0-9a-f]{6})\]/.exec(run(dir, { threshold: 0.5 }).text)![1];
    expect(run(dir, { apply: true, only: [id], threshold: 0.5, shim: true }).result.ok).toBe(true);
    const head = git(dir, 'rev-parse', 'HEAD');
    const again = run(dir, { apply: true, only: [id], threshold: 0.5, shim: true });
    expect(again.result.ok).toBe(true);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('--to-global for a group that is not being applied is refused', () => {
    const dir = store();
    seed(dir);
    const id = /\[(c-[0-9a-f]{6})\]/.exec(run(dir, { threshold: 0.5 }).text)![1];
    const { result } = run(dir, { apply: true, toGlobal: [id], threshold: 0.5 }); // candidate without --only
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--to-global/);
    expect(fileExists(dir, 'fleet-global')).toBe(false);
  });

  test('a base that contains "@" has no domain shelf to go to: reported, not guessed', () => {
    const dir = store();
    writeShelf(dir, 'a@b@one', L([3, SAME]));
    writeShelf(dir, 'a@b@two', L([4, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true });
    expect(text).toContain('is not a bare domain shelf name');
    expect(result.performed).toEqual([]);
    expect(readLessons(dir, 'a@b@one')).toHaveLength(1);
    expect(readLessons(dir, 'a@b@two')).toHaveLength(1);
  });
});

describe('promote: --apply guards', { timeout: 120_000 }, () => {
  test('refuses when the store is not a git repository and changes nothing', () => {
    const dir = store({ git: false });
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    const before = dirContents(dir);
    const { result } = run(dir, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`--apply refused: ${dir} is not a git repository, so there is no rollback anchor and the moves would not be committed.`);
    expect(dirContents(dir)).toEqual(before);
  });

  test('a store that merely sits inside some other git repository is refused, and the parent is never tagged or committed to', () => {
    const parent = store();
    const dir = join(parent, 'notebooks');
    mkdirSync(dir);
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(parent);
    const head = git(parent, 'rev-parse', 'HEAD');
    const { result } = run(dir, { apply: true, shim: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^--apply refused: .* is not a git repository/);
    expect(git(parent, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(parent, 'tag')).toBe('');
    expect(readLessons(dir, 'code-review@repo-one')).toHaveLength(1);
  });

  test('tags the store with a fresh pre-lesson-promotion-<time> anchor, and keeps an explicit --tag that already exists', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const anchor = git(dir, 'rev-parse', 'HEAD');
    run(dir, { apply: true });
    const tag = git(dir, 'tag', '-l', `${DEFAULT_TAG}-*`);
    expect(tag).toMatch(new RegExp(`^${DEFAULT_TAG}-\\d{8}T\\d{6}Z$`));
    expect(git(dir, 'rev-list', '-n1', tag)).toBe(anchor);

    // An explicit tag that already exists is kept (it is the caller's anchor).
    const dir2 = store();
    writeShelf(dir2, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir2, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir2);
    git(dir2, 'tag', 'my-anchor');
    const anchor2 = git(dir2, 'rev-list', '-n1', 'my-anchor');
    commitAll(dir2, 'later work');
    run(dir2, { apply: true, tag: 'my-anchor' });
    expect(git(dir2, 'rev-list', '-n1', 'my-anchor')).toBe(anchor2);
  });

  test('refuses with NB_GIT_AUTOCOMMIT=0 (with the shim, moves would not be commits) and changes nothing', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const before = dirContents(dir);
    const { result } = run(dir, { apply: true, shim: true, env: { NB_GIT_AUTOCOMMIT: '0' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/NB_GIT_AUTOCOMMIT=0/);
    expect(dirContents(dir)).toEqual(before);
  });

  test('an empty or missing --only value is refused, never widened to "apply every exact group"', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const before = dirContents(dir);
    const script = join(repoRoot, 'scripts', 'promote-notebook-lessons.mjs');
    const env = cleanEnv({ NB_DIR: dir });
    const go = (...args: string[]) => spawnSync(process.execPath, [script, ...args, '--nb', RAW_NB], { encoding: 'utf-8', env });
    for (const args of [['--apply', '--only', ''], ['--apply', '--only', ' '], ['--apply', '--only', '--force-low'], ['--only'], ['--apply', '--to-global', '']]) {
      const r = go(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('needs a value');
    }
    // (an --only that is last on the command line, after the --nb the helper appends, is covered by the ['--only'] case)
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('a misspelled, unknown or "="-form flag is refused, never ignored (a restricted run must not widen into a plain --apply)', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const before = dirContents(dir);
    const script = join(repoRoot, 'scripts', 'promote-notebook-lessons.mjs');
    const env = cleanEnv({ NB_DIR: dir });
    const go = (...args: string[]) => spawnSync(process.execPath, [script, ...args, '--nb', RAW_NB], { encoding: 'utf-8', env });
    for (const args of [['--apply', '--only=c-123456'], ['--apply', '--onyl', 'c-123456'], ['--apply', '--to-global=e-1'], ['--apply', '--bogus'], ['--apply', 'stray']]) {
      const r = go(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('unknown argument');
      expect(r.stderr).toContain('Nothing was changed');
    }
    expect(go('--apply', '--only=c-123456').stderr).toContain('write "--only c-123456" with a space');
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('a value that looks like a flag (--tag -l), a repeated value flag, or a missing --map file is refused before anything changes', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const before = dirContents(dir);
    const script = join(repoRoot, 'scripts', 'promote-notebook-lessons.mjs');
    const env = cleanEnv({ NB_DIR: dir });
    const go = (...args: string[]) => spawnSync(process.execPath, [script, ...args, '--nb', RAW_NB], { encoding: 'utf-8', env });
    const tagFlag = go('--apply', '--tag', '-l');
    expect(tagFlag.status).toBe(2);
    expect(tagFlag.stderr).toContain('looks like a flag');
    const twice = go('--apply', '--only', 'e-000001', '--only', 'e-000002');
    expect(twice.status).toBe(2);
    expect(twice.stderr).toContain('more than once');
    const twiceGlobal = go('--apply', '--to-global', 'e-000001', '--to-global', 'e-000002');
    expect(twiceGlobal.status).toBe(2);
    const noMap = go('--apply', '--map', join(dir, 'missing-aliases.json'));
    expect(noMap.status).toBe(2);
    expect(noMap.stderr).toContain('does not exist');
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('candidate group ids are unique even when the same lesson sits under a legacy and a canonical slug (the shelf is part of the id)', () => {
    const dir = store();
    const A1 = 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds';
    const A2 = 'gh pr merge delete branch errors locally in a linked worktree but the remote merge succeeds.'; // same nb dedup key as A1
    const B1 = 'gh pr merge --delete-branch fails locally in a linked worktree; the remote merge still succeeds';
    const B2 = 'gh pr merge --delete-branch fails locally in a linked worktree and the remote merge still succeeds';
    writeShelf(dir, 'orchestrator@agent-notebook', L([6, A1]));
    writeShelf(dir, `orchestrator@${CANON}`, L([5, A2]));
    writeShelf(dir, 'orchestrator@repo-b', L([2, B1]));
    writeShelf(dir, 'orchestrator@repo-c', L([2, B2]));
    const ids = groupsOf(dir, 0.5).groups.map((g: { id: string }) => g.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a --to-global id that is not a group (and not in --only) is refused: it would silently send the lesson to the domain shelf', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const id = /\[(e-[0-9a-f]{6})\]/.exec(run(dir).text)![1];
    const before = dirContents(dir);
    const { result } = run(dir, { apply: true, only: [id], toGlobal: [`${id}x`] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a group id/);
    expect(dirContents(dir)).toEqual(before);
    expect(git(dir, 'tag')).toBe('');
  });

  test('a move that did not become a commit stops the run: nothing further is moved or removed', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    breakCommits(dir);
    const { result } = run(dir, { apply: true, shim: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/store got no commit/);
    expect(result.removed).toEqual([]);
    expect(readLessons(dir, 'code-review@repo-one')).toHaveLength(1); // the other copy is still there
  });

  test('a set-but-blank NB_DIR is refused instead of falling back to the live store', () => {
    const script = join(repoRoot, 'scripts', 'promote-notebook-lessons.mjs');
    const r = spawnSync(process.execPath, [script, '--nb', RAW_NB], { encoding: 'utf-8', env: cleanEnv({ NB_DIR: '' }) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NB_DIR is set but empty');
  });

  test('the CLI: bad --threshold exits 2, a dry-run exits 0, --apply on a non-git store exits 2', () => {
    const dir = store({ git: false });
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    const script = join(repoRoot, 'scripts', 'promote-notebook-lessons.mjs');
    const env = cleanEnv({ NB_DIR: dir });
    const go = (...args: string[]) => spawnSync(process.execPath, [script, ...args, '--nb', RAW_NB], { encoding: 'utf-8', env });
    const badThreshold = go('--threshold', '7');
    expect(badThreshold.status).toBe(2);
    expect(badThreshold.stderr).toContain('--threshold must be a number');
    const dry = go();
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('DRY RUN');
    const refused = go('--apply');
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain('is not a git repository');
  });
});

describe('promote: a full domain shelf cannot cost the only copy of a lesson', { timeout: 120_000 }, () => {
  const T = 'Pin the node version in CI: an unpinned runner upgrades under you and breaks the lockfile install.';
  const seedFull = (dir: string) => {
    // The domain shelf is full (cap 3) with a +1 at the bottom; two exact groups both score +2.
    writeShelf(dir, 'code-review', L([9, 'd1'], [9, 'd2'], [1, 'd3 weakest']));
    writeShelf(dir, 'code-review@repo-one', L([2, SAME], [2, T]));
    writeShelf(dir, 'code-review@repo-two', L([2, SAME], [2, T]));
    commitAll(dir);
  };

  test('the second promotion only ties the first (now the shelf\'s lowest): it is refused, and nothing is lost', () => {
    const dir = store();
    seedFull(dir);
    const { result, text } = run(dir, { apply: true, cap: 3 });
    expect(text).toContain('SKIP low-score');
    // Exactly one of the two lessons was promoted (replacing the weak +1) and its other copy removed...
    const promoted = readLessons(dir, 'code-review').filter(([, t]) => t === SAME || t === T);
    expect(promoted).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    // ...and the other lesson is still in BOTH project shelves.
    const other = promoted[0][1] === SAME ? T : SAME;
    expect(readLessons(dir, 'code-review@repo-one').map(([, t]) => t)).toContain(other);
    expect(readLessons(dir, 'code-review@repo-two').map(([, t]) => t)).toContain(other);
  });

  test('even when --force-low lets the second move push the first out, the first one\'s copies are NOT removed', () => {
    const dir = store();
    seedFull(dir);
    const { result, text } = run(dir, { apply: true, cap: 3, forceLow: true });
    expect(text).toContain('NOT REMOVING');
    // Whichever lesson was pushed out still has its project copies; every lesson exists somewhere.
    for (const lesson of [SAME, T]) {
      const holders = ['code-review', 'code-review@repo-one', 'code-review@repo-two'].filter((sh) =>
        readLessons(dir, sh).some(([, t]) => t === lesson),
      );
      expect(holders, lesson).not.toEqual([]);
    }
    expect(result.ok).toBe(true);
  });

  test('RESUME with the run\'s tag keeps the bar: the aging the first run caused does not let a tying group through the second time', () => {
    const dir = store();
    const U = 'Run migrations before the integration suite: a stale schema makes half of it fail for no good reason.';
    writeShelf(dir, 'code-review', L([1, 'o1'], [1, 'o2'], [1, 'o3']));
    writeShelf(dir, 'code-review@repo-one', L([5, SAME], [1, T2], [1, U]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME], [1, T2], [1, U]));
    commitAll(dir);
    const first = run(dir, { apply: true, cap: 3, tag: 'resume-anchor' });
    expect(first.result.ok).toBe(true);
    expect(readLessons(dir, 'code-review').map(([, t]) => t)).toContain(SAME);
    expect(readLessons(dir, 'code-review').some(([s]) => s === 0)).toBe(true); // aged by the first run
    expect(first.text).toContain('--tag resume-anchor');
    const second = run(dir, { apply: true, cap: 3, tag: 'resume-anchor' });
    expect(second.result.performed).toEqual([]);
    expect(readLessons(dir, 'code-review@repo-one').map(([, t]) => t).sort()).toEqual([T2, U].sort());
    expect(readLessons(dir, 'code-review@repo-two').map(([, t]) => t).sort()).toEqual([T2, U].sort());
  });

  test('RESUME with --tag after a lesson was voted up between the runs: it is protected at the higher score', () => {
    const dir = store();
    const V = 'victim lesson in the domain shelf, voted up between the first run and its resume';
    writeShelf(dir, 'code-review', L([1, 'L low'], [2, V]));
    writeShelf(dir, 'code-review@repo-one', L([9, SAME], [3, T2]));
    writeShelf(dir, 'code-review@repo-two', L([9, SAME], [3, T2]));
    commitAll(dir);
    // First run: only tags the store (selecting nothing is a no-op before the tag, so tag by a run that applies a different group set).
    git(dir, 'tag', 'resume-anchor');
    const client = createNbClient({ dir, nb: RAW_NB, env: cleanEnv({ NB_MAX_LINES: '2' }) });
    expect(client.run(['vote', 'code-review', entryId(V), '+1']).status).toBe(0); // V: +2 -> +3
    const { result, text } = run(dir, { apply: true, cap: 2, tag: 'resume-anchor' });
    expect(result.ok, text).toBe(true);
    // SAME (+9) evicts 'L low' and ages V to +2; T2 (+3) must not then evict V (+3 when the resume began).
    expect(readLessons(dir, 'code-review').map(([, t]) => t).sort()).toEqual([SAME, V].sort());
    expect(readLessons(dir, 'code-review@repo-one').map(([, t]) => t)).toEqual([T2]); // T2's copies are untouched
    expect(readLessons(dir, 'code-review@repo-two').map(([, t]) => t)).toEqual([T2]);
  });

  test('groups are applied highest-scored first', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([1, SAME], [7, T]));
    writeShelf(dir, 'code-review@repo-two', L([1, SAME], [7, T]));
    const { result } = run(dir);
    const order = result.steps.map((s: { score: number }) => s.score);
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  test('a target already over the cap is refused: a move would evict several lessons at once', () => {
    const dir = store();
    writeShelf(dir, 'code-review', L([1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']));
    writeShelf(dir, 'code-review@repo-one', L([9, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([9, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true, cap: 3 });
    expect(text).toContain('SKIP over-cap');
    expect(result.performed).toEqual([]);
    expect(readLessons(dir, 'code-review')).toHaveLength(5);
    expect(readLessons(dir, 'code-review@repo-one')).toHaveLength(1);
  });

  test('moving a shelf\'s last lesson leaves no file behind and nothing uncommitted', () => {
    const dir = store();
    writeShelf(dir, 'code-review@repo-one', L([3, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([5, SAME]));
    commitAll(dir);
    const { result } = run(dir, { apply: true, shim: true });
    expect(result.ok).toBe(true);
    // nb 0.8.0 deletes a shelf file itself once it is emptied, by a move as well as by an rm, and the
    // shim commits that deletion with the command. (nb before 0.8.0 left a 0-byte file after a move; the
    // script still deletes one if it finds it, which scripts/lib/nb-sim.test.ts covers.)
    expect(fileExists(dir, 'code-review@repo-two')).toBe(false); // best copy moved out
    expect(fileExists(dir, 'code-review@repo-one')).toBe(false); // other copy rm'd
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const tag = git(dir, 'tag', '-l', 'pre-lesson-promotion-*');
    const subjects = git(dir, 'log', '--format=%s', `${tag}..HEAD`).split('\n');
    expect(subjects.sort()).toEqual(['nb move code-review@repo-two', 'nb rm code-review@repo-one']);
  });
});

describe('promote: leftovers of an interrupted promotion', { timeout: 120_000 }, () => {
  test('a project copy of a lesson the domain shelf already holds is listed with its nb rm, and --apply removes nothing', () => {
    const dir = store();
    writeShelf(dir, 'code-review', L([5, SAME]));
    writeShelf(dir, 'code-review@repo-two', L([2, SAME.toUpperCase()], [1, 'unrelated']));
    commitAll(dir);
    const dry = run(dir);
    expect(dry.text).toContain('PROJECT COPIES of a lesson the domain shelf or fleet-global already holds');
    expect(dry.text).toContain(`nb rm code-review@repo-two ${entryId(SAME)} --reason obsolete --note duplicate`);
    expect(dry.text).not.toContain('unrelated');
    const before = dirContents(dir);
    const applied = run(dir, { apply: true });
    expect(applied.result.removed).toEqual([]);
    expect(dirContents(dir)).toEqual(before);
  });
});

describe('promote: odd names and re-runs', { timeout: 120_000 }, () => {
  test('a base ending in @ (a@@one + a@@two) has no valid domain shelf: reported and skipped, --apply still completes', () => {
    const dir = store();
    writeShelf(dir, 'a@@one', L([3, SAME]));
    writeShelf(dir, 'a@@two', L([4, SAME]));
    commitAll(dir);
    const { result, text } = run(dir, { apply: true });
    expect(result.ok, text).toBe(true);
    expect(text).toContain('SKIP bad-destination');
    expect(readLessons(dir, 'a@@one')).toHaveLength(1);
    expect(readLessons(dir, 'a@@two')).toHaveLength(1);
  });

  test('re-running the same --only list after a partial success finishes the rest instead of failing', () => {
    const dir = store();
    const A1 = 'gh pr merge --delete-branch errors locally in a linked worktree but the remote merge succeeds';
    const A2 = 'gh pr merge --delete-branch fails locally in a linked worktree; the remote merge still succeeds';
    const B1 = 'pnpm install in a fresh worktree needs the lockfile from the main checkout before the tests will run';
    const B2 = 'a fresh worktree needs pnpm install with the main checkout lockfile before the tests will run';
    writeShelf(dir, 'orchestrator@repo-one', L([6, A1], [5, B1]));
    writeShelf(dir, 'orchestrator@repo-two', L([2, A2], [2, B2]));
    commitAll(dir);
    const ids = [...run(dir, { threshold: 0.5 }).text.matchAll(/\[(c-[0-9a-f]{6})\]/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    // Apply only the first, then re-run asking for both.
    run(dir, { apply: true, only: [ids[0]], threshold: 0.5 });
    const second = run(dir, { apply: true, only: ids, threshold: 0.5 });
    expect(second.result.ok, second.text).toBe(true);
    expect(second.text).toContain('was not found');
    expect(readLessons(dir, 'orchestrator')).toHaveLength(2); // both groups promoted in the end
  });
});
