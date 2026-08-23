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
  readyIssueRef,
  umbrellaRef,
  type CapacitySignal,
  type LeafSpec,
  type QueueFeederDecision,
  type QueueFeederInput,
  type ReadyIssue,
  type SkippedUmbrella,
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
                          (opt-in; default OFF — dry-run only). Idempotent by
                          title: a leaf whose title already exists as an OPEN or
                          CLOSED issue in the umbrella repo is skipped (the
                          existing ref is reused and recorded in the ledger),
                          so an already-landed leaf is not re-filed (#2120).
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
  /** Override claim-ownership HTTP (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
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

interface QueueFeederClaimOwner {
  taskId: string;
  ownerName?: string;
}

type QueueFeederClaimLookup =
  | { kind: 'unowned' }
  | { kind: 'owned'; owner: QueueFeederClaimOwner }
  | { kind: 'error'; reason: string };

function queueFeederApiBase(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.KOOKR_API_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const portRaw = env.KOOKR_PORT?.trim();
  if (!portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
}

function queueFeederApiHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_API_TOKEN?.trim();
  return {
    'X-Kookr-Launch-Source': 'cli',
    'User-Agent': `kookr-queue-feeder/node-${process.versions.node}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function lookupQueueFeederClaim(
  issue: Pick<ReadyIssue, 'repo' | 'number'>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<QueueFeederClaimLookup> {
  const baseUrl = queueFeederApiBase(env);
  if (!baseUrl) {
    return {
      kind: 'error',
      reason: 'issue-claim lookup unavailable: KOOKR_API_BASE_URL or KOOKR_PORT is not configured',
    };
  }

  let response: Response;
  let raw: string;
  try {
    const url = new URL('/api/issue-claims', `${baseUrl}/`);
    url.searchParams.set('repo', issue.repo);
    url.searchParams.set('number', String(issue.number));
    response = await fetchImpl(url, {
      method: 'GET',
      headers: queueFeederApiHeaders(env),
      signal: AbortSignal.timeout(5_000),
    });
    raw = await response.text();
  } catch (error) {
    return {
      kind: 'error',
      reason: `issue-claim lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return { kind: 'error', reason: `issue-claim lookup returned HTTP ${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'error',
      reason: `issue-claim lookup returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'error', reason: 'issue-claim lookup returned a non-array response' };
  }
  if (parsed.length === 0) return { kind: 'unowned' };
  if (parsed.length !== 1) {
    return { kind: 'error', reason: `issue-claim lookup returned ${parsed.length} owners` };
  }

  const row = parsed[0];
  if (!row || typeof row !== 'object') {
    return { kind: 'error', reason: 'issue-claim lookup returned an invalid owner record' };
  }
  const owner = row as Record<string, unknown>;
  if (typeof owner.taskId !== 'string' || owner.taskId.trim() === '') {
    return { kind: 'error', reason: 'issue-claim lookup returned an owner without task identity' };
  }
  return {
    kind: 'owned',
    owner: {
      taskId: owner.taskId,
      ...(typeof owner.ownerName === 'string' && owner.ownerName.trim()
        ? { ownerName: owner.ownerName }
        : {}),
    },
  };
}

function claimSkipReason(lookup: Extract<QueueFeederClaimLookup, { kind: 'owned' | 'error' }>): string {
  if (lookup.kind === 'owned') {
    const name = lookup.owner.ownerName ? ` (${lookup.owner.ownerName})` : '';
    return `active issue claim owned by task ${lookup.owner.taskId}${name}`;
  }
  return lookup.reason;
}

async function consultReadyIssueClaims(
  issues: readonly ReadyIssue[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<{ readyIssues: ReadyIssue[]; skipped: SkippedUmbrella[] }> {
  const currentTaskId = env.KOOKR_TASK_ID?.trim() || null;
  const readyIssues: ReadyIssue[] = [];
  const skipped: SkippedUmbrella[] = [];

  // Keep this per-candidate and sequential: the lookup is a safety gate, and
  // every candidate must leave an auditable decision even when a sibling wins
  // the claim between two candidates.
  for (const issue of issues) {
    const lookup = await lookupQueueFeederClaim(issue, env, fetchImpl);
    if (lookup.kind === 'unowned') {
      readyIssues.push(issue);
      continue;
    }
    if (lookup.kind === 'owned' && lookup.owner.taskId === currentTaskId) {
      readyIssues.push(issue);
      continue;
    }
    skipped.push({ ref: readyIssueRef(issue), reason: claimSkipReason(lookup) });
  }

  return { readyIssues, skipped };
}

async function recheckSecondaryClaims(
  decision: QueueFeederDecision,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<QueueFeederDecision> {
  if (decision.action !== 'emit-secondary' || decision.actionSource !== 'idea-scout') {
    return decision;
  }

  const currentTaskId = env.KOOKR_TASK_ID?.trim() || null;
  const secondaryEmitted = [] as typeof decision.secondaryEmitted;
  const skipped: SkippedUmbrella[] = [];
  for (const item of decision.secondaryEmitted) {
    const lookup = await lookupQueueFeederClaim(item, env, fetchImpl);
    if (lookup.kind === 'unowned' || (lookup.kind === 'owned' && lookup.owner.taskId === currentTaskId)) {
      secondaryEmitted.push(item);
      continue;
    }
    skipped.push({ ref: item.ref, reason: claimSkipReason(lookup) });
  }

  return {
    ...decision,
    secondaryEmitted,
    leafCount: secondaryEmitted.length,
    skipped: [...decision.skipped, ...skipped],
  };
}

interface QueueFeederSnapshot {
  capacity: CapacitySignal;
  candidates: UmbrellaCandidate[];
  readyIssues: ReadyIssue[];
  openProductMetricIssues?: number;
  /** Drought depth for invent pressure (#2358). */
  consecutiveBlockedEmpty?: number;
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
  const consecutiveBlockedEmpty =
    typeof obj.consecutiveBlockedEmpty === 'number'
    && Number.isFinite(obj.consecutiveBlockedEmpty)
    && obj.consecutiveBlockedEmpty >= 0
      ? Math.floor(obj.consecutiveBlockedEmpty)
      : undefined;
  return {
    capacity: {
      free: cap.free,
      pendingQueueDepth: cap.pendingQueueDepth,
      // Issue #2357: preserve effective free from /api/health snapshots so
      // feeder idle decisions agree with capacityThroughputVerdict.
      ...(typeof cap.freeForGeneralSources === 'number'
        && Number.isFinite(cap.freeForGeneralSources)
        ? { freeForGeneralSources: cap.freeForGeneralSources }
        : {}),
    },
    candidates,
    readyIssues: parseReadyIssues(obj.readyIssues),
    openProductMetricIssues,
    consecutiveBlockedEmpty,
  };
}

