#!/usr/bin/env node
// kookr-opencode-gate — deliverable gate for opencode worker profiles
// (RFC rfc-opencode-agent-integration §6). Runs as a Claude-style Stop hook:
// the Stop payload arrives as JSON on stdin; exit 2 + stderr re-prompts the
// worker with exactly what is still missing, exit 0 lets it stop.
//
//   kookr-opencode-gate --kind commit-and-pr-body|file:<name> [--lint-cmd <cmd>] [--base <rev>]
//
// commit-and-pr-body requires: no uncommitted tracked changes; >=1 commit
// ahead of the base (--base, env KOOKR_OPENCODE_GATE_BASE = HEAD at launch,
// else merge-base with the upstream default branch); `Closes #N` in those
// commit messages when env KOOKR_OPENCODE_ISSUE=N; PR_BODY.md in cwd; and a
// zero exit from the lint command (--lint-cmd or env KOOKR_PR_LINT_CMD, with
// `{pr_body}` replaced by the quoted PR_BODY.md path); and PR_BODY.md must NOT
// be added/modified by the branch (hand-off file).
//
// Loop guard: after MAX_BLOCKS blocks for one session the gate exits 0 with a
// note, so an unsatisfiable gate can never trap a worker forever.
// Every unexpected internal error also exits 0 (fail open).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BLOCKS = 3;
const STDIN_TIMEOUT_MS = 2000;
const LINT_TIMEOUT_MS = 90_000;
const LINT_TAIL_CHARS = 3000;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const take = (name) => {
      if (tok === name) return argv[++i];
      if (tok.startsWith(`${name}=`)) return tok.slice(name.length + 1);
      return undefined;
    };
    for (const [flag, key] of [['--kind', 'kind'], ['--lint-cmd', 'lintCmd'], ['--base', 'base']]) {
      const v = take(flag);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

function resolveBase(cwd, explicit, env) {
  const given = explicit || env.KOOKR_OPENCODE_GATE_BASE;
  if (given) {
    const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${given}^{commit}`]);
    if (sha) return sha;
    // The recorded base no longer resolves (gc, rewritten history): fall
    // through to the merge-base heuristic instead of skipping the check.
  }
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    const mb = git(cwd, ['merge-base', 'HEAD', ref]);
    if (mb) return mb;
  }
  return null;
}

function tail(text) {
  const t = text.trim();
  return t.length > LINT_TAIL_CHARS ? `...${t.slice(-LINT_TAIL_CHARS)}` : t;
}

/** Returns an array of problem strings (empty = deliverable satisfied). */
export function checkDeliverable({ kind, cwd, lintCmd, base, env = process.env }) {
  if (kind.startsWith('file:')) {
    const name = kind.slice('file:'.length);
    if (!FILE_NAME_PATTERN.test(name)) return [`gate misconfigured: invalid file name "${name}"`];
    const p = join(cwd, name);
    if (!existsSync(p)) return [`${name} does not exist in ${cwd}. Write it (your deliverable) before finishing.`];
    if (!statSync(p).isFile() || statSync(p).size === 0 || readFileSync(p, 'utf8').trim() === '') {
      return [`${name} exists in ${cwd} but is empty. Fill it with your findings before finishing.`];
    }
    return [];
  }
  if (kind !== 'commit-and-pr-body') return [`gate misconfigured: unknown --kind "${kind}"`];

  const problems = [];
  if (git(cwd, ['rev-parse', '--git-dir']) === null) {
    return [`${cwd} is not a git repository; the commit deliverable cannot be verified.`];
  }
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    problems.push(`There are uncommitted changes to tracked files:\n${tail(dirty)}\nCommit the files that belong to your change (git add <files> + git commit) and restore unrelated ones, such as a lockfile touched by an install, with git checkout -- <file> instead of committing them; do not push.`);
  }
  const baseSha = resolveBase(cwd, base, env);
  const baseGiven = Boolean(base || env.KOOKR_OPENCODE_GATE_BASE);
  const baseUnresolved = baseGiven && !baseSha;
  const range = baseSha ? `${baseSha}..HEAD` : null;
  if (range) {
    const count = Number(git(cwd, ['rev-list', '--count', range]) ?? '0');
    if (!count) problems.push('No commit exists ahead of the starting point. Commit your change on the current branch (git add + git commit); do not push.');
  }
  const issue = (env.KOOKR_OPENCODE_ISSUE || '').trim();
  if (issue) {
    const messages = git(cwd, range ? ['log', '--format=%B', range] : ['log', '-1', '--format=%B']) ?? '';
    if (!new RegExp(`\\bCloses\\s+#${issue.replace(/[^0-9]/g, '')}\\b`, 'i').test(messages)) {
      problems.push(`The commit message must contain the line "Closes #${issue}". Amend it (git commit --amend) to add it.`);
    }
  }
  // PR_BODY.md is a hand-off file, never part of the change: block when the
  // branch ADDS or MODIFIES it relative to the base (net diff, so a follow-up
  // commit that untracks it clears the problem). A repo that already tracks its
  // own PR_BODY.md and is left untouched is not flagged. Needs a resolvable base.
  if (baseSha && git(cwd, ['diff', '--name-only', '--diff-filter=AM', baseSha, 'HEAD', '--', 'PR_BODY.md'])) {
    problems.push(
      'PR_BODY.md is committed on this branch, but it must stay uncommitted (it is a hand-off file, not part of the change). ' +
      'Run `git rm --cached PR_BODY.md` (keeps the file on disk), then `git commit --amend --no-edit` ' +
      '(or `git commit -m "chore: untrack PR_BODY.md"` as a new commit). Do not delete PR_BODY.md from disk.',
    );
  }
  const prBody = resolve(cwd, 'PR_BODY.md');
  if (!existsSync(prBody) || readFileSync(prBody, 'utf8').trim() === '') {
    problems.push('PR_BODY.md is missing or empty at the repo root. Write it (uncommitted) from the repository pull request template, every template item present.');
  } else {
    const lint = (lintCmd || env.KOOKR_PR_LINT_CMD || '').trim();
    if (lint) {
      const r = spawnSync('/bin/sh', ['-c', lint.split('{pr_body}').join(shq(prBody))], {
        cwd, encoding: 'utf8', timeout: LINT_TIMEOUT_MS, env,
      });
      if (r.status !== 0) {
        problems.push(
          `The PR body lint failed (exit ${r.status ?? r.signal ?? 'error'}):\n${tail(`${r.stdout || ''}\n${r.stderr || ''}`)}\n` +
          'Fix PR_BODY.md honestly: tick a box only if your diff really satisfies it; strike through a genuinely not-applicable box with a one-line reason. Do not tick boxes just to pass the lint.',
        );
      }
    }
  }
  // Informational only: never blocks on its own, but explains the missing check.
  if (baseUnresolved && problems.length > 0) {
    problems.push('Note: the recorded starting point could not be resolved and no merge-base with origin/main or main was found, so the "at least one commit ahead" check was skipped.');
  }
  return problems;
}

