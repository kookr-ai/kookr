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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_CONSTRAINED_BUDGET,
  DEFAULT_DEDUPE_SIMILARITY_THRESHOLD,
  DEFAULT_DRAIN_COUPLING_RATIO,
  DEFAULT_DRAIN_FLOOR_BUDGET,
  DEFAULT_OPEN_BACKLOG_THRESHOLD,
  DEFAULT_RETRO_VERIFY_DEPTH_THRESHOLD,
  EMISSION_BUDGET_SCHEMA_VERSION,
  NET_BACKLOG_DELTA_WINDOW_DAYS,
  budgetLogicVersionStatus,
  buildDeferredIdeaRecord,
  checkDedupe,
  computeNetBacklogDelta7d,
  deferredIdeasPath,
  extractSchemaVersion,
  resolveEmissionBudget,
  shouldBurstDrainBeforeEmission,
  utcDayKeyDaysAgo,
  type EmissionBudgetPlan,
  type IssueRef,
  type NetBacklogDelta7d,
} from '../core/emission-budget.js';
import {
  computeCiBlindDebt,
  formatCiBlindDebtLogLine,
  type CiBlindDebt,
} from '../core/ci-blind-debt.js';
import {
  defaultRetroVerifyQueueDir,
  readPendingRetroVerify,
} from '../core/retro-verify-queue.js';
import { EnvironmentBlockerRegistry } from '../core/environment-blocker-registry.js';
import { resolveKookrDataDir } from './kookr-maintenance.js';
import {
  PROJECT_ISSUE_EMISSION_LIMIT_ENV,
  readMaxZeroDrainIssueLimitFromEnv,
} from '../core/project-config-store.js';

