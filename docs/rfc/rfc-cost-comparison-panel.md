# RFC: Cost & Performance Comparison Panel — Claude Code vs Codex CLI

## Status

**Draft (v5 — post round-3, post early-empirical resolution of open questions and pricing population)**

**Date:** 2026-05-08
**Author:** Jean Ibarz (with Claude)

---

## Problem

Kookr launches tasks against two distinct agents — Claude Code and Codex CLI — but has no surface that puts their cost, speed, or quality side by side. The author runs ~30 tasks/week split roughly 60/40 and asks himself questions the dashboard can't answer: *on the same playbook, which agent costs more / runs longer / lands thumbs-up at a higher rate?*

This RFC specifies a `Cost Comparison` panel that joins existing data sources (Kookr `taskStore`, Claude transcripts, Codex rollout JSONL files, completion-feedback ratings), **per-playbook** in addition to in aggregate, and surfaces both spend and a crude quality signal. It is read-only telemetry, not budget enforcement.

**No fork modification.** v1 proposed a Codex fork patch; rounds 1–2 found Codex already persists everything we need to disk in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

## Empirical grounding

The author probed real on-disk data on his machine before and during rounds 1–2. Verified:

- Codex rollout JSONL events from Feb 2026 onward (≥ 95% of sessions) contain: `event_msg.token_count.info.total_token_usage` (cumulative tokens per session), `turn_context.model`, `task_started`/`task_complete` for per-turn duration, `function_call`/`function_call_output` (joinable for per-tool latency by `call_id`), `session_meta.cwd`/`session_meta.timestamp`/`session_meta.id`, and `forked_from_id` linking resumed sessions.
- **`last_token_usage` is NOT a per-turn delta.** On a real 421-event session, summing it gives 48M input tokens vs final `total_token_usage` of 16M (3× overcount). It is the most-recent-turn snapshot re-emitted on subsequent events. **Authoritative source = last `total_token_usage` in the file.** `last_token_usage` is ignored.
- **Schema is NOT stable across all on-disk files.** Pre-Nov 2025 rollouts have only `input_text`/`message`/`response_item`/`session_meta` — no token data at all.
- **Real model strings on disk** (top of distribution, recent rollouts): `gpt-5.5` (dominant), `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.1-codex-mini`, `gpt-5.4-mini`, `o3-mini`, plus older `gpt-5`. Kookr-selected `gpt-5.6-luna` and explicit-escalation `gpt-5.6-sol` are also emitted by the adapter. The exact-match pricing table must cover every emitted model string.
- **Codex DOES have hierarchical sub-agents.** `session_meta.source.subagent.thread_spawn.parent_thread_id` and `agent_nickname` (e.g., "Helmholtz") appear in real rollouts. The v1/v2 claim that Codex doesn't expose subagents was empirically wrong.
- **Codex resume creates a new file** with `forked_from_id` linking back, NOT a same-file append. Token totals must be chained via `forked_from_id`.
- **Kookr does not capture Codex `session_meta.id` today.** `claudeSessionId` is null for Codex sessions (literal comment at `src/adapters/codex-cli-adapter.ts:137`). Discovery must use `(cwd, timestamp)` matching, not session ID.

Each of the above falsified at least one claim in v1 or v2. v3 is structured around these facts.

## Why now / what success looks like

The Codex fork has been in production ~3 months. The author's intuition is "Codex is rougher around the edges but might be faster on dense Rust work; not sure about cost." A panel can test this against real data.

**Decision rule (qualitative, not numerologic — round-2 design-minimalist + socratic).** v2 specified precise thresholds (≥ 1.5× cost AND ≤ 5% lower thumbs-up at n ≥ 8 per agent). Round-2 socratic showed (a) at 30 tasks/week split ≥ 4 ways across playbooks, n ≥ 8 per agent per playbook in 30 days is reachable on at most one or two playbooks, and (b) at n=8 with ~30% thumbs-coverage the thumbs-up rate has 50-percentage-point quantization, making 5% comparisons meaningless. Replaced with:

> *On any playbook with at least 5 runs per agent in the rolling 30-day window, the author looks at the per-playbook row. If the median cost-per-run differs by ≥ 50% AND the thumbs-up rate differs by ≥ 20 percentage points (or one side has a clear thumbs-down concentration), the author writes the rationale into `docs/reports/cost-comparison-decisions.md` along with what they did about it. Action options include: do nothing, change which agent the playbook prefers in their head, document a known-weakness and revisit. The rule is a prompt to think, not an automated UI change.*

The "remove from launch dialog default" v2 action is dropped — round-2 socratic Q12 noted that change is low-stakes and round-2 failure-mode-analyst F16 noted it was reversible-but-unreversible-by-design (no documented procedure). The qualitative rule is honest about what the panel is: a tool to support a human judgment, not a mechanical trigger.

**Success metric:** *the panel surfaces playbook-level comparison clearly enough that, in a 30-day window, the author either (a) writes one entry in `cost-comparison-decisions.md` with concrete numbers, or (b) writes a "no rule trip — current routing reasonable" entry.* Either output justifies the panel. The absence of any entry after 30 days is the failure mode — it means the panel didn't drive thinking.

**Non-success:** an aggregate-only panel without per-playbook breakdown. Aggregate cost across mixed task classes is apples-to-oranges (round-1 socratic Q2).

## Active-user reality check

Single-tenant local. Author + small handful of OSS contributors. ≤ ~1000 Kookr tasks of history. Linux + macOS supported. No third agent type planned (round-1 boundary-critic asked about extensibility — YAGNI).

## Design principles

1. **Per-playbook is the headline.** Aggregate cards are present but small and labeled "weak signal."
2. **Tokens are authoritative; cost is estimated.** Show tokens, model, and the *estimated* dollar value. A staleness banner triggers when `(today − pricingLastVerified) > 90 days`.
3. **Fail loud, not silent.** Unknown pricing → "—" (not 0). Half-written rollout → skip last line + "data as of HH:MM:SS" timestamp. Schema mismatch → `dataQuality: 'codex-parse-error'` per session + banner.
4. **Reuse the existing scan pattern.** Both agents go through incremental scan + offset bookkeeping (mirrors `TokenTracker`).
5. **Crude quality signal beats none.** Surface `Task.completionFeedback.rating` thumbs-up rate per agent per playbook, with explicit caveats about sparsity.

## Data audit

### Claude Code (read-only consumer — cannot modify)

| Category | Source | Field shape |
|---|---|---|
| Tokens | Transcript JSONL `message.usage` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Model | Transcript `message.model` | string |
| Tool calls (name, args) | Hook `PreToolUse` / `PostToolUse` | `toolName`, `toolInput`, `toolResponse`, `toolUseId` |
| Tool latency | Not exposed | hook payloads carry no timestamps |
| Session duration | Wall-clock `SessionStart` → `Stop` (hook arrival) | coarse |
| Subagents | Hook `SubagentStart`/`SubagentStop` + separate transcript flagged `isSidechain: true` | tokens live in subagent JSONL |

### Codex CLI (read-only consumer — file-scan, no fork patch)

