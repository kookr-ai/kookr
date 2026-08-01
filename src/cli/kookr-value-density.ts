/**
 * `kookr value-density` — cap cosmetic-refactor emission/spawn + composition
 * metrics (issue #1846).
 *
 *   kookr value-density classify     --title "..." [--labels a,b] [--json]
 *   kookr value-density admit        --title "..." --refactor-count N [OPTIONS]
 *   kookr value-density composition  --repo owner/repo [--window-hours N] [--json]
 *   kookr value-density decline      --repo owner/repo --title "..." --source <pb> --reason "..."
 *
 * Playbooks (architecture-health-check, orchestrators, idea-scout) call admit
 * before filing/spawning refactor-class work, and composition from the daily
 * reflection / velocity probe. Pure math lives in core/value-density-governor.ts;
 * this CLI shells out to `gh` for live merged-PR titles and appends the
 * declined-ideas JSONL the next reflection reads.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_MAX_REFACTOR_PER_WINDOW,
  DEFAULT_MIN_DRIFT_SCORE_DELTA,
  DEFAULT_VALUE_ADVANCING_TARGET_PER_DAY,
  DEFAULT_WINDOW_HOURS,
  VALUE_DENSITY_SCHEMA,
  buildDeclineRecord,
  classifyWorkItem,
  compositionSnapshotPath,
  computeComposition,
  declinedIdeasPath,
  evaluateAdmission,
  formatCompositionLine,
  type DeclineReasonCode,
  type WorkClass,
  type WorkItemInput,
} from '../core/value-density-governor.js';

export const USAGE = `kookr value-density — refactor-class emission/spawn governor + composition (#1846).

Usage:
  kookr value-density classify     --title <text> [OPTIONS]
  kookr value-density admit        --title <text> --refactor-count <N> [OPTIONS]
  kookr value-density composition  --repo <owner/repo> [OPTIONS]
  kookr value-density decline      --repo <owner/repo> --title <text> --source <name> --reason <text> [OPTIONS]

classify     Map a title/labels to workClass + cosmetic + product-metric flags.
admit        Decide admit/decline for one candidate given the window's
             refactor-class admit count. Logs nothing; pair with decline to
             record a sub-threshold consolidation.
composition  Classify merged PRs over the window; print refactor share +
             value-advancing count. Appends one JSONL row per call by default.
decline      Append a declined candidate to the durable ledger the next
             reflection reads (~/.kookr/playbook-state/value-density/declined/).

Options:
  --title <text>              Candidate / PR title (classify, admit, decline).
  --labels <a,b,c>            Comma-separated label names.
  --body <text>               Optional body snippet (cosmetic heuristics).
  --drift-score-delta <N>     Claimed drift-score improvement (admit).
  --refactor-count <N>        Refactor-class admits already in the window (admit).
  --max-refactor <N>          Cap per window (default ${DEFAULT_MAX_REFACTOR_PER_WINDOW}).
  --min-drift-delta <N>       Cosmetic floor (default ${DEFAULT_MIN_DRIFT_SCORE_DELTA}).
  --repo <owner/repo>         Target GitHub repository (composition, decline).
  --window-hours <N>          Lookback window (composition; default ${DEFAULT_WINDOW_HOURS}).
  --value-target <N>          Value-advancing PRs/day target (default ${DEFAULT_VALUE_ADVANCING_TARGET_PER_DAY}).
  --source <name>             Emitting playbook id (decline).
  --reason <text>             Decline reason (decline; default from reason-code).
  --reason-code <code>        cosmetic_subthreshold | refactor_cap_reached |
                              drift_score_below_min | not_applicable.
  --work-class <class>        Override workClass on decline records.
  --kookr-dir <PATH>          State root (default ~/.kookr).
  --no-persist                Skip composition JSONL write.
  --json                      Machine-readable envelope on stdout.
  -h, --help                  Show this help.

Environment:
  GH_TOKEN / gh auth          Required for composition (live merged-PR titles).

Exit codes:
  0  Success (admit prints action=admit|decline; decline is always 0 on write).
  2  User error (bad flags).
  4  GitHub query failed (composition).
`;

export interface ValueDensityCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  now?: () => Date;
  runGh?: (args: string[]) => string;
  appendLine?: (path: string, line: string) => void;
}

interface ParsedArgs {
  verb: string | null;
  title: string | null;
  labels: string[];
  body: string | null;
  driftScoreDelta: number | null;
  refactorCount: number | null;
  maxRefactor: number;
  minDriftDelta: number;
  repo: string | null;
  windowHours: number;
  valueTarget: number;
  source: string | null;
  reason: string | null;
  reasonCode: string | null;
  workClass: string | null;
  kookrDir: string;
  persist: boolean;
  json: boolean;
  help: boolean;
}

export class ValueDensityUsageError extends Error {}

export function parseValueDensityArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    verb: null,
    title: null,
    labels: [],
    body: null,
    driftScoreDelta: null,
    refactorCount: null,
    maxRefactor: DEFAULT_MAX_REFACTOR_PER_WINDOW,
    minDriftDelta: DEFAULT_MIN_DRIFT_SCORE_DELTA,
    repo: null,
    windowHours: DEFAULT_WINDOW_HOURS,
    valueTarget: DEFAULT_VALUE_ADVANCING_TARGET_PER_DAY,
    source: null,
    reason: null,
    reasonCode: null,
    workClass: null,
    kookrDir: `${homedir()}/.kookr`,
    persist: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const eat = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new ValueDensityUsageError(`option ${tok} requires a value`);
      return v;
    };
    const eatNum = (label: string): number => {
      const raw = eat();
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new ValueDensityUsageError(`${label} must be a number (got ${raw})`);
      }
      return n;
    };

    if (tok === '-h' || tok === '--help' || tok === 'help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--no-persist') {
      out.persist = false;
    } else if (tok === '--title' || tok.startsWith('--title=')) {
      out.title = tok.includes('=') ? tok.slice('--title='.length) : eat();
    } else if (tok === '--labels' || tok.startsWith('--labels=')) {
      const raw = tok.includes('=') ? tok.slice('--labels='.length) : eat();
      out.labels = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (tok === '--body' || tok.startsWith('--body=')) {
      out.body = tok.includes('=') ? tok.slice('--body='.length) : eat();
    } else if (tok === '--drift-score-delta' || tok.startsWith('--drift-score-delta=')) {
      out.driftScoreDelta = tok.includes('=')
        ? Number(tok.slice('--drift-score-delta='.length))
        : eatNum('--drift-score-delta');
      if (!Number.isFinite(out.driftScoreDelta)) {
        throw new ValueDensityUsageError('--drift-score-delta must be a number');
      }
    } else if (tok === '--refactor-count' || tok.startsWith('--refactor-count=')) {
      out.refactorCount = tok.includes('=')
        ? Number(tok.slice('--refactor-count='.length))
        : eatNum('--refactor-count');
      if (!Number.isFinite(out.refactorCount) || out.refactorCount! < 0) {
        throw new ValueDensityUsageError('--refactor-count must be a non-negative number');
      }
    } else if (tok === '--max-refactor' || tok.startsWith('--max-refactor=')) {
      out.maxRefactor = tok.includes('=')
        ? Number(tok.slice('--max-refactor='.length))
        : eatNum('--max-refactor');
      if (!Number.isFinite(out.maxRefactor) || out.maxRefactor < 0) {
        throw new ValueDensityUsageError('--max-refactor must be a non-negative number');
      }
    } else if (tok === '--min-drift-delta' || tok.startsWith('--min-drift-delta=')) {
      out.minDriftDelta = tok.includes('=')
        ? Number(tok.slice('--min-drift-delta='.length))
        : eatNum('--min-drift-delta');
      if (!Number.isFinite(out.minDriftDelta)) {
        throw new ValueDensityUsageError('--min-drift-delta must be a number');
      }
    } else if (tok === '--repo' || tok.startsWith('--repo=')) {
      out.repo = tok.includes('=') ? tok.slice('--repo='.length) : eat();
    } else if (tok === '--window-hours' || tok.startsWith('--window-hours=')) {
      out.windowHours = tok.includes('=')
        ? Number(tok.slice('--window-hours='.length))
        : eatNum('--window-hours');
      if (!Number.isFinite(out.windowHours) || out.windowHours <= 0) {
        throw new ValueDensityUsageError('--window-hours must be a positive number');
      }
    } else if (tok === '--value-target' || tok.startsWith('--value-target=')) {
      out.valueTarget = tok.includes('=')
        ? Number(tok.slice('--value-target='.length))
        : eatNum('--value-target');
      if (!Number.isFinite(out.valueTarget) || out.valueTarget < 0) {
        throw new ValueDensityUsageError('--value-target must be a non-negative number');
      }
    } else if (tok === '--source' || tok.startsWith('--source=')) {
      out.source = tok.includes('=') ? tok.slice('--source='.length) : eat();
    } else if (tok === '--reason' || tok.startsWith('--reason=')) {
      out.reason = tok.includes('=') ? tok.slice('--reason='.length) : eat();
    } else if (tok === '--reason-code' || tok.startsWith('--reason-code=')) {
      out.reasonCode = tok.includes('=') ? tok.slice('--reason-code='.length) : eat();
    } else if (tok === '--work-class' || tok.startsWith('--work-class=')) {
      out.workClass = tok.includes('=') ? tok.slice('--work-class='.length) : eat();
    } else if (tok === '--kookr-dir' || tok.startsWith('--kookr-dir=')) {
      out.kookrDir = tok.includes('=') ? tok.slice('--kookr-dir='.length) : eat();
    } else if (tok.startsWith('-')) {
      throw new ValueDensityUsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else {
      throw new ValueDensityUsageError(`unexpected argument: ${tok}`);
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

function requireRepo(repo: string | null): string {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ValueDensityUsageError('--repo must be owner/repo');
  }
  return repo;
}

function requireTitle(title: string | null): string {
  if (!title || !title.trim()) throw new ValueDensityUsageError('--title is required');
  return title;
}

function itemFromArgs(args: ParsedArgs): WorkItemInput {
  return {
    title: requireTitle(args.title),
    labels: args.labels,
    body: args.body,
    driftScoreDelta: args.driftScoreDelta,
  };
}

function emit(
  args: ParsedArgs,
  out: { log: (...args: unknown[]) => void },
  payload: Record<string, unknown>,
  textLine: string,
): void {
  if (args.json) {
    out.log(JSON.stringify({ ok: true, schemaVersion: VALUE_DENSITY_SCHEMA, ...payload }));
  } else {
    out.log(textLine);
  }
}

/** Fetch merged PR titles (+ labels) in the window via `gh pr list --search`. */
export function listMergedPrsInWindow(
  runGh: (args: string[]) => string,
  repo: string,
  sinceIsoDay: string,
): WorkItemInput[] {
  const raw = runGh([
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceIsoDay}`,
    '--limit',
    '200',
    '--json',
    'title,labels',
  ]);
  const parsed = JSON.parse(raw || '[]') as Array<{
    title?: string;
    labels?: Array<{ name?: string } | string>;
  }>;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((pr) => {
    const labels = (pr.labels ?? []).map((l) =>
      typeof l === 'string' ? l : String(l?.name ?? ''),
    );
    return { title: String(pr.title ?? ''), labels };
  });
}

export async function runValueDensityCli(
  argv: string[],
  io: ValueDensityCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());
  const runGh = io.runGh ?? ((args: string[]) => defaultRunGh(args, env));
  const appendLine =
    io.appendLine ??
    ((path: string, line: string) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    });

  let args: ParsedArgs;
  try {
    args = parseValueDensityArgs(argv);
  } catch (e) {
    err.error(`[kookr value-density] ${e instanceof Error ? e.message : String(e)}`);
    err.error('Run `kookr value-density --help` for usage.');
    return 2;
  }

  if (args.help || args.verb === null) {
    out.log(USAGE);
    return 0;
  }

  try {
    if (args.verb === 'classify') {
      const item = itemFromArgs(args);
      const classification = classifyWorkItem(item, {
        minDriftScoreDelta: args.minDriftDelta,
        maxRefactorPerWindow: args.maxRefactor,
      });
      emit(
        args,
        out,
        { classification, title: item.title, labels: item.labels },
        [
          `workClass=${classification.workClass}`,
          `cosmetic=${classification.cosmetic}`,
          `refactorClass=${classification.refactorClass}`,
          `productMetricBlocking=${classification.productMetricBlocking}`,
          `valueAdvancing=${classification.valueAdvancing}`,
        ].join(' '),
      );
      return 0;
    }

    if (args.verb === 'admit') {
      const item = itemFromArgs(args);
      if (args.refactorCount === null) {
        throw new ValueDensityUsageError('--refactor-count is required for admit');
      }
      const verdict = evaluateAdmission(
        item,
        { refactorAdmitted: args.refactorCount },
        {
          maxRefactorPerWindow: args.maxRefactor,
          minDriftScoreDelta: args.minDriftDelta,
        },
      );
      emit(
        args,
        out,
        { verdict },
        [
          `action=${verdict.action}`,
          `reasonCode=${verdict.reasonCode}`,
          `workClass=${verdict.classification.workClass}`,
          `cosmetic=${verdict.classification.cosmetic}`,
          `remaining=${verdict.window.remainingRefactorBudget}`,
          `reason=${verdict.reason}`,
        ].join(' '),
      );
      return 0;
    }

    if (args.verb === 'composition') {
      const repo = requireRepo(args.repo);
      const since = new Date(now().getTime() - args.windowHours * 3_600_000)
        .toISOString()
        .slice(0, 10);
      let items: WorkItemInput[];
      try {
        items = listMergedPrsInWindow(runGh, repo, since);
      } catch (e) {
        err.error(
          `[kookr value-density] GitHub query failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 4;
      }
      const report = computeComposition(items, {
        windowHours: args.windowHours,
        valueAdvancingTargetPerDay: args.valueTarget,
        config: {
          maxRefactorPerWindow: args.maxRefactor,
          minDriftScoreDelta: args.minDriftDelta,
        },
      });
      const line = formatCompositionLine(report, repo);
      if (args.persist) {
        const path = compositionSnapshotPath(repo, args.kookrDir);
        const row = {
          ...report,
          repo,
          ts: now().toISOString(),
          date: now().toISOString().slice(0, 10),
          line,
        };
        appendLine(path, JSON.stringify(row));
      }
      emit(args, out, { report, repo, line }, line);
      return 0;
    }

    if (args.verb === 'decline') {
      const repo = requireRepo(args.repo);
      const title = requireTitle(args.title);
      if (!args.source || !args.source.trim()) {
        throw new ValueDensityUsageError('--source is required for decline');
      }
      const classification = classifyWorkItem({
        title,
        labels: args.labels,
        body: args.body,
        driftScoreDelta: args.driftScoreDelta,
      });
      const reasonCode = (args.reasonCode ??
        'cosmetic_subthreshold') as DeclineReasonCode | string;
      const reason = args.reason ?? `declined: ${reasonCode}`;
      const workClass = (args.workClass as WorkClass | null) ?? classification.workClass;
      const record = buildDeclineRecord({
        repo,
        title,
        source: args.source,
        reasonCode,
        reason,
        workClass,
        cosmetic: classification.cosmetic,
        productMetricBlocking: classification.productMetricBlocking,
        driftScoreDelta: args.driftScoreDelta,
        bodyPreview: args.body,
        now: now(),
      });
      const path = declinedIdeasPath(repo, args.kookrDir);
      appendLine(path, JSON.stringify(record));
      emit(
        args,
        out,
        { record, path },
        `declined ${repo}: ${title} (${reasonCode}) → ${path}`,
      );
      return 0;
    }

    throw new ValueDensityUsageError(
      `unknown verb: ${args.verb} (expected classify|admit|composition|decline)`,
    );
  } catch (e) {
    if (e instanceof ValueDensityUsageError) {
      err.error(`[kookr value-density] ${e.message}`);
      err.error('Run `kookr value-density --help` for usage.');
      return 2;
    }
    err.error(
      `[kookr value-density] ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
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
  const code = await runValueDensityCli(opts.argv ?? process.argv.slice(2), {
    env: opts.env,
    out: opts.out,
    err: opts.err,
  });
  (opts.exit ?? process.exit)(code);
}
