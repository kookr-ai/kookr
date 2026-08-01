#!/usr/bin/env node
/**
 * independent-verification-lane — clean-checkout execution signal after CI
 * removal (issue #1847).
 *
 * A fresh-context worker that clean-clones a merged SHA, installs from scratch,
 * and runs the full suite in an environment isolated from the authoring task.
 * A red run files an `incident`-labeled issue routed through the close-out gate
 * (#1750/#1802); a green run is recorded so it is not re-run. The lane is
 * additive and **tightening-only**: it can flag / file an incident but can
 * never approve, merge, close, or loosen a gate.
 *
 * Pure decision logic lives in `src/core/independent-verification-lane.ts`;
 * this file performs the clone/install/test I/O and the GitHub calls, behind an
 * injectable {@link LaneDeps} seam so the orchestration is unit-testable with
 * fakes (no real clone / gh calls in tests).
 *
 * Modes (cadence):
 *   --sha <sha>        per-merge: verify one merged SHA (cheap per-merge check)
 *   --sweep            rolling-sweep: walk a bounded window of recent merges,
 *                      file on the first red (default cadence)
 *
 * Usage:
 *   node --import tsx scripts/independent-verification-lane.ts --sweep \
 *     --repo kookr-ai/kookr --limit 5 --suite "pnpm test"
 *   node --import tsx scripts/independent-verification-lane.ts \
 *     --sha <full-sha> --repo kookr-ai/kookr
 *
 * Exit codes:
 *   0  all verified green (or nothing to do)
 *   3  at least one RED — incident filed (or, in --dry-run, would be filed)
 *   4  infra error only (clone/install failed; no red) — retried next tick
 *   1  usage / runtime error
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_SWEEP_LIMIT,
  type IncidentReport,
  type LaneCadence,
  type MergedCommit,
  type SuiteRunResult,
  type VerificationTarget,
  assertTighteningOnlyAction,
  boundSweepLimit,
  buildIncidentReport,
  classifySuiteExit,
  incidentDedupeKey,
  laneActionForRun,
  resolveCadence,
  selectVerificationTargets,
  shortSha,
} from '../src/core/independent-verification-lane.js';

export const EXIT_CODES = Object.freeze({
  ok: 0,
  redFiled: 3,
  infra: 4,
  error: 1,
});

export interface LaneConfig {
  cadence: LaneCadence;
  repo: string;
  repoUrl: string;
  suite: string;
  sha?: string;
  sweepLimit: number;
  /** Sweep stops after the first red (default true — bounded + matches #1847). */
  stopOnFirstRed: boolean;
  dryRun: boolean;
  labels: string[];
  /** Root for temp clones; defaults to the OS temp dir. */
  workRoot?: string;
  json: boolean;
}

/** Injectable I/O seam so orchestration is testable without real clones / gh. */
export interface LaneDeps {
  loadProcessed(): string[];
  saveProcessed(shas: string[]): void;
  listMergedCommits(limit: number): MergedCommit[];
  runSuite(target: VerificationTarget): SuiteRunResult;
  incidentExists(dedupeKey: string): boolean;
  ensureIncidentLabel(label: string): void;
  fileIncident(report: IncidentReport): number | null;
  log(message: string): void;
}

