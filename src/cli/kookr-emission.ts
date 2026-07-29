/**
 * `kookr emission` — drain-coupled issue-filing budget + mandatory dedupe
 * (issue #1607).
 *
 *   kookr emission plan    --repo owner/repo --requested N [--json]
 *   kookr emission dedupe  --repo owner/repo --title "..." [--json]
 *   kookr emission metrics --repo owner/repo [--json]
 *   kookr emission defer   --repo owner/repo --title "..." --source <playbook> [--json]
 *
 * Playbooks (idea-scout, architecture-health-check, reflection/retro) call
 * these before any `gh issue create`. Pure budget/dedupe math lives in
 * `core/emission-budget.ts`; this CLI shells out to `gh` for live counts and
 * writes the deferred-ideas JSONL.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_CONSTRAINED_BUDGET,
  DEFAULT_DEDUPE_SIMILARITY_THRESHOLD,
  DEFAULT_DRAIN_COUPLING_RATIO,
  DEFAULT_DRAIN_FLOOR_BUDGET,
  DEFAULT_OPEN_BACKLOG_THRESHOLD,
  EMISSION_BUDGET_SCHEMA_VERSION,
  NET_BACKLOG_DELTA_WINDOW_DAYS,
  budgetLogicVersionStatus,
  buildDeferredIdeaRecord,
  checkDedupe,
  computeNetBacklogDelta7d,
  deferredIdeasPath,
  extractSchemaVersion,
  resolveEmissionBudget,
  utcDayKeyDaysAgo,
  type EmissionBudgetPlan,
  type IssueRef,
  type NetBacklogDelta7d,
} from '../core/emission-budget.js';

export const USAGE = `kookr emission — drain-coupled issue filing budget + dedupe (#1607, #1657).

Usage:
  kookr emission plan    --repo <owner/repo> --requested <N> [OPTIONS]
  kookr emission dedupe  --repo <owner/repo> --title <text> [OPTIONS]
  kookr emission metrics --repo <owner/repo> [OPTIONS]
  kookr emission defer   --repo <owner/repo> --title <text> --source <name> [OPTIONS]
  kookr emission version [--repo-dir <path>] [OPTIONS]

plan     Resolve how many new issues this run may file given live open backlog
         AND the target repo's drain rate (closed issues in the window, #1657).
dedupe   Mandatory pre-filing duplicate check; always prints a log line.
metrics  Open backlog + 7-day netBacklogDelta7d + current constrained budget.
defer    Append a candidate to the deferred-ideas JSONL instead of filing.
version  Report the running budget-logic version and warn if it lags origin/main.

Options:
  --repo <owner/repo>     Target GitHub repository (required).
  --requested <N>         How many issues this run wants to file (plan).
  --title <text>          Candidate issue title (dedupe / defer).
  --source <name>         Emitting playbook id (defer).
  --reason <text>         Defer reason (default: over emission budget).
  --threshold <N>         Open-backlog threshold (default: ${DEFAULT_OPEN_BACKLOG_THRESHOLD}).
  --constrained <N>       Budget when over threshold (default: ${DEFAULT_CONSTRAINED_BUDGET}).
  --drain-window <N>      Drain-rate window in days (plan; default: ${NET_BACKLOG_DELTA_WINDOW_DAYS}).
  --drain-ratio <N>       New issues earned per drained issue (default: ${DEFAULT_DRAIN_COUPLING_RATIO}).
  --drain-floor <N>       Minimum budget regardless of drain (default: ${DEFAULT_DRAIN_FLOOR_BUDGET}).
  --no-drain-coupling     Disable drain coupling (legacy backlog-only budget).
  --body-preview <text>   Optional body snippet stored on defer.
  --kookr-dir <PATH>      State root for deferred-ideas (default: ~/.kookr).
  --repo-dir <PATH>       Local checkout to compare against origin/main (version).
  --json                  Machine-readable envelope on stdout.
  -h, --help              Show this help.

Environment:
  GH_TOKEN / gh auth      Required for live GitHub counts (plan/dedupe/metrics).

Exit codes:
  0  Success.
  2  User error (bad flags / missing required args).
  4  GitHub query failed.
`;

export interface EmissionCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  now?: () => Date;
  /** Injectable gh runner for tests. Returns stdout text; throws on failure. */
  runGh?: (args: string[]) => string;
  /** Injectable git runner for tests (version verb). Returns stdout; throws on failure. */
  runGit?: (args: string[]) => string;
  /** Injectable append for defer (tests). */
  appendLine?: (path: string, line: string) => void;
}

