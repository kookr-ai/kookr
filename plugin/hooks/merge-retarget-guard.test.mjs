// Tests for merge-retarget-guard.sh (issue #3803): run the real hook against
// real git checkouts in a temp directory, with a fake `gh` on PATH.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitCommands } from './merge-retarget-guard.mjs';

const HOOK = join(import.meta.dirname, 'merge-retarget-guard.sh');

let root;
let fakeBin;
let ghLog;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone of a fresh origin whose main may carry the delivery-gate config. */
function checkout(name, { config = true, script = 'new' } = {}) {
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
  if (script) {
    // The working tree of this checkout holds its own merge script, as a
    // checkout parked on an old branch does.
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    const body = script === 'new'
      ? '#!/usr/bin/env bash\nretarget_to_integration_branch() { :; }\nretarget_to_integration_branch\n'
      : '#!/usr/bin/env bash\ngh pr merge "$1" --squash\n';
    writeFileSync(join(dir, 'scripts', 'kookr-merge.sh'), body);
    if (script === 'new') writeFileSync(join(dir, 'scripts', 'lib', 'delivery-gate.sh'), '# reader\n');
  }
  return dir;
}

/** Runs the hook; returns the denial reason, or null when allowed. */
function hook(command, cwd, { base = 'main' } = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: root, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_BASE: base, FAKE_GH_LOG: ghLog },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

