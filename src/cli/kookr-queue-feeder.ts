/**
 * `kookr queue-feeder` — auto-decompose product umbrellas into spawnable leaves
 * when capacity idles (issue #1845), with invent-product-wave when the product
 * belt is empty and open umbrella children are all closed (#2069), and a
 * secondary path for open idea-scout / ready issues (#2044).
 *
 *   kookr queue-feeder plan --input <file|-> [--free N] [--pending N] [--emit] [--json]
 *   kookr queue-feeder leaves --umbrella owner/repo#N [--json]
 *
 * The orchestration loop / velocity probe calls `plan` when it sees the
 * `idle_capacity` warn (free≥3, pendingQueueDepth==0). It hands a JSON snapshot
 * of the current capacity ledger + candidate umbrellas (+ optional readyIssues);
 * the CLI runs the pure decision (core/umbrella-decomposer.ts), prints which
 * umbrella it would shred / invent under or which ready issues to enqueue, and
 * appends a dry-run observability row the next reflection reads. `--emit`
 * (opt-in, default OFF) files leaf issues via `gh issue create` for shred
 * actions; invent-product-wave authorizes the playbook to author leaves (CLI
 * does not invent content); secondary ready-issue emit never auto-creates or
 * auto-claims assigned work.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_FREE_SLOTS_THRESHOLD,
  QUEUE_FEEDER_SCHEMA,
  buildLeafIssueBody,
  buildQueueFeederRecord,
  curatedLeafPlan,
  evaluateQueueFeeder,
  formatQueueFeederLine,
  normalizeLeafPlan,
  queueFeederLedgerPath,
  type CapacitySignal,
  type LeafSpec,
  type QueueFeederDecision,
  type ReadyIssue,
  type UmbrellaCandidate,
} from '../core/umbrella-decomposer.js';

export const USAGE = `kookr queue-feeder — auto-decompose product umbrellas into spawnable leaves (#1845/#2044/#2069).

Usage:
  kookr queue-feeder plan --input <file|-> [OPTIONS]
  kookr queue-feeder leaves --umbrella <owner/repo#N> [--json]

plan          Read a capacity + umbrella snapshot, decide which ONE umbrella to
              shred into 3–5 leaves, invent-product-wave (1–3 next product leaves
              when openPM=0 and open children are 0 — #2069), or secondary-emit
              ready issues when product leaves are empty (#2044). Print the
              dry-run plan. Appends an observability row to the queue-feeder
              ledger by default.
leaves        Print the rendered GitHub issue bodies for a curated umbrella's
              leaf plan (goal + acceptance criteria + hints + backref).

Input JSON (plan), from --input <file> or '-' for stdin:
  {
    "capacity":   { "free": 5, "pendingQueueDepth": 0 },
    "candidates": [
      { "repo": "owner/repo", "number": 1588, "title": "...",
        "labels": ["sec-anchor"], "openChildrenCount": 0 }
    ],
    "readyIssues": [
      { "repo": "owner/repo", "number": 2032, "title": "...",
        "labels": ["idea-scout"], "assignees": [] }
    ],
    "openProductMetricIssues": 0
  }

Options:
  --input <file|->        Snapshot JSON path, or '-' for stdin (plan).
  --free <N>              Override capacity.free from the snapshot (plan).
  --pending <N>           Override capacity.pendingQueueDepth (plan).
  --free-threshold <N>    Idle-capacity gate (default ${DEFAULT_FREE_SLOTS_THRESHOLD}).
  --umbrella <ref>        owner/repo#N for leaves.
  --emit                  Actually file leaf issues via 'gh issue create'
                          (opt-in; default OFF — dry-run only).
  --kookr-dir <PATH>      State root (default ~/.kookr).
  --no-persist            Skip the observability ledger write.
  --json                  Machine-readable envelope on stdout.
  -h, --help              Show this help.

Exit codes:
  0  Success (plan prints the decision; a triggered run with a selected umbrella
     still exits 0 whether or not it emitted).
  2  User error (bad flags / unparseable input).
  4  gh issue create failed during --emit.
`;

export interface QueueFeederCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  now?: () => Date;
  runGh?: (args: string[]) => string;
  readInput?: (path: string | null) => string;
  appendLine?: (path: string, line: string) => void;
}

interface ParsedArgs {
  verb: string | null;
  input: string | null;
  free: number | null;
  pending: number | null;
  freeThreshold: number;
  umbrella: string | null;
  emit: boolean;
  kookrDir: string;
  persist: boolean;
  json: boolean;
  help: boolean;
}

export class QueueFeederUsageError extends Error {}

export function parseQueueFeederArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    verb: null,
    input: null,
    free: null,
    pending: null,
    freeThreshold: DEFAULT_FREE_SLOTS_THRESHOLD,
    umbrella: null,
    emit: false,
    kookrDir: `${homedir()}/.kookr`,
    persist: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const eat = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new QueueFeederUsageError(`option ${tok} requires a value`);
      return v;
    };
    const eatNum = (label: string): number => {
      const raw = eat();
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new QueueFeederUsageError(`${label} must be a number (got ${raw})`);
      }
      return n;
    };
    const valueOf = (prefix: string): string => (tok.includes('=') ? tok.slice(prefix.length) : eat());

    if (tok === '-h' || tok === '--help' || tok === 'help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--emit') {
      out.emit = true;
    } else if (tok === '--no-persist') {
      out.persist = false;
    } else if (tok === '--input' || tok.startsWith('--input=')) {
      out.input = valueOf('--input=');
    } else if (tok === '--umbrella' || tok.startsWith('--umbrella=')) {
      out.umbrella = valueOf('--umbrella=');
    } else if (tok === '--kookr-dir' || tok.startsWith('--kookr-dir=')) {
      out.kookrDir = valueOf('--kookr-dir=');
    } else if (tok === '--free' || tok.startsWith('--free=')) {
      out.free = tok.includes('=') ? Number(tok.slice('--free='.length)) : eatNum('--free');
      if (!Number.isFinite(out.free) || out.free! < 0) {
        throw new QueueFeederUsageError('--free must be a non-negative number');
      }
    } else if (tok === '--pending' || tok.startsWith('--pending=')) {
      out.pending = tok.includes('=') ? Number(tok.slice('--pending='.length)) : eatNum('--pending');
      if (!Number.isFinite(out.pending) || out.pending! < 0) {
        throw new QueueFeederUsageError('--pending must be a non-negative number');
      }
    } else if (tok === '--free-threshold' || tok.startsWith('--free-threshold=')) {
      out.freeThreshold = tok.includes('=')
        ? Number(tok.slice('--free-threshold='.length))
        : eatNum('--free-threshold');
      if (!Number.isFinite(out.freeThreshold) || out.freeThreshold < 1) {
        throw new QueueFeederUsageError('--free-threshold must be a positive number');
      }
    } else if (tok.startsWith('-') && tok !== '-') {
      throw new QueueFeederUsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else {
      throw new QueueFeederUsageError(`unexpected argument: ${tok}`);
    }
  }

  return out;
}

function defaultRunGh(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('gh', args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`gh failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `gh exit ${result.status}`).trim();
    throw new Error(msg);
  }
  return result.stdout ?? '';
}

function defaultReadInput(path: string | null): string {
  // '-' or null → stdin (fd 0); otherwise a file path.
  return readFileSync(path && path !== '-' ? path : 0, 'utf8');
}

interface QueueFeederSnapshot {
  capacity: CapacitySignal;
  candidates: UmbrellaCandidate[];
  readyIssues: ReadyIssue[];
  openProductMetricIssues?: number;
}

function parseReadyIssues(raw: unknown): ReadyIssue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new QueueFeederUsageError('input.readyIssues must be an array when present');
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new QueueFeederUsageError(`readyIssues[${i}] must be an object with { repo, number, title }`);
    }
    const row = c as Record<string, unknown>;
    if (typeof row.repo !== 'string' || typeof row.number !== 'number' || typeof row.title !== 'string') {
      throw new QueueFeederUsageError(`readyIssues[${i}] needs { repo, number, title }`);
    }
    const assignees = Array.isArray(row.assignees)
      ? row.assignees.map((a) => String(a))
      : undefined;
    const state =
      row.state === 'open' || row.state === 'closed' ? (row.state as 'open' | 'closed') : undefined;
    return {
      repo: row.repo,
      number: row.number,
      title: row.title,
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l)) : undefined,
      assignees,
      alreadyEmitted: typeof row.alreadyEmitted === 'boolean' ? row.alreadyEmitted : undefined,
      state,
    };
  });
}

export function parseSnapshot(raw: string): QueueFeederSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new QueueFeederUsageError(`input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new QueueFeederUsageError('input must be a JSON object with capacity + candidates');
  }
  const obj = parsed as Record<string, unknown>;
  const cap = obj.capacity as Record<string, unknown> | undefined;
  if (!cap || typeof cap.free !== 'number' || typeof cap.pendingQueueDepth !== 'number') {
    throw new QueueFeederUsageError('input.capacity must be { free: number, pendingQueueDepth: number }');
  }
  if (!Array.isArray(obj.candidates)) {
    throw new QueueFeederUsageError('input.candidates must be an array');
  }
  const candidates: UmbrellaCandidate[] = obj.candidates.map((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new QueueFeederUsageError(`candidate[${i}] must be an object with { repo, number, title }`);
    }
    const row = c as Record<string, unknown>;
    if (typeof row.repo !== 'string' || typeof row.number !== 'number' || typeof row.title !== 'string') {
      throw new QueueFeederUsageError(`candidate[${i}] needs { repo, number, title }`);
    }
    return {
      repo: row.repo,
      number: row.number,
      title: row.title,
      body: typeof row.body === 'string' ? row.body : null,
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l)) : undefined,
      openChildrenCount: typeof row.openChildrenCount === 'number' ? row.openChildrenCount : 0,
      productMetricBlocking:
        typeof row.productMetricBlocking === 'boolean' ? row.productMetricBlocking : undefined,
      harness: typeof row.harness === 'boolean' ? row.harness : undefined,
      priority: typeof row.priority === 'number' ? row.priority : undefined,
    };
  });
  const openProductMetricIssues =
    typeof obj.openProductMetricIssues === 'number' ? obj.openProductMetricIssues : undefined;
  return {
    capacity: { free: cap.free, pendingQueueDepth: cap.pendingQueueDepth },
    candidates,
    readyIssues: parseReadyIssues(obj.readyIssues),
    openProductMetricIssues,
  };
}

/** File one leaf as a GitHub issue in the umbrella's repo; returns the issue URL. */
function emitLeaf(
  runGh: (args: string[]) => string,
  repo: string,
  leaf: LeafSpec,
  umbrella: string,
): string {
  const body = buildLeafIssueBody(leaf, umbrella);
  const args = ['issue', 'create', '-R', repo, '--title', leaf.title, '--body', body];
  for (const label of leaf.labels ?? []) args.push('--label', label);
  return runGh(args).trim();
}

