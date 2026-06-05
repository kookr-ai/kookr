import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import type { TokenUsage } from './types.js';
import { getPricing, estimateCost, type ModelPricing } from './pricing-tables.js';

/**
 * A transcript file that has grown since the last `scanAll`, but whose new bytes
 * have not yet been parsed. Emitted by {@link TokenTracker.scanGrowth} so the
 * watchdog can treat in-flight streaming as a freshness signal even before the
 * final `usage` block lands.
 */
export interface TranscriptGrowth {
  taskId: string;
  bytesGained: number;
}

/**
 * Shape of transcript JSONL entries that carry cost/token data.
 *
 * Real Claude Code format (v2.1+):
 *   assistant entries have usage inside message.usage
 *   No cost_usd or result entries — cost is estimated from tokens.
 *
 * Legacy/fixture format:
 *   assistant entries may have top-level cost_usd and usage
 *   result entries may have total_cost_usd and usage
 */
interface TranscriptCostEntry {
  type?: string;
  role?: string;
  // Legacy top-level fields
  cost_usd?: number;
  total_cost_usd?: number;
  usage?: UsageBlock;
  // Real format: message wrapper
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: UsageBlock;
  };
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptState {
  taskId: string;
  /**
   * UTF-16 code-unit offset into the in-memory string representation of the
   * file. Used by `scanOne` to slice off already-parsed content.
   */
  offset: number;
  /**
   * Byte offset into the on-disk transcript. Used by `scanGrowth` to detect
   * file growth via `fs.stat` without re-reading. Tracked separately from
   * `offset` because `fs.stat` returns bytes while JS string `.length` is
   * UTF-16 code units — mixing them silently misfires on any non-ASCII byte
   * (em-dashes, smart quotes, emoji are all common in transcripts).
   */
  byteOffset: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Explicit cost from cost_usd fields (legacy format). */
  explicitCostUsd: number;
  /** Authoritative total from result entry (legacy format). */
  totalCostUsd: number | null;
  /** Model detected from transcript, used for cost estimation. */
  model: string | null;
  /**
   * Per-`message.id` latest-seen usage block. Claude Code writes one JSONL line
   * per content block (thinking / text / tool_use) of a single API response,
   * and each line carries the same `message.id` with progressive, monotonically
   * growing usage. We keep only the final value per id — on a repeat, the prior
   * contribution is subtracted and the new one added.
   */
  perMsgUsage: Map<string, UsageBlock>;
  /**
   * Signature of the last assistant entry that had usage but no `message.id`.
   * Preserves the pre-v2.1 consecutive-dedup behavior for legacy transcripts
   * where per-content-block duplicates shared identical usage blocks.
   */
  lastLegacySignature: string | null;
}

/**
 * Tracks token usage across Claude Code transcript JSONL files.
 * Reads incrementally (offset-based) to avoid re-parsing entire files.
 * Aggregates per-task across multiple sessions.
 */
export class TokenTracker {
  /** transcript path → incremental state */
  private transcripts = new Map<string, TranscriptState>();
  /** task id → transcript paths */
  private taskToTranscripts = new Map<string, Set<string>>();

  /** Register a transcript file for a task. */
  register(transcriptPath: string, taskId: string): void {
    if (this.transcripts.has(transcriptPath)) return;
    // Seed byteOffset to the file's current size so scanGrowth treats
    // pre-existing bytes as "already accounted for" rather than as fresh
    // growth on the first tick. The transcript may not exist yet — that's
    // fine, byteOffset stays 0 and subsequent writes register as growth.
    let initialByteOffset = 0;
    try { initialByteOffset = statSync(transcriptPath).size; } catch { /* file not created yet */ }
    this.transcripts.set(transcriptPath, {
      taskId,
      offset: 0,
      byteOffset: initialByteOffset,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      explicitCostUsd: 0,
      totalCostUsd: null,
      model: null,
      perMsgUsage: new Map(),
      lastLegacySignature: null,
    });
    let paths = this.taskToTranscripts.get(taskId);
    if (!paths) {
      paths = new Set<string>();
      this.taskToTranscripts.set(taskId, paths);
    }
    paths.add(transcriptPath);
  }

