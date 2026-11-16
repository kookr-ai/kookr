#!/usr/bin/env node
// Logic for git-add-all-guard.sh (issue #3654). Reads a Claude Code PreToolUse
// event (Bash tool) from stdin and, in a Kookr task, denies a `git add` that
// stages the whole tree: `git add -A`, `git add --all` and `git add .`.
//
// Why: these forms stage every untracked file, so output that a test run or a
// script left in the worktree lands in the commit. It happened in three
// repositories: end-to-end run output (runs/), a scratch PR-body file under
// data/, and pytest fixture output. The denial tells the agent to stage the
// paths it changed by name.
//
// Denied (outside a dry run): `git add` with `-A`/`--all` (also inside a flag
// cluster such as `-fA`) and no named path, and `git add` with a whole-tree
// path (`.`, `./`, `:/`), unless `-u`/`--update`, `-p` or `-i` limits it to
// tracked files. Exclude-only paths (`:!data`) name nothing, so
// `git add -A ':!data'` is denied too. `git -C dir`, `cd dir &&` and the other
// command positions of merge-retarget-guard.mjs are seen.
// Allowed: `git add path/to/file`, `git add -u`, `git add -A src/new-dir/`,
// and text that only mentions the command (a commit message, a quoted string).
//
// Only in a Kookr task (KOOKR_TASK_ID set); the .sh wrapper checks that and
// the KOOKR_GIT_ADD_ALL_GUARD_SKIP=1 kill switch. Best effort, not a sandbox:
// `bash -c`, `eval` and aliases are not looked into.
//
// Exit 0 always. A denial is the JSON PreToolUse decision on stdout. Any crash
// allows the command (fail open) and is logged to ~/.kookr/hook-errors.log.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bothSplits } from './merge-retarget-guard.mjs';
import { gitInvocation } from './lib/git-command.mjs';

function logError(message) {
  try {
    const dir = join(homedir(), '.kookr');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ERROR git-add-all-guard: ${message}\n`);
  } catch {
    // nothing else to do
  }
}

const WHOLE_TREE = new Set(['.', './', ':/', ':/.', ':(top)']);
const isExclude = (p) => p.startsWith(':!') || p.startsWith(':^') || p.startsWith(':(exclude)');

/** True when one simple command is a whole-tree `git add`. */
function stagesWholeTree(words) {
  const git = gitInvocation(words, '/');
  if (!git || git.sub !== 'add') return false;
  let all = false;
  let limited = false;
  let named = false;
  let optionsEnded = false;
  const paths = [];
  for (const a of git.args) {
    if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && a.startsWith('--')) {
      if (a === '--all') all = true;
      if (['--update', '--patch', '--interactive', '--dry-run', '--edit', '--renormalize'].includes(a)) limited = true;
      // The paths are named in a file.
      if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) named = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a.length > 1) {
      if (a.includes('A')) all = true;
      if (/[upine]/.test(a)) limited = true;
      continue;
    }
    paths.push(a);
  }
  if (limited) return false;
  if (paths.some((p) => WHOLE_TREE.has(p))) return true;
  return all && !named && paths.every(isExclude);
}

/** The first whole-tree `git add` in `command`, as text, or null to allow. */
export function decide(command) {
  for (const commands of bothSplits(command)) {
    for (const words of commands) {
      if (stagesWholeTree(words)) return words.join(' ');
    }
  }
  return null;
}

export function denialMessage(found) {
  return [
    `git-add-all-guard (issue #3654): blocked \`${found}\` in a Kookr task.`,
    'It stages every untracked file in the tree, which has swept test output, end-to-end run artifacts and scratch files into commits.',
    'Stage the paths you changed by name: `git add path/a path/b` (`git status --short` lists them).',
    '`git add -u` stages edits and deletions of tracked files; to add a whole new directory, name it: `git add -A src/new-dir/`.',
  ].join(' ');
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
  if (!command.includes('add')) return;
  const found = decide(command);
  if (found === null) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denialMessage(found) },
  }));
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
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
  }
}
