# RFC: Delivery-Gate Streamlining — Pre-Authorized Delivery and a One-Click "Push & Open PR"

**Status:** Draft (v3 — post round-2 critic revision)
**Date:** 2026-06-10
**Author:** Jean Ibarz (with Claude)

---

## Problem

Every Kookr task prompt carries a server-appended gate (the worktree
guardrail preamble, `src/server/worktree-guardrails.ts`): *"After committing,
don't end your turn silently — unless the task already told you to deliver,
ask the user whether to push the branch and open a PR."* The gate is
intentional. Its **cost** is now measured.

Reflection run 17 (2026-06-04 → 2026-06-10, 18 sessions, 70 user inputs):

- **~15 of 55 directives were pure gate releases**: `"yes, push and open PR"`
  (×5), `"yes, go ahead"` (×4), `"push and open the PR"`,
  `"ok create a PR and merge it"`, `"ok proceed"` (×3), plus bare `"yes"`
  approvals (×4).
- **Average needs_input resolution time: 4085 s (~68 minutes).** An agent
  that finishes its work and asks the gate question strands for an hour, on
  average, waiting for one word.
- The repeated-instructions analyzer independently surfaced `"push and open
  pr"`, `"go ahead"`, and `"proceed"` as the top *organic* repeated
  instructions — each a system gap by the reflection skill's own definition.

An honest read of the 68-minute number: much of it is **human absence**, not
decision time — overnight sessions prove the supervisor is often away. A
better mechanism cannot make an absent human answer faster. What it *can* do:

1. **Remove the question entirely where it is ceremony** (batch tasks whose
   playbook already names a PR as the deliverable). This eliminates the wait,
   absent human or not — and it is where most of the 15 inputs came from.
2. **Make the remaining genuine gates non-blocking and one-click** so the
   agent doesn't strand in `waiting_for_input`, the attention queue isn't
   polluted with `needs_input` findings for ceremony, and a present human
   spends one click instead of reading a terminal and typing.

Critically, the evidence shows prompt text alone does not win this fight:
batch playbooks *already say* "open a PR with `Closes #N`", yet agents still
pause — the server-appended guardrail gate outranks the playbook body in
practice. Any fix must change what the server appends, not add a third
competing instruction.

A related friction from the same window: four sibling batch agents each asked
the same templated multiple-choice question, and the user typed `"2"` four
times — template ambiguity multiplies by batch fan-out.

## Requirements

- **R1** — A playbook can declare delivery pre-authorized; tasks launched from
  it complete the delivery cycle without repeated prompts: commit verified
  work, push the branch, open or update the PR, and report the PR URL. The
  declaration changes the **server-appended gate**, not just playbook prose.
- **R2** — Pre-authorization is auditable: the task record carries a
  structured marker of the authorization mode it was launched with.
- **R3** — Pre-authorization is not unconditional: the agent retains an
  explicit instruction to *withhold* the PR when the work does not actually
  satisfy the task ("stop and report" escape hatch). Pre-authorized means
  "don't ask when the work is good", not "always push".
- **R4** — For non-pre-authorized tasks, an agent that has committed work and
  wants delivery authorization can express that **without blocking**: it
  raises a signal and ends its turn, rather than holding `waiting_for_input`.
- **R5** — The dashboard surfaces that signal as a one-click affordance
  ("Push & open PR"); the accept action **atomically** delivers an
  unambiguous canned authorization to the agent and clears the pending
  signal, through a single server operation (logged, source-tagged).
- **R6** — The user can dismiss the signal (decline) without typing; the
  agent stays paused and the badge clears (existing dismiss path).
- **R7** — The agent treats the canned authorization as authorization, not as
  a guarantee of state: it re-validates its worktree (clean, committed,
  rebased) before pushing, exactly as it would after a typed "yes".
- **R8** — Batch playbook templates pre-answer foreseeable choices (or
  delegate them explicitly), so one ambiguity does not fan out into N
  identical questions.
- **R9** — Part B ships only if the measured residual after Part A justifies
  it (see Phasing).

## Non-Goals

- Auto-*merge*. Pre-authorization covers push + PR creation; the PR itself
  remains the human review gate. (`gh pr merge --auto` was considered — see
  Alternatives; rejected for now because the target repos largely lack the
  branch-protection rules that make auto-merge a gate rather than a bypass.)
- Removing the gate for interactive tasks. R4–R6 make the gate cheap, not
  absent.