/**
 * Query the umbrella repo for an existing issue — open OR closed — whose title
 * exactly matches `title`. Returns its ref (owner/repo#N) when found, else null.
 *
 * Playbook rule (queue-feeder §0): never re-file a leaf title that already
 * exists as an open or closed issue (#2120). We search `in:title` (a fuzzy
 * GitHub match) to narrow the set, then require EXACT title equality so a
 * near-match never suppresses a genuinely new leaf.
 *
 * Failure posture: a gh *process* failure throws → the emit loop catches it →
 * exit 4 (fail closed — we never blind-create when the check could not run). A
 * gh success with an unparseable payload instead fails OPEN (returns null →
 * create), since a malformed `--json` stdout is near-impossible in practice and
 * crashing the whole plan is worse. The gate is therefore best-effort: it
 * relies on GitHub search surfacing the existing issue, so a search-index miss
 * (ingestion lag on a just-filed issue, >100 fuzzy matches, or a title GitHub
 * search can't phrase-quote) can still let a duplicate through. That is an
 * acceptable degradation for #2120's target (long-closed, long-indexed leaves).
 */
function findExistingIssueByTitle(
  runGh: (args: string[]) => string,
  repo: string,
  title: string,
): string | null {
  const raw = runGh([
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'all',
    '--search',
    `in:title ${JSON.stringify(title)}`,
    '--json',
    'number,title',
    '--limit',
    '100',
  ]).trim();
  let rows: Array<{ number: number; title: string }>;
  try {
    rows = raw ? (JSON.parse(raw) as Array<{ number: number; title: string }>) : [];
  } catch {
    // Unparseable payload — treat as no match rather than crashing the loop.
    return null;
  }
  const match = Array.isArray(rows) ? rows.find((r) => r.title === title) : undefined;
  return match ? `${repo}#${match.number}` : null;
}

/**
 * File one leaf as a GitHub issue in the umbrella's repo, unless an issue with
 * the same title already exists (open or closed) — in which case we skip the
 * create and reuse the existing ref. `existing` is the pre-resolved existing
 * ref (from the plan-time title pass, #2145) or null; when undefined we resolve
 * it here (fail-open path). Returns the issue ref (URL for a fresh create,
 * owner/repo#N for a reused one) and whether we created it.
 */
