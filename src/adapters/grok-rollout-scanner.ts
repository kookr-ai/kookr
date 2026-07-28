/**
 * Grok Build token-telemetry scanner (issue #1581).
 *
 * Grok Build persists per-turn token usage into its session transcripts
 * (`<GROK_HOME>/sessions/<url-encoded-cwd>/<sessionId>/updates.jsonl`). Each
 * completed user turn writes one `_x.ai/session/update` line whose
 * `params.update` carries `sessionUpdate: "turn_completed"` and a `usage`
 * block:
 *
 *   {"method":"_x.ai/session/update","params":{"update":{
 *      "sessionUpdate":"turn_completed",
 *      "usage":{"inputTokens":110087,"outputTokens":938,"totalTokens":111025,
 *               "cachedReadTokens":76800,"reasoningTokens":273,
 *               "modelUsage":{"grok-4.5-build":{...}}}}}}
 *
 * The per-turn `usage` blocks are NOT cumulative — each reports only its own
 * turn — so a session's total is the SUM across every `turn_completed` line, and
 * a task's total is the sum across every transcript under the launch's
 * `GROK_HOME` (the parent session plus any sub-agent sessions, which run under
 * the same isolated home).
 *
 * Token semantics differ from Codex in one load-bearing way: Grok's
 * `totalTokens === inputTokens + outputTokens` for every observed record, i.e.
 * `outputTokens` ALREADY INCLUDES `reasoningTokens` (reasoning is a subset, not
 * an additive bucket). Codex reports reasoning separately
 * (`total = input + output + reasoning`) and its metering adds it back in; Grok
 * must NOT — doing so double-counts reasoning. See
 * {@link mapGrokUsageToTokenUsage}.
 *
 * Unlike Codex's persistent `~/.codex/sessions`, a managed Grok launch composes
 * an EPHEMERAL per-session `GROK_HOME` that its adapter deletes on stop, so this
 * scanner is invoked by {@link GrokBuildAdapter.stop} BEFORE that teardown — it
 * is the only point at which the transcript still exists. The resulting
 * {@link TokenUsage} shape is identical to Codex/Claude (input = gross − cached;
 * output = all output tokens) so no parallel shape is introduced (issue #1581 /
 * #1307).
 */
import { createReadStream, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { TokenUsage } from '../core/types.js';

/** Cheap substring pre-filter: only lines carrying this marker are JSON-parsed. */
const TURN_COMPLETED_MARKER = 'turn_completed';
/** Transcript file name Grok writes per session. */
const TRANSCRIPT_FILENAME = 'updates.jsonl';
/** Bound on the directory-walk depth under `<GROK_HOME>/sessions`. */
const MAX_WALK_DEPTH = 4;

/**
 * Token usage summed across every `turn_completed` record in one launch's
 * transcripts (parent + sub-agent sessions). Token counts follow Grok's raw
 * semantics: `inputTokens` is GROSS prompt tokens (it includes the
 * `cachedReadTokens` subset) and `outputTokens` already includes
 * `reasoningTokens`. {@link mapGrokUsageToTokenUsage} converts to the shared
 * contract.
 */
export interface GrokSessionUsage {
  /** Gross prompt tokens (INCLUDES `cachedReadTokens`), summed across turns. */
  inputTokens: number;
  /** Output tokens (ALREADY INCLUDES `reasoningTokens`), summed across turns. */
  outputTokens: number;
  /** Cached-read prompt tokens (a subset of `inputTokens`), summed across turns. */
  cachedReadTokens: number;
  /**
   * Reasoning tokens, summed across turns. Retained as faithful raw telemetry
   * for observability, but it is a SUBSET of {@link outputTokens} — never add it
   * back when mapping to {@link TokenUsage} (issue #1581 regression guard).
   */
  reasoningTokens: number;
  /** Dominant model tag — the model with the most total tokens — or null. */
  model: string | null;
  /** Number of `turn_completed` usage records aggregated. */
  turnCount: number;
}

interface RawGrokUsageBlock {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  reasoningTokens?: unknown;
  modelUsage?: unknown;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Aggregate token usage across every `updates.jsonl` under
 * `<grokHome>/sessions`. Returns `null` when the sessions directory is absent or
 * carries no parseable `turn_completed` usage (the missing-source fallback: the
 * caller leaves `tokenUsage` unavailable rather than recording zeros).
 */
export async function readGrokHomeUsage(grokHome: string): Promise<GrokSessionUsage | null> {
  const sessionsRoot = join(grokHome, 'sessions');
  const files = await collectTranscriptFiles(sessionsRoot, 0);
  if (files.length === 0) return null;

  const totals: GrokSessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    model: null,
    turnCount: 0,
  };
  // Model attribution: accumulate per-model total tokens, then pick the max.
  const modelTotals = new Map<string, number>();

  for (const file of files) {
    await aggregateTranscript(file, totals, modelTotals);
  }

  if (totals.turnCount === 0) return null;
  totals.model = pickDominantModel(modelTotals);
  return totals;
}

async function collectTranscriptFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // sessions dir absent / unreadable — treated as no telemetry.
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTranscriptFiles(full, depth + 1)));
    } else if (entry.isFile() && entry.name === TRANSCRIPT_FILENAME) {
      files.push(full);
    }
  }
  return files;
}

