/**
 * Cost-comparison scanner for Codex CLI rollout JSONL files
 * (rfc-cost-comparison-panel.md, R10/R16/§Discovery/§Token aggregation rule).
 *
 * Read-only: walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (CODEX_HOME env
 * var honoured), extracts `session_meta`, the last `total_token_usage` snapshot,
 * the first `turn_context.model`, and terminal-event presence; binds Kookr tasks
 * to rollouts by (cwd, ±60 s UTC) with abandoned-rollout exclusion; sums
 * sub-agent rollouts recursively via `thread_spawn.parent_thread_id`.
 *
 * Per-file results are cached by (path, mtime) so a warm scan only re-parses
 * files that actually changed since the last call. Cold scans aim to complete
 * in < 5 s on ≤ 1500 rollouts; warm scans in < 200 ms (R6, microbenchmark in
 * codex-rollout-scanner.test.ts).
 *
 * The scanner does NOT enforce business rules — it returns rollout metadata
 * and a token-aggregated binding map. Pricing lookup, dataQuality discriminant,
 * and per-playbook bucketing live in `cost-comparison-aggregator.ts`.
 */
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import type {
  BoundTaskTokens,
  CodexRolloutMeta,
  DiscoveryOutcome,
  OrphanBinding,
} from '../core/cost-comparison-scanner-contracts.js';

export type {
  BoundTaskTokens,
  CodexRolloutMeta,
  CodexTokenSnapshot,
  DiscoveryOutcome,
  OrphanBinding,
} from '../core/cost-comparison-scanner-contracts.js';

const SIXTY_S_MS = 60_000;
const ONE_DAY_MS = 86_400_000;

/**
 * Sum tokens, model, and quality flags across a parent rollout + its
 * sub-agent thread. Shared by the bound-task and orphan-parent paths so
 * the recursive-sum rule (RFC §Token aggregation rule) is enforced once.
 */
