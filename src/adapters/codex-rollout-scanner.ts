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
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Stats } from 'node:fs';

const SIXTY_S_MS = 60_000;
const ONE_DAY_MS = 86_400_000;
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

/** Per-rollout token snapshot, sourced from the last `token_count` event with non-null `info`. */
export interface CodexTokenSnapshot {
  /** Codex's `input_tokens` is the GROSS prompt total (it INCLUDES `cached_input_tokens`). Aggregator subtracts. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens that was served from prompt cache. */
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

/** Result of parsing a single rollout file. */
export interface CodexRolloutMeta {
  /** Absolute path to the rollout file. */
  path: string;
  /** session_meta.id — the rollout's primary key, used as the parent_thread_id target by sub-agents. */
  id: string;
  /** session_meta.cwd — what Codex was launched into. */
  cwd: string;
  /** session_meta.timestamp parsed as UTC. */
  startedAt: Date;
  /** session_meta.cli_version. Surfaced for forward-compatibility (sub-agent rule may become version-keyed). */
  cliVersion: string | null;
  /** Forked-from id chain link for resumed sessions. v1 does NOT chain — surfaced only. */
  forkedFromId: string | null;
  /** Sub-agent's parent thread id; null on top-level rollouts. */
  parentThreadId: string | null;
  /** session_meta.source.subagent.thread_spawn.agent_nickname. */
  agentNickname: string | null;
  /** First non-null `turn_context.model` (mixed-model task: first wins, mirrors token-tracker.ts behavior). */
  model: string | null;
  /** Last-seen `total_token_usage` snapshot; null when the rollout has no token telemetry yet. */
  totalUsage: CodexTokenSnapshot | null;
  /** True iff the rollout has a `task_complete` or `session_end` event. */
  hasTerminalEvent: boolean;
  /** File mtime ms-since-epoch (used to gate the abandoned-rollout check + the last-line freshness skip). */
  mtimeMs: number;
  /** When set, the row is poisoned: schema mismatch, unreadable file, or canonical token keys missing. */
  parseError: string | null;
}

/** Aggregated tokens for a Kookr task — parent rollout + recursively-bound sub-agents. */
export interface BoundTaskTokens {
  taskId: string;
  parent: CodexRolloutMeta;
  subagents: CodexRolloutMeta[];
  /** Sum of input_tokens across parent + sub-agents (gross — still includes cached). */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  /** First non-null model among parent + sub-agents (parent first). */
  model: string | null;
  /** True iff at least one rollout in the binding had non-null `totalUsage`. */
  hasTokenData: boolean;
  /** True iff at least one rollout in the binding raised a parse error. */
  hasParseError: boolean;
  /** Set when binding flagged the parent as ambiguous (multiple candidates within ±60 s). */
  ambiguousCandidateCount: number;
}

/** Per-rollout discovery result for a Kookr task. */
export type DiscoveryOutcome =
  | { kind: 'bound'; binding: BoundTaskTokens }
  | { kind: 'not-found'; reason: 'no-candidates' | 'ambiguous'; candidateCount: number }
  | { kind: 'abandoned'; mostRecentRolloutMtimeMs: number };

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
  async scan(windowStartMs: number, windowEndMs: number): Promise<ScanResult> {
    const startedAt = this.now();
    const paths = await this.collectPaths(windowStartMs, windowEndMs);

    const rollouts: CodexRolloutMeta[] = [];
    let parseErrorCount = 0;
    let abandonedCount = 0;
    const seenPaths = new Set<string>();

    for (const path of paths) {
      seenPaths.add(path);
      let meta: CodexRolloutMeta;
      try {
        const st = await stat(path);
        const cached = this.cache.get(path);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          meta = cached.meta;
        } else {
          meta = await this.parseRollout(path, st);
          this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, meta });
        }
      } catch (err) {
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
   * Bind Kookr tasks to rollouts by (cwd, ±60 s UTC). Ambiguity (multiple
   * candidates) records a binding with `ambiguousCandidateCount > 0`; callers
   * surface the ambiguity through tooltips. Sub-agents are summed recursively
   * by walking the `thread_spawn.parent_thread_id` chain.
   */
  bindTasks(rollouts: CodexRolloutMeta[], tasks: KookrCodexTaskInput[]): {
    bindings: Map<string, BoundTaskTokens>;
    outcomes: Map<string, DiscoveryOutcome>;
    /** Top-level rollouts (parent_thread_id null) that no Kookr task claimed. */
    orphanRollouts: CodexRolloutMeta[];
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
      const ambiguousCount = matches.length - 1;
      usedRolloutIds.add(parent.id);

      // Recursively bind sub-agents whose parent_thread_id chain reaches `parent.id`.
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

      // Sum tokens across the binding.
      const all = [parent, ...subagents];
      let totalInput = 0, totalOutput = 0, totalCached = 0;
      let model: string | null = null;
      let hasTokenData = false;
      let hasParseError = false;
      for (const r of all) {
        if (r.parseError) hasParseError = true;
        if (r.totalUsage) {
          hasTokenData = true;
          totalInput += r.totalUsage.inputTokens;
          totalOutput += r.totalUsage.outputTokens;
          totalCached += r.totalUsage.cachedInputTokens;
        }
        if (model == null && r.model) model = r.model;
      }

      const binding: BoundTaskTokens = {
        taskId: task.taskId,
        parent,
        subagents,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCachedInputTokens: totalCached,
        model,
        hasTokenData,
        hasParseError,
        ambiguousCandidateCount: ambiguousCount,
      };
      bindings.set(task.taskId, binding);
      outcomes.set(task.taskId, { kind: 'bound', binding });
    }

    const orphanRollouts = rollouts.filter(r =>
      !r.parseError
      && r.parentThreadId == null
      && !this.isAbandoned(r)
      && !usedRolloutIds.has(r.id),
    );

    return { bindings, outcomes, orphanRollouts };
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
  private async collectPaths(windowStartMs: number, windowEndMs: number): Promise<string[]> {
    const paths: string[] = [];
    const start = windowStartMs - ONE_DAY_MS;
    const end = windowEndMs + ONE_DAY_MS;
    const startUtc = new Date(start);
    const endUtc = new Date(end);
    let cursor = Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate());
    const limit = Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate());
    while (cursor <= limit) {
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
    }
    return paths;
  }

  /** Read a rollout file once. Returns a `parseError`-flagged record on any structural problem. */
  private async parseRollout(path: string, st: Stats): Promise<CodexRolloutMeta> {
    const out: CodexRolloutMeta = {
      path, id: '', cwd: '', startedAt: new Date(0), cliVersion: null,
      forkedFromId: null, parentThreadId: null, agentNickname: null,
      model: null, totalUsage: null, hasTerminalEvent: false,
      mtimeMs: st.mtimeMs, parseError: null,
    };

    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      out.parseError = `read: ${(err as Error).message}`;
      return out;
    }

    const lines = raw.split('\n');
    if (!lines[0]?.trim()) {
      out.parseError = 'empty file';
      return out;
    }

    // First line MUST be session_meta.
    let metaJson: Record<string, unknown>;
    try {
      metaJson = JSON.parse(lines[0]) as Record<string, unknown>;
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

    // Determine whether to skip the last line (Codex may still be writing it).
    const isFresh = (this.now() - st.mtimeMs) < FRESH_MTIME_WINDOW_MS;
    const lastIdx = lines.length - 1;
    const skipLastLine = isFresh && lines[lastIdx] !== '';                 // empty trailing line is fine

    // Walk events: capture last token_count.info, first turn_context.model, any terminal event.
    for (let i = 0; i < lines.length; i++) {
      if (skipLastLine && i === lastIdx) break;
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;                                                          // single garbled line is not a fatal parse error
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

    return out;
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
