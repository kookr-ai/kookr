# RFC: PR-State Agent Relay — Stop Making the Supervisor a Human Webhook

**Status:** Draft (v3 — post round-2 critic revision + empirical checkpoint)
**Date:** 2026-06-10
**Author:** Jean Ibarz (with Claude)

---

## Problem

When a Kookr agent opens a PR and keeps working (or pauses), the agent has no
way to learn that the PR's GitHub state changed. Today that information travels
through exactly one channel: **Jean reads GitHub and types it into the agent's
terminal by hand.**

Reflection run 17 (window 2026-06-04 → 2026-06-10, 18 sessions, 70 user
inputs) counted **at least 10 inputs that were pure GitHub-state relay**:

- `"Supervisor note: PR #616 for issue #594 is merged at https://github.com/jeanibar…"` —
  three near-identical messages in one session (2026-06-05T18-16), one per
  merged PR.
- `"PR #723 for issue #701 is open but GitHub reports mergeable=CONFLICTING after #7…"` —
  manual conflict detection after a sibling batch PR merged first.
- `"resolve conflicts"`, `"conflicts again"`, `"small conflicts to resolve"`,
  `"resolve recent comments on the PR"` — repeat manual relays for the same
  class of event.

This worsens with parallel batch volume: every batch of N sibling PRs against
the same base creates N−1 potential conflict cascades as PRs merge, and the
supervisor currently polls and relays each one. Overnight autonomous sessions
(71 launches, 0 inputs) show the system runs unattended *until* a PR-state
event needs relaying — then it silently stalls until a human notices.

### What already exists (and where it stops)

The server already has most of the machinery:

- `GitHubScannerService` (`src/core/github-scanner-service.ts`) extracts
  issue/PR references from task prompts (`extractRefsFromPrompt`) **and from
  agent hook events** (`extractRefsFromEvents`), keyed **per task**
  (`GitHubReference.taskId`; `onChanges: (taskId, changes) => …`), and polls
  their state through the `gh` CLI behind a circuit breaker
  (`src/adapters/circuit-breaker-github-fetcher.ts`). The active fetch path
  for batches is the **GraphQL** `fetchStates` (one request per repo,
  `github-fetcher.ts` `PR_STATE_SELECTION`/`parsePRNode`); the per-PR
  `gh pr view --json` path is a fallback.
- `github-state-differ.ts` already emits typed changes: `pr_merged`,
  `pr_closed`, `review_requested_changes`, `review_approved`, `ci_failed`,
  `ci_passed`, `new_comment`, `new_unresolved_thread`.
- `github-alerts.ts` maps changes to dashboard alerts; the
  `create-github-runtime.ts` bootstrap wires `onChanges` to
  `broadcastToAll({ type: 'githubUpdate', … })`.
- `UserInputDeliveryService` (`src/server/user-input-delivery-service.ts`)
  delivers text to an agent terminal keyed by **tmux session name**
  (`SessionInfo.tmuxSession`), with a tagged `UserInputDeliverySource`,
  tracks `queued → submitted_by_agent → failed`, and logs to the interaction
  log.

Two gaps remain, and they are exactly what the manual relays compensate for:

1. **Changes never reach the agent.** `onChanges` broadcasts to dashboard
   WebSocket clients only. The agent that owns the PR — the one party that can
   *act* — is not in the loop.
2. **`mergeable` is not fetched.** `GitHubPRState`
   (`src/shared/contracts/github.ts`) has `status`, `reviewDecision`, `checks`,
   threads — but no mergeability field. CONFLICTING is invisible even to the
   dashboard; the differ cannot emit what the fetcher never reads.

### Load-bearing dependency: ref tracking of agent-created PRs

The relay can only fire for PRs the scanner tracks. PRs created by the agent
mid-session enter tracking via `extractRefsFromEvents` — i.e. only once the PR
number/URL appears in a captured hook event (typically `gh pr create` tool
output).