async function aggregateTranscript(
  file: string,
  totals: GrokSessionUsage,
  modelTotals: Map<string, number>,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.includes(TURN_COMPLETED_MARKER)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a single garbled line is not fatal.
      }
      const update = (parsed as { params?: { update?: Record<string, unknown> } })?.params?.update;
      if (!update || update.sessionUpdate !== 'turn_completed') continue;
      const usage = update.usage as RawGrokUsageBlock | undefined;
      if (!usage || typeof usage !== 'object') continue;

      totals.inputTokens += toNumber(usage.inputTokens);
      totals.outputTokens += toNumber(usage.outputTokens);
      totals.cachedReadTokens += toNumber(usage.cachedReadTokens);
      totals.reasoningTokens += toNumber(usage.reasoningTokens);
      totals.turnCount += 1;

      const modelUsage = usage.modelUsage;
      if (modelUsage && typeof modelUsage === 'object') {
        for (const [model, mu] of Object.entries(modelUsage as Record<string, unknown>)) {
          const total = toNumber((mu as { totalTokens?: unknown })?.totalTokens);
          modelTotals.set(model, (modelTotals.get(model) ?? 0) + total);
        }
      }
    }
  } catch {
    /* mid-stream read error — keep whatever we aggregated so far. */
  } finally {
    rl.close();
  }
}

function pickDominantModel(modelTotals: Map<string, number>): string | null {
  let best: string | null = null;
  let bestTotal = -1;
  for (const [model, total] of modelTotals) {
    if (total > bestTotal) {
      best = model;
      bestTotal = total;
    }
  }
  return best;
}

/**
 * Map summed Grok session usage into the shared {@link TokenUsage} contract, so
 * no parallel shape is introduced (issue #1581 / #1307):
 *   - `inputTokens` = gross input − cached-read (the uncached prompt tokens);
 *   - `outputTokens` = Grok's `outputTokens` verbatim — it ALREADY includes
 *     reasoning tokens (`total === input + output` for every observed record),
 *     so unlike the Codex conversion we do NOT add `reasoningTokens` back;
 *   - `cacheReadTokens` = Grok's cached-read tokens; `cacheWriteTokens` = 0
 *     (Grok reports no cache-write counter).
 *
 * `costUsd` is 0: managed Grok runs on a subscription with no marginal
 * per-token charge, and Grok has no vendor row in the Anthropic/OpenAI pricing
 * tables — token counts are the required compute/attention proxy (issue #1581).
 * `provider` is left unset for the same reason (the field's union is
 * openai/anthropic only; mis-tagging would conflate spend).
 */
export function mapGrokUsageToTokenUsage(usage: GrokSessionUsage): TokenUsage {
  const inputTokens = Math.max(0, usage.inputTokens - usage.cachedReadTokens);
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedReadTokens,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...(usage.model ? { model: usage.model } : {}),
  };
}