- Claude Code permission-rule changes (`git push` allowlisting). That layer
  decides whether the *tool call* prompts; this RFC decides whether the
  *workflow* asks. **Prerequisite, not edge case:** for Part B's no-strand
  benefit to be real on interactive (non-bypass) setups, `git push` must be
  permission-allowlisted — otherwise the one-click authorization just moves
  the strand to a `permission_blocked` prompt. Part A's batch population
  already runs with bypass permissions.
- A general mid-task structured-ask surface. Bigger design; the signal
  surface's bounded-kind governance rule is the guardrail against scope
  creep here.

## Design

### Part A — Pre-authorized delivery (batch playbooks)

**A1. Frontmatter flag, consumed server-side.** Playbooks gain an optional
frontmatter field:

```yaml
deliveryPreAuthorized: true
```

parsed by `playbook-parser.ts` (the `Playbook` interface in
`src/core/playbook.ts` gains the optional field) — **parser-first merge
order**: interface + parser land before the launch-path threading reads the
field. The playbook launch use-case resolves the flag into a server-internal
`DeliveryPolicy` parameter passed directly to the guardrail builder. It is
deliberately **not** added to the shared `LaunchOpts` contract: that contract
is visible to the frontend and CLI, and a launch option would let any caller
synthesize pre-authorization without a playbook — the flag is
playbook-internal policy. The guardrail builder **swaps the gate sentence**:

