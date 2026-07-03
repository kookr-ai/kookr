---
name: kookr-supervise-tasks
description: Autonomously monitor running Kookr agent tasks, advance them through permission prompts / idle states, and judge completion correctly (including treating CI Actions-budget failures as non-blocking). Use when the user asks to "supervise", "monitor", "babysit", or "auto-advance" running Kookr tasks.
keywords: supervise, monitor, kookr, tasks, advance, auto, babysit, tmux, prompt, approval, RFC, PR, CI, budget, snooze
---

# Supervise Kookr Tasks

Use when the user asks you to supervise, monitor, or auto-advance their running Kookr tasks without them having to type commands themselves.

## Core trust model

1. **Self-exclusion** — never send input to your own supervisor task. Identify your own `taskId` / tmux session first and exclude it from every sweep.
2. **Snoozed tasks stay untouched** — even after the snooze timer expires. If the user said "don't execute this one", that is a durable instruction, not a countdown.
3. **Other running tasks advance autonomously** — the user wants them driven to completion without further confirmation from them. Send the commands yourself.
4. **Only stop and ask** when you encounter a decision the task's own prompt explicitly deferred to the user AND that decision has not been pre-authorised by the current supervision ask.

## Inspection — what to query and how to read it

### Kookr API

```bash
# List all tasks with status, sessions, age
curl -s http://localhost:4800/api/tasks

# Richer snapshot with snoozedUntil, anomaly, token usage
curl -s http://localhost:4800/api/snapshot
```

Port is `4800` for prod, `4801` for dev. Check both if the user runs dual instances.

Per-task fields that matter:
- `status: "inProgress" | "completed" | "cancelled"` — top-level task state
- `sessions[-1].lastStatus: "completed" | "aborted" | null` — the live agent's last hook-reported state
- `sessions[-1].lastEventAt` — timestamp; compute age to spot stale idles
- `snoozedUntil` (snapshot only) — epoch ms; compare to `Date.now()`
- `anomaly.kind` (snapshot only) — e.g. `needs_input`, `stuck`, null
- `agentId` — tmux session name (e.g. `kookr-bea5ed4c`)

### tmux capture

```bash
tmux capture-pane -pt <kookr-session> -S -60 | tail -60
```

The bottom 60 lines almost always tell you what state the agent is in. You read this, not the top.

## Reading the agent's current state

| What you see at the bottom | Meaning | Action |
|---|---|---|
| `Running critics… (Xm)`, `Thinking with xhigh effort`, `Cogitated for…`, `Pondering…` | Actively working | Do nothing. Check back later. |
| `Do you want to proceed?` with `❯ 1. Yes / 2. No` | Permission dialog | Send `1` + Enter |
| `[Pasted text #N +M lines]` above an empty `❯` prompt | Text was pasted into composer but **not submitted** | Send another `Enter` |
| `❯ ` empty for many minutes, no active spinner | Idle / turn ended | Inspect last output: is the task done (PR URL present) or waiting for a decision? |
| `✻ Presenting RFC to user…` or similar "present" step | Reached a designed checkpoint | Usually needs user-level decision; see RFC tasks rule below |

## Sending input to agents — the Enter pitfall

Long multi-line messages sent via `tmux send-keys -t <session> "..." Enter` are frequently rendered by Claude Code as a single pasted block that requires a **second Enter** to actually submit:

```
❯ [Pasted text #1 +N lines]
```

**Always verify after sending.** Capture the pane 10–20 s later; if you see a `[Pasted text ... ]` line that did not get submitted, send a bare Enter:

```bash
tmux send-keys -t <session> Enter
```

For short commands and digit answers to permission dialogs (`1`, `2`) a single `Enter` usually works the first time, but it is cheap to re-verify.

## Permission dialog handling

Claude Code prompts like `Do you want to proceed?` with options `❯ 1. Yes / 2. No` are **routine gating, not user-level decisions** when they are asking to run commit/push/`gh pr create` on behalf of a task the user already authorised. Approve with `1` Enter.

The ambiguous variants that include a 3rd option like "Yes, allow reading from X for this project" are also safe to approve with `1` — option 2 grants a broader persistent permission that is not required to continue.

## RFC tasks default to **single-stage** delivery

When the user writes a prompt like:

> Generate an RFC document and review it multiple times with subagents until you converge. Then wait for my approval to implement…

**Do not** split this into "RFC-only PR now, implementation PR later". The user's intended full-delivery arc is:

1. Draft RFC
2. Iterate with critics
3. Commit + push + open docs PR for the RFC
4. Immediately proceed to implementation (PR-A, PR-B, etc.) per the RFC's own staging
5. Report all PR URLs

The "wait for approval" line is normally just the iterate-critics gate — by the time supervision is asked for, the user has already approved continuing. When an agent reaches that checkpoint under supervision, send the approval in the same sweep, with concrete staging instructions so the agent does not re-prompt:

> Approve the RFC. Proceed with implementation in the staged order specified in the RFC: (1) PR-A first — <what PR-A does>. (2) Immediately after opening PR-A, proceed to PR-B — <what PR-B does>. Do not combine them. Do not wait for PR-A to merge. Report both PR URLs when done.

If a split is genuinely wanted (e.g. user said "wait for my explicit approval in the PR thread"), honour that — but it is the exception, not the default.

## Task-complete criteria

A supervised task is **complete** when:

