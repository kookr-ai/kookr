// Tests for the rerouted `bin/nb.js` shim. kookr no longer vendors the notebook
// CLI — the shim resolves and runs the public `agent-notebook` package, pins
// NB_DIR to the kookr location, and (Objective C) commits every notebook
// mutation when NB_DIR is a git repo so a daily job can push the history.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// The .gitignore the host setup writes into the notebook repo so only the
// lesson files are versioned (not the churny usage ring / retro sentinels).
// `.nb-usage.log*` (glob) covers the append-only log AND its runtime sidecars —
// the atomic-write `.nb-usage.log.tmp` and the row/byte-count state file
// `.nb-usage.log.count` (agent-notebook #135). Matching the tool's own
// git-versioning gitignore (agent-notebook #213) keeps a no-op mutation from
// staging the sidecar and producing a spurious backup commit.
const NOTEBOOK_GITIGNORE = '.nb-usage.log*\n.retro-*\n.nb.lock\n*.tmp\n';

// Strip inherited GIT_* vars so this test's own `git -C <tmpdir>` calls target
// the temp repo and can never leak into the real repo — notably under the
// pre-push hook, where git exports GIT_DIR/GIT_WORK_TREE and they would override
// `-C`. Mirrors src/core/git-helpers NESTED_GIT_ENV_VARS.
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
  ]) delete env[k];
  return env;
}

const BIN = join(process.cwd(), 'bin/nb.js');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-bin-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run `node bin/nb.js <argv>` with NB_DIR=dir; capture stdout/exit. */
function nb(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('node', [BIN, ...args], {
      env: { ...cleanGitEnv(), NB_DIR: dir, ...extraEnv },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? -1, out: err.stdout?.toString() ?? '' };
  }
}

/**
 * The shim's own stderr: everything except the `note: created new shelf "<name>"`
 * line that agent-notebook itself prints (since 0.8.0) when an `add` starts a
 * shelf. The advisory tests assert what the SHIM says, and most of them add to a
 * shelf that does not exist yet.
 */
function shimStderr(stderr: string | null): string {
  return (stderr ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('note: created new shelf '))
    .join('\n');
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: cleanGitEnv() }).trim();
}

function initRepo(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 'nb@test']);
  git(['config', 'user.name', 'nb test']);
  writeFileSync(join(dir, '.gitignore'), NOTEBOOK_GITIGNORE);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'init']);
}