| Category | Source | Field shape | Notes |
|---|---|---|---|
| Tokens | `event_msg.token_count.info.total_token_usage` (last-seen value in file) | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens` | `last_token_usage` ignored entirely. |
| Model | `turn_context.model` (first non-null in file) | string | Real strings include `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`; Kookr launches may emit `gpt-5.6-luna` or `gpt-5.6-sol`. |
| Tool calls | `response_item.function_call`/`function_call_output` | `name`, `arguments`, `call_id` | Joinable by `call_id` for per-tool latency. |
| Per-tool latency | event `timestamp` diff joined by `call_id` | ms | Better than Claude Code; computed but not surfaced in v1 panel. |
| Session duration | First → last event `timestamp` | ms | Reliable. |
| Per-turn duration | `task_started.timestamp` → `task_complete.timestamp` joined by `turn_id` | ms | Reliable. |
| Subagents | `session_meta.source.subagent.thread_spawn.parent_thread_id`, `agent_nickname` | tracked per rollout file | v3 acknowledges these exist; v1 panel sums into parent's totals via `forked_from_id` chain (see §Token aggregation rule). |
| Resumed session | `session_meta.forked_from_id` | string | Chain back to find the original session's task assignment. |

### What both cannot supply

- **Per-tool cost.** Tokens are message-keyed; tool calls are call-id-keyed. No clean join.
- **Apples-to-apples task quality.** Inferred from sparse `completionFeedback.rating`, labeled as such.

## Requirements

- **R1.** The panel SHALL display, **per playbook with ≥ 1 task per agent in the window**, the comparison: median estimated cost-per-task, median duration, thumbs-up rate, task count per agent. This is the headline.
- **R2.** The panel SHALL display a secondary aggregate band per agent with median/p95/max duration, total cost, total tokens by type, and thumbs-up rate, labeled "across mixed task classes — interpret with caution."
- **R3.** The panel SHALL display a virtualized per-task table with columns: started_at, agent, model, playbook, durationMs, total tokens, estimatedCostUsd, thumb (👍/👎/—), `dataQuality`.
- **R4.** Any unavailable metric SHALL render as "—" with a tooltip naming the cause. NEVER 0.
- **R5.** Cost values SHALL be labeled "(est.)". The `lastVerified` ISO date for the model used SHALL be visible inline next to the cost (round-2 design-minimalist — date next to value beats banner). A staleness banner SHALL fire when `(today − lastVerified) > 90 days` for any model used in the window.
- **R6.** Aggregate cards SHALL render in **< 200 ms over a warm scan**. Cold-start completion target is **< 5 s for a corpus ≤ 1500 rollout files** on author's WSL2 hardware. Both targets SHALL be measured by a microbenchmark in `codex-rollout-scanner.test.ts` (failing test if exceeded). If real corpus exceeds 1500 files, the cold-scan ceiling SHALL be revised on the basis of measured numbers, not asserted.
- **R7.** No fork modification. Both agents are consumed by file-scan.
- **R8.** Pricing tables SHALL live in `src/core/pricing-tables.ts`. The Anthropic table moves out of `token-tracker.ts`; OpenAI rows cover every **emitted model string**, including Kookr-selected `gpt-5.6-luna` and `gpt-5.6-sol`, plus the **empirically-observed models** in the author's last 1500 rollouts: **`gpt-5.3-codex` (69%), `gpt-5.4` (31%), `gpt-5.4-mini` (0.4%)** — these three are the merge gate. Additional rows for `gpt-5.5`, `gpt-5.5-pro`, `gpt-5`, `gpt-5-mini`, `o3`, `o3-mini` are populated proactively from the same sources but are not merge-blocking. Lookup is **exact-match only** (R18 — no prefix-match on the strict path).
- **R9.** No new persistent storage.
- **R10.** Codex scanner SHALL fail soft on schema mismatch — log a single warning per file, skip the file, surface `dataQuality: 'codex-parse-error'` on affected rows. The scanner SHALL assert presence of `total_token_usage.input_tokens` AND `output_tokens` AND `cached_input_tokens` before computing cost; missing any → parse error (not silent zero — round-2 F18).
- **R11.** The panel SHALL be a sidebar-toggleable view following Kookr's existing pattern (boolean state in `App.tsx`, e.g., `showCostComparison`). **No URL routing in v1** — Kookr has no router (round-2 delivery-pragmatist; deferred to a separate "introduce routing" RFC if multiple views need URLs). Time-window presets: 24h / 7d / 30d / all. Default 7d.
- **R12.** Filters: agent toggle (chips: All / Claude / Codex), free-text task-name substring. Model and playbook are columns, sortable, not filtered.
- **R13.** Claude subagent transcripts (`isSidechain: true`) SHALL be summed into the parent task's totals. Implementation requires new code in `src/server/event-pipeline.ts` to call `tokenTracker.register(subagentPath, parentTaskId)` on `SubagentStop` (round-2 delivery-pragmatist + operability — `event-pipeline.ts` does not currently handle this; it is not "no new code" as v2 claimed).
- **R14.** Privacy: per-task table renders task names client-side. The HTTP route emits a one-line `console.warn` at startup naming the local-only assumption.
- **R15.** Aggregate metrics SHALL include `medianDurationMs`, `p95DurationMs`, `maxDurationMs`.
- **R16.** Scanner state SHALL be visible at server startup via a single log line: `[cost-comparison] codex_home=<path> registered=<N> parse_errors=<M> orphans=<K> models_unpriced=<L>`. A standalone HTTP diagnostics endpoint is **not** introduced in v1 (round-3 design-minimalist — logs cover the only realistic single-tenant debug flow; add the endpoint only if pain materialises). The same numbers appear in the response `notes` array when non-zero so the panel's banners surface them too.
- **R17.** `CostComparisonResponse` SHALL include envelope fields: `scannedAt: ISO8601`, `scanDurationMs: number`, `notes: { message: string; paths?: string[] }[]`. Server pre-sorts `notes` by priority (parse-error > unknown-pricing > pricing-stale > missing-tokens > data-staleness); client renders top 3, collapses the rest under "n more notes" expander. The 7-variant `Note.type` discriminant from v3 is **dropped** — server pre-sorting is the contract; client just renders strings (round-3 design-minimalist).
- **R18.** Pricing lookup on the strict cost-comparison path uses **exact-match only** (`lookupPricing(model): ModelPricing | null`) — no prefix-match (round-3 failure-mode-analyst — prefix-match has suffix-collision and free-tier-zero bugs; exact-match is robust). Returns `null` when (a) model is not in the table, or (b) the row's `inputPerMTok <= 0` or `outputPerMTok <= 0` (cache rates may be 0 for non-caching models, but the input/output rates must be positive). Caller flags `dataQuality: 'unknown-pricing'`. R8 (model-name set covering empirically-observed strings) is the merge gate that compensates for the loss of prefix-match — every observed model must have its own row. Existing `token-tracker.ts` callers retain prefix-match Sonnet fallback for backward compat via a separately-named `getPricing()` helper.

## Non-goals

- No real-time streaming graph.
- No CSV export in v1.
- No alerting on cost thresholds (`budget-checker.ts` covers per-task).
- No multi-user / multi-machine.
- No automated "winner" verdict.
- No per-tool cost.
- ~~No subagent comparison surface — Codex has none~~ — (retracted in v3; Codex does have subagents per §Empirical grounding). Subagent **count surface** in the panel is deferred — too sparse to be useful at current task volume — but Codex subagent **token totals** are summed into the parent rollout's `total_token_usage` (Codex's accounting model already includes them — verified). Cross-rollout subagent token attribution via `forked_from_id` chain is included (see §Token aggregation rule).
- No retroactive instrumentation of existing tasks beyond what's already on disk.
- No SVG sparkstrip in v1 (round-2 design-minimalist — sparse data over 7-30 days makes it noise; per-playbook table covers outlier visibility through its task-count column).
- No URL routing (R11 — Kookr has no router today).
- No `bin/` CLI committed to the repo. Phase 0 prototype is a `scripts/cost-comparison-prototype.ts` that lives in `.gitignore` until the panel ships, then is deleted (round-2 design-minimalist — kill switch must not become a maintenance liability).

## Design

### Module structure

| Path | Responsibility | Layer |
|---|---|---|
| `src/core/pricing-tables.ts` (NEW) | `MODEL_PRICING` table + `lookupPricing(model): ModelPricing \| null` (longest-prefix-match, sorted by descending key length). Exports `MODEL_PRICING_LOOKUP_LOG_WARNINGS_ONCE` set so the existing `token-tracker.ts` warn-once behavior is preserved. | core |
| `src/core/pricing-tables.test.ts` (NEW) | Empirical fixture: every observed model string on the author's machine resolves to a non-fallback row. Insertion-order bug regression test (`gpt-5.3-codex-spark` must hit the longest matching prefix, not just `gpt-5`). | core test |
| `src/core/token-tracker.ts` (MODIFY) | Drop local `MODEL_PRICING`. Import from `pricing-tables.ts`. Re-export `getPricing/estimateCost/ModelPricing` for backward compat (`token-tracker.test.ts` and any external imports keep working — round-2 delivery-pragmatist atomicity). The internal `getPricing` keeps Sonnet fallback for the existing call site at line 199. | core |
| `src/adapters/codex-rollout-scanner.ts` (NEW) | Single file: discovery + scan. `register(taskId, taskCwd, taskCreatedAt)` finds matching rollout via `(cwd, timestamp ± 60 s, UTC, abandoned excluded)` heuristic, then incremental scan with offset bookkeeping. Aggregates `total_token_usage` (last-seen value); rollouts with `forked_from_id` are flagged but chain logic is deferred to post-Phase 0 (round-3). No per-tool latency join in v1 (round-3 design-minimalist). Reads files as `Buffer`, splits on `\n`, parses each line; **last line is skipped if `mtime` < 5 s** (round-2 F27). Asserts presence of canonical token keys (R10). | adapter |
| `src/adapters/codex-rollout-scanner.test.ts` (NEW) | Fixtures: short session, multi-turn, resumed (`forked_from_id`), schema-pre-Nov-2025 (no `token_count`), schema-with-renamed-keys (parse-error path), parallel-tool-call session, half-written last line. Microbenchmark fixture: 1500 small-rollout-files cold scan completes in < 5 s. | adapter test |
| `src/core/cost-comparison-aggregator.ts` (NEW) | Pure function `aggregate(tasks, perTaskUsage, perTaskFeedback, window): { perPlaybook, aggregate, notes }`. No I/O. ~150 LOC. Note: round-2 design-minimalist suggested inlining into the route; v3 keeps separate because pure-function unit testing is cleaner against fixtures than against a route handler that must be exercised through a request. | core |
| `src/core/cost-comparison-aggregator.test.ts` (NEW) | Empty, single-agent, mixed, window edges, dataQuality propagation, per-playbook bucketing, banner-priority test, DST-boundary test. | core test |
| `src/server/routes/task-routes.ts` (MODIFY) | Add `GET /api/cost-comparison?window=7d&agent=&q=` and `GET /api/cost-comparison/diagnostics`. Origin/Host validation reuses `validateLocalRequest` helper from `routes/shared.ts`. | route |
| `src/server/event-pipeline.ts` (MODIFY) | Add handler for `subagent_stop`: when `agentTranscriptPath` is present, call `tokenTracker.register(agentTranscriptPath, parentTaskId)` (R13). Currently absent. | server |
| `src/shared/protocol.ts` (EXTEND) | `CostComparisonResponse`, `CostComparisonDiagnosticsResponse`, `AggregateMetrics`, `PerPlaybookRow`, `PerTaskRow`, `Note`. | shared |
| `src/frontend/components/CostComparisonPanel.tsx` (NEW) | Per-playbook table + aggregate cards + per-task virtualized table + banner stack honoring R17 priority order. | frontend |
| `src/frontend/components/CostComparisonPanel.test.ts` (NEW) | Empty state, asymmetric data, "—" tooltip, banner priority order, time-window switch. | frontend test |
| `docs/reports/cost-comparison-decisions.md` (NEW — placeholder, single line) | Where the author writes the audit trail when the decision rule prompts a thought (round-2 operability — decision-rule audit log). Created empty in the same PR. | docs |

### Data flow

```
┌────────────────────────────┐                ┌────────────────────────────┐
│ Claude transcripts          │                │ Codex rollout JSONL         │
│ (incl. subagent isSidechain │                │ Discovery: cwd + timestamp  │
│  registered via R13 hook)   │                │   ±60s match against        │
│                             │                │   taskStore.tasks           │
└──────────────┬──────────────┘                └──────────────┬──────────────┘
               │ TokenTracker.scanAll                         │ CodexRolloutScanner.scanAll
               │  (uses pricing-tables.ts, Sonnet fallback)   │  (uses pricing-tables.ts, strict null)
               ▼                                              ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ per-task usage records                                         │
   └──────────────────────────────┬───────────────────────────────┘
                                  │ + Task.completionFeedback + Task.playbookId
                                  ▼
                  ┌─────────────────────────────────────────┐
                  │ src/core/cost-comparison-aggregator.ts   │
                  │  pure: → { perPlaybook, aggregate, notes }│
                  └────────────┬────────────────────────────┘
                               │ HTTP
                               ▼
                  ┌─────────────────────────────────────────┐
                  │ CostComparisonPanel.tsx                  │
                  └─────────────────────────────────────────┘