  /** Unregister a transcript (e.g. session stopped). */
  unregister(transcriptPath: string): void {
    const state = this.transcripts.get(transcriptPath);
    if (!state) return;

    this.transcripts.delete(transcriptPath);
    const paths = this.taskToTranscripts.get(state.taskId);
    if (!paths) return;
    paths.delete(transcriptPath);
    if (paths.size === 0) {
      this.taskToTranscripts.delete(state.taskId);
    }
  }

  /** Scan all registered transcripts for new cost data. */
  async scanAll(): Promise<void> {
    for (const [path, state] of this.transcripts) {
      await this.scanOne(path, state);
    }
  }

  /**
   * Stat each registered transcript and report any whose on-disk size exceeds
   * the last byte offset consumed by {@link scanAll}. This is a near-zero-cost
   * freshness probe used to suppress watchdog `stale_agent` findings while an
   * LLM is mid-stream — long thinking turns finalize their `usage` block only
   * at message end, but bytes arrive continuously in the meantime.
   *
   * Call this BEFORE `scanAll` on the same tick so `scanAll` does not advance
   * `state.offset` past the growth this probe is supposed to observe.
   */
  async scanGrowth(): Promise<TranscriptGrowth[]> {
    const growths: TranscriptGrowth[] = [];
    for (const [path, state] of this.transcripts) {
      const s = await stat(path).catch(() => null);
      if (!s) continue;
      if (s.size > state.byteOffset) {
        growths.push({ taskId: state.taskId, bytesGained: s.size - state.byteOffset });
      }
    }
    return growths;
  }

  /** Scan only transcripts belonging to a specific task. Returns true if usage changed. */
  async scanTask(taskId: string): Promise<boolean> {
    let changed = false;
    for (const path of this.taskToTranscripts.get(taskId) ?? []) {
      const state = this.transcripts.get(path);
      if (!state) continue;
      const beforeInput = state.inputTokens;
      const beforeOutput = state.outputTokens;
      await this.scanOne(path, state);
      if (state.inputTokens !== beforeInput || state.outputTokens !== beforeOutput) {
        changed = true;
      }
    }
    return changed;
  }

  /** Get aggregated token usage for a task (across all its sessions). */
  getUsage(taskId: string): TokenUsage | undefined {
    let found = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;

    for (const path of this.taskToTranscripts.get(taskId) ?? []) {
      const state = this.transcripts.get(path);
      if (!state) continue;
      found = true;
      inputTokens += state.inputTokens;
      outputTokens += state.outputTokens;
      cacheReadTokens += state.cacheReadTokens;
      cacheWriteTokens += state.cacheWriteTokens;

      // Use explicit cost if available (legacy format), otherwise estimate from tokens
      if (state.totalCostUsd != null) {
        costUsd += state.totalCostUsd;
      } else if (state.explicitCostUsd > 0) {
        costUsd += state.explicitCostUsd;
      } else {
        const pricing = getPricing(state.model ?? '');
        costUsd += estimateCost(
          state.inputTokens, state.outputTokens,
          state.cacheWriteTokens, state.cacheReadTokens, pricing,
        );
      }
    }

    if (!found) return undefined;
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
  }

  /** Get all task IDs that have registered transcripts. */
  getTrackedTaskIds(): string[] {
    return Array.from(this.taskToTranscripts.keys());
  }

  /**
   * First non-null model observed across the task's registered transcripts.
   * Used by the cost-comparison surface to drive the R17 pricing-staleness
   * banner for Claude rows (the row's `model` field on the wire stays null
   * because Anthropic transcripts carry dated model ids that don't round-trip
   * cleanly across the panel's exact-match pricing path).
   */
  getModel(taskId: string): string | null {
    for (const path of this.taskToTranscripts.get(taskId) ?? []) {
      const state = this.transcripts.get(path);
      if (!state) continue;
      if (state.model) return state.model;
    }
    return null;
  }