export interface LaneSummary {
  cadence: LaneCadence;
  repo: string;
  suite: string;
  scanned: number;
  green: number;
  red: number;
  error: number;
  incidentsFiled: number;
  incidentsFileFailed: number;
  incidentsSkippedDuplicate: number;
  targets: string[];
  redShas: string[];
  exitCode: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Orchestration (pure of process I/O — all side effects go through deps)
// ---------------------------------------------------------------------------

/** Select the SHAs to verify this tick, from state + (for sweep) merged list. */
export function planTargets(config: LaneConfig, deps: LaneDeps): VerificationTarget[] {
  const processed = deps.loadProcessed();
  if (config.cadence === 'per-merge') {
    return selectVerificationTargets({
      cadence: 'per-merge',
      merged: [],
      targetSha: config.sha,
      alreadyVerified: processed,
    });
  }
  const merged = deps.listMergedCommits(Math.max(config.sweepLimit * 4, config.sweepLimit));
  return selectVerificationTargets({
    cadence: 'rolling-sweep',
    merged,
    alreadyVerified: processed,
    sweepLimit: config.sweepLimit,
  });
}

/** Run the lane end to end. All process/network effects are in `deps`. */
export function executeLane(config: LaneConfig, deps: LaneDeps): LaneSummary {
  const targets = planTargets(config, deps);
  const summary: LaneSummary = {
    cadence: config.cadence,
    repo: config.repo,
    suite: config.suite,
    scanned: 0,
    green: 0,
    red: 0,
    error: 0,
    incidentsFiled: 0,
    incidentsFileFailed: 0,
    incidentsSkippedDuplicate: 0,
    targets: targets.map((t) => t.sha),
    redShas: [],
    exitCode: EXIT_CODES.ok,
    dryRun: config.dryRun,
  };

  if (targets.length === 0) {
    deps.log('independent-verification-lane: no un-verified merges to check');
    return summary;
  }

  if (config.dryRun) {
    deps.log(
      `independent-verification-lane: DRY RUN — would verify ${targets.length} SHA(s): ${targets
        .map((t) => shortSha(t.sha))
        .join(', ')}`,
    );
    // Report the plan without running the suite or filing anything.
    summary.exitCode = EXIT_CODES.ok;
    return summary;
  }

  const processed = new Set(deps.loadProcessed());
  let labelEnsured = false;

  for (const target of targets) {
    summary.scanned += 1;
    deps.log(`independent-verification-lane: verifying ${shortSha(target.sha)} …`);
    const result = deps.runSuite(target);
    const status = result.status;
    const action = assertTighteningOnlyAction(laneActionForRun(status));

    if (status === 'green') {
      summary.green += 1;
      processed.add(target.sha);
      deps.log(`  green (${result.durationMs ?? '?'}ms)`);
      continue;
    }

    if (status === 'error') {
      // Infra flake (clone/install failed before tests ran). Do NOT file a
      // product incident and do NOT record as processed — retry next tick.
      summary.error += 1;
      deps.log(`  infra error: ${result.failedSummary ?? `exit ${result.exitCode}`}`);
      continue;
    }

    // status === 'red' → file an incident (the only remaining action).
    summary.red += 1;
    summary.redShas.push(target.sha);
    const dedupeKey = incidentDedupeKey(target.sha);
    if (deps.incidentExists(dedupeKey)) {
      summary.incidentsSkippedDuplicate += 1;
      processed.add(target.sha);
      deps.log(`  RED — incident already open for ${dedupeKey}; skipping duplicate`);
    } else {
      const report = buildIncidentReport({
        sha: target.sha,
        prNumber: target.prNumber,
        subject: target.subject,
        mergedAt: target.mergedAt,
        repo: config.repo,
        suite: config.suite,
        failedSummary: result.failedSummary,
        logExcerpt: result.logExcerpt,
        labels: config.labels,
      });
      if (action !== 'file-incident') {
        // Defensive: laneActionForRun('red') is 'file-incident'; guard anyway.
        throw new Error(`independent-verification-lane: unexpected action ${action} for red run`);
      }
      if (!labelEnsured) {
        for (const label of config.labels) deps.ensureIncidentLabel(label);
        labelEnsured = true;
      }
      const issueNumber = deps.fileIncident(report);
      if (issueNumber !== null) {
        summary.incidentsFiled += 1;
        // Record as processed ONLY once the incident actually exists, so the
        // red is captured and not re-run.
        processed.add(target.sha);
        deps.log(`  RED — filed incident #${issueNumber}: ${report.title}`);
      } else {
        // Filing failed (transient gh error: auth blip, rate limit, network).
        // Do NOT record as processed — leave the SHA un-verified so it is
        // retried next tick. Never silently swallow a red.
        summary.incidentsFileFailed += 1;
        deps.log(`  RED — incident filing FAILED for ${dedupeKey}; will retry next tick`);
      }
    }

    if (config.stopOnFirstRed) {
      deps.log('independent-verification-lane: stopping sweep at first red');
      break;
    }
  }

  deps.saveProcessed([...processed]);

  if (summary.red > 0) summary.exitCode = EXIT_CODES.redFiled;
  else if (summary.error > 0) summary.exitCode = EXIT_CODES.infra;
  else summary.exitCode = EXIT_CODES.ok;

  return summary;
}

// ---------------------------------------------------------------------------
// Real deps (git / gh / pnpm I/O)
// ---------------------------------------------------------------------------

function stateDir(repo: string): string {
  const safe = repo.replace(/\//g, '_');
  return join(homedir(), '.kookr', 'playbook-state', 'independent-verification-lane', safe);
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
}

/** Extract a trailing `(#1234)` PR number from a squash-merge subject. */
export function extractPrNumber(subject: string | undefined): number | undefined {
  if (!subject) return undefined;
  const m = subject.match(/\(#(\d+)\)\s*$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * A full 40-char hex commit SHA. `git fetch --depth 1 origin <sha>` requires the
 * full SHA (a by-SHA "want" is not resolved from an abbreviation), so per-merge
 * mode must reject short SHAs up front rather than loop on a permanent infra
 * error that never converges.
 */
export function isFullCommitSha(sha: string | undefined | null): boolean {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha.trim());
}

/**
 * True when a suite `spawnSync` result reflects an inability to *run* the suite
 * (shell not spawnable, killed by signal, or command-not-found 127) rather than
 * a genuine test failure. Such runs are classified `error` — the lane must not
 * file a false incident for its own broken invocation.
 */
export function isSuiteInfraFailure(status: number | null, error: unknown): boolean {
  return error != null || status === null || status === 127;
}

const REAL_LOG_TAIL_CHARS = 4_000;

export function createRealDeps(config: LaneConfig): LaneDeps {
  const dir = stateDir(config.repo);
  const processedFile = join(dir, 'processed.json');

  return {
    loadProcessed(): string[] {
      try {
        const raw = JSON.parse(readFileSync(processedFile, 'utf-8')) as unknown;
        if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
        return [];
      } catch {
        return [];
      }
    },

    saveProcessed(shas: string[]): void {
      mkdirSync(dir, { recursive: true });
      // Keep the tail bounded so the state file cannot grow without limit.
      const bounded = shas.slice(-500);
      writeFileSync(processedFile, JSON.stringify(bounded, null, 2));
    },

    listMergedCommits(limit: number): MergedCommit[] {
      const out = gh([
        'api',
        `repos/${config.repo}/commits?sha=main&per_page=${Math.min(limit, 100)}`,
        '--jq',
        '.[] | {sha: .sha, subject: (.commit.message | split("\\n")[0]), mergedAt: .commit.committer.date}',
      ]);
      const commits: MergedCommit[] = [];
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as { sha: string; subject?: string; mergedAt?: string };
          commits.push({
            sha: obj.sha,
            subject: obj.subject,
            mergedAt: obj.mergedAt,
            prNumber: extractPrNumber(obj.subject),
          });
        } catch {
          // skip unparseable line
        }
      }
      return commits;
    },

    runSuite(target: VerificationTarget): SuiteRunResult {
      const workRoot = config.workRoot ?? tmpdir();
      mkdirSync(workRoot, { recursive: true });
      const checkout = mkdtempSync(join(workRoot, `iv-lane-${shortSha(target.sha)}-`));
      const started = Date.now();
      const gitRun = (args: string[]): { code: number; out: string } => {
        const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf-8' });
        return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      };
      try {
        // Fresh, shallow, isolated clone of exactly the merged SHA.
        let phase = gitRun(['init', '-q']);
        if (phase.code === 0) phase = gitRun(['remote', 'add', 'origin', config.repoUrl]);
        if (phase.code === 0) phase = gitRun(['fetch', '--depth', '1', 'origin', target.sha]);
        if (phase.code === 0) phase = gitRun(['checkout', '-q', 'FETCH_HEAD']);
        if (phase.code !== 0) {
          return {
            status: 'error',
            exitCode: phase.code,
            suite: config.suite,
            durationMs: Date.now() - started,
            failedSummary: `clone/fetch failed for ${shortSha(target.sha)}`,
            logExcerpt: phase.out.slice(-REAL_LOG_TAIL_CHARS),
          };
        }

        // Install from scratch (frozen lockfile → reproducible).
        const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
          cwd: checkout,
          encoding: 'utf-8',
          env: { ...process.env, CI: '1' },
          maxBuffer: 64 * 1024 * 1024,
        });
        if ((install.status ?? 1) !== 0) {
          return {
            status: 'error',
            exitCode: install.status ?? 1,
            suite: config.suite,
            durationMs: Date.now() - started,
            failedSummary: 'pnpm install --frozen-lockfile failed',
            logExcerpt: `${install.stdout ?? ''}${install.stderr ?? ''}`.slice(-REAL_LOG_TAIL_CHARS),
          };
        }

        // Run the full suite. `suite` is operator-controlled config, so a shell
        // is acceptable here (it is not untrusted input).
        const run = spawnSync('sh', ['-c', config.suite], {
          cwd: checkout,
          encoding: 'utf-8',
          env: { ...process.env, CI: '1' },
          maxBuffer: 64 * 1024 * 1024,
        });
        const exitCode = run.status ?? 1;
        const combined = `${run.error ? `${String(run.error)}\n` : ''}${run.stdout ?? ''}${run.stderr ?? ''}`;
        const infraError = isSuiteInfraFailure(run.status, run.error);
        const status = classifySuiteExit(exitCode, { infraError });
        return {
          status,
          exitCode,
          suite: config.suite,
          durationMs: Date.now() - started,
          failedSummary:
            status === 'red'
              ? `suite exited ${exitCode} (\`${config.suite}\`)`
              : status === 'error'
                ? `suite could not run (\`${config.suite}\`, exit ${exitCode})`
                : undefined,
          logExcerpt: status !== 'green' ? combined.slice(-REAL_LOG_TAIL_CHARS) : undefined,
        };
      } finally {
        try {
          rmSync(checkout, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    },

    incidentExists(dedupeKey: string): boolean {
      try {
        const out = gh([
          'issue',
          'list',
          '--repo',
          config.repo,
          '--state',
          'all',
          '--search',
          `"${dedupeKey}" in:body`,
          '--limit',
          '5',
          '--json',
          'number',
        ]);
        const arr = JSON.parse(out) as unknown[];
        return Array.isArray(arr) && arr.length > 0;
      } catch {
        // On search failure, assume not-existing but do not crash the tick.
        return false;
      }
    },

    ensureIncidentLabel(label: string): void {
      try {
        gh([
          'label',
          'create',
          label,
          '--repo',
          config.repo,
          '--color',
          'B60205',
          '--description',
          'Independent verification / incident close-out gate',
          '--force',
        ]);
      } catch {
        // Label may already exist or creation may be disallowed; non-fatal.
      }
    },

    fileIncident(report: IncidentReport): number | null {
      const bodyFile = join(dir, `incident-${report.dedupeKey.replace(/[:/]/g, '_')}.md`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(bodyFile, report.body);
      try {
        const labelArgs = report.labels.flatMap((l) => ['--label', l]);
        const url = gh([
          'issue',
          'create',
          '--repo',
          config.repo,
          '--title',
          report.title,
          '--body-file',
          bodyFile,
          ...labelArgs,
        ]).trim();
        const m = url.match(/\/issues\/(\d+)/);
        return m ? Number(m[1]) : null;
      } catch (err) {
        console.error(
          `independent-verification-lane: gh issue create failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    },

    log(message: string): void {
      console.log(message);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`Usage:
  node --import tsx scripts/independent-verification-lane.ts --sweep \\
    [--repo OWNER/NAME] [--limit N] [--suite "pnpm test"] [--all] [--dry-run]
  node --import tsx scripts/independent-verification-lane.ts --sha <sha> \\
    [--repo OWNER/NAME] [--suite "pnpm test"] [--dry-run]

Options:
  --sweep            Rolling-sweep cadence over recent merges (default).
  --sha <sha>        Per-merge cadence: verify exactly this merged SHA.
  --repo OWNER/NAME  Target repo (default: current git remote).
  --repo-url URL     Clone URL (default: https://github.com/<repo>.git).
  --limit N          Max SHAs per sweep (bounded 1..20, default ${DEFAULT_SWEEP_LIMIT}).
  --suite "<cmd>"    Full-suite command (default: "pnpm test").
  --all              Sweep: check every selected SHA (do not stop at first red).
  --labels a,b       Incident labels (default: incident).
  --work-root DIR    Root for temp clones (default: OS temp dir).
  --dry-run          Print the plan; never clone, run, or file.
  --json             Emit the summary as JSON.
  -h, --help         Show this help.

Exit: 0 all green · 3 RED (incident filed) · 4 infra error · 1 usage/runtime`);
  process.exit(EXIT_CODES.error);
}

export function parseArgs(argv: string[]): LaneConfig {
  let cadence: LaneCadence = 'rolling-sweep';
  let repo = '';
  let repoUrl = '';
  let suite = 'pnpm test';
  let sha: string | undefined;
  let sweepLimit = DEFAULT_SWEEP_LIMIT;
  let stopOnFirstRed = true;
  let dryRun = false;
  let labels = ['incident'];
  let workRoot: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--sweep':
        cadence = 'rolling-sweep';
        break;
      case '--sha':
        sha = next();
        cadence = 'per-merge';
        break;
      case '--repo':
        repo = next();
        break;
      case '--repo-url':
        repoUrl = next();
        break;
      case '--limit':
        sweepLimit = boundSweepLimit(Number(next()));
        break;
      case '--suite':
        suite = next();
        break;
      case '--all':
        stopOnFirstRed = false;
        break;
      case '--labels':
        labels = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--work-root':
        workRoot = next();
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        usage();
    }
  }

  cadence = resolveCadence(cadence);

  if (!repo) {
    try {
      repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        encoding: 'utf-8',
      }).trim();
    } catch {
      console.error('independent-verification-lane: --repo is required (could not infer from gh)');
      usage();
    }
  }
  if (!repoUrl) repoUrl = `https://github.com/${repo}.git`;
  if (cadence === 'per-merge') {
    if (!sha) {
      console.error('independent-verification-lane: --sha is required for per-merge cadence');
      usage();
    } else if (!isFullCommitSha(sha)) {
      console.error(
        'independent-verification-lane: --sha must be a full 40-char commit SHA (git fetch-by-SHA requires it)',
      );
      usage();
    }
  }
  if (labels.length === 0) labels = ['incident'];

  return {
    cadence,
    repo,
    repoUrl,
    suite,
    sha,
    sweepLimit,
    stopOnFirstRed,
    dryRun,
    labels,
    workRoot,
    json,
  };
}

async function main(argv: string[]): Promise<number> {
  const config = parseArgs(argv);
  const deps = createRealDeps(config);
  const summary = executeLane(config, deps);

  if (config.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `independent-verification-lane: repo=${summary.repo} cadence=${summary.cadence}` +
        ` scanned=${summary.scanned} green=${summary.green} red=${summary.red}` +
        ` error=${summary.error} incidents=${summary.incidentsFiled}` +
        (summary.incidentsFileFailed ? ` fileFailed=${summary.incidentsFileFailed}` : '') +
        (summary.incidentsSkippedDuplicate ? ` dupSkipped=${summary.incidentsSkippedDuplicate}` : '') +
        (summary.dryRun ? ' (dry-run)' : ''),
    );
  }
  return summary.exitCode;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(
        `independent-verification-lane: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT_CODES.error);
    });
}