1. All deliverables described in its prompt exist as committed, pushed artefacts (RFC files, code files)
2. One or more PRs are open against `main`
3. Local verification is green (`pnpm build:server`, `pnpm check:e2e`, `pnpm test` — or whatever the repo pre-push hook runs)
4. PR `mergeable` field is `MERGEABLE`
5. PR URL(s) have been reported in the agent's last message

### CI-budget failures do NOT block completion

GitHub Actions can refuse to start jobs with:

> The job was not started because an Actions budget is preventing further use.

This is an **org-level quota issue, not a code failure**. Diagnostic signal: check-conclusion is `FAILURE` but the job duration is ~2 s and `gh run view <id>` shows the "Actions budget" annotation. When you see this, the task is still complete — report the PR as done and note the budget blocker separately for the user to resolve.

Distinguish from real failures: real failures have longer durations (tens of seconds to minutes) and show test/build output in `gh run view --log-failed`.

## Snoozed tasks

- A task with `snoozedUntil > now` should never receive keystrokes.
- A task the user told you to leave alone stays untouched **even after the snooze timer expires** — the user's instruction overrides the data model.
- Exclude the task from the sweep list and move on. Don't re-snooze unless the user asks.

## Polling cadence

You need a mechanism to wake yourself back up since live monitoring is not built in.

### Mechanisms (most → least reliable)

1. **`sleep N && echo wake` in `run_in_background: true`** — produces a task-completion notification after N seconds. Works in every harness mode.
2. **`ScheduleWakeup` tool** — only fires in `/loop` dynamic mode. If you were not invoked via `/loop`, it may silently not fire. Useful as a secondary trigger when `/loop` is active.
3. **Belt-and-suspenders** — schedule both. They are cheap.

### How long to sleep

- **Actively-working agents** (running critics, thinking, drafting) — check back in 15–20 min (`sleep 1200`).
- **Idle agents that just finished a step** — check back in 3–5 min if you expect them to kick off the next step on their own, longer if you already sent input.
- **Post-PR monitoring** (waiting for CI) — 10–20 min is reasonable; CI usually completes in a few minutes when the budget is OK.

Do not sleep > 3600 s in a single call; the runtime clamps it.

## Operational checklist per sweep

```
1. GET /api/tasks + /api/snapshot
2. Identify: (a) own taskId, (b) snoozed/excluded tasks, (c) supervised tasks
3. For each supervised task:
   - tmux capture-pane -pt <session> -S -60 | tail -60
   - Classify the state using the table above
   - If permission dialog → send "1" Enter
   - If stuck paste → send Enter
   - If idle at presentation checkpoint for an RFC → send RFC-continuation message
   - If actively working → no action
   - If done (PR URL reported) → mark complete in your own report
4. For each PR produced by a completed task:
   - gh pr view N --json state,mergeable,statusCheckRollup
   - If CI fails with 2-3 s duration → check gh run view for "Actions budget"
   - Treat budget failures as non-blocking
5. Schedule next wake (sleep + ScheduleWakeup)
6. Report summary table to user
```

## Reporting format

When reporting to the user between sweeps, use a compact status table:

| Task (first 8) | State | Action taken | Blocker |
|---|---|---|---|
| bf81808e | Snoozed | none | — |
| 128200ab | PR #329 open, local green | approved commit + push + gh pr create | Actions budget on CI (not blocking) |
| 2b5140b9 | Running critics (12m) | none | — |

End with a clear "next wake at HH:MM" line.

### Batch / multi-issue milestone reports

When you supervise a **pool** of issues (e.g. a parallel-issue-batch parent driving many children), the per-task table above is not enough — the user wants to see the *whole pool* at a glance. At each milestone (a wave completes, a PR merges, a new wave spawns), report progress in this shape:

1. **A per-issue table** keyed by issue, with an emoji status column, PR number, and a one-line note. Emoji make merged/in-flight/blocked scannable at a glance:

   | Issue | PR | State |
   |---|---|---|
   | #996 delivery target | #1047 | ✅ merged |
   | #1001 estimate drift | #1051 | ✅ merged (parent-merged after child over-caution) |
   | #997 conflict review queue | — | 🔨 implementing (owns `index.js`, `detection.md`) |

   Suggested glyphs: ✅ merged / done · 🔨 implementing / in-flight · ⏳ blocked-waiting · ⚠️ blocker recorded.

2. **A pool rollup** — one sentence stating coverage against the target, e.g. *"6 of the 10-issue pool now in-flight or done."*

3. **A remaining-pool list, each item annotated with WHY it hasn't started** — usually the specific shared/hub file it is waiting to be freed:

   - #995 mission board → blocked on `control-room.js` (owned by #1002)
   - #999 handoff packets → blocked on `control-room.js` (owned by #1002)

4. **Operational learnings** worth carrying into the next wave (e.g. "`main` has no required checks; CI `format:check` fails on pre-existing drift #1038, so children verify locally and merge past it").

The value is that the user never has to reconstruct pool state from scattered child terminals: one message shows what's done, what's running, what's queued, and the exact reason each queued item is waiting. Prefer this over dumping raw child output.

## Anti-patterns to avoid

- **Sending commands to your own tmux** — check the `a682c4c0`-style id of your supervisor task before every send.
- **Re-prompting the user for already-authorised actions** (approving a git commit after the RFC was drafted, approving PR creation after tests passed).
- **Treating CI budget failures as regressions** and sending "fix CI" instructions — agents can't fix quota limits.
- **Splitting RFC + implementation into two user checkpoints** when one was asked for.
- **Silently polling** — always tell the user when you scheduled the next wake and on what signal.
