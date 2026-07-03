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
- Include this same continuation contract in the successor prompt.
- Include a uniqueness cursor in every successor prompt so Kookr's task
  deduplication does not collapse distinct iterations into one task.

The successor prompt must be self-contained. Assume task N+1 starts cold and
cannot see task N's transcript.

## Durable State

Choose one source of truth and keep it simple:

- GitHub issues/PRs: open/closed state, labels, linked PRs, comments.
- Local queue file: `queue.json`, `state.json`, or append-only `attempts.log`.
- External API: status rows, job records, or explicit claims.

Prefer positive completion evidence over attempt counters. For example, "open
PR closes issue N" is stronger than "N appears in attempts.log".

Use an attempt cap for units that can fail repeatedly. The cap should be
mechanical, stored in durable state, and checked before starting work.

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
3. If none exists, report completion and do not spawn.
4. If another unit exists, write a complete successor prompt to a temp file
   outside the repo, then launch the next Kookr task using the installation's
   supported task-creation path.

Use a prompt-file or stdin-based launch path when available. Create the prompt
file with the agent's file-write tool, not with a Bash heredoc or inline shell
string. Do not place the prompt body in shell argv: hook scanners often inspect
command lines, and continuation prompts commonly contain strings that hooks may
block.

For parent/child linkage, use whatever parent-task field the installed launcher
or API documents. If the launcher cannot express parentage, keep the durable
state sufficient for tracing the chain without transcript access.

## Releasing the Task Slot (auto-close on completion signal)

A long chain only stays healthy if each finished task actually *closes*.
Otherwise finished-but-still-open tasks accumulate against Kookr's active-task
cap (`MAX_ACTIVE_TASKS`, default 10) and eventually block the chain from
launching its successor. Two mechanisms cooperate here:

- **The completion signal.** When a task's work is genuinely done — the unit is
  complete, durable state is recorded, and (if applicable) the successor has
  been spawned — run `kookr signal completion-ready` (optionally
  `--note "..."`). This is the agent telling Kookr "this task is finished."
- **Auto-close.** If the task was launched with `autoCloseOnSignal` enabled,
  that signal schedules completion after the one-hour grace period instead of
  waiting indefinitely for a human to review and click Complete.

**Inheritance is automatic and server-side.** A task launched with
`autoCloseOnSignal` set propagates it to any successor spawned with its task id
as `parentTaskId` (the linkage you already set above). You do NOT need to pass a
flag in the successor prompt or launch command — the server reads the parent's
policy from durable task state, which is exactly the memory-free guarantee this
skill relies on. To opt a successor out of an inherited policy, launch it with
`kookr spawn --no-auto-close-on-signal`.

Only signal completion-ready when work is truly finished: under `autoCloseOnSignal`
it closes the task after the grace period without another prompt, so signalling
mid-work would still abort it later. If a task is NOT auto-close enabled, the
signal is harmless — it just surfaces a banner for manual review. See
docs/reference/auto-close-on-signal.md for the full model.

## Successor Prompt Template

Use this shape and fill in concrete paths, repo names, selection rules, caps,
and verification commands:

```markdown
You are continuing a sequential Kookr task chain.

Goal: <overall batch goal>.

Continuation contract:
- Read durable state from <source of truth>.
- Select exactly one eligible unit using <selection rule>.
- Before tracked-file edits, create a fresh git worktree and work only there.
- Complete that one unit end to end.
- Record the result in <source of truth>.
- If no eligible unit remains, stop and report completion.
- If another eligible unit remains, spawn the next Kookr task with this same
  continuation contract using a hook-safe prompt file.
- Make the successor prompt content-distinct by including the current
  uniqueness cursor from durable state.

Current source-of-truth details:
- Repo/cwd: <absolute cwd or owner/name>.
- Queue/query: <selector>.
- Continuation cursor: <next unit id, remaining eligible ids/count, source
  revision/checksum, and parent/previous task id if available>.
- Attempt cap: <N>.
- Completion evidence: <how to detect done>.
- Verification commands: <commands>.

Do not batch multiple units into this task. Do not rely on prior conversation.
```

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
their changes visible to later worktrees based on `main`.

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
- Encoding "continue until it feels done" without a mechanical stop condition.
- Selecting the next unit from conversation memory or a non-persisted TODO list.
- Letting one task work multiple issues because setup is already warm.
- Reusing a static successor prompt such as "Implement next issue" for every
  child task.
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