  private async scanOne(path: string, state: TranscriptState): Promise<void> {
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      return; // File doesn't exist yet or is unreadable
    }

    if (content.length <= state.offset) {
      // Even when no new code units are present, keep byteOffset in sync with
      // the file's actual byte size so the freshness probe doesn't double-fire
      // on pure-ASCII no-op ticks.
      state.byteOffset = Buffer.byteLength(content, 'utf-8');
      return;
    }

    const newContent = content.slice(state.offset);
    state.offset = content.length;
    state.byteOffset = Buffer.byteLength(content, 'utf-8');

    const lines = newContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TranscriptCostEntry;
      try {
        entry = JSON.parse(trimmed) as TranscriptCostEntry;
      } catch {
        continue;
      }

      this.processEntry(state, entry);
    }
  }

  private processEntry(state: TranscriptState, entry: TranscriptCostEntry): void {
    const entryType = entry.type ?? entry.role;

    // Assistant messages: accumulate per-turn token usage
    if (entryType === 'assistant') {
      // Detect model from message.model (real format)
      if (entry.message?.model && !state.model) {
        state.model = entry.message.model;
      }

      // Real format carries usage under message.usage; legacy fixtures put it at top level.
      const usage = entry.message?.usage ?? entry.usage;
      const msgId = entry.message?.id;
      if (usage) {
        if (msgId) {
          // Real format: multiple content blocks from one API response share a
          // message.id with progressive usage updates. Keep the latest value
          // per id — replacing the prior contribution rather than adding to it.
          const prev = state.perMsgUsage.get(msgId);
          if (prev) {
            state.inputTokens -= prev.input_tokens ?? 0;
            state.outputTokens -= prev.output_tokens ?? 0;
            state.cacheReadTokens -= prev.cache_read_input_tokens ?? 0;
            state.cacheWriteTokens -= prev.cache_creation_input_tokens ?? 0;
          }
          state.perMsgUsage.set(msgId, usage);
          state.lastLegacySignature = null;
        } else {
          // No message.id (legacy transcript). Preserve the pre-v2.1
          // consecutive-signature dedup so older on-disk logs don't suddenly
          // start over-counting content-block duplicates.
          const sig = `${usage.input_tokens ?? 0}:${usage.output_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}:${usage.cache_creation_input_tokens ?? 0}`;
          if (sig === state.lastLegacySignature) return;
          state.lastLegacySignature = sig;
        }
        state.inputTokens += usage.input_tokens ?? 0;
        state.outputTokens += usage.output_tokens ?? 0;
        state.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        state.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      }

      // Legacy format: top-level cost_usd
      if (entry.cost_usd != null) {
        state.explicitCostUsd += entry.cost_usd;
      }
    }

    // Result entry (legacy format): authoritative session total
    if (entryType === 'result') {
      if (entry.total_cost_usd != null) {
        state.totalCostUsd = entry.total_cost_usd;
      }
      // A result entry marks an authoritative boundary. Drop per-msg
      // bookkeeping unconditionally so any subsequent assistant entry that
      // reuses an earlier msg_id can't subtract against stale state.
      state.perMsgUsage.clear();
      state.lastLegacySignature = null;
      // If result carries usage totals, override accumulated values
      const usage = entry.usage;
      if (usage) {
        if (usage.input_tokens != null) state.inputTokens = usage.input_tokens;
        if (usage.output_tokens != null) state.outputTokens = usage.output_tokens;
        if (usage.cache_read_input_tokens != null) state.cacheReadTokens = usage.cache_read_input_tokens;
        if (usage.cache_creation_input_tokens != null) state.cacheWriteTokens = usage.cache_creation_input_tokens;
      }
    }
  }
}

// Re-export pricing helpers for backward compat — callers historically imported these from
// `./token-tracker`. New code SHOULD import from `./pricing-tables` directly; in particular,
// the cost-comparison surface uses `lookupPricing` (strict null) instead of `getPricing`.
export { estimateCost, getPricing, type ModelPricing };
