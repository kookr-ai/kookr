# RFC: Hermes Observed-Activity Bridge

**Status:** Accepted — slice 1 (backend) and slice 2 (monitor lane) both IMPLEMENTED (v3 — post-consensus-attack; symmetric-error fix + honest slice-2 cost)
**Date:** 2026-11-07
**Author:** Jean Ibarz (with Claude)

> Line citations are against `origin/main` at `0b8642af` (the implementation
> base; the RFC worktree branches from it). A stale sibling checkout on another
> branch will show shifted numbers — the *structures* are what matter.

---

## Summary

Make the operator's Hermes fleet — an external, batch `do → judge → learn` bash
loop running on the same host as kookr-prod — **visible as live activity in the
Kookr monitor**, named with its own first-class provider identity
(`hermes-fleet`), without pretending it is a Kookr-launched agent and **without
writing to the load-bearing activity ledger**.

Tranche 1 ([#3505](https://github.com/kookr-ai/kookr/pull/3505), merged
`0b8642af`) made `hermes-fleet` a first-class `AgentType` *identity*: the ledger
and review verdicts can now *name* Hermes as a real provider. But naming is not
seeing. This RFC designs the **visibility path**, and — after review — routes it
through a **dedicated, flag-gated, in-memory observed-session store**, never the
durable ledger. That choice makes the integrity and reversibility requirements true *by
construction* instead of by a fragile case-by-case exclusion the review proved
does not hold. (v3 adds one small *dedicated* durable last-state file — never the
activity ledger — so the live lane also survives kookr's routine restarts without
lying in either direction.)

This is the step the source issue
([jeanibarz/hermes-fleet#15](https://github.com/jeanibarz/hermes-fleet/issues/15))
places behind its **hard human gate**: "wire into kookr core → STOP + draft PR
prepared for review." **This document is that review artifact.** It recommends a
path and a phased, reversible rollout; it does not authorize implementation. The
operator decides at this gate.

## Context

Hermes is the operator's own fleet: a DeepSeek-via-bash reviewer/worker loop with
a local `ledger.jsonl` (hermes-fleet#15 Rung 2) that can also emit Kookr-format
merge-gate verdicts (Rung 1). It is **not** an interactive agent Kookr launches,
supervises, or injects hooks into: no PTY, no dtach session, no adapter — by
design. Tranche 1 registered **no launch adapter** for `hermes-fleet`: it is
identity-only, absent from `AVAILABLE_AGENT_TYPES`, never in the picker,
round-robin, or remote allowlist (`isIdentityOnlyAgentType` stays `true`).

The operator's goal: **"see Hermes activity in the monitor"** — when the fleet is
reviewing a PR or grinding a batch, that work should appear in the live surface
alongside Claude Code and Codex sessions, attributed to Hermes with its own node
mark (the neutral hexagon Tranche 1 added in `presentation.ts`).

## Problem

Kookr's activity pipeline is built around agents **it launches**. Two invariants
make an external producer invisible:

1. **Live rendering is task-bound.** The monitor's live grid and the per-task
   activity-diagnostics view (`diagnostics-routes.ts` `GET
   /api/tasks/:taskId/activity-diagnostics`) enumerate
   `task.sessions[].tmuxSession` (`index.ts` snapshot build;
   `tasks.ts:1756` `findTaskIdBySession`). A session bound to no `Task` renders
   nowhere. **Visibility comes from task binding, not from the ledger
   projection** — a fact the review corrected in the v1 draft (see *Critic
   feedback*).

2. **No first-class foreign-activity surface exists.** Everything the monitor
   shows is either a launched agent's hook stream or a task's state. There is no
   "observed external producer" lane.

The HTTP ingress is **not** the blocker: `POST /api/hook-event/:sessionId`
(`diagnostics-routes.ts:1902`) already accepts records from any local process and
on the default **loopback bind requires no auth** (`index.ts:413`; `start.ts`
loopback case). Hermes runs on the host, so it can already reach ingestion. The
gap is a *surface* and a *trust boundary*, not transport.

### Why not the ledger (the v1 draft was wrong here)

The v1 draft proposed an additive `observed_activity` ledger projection, excluded
from real-task semantics "the same way `diagnostic_only` is." Five critics,
reading the code, falsified that:

- The exclusion guards have **opposite polarity**. `hook-ingestion.ts:596` and
  `activity-ledger.ts:236` are `=== 'diagnostic_only'` *skip* checks (a new member
  is **not** skipped), while **`hook-ingestion.ts:582` is `!== 'diagnostic_only'`
  → treated as a primary parsed row**, feeding `primaryParsedRows` →
  `canReplayLiveState` → **live-state replay on startup**. A naively-added
  `observed_activity` row is therefore *replayed as live agent state* — the exact
  R6 breach the design meant to prevent. "Mirror the branch" copies the wrong
  polarity at the one site that matters.
- The ledger is **durable** (append + full replay on startup). So "flag OFF ⇒
  byte-for-byte unchanged" (R3) is **false** once the ledger has held observed
  rows: on the next restart those orphan rows hit the fail-open guard regardless
  of the flag. Reversibility is not clean.
- The ledger is **one file per session id** (`<id>.jsonl` + rotated `.1`,
  `activity-ledger.ts:170`), pruned **only** on task deletion
  (`delete-task.ts:74` → `pruneSession`). Non-task-bound `hermes-obs-*` files
  would **never be pruned** — orphan files forever.

All three problems are properties of *using the durable ledger*. Removing the
ledger from the path removes all three. That is v2.

## Requirements

- **R1 — Visible live.** Hermes activity appears in the live monitor, attributed
  to provider `hermes-fleet`, while the fleet works (not a diagnostics-only count).
- **R2 — Honest identity.** Never represented as a launchable/supervisable agent.
  No adapter, no picker/round-robin/allowlist, no launch/relaunch path.
  `isIdentityOnlyAgentType('hermes-fleet')` stays `true`.
- **R3 — Opt-in, cleanly reversible.** Gated behind `KOOKR_HERMES_FLEET` (default
  OFF). Flag off ⇒ no existing path changes behaviour for previously valid input.
  (One deliberate exception is active regardless of the flag: the public
  `/api/hook-event` route rejects session ids beginning with the reserved
  `hermes-obs-` prefix — a newly-reserved namespace, documented in `api.md`, not a
  regression for any real caller.) The only durable artifact is one small
  dedicated last-state file; `git revert` + flag-off + delete that file is a clean
  teardown. Crucially, **the activity ledger is never written**, so there are no
  orphan ledger rows to replay after a revert (the specific R3 breach v1 had).
- **R4 — Bounded trust.** Accepting externally-sourced activity must not let an
  arbitrary local process forge fleet liveness shown to the operator, nor widen
  the ledger's blast radius.
- **R5 — Ledger untouched.** The activity ledger is load-bearing for
  stuck-detection, recovery hydration, and diagnostics. The bridge **writes no
  ledger rows** — integrity is preserved by construction, not by exclusion logic.
- **R6 — No false *positive* liveness/recovery.** Hermes activity must never make
  a real task look alive, trigger stuck/idle detection, or be hydrated as
  resumable agent state. **Guaranteed by never binding an observed session to a
  `Task` and never entering the ledger/replay path.**
- **R7 — No false *negative* liveness, including across restarts.** The symmetric
  error matters just as much: the lane must not show Hermes *idle/dead when it is
  actually working*. Because kookr-prod is a long-lived systemd service that
  restarts routinely (deploys, `Restart=on-failure`, watchdog — `deploy/server/
  kookr.service`, issue #2226), a purely in-memory lane would blank on every
  restart and read as "fleet died" during exactly the window an operator is
  watching a deploy. The design must survive a restart without either lying
  "working" (R6) or lying "idle" (R7). An operator must also tell apart "Hermes
  working", "Hermes finished/idle", and "the bridge is misconfigured / dropping
  pulses" — transport health is a distinct signal from Hermes's self-reported
  state.

## Non-Goals

- Launching, supervising, pausing, or injecting input into Hermes.
- A general "any external tool streams into Kookr" framework. Scope is the
  operator's own single, trusted, same-host fleet.
- Verdict/merge-gate interop (Rung 1) — already works via the review-verdict path.
- Durable Hermes **history / transcript** inside Kookr. Hermes keeps its own
  `ledger.jsonl` for full history. (This is distinct from persisting the *last
  known state per session* so the live lane survives a restart — which v3 **does**
  do, in a dedicated small store, never the activity ledger. See Design §2 and the
  headline Open Question.)
- Reconstructing Hermes's transcript. We surface coarse state + a label, not a
  replayable transcript.

## Design

### Chosen path: a flag-gated, in-memory observed-session lane

Four parts. **Nothing touches the ledger, the adapter registry, or the Task
store.**

#### 1. A dedicated, authenticated, provider-pinned ingress

```
POST /api/observed-activity/hermes-fleet          (exists only when flag ON; else 404)
  X-Kookr-Observer-Token: <secret>                (REQUIRED even on loopback)
  body: { sessionId, state?, label?, done?, ts }  (NOT a Claude hook envelope)
```

- **Token required, always.** Verified with the existing
  `timingSafeTokenEqual` (`admin-token.ts:11`) — constant-time, no timing oracle.
  Provisioned alongside the opt-in. **If the flag is ON but no token is
  configured, the route refuses to register and logs once** (fail-loud, per
  operability + delivery review).
- **Provider pinned by the route** to `hermes-fleet`; never read from the body.
- **Rate-limited** (token-bucket per token) and **body-size capped**, so a buggy
  or hostile caller cannot flood the process.
- The body is a small observed-activity record, **not** a Claude hook. It is
  stored directly in the in-memory store (below) — there is no translation into
  `HookEnvelopeV1` and it never enters `ingestFromHttp`, the dedup cache, or the
  ledger.

#### 2. An observed-session store with durable last-state (not the ledger)

A capped, TTL-evicted `Map<sessionId, ObservedSession>` populated **only** by the
gated route handler, **backed by a small dedicated durable store** (a single
flag-gated JSON/state file, or a slice of the existing config/state store — **not**
the activity ledger). Each entry: `{ state, label, receivedAt (server-stamped),
firstSeen, pulseCount }`. Membership in this store **is** the observed lane — it
is never derived from a session-id prefix, never read back from the activity
ledger. This makes the security boundary and the auth boundary *the same boundary*
(closing the v1 hole the failure-mode review found): the ungated generic route
writes to the ledger/monitor, which this lane never reads, so it **cannot** inject
an observed entry.

- **Decay is computed from the server-stamped `receivedAt`**, never the
  producer's `ts`. This is the key to surviving a restart *without* lying: on
  reload, a session whose last `receivedAt` is older than the staleness window
  renders `stale`/`idle` — it is **never** replayed as fresh `working` (R6), and
  it is **not** blanked to "unknown" either (R7). A session that was genuinely
  mid-work moments before the restart reloads as `working` and self-heals on its
  next heartbeat.
- **Why durable, and why not the ledger (dissolving the false dichotomy).** The
  review's ledger-vs-in-memory debate framed durability as *only* obtainable from
  the activity ledger — and the activity ledger is what reopened every integrity
  risk. But durability of a tiny last-known-state map does not need the ledger: a
  dedicated store gives R1/R7-through-restart while leaving `activity-ledger.ts`
  untouched (R5) and never entering the replay path (R6). The durable artifact is
  one small additive file, flag-gated and trivially deletable (R3 reversibility
  stays clean — it is not the append-only, per-session, never-pruned ledger).
- **Bounded:** max N observed sessions, TTL eviction; the durable file is compact
  (one row per live-ish session, not an append log), so no unbounded growth and no
  startup-replay penalty.

#### 3. Monitor rendering + transport observability

- **The observed lane is its own `ServerMessage` type, not a ride-along on the
  task grid.** The live grid is task-keyed: `agents[]` entries are bucketed by
  `taskId` and `buildSnapshotProjection` + `sweepUnownedDeadAgents` actively
  **suppress** any `taskId`-less session state as a "ghost agent"
  (`monitor.ts:665,788`; `tasks.ts:859`). So a non-task lane **cannot** ride
  `agents[]` — it follows the precedent of `projectSummaries` /
  `coordinator.snapshot` (`shared/contracts/messages.ts:426-427`): a new wire
  message type with its own schema, broadcast cadence, viewer-scope filter, and
  frontend store slice. (Upside: that same suppression keeps the lane structurally
  isolated from task semantics, reinforcing R6.)
- **Always rendered when the flag is ON.** Empty ⇒ an explicit state, and
  crucially **three distinguishable empty states**, not one: "awaiting first pulse
  since <restart at HH:MM>" (just restarted — R7), "idle/finished" (Hermes
  reported `idle`/`done`), and "bridge error" (recent rejects — see counters).
  Never a blank lane that reads as "fleet died".
- **Bridge/transport state is a distinct signal from Hermes's state.** A
  flag-gated, token-gated **status route** exposes counters: `accepted`,
  `deduped`, `rejected{byReason}`, `lastRejectAt`, `lastAcceptedAt`.
- **Fast self-heal after a restart (bounds the R7 blind window).** Two mechanisms,
  so a restart does not leave the lane wrong for minutes: (a) the durable
  last-state store means a mid-work session reloads as `working` immediately, not
  blank; (b) the **`ping`/re-sync endpoint** is a re-announce trigger, not just a
  start-of-batch self-test — on a failed ping (e.g. the gated route 404s briefly
  during a deploy) the Hermes loop re-POSTs its *current* state as soon as the
  route is back, and a frequent heartbeat (not per-unit; coarse but on a short
  interval) re-confirms liveness within seconds.
- **State vocabulary kept minimal** (operability + minimalist): `working` /
  `idle` / `done`, plus `stale-while-working` *derived by the server* from
  `receivedAt` when a `working` session misses its heartbeat window. The label
  carries free-form context ("reviewing PR #123").

#### 4. The hard isolation invariant

**An observed session is NEVER associated with a real `Task`.** This is the true
protector of stuck-flag and recovery integrity — the failure-mode review showed
`stuck-flag-precision.ts` suppression keys on a session's own liveness within a
grace window, and observed sessions are safe *only because* they bind to no task.
The stated goal ("see Hermes reviewing *a PR*") pushes toward associating the
observed session with that PR's task; **the design forbids it.** PR context is a
*label*, not a binding. Backed by an invariant test.

### Defense-in-depth (cheap, adopted)

- The generic `POST /api/hook-event/:sessionId` route **rejects** the Hermes
  observed prefix (`hermes-obs-`) with 400, so that namespace cannot be driven
  from the unauthenticated lane and cannot pollute the monitor's session-keyed
  event map. (Note: `kookr-replay-` is **not** rejected here — the replay harness
  `scripts/replay-hooks.ts` legitimately feeds replay sessions through this very
  route; only the observed namespace is reserved *away* from it.)

### Why this shape

- **Integrity and reversibility stay structural.** No *activity-ledger* write ⇒
  R5/R6 hold by construction (no replay path, no parentage counts, no per-session
  orphan ledger files). The only durable artifact is one small dedicated
  last-state file, flag-gated and deletable ⇒ `git revert` + flag-off + remove
  that file is a clean teardown (R3). Durability of last-state buys R1/R7 across
  restarts *without* reintroducing any ledger risk.
- **The trust boundary is real, not theater.** The lane is reachable *only*
  through the token-gated route; the token actually bounds R4, and constant-time
  comparison + rate limits + fail-loud-on-missing-token close the obvious holes.
- **It is operable.** Transport health is observable and separable from Hermes's
  state (R7), which the v1 draft entirely lacked.

## Files to change (scope estimate, not a commitment)

| File | Change |
|------|--------|
| new `src/server/observed-activity.ts` (or similar) | Store (capped/TTL) with **dedicated durable last-state file**, server-stamped `receivedAt`, counters, `receivedAt`-based decay |
| new `src/shared/contracts/messages.ts` entry | New `observed.snapshot` (or similar) `ServerMessage` type + schema + exhaustiveness entries (precedent: `projectSummaries`/`coordinator.snapshot`) |
| new `src/server/routes/observed-activity-routes.ts` | Flag-gated POST ingress + status + `ping`; token (constant-time), provider pinning, rate limit, fail-loud on missing token |
| `src/server/routes/diagnostics-routes.ts` | Generic hook route rejects reserved-prefix session ids (defense-in-depth) |
| `src/server/index.ts` / bootstrap | Register routes + store **only** when flag ON; snapshot/WS broadcast of the observed lane |
| frontend monitor | Observed lane (always-rendered-when-on, empty state, bridge-vs-Hermes state) with the hexagon mark — **separate slice, mockups first (Q)** |
| docs (`architecture.md`, `environment-variables.md`, subsystem summary) | Document the observed lane, the durability choice (Q0), the ledger-untouched guarantee, and the trust boundary |
| tests | token required + constant-time; flag-off ⇒ 404; flag-on + no token ⇒ no register; reserved-prefix rejected on generic route; **invariant: no observed session ever bound to a Task**; decay from `receivedAt`; bounded store eviction; rate limit |

**Note:** `activity-ledger.ts`, `hook-ingestion.ts` (ingest path), and
`stuck-flag-precision.ts` are **not** modified. That is the point of v2.

## Delivery slices (reversible, independently verifiable)

1. **Slice 1 — backend, curl-verifiable. (IMPLEMENTED in this PR.)** Store (with
   durable last-state) + ingress route + status/`ping` re-sync + generic-route
   reserved-prefix rejection + all backend tests. Delivers value (operator can
   `curl` the status route and see pulses survive a restart) with **no UI**. Fully
   behind the flag; revert = delete additive modules + the one small durable file.
2. **Slice 2 — monitor lane (a full-stack vertical slice, not "just UI"). (IMPLEMENTED.)**
   Honest scope, per the consensus attack: because the grid suppresses non-task
   state, this slice adds a **new `ServerMessage` type** `observed.snapshot`
   (schema in `server-message-schema.ts` + exhaustiveness entries in
   `shared/contracts/messages.ts`; the wire shapes live in
   `shared/contracts/observed-activity.ts` so the frontend never imports from
   `server/`), a **server broadcast cadence** (a flag-gated 2s interval in
   `index.ts` calling `broadcastObservedActivity`), a **viewer-scope filter**
   (routed through `broadcastToAll` → the broadcaster's non-snapshot default-deny,
   so project-scoped share viewers never receive the operator-global lane), a
   **frontend store slice** (`observed-lane-slice.ts`), and the **render path**
   (`HermesFleetObservedLane.tsx` — a self-contained pill↔lane overlay, NOT a task
   grid section). UI mockups were taken first (combined header-pill + popover lane,
   neutral hexagon, collapse state persisted per-viewer in `localStorage`). The UI
   renders nothing until an `observed.snapshot` frame arrives (its proxy for
   flag-on) and never renders through the task grid. Droppable with zero backend
   side effects.

Stopping points: after slice 1 the operator has a usable, revertible, restart-safe
API; slice 2 is independently approvable/rejectable and is the larger of the two —
sequence accordingly.

## Edge cases

- **Flag off:** routes 404, no store, nothing registered. Unchanged behavior (R3).
- **Flag on, no token configured:** route refuses to register, logs once (fail-loud).
- **Forged pulse via generic route:** rejected (reserved-prefix 400); even absent
  that, it would only create unbound ledger rows (diagnostic_only, invisible) and
  could never enter the observed lane (lane reads only the in-memory store).
- **Hermes crashes mid-batch:** heartbeat stops; server marks `stale-while-
  working` from `receivedAt`. No real stuck-flag fires; nothing to recover.
- **Restart (the symmetric-error case the consensus attack found):** the durable
  last-state store reloads. A session last seen seconds ago → renders `working`
  (no false "idle"/R7); a session last seen beyond the staleness window →
  `stale`/`idle` (no false "working"/R6). `receivedAt`-based decay is what makes
  both true at once. The next heartbeat self-heals a genuinely-live session within
  seconds. No activity-ledger replay is involved.
- **Duplicate/retried pulses:** store keeps latest per session; a dedicated small
  guard, isolated from the shared ledger dedup cache (so a generic-route pre-post
  cannot suppress a real observed pulse — the cross-lane poisoning the review
  flagged is structurally impossible here).
- **Pulse flood:** rate limit + bounded store + TTL eviction cap cost; no durable
  growth, no startup-replay penalty (ledger untouched).

## Security

The crux of the human gate: accepting externally-sourced activity.

- **The lane is reachable only through the token-gated route.** Because observed
  state lives solely in the in-memory store that only this route writes, the auth
  boundary and the visibility boundary are the same boundary — the v1 "token is
  theater while the generic route accepts the prefix" hole is closed.
- **Constant-time token** (`timingSafeTokenEqual`), **fail-loud on missing
  token**, **rate-limited**, **body-size capped**.
- **Loopback is not treated as trusted.** The token is required even on loopback,
  because on a shared/prod host loopback is reachable by any local user,
  host-networked container, or RCE foothold (confused-deputy). The flag alone is
  not the control.
- **Worst case is bounded and cosmetic-only:** a token holder can display
  `hermes-fleet` pulses in the observed lane. It cannot alter a real task's
  liveness, be hydrated as agent state, trigger recovery, touch the ledger, or
  launch anything. The isolation is structural.
- **Reversibility:** `git revert` + flag-off leaves no durable trace.

## Alternatives considered

- **A — producer posts to the existing `/api/hook-event` (rejected).** Zero core
  change, but lands `diagnostic_only`, invisible live (fails R1). Baseline only.
- **B(ledger) — additive `observed_activity` ledger projection (rejected after
  review; was the v1 draft).** Falsified by five critics: fail-open at
  `hook-ingestion.ts:582` (R6 breach via live-state replay), durable rows break
  R3 on restart, orphan per-session files never pruned. All are ledger
  properties; the in-memory lane avoids them wholesale.
- **Fake Task per Hermes batch (rejected).** A real `Task` is load-bearing for
  recovery/stuck/relaunch/scheduling; a fake one risks phantom resume/sweep
  (violates R2/R5/R6).
- **Dedicated adapter for Hermes (rejected).** Re-introduces Hermes into
  `AVAILABLE_AGENT_TYPES`/picker/round-robin and implies launchability —
  contradicts R2 and Tranche 1's identity-only premise.

## Open Questions

- **Q0 — durability level. RESOLVED: (b), approved by the operator and
  implemented in slice 1.** The consensus attack showed the ephemeral-vs-ledger
  framing hid a third option. The lane uses **durable last-known-state in a
  dedicated small store** (`<kookrDir>/hermes-observed-activity.json`, atomic
  `0600`) — survives restart, ledger untouched. The options considered:
  - **(a) Ephemeral** — simplest; lane blanks on restart (accepts the R7
    false-negative window). Rejected by v3 as failing R1/R7 on a service that
    restarts routinely.
  - **(b) Durable last-state (recommended)** — one small file, last state per
    live-ish session, `receivedAt`-decayed. Survives restart without false
    "working" or false "idle". Ledger untouched; clean revert.
  - **(c) Durable short history** — a bounded ring of recent transitions. More
    than the stated goal asks for; defer unless the operator wants a mini-timeline.
- **Q1 — token provisioning. RESOLVED (slice 1):** a dedicated observer secret
  `KOOKR_HERMES_OBSERVER_TOKEN` (blast-radius isolation), compared constant-time
  via `timingSafeTokenEqual`; the route fails closed when the flag is on but the
  token is unset.
- **Q2 — pulse granularity.** Resolved toward **coarse start/stop + heartbeat**
  (not "per unit of work"); in-memory storage makes volume a non-issue, and
  coarse pulses keep the monitor legible.
- **Q3 — monitor lane UI.** User-facing; **mockups before implementation**
  (slice 2). Could be a dedicated lane or a labeled row in an existing sidebar —
  decide at mockup time.
- **Q4 — latent hardening (separate follow-up, NOT required here).** The review
  found `hook-ingestion.ts:582`'s `!== 'diagnostic_only'` guard fails open for
  *any* future projection member. v2 adds no member, so this RFC does not depend
  on it — but it is a real latent landmine worth a standalone, behavior-preserving
  hardening issue (convert the deny-checks to a positive `isLiveParentChild`
  predicate). Recommend filing it regardless of this RFC's fate.

## Critic feedback incorporated

Round 1 panel (5 critics, parallel), followed by a consensus attack. The round
produced major substantive findings that **pivoted the design** from ledger-based
(v1) to in-memory (v2); given the "mini-RFC" scope and the breadth of the
convergence, the review converged after one round plus the consensus attack.

- **boundary-critic — Needs Revision.** Deny-list guards (`!== diagnostic_only`)
  let a new enum member pass as ordinary activity; an overloaded value can't carry
  a third meaning. → Drove the pivot away from a new projection member.
- **design-minimalist — Not minimal.** The ledger is what makes R5/R6 hard;
  visibility comes from task binding, not the projection. Simplest design honoring
  R2/R5/R6 = in-memory observed map, no ledger, no projection member. → **Adopted
  as the core of v2.** Also cut the four-state machine → coarse states; flagged
  the token as possibly cosmetic (see adversarial resolution below).
- **operability-reviewer — Opaque.** No way to tell working vs crashed vs
  misconfigured. → Added distinct bridge/transport state, status counters, `ping`
  self-test, always-rendered lane with "no pulses since boot", decay from
  server-stamped `receivedAt`, fail-loud on missing token.
- **delivery-pragmatist — Risky → shippable after slicing.** Orphan per-session
  ledger files (prune is task-deletion-only); "single git revert" only partly
  true. → In-memory pivot removes orphan files and makes revert clean; added the
  2-slice plan with a locked broadcast contract and a curl-verifiable slice 1.
- **failure-mode-analyst — High risk; Revise before implementation.** (1) Token is
  theater if lane membership is prefix-derived while the ungated generic route
  accepts the prefix; (2) fail-open at `:582` replays observed rows as live state
  on startup (R6 breach); (3) R3 false once the ledger holds observed rows; plus
  constant-time token, loopback-≠-trusted, cross-lane dedup poisoning, unbounded
  ledger growth, and the stuck-flag protection really coming from no-task-binding.
  → **All addressed by v2:** lane membership lives only in the route-written
  in-memory store (auth boundary = visibility boundary); no ledger write (kills
  #2/#3, dedup poisoning, growth); constant-time token; token required on
  loopback; generic-route reserved-prefix rejection; and the explicit
  never-bind-to-a-Task invariant with a test.

**Adversarial resolution (design-minimalist vs failure-mode-analyst — keep the
token):** the minimalist argued the observer token is cosmetic once nothing is
written to the ledger; the failure-mode analyst's worst-case — a local process
forging "Hermes actively reviewing" on the operator's live surface during an
incident, misdirecting human response — shows a forged *observed-lane* pulse is
real operational harm even when data-cosmetic. The operator trusts the live
surface for decisions, so the lane must not be forgeable by any local process. **I
kept the token** (constant-time, required on loopback, fail-loud if unset),
adopting the minimalist's in-memory core *and* the failure-mode analyst's trust
controls. The two are complementary, not exclusive, once the lane is in-memory.

**Empirical checkpoint:** round-1 findings were structural/code-verifiable (guard
polarity at `:582/:596`, `activity-ledger.ts:236`; route auth; per-session ledger
files + prune trigger; `timingSafeTokenEqual`; dedup key shape) — each verified
directly against `origin/main`, no runtime probe required. The most dangerous
claim (observed rows replayed as live state) is **mooted** by the in-memory pivot,
which removes the ledger from the path entirely.

**general-purpose 2026-11-07: consensus-attack — found a real shared blind spot
(incorporated, one revision → v3).** The whole panel optimized against
*false-positive* liveness (Hermes shown alive when dead) and never weighed the
*symmetric* error the operator's goal is actually about — Hermes shown *idle/dead
when working*. The ephemeral in-memory pivot is optimal for the first error and
*pessimal* for the second: it blanks the lane on every restart, and kookr-prod
restarts routinely (verified: `deploy/server/kookr.service`, `Restart=on-failure`
+ watchdog, issue #2226). It also proved the "slice 2 is just UI" cost was wrong:
the grid suppresses non-task state (`monitor.ts:665,788` `suppressSessionIds` /
`sweepUnownedDeadAgents`; `tasks.ts:859`), so the lane needs its own
`ServerMessage` type (verified precedent: `messages.ts:426-427`). **Triage:
incorporated both.** Added R7 (no false-negative across restarts), a dedicated
*durable last-state* store that is **not** the activity ledger (dissolving the
false ledger-vs-ephemeral dichotomy — survives restart with `receivedAt`-decay, so
neither false "working" nor false "idle"), `ping` re-sync + frequent heartbeat to
bound the blind window, three distinguishable empty states, and an honest
full-stack slice-2 scope. The verdict did **not** reopen a critic round (per the
attack's one-revision bound); it refined the converged design rather than
overturning it — the in-memory-hot-path + ledger-untouched core stands.