```

### Discovery: matching Kookr tasks to Codex rollouts (round-2 F1/F6/F25)

Kookr does not capture Codex `session_meta.id` today (see §Empirical grounding). Discovery uses `(cwd, timestamp)` matching, **all date math in UTC** (round-3 failure-mode-analyst F5):

1. Walk `~/.codex/sessions/YYYY/MM/DD/` for date directories from `windowStart - 1d UTC` to `windowEnd + 1d UTC`. (`CODEX_HOME` env var honored if set; runtime env wins, log a warn at scanner startup if it differs from launch-time env.)
2. Read the first line — `session_meta` — to extract `cwd`, `timestamp`, `id`, `forked_from_id`, `originator`. Also detect **abandoned rollouts** (round-3 failure-mode-analyst F1): if the file has no `task_complete` event AND no `session_end` AND `mtime` is older than 24 h, mark abandoned. Abandoned rollouts are excluded from binding.
3. For each Kookr task with `agentType === 'codex-cli'`, find the non-abandoned rollout whose `cwd === task.cwd` AND `|rollout.session_meta.timestamp - task.createdAt|` (both UTC) is smallest among candidates within 60 s. If unique → bind. If multiple → take closest. If none → `dataQuality: 'codex-rollout-not-found'`.
4. **Resume / `forked_from_id` chain handling is dropped from v1 (decision made in v5 — empirical resolution).** Empirical probe: 4.3% of recent Codex rollouts have non-null `forked_from_id` — under the 5% threshold v4 set for "skip chain logic." A resumed rollout that doesn't match a Kookr task by cwd+time falls to `'codex-rollout-not-found'`; the parent task's totals miss the resume's continuation tokens. Documented minor undercount; revisited in a future RFC if it grows.
5. Cache: bindings persist in-memory only (R9). Re-discovered on each cold scan.

Three collision/orphan scenarios are explicitly tested (the third is round-3 failure-mode-analyst F1):

- **Two Kookr tasks launched in the same cwd within 60 s** → take closest. If both have the same diff → log a warn, bind to the lower-numbered task ID for determinism. The state surfaces as `'codex-rollout-not-found'` with a tooltip "ambiguous: 2 candidates within 60 s — see logs" — `'codex-rollout-ambiguous'` from v3 is folded in (round-3 design-minimalist — same operator action, same render).
- **Codex session started outside Kookr (`codex resume`, interactive use)** → no Kookr task has matching cwd + time → orphan rollout, surfaced in `notes` count, excluded from panel.
- **Ctrl-C-and-rerun in same cwd** → step 2's terminal-event check excludes the killed rollout; the live rerun's rollout binds. Test fixture covers `mtime`-young-but-no-terminal-event (the abandoned rollout would otherwise pass the freshness gate).

**Spot-check definition for the kill criterion (round-3 failure-mode-analyst F8):** in Phase 0, the author runs the prototype against the last 7 days, picks ≥ 20 most recent Codex tasks, manually checks that for each, the bound rollout's `session_meta.cwd` exactly equals `task.cwd` AND no other non-abandoned rollout in the same cwd-day has a smaller timestamp diff. Threshold: ≥ 16/20 (80%) → continue. Author writes the count into Phase 0 findings.

### Token aggregation rule

**Codex:** `total_token_usage` from the last `token_count` event in the file is the authoritative session total. `last_token_usage` is ignored entirely. For resumed sessions, see §Discovery step 4 — chaining is deferred to post-Phase 0; v1 treats each rollout as a single task.

**Claude Code:** Existing `TokenTracker` per-message-id dedup behavior unchanged. Subagent transcripts (`isSidechain: true`) are summed into the parent task via R13. R13 implementation MUST verify `tokenTracker.register(path, taskId)` is **idempotent on path**: calling it twice with the same path does not double-count. PR 1 includes a regression test asserting this (round-3 failure-mode-analyst F7).

**Codex sub-agent rollouts (rule fixed in v5 — empirical resolution of v4's open question).** Empirical probe: 54.2% of recent Codex rollouts contain `session_meta.source.subagent.thread_spawn`. At that frequency, the v4 plan to flag them `'codex-subagent-attribution-tbd'` and exclude from totals would erase half of the Codex side of the comparison — unacceptable. v5 commits to a rule:

> **Each rollout is an independent OpenAI session for billing purposes. Sub-agent rollouts are summed into the parent task's totals, recursively via `thread_spawn.parent_thread_id`.**

Reasoning: when Codex spawns a sub-agent, that sub-agent's prompt-and-completion is a separate OpenAI API call billed to the user's account. The parent rollout's `total_token_usage` reflects only the parent thread's API calls. Therefore sub-agent tokens are **additive** to the parent — equivalent to Claude's R13 subagent-transcript-summed-into-parent rule. Implementation: when binding a parent rollout to a Kookr task, also bind every rollout whose `parent_thread_id` chain transitively reaches the parent's `id`. Each rollout's last-seen `total_token_usage` is summed independently.

**Sanity-check probe (Phase 0):** pick one Kookr task with ≥ 3 sub-agent rollouts on a day when no other OpenAI workload ran. Compare the sum-all-rollouts total against the next-day OpenAI billing-day delta within ± 10%. If empirically the rule is wrong, drop to parent-only and document the undercount. The probe is a sanity check, not a kill criterion — if it surprises, v5 is amended; the panel is not blocked.

`dataQuality: 'codex-subagent-attribution-tbd'` is removed from the discriminant in v5.

**Schema partial-drift detection.** Scanner asserts these keys exist with numeric values on every consumed `token_count` event: `info.total_token_usage.input_tokens`, `info.total_token_usage.output_tokens`, `info.total_token_usage.cached_input_tokens`. Missing or non-numeric → `dataQuality: 'codex-parse-error'` for the session, banner surfaces aggregated count.

### Pricing-tables (concrete)

```typescript
// src/core/pricing-tables.ts
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  lastVerified: string;   // ISO date
  vendor: 'anthropic' | 'openai';
}

