// Tests for pr-create-delivery-note.sh (issue #3913): run the real hook against
// real git checkouts in a temp directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, 'pr-create-delivery-note.sh');
const URL = 'https://github.com/owner/name/pull/42';

let root;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone whose origin/main may carry the delivery-gate config; origin's URL names owner/name. */
function checkout(name, { config = true } = {}) {
  const origin = join(root, `${name}-origin.git`);
  const seed = join(root, `${name}-seed`);
  const dir = join(root, name);
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '--initial-branch=main');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  if (config) {
    mkdirSync(join(seed, '.kookr'));
    writeFileSync(join(seed, '.kookr/delivery-gate.json'), '{"integrationBranch":"staging","prePushGate":"fast"}\n');
  }
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, dir);
  git(dir, 'remote', 'set-url', 'origin', 'https://github.com/owner/name.git');
  return dir;
}

/** Runs the hook; returns the note, or null when it printed nothing. */
function hook(command, cwd, stdout = `${URL}\n`, extra = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' }, cwd, ...extra }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: root },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  expect(out.hookSpecificOutput).not.toHaveProperty('decision');
  expect(out).not.toHaveProperty('decision');
  return out.hookSpecificOutput.additionalContext;
}

let gated;
let plain;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-create-delivery-note-'));
  gated = checkout('gated');
  plain = checkout('plain', { config: false });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pr-create-delivery-note', () => {
  it('after a pull request opened against main, says it is expected and names the merge command and what the train does', () => {
    for (const command of ['gh pr create --base main --title t --body b', 'gh pr create --title t --body-file /tmp/b.md']) {
      const note = hook(command, gated);
      expect(note).toContain('pull request #42 is open against `main`. That is expected');
      expect(note).toContain('integration branch `staging`');
      expect(note).toContain('`kookr merge 42 --repo owner/name`');
      expect(note).toContain('retargets the pull request to `staging`');
      expect(note).toContain('runs the full test suite on `staging` and moves `main`');
      expect(note).toContain('Do not change the base yourself and do not merge with `gh pr merge`');
    }
  });

  it('after a pull request opened against the integration branch, says that works but is not needed', () => {
    const note = hook('gh pr create -B staging --title t --body b', gated);
    expect(note).toContain('is open against `staging`, the integration branch. That works, but it is not needed');
    expect(note).toContain('`kookr merge 42 --repo owner/name`');
  });

  it('says nothing in a repository with no integration branch', () => {
    expect(hook('gh pr create --base main --title t --body b', plain)).toBeNull();
  });

  it('says nothing for a stacked pull request, a failed create, or a command that only mentions gh pr create', () => {
    expect(hook('gh pr create --base feat/parent --title t --body b', gated)).toBeNull();
    expect(hook('gh pr create --base main --title t --body b', gated, 'pull request create failed: GraphQL error\n')).toBeNull();
    expect(hook('echo "gh pr create --base main"', gated)).toBeNull();
    expect(hook('git commit -m "docs: explain gh pr create"', gated)).toBeNull();
  });

  it('follows cd to the checkout the pull request is created from', () => {
    expect(hook(`cd ${gated} && gh pr create --title t --body b`, plain)).toContain('integration branch `staging`');
    expect(hook(`cd ${plain} && gh pr create --title t --body b`, gated)).toBeNull();
  });

  it('says nothing when --repo names another repository, and notes it when --repo names this one', () => {
    expect(hook('gh pr create --repo other/thing --title t --body b', gated, 'https://github.com/other/thing/pull/9\n')).toBeNull();
    expect(hook('gh pr create --repo owner/name --title t --body b', gated)).toContain('#42');
  });

  it('takes the PR number from a multi-line create output that also carries a body heredoc', () => {
    const command = "gh pr create --title t --body-file - <<'EOF'\nCloses #3913\nsee https://github.com/owner/name/pull/1\nEOF";
    const note = hook(command, gated, `Warning: 1 uncommitted change\nhttps://github.com/owner/name/pull/77\n`);
    expect(note).toContain('pull request #77 is open');
  });

  it('never blocks: bad input, another tool, or no output all exit 0 silently', () => {
    for (const input of ['not json', '{}', JSON.stringify({ tool_name: 'Edit', tool_input: {}, cwd: gated })]) {
      const r = spawnSync('bash', [HOOK], { input, encoding: 'utf-8', env: { ...process.env, HOME: root } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(hook('gh pr create --title t', gated, '')).toBeNull();
  });

  it('is registered as a PostToolUse hook on Bash in hooks.json', () => {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const commands = config.hooks.PostToolUse
      .filter((entry) => entry.matcher === 'Bash')
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/pr-create-delivery-note.sh');
  });
});
