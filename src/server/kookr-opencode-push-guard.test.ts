// Tests bin/kookr-opencode-push-guard.js, the PreToolUse guard that keeps profiled
// opencode workers local-only: no `git push`, no PR merge/create. The classifier is
// unit-tested directly; the script is also spawned the way the generated plugin does
// (payload on stdin, exit 2 = block).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS script without type declarations
import { classifyCommand } from '../../bin/kookr-opencode-push-guard.js';

const GUARD = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'kookr-opencode-push-guard.js');

const blocked = (cmd: string) => expect(classifyCommand(cmd), cmd).toEqual(expect.any(String));
const allowed = (cmd: string) => expect(classifyCommand(cmd), cmd).toBeNull();

describe('classifyCommand: blocks publishing commands', () => {
  it.each([
    'git push',
    'git push origin work/issue-1',
    'git push -u origin HEAD',
    'git push --force-with-lease origin main',
    '/usr/bin/git push',
    'git -C /some/repo push origin x',
    'git -c user.name=x push',
    'git --no-pager push',
    'git --git-dir=.git push',
    'git send-pack origin main',
    'gh pr merge 12',
    'gh pr merge 12 --squash --auto',
    'gh pr create --title t --body b',
    'gh -R kookr-ai/kookr pr create',
    'gh pr --repo kookr-ai/kookr merge 12 --squash',
    'gh pr -R kookr-ai/kookr create --title t',
    'gh release -R o/r create v1',
    'cat <<EOF\n$(git push)\nEOF',
    'echo "$(git push)"',
    'git commit -m "x" && echo "`git push`"',
    'env -u GITHUB_TOKEN git push origin HEAD',
    'env -i PATH=/usr/bin git push',
    '> /dev/null git push origin HEAD',
    '2>&1 git push origin HEAD',
    'printf "%s\\n" "<<EOF"\ngit push origin HEAD',
    "echo '<<EOF'\ngit push origin HEAD",
    "cat <<EOF\n'$(git push)'\nEOF",
    'xargs -n1 -I{} git push {}',
    'echo git push',
    'gh pr new --title t --body b',
    "gh pr --title 'Fix bug' create --body x",
    'gh api -iX PUT repos/o/r/pulls/12/merge',
    'gh api -iXPOST repos/o/r/pulls',
    "/bin/bash <<'EOF'\ngit push origin HEAD\nEOF",
    "cat <<'EOF' | bash\ngit push origin HEAD\nEOF",
    'cat <<END-NOTES\nhello\nEND-NOTES\ngit push origin HEAD',
    'git push>/dev/null',
    'git push 2>&1',
    'git push >out.txt origin HEAD',
    'git push</dev/null',
    'gh pr revert 123',
    'gh release delete-asset v1 f.zip --yes',
    'git 2>/dev/null push origin HEAD',
    'git commit -m "$(git push)"',
    'git commit -m "$(cat <<EOF\n$(git push)\nEOF\n)"',
    'gh pr ready 3',
    'gh pr comment 1 -b x',
    'gh pr edit 1 --add-label x',
    'gh pr update-branch 1',
    'gh release create v1',
    'gh release upload v1 a.zip',
    'git subtree push --prefix d origin b',
    'git push \\\n  origin HEAD',
    'gh api -XPOST repos/o/r/pulls',
    'gh api -XPUT repos/o/r/pulls/3/merge',
    'gh api repos/o/r/issues/1/comments -fbody=hi',
    'gh pr close 3',
    'gh pr review 3 --approve',
    'gh api repos/o/r/pulls/3/merge -X PUT',
    'gh api -X POST repos/o/r/pulls',
    'gh api --method=PATCH repos/o/r/pulls/3',
    'gh api repos/o/r/issues/1/comments -f body=hi',
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }\'',
  ])('blocks %s', blocked);

  it.each([
    'cd repo && git push',
    'npm test; git push origin HEAD',
    'git commit -m x && git push',
    'echo hi | git push',
    'git status\ngit push',
    'FOO=1 git push',
    'sudo git push',
    'env GIT_SSH_COMMAND=x git push',
    'time git push',
    'nohup git push &',
    'bash -c "git push origin HEAD"',
    "sh -c 'cd x && gh pr merge 3'",
    'eval "git push"',
    'echo $(git push)',
    'echo `git push`',
    'xargs git push',
    '( git push )',
    '{ git push; }',
  ])('blocks the compound or wrapped form %s', blocked);
});