function emit(
  json: boolean,
  out: { log: (...args: unknown[]) => void },
  payload: Record<string, unknown>,
  textLine: string,
): void {
  if (json) {
    out.log(JSON.stringify({ ok: true, schemaVersion: QUEUE_FEEDER_SCHEMA, ...payload }));
  } else {
    out.log(textLine);
  }
}

function runPlan(
  args: ParsedArgs,
  io: Required<Pick<QueueFeederCliIo, 'out' | 'err' | 'now'>> & {
    runGh: (args: string[]) => string;
    readInput: (path: string | null) => string;
    appendLine: (path: string, line: string) => void;
  },
): number {
  const snapshot = parseSnapshot(io.readInput(args.input));
  const capacity: CapacitySignal = {
    free: args.free ?? snapshot.capacity.free,
    pendingQueueDepth: args.pending ?? snapshot.capacity.pendingQueueDepth,
  };

  const decision: QueueFeederDecision = evaluateQueueFeeder({
    capacity,
    candidates: snapshot.candidates,
    readyIssues: snapshot.readyIssues,
    openProductMetricIssues: snapshot.openProductMetricIssues,
    config: { freeSlotsThreshold: args.freeThreshold },
  });

  const emitted: string[] = [];
  let emitError: string | undefined;
  const dryRun = !args.emit;

  // Primary shred only: create leaf issues for a plan-ready umbrella.
  // Secondary ready-issue emit never creates issues (they already exist) and
  // never auto-claims assignees — the playbook spawns implementers from
  // decision.secondaryEmitted.
  if (
    args.emit &&
    decision.action === 'shred' &&
    decision.selected &&
    !decision.selected.needsAuthoring
  ) {
    // Accumulate created issue URLs as we go so a mid-loop failure still records
    // the issues that were already filed (they are otherwise orphaned — the next
    // run's live openChildrenCount refetch prevents duplicates, but the ledger
    // must show what this run actually created).
    try {
      for (const leaf of decision.selected.leaves) {
        emitted.push(emitLeaf(io.runGh, decision.selected.repo, leaf, decision.selected.ref));
      }
    } catch (e) {
      emitError = e instanceof Error ? e.message : String(e);
    }
  }

  // For secondary idea-scout path, surface selected refs as "emitted" (already
  // open issues handed to the implement set) so the ledger matches agent audit.
  if (decision.action === 'emit-secondary' && decision.actionSource === 'idea-scout') {
    for (const item of decision.secondaryEmitted) {
      emitted.push(item.ref);
    }
  }

  const record = buildQueueFeederRecord(decision, { now: io.now(), dryRun });
  if (args.persist) {
    const path = queueFeederLedgerPath(args.kookrDir);
    io.appendLine(
      path,
      JSON.stringify({
        ...record,
        emitted,
        emitError: emitError ?? null,
        openProductMetricIssues: snapshot.openProductMetricIssues ?? null,
      }),
    );
  }

  if (emitError) {
    io.err.error(`[kookr queue-feeder] gh issue create failed: ${emitError}`);
    return 4;
  }

  const line = formatQueueFeederLine(record);
  emit(args.json, io.out, { decision, record, emitted }, line);
  return 0;
}

