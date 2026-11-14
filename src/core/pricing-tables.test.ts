import { describe, test, expect, vi, afterEach } from 'vitest';
import { MODEL_PRICING, lookupPricing, getPricing, resolvePricing, estimateCost } from './pricing-tables.js';
import { CLAUDE_CODE_MODEL_IDS } from '../shared/contracts/agent-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lookupPricing — strict exact-match', () => {
  test('every empirically-observed model name resolves to a real (non-null) row', () => {
    // R8 merge gate: each empirically-observed model in the author's last 1500 rollouts
    // MUST have its own pricing row. If you add an OpenAI model to the disk corpus,
    // add it here and to MODEL_PRICING in the same change.
    const observed = [
      'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
      'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini',
      'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini',
    ];
    for (const m of observed) {
      const p = lookupPricing(m);
      expect(p, `missing pricing for ${m}`).not.toBeNull();
      expect(p!.inputPerMTok, `inputPerMTok for ${m}`).toBeGreaterThan(0);
      expect(p!.outputPerMTok, `outputPerMTok for ${m}`).toBeGreaterThan(0);
      expect(p!.lastVerified, `lastVerified for ${m}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('every Claude Code allowlisted model id has its own pricing row', () => {
    // Drift guard: a model offered in the launch picker must not silently fall
    // back to Sonnet 4.6 pricing in the cost tracker (that happened to
    // claude-sonnet-5, allowlisted in #1518 without a pricing row).
    for (const m of CLAUDE_CODE_MODEL_IDS) {
      const p = lookupPricing(m);
      expect(p, `missing pricing for allowlisted ${m}`).not.toBeNull();
      // lookupPricing validates rates but not lastVerified; a 'TBD' placeholder
      // would otherwise slip through this guard.
      expect(p!.lastVerified, `lastVerified for ${m}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('uses published rates for Fable 5.2 (reduced-rate cache reads: 2.5% of input)', () => {
    expect(lookupPricing('claude-fable-5-2')).toMatchObject({
      inputPerMTok: 8,
      outputPerMTok: 40,
      cacheWritePerMTok: 10,
      cacheReadPerMTok: 0.20,
    });
  });

  test('pins the rate pairs that differ only in cache reads (Sonnet 5 vs 5.5) and Haiku 5.5', () => {
    // claude-sonnet-5 and claude-sonnet-5-5 share input/output/cache-write and
    // differ ONLY in cacheReadPerMTok — a row transposition would pass the
    // drift guard, so pin both explicitly.
    expect(lookupPricing('claude-sonnet-5-5')).toMatchObject({
      inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.10,
    });
    expect(lookupPricing('claude-sonnet-5')).toMatchObject({
      inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.20,
    });
    expect(lookupPricing('claude-opus-5-5')).toMatchObject({
      inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.20,
    });
    expect(lookupPricing('claude-fable-5-1')).toMatchObject({
      inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 0.25,
    });
    // Base (≤100K-prompt) tier — the >100K tier is 5x and not modeled.
    expect(lookupPricing('claude-haiku-5-5')).toMatchObject({
      inputPerMTok: 0.10, outputPerMTok: 0.50, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.01,
    });
  });

  test('uses current Anthropic API rates for Opus 4.8 and Fable 5', () => {
    expect(lookupPricing('claude-opus-4-8')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.5,
    });
    expect(lookupPricing('claude-fable-5')).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheReadPerMTok: 1,
    });
  });

  test('uses current published rates for legacy Opus 4.6 and Haiku 4.5 (issue #3560)', () => {
    // These rows were stale for months (Opus 4.6 at the old $15/$75 Opus-4
    // rate, Haiku 4.5 at the Haiku 3.5 rate). Pin the corrected values.
    expect(lookupPricing('claude-opus-4-6')).toMatchObject({
      inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.50,
    });
    expect(lookupPricing('claude-haiku-4-5')).toMatchObject({
      inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.10,
    });
  });

  test('returns null for unknown model (no prefix-match fallback)', () => {
    expect(lookupPricing('claude-opus-99')).toBeNull();
    expect(lookupPricing('gpt-7')).toBeNull();
    expect(lookupPricing('')).toBeNull();
  });

  test('does NOT prefix-match — gpt-5.3-codex-spark resolves to null even though gpt-5.3-codex exists', () => {
    // Prefix-match would falsely resolve `gpt-5.3-codex-spark` to the `gpt-5.3-codex`
    // row; strict exact-match returns null and the caller flags `unknown-pricing`.
    // This is a regression test for round-3 failure-mode-analyst F9.
    expect(lookupPricing('gpt-5.3-codex-spark')).toBeNull();
    expect(lookupPricing('gpt-5.3-codex-mini')).toBeNull();
  });

  test('returns null when input or output rate is non-positive (free-tier zero / placeholder)', () => {
    // Round-3 failure-mode-analyst F4: a row that ships with placeholder zeros
    // must be treated as unknown rather than as "free".
    const original = MODEL_PRICING['claude-haiku-4-5'];
    try {
      MODEL_PRICING['__test_zero__'] = {
        vendor: 'openai', lastVerified: '2026-05-08',
        inputPerMTok: 0, outputPerMTok: 0,
        cacheWritePerMTok: 0, cacheReadPerMTok: 0,
      };
      MODEL_PRICING['__test_negative_input__'] = {
        vendor: 'openai', lastVerified: '2026-05-08',
        inputPerMTok: -1, outputPerMTok: 5,
        cacheWritePerMTok: 0, cacheReadPerMTok: 0,
      };
      MODEL_PRICING['__test_zero_output__'] = {
        vendor: 'openai', lastVerified: '2026-05-08',
        inputPerMTok: 5, outputPerMTok: 0,
        cacheWritePerMTok: 0, cacheReadPerMTok: 0,
      };
      expect(lookupPricing('__test_zero__')).toBeNull();
      expect(lookupPricing('__test_negative_input__')).toBeNull();
      expect(lookupPricing('__test_zero_output__')).toBeNull();
    } finally {
      delete MODEL_PRICING['__test_zero__'];
      delete MODEL_PRICING['__test_negative_input__'];
      delete MODEL_PRICING['__test_zero_output__'];
      MODEL_PRICING['claude-haiku-4-5'] = original;
    }
  });

  test('cache rates may legitimately be 0 for non-caching models', () => {
    // Older OpenAI rows ship `cacheWritePerMTok: 0` because those APIs do not
    // bill cache writes; GPT-5.6 rows use their separately published write rate.
    // Only input/output non-positivity disqualifies a row.
    const codex = lookupPricing('gpt-5.3-codex');
    expect(codex).not.toBeNull();
    expect(codex!.cacheWritePerMTok).toBe(0);
    expect(codex!.cacheReadPerMTok).toBeGreaterThan(0);
  });

  test('GPT-5.6 Luna and Sol use their published token and cache rates', () => {
    expect(lookupPricing('gpt-5.6-luna')).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 6,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.1,
    });
    expect(lookupPricing('gpt-5.6-sol')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 30,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.5,
    });
  });

  test('gpt-6-astra uses its published token and cache rates', () => {
    expect(lookupPricing('gpt-6-astra')).toMatchObject({
      vendor: 'openai',
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheWritePerMTok: 12.5,
      cacheReadPerMTok: 1,
    });
  });
});

