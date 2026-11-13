# RFC: Operator Attention Notifications to Telegram — confirmed-need gating + durable delivery + reachable report links

**Status:** Accepted (direction approved by the operator 2026-11-13; v3 design, revised for what has since shipped)
**Date:** 2026-11-07 (revised 2026-11-13)
**Author:** Jean Ibarz (with Claude)

---

## Update 2026-11-13: what has shipped since this draft

The direction was approved on 2026-11-13. Two pieces landed through other PRs while
this RFC was waiting for that approval:

- **R3 (the source fix) is done.** #3512 added `src/core/background-parked.ts`. Its
  `isBackgroundParked` predicate is now shared by `turn-state.ts` and
  `anomaly-detector.ts`, and `detectNeedsInput` returns `null` for a parked agent.
  #3573 extended the same idea to the watchdog and the hung-task reaper with a bounded
  `background_parked` verdict (45 minutes). Slice 1 step 1 is therefore complete.
- **Replying from Telegram exists.** #3512 added quick-reply buttons and reply routing
  for a running task. `kookr ask` (#3539 RFC; #3540, #3542, #3543, #3547, #3681) lets an agent
  ask the operator a multiple-choice question over Telegram. This RFC still owns the
  *outbound* side: deciding which events notify the operator, for every task, delivered
  durably, with a reachable report.

Nothing else here has been built yet: R1, R2, and R4 through R10 are open. Line
references in the Problem and Empirical Checkpoint sections describe `origin/main` on
2026-11-07, before #3512. They are kept as the record of why the design looks the way it
does. Where they describe the R3 gap, that gap is now closed.

---

## Problem

Kookr is a smart attention router, but its outbound "come back, an agent needs you"
channel is incomplete and untrustworthy on the axes the operator cares about most.

### P1 — Notifications can't reach the operator for most tasks

Outbound Telegram messages about a task (`completion_ready` / `completed` / `failed`
/ `cancelled`, or a permission block) are sent **only when the task was spawned from
Telegram**: both callbacks look up `state.get().origin[taskId]` and silently no-op
when it is absent (`src/integrations/telegram/index.ts:708-712, 742-746`;
`permission-block-alert-processor.ts:59`). A task started from the dashboard or
locally — the common case — produces **no Telegram notification at all**. Verified:
`completion_ready` already reaches `onTaskOutcome` for non-remote tasks
(`delivered-task-completion-sweep.ts:172` calls it unconditionally); only the
handler's origin gate drops it. The operator's ask was simply "tell me on Telegram
when *this* task needs me," independent of launch path.

### P2 — When notifications fire, they fire falsely (the core requirement)

The operator's hard requirement: notify **only when it is accurately confirmed the
agent needs me** — never when the agent has merely parked itself on a background
shell, a long-running tool, or a scheduled wakeup (e.g. a 20-minute sleep). And,
because a missed real block is worse than a spurious ping, the gate must be
**fail-closed**: absence of a confirmed signal means *no* notification, not a guess.

*(Shipped 2026-11: the gap below was closed by #3512 and #3573; see the update at the top.)*

Kookr already has the information to tell these apart, but on the wrong code path:

- `turn-state.ts:46-68` reads `activeBackgroundTaskCount` / `activeSessionCronCount`
  (carried on every Stop hook) and returns `turnState: 'running'` when the agent
  parked itself on its own background work.
- The **anomaly path that feeds the attention surface is blind to those counts.**
  `detectNeedsInput` mints a `needs_input` (`subType:'stop'`) anomaly on *every* Stop
  (`src/core/anomaly-detector.ts:367-381`) — verified: a grep for
  `activeBackgroundTaskCount` in that file returns nothing.

The blindness is not just a Telegram problem. The **same** spurious `needs_input`
anomaly drives **desktop notifications and sound** (`useNotifications.ts` keys on
`agent.anomaly`, verified) and triggers **`response-assist` LLM spend**
(`response-assist-processor.ts:53`). A 20-minute background sleep therefore already
mislabels the dashboard, can buzz the desktop, and can spend tokens. Fixing only the
Telegram path would leave three other consumers lying. The honest fix is at the
source.

### P3 — Enabling is env-file surgery split across two unrelated paths

No settings UI. Enabling means hand-editing `.env` in exactly one worktree (there is
a single-worktree lock, `safety.ts:68`), and the two Telegram code paths need
*different* variables — signal-delivery wants `KOOKR_SIGNAL_TELEGRAM_CHAT_ID`
(`config.ts:46`); the bot wants `KOOKR_TELEGRAM_ALLOWED_USERS` +
`KOOKR_REMOTE_CHAT_PROJECTS`. `config-preflight.ts` validates only the API host, not
the token/chat/allowlist, so a half-configured setup fails only at runtime.

### P4 — The link is a live dashboard view, not a reachable "what happened / what's next" report

Remote-task messages embed a dashboard deep link (`/?task=<id>`,
`dashboard-task-url.ts`). Tapped from a phone it opens the live SPA, and only resolves
remotely if `KOOKR_REMOTE_CHAT_DASHBOARD_URL` is set. The operator asked for the
opposite shape: a small message whose link opens a **rich, static report** — what the
agent achieved, what remains, what it needs — that reads well on a phone **and is
still reachable hours later, even if the home machine is off**. No HTML-report builder
exists today, and (round-1 correction) the relay share is a *live, view-only session
invite with a 10-minute TTL* (`relay-share-client.ts:30-65`), **not** a static route
host — so it cannot, as-is, serve a durable `/report/<id>`.

## Empirical Checkpoint (origin/main at draft time; all re-verified in round 1)

1. Outbound task/permission messages no-op for non-remote tasks —
   `src/integrations/telegram/index.ts:708-712, 742-746`.
2. `completion_ready` reaches `onTaskOutcome` for non-remote tasks unconditionally —
   `delivered-task-completion-sweep.ts:172` (de-gating the handler suffices).
3. Detection gap confirmed — `anomaly-detector.ts:367-381` vs `turn-state.ts:46-68`;
   the background-count check is currently inlined **only** in `turn-state.ts:61`
   (no shared helper), so extracting one predicate is clean. *(Since done: #3512.)*
4. The spurious anomaly drives desktop/audio (`useNotifications.ts`, keys on
   `agent.anomaly`) and `response-assist` spend (`response-assist-processor.ts:53`).
5. `completion_ready` → `awaiting_completion_ack` (a genuine "needs ack", not an FYI)
   — `stuck-reason.ts:86-88`.
6. Reliable confirmed-need signals: `OperatorNeeded` (`interactive_tool_denied`,
   durable first-write-wins) — `operator-needed.ts`; edge-triggered
   `permission_blocked` behind a circuit breaker that **drops** on repeated send
   failure — `permission-block-alert-processor.ts:62`, `permission-alert-breaker.ts`;
   `ask_user_question` subtype (detected as an anomaly, but **no** notification wiring
   today); terminal `TaskStatus` transitions.
7. Relay share is a live, TTL-bounded (10 min) view-only session invite, not a static
   host — `relay-share-client.ts:30-65`. No HTML-report builder exists.
8. signal-delivery is a 15s-poll file spool, ≤1 msg/min **batched**, plain-text, no
   links, single fixed chat id — `service.ts:140-169`, `channels.ts:63-70`. Durable,
   but the wrong mechanism for a latency-sensitive per-user block ping.
9. Quiet-hours (`quiet-hours.ts`) is consumed only in the frontend and uses a
   server-local clock in its helper; zero server/Telegram callers.
10. The #2765 work archives terminal task history before pruning (merged to `main`
    as #2953, `src/server/use-cases/task-archive.ts`) — the report model can read that archive for pruned tasks.

## Goals

1. Notify the operator on Telegram when — and **only when** — an agent **accurately,
   deterministically needs them**, for *any* task regardless of launch path.
2. **Fail-closed, zero false positives** from background shells, long foreground
   tools, or scheduled wakeups/sleeps. Absence of a confirmed signal → no notification.
3. **No false negatives for the hard class**: a genuine permission block / denied
   interactive tool is delivered durably, never silently dropped.
4. Fix the detection gap at the **source**, so the dashboard, desktop, audio, and
   `response-assist` all stop mislabeling background waits — not just Telegram.
5. Keep each message small: one line of why-you're-needed plus one link.
6. The link opens a phone-friendly, **durable, reachable** report (achieved /
   remaining / what's needed), not the live dashboard — reachable even when the home
   machine is off.
7. Make enabling a single validated step, with a self-test so a silent channel is
   distinguishable from a broken one.
8. **The operator can act on what arrives.** The real success metric is not "zero
   false positives" but "every message is triageable." At the operator's real scale
   (~87 live tasks), a burst of *correct* notifications is as un-actionable as noise, so
   aggregate volume must be governed, not just per-event precision.

## Non-Goals

- Do **not** rework the watchdog silence detection (`stale_agent` /
  `hook_disconnected`). That false-positive class has its own RFC
  (`rfc-supervisor-stale-agent-false-positives.md`); the notification set simply does
  not include silence-based types. (Consequence: a *genuinely* hung foreground
  `sleep 1200` is not notified by this feature — an accepted, documented gap.)
- Do **not** migrate desktop/audio onto a shared attention event in this RFC. The
  source fix (Goal 4) already corrects them via the anomaly they consume; unifying all
  channels onto one `OperatorAttention` event is a worthwhile *follow-up refactor*,
  explicitly out of scope here to keep this change shippable.
- Do **not** add a second chat-channel abstraction or Discord support for task
  attention. Telegram only (matching `rfc-remote-chat-trigger.md`).
- Do **not** change task lifecycle or `TaskStatus`. The notification layer MAY *read*
  the attention-queue severity model to rank across tasks (R10) but SHALL NOT rewrite
  it. (Relaxed from v2, which fenced off the severity model entirely — the
  consensus attack showed that fence blocked the only mechanism able to prioritize a
  burst of 87 tasks' needs.)

## Requirements

- **R1 — Two confirmed-need classes (closed sets).** A notification SHALL be emitted
  only from these deterministic signals, grouped by urgency:
  - **Actionable (hard)** — the agent is stopped and needs a human decision now:
    (a) `OperatorNeeded` (`interactive_tool_denied`); (b) entry into
    `permission_blocked` (edge-triggered); (c) `ask_user_question`; (d)
    `pendingSignal.kind === 'completion_ready'` (awaiting ack).
  - **Done (FYI)** — the task reached a terminal `TaskStatus`: `completed` / `failed`
    / `cancelled`.
  No other signal SHALL produce a notification. In particular, `needs_input` with
  `subType === 'stop'`, `completed_turn`, and the watchdog silence types are **not**
  in either set.
- **R2 — Completion keys on lifecycle, never on turn state.** The "Done" class SHALL
  be driven by `TaskStatus` terminal transitions (and `completion_ready` for the
  actionable "needs ack"), **never** by `completed_turn` / a clean Stop. (Closes F2.)
- **R3 — Source fix for background/scheduled waits.** *(Shipped in #3512, extended to
  the watchdog in #3573.)* A single shared predicate
  `isBackgroundParked(stopEvent)` SHALL be extracted and used by both `turn-state.ts`
  and `anomaly-detector.ts`; `detectNeedsInput` SHALL return `null` when parked. The
  notification gate itself is **positive/allowlist** (R1), so it is fail-closed by
  construction: a Stop that is neither a terminal transition nor a confirmed actionable
  signal produces nothing, regardless of whether the count field is present. (Closes
  F1 at the gate; fixes dashboard/desktop/audio/response-assist at the source.)
- **R4 — Launch-agnostic, single outbound owner.** Notifications SHALL fire regardless
  of launch path (not gated on the `origin` map). `src/integrations/telegram` SHALL be
  the **sole** outbound owner, exposing one `notifyOperator(scope, message)` (transport
  + recipient resolution + redaction + audit). The two legacy callbacks' divergent send
  logic SHALL be removed and routed through it; the `origin` map becomes a
  reply-routing hint, not a notify gate. (Closes the two-senders boundary smell.)
  *(Since the draft, `kookr ask` added a third outbound sender, `askNotifier.sendAsk`
  in `telegram/index.ts`. It is not origin-gated: with no origin chat it sends to the
  first allowlisted user. It should move behind `notifyOperator` too, and its recipient
  fallback is a usable precedent.)*
- **R5 — Small message + one link.** Each message SHALL be one short line
  (`<task title/id> — <blocked | question | needs ack | done:ok/fail>`) + exactly one
  URL. A single novel hard-class event SHALL be sent **promptly** (not held behind the
  ≤1-msg/min infra batch, which strips links and merges unrelated tasks — F6); a *burst*
  of hard-class events is governed by the R10 aggregation stage (cause-clustered), not
  streamed one-per-event.
- **R6 — Durable hard-class delivery.** Actionable notifications SHALL be delivered
  through a durable outbox with **retry** and a durable **notified-ledger** keyed
  `(user, taskId, kind, edge)`. A transient send failure SHALL be retried, never
  silently dropped (closes F3); a daemon restart SHALL NOT re-fire an
  already-delivered durable signal (closes F7). The ledger SHALL be evicted on task
  terminal + delete (bounds growth — F8).
- **R7 — Reachable, durable report link.** The link SHALL resolve to a **self-contained
  static HTML report** (no live fetches) for the task: achieved / remaining / action
  needed, built from a `buildReportModel(taskId)` that reads `CompletionDigest`, the
  supervision next-action, open findings, PR/branch refs, **and the #2765 task-history
  archive** for pruned tasks. Two hosting options, operator-chosen (see Design):
  (A) **Claude-artifact export** (off-box, phone-reachable, durable — the operator's
  literal ask; opt-in because the task summary leaves the machine); (B) **local static
  report** at `/report/<id>?t=<signed,expiring token>` served by the kookr server,
  reachable via `KOOKR_REMOTE_CHAT_DASHBOARD_URL`. The renderer SHALL degrade to a
  minimal "task <id>: <status>, data archived" page rather than error.
- **R8 — Policy as a pure function; enable + self-test.** Eligibility SHALL be a pure
  `shouldNotify(event, policy)` in core; `AttentionPolicy`
  (`off | actionable-only | actionable+done | per-project`, default `actionable+done`)
  SHALL live in `shared/contracts`, be projected by `settings-service`, and be injected
  into the sink as a getter — the sink SHALL NOT read the settings blob. Enabling SHALL
  validate token/chat/allowlist in `config-preflight.ts` and send a **test ping** so a
  silent channel is distinguishable from a broken one (Goal 7).
- **R9 — Respect operator context.** Quiet-hours SHALL gate the **Done** class only
  (never the actionable class), using the **operator's configured timezone**, not the
  server-local clock (closes F9). Where a "task is being attended in the dashboard"
  signal is available, `ask_user_question` SHOULD be suppressed on Telegram while the
  operator is actively viewing that task (reduces the R1c annoyance FP); if no such
  signal exists, this is a documented minor FP, not a blocker.
- **R10 — Aggregate volume governance (cross-task).** Between projection and send there
  SHALL be an aggregation stage that bounds *how much correct signal* reaches the
  operator at fleet scale:
  - **Cause clustering.** Simultaneous actionable events sharing a cause (e.g. many
    tasks hitting `permission_blocked` on the same tool, or `api_error:billing`) SHALL
    collapse into **one** message — "12 tasks blocked approving `Bash(git push)` — fix
    once" with one link to a multi-task view — not N separate pings. (This is the
    inverse of F6: coalescing unrelated tasks was the bug; coalescing by *shared cause*
    is the feature.)
  - **Aggregate rate cap + digest.** Beyond a configurable per-window ceiling, further
    actionable events SHALL roll into a single periodic **digest** ("5 more tasks need
    you: 3 blocked, 2 questions — open queue"), ranked by the attention-queue severity
    model (read-only), rather than streamed one-per-event. A single, novel, highest-
    severity block SHALL still cut through promptly (the cap governs the tail, not the
    first of a kind).
  - **Done-class rollup.** Terminal `completed`/`failed`/`cancelled` events SHALL be
    rolled up ("8 tasks finished: 7 ok, 1 failed — review"), not one message per task.
  The default ceiling SHALL be conservative (triageable on a phone), operator-tunable.

## Design

### Default notification semantics (resolves the "done vs needs-me" tension)

The operator said two things — "telegram me when the task was done" **and** "only when
the agent is needing me." These are *not* in conflict once completion is modeled
correctly: in the operator's workflow a finished task **does** need them (to review /
ack / merge). So the default (`actionable+done`) notifies on both the hard class and
genuine terminal completion, and on **nothing mid-flight**. `completion_ready` is
classified as **actionable** (it is `awaiting_completion_ack`, a real pending need —
`stuck-reason.ts:88`), not folded into the FYI group. This is why the earlier
`needs-action-only` default was wrong: it muted both of the operator's asks.

### Component map (layering, single ownership)

```
 Stop event ─▶ isBackgroundParked()  (core, shared by turn-state + anomaly-detector)
                                     │  detectNeedsInput → null when parked (R3)
 confirmed signals ────────────────▶ operatorAttention(facts) : OperatorAttention | null
   OperatorNeeded (durable store)    │   pure core projection over a SMALL fact struct
   permission_blocked (edge)         │   (not the whole AgentState) — R1 closed set
   ask_user_question                 ▼
   completion_ready            shouldNotify(event, policy)   (pure core — R8)
   TaskStatus terminal               │
                                     ▼
                         AttentionAggregator (R10: cause-cluster · rate-cap · digest ·
                                     │  cross-task rank via severity model, read-only)
                                     ▼
                         AttentionDispatcher (server/bootstrap wiring)
                                     │  durable outbox + notified-ledger (R6)
                                     ▼
                         telegram.notifyOperator(scope, msg)   ← SOLE outbound owner (R4)
                                     │
                         link = ReportPublisher.publish(model)  (artifact | local — R7)
```

- **Types** (`OperatorAttention`, `AttentionPolicy`, `AttentionSink` port) live in
  `shared/contracts`, next to `telegram.ts`.
- **Pure logic** (`operatorAttention`, `shouldNotify`, `isBackgroundParked`,
  `renderTaskReport`) lives in `core` with no Telegram/observability imports.
- **Wiring + durable outbox** live in `server`.
- **Transport** lives only in `integrations/telegram`.
  Dependency direction: `core → server → integrations`; no cycle.

### Slice 1 — the confirmed-need gate + durable delivery (the whole core value)

1. **Source fix (R3):** *done in #3512 (see the update at the top).* Extract
   `isBackgroundParked`; `detectNeedsInput` returns null when parked; add a regression
   test. This alone fixes dashboard/desktop/audio/spend.
2. **Projection (R1/R2):** `operatorAttention(facts)` — a pure function over a small
   struct (anomaly type+subtype, `pendingSignal.kind`, `operatorNeeded`, the
   `TaskStatus` transition) — emits at most one `OperatorAttention` per edge.
3. **Single owner (R4):** de-gate `integrations/telegram`; collapse the two legacy
   callbacks into `notifyOperator`. Origin map → reply-routing hint.
4. **Aggregation (R10):** `AttentionAggregator` cause-clusters a burst, applies the
   windowed rate cap, and ranks the tail into a digest (reading the severity model
   read-only) before the dispatcher. This is the fleet-scale safety valve the consensus
   attack showed was missing; it ships in Slice 1 because at ~87 tasks the feature is
   un-usable without it.
5. **Durable delivery (R6):** `AttentionDispatcher` writes to a durable outbox with a
   `(user,taskId,kind,edge)` notified-ledger; retries transient failures; survives
   restart. Prompt send for a novel hard-class event (R5).
6. **Policy + enable (R8):** `shouldNotify` + `AttentionPolicy` (default
   `actionable+done`); preflight validation; test ping on enable.
7. **Link:** the report (below). Slice 1 is not "done" until the link is reachable —
   so the report ships in Slice 1, not deferred.

### The report (R7) — honest hosting

`buildReportModel(taskId)` (store access, archive-aware) → pure
`renderTaskReport(model)` → **self-contained** HTML (inlined CSS, no live fetches), so
the same artifact is equally valid as a Claude-artifact export or a locally-served
page. A one-method `ReportPublisher` interface has two adapters:

- **`ClaudeArtifactPublisher`** — publishes the HTML as a Claude artifact and returns
  its URL. This is the only option that is reliably phone-reachable and durable when
  the home box is off — which is the whole point of a phone notification — and is the
  operator's literal ask. Opt-in per project because the task summary (file names,
  status, next action) leaves the machine.
- **`LocalReportPublisher`** — serves `/report/<id>?t=<signed,expiring token>` from the
  kookr server, reachable only if `KOOKR_REMOTE_CHAT_DASHBOARD_URL` (a tunnel/public
  origin) is set. Privacy-preserving; requires the box reachable. The token is signed
  and expiring (hours, not the relay's 10 min) and the route is **not** a guessable
  `/report/<id>`.

The RFC does **not** make the privacy-leaking option the silent default: the policy
chooses, defaulting to `LocalReportPublisher` and falling back to a plain dashboard
deep link + a preflight warning when no public origin is configured, with the artifact
publisher offered as the reachable upgrade.

### Slice 2 — ergonomics (follow-up)

Settings UI toggle + scope selector; quiet-hours server gate with operator tz (R9);
periodic heartbeat option; `per-project` policy; attended-task suppression (R9).

### Explicitly deferred (separate RFCs / follow-ups)

Migrating desktop + audio onto a shared `OperatorAttention` event (the source fix
already de-lies them); watchdog silence FP (`rfc-supervisor-stale-agent-false-positives.md`).

## Files to change

- `src/core/background-parked.ts` *(exists since #3512; no further change planned)* — `isBackgroundParked(stopEvent)`; used by
  `turn-state.ts` and `anomaly-detector.ts` (`detectNeedsInput` returns null when parked).
- `src/shared/contracts/operator-attention.ts` *(new)* — `OperatorAttention`,
  `AttentionPolicy`, `AttentionSink` port.
- `src/core/operator-attention.ts` *(new)* — pure `operatorAttention(facts)` +
  `shouldNotify(event, policy)`.
- `src/core/attention-aggregate.ts` *(new)* — pure cause-clustering + digest shaping
  (R10); `src/server/attention-aggregator.ts` *(new)* — the windowed rate-cap + rank
  (reads severity model read-only), feeding the dispatcher.
- `src/server/attention-dispatcher.ts` *(new)* — durable outbox, notified-ledger,
  retry, wiring (`server/bootstrap`).
- `src/integrations/telegram/index.ts` — collapse `onTaskOutcome` / `onPermissionBlocked`
  into one `notifyOperator`; de-gate from origin map (origin → reply hint).
- `src/core/report-model.ts` + `src/core/task-report-renderer.ts` *(new)* —
  `buildReportModel` (archive-aware) + pure `renderTaskReport`.
- `src/server/report-publisher/{index,claude-artifact,local}.ts` *(new)* —
  `ReportPublisher` + two adapters; `/report/<id>` route for the local adapter.
- `src/server/config-preflight.ts` — validate token/chat/allowlist; test-ping path.
- `src/server/settings-service.ts` + settings schema — project `AttentionPolicy`.
- `docs/configuration.md`, `docs/user-guide.md` — enable instructions.

## Edge cases

- **Count field absent on Stop** — the gate is positive/allowlist (R1/R3), so an
  unconfirmable stop produces nothing. Fail-closed by construction.
- **Clean `completed_turn`** — not a completion signal (R2); only a `TaskStatus`
  terminal transition or `completion_ready` notifies. No per-turn spam.
- **Permission block during a Telegram/network blip** — durable outbox retries (R6);
  never breaker-dropped.
- **Daemon restart with a still-open block / durable `OperatorNeeded`** — the durable
  notified-ledger suppresses a re-fire (R6), so restart does not re-ping.
- **`completion_ready` → `completed` → `failed`** — ledger key includes `kind`, so a
  later distinct terminal kind still notifies while identical re-emits dedup (F10).
- **Dead background job stuck at count > 0** — the gate never *relies* on counts to
  decide a notification (it is allowlist-positive), so a stale count cannot suppress a
  genuine actionable signal (which comes from `OperatorNeeded`/`permission_blocked`/
  `completion_ready`, not from the count). The source-fix suppression only affects the
  (non-notifying) `needs_input:stop` anomaly.
- **Long foreground `sleep 1200`** — `stale_agent` at 10 min; not in R1 → not notified
  (documented Non-Goal gap).
- **Report for a pruned/archived task** — `buildReportModel` reads the #2765 archive;
  else degrades to a minimal status page (R7).
- **Attended task** — `ask_user_question` suppressed while the operator views that task
  (R9), if the signal exists.
- **Multiple allowlisted users** — ledger and dedup are per `(user, …)`;
  `notifyOperator` resolves recipients; no coalescing across users (R5/R6).
- **Burst from a shared cause** (e.g. expired credential → 15 blocks at once) — the R10
  aggregator cause-clusters into one "15 tasks blocked on X — fix once" message, not 15
  pings; the tail beyond the window cap rolls into a ranked digest.
- **Overnight fleet** (~40 terminal + N blocks) — Done-class rolls up to one "N
  finished: X ok, Y failed" message; actionable bursts cluster; quiet-hours defers the
  Done rollup to window-end (R9) without muting the actionable cut-through.

## Alternatives considered

- **Notifier-side suppression instead of the source fix (v1's default).** Rejected:
  `design-minimalist` + `ambition-amplifier` agreed it leaves the attention-queue,
  desktop, audio, and response-assist consumers still wrong, and creates a second
  source of truth that drifts from `turn-state.ts`. The source fix is smaller *and*
  broader.
- **A new `OperatorAttention` event bus that desktop/audio/Telegram all subscribe to
  (v1 maximalist read).** Deferred, not rejected: the typed event is kept (as a pure
  projection + a `shared/contracts` type), but migrating the other channels onto it is
  a follow-up; doing it now would balloon the change. (Adversarial-pair resolution: see
  "Critic feedback incorporated".)
- **Claude.ai artifact as the default link.** Rejected as the *silent* default
  (ships task content off-box), but — corrected from v1 — it is *not* ranked last: it
  is the only reliably-phone-reachable, box-off-durable option, so it is a first-class
  opt-in and the recommended upgrade, behind a `ReportPublisher` seam from day one.
- **Reuse signal-delivery transport for these (v1 R7).** Rejected: `boundary-critic` +
  `failure-mode-analyst` showed it is a 15s-poll, ≤1-msg/min **batched**, plain-text,
  single-chat infra-alert mechanism — wrong latency, strips links, merges tasks/users,
  and cannot fan out per-user. Its durable-spool *pattern* is reused for the outbox;
  its delivery path is not.
- **Gate on `TurnState` instead of a projection.** Insufficient: `TurnState` is a live
  per-window badge, not an edge, and the actionable signals (OperatorNeeded,
  permission, completion_ready) live outside it.
- **Relay live-session share as the report link.** Rejected: it is a 10-min TTL
  view-only *session* invite, not a static host (F4); it may offer a "watch live" link
  *inside* the report, but it cannot be the durable report itself.

## Critic feedback incorporated

Round 1 panel (5 critics, parallel): `failure-mode-analyst`, `design-minimalist`,
`ambition-amplifier`, `boundary-critic`, `socratic-challenger`. Shared evidence pack:
`rfc-telegram-attention-notifications-evidence.md`.

- **failure-mode-analyst** — adopted: completion must not key on `completed_turn` (R2);
  fail-closed gate by positive allowlist (R3); durable retried hard-class delivery +
  restart-safe notified-ledger (R6); relay-share is not a static host → real hosting
  decided (R7); operator-tz quiet-hours, ledger eviction, `(task,kind,edge)` dedup
  (R9/edges). Rejected none of substance.
- **boundary-critic** — adopted: single outbound Telegram owner (R4); pure
  `shouldNotify` + injected `AttentionPolicy`, sink does not read settings (R8); split
  `buildReportModel` from `renderTaskReport` (R7); types/port in `shared/contracts`,
  pure logic in `core`, wiring in `server`. Adopted: drop signal-delivery delivery path
  (keep only the durable-spool pattern).
- **socratic-challenger** — adopted: `completion_ready` reclassified as **actionable**
  (`awaiting_completion_ack`), fixing the default that otherwise muted both operator
  asks; test-ping so silence ≠ broken (R8); attended-task suppression (R9).
- **design-minimalist** vs **ambition-amplifier (adversarial pair) — resolution:** both
  agreed the false-positive must be fixed at the **source** (`detectNeedsInput` +
  shared predicate), not via a notifier-only projector — **adopted** (R3), because it
  is the smaller change *and* fixes four consumers. On the report: followed
  **ambition** (keep it in the core slice, it is the explicit user ask) while adopting
  **minimalist's / failure-mode's** auth+hosting objection as a hard requirement (R7
  signed-token + artifact seam). On the event abstraction: followed **minimalist** (no
  new subsystem; de-gate existing callbacks) using the function-granularity typed seam
  **ambition** explicitly endorsed as "the cheap version" — the bus/migration is
  deferred (Non-Goals).
- **Invocation log:** `ambition-amplifier 2026-11-07: novel finding` (source-fix
  benefits desktop/audio/response-assist; report is the ask, not a phase).
- **Post-round-1 empirical checkpoint (2026-11-07):** load-bearing code claims verified
  directly (static-structure checks, not runtime): detection gap confirmed; no shared
  background-count helper exists today (since #3512, it does); `useNotifications`/`response-assist` fire on the
  spurious anomaly; `completion_ready` reaches `onTaskOutcome` for non-remote tasks;
  `stuck-reason.ts:88` completion_ready→awaiting_completion_ack. Nothing falsified; the
  checks sharpened R2/R3/R4 and the default. `design-experimenter` not spawned — the
  claims were code-structure facts fully resolved by direct reads.
- **Intent preservation check:** the operator's two load-bearing motivations — (i)
  notify only on confirmed need, no background false positives, and (ii) "telegram me
  when done" with a small link to a rich phone report — are both honored by the
  `actionable+done` default (not the muting `needs-action-only`) and the in-slice
  reachable report. The privacy pivot away from a Claude-artifact *default* is presented
  as an explicit operator choice (R7), not a silent one.

- **Consensus attack (`general-purpose` 2026-11-07): finding — adopted.** The shared
  blind spot across all 5 critics and the draft: everyone optimized *per-event
  precision* and no one questioned *aggregate volume* at the operator's real scale
  (~87 live tasks = 87 notification sources; the remote-chat send path has no rate
  limit of its own). A perfectly precise notifier still floods — e.g. one expired
  credential trips 15 tasks into `permission_blocked` at once — and every v2 lever
  (direct send, retry, durable outbox, no coalescing) *amplifies* it, while the v2
  Non-Goal fenced off the severity model that could rank the burst. Incorporated as
  R10 (cause-clustering + aggregate rate cap + digest + read-only cross-task ranking),
  Goal 8 (the real metric is "every message is triageable"), a relaxed Non-Goal, and
  the aggregation stage in the component map. This was the one permitted
  post-convergence revision; the review was not reopened.
