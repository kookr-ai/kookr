/**
 * `kookr retro-verify` — status + burst-drain for the CI-blind-merge queue
 * (issues #1689 / #1703).
 *
 *   kookr retro-verify status [--json]
 *   kookr retro-verify drain  [--json] [--limit N] [--dry-run]
 *   kookr retro-verify enqueue --sha <sha> --repo <owner/repo> [--pr N] [--reason <text>]
 *
 * `status` exposes the first-class `ci_blind_debt` metric (queue depth +
 * blind-merge count). `drain` re-verifies pending commits via an injected
 * `verify` callback (default: local `pnpm test` in --repo-dir when set, else
 * reports `unavailable` so capacity recovery can retry) and files a P1 issue
 * on failure via `gh issue create`.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeCiBlindDebt,
  formatCiBlindDebtLogLine,
  type CiBlindDebt,
} from '../core/ci-blind-debt.js';
import {
  buildRetroVerifyEntry,
  defaultRetroVerifyQueueDir,
  drainRetroVerifyQueue,
  enqueueRetroVerify,
  readPendingRetroVerify,
  type DrainRetroVerifyResult,
  type FileP1Fn,
  type FileP1Result,
  type RetroVerifyEntry,
  type VerifyFn,
  type VerifyResult,
} from '../core/retro-verify-queue.js';

export const USAGE = `kookr retro-verify — CI-blind-merge debt + retro-verify drain (#1689, #1703).

Usage:
  kookr retro-verify status  [--json] [--dir PATH]
  kookr retro-verify drain   [--json] [--dir PATH] [--limit N] [--dry-run]
                             [--repo-dir PATH] [--verify-cmd <shell>]
  kookr retro-verify enqueue --sha <sha> --repo <owner/repo>
                             [--pr <N>] [--reason <text>] [--dir PATH] [--json]

status   Print the ci_blind_debt metric (blind-merge count + queue depth).
drain    Burst-drain the queue: re-verify each entry; on fail file a P1 issue.
enqueue  Record a merge made under a CI-signal-absent regime (or verified-locally).

Options:
  --dir PATH          Queue directory (default: ~/.kookr/playbook-state/retro-verify-queue
                      or KOOKR_RETRO_VERIFY_QUEUE_DIR).
  --sha <sha>         Commit SHA to enqueue (enqueue).
  --repo <owner/repo> Repository the commit belongs to (enqueue; also labels P1s).
  --pr <N>            PR number that merged the commit (enqueue; 0 when unknown).
  --reason <text>     Enqueue reason (default: verified-locally).
  --limit <N>         Max entries to attempt this drain (default: all).
  --dry-run           Drain without calling verify/fileP1; report what would run.
  --repo-dir PATH     Local checkout used by the default local-suite verify.
  --verify-cmd <cmd>  Shell command that exits 0 on pass (overrides --repo-dir suite).
  --json              Machine-readable envelope on stdout.
  -h, --help          Show this help.

Environment:
  KOOKR_RETRO_VERIFY_QUEUE_DIR  Override queue path.
  GH_TOKEN / gh auth            Required for P1 filing on failed re-verify.

Exit codes:
  0  Success.
  2  User error (bad flags / missing required args).
  4  Drain completed with one or more verification failures (P1 filed or pending).
`;

export interface RetroVerifyCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  now?: () => Date;
  /** Injectable verify callback (tests / custom runners). */
  verify?: VerifyFn;
  /** Injectable P1 filer (tests). */
  fileP1?: FileP1Fn;
  /** Injectable gh runner for the default P1 filer. */
  runGh?: (args: string[]) => string;
}

export class RetroVerifyUsageError extends Error {}

interface ParsedArgs {
  verb: string | null;
  dir: string | null;
  sha: string | null;
  repo: string | null;
  pr: number;
  reason: string;
  limit: number | null;
  dryRun: boolean;
  repoDir: string | null;
  verifyCmd: string | null;
  json: boolean;
  help: boolean;
}