export const USAGE = `kookr emission — drain-coupled issue filing budget + dedupe (#1607, #1657, #1703).

Usage:
  kookr emission plan    --repo <owner/repo> --requested <N> [OPTIONS]
  kookr emission dedupe  --repo <owner/repo> --title <text> [OPTIONS]
  kookr emission metrics --repo <owner/repo> [OPTIONS]
  kookr emission defer   --repo <owner/repo> --title <text> --source <name> [OPTIONS]
  kookr emission version [--repo-dir <path>] [OPTIONS]

plan     Resolve how many new issues this run may file given live open backlog,
         the target repo's drain rate (closed issues in the window, #1657), and
         the retro-verify / ci_blind_debt queue depth (#1703).
dedupe   Mandatory pre-filing duplicate check; always prints a log line.
metrics  Open backlog + 7-day netBacklogDelta7d + ci_blind_debt + budget.
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
  --drain-floor <N>       Internal compatibility option; must remain ${DEFAULT_DRAIN_FLOOR_BUDGET}.
  --retro-verify-threshold <N>
                          Depth at/above which emission is withheld
                          (default: ${DEFAULT_RETRO_VERIFY_DEPTH_THRESHOLD}).
  --no-retro-verify-coupling
                          Disable ci_blind_debt gate (do not read the queue).
  --tolerance-blocker <type:scope>
                          Mark this run's candidates as tolerance machinery for
                          the given external blocker (plan). If that blocker
                          already has a tolerance regime in the env-blocker
                          registry, emission is refused (#1702).
  --body-preview <text>   Optional body snippet stored on defer.
  --kookr-dir <PATH>      State root for deferred-ideas (default: ~/.kookr).
  --retro-verify-dir <PATH>
                          Retro-verify queue dir (default: ~/.kookr/playbook-state/retro-verify-queue
                          or KOOKR_RETRO_VERIFY_QUEUE_DIR).
  --repo-dir <PATH>       Local checkout to compare against origin/main (version).
  --json                  Machine-readable envelope on stdout.
  -h, --help              Show this help.

Environment:
  GH_TOKEN / gh auth      Required for live GitHub counts (plan/dedupe/metrics).
  KOOKR_RETRO_VERIFY_QUEUE_DIR  Override retro-verify queue path.
  KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT  Optional deployment-wide ceiling for repository zero-drain limits.

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
  /**
   * Injectable retro-verify depth reader (tests). When omitted, the CLI reads
   * the durable queue from disk (or returns 0 / empty debt on ENOENT).
   */
  readRetroVerifyDepth?: () => Promise<{ depth: number; debt: CiBlindDebt }>;
  /**
   * Injectable tolerance-regime reader (tests). Given a blocker key
   * `type:scope`, returns whether that blocker already has a tolerance regime.
   * When omitted, the CLI loads the env-blocker registry from `--kookr-dir` and
   * calls `hasRegime` (a missing/unreadable registry ⇒ false / no regime).
   */
  readToleranceRegime?: (blockerKey: string) => Promise<boolean>;
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
  retroVerifyCoupling: boolean;
  retroVerifyDepthThreshold: number;
  retroVerifyDir: string | null;
  toleranceBlocker: string | null;
  repoDir: string | null;
  kookrDir: string;
  kookrDirExplicit: boolean;
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
    retroVerifyCoupling: true,
    retroVerifyDepthThreshold: DEFAULT_RETRO_VERIFY_DEPTH_THRESHOLD,
    retroVerifyDir: null,
    toleranceBlocker: null,
    repoDir: null,
    kookrDir: `${homedir()}/.kookr`,
    kookrDirExplicit: false,
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
    } else if (tok === '--no-retro-verify-coupling') {
      out.retroVerifyCoupling = false;
    } else if (tok === '--retro-verify-threshold' || tok.startsWith('--retro-verify-threshold=')) {
      out.retroVerifyDepthThreshold = tok.includes('=')
        ? Number(tok.slice('--retro-verify-threshold='.length))
        : eatNum('--retro-verify-threshold');
      if (!Number.isFinite(out.retroVerifyDepthThreshold)) {
        throw new EmissionUsageError('--retro-verify-threshold must be a number');
      }
    } else if (tok === '--retro-verify-dir' || tok.startsWith('--retro-verify-dir=')) {
      out.retroVerifyDir = tok.includes('=')
        ? tok.slice('--retro-verify-dir='.length)
        : eat();
    } else if (tok === '--tolerance-blocker' || tok.startsWith('--tolerance-blocker=')) {
      out.toleranceBlocker = tok.includes('=')
        ? tok.slice('--tolerance-blocker='.length)
        : eat();
    } else if (tok === '--repo-dir' || tok.startsWith('--repo-dir=')) {
      out.repoDir = tok.includes('=') ? tok.slice('--repo-dir='.length) : eat();
    } else if (tok === '--kookr-dir' || tok.startsWith('--kookr-dir=')) {
      out.kookrDir = tok.includes('=') ? tok.slice('--kookr-dir='.length) : eat();
      out.kookrDirExplicit = true;
    } else if (tok.startsWith('-')) {
      throw new EmissionUsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else {
      throw new EmissionUsageError(`unexpected argument: ${tok}`);
    }
  }

  if (out.drainFloor !== DEFAULT_DRAIN_FLOOR_BUDGET) {
    throw new EmissionUsageError(`--drain-floor is fixed at ${DEFAULT_DRAIN_FLOOR_BUDGET}; configure zero-drain allowance in the repository settings`);
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

function readConfiguredZeroDrainIssueLimit(
  repo: string,
  kookrDir: string,
  env: NodeJS.ProcessEnv,
): number {
  const path = join(kookrDir, 'project-configs.json');
  let configured = 0;
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (Array.isArray(rows)) {
      const row = rows.find((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const project = (candidate as { project?: unknown }).project;
        const normalizedRepo = repo.toLowerCase();
        return project === `github.com/${normalizedRepo}` || project === normalizedRepo;
      }) as { zeroDrainIssueLimit?: unknown } | undefined;
      if (row && Number.isSafeInteger(row.zeroDrainIssueLimit) && (row.zeroDrainIssueLimit as number) >= 0) {
        configured = row.zeroDrainIssueLimit as number;
      }
    }
  } catch {
    // Missing/corrupt optional project settings keep the strict default.
  }
  const maximum = readMaxZeroDrainIssueLimitFromEnv(env);
  if (maximum !== undefined && configured > maximum) {
    throw new EmissionUsageError(
      `project zeroDrainIssueLimit=${configured} exceeds ${maximum} (${PROJECT_ISSUE_EMISSION_LIMIT_ENV})`,
    );
  }
  return configured;
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
  out.log(`retroVerifyCoupled=${plan.retroVerifyCoupled}`);
  if (plan.retroVerifyDepth !== undefined) out.log(`retroVerifyDepth=${plan.retroVerifyDepth}`);
  if (plan.retroVerifyDepthThreshold !== undefined) {
    out.log(`retroVerifyDepthThreshold=${plan.retroVerifyDepthThreshold}`);
  }
  out.log(`retroVerifyWithheld=${plan.retroVerifyWithheld}`);
  out.log(`toleranceRegimeCoupled=${plan.toleranceRegimeCoupled}`);
  if (plan.toleranceRegimeBlockerKey !== undefined) {
    out.log(`toleranceRegimeBlockerKey=${plan.toleranceRegimeBlockerKey}`);
  }
  out.log(`toleranceRegimeBlocked=${plan.toleranceRegimeBlocked}`);
  out.log(`action=${plan.action}`);
  out.log(`reason=${plan.reason}`);
}

async function loadCiBlindDebt(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  inject?: EmissionCliIo['readRetroVerifyDepth'],
): Promise<{ depth: number; debt: CiBlindDebt }> {
  if (inject) return inject();
  const spoolDir = args.retroVerifyDir ?? defaultRetroVerifyQueueDir(env);
  try {
    const pending = await readPendingRetroVerify(spoolDir);
    const debt = computeCiBlindDebt(pending, { now: now() });
    return { depth: debt.queueDepth, debt };
  } catch {
    // Fail-open for the metric path: a missing/unreadable spool is treated as
    // zero debt rather than failing the whole plan (same posture as a failed
    // drain-search). Operators can still inspect via `kookr retro-verify status`.
    const debt = computeCiBlindDebt([], { now: now() });
    return { depth: 0, debt };
  }
}

/**
 * Split a `type:scope` blocker key on its first `:`. The env-blocker registry
 * forbids `:` in either field, so the first colon is the unambiguous delimiter.
 * Returns null when the key is malformed (no colon / empty half).
 */
export function parseBlockerKey(key: string): { type: string; scope: string } | null {
  const idx = key.indexOf(':');
  if (idx <= 0 || idx >= key.length - 1) return null;
  return { type: key.slice(0, idx), scope: key.slice(idx + 1) };
}

/**
 * Resolve whether the given blocker already has a tolerance regime (#1702).
 * Reads the env-blocker registry from `kookrDir`; a missing/unreadable registry
 * or an unknown blocker means "no regime" (fail-open, same posture as the other
 * live-signal reads in this CLI).
 */
async function loadToleranceRegimeActive(
  blockerKey: string,
  kookrDir: string,
  inject?: EmissionCliIo['readToleranceRegime'],
): Promise<boolean> {
  if (inject) return inject(blockerKey);
  const parsed = parseBlockerKey(blockerKey);
  if (!parsed) return false;
  try {
    const registry = new EnvironmentBlockerRegistry(kookrDir);
    await registry.load();
    return registry.hasRegime(parsed.type, parsed.scope);
  } catch {
    return false;
  }
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

  // Keep the implicit state root aligned with the server's per-port namespace.
  // An explicit --kookr-dir remains authoritative; this only replaces the
  // parser's default ~/.kookr when the caller did not choose a path.
  if (!args.kookrDirExplicit) {
    args.kookrDir = resolveKookrDataDir(env);
  }

  try {
    if (args.verb === 'plan') {
      const repo = requireRepo(args.repo);
      if (args.requested === null) throw new EmissionUsageError('--requested is required for plan');
      const zeroDrainIssueLimit = readConfiguredZeroDrainIssueLimit(repo, args.kookrDir, env);
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
      const since = utcDayKeyDaysAgo(args.drainWindow, now());
      try {
        drainCount = searchTotalCount(
          runGh,
          `repo:${repo} is:issue is:closed closed:>=${since}`,
        );
      } catch (error) {
        throw new Error(
          `drain count unavailable; refusing to plan issue emission (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      // ci_blind_debt / retro-verify coupling (#1703): read the durable queue
      // and withhold feature emissions while depth exceeds the threshold so
      // verification drains before new inventory.
      let retroVerifyDepth: number | undefined;
      let ciBlindDebt: CiBlindDebt | undefined;
      let burstDrainFirst = false;
      if (args.retroVerifyCoupling) {
        const loaded = await loadCiBlindDebt(args, env, now, io.readRetroVerifyDepth);
        retroVerifyDepth = loaded.depth;
        ciBlindDebt = loaded.debt;
        burstDrainFirst = shouldBurstDrainBeforeEmission({
          retroVerifyDepth: loaded.depth,
          retroVerifyDepthThreshold: args.retroVerifyDepthThreshold,
        });
      }
      // Tolerance-machinery cap (#1702): when this run's candidates tolerate a
      // blocker that already has a regime, the budget is forced to 0.
      let toleranceRegimeActive: boolean | undefined;
      if (args.toleranceBlocker) {
        toleranceRegimeActive = await loadToleranceRegimeActive(
          args.toleranceBlocker,
          args.kookrDir,
          io.readToleranceRegime,
        );
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
              drainFloorBudget: zeroDrainIssueLimit,
            }
          : {}),
        ...(retroVerifyDepth !== undefined
          ? {
              retroVerifyDepth,
              retroVerifyDepthThreshold: args.retroVerifyDepthThreshold,
            }
          : {}),
        ...(toleranceRegimeActive !== undefined
          ? {
              toleranceRegimeActive,
              toleranceRegimeBlockerKey: args.toleranceBlocker!,
            }
          : {}),
      });
      const payload = {
        ok: true,
        repo,
        zeroDrainIssueLimit,
        plan,
        ...(ciBlindDebt
          ? {
              ciBlindDebt,
              ci_blind_debt: ciBlindDebt,
              burstDrainFirst,
            }
          : {}),
        openIssueSample: openIssues.slice(0, 5).map((i) => ({ number: i.number, title: i.title })),
        note:
          plan.toleranceRegimeBlocked
            ? `tolerance-regime gate: ${plan.toleranceRegimeBlockerKey ?? 'blocker'} already has a tolerance regime; refusing new tolerance machinery. Escalate the blocker to a human instead (#1702).`
            : plan.retroVerifyWithheld
            ? `ci_blind_debt gate: retro-verify depth ${plan.retroVerifyDepth} > threshold ${plan.retroVerifyDepthThreshold}; run \`kookr retro-verify drain\` before new feature emissions.`
            : plan.deferredCount > 0
              ? `With allowedBudget=${plan.allowedBudget}, ${plan.deferredCount} of the requested filings must be deferred/redirected.`
              : undefined,
      };
      if (args.json) {
        out.log(JSON.stringify(payload));
      } else {
        printPlanHuman(out, plan);
        if (ciBlindDebt) out.log(formatCiBlindDebtLogLine(ciBlindDebt));
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
      let retroVerifyDepth: number | undefined;
      let ciBlindDebt: CiBlindDebt | undefined;
      if (args.retroVerifyCoupling) {
        const loaded = await loadCiBlindDebt(args, env, now, io.readRetroVerifyDepth);
        retroVerifyDepth = loaded.depth;
        ciBlindDebt = loaded.debt;
      }
      const plan = resolveEmissionBudget({
        openBacklogCount,
        requestedBudget: 10,
        openBacklogThreshold: args.threshold,
        constrainedBudget: args.constrained,
        ...(retroVerifyDepth !== undefined
          ? {
              retroVerifyDepth,
              retroVerifyDepthThreshold: args.retroVerifyDepthThreshold,
            }
          : {}),
      });
      const payload: {
        ok: true;
        repo: string;
        openBacklogCount: number;
        since: string;
        ciBlindDebt?: CiBlindDebt;
        /** snake_case alias for daily-report consumers (issue #1703). */
        ci_blind_debt?: CiBlindDebt;
      } & NetBacklogDelta7d & {
          emissionBudgetIfRequested10: EmissionBudgetPlan;
        } = {
        ok: true,
        repo,
        openBacklogCount,
        since,
        ...delta,
        emissionBudgetIfRequested10: plan,
        ...(ciBlindDebt ? { ciBlindDebt, ci_blind_debt: ciBlindDebt } : {}),
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
        if (ciBlindDebt) out.log(formatCiBlindDebtLogLine(ciBlindDebt));
        out.log(
          `emissionBudget(if requested=10): allowed=${plan.allowedBudget} action=${plan.action}` +
            (plan.retroVerifyWithheld ? ' retroVerifyWithheld=true' : ''),
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
