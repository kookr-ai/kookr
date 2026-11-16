// Shared by git-add-all-guard.mjs and worktree-deps-hint.mjs: reads one simple
// command (a word list from splitCommands in merge-retarget-guard.mjs) as a git
// invocation.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { stripPrefixes } from '../merge-retarget-guard.mjs';

// Global options that take their value as the next word (`git -C dir`).
const GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** `p` resolved against `dir`, after `~` expansion. */
export function resolveFrom(dir, p) {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(dir, e);
}

/**
 * The git subcommand in `words`, or null when the command is not git.
 * Returns { dir, sub, args }: `dir` is `cwd` after every `-C <dir>` (each one
 * relative to the previous, as git does), `sub` the subcommand word and `args`
 * the words after it.
 */
export function gitInvocation(words, cwd) {
  const w = stripPrefixes(words);
  if (w.length === 0 || w[0].split('/').pop() !== 'git') return null;
  let dir = cwd;
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) {
    if (GLOBAL_VALUED.has(w[i])) {
      if (w[i] === '-C' && i + 1 < w.length) dir = resolveFrom(dir, w[i + 1]);
      i += 2;
      continue;
    }
    i++;
  }
  if (i >= w.length) return null;
  return { dir, sub: w[i], args: w.slice(i + 1) };
}

/**
 * Follows `cd` and `pushd` through a command's simple commands. Returns the
 * directory the command at `words` runs in and updates `state.dir`.
 */
export function trackDir(words, state) {
  const w = stripPrefixes(words);
  if (w[0] === 'cd' || w[0] === 'pushd') {
    const target = w.slice(1).find((a) => !a.startsWith('-'));
    state.dir = target ? resolveFrom(state.dir, target) : homedir();
    return null;
  }
  return state.dir;
}