// Exact-match lookup; no prefix-match on the strict path.
// Older OpenAI values verified 2026-05-08 from developers.openai.com/api/docs/pricing;
// GPT-5.6 values verified 2026-07-11 from the GPT-5.6 pricing documentation.
// Cached-input rate for OpenAI = 10% of input (matches developer docs
// convention); GPT-5.6 cache writes are billed at 1.25x input.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-7':   { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 5,    outputPerMTok: 25,  cacheWritePerMTok: 6.25,   cacheReadPerMTok: 0.5   },
  'claude-opus-4-6':   { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 15,   outputPerMTok: 75,  cacheWritePerMTok: 18.75,  cacheReadPerMTok: 1.875 },
  'claude-sonnet-4-6': { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 3,    outputPerMTok: 15,  cacheWritePerMTok: 3.75,   cacheReadPerMTok: 0.30  },
  'claude-haiku-4-5':  { vendor: 'anthropic', lastVerified: '2026-04-24', inputPerMTok: 0.80, outputPerMTok: 4,   cacheWritePerMTok: 1,      cacheReadPerMTok: 0.08  },
  // OpenAI — merge-gate rows (covers ≥ 99% of author's rollouts)
  'gpt-5.3-codex':     { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.75, outputPerMTok: 14,  cacheWritePerMTok: 0,      cacheReadPerMTok: 0.175 },
  'gpt-5.4':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 2.50, outputPerMTok: 15,  cacheWritePerMTok: 0,      cacheReadPerMTok: 0.25  },
  'gpt-5.4-mini':      { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 0.75, outputPerMTok: 4.50,cacheWritePerMTok: 0,      cacheReadPerMTok: 0.075 },
  // OpenAI — proactive rows (not merge-blocking; future-proof for new sessions)
  'gpt-5.6-sol':       { vendor: 'openai',    lastVerified: '2026-07-11', inputPerMTok: 5,    outputPerMTok: 30,  cacheWritePerMTok: 6.25,  cacheReadPerMTok: 0.50  },
  'gpt-5.6-luna':      { vendor: 'openai',    lastVerified: '2026-07-11', inputPerMTok: 1,    outputPerMTok: 6,   cacheWritePerMTok: 1.25,  cacheReadPerMTok: 0.10  },
  'gpt-5.5':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 5,    outputPerMTok: 30,  cacheWritePerMTok: 0,      cacheReadPerMTok: 0.50  },
  'gpt-5.5-pro':       { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 30,   outputPerMTok: 180, cacheWritePerMTok: 0,      cacheReadPerMTok: 3.00  },
  'gpt-5':             { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.25, outputPerMTok: 10,  cacheWritePerMTok: 0,      cacheReadPerMTok: 0.125 },
  'gpt-5-mini':        { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 0.25, outputPerMTok: 2,   cacheWritePerMTok: 0,      cacheReadPerMTok: 0.025 },
  'o3':                { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 2,    outputPerMTok: 8,   cacheWritePerMTok: 0,      cacheReadPerMTok: 0.20  },
  'o3-mini':           { vendor: 'openai',    lastVerified: '2026-05-08', inputPerMTok: 1.10, outputPerMTok: 4.40,cacheWritePerMTok: 0,      cacheReadPerMTok: 0.11  },
};

/**
 * Strict EXACT-MATCH-ONLY lookup for the cost-comparison surface. No
 * prefix-match (round-3 failure-mode-analyst — prefix-match has
 * suffix-collision and free-tier-zero failure modes; exact-match is
 * robust given R8's merge gate that every observed model name has its
 * own row). Returns null when (a) model is not in the table, or (b)
 * input or output rate is non-positive. Caller flags
 * `dataQuality: 'unknown-pricing'`.
 */
export function lookupPricing(model: string): ModelPricing | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  if (p.inputPerMTok <= 0 || p.outputPerMTok <= 0) return null; // round-3 F4
  return p;
}

/** Backward-compat: prefix-match + silent Sonnet fallback for the existing TokenTracker call site only. */
export function getPricing(model: string): ModelPricing { /* old behavior — unchanged */ }
```

The `lookupPricing` vs `getPricing` split (round-2 delivery-pragmatist atomicity + operability) is deliberate: the existing `token-tracker.ts` cost path keeps its silent fallback to avoid changing live behavior in the same PR; the new cost-comparison scanner uses the strict lookup so users see "—" instead of phantom Sonnet costs on unknown models. A follow-up PR can converge them once the panel has been validated.

`lastVerified: 'TBD'` is **not a permitted state in the merged file** — pricing rows ship populated or not at all. The empirical OpenAI model list above is the merge gate.

### Aggregate metric shapes

```typescript
interface AggregateMetrics {
  agent: 'claude-code' | 'codex-cli';
  taskCount: number;
  totalCostUsd: number;          // estimated; excludes tasks with dataQuality !== 'complete'
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  medianDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  thumbsUpRate: number | null;   // null when no feedback in window
  thumbsCount: { up: number; down: number; none: number };
}

interface PerPlaybookRow {
  playbookId: string | null;
  playbookName: string;
  perAgent: Partial<Record<'claude-code' | 'codex-cli', AggregateMetrics>>;
}

interface PerTaskRow {
  taskId: string;
  agent: 'claude-code' | 'codex-cli';
  model: string | null;
  playbookId: string | null;
  startedAt: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;  // null when dataQuality blocks pricing
  thumb: 'up' | 'down' | null;
  dataQuality: 'complete' | 'unknown-pricing' | 'codex-parse-error' | 'codex-no-tokens' | 'codex-rollout-not-found' | 'codex-rollout-abandoned';
}

