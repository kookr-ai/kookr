#!/usr/bin/env node
// Logic for pr-create-delivery-note.sh (issue #3913). Reads a Claude Code
// PostToolUse event (Bash tool) from stdin. When the command opened a pull
// request with `gh pr create` in a repository that merges through an
// integration branch (`.kookr/delivery-gate.json` on origin/main), it adds one
// short note to the agent's context.
//
// Why: `gh pr create --base main` prints only the URL. Nothing says that a base
// of `main` is expected and that `kookr merge` will move the pull request to
// the integration branch, so an agent (or the operator reading its transcript)
// can think the task is bypassing that branch, change the base by hand, or
// merge with `gh`. The note says what happened, why, and what comes next.
//
// A note is added only when all of these hold:
//   - a simple command in the Bash call is `gh pr create` (quotes, heredocs and
//     `cd` are handled by the same splitter as merge-retarget-guard.mjs);
//   - its output contains the URL of a pull request, so the pull request
//     exists (`--web`, `--dry-run` and a failed create print none);
//   - the repository of its working directory configures an integration
//     branch, and the repository gh targets names that same repository: the
//     `--repo` flag, else a `GH_REPO=...` prefix on the command, else the
//     GH_REPO environment variable (gh reads it like `--repo`);
//   - the output holds a pull-request URL of that repository; the number comes
//     from the last such URL, so a URL of another repository (in a warning, say)
//     is never named;
//   - its base is `main` (given or defaulted) or the integration branch. A
//     stacked pull request (any other base) gets no note.
//
// Never blocks: exit 0 always, and any crash prints nothing.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue, integrationBranchAt, originRepo, splitCommands, stripPrefixes } from './merge-retarget-guard.mjs';

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Each `gh pr create` in the command, with the directory it runs in. */
export function prCreates(command, cwd) {
  const found = [];
  let dir = cwd;
  for (const words of splitCommands(command)) {
    const w = stripPrefixes(words);
    if (w[0] === 'cd' || w[0] === 'pushd') {
      const target = w.slice(1).find((a) => !a.startsWith('-'));
      const p = target ? expandHome(target) : homedir();
      dir = isAbsolute(p) ? p : resolve(dir, p);
      continue;
    }
    if (w[0] === 'gh' && w[1] === 'pr' && w[2] === 'create') {
      const rest = w.slice(3);
      // A `GH_REPO=owner/name gh pr create` prefix; stripPrefixes drops it.
      const inline = words.slice(0, words.length - w.length).filter((x) => x.startsWith('GH_REPO=')).pop();
      const repo = flagValue(rest, ['--repo', '-R']) ?? (inline === undefined ? envRepo() : inline.slice('GH_REPO='.length));
      found.push({ dir, base: flagValue(rest, ['--base', '-B']), repo: repo || null });
    }
  }
  return found;
}

/** GH_REPO from the hook's environment, which the Bash tool's commands share. */
const envRepo = () => process.env.GH_REPO || null;

/** OWNER/NAME of a gh repository argument: OWNER/NAME, HOST/OWNER/NAME or a URL. */
const repoSlug = (value) => value.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/').slice(-2).join('/');

const sameRepo = (a, b) => repoSlug(a).toLowerCase() === repoSlug(b).toLowerCase();

/** The note for one Bash call, or null. */
export function noteFor(command, cwd, output) {
  const urls = [...String(output).matchAll(/https:\/\/[^\s/]+\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/g)];
  if (urls.length === 0) return null;
  for (const create of prCreates(command, cwd)) {
    const integration = integrationBranchAt(create.dir);
    if (!integration) continue;
    const origin = originRepo(create.dir);
    if (create.repo && !(origin && sameRepo(create.repo, origin))) continue;
    // The pull request this command opened: the last URL of the target
    // repository. With no origin to compare against, the last URL.
    const url = origin ? urls.filter((u) => sameRepo(u[1], origin)).pop() : urls[urls.length - 1];
    if (!url) continue;
    const pr = url[2];
    const slug = origin ?? url[1];
    const merge = `\`kookr merge ${pr} --repo ${slug}\``;
    const after =
      `The integration train then runs the full test suite on \`${integration}\` and moves \`main\` to it; ` +
      'the linked issue closes at that point, and the train comments on the pull request whether it promoted or reverted the change. ' +
      'Do not change the base yourself and do not merge with `gh pr merge`.';
    if (create.base === null || create.base === 'main') {
      return `Delivery note (issue #3913): pull request #${pr} is open against \`main\`. That is expected: this repository merges ` +
        `through the integration branch \`${integration}\` (.kookr/delivery-gate.json). Next: get the independent review verdict, ` +
        `then run ${merge} from your own worktree; it retargets the pull request to \`${integration}\` and squash-merges it there. ${after}`;
    }
    if (create.base === integration) {
      return `Delivery note (issue #3913): pull request #${pr} is open against \`${integration}\`, the integration branch. ` +
        `That works, but it is not needed: ${merge} retargets a pull request opened against \`main\` itself. ` +
        `Next: get the independent review verdict, then run ${merge} from your own worktree; it squash-merges it into \`${integration}\`. ${after}`;
    }
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return;
  }
  if ((event?.tool_name ?? 'Bash') !== 'Bash') return;
  const command = String(event?.tool_input?.command ?? '');
  if (!command.includes('pr') || !command.includes('create')) return;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const response = event?.tool_response;
  const output = typeof response === 'string' ? response : `${response?.stdout ?? ''}\n${response?.stderr ?? ''}`;
  const note = noteFor(command, cwd, output);
  if (!note) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }));
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main();
  } catch {
    // A note is never worth breaking the tool call for.
  }
}
