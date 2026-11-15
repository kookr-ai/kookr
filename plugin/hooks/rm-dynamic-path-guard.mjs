#!/usr/bin/env node
// Logic for rm-dynamic-path-guard.sh (issue #3867). Reads a Claude Code
// PreToolUse event (Bash tool) from stdin and denies a recursive `rm` whose
// target the shell has to compute: a command substitution (`$(...)` or
// backticks) or a variable (`$DIR`, `"${DIR}"`).
//
// Why: Claude Code cannot tell where such a path points, so it asks a human for
// permission even in bypassPermissions mode. In an unattended task nobody
// answers, and the task waits until someone opens the dashboard (76 and 52
// minutes on 15 Nov 2026, both reviewer subagents cleaning up a temp
// directory with `rm -rf "$(cat <scratchpad>/mutdir)"`). A hook denial reaches
// the agent at once, with instructions, so it retries with a literal path
// instead of waiting.
//
// Denied: `rm` at command position (also `/bin/rm`, `sudo rm`, `command rm`,
// after `do`/`then`/`&&`/`;`/`|`) with a recursive flag (`-r`, `-R`, a cluster
// such as `-rf`, or `--recursive`) and at least one target containing `$` or a
// backtick. Allowed: literal targets, non-recursive `rm`, `git rm -r`, and any
// text that only mentions such a command (inside quotes, a commit message, a
// grep pattern, a heredoc body).
//
// Best effort, not a sandbox: `bash -c`, `eval`, `xargs rm` and `find -exec rm`
// are not looked into. The word splitter drops quoting, so a single-quoted or
// backslash-escaped `$` (`rm -rf '$DIR'`) is treated as a variable and denied.
//
// Exit 0 always. A denial is the JSON PreToolUse decision on stdout. Any crash
// allows the command (fail open) and is logged to ~/.kookr/hook-errors.log.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bothSplits } from './merge-retarget-guard.mjs';

function logError(message) {
  try {
    const dir = join(homedir(), '.kookr');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ERROR rm-dynamic-path-guard: ${message}\n`);
  } catch {
    // nothing else to do
  }
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that can stand in front of the real command word.
const PREFIX_WORDS = new Set([
  'env', 'command', 'exec', 'time', 'nohup', 'builtin', 'sudo', 'nice',
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{',
]);
// `>`, `2>>`, `&>`, `<`: a redirect operator on its own; its target is the next word.
const REDIRECT_OP = /^[0-9]*(?:[<>]{1,2}|&>>?|>&|>\|)$/;
// A redirect glued to its target: `2>>"$LOG"` arrives as `2>>$LOG`.
const REDIRECT_WORD = /^[0-9]*(?:[<>]|&>)/;

function isDynamic(word) {
  return word.includes('$') || word.includes('`');
}

/** Drops `FOO=1`, `sudo`, `do`, `timeout 60`, ... in front of the real command. */
function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    if (ENV_ASSIGN.test(words[i]) || PREFIX_WORDS.has(words[i])) { i++; continue; }
    if (words[i] === 'timeout' && i + 1 < words.length) { i += 2; continue; }
    break;
  }
  return words.slice(i);
}

/**
 * Examines one simple command. Returns the first computed target of a
 * recursive `rm`, or null to allow.
 */
function computedRmTarget(words) {
  const w = stripPrefixes(words);
  if (w.length === 0 || isDynamic(w[0]) || w[0].split('/').pop() !== 'rm') return null;
  let recursive = false;
  let optionsEnded = false;
  let target = null;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (REDIRECT_OP.test(a)) { i++; continue; }
    if (REDIRECT_WORD.test(a)) continue;
    if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && a.startsWith('--')) {
      if (a === '--recursive') recursive = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a.length > 1) {
      if (/[rR]/.test(a)) recursive = true;
      continue;
    }
    if (target === null && isDynamic(a)) target = a;
  }
  return recursive ? target : null;
}

/** The computed target of the first recursive `rm` in `command`, or null to allow. */
export function decide(command) {
  for (const commands of bothSplits(command)) {
    for (const words of commands) {
      const target = computedRmTarget(words);
      if (target !== null) return target;
    }
  }
  return null;
}

export function denialMessage(target) {
  return [
    `rm-dynamic-path-guard (issue #3867): blocked a recursive rm on a computed path (\`${target}\`).`,
    'Claude Code cannot see where a path built from a variable or a command substitution points, so it asks a human for permission',
    'even in bypass mode, and an unattended task waits until someone answers.',
    'Delete by literal path instead. Shell variables do not survive between Bash calls, so first print the path',
    '(for example `cat <file>` or `echo "$DIR"`), then type it out: `rm -rf /tmp/claude-1000/<session>/scratchpad/mutdir`.',
    'To empty a directory but keep it: `find /literal/dir -mindepth 1 -delete`.',
    'Next time, create temp directories with `mktemp -d "<scratchpad>/name.XXXXXX"` and note the printed path.',
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
  if (!command.includes('rm')) return;
  const target = decide(command);
  if (target === null) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denialMessage(target) },
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