- default (absent/false) — current text: "…ask the user whether to push the
  branch and open a PR."
  > **Amended 2026-07-30 (#1706):** the default flipped. Absent now resolves
  > to **pre-authorized**; only an explicit `deliveryPreAuthorized: false`
  > (or serverOpts `deliveryPolicy: 'ask-first'`) produces the ask-first
  > gate. Unrecognized frontmatter values fail safe to ask-first.
- pre-authorized — replacement: "Delivery is pre-authorized for this task:
  when your work is committed and verified, finish the full delivery cycle
  without asking again — commit, push the branch, open or update the PR, and
  report the PR URL. If you show a diff or plan and the user approves it, treat
  that as approval to continue through the full delivery cycle. The PR is the
  review gate. If the work does **not** actually satisfy the task, do NOT open
  a PR; stop and report what's wrong instead."

This is the decisive difference from prompt-only approaches: the conflicting
server-appended instruction is *removed*, not argued with. (Round-1 review
confirmed the gate text lives in `worktree-guardrails.ts` and is pinned by
several test fixtures — those fixtures change with it.)

Three round-2-verified constraints on the swap:

- **Freeze-at-launch semantics.** The guardrail is applied once at launch
  and baked into the stored `task.prompt`; crash recovery and Ralph
  relaunches re-send that stored prompt verbatim. So the pre-authorized
  variant *survives relaunch by persistence, not re-derivation* — and the
  flag is effectively immutable per task. Stated explicitly because it is
  load-bearing.
- **Sentinel compatibility.** `applyWorktreeGuardrails` is idempotent via
  sentinel regexes (`hasWorktreeGuardrails`). The replacement text **must
  retain the sentinel-matching phrases** (worktree-add instruction, "do not
  commit to main"), otherwise any re-derive path would fail to recognize the
  prompt as guarded and append the *default* gate on top — reintroducing
  exactly the "third competing instruction" failure this design exists to
  avoid. A test asserts a pre-authorized prompt is not re-guarded by a
  second `applyWorktreeGuardrails` call.
- **Display stripping.** `src/core/prompt-display.ts` strips the guardrail
  preamble for display via `WORKTREE_GUARDRAIL_PREFIX_RE`, which anchors on
  the current gate sentence. The regex must learn the pre-authorized variant
  in the same change, or pre-authorized tasks show the raw preamble in the
  task detail view.

**A2. Audit marker (R2).** The launch path stamps the task record:
`deliveryAuthorization: 'pre-authorized' | 'ask-first'`. One optional field
on the task entity; queryable later ("which tasks pushed without a human
click"), no UI in v1. This replaced a v1-draft launch-form parameter — review
found no evidence for per-launch overrides, and the structured field serves
the audit need the form never did.

**A3. Pre-answered choices (R8).** Batch templates gain a standing clause:

> If you face a design choice the issue does not settle, pick the smallest
> implementation that satisfies the issue, note the choice and alternatives
> in the PR description, and continue. Do not stop to ask.

(The PR description becomes the record; the human reviews it there.)

### Part B — One-click delivery for interactive tasks

**B1. New signal kind.** `AgentSignalKind` gains `'delivery_ready'`
(`src/shared/contracts/agent-signal.ts`). It satisfies the surface's
governance rule (use case / accept action / dismiss action — all three):

| | |
|---|---|
| Use case | Agent has committed work on a branch and wants authorization to push + open PR |
| Accept | One server operation delivers canned authorization text to the agent **and** clears the signal |
| Dismiss | Signal clears; agent stays paused; no input sent (existing `dismissAgentSignal`) |

The CLI (`kookr signal`) validates kinds against `AGENT_SIGNAL_KINDS` — one
source of truth, no second hardcoded list.

**B2. Agent contract.** For non-pre-authorized tasks, the guardrail gate
sentence becomes:

> After committing, run
> `kookr signal delivery-ready --note "<branch>, <n> commits, <verify status>"`
> and end your turn. Do not block waiting for the answer.

This converts the blocking ask (`waiting_for_input`, `needs_input` finding)
into the non-blocking signal pattern — same shape as `completion_ready`, one
lifecycle step earlier.

**B3. Accept action: `acceptAgentSignal`.** Round-1 review established that
the existing `respond` WS path does **not** clear pending signals (only
`dismissAgentSignal` does), so "reuse respond" would leave the button lit and
double-fireable. Instead, one new WS message:

```ts
{ type: 'acceptAgentSignal', taskId }
```

Server-side: resolve the pending signal kind → look up the kind's canned
text from a map owned by the signal contract module (so a future REST/CLI
accept path resolves the same text — no duplication in the WS handler) →
`await` delivery via `UserInputDeliveryService` with source
`'signal_action'` → **clear the signal only on delivery acceptance**.
"Atomic" means precisely: *no state in which the signal is cleared but no
authorization was delivered.* If the PTY write throws (session died between
the liveness check and the write), the signal stays pending, the button
stays lit for retry, and the `failed` delivery surfaces in the activity
feed. (PTY-accept ≠ agent-consumed — same documented caveat as the relay
RFC; the delivery lifecycle's `failed` terminal state covers the
accept-then-die window.) For `delivery_ready` the canned text is:

> Approved: push the branch and open the PR. (One-click authorization via
> Kookr delivery_ready signal.)

**B4. Rendering — an explicit predicate, not a mirror.** Review showed the
`completion_ready` affordance is gated on a predicate entangled with the
`needs_input` anomaly (`isCompletedTurn = anomaly?.type === 'needs_input' &&
turnState === 'completed_turn'`), which a *non-blocking* delivery-ready agent
will not satisfy — that's the point of B2. `delivery_ready` therefore gets
its own gate in `DetailPanel.tsx`:

```
pendingSignal?.kind === 'delivery_ready' && turnState === 'completed_turn'
```

(no anomaly requirement), rendering a **"Push & open PR"** button plus the
existing quiet dismiss. The button disables when the session is not alive —
the same liveness predicate the other task actions use; a click on a
just-died session surfaces the existing `failed` delivery status rather than
silence. This is a documented behavior fork from `completion_ready` (whose
accept remains the pulsed Complete button), not a mirror.

**Background-task caveat (round-2 verified):** `completed_turn` requires the
turn's final stop with *zero* background tasks/session crons — an agent that
parks background work never reaches it, so its raised signal would never
render. The B2 contract text therefore says "end your turn **fully** (no
background tasks)"; and the render gate should be revisited to also accept
the background-only-running state if evidence shows agents legitimately hold
background work at delivery time. The targeted population (committed, wants
to push) rarely does; documented, not solved, in v1.

**B5. Signal note as context.** The `--note` (≤280 chars, secret-scrubbed —
existing machinery) shows in the button tooltip: `fix/panel-flicker, 3
commits, tests pass`. The diff pane in `DetailPanel` is one click away for
inspection before accepting. (Review pushed for a mandatory inline diff
summary at decision time; deferred — see Open questions O3.)

**B6. Signal-ordering invariant.** `pendingSignal` is single-slot,
latest-wins. If the agent raises `completion_ready` before the user acts on
`delivery_ready`, the delivery affordance is replaced by the Complete pulse.
This is **intended**: the agent contract requires `completion_ready` only
after delivery is actually done (PR opened) or the task is genuinely
finished without one — so an overwrite means the delivery decision became
moot, not skipped. The agent-side rule lives in the same guardrail text:
"signal completion-ready only after the PR is open (or if no PR is needed)."
The invariant's correctness rests on agent compliance with that rule — a
violating overwrite is indistinguishable from a legitimate one at the UI, so
the server logs every signal overwrite (`old kind → new kind`) to make
gun-jumping agents auditable.

### Composition with the PR-state relay RFC

Together with `rfc-pr-state-agent-relay.md`, the happy path closes without a
typed input: agent commits → `delivery_ready` → one click → PR opens →
(merged | CONFLICTING) relayed back to the agent automatically → agent
finishes → `completion_ready` → one click. The supervisor's remaining typed
inputs become actual decisions, not ceremony. (Each link has its own
verification plan; the composition is only as strong as its weakest link and
is a goal, not a claim.)

## Phasing (R9)

- **Phase 1 — Part A only.** Frontmatter flag, guardrail gate swap, audit
  stamp, A3 clause in batch templates. Small server diff, no new UI, no new
  contracts.
- **Phase-1 measurement (made concrete in round 2 — the go/no-go must be
  computable, not a hand count):**
  - *Join:* each gate-release input / delivery-ask `needs_input` finding is
    attributed to its task's `deliveryAuthorization` stamp, partitioning the
    residual into **ask-first** (legitimate gate traffic), **pre-authorized
    but asked anyway** (prompt non-compliance — a Part-A bug, not Part-B
    evidence), and **unmigrated** (no stamp — playbook not yet flagged).
  - *Denominator:* record migration coverage (fraction of batch launches
    carrying the flag); a small residual with low coverage means "migrate
    more playbooks", not "Part A worked".
  - *Classifier:* concretely, a log query — filter `needs_input` findings
    whose question matches the gate sentence / push-PR intent, joined to
    the owning task's stamp — not a new pipeline (round-3 minimalist: a
    hand-verifiable grep over the interaction log is sufficient and
    faster). This stays a reflection-loop measurement — a semi-automated
    judgment with a deterministic join, honestly not a threshold metric.
  - *Decision rule:* Phase 2 ships only on meaningful **ask-first**
    residual.
- **Phase 2 — Part B,** gated as above. If Part A absorbed ~all of it, Part
  B's machinery (kind, CLI verb, WS message, button, source tag) is never
  built — that is a success, not a failure of this RFC.

## Files to change

Phase 1:

| File | Change |
|------|--------|
| `src/core/playbook.ts` | optional `deliveryPreAuthorized` on the `Playbook` interface (lands first) |
| `src/core/playbook-parser.ts` | parse `deliveryPreAuthorized` frontmatter (lands with the interface) |
| `src/server/worktree-guardrails.ts` | gate-sentence variant via a `DeliveryPolicy` param; sentinel phrases retained; escape hatch text |
| playbook launch use-case | resolve flag → `DeliveryPolicy` (server-internal, **not** `LaunchOpts`); stamp `deliveryAuthorization` on task |
| `src/shared/contracts/task.ts` | `deliveryAuthorization` union type + optional field on the task entity |
| `src/core/prompt-display.ts` | `WORKTREE_GUARDRAIL_PREFIX_RE` learns the pre-authorized variant |
| `plugin/playbooks/*` batch templates | `deliveryPreAuthorized: true`; A3 clause |
| tests | guardrail variants (fixtures pinning the current sentence: launch-service, snapshot-projection), no-double-guard idempotency, parser, stamp, display stripping |

Phase 2:

| File | Change |
|------|--------|
| `src/shared/contracts/agent-signal.ts` | `'delivery_ready'` kind + guard + KINDS array |
| `src/server/routes/task-routes.ts` | accept new kind on `POST /api/tasks/:id/signal` (validates via contract) |
| `bin/kookr` signal subcommand | accept `delivery-ready` (validates via `AGENT_SIGNAL_KINDS`) |
| `src/shared/contracts/agent-signal.ts` (or co-located actions module) | canned-text-per-kind map (single authority for WS/REST/CLI accept paths) |
| WS contract + handler | `acceptAgentSignal` message: await delivery, clear signal only on acceptance; log signal overwrites |
| `src/shared/contracts/user-input-delivery.ts` | add `'signal_action'` source; extend `DELIVERY_SOURCE_LABEL` (shared with relay RFC) |
| `src/core/interaction-log.ts` | `source` on `user_input` events (shared with relay RFC; coordinate landing order) |
| `src/frontend/components/DetailPanel.tsx` | delivery_ready gate + button + disable-on-dead-session (button renders only after handler ships) |
| `src/frontend/components/ActivityPanel.tsx` | source-aware label from the shared map — shared with relay RFC |
| guardrail text | B2 sentence for ask-first tasks |
| tests | kind round-trip, accept atomicity (deliver + clear), render predicate, ordering invariant |

## Edge cases

- **Agent signals `delivery_ready` with a dirty worktree.** The note is
  advisory; the accept action sends text, not a state assertion. R7 makes
  the agent re-validate on resume — same trust model as a typed "yes".
- **Click after session death.** Button disables on the shared liveness
  predicate; a race lands in the existing `failed` delivery status, visible
  in the activity feed.
- **Pre-authorized task that still signals.** Shouldn't happen (its gate
  text says don't ask), but harmless: the button works the same.
- **`delivery_ready` then agent keeps working.** The render gate
  (`turnState === 'completed_turn'`) holds the button until the turn ends.
- **Canned-text ambiguity.** The accept text names its own provenance, and
  the `'signal_action'` source makes it machine-distinguishable in the
  interaction log (now that `user_input` events carry `source`).
- **Wrong playbook gets pre-authorized.** The flag is per-playbook
  frontmatter, reviewed like any template change; only templates whose
  deliverable is already "a PR for human review" should set it. The escape
  hatch (R3) bounds the damage when an agent's work is bad — the measured
  window included a wholesale rejection ("no everything is bad…") that
  auto-push would have turned into PR noise.
- **Sibling fan-out (R8).** A3 reduces it at the source. The existing
  `respondAll` WS message covers the residual case for *blocked* agents
  (pre-signal model). Under the Part-B signal model, multiple sibling
  `delivery_ready` signals have no batch-accept affordance in v1 — batch
  tasks should be pre-authorized (Part A) precisely so this population
  doesn't exist; a batch-accept button is future work if it does.

## Alternatives considered

- **Always auto-push (drop the gate everywhere).** Rejected: interactive
  tasks are exploratory; the window's evidence includes a wholesale
  rejection where auto-push would have created PR noise. The gate has value;
  its cost was the problem.
- **Prompt-only grant in playbook bodies (v1 draft, A1/A2 as text +
  launch-form parameter).** Falsified by the evidence the RFC itself cites:
  playbook bodies already declare PR delivery and lose to the server-appended
  gate. Adding more prose adds a third competing instruction; the robust fix
  is changing what the server appends. The launch-form parameter was cut
  (no per-launch override evidence) in favor of frontmatter + audit stamp.
- **Auto-merge (`gh pr merge --auto`) for pre-authorized batches.** Raised
  in review (the window includes `"ok create a PR and merge it"`). GitHub's
  auto-merge is only a gate when branch protections enforce review/CI; the
  target personal repos largely lack those protections, so `--auto` would
  merge unreviewed code immediately. Revisit if/when branch protections are
  configured; not a v1 risk worth taking.
- **Extend `extractQuickActions()` regexes** to detect "push and open PR?"
  questions and render a quick button. Cheaper, but the agent still blocks
  in `waiting_for_input`, detection is regex-over-prose fragile, and
  `response-assist.ts` deliberately avoids false-positive-prone pattern
  families. Remains a complementary fallback for agents that ask anyway.
- **Reuse `completion_ready` "one step earlier" instead of a new kind.**
  Rejected: the two signals answer different questions ("may I deliver?" vs
  "is this task done?") with different accept actions (send authorization
  text vs complete the task). Collapsing them would make the Complete button
  push code — a lifecycle mutation the signal surface explicitly forbids
  signals from causing.
- **A structured `deliveryRequest` entity** (branch, commit list, diffstat)
  instead of a signal note. Over-modeled for v1; the note + diff pane covers
  the review need. Revisit if notes prove insufficient (see O3).

## Open questions

- **O1:** Should accepting `delivery_ready` chain "…and signal
  completion-ready when the PR is open" into the canned text? Leaning no
  (the guardrail contract already says this), but batch evidence may
  justify it.
- **O2:** Per-project pre-authorization defaults — wait for evidence that
  per-playbook frontmatter is insufficient.
- **O3:** Inline diff summary (files changed, +/-) on the accept button
  tooltip/popover, so the "glance" the gate exists for happens at the
  decision moment without a click. Deferred to keep Phase 2 small; strong
  candidate for the first Part-B iteration if users click blind.

## Critic feedback incorporated

Round 1 (2026-06-10) — failure-mode-analyst, design-minimalist,
ambition-amplifier, socratic-challenger, operability-reviewer:

- **failure-mode-analyst:** `respond` doesn't clear pending signals →
  atomic `acceptAgentSignal` (B3); `completion_ready` render predicate is
  `needs_input`-entangled and doesn't transfer → explicit delivery_ready
  gate (B4); signal-ordering race → explicit invariant + agent-side rule
  (B6); pre-authorization escape hatch (R3); push-permission posture
  promoted from edge case to prerequisite.
- **socratic-challenger:** identified that the gate text is server-appended
  (`worktree-guardrails.ts`) and that playbook prose demonstrably loses to
  it → Part A redesigned from prompt-text to frontmatter flag + server-side
  gate swap; challenged the 68-minute framing (human absence vs mechanics)
  → honest re-framing + Phase-1-first measurement plan (R9); file table
  corrected (guardrails + pinned fixtures).
- **design-minimalist:** launch-form `deliveryAuthorization` parameter cut
  (YAGNI) — superseded by frontmatter flag; `acceptAgentSignal` as one
  atomic message rather than respond+dismiss two-step; banner "mirror"
  acknowledged as a behavior fork and documented (B4); CLI validates kinds
  against `AGENT_SIGNAL_KINDS` (one source of truth).
- **ambition-amplifier:** auto-merge proposal evaluated and rejected with a
  concrete reason (target repos lack branch protections, so `--auto` is a
  bypass, not a gate) — recorded in Alternatives; inline diff-at-decision
  pushed → O3.
- **Adversarial pair resolution (required):** ambition-amplifier wanted
  auto-merge and a mandatory diff surface; design-minimalist wanted less
  machinery throughout — we sided with the minimalist on both v1 scopes
  (no auto-merge, diff stays one click away) because the safety case
  (unprotected repos) and the phasing rule (R9) bound the downside, while
  recording O3 as the trigger to revisit.
- **operability-reviewer:** audit gap closed via the
  `deliveryAuthorization` task stamp (R2/A2); `'signal_action'` source +
  interaction-log `source` field + ActivityPanel label so one-click
  authorizations are auditable offline; dead-session button behavior
  specified (B4).
Round 2 (2026-06-10) — failure-mode-analyst, boundary-critic,
delivery-pragmatist:

- **failure-mode-analyst:** freeze-at-launch semantics stated (variant
  survives relaunch via the stored prompt, verified against crash-recovery);
  sentinel-compatibility constraint on the replacement text (prevents
  double-guarding); `acceptAgentSignal` failure ordering pinned to
  deliver-first/clear-on-acceptance with the dead-session race specified;
  background-task vs `completed_turn` render gap documented in B4/B2;
  signal-overwrite logging added (B6); Phase-1 measurement made attributable
  (join on the `deliveryAuthorization` stamp, coverage denominator,
  ask-first decision rule).
- **boundary-critic:** `deliveryPreAuthorized` kept out of the shared
  `LaunchOpts` contract (frontend/CLI must not synthesize pre-authorization)
  — resolved in the playbook launch use-case as a server-internal
  `DeliveryPolicy` param; canned-text map moved to the signal contract
  module; `deliveryAuthorization` union declared in
  `src/shared/contracts/task.ts`; shared `DELIVERY_SOURCE_LABEL` map with
  the relay RFC.
- **delivery-pragmatist:** `src/core/prompt-display.ts`
  (`WORKTREE_GUARDRAIL_PREFIX_RE`) added to the file table — silent display
  regression otherwise; parser-first merge order prescribed
  (`playbook.ts` interface → parser → launch threading); Phase-2 gate
  reframed honestly as a semi-automated reflection-loop judgment with a
  deterministic join rather than a fictional threshold metric.

Round 3 (2026-06-10) — failure-mode-analyst, design-minimalist: both
**CONVERGED**. Polish applied: Phase-1 classifier stated plainly as a log
query, not a pipeline. The minimalist proposed inlining the two-entry
`DELIVERY_SOURCE_LABEL` map; kept as a shared map because the two sources
land in two separate PRs from two RFCs — the coordination concern is
present-tense, not future-proofing (disagreement noted, author's call).
- ambition-amplifier 2026-06-10: novel findings (auto-merge gap,
  diff-at-decision).
- assumption-archaeologist: not invoked — no ADR-justified behavior is being
  changed.