interface ParsedArgs {
  verb: string | null;
  repo: string | null;
  requested: number | null;
  title: string | null;
  source: string | null;
  reason: string | null;
  bodyPreview: string | null;
  threshold: number;
  constrained: number;
  drainWindow: number;
  drainRatio: number;
  drainFloor: number;
  drainCoupling: boolean;
  repoDir: string | null;
  kookrDir: string;
  json: boolean;
  help: boolean;
}

export class EmissionUsageError extends Error {}

export function parseEmissionArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    verb: null,
    repo: null,
    requested: null,
    title: null,
    source: null,
    reason: null,
    bodyPreview: null,
    threshold: DEFAULT_OPEN_BACKLOG_THRESHOLD,
    constrained: DEFAULT_CONSTRAINED_BUDGET,
    drainWindow: NET_BACKLOG_DELTA_WINDOW_DAYS,
    drainRatio: DEFAULT_DRAIN_COUPLING_RATIO,
    drainFloor: DEFAULT_DRAIN_FLOOR_BUDGET,
    drainCoupling: true,
    repoDir: null,
    kookrDir: `${homedir()}/.kookr`,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const eat = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new EmissionUsageError(`option ${tok} requires a value`);
      return v;
    };
    const eatNum = (label: string): number => {
      const raw = eat();
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new EmissionUsageError(`${label} must be a number (got ${raw})`);
      return n;
    };

    if (tok === '-h' || tok === '--help' || tok === 'help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--repo' || tok.startsWith('--repo=')) {
      out.repo = tok.includes('=') ? tok.slice('--repo='.length) : eat();
    } else if (tok === '--requested' || tok.startsWith('--requested=')) {
      out.requested = tok.includes('=')
        ? Number(tok.slice('--requested='.length))
        : eatNum('--requested');
      if (!Number.isFinite(out.requested)) throw new EmissionUsageError('--requested must be a number');
    } else if (tok === '--title' || tok.startsWith('--title=')) {
      out.title = tok.includes('=') ? tok.slice('--title='.length) : eat();
    } else if (tok === '--source' || tok.startsWith('--source=')) {
      out.source = tok.includes('=') ? tok.slice('--source='.length) : eat();
    } else if (tok === '--reason' || tok.startsWith('--reason=')) {
      out.reason = tok.includes('=') ? tok.slice('--reason='.length) : eat();
    } else if (tok === '--body-preview' || tok.startsWith('--body-preview=')) {
      out.bodyPreview = tok.includes('=') ? tok.slice('--body-preview='.length) : eat();
    } else if (tok === '--threshold' || tok.startsWith('--threshold=')) {
      out.threshold = tok.includes('=')
        ? Number(tok.slice('--threshold='.length))
        : eatNum('--threshold');
      if (!Number.isFinite(out.threshold)) throw new EmissionUsageError('--threshold must be a number');
    } else if (tok === '--constrained' || tok.startsWith('--constrained=')) {
      out.constrained = tok.includes('=')
        ? Number(tok.slice('--constrained='.length))
        : eatNum('--constrained');
      if (!Number.isFinite(out.constrained)) {
        throw new EmissionUsageError('--constrained must be a number');
      }
    } else if (tok === '--drain-window' || tok.startsWith('--drain-window=')) {
      out.drainWindow = tok.includes('=')
        ? Number(tok.slice('--drain-window='.length))
        : eatNum('--drain-window');
      if (!Number.isFinite(out.drainWindow)) {
        throw new EmissionUsageError('--drain-window must be a number');
      }
    } else if (tok === '--drain-ratio' || tok.startsWith('--drain-ratio=')) {
      out.drainRatio = tok.includes('=')
        ? Number(tok.slice('--drain-ratio='.length))
        : eatNum('--drain-ratio');
      if (!Number.isFinite(out.drainRatio)) {
        throw new EmissionUsageError('--drain-ratio must be a number');
      }
    } else if (tok === '--drain-floor' || tok.startsWith('--drain-floor=')) {
      out.drainFloor = tok.includes('=')
        ? Number(tok.slice('--drain-floor='.length))
        : eatNum('--drain-floor');
      if (!Number.isFinite(out.drainFloor)) {
        throw new EmissionUsageError('--drain-floor must be a number');
      }
    } else if (tok === '--no-drain-coupling') {
      out.drainCoupling = false;
    } else if (tok === '--repo-dir' || tok.startsWith('--repo-dir=')) {
      out.repoDir = tok.includes('=') ? tok.slice('--repo-dir='.length) : eat();
    } else if (tok === '--kookr-dir' || tok.startsWith('--kookr-dir=')) {
      out.kookrDir = tok.includes('=') ? tok.slice('--kookr-dir='.length) : eat();
    } else if (tok.startsWith('-')) {
      throw new EmissionUsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else {
      throw new EmissionUsageError(`unexpected argument: ${tok}`);
    }
  }

  return out;
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

