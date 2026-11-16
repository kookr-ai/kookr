#!/usr/bin/env node
// Logic for upstream-lag-notice.sh (issue #3653). Reads a Claude Code
// SessionStart event from stdin. When the session's checkout is behind its
// remote default branch (origin/main), it adds one line to the agent's context
// with the count and the advice to read code from the remote ref or a fresh
// worktree.
//
// Why: agents branch from origin/main as told, but they still read code from
// the checkout they start in. Issue evidence, review packs and subagent briefs
// quoted a local `main` that lagged or had diverged; one analysis started in a
// checkout 416 commits behind origin/main.
//
// Steps: find the default branch (origin/HEAD, else origin/main, else
// origin/master), fetch it with a short timeout (KOOKR_UPSTREAM_LAG_FETCH_TIMEOUT_MS,
// default 1500), then count the commits of origin/<branch> that HEAD lacks.
// When the fetch fails or times out, the count uses the remote-tracking ref
// from the last fetch and says "at least": that ref can only be older than the
// remote, so the count can only be too low, never a false warning.
//
// Silent when: not a git checkout, no `origin` remote, no remote-tracking ref,
// HEAD already contains the branch, or the event is a compaction (the session
// was already told). Never blocks: exit 0 always, and any crash prints nothing.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_FETCH_TIMEOUT_MS = 1500;

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    return null;
  }
}

function fetchTimeoutMs() {
  const n = Number.parseInt(process.env.KOOKR_UPSTREAM_LAG_FETCH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FETCH_TIMEOUT_MS;
}

const VALID_BRANCH = /^[A-Za-z0-9._/-]+$/;

/** The remote default branch name, or null when origin has none we can name. */
function defaultBranch(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head && head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const b of ['main', 'master']) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null) return b;
  }
  return 'main';
}

/**
 * Fetches origin/<branch> within the timeout. True on success. stdio is
 * ignored so a leftover ssh or credential helper holds no pipe of ours open,
 * and SIGTERM lets git remove its lock files.
 *
 * Nothing may prompt: GIT_TERMINAL_PROMPT=0 stops HTTPS credential prompts,
 * and ssh runs with BatchMode=yes, so a passphrase or host-key question fails
 * the fetch instead of reaching the terminal (an ssh left running after the
 * timeout would otherwise keep reading it). A user's own ssh command
 * (GIT_SSH_COMMAND, GIT_SSH, core.sshCommand) is left as it is.
 */
function fetchBranch(dir, branch) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && git(dir, ['config', 'core.sshCommand']) === null) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  const r = spawnSync('git', ['-C', dir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    stdio: 'ignore',
    timeout: fetchTimeoutMs(),
    killSignal: 'SIGTERM',
    env,
  });
  return r.status === 0 && !r.error;
}

/** The note for a session starting in `dir`, or null. */
export function noteFor(dir) {
  if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  if (!git(dir, ['remote', 'get-url', 'origin'])) return null;
  const branch = defaultBranch(dir);
  if (!VALID_BRANCH.test(branch) || branch.startsWith('-')) return null;
  const fetched = fetchBranch(dir, branch);
  const ref = `origin/${branch}`;
  const count = Number.parseInt(git(dir, ['rev-list', '--count', `HEAD..refs/remotes/${ref}`]) ?? '', 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  const where = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = where && where !== 'HEAD' ? `branch \`${where}\`` : 'a detached HEAD';
  const lag = fetched
    ? `is ${count} commit${count === 1 ? '' : 's'} behind \`${ref}\``
    : `is at least ${count} commit${count === 1 ? '' : 's'} behind \`${ref}\` as of the last fetch (fetching it now failed or timed out)`;
  return `Upstream note (issue #3653): this checkout (${dir}, ${head}) ${lag}. ` +
    `Its files are not the current code: do not quote them as evidence, in reviews or in subagent briefs. ` +
    `Read from the remote ref (\`git show ${ref}:<path>\`, \`git grep <pattern> ${ref}\`) or from a fresh worktree cut from \`${ref}\`.`;
}

function main() {
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    // No event: use the process directory.
  }
  if (event?.source === 'compact') return;
  const dir = typeof event?.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const note = noteFor(dir);
  if (!note) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }));
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
    // A note is never worth breaking the session start for.
  }
}
