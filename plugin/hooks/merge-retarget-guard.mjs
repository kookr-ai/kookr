#!/usr/bin/env node
// Logic for merge-retarget-guard.sh (issue #3803). Reads a Claude Code
// PreToolUse event (Bash tool) from stdin and denies a pull-request merge that
// would skip the integration branch.
//
// Why: when a repository names an integration branch in
// `.kookr/delivery-gate.json` on origin/main, pull requests must merge into that
// branch, and the integration train verifies them before `main` moves. The merge
// wrapper (`scripts/kookr-merge.sh`) retargets the pull request first, but only
// in checkouts new enough to have that step. `pnpm merge` runs the wrapper of
// whatever checkout it is run in, so running it in an old checkout squash-merged
// PR #3802 straight into main. `kookr merge <PR>` always runs the wrapper of the
// deployed production checkout, which follows main, so it is the one command
// to use.
//
// Denied, only when the repository of the command's working directory has an
// integration branch:
//   - `pnpm [-s] [run] merge` / `npm run merge` in a checkout whose
//     `scripts/kookr-merge.sh` cannot retarget;
//   - `bash|sh <path>/kookr-merge.sh` (or running it directly) when that script
//     cannot retarget;
//   - bare `gh pr merge`, and `gh api --method PUT .../pulls/<n>/merge`, when the
//     pull request's base is `main` or cannot be read.
// Allowed: `kookr merge`, everything in a repository with no integration
// branch, and every command that only mentions these words (inside quotes, a
// commit message, a grep pattern).
//
// The working directory starts at the event's `cwd` and follows `cd`, `pushd`
// and `pnpm -C/--dir` within the command. Best effort, not a sandbox: a merge
// hidden behind `bash -c`, `eval` or a variable is not seen.
//
// Exit 0 always. A denial is the JSON PreToolUse decision on stdout. Any crash
// allows the command (fail open) and is logged to ~/.kookr/hook-errors.log.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETARGET_MARKER = 'retarget_to_integration_branch';
const GH_TIMEOUT_MS = 15_000;