let stale;
let fresh;
let plain;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-retarget-guard-'));
  fakeBin = join(root, 'bin');
  ghLog = join(root, 'gh.log');
  mkdirSync(fakeBin);
  // Fake gh: answers `gh pr view ... --json baseRefName` with $FAKE_GH_BASE;
  // an empty FAKE_GH_BASE means the lookup failed.
  writeFileSync(join(fakeBin, 'gh'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$FAKE_GH_LOG"',
    'if [ "$1 $2" = "pr view" ] && [ -n "$FAKE_GH_BASE" ]; then echo "$FAKE_GH_BASE"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(join(fakeBin, 'gh'), 0o755);
  stale = checkout('stale', { script: 'old' });
  fresh = checkout('fresh', { script: 'new' });
  plain = checkout('plain', { config: false, script: 'old' });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('merge-retarget-guard', () => {
  it('denies the #3802 sequence: pnpm merge in a checkout whose merge script cannot retarget', () => {
    const reason = hook(`cd ${stale} && pnpm -s merge 3802`, fresh);
    expect(reason).toMatch(/predates the retarget step/);
    expect(reason).toContain('kookr merge <PR> --repo');
    expect(reason).toMatch(/Never change directory to the main checkout/);
    expect(hook('pnpm merge 3802', stale)).toMatch(/predates/);
    expect(hook(`pnpm -C ${stale} merge 3802`, fresh)).toMatch(/predates/);
    expect(hook(`pnpm --dir=${stale} run merge 3802`, fresh)).toMatch(/predates/);
    expect(hook('npm run merge 3802', stale)).toMatch(/predates/);
  });

  it('denies running an old merge script by path, even from a current checkout', () => {
    expect(hook(`bash ${stale}/scripts/kookr-merge.sh 3802`, fresh)).toMatch(/predates/);
    expect(hook('bash scripts/kookr-merge.sh 3802', stale)).toMatch(/predates/);
    expect(hook('./scripts/kookr-merge.sh 3802', stale)).toMatch(/predates/);
  });

  it('allows the current merge script and kookr merge', () => {
    expect(hook('pnpm -s merge 3802', fresh)).toBeNull();
    expect(hook('bash scripts/kookr-merge.sh 3802', fresh)).toBeNull();
    expect(hook(`cd ${fresh} && pnpm merge 3802`, stale)).toBeNull();
    expect(hook('kookr merge 3802 --repo kookr-ai/kookr', stale)).toBeNull();
    expect(hook(`cd ${stale} && kookr merge 3802 --repo kookr-ai/kookr`, fresh)).toBeNull();
  });

  it('starts each split from the event cwd, not where the previous split left off (#3895)', () => {
    // The comment makes the two splits differ, so both run. If the second one
    // started in the stale checkout the first one moved to, it would deny.
    expect(hook(`pnpm merge 1; cd ${stale} # back`, fresh)).toBeNull();
  });

  it('allows everything when the repository configures no integration branch', () => {
    expect(hook('pnpm -s merge 3802', plain)).toBeNull();
    expect(hook('bash scripts/kookr-merge.sh 3802', plain)).toBeNull();
    expect(hook('gh pr merge 3802 --squash', plain)).toBeNull();
    expect(hook('gh api --method PUT repos/o/r/pulls/3802/merge', plain)).toBeNull();
  });

  it('denies gh pr merge and the REST merge aimed at main, allows them aimed at the integration branch', () => {
    expect(hook('gh pr merge 3802 --squash', fresh, { base: 'main' })).toMatch(/into main directly/);
    expect(hook('KOOKR_X=1 gh pr merge --squash --repo o/r 3802', fresh, { base: 'main' })).toMatch(/into main directly/);
    expect(hook('gh api -X PUT repos/o/r/pulls/3802/merge -f merge_method=squash', fresh, { base: 'main' }))
      .toMatch(/REST merge endpoint/);
    expect(hook('gh api --method=PUT repos/{owner}/{repo}/pulls/3802/merge', fresh, { base: 'main' }))
      .toMatch(/REST merge endpoint/);
    expect(hook('gh pr merge 3802 --squash', fresh, { base: 'staging' })).toBeNull();
    expect(hook('gh api -X PUT repos/o/r/pulls/3802/merge', fresh, { base: 'staging' })).toBeNull();
    // A stacked PR (base is another feature branch) is not this guard's business.
    expect(hook('gh pr merge 3802', fresh, { base: 'feature-x' })).toBeNull();
  });

  it('looks up the pull request once when the command has no comment (#3898)', () => {
    const lookups = () => {
      const log = existsSync(ghLog) ? readFileSync(ghLog, 'utf-8') : '';
      return log.split('\n').filter((l) => l.startsWith('pr view')).length;
    };
    const before = lookups();
    expect(hook('gh pr merge 3802 --squash', fresh, { base: 'staging' })).toBeNull();
    expect(lookups() - before).toBe(1);
  });

  it('reads the word after a <<< here-string as its input, not as the pull request (#3894)', () => {
    writeFileSync(ghLog, '');
    expect(hook('gh pr merge <<< 7', fresh, { base: 'main' })).toMatch(/into main directly/);
    expect(readFileSync(ghLog, 'utf-8')).toBe('pr view --json baseRefName --jq .baseRefName\n');
  });

  it('denies a gh merge whose base cannot be read in a configured repository (fails closed)', () => {
    expect(hook('gh pr merge 3802', fresh, { base: '' })).toMatch(/could not be read/);
  });

  it('allows commands that only mention a merge in quotes, messages or reads', () => {
    expect(hook('git commit -m "fix: stop pnpm merge from bypassing; gh pr merge 1"', stale)).toBeNull();
    expect(hook("grep -rn 'pnpm merge' docs && echo 'gh pr merge 5'", stale)).toBeNull();
    expect(hook('gh pr create --title t --body "run gh pr merge 3 after"', fresh, { base: 'main' })).toBeNull();
    expect(hook('gh api repos/o/r/pulls/3802/merge', fresh, { base: 'main' })).toBeNull();
    expect(hook('cat <<EOF > notes.md\npnpm merge 3802\ngh pr merge 1\nEOF\nls', stale)).toBeNull();
    expect(hook('git merge --no-edit origin/main', stale)).toBeNull();
  });

  it('still denies a merge after a # that bash does not read as a comment', () => {
    for (const prefix of ['l=${l%% #*}', 'echo ${x:- #y}', 'echo ${x:+ #}', 'echo ${x/ #/_}', 'echo `echo a #b`', 'x=`ls #`']) {
      expect(hook(`${prefix}; pnpm merge 1`, stale), prefix).toMatch(/predates/);
    }
    expect(hook('[[ $l =~ ^( #|$) ]] && pnpm merge 1', stale)).toMatch(/predates/);
    // The comment split takes this `(#` for a comment; the plain split still sees the merge.
    expect(hook('[[ $l =~ ^(#|$) ]] && pnpm merge 1', stale)).toMatch(/predates/);
    // A real comment with an apostrophe does not hide the next line either,
    // also right after `(` (#3899).
    expect(hook("# don't skip it\npnpm merge 1", stale)).toMatch(/predates/);
    expect(hook("(# don't skip it\npnpm merge 1)", stale)).toMatch(/predates/);
  });
});

describe('splitCommands', () => {
  it('splits on shell operators outside quotes and drops heredoc bodies', () => {
    expect(splitCommands('cd /x && pnpm -s merge 1; echo "a; b" | tee f')).toEqual([
      ['cd', '/x'], ['pnpm', '-s', 'merge', '1'], ['echo', 'a; b'], ['tee', 'f'],
    ]);
    expect(splitCommands("cat <<'EOF'\npnpm merge 1\nEOF\nls")).toEqual([['cat'], ['ls']]);
    expect(splitCommands("# don't merge yet\npnpm merge 1", { comments: true })).toEqual([['pnpm', 'merge', '1']]);
    expect(splitCommands('echo a # b; c\nls', { comments: true })).toEqual([['echo', 'a'], ['ls']]);
    // The here-string word is input, not an argument; only that one word is dropped (#3894).
    expect(splitCommands('jq . <<< "$x"\npnpm merge 1')).toEqual([['jq', '.'], ['pnpm', 'merge', '1']]);
    expect(splitCommands('gh pr merge <<< 7 8')).toEqual([['gh', 'pr', 'merge', '8']]);
    expect(splitCommands('gh pr merge <<<7')).toEqual([['gh', 'pr', 'merge']]);
    expect(splitCommands('cat <<<\ngh pr merge 7')).toEqual([['cat'], ['gh', 'pr', 'merge', '7']]);
    expect(splitCommands('cat <<< ; gh pr merge 7')).toEqual([['cat'], ['gh', 'pr', 'merge', '7']]);
    // Right after `(`, a `#` starts a comment, as in bash (#3899).
    expect(splitCommands("(# don't merge\nls)", { comments: true })).toEqual([['ls']]);
    expect(splitCommands("echo $(# don't\nls)", { comments: true })).toEqual([['echo', '$'], ['ls']]);
    // A `#` inside a word, or right after `)`, does not start a comment.
    for (const src of ['echo $#', 'echo ${#x}', 'echo a#b', 'echo "x"#y', 'f=out-$(date +%s)#1', 'echo $((16#ff))#y']) {
      expect(splitCommands(`${src}; pnpm merge 1`, { comments: true }).at(-1), src).toEqual(['pnpm', 'merge', '1']);
    }
    expect(splitCommands('(cd /y && bash scripts/kookr-merge.sh 2)')).toEqual([
      ['cd', '/y'], ['bash', 'scripts/kookr-merge.sh', '2'],
    ]);
  });
});
