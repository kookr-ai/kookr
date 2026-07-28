---
name: autonomous-watch-loop
description: >
  Run a long-lived watch/janitor task that polls a system on an interval and
  acts on what it finds. Use for "monitor X all day and do Y", task sweepers,
  queue drains that wait on external state, deploy and CI watchers, and any
  loop that would otherwise ping the operator every cycle with a status line.
keywords: >
  monitor, watch loop, watchdog, janitor, poll, hourly check, periodic check,
  heartbeat, background monitor, sweep tasks, close completed tasks, babysit,
  keep an eye on, status report, long-running task, Monitor tool
related: self-continuation-task, token-efficiency
---

# Autonomous Watch Loop

Use this when a task is phrased as *"monitor X all day"*, *"check Y every
hour"*, or *"keep watching Z and handle it"*. The runtime is cheap; the
operator's attention is not. A watch loop that reports every cycle converts a
12-hour autonomous run into 12 interruptions.

The discipline is three rules:

1. **The watcher emits events, not heartbeats.** Silence means healthy.
2. **Investigate before escalating.** Never hand back a bare "you may want to
   look at this".
3. **Every report answers done / outstanding / blocked-on-you.** Never raw
   counts alone.

## Use When

- The work is *waiting* punctuated by short bursts of action.
- Each cycle's finding is usually "nothing to do".
- You can express "something needs attention" as a mechanical predicate.

Do not use this for a queue you can drain immediately — that is
`self-continuation-task`. A watch loop exists because the interesting events
have not happened yet.

## Rule 1 — The Watcher Emits Events, Not Heartbeats

Put the filtering in the **watcher script**, not in your own prose. If the
script prints an hourly line, you will wake for it, end a turn on it, and the
operator gets a "waiting for your input" ping that carries no decision.

Emit only when one of these is true:

- an **actionable candidate** matched the predicate
- an **error** occurred (poll failed, endpoint moved, auth expired) — never
  fail silently
- a **threshold tripped** (see Rule 2)
- the **rollup interval** elapsed (once per day, or when the operator asks)

Otherwise print nothing and sleep. A rollup on a long interval is what keeps
silence unambiguous — it proves the watcher is alive without spending a turn
per cycle.

```bash
# Shape of it. Track state across cycles so you can emit only on change.
prev=""
while true; do
  snap=$(curl -s --max-time 30 "$API") || { echo "[$(date -u +%H:%M)] ERROR: poll failed"; sleep "$PERIOD"; continue; }
  echo "$snap" | jq -e 'type=="array"' >/dev/null 2>&1 \
    || { echo "[$(date -u +%H:%M)] ERROR: unexpected shape (route changed?)"; sleep "$PERIOD"; continue; }

  cand=$(echo "$snap" | jq -r "$PREDICATE")
  stuck=$(echo "$snap" | jq -r "$PARKED_PREDICATE")   # Rule 2

  if   [ -n "$cand" ];  then echo "[$(date -u +%H:%M)] ACTIONABLE:"; echo "$cand"
  elif [ "$stuck" != "$prev" ] && [ -n "$stuck" ]; then echo "[$(date -u +%H:%M)] PARKED (changed):"; echo "$stuck"
  elif [ $((cycle % ROLLUP_EVERY)) -eq 0 ]; then echo "[$(date -u +%H:%M)] rollup: $(echo "$snap" | jq -r "$LEDGER")"
  fi
  prev="$stuck"; cycle=$((cycle + 1)); sleep "$PERIOD"
done
```

Verify every endpoint and predicate **before** arming the watcher. A loop
launched against a 404 burns hours before anyone notices.

## Rule 2 — Investigate Before Escalating

Finding an anomaly is the start of your work, not the end of it. Walk the
ladder, and only stop when a rung is genuinely blocked:

| Rung | Action |
|---|---|
| 1. Observe | The predicate matched. Record it. |
| 2. Inspect | Read the thing. Pull the actual transcript, output, or log — `TaskOutput`, the task's last messages, the job's stderr. Do not reason from summary fields alone. |
| 3. Decide | Is it finished, stuck, waiting on a human, or dead? |
| 4. Act | Do the safe reversible thing yourself: close, nudge, retry, restart, file an issue. |
| 5. Escalate | Only if the action is irreversible, ambiguous, or outside your mandate. |

An item that trips the predicate for **more than two consecutive cycles** is
not a steady state — it is a backlog. Promote it to rung 2 and work it. Never
report the same unresolved anomaly twice in identical words; either you learned
something new about it or you should have.

When you do reach rung 5, escalate with a **proposal and a default**, not a
question:

> 9 tasks are parked at `completed_turn` with empty final messages. I read three
> transcripts: all finished their unit and stopped without signalling — a bug in
> the chain's exit path, not real work in flight. I filed #1441. **I plan to
> close all 9 at the next check unless you say otherwise.**

Not:

> ~~You may want to look at one of these directly.~~

## Rule 3 — The Report Contract

Whenever you do surface something, the operator must never have to ask "so
what's done?". Every report carries these four, and nothing decorative:

- **Done since last report** — what you closed, fixed, or resolved, with the
  evidence you acted on.
- **Outstanding** — each item, *why* it is still open, and how long it has been
  that way. A count is not a ledger; `inProgress=12` tells the operator nothing.
- **Blocked on you** — the specific decision needed, your recommendation, and
  what you will do by default if they stay silent. Empty most of the time.
- **Next check** — when, and what would make you speak sooner.

Ages and reasons are the load-bearing parts. "Parked 6h, waiting on a review
that never arrived" is actionable; "12 in progress" is not.

## Safety

Autonomy is bounded by reversibility, not by confidence.

- Prefer the **non-destructive** operation. Mark something terminal rather than
  deleting it; preserve history.
- Read the target's own final output before acting on it. A predicate says
  *maybe*; the transcript says *yes*.
- Never act on an item that has not declared itself finished **and** whose
  output you have not read.
- State your close/act predicate explicitly in your first report, so the
  operator can correct the bar early instead of after a day of sweeps.

## Anti-Patterns

- Hourly "nothing changed" turns. Nine content-free pings is a broken watcher,
  not diligence.
- Loading a tool you never call. If `TaskOutput` is in your belt and something
  is stuck, use it.
- Reporting an anomaly and moving on, then re-reporting "unchanged" for hours.
- Raw counts as a status report.
- Asking permission for a reversible action you could take and describe.
- Arming the watcher before verifying its endpoints and predicates.
- Swallowing poll errors — a silent watcher and a healthy system look identical.