function defaultRunGit(args: string[], repoDir: string): string {
  const result = spawnSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `git exit ${result.status}`).trim();
    throw new Error(msg);
  }
  return result.stdout ?? '';
}

function requireRepo(repo: string | null): string {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new EmissionUsageError('--repo must be owner/repo');
  }
  return repo;
}

function searchTotalCount(runGh: (args: string[]) => string, query: string): number {
  // gh api search encodes the q= query; use --method GET with -f for safety.
  const raw = runGh([
    'api',
    '-X',
    'GET',
    'search/issues',
    '-f',
    `q=${query}`,
    '-f',
    'per_page=1',
    '--jq',
    '.total_count',
  ]);
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new Error(`unexpected search total_count: ${raw}`);
  return Math.max(0, Math.floor(n));
}

function listOpenIssues(runGh: (args: string[]) => string, repo: string): IssueRef[] {
  const raw = runGh([
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,url,state',
  ]);
  const parsed = JSON.parse(raw || '[]') as IssueRef[];
  if (!Array.isArray(parsed)) throw new Error('gh issue list returned non-array JSON');
  return parsed;
}

function printPlanHuman(out: { log: (...a: unknown[]) => void }, plan: EmissionBudgetPlan): void {
  out.log(`openBacklogCount=${plan.openBacklogCount}`);
  out.log(`openBacklogThreshold=${plan.openBacklogThreshold}`);
  out.log(`overThreshold=${plan.overThreshold}`);
  out.log(`requestedBudget=${plan.requestedBudget}`);
  out.log(`allowedBudget=${plan.allowedBudget}`);
  out.log(`deferredCount=${plan.deferredCount}`);
  out.log(`drainCoupled=${plan.drainCoupled}`);
  if (plan.drainCount !== undefined) out.log(`drainCount=${plan.drainCount}`);
  if (plan.drainCap !== undefined) out.log(`drainCap=${plan.drainCap}`);
  out.log(`action=${plan.action}`);
  out.log(`reason=${plan.reason}`);
}

