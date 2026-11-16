// Tests for upstream-lag-notice.sh (issue #3653): build real repositories (a
// bare "origin" and clones of it) in a temp directory, run the real hook (the
// .sh wrapper, as Claude Code does) on a SessionStart event, and read the note.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, 'upstream-lag-notice.sh');
const ROOT = mkdtempSync(join(tmpdir(), 'upstream-lag-notice-'));

/** The test's environment without inherited git or hook settings (a pre-push hook sets GIT_DIR). */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && !k.startsWith('KOOKR_UPSTREAM_LAG')) env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1', HOME: ROOT,
    ...extra,
  };
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: cleanEnv() }).trim();

function commits(dir, n, tag) {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, 'f.txt'), `${tag} ${i}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', `${tag} ${i}`);
  }
}

/** Runs the hook; returns { note, ms }. */
function hook(cwd, { env = {}, source = 'startup' } = {}) {
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd }),
    encoding: 'utf-8',
    env: cleanEnv(env),
  });
  const ms = Date.now() - started;
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return { note: null, ms };
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return { note: out.hookSpecificOutput.additionalContext, ms };
}

const ORIGIN = join(ROOT, 'origin.git');
const SEED = join(ROOT, 'seed');
const BEHIND = join(ROOT, 'behind');
const OFFLINE = join(ROOT, 'offline');

beforeAll(() => {
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  git(ROOT, 'init', '-q', '-b', 'main', SEED);
  commits(SEED, 1, 'base');
  git(SEED, 'remote', 'add', 'origin', ORIGIN);
  git(SEED, 'push', '-q', 'origin', 'main');
  git(ROOT, 'clone', '-q', ORIGIN, BEHIND);
  git(ROOT, 'clone', '-q', ORIGIN, OFFLINE);
  commits(SEED, 10, 'later');
  git(SEED, 'push', '-q', 'origin', 'main');
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('upstream-lag-notice', () => {
  it('warns with the count when the checkout is 10 commits behind origin/main', () => {
    const { note } = hook(BEHIND);
    expect(note).toContain('is 10 commits behind `origin/main`');
    expect(note).toContain('branch `main`');
    expect(note).toContain('git show origin/main:<path>');
    expect(note).toContain('fresh worktree');
  });

  it('says nothing when the checkout is current', () => {
    const current = join(ROOT, 'current');
    git(ROOT, 'clone', '-q', ORIGIN, current);
    expect(hook(current).note).toBeNull();
    // A checkout ahead of origin/main is not behind it.
    commits(current, 2, 'mine');
    expect(hook(current).note).toBeNull();
  });

  it('says nothing without an origin remote or outside a git checkout', () => {
    const local = join(ROOT, 'local');
    git(ROOT, 'init', '-q', '-b', 'main', local);
    commits(local, 1, 'x');
    expect(hook(local).note).toBeNull();
    const plain = join(ROOT, 'plain');
    mkdirSync(plain);
    expect(hook(plain).note).toBeNull();
  });

  it('returns well before a hung fetch, and counts from the last fetched ref ("at least")', () => {
    git(OFFLINE, 'fetch', '-q', 'origin');
    git(OFFLINE, 'remote', 'set-url', 'origin', 'ssh://git@unreachable.invalid/repo.git');
    // The "network" never answers: the ssh transport sleeps far past the timeout.
    git(OFFLINE, 'config', 'core.sshCommand', 'sleep 20');
    const { note, ms } = hook(OFFLINE, { env: { KOOKR_UPSTREAM_LAG_FETCH_TIMEOUT_MS: '300' } });
    expect(ms).toBeLessThan(10_000);
    expect(note).toContain('is at least 10 commits behind `origin/main` as of the last fetch');
  });

  it('falls back to origin/main when origin/HEAD is unset, and follows origin/HEAD when set', () => {
    const noHead = join(ROOT, 'no-head');
    git(ROOT, 'clone', '-q', ORIGIN, noHead);
    git(noHead, 'reset', '-q', '--hard', 'HEAD~3');
    git(noHead, 'remote', 'set-head', 'origin', '-d');
    expect(hook(noHead).note).toContain('is 3 commits behind `origin/main`');

    git(SEED, 'push', '-q', 'origin', 'main:trunk');
    const trunk = join(ROOT, 'trunk');
    git(ROOT, 'clone', '-q', ORIGIN, trunk);
    git(trunk, 'fetch', '-q', 'origin');
    git(trunk, 'remote', 'set-head', 'origin', 'trunk');
    git(trunk, 'checkout', '-q', '--detach', 'HEAD~1');
    const { note } = hook(trunk);
    expect(note).toContain('is 1 commit behind `origin/trunk`');
    expect(note).toContain('a detached HEAD');
  });

  it('says nothing on compaction and with its kill switch', () => {
    expect(hook(BEHIND, { source: 'compact' }).note).toBeNull();
    expect(hook(BEHIND, { env: { KOOKR_UPSTREAM_LAG_SKIP: '1' } }).note).toBeNull();
    expect(hook(BEHIND, { source: 'resume' }).note).toContain('10 commits behind');
  });

  it('fails open on a malformed event', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf-8', cwd: ROOT, env: cleanEnv() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is registered as a SessionStart hook with a hard timeout', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const entry = manifest.hooks.SessionStart.flatMap((m) => m.hooks)
      .find((h) => h.command === '${CLAUDE_PLUGIN_ROOT}/hooks/upstream-lag-notice.sh');
    expect(entry).toBeDefined();
    expect(entry.timeout).toBeLessThanOrEqual(5);
  });
});
