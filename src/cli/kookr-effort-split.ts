/**
 * `kookr effort-split` — lucy vs kookr output share vs the 80/20 target (#1718).
 *
 * Gathers non-merge commits, merged PRs, and lines changed from `gh` (never the
 * contribution ledger), prints the daily-report section, and persists one
 * JSONL row/day under `~/.kookr/effort-split.jsonl` (same-day re-run overwrites).
 *
 *   kookr effort-split [--json] [--window-hours N] [--repo owner/name]...
 *   kookr effort-split --no-persist
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  computeEffortSplit,
  defaultEffortSplitPath,
  formatEffortSplitSection,
  persistEffortSplit,
  thresholdsFromEnv,
  DEFAULT_PRIMARY_REPO,
  DEFAULT_SECONDARY_REPO,
  DEFAULT_WINDOW_HOURS,
  type EffortSplitReport,
  type EffortSplitThresholds,
} from '../core/effort-split.js';
import {
  DEFAULT_EFFORT_REPOS,
  defaultGhRunner,
  gatherAllRepoEffortMetrics,
  type GhRunner,
} from '../core/effort-split-gh.js';

export const USAGE = `kookr effort-split — repo output share vs the 80/20 target (#1718).

Usage:
  kookr effort-split [OPTIONS]

Gathers non-merge commits, merged PRs, and lines changed from \`gh\` for the
configured repos (default jeanibarz/lucy + kookr-ai/kookr), prints the
"Effort split vs 80/20" daily-report section, and persists one JSONL row per
UTC day to ~/.kookr/effort-split.jsonl (same-day re-run overwrites).

Does NOT read the contribution ledger.

Options:
  --repo <owner/name>     Repo to include (repeatable; default lucy + kookr)
  --window-hours <N>      Lookback window (default ${DEFAULT_WINDOW_HOURS})
  --primary <owner/name>  Primary (lucy-side) repo id (default ${DEFAULT_PRIMARY_REPO})
  --secondary <owner/name>
                          Secondary (kookr-side) repo id used for the share band
                          (default ${DEFAULT_SECONDARY_REPO})
  --kookr-dir <PATH>      State root (default ~/.kookr); JSONL at <dir>/effort-split.jsonl
  --path <PATH>           Override the JSONL path entirely
  --no-persist            Skip JSONL write
  --min-share <N>         Secondary-share floor (0–1 or 0–100; default 5%)
  --max-share <N>         Secondary-share ceiling (0–1 or 0–100; default 35%)
  --date <YYYY-MM-DD>     Force the calendar-day key used for JSONL upsert
  --json                  Machine-readable report on stdout (section on stderr)
  -h, --help              Show this help

Environment:
  KOOKR_EFFORT_SPLIT_MIN / KOOKR_EFFORT_SPLIT_MAX
      Override the secondary-share band (same units as --min-share/--max-share).
  KOOKR_EFFORT_SPLIT_TARGET / KOOKR_EFFORT_SPLIT_DEVIATION_PTS
      Alternative to min/max: target share + allowed deviation points.
  GH_TOKEN / gh auth      Required for live GitHub counts.

Exit codes:
  0  Success (deviations are reported in the section, not as a hard fail).
  2  User error (bad flags).
  4  GitHub query failed.
`;

export interface EffortSplitCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  now?: () => Date;
  runGh?: GhRunner;
}

interface ParsedArgs {
  help: boolean;
  json: boolean;
  persist: boolean;
  windowHours: number;
  repos: string[];
  primary: string;
  secondary: string;
  kookrDir: string;
  path: string | null;
  date: string | null;
  minShare: number | null;
  maxShare: number | null;
}

function parseShareFlag(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1) return Math.min(1, n / 100);
  return n;
}

export function parseEffortSplitArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    json: false,
    persist: true,
    windowHours: DEFAULT_WINDOW_HOURS,
    repos: [],
    primary: DEFAULT_PRIMARY_REPO,
    secondary: DEFAULT_SECONDARY_REPO,
    kookrDir: join(homedir(), '.kookr'),
    path: null,
    date: null,
    minShare: null,
    maxShare: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('-')) {
        throw new UsageError(`missing value for ${a}`);
      }
      return v;
    };
    if (a === '-h' || a === '--help' || a === 'help') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-persist') out.persist = false;
    else if (a === '--window-hours') {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`invalid --window-hours: ${raw}`);
      out.windowHours = n;
    } else if (a.startsWith('--window-hours=')) {
      const raw = a.slice('--window-hours='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`invalid --window-hours: ${raw}`);
      out.windowHours = n;
    } else if (a === '--repo') {
      out.repos.push(next());
    } else if (a.startsWith('--repo=')) {
      out.repos.push(a.slice('--repo='.length));
    } else if (a === '--primary') {
      out.primary = next();
    } else if (a.startsWith('--primary=')) {
      out.primary = a.slice('--primary='.length);
    } else if (a === '--secondary') {
      out.secondary = next();
    } else if (a.startsWith('--secondary=')) {
      out.secondary = a.slice('--secondary='.length);
    } else if (a === '--kookr-dir') {
      out.kookrDir = next();
    } else if (a.startsWith('--kookr-dir=')) {
      out.kookrDir = a.slice('--kookr-dir='.length);
    } else if (a === '--path') {
      out.path = next();
    } else if (a.startsWith('--path=')) {
      out.path = a.slice('--path='.length);
    } else if (a === '--date') {
      out.date = next();
    } else if (a.startsWith('--date=')) {
      out.date = a.slice('--date='.length);
    } else if (a === '--min-share') {
      const v = parseShareFlag(next());
      if (v == null) throw new UsageError('invalid --min-share');
      out.minShare = v;
    } else if (a.startsWith('--min-share=')) {
      const v = parseShareFlag(a.slice('--min-share='.length));
      if (v == null) throw new UsageError('invalid --min-share');
      out.minShare = v;
    } else if (a === '--max-share') {
      const v = parseShareFlag(next());
      if (v == null) throw new UsageError('invalid --max-share');
      out.maxShare = v;
    } else if (a.startsWith('--max-share=')) {
      const v = parseShareFlag(a.slice('--max-share='.length));
      if (v == null) throw new UsageError('invalid --max-share');
      out.maxShare = v;
    } else {
      throw new UsageError(`unknown flag: ${a}`);
    }
  }

  if (out.repos.length === 0) {
    out.repos = [...DEFAULT_EFFORT_REPOS];
  }
  if (out.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    throw new UsageError(`invalid --date (want YYYY-MM-DD): ${out.date}`);
  }
  return out;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function resolveThresholdsFromArgs(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Partial<EffortSplitThresholds> {
  if (args.minShare != null && args.maxShare != null && args.maxShare >= args.minShare) {
    return {
      secondaryTargetShare: Math.round(((args.minShare + args.maxShare) / 2) * 10_000) / 10_000,
      deviationPts: Math.round(((args.maxShare - args.minShare) / 2) * 10_000) / 10_000,
    };
  }
  return thresholdsFromEnv(env);
}

export async function runEffortSplitCli(
  argv: string[],
  io: EffortSplitCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());

  let args: ParsedArgs;
  try {
    args = parseEffortSplitArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.error(`[kookr effort-split] ${msg}`);
    err.error(USAGE);
    return 2;
  }

  if (args.help) {
    out.log(USAGE);
    return 0;
  }

  // Allow KOOKR_DIR-style override via env when --kookr-dir not passed.
  if (args.kookrDir === join(homedir(), '.kookr') && env.KOOKR_DIR) {
    args.kookrDir = env.KOOKR_DIR;
  }

  const until = now();
  const untilIso = until.toISOString();
  const sinceIso = new Date(until.getTime() - args.windowHours * 3_600_000).toISOString();
  const runGh = io.runGh ?? defaultGhRunner();

  let repos;
  try {
    repos = await gatherAllRepoEffortMetrics(args.repos, {
      sinceIso,
      untilIso,
      runGh,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.error(`[kookr effort-split] gh query failed: ${msg}`);
    return 4;
  }

  const report: EffortSplitReport = computeEffortSplit({
    repos,
    now: until,
    windowHours: args.windowHours,
    primaryRepo: args.primary,
    secondaryRepo: args.secondary,
    thresholds: resolveThresholdsFromArgs(args, env),
    date: args.date ?? undefined,
  });

  let persistInfo: { path: string; overwritten: boolean } | null = null;
  if (args.persist) {
    const path = args.path ?? defaultEffortSplitPath(args.kookrDir);
    try {
      persistInfo = await persistEffortSplit(path, report);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err.error(`[kookr effort-split] failed to persist ${path}: ${msg}`);
      return 4;
    }
  }

  const section = formatEffortSplitSection(report);

  if (args.json) {
    out.log(
      JSON.stringify(
        {
          ok: true,
          code: 'OK',
          message: report.deviations.length > 0
            ? `effort split computed with ${report.deviations.length} deviation(s)`
            : 'effort split computed',
          details: {
            report,
            section,
            persisted: persistInfo,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out.log(section);
  if (persistInfo) {
    err.error(
      `[kookr effort-split] ${persistInfo.overwritten ? 'updated' : 'wrote'} ${persistInfo.path}`,
    );
  }
  return 0;
}

export async function main(
  opts: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    out?: { log: (...args: unknown[]) => void };
    err?: { error: (...args: unknown[]) => void };
    exit?: (code: number) => void;
  } = {},
): Promise<void> {
  const exit = opts.exit ?? process.exit;
  const code = await runEffortSplitCli(opts.argv ?? process.argv.slice(2), {
    env: opts.env,
    out: opts.out,
    err: opts.err,
  });
  exit(code);
}
