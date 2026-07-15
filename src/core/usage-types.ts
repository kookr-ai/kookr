// Per-task token usage aggregation
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /**
   * Billing vendor the `costUsd` estimate was priced against. Tags the record
   * so cross-vendor spend is not conflated — e.g. a `codex-cli` task priced
   * against an OpenAI model reports `provider: 'openai'` even though the rest
   * of the dashboard is Anthropic-billed (issue #1307). Absent on legacy rows
   * and on aggregates that mix vendors.
   */
  provider?: 'openai' | 'anthropic';
  /** Model name the `costUsd` estimate was priced against (e.g. `gpt-5.3-codex`). */
  model?: string;
  /** Whether transcript-derived pricing used only strict exact rows; prefix/default estimates are fallback. */
  pricingQuality?: 'exact' | 'fallback';
}