export function parseRetroVerifyArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    verb: null,
    dir: null,
    sha: null,
    repo: null,
    pr: 0,
    reason: 'verified-locally',
    limit: null,
    dryRun: false,
    repoDir: null,
    verifyCmd: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const eat = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new RetroVerifyUsageError(`option ${tok} requires a value`);
      return v;
    };
    const eatNum = (label: string): number => {
      const raw = eat();
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new RetroVerifyUsageError(`${label} must be a number (got ${raw})`);
      return n;
    };

    if (tok === '-h' || tok === '--help' || tok === 'help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--dry-run') {
      out.dryRun = true;
    } else if (tok === '--dir' || tok.startsWith('--dir=')) {
      out.dir = tok.includes('=') ? tok.slice('--dir='.length) : eat();
    } else if (tok === '--sha' || tok.startsWith('--sha=')) {
      out.sha = tok.includes('=') ? tok.slice('--sha='.length) : eat();
    } else if (tok === '--repo' || tok.startsWith('--repo=')) {
      out.repo = tok.includes('=') ? tok.slice('--repo='.length) : eat();
    } else if (tok === '--pr' || tok.startsWith('--pr=')) {
      out.pr = tok.includes('=') ? Number(tok.slice('--pr='.length)) : eatNum('--pr');
      if (!Number.isFinite(out.pr)) throw new RetroVerifyUsageError('--pr must be a number');
    } else if (tok === '--reason' || tok.startsWith('--reason=')) {
      out.reason = tok.includes('=') ? tok.slice('--reason='.length) : eat();
    } else if (tok === '--limit' || tok.startsWith('--limit=')) {
      out.limit = tok.includes('=')
        ? Number(tok.slice('--limit='.length))
        : eatNum('--limit');
      if (!Number.isFinite(out.limit)) throw new RetroVerifyUsageError('--limit must be a number');
    } else if (tok === '--repo-dir' || tok.startsWith('--repo-dir=')) {
      out.repoDir = tok.includes('=') ? tok.slice('--repo-dir='.length) : eat();
    } else if (tok === '--verify-cmd' || tok.startsWith('--verify-cmd=')) {
      out.verifyCmd = tok.includes('=') ? tok.slice('--verify-cmd='.length) : eat();
    } else if (tok.startsWith('-')) {
      throw new RetroVerifyUsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else {
      throw new RetroVerifyUsageError(`unexpected argument: ${tok}`);
    }
  }

  return out;
}

function resolveSpoolDir(args: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return args.dir ?? defaultRetroVerifyQueueDir(env);
}

