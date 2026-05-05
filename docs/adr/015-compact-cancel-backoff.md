# ADR-015: No-progress back-off when `/compact` keeps getting cancelled

- **Status:** Accepted
- **Date:** 2026-04-24
- **Supersedes / amends:** none — extends ADR-013 / POC-005 (proactive checkpoint cycle).
- **Issue:** [#412](https://github.com/kookr-ai/kookr/issues/412)

## Context

The proactive checkpoint cycler (`src/core/checkpoint-cycler.ts`) injects `/compact` into the agent's terminal when the per-turn context fill crosses `triggerRatio` (default 75%). The existing guards are:

- `compactTimeoutMs` (2 min) — resets the state machine after a compacting phase takes too long.
- `cooldownMs` (5 min) — gates the next cycle start.
- `promptGraceMs` (1.5 s) — filters stale Stop events during the prompting phase.

Issue #412 captured a production session (transcript + `~/.kookr/hooks/*.jsonl` line numbers) where the user repeatedly cancelled the `/compact` input. Because Claude Code does **not** emit a Stop hook when a slash-command input is cancelled, the cycler had no way to distinguish "compaction still running" from "user killed it". It timed out after 2 minutes, started the 5-minute cooldown, and 7 minutes later re-injected `/compact` — indefinitely.

The cycler needed a way to tell a successful cycle (ratio dropped) from a no-progress cycle (ratio unchanged), and a hard stop for the session once it becomes clear the user does not want compaction.

## Decision

Implement options (2) and (3) from the issue body, both — they compose cleanly and give us a minimum fix that protects users against the true infinite loop without changing any of the existing guard values.

### (3) Post-compact-timeout ratio sampling

- Store `cycleStartRatio: number` on `CycleState`. Populate it when the cycler transitions `idle → prompting`.
- On the `compactTimeoutMs` branch in `tick()`, re-read the transcript and compute the current fill ratio.
- **Success** is defined as "current ratio strictly below `cycleStartRatio`". Any other outcome (ratio equal, ratio higher, or transcript unreadable) is treated as a **no-progress cycle**.

### (2) Give up after N consecutive no-progress cycles

- Add `cancelledAttempts: number` to `CycleState`. Starts at 0. Incremented on no-progress cycles, reset to 0 on a successful cycle (both the tick-detected-success path and the onStop-during-compacting path — Stop during compacting means `/compact` actually ran to completion, per the issue's evidence that Claude Code does not emit Stop for slash-command cancellation).
- Add `maxCancelledAttempts: number` to config. Default 3. Overridable via `KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS`.
- When `cancelledAttempts >= maxCancelledAttempts`: flip a new `gaveUp: boolean` flag on the state, log a warning (`console.warn`), and pin `lastCycleEndedAt` to `Number.MAX_SAFE_INTEGER`. The cooldown gate then also blocks — belt and suspenders with the explicit `gaveUp` check at the top of the fire path.
- Give-up is **session-scoped**. Clearing happens only when the session is forgotten (session end, explicit `forget()`, or passive cleanup via tick).

### What we did NOT change

- `triggerRatio` stays 0.75.
- `cooldownMs` stays 5 minutes.
- `compactTimeoutMs` stays 2 minutes.
- No exponential back-off (option 1). The hard 3-attempt cap is sufficient for the minimum fix and avoids another tuning knob. `KOOKR_CHECKPOINT_BACKOFF_FACTOR` is reserved for a future change if this turns out not to be enough in practice.
- No dashboard-surfaced `CycleCancelled` event (option 4). The server-side log is enough visibility for the fix; if we want user-facing messaging we can add it in a follow-up.

## Consequences

- A user who repeatedly cancels `/compact` will see at most **3** injections before Kookr stops for the session. The session can continue running; Kookr just stops being proactive about context compaction.
- A cycle that *succeeds* — whether via Stop-during-compacting or via ratio-drop at timeout — resets the no-progress counter. Users who occasionally cancel `/compact` do not accumulate a trap.
- The `cycleStartRatio` field is redundant during normal operation (it is only read on the timeout path) but makes the state machine's definition of "successful cycle" explicit and testable.
- `prompt`-phase timeouts do NOT count toward `cancelledAttempts` — they represent "agent never finished writing CHECKPOINT.md", a different failure mode, and the `/compact` send never happened.
- No migration: `CycleState` is in-memory only; existing sessions will be reinitialised with the new fields via `getOrInit`.

## Alternatives considered

- **Synchronous Stop-on-cancel.** Teach the adapter to detect slash-command cancellation from the transcript and emit a synthetic Stop. Ruled out — brittle, requires parsing transcript contents the cycler otherwise never touches, and Claude Code's transcript format is not a stable contract.
- **Exponential cooldown only (option 1).** Would still retry forever, just less often. Users would still have to cancel every N minutes until they gave up and ended the task manually. Rejected as a primary fix.
- **Dashboard prompt before re-injection.** Adds a synchronous user decision to every retry, which contradicts the whole "proactive, background" design of the cycler. Worth revisiting if the silent give-up turns out to be confusing.

## Test coverage

Added to `src/core/checkpoint-cycler.test.ts`:

- `cycleStartRatio` is populated on prompting entry.
- Successful cycle (ratio drop at compact timeout) resets `cancelledAttempts`.
- Successful cycle (Stop during compacting) resets `cancelledAttempts`.
- Two consecutive no-progress cycles still allow a third attempt.
- After 3 consecutive no-progress cycles the cycler refuses to fire for the session.
- `KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS` env override (valid, invalid, unset).
- `prompt`-phase timeout does NOT increment the counter.
