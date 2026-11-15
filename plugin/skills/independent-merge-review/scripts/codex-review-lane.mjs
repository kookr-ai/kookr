#!/usr/bin/env node
// Codex reviewer lane for the independent-merge-review skill (issue #3640).
//
// Runs one Codex review with the three known failure modes handled up front, so a
// task learns "Codex is unusable here" in seconds instead of losing a 10-minute
// budget and then falling back to the Claude lane anyway:
//   1. stdin is closed (`</dev/null`): `codex exec` otherwise waits on
//      "Reading additional input from stdin..." until it is killed.
//   2. the model comes from ONE setting (KOOKR_CODEX_REVIEW_MODEL) and a short
//      preflight call checks it before the review: a configured default the API
//      rejects answers `model_not_found`.
//   3. on Linux, Codex runs its tools through bubblewrap (`bwrap`), even outside
//      read-only mode; without it the run aborts with no verdict.
//
// Usage: node codex-review-lane.mjs --prompt-file <file> [--repo-dir <dir>]
//
// Exit codes (stable; the skill keys its fallback on them):
//   0  review ran; the reviewer's final message is on stdout
//   2  usage error (bad arguments, unreadable or oversized prompt file)
//   3  Codex lane unusable (no codex binary, no bwrap on Linux, preflight
//      rejected or timed out, review run failed or timed out) -> use the Claude lane
//
// Settings (environment):
//   KOOKR_CODEX_REVIEW_MODEL             model passed as `-m`; unset = Codex's own default
//   KOOKR_CODEX_REVIEW_SANDBOX           sandbox mode, default `read-only`
//   KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT seconds for the preflight call, default 25
//   KOOKR_CODEX_REVIEW_TIMEOUT           seconds for the review call, default 570
//                                        (with the preflight, inside the skill's 10-minute budget)
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_CODEX_UNUSABLE = 3;

// The prompt travels as one argv entry; Linux caps a single argument at 128 KiB.
// Reference the diff by path in the prompt instead of inlining a large one.
export const MAX_PROMPT_BYTES = 100 * 1024;

const PREFLIGHT_PROMPT = 'Reply with exactly the word OK and nothing else.';

export function parseArgs(argv) {
  const out = { promptFile: null, repoDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt-file') out.promptFile = argv[++i] ?? null;
    else if (a === '--repo-dir') out.repoDir = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.promptFile) throw new Error('--prompt-file is required');
  return out;
}

/** First executable named `name` on PATH, or null. */
export function which(name, pathEnv = '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function seconds(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readSettings(env = process.env) {
  return {
    model: env.KOOKR_CODEX_REVIEW_MODEL?.trim() || null,
    sandbox: env.KOOKR_CODEX_REVIEW_SANDBOX?.trim() || 'read-only',
    preflightTimeoutS: seconds(env.KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT, 25),
    reviewTimeoutS: seconds(env.KOOKR_CODEX_REVIEW_TIMEOUT, 570),
  };
}

// The review runs at high reasoning effort whatever the host config says (the
// skill's strength floor); the preflight only has to answer OK, so it runs low.
export function codexArgs(settings, prompt, repoDir, { effort = 'high' } = {}) {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', settings.sandbox, '-c', `model_reasoning_effort="${effort}"`];
  if (settings.model) args.push('--model', settings.model);
  if (repoDir) args.push('--cd', repoDir);
  // `--` so a prompt that starts with `-` or `---` (front matter) is not parsed as a flag.
  args.push('--', prompt);
  return args;
}

/** Run codex with stdin closed and a hard timeout. */
function runCodex(codex, args, timeoutS, env) {
  const r = spawnSync(codex, args, {
    stdio: ['ignore', 'pipe', 'pipe'], // 'ignore' = </dev/null: never wait on stdin
    encoding: 'utf8',
    timeout: timeoutS * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { status: r.status, timedOut, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tail(s, n = 400) {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

/**
 * Returns { code, stdout, reason }. `reason` explains an EXIT_CODEX_UNUSABLE so the
 * caller can record why the Claude lane was taken.
 */
export function runLane({ prompt, repoDir = null, env = process.env, platform = process.platform }) {
  const settings = readSettings(env);
  const unusable = (reason) => ({ code: EXIT_CODEX_UNUSABLE, stdout: '', reason });

  const codex = which('codex', env.PATH ?? '');
  if (!codex) return unusable('codex binary not found on PATH');
  if (platform === 'linux' && !which('bwrap', env.PATH ?? '')) {
    return unusable('bubblewrap (bwrap) not installed; Codex cannot run its sandbox on Linux');
  }

  const model = settings.model ?? '(codex default)';
  const pre = runCodex(codex, codexArgs(settings, PREFLIGHT_PROMPT, repoDir, { effort: 'low' }), settings.preflightTimeoutS, env);
  if (pre.timedOut) return unusable(`preflight timed out after ${settings.preflightTimeoutS}s (model ${model})`);
  if (pre.error) return unusable(`preflight could not start codex: ${pre.error.message}`);
  // A line that is exactly OK: the prompt text itself contains the word, so an echo must not pass.
  if (pre.status !== 0 || !/^\s*OK\s*$/m.test(pre.stdout)) {
    return unusable(`preflight failed (model ${model}, exit ${pre.status}): ${tail(pre.stderr + pre.stdout)}`);
  }

  const rev = runCodex(codex, codexArgs(settings, prompt, repoDir), settings.reviewTimeoutS, env);
  if (rev.timedOut) return unusable(`review timed out after ${settings.reviewTimeoutS}s`);
  if (rev.error) return unusable(`review could not start codex: ${rev.error.message}`);
  if (rev.status !== 0 || !rev.stdout.trim()) {
    return unusable(`review failed (exit ${rev.status}): ${tail(rev.stderr + rev.stdout)}`);
  }
  return { code: EXIT_OK, stdout: rev.stdout, reason: null };
}

function main() {
  let args;
  let prompt;
  try {
    args = parseArgs(process.argv.slice(2));
    prompt = readFileSync(args.promptFile, 'utf8');
    const bytes = Buffer.byteLength(prompt);
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(`prompt is ${bytes} bytes (max ${MAX_PROMPT_BYTES}); reference the diff file by path instead of inlining it`);
    }
  } catch (e) {
    process.stderr.write(`codex-review-lane: ${e.message}\n`);
    process.exit(EXIT_USAGE);
  }
  const r = runLane({ prompt, repoDir: args.repoDir });
  if (r.code === EXIT_OK) process.stdout.write(r.stdout);
  else process.stderr.write(`codex-review-lane: Codex lane unusable: ${r.reason}\n`);
  process.exit(r.code);
}

// Compare real paths: import.meta.url resolves symlinks but argv[1] does not, so a
// symlinked plugin dir would otherwise skip main() and exit 0 with no output.
function invokedDirectly() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (invokedDirectly()) main();