describe('getPricing — legacy fallback for existing TokenTracker', () => {
  test('exact-match returns the row', () => {
    const p = getPricing('claude-opus-4-7');
    expect(p.inputPerMTok).toBe(5);
  });

  test('prefix-match resolves dated Anthropic IDs (claude-opus-4-7-20260424 → claude-opus-4-7)', () => {
    // Backward-compat: real Claude Code transcripts contain dated model IDs.
    const p = getPricing('claude-opus-4-7-20260424');
    expect(p.inputPerMTok).toBe(5);
    expect(p.outputPerMTok).toBe(25);
  });

  test('longest-prefix wins when a shorter sibling key would also match', () => {
    // MODEL_PRICING lists `gpt-5.5` before `gpt-5.5-pro`. First-hit prefix would
    // bind the pro dated id to the cheaper base row; longest-prefix must not.
    const p = getPricing('gpt-5.5-pro-20260101');
    expect(p.inputPerMTok).toBe(MODEL_PRICING['gpt-5.5-pro'].inputPerMTok);
    expect(p.outputPerMTok).toBe(MODEL_PRICING['gpt-5.5-pro'].outputPerMTok);
    expect(p.inputPerMTok).not.toBe(MODEL_PRICING['gpt-5.5'].inputPerMTok);
  });

  test('unknown model falls back to Sonnet (silent — only warn-once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p1 = getPricing('totally-unknown-model-xyz');
    const p2 = getPricing('totally-unknown-model-xyz');                // second call must not re-warn
    expect(p1.inputPerMTok).toBe(3);                                   // Sonnet
    expect(p2.inputPerMTok).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('totally-unknown-model-xyz');
  });
});