function emitLeaf(
  runGh: (args: string[]) => string,
  repo: string,
  leaf: LeafSpec,
  umbrella: string,
  existing: string | null | undefined,
): { ref: string; created: boolean } {
  const resolved = existing === undefined ? findExistingIssueByTitle(runGh, repo, leaf.title) : existing;
  if (resolved) return { ref: resolved, created: false };
  const body = buildLeafIssueBody(leaf, umbrella);
  const args = ['issue', 'create', '-R', repo, '--title', leaf.title, '--body', body];
  for (const label of leaf.labels ?? []) args.push('--label', label);
  return { ref: runGh(args).trim(), created: true };
}

/**
 * Attach extra skip reasons (e.g. exhausted umbrellas) to a decision. An
 * excluded umbrella may also appear in `decision.skipped` with a rank-based
 * reason from the pure engine (when a lower-ranked umbrella won the re-eval,
 * that reason is factually inverted); the exhaustion reason here is the
 * accurate one, so we drop the engine's entry for the same ref before appending.
 */
function withExtraSkips(
  decision: QueueFeederDecision,
  extra: readonly SkippedUmbrella[],
): QueueFeederDecision {
  if (extra.length === 0) return decision;
  const extraRefs = new Set(extra.map((s) => s.ref));
  const deduped = decision.skipped.filter((s) => !extraRefs.has(s.ref));
  return { ...decision, skipped: [...deduped, ...extra] };
}

interface TitleExhaustionResult {
  decision: QueueFeederDecision;
  /**
   * For a shred decision, a `leaf title → existing ref (or null)` map covering
   * every selected leaf, so the emit loop reuses it instead of re-querying gh.
   * Null for non-shred outcomes (invent / secondary / skip) and for the
   * fail-open path.
   */
  existingByTitle: Map<string, string | null> | null;
}

/**
 * Plan-time curated-plan title-exhaustion guard (#2145).
 *
 * {@link evaluateQueueFeeder} is pure and cannot see GitHub, so it returns
 * `action=shred` for a curated umbrella whose every leaf title has already been
 * emitted and CLOSED. Trusting that decision would spawn implementers against
 * completed work and never refill the belt. Here we refetch existing issue
 * titles (open OR closed) for the selected umbrella; if EVERY leaf title
 * already exists, we exclude that umbrella and re-evaluate so the decision
 * advances to the next-ranked shreddable umbrella, `invent-product-wave` (a
 * curated-but-exhausted product umbrella now routes to invent, refilling the
 * belt — problem #2), or `skip-invent`.
 *
 * A partially-exhausted plan still shreds; the emit path files only the
 * genuinely-new titles, reusing the map computed here so each leaf title is
 * queried at most once per selected umbrella (keeps gh cost bounded).
 *
 * Failure posture: a gh *process* failure while verifying the selected
 * umbrella's titles cannot be turned into an exhaustion verdict, so we return
 * the current decision (prior exclusions already applied) with no reuse map —
 * the emit path re-checks and fails closed (exit 4), and dry-run degrades to
 * this un-verified shred plan. We deliberately do NOT restart from an
 * un-excluded evaluation, which could re-select an already-excluded exhausted
 * umbrella. A gh success with an unparseable payload fails open per-leaf inside
 * {@link findExistingIssueByTitle}.
 */