**Empirically verified (design-experimenter, 2026-06-10): PARTIAL.** The live
path works: `shouldScanToolResult` passes Bash `gh pr create`/`gh pr merge`
results (mutating-command regex) and all non-Bash tool results (covering MCP
`create_pull_request`), and a real captured `PostToolUse` event for an
agent-created PR contained the parseable `/pull/N` URL. The verified gap:
`GitHubStateStore` is **purely in-memory** — a server restart loses all
tracked refs, and `refreshTaskState` re-scans only the task *prompt*, so an
agent-created PR is not re-tracked after a restart unless the agent emits
another scannable `gh pr` event. Accepted v1 gap (see Edge cases); the
`no_live_session`/drop instrumentation makes its frequency measurable before
deciding whether ref persistence is warranted.

## Requirements

- **R1** — When a tracked PR owned by a running Kookr task transitions to
  `merged`, the owning agent receives a templated notification message in its
  session without human involvement.
- **R2** — When such a PR transitions from mergeable to non-mergeable against
  its base (`mergeable: CONFLICTING`), the owning agent receives a templated
  notification instructing it to rebase, without human involvement.
- **R3** — Relay messages are delivered through the existing
  `UserInputDeliveryService` with a distinct source tag, are recorded in the
  interaction log **with that source**, and are rendered in the dashboard
  activity feed with a visible non-human attribution (not "You").
- **R4** — Each (PR, change-type) occurrence is relayed **at most once**; a
  per-task rate cap (4/hour, hard-coded) bounds worst-case relay storms.
- **R5** — Ownership is resolved primarily by **`ref.taskId`** (the scanner
  already keys every reference to the task whose prompt/events produced it).
  The task must be `inProgress` and have a live session. If the task has
  multiple live sessions, prefer the one whose current branch matches the PR
  head branch; otherwise the most recently created. No live session → no
  relay (dashboard alert only), and a structured drop event is recorded.
- **R6** — Relayed message text is **fully templated from trusted or
  low-risk fields** (repo, PR number, head/base branch names). No
  third-party-authored *prose* (PR titles, comment bodies, review bodies) is
  ever injected into an agent session by the relay.
- **R7** — The feature is globally toggleable (`enabled: boolean`). The
  relayed change-type set is **hard-coded** to `{pr_merged, pr_conflicting}`
  in v1 — not a config knob.
- **R8** — `mergeable: UNKNOWN` (GitHub computes mergeability asynchronously;
  GraphQL returns `null`/`UNKNOWN` until computed) never triggers a relay;
  `pr_conflicting` requires an observed `MERGEABLE → CONFLICTING` transition
  between two fetches in the same process lifetime. First-fetch CONFLICTING
  never relays.
- **R9 (observability)** — Every relay decision is observable: deliveries are
  attributed in the activity feed and interaction log; **drops** produce a
  structured event with a `dropReason`
  (`ownership_miss | no_live_session | rate_cap | dedup | delivery_failed`);
  mid-turn **deferrals** are not drops — they silently re-queue (one pending
  entry per occurrence, no repeated events); server startup logs the relay's
  mode.

## Non-Goals

- Relaying free-prose content (comment bodies, review text) to agents —
  excluded by R6. Note the *correct* injection analysis: `new_comment` and
  `new_unresolved_thread` carry third-party `body` text and stay excluded;
  `review_requested_changes` (carries only a reviewer login) and `ci_failed`
  (carries only a check name) are **template-safe** and are the designated
  v2 additions once v1 relay behavior is validated in production — added as a
  code change with evidence, not a config toggle.
- GitHub webhooks or any inbound public endpoint (Kookr is local-first; the
  existing poll loop is the transport).
- Waking *terminated* tasks or spawning new tasks in response to PR events.
  The lifecycle machinery exists (`terminated → open` is a valid transition;
  `reopenTask` is a WS handler), so this is a realistic **phase 2**: v1's
  structured `no_live_session` drop events quantify the need; the dashboard
  "stalled PR events — relaunch?" affordance and any task-record stamping
  belong to phase 2. v1 does not act on these drops.
- Changing dashboard alert behavior — `githubUpdate`/`alert` broadcasts stay
  as they are; the relay is additive.

## Design

### 1. Fetch mergeability (GraphQL-first)

Extend `GitHubPRState` with:

```ts
mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
```

The **active** fetch path is GraphQL `fetchStates`: add `mergeable` to
`PR_STATE_SELECTION` and map it in `parsePRNode`, normalizing `null` →
`'UNKNOWN'`. Also add `mergeable` to the `gh pr view --json` fallback field
list for parity. No extra API call on either path.

