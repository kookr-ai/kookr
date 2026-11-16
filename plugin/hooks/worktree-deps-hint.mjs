#!/usr/bin/env node
// Logic for worktree-deps-hint.sh (issue #3652). Reads a Claude Code
// PostToolUse event (Bash tool) from stdin. After `git worktree add` created a
// worktree that has a JavaScript lockfile but no node_modules, it adds one note
// to the agent's context with the exact install command for that worktree.
//
// Why: a new worktree has no installed dependencies, so the first build or test
// there fails (for example TypeScript's "cannot find name 'process'"). Agents
// wrote the same notebook lesson about it in six shelves for four repositories.
//
// It only prints the command; it never runs the install. An install takes from
// seconds to minutes, would hold the tool call in the foreground, and could
// race an install the agent starts itself.
//
// The worktree path is read from the command (`git [-C dir] worktree add
// [options] <path> [<commit-ish>]`, following `cd`), and the result is checked
// on disk, not inferred from the command text: the directory must exist and
// hold a `.git` file, a lockfile, and no `node_modules`. Lockfiles:
// pnpm-lock.yaml -> `pnpm install --frozen-lockfile`; yarn.lock ->
// `yarn install --immutable` (Yarn 2+, `.yarnrc.yml` present) or
// `yarn install --frozen-lockfile`; package-lock.json or npm-shrinkwrap.json
// -> `npm ci`. Other ecosystems (cargo, pip, ...) are out of scope.
//
// Never blocks: exit 0 always, and any crash prints nothing.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitCommands } from './merge-retarget-guard.mjs';
import { gitInvocation, resolveFrom, trackDir } from './lib/git-command.mjs';

// `git worktree add` options that take their value as the next word.
const ADD_VALUED = new Set(['-b', '-B', '--reason']);

/** Absolute paths of the worktrees each `git worktree add` in `command` names. */
export function worktreePaths(command, cwd) {
  const found = [];
  const state = { dir: cwd };
  for (const words of splitCommands(command, { comments: true })) {
    const dir = trackDir(words, state);
    if (dir === null) continue;
    const git = gitInvocation(words, dir);
    if (!git || git.sub !== 'worktree' || git.args[0] !== 'add') continue;
    const args = git.args.slice(1);
    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
      if (!optionsEnded && a.startsWith('-')) {
        if (ADD_VALUED.has(a)) i++;
        continue;
      }
      found.push(resolveFrom(git.dir, a));
      break;
    }
  }
  return found;
}

const shellQuote = (p) => (/^[A-Za-z0-9_./~@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** The lockfile and install command for `dir`, or null when there is nothing to install. */
export function installFor(dir) {
  if (!existsSync(join(dir, '.git')) || existsSync(join(dir, 'node_modules'))) return null;
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return { lockfile: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile' };
  if (existsSync(join(dir, 'yarn.lock'))) {
    const berry = existsSync(join(dir, '.yarnrc.yml'));
    return { lockfile: 'yarn.lock', install: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' };
  }
  for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (existsSync(join(dir, lockfile))) return { lockfile, install: 'npm ci' };
  }
  return null;
}

/** The note for one Bash call, or null. */
export function noteFor(command, cwd) {
  const lines = [];
  for (const path of worktreePaths(command, cwd)) {
    const found = installFor(path);
    if (!found) continue;
    lines.push(
      `Dependency note (issue #3652): the new worktree ${path} has ${found.lockfile} but no node_modules, ` +
      `so builds and tests there fail until its dependencies are installed. Install them before you build or test: ` +
      `\`cd ${shellQuote(path)} && ${found.install}\``,
    );
  }
  return lines.length > 0 ? lines.join('\n') : null;
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
  if (!command.includes('worktree')) return;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const note = noteFor(command, cwd);
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