function defaultRunGh(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`gh failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `gh exit ${result.status}`).trim();
    throw new Error(msg);
  }
  return result.stdout ?? '';
}

/** Default verify: shell command, or local suite, else unavailable. */
export function buildDefaultVerifyFn(opts: {
  verifyCmd?: string | null;
  repoDir?: string | null;
}): VerifyFn {
  return async (entry: RetroVerifyEntry): Promise<VerifyResult> => {
    if (opts.verifyCmd && opts.verifyCmd.trim()) {
      const result = spawnSync(opts.verifyCmd, {
        shell: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          KOOKR_RETRO_VERIFY_SHA: entry.sha,
          KOOKR_RETRO_VERIFY_REPO: entry.repo,
          KOOKR_RETRO_VERIFY_PR: String(entry.prNumber),
        },
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status === 0) return { outcome: 'pass' };
      if (result.status === null) {
        return {
          outcome: 'unavailable',
          error: result.error?.message ?? 'verify command failed to start',
        };
      }
      const err = (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500);
      return { outcome: 'fail', error: err || `verify-cmd exit ${result.status}` };
    }
    if (opts.repoDir && opts.repoDir.trim()) {
      // Prefer the repo's local verify surface when present; fall back to pnpm test.
      const result = spawnSync('pnpm', ['test'], {
        cwd: opts.repoDir,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (result.status === 0) return { outcome: 'pass' };
      if (result.status === null) {
        return {
          outcome: 'unavailable',
          error: result.error?.message ?? 'pnpm test failed to start',
        };
      }
      const err = (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500);
      return { outcome: 'fail', error: err || `pnpm test exit ${result.status}` };
    }
    return {
      outcome: 'unavailable',
      error:
        'no verify runner configured (pass --verify-cmd or --repo-dir, or inject verify)',
    };
  };
}

/** Default P1 filer: open a tracked GitHub issue naming the offending commit. */
export function buildDefaultFileP1Fn(opts: {
  runGh: (args: string[]) => string;
}): FileP1Fn {
  return async (entry: RetroVerifyEntry, error?: string): Promise<FileP1Result> => {
    const title =
      `[P1] Retro-verify failed for ${entry.sha.slice(0, 12)}` +
      (entry.prNumber > 0 ? ` (PR #${entry.prNumber})` : '');
    const body = [
      '## Retro-verify failure (issue #1703 / #1689)',
      '',
      'A commit that merged while CI was signal-absent failed re-verification',
      'once capacity recovered. This issue is auto-filed so the regression is',
      'tracked rather than silent.',
      '',
      `| Field | Value |`,
      `| --- | --- |`,
      `| Repo | \`${entry.repo}\` |`,
      `| SHA | \`${entry.sha}\` |`,
      `| PR | ${entry.prNumber > 0 ? `#${entry.prNumber}` : '_unknown_'} |`,
      `| Enqueue reason | \`${entry.reason}\` |`,
      `| Enqueued at | ${entry.createdAt} |`,
      `| Verify error | ${error ? error.replace(/\n/g, ' ').slice(0, 400) : '_none_'} |`,
      '',
      '### Next steps',
      '',
      '1. Confirm the failure against the SHA (checkout + re-run the suite).',
      '2. Revert or fix forward; keep this issue open until main is green.',
      '3. Leave the retro-verify queue entry to the drain — it dequeues once',
      '   this P1 is filed.',
      '',
      '_Filed by `kookr retro-verify drain`._',
    ].join('\n');

    // Write body to a temp file so gh does not choke on long args / shell
    // quoting. Clean up best-effort after create.
    const dir = mkdtempSync(join(tmpdir(), 'kookr-retro-verify-p1-'));
    const bodyPath = join(dir, 'body.md');
    try {
      writeFileSync(bodyPath, body, 'utf8');
      const raw = opts.runGh([
        'issue',
        'create',
        '-R',
        entry.repo,
        '--title',
        title,
        '--body-file',
        bodyPath,
        '--label',
        'bug',
      ]);
      const issueRef = raw.trim().split('\n').filter(Boolean).pop() ?? raw.trim();
      return { filed: true, issueRef };
    } catch (err) {
      // Surface as filed:false so the queue keeps the verifyFailed entry and
      // retries filing on the next drain without re-running verify.
      void err;
      return { filed: false };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  };
}

export async function runRetroVerifyCli(
  argv: string[],
  io: RetroVerifyCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());

  let args: ParsedArgs;
  try {
    args = parseRetroVerifyArgs(argv);
  } catch (e) {
    err.error(`[kookr retro-verify] ${e instanceof Error ? e.message : String(e)}`);
    err.error('Run `kookr retro-verify --help` for usage.');
    return 2;
  }

  if (args.help || args.verb === null) {
    out.log(USAGE);
    return 0;
  }

  const spoolDir = resolveSpoolDir(args, env);

  try {
    if (args.verb === 'status') {
      const pending = await readPendingRetroVerify(spoolDir);
      const debt = computeCiBlindDebt(pending, { now: now() });
      return printStatus(out, args.json, debt, spoolDir);
    }

    if (args.verb === 'enqueue') {
      if (!args.sha) throw new RetroVerifyUsageError('--sha is required for enqueue');
      if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
        throw new RetroVerifyUsageError('--repo must be owner/repo');
      }
      const entry = buildRetroVerifyEntry({
        sha: args.sha,
        prNumber: args.pr,
        repo: args.repo,
        reason: args.reason,
        createdAt: now().toISOString(),
      });
      const result = await enqueueRetroVerify(spoolDir, entry);
      if (args.json) {
        out.log(JSON.stringify({ ok: true, spoolDir, ...result, entry }));
      } else {
        out.log(
          result.enqueued
            ? `enqueued ${entry.sha} (${entry.repo} pr=${entry.prNumber}) → ${result.path}`
            : `duplicate ${entry.sha} (already queued) → ${result.path}`,
        );
      }
      return 0;
    }

    if (args.verb === 'drain') {
      const pending = await readPendingRetroVerify(spoolDir);
      if (args.dryRun) {
        const debt = computeCiBlindDebt(pending, { now: now() });
        const limit = args.limit !== null ? Math.max(0, Math.floor(args.limit)) : pending.length;
        const wouldAttempt = pending.slice(0, limit);
        if (args.json) {
          out.log(
            JSON.stringify({
              ok: true,
              dryRun: true,
              spoolDir,
              ciBlindDebt: debt,
              ci_blind_debt: debt,
              wouldAttempt: wouldAttempt.map((e) => ({
                sha: e.sha,
                prNumber: e.prNumber,
                repo: e.repo,
                reason: e.reason,
                verifyFailed: e.verifyFailed ?? false,
              })),
            }),
          );
        } else {
          out.log(formatCiBlindDebtLogLine(debt));
          out.log(`dry-run: would attempt ${wouldAttempt.length} of ${pending.length} entr(y/ies)`);
          for (const e of wouldAttempt) {
            out.log(
              `  - ${e.sha.slice(0, 12)} ${e.repo} pr=${e.prNumber}` +
                (e.verifyFailed ? ' (p1-retry)' : ''),
            );
          }
        }
        return 0;
      }

      const verify =
        io.verify ??
        buildDefaultVerifyFn({
          verifyCmd: args.verifyCmd,
          repoDir: args.repoDir,
        });
      const runGh = io.runGh ?? ((a: string[]) => defaultRunGh(a, env));
      const fileP1 = io.fileP1 ?? buildDefaultFileP1Fn({ runGh });

      // Optional limit: only hand the first N entries to the drain by
      // temporarily rewriting is not needed — drain processes the whole
      // queue, so when limit is set we drain a filtered view via a custom
      // verify that marks the rest unavailable? Cleaner: bound by wrapping.
      let limitedVerify: VerifyFn = verify;
      if (args.limit !== null) {
        let seen = 0;
        const cap = Math.max(0, Math.floor(args.limit));
        limitedVerify = async (entry) => {
          // Always allow verifyFailed retries through — they are cheap P1
          // re-filings, not full suite re-runs.
          if (entry.verifyFailed) return verify(entry);
          if (seen >= cap) {
            return { outcome: 'unavailable', error: 'deferred by --limit' };
          }
          seen += 1;
          return verify(entry);
        };
      }

      const result: DrainRetroVerifyResult = await drainRetroVerifyQueue({
        spoolDir,
        verify: limitedVerify,
        fileP1,
        now: now(),
      });
      const remaining = await readPendingRetroVerify(spoolDir);
      const debt = computeCiBlindDebt(remaining, { now: now() });
      if (args.json) {
        out.log(
          JSON.stringify({
            ok: true,
            spoolDir,
            drain: result,
            ciBlindDebt: debt,
            ci_blind_debt: debt,
          }),
        );
      } else {
        out.log(
          `drain: attempted=${result.attempted} passed=${result.passed} ` +
            `failed=${result.failed} unavailable=${result.unavailable} ` +
            `p1Filed=${result.p1Filed} remaining=${result.remaining}`,
        );
        out.log(formatCiBlindDebtLogLine(debt));
        if (result.failedShas.length > 0) {
          out.log(`failedShas=${result.failedShas.join(',')}`);
        }
        if (result.p1FiledShas.length > 0) {
          out.log(`p1FiledShas=${result.p1FiledShas.join(',')}`);
        }
      }
      return result.failed > 0 ? 4 : 0;
    }

    throw new RetroVerifyUsageError(`unknown verb: ${args.verb}`);
  } catch (e) {
    if (e instanceof RetroVerifyUsageError) {
      err.error(`[kookr retro-verify] ${e.message}`);
      err.error('Run `kookr retro-verify --help` for usage.');
      return 2;
    }
    err.error(`[kookr retro-verify] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function printStatus(
  out: { log: (...a: unknown[]) => void },
  json: boolean,
  debt: CiBlindDebt,
  spoolDir: string,
): number {
  if (json) {
    out.log(
      JSON.stringify({
        ok: true,
        spoolDir,
        ciBlindDebt: debt,
        ci_blind_debt: debt,
      }),
    );
  } else {
    out.log(`spoolDir=${spoolDir}`);
    out.log(formatCiBlindDebtLogLine(debt));
    if (debt.sample.length > 0) {
      out.log('oldest:');
      for (const s of debt.sample) {
        out.log(
          `  - ${s.sha.slice(0, 12)} ${s.repo} pr=${s.prNumber} reason=${s.reason}` +
            (s.verifyFailed ? ' verifyFailed' : ''),
        );
      }
    }
  }
  return 0;
}