export async function runEmissionCli(
  argv: string[],
  io: EmissionCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());
  const runGh = io.runGh ?? ((args: string[]) => defaultRunGh(args, env));
  const runGit = io.runGit;
  const appendLine =
    io.appendLine ??
    ((path: string, line: string) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    });

  let args: ParsedArgs;
  try {
    args = parseEmissionArgs(argv);
  } catch (e) {
    err.error(`[kookr emission] ${e instanceof Error ? e.message : String(e)}`);
    err.error('Run `kookr emission --help` for usage.');
    return 2;
  }

  if (args.help || args.verb === null) {
    out.log(USAGE);
    return 0;
  }

  try {
    if (args.verb === 'plan') {
      const repo = requireRepo(args.repo);
      if (args.requested === null) throw new EmissionUsageError('--requested is required for plan');
      // Prefer search total_count so backlog >200 is not under-counted by list --limit.
      let openBacklogCount: number;
      try {
        openBacklogCount = searchTotalCount(runGh, `repo:${repo} is:issue is:open`);
      } catch {
        openBacklogCount = listOpenIssues(runGh, repo).length;
      }
      const openIssues = listOpenIssues(runGh, repo);
      // Drain-coupling (#1657): the drain denominator is *this* repo's recent
      // closed-issue count, so a high-drain actor filing into a low-drain repo
      // is budgeted by the low-drain target, never the actor's home repo.
      let drainCount: number | undefined;
      if (args.drainCoupling) {
        const since = utcDayKeyDaysAgo(args.drainWindow, now());
        try {
          drainCount = searchTotalCount(
            runGh,
            `repo:${repo} is:issue is:closed closed:>=${since}`,
          );
        } catch {
          // Leave drainCount undefined → drain coupling is skipped this run
          // rather than failing the whole plan on a flaky search query.
          drainCount = undefined;
        }
      }
      const plan = resolveEmissionBudget({
        openBacklogCount,
        requestedBudget: args.requested,
        openBacklogThreshold: args.threshold,
        constrainedBudget: args.constrained,
        ...(drainCount !== undefined
          ? {
              drainCount,
              drainCouplingRatio: args.drainRatio,
              drainFloorBudget: args.drainFloor,
            }
          : {}),
      });
      const payload = {
        ok: true,
        repo,
        plan,
        openIssueSample: openIssues.slice(0, 5).map((i) => ({ number: i.number, title: i.title })),
        note:
          plan.deferredCount > 0
            ? `With allowedBudget=${plan.allowedBudget}, ${plan.deferredCount} of the requested filings must be deferred/redirected.`
            : undefined,
      };
      if (args.json) {
        out.log(JSON.stringify(payload));
      } else {
        printPlanHuman(out, plan);
        if (payload.note) out.log(payload.note);
      }
      return 0;
    }

    if (args.verb === 'dedupe') {
      const repo = requireRepo(args.repo);
      if (!args.title) throw new EmissionUsageError('--title is required for dedupe');
      const openIssues = listOpenIssues(runGh, repo);
      const result = checkDedupe(args.title, openIssues, DEFAULT_DEDUPE_SIMILARITY_THRESHOLD);
      // Always surface the audit line: stderr when --json (so stdout stays one
      // JSON document), otherwise stdout. Playbooks must keep the line in logs.
      if (args.json) {
        err.error(result.logLine);
        out.log(
          JSON.stringify({
            ok: true,
            repo,
            ...result,
            match: result.match
              ? {
                  number: result.match.number,
                  title: result.match.title,
                  url: result.match.url,
                }
              : null,
          }),
        );
      } else {
        out.log(result.logLine);
      }
      return 0;
    }

    if (args.verb === 'metrics') {
      const repo = requireRepo(args.repo);
      const since = utcDayKeyDaysAgo(NET_BACKLOG_DELTA_WINDOW_DAYS, now());
      const openBacklogCount = searchTotalCount(runGh, `repo:${repo} is:issue is:open`);
      const opened7d = searchTotalCount(runGh, `repo:${repo} is:issue created:>=${since}`);
      const closed7d = searchTotalCount(runGh, `repo:${repo} is:issue is:closed closed:>=${since}`);
      const delta = computeNetBacklogDelta7d(opened7d, closed7d);
      const plan = resolveEmissionBudget({
        openBacklogCount,
        requestedBudget: 10,
        openBacklogThreshold: args.threshold,
        constrainedBudget: args.constrained,
      });
      const payload: {
        ok: true;
        repo: string;
        openBacklogCount: number;
        since: string;
      } & NetBacklogDelta7d & {
          emissionBudgetIfRequested10: EmissionBudgetPlan;
        } = {
        ok: true,
        repo,
        openBacklogCount,
        since,
        ...delta,
        emissionBudgetIfRequested10: plan,
      };
      if (args.json) {
        out.log(JSON.stringify(payload));
      } else {
        out.log(`repo=${repo}`);
        out.log(`openBacklogCount=${openBacklogCount}`);
        out.log(`opened7d=${delta.opened7d}`);
        out.log(`closed7d=${delta.closed7d}`);
        out.log(`netBacklogDelta7d=${delta.netBacklogDelta7d}`);
        out.log(`since=${since}`);
        out.log(
          `emissionBudget(if requested=10): allowed=${plan.allowedBudget} action=${plan.action}`,
        );
      }
      return 0;
    }

    if (args.verb === 'defer') {
      const repo = requireRepo(args.repo);
      if (!args.title) throw new EmissionUsageError('--title is required for defer');
      if (!args.source) throw new EmissionUsageError('--source is required for defer');
      const path = deferredIdeasPath(repo, args.kookrDir);
      const record = buildDeferredIdeaRecord({
        repo,
        title: args.title,
        reason: args.reason ?? 'over emission budget',
        source: args.source,
        bodyPreview: args.bodyPreview ?? undefined,
        now: now(),
      });
      appendLine(path, JSON.stringify(record));
      if (args.json) {
        out.log(JSON.stringify({ ok: true, path, record }));
      } else {
        out.log(`deferred → ${path}`);
        out.log(JSON.stringify(record));
      }
      return 0;
    }

    if (args.verb === 'version') {
      // Deploy-freshness check (#1657 acceptance criterion 3): compare the
      // running budget-logic version against origin/main's source so a
      // silently-lagging daemon is surfaced, not assumed fresh. Best-effort:
      // a missing git / no origin ref yields reference=null ("cannot verify").
      const running = EMISSION_BUDGET_SCHEMA_VERSION;
      const repoDir = args.repoDir ?? process.cwd();
      const gitRun = runGit ?? ((a: string[]) => defaultRunGit(a, repoDir));
      let reference: string | null = null;
      try {
        const source = gitRun(['show', 'origin/main:src/core/emission-budget.ts']);
        reference = extractSchemaVersion(source);
      } catch {
        reference = null;
      }
      const status = budgetLogicVersionStatus(running, reference);
      if (args.json) {
        err.error(status.logLine);
        out.log(JSON.stringify({ ok: true, repoDir, ...status }));
      } else {
        out.log(status.logLine);
      }
      return 0;
    }

    throw new EmissionUsageError(`unknown verb: ${args.verb}`);
  } catch (e) {
    if (e instanceof EmissionUsageError) {
      err.error(`[kookr emission] ${e.message}`);
      err.error('Run `kookr emission --help` for usage.');
      return 2;
    }
    err.error(`[kookr emission] ${e instanceof Error ? e.message : String(e)}`);
    return 4;
  }
}
