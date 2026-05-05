# ADR-013: Stuck-Loop Detection Promotion Criteria

## Status

**Accepted** (2026-04-15)

## Context

Stuck-loop detection is Kookr's largest visible gap in anomaly coverage. Agents that loop 50+ times on a failing approach are the most common supervised-agent failure mode, and Kookr currently does not flag them. The deterministic "count consecutive same-tool calls" detector was explicitly removed from `src/core/anomaly-detector.ts` because it produced false positives on normal exploration (e.g., an agent reading 20 files in a row).

Three alternative shadow strategies were built and wired into the watchdog tick:

- `PaneSemanticsStrategy` — classifies terminal pane content into `input_prompt`, `permission_dialog`, `shell_prompt`, `streaming`, `unknown`.
- `ProcessLivenessStrategy` — checks whether the foreground process in the dtach-managed PTY is still Claude Code (Linux: `/proc/<pid>/cmdline`; macOS: `ps`). Originally drafted against tmux panes; unchanged since the dtach switch in ADR-014.
- `CombinedShadowStrategy` — union of the two above; pane_semantics wins when both fire because it produces more specific anomaly types.

A fourth source, `http_push`, is registered in `DEFAULT_STRATEGY_CONFIG` but does not yet emit anomaly verdicts — it tracks agent activity for future detection work and is out of scope for this promotion decision.

All three run in **shadow mode**: they evaluate against live agents, log verdicts to `~/.kookr/shadow-detection.jsonl`, but do not affect the attention queue. The real detector continues to drive production behavior.

The open question this ADR answers: **what quantitative evidence is required before any shadow strategy is promoted to active mode?** Promoting a strategy without evidence risks repeating the false-positive-flood that killed the original detector and eroding developer trust in all Kookr anomalies, not just stuck-loop ones.

## Decision

A shadow strategy is only promoted from `shadow` to `active` when **all** of the following hold:

### 1. Precision floor: ≥ 90%

Measured as `overlapMs / shadowAnomalyMs` across a continuous observation window of at least one week of real production traffic (Jean's personal Kookr instance running agents daily). Computed by `scripts/shadow-report.ts` from `~/.kookr/shadow-detection.jsonl`.

The rationale for 90% (rather than, e.g., 80%) is asymmetric cost: a false positive interrupts the developer for an agent that is actually fine, which trains them to ignore the attention queue — a far worse outcome than missing one stuck agent on a given tick.

### 2. Coverage floor: ≥ 50%

Measured as `overlapMs / realAnomalyMs` across the same window. Coverage below 50% means the strategy is missing more real anomalies than it catches, so graduating it gains little over doing nothing. Above 50%, it becomes a net improvement over the current state even with the precision floor applied.

### 3. Platform parity verified

`ProcessLivenessStrategy` uses `/proc`, which does not exist on macOS. Before promotion, the strategy (or the combined strategy, if it depends on it) must have produced **non-empty data** from macOS shadow logs as well as Linux — either via Jean's own macOS testing or a second contributor. A strategy that silently degrades on macOS is not acceptable as "active" on that platform.

### 4. Dashboard regression test passes

After promoting, run Kookr with at least three concurrent healthy agents for 30 minutes. The attention queue must not accumulate any false anomalies from the newly-promoted strategy during that window. This is a manual smoke test, not an automated one, because the real signal is whether the dashboard looks trustworthy to a human watching it.

### 5. Opt-in via env var for one release

When a strategy first meets criteria 1-4, it is promoted behind `KOOKR_STUCK_DETECTION=active` (off by default). After one full release in opt-in mode without regression reports, the default flips to on. This is a rollback safety valve — if precision or coverage silently degrade on a future agent build, users can disable without rebuilding Kookr.

### Confidence field

Shadow strategies emit an optional `confidence: 'high' | 'medium' | 'low'` on each verdict. Confidence is logged to `shadow-detection.jsonl` entries so the analysis script can compute **precision-at-high-confidence** in addition to overall precision. When overall precision is below the 90% floor, a strategy may still be promoted if its **high-confidence-only** verdicts clear the floor — the active strategy would then ignore low-confidence matches.

This gives us a graduated path: the first strategy to promote may be a high-confidence-only variant of pane_semantics that catches permission dialogs (very clean signal) without attempting input-prompt detection (noisier signal).

## Consequences

### Positive

- No stuck-loop detection is promoted on vibes. Every promotion is backed by numbers from a shared, reproducible analysis script.
- The shadow-log schema now captures confidence, enabling richer analysis without another data-collection round.
- Platform gaps (macOS `/proc`) cannot be ignored silently — parity is a hard gate.
- Env-var opt-in provides one release worth of rollback safety for every promotion.

### Negative

- The one-week observation window delays promotion by at least one week after a strategy is first proposed. This is a deliberate trade-off: rushing a promotion is how we got here.
- Coverage and precision are computed against the **real detector** as ground truth. The real detector has no stuck-loop coverage, so a strategy detecting genuine stuck loops the real detector missed shows up as "unmatched shadow intervals" (apparent false positives). Section **Open Issues** below discusses mitigation.

### Open issues

- **Ground-truth labeling for missed anomalies.** `scripts/shadow-report.ts` can compute precision/coverage relative to the real detector, but it cannot distinguish "real detector missed a genuine stuck loop" from "shadow had a false positive." Manual labeling of unmatched shadow intervals is required before the first promotion. Deferred to issue follow-up.
- **Rehydration of historical logs** when the schema evolves. New fields (like `confidence`) are optional, so existing logs remain parseable — but future breaking changes should land behind a version bump in the log entry.

## Related

- Issue #103 — shadow detection validation pipeline
- `src/core/shadow-detector.ts` — log schema and registry
- `src/core/shadow-report.ts` — analysis library
- `scripts/shadow-report.ts` — CLI wrapper
- `src/core/anomaly-detector.ts` — real detector with the removed deterministic detector
