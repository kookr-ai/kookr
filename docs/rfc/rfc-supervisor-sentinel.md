# RFC: Supervisor sentinel — keep a long-lived lead alive, compacted and moving

**Status:** Draft (v3.2: post round 3 and consensus attack. A separate `SentinelService` reuses supervision's primitives. The lead's own timer stays, and the guard's tick is only a backstop.)
**Date:** 2026-11-21
**Author:** Jean Ibarz (with Claude)
**Evidence pack:** [`rfc-supervisor-sentinel-evidence.md`](./rfc-supervisor-sentinel-evidence.md)
**Related:** `rfc-attachable-task-supervisor.md` (`SupervisionService`, whose primitives are reused),
`rfc-kookr-ask.md`, `rfc-reap-grace-warning.md`, `plugin/skills/autonomous-watch-loop`.

---

## Summary

A long-lived **lead** task is the operator's single conversation with a fleet. It talks with the
operator, starts workers, reviews and merges. Today it is a single point of failure in three ways:

- it stays alive only through a timer armed inside its own session;
- its context grows without a plan;
- when the fleet stops moving, the operator is the one who notices.

This RFC adds a **sentinel** in two parts, which watch each other:

1. **The guard.** A small new `SentinelService` in Kookr's server, deterministic, ticking every 60 s.
   It reuses supervision's tested primitives: the dialog-safe input sender (extracted for sharing), the
   alert path to Telegram, and the system asks of `AskService`. Its main duties, each a small pure
   module:
   - **Backstop tick:** if the lead's own timer has not woken it for 25 minutes, the guard types a
     tick. The lead's timer stays the primary keep-alive.
   - **Worker events:** when one of the lead's workers ends or is reclaimed, the guard tells the lead
     within 2 minutes.
   - **Planned compaction:** at about 300k tokens it asks the lead for a handoff file, sends
     `/compact`, and confirms that it happened.
   - **Progress:** if nothing moves for 90 minutes, the lead is asked first, then the operator on
     Telegram, with buttons that actually unlock the situation.
2. **The sentinel agent.** A Haiku 5.5 run every 2 hours. It forms its own view of the lead (the
   transcript, the GPU, the run folders, the handoff file), then compares that view with the guard's.
   If they disagree it raises an alert. This is the small agent checking from time to time, and it
   keeps the deterministic code honest.

The entry point is one command, `kookr sentinel start --target <task> --for 3d`. A skill rule makes
any task asked to supervise for hours or days run it on itself.

**Two deliberate tradeoffs:**

- **The mechanics live in the server, not in the agent.** The operator first asked for "a very small
  agent checking from time to time" to do the whole job. Review showed every keep-alive and
  compaction decision is a mechanical check, and that an agent started by a schedule shares the very
  failures it guards against: skipped schedules raise no alert, and provider outages stop it too. So
  the agent became the auditor of the server code.
- **The guard is a separate service, not a mode of `SupervisionService`.** Round 2 showed that an
  "adopted" mode would overload a type built for launched mandates. Rollback would also be unsafe:
  old code would read an adopted lead as a crashed supervisor and launch a second lead. The guard
  reuses supervision's primitives, but keeps its own state and its own policy.

## Problem

Observed on the LFM3 fleet, 18–21 Nov 2026 (evidence pack §2):

- **Survival depends on one self-armed timer.** Kookr closes a task after 60 minutes of total
  silence on this host (25 by default). The lead lives because a session `CronCreate` tick wakes it
  every 20 minutes. That tick survives `/compact` (checkpoint §4), but nothing outside the session
  checks it. The lead has never been closed by the silence rule, so liveness is a backstop. The
  pressing problems are the next two.
- **Compaction is unplanned.** 5 compactions in 2 days, at 233k–493k tokens, none timed for a quiet
  moment. Since the last one the context grew to about 695k, at about 20k/h. A cached re-read at
  680k costs about 9 times what it costs at 75k.
- **Kookr's own reaper causes stalls, and the lead does not notice.** On 21 Nov at 12:26 and 12:29
  UTC two workers were reclaimed by the idle rule. The first had gone silent while waiting on its own
  GPU job, and the job died with it. The lead's own note at 12:34 UTC reads: "Test 3 session killed …
  when task 007332b1 was terminated (non-detached child)". Closing a task kills every process it
  started that is still its descendant. The ledger called the reclaim benign ("delivered PR before
  hanging"). The lead kept saying "in progress" until the operator asked.
- **Existing safeguards do not cover this.** `SupervisionService` handles only supervisors it
  launched, and never compacts. Most scheduled watchdogs here are skipped silently
  (`skipped_project_automation`, which the schedule dead-man ignores by design).

## Goals and non-goals

**Goals**

- **G1 Alive:** losing the lead's own timer no longer kills the lead. A lead that crashed, or that
  stopped answering, is reopened or reported to the operator within 45 minutes while the Kookr server
  is up.
- **G2 Compacted:** the lead is compacted at about 300k tokens, from a handoff file, at a moment the
  lead itself judges quiet.
- **G3 Moving:**
  - a worker's end reaches the lead within 2 minutes;
  - 90 minutes with nothing moving reaches the lead, and 30 minutes after that the operator, with
    answers that unlock the situation.
- **G4 Cheap:** under $0.50 a day. The audit is about 12 Haiku 5.5 runs a day at about $0.01 each.
  The guard costs only server CPU. The lead's own tick is unchanged.
- **G5 Watched:** the guard alerts when audits stop, and the auditor checks the guard. Alerts do not
  depend on any model provider.

**Non-goals**

- A second coordinator. The sentinel never talks to workers, starts or stops jobs, merges, or edits
  code.
- Judging the lead's work.
- Watching every task. One sentinel watches one lead.
- Changing what the reaper or `SupervisionService` decide. Launched mandates behave as before. The
  only changes are one extra input to the reaper's existing exemption predicate (§2.1), and moving
  supervision's delivery code into a shared sender, with pin tests. Fixing the reaper's own behaviour
  towards long-running jobs is O6.

## Design

### Overview

```
 kookr sentinel start --target <lead> --for 3d      (CLI → POST /api/sentinels)
   creates ~/.kookr/sentinels/<id>/ (own state; supervision code never scans it)
   creates the audit schedule; pastes the lead contract into the lead once

 SentinelService (server, 60 s tick)                         ← the guard
   facts ports: TaskFacts · TranscriptFacts · ChildEvents · OperatorActivity
   duties (pure): backstopTick+unresponsive · crashRecovery · workerEvents · compaction · progress · expiry
   effect interpreter + EscalationRouter → lead line | guard-owned system ask | alert
   shared with supervision: GuardedInputSender (extracted), alert emitter, AskService.createSystem
        │ guard-log.jsonl, state.json                ▲ reads audit verdicts
        ▼                                            │
 audit schedule, every 2 h (Haiku 5.5, read-only) ───┘
   own view first (transcript, nvidia-smi, run folders, handoff), then compare → audit-log.jsonl
```

### 0. Entry points

**Server resource.** `POST /api/sentinels`, `GET /api/sentinels[/:id]` and `DELETE /api/sentinels/:id`.
Creation writes the state directory and the audit schedule together. Deletion archives the schedule.
So there is one way to start a sentinel and one way to end it, with no orphaned schedule.

**CLI.** A thin wrapper over that resource:

- `kookr sentinel start --target <id> [--for 1h..7d] [--dry-run | --live <duties>]`.
  - **The default is live for every duty that has shipped as live.** During P0 none has, so every
    sentinel starts as a dry run. `--dry-run` forces a dry run, and the skill rule uses the default.
  - The flags work like this: `--live backstop,worker-events` turns duties on one at a time, and
  `kookr sentinel live <id> <duties>` turns more on later. The dry run posts one Telegram digest a
  day: "would have done: …". The lead's dashboard card shows a `sentinel: dry run` or
  `sentinel: live (backstop, …)` badge.
  - It is idempotent per target.
  - **Preflight:** it refuses, and says why, unless:
    - the target is live;
    - no sentinel already covers it;
    - Telegram is configured, or `--no-telegram` is passed;
    - the audit schedule's project has automation enabled;
    - the supervisor token, if one is configured, is available to the audit schedule.
  - On success it types the **lead contract** (§5) into the lead once. A running session never
    loads a newly added plugin skill, so this is how today's LFM3 lead adopts it without a restart.
- `kookr sentinel status [<id>] [--json]` shows:
  - which duties are live and which are in dry run;
  - the guard's **tick age** and its last tick error;
  - the last decision of each duty, with its reason (for example "compaction blocked: operator
    activity unknown");
  - the context size and the compaction step;
  - open asks, and refused asks;
  - the dedup keys and when they expire;
  - the last audit verdict, and the expiry.
- `kookr sentinel stop <id>` clears any compaction step in progress, cancels open asks with a
  notice, archives the audit schedule (reporting a failed archive), and writes a final `stopped` log
  line.

**Skill rule.** A new skill, `long-supervision`, referenced from the `task-supervisor` and
`goal-supervisor` playbooks and from `autonomous-watch-loop`. It says: a task told to supervise,
babysit, drive or watch something for hours or days runs
`kookr sentinel start --target "$KOOKR_TASK_ID" --for <mandate>` early on.

### 1. Facts (ports; read-only)

| Port | Source | Notes |
|---|---|---|
| `TaskFacts` | the task store, including the last screen-change time | Status, and the terminal reason plus its **disposition source** from the disposition ledger (`hung-suspect-ttl`, `hung-task-reaper`, `crash-recovery`, operator, `completion_ready`). The source is a structured field, never prose. |
| `TranscriptFacts` | the transcript path from the hook stream's `transcript_path` | **Context size:** last assistant entry with non-zero usage, `input + cache_read + cache_creation`. **Last turn end:** last `turn_duration`. **Last assistant entry time.** **`compact_boundary` times.** Every read filters by timestamp, because the file is not chronological. A missing value is `unknown`, never 0. |
| `ChildEvents` | the task store's `parentTaskId` | Ends, reclaims and starts of the lead's workers, with disposition source. |
| `OperatorActivity` | the user-input delivery log by `source` | The operator's own inputs count: dashboard, Telegram `directReply`, the operator's CLI, and `operator-via-sentinel`. Sentinel input (`source: 'sentinel'`) does not. The guard types only through `GuardedInputSender`, which writes this log. Sentinel asks are system asks and never type into the lead, so a Telegram `directReply` is always the operator. Until the tag ships, operator activity is `unknown`, which counts as "not quiet". |

### 2. Duties (pure functions of facts and the sentinel's state)

**2.1 Backstop tick, and a bounded reap exemption.**

- **The exemption.** A live (not dry-run) sentinel's lead is exempt from the hungSuspect idle reclaim
  for at most **45 minutes** after its last sign of life: an assistant entry, or a change on its
  screen. The exemption is one more input to the reclaim selector's existing injected predicate,
  modelled on `isAwaitingScheduledWake` (#4162).
  - Without it, a default host's 25-minute TTL would race the 25-minute backstop tick.
  - After 45 minutes of nothing, the exemption lapses and normal reaping applies.
  - A dry-run sentinel never changes reaping.
- **The tick.** If there has been no sign of life for 25 minutes, the guard types:
  `[kookr sentinel] no turn for 25 min. Run your tick now, and re-create it (CronCreate) if CronList shows none.`
  - The lead's own 20-minute timer normally prevents this, so in normal operation the guard types
    nothing and never interrupts a conversation.
  - Delivery goes through the shared `GuardedInputSender` (§Files), which refuses dialogs.
  - Typing into a busy pane is safe: the input queues and runs when the turn ends (checkpoint §4).
- **Unresponsive.** No sign of life for 15 minutes after a backstop tick (40 minutes in total) makes
  the lead **unresponsive**.
  - The "screen changing" part covers a long tool call, which writes no transcript entry for many
    minutes.
  - The guard asks the operator (guard-owned, §3): *Lead <name> unresponsive for 40 min (last sign of
    life HH:MM)*, with the options **Close it and reopen** · **Leave it (no reopen)** · free text.
  - **Close it and reopen** terminates the task through the existing terminate use case, and then
    reopens it. This is the only path to closing a live task, and it needs the operator's tap. The
    guard never does it on its own.
  - **A process still running under the lead changes the ask.** `TaskFacts` lists the live
    descendant processes of the lead's session, excluding the agent and its shell. If any are
    running, the ask says "the lead is quiet but <cmd> (pid N) has been running for 47 min", and
    warns that **Close it and reopen kills it**. It then offers **Keep waiting** as well, which
    extends the exemption while that process lives.
  - **Leave it (no reopen)** lifts the exemption, so normal reaping applies. It also records a
    suppression: if the reaper then closes the lead, crash recovery (§2.2) alerts instead of
    reopening, for this episode only. "No answer" keeps the exemption until it lapses, then the
    normal §2.2 rules apply.
  - Free text is typed into the lead.

**2.2 Crash recovery.** This duty reads the task's terminal **status and transition source**
(`TerminalTransitionSource`), plus the disposition entry's **kind and source** together:

| Observed | Action |
|---|---|
| reclaimed by `hung-suspect-ttl` or `hung-task-reaper` (disposition `obsolete` or terminated `timeout`) | `kookr reopen`, at most once per 30 min and 3 times per sentinel. The idempotency key `reopen:<lead>:<terminalAt>` is written before acting and checked against task status on the next tick. It retries on `task_cleanup_in_progress`. |
| `crash-recovery` · `respawned` | Kookr already relaunched it. Type the lead contract again, with no reopen. |
| `crash-recovery` · `needs-human` (crash-loop protection) | **No reopen**: the protection wins. Alert. |
| `provider_transient`, or anything unlisted | No reopen. Alert. |
| completed, or cancelled by the operator | End the sentinel, with an info alert. |
| `completion_ready` raised by the lead | Keep the sentinel, and alert (§2.6). |

After a reopen, the first line typed says: "reopened after <reason>. Re-check every job in your
handoff against ps and gh before continuing." When the reopen budget is spent, the guard alerts
"reopen budget exhausted".

**2.3 Worker events.**

- Within 2 minutes of a worker ending, the guard types
  `[kookr sentinel] worker <name> ended at 12:26 (<disposition source>). Check its job.`
- **A reclaim carries a warning.** When the source is a reclaim (`hung-suspect-ttl`,
  `hung-task-reaper`), the line adds: "Kookr killed every non-detached process it started. If it
  owned a run, that run is dead. Relaunch it detached, and tell the new worker to poll in bounded
  loops instead of waiting silently."
- Several events within 2 minutes are batched into one line.
- **A reclaim loop is a stall.** When two workers of the lead are reclaimed within 4 hours, the guard
  treats it as a stall at once. In P1 that raises an operational alert. From P3 it raises the
  operator ask (§2.5), with the reclaim times in the facts.

**2.4 Planned compaction.** The guard keeps one field, `compaction: {requestedAt?, sentAt?}`.

1. **Request.** When context ≥ 300k and the operator has been quiet for 20 minutes, the guard types:
   "context 312k. When nothing needs you for the next 5 min, write `<dir>/handoff.md` and
   `fleet-state.json`, checking each entry against gh, ps and the run folders, then answer with a line
   containing only `HANDOFF READY`. If now is a bad moment, answer `HANDOFF LATER`."
   - It sets `requestedAt`.
   - After a `HANDOFF LATER`, it asks again 1 hour later.
2. **Send.** When an **assistant** entry dated after `requestedAt` holds a standalone line
   `HANDOFF READY`, and both handoff files are newer than `requestedAt`, the guard types
   `/compact The authoritative state is <dir>/handoff.md and fleet-state.json. Keep standing rules and pending decisions verbatim.`
   It sets `sentAt`. The guard's own prompt is a user entry, so it can never match.
3. **Confirm.** A `compact_boundary` dated after `sentAt` clears the field.
4. **Resume.** A stateless rule: if a `compact_boundary` is newer than the last guard line, the next
   line the guard types starts with "compacted: re-read `<dir>/handoff.md` first."
5. **Timeouts and escalation.**
   - If no `HANDOFF READY` arrives within 1 hour, or no `compact_boundary` within 15 minutes of
     `sentAt`, the guard clears the field and logs it.
   - At 850k with nothing sent in 2 hours, it asks the operator (guard-owned): **Compact now**
     (send the request and skip the quiet rule) · **Wait 1 h**.

**2.5 Progress.** The fingerprint uses **Kookr-native facts only**:

- the lead's workers: their set and states, plus starts and ends;
- the lead's open PRs, their head SHAs, and the merged count, through Kookr's GitHub integration.

The lead's own messages are excluded, so its answers to ticks cannot reset the clock. **Worker
churn does not count as progress either.** A worker that starts, or that ends by reclaim or crash,
does not reset the clock. Only a worker ending with a delivered result (completion or merge), or a PR
change, does. Otherwise a relaunch-then-reap loop would look like a fleet that is moving. A fact that is
`unavailable` counts as "no change observed". GPU and run-folder freshness are project-shaped, so
the auditor checks those instead.

- **A declared long job explains the wait.** A job listed in `fleet-state.json` (PID, expected end)
  explains a stall while its PID is alive (`/proc`) and its expected end has not passed by more than
  30 minutes. A single 4-hour eval therefore raises no ask. A job that dies early, or overruns,
  starts the clock again.
- 90 minutes unchanged: the guard tells the lead what is stale, and asks it to say what it is waiting
  on, or to act.
- If the lead answers with a line `WAITING ON OPERATOR: <what>`, the stall is explained. The operator
  is reminded once every 4 hours at most, instead of being asked.
- If 30 more minutes pass unchanged and unexplained, the guard sends an operator ask (§3).

**2.6 Expiry.**

- 1 hour before `--for` ends, the guard asks the operator (guard-owned): **Renew 3 days** · **Let it
  expire**.
- On expiry it types into the lead: "sentinel ended; make sure your own CronCreate tick exists."
  It never says "signal completion-ready".
- `completion_ready` raised by the lead during a sentinel does **not** end the sentinel. It alerts
  the operator, because the stop-hook nudge can push a lead to raise it by mistake. Guarded tasks get
  no stop nudge: the sentinel sets a generic per-task flag, `suppressStopNudge`, on the task API
  that the nudge script already calls at runtime. This also covers sessions launched earlier.

### 3. Escalation: one router, and everything goes through it

`AskService` cannot route single options of one ask to different handlers. A task ask's answer is
typed into the task; a system ask's answer goes to its owner. So **every sentinel ask is a system ask
owned by the guard**, under its own system id `system:sentinel-<id>`. The guard carries out each answer
itself, including the options that type text into the lead. The router is therefore the only path
from the sentinel to the operator and to the lead, and dry run, SAFE MODE and dedup apply to all of
it.

| Channel | Used for |
|---|---|
| **Line typed into the lead** (through `GuardedInputSender`, `source: 'sentinel'`) | ticks, worker events, compaction requests, first stall notice, and relayed operator answers (`source: 'operator-via-sentinel'`, which counts as operator activity) |
| **Guard-owned ask** (system ask; the answer reaches the guard) | *Unresponsive*, *Compact now?*, *Renew sentinel?*, and *No progress*. The last offers **Send me the facts** (posted as a Telegram alert) · **Nudge the lead** (types the stale facts into the lead) · **Snooze 3 h** · free text (relayed into the lead) |
| **Operational alert** (the server's Telegram path; needs no model) | provider outage, audit missing, auditor `disagree`, reopen budget exhausted, crash-loop `needs-human`, unexpected `completion_ready`, compaction failed twice, guard tick errors, and any ask the ask service refused (`rate_limited`, `not_configured`) |

- **Message format.** Every message starts `[sentinel · <lead name> · <trigger>]`, then states the
  facts behind it (ages, sizes, worker names). In dry run every message carries `DRY RUN: no action
  will be taken`.
- **Answers are confirmed.** Once an answer has been carried out, the guard posts what it did, for
  example "Nudge sent to lead at 14:02". An answer arriving after the sentinel ended, or a second
  answer, is logged and acknowledged as "no longer applicable".
- **Dedup.** Keys are `<condition>:<lead>:<conditionStartedAt>`, stored in the sentinel state, so
  they outlive an ask's 2-hour timeout. A refused ask does not consume its key; it is retried on the
  next tick after an alert.
- **Ask timeout:** 2 hours.

### 4. The audit agent

- **What runs:** a schedule every 2 hours with the model pinned to `claude-haiku-5-5`. The `small`
  tier would resolve to the 10-times-pricier `claude-haiku-4-5`. It is read-only, with its tools
  restricted mechanically (O2).
- **Blind first, then compare:**
  1. It forms its own view from raw sources: the lead's last transcript entries, `nvidia-smi`, the run
     folders named in the handoff, the handoff itself, and the worker states.
  2. Only then does it read the guard's latest decisions.
  3. It writes one verdict to its own `audit-log.jsonl`: `agree`, or `disagree` with the specific
     mismatch.
- **The guard reads the verdicts:**
  - A `disagree` of a new kind raises an alert; the same kind repeats at most once a day.
  - No completed audit in 5 hours, for whatever reason, raises an alert.
- **What the audit catches that the guard cannot:**
  - project-shaped stalls: the GPU idle with work queued, or no new artifact during a "running" job;
  - a handoff that contradicts reality;
  - guard facts read wrongly, such as a context size that disagrees with the transcript.
- **The guard's own liveness** is not left to the auditor, which runs only every 2 hours. The
  guard records `lastTickAt` and its last tick error. The server's existing lifecycle health check
  alerts when a live sentinel's tick is older than 3 minutes or has failed 3 times in a row. A down
  server remains out of scope.

### 5. The lead contract

Typed once by `start`, and also in the skill:

- Keep your own `CronCreate` tick. The sentinel is a backstop, not a replacement.
- **Launch every long job detached** (`setsid nohup …`, or a separate scope), and record its PID and
  exit marker in `fleet-state.json`. Brief every worker with the same rule. Workers waiting on a job
  must poll in bounded loops of under 10 minutes, never wait silently. Kookr kills a closed task's
  non-detached processes.
- Answer `HANDOFF READY` or `HANDOFF LATER` when asked, re-read the handoff after a compaction or a
  reopen, and say `WAITING ON OPERATOR: <what>` when that is the case.
- While guarded, ignore any nudge to raise completion-ready unless the operator asked you to finish.

### 6. Failures each part shares with the lead

| Failure | Lead | Guard | Auditor | Who notices |
|---|---|---|---|---|
| Lead's own timer lost | quiet | backstop tick at 25 min | runs | guard |
| Lead alive but not answering | quiet | asks the operator after 15 min | runs | guard |
| Lead reaped or crashed | gone | reopens | runs | guard |
| Provider outage | stalls | runs, no reopen | skipped | guard alert (no model needed) |
| Audit skipped (project pause, capacity) | runs | runs | silent | guard (no audit in 5 h) |
| Guard misreads facts | runs | wrong | runs | auditor (`disagree`) |
| SAFE MODE or drain | the lead's own timer still works | alerts only, no typing | skipped | intentional; the lead's own timer keeps it alive |
| Kookr server down | gone | gone | gone | Kookr crash recovery; out of scope |

## Phased delivery

| Phase | Content | Exit criterion |
|---|---|---|
| **P-1 (this week, by hand)** | Planned compaction of the LFM3 lead: it writes a handoff, then the operator or a task sends `kookr reply <lead> "/compact …"`. A short script confirms the `compact_boundary`. | The lead resumes correctly from the handoff, with context under 100k. Note the reopen cost (O4) and the automatic threshold (O3). |
| **P0** | Pure duty modules, the router and the transcript reader with fixtures (non-chronological lines, zero usage, partial lines, a boundary before the send, shuffled lines, a crash-loop `needs-human` entry). `GuardedInputSender` extracted, with supervision pin tests. `SentinelService` with every duty in dry run, its own state directory, `/api/sentinels`, `kookr sentinel start/status/stop/live`, the daily dry-run digest, and the new `source` values. | Unit tests pass, and the existing supervision tests pass unchanged. 24 h on LFM3 with a scored list: each would-be action compared with what happened. 0 "unresponsive" verdicts while the lead was visibly alive. |
| **P1** | Live (`--live backstop,worker-events,expiry`): the bounded reap exemption, backstop tick, worker events, unresponsive ask, alerts, guard tick health, and stop-nudge suppression. | Drill 1: delete the lead's tick; the backstop tick arrives within 25 min. Drill 2: a worker reclaim reaches the lead within 2 min. |
| **P2** | Live: compaction (operator-attended for the first 2), and reopen. | 3 planned compactions with 0 automatic ones. Drill 3: close the lead; it is reopened and told to re-check its jobs. |
| **P3** | Progress asks and the audit schedule. | One week with fewer than 2 false asks. The auditor catches a **planted** guard fault (a fixture with a wrong context size), and false `disagree` stays under 1 per day. |

**Rollback:** each phase is one PR. Sentinel state lives in its own directory, so reverting leaves
launched supervisions untouched. `kookr sentinel live <id> none` (back to dry run) and `kookr sentinel stop` are the per-lead switches, and
`KOOKR_SENTINEL_DISABLED` is the global one.

## Requirements

- R1. The guard closes a live task only after the operator taps **Close it and reopen**. It reopens
  a terminal task only for the listed reclaim sources, and never against crash-loop protection.
- R2. `/compact` is sent only after an assistant `HANDOFF READY` dated after the request, with both
  handoff files newer than the request. It is confirmed only by a later `compact_boundary`.
- R3. An `unknown` or `unavailable` fact never makes the lead look healthy, quiet or moving.
- R4. The lead's own timer stays the primary keep-alive. Disabling the sentinel, or closing the
  autonomy gate, never removes it.
- R5. Every guard decision, including "nothing", writes one log line with its reason and the facts
  behind it.
- R6. One router dedups every operator contact, and keys outlive ask timeouts.
- R7. The auditor is read-only, mechanically, and forms its own view before reading the guard's.
- R8. Launched `kookr supervise` mandates behave exactly as before.
- R9. The reap exemption applies only to a live sentinel's lead, and lapses 45 minutes after the
  lead's last sign of life.
- R10. Any ask the ask service refuses becomes an alert and a log line, and its dedup key is not
  consumed.

## Files to change

- `src/core/sentinel/` (new, pure): the duties `backstop-tick.ts`, `worker-events.ts`, `compaction.ts`,
  `progress.ts` and `expiry.ts`, plus `escalation-router.ts` and `types.ts`.
- `src/server/sentinel/` (new):
  - `sentinel-service.ts`, the 60-second tick and the state files;
  - the facts adapters `task-facts.ts`, `transcript-facts.ts`, `child-events.ts` and
    `operator-activity.ts`;
  - `sentinel-routes.ts`.
- `src/server/guarded-input-sender.ts` (new). It is extracted from `SupervisionService.deliver()`,
  which does `guardChoiceDialog` then `sendInput`, and it now also writes the user-input delivery log
  with a `source`. Supervision switches to it, with pin tests first.
- `src/core/sentinel/crash-recovery.ts`, with the backstop and unresponsive rules in
  `backstop-tick.ts`.
- `src/server/hung-suspect-ttl-sweep.ts`: one more input to the injected exemption predicate.
- **Reused:** the operational-alert emitter, `AskService.createSystem`, and the terminate and reopen
  use cases. Asks are reached through a small port over `AskService`, with rate-limit results passed
  back to the caller.
- Both JSONL logs carry `schemaVersion: 1`, with a fixture test.
- The schedule is created and archived through a schedule-service port.
- `src/shared/contracts/user-input-delivery.ts`: the `sentinel` and `operator-via-sentinel` sources.
- `src/cli/kookr-sentinel.ts` (new) and its dispatcher entry.
- The stop-nudge hook: skip tasks with `suppressStopNudge`. The task API gains that generic flag.
- `plugin/playbooks/sentinel-audit.md`, `plugin/skills/long-supervision/SKILL.md`, the references from
  the supervisor playbooks and `autonomous-watch-loop`, and the `plugin.json` version bump.
- `docs/reference/api.md` for the new `/api/sentinels` routes, the CLI reference, and
  `environment-variables.md` for `KOOKR_SENTINEL_DISABLED`.

## Edge cases

- **The operator is chatting:** the lead's own timer keeps it busy, so backstop ticks do not fire.
  Compaction waits for 20 minutes of operator quiet, by `source`. Stall asks wait 30 minutes after an
  operator message.
- **A lead that runs for weeks:** renewal asks before each expiry. "Let it expire" hands keep-alive
  back to the lead's own timer.
- **A reopened 695k session:** the cold cache costs about $3.5 once, and the compaction request comes
  at the next opportunity. If P-1 shows a reopen resumes badly, P2 replaces reopen with a fresh launch
  from the handoff.
- **The lead never says `HANDOFF READY`:** it is asked again every hour, and at 850k the operator is
  asked.
- **`turn_duration` missing:** `TranscriptFacts` uses the last assistant entry time instead. Fixtures
  cover both.
- **Worker events during an operator conversation:** they are typed anyway. They are short and
  relevant, and they queue behind any running turn.
- **Several leads:** one sentinel each.

## Alternatives considered

1. **Two supervisors that watch each other.** Rejected. They share the same failure domain, they risk
   acting twice on the fleet, and they double the cost of the most expensive role.
2. **v1: a schedule-only Haiku sentinel every 15 minutes that does everything.** Rejected in round 1.
   Its rules were all mechanical. Schedule skips and provider outages silence it. It starts 96 tasks a
   day. It needed answers read back by a later run. Its useful part survives as the auditor.
3. **v2: an "adopted" mode inside `SupervisionService`.** Rejected in round 2:
   - it overloads a type built for launched mandates (required targets, deadline-wake semantics,
     restart by launching);
   - it would have told an adopted lead "signal completion-ready" at the deadline;
   - rolling it back would make old code launch a second lead.

   The separate service reuses the same primitives without those couplings.
4. **The guard's tick replacing the lead's timer.** Rejected in round 2. Every off-switch (SAFE MODE,
   drain, dry run, stop) would leave the lead with no tick and get it closed.
5. **A pure script on a systemd timer.** Rejected. It shares neither Kookr's state nor its alert
   path.
6. **A PreCompact hook in the lead.** It can write a snapshot but not choose the moment. It is a
   possible complement.

## Open questions

- O1. *Resolved by experiment* (evidence pack §4). External and queued `/compact` both work, and
  `CronCreate` survives them.
- O2. How is the auditor's tool set restricted mechanically: a schedule-level tool restriction, if
  Kookr supports one, or a PreToolUse hook keyed on the playbook?
- O3. Which automatic compaction threshold applies to Kookr tasks? If it is settable, set it above
  300k so planned compaction comes first.
- O4. Does a reopened long session resume well enough, or should recovery start a fresh lead from the
  handoff? P-1 and P2 measure this.
- O5. Should a second fleet need it, `fleet-state.json` could declare its own progress sources for
  the auditor.
- O6. **Out of scope here, recommended as a follow-up issue.** Should Kookr's idle reaper reclaim a
  task that owns a live, long-running descendant process (a GPU job) at all? Or should it reclaim
  without killing such a process? This RFC mitigates the problem (the detach rule, reclaim warnings,
  reclaim loops counted as stalls), but the cause sits in the reaper.
- O7. **PR attribution is unverified.** No per-task PR field was found in the task contracts
  (`completion-digest` has `prUrls`). Until a per-lead PR signal is confirmed, progress rests on
  worker completions with a delivered result, plus declared jobs. PR head changes are added once
  attribution exists.
- O8. **Night-time alerts.** Should *unresponsive*, *reopen failed* and *crash-loop* alerts bypass
  quiet hours? Supervision alerts carry a server-internal `bypassQuietHours`, used only after
  self-healing fails. G1's 45 minutes holds overnight only if these alerts may wake the operator.
- **Not verified at source:**
  - listing the lead's live descendant processes;
  - the last screen-change time in `TaskFacts`;
  - that the lifecycle health check can alert on a stale sentinel tick;
  - the stop-nudge hook reading a task flag.

  P0 confirms or replaces each one.

## Critic feedback incorporated

**Round 1 (2026-11-21).** Panel: `failure-mode-analyst`, `design-minimalist`, `ambition-amplifier`,
`operability-reviewer`, `socratic-challenger` (N=5). `boundary-critic` was deferred to round 2.

- **ambition-amplifier 2026-11-21: novel finding.** Move liveness to the server. Close the
  provider-outage gap. Add a deterministic backstop for the skill trigger.
- **Adversarial pair:** the minimalist said "the ladder is mechanical, drop the LLM"; ambition said
  "move liveness to the server". I agreed with both on putting the mechanics in the server, and
  disagreed with the minimalist on dropping the agent: the operator explicitly wants a small agent,
  and distrusts unwatched deterministic code. The agent is kept as the auditor.
- **Incorporated:**
  - a server-side guard;
  - asks filed under the lead where the lead acts;
  - compaction confirmed by `compact_boundary`;
  - a deterministic reopen list;
  - worker events relayed to the lead;
  - the corrected incident timeline;
  - liveness treated as a backstop;
  - one log line per decision;
  - an alert when audits are missing;
  - audits every 2 h (12 runs a day instead of 96);
  - a supervisor-token preflight.
- **Rejected:**
  - dropping the LLM;
  - cutting `status`/`stop`;
  - a `--urgent` flag on `kookr ask`, because operator contact now goes through server alerts.
    Their night-time behaviour is O8.

**Empirical checkpoint after round 1** (`design-experimenter` 2026-11-21, on a throwaway Haiku task,
$0.20):

- Confirmed: external and queued `/compact` both work, and `CronCreate` survives them.
- Found: `lastTurnState` is unreliable; the transcript path comes from the hook stream; the
  transcript is not chronological; the stop nudge fires on cron turns.

**Round 2 (2026-11-21).** Panel: `boundary-critic`, `failure-mode-analyst`, `design-minimalist`,
`socratic-challenger`, `delivery-pragmatist` (N=5). `ambition-amplifier` was skipped, because the
revision adds no deferred items.

- **Incorporated:**
  - **A separate `SentinelService`** in its own state directory, with duties as pure modules behind
    ports and one escalation router reusing the asks port (boundary #1–4; delivery's rollback
    hazard).
  - **The lead keeps its own timer, and the guard's tick is a backstop** (failure-mode #1). This
    also stops ticks landing in operator conversations (socratic Q6).
  - **Expiry asks to renew**, and never says "signal completion-ready" (failure-mode #2,
    socratic Q1).
  - **`completion_ready` alerts instead of ending the sentinel**, and guarded tasks get no stop nudge
    (failure-mode #3, delivery).
  - **"Dead 10 min after a tick" is replaced** by an explicit "unresponsive" check, built on
    transcript facts instead of hook turn state, which asks the operator rather than restarting
    (failure-mode #4).
  - **Operator activity is measured by `source`, with sentinel input tagged**, and is `unknown` until
    then (failure-mode #5).
  - **Guard-owned asks** for options the guard carries out, and **Send me the facts** over Telegram
    (failure-mode #6, socratic Q5).
  - **`HANDOFF READY` is accepted only on a standalone line in an assistant entry** (failure-mode #7).
  - **Reopen is keyed on the disposition source**, with an idempotency key, and `provider_transient`
    only alerts (failure-mode #8).
  - **The auditor forms its own view first**, writes its own log, has its alerts deduped, and must
    catch a planted fault (boundary #5, failure-mode #9, socratic Q4).
  - **The fingerprint uses Kookr-native facts only**, excluding the lead's messages; project facts go
    to the auditor, and the lead can say `WAITING ON OPERATOR` (boundary #3, minimalist, socratic Q3,
    failure-mode #10).
  - **The server resource has a thin CLI** (boundary #6).
  - **The contract is typed into a running lead** (socratic Q7).
  - **Phase P-1 compacts the LFM3 lead by hand this week**, and the phases are re-sliced (delivery).
  - **Cut:** the circuit breaker, the 5 modes (now a dry-run flag only), `--tick`/`--compact-at`,
    `note`, guard-triggered audits, the `resuming` phase, and the "no sentinel" backstop card
    (minimalist).
- **Rejected:**
  - *Two PRs instead of five phases* (minimalist): rejected in favour of the delivery-pragmatist's
    smaller, safer slices. Five one-PR phases are kept as a compromise.
- **Deferred:**
  - fresh launch instead of reopen (O4);
  - compaction for launched mandates;
  - lead-declared progress sources (O5).

**Round 3 (2026-11-21).** Panel: `failure-mode-analyst`, `boundary-critic`, `operability-reviewer`
(N=3). This was a confirmation pass.

- **Incorporated:**
  - A bounded 45-minute reap exemption for a live sentinel's lead. It removes the race on default
    25-minute hosts and the reaper-versus-reopen fight (boundary high, failure-mode #1).
  - "Unresponsive" now needs both the transcript and the screen to be silent. Its button is
    **Close it and reopen**, a tapped terminate then reopen, because `reopen` refuses live tasks
    (failure-mode #4).
  - Reopen is keyed on disposition kind plus source. It never overrides crash-loop protection, and a
    `respawned` lead only gets the contract typed again (failure-mode #8).
  - All sentinel asks are system asks owned by the guard, so the router alone types into the lead.
    `AskService` cannot route single options (failure-mode #6, boundary "two typists").
  - Refused asks become alerts, and their dedup keys are kept (failure-mode, operability).
  - A `GuardedInputSender` is extracted from `SupervisionService` and writes the delivery log with
    `source` (boundary high ×2).
  - The asks seam is corrected to `AskService.createSystem` (boundary).
  - A generic `suppressStopNudge` task flag (boundary).
  - A named crash-recovery duty and an effect interpreter (boundary).
  - Versioned logs, and a schedule port (boundary).
  - Dry run is per duty, with `--live`. It is visible in a card badge, in a `DRY RUN` tag on every
    message, and in a daily digest (operability high).
  - Guard tick-age health alerts (operability high).
  - A message header naming the sentinel, lead and trigger, and confirmation of every answer
    carried out (operability high).
  - `stop` is safe mid-state (operability).
  - "Compaction failed twice" and "reopen budget exhausted" alerts (operability).
- **Rejected:** none.

**Consensus attack — `general-purpose 2026-11-21: consensus-attack — finding`.** The whole panel
framed the 21 Nov incident as a detection failure. The lead's own transcript shows the reaper
*caused* it: a silent worker waiting on its GPU job was reclaimed, and the process-tree kill took the
job with it. With churn counted as progress, a relaunch-then-reap loop would never look stalled.
*Incorporated (one revision):*

- the reframed problem;
- reclaim lines that warn the job died;
- two reclaims within 4 hours counted as a stall;
- worker churn excluded from progress;
- live descendant processes shown in the *unresponsive* ask, with a **Keep waiting** option;
- the detach and bounded-poll rule in the lead contract and the skill;
- the reaper question recorded as O6, recommended as a follow-up issue.

**Intent preservation check:**

- "Kept alive": G1, and the lead's own timer stays.
- "Compact every 300k with a handoff file": §2.4.
- "Telegram notification I can answer to unlock": §3; answers are executed by the guard or typed
  into the lead.
- "A command and/or skill that a supervising task knows to start": §0.
- "A very small agent checking from time to time": the auditor. The mechanics moved to the server,
  which is an explicit tradeoff stated in the Summary.
- "Not two supervisors": unchanged.
