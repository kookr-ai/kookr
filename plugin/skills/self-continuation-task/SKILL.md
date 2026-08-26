---
name: self-continuation-task
description: >
  Build a Ralph-like sequential Kookr task chain where each task completes one
  independent unit, records durable state, and spawns the next task with the
  same continuation contract. Use for issue batches, queue drains, staged
  migrations, or other long runs that should proceed one task at a time without
  relying on conversation memory.
keywords: >
  self continuation, continuation task, sequential task chain, spawn next task,
  issue batch, queue drain, Ralph-like, Kookr task chain, parent task, child task,
  baton pass, autonomous sequence, one issue at a time
related: github-issue-workflow, pr-review-triage
---

# Self-Continuation Task

Use this skill when a workflow should process many independent units
sequentially by having task N spawn task N+1 at the end of its run.

The reliable pattern is:

1. Read durable external state.
2. Pick exactly one eligible unit.
3. Complete that unit end to end.
4. Update durable state.
5. If more units remain, spawn a fresh Kookr task with the same contract.

This is intentionally close to the Ralph loop discipline: one runtime owns one
unit of work, then stops. The continuation comes from external state and a
fresh task prompt, not from the agent remembering prior conversation.

## Use When

- A list of issues, PR comments, repos, files, or migration steps can be worked
  one at a time.
- Each unit can be selected from durable state such as GitHub, a JSON file, or a
  database row.
- A new task can decide the next unit without needing hidden context from the
  previous task.
- Sequential execution is safer than parallel execution because branches,
  reviews, deploys, rate limits, or dependencies would collide.

Do not use this pattern when the parent must review the child result before the
next step. In that case, use an explicit parent-orchestrated
`spawn -> inspect -> decide -> spawn` workflow instead.

## Required Contract

Every task in the chain must carry these rules in its prompt:

- Work in a fresh git worktree for any tracked-file edits.
- Do one unit only.
- Use durable state, not conversation memory, to determine what has already
  happened.
- Record the outcome before spawning a successor.
- Stop without spawning when no eligible unit remains or a configured cap is
  reached.
- After a confirmed successor spawn (or a deliberate no-successor stop),
  **release this task's slot immediately** — do not leave the parent
  `inProgress` while the child runs (see Releasing the Task Slot).
- Include a uniqueness cursor in every successor prompt so Kookr's task
  deduplication does not collapse distinct iterations into one task.

