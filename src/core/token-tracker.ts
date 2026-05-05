import { readFile } from 'node:fs/promises';
import type { TokenUsage } from './types.js';

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

/**
 * Per-model pricing in USD per million tokens.
 * Based on published Anthropic API pricing.
 */
interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.875 },
  // Verified 2026-04-24: Anthropic lists Opus 4.7 at $5/$25 per MTok, and prompt caching remains 1.25x write / 0.1x read of input.
  // Sources: https://www.anthropic.com/news/claude-opus-4-7 and https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  'claude-opus-4-7':   { inputPerMTok: 5,  outputPerMTok: 25, cacheWritePerMTok: 6.25,  cacheReadPerMTok: 0.5 },
  'claude-sonnet-4-6': { inputPerMTok: 3,  outputPerMTok: 15, cacheWritePerMTok: 3.75,  cacheReadPerMTok: 0.30 },
  'claude-haiku-4-5':  { inputPerMTok: 0.80, outputPerMTok: 4, cacheWritePerMTok: 1,     cacheReadPerMTok: 0.08 },
};

// Default pricing when model is unknown — use Sonnet as a reasonable middle ground
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING['claude-sonnet-4-6'];
const warnedUnknownPricingModels = new Set<string>();

/** Look up pricing by model ID (supports partial match for dated model IDs). */
function getPricing(model: string): ModelPricing {
  // Exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Prefix match for dated IDs like "claude-opus-4-6-20250514"
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return pricing;
  }
  if (!warnedUnknownPricingModels.has(model)) {
    warnedUnknownPricingModels.add(model);
    console.warn(`[token-tracker] Unknown pricing model ${JSON.stringify(model)}; using default Sonnet pricing`);
  }
  return DEFAULT_PRICING;
}

/** Estimate cost from token counts and model pricing. */
function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok
  );
}

interface TranscriptState {
  taskId: string;
  offset: number;
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

  /** Register a transcript file for a task. */
  register(transcriptPath: string, taskId: string): void {
    if (this.transcripts.has(transcriptPath)) return;
    this.transcripts.set(transcriptPath, {
      taskId,
      offset: 0,
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
  }

  /** Unregister a transcript (e.g. session stopped). */
  unregister(transcriptPath: string): void {
    this.transcripts.delete(transcriptPath);
  }

  /** Scan all registered transcripts for new cost data. */
  async scanAll(): Promise<void> {
    for (const [path, state] of this.transcripts) {
      await this.scanOne(path, state);
    }
  }

  /** Scan only transcripts belonging to a specific task. Returns true if usage changed. */
  async scanTask(taskId: string): Promise<boolean> {
    let changed = false;
    for (const [path, state] of this.transcripts) {
      if (state.taskId !== taskId) continue;
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

    for (const state of this.transcripts.values()) {
      if (state.taskId !== taskId) continue;
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
    const ids = new Set<string>();
    for (const state of this.transcripts.values()) {
      ids.add(state.taskId);
    }
    return Array.from(ids);
  }

  private async scanOne(path: string, state: TranscriptState): Promise<void> {
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      return; // File doesn't exist yet or is unreadable
    }

    if (content.length <= state.offset) return;

    const newContent = content.slice(state.offset);
    state.offset = content.length;

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

// --- Context-fill computation (for v5 checkpoint cycler) ----------------------

/**
 * Per-model context-window size in tokens. Used by computeContextFillFromTranscript
 * to convert the raw per-turn token count into a 0..1 fill ratio.
 *
 * Anthropic's published context windows. The Opus 4.6 1M variant ships a
 * separate model id (`claude-opus-4-6[1m]`) that prefix-matches before the
 * default Opus entry, so we list it first.
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6[1m]': 1_000_000,
  'claude-opus-4-7':       1_000_000,
  'claude-opus-4-6':       200_000,
  'claude-sonnet-4-6':     200_000,
  'claude-haiku-4-5':      200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;
const warnedUnknownContextModels = new Set<string>();

/** Resolve the context-window size for a model id, with prefix-fallback for dated ids. */
export function getContextLimit(model: string): number {
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return limit;
  }
  if (!warnedUnknownContextModels.has(model)) {
    warnedUnknownContextModels.add(model);
    console.warn(`[token-tracker] Unknown context limit for model ${JSON.stringify(model)}; using default ${DEFAULT_CONTEXT_LIMIT}`);
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export interface ContextFillSample {
  /** Tokens in the most recent assistant turn's effective context window. */
  totalTokens: number;
  /** Per-model context-window size used as the denominator. */
  modelLimit: number;
  /** Resolved model id from the transcript. */
  model: string;
  /** 0..1 fill ratio. */
  ratio: number;
}

/**
 * Read the most recent assistant entry from a transcript JSONL and compute the
 * context-window fill ratio.
 *
 * The "context fill" of an in-flight session is approximated as the sum of
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from
 * the most recent assistant message. This matches Claude Code's own `/context`
 * indicator within rounding (verified empirically — see
 * `docs/poc/005-checkpoint-cycle-mechanics.md`).
 *
 * Returns null when:
 *   - The file does not exist or is unreadable
 *   - No assistant turn with usage data has been written yet
 *
 * Reads the WHOLE file then iterates lines from the end. For long-running
 * sessions the file can grow into the megabyte range; if perf becomes a
 * concern, switch to tail-only reading via incremental offsets.
 */
export async function computeContextFillFromTranscript(
  transcriptPath: string,
): Promise<ContextFillSample | null> {
  let content: string;
  try {
    content = await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    let entry: TranscriptCostEntry;
    try {
      entry = JSON.parse(trimmed) as TranscriptCostEntry;
    } catch {
      continue;
    }

    if ((entry.type ?? entry.role) !== 'assistant') continue;

    const usage = entry.message?.usage ?? entry.usage;
    if (!usage) continue;

    const model = entry.message?.model ?? '';
    const total =
      (usage.input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0);
    const modelLimit = getContextLimit(model);
    const ratio = modelLimit > 0 ? total / modelLimit : 0;

    return { totalTokens: total, modelLimit, model, ratio };
  }

  return null;
}

// Export for testing
export { estimateCost, getPricing, type ModelPricing };