function planWithTitleExhaustion(
  input: QueueFeederInput,
  runGh: (args: string[]) => string,
): TitleExhaustionResult {
  const excluded = new Set<string>();
  const extraSkips: SkippedUmbrella[] = [];
  const baseResolve =
    input.resolveLeaves ?? ((c: UmbrellaCandidate) => curatedLeafPlan(umbrellaRef(c)));
  const evalWith = (): QueueFeederDecision =>
    evaluateQueueFeeder({
      ...input,
      resolveLeaves: (c) => (excluded.has(umbrellaRef(c)) ? undefined : baseResolve(c)),
    });

  // Each iteration excludes ≥1 umbrella, so the candidate count bounds the loop.
  for (let guard = 0; guard <= input.candidates.length; guard++) {
    const decision = evalWith();
    const sel = decision.selected;
    if (decision.action !== 'shred' || !sel || sel.needsAuthoring || sel.leaves.length === 0) {
      return { decision: withExtraSkips(decision, extraSkips), existingByTitle: null };
    }
    const existingByTitle = new Map<string, string | null>();
    let allExist = true;
    try {
      for (const leaf of sel.leaves) {
        const existing = findExistingIssueByTitle(runGh, sel.repo, leaf.title);
        existingByTitle.set(leaf.title, existing);
        if (existing === null) allExist = false;
      }
    } catch {
      // gh process failure verifying titles → cannot determine exhaustion for
      // this umbrella. Return the current decision (prior exclusions kept) with
      // no reuse map so emit re-checks and fails closed; never restart from an
      // un-excluded eval (would risk re-selecting an excluded umbrella).
      return { decision: withExtraSkips(decision, extraSkips), existingByTitle: null };
    }
    if (!allExist) {
      // At least one genuinely-new title — shred stands; emit files only the new.
      return { decision: withExtraSkips(decision, extraSkips), existingByTitle };
    }
    // Curated plan fully exhausted → exclude this umbrella and re-evaluate.
    excluded.add(sel.ref);
    extraSkips.push({
      ref: sel.ref,
      reason:
        `curated leaf plan exhausted — all ${sel.leaves.length} leaf title(s) already exist ` +
        `as open/closed issues; excluded from shred so the belt can refill (#2145)`,
    });
  }
  // Loop guard tripped (unreachable in practice) — return the fully-excluded eval.
  return { decision: withExtraSkips(evalWith(), extraSkips), existingByTitle: null };
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

async function runPlan(
  args: ParsedArgs,
  io: Required<Pick<QueueFeederCliIo, 'out' | 'err' | 'now'>> & {
    runGh: (args: string[]) => string;
    fetchImpl: typeof fetch;
    env: NodeJS.ProcessEnv;
    readInput: (path: string | null) => string;
    appendLine: (path: string, line: string) => void;
  },
): Promise<number> {
  const snapshot = parseSnapshot(io.readInput(args.input));
  const claimConsultation = await consultReadyIssueClaims(snapshot.readyIssues, io.env, io.fetchImpl);
  const capacity: CapacitySignal = {
    free: args.free ?? snapshot.capacity.free,
    pendingQueueDepth: args.pending ?? snapshot.capacity.pendingQueueDepth,
    // Issue #2357: prefer ledger effective free so feeder agrees with
    // capacityThroughputVerdict.idleEffectiveSlots under residual phantoms.
    ...(typeof snapshot.capacity.freeForGeneralSources === 'number'
      && Number.isFinite(snapshot.capacity.freeForGeneralSources)
      ? { freeForGeneralSources: snapshot.capacity.freeForGeneralSources }
      : {}),
  };

  const baseInput: QueueFeederInput = {
    capacity,
    candidates: snapshot.candidates,
    readyIssues: claimConsultation.readyIssues,
    openProductMetricIssues: snapshot.openProductMetricIssues,
    consecutiveBlockedEmpty: snapshot.consecutiveBlockedEmpty,
    config: { freeSlotsThreshold: args.freeThreshold },
  };

  // Plan-time title-exhaustion guard (#2145): never return action=shred with a
  // leaf set whose titles are all already-closed issues. On a gh failure the
  // guard keeps prior exclusions and returns the current shred with no reuse
  // map, so the emit gate fails closed (exit 4) and dry-run degrades to the
  // un-verified plan (see planWithTitleExhaustion).
  const planned = planWithTitleExhaustion(baseInput, io.runGh);
  let decision: QueueFeederDecision = {
    ...planned.decision,
    skipped: [...claimConsultation.skipped, ...planned.decision.skipped],
  };
  // The first consultation prevents obvious duplicates. This second read is
  // the race recheck immediately before secondary emission (#2757).
  decision = await recheckSecondaryClaims(decision, io.env, io.fetchImpl);
  const { existingByTitle } = planned;

  const emitted: string[] = [];
  // Leaves whose title already existed (open or closed) → skipped create,
  // existing ref reused (#2120). Recorded in the ledger for agent audit.
  const skipped: Array<{ title: string; existing: string }> = [];
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
        // Reuse the plan-time title lookup (#2145) when present; undefined tells
        // emitLeaf to resolve it itself (fail-open path when the guard threw).
        const existing = existingByTitle ? existingByTitle.get(leaf.title) ?? null : undefined;
        const res = emitLeaf(io.runGh, decision.selected.repo, leaf, decision.selected.ref, existing);
        emitted.push(res.ref);
        if (!res.created) skipped.push({ title: leaf.title, existing: res.ref });
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
        skipped,
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
  const skipNote =
    skipped.length > 0 ? ` (skipped ${skipped.length} existing-title leaf(s))` : '';
  emit(args.json, io.out, { decision, record, emitted, skipped }, `${line}${skipNote}`);
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
  const fetchImpl = io.fetchImpl ?? fetch;
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
      return await runPlan(args, { out, err, now, runGh, fetchImpl, env, readInput, appendLine });
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
