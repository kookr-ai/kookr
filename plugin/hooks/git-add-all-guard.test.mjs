// Tests for git-add-all-guard.sh (issue #3654): run the real hook (the .sh
// wrapper, as Claude Code does) on PreToolUse events and read its decision.
// The environment is set explicitly: the suite itself runs inside Kookr tasks.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, 'git-add-all-guard.sh');

function baseEnv() {
  const env = { ...process.env };
  delete env.KOOKR_TASK_ID;
  delete env.KOOKR_GIT_ADD_ALL_GUARD_SKIP;
  return env;
}

/** Runs the hook; returns the denial reason, or null when allowed. */
function hook(command, { env = { KOOKR_TASK_ID: 'task-1' }, toolName = 'Bash' } = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: '/tmp' }),
    encoding: 'utf-8',
    env: { ...baseEnv(), ...env },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('git-add-all-guard', () => {
  it('denies the three whole-tree forms with an instruction to stage named paths', () => {
    for (const cmd of ['git add -A', 'git add --all', 'git add .']) {
      const reason = hook(cmd);
      expect(reason, cmd).toContain(`blocked \`${cmd}\``);
      expect(reason, cmd).toContain('Stage the paths you changed by name');
      expect(reason, cmd).toContain('git add -u');
    }
  });

  it('denies other spellings of the same three forms', () => {
    for (const cmd of [
      'git add -fA',
      'git add -Av',
      'git add -A .',
      'git add -- .',
      'git add ./',
      'git add :/',
      'git -C /repo add -A',
      'git -c core.autocrlf=false add .',
      'cd /repo && git add -A && git commit -m wip',
      'make test; git add .',
      'pnpm test | tail -3\ngit add --all',
      "git add -A ':!data'",
      'FOO=1 git add .',
      '/usr/bin/git add -A',
    ]) {
      expect(hook(cmd), cmd).not.toBeNull();
    }
  });

  it('allows named paths, tracked-only and dry-run forms', () => {
    for (const cmd of [
      'git add path/to/file',
      'git add src/a.ts src/b.ts',
      'git add -u',
      'git add --update',
      'git add -u .',
      'git add -A src/new-dir/',
      "git add -A src/ ':!src/generated'",
      'git add -A --pathspec-from-file=changed.txt',
      'git add -n .',
      'git add --dry-run -A',
      'git add -p .',
      'git status --short',
      'git commit -am "x"',
    ]) {
      expect(hook(cmd), cmd).toBeNull();
    }
  });

  it('allows commands that only mention the forms', () => {
    for (const cmd of [
      'git commit -m "never run git add -A here"',
      "echo 'git add .'",
      'grep -rn "git add -A" docs/',
      'cat <<EOF\ngit add -A\nEOF',
    ]) {
      expect(hook(cmd), cmd).toBeNull();
    }
  });

  it('is off outside a Kookr task and with its kill switch', () => {
    expect(hook('git add -A', { env: {} })).toBeNull();
    expect(hook('git add -A', { env: { KOOKR_TASK_ID: '' } })).toBeNull();
    expect(hook('git add -A', { env: { KOOKR_TASK_ID: 'task-1', KOOKR_GIT_ADD_ALL_GUARD_SKIP: '1' } })).toBeNull();
  });

  it('ignores other tools and malformed events (fail open)', () => {
    expect(hook('git add -A', { toolName: 'Edit' })).toBeNull();
    const r = spawnSync('bash', [HOOK], { input: 'not json git add', encoding: 'utf-8', env: { ...baseEnv(), KOOKR_TASK_ID: 't' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is registered as a PreToolUse Bash hook', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const bash = manifest.hooks.PreToolUse.find((m) => m.matcher === 'Bash');
    expect(bash.hooks.map((h) => h.command)).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/git-add-all-guard.sh');
  });
});