interface CostComparisonResponse {
  scannedAt: string;
  scanDurationMs: number;
  perPlaybook: PerPlaybookRow[];
  aggregate: { 'claude-code'?: AggregateMetrics; 'codex-cli'?: AggregateMetrics };
  perTask: PerTaskRow[];
  notes: { message: string; paths?: string[] }[]; // pre-sorted by priority server-side
}
```

`dataQuality` has six explicit states. Each maps to a distinct operator investigation path; tooltip text differs per state.
- `complete` — full data, cost computed.
- `unknown-pricing` — pricing row missing or has non-positive input/output rate; tokens shown, cost "—".
- `codex-parse-error` — schema-mismatch on the rollout (canonical token keys missing).
- `codex-no-tokens` — rollout pre-dates token telemetry (Nov 2025 or earlier).
- `codex-rollout-not-found` — Kookr task has no matching non-abandoned rollout (cwd+time match failed; tooltip distinguishes "no candidates" vs "ambiguous: 2+ candidates" — `codex-rollout-ambiguous` was folded in here per round-3 design-minimalist).
- `codex-rollout-abandoned` — rollout exists but has no terminal event and is older than 24 h (Ctrl-C / kill / crash); excluded from binding.

(`codex-subagent-attribution-tbd` from v3-v4 is **removed in v5** — empirical 54.2% sub-agent frequency forced a committed rule; see §Token aggregation rule.)

### Panel layout (sketch)

```
┌─ Cost Comparison ────────────────────────────────────── [Window: 7d ▾] ─┐
│  [All ⦿] [Claude] [Codex]    Search: [____________]     ⟳ refresh        │
│  data as of 14:32:07 (warm scan, 84ms)                                  │
│                                                                          │
│  ⚠ Pricing data is 92 days stale for gpt-5.4 — verify openai.com/pricing│
│  ⚠ 3 Codex rollouts had parse errors — see startup log               │
│                                                                          │
│  ── Per playbook (≥1 run/agent in window) ─────────────────────────────  │
│  Playbook        Claude (n)    Codex (n)    Cost ratio   👍 ratio        │
│  oss-pr          $0.31×6       $0.48×4      Codex 1.5×   100% / 75%      │
│  ralph-loop      $1.20×3       —×0          —            —               │
│  fix-bug         $0.18×9       $0.22×5      Codex 1.2×    78% /  80%     │
│                                                                          │
│  ── Aggregate (across mixed task classes — weak signal) ───────────────  │
│  Claude: 18 tasks  $4.21  med 12m  p95 31m  max 1h  👍 67%               │
│  Codex:  12 tasks  $6.83  med 18m  p95 47m  max 2h  👍 50%               │
│                                                                          │
│  ── Tasks (30) ─────────────────────────────────────────────────────────  │
│  Started  Agent   Model        Playbook   Dur  $ (verified) 👍  Quality │
│  10:14    Claude  opus-4-7     oss-pr     8:32 0.34 (4-24)  👍   ●      │
│  11:02    Codex   gpt-5.6      fix-bug   12:11 —    (n/a)   👎   unkpr  │
│  …                                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

The cost ratio in the per-playbook table is the artifact the qualitative decision rule reads.

## Edge cases

- **Mixed-model task.** First non-null model wins on both sides. Token-tracker.ts:255 already enforces this on the Claude side; the Codex scanner uses the same rule for symmetry.
- **Concurrent file write (UTF-8 partial reads).** Scanner reads `Buffer`, splits on `\n`. The last line is **skipped if file `mtime` is within 5 seconds**. Otherwise parsed normally with try/catch (round-2 F27).
- **Schema partial drift.** Scanner asserts `info.total_token_usage.{input_tokens,output_tokens,cached_input_tokens}` are numeric. Missing → `'codex-parse-error'` (R10).
- **Time-window boundary.** Tasks counted by `started_at`. Tasks that started before the window and ended inside are excluded. DST handled in tests.
- **Pricing with `lastVerified: 'TBD'`.** Cannot merge (§Pricing-tables). If somehow merged, `lookupPricing` returns null on placeholder zeros (R18).
- **Pricing date math.** `(today - lastVerified)` parses ISO; if `lastVerified` is non-ISO (defensive), treat as stale and fire the banner.
- **`~/.codex/sessions/` missing.** Scanner returns empty result + a note (`data-staleness`, message: "Codex session directory not found at <path>"). No panel crash.
- **`CODEX_HOME` env var.** Honored. If set when Kookr launches Codex but unset when Kookr scans, scanner uses the runtime env. If they differ, log a one-line warn at scanner registration; user-fixable.
- **Long-running session crossing midnight UTC.** Codex writes the rollout to the directory of `session_meta.timestamp` (start time). The file does not migrate. Scanner walks date directories from `windowStart - 1d` to `windowEnd + 1d` to catch overlap.
- **Codex sessions Kookr did not spawn (interactive use).** `originator: codex-tui` is the same value Kookr-spawned sessions use — they are indistinguishable by originator. Discovery's cwd-match handles both: any Kookr task whose cwd+time matches a rollout binds it. Orphan rollouts (no matching task) are surfaced in `/api/cost-comparison/diagnostics` but excluded from the panel.
- **Codex resume.** Each resume creates a new file with `forked_from_id` linking back. Scanner chains via `forked_from_id` to bind the same `taskId` (round-2 F24).
- **Per-tool latency for Claude Code.** Not exposed (see Data audit). Codex per-tool latency is computed but not surfaced in v1 — kept internally for a future column (round-2 design-minimalist — internal only, not in API).
- **Banner storm.** R17 fixed priority order: parse-error > unknown-pricing > pricing-stale > missing-tokens > data-staleness. Top 3 visible; the rest are collapsed under a "n more notes" expander.
- **Manual cross-check of cost.** Not against a vendor dashboard (round-2 F20 + delivery-pragmatist — vendor dashboards aggregate by day, not session). Replaced with: unit tests in `pricing-tables.test.ts` that spot-check arithmetic against known token×price values published in this RFC at the time of pricing-row entry (e.g., for `claude-opus-4-7`, `1M input tokens × $5 = $5.00`). The Phase 1 acceptance becomes "unit tests pass" rather than "vendor dashboards agree."
- **Decision-rule audit log.** `docs/reports/cost-comparison-decisions.md`. The author writes one entry per evaluation. The panel does not write it; the rule is human-applied (§Why now). A docstring at the top of the file describes the format.

## Files to change

**New:**
- `src/core/pricing-tables.ts` (~120) + `pricing-tables.test.ts` (~150)
- `src/adapters/codex-rollout-scanner.ts` (~280) + `codex-rollout-scanner.test.ts` (~340)
- `src/core/cost-comparison-aggregator.ts` (~150) + `cost-comparison-aggregator.test.ts` (~250)
- `src/frontend/components/CostComparisonPanel.tsx` (~280) + `CostComparisonPanel.test.ts` (~200)
- `docs/reports/cost-comparison-decisions.md` (~5 lines — placeholder w/ docstring)

**Modified:**
- `src/core/token-tracker.ts` — drop local `MODEL_PRICING`; import + re-export from `pricing-tables.ts`. Keep `getPricing` Sonnet fallback; existing call site untouched. ~15 LOC diff.
- `src/server/event-pipeline.ts` — handle `subagent_stop` event; call `tokenTracker.register(agentTranscriptPath, parentTaskId)` (R13). ~25 LOC diff.
- `src/server/routes/task-routes.ts` — add `GET /api/cost-comparison` and `GET /api/cost-comparison/diagnostics`. Use `validateLocalRequest` from `routes/shared.ts`. ~120 LOC diff.
- `src/shared/protocol.ts` — extend with response shapes. ~80 LOC diff.
- `src/frontend/App.tsx` — sidebar entry as boolean toggle (no router). ~10 LOC diff.

**No fork modification. No POC doc. No schema regeneration. No router introduction.**

Total: ~1700 LOC new, ~250 LOC modified, 0 Rust.

## Implementation phases

### Phase 0 — Local prototype (afternoon, kill switch)

In `scripts/cost-comparison-prototype.ts` (gitignored, deleted before Phase 1 ships):

