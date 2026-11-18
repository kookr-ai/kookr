/**
 * review-patch-id.sh: an id of the exact file versions a PR changes (#3788).
 * Runs the real script against throwaway git repos; the PR mode additionally
 * uses a stub `gh` and a bare origin that carries refs/pull/<n>/head.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';

const SCRIPT = join(process.cwd(), 'scripts/review-patch-id.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitExecEnv(),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(repo: string, name: string, body: string | Buffer): void {
  writeFileSync(join(repo, name), body);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-patch-id-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commitFile(dir, 'base.txt', 'one\ntwo\nthree\n');
  return dir;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...gitExecEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

describe('review-patch-id.sh (local refs)', () => {
  it('prints the same id before and after rebasing onto a moved base', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    const before = run(repo, ['main']);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toMatch(/^[0-9a-f]{40}$/);

    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'other.txt', 'moved base\n');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');

    const after = run(repo, ['main', 'feature']);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it('keeps a plugin PR\'s id when the base gains the train\'s plugin version bump (#3793)', () => {
    // Pull requests no longer edit plugin.json; the integration train bumps it
    // in its own commit. A plugin PR rebased over that commit keeps its id, so a
    // passed review stays bound. (When every plugin PR bumped the version, each
    // such rebase changed the shared plugin.json blob and voided the review.)
    // The id is base-independent for files the PR does not touch, so this is a
    // regression guard for the property the design relies on, not a train test.
    const repo = makeRepo();
    mkdirSync(join(repo, 'plugin/.claude-plugin'), { recursive: true });
    mkdirSync(join(repo, 'plugin/skills'), { recursive: true });
    commitFile(repo, 'plugin/.claude-plugin/plugin.json', '{\n  "version": "0.1.0"\n}\n');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'plugin/skills/demo.md', 'skill\n');
    const before = run(repo, ['main']);
    expect(before.status, before.stderr).toBe(0);

    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'plugin/.claude-plugin/plugin.json', '{\n  "version": "0.1.1"\n}\n');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');

    const after = run(repo, ['main', 'feature']);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it('prints a different id after an extra change', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    const before = run(repo, ['main']).stdout;
    commitFile(repo, 'more.txt', 'extra\n');
    const after = run(repo, ['main']).stdout;
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('changes when a NUL byte is added to a file git diffs as text', () => {
    // The diff must never pass through a shell variable: bash drops NUL bytes,
    // so "X\0Y" and "XY" would hash the same and unreviewed bytes would pass.
    const repo = makeRepo();
    commitFile(repo, '.gitattributes', 'data.txt text diff\n');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'data.txt', 'XY\n');
    const before = run(repo, ['main']).stdout;
    writeFileSync(join(repo, 'data.txt'), Buffer.from('X\0Y\n'));
    git(repo, 'commit', '-q', '-am', 'add a NUL');
    const after = run(repo, ['main']).stdout;
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('prints a DIFFERENT id after a rebase onto a base that changed the SAME file', () => {
    // Intended, fail-closed trade-off: the id names the exact blobs the PR
    // changes, so a base that also edited a file the PR touches changes the
    // PR's "old" blob and therefore the id, even far from the hunk. The
    // reviewer re-reviews instead of the gate guessing the change is the same.
    const repo = makeRepo();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    commitFile(repo, 'big.txt', `${lines.join('\n')}\n`);
    git(repo, 'checkout', '-q', '-b', 'feature');
    const edited = [...lines];
    edited[35] = 'line 35 changed';
    commitFile(repo, 'big.txt', `${edited.join('\n')}\n`);
    const before = run(repo, ['main']).stdout;
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'big.txt', `new first line\nanother\n${lines.join('\n')}\n`);
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');
    const after = run(repo, ['main', 'feature']);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toMatch(/^[0-9a-f]{40}$/);
    expect(after.stdout).not.toBe(before);
  });

  it('differs for the same edit made in the first vs the second of two identical functions', () => {
    const body = (name: string) => `function ${name}(u) {\n  if (u.flag) {\n    return deny();\n  }\n  return 0;\n}\n`;
    const original = `${body('check_admin')}\n${body('check_guest')}`;
    const edit = (text: string, fn: string) =>
      text.replace(new RegExp(`(function ${fn}\\(u\\) \\{\\n  if \\(u.flag\\) \\{\\n    return )deny\\(\\)`), '$1allow()');
    const make = (fn: string) => {
      const repo = makeRepo();
      commitFile(repo, 'auth.js', original);
      git(repo, 'checkout', '-q', '-b', 'feature');
      const changed = edit(original, fn);
      expect(changed).not.toBe(original);
      commitFile(repo, 'auth.js', changed);
      const r = run(repo, ['main']);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    expect(make('check_admin')).not.toBe(make('check_guest'));
  });

  describe('is sensitive to every content byte', () => {
    function branchWith(file: string, body: string | Buffer) {
      const repo = makeRepo();
      commitFile(repo, file, typeof body === 'string' ? '' : Buffer.from([0, 1, 2, 3]));
      git(repo, 'checkout', '-q', '-b', 'feature');
      return repo;
    }
    const idOf = (repo: string) => {
      const r = run(repo, ['main']);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };

    it('(a) a whitespace-only re-indent of a changed line', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'f.js', 'if (x) {\n  run();\n}\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'f.js', 'if (x) {\n    run();\n}\n');
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(b) removing one space inside a string on a changed line', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'f.js', 'const s = "a b";\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'f.js', 'const s = "ab";\n');
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(c) replacing the bytes of a binary file the PR adds', () => {
      const a = branchWith('x.txt', 'x');
      commitFile(a, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
      const b = branchWith('x.txt', 'x');
      commitFile(b, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 6]));
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(d) a file mode change', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'run.sh', 'echo hi\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'run.sh', 'echo hi\n');
      const before = idOf(b);
      git(b, 'update-index', '--chmod=+x', 'run.sh');
      git(b, 'commit', '-q', '-m', 'chmod');
      expect(idOf(b)).not.toBe(before);
      expect(idOf(b)).not.toBe(idOf(a));
    });

    it('(e) a rename with identical content', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      git(a, 'mv', 'base.txt', 'renamed.txt');
      git(a, 'commit', '-q', '-m', 'rename');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      git(b, 'mv', 'base.txt', 'other-name.txt');
      git(b, 'commit', '-q', '-m', 'rename');
      const idA = idOf(a);
      expect(idA).toMatch(/^[0-9a-f]{40}$/);
      expect(idA).not.toBe(idOf(b));
    });
  });

  it('prints nothing and exits non-zero for an empty diff', () => {
    const repo = makeRepo();
    const r = run(repo, ['main']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('empty');
  });

  it('exits 2 on bad usage', () => {
    expect(run(makeRepo(), []).status).toBe(2);
  });
});

describe('review-patch-id.sh line-bound reference pages (#3798)', () => {
  const PAGE = 'docs/reference/api.md';
  const rows = Array.from({ length: 30 }, (_, i) => `| GET /r${i} | route ${i} |`);
  const page = (r: string[]) => `# API\n\n| Route | What |\n| --- | --- |\n${r.join('\n')}\n`;
  const withRow = (r: string[], at: number, row: string) => [...r.slice(0, at), row, ...r.slice(at)];

  /** main has the page; feature adds `prRow` near the end. */
  function setup(path = PAGE, prRow = '| POST /mine | the PR row |') {
    const repo = makeRepo();
    mkdirSync(join(repo, 'docs/reference'), { recursive: true });
    commitFile(repo, path, page(rows));
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, path, page(withRow(rows, 25, prRow)));
    return repo;
  }
  function rebaseOntoBaseRow(repo: string, path = PAGE) {
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, path, page(withRow(rows, 3, '| PUT /theirs | another PR row |')));
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');
  }
  const idOf = (repo: string) => {
    const r = run(repo, ['main', 'feature']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^[0-9a-f]{40}$/);
    return r.stdout;
  };

  it.each(['docs/reference/environment-variables.md', 'docs/reference/api.md', 'docs/reference/cli.md'])(
    'keeps the id of a PR adding a row to %s after a rebase onto a base that added a different row',
    (path) => {
      const repo = setup(path);
      const before = idOf(repo);
      rebaseOntoBaseRow(repo, path);
      expect(idOf(repo)).toBe(before);
    },
  );

  it('prints the same id when run from a subdirectory', () => {
    const repo = setup();
    const fromRoot = idOf(repo);
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const r = run(join(repo, 'sub'), ['main', 'feature']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(fromRoot);
  });

  it('ignores GIT_DIFF_OPTS and diff.relative', () => {
    const repo = setup();
    const plain = idOf(repo);
    const r = run(repo, ['main', 'feature'], { GIT_DIFF_OPTS: '--unified=5' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(plain);
    git(repo, 'config', 'diff.relative', 'true');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const sub = run(join(repo, 'sub'), ['main', 'feature']);
    expect(sub.status, sub.stderr).toBe(0);
    expect(sub.stdout).toBe(plain);
  });

  it('fails rather than bind an allow-listed page whose diff shows no line (binary diff attribute)', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'docs/reference'), { recursive: true });
    commitFile(repo, '.gitattributes', '*.md -diff\n');
    commitFile(repo, PAGE, page(rows));
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, PAGE, page(withRow(rows, 25, '| POST /mine | r |')));
    const r = run(repo, ['main', 'feature']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('keeps the id when the PR\'s row lands at another place in the page (accepted trade-off)', () => {
    // Documents the operator's choice: content and order of the changed lines
    // are bound, their position is not.
    expect(idOf(setup())).toBe(idOf((() => {
      const repo = makeRepo();
      mkdirSync(join(repo, 'docs/reference'), { recursive: true });
      commitFile(repo, PAGE, page(rows));
      git(repo, 'checkout', '-q', '-b', 'feature');
      commitFile(repo, PAGE, page(withRow(rows, 5, '| POST /mine | the PR row |')));
      return repo;
    })()));
  });

  it('changes the id when the content of the PR\'s own added row changes', () => {
    const a = idOf(setup(PAGE, '| POST /mine | the PR row |'));
    const b = idOf(setup(PAGE, '| POST /mine | the PR row  |'));
    expect(a).not.toBe(b);
  });

  it('changes the id when the PR also removes a line', () => {
    const repo = setup();
    const before = idOf(repo);
    const r = withRow(rows, 25, '| POST /mine | the PR row |');
    r.splice(10, 1);
    commitFile(repo, PAGE, page(r));
    expect(idOf(repo)).not.toBe(before);
  });

  it('still changes the id when the PR also changes another file the base touched', () => {
    const repo = setup();
    commitFile(repo, 'base.txt', 'one\ntwo\nthree\nfour\n');
    const before = idOf(repo);
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'base.txt', 'zero\none\ntwo\nthree\n');
    commitFile(repo, PAGE, page(withRow(rows, 3, '| PUT /theirs | another PR row |')));
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');
    expect(idOf(repo)).not.toBe(before);
  });

  it('keeps the blob-level binding for a file outside the exact allow-list', () => {
    // Same shape, a path that only resembles the allow-listed ones.
    const path = 'docs/reference/api-extra.md';
    const repo = setup(path);
    const before = idOf(repo);
    rebaseOntoBaseRow(repo, path);
    expect(idOf(repo)).not.toBe(before);
  });

  it('keeps the blob-level binding when the PR adds an allow-listed page (status A)', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(repo, 'docs/reference'), { recursive: true });
    commitFile(repo, PAGE, page(rows));
    const blobLevel = git(repo, 'diff-tree', '-r', '--no-commit-id', '--full-index', '--no-renames', 'main', 'feature');
    const expected = spawnSync('git', ['hash-object', '--stdin'], { input: `${blobLevel}\n`, encoding: 'utf8' }).stdout.trim();
    expect(idOf(repo)).toBe(expected);
  });

  it('keeps the blob-level binding when an allow-listed page holds a NUL byte', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'docs/reference'), { recursive: true });
    // Diff it as text, so only the NUL check keeps the blob line.
    commitFile(repo, '.gitattributes', '*.md text diff\n');
    commitFile(repo, PAGE, Buffer.from(`${page(rows)}x\0y\n`));
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, PAGE, Buffer.from(`${page(withRow(rows, 25, '| POST /mine | r |'))}x\0y\n`));
    const before = idOf(repo);
    git(repo, 'checkout', '-q', 'main');
    const theirs = withRow(rows, 3, '| PUT /theirs | r |');
    commitFile(repo, PAGE, Buffer.from(`${page(theirs)}x\0y\n`));
    // What a rebase would produce (git refuses to merge a file with a NUL).
    git(repo, 'checkout', '-q', '-B', 'feature', 'main');
    commitFile(repo, PAGE, Buffer.from(`${page(withRow(theirs, 26, '| POST /mine | r |'))}x\0y\n`));
    expect(idOf(repo)).not.toBe(before);
  });

  it('keeps the blob-level binding on a mode change of an allow-listed page', () => {
    const repo = setup();
    const before = idOf(repo);
    chmodSync(join(repo, PAGE), 0o755);
    git(repo, 'add', PAGE);
    git(repo, 'commit', '-q', '-m', 'chmod');
    const after = idOf(repo);
    expect(after).not.toBe(before);
    rebaseOntoBaseRow(repo);
    expect(idOf(repo)).not.toBe(after);
  });
});