GitHub recomputes mergeability lazily (every base push resets it to
UNKNOWN/null until a background job settles it). The poll cadence must
tolerate this; R8's transition rule absorbs it — worst case one to two extra
poll cycles of latency (**empirically observed** on real repos: a 30s-interval
poll loop showed UNKNOWN settling within one cycle; some PRs took two
queries). Two verified nuances: CONFLICTING is stable once computed (probed
live on a real conflicting PR via both GraphQL and `gh pr view`), and
`mergeable` stays UNKNOWN **permanently on merged PRs** (GitHub never computes
it post-merge) — benign for the relay (R8 requires an open PR and a known→
known transition) but relevant to dashboard rendering (§6).

### 2. New change type

`GitHubStateChange` gains one member:

```ts
| { type: 'pr_conflicting'; ref: GitHubReference }
```

`github-state-differ.ts` emits it **only** on the transition
`prev.mergeable === 'MERGEABLE' && current.mergeable === 'CONFLICTING'` with
the PR open. It does **not** emit on first fetch: first-fetch occurs on
server restart and whenever an old PR number is merely *mentioned* in agent
events — relaying an unsolicited "rebase and force-push" instruction for a
stale or abandoned PR is actively harmful. First-fetch CONFLICTING is
invisible to the relay by construction (dashboard alerting for it can be
added to the existing first-fetch block independently if wanted; out of
scope here).

`github-alerts.ts` maps `pr_conflicting` to a `warning` dashboard alert.
Note its `formatGitHubAlert` switch is exhaustive with no `default` — the
new union member **requires** updating it (compile-enforced).

No `pr_mergeable_restored` counterpart: the agent that rebases sees the
result of its own push; a restoration event is noise.

### 3. The relay: `GitHubChangeAgentRelay`

A use-case-layer service, `src/server/use-cases/github-agent-relay.ts`
(policy, not bootstrap plumbing), with its collaborators injected
(taskStore, github-state-store, delivery service, an idleness predicate —
see below). It is constructed in
`src/server/bootstrap/create-github-runtime.ts` and invoked from the
`onChanges` callback there (alongside, not replacing, `broadcastToAll`):

```ts
onChanges: (taskId, changes) => {
  broadcastToAll(…);                      // unchanged
  agentRelay.onChanges(taskId, changes);  // new; errors caught internally
}
```

**Critical structural fact (round-2 verified):** the scanner is
store-then-diff and the differ is transition-only, so `onChanges` fires
**exactly once** per occurrence — there is no re-emission to "retry
against" on a later poll. The relay therefore owns its own state machine:

- `onChanges` **enqueues** eligible changes into a relay-owned
  `pendingDeliveries` map (key `${owner}/${repo}#${number}:${type}`,
  value: taskId + created-at + attempt count) after the filter and
  ownership steps below. One pending entry per occurrence — repeated
  deferral does not create repeated drop records.
- A relay `tick()` — driven by the existing 5-second watchdog/lifecycle
  timer, no new timer — attempts delivery of pending entries whose owning
  agent is idle, and expires entries whose task left `inProgress`
  (recording the drop).

Per change, in order:

1. **Filter:** hard-coded set `{pr_merged, pr_conflicting}`.
2. **Resolve ownership (R5):** `taskId` comes with the callback (refs are
   task-keyed — this is the primary ownership fact, not branch matching).
   Require `task.status === 'inProgress'` and at least one live session
   (same liveness predicate the dashboard actions use). Session selection
   within the task: single live session → use it; multiple → prefer
   `SessionInfo.gitBranch === prState.branch` (read the head branch via
   `stateStore.getPRState(ref)`), falling back to the most recently created
   live session. **Caveat acknowledged:** `SessionInfo.gitBranch` is captured
   from the spawn cwd and refreshed only opportunistically, so it lags when
   the agent creates a sibling worktree with a new `-b` branch — which is
   exactly the standard Kookr discipline. That is why branch equality is a
   *tiebreaker among sessions of the already-identified owning task*, never
   the ownership requirement. No live session → record drop
   (`no_live_session`) and return.
