// Tests bin/kookr-opencode-gate.js, the Stop-hook deliverable gate for opencode
// worker profiles. Uses real temp git repos and spawns the script like the
// generated opencode plugin does (payload on stdin, exit 2 = block).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { gitExecEnv } from '../core/git-helpers.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'kookr-opencode-gate.js');

let root: string;
let repo: string;
let sessionDir: string;

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: gitExecEnv() }).trim();

function run(args: string[], env: Record<string, string> = {}, payload: Record<string, unknown> = {}) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    input: JSON.stringify({ session_id: 'sess-1', cwd: repo, ...payload }),
    encoding: 'utf8',
    env: { ...gitExecEnv(), KOOKR_SESSION_DIR: sessionDir, KOOKR_OPENCODE_GATE_BASE: '', KOOKR_OPENCODE_ISSUE: '', KOOKR_PR_LINT_CMD: '', ...env },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kookr-gate-'));
  repo = join(root, 'repo');
  sessionDir = join(root, 'sess');
  execFileSync('git', ['init', '-q', repo], { env: gitExecEnv() });
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('file:<name>', () => {
  it('blocks (exit 2) naming the missing file, passes once it is non-empty', () => {
    const r = run(['--kind', 'file:REVIEW.md']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REVIEW.md does not exist');
    writeFileSync(join(repo, 'REVIEW.md'), '   \n');
    expect(run(['--kind', 'file:REVIEW.md']).stderr).toContain('empty');
    writeFileSync(join(repo, 'REVIEW.md'), '# findings\n');
    expect(run(['--kind', 'file:REVIEW.md']).status).toBe(0);
  });

  it('uses payload.cwd, not the process cwd', () => {
    writeFileSync(join(repo, 'AUDIT.md'), 'x');
    expect(run(['--kind=file:AUDIT.md'], {}, { cwd: repo }).status).toBe(0);
    expect(run(['--kind=file:AUDIT.md'], {}, { cwd: root }).status).toBe(2);
  });

  it('rejects path-like names without crashing the session', () => {
    const r = run(['--kind', 'file:../x']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid file name');
  });
});

describe('commit-and-pr-body', () => {
  let base: string;
  beforeEach(() => { base = g(repo, 'rev-parse', 'HEAD'); });
  const env = () => ({ KOOKR_OPENCODE_GATE_BASE: base });

  function commit(msg: string) {
    writeFileSync(join(repo, 'a.txt'), `${Math.random()}`);
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-q', '-m', msg);
  }

  it('blocks when there is no commit ahead of the base', () => {
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    const r = run(['--kind', 'commit-and-pr-body'], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('No commit exists ahead');
  });

  it('blocks on uncommitted tracked changes', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    writeFileSync(join(repo, 'a.txt'), 'dirty');
    const r = run(['--kind', 'commit-and-pr-body'], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('uncommitted changes');
  });

  it('requires Closes #N when KOOKR_OPENCODE_ISSUE is set', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    const e = { ...env(), KOOKR_OPENCODE_ISSUE: '42' };
    expect(run(['--kind', 'commit-and-pr-body'], e).stderr).toContain('Closes #42');
    g(repo, 'commit', '-q', '--amend', '-m', 'feat: a\n\nCloses #42');
    expect(run(['--kind', 'commit-and-pr-body'], e).status).toBe(0);
    // #4 must not satisfy #42 prefix collisions
    g(repo, 'commit', '-q', '--amend', '-m', 'feat: a\n\nCloses #421');
    expect(run(['--kind', 'commit-and-pr-body'], e).status).toBe(2);
  });

  it('requires PR_BODY.md', () => {
    commit('feat: a');
    const r = run(['--kind', 'commit-and-pr-body'], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PR_BODY.md is missing');
  });

  it('blocks while the branch commits PR_BODY.md, with the exact untrack instruction; passes once removed from the index', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    g(repo, 'add', 'PR_BODY.md');
    g(repo, 'commit', '-q', '--amend', '--no-edit');
    const r = run(['--kind', 'commit-and-pr-body'], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('git rm --cached PR_BODY.md');
    expect(r.stderr).toContain('git commit --amend --no-edit');
    g(repo, 'rm', '--cached', '-q', 'PR_BODY.md');
    g(repo, 'commit', '-q', '-m', 'chore: untrack PR_BODY.md');
    expect(existsSync(join(repo, 'PR_BODY.md'))).toBe(true);
    expect(run(['--kind', 'commit-and-pr-body'], env()).status).toBe(0);
  });

  it('does not flag a repo whose base already tracks an untouched PR_BODY.md', () => {
    writeFileSync(join(repo, 'PR_BODY.md'), 'fixture');
    g(repo, 'add', 'PR_BODY.md');
    g(repo, 'commit', '-q', '-m', 'fixture');
    base = g(repo, 'rev-parse', 'HEAD');
    commit('feat: a');
    writeFileSync(join(repo, 'a-other.txt'), 'x');
    expect(run(['--kind', 'commit-and-pr-body'], env()).status).toBe(0);
    writeFileSync(join(repo, 'PR_BODY.md'), 'edited and committed');
    g(repo, 'add', 'PR_BODY.md');
    g(repo, 'commit', '-q', '-m', 'oops');
    expect(run(['--kind', 'commit-and-pr-body'], env()).stderr).toContain('git rm --cached PR_BODY.md');
  });

  it('does not flag an untracked PR_BODY.md or a same-named file in a subdirectory', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'PR_BODY.md'), 'x');
    g(repo, 'add', 'docs/PR_BODY.md');
    g(repo, 'commit', '-q', '-m', 'docs: sample');
    expect(run(['--kind', 'commit-and-pr-body'], env()).status).toBe(0);
  });

  it('runs the lint command with {pr_body} substituted and feeds back its output', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), '- [ ] tests');
    const lint = `grep -q '\\[x\\]' {pr_body} || { echo "unticked box: tests"; exit 1; }`;
    const r = run(['--kind', 'commit-and-pr-body', '--lint-cmd', lint], env());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unticked box: tests');
    expect(r.stderr).toContain('tick a box only if your diff really satisfies it');
    writeFileSync(join(repo, 'PR_BODY.md'), '- [x] tests');
    expect(run(['--kind', 'commit-and-pr-body', '--lint-cmd', lint], env()).status).toBe(0);
  });

  it('takes the lint command from KOOKR_PR_LINT_CMD and passes a quoted path with spaces', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'ok');
    expect(run(['--kind', 'commit-and-pr-body'], { ...env(), KOOKR_PR_LINT_CMD: 'test -s {pr_body}' }).status).toBe(0);
    expect(run(['--kind', 'commit-and-pr-body'], { ...env(), KOOKR_PR_LINT_CMD: 'exit 3' }).status).toBe(2);
  });

  it('falls back to the merge-base with main when no base is given', () => {
    g(repo, 'branch', '-M', 'main');
    g(repo, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    expect(run(['--kind', 'commit-and-pr-body']).stderr).toContain('No commit exists ahead');
    commit('feat: a');
    expect(run(['--kind', 'commit-and-pr-body']).status).toBe(0);
  });

  it('falls back to the merge-base when the recorded base no longer resolves', () => {
    g(repo, 'branch', '-M', 'main');
    g(repo, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    const gone = { KOOKR_OPENCODE_GATE_BASE: 'f'.repeat(40) };
    // Nothing ahead of main: the check must still fire, not be skipped.
    expect(run(['--kind', 'commit-and-pr-body'], gone).stderr).toContain('No commit exists ahead');
    commit('feat: a');
    expect(run(['--kind', 'commit-and-pr-body'], gone).status).toBe(0);
  });

  it('says the check was skipped when the base and every fallback are unresolvable', () => {
    g(repo, 'branch', '-M', 'trunk');
    const gone = { KOOKR_OPENCODE_GATE_BASE: 'f'.repeat(40) };
    // No PR_BODY.md so the gate blocks and must explain the skipped check.
    const r = run(['--kind', 'commit-and-pr-body'], gone);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not be resolved');
    expect(r.stderr).not.toContain('No commit exists ahead');
  });

  it('honours --base over the env base', () => {
    commit('feat: a');
    writeFileSync(join(repo, 'PR_BODY.md'), 'body');
    const head = g(repo, 'rev-parse', 'HEAD');
    expect(run(['--kind', 'commit-and-pr-body', '--base', head], env()).status).toBe(2);
    expect(run(['--kind', 'commit-and-pr-body', '--base', base], { KOOKR_OPENCODE_GATE_BASE: head }).status).toBe(0);
  });
});

describe('loop guard', () => {
  it('blocks three times per session, then allows with a note; other sessions are independent', () => {
    for (let i = 0; i < 3; i++) expect(run(['--kind', 'file:X.md']).status).toBe(2);
    const fourth = run(['--kind', 'file:X.md']);
    expect(fourth.status).toBe(0);
    expect(fourth.stderr).toContain('allowing stop');
    expect(run(['--kind', 'file:X.md'], {}, { session_id: 'other' }).status).toBe(2);
  });

  it('fails open on a missing --kind or garbage stdin', () => {
    expect(run([]).status).toBe(0);
    const r = spawnSync(process.execPath, [GATE, '--kind', 'file:X.md'], { input: 'not json', encoding: 'utf8', cwd: repo, env: { ...gitExecEnv(), KOOKR_SESSION_DIR: sessionDir } });
    expect(r.status).toBe(2);
    expect(existsSync(sessionDir)).toBe(true);
  });
});