describe('review-patch-id.sh --pr', () => {
  function setup() {
    const repo = makeRepo();
    const bare = mkdtempSync(join(tmpdir(), 'review-patch-id-origin-'));
    dirs.push(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    git(repo, 'push', '-q', 'origin', 'feature:refs/pull/7/head');
    const stub = mkdtempSync(join(tmpdir(), 'review-patch-id-gh-'));
    dirs.push(stub);
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, 'gh'), '#!/usr/bin/env bash\necho main\n');
    chmodSync(join(stub, 'gh'), 0o755);
    return { repo, stub };
  }

  it('matches the local-ref id and leaves branches and the working tree alone', () => {
    const { repo, stub } = setup();
    const local = run(repo, ['main', 'feature']).stdout;
    const branchesBefore = git(repo, 'branch', '--list');
    const r = run(repo, ['--pr', '7'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(local);
    expect(git(repo, 'branch', '--list')).toBe(branchesBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('--expect-head passes when the fetched head matches, and fails when it does not', () => {
    const { repo, stub } = setup();
    const env = { PATH: `${stub}:${process.env.PATH}` };
    const head = git(repo, 'rev-parse', 'feature');
    const ok = run(repo, ['--pr', '7', '--expect-head', head.toUpperCase()], env);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(run(repo, ['main', 'feature']).stdout);
    const bad = run(repo, ['--pr', '7', '--expect-head', 'f'.repeat(40)], env);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('not the expected head');
  });

  it('names the commits by SHA, so a concurrent fetch that replaces FETCH_HEAD changes nothing', () => {
    const { repo, stub } = setup();
    // An unrelated branch on origin: whatever a second fetch brings in.
    git(repo, 'checkout', '-q', '-b', 'decoy', 'main');
    commitFile(repo, 'decoy.txt', 'not the PR\n');
    git(repo, 'push', '-q', 'origin', 'decoy');
    git(repo, 'checkout', '-q', 'feature');
    // A `git` shim: after each fetch, another fetch in the same worktree
    // overwrites FETCH_HEAD with the decoy.
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const shim = mkdtempSync(join(tmpdir(), 'review-patch-id-git-'));
    dirs.push(shim);
    writeFileSync(join(shim, 'git'), [
      '#!/usr/bin/env bash',
      `"${realGit}" "$@"; status=$?`,
      `if [ "$1" = fetch ] && [ "$status" -eq 0 ]; then "${realGit}" fetch -q origin refs/heads/decoy; fi`,
      'exit "$status"',
      '',
    ].join('\n'));
    chmodSync(join(shim, 'git'), 0o755);
    const head = git(repo, 'rev-parse', 'feature');

    const r = run(repo, ['--pr', '7', '--expect-head', head], { PATH: `${shim}:${stub}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(run(repo, ['main', 'feature']).stdout);
  });

  it('--expect-head is rejected without --pr', () => {
    expect(run(makeRepo(), ['main', '--expect-head', 'a'.repeat(40)]).status).toBe(2);
  });

  it('fails when the pull ref cannot be fetched', () => {
    const { repo, stub } = setup();
    const r = run(repo, ['--pr', '8'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});

// #4205: the places that explain when a passed review survives a rebase must
// name the line-bound reference pages, or a reader expects a re-review the gate
// no longer asks for. Reads the list from the script so the two cannot drift.
describe('review-patch-id line-bound pages are documented', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const listBody = /LINE_BOUND_PATHS=\(([^)]*)\)/.exec(script)?.[1] ?? '';
  const paths = listBody.split(/\s+/).filter(Boolean);
  const basename = (p: string) => p.split('/').pop() ?? p;

  it('reads a non-empty list from the script', () => {
    expect(paths).toContain('docs/reference/environment-variables.md');
    expect(paths.length).toBe(3);
  });

  it('the KOOKR_MERGE_REQUIRE_REVIEW row names every line-bound page', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/reference/environment-variables.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| `KOOKR_MERGE_REQUIRE_REVIEW`')) ?? '';
    for (const p of paths) expect(row).toContain(p);
  });

  it('the skill "Delta re-review after a PASS" section names every line-bound page', () => {
    const skill = readFileSync(
      join(process.cwd(), 'plugin/skills/independent-merge-review/SKILL.md'),
      'utf8',
    );
    const section = skill.split('## Delta re-review after a PASS')[1]?.split('\n## ')[0] ?? '';
    for (const p of paths) expect(section).toContain(p);
  });

  it('the kookr-merge.sh refusal message names every line-bound page', () => {
    const merge = readFileSync(join(process.cwd(), 'scripts/kookr-merge.sh'), 'utf8');
    const refusal = merge.split('\n').find((l) => l.includes('the latest reviewer verdict must be')) ?? '';
    for (const p of paths) expect(refusal).toContain(basename(p));
    expect(refusal).toContain('scripts/review-patch-id.sh');
  });
});