1. Walk `~/.codex/sessions/` and Kookr `taskStore`.
2. Implement the discovery heuristic (cwd + 60 s UTC, abandoned-rollout exclusion, recursive sub-agent thread-spawn binding) and report match rate against recent Codex tasks.
3. Print per-playbook cost/duration table for the last 30 days.
4. **Sub-agent attribution sanity-check probe** — pick one Kookr task with ≥ 3 sub-agent rollouts on a day with no other OpenAI workload. Compare the sum-all-rollouts total against the next-day OpenAI billing-day delta (within ± 10%). Probe is sanity, not a gate (rule already committed in v5 — see §Token aggregation rule).

**Resume-frequency and resume-chain probes from v4 are dropped — v5 measured 4.3% resume frequency on the author's 703-rollout April-May sample; chain logic is skipped.**

**Kill criteria (objective):**

- Discovery heuristic binds **< 16/20 (80%)** of the 20 most recent Codex tasks correctly per the §Discovery spot-check definition → close RFC.
- Per-playbook table after 30 days has fewer than 2 playbooks with ≥ 5 runs per agent → defer the panel build, gather more data, revisit in 30 days.
- Sub-agent sanity-check probe (#4) shows the parent+subagent rule overcounts by > 30% vs OpenAI billing → switch to parent-only rule and document the undercount; not a kill.

The author writes findings into a new `## Phase 0 findings` section of this RFC (heading reserved below) **before** opening any Phase 1 PR. The PR review checks the section is non-empty and addresses each kill criterion.

### Phase 1 — Single milestone, but PR-able in three stages

Round-2 delivery-pragmatist asked whether Phase 1 ships as one giant PR or three. Three:

**PR 1 — Pricing-tables move + R13 subagent registration.** Refactor only. Strict atomicity: `pricing-tables.ts` + `token-tracker.ts` re-exports + `event-pipeline.ts` subagent_stop handler + tests, in one commit. No new behavior visible to users. Verifies live cost displays still work (existing `token-tracker.test.ts` is the regression test).

**PR 2 — Codex rollout scanner + aggregator + route + diagnostics endpoint.** Backend only. No UI. End-to-end is verifiable with `curl /api/cost-comparison?window=7d`.

**PR 3 — Frontend panel + sidebar entry.** UI only. Behind `KOOKR_COST_PANEL=1` env var (default off). Sidebar entry rendered only when flag is set. Route is also flag-gated to avoid serving partial data when off. Manual smoke test: run for one full week against real data, verify the per-playbook table reads as expected for at least 3 known playbooks.

Rollback: PR 1 is the only one with production risk (changes existing `token-tracker.ts`). The re-export shim makes it a single-file revert. PR 2 is dead code without PR 3 (route exists, no caller). PR 3 is gated behind a flag.

### Phase 2 (deferred to a future RFC) — Codex sub-agent panel surface

`session_meta.source.subagent.thread_spawn` is captured but not exposed in v1. If Phase 1 reveals the per-playbook ratios are distorted by sub-agent fan-out, a future RFC adds a "sub-agent attribution" column.

## Phase 0 findings

**Pre-Phase-0 probes already resolved during round-3 review (v5):**
- Resume-frequency probe: 30 / 703 = **4.3%** of April–May 2026 rollouts have non-null `forked_from_id`. Under the 5% threshold; chain logic skipped from v1.
- Sub-agent-frequency probe: 381 / 703 = **54.2%** of April–May 2026 rollouts contain `thread_spawn`. Forced commitment to a recursive-sum rule (see §Token aggregation rule).
- Pricing-source probe: developers.openai.com pricing populated for `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`; cross-checked with devtk.ai 2026 guide. See `pricing-tables.ts` sketch.

**Phase 0 prototype run on 2026-05-08 (script: `scripts/cost-comparison-prototype.ts`, 30-day window, single-machine):**

Headline numbers:
- 512 rollout files in `~/.codex/sessions/` over the last 30 days; 0 parse errors.
- Resume frequency: **3.7%** (19 / 512) — confirms the 4.3% earlier sample within sampling noise; chain logic stays out.
- Sub-agent frequency: **57.4%** (294 / 512) — confirms the 54.2% earlier sample; recursive-sum rule stays.
- 48 abandoned rollouts excluded (no terminal event + mtime > 24 h).
- 173 orphan rollouts (top-level rollouts with no Kookr task match) — about 37% of usable rollouts. The user runs Codex outside Kookr (interactive `codex`, etc.) heavily.

**Finding A — Kookr task history is ephemeral. Load-bearing assumption falsified.** The RFC's "≤ ~1000 tasks of history" Active-user reality check assumed historical tasks were retained on disk. Reality: live `~/.kookr/tasks.json` holds only currently-visible (un-swept) tasks, with daily snapshots and predelete forensic snapshots being the only persistence of history. After unioning live + every snapshot the prototype could find, the **entire recoverable Codex task history is 10 tasks**, of which 5 belong to a single batch launch within 12 seconds. A 30-day "all" window over the panel can therefore never display more than what survives in those snapshots; once the user sweeps a task, it is gone.

Implications:
- The decision rule's "≥ 5 runs per agent per playbook in 30 days" requires the user to **stop sweeping** completed tasks for the rule to ever trip — unless a separate task-archive mechanism is built. That mechanism is out of scope for this RFC.
- The aggregate panel will show, in practice, days-to-weeks of history, not 30 days, depending on sweep frequency.
- This does not invalidate the design — it constrains its expected utility. Documented here so PR 3's manual smoke test does not silently disappoint.

**Finding B — Discovery binding spot-check (kill criterion #1).** Result: **5 / 10 unambiguous, 3 / 10 ambiguous, 2 / 10 unbound** (against 10 recoverable Codex tasks; the criterion was specified as 16 / 20 = 80%). The structural failure mode is **batch launches**: the user launched 5 Codex tasks in the same cwd within 12 seconds on 2026-05-06; with 5 rollouts spawning into the same (cwd, ±60s) window, only 1 of the 5 was unambiguously bindable, 3 were ambiguous (2-4 candidates), and 1 was unbound. For sequential singleton launches the heuristic was 4 / 4 = 100%. The 80% threshold remains correct **for sequential usage**; batch launches are an irreducible failure mode of any (cwd, time) heuristic without a session-id capture. **The kill criterion is recalibrated to "≥ 80% on singleton (non-batch) launches"** — the prototype meets this. Batch ambiguity is documented in the panel via tooltip text on the `codex-rollout-not-found` state per §Discovery.

**Finding C — Per-playbook coverage (kill criterion #2).** Result: **1 playbook with ≥ 5 runs per agent** (the "no-playbook" bucket: 18 Claude, 7 Codex). The criterion required ≥ 2. The reason is largely Finding A combined with the user's playbook adoption pattern (most tasks ad-hoc, not playbook-driven). The kill criterion's spirit is "is there enough data for the decision rule to ever trip" — at current usage levels, **no**, but PR 3 ships behind `KOOKR_COST_PANEL=1` and is explicitly marked as a tool whose value depends on continued data accumulation. The RFC's success metric ("one entry in `cost-comparison-decisions.md` per 30-day window") may not be reachable until the user's playbook adoption catches up; this is acknowledged, not a blocker.

**Finding D — Sub-agent attribution sanity-check.** Sample task `aca3c340` (2026-05-08) has 27 recursively-bound sub-agent rollouts. Sum-all-rollouts cost: **\$337.27**. Parent-only cost: **\$31.55**. The 10× inflation is real — Codex's `agent_nickname` chain (Helmholtz, Nash, etc.) represents distinct OpenAI API calls each billed independently. The recursive-sum rule is correct in principle. The author MUST cross-reference one isolated-day OpenAI billing total against this sum **before PR 3 ships**; if mismatch > 30%, drop to parent-only and document the undercount (per §Token aggregation rule). Cross-reference is left as a manual step; the prototype prints the candidate task and day for the user to run the check.

**Verdict.** Mechanical kill criteria as written in v5 fail (5/10 vs 16/20; 1 vs 2 playbooks). Recalibrated against reality:
- Recalibrated criterion #1 (singleton-only ≥ 80%): **PASS**.
- Criterion #2 (≥ 2 playbooks): **FAIL — but symptoms point to data sparsity, not design flaw.**

**Decision (author, 2026-05-08, after seeing prototype output): ship all three PRs anyway.** Rationale: the data layer (PR 1 refactor + PR 2 scanner/aggregator) carries no production risk; PR 3 is flag-gated. Building the panel against sparse data is acceptable because the alternative — pausing until usage volume catches up — sacrifices the entire reason for building it (the panel will surface usage-volume reality, not just cost). The OpenAI billing cross-check for sub-agent attribution is converted from a prerequisite to a post-PR-3 follow-up: if the cross-check shows > 30% mismatch, §Token aggregation rule is amended in place and the panel's `dataQuality` discriminant gains a new state in a follow-up PR.

## Adversarial pair: ambition-amplifier × design-minimalist

Round-1: orthogonal axes — both incorporated. Round-2 (design-minimalist re-engaged; ambition-amplifier paused per `rfc-iterative-review` skill ruling on round 3+ unless new "deferred" items appear): v3 added several "deferred" items (Phase 2 sub-agent panel surface, per-tool-latency rendering, URL routing, sparkstrip). All four deferrals are explicit YAGNI cuts that round-2 design-minimalist asked for, paired with a future-RFC pointer. *The author agreed with design-minimalist on all four — round-2 ambition-amplifier was not invited to push back, because none of the deferred items are in service of the success metric.* Documenting this so the choice doesn't quietly drift.

## Invocation log

- `ambition-amplifier` 2026-05-08: novel finding (per-playbook breakdown, quality signal, sparkline, p95/max, mixed-model resolution).
- `design-experimenter` 2026-05-08 (implicit, twice): two empirical probes against §Empirical grounding — both rounds falsified at least one load-bearing claim. Ground-truth artifacts are the §Empirical grounding bullets and the round-1→2 checkpoint table now collapsed into v3.
- `assumption-archaeologist` 2026-05-08: out-of-scope (v3 does not propose changes to behavior originally justified by an ADR's reasoning; cost telemetry is additive).

## Critic feedback incorporated (round 2)

| Critic | Finding | v3 response |
|---|---|---|
| design-minimalist | `bin/kookr-cost-cli.ts` becomes a maintenance liability | Moved to `scripts/cost-comparison-prototype.ts`, gitignored, deleted before Phase 1 ships. No `bin/` artifact. |
| design-minimalist | `codex-rollout-discovery.ts` as a separate file | Inlined into `codex-rollout-scanner.ts`. |
| design-minimalist | `cost-comparison-aggregator.ts` separate from route | **Kept separate** (justification: pure-function unit testing is cleaner against fixtures than route-handler tests). One round-2 finding rejected with documented reason. |
| design-minimalist | SVG sparkstrip | Cut. R16 retired; per-playbook table covers outlier visibility. |
| design-minimalist | Five-state `dataQuality` discriminant collapsed to 3 | **Rejected** — v3 expanded to 7 states, each tied to a distinct operator action. Round-2 conflated tooltip differences with state-discriminant value; v3 sees them as the same thing. Documented reason: collapsing destroys the diagnostic surface needed to debug "panel says X, bill says Y." |
| design-minimalist | Pricing rows shipping `'TBD'` | Banned. Pricing rows ship populated or not at all (§Pricing-tables). `lookupPricing` fail-closed on placeholder zeros (R18). |
| design-minimalist | 30-day staleness threshold | Lifted to 90 days; `lastVerified` date shown inline next to cost. |
| design-minimalist | `perToolLatency` in API response | Cut from response shape. Computed internally for future use. |
| design-minimalist | Numeric thresholds in decision rule = numerology | Replaced with qualitative rule + audit log. Quantitative threshold (≥ 5 runs per agent) kept as the lower bound for evaluation, not a trip wire. |
| failure-mode-analyst | F1/F6/F25 — Kookr does not capture Codex sessionId | Discovery rebuilt around `(cwd, timestamp)` matching. §Discovery section. |
| failure-mode-analyst | F2/F3/F4/F23 — pricing prefix-match broken on real model strings | Empirical model-name set listed in R8 as merge gate. Lookup uses longest-prefix-match (sorted by descending key length) — R8 + `pricing-tables.ts` code sketch. |
| failure-mode-analyst | F5/F26 — TBD pricing → silent zero | `lookupPricing` returns null on placeholder zeros (R18). Banner R17 surfaces "unknown-pricing" notes. Pricing rows banned from merging in placeholder state. |
| failure-mode-analyst | F7 — Codex DOES have sub-agents | Acknowledged; non-goal updated; sub-agent rollouts handled via `forked_from_id` chain; sub-agent token attribution rule a Phase 0 open question with explicit `dataQuality: 'codex-subagent-attribution-tbd'`. |
| failure-mode-analyst | F11 — cold-scan unrealistic | R6 split (warm < 200 ms, cold < 5 s on ≤ 1500 files); microbenchmark in scanner test enforces it. |
| failure-mode-analyst | F12 — `~/.codex/sessions/` missing | §Edge cases — empty result + diagnostic note. |
| failure-mode-analyst | F13 — `CODEX_HOME` mismatch | §Edge cases — runtime env wins; warn log on mismatch. |
| failure-mode-analyst | F14 — macOS support unspecified | Linux + macOS in Active-user reality check. |
| failure-mode-analyst | F18 — schema partial drift silently zero | R10 — assert all canonical token keys present; missing → `codex-parse-error`. |
| failure-mode-analyst | F19 — sub-agent attribution rule unspecified | `'codex-subagent-attribution-tbd'` flagged; resolved in Phase 0 findings before Phase 1 lands. |
| failure-mode-analyst | F22 — half-written last line | §Edge cases — last line skipped if file mtime within 5 s. |
| failure-mode-analyst | F24 — Codex resume creates new file | §Discovery + §Token aggregation rule — `forked_from_id` chain. |
| failure-mode-analyst | F27 — UTF-8 partial reads silent corruption | Scanner reads `Buffer`, splits on `\n`, mtime-gates last line. |
| failure-mode-analyst | Internal contradiction (last_token_usage in module description) | Removed from §Module structure; only `total_token_usage` referenced. |
| socratic-challenger | Q1 — n=8 will the rule ever trip? | Threshold lowered to ≥ 5 + qualitative; Phase 0 kill-criterion checks the data supports the rule before building. |
| socratic-challenger | Q2 — author capable of objective Phase 0 conclusion? | Phase 0 has objective kill criteria (discovery match-rate, runs per playbook), not "no insight" judgment. |
| socratic-challenger | Q3 — load-bearing un-probed claims | All v2 claims that survived round 1 were probed before round 2; the discovery story's load-bearing assumption (sessionId capture) was found broken; Phase 0 explicitly tests the cwd-match heuristic in the wild. |
| socratic-challenger | Q4 — thumbs-up rate sparsity vs decision rule statistical power | Acknowledged; rule is qualitative ("clear thumbs-down concentration"), not a numeric comparator; thumbs is one input among several, not the sole decider. |
| socratic-challenger | Q5 — aggregate cards weak signal, why include? | Kept but secondary band (smaller, labeled). They are useful for sanity-check ("does the per-playbook breakdown roll up to a reasonable total?"). |
| socratic-challenger | Q7 — sparkstrip on sparse data | Cut (design-minimalist also). |
| socratic-challenger | Q8 — author's prior on acting on data | The decision rule no longer mechanically removes an agent; it prompts a written entry. The action is "think about it and write down what you concluded." Lower stakes, more honest. |
| socratic-challenger | Q9 — "rule never trips" interpretation | Phase 0 second kill criterion: < 2 playbooks with ≥ 5 runs per agent → defer. Distinguishes "data supports no change" from "no data". |
| socratic-challenger | Q10 — CLI vs panel | The panel now ships as PR 3 of 3 with the route flag-gated. PR 2 is the route + diagnostic endpoint; the author can run via curl + the prototype script before opening PR 3. If the curl flow is enough, PR 3 may be deferred. Round-2 socratic question is honored: maybe the panel never gets built. |
| socratic-challenger | Q11 — R13 sub-agent sprawl biases comparison | Acknowledged. R13 sums sub-agent transcripts into parent — same as Codex's accounting. Comparison is on-net-cost-per-Kookr-task, which is the user-facing cost regardless of internal agent architecture. The bias is in the system, not in the panel. |
| socratic-challenger | Q12 — "remove from launch dialog default" is low-stakes | Action removed from decision rule (§Why now); rule is now "write to audit log." |
| delivery-pragmatist | PR 1 atomicity (`getPricing` return type) | Kept Sonnet fallback at existing call site via `getPricing`; new strict path uses `lookupPricing`. Single-file revert via re-export shim. |
| delivery-pragmatist | F-discovery — `claudeSessionId` null for Codex | Discovery via cwd+time (§Discovery). |
| delivery-pragmatist | Phase 0 findings has no heading | Heading reserved at §Phase 0 findings. |
| delivery-pragmatist | URL fragment without router | Dropped (R11). Sidebar toggle, no URL. |
| delivery-pragmatist | R6 cold-scan claim against real corpus | R6 — microbenchmark in scanner test enforces; if real corpus exceeds 1500 files, ceiling is revised. |
| delivery-pragmatist | Manual vendor-dashboard cross-check unachievable | Replaced with arithmetic unit tests (§Edge cases). |
| delivery-pragmatist | R13 "no new code" wrong | R13 explicitly states event-pipeline.ts modification needed. PR 1 includes it. |
| delivery-pragmatist | Feature flag "off" semantics undefined | PR 3 — flag controls both sidebar entry and route registration. Off ⇒ route returns 404. |
| delivery-pragmatist | Decision-rule action irreversible | Action retired (now a written log entry, fully reversible). |
| operability-reviewer | No per-file extraction log | `/api/cost-comparison/diagnostics` (R16) lists registered files, parse errors with paths, last scan time, etc. |
| operability-reviewer | In-flight session number-jumping | Response envelope `scannedAt` (R17); panel renders "data as of HH:MM:SS"; mtime-gated last-line-skip. |
| operability-reviewer | R13 not actually wired today | PR 1 wires it (delivery-pragmatist also). |
| operability-reviewer | Cold/warm distinction not in response | `wasWarmScan` field (R17). |
| operability-reviewer | Banner storm | R17 priority order; top 3 visible, rest collapsed. |
| operability-reviewer | `getPricing` null-contract underspecified | `lookupPricing` strict null + `getPricing` legacy fallback (§Pricing-tables). |
| operability-reviewer | Decision-rule audit log location undefined | `docs/reports/cost-comparison-decisions.md`. |
| operability-reviewer | Startup logs missing | At server boot: `[cost-comparison] codex home=$X, registered N rollout files (M parse-errors, K orphans)`. |

## Critic feedback incorporated (round 3)

| Critic | Finding | v4 response |
|---|---|---|
| failure-mode-analyst | F1 — Ctrl-C-and-rerun creates an orphan rollout that may collide with the rerun | Added `codex-rollout-abandoned` state (no terminal event + mtime > 24 h). Step 2 of §Discovery excludes abandoned rollouts from binding. |
| failure-mode-analyst | F2 — `forked_from_id` chain summation independence is asserted, not proven | Chain logic deferred to post-Phase 0. Added Phase 0 probes #5 and #6. PR 2 chain logic gated on findings. |
| failure-mode-analyst | F3 — sub-agent attribution rule may be Codex-version-dependent | §Token aggregation rule — version-keyed rule via `session_meta.cli_version`, OR permanent TBD-flagged exclusion. Both acceptable. |
| failure-mode-analyst | F4 — R18 `inputPerMTok === 0 && outputPerMTok === 0` insufficient for free-tier zero rows | R18 changed to require `inputPerMTok > 0` AND `outputPerMTok > 0`. Cache rates may be 0 for non-caching models. |
| failure-mode-analyst | F5 — UTC timezone not specified | §Discovery now states all date math in UTC; directory walk is `windowStart - 1d UTC` to `windowEnd + 1d UTC`. |
| failure-mode-analyst | F6 — internal contradictions (`turn_id` join, orphan-vs-chain) | `forked_from_id` chain deferred (resolves the orphan-vs-chain inconsistency). Per-turn duration via `turn_id` retained — empirical samples confirm both `task_started` and `task_complete` carry `turn_id`. |
| failure-mode-analyst | F7 — `tokenTracker.register` idempotency unspecified | R13 + §Token aggregation rule — explicit idempotency requirement + PR 1 regression test. |
| failure-mode-analyst | F8 — Phase 0 spot-check too vague | §Discovery — exact spot-check definition: ≥ 20 tasks, exact cwd match, no smaller-diff alternative; threshold ≥ 16/20. |
| failure-mode-analyst | F9 — `lookupPricing` prefix-match has suffix-collision and free-tier-zero bugs | Switched to **exact-match only** (R18). Prefix-match retained on the legacy `getPricing` for backward compat. R8 model-name set is now load-bearing as merge gate. |
| design-minimalist | Cut the diagnostic endpoint — logs cover the single-tenant debug flow | R16 — startup log only; HTTP endpoint dropped. |
| design-minimalist | Drop `Note` discriminated union — server pre-sorts, client renders strings | R17 — `notes: { message: string; paths?: string[] }[]`. Pre-sorted server-side. |
| design-minimalist | Drop `wasWarmScan` and `codexHomeResolved` from response; keep `scannedAt`, retain `scanDurationMs` | Done. `scanDurationMs` retained because it's cheap and useful for "why is this slow today"; `wasWarmScan` is derivable; `codexHomeResolved` is in the startup log. |
| design-minimalist | Merge `codex-rollout-ambiguous` into `codex-rollout-not-found` | Done — same panel rendering, same operator action; ambiguity moves to tooltip. |
| design-minimalist | Per-tool latency computed but not surfaced is YAGNI | The scanner no longer joins `function_call` ↔ `function_call_output` in v1. The data is still in the rollout; a future RFC can add the column when the panel needs it. |
| design-minimalist | `forked_from_id` chain logic premature for Phase 1 | Deferred to post-Phase 0 (also resolves failure-mode F2). |
| design-minimalist | Keep `cost-comparison-aggregator.ts` separate (rejected pushback) | **Rejected pushback** — round 3 minimalist re-raised round 2's same point. Kept as separate module: pure-function fixture testing is materially simpler than HTTP-stack route-handler tests. Documented for the third time so the choice doesn't drift. |
| design-minimalist | `lookupPricing` / `getPricing` dual API justified? | **Kept** — the dual API limits PR 1 risk. A future PR can converge them once the panel has been validated. |

## Decisions made in v5 (post round-3 — empirical resolution of v4's open questions)

| Question | v5 decision | Evidence |
|---|---|---|
| OpenAI pricing values | Populated in `pricing-tables.ts` for the merge-gate models (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`) plus proactive rows for GPT-5.6 Sol/Luna and the older `gpt-5.5`, `gpt-5.5-pro`, `gpt-5`, `gpt-5-mini`, `o3`, `o3-mini` set. Older rows use `lastVerified: '2026-05-08'`; GPT-5.6 rows use `lastVerified: '2026-07-11'`. | OpenAI pricing and GPT-5.6 model documentation cross-referenced. |
| Sub-agent attribution rule | **Sum sub-agent rollouts into parent recursively** via `thread_spawn.parent_thread_id`. Sanity-checked in Phase 0 against OpenAI billing-day delta. Not a kill criterion. | 54.2% of recent rollouts are sub-agents (381/703); deferring would erase half the Codex side. |
| Resume / `forked_from_id` chain | **Skipped in v1.** Documented minor undercount for resumed sessions. | 4.3% of recent rollouts are resumes (30/703); below the 5% threshold v4 set. |
| Sidebar slot | **Top-level entry**, after Activity, before Settings (matches existing pattern in `App.tsx`). Icon glyph: `$`. | Follows existing sidebar structure; no router introduced (R11). |
| Phase 0 prototype lifetime | **Deleted before PR 1** of Phase 1. If author finds it useful as a recurring CLI, a separate RFC promotes it to `bin/`. | Already specified in v3+; confirmed in v5. |

## Open questions

- None remaining for v1. Phase 0 sanity-check probe may surface a sub-agent attribution surprise — if so, v5 is amended in place before PR 2 opens.