describe('bin/nb.js — dogfooded package', () => {
  test('runs the public agent-notebook package (version line)', () => {
    const r = nb(['--version']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb (agent-notebook)');
  });

  test('add then show round-trips a lesson under the pinned NB_DIR', () => {
    expect(nb(['add', 'patcher', 'prefer execFileSync, array args']).code).toBe(0);
    const show = nb(['show', 'patcher']);
    expect(show.out).toContain('prefer execFileSync, array args');
  });
});

describe('bin/nb.js — per-change git auto-commit (Objective C)', () => {
  test('commits each mutation when NB_DIR is a git repo; reads do not commit', () => {
    initRepo();
    const before = git(['rev-list', '--count', 'HEAD']);
    nb(['add', 'patcher', 'lesson about locks']);
    nb(['vote', 'patcher', 'locks', '+1']);
    const afterMutations = Number(git(['rev-list', '--count', 'HEAD']));
    expect(afterMutations).toBe(Number(before) + 2); // one commit per mutation
    expect(git(['log', '-1', '--format=%s'])).toMatch(/^nb vote patcher/);

    nb(['show', 'patcher']); // a read
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(afterMutations); // no new commit
  });

  test('tracks only lesson files — the usage log/sentinels stay ignored', () => {
    initRepo();
    nb(['add', 'patcher', 'x']);
    nb(['show', 'patcher']); // a read churns the usage log
    const tracked = git(['ls-files']);
    expect(tracked).toContain('patcher.md');
    expect(tracked).not.toContain('.nb-usage.log');
  });

  test('NB_GIT_AUTOCOMMIT=0 disables the auto-commit', () => {
    initRepo();
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['add', 'patcher', 'no commit please'], { NB_GIT_AUTOCOMMIT: '0' });
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // unchanged
  });

  test('is fail-open when NB_DIR is not a git repo (mutation still succeeds)', () => {
    const r = nb(['add', 'patcher', 'works without git']);
    expect(r.code).toBe(0);
    expect(nb(['show', 'patcher']).out).toContain('works without git');
  });

  test('a mutation that changes nothing (duplicate add) creates no commit', () => {
    initRepo();
    nb(['add', 'patcher', 'same lesson']);
    const afterFirst = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['add', 'patcher', 'same lesson']); // dedup-skipped → nothing staged
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(afterFirst); // no empty commit
  });

  test('is fail-open when the git commit itself fails (mutation still succeeds)', () => {
    initRepo();
    // A pre-commit hook that always rejects makes `git commit` fail while the
    // notebook write still lands — exercises the autoCommit() catch in bin/nb.js.
    const hookPath = join(dir, '.git/hooks/pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    const r = nb(['add', 'patcher', 'lands despite failing commit']);
    expect(r.code).toBe(0); // the nb call never fails on a git error
    expect(nb(['show', 'patcher']).out).toContain('lands despite failing commit');
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // commit was rejected
  });

  test('auto-commit targets NB_DIR even when a hostile GIT_DIR is exported', () => {
    // Under a git hook, git exports GIT_DIR/GIT_WORK_TREE; unstripped they would
    // override `-C <NB_DIR>` and commit to the wrong repo. Point them at a decoy
    // repo and assert the commit lands in NB_DIR, not the decoy.
    initRepo();
    const decoy = mkdtempSync(join(tmpdir(), 'kookr-nb-decoy-'));
    try {
      const dgit = (args: string[]) =>
        execFileSync('git', ['-C', decoy, ...args], { encoding: 'utf-8', env: cleanGitEnv() });
      dgit(['init', '-q']);
      dgit(['config', 'user.email', 'd@d']);
      dgit(['config', 'user.name', 'd']);
      dgit(['commit', '--quiet', '--allow-empty', '-m', 'decoy-init']);
      const nbBefore = Number(git(['rev-list', '--count', 'HEAD']));
      const decoyBefore = Number(dgit(['rev-list', '--count', 'HEAD']).trim());

      nb(['add', 'patcher', 'lands in NB_DIR not the decoy'], {
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
      });

      expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(nbBefore + 1); // NB_DIR got it
      expect(Number(dgit(['rev-list', '--count', 'HEAD']).trim())).toBe(decoyBefore); // decoy untouched
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test('a derived @-scoped role (orchestrator@owner-repo) round-trips through the package', () => {
    // Re-anchors the three-way charset agreement: sanitizeRoleSegment (launcher)
    // ↔ hook role regex ↔ the package SAFE_ROLE all accept `role@owner-repo`.
    const role = 'orchestrator@acme-widgets';
    expect(nb(['add', role, 'per-repo orchestrator lesson']).code).toBe(0);
    expect(nb(['show', role]).out).toContain('per-repo orchestrator lesson');
  });
});

describe('bin/nb.js — discovery passes through to the package (no shim interception)', () => {
  // The shim used to intercept `roles`/`list`/`ls` with its own name+count view.
  // The package now owns `nb list` (a richer index with per-shelf descriptions)
  // AND exposes `ls`/`roles` as aliases of it, so the shim intercepts nothing —
  // every discovery command reaches the package instead of being shadowed.
  test('`nb list` / `ls` / `roles` all render the package index', () => {
    nb(['add', 'code-review', 'one']);
    nb(['add', 'patch-author', 'a']);
    const list = nb(['list']);
    const ls = nb(['ls']);
    const roles = nb(['roles']);
    for (const r of [list, ls, roles]) {
      expect(r.code).toBe(0);
      expect(r.out).toContain('code-review');
      expect(r.out).toContain('patch-author');
      // the package index header — proves the command reached the package, not a
      // kookr-local name+count shim view (which rendered "roles —").
      expect(r.out).toContain('notebooks —');
    }
    // `ls` and `roles` are the package's own aliases of `list` → identical output.
    expect(ls.out).toBe(list.out);
    expect(roles.out).toBe(list.out);
  });

  test('discovery is read-only — `nb list` creates no git commit', () => {
    initRepo();
    nb(['add', 'patcher', 'x']); // mutating → one commit
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    nb(['list']);
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before); // list is not mutating
  });
});

describe('bin/nb.js — `move` (promotion) is auto-committed', () => {
  test('nb move produces a commit in a git-backed NB_DIR and the lesson lands in the target', () => {
    initRepo();
    expect(nb(['add', 'topic@acme-widgets', 'a lesson that deserves promotion']).code).toBe(0);
    const before = Number(git(['rev-list', '--count', 'HEAD']));
    const r = nb(['move', 'topic@acme-widgets', 'topic', 'promotion']);
    expect(r.code).toBe(0); // a refused move must not pass silently
    expect(Number(git(['rev-list', '--count', 'HEAD']))).toBe(before + 1);
    expect(git(['log', '-1', '--format=%s'])).toMatch(/^nb move topic@acme-widgets/);
    expect(nb(['show', 'topic']).out).toContain('a lesson that deserves promotion');
  });
});

describe('bin/nb.js — MUTATING set does not drift from `nb --help`', () => {
  /** The verbs `nb --help` says write the notebook: the union of the two notes that
   *  name them ("... accept --json" and "... accept an optional `--reason`"). */
  function helpMutatingVerbs(): Set<string> {
    const help = nb(['--help']).out;
    const verbs = new Set<string>();
    for (const re of [/^\s*- ([a-z/]+) accept --json/m, /^\s*- ([a-z/]+) accept an optional `--reason/m]) {
      const m = re.exec(help);
      if (!m) throw new Error(`nb --help no longer matches ${re}; update this drift test`);
      for (const v of m[1].split('/')) verbs.add(v);
    }
    return verbs;
  }

  function shimMutatingVerbs(): Set<string> {
    const m = /const MUTATING = new Set\(\[([^\]]*)\]\)/.exec(readFileSync(BIN, 'utf-8'));
    if (!m) throw new Error('bin/nb.js MUTATING is no longer a single `new Set([...])` literal');
    return new Set([...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
  }

  test('every verb --help lists as mutating is in the shim set', () => {
    const fromHelp = helpMutatingVerbs();
    // non-vacuous: the parse must at least see the two verbs this guards
    expect(fromHelp.has('add')).toBe(true);
    expect(fromHelp.has('move')).toBe(true);
    const shim = shimMutatingVerbs();
    const missing = [...fromHelp].filter((v) => !shim.has(v));
    expect(missing).toEqual([]);
  });

  test('the shim set holds no read-only verb (it would commit on every read)', () => {
    for (const v of ['show', 'stale', 'search', 'stats', 'path', 'config', 'list', 'ls', 'shelves', 'roles']) {
      expect(shimMutatingVerbs().has(v)).toBe(false);
    }
  });
});

describe('bin/nb.js — placement advisories on `add` (stderr only, never a refusal)', () => {
  /** Like nb() but keeps stderr and pins the two env vars the advisories read. */
  function nbErr(args: string[], env: Record<string, string | undefined>): { code: number; err: string } {
    const base = cleanGitEnv();
    delete base.KOOKR_REPO_SLUG;
    delete base.KOOKR_NB_CURATOR;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    const r = spawnSync('node', [BIN, ...args], { env: { ...base, NB_DIR: dir }, encoding: 'utf-8' });
    return { code: r.status ?? -1, err: shimStderr(r.stderr) };
  }

  test('add to fleet-global without KOOKR_NB_CURATOR warns, but the lesson is still written', () => {
    const r = nbErr(['add', 'fleet-global', 'host fact'], {});
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/advisory: fleet-global is written only by promotion/);
    expect(nb(['show', 'fleet-global']).out).toContain('host fact');
  });

  test('asking for help on add writes nothing, so it gets no advisory', () => {
    for (const flag of ['--help', '-h']) {
      const r = nbErr(['add', 'fleet-global', flag], {});
      expect(r.code, flag).toBe(0);
      expect(r.err, flag).toBe('');
    }
    expect(nb(['show', 'fleet-global']).out).not.toContain('--help');
    // After `--` the token is the lesson text: it is written, and the advisory applies.
    const literal = nbErr(['add', 'fleet-global', '--', '--help'], {});
    expect(literal.code).toBe(0);
    expect(literal.err).toMatch(/advisory: fleet-global is written only by promotion/);
    expect(nb(['show', 'fleet-global']).out).toContain('--help');
  });

  test('add to fleet-global is silent when KOOKR_NB_CURATOR is set', () => {
    const r = nbErr(['add', 'fleet-global', 'host fact'], { KOOKR_NB_CURATOR: '1' });
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/advisory/);
  });

  test("add to another repo's project shelf warns; the lesson is still written", () => {
    const r = nbErr(['add', 'code-review@someone-else', 'x'], { KOOKR_REPO_SLUG: 'acme-widgets' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/advisory: shelf code-review@someone-else is scoped to 'someone-else'.*'acme-widgets'/);
    expect(nb(['show', 'code-review@someone-else']).out).toContain('x');
  });

  test('add to this repo\'s own project shelf, an unscoped shelf, or with no slug set is silent', () => {
    expect(nbErr(['add', 'code-review@acme-widgets', 'a'], { KOOKR_REPO_SLUG: 'acme-widgets' }).err).toBe('');
    expect(nbErr(['add', 'code-review', 'b'], { KOOKR_REPO_SLUG: 'acme-widgets' }).err).toBe('');
    expect(nbErr(['add', 'code-review@someone-else', 'c'], {}).err).toBe(''); // no slug → nothing to compare
  });

  test('a --json flag before the shelf does not hide the shelf from the advisory', () => {
    const r = nbErr(['add', '--json', 'fleet-global', 'host fact two'], {});
    expect(r.err).toMatch(/advisory: fleet-global/);
  });

  test('a --reason value before the shelf is not mistaken for the shelf', () => {
    const r = nbErr(['add', '--reason', 'other', 'fleet-global', 'host fact three'], {});
    expect(r.err).toMatch(/advisory: fleet-global/);
  });

  test('an empty KOOKR_NB_CURATOR counts as unset', () => {
    expect(nbErr(['add', 'fleet-global', 'host fact four'], { KOOKR_NB_CURATOR: '' }).err).toMatch(/advisory/);
  });

  test('a rejected add (too long) prints no advisory: nothing was written to the wrong shelf', () => {
    const r = nbErr(['add', 'fleet-global', 'x'.repeat(300)], {});
    expect(r.code).not.toBe(0);
    expect(r.err).not.toMatch(/advisory/);
  });

  test('a read of fleet-global prints no advisory', () => {
    nbErr(['add', 'fleet-global', 'host fact'], { KOOKR_NB_CURATOR: '1' });
    expect(nbErr(['show', 'fleet-global'], {}).err).not.toMatch(/advisory/);
  });
});

describe('bin/nb.js — the advisory classifies shelves with the shared layers module', () => {
  /** Like nb() but keeps stderr; pins KOOKR_REPO_SLUG and drops KOOKR_NB_CURATOR. */
  function nbErr(args: string[], slug: string | undefined, bin = BIN): { code: number; err: string } {
    const base = cleanGitEnv();
    delete base.KOOKR_REPO_SLUG;
    delete base.KOOKR_NB_CURATOR;
    if (slug !== undefined) base.KOOKR_REPO_SLUG = slug;
    const r = spawnSync('node', [bin, ...args], { env: { ...base, NB_DIR: dir }, encoding: 'utf-8' });
    return { code: r.status ?? -1, err: shimStderr(r.stderr) };
  }

  test('case-insensitive: Code-Review@Kookr-AI-Kookr is this repo\'s shelf for slug kookr-ai-kookr', () => {
    expect(nbErr(['add', 'Code-Review@Kookr-AI-Kookr', 'a'], 'kookr-ai-kookr').err).toBe('');
  });

  test('last @ wins: a@b@c is scoped to c (silent for slug c, advisory for slug b)', () => {
    expect(nbErr(['add', 'a@b@c', 'x'], 'c').err).toBe('');
    expect(nbErr(['add', 'a@b@c', 'y'], 'b').err).toMatch(/scoped to 'c'.*slug is 'b'/);
  });

  test('a legacy slug is the same repo as its canonical slug, in either direction', () => {
    expect(nbErr(['add', 'x@agent-notebook', 'a'], 'jeanibarz-agent-notebook').err).toBe('');
    expect(nbErr(['add', 'x@jeanibarz-agent-notebook', 'b'], 'agent-notebook').err).toBe('');
  });

  test('a@@c is a project shelf of slug c (base `a@`)', () => {
    expect(nbErr(['add', 'a@@c', 'x'], 'c').err).toBe('');
    expect(nbErr(['add', 'a@@c', 'y'], 'd').err).toMatch(/scoped to 'c'.*slug is 'd'/);
  });

  test('the slug is trimmed and a whitespace-only slug counts as unset', () => {
    expect(nbErr(['add', 'x@mine', 'a'], '  mine  ').err).toBe('');
    expect(nbErr(['add', 'x@theirs', 'b'], '   ').err).toBe('');
  });

  describe('guarded import: the shim never breaks when the module cannot be loaded', () => {
    let tree: string;
    beforeEach(() => {
      // A copy of the shim in its own tree. node_modules is linked in so the real
      // agent-notebook package still resolves; plugin/ is left out or sabotaged per test.
      tree = mkdtempSync(join(tmpdir(), 'kookr-nb-shim-tree-'));
      mkdirSync(join(tree, 'bin'));
      copyFileSync(BIN, join(tree, 'bin', 'nb.js'));
      symlinkSync(join(process.cwd(), 'node_modules'), join(tree, 'node_modules'));
    });
    afterEach(() => rmSync(tree, { recursive: true, force: true }));
    const shim = () => join(tree, 'bin', 'nb.js');

    test('control: with the module present the case-insensitive check applies', () => {
      mkdirSync(join(tree, 'plugin', 'hooks', 'lib'), { recursive: true });
      copyFileSync(join(process.cwd(), 'plugin/hooks/lib/notebook-layers.mjs'), join(tree, 'plugin/hooks/lib/notebook-layers.mjs'));
      expect(nbErr(['add', 'Code-Review@Kookr-AI-Kookr', 'a'], 'kookr-ai-kookr', shim()).err).toBe('');
    });

    test('module missing: nb add still succeeds and the advisory falls back to the first-@, case-sensitive check', () => {
      const r = nbErr(['add', 'Code-Review@Kookr-AI-Kookr', 'lesson-xyz'], 'kookr-ai-kookr', shim());
      expect(r.code).toBe(0); // the nb call is unaffected
      expect(r.err).toMatch(/advisory: shelf Code-Review@Kookr-AI-Kookr is scoped to 'Kookr-AI-Kookr'/); // old, case-sensitive rule
      expect(nb(['show', 'Code-Review@Kookr-AI-Kookr']).out).toContain('lesson-xyz');
      expect(nbErr(['add', 'x@mine', 'b'], 'mine', shim()).err).toBe(''); // own shelf is still silent
      expect(nbErr(['show', 'x@mine'], 'mine', shim()).code).toBe(0); // reads are untouched
    });

    test('module present but broken (syntax error): same fallback, exit 0', () => {
      mkdirSync(join(tree, 'plugin', 'hooks', 'lib'), { recursive: true });
      writeFileSync(join(tree, 'plugin/hooks/lib/notebook-layers.mjs'), 'export const x = ;\n');
      const r = nbErr(['add', 'Code-Review@Kookr-AI-Kookr', 'a'], 'kookr-ai-kookr', shim());
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/advisory: shelf Code-Review@Kookr-AI-Kookr is scoped to/);
    });
  });
});
