/**
 * Per-model API pricing in USD per million tokens.
 *
 * Two access functions are exported intentionally:
 *
 * - `lookupPricing(model)` — exact-match-only, returns null on miss or on a
 *   row whose input/output rate is non-positive. Used by the cost-comparison
 *   surface (rfc-cost-comparison-panel.md R18). Caller flags the row as
 *   `dataQuality: 'unknown-pricing'`.
 *
 * - `getPricing(model)` — exact-match → prefix-match → silent Sonnet fallback.
 *   Preserves the legacy behavior the existing TokenTracker relied on so live
 *   cost displays don't change as a side effect of this refactor.
 *
 * The dual API is documented in §Pricing-tables of the RFC.
 */
export interface ModelPricing {
  vendor: 'anthropic' | 'openai';
  /** ISO date the rate was verified against the vendor's published pricing. */
  lastVerified: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Pricing rows ship populated or not at all — `lastVerified: 'TBD'` and zero
 * input/output rates are treated as "missing" by `lookupPricing`. Adding a new
 * model REQUIRES populating all four rates and an ISO `lastVerified` date.
 *
 * Anthropic pricing rows are verified against
 *   https://www.anthropic.com/news/claude-opus-4-7
 *   https://www.anthropic.com/news/claude-opus-4-8
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 * Each row's `lastVerified` field records its own verification date.
 *
 * OpenAI verified 2026-05-08 against
 *   https://developers.openai.com/api/docs/pricing
 *   https://developers.openai.com/codex/pricing
 *   https://devtk.ai/en/blog/openai-api-pricing-guide-2026/  (cross-check)
 *
 * The merge gate is the empirically-observed model-name set in the author's
 * last 1500 rollouts: gpt-5.3-codex (69%), gpt-5.4 (31%), gpt-5.4-mini (0.4%).
 * Additional rows are populated proactively so new sessions are priced
 * correctly without a follow-up PR.
 *
 * Cached-input rate for OpenAI = 10% of input rate (matches developer docs
 * convention). GPT-5.6 cache writes are billed at 1.25x input; those rows
 * override the older OpenAI zero-write convention below. Codex's
 * `total_token_usage.input_tokens` includes
 * `cached_input_tokens` — callers must subtract before charging the input rate.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-8':   { vendor: 'anthropic', lastVerified: '2026-07-15', inputPerMTok: 5,    outputPerMTok: 25,  cacheWritePerMTok: 6.25,   cacheReadPerMTok: 0.5   },
  'claude-fable-5':    { vendor: 'anthropic', lastVerified: '2026-07-15', inputPerMTok: 10,   outputPerMTok: 50,  cacheWritePerMTok: 12.5,   cacheReadPerMTok: 1     },
  'claude-opus-4-7':   { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 5,    outputPerMTok: 25,  cacheWritePerMTok: 6.25,   cacheReadPerMTok: 0.5   },
  'claude-opus-4-6':   { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 15,   outputPerMTok: 75,  cacheWritePerMTok: 18.75,  cacheReadPerMTok: 1.875 },
  'claude-sonnet-4-6': { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 3,    outputPerMTok: 15,  cacheWritePerMTok: 3.75,   cacheReadPerMTok: 0.30  },
  'claude-haiku-4-5':  { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 0.80, outputPerMTok: 4,   cacheWritePerMTok: 1,      cacheReadPerMTok: 0.08  },

  // OpenAI — merge-gate rows (cover ≥ 99% of author's rollouts)
  'gpt-5.3-codex':     { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.75, outputPerMTok: 14,   cacheWritePerMTok: 0, cacheReadPerMTok: 0.175 },
  'gpt-5.4':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 2.50, outputPerMTok: 15,   cacheWritePerMTok: 0, cacheReadPerMTok: 0.25  },
  'gpt-5.4-mini':      { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 0.75, outputPerMTok: 4.50, cacheWritePerMTok: 0, cacheReadPerMTok: 0.075 },

  // OpenAI — proactive rows (not merge-blocking; future-proof for new sessions)
  'gpt-5.6-sol':       { vendor: 'openai',    lastVerified: '2026-07-11', inputPerMTok: 5,    outputPerMTok: 30,   cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.50  },
  'gpt-5.6-luna':      { vendor: 'openai',    lastVerified: '2026-07-11', inputPerMTok: 1,    outputPerMTok: 6,    cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.10  },
  'gpt-5.5':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 5,    outputPerMTok: 30,   cacheWritePerMTok: 0, cacheReadPerMTok: 0.50  },
  'gpt-5.5-pro':       { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 30,   outputPerMTok: 180,  cacheWritePerMTok: 0, cacheReadPerMTok: 3.00  },
  'gpt-5':             { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.25, outputPerMTok: 10,   cacheWritePerMTok: 0, cacheReadPerMTok: 0.125 },
  'gpt-5-mini':        { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 0.25, outputPerMTok: 2,    cacheWritePerMTok: 0, cacheReadPerMTok: 0.025 },
  'o3':                { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 2,    outputPerMTok: 8,    cacheWritePerMTok: 0, cacheReadPerMTok: 0.20  },
  'o3-mini':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.10, outputPerMTok: 4.40, cacheWritePerMTok: 0, cacheReadPerMTok: 0.11  },
};

/**
 * Strict, exact-match lookup for the cost-comparison surface (R18). Returns
 * null when (a) the model has no row, or (b) the row's input or output rate
 * is non-positive (placeholder/free-tier zero). Caller flags the row as
 * `dataQuality: 'unknown-pricing'`.
 *
 * No prefix-match. The merge gate (R8) is "every empirically-observed model
 * name has its own row"; prefix-match's suffix-collision and free-tier-zero
 * failure modes are not worth re-introducing.
 */
export function lookupPricing(model: string): ModelPricing | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  if (p.inputPerMTok <= 0 || p.outputPerMTok <= 0) return null;
  return p;
}

const DEFAULT_PRICING_LEGACY: ModelPricing = MODEL_PRICING['claude-sonnet-4-6'];
const warnedUnknownPricingModels = new Set<string>();

/**
 * Legacy lookup for the existing TokenTracker call site. Keeps the
 * exact-match → prefix-match → Sonnet-default behavior so the live cost
 * display does not change shape during the refactor that introduces
 * `lookupPricing`. Warns once per unseen model.
 *
 * New callers SHOULD use `lookupPricing` instead — it does not silently
 * substitute Sonnet pricing for unknown OpenAI models, which would corrupt
 * cross-vendor comparisons.
 */
export function getPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return pricing;
  }
  if (!warnedUnknownPricingModels.has(model)) {
    warnedUnknownPricingModels.add(model);
    console.warn(`[pricing-tables] Unknown pricing model ${JSON.stringify(model)}; using default Sonnet pricing`);
  }
  return DEFAULT_PRICING_LEGACY;
}

/**
 * Estimate USD cost from token counts and a pricing row.
 *
 * Note for OpenAI rollouts: `cached_input_tokens` is a SUBSET of `input_tokens`
 * in Codex's `total_token_usage` (the gross input total includes cached). Pass
 * cached separately and pre-subtract from input on the caller side; this
 * function trusts its inputs and bills each component at its own rate.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok
    + (outputTokens / 1_000_000) * pricing.outputPerMTok
    + (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMTok
    + (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok
  );
}