function sumThread(
  parent: CodexRolloutMeta,
  subagents: CodexRolloutMeta[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  model: string | null;
  hasTokenData: boolean;
  hasParseError: boolean;
} {
  let totalInput = 0, totalOutput = 0, totalCached = 0;
  let model: string | null = null;
  let hasTokenData = false;
  let hasParseError = false;
  for (const r of [parent, ...subagents]) {
    if (r.parseError) hasParseError = true;
    if (r.totalUsage) {
      hasTokenData = true;
      totalInput += r.totalUsage.inputTokens;
      totalOutput += r.totalUsage.outputTokens;
      totalCached += r.totalUsage.cachedInputTokens;
    }
    if (model == null && r.model) model = r.model;
  }
  return {
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCachedInputTokens: totalCached,
    model,
    hasTokenData,
    hasParseError,
  };
}
/**
 * mtime gate for skipping the last line of a rollout that may still be
 * actively written by Codex. Round-2 F27.
 */
const FRESH_MTIME_WINDOW_MS = 5_000;
/**
 * Abandoned-rollout exclusion: no terminal event AND mtime older than 24 h
 * means Codex was Ctrl-C'd / crashed / killed and never wrote a closeout.
 * Round-3 failure-mode-analyst F1.
 */
const ABANDON_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const SCAN_FILE_YIELD_INTERVAL = 10;
const PARSE_LINE_YIELD_INTERVAL = 1_000;

/** Input to the binder: the Kookr-side view of a Codex task. */
export interface KookrCodexTaskInput {
  taskId: string;
  cwd: string;
  createdAtMs: number;
}

/** Cache entry per file — keyed by path, invalidated on mtime change. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  meta: CodexRolloutMeta;
}

/** Top-level scanner result. Useful as an internal seam for the aggregator + tests. */
export interface ScanResult {
  /** All rollout files seen in the window. Includes parse errors and abandoned ones (the binder filters). */
  rollouts: CodexRolloutMeta[];
  /** Diagnostic counts for the startup-log line and the response notes. */
  stats: {
    rolloutCount: number;
    parseErrorCount: number;
    abandonedCount: number;
    /** Wall-clock duration of this scan in ms. */
    scanDurationMs: number;
    /** Where the scan looked. */
    codexHome: string;
  };
}

/** Configuration knobs (mostly for tests). */
export interface CodexRolloutScannerOptions {
  /** Override `~/.codex/sessions`. Honors CODEX_HOME env var by default. */
  codexHome?: string;
  /** Test seam: clock function returning ms-since-epoch. Defaults to Date.now(). */
  now?: () => number;
}

export class CodexRolloutScanner {
  private readonly codexHome: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: CodexRolloutScannerOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex', 'sessions');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Walk the date directories in `[windowStartMs - 1d, windowEndMs + 1d]` (UTC) and
   * read each rollout. Cached files (same path + same mtime + same size) are reused.
   *
   * The 1-day padding catches long-running sessions that started just before the
   * window or finished just after it (rollout files are filed by start time, not
   * end time).
   */
  async scan(windowStartMs: number, windowEndMs: number, options: { signal?: AbortSignal } = {}): Promise<ScanResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const startedAt = this.now();
    const paths = await this.collectPaths(windowStartMs, windowEndMs, signal);

    const rollouts: CodexRolloutMeta[] = [];
    let parseErrorCount = 0;
    let abandonedCount = 0;
    const seenPaths = new Set<string>();

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      signal?.throwIfAborted();
      seenPaths.add(path);
      let meta: CodexRolloutMeta;
      try {
        const st = await stat(path);
        signal?.throwIfAborted();
        const cached = this.cache.get(path);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          meta = cached.meta;
        } else {
          meta = await this.parseRollout(path, st, signal);
          this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, meta });
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        meta = {
          path, id: '', cwd: '', startedAt: new Date(0), cliVersion: null,
          forkedFromId: null, parentThreadId: null, agentNickname: null,
          model: null, totalUsage: null, hasTerminalEvent: false, mtimeMs: 0,
          parseError: `stat/read: ${(err as Error).message}`,
        };
      }
      rollouts.push(meta);
      if (meta.parseError) parseErrorCount++;
      if (this.isAbandoned(meta)) abandonedCount++;
      if ((i + 1) % SCAN_FILE_YIELD_INTERVAL === 0) {
        await cooperativeYield(signal);
      }
    }

    // Evict cache entries whose paths are no longer on disk (rotated / deleted).
    for (const cachedPath of this.cache.keys()) {
      if (!seenPaths.has(cachedPath)) this.cache.delete(cachedPath);
    }

    return {
      rollouts,
      stats: {
        rolloutCount: rollouts.length,
        parseErrorCount,
        abandonedCount,
        scanDurationMs: this.now() - startedAt,
        codexHome: this.codexHome,
      },
    };
  }

  /**
   * Bind Kookr tasks to rollouts by (cwd, ±60 s UTC). On ambiguity (multiple
   * candidates within the window) the closest by timestamp wins; callers
   * downstream get a single-binding view either way. Sub-agents are summed
   * recursively by walking the `thread_spawn.parent_thread_id` chain.
   */
  bindTasks(rollouts: CodexRolloutMeta[], tasks: KookrCodexTaskInput[]): {
    bindings: Map<string, BoundTaskTokens>;
    outcomes: Map<string, DiscoveryOutcome>;
    /**
     * Top-level rollouts (parent_thread_id null) that no Kookr task claimed,
     * each summed with its recursively-reachable sub-agents — same accounting
     * rule as a bound task. Counts and totals here drive the panel's
     * "Unbound Codex" coverage caveat (rfc-cost-comparison-coverage-and-perf.md
     * §Change 2).
     */
    orphanBindings: OrphanBinding[];
  } {
    // Index rollouts by (cwd, valid-non-abandoned-non-error parent rollout) for fast lookup.
    const candidateParents = rollouts.filter(r =>
      !r.parseError && r.parentThreadId == null && !this.isAbandoned(r),
    );
    // Sub-agent map: parent_thread_id -> children
    const childrenByParent = new Map<string, CodexRolloutMeta[]>();
    for (const r of rollouts) {
      if (r.parseError || !r.parentThreadId) continue;
      let arr = childrenByParent.get(r.parentThreadId);
      if (!arr) { arr = []; childrenByParent.set(r.parentThreadId, arr); }
      arr.push(r);
    }

    const usedRolloutIds = new Set<string>();
    const bindings = new Map<string, BoundTaskTokens>();
    const outcomes = new Map<string, DiscoveryOutcome>();

    // Process tasks in chronological order so deterministic batch-launch tie-breaks.
    const sortedTasks = [...tasks].sort((a, b) => a.createdAtMs - b.createdAtMs);

    for (const task of sortedTasks) {
      const matches = candidateParents.filter(r =>
        !usedRolloutIds.has(r.id)
        && r.cwd === task.cwd
        && Math.abs(r.startedAt.getTime() - task.createdAtMs) <= SIXTY_S_MS,
      );

      if (matches.length === 0) {
        // Distinguish "no candidates" from "rolled-back-but-abandoned" — the
        // panel may want to render different tooltips (round-3: codex-rollout-abandoned vs codex-rollout-not-found).
        const abandonedCandidates = rollouts.filter(r =>
          r.cwd === task.cwd
          && r.parentThreadId == null
          && this.isAbandoned(r)
          && Math.abs(r.startedAt.getTime() - task.createdAtMs) <= SIXTY_S_MS,
        );
        if (abandonedCandidates.length > 0) {
          const newest = abandonedCandidates.reduce((a, b) => a.mtimeMs > b.mtimeMs ? a : b);
          outcomes.set(task.taskId, { kind: 'abandoned', mostRecentRolloutMtimeMs: newest.mtimeMs });
        } else {
          outcomes.set(task.taskId, { kind: 'not-found', reason: 'no-candidates', candidateCount: 0 });
        }
        continue;
      }

      // Take the closest by timestamp; record ambiguity for tooltip surface.
      const sorted = matches.slice().sort((a, b) =>
        Math.abs(a.startedAt.getTime() - task.createdAtMs) - Math.abs(b.startedAt.getTime() - task.createdAtMs),
      );
      const parent = sorted[0];
      usedRolloutIds.add(parent.id);

      const subagents = this.walkSubagents(parent, childrenByParent, usedRolloutIds);
      const summed = sumThread(parent, subagents);

      const binding: BoundTaskTokens = {
        taskId: task.taskId,
        parent,
        subagents,
        ...summed,
      };
      bindings.set(task.taskId, binding);
      outcomes.set(task.taskId, { kind: 'bound', binding });
    }

    // Orphan parents — top-level non-error non-abandoned rollouts not claimed
    // by any task. Walk their sub-agent trees with the same recursive sum so
    // an unbound parent + 3 children counts as one orphan with the full
    // thread total, not 4 separate items.
    const orphanBindings: OrphanBinding[] = [];
    for (const r of rollouts) {
      if (r.parseError) continue;
      if (r.parentThreadId != null) continue;
      if (this.isAbandoned(r)) continue;
      if (usedRolloutIds.has(r.id)) continue;
      const subagents = this.walkSubagents(r, childrenByParent, usedRolloutIds);
      orphanBindings.push({ parent: r, subagents, ...sumThread(r, subagents) });
    }

    return { bindings, outcomes, orphanBindings };
  }

  /**
   * Walk the sub-agent tree rooted at `parent` via `thread_spawn.parent_thread_id`
   * (BFS). Each visited child is added to `usedRolloutIds` so subsequent
   * bind/orphan passes don't double-count it.
   */
  private walkSubagents(
    parent: CodexRolloutMeta,
    childrenByParent: Map<string, CodexRolloutMeta[]>,
    usedRolloutIds: Set<string>,
  ): CodexRolloutMeta[] {
    const subagents: CodexRolloutMeta[] = [];
    const visited = new Set<string>([parent.id]);
    let frontier = [parent.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const pid of frontier) {
        const children = childrenByParent.get(pid);
        if (!children) continue;
        for (const c of children) {
          if (visited.has(c.id)) continue;
          visited.add(c.id);
          usedRolloutIds.add(c.id);
          subagents.push(c);
          next.push(c.id);
        }
      }
      frontier = next;
    }
    return subagents;
  }

  /** True iff no terminal event AND the file has been quiet for ≥ 24 h. */
  isAbandoned(r: CodexRolloutMeta): boolean {
    if (r.parseError) return false;
    if (r.hasTerminalEvent) return false;
    return (this.now() - r.mtimeMs) > ABANDON_THRESHOLD_MS;
  }

  /** Test/diagnostic seam — clear cached file metadata. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Walk every YYYY/MM/DD directory in [windowStart - 1d, windowEnd + 1d] UTC. */
  private async collectPaths(windowStartMs: number, windowEndMs: number, signal?: AbortSignal): Promise<string[]> {
    const paths: string[] = [];
    const start = windowStartMs - ONE_DAY_MS;
    const end = windowEndMs + ONE_DAY_MS;
    const startUtc = new Date(start);
    const endUtc = new Date(end);
    let cursor = Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate());
    const limit = Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate());
    while (cursor <= limit) {
      signal?.throwIfAborted();
      const d = new Date(cursor);
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const dir = join(this.codexHome, yyyy, mm, dd);
      const entries = await safeReaddir(dir);
      for (const name of entries) {
        if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
          paths.push(join(dir, name));
        }
      }
      cursor += ONE_DAY_MS;
      await cooperativeYield(signal);
    }
    return paths;
  }

  /** Read a rollout file once. Returns a `parseError`-flagged record on any structural problem. */
  private async parseRollout(path: string, st: Stats, signal?: AbortSignal): Promise<CodexRolloutMeta> {
    signal?.throwIfAborted();
    const out: CodexRolloutMeta = {
      path, id: '', cwd: '', startedAt: new Date(0), cliVersion: null,
      forkedFromId: null, parentThreadId: null, agentNickname: null,
      model: null, totalUsage: null, hasTerminalEvent: false,
      mtimeMs: st.mtimeMs, parseError: null,
    };

    const isFresh = (this.now() - st.mtimeMs) < FRESH_MTIME_WINDOW_MS;
    const skipLastLine = isFresh && st.size > 0 && !(await fileEndsWithNewline(path));
    const stream = createReadStream(path, { encoding: 'utf-8', signal });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let firstLine: string | null = null;
    let pendingLine: string | null = null;
    let lineCount = 0;
    let processedAnyEventLine = false;

    try {
      for await (const line of rl) {
        signal?.throwIfAborted();
        lineCount++;
        if (firstLine == null) {
          firstLine = line;
          pendingLine = line;
          continue;
        }
        if (pendingLine != null) {
          processRolloutEventLine(out, pendingLine, processedAnyEventLine);
          processedAnyEventLine = true;
        }
        pendingLine = line;
        if (lineCount % PARSE_LINE_YIELD_INTERVAL === 0) {
          await cooperativeYield(signal);
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      out.parseError = `read: ${(err as Error).message}`;
      return out;
    } finally {
      rl.close();
      stream.destroy();
    }

    if (!firstLine?.trim()) {
      out.parseError = 'empty file';
      return out;
    }

    // First line MUST be session_meta.
    let metaJson: Record<string, unknown>;
    try {
      metaJson = JSON.parse(firstLine) as Record<string, unknown>;
    } catch (err) {
      out.parseError = `session_meta parse: ${(err as Error).message}`;
      return out;
    }
    if ((metaJson as { type?: string }).type !== 'session_meta') {
      out.parseError = `first-line type=${(metaJson as { type?: string }).type ?? '<missing>'}`;
      return out;
    }
    const payload = (metaJson.payload as Record<string, unknown>) ?? {};
    out.id = String(payload.id ?? '');
    out.cwd = String(payload.cwd ?? '');
    const ts = payload.timestamp;
    if (typeof ts === 'string') {
      const d = new Date(ts);
      if (isFinite(d.getTime())) out.startedAt = d;
    }
    out.cliVersion = typeof payload.cli_version === 'string' ? payload.cli_version : null;
    out.forkedFromId = typeof payload.forked_from_id === 'string' ? payload.forked_from_id : null;
    // payload.source can be a string ("cli") OR an object containing subagent metadata. Skip when string.
    const source = payload.source;
    if (source && typeof source === 'object') {
      const subagent = (source as Record<string, unknown>).subagent;
      if (subagent && typeof subagent === 'object') {
        const ts2 = (subagent as Record<string, unknown>).thread_spawn;
        if (ts2 && typeof ts2 === 'object') {
          const tsObj = ts2 as Record<string, unknown>;
          out.parentThreadId = typeof tsObj.parent_thread_id === 'string' ? tsObj.parent_thread_id : null;
          out.agentNickname = typeof tsObj.agent_nickname === 'string' ? tsObj.agent_nickname : null;
        }
      }
    }

    if (pendingLine != null && !skipLastLine) {
      processRolloutEventLine(out, pendingLine, processedAnyEventLine);
    }

    return out;
  }
}

function processRolloutEventLine(out: CodexRolloutMeta, line: string, alreadyProcessedFirstLine: boolean): void {
  if (!line || !line.trim()) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;                                                                // single garbled line is not a fatal parse error
  }
  if (!alreadyProcessedFirstLine && (evt as { type?: string }).type === 'session_meta') {
    return;
  }
  const t = evt.type as string | undefined;
  const p = (evt.payload as Record<string, unknown> | undefined) ?? {};

  if (t === 'turn_context' && !out.model) {
    const m = p.model;
    if (typeof m === 'string') out.model = m;
  }

  if (t === 'event_msg' && (p.type as string | undefined) === 'token_count') {
    const info = p.info;
    if (info && typeof info === 'object') {
      const total = (info as Record<string, unknown>).total_token_usage;
      if (total && typeof total === 'object') {
        const ttu = total as Record<string, unknown>;
        // R10 schema assertion: input_tokens + output_tokens + cached_input_tokens MUST all be numeric.
        // Missing/non-numeric → parseError stamped on first encounter (the canonical token keys are the contract).
        if (typeof ttu.input_tokens === 'number'
          && typeof ttu.output_tokens === 'number'
          && typeof ttu.cached_input_tokens === 'number') {
          out.totalUsage = {
            inputTokens: ttu.input_tokens,
            outputTokens: ttu.output_tokens,
            cachedInputTokens: ttu.cached_input_tokens,
            reasoningOutputTokens: typeof ttu.reasoning_output_tokens === 'number' ? ttu.reasoning_output_tokens : 0,
          };
        } else if (out.parseError == null) {
          out.parseError = 'token_count.total_token_usage missing canonical keys';
        }
      }
    }
  }

  if (t === 'event_msg') {
    const eType = p.type as string | undefined;
    if (eType === 'task_complete' || eType === 'session_end') {
      out.hasTerminalEvent = true;
    }
  }
}

async function cooperativeYield(signal?: AbortSignal): Promise<void> {
  await yieldImmediate(undefined, { signal });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

async function fileEndsWithNewline(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1);
    const { bytesRead } = await fh.read(buffer, 0, 1, (await fh.stat()).size - 1);
    return bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