describe('resolvePricing — match honesty', () => {
  test('exact key is exact', () => {
    expect(resolvePricing('claude-opus-4-8').match).toBe('exact');
  });

  test('dated id that longest-prefix-matches is prefix, not fallback', () => {
    const r = resolvePricing('claude-opus-4-8-20260115');
    expect(r.match).toBe('prefix');
    expect(r.pricing.inputPerMTok).toBe(MODEL_PRICING['claude-opus-4-8'].inputPerMTok);
  });

  test('prefix match stops at a `-` boundary: dated Fable 5 ids do not bind to the Fable 5.2 row', () => {
    // `claude-fable-5-20260715` is a dated snapshot of claude-fable-5 ($10/$50).
    // Without the boundary, longest-prefix would bind it to the longer sibling
    // key `claude-fable-5-2` ($8/$40) because the version digit abuts the date.
    const dated = resolvePricing('claude-fable-5-20260715');
    expect(dated.match).toBe('prefix');
    // Row identity (not just rate equality) keeps this discriminating even if
    // the two Fable rows' rates ever converge.
    expect(dated.pricing).toBe(MODEL_PRICING['claude-fable-5']);

    // The sibling still resolves exactly, and its own dated ids still prefix to it.
    expect(resolvePricing('claude-fable-5-2').match).toBe('exact');
    const datedSibling = resolvePricing('claude-fable-5-2-20270101');
    expect(datedSibling.match).toBe('prefix');
    expect(datedSibling.pricing).toBe(MODEL_PRICING['claude-fable-5-2']);

    // Refusal direction of the boundary (intended): a non-`-` extension no
    // longer prefix-matches at all and falls to the Sonnet default.
    expect(resolvePricing('claude-fable-5x').match).toBe('fallback');
  });

  test('unknown model is fallback Sonnet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = resolvePricing('no-such-model');
    expect(r.match).toBe('fallback');
    expect(r.pricing.inputPerMTok).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('estimateCost — arithmetic spot-check', () => {
  test('1M input tokens × $5 = $5.00 (claude-opus-4-7 input rate)', () => {
    const p = lookupPricing('claude-opus-4-7')!;
    expect(estimateCost(1_000_000, 0, 0, 0, p)).toBeCloseTo(5);
  });

  test('1M output tokens × $25 = $25.00 (claude-opus-4-7 output rate)', () => {
    const p = lookupPricing('claude-opus-4-7')!;
    expect(estimateCost(0, 1_000_000, 0, 0, p)).toBeCloseTo(25);
  });

  test('mixed token counts sum each rate independently', () => {
    const p = lookupPricing('claude-sonnet-4-6')!;
    // 100k input × 3 + 50k output × 15 + 10k cacheWrite × 3.75 + 200k cacheRead × 0.30
    // = 0.3 + 0.75 + 0.0375 + 0.06 = 1.1475
    expect(estimateCost(100_000, 50_000, 10_000, 200_000, p)).toBeCloseTo(1.1475, 4);
  });

  test('OpenAI Codex row with zero cache-write rate produces zero cache-write contribution', () => {
    const p = lookupPricing('gpt-5.3-codex')!;
    // 1M input × 1.75 + 0 output + 1M cacheWrite × 0 + 0 cacheRead = 1.75
    expect(estimateCost(1_000_000, 0, 1_000_000, 0, p)).toBeCloseTo(1.75);
  });
});