function runLeafBodies(args: ParsedArgs, io: Required<Pick<QueueFeederCliIo, 'out'>>): number {
  const ref = (args.umbrella ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(ref)) {
    throw new QueueFeederUsageError('--umbrella must be owner/repo#N');
  }
  const plan = curatedLeafPlan(ref);
  const normalized = normalizeLeafPlan(plan);
  if (!plan || !normalized.ok) {
    throw new QueueFeederUsageError(
      `no vetted leaf plan for ${ref}${normalized.error ? ` (${normalized.error})` : ''}`,
    );
  }
  const bodies = normalized.leaves.map((leaf) => ({
    title: leaf.title,
    labels: leaf.labels ?? [],
    body: buildLeafIssueBody(leaf, ref),
  }));
  if (args.json) {
    io.out.log(JSON.stringify({ ok: true, schemaVersion: QUEUE_FEEDER_SCHEMA, umbrella: ref, bodies }));
  } else {
    for (const b of bodies) {
      io.out.log(`### ${b.title}${b.labels.length ? `  [${b.labels.join(', ')}]` : ''}\n`);
      io.out.log(b.body);
      io.out.log('\n');
    }
  }
  return 0;
}

export async function runQueueFeederCli(argv: string[], io: QueueFeederCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const now = io.now ?? (() => new Date());
  const runGh = io.runGh ?? ((a: string[]) => defaultRunGh(a, env));
  const readInput = io.readInput ?? defaultReadInput;
  const appendLine =
    io.appendLine ??
    ((path: string, line: string) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    });

  let args: ParsedArgs;
  try {
    args = parseQueueFeederArgs(argv);
  } catch (e) {
    err.error(`[kookr queue-feeder] ${e instanceof Error ? e.message : String(e)}`);
    err.error('Run `kookr queue-feeder --help` for usage.');
    return 2;
  }

  if (args.help || args.verb === null) {
    out.log(USAGE);
    return 0;
  }

  try {
    if (args.verb === 'plan') {
      return runPlan(args, { out, err, now, runGh, readInput, appendLine });
    }
    if (args.verb === 'leaves') {
      return runLeafBodies(args, { out });
    }
    throw new QueueFeederUsageError(`unknown verb: ${args.verb} (expected plan|leaves)`);
  } catch (e) {
    if (e instanceof QueueFeederUsageError) {
      err.error(`[kookr queue-feeder] ${e.message}`);
      err.error('Run `kookr queue-feeder --help` for usage.');
      return 2;
    }
    err.error(`[kookr queue-feeder] ${e instanceof Error ? e.message : String(e)}`);
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
  const code = await runQueueFeederCli(opts.argv ?? process.argv.slice(2), {
    env: opts.env,
    out: opts.out,
    err: opts.err,
  });
  (opts.exit ?? process.exit)(code);
}