describe('classifyCommand: allows local and read-only work', () => {
  it.each([
    'git status',
    'git add -A && git commit -m "fix: push the button"',
    'git commit -m "Closes #3; do not git push"',
    "git commit -m 'docs: explain `git push`'",
    "git commit -m 'docs: run $(git push) later'",
    "echo 'a `gh pr merge 3` b'",
    'git commit -m "docs: explain \\`git push\\`"',
    "cat <<'EOF'\n$(git push)\nEOF",
    'gh pr --repo kookr-ai/kookr view 12',
    '# Do not run `git push`\ngit status',
    'git status # then `git push` later',
    'echo "a # b" && git status',
    'cat <<\\EOF\n$(git push)\nEOF',
    'cat <<EOF > run.sh\ngit push origin HEAD\nEOF',
    'gh pr create --help',
    'gh pr merge -h',
    'git push --help',
    'git status >out.txt',
    "git commit -m \"$(cat <<'EOF'\nfix: guard `git push`\n\nbody mentions $(git push) too\nEOF\n)\"",
    "git add -A && git commit -m \"$(cat <<'EOF'\nfix(x): stop pushing\n\nCo-Authored-By: A <a@b>\nEOF\n)\"",
    'gh pr list --state open',
    'gh pr list --search "merge"',
    'gh pr list --search merge',
    'gh pr list --label review',
    'gh pr list --search "is:open create"',
    'gh release list --limit 5',
    'echo ok >/dev/null',
    'ls 2>&1 | head',
    'git log --oneline origin/main..HEAD',
    'git diff origin/main HEAD',
    'git fetch origin',
    'git pull --rebase',
    'git stash push -m wip',
    'git remote -v',
    'git branch --set-upstream-to=origin/main',
    'echo "git push" > notes.txt',
    'grep -rn "git push" src',
    'cat <<EOF\ngit push\nEOF',
    'gh pr view 12',
    'gh pr list --state open',
    'gh pr diff 12',
    'gh pr checks 12',
    'gh pr status',
    'gh release list',
    'gh release view v1',
    'git subtree split --prefix d',
    'gh api -XGET repos/o/r/pulls/3',
    'gh issue view 3585',
    'gh api repos/o/r/pulls/3',
    'gh api repos/o/r/issues/1 --jq .title',
    'gh api graphql -f query=\'{ viewer { login } }\'',
    'gh api -q .data.viewer graphql -f query=\'{ viewer { login } }\'',
    'gh api -H "Accept: application/json" graphql -f query=\'{ viewer { login } }\'',
    'pnpm exec vitest run src/foo.test.ts',
    'npm run push-assets',
    'ls',
    '',
  ])('allows %s', allowed);
});

describe('script entry point', () => {
  const run = (payload: unknown, raw?: string) =>
    spawnSync(process.execPath, [GUARD], { input: raw ?? JSON.stringify(payload), encoding: 'utf8' });

  it('exits 2 with an explanation on stderr for a Bash push', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/commit locally|operator/i);
    expect(r.stderr).toMatch(/git push/);
  });

  it('exits 0 for a harmless Bash command', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'git status' } }).status).toBe(0);
  });

  it('exits 0 for non-Bash tools, even if a field mentions git push', () => {
    expect(run({ tool_name: 'Write', tool_input: { content: 'git push' } }).status).toBe(0);
    expect(run({ tool_name: 'Read', tool_input: { filePath: '/x/git push' } }).status).toBe(0);
  });

  it('fails open (exit 0) on an empty or malformed payload', () => {
    expect(run(null, '').status).toBe(0);
    expect(run(null, 'not json').status).toBe(0);
    expect(run({ tool_name: 'Bash' }).status).toBe(0);
    expect(run({ tool_name: 'Bash', tool_input: { command: 42 } }).status).toBe(0);
  });
});
