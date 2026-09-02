# Kookr parallel issue batch — diagnosis and repair (issue #2982)

_Analysis artifact for issue #2982. Root cause of the `cancelled, fails: 2`
state of the "Kookr parallel issue batch" schedule, and the code guard added to
prevent the failure class from recurring silently._

## Summary

The Kookr parallel issue batch was not broken code — it was **broken
configuration**. The schedule (`d46066da-82d6-42a7-afef-633ef01f43a1`) pinned
`issueSelector: "2756 2757 2758"`. All three issues closed on **2026-08-23**, so
from that day every fire correctly found **NO-ELIGIBLE-WORK** and dispatched
nothing. The batch kept firing on its cron (`23 2,14 * * *`) but was a permanent
no-op — a dead delivery engine that still looked "enabled, running." The working
Lucy batch never hit this because it uses a **blank** `issueSelector` and rescans
the open backlog every fire.

The `cancelled, fails: 2` surface was a downstream symptom: two fires happened to
be reclaimed by watchdog TTLs rather than completing their clean no-op, which
counted as failures and tripped the consecutive-failure auto-hold.

## Evidence — the last two failed runs

Both terminal runs were **watchdog TTL reclaims**, not batch-logic errors, and
neither even created a run state directory (they hung/paused before doing work):

| Run (scheduledFor) | Task id | Agent | Termination | Detail |
| --- | --- | --- | --- | --- |
| 2026-09-01 12:23 | `6d2b81d6…` | codex-cli | `provider-paused-ttl` | paused 2400s (billing/quota hold), reclaimed with no delivery |
| 2026-09-02 00:23 | `6f647b43…` | claude-code | `hung-suspect-ttl` | silent 1503s (threshold 1500s), reclaimed with no confirmed delivery |

Both carried `provenance.kind = schedule`, `sourceId = d46066da…`, and the pinned
`issueSelector: "2756 2757 2758"`.

The three pinned issues (confirmed via `gh issue view`):

- `#2756` CLOSED 2026-08-23 — "Ship the existing TERM=dumb Codex spawn fix"
- `#2757` CLOSED 2026-08-23 — "Queue-feeder consults cross-task issue claims…"
- `#2758` CLOSED 2026-08-23 — "Implement Phase 2 umbrella-chain advancer backstop"

Prior **completed** cron runs recorded the honest no-op directly in their
`state.md`, confirming the mechanism:

> `32edf03d` / `262b6814` / `09b54e6b` — NO-ELIGIBLE-WORK (explicit-selector
> campaigns already delivered/closed).

The schedule's `extraInstruction` compounded the pin: a 2026-08-23 operator note
restricting the batch to "residual leaves of the frozen umbrella campaign
#2711, #1552, #1549, #1548, #1547, #1545, #1526" — a campaign that is itself
drained. So even setting the selector aside, the run note steered every fire back
to an empty pool.

## Relationship to Lucy's PR #3811

Issue #2982 asked whether this matches Lucy's pre-#3811 "stale-marker halt." It
is the **same class** — a stale, frozen artifact silently halting the batch — but
a **different mechanism**. Lucy's was a stale run marker; Kookr's is a stale
**pinned configuration** (`issueSelector` + `extraInstruction`). So this is the
"apply the targeted fix" branch of the issue, not the stale-marker-idempotency
branch.

## The repair (two parts)

### 1. Runtime config — operator-gated, not done autonomously

The direct repair is to make the Kookr batch mirror the working Lucy lane:

- Clear `issueSelector` to `""` (scan the open backlog every fire).
- Clear the stale campaign `extraInstruction`.
- Optionally align cadence/agent to Lucy's lane (codex-cli, ~2h interval).
- Re-enable / lift the consecutive-failure hold.

Issue #2982 explicitly makes re-enable **operator-gated** ("Operator to confirm
re-enable (not autonomous)"), and this is live production runtime state
(`~/.kookr/schedules.json`), not a tracked file. So this PR does **not** edit the
live schedule. Suggested operator commands are in the PR description.

### 2. Code guard — prevents silent recurrence (this PR)

The real defect the codebase could own: a recurring batch pinned to explicit
issues rots into a no-op the moment those issues close, and **nothing raises its
hand** — exactly the silent-config-error class the `ScheduleResolutionAlerter`
(#1661) was built for. This PR adds an analogous, purely-static detector:

- `src/core/batch-selector-pin.ts` — classifies a schedule as a drained-pin risk
  when it runs `parallel-issue-batch.md` on a recurring budget
  (`maxTriggers !== 1`) with an `issueSelector` that is an explicit numeric pin
  (blank selectors and GitHub search filters are not pins; one-shots are exempt).
  No GitHub calls — it reads only the schedule config.
- `src/server/schedule-batch-pin-alert.ts` — `ScheduleBatchPinAlerter`,
  edge-triggered like the resolution alerter: one `warning` operational alert per
  pinned episode per schedule, a matching `info` recovery alert when the selector
  is blanked or switched to a filter, silent clear on deletion.
- Wired into `ScheduleRunner.refreshPlaybookResolution` (the existing validation
  tick, no new timer) and constructed in the schedule-runtime bootstrap.

Had this guard existed, the Kookr batch would have raised an operator alert
within one validation cycle of 2026-08-23 instead of firing no-op for ~10 days.

## Acceptance-criteria status

- **Diagnosis** — done (this report).
- **Re-enable** — operator-gated by the issue; commands documented in the PR, not
  executed autonomously against live runtime state.
- **Validation / 48h impact** — operational, measurable only after the operator
  re-enables; cannot be satisfied by a PR.