function counterPath(payload, cwd, env) {
  const key = createHash('sha256').update(String(payload.session_id || cwd)).digest('hex').slice(0, 16);
  const dir = env.KOOKR_SESSION_DIR || tmpdir();
  return join(dir, `kookr-opencode-gate-${key}.count`);
}

function readStdin() {
  return new Promise((resolveStdin) => {
    let buf = '';
    const timer = setTimeout(() => resolveStdin(buf), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolveStdin(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolveStdin(buf); });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || '{}') || {}; } catch { /* fail open on payload shape */ }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  if (!args.kind) { process.stderr.write('kookr-opencode-gate: --kind is required; allowing stop\n'); return 0; }

  const problems = checkDeliverable({ kind: args.kind, cwd, lintCmd: args.lintCmd, base: args.base, env });
  if (problems.length === 0) return 0;

  const file = counterPath(payload, cwd, env);
  let blocks = 0;
  try { blocks = Number(readFileSync(file, 'utf8')) || 0; } catch { /* first block */ }
  if (blocks >= MAX_BLOCKS) {
    process.stderr.write(`kookr-opencode-gate: deliverable still unmet after ${MAX_BLOCKS} reminders; allowing stop.\n${problems.join('\n')}\n`);
    return 0;
  }
  try { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, String(blocks + 1)); } catch { /* best effort */ }
  process.stderr.write(
    `Deliverable gate (${blocks + 1}/${MAX_BLOCKS}): you are not done yet.\n` +
    `${problems.map((p) => `- ${p}`).join('\n')}\nFix this, then finish again.\n`,
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`kookr-opencode-gate: internal error (${err}); allowing stop\n`);
    process.exit(0);
  });
}
