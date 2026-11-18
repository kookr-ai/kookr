// Tests for closes-keyword-guard.sh (issue #4185). The cases are the ones the
// user-level pr-workflow-gate covered for this check (issue #3642, cases
// H1-H13), run through the real hook script.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, 'closes-keyword-guard.sh');
const BRANCH = 'feat/issue-12-thing';

let root;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Runs the hook; returns { verdict: 'deny'|'warn'|'allow', text }. */
function hook(command, cwd = root) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: root },
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return { verdict: 'allow', text: '' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe('PreToolUse');
  if (out.permissionDecision === 'deny') return { verdict: 'deny', text: out.permissionDecisionReason };
  expect(out.permissionDecision).toBeUndefined();
  return { verdict: 'warn', text: out.additionalContext };
}

const create = (bodyArgs) => `gh pr create -R testowner/repo --head ${BRANCH} --title t ${bodyArgs}`;

/** Asserts a deny whose reason shows `form` on its own line. */
function expectDeny(result, form) {
  expect(result.verdict).toBe('deny');
  expect(result.text).toContain('closing keyword inside inline code');
  expect(result.text.split('\n')).toContain(form);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'closes-keyword-guard-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('closes-keyword-guard', () => {
  it('H1: `Closes #12` in inline code → deny, shows the bare form', () => {
    expectDeny(hook(create("--body 'Summary. `Closes #12`'")), 'Closes #12');
  });

  it('H2: escaped backticks in a double-quoted --body → deny', () => {
    expectDeny(hook(create('--body "Summary. \\`Fixes #12\\`"')), 'Fixes #12');
  });

  it('H3: closing keyword inside a fenced block (heredoc) → deny', () => {
    expectDeny(hook(create(`--body "$(cat <<'EOF'
Summary
\`\`\`
Resolves #12
\`\`\`
EOF
)"`)), 'Resolves #12');
  });

  it('H4: bare Closes #12 line → allow, no warning', () => {
    expect(hook(create(`--body "$(cat <<'EOF'
Summary

Closes #12
EOF
)"`)).verdict).toBe('allow');
  });

  it('H5: branch issue only as (#12) → allow with a warning', () => {
    const r = hook(create("--body 'Fix the thing (#12)'"));
    expect(r.verdict).toBe('warn');
    expect(r.text).toContain('Closes #12');
  });

  it('H5b: (#12) plus a bare Closes #12 → no warning', () => {
    expect(hook(create("--body 'Fix the thing (#12). Closes #12'")).verdict).toBe('allow');
  });

  it('H6: deliberate code mention plus a bare closer → allow', () => {
    expect(hook(create("--body 'Closes #12. The old form `Closes #12` did not work.'")).verdict).toBe('allow');
  });

  it('H7: an unclosed backtick does not hide a bare closer → allow', () => {
    expect(hook(create("--body 'it`s fixed. Closes #12'")).verdict).toBe('allow');
  });

  it('H8: --body-file with `Closes #12` → deny', () => {
    const f = join(root, 'body-h8.md');
    writeFileSync(f, 'Summary\n\n`Closes #12`\n');
    expectDeny(hook(create(`--body-file ${f}`)), 'Closes #12');
  });

  it('H9: a ~~~ line inside a ``` fence does not close it → allow', () => {
    expect(hook(create(`--body "$(cat <<'EOF'
\`\`\`
~~~
\`\`\`
Closes #12
EOF
)"`)).verdict).toBe('allow');
  });

  it('H10: a backticked keyword in the title or a chained command is not the body → allow', () => {
    expect(hook(create("--title '`fixes #12` regression' --body 'Closes #12'") + " && echo '`closes #12`'").verdict).toBe('allow');
  });

  it('H11: another issue quoted in a fence (git log) → allow', () => {
    expect(hook(create(`--body "$(cat <<'EOF'
Closes #12
\`\`\`
fix: resolve #77 crash
\`\`\`
EOF
)"`)).verdict).toBe('allow');
  });

  it('H12: a nested fence (```` around ```) still counts as code → deny', () => {
    expectDeny(hook(create(`--body "$(cat <<'EOF'
\`\`\`\`
\`\`\`
Closes #12
\`\`\`
\`\`\`\`
EOF
)"`)), 'Closes #12');
  });

  it('H13: a relative --body-file is found via the event cwd → deny', () => {
    const dir = join(root, 'h13');
    mkdirSync(dir);
    writeFileSync(join(dir, 'body.md'), 'Summary\n\n`Closes #12`\n');
    expectDeny(hook(create('--body-file body.md'), dir), 'Closes #12');
  });

  it('a relative --body-file is found after `cd` in the same command → deny', () => {
    const dir = join(root, 'cd-body');
    mkdirSync(dir);
    writeFileSync(join(dir, 'body.md'), '`Fixes #12`\n');
    expectDeny(hook(`cd ${dir} && ${create('--body-file body.md')}`), 'Fixes #12');
  });

  it('a body written by a heredoc then passed with --body-file → deny', () => {
    const f = join(root, 'not-yet-written.md');
    expectDeny(hook(`cat > ${f} <<'EOF'
Summary
\`Closes #12\`
EOF
${create(`--body-file ${f}`)}`), 'Closes #12');
  });

  it('cross-repo closing reference inside code → deny, shows that form', () => {
    expectDeny(hook(create("--body 'See `Closes acme/widgets#12`'")), 'Closes acme/widgets#12');
  });

  it('cross-repo bare closer → allow', () => {
    expect(hook(create("--body 'Closes acme/widgets#12'")).verdict).toBe('allow');
  });

  it('gh pr edit is checked too, using the checked-out branch', () => {
    const repo = join(root, 'edit-repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=feat/issue-12-edit');
    expectDeny(hook("gh pr edit --body 'Done: `Closes #12`'", repo), 'Closes #12');
    expect(hook("gh pr edit --body 'Fix (#12)'", repo).verdict).toBe('warn');
  });

  it('gh pr edit <N> does not take the issue from the checked-out branch', () => {
    const repo = join(root, 'edit-sel-repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=feat/issue-12-other');
    // PR 77 is not the checkout's branch: its code-only closer is still denied,
    // and no warning names issue #12.
    expectDeny(hook("gh pr edit 77 --body 'Done: `Closes #77`'", repo), 'Closes #77');
    expect(hook("gh pr edit 77 --body 'Fix (#12)'", repo).verdict).toBe('allow');
  });

  it('a relative --body-file is found in the --head branch worktree', () => {
    const main = join(root, 'wt-main');
    mkdirSync(main);
    git(main, 'init', '-q', '--initial-branch=main');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const wt = join(root, 'wt-linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/issue-12-wt', wt);
    writeFileSync(join(wt, 'body.md'), 'Summary\n\n`Closes #12`\n');
    expectDeny(hook('gh pr create --head feat/issue-12-wt --title t --body-file body.md', main), 'Closes #12');
  });

  it('gh pr create inside a quoted command substitution, an if, or braces → deny', () => {
    const body = "--body '`Closes #12`'";
    expectDeny(hook(`PR_URL="$(${create(body)})"`), 'Closes #12');
    expectDeny(hook(`if true; then ${create(body)}; fi`), 'Closes #12');
    expectDeny(hook(`{ ${create(body)}; }`), 'Closes #12');
  });

  it('a branch without an issue number checks every closing keyword in code', () => {
    expectDeny(
      hook("gh pr create --head topic --title t --body '`fixes #77`'"),
      'fixes #77',
    );
  });

  it('a `cd` to an unresolvable path falls back to the event cwd for the branch', () => {
    const repo = join(root, 'cd-var-repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=feat/issue-12-cdvar');
    // Branch issue #12 is known, so the (#12)-only body still gets its warning
    // and a quoted other issue in a fence passes.
    expect(hook(`cd "$WT" && gh pr edit --body 'Fix (#12)'`, repo).verdict).toBe('warn');
    expect(hook(`cd "$WT" && gh pr edit --body "$(cat <<'EOF'
Closes #12
\`\`\`
fix: resolve #77 crash
\`\`\`
EOF
)"`, repo).verdict).toBe('allow');
  });

  it('a comment with an apostrophe does not hide the gh pr create after it', () => {
    expectDeny(hook(`# don't forget the label
${create("--body '`Closes #12`'")}`), 'Closes #12');
  });

  it('commands that are not gh pr create/edit are left alone', () => {
    expect(hook("git commit -m 'gh pr create --body `Closes #12`'").verdict).toBe('allow');
    expect(hook("gh pr view 5 --json body").verdict).toBe('allow');
    expect(hook("echo \"gh pr create --body '\\`Closes #12\\`'\"").verdict).toBe('allow');
  });

  it('is registered in hooks.json as a PreToolUse hook on Bash', () => {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const commands = config.hooks.PreToolUse
      .filter((entry) => entry.matcher === 'Bash')
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/closes-keyword-guard.sh');
  });
});