The successor prompt must be self-contained *for state*, not for prose: assume
task N+1 starts cold and cannot see task N's transcript, but do NOT re-embed the
invariant rules above. Those live here in the skill. The successor carries only a
compact, versioned **continuation envelope** — stable parameters plus a durable
cursor — and re-derives everything else from durable state at start. See
[Compact Continuation Envelope](#compact-continuation-envelope).

## Durable State

Choose one source of truth and keep it simple:

- GitHub issues/PRs: open/closed state, labels, linked PRs, comments.
- Local queue file: `queue.json`, `state.json`, or append-only `attempts.log`.
- External API: status rows, job records, or explicit claims.

Prefer positive completion evidence over attempt counters. For example, "open
PR closes issue N" is stronger than "N appears in attempts.log".

Use an attempt cap for units that can fail repeatedly. The cap should be
mechanical, stored in durable state, and checked before starting work.

## Compact Continuation Envelope

Do not hand the successor a narrative essay — repository policy, prior PR
details, issue scans, CI behaviour, and continuation history re-pasted verbatim.
That prose is pure repeated input cost across the chain and drifts stale the
moment durable state moves. Analysis of real chains found the same handoff
paragraphs copied into successor after successor with only the unit id changing.

Instead, every successor carries a **compact, versioned continuation envelope**:
only the *stable* parameters (overall goal, authorization toggles) plus a durable
**cursor** (repo, selector, parent task/PR/issue, next-unit pointer, remaining
units, source revision, attempt cap). The invariant safety rules stay in this
skill; the successor references them rather than re-inlining them.

The helper `src/core/continuation-envelope.ts` codifies this shape and the
successor-start logic:

- `ContinuationEnvelope` — the versioned envelope (goal + cursor + parent +
  authorization toggles).
- `resolveContinuationState(envelope, resolver)` — at successor start, re-derives
  the *current* GitHub/task state from durable sources through an injected
  resolver. A stale cursor (the next unit already done, in-flight, blocked, or
  vanished) self-heals to the next eligible unit; missing parent state is flagged
  but does not stop the chain.
- `advanceEnvelope(current, resolved, parent?)` — builds the next envelope after a
  unit completes. **Authorization toggles are copied verbatim** so delivery and
  safety grants survive continuation exactly — they are never re-derived.
- `continuationCursorKey` / `areContinuationsDistinct` — the content-distinct
  signal that keeps successive iterations from being deduplicated into one task.
  Never spawn a successor whose cursor did not change. (Content-distinctness is
  the dedup guard; the per-unit `attemptCap` is what stops re-working the *same*
  unit after a failed attempt.)
- `renderContinuationPrompt(envelope)` — the bounded successor prompt (remaining
  units capped, invariant rules referenced not inlined).
- `parseContinuationEnvelope(raw)` — validate an envelope read back from durable
  state; rejects an unknown version or a malformed cursor and drops non-boolean
  authorization values, so a corrupt handoff fails loudly.

The pointer in the cursor (`nextUnit`) is **advisory**. The successor always
revalidates it against durable state before acting, so a chain that raced with
another workstream recovers instead of working an already-finished unit.

## Successor Prompt Uniqueness

Kookr intentionally deduplicates task launches whose prompt content matches an
already-known task. A self-continuation chain must therefore make every
successor prompt content-distinct while still deriving behavior from durable
state.

Before spawning, re-read the source of truth and write a successor prompt that
contains a concrete uniqueness cursor from that fresh state. Good cursors
include:

- Next unit ID: `Next unit: issue #109`.
- Remaining queue snapshot: `Remaining eligible units: #109, #110, #111`.
- Queue progress: `Completed count: 8; remaining count: 12`.
- Source revision: Git SHA, queue file checksum, database row version, or API
  cursor/ETag.
- Parent/previous task ID when available, as supporting trace data.

The cursor should change after each completed unit. Prefer state-derived
content over a timestamp because it documents why this child is distinct and
lets the next task verify the same state independently. A timestamp or UUID may
be added as a last-resort launch nonce only when the durable source does not
offer a stable cursor, but it must not replace the real selection rule.

Do not spawn if the prompt you are about to write would have the same cursor as
the current task's prompt. That means the source of truth did not advance, the
next unit is already claimed, or the completion/blocker was not recorded
durably enough.

## Handoff Procedure

At the end of the current unit:

1. Verify the unit is complete enough to hand off:
   - tests/checks run or an explicit blocker recorded;
   - PR/issue/comment/status updated if applicable;
   - local state file updated atomically if one is used.
2. Re-read the queue/source of truth and decide whether another eligible unit
   exists.
3. If none exists, release this task's slot (see below) and do not spawn.
4. If another unit exists, write a complete successor prompt to a temp file
   outside the repo, then launch the next Kookr task using the installation's
   supported task-creation path **with this task's id as `parentTaskId`**.
5. **Immediately release this task's slot** after a confirmed successor spawn
   (or after a no-successor stop). Do not leave the parent `inProgress` while
   the child runs — that is how chains burn through `MAX_ACTIVE_TASKS`.

Use a prompt-file or stdin-based launch path when available. Create the prompt
file with the agent's file-write tool, not with a Bash heredoc or inline shell
string. Do not place the prompt body in shell argv: hook scanners often inspect
command lines, and continuation prompts commonly contain strings that hooks may
block.

For a self-advancing chain, the successor launch must preserve the delivery
policy through a playbook wrapper parsed by Kookr, or an equivalent trusted
server path. Do not use a generic spawn: it does not carry the chain-specific
contract to merge this phase and launch the next one. The architecture-refactor
chain uses this exact shape after writing the next phase prompt file:

```bash
kookr spawn -C "$REPO_DIR" --prompt-file "$NEXT_PHASE_PROMPT_FILE" \
  --playbook architecture-refactor-phase.md --playbook-scope plugin \
  --idempotency-key "chain:${REPO_KEY}:${UMBRELLA_NUMBER}:phase:${NEXT_PHASE_ID}" \
  --parent-task-id "$KOOKR_TASK_ID" --unattended --json
```

`REPO_KEY` is the validated `owner/name`, lowercased. Repository qualification
prevents two chains with the same umbrella issue number from colliding in
Kookr's shared idempotency ledger.

For parent/child linkage, use whatever parent-task field the installed launcher
or API documents. If the launcher cannot express parentage, keep the durable
state sufficient for tracing the chain without transcript access.

## Releasing the Task Slot (immediate close; auto-close is backup only)

A long chain only stays healthy if each finished task actually *closes*.
Otherwise finished-but-still-open tasks accumulate against Kookr's active-task
cap (`MAX_ACTIVE_TASKS`, default 10) and eventually block the chain from
launching its successor.

**Primary path — free the slot now.** When the unit is done and durable state is
recorded (and the successor has been spawned when continuing), close *this*
task immediately. Prefer this order:

1. `kookr signal completion-ready --note "successor <id> spawned"` (or a
   no-successor stop note) so the dashboard shows the done signal.
2. **Immediately** complete the task so it leaves the active set:

   ```bash
   API="${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}"
   curl -sS -X POST "$API/api/tasks/${KOOKR_TASK_ID}/complete"
   ```

   `POST /api/tasks/:id/complete` is the documented, non-destructive terminal
   transition for finished work (history preserved; sessions torn down). It is
   the correct handoff for a self-continuation parent that has already spawned
   its child. Do **not** wait for the one-hour auto-close grace.

**Backup path — auto-close on signal.** If the task was launched with
`autoCloseOnSignal` and something prevents the immediate `POST .../complete`
(missing `KOOKR_TASK_ID`, transient API error after retries), the
`completion-ready` signal still schedules completion after the one-hour grace
period. That grace is a safety net for human review of interactive tasks — it
is **not** fast enough for dense chains that spawn every few minutes. Relying
on grace alone is how four parent tasks pile up while only one child should be
live.

**Inheritance is automatic and server-side.** A task launched with
`autoCloseOnSignal` set propagates it to any successor spawned with its task id
as `parentTaskId` (the linkage you already set above). You do NOT need to pass a
flag in the successor prompt or launch command — the server reads the parent's
policy from durable task state, which is exactly the memory-free guarantee this
skill relies on. To opt a successor out of an inherited policy, launch it with
`kookr spawn --no-auto-close-on-signal`.

Only signal completion-ready / complete when work is truly finished. Signalling
or completing mid-unit aborts remaining work. If a task is NOT auto-close
enabled and you cannot `POST .../complete`, the signal still surfaces a banner
for manual review. See docs/reference/auto-close-on-signal.md for the full
model.

## Successor Prompt Template

The successor prompt is the rendered continuation envelope — a bounded block, not
a re-pasted narrative. Fill the cursor from fresh durable state; leave the
invariant rules to this skill. `renderContinuationPrompt` in
`src/core/continuation-envelope.ts` produces this shape:

```markdown
You are continuing a sequential Kookr task chain (continuation envelope v1).

Goal: <overall batch goal>

Follow the self-continuation-task skill for all invariant rules
(fresh worktree, one unit only, durable-state selection, record-before-spawn,
immediate parent close after spawn, end-of-chain sweep). Do not re-derive them here.

Cursor:
- repo: <owner/name>
- selector: <stable query, e.g. gh issue list ...>
- next unit: <advisory next unit id>
- remaining eligible: <capped id list>
- source revision: <SHA/checksum/ETag>
- attempt cap: <N>

Parent: task <id>, PR <url>, issue <#N>

Authorization (preserve exactly in any successor):
- <toggle>: <true|false>

Revalidate the cursor against durable state before acting; if the next unit is
no longer eligible, recover the next eligible unit from the selector.
```

Do not batch multiple units into this task. Do not rely on prior conversation.
The authorization block carries forward unchanged in every successor — never
re-derive or drop it. Anything not in the envelope must be re-derived from
durable state, not remembered from a prior task's prompt.

## GitHub Issue Chain Pattern

For issue batches, the next task should derive state from GitHub rather than
from the previous task's memory:

- Candidate set: explicit issue list or a stable `gh issue list` query.
- Done check: issue closed, OR an open PR whose closing issue references
  include the issue, OR (drift signal) a recently-merged PR on a branch
  matching the unit's namespace (e.g. `*<issue-number>*`, `*<slug>*`) — see
  End-of-Chain Sweep for why the drift signal matters.
- In-progress check: existing branch/PR for the issue.
- Successor cursor: include the next issue number and a remaining issue list or
  count, for example `Next issue: #110; remaining issues: #110, #111, #112`.
- Failure cap: durable per-issue attempt count only when there is no stronger
  completion signal.
- Blocker marking: when a task records a blocker on its issue (e.g. dependency
  not yet merged), make the marker discoverable to other workstreams that may
  pick the issue up independently. Post a sticky comment such as
  `tracked-by: chain-task <task-id>; blocked-on: <#dep>; resume when: <#dep>
  is merged`, OR apply a `chain-blocked` label. Without a discoverable marker,
  a parallel workstream may pick the issue up, merge a fix that forgets the
  `Closes #N` keyword, and leave the issue stale-open while the chain assumes
  it is still pending — the failure mode the End-of-Chain Sweep catches.

Avoid dependent issues in one chain unless the completion check verifies that
the dependency has actually merged. Open PRs on separate branches do not make
their changes visible to later worktrees based on `main`. For **dependent-phase
chains** (each phase's prerequisite is the previous phase merged to `main`), do
not rely on this prose warning alone — it did not prevent the reproduced
deadlock. Use the mechanism that now enforces it: the **self-advancing phase
contract** below.

## Self-Advancing Phase Chains (dependent-phase decomposition)

A plain self-continuation chain deadlocks the moment one unit depends on a
previous unit having **merged**: phase P1 opens its PR and completes, releasing
its slot; the PR merges later; nothing is watching to spawn P2. The chain freezes
at the first merge boundary even though every remaining phase is fully specified
(reproduced live on a `lucy#3272` decomposition). A prose "avoid dependent chains" warning
does not prevent this — the deadlock happened anyway.

The **self-advancing** delivery mode closes the gap mechanically by making the
merge and the next-phase spawn two steps of **one synchronous task run**, so
there is no "PR merges later, nothing watching" gap. A phase launched under this
mode (playbook frontmatter `deliveryMode: self-advancing`, threaded to the
`worktree-guardrails` delivery preamble as the `self-advancing` `DeliveryPolicy`
value) runs the extended contract:

```
implement in a fresh worktree
  → local gate green
  → INDEPENDENT review verdict (distinct task-id, verified against the registry)
  → self-merge (wrapper-only)
  → record PR# + tick the umbrella issue
  → spawn the next phase
  → release this task's slot
```

Eligibility and satisfaction are decided by the single pure function
`src/core/phase-ledger.ts::nextEligiblePhase(...)`:

- **Strict-sequential:** selection stops at the first phase that is not
  merge-reachable, regardless of any later phase's dependency. The chain is a
  simple ordered list, not a DAG.
- **Satisfaction = PR-merge reachability against a freshly-fetched base**, keyed
  to the phase's **recorded PR number** — never bare file existence. A
  move-and-reexport facade leaves the moved file present after a revert, and an
  unrelated PR can create the same path; either would falsely satisfy a phase.
  Recording the PR number at branch-open lets a task that crashed between merge
  and ledger-tick recover by re-querying that exact PR.
- A previously-merged phase that becomes unreachable (its merge was **reverted**)
  flips back to blocked and halts everything downstream.

`resolveContinuationState` distinguishes **blocked — dependency unmerged** from
**chain complete** via its `outcome` field (`eligible` / `blocked` / `complete`).
A blocked outcome means *wait*, not *stop*: do not treat "no eligible unit" as
the end of the chain when a unit is blocked on an unmerged dependency.

### Merge safety (why this is not "grant every task merge authority")

Self-merge is opt-in, namespace-bound, and rate-capped — never a blanket grant.
The gates (pure predicates in `src/server/self-advancing-authority.ts`, verified
**at merge time**, not merely carried):

- **Grant verification:** the PR head branch must match the chain namespace AND
  the umbrella issue must carry the chain marker. A stray `self-advancing` policy
  value on an unrelated child authorizes nothing.
- **Independent review is unforgeable and unskippable:** the verdict must come
  from a task whose task-id differs from the implementer's lineage (verified
  against the task registry). The **merge wrapper is the only merge path** (any
  non-lucy fallback routes through it, never raw `gh pr merge`). Re-review
  attempts use the shared default cap of 10 (or a deliberate lower configured
  cap) then hard-block to a human. "Reviewer failed to run"
  (retry/alert) is distinguished from "reviewer returned BLOCK" (stop).
- **Circuit breaker:** a per-chain cap of N self-merges per hour.
- **Global kill switch:** the env flag `KOOKR_SELF_ADVANCING_DISABLED` halts all
  self-advancing merges and spawns regardless of any issue's content. When set,
  the delivery preamble degrades to an open-PR gate and an operator advances the
  chain manually.

If the local gate is red or the review returns BLOCK, record a discoverable
blocker on the umbrella issue and STOP — never force-merge.

This variant is **additive and opt-in**: a chain without `deliveryMode:
self-advancing` behaves exactly as before.

## End-of-Chain Sweep

When the chain stops — because no eligible unit remains, an attempt cap is
hit, or a hard blocker was recorded — the terminating task SHOULD perform a
final reconciliation pass before exiting:

1. Re-derive the full unit list from the source of truth.
2. For each unit, check BOTH the primary done-signal (issue closed, queue row
   complete) AND the secondary "work shipped but signal missing" drift signal
   (a merged PR on the unit's branch namespace, a status row updated
   out-of-band, an issue comment from a non-chain workstream claiming
   completion).
3. Emit a one-line-per-unit status summary — as a comment on a tracking issue,
   as stdout, or as a row in durable state — labelling each unit as:
   `done` / `in-flight` / `blocked` / `stale-open-but-shipped` / `pending`.

The sweep catches a common failure: another workstream completes a chain unit
but uses a different completion convention (e.g. merges a PR without the
`Closes #N` keyword). The primary done-check misses it; the sweep surfaces it
as a drift report so a human can close the gap manually.

Keep the sweep read-only and cheap — no new work, no PR changes, just a final
scan and a short summary. If the sweep finds drift, do NOT silently
"fix" it; report it and let a human decide. Silent reconciliation hides bugs
in the chain's completion-detection logic.

## Anti-Patterns

- Spawning the next task before the current unit has durable evidence.
- Spawning a successor and leaving this parent `inProgress` (or only signalling
  completion-ready and waiting the one-hour auto-close grace). That stacks N
  live parents behind one tip and hits `MAX_ACTIVE_TASKS`.
- Encoding "continue until it feels done" without a mechanical stop condition.
- Selecting the next unit from conversation memory or a non-persisted TODO list.
- Letting one task work multiple issues because setup is already warm.
- Reusing a static successor prompt such as "Implement next issue" for every
  child task.
- Re-pasting the full narrative handoff (repo policy, prior PR details, CI
  behaviour, continuation history) into every successor instead of a compact
  versioned envelope with a durable cursor.
- Re-deriving or dropping authorization/delivery toggles between tasks. They must
  carry forward verbatim via the envelope.
- Using only a timestamp to bypass deduplication when a durable queue cursor is
  available.
- Using inline `kookr-spawn "long prompt..."` from inside agent sessions.
- Continuing when tests fail and the blocker has not been recorded.
- Recording a blocker on an issue without a discoverable marker (label, sticky
  comment, status tag) that parallel workstreams can see — they may complete
  the issue under a different convention and leave it stale-open.
- Ending the chain without a reconciliation sweep that cross-checks primary
  done-signals against secondary "work shipped but signal missing" signals.
- Silently "fixing" drift the sweep finds. Surface it; let a human decide.