function logError(message) {
  try {
    const dir = join(homedir(), '.kookr');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ERROR merge-retarget-guard: ${message}\n`);
  } catch {
    // nothing else to do
  }
}

function run(cmd, args, cwd, timeout = 5_000) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim();
  } catch {
    return null;
  }
}

/**
 * Splits a shell command into simple commands, each a list of words. Quotes are
 * honoured (a quoted `;` or `gh pr merge` stays inside one word), heredoc bodies
 * are dropped, and `;`, `&&`, `||`, `|`, `&`, newlines and parentheses end a
 * command. Not a full shell parser; enough to find what runs at command position.
 */
export function splitCommands(src) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const heredocs = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') { word += src[i + 1]; inWord = true; }
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { word += src[j + 1]; j += 2; continue; }
        word += src[j];
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // Heredoc: remember the delimiter; its body is skipped at the next newline.
      endWord();
      let j = i + 2;
      if (src[j] === '-') j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      while (j < src.length && !/[\s;&|()<>]/.test(src[j])) {
        if (src[j] !== "'" && src[j] !== '"' && src[j] !== '\\') delim += src[j];
        j++;
      }
      if (delim) heredocs.push(delim);
      i = j - 1;
      continue;
    }
    if (c === '\n') {
      endCommand();
      while (heredocs.length > 0) {
        const delim = heredocs.shift();
        let k = i + 1;
        while (k < src.length) {
          const eol = src.indexOf('\n', k);
          const line = src.slice(k, eol === -1 ? src.length : eol);
          k = eol === -1 ? src.length : eol + 1;
          if (line.replace(/^\t+/, '').trim() === delim) break;
        }
        i = k - 1;
      }
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand();
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand();
  return commands;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_COMMANDS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'builtin']);

/** Drops `FOO=1`, `env`, `command`, ... in front of the real command. */
function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    if (ENV_ASSIGN.test(words[i]) || PREFIX_COMMANDS.has(words[i])) { i++; continue; }
    if (words[i] === 'timeout' && i + 1 < words.length) { i += 2; continue; }
    break;
  }
  return words.slice(i);
}

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** The integration branch configured for the repository at `dir`, or null. */
export function integrationBranchAt(dir) {
  const json = run('git', ['-C', dir, 'show', 'origin/main:.kookr/delivery-gate.json'], dir);
  if (!json) return null;
  let branch;
  try {
    branch = JSON.parse(json)?.integrationBranch;
  } catch {
    return null;
  }
  // Same validation as scripts/lib/delivery-gate.sh.
  if (typeof branch !== 'string' || branch === '' || branch === 'main') return null;
  if (branch.startsWith('-') || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) return null;
  return branch;
}

/**
 * True when the merge script at `path` retargets to the integration branch: it
 * has the retarget step and the configuration reader it sources next to it
 * (without that reader the step silently does nothing).
 */
export function scriptCanRetarget(path) {
  try {
    if (!readFileSync(path, 'utf-8').includes(RETARGET_MARKER)) return false;
    return existsSync(join(dirname(path), 'lib', 'delivery-gate.sh'));
  } catch {
    return false;
  }
}

/** Value of `--name value`, `--name=value` or `-n value` in a word list, or null. */
function flagValue(words, names) {
  for (let i = 0; i < words.length; i++) {
    for (const n of names) {
      if (words[i] === n && i + 1 < words.length) return words[i + 1];
      if (n.startsWith('--') && words[i].startsWith(`${n}=`)) return words[i].slice(n.length + 1);
    }
  }
  return null;
}

const GH_PR_MERGE_VALUE_FLAGS = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit',
]);

/**
 * Base branch of the pull request a merge targets, or null when it cannot be
 * read. `selector` is a number, URL or branch; null means the current branch.
 */
function prBase(dir, selector, repo) {
  const args = ['pr', 'view'];
  if (selector) args.push(selector);
  if (repo) args.push('--repo', repo);
  args.push('--json', 'baseRefName', '--jq', '.baseRefName');
  const base = run('gh', args, dir, GH_TIMEOUT_MS);
  return base ? base : null;
}

/**
 * Examines one simple command. Returns a denial reason, or null to allow.
 * `state.dir` is the working directory, updated by `cd`/`pushd`.
 */
function examine(words, state) {
  const w = stripPrefixes(words);
  if (w.length === 0) return null;
  const cmd = w[0];

  if (cmd === 'cd' || cmd === 'pushd') {
    const target = w.slice(1).find((a) => !a.startsWith('-'));
    if (!target) { state.dir = homedir(); return null; }
    const p = expandHome(target);
    state.dir = isAbsolute(p) ? p : resolve(state.dir, p);
    return null;
  }

  const integration = () => integrationBranchAt(state.dir);

  // pnpm [flags] [run] merge  /  npm run merge
  if (cmd === 'pnpm' || cmd === 'npm') {
    let i = 1;
    let dir = state.dir;
    while (i < w.length && w[i].startsWith('-')) {
      const f = w[i];
      if ((f === '-C' || f === '--dir' || f === '--prefix') && i + 1 < w.length) { dir = resolve(state.dir, expandHome(w[i + 1])); i += 2; continue; }
      if (f.startsWith('--dir=') || f.startsWith('--prefix=')) { dir = resolve(state.dir, expandHome(f.slice(f.indexOf('=') + 1))); i++; continue; }
      if (f.startsWith('-C') && f.length > 2) { dir = resolve(state.dir, expandHome(f.slice(2))); i++; continue; }
      i++;
    }
    if (w[i] === 'run' || w[i] === 'run-script') i++;
    else if (cmd === 'npm') return null;
    if (w[i] !== 'merge') return null;
    if (!integrationBranchAt(dir)) return null;
    const root = run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], dir);
    if (!root) return null;
    if (scriptCanRetarget(join(root, 'scripts', 'kookr-merge.sh'))) return null;
    return `\`${cmd} merge\` here runs ${root}/scripts/kookr-merge.sh, which predates the retarget step, so it would merge straight into main and skip the integration branch.`;
  }

  // bash|sh <path>/kookr-merge.sh, or the script run directly.
  let script = null;
  if ((cmd === 'bash' || cmd === 'sh') && w.length > 1) {
    const first = w.slice(1).find((a) => !a.startsWith('-'));
    if (first && /(^|\/)kookr-merge\.sh$/.test(first)) script = first;
  } else if (/(^|\/)kookr-merge\.sh$/.test(cmd)) {
    script = cmd;
  }
  if (script !== null) {
    if (!integration()) return null;
    const path = resolve(state.dir, expandHome(script));
    if (scriptCanRetarget(path)) return null;
    return `${path} predates the retarget step, so it would merge straight into main and skip the integration branch.`;
  }

  if (cmd !== 'gh') return null;

  // gh pr merge [<selector>] [flags]
  if (w[1] === 'pr' && w[2] === 'merge') {
    const branch = integration();
    if (!branch) return null;
    const rest = w.slice(3);
    let selector = null;
    for (let i = 0; i < rest.length; i++) {
      if (GH_PR_MERGE_VALUE_FLAGS.has(rest[i])) { i++; continue; }
      if (rest[i].startsWith('-')) continue;
      selector = rest[i];
      break;
    }
    const base = prBase(state.dir, selector, flagValue(rest, ['--repo', '-R']));
    if (base !== null && base !== 'main') return null;
    return base === 'main'
      ? `\`gh pr merge\` would merge this pull request into main directly; this repository merges into \`${branch}\` and the integration train promotes to main.`
      : `\`gh pr merge\` cannot be checked: the pull request's base branch could not be read, and this repository merges into \`${branch}\`.`;
  }

  // gh api --method PUT .../pulls/<n>/merge
  if (w[1] === 'api') {
    const method = flagValue(w, ['--method', '-X']) ?? (w.find((a) => /^-X./i.test(a))?.slice(2) ?? null);
    if (!method || method.toUpperCase() !== 'PUT') return null;
    const endpoint = w.find((a) => /pulls\/\d+\/merge\/?$/.test(a));
    if (!endpoint) return null;
    const branch = integration();
    if (!branch) return null;
    const m = /(?:^|\/)repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge/.exec(endpoint);
    let repo = null;
    if (m && !m[1].startsWith('{') && !m[2].startsWith('{')) repo = `${m[1]}/${m[2]}`;
    const pr = /pulls\/(\d+)\/merge/.exec(endpoint)[1];
    const base = prBase(state.dir, pr, repo);
    if (base !== null && base !== 'main') return null;
    return base === 'main'
      ? `the REST merge endpoint would merge pull request #${pr} into main directly; this repository merges into \`${branch}\` and the integration train promotes to main.`
      : `the REST merge of pull request #${pr} cannot be checked: its base branch could not be read, and this repository merges into \`${branch}\`.`;
  }
  return null;
}

/** Denial reason for the whole command, or null to allow. */
export function decide(command, cwd) {
  const state = { dir: cwd || process.cwd() };
  for (const words of splitCommands(command)) {
    const reason = examine(words, state);
    if (reason) return reason;
  }
  return null;
}

function correction(repo) {
  return 'Merge with `kookr merge <PR> --repo ' + (repo || '<owner/name>') + '` run from your own worktree. ' +
    'It always runs the merge wrapper of the deployed production checkout, which retargets the pull request to the integration branch; ' +
    '`pnpm merge` runs the wrapper of the current checkout, which may be old. Never change directory to the main checkout to merge.';
}

function originRepo(dir) {
  const url = run('git', ['-C', dir, 'remote', 'get-url', 'origin'], dir);
  if (!url) return null;
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : null;
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
  if (!command.includes('merge')) return;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const reason = decide(command, cwd);
  if (!reason) return;
  const message = `merge-retarget-guard (issue #3803): blocked. ${reason} ${correction(originRepo(cwd))}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
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