3. **Idleness gate:** delivery happens only when the owning agent is idle.
   The relay does **not** read raw `turnState` (that would couple it to the
   monitor's derivation internals); the Monitor exposes a stable predicate
   `isIdleForInput(sessionId): boolean` (true on `completed_turn` /
   `waiting_for_input`) that the relay consumes. Mid-turn → the entry stays
   in `pendingDeliveries`; the next tick re-checks. **Residual TOCTOU
   acknowledged:** the agent can start a new turn between the predicate
   check and the PTY write; the gate is best-effort, not a hard guarantee —
   acceptable because templates are idempotent instructions. (Verified
   mid-turn queueing, O1, would dissolve this entirely.)
4. **Dedup + rate cap (R4):** evaluated at delivery time, in this order:
   dedup check → cap check → deliver. **"Delivered" means PTY-accepted**:
   `submitMessage` resolved without throwing. That is weaker than
   agent-consumed (the service's `queued → submitted_by_agent | failed`
   lifecycle confirms consumption later and a session can die in between) —
   accepted and documented; the delivery snapshot's `failed` state remains
   visible in the activity feed. On PTY-accept: add the dedup key, count
   against the cap, remove the pending entry. On throw: keep the entry
   pending (bounded by max 3 attempts, then drop with reason
   `delivery_failed`; attempts count only PTY-write throws — idle-gate
   deferrals never consume attempts, so a long-busy agent stays queued, not
   exhausted). The cap (4/task/hour, hard-coded) counts **only PTY-accepted
   deliveries** — never deferrals, dedup hits, or drops. Both dedup set and
   cap window are in-memory and process-local — explicitly
   **non-authoritative**: a restart re-relaying a still-CONFLICTING PR once
   and resetting the cap window is accepted (the cap bounds storms within a
   process lifetime).
5. **Deliver (R3):** `userInputDelivery.submitMessage(tmuxSession, text,
   'github_watcher')` — one new member on the `UserInputDeliverySource`
   union (today `'respond' | 'directReply'`). The key is the **tmux session
   name**, matching the service's existing calling convention. The promise
   is always `.catch`-handled inside the relay (no unhandled rejections
   from the `onChanges` call site).

### 4. Message templates (R6)

Built exclusively from `ref` + branch-name fields:

> `Kookr GitHub watcher: PR #723 (head fix/issue-701, base main) is now
> CONFLICTING with its base. Rebase your worktree branch onto the base
> branch, resolve conflicts, and force-push with --force-with-lease.`

> `Kookr GitHub watcher: PR #616 (head fix/issue-594) was merged. If your
> task is complete, signal completion-ready; otherwise continue with any
> remaining post-merge steps.`

No title, no comment text, no usernames. An attacker who can rename a branch
controls at most a branch-name string the agent already has in its own git
state.

### 5. Configuration and rollout (R7)

One knob, same settings path the GitHub polling toggle uses — but a
tri-state, because a brand-new automated injection path must not go live
unvalidated:

```ts
githubAgentRelay: { mode: 'off' | 'shadow' | 'active' } // default 'shadow'
```

- **shadow (default at ship):** the full pipeline runs — filter, ownership,
  idleness, dedup, cap — but instead of injecting, logs a structured
  "would deliver to <tmuxSession>" event. One reflection window (~2 weeks)
  of shadow traffic validates ownership resolution against real PRs with
  zero blast radius; misfires are visible as wrong-session would-deliver
  lines.
- **active:** real delivery. Flipped after shadow validation.
- Rollback is a config change back to `shadow`/`off` (no code revert).

Change-type set and rate cap are hard-coded; if the defaults prove wrong the
fix is a code change with evidence, not a knob nobody can safely tune.

**PR sequencing:** two independently-mergeable PRs. PR 1 — contracts +
fetcher + differ + alerts (`mergeable`, `pr_conflicting`,
`formatGitHubAlert` case, `UserInputDeliverySource` member, interaction-log
`source`): pure additive, dashboard value on its own, compile-enforced
consistency. PR 2 — the relay service, Monitor predicate, bootstrap wiring,
ActivityPanel attribution, tests.

### 6. Observability (R9)

- **Interaction log:** add `source?: UserInputDeliverySource` to the
  `user_input` branch of `InteractionEvent` (`src/core/interaction-log.ts`)
  so relayed messages are distinguishable offline and across restarts.
  Historical entries lack the field — readers treat `undefined` as
  human-typed.
- **Activity feed:** `ActivityPanel.tsx` currently hardcodes the label
  `"You"` for every user-input delivery. Render from a
  `DELIVERY_SOURCE_LABEL` map exported next to the
  `UserInputDeliverySource` union (`src/shared/contracts/
  user-input-delivery.ts`) — `'github_watcher'` → "Kookr watcher" — so this
  RFC and the delivery-gate RFC (`'signal_action'` → "One-click") extend one
  owned map instead of competing inline conditionals.
- **Drop events:** every drop records a structured server-log event (fixed
  tag, machine-readable fields: `taskId`, `prRef`, `changeType`,
  `dropReason` — the R9 union). Deferrals re-queue silently. The server log
  alone is the phase-1/2 evidence base; a task-record
  `undeliveredRelayEvents` stamp was considered and **deferred to phase 2**
  (round-3 minimalist: the log query suffices until the "stalled PR events —
  relaunch?" affordance is actually built).
- **Startup log:** when enabled, log one line in the existing
  "GitHub PR awareness enabled (…)" pattern naming the armed change types
  and cap.
- **Mergeability visibility:** the GitHub panel renders `mergeable`,
  including an explicit "pending" presentation for UNKNOWN on open PRs, so
  "why hasn't the relay fired" is answerable from the dashboard. For merged
  PRs render "N/A", not "pending" — UNKNOWN is permanent there (verified).

## Files to change

| File | Change |
|------|--------|
| `src/shared/contracts/github.ts` | `mergeable` field on `GitHubPRState`; `pr_conflicting` change type |
| `src/adapters/github-fetcher.ts` | `mergeable` in GraphQL `PR_STATE_SELECTION` + `parsePRNode` (null→UNKNOWN); parity in `gh pr view --json` fallback |
| `src/core/github-state-differ.ts` | emit `pr_conflicting` on MERGEABLE→CONFLICTING transition only (R8) |
| `src/core/github-alerts.ts` | `pr_conflicting` case in the exhaustive `formatGitHubAlert` switch |
| `src/server/use-cases/github-agent-relay.ts` | **new** — filter, taskId-primary ownership, pendingDeliveries queue + tick, idleness gate, dedup, cap, templates, drop events, shadow mode |
| Monitor | expose `isIdleForInput(sessionId): boolean` predicate (owns turn-state semantics once) |
| `src/shared/contracts/user-input-delivery.ts` | add `'github_watcher'` to `UserInputDeliverySource`; `DELIVERY_SOURCE_LABEL` map |
| `src/core/interaction-log.ts` | `source` on `user_input` events |
| `src/server/bootstrap/create-github-runtime.ts` | construct relay; call from `onChanges`; hook tick into existing lifecycle timer |
| `src/frontend/components/ActivityPanel.tsx` | source-aware attribution label from the shared map |
| GitHub panel component | render `mergeable` incl. UNKNOWN-pending (open) / N/A (merged) |
| config + docs | `githubAgentRelay.mode` |
| tests | differ transitions (incl. UNKNOWN, first-fetch suppression), relay ownership/idle-gate/pending-queue/dedup/cap/drop-reasons/shadow, fetcher GraphQL mapping, activity label |

## Verification plan — results (design-experimenter, 2026-06-10)

- **V1 (load-bearing): PARTIAL.** Live ref tracking of agent-created PRs
  verified against real hook data (197k events; a real `PostToolUse` for an
  agent-created PR carries the parseable URL; both Bash `gh pr create` and
  MCP tool paths pass `shouldScanToolResult`). Gap: in-memory
  `GitHubStateStore` loses refs on server restart and prompt re-scan doesn't
  recover event-sourced refs — accepted v1 gap, measured via drop events.
- **V2: VERIFIED.** Tri-state obtainable via GraphQL `mergeable` and
  `gh pr view --json mergeable`; UNKNOWN settles in 1–2 poll cycles on open
  PRs (observed in a real 30s poll loop); CONFLICTING stable (probed live);
  UNKNOWN permanent on merged PRs (render "N/A"). Confirmed neither the
  GraphQL selection nor the CLI fallback fetches `mergeable` today. Note:
  in production the GraphQL `fetchStates` path short-circuits before the
  per-PR fallback, so fallback parity is lower priority than the GraphQL
  change.
- **V3 (deferred, gates O1):** Mid-turn injection semantics. Not
  load-bearing for v1 (the turn-state gate sidesteps it).

## Edge cases

- **UNKNOWN flapping (R8).** After every base push GitHub resets
  mergeability; the known→known transition rule means at worst one extra
  poll cycle of latency, never a false relay.
- **Prompt injection via PR content.** Why R6 exists. `new_comment` /
  `new_unresolved_thread` payloads contain third-party-authored text;
  delivering them into an agent session is delivering instructions. The
  template-safe v2 additions (`review_requested_changes`,
  `ci_failed`) render only a login / check name.
- **Self-discovery races the relay.** An *active* agent often discovers its
  own conflict on the next push; the relay's marginal value there is low.
  The high-value population is the paused/idle agent — which is exactly
  where the turn-state gate delivers immediately. Accepted: some relays
  will tell an agent something it just learned; the templates are idempotent
  instructions, and dedup caps the noise at one message.
- **Two tasks, same branch.** Branch names recur across retries. Ownership
  is task-keyed (R5), so the wrong-task case requires the *same ref* tracked
  by two `inProgress` tasks — possible (both prompts mention PR #N). Both
  then get a relay; each owning agent re-validates against its own git
  state. Acceptable; log both deliveries.
- **Agent exits between change and relay.** Liveness is re-checked at relay
  time; drop with `no_live_session` (recorded on the task for phase 2).
- **Circuit breaker open / `gh` failures.** No fetch → no diff → no relay.
  The relay adds no GitHub calls and inherits breaker behavior. The
  breaker's existing status broadcast tells the operator polling is dark;
  the relay startup/drop logging covers the rest.
- **Conflict cascades in batches.** Sibling PRs are owned by sibling tasks
  (one task per issue), so each owning agent gets exactly one message; the
  per-task cap is a backstop for the rarer many-PRs-per-task shape. A global
  ceiling is deliberately omitted in v1 — revisit with evidence.
- **Re-conflict after recovery.** Dedup is per-occurrence: a second
  MERGEABLE→CONFLICTING transition is a new change and relays again —
  correct, it is a new fact.
- **codex-cli sessions.** v1 relays to claude-code sessions only; codex-cli
  follows once its input semantics are verified (Open questions O1).
- **Server restart loses event-sourced refs (verified).** `GitHubStateStore`
  is in-memory; after a restart, an agent-created PR is untracked until the
  agent emits another scannable `gh pr` event or the operator triggers
  `refreshTaskState` (prompt refs only). Accepted v1 gap; drop-event
  telemetry quantifies it before investing in ref persistence.

## Alternatives considered

- **GitHub webhooks.** Push-based, instant — but requires a publicly
  reachable endpoint or tunnel, against Kookr's local-first posture, for a
  latency win the poll loop doesn't need.
- **Agents self-poll (`gh pr view` in a loop).** The de-facto current
  workaround in some playbooks. Burns agent tokens, duplicates polling logic
  in every prompt, and a paused/blocked agent can't poll at all — precisely
  the failing case.
- **Dashboard-only alerts (status quo).** Demonstrably insufficient — the
  ≥10 manual relays happened *with* dashboard alerts available, because
  acting on them still requires a human to copy state into the agent.
- **Auto-spawn a fix task instead of messaging the agent.** Loses the owning
  agent's loaded context (worktree, branch, task history) and conflicts with
  one-task-one-worktree discipline. Messaging the live owner is the minimal
  correct action; task wake-up is the named phase 2 for dead owners.
- **Branch-match-primary ownership (v1 draft).** Falsified in review:
  `SessionInfo.gitBranch` reflects the spawn cwd and lags the agent's
  sibling-worktree branch, so the match would silently fail for the exact
  population the RFC targets. Replaced by taskId-primary resolution.

## Open questions

- **O1:** Mid-turn injection semantics for claude-code (and codex-cli). The
  turn-state gate makes this non-blocking for v1; verifying it (V3) would
  allow immediate mid-turn delivery and codex-cli support.
- **O2:** Should `pr_closed` (without merge) be relayed? It usually signals
  human rejection; the right agent response is less scripted. Deferred
  pending evidence.

## Critic feedback incorporated

Round 1 (2026-06-10) — failure-mode-analyst, design-minimalist,
ambition-amplifier, socratic-challenger, operability-reviewer:

- **failure-mode-analyst:** branch-match ownership falsified
  (`gitBranch` captured at spawn cwd vs worktree discipline) → taskId-primary
  resolution (R5 rewritten); `mergeable` moved to the GraphQL `fetchStates`
  path (`PR_STATE_SELECTION`/`parsePRNode`, null→UNKNOWN); first-fetch
  CONFLICTING relay removed (transition-only, R8); mid-turn queueing claim
  replaced by an explicit turn-state gate with retry; dedup keyed on
  successful delivery only.
- **design-minimalist:** config reduced to `enabled` only (change-type set
  and cap hard-coded); wiring point corrected to
  `create-github-runtime.ts`; delivery key named `tmuxSession` per the
  service's convention; `formatGitHubAlert` exhaustive-switch note;
  state-store lookup path clarified.
- **ambition-amplifier:** injection rationale corrected —
  `review_requested_changes`/`ci_failed` carry only login/check-name and are
  template-safe; named as designated v2 additions. Terminated-task wake-up
  promoted from vague future work to an explicit phase 2 with v1 laying the
  data (`no_live_session` drops stamped on the task).
- **Adversarial pair resolution (required):** design-minimalist wanted the
  change-type set hard-coded and ambition-amplifier wanted it broader; we
  sided with the minimalist for v1 scope (two types, no knob) while adopting
  the amplifier's corrected injection analysis as the documented v2 path —
  scope stays small now without rationalizing the cap with a wrong security
  argument.
- **socratic-challenger:** surfaced the load-bearing ref-tracking dependency
  (V1) and the GraphQL-vs-CLI mergeable question (V2); self-discovery race
  acknowledged as an edge case; merged-template wording softened to avoid
  nudging dead-purpose work.
- **operability-reviewer:** R9 added — structured drop reasons, interaction-
  log `source` field, ActivityPanel attribution (was hardcoded "You"),
  startup log, UNKNOWN-pending rendering, restart semantics of dedup/cap
  documented.
- **design-experimenter (post-round-1 checkpoint, 2026-06-10):** V1 PARTIAL
  (live ref tracking works; in-memory state store loses refs on restart —
  documented as accepted gap), V2 VERIFIED (tri-state settles 1–2 cycles;
  CONFLICTING stable; UNKNOWN permanent on merged PRs; production path is
  GraphQL-only). Latency claim corrected, dashboard rendering nuance added.
Round 2 (2026-06-10) — failure-mode-analyst, boundary-critic,
delivery-pragmatist:

- **failure-mode-analyst (CRITICAL):** "retry on next poll" falsified —
  the scanner is store-then-diff and `onChanges` fires once per occurrence;
  the relay now owns a `pendingDeliveries` queue with a tick on the existing
  lifecycle timer. "Delivered" defined as PTY-accepted (with the
  accept≠consumed caveat); cap counts only accepted deliveries; gate→dedup→
  cap→deliver ordering specified; TOCTOU on the idleness gate acknowledged
  as best-effort.
- **boundary-critic:** relay moved to `src/server/use-cases/` with injected
  collaborators; raw `turnState` reads replaced by a Monitor-owned
  `isIdleForInput` predicate; in-memory dedup/cap state declared
  non-authoritative vs the task-record counter; shared
  `DELIVERY_SOURCE_LABEL` map owned by the contracts module (coordinates
  with the delivery-gate RFC).
- **delivery-pragmatist:** default flipped from `enabled: true` to a
  tri-state `mode` defaulting to **shadow** (full pipeline, log-only) for
  one validation window before going active; two-PR merge sequence
  specified (contracts-first); rollback is config-only; historical
  interaction-log entries noted as source-less.
Round 3 (2026-06-10) — failure-mode-analyst, design-minimalist: both
**CONVERGED**. Polish applied: drop-reason union reconciled to
`{ownership_miss, no_live_session, rate_cap, dedup, delivery_failed}` with
deferrals explicitly not drops; attempt-counter semantics clarified
(idle-gate deferrals never consume attempts); the task-record
`undeliveredRelayEvents` stamp deferred to phase 2 (server-log drop events
suffice for evidence).

- ambition-amplifier 2026-06-10: novel findings (injection-rationale
  correction; terminated-task wake-up gap).
- assumption-archaeologist: not invoked — no ADR-justified behavior is being
  changed.
