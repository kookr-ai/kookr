// Tests for worktree-deps-hint.sh (issue #3652): build a worktree-shaped
// directory on disk, run the real hook (the .sh wrapper, as Claude Code does)
// on a PostToolUse event for `git worktree add`, and read the note.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, 'worktree-deps-hint.sh');
const ROOT = mkdtempSync(join(tmpdir(), 'worktree-deps-hint-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A directory that looks like a freshly added worktree with these files. */
function worktree(name, files) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
  for (const f of files) {
    if (f.endsWith('/')) mkdirSync(join(dir, f), { recursive: true });
    else writeFileSync(join(dir, f), '');
  }
  return dir;
}

/** Runs the hook; returns the note, or null when it says nothing. */
function hook(command, { cwd = ROOT, env = {}, toolName = 'Bash' } = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, tool_response: { stdout: '', stderr: '' }, cwd }),
    encoding: 'utf-8',
    env: { ...process.env, KOOKR_WORKTREE_DEPS_HINT_SKIP: '', ...env },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}

describe('worktree-deps-hint', () => {
  it('prints `npm ci` with the worktree path after an npm worktree is added', () => {
    const dir = worktree('npm-wt', ['package.json', 'package-lock.json']);
    const note = hook('git worktree add npm-wt -b feat origin/main');
    expect(note).toContain(`\`cd ${dir} && npm ci\``);
    expect(note).toContain('package-lock.json but no node_modules');
  });

  it('prints the pnpm install command for a pnpm worktree', () => {
    const dir = worktree('pnpm-wt', ['package.json', 'pnpm-lock.yaml']);
    expect(hook(`git worktree add ${dir}`)).toContain(`\`cd ${dir} && pnpm install --frozen-lockfile\``);
  });

  it('prints the yarn install command, `--immutable` for Yarn 2+', () => {
    const classic = worktree('yarn1-wt', ['yarn.lock']);
    expect(hook(`git worktree add ${classic}`)).toContain('yarn install --frozen-lockfile');
    const berry = worktree('yarn2-wt', ['yarn.lock', '.yarnrc.yml']);
    expect(hook(`git worktree add ${berry}`)).toContain('yarn install --immutable');
  });

  it('says nothing when dependencies are present or there is no lockfile', () => {
    worktree('installed-wt', ['package-lock.json', 'node_modules/']);
    expect(hook('git worktree add installed-wt')).toBeNull();
    worktree('nolock-wt', ['package.json']);
    expect(hook('git worktree add nolock-wt')).toBeNull();
    worktree('cargo-wt', ['Cargo.lock']);
    expect(hook('git worktree add cargo-wt')).toBeNull();
  });

  it('says nothing when the add failed (no worktree on disk)', () => {
    mkdirSync(join(ROOT, 'not-a-worktree'), { recursive: true });
    writeFileSync(join(ROOT, 'not-a-worktree', 'package-lock.json'), '');
    expect(hook('git worktree add not-a-worktree')).toBeNull();
    expect(hook('git worktree add does-not-exist')).toBeNull();
  });

  it('finds the path through cd, git -C, options and a pipeline', () => {
    const dir = worktree('repo/../moved-wt', ['package-lock.json']);
    mkdirSync(join(ROOT, 'repo'), { recursive: true });
    const cmd = `cd ${ROOT}/repo && git fetch origin main && git worktree add ../moved-wt -b feat origin/main -q 2>&1 | tail -2; cd ../moved-wt && ls`;
    expect(hook(cmd, { cwd: '/' })).toContain(`cd ${join(ROOT, 'moved-wt')} && npm ci`);
    expect(dir).toBe(join(ROOT, 'moved-wt'));
    expect(hook(`git -C ${ROOT}/repo worktree add --lock --reason why -B b ../moved-wt`, { cwd: '/' })).toContain('npm ci');
    expect(hook(`git worktree add -f --detach -- moved-wt HEAD`)).toContain('npm ci');
  });

  it('quotes a path with spaces in the command it prints', () => {
    const dir = worktree('with space', ['package-lock.json']);
    expect(hook(`git worktree add "${dir}"`)).toContain(`\`cd '${dir}' && npm ci\``);
  });

  it('ignores other git worktree commands, mentions, other tools and its kill switch', () => {
    worktree('other-wt', ['package-lock.json']);
    expect(hook('git worktree list')).toBeNull();
    expect(hook('git worktree remove other-wt')).toBeNull();
    expect(hook('echo "git worktree add other-wt"')).toBeNull();
    expect(hook('git worktree add other-wt', { toolName: 'Edit' })).toBeNull();
    expect(hook('git worktree add other-wt', { env: { KOOKR_WORKTREE_DEPS_HINT_SKIP: '1' } })).toBeNull();
    expect(hook('git worktree add other-wt')).toContain('npm ci');
  });

  it('is registered as a PostToolUse Bash hook', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const bash = manifest.hooks.PostToolUse.find((m) => m.matcher === 'Bash');
    expect(bash.hooks.map((h) => h.command)).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/worktree-deps-hint.sh');
  });
});
