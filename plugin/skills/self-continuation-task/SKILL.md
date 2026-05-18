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
related: github-issue-workflow, task-checkpointing, pr-review-triage
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
- Each unit can be selected from durable state such as GitHub, a JSON file, a
  database row, or a checkpoint directory.
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
- Checkpoint directory: `CHECKPOINT.json` for long-running branch state.
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
- Done check: issue closed, or an open PR whose closing issue references include
  the issue.
- In-progress check: existing branch/PR for the issue.
- Successor cursor: include the next issue number and a remaining issue list or
  count, for example `Next issue: #110; remaining issues: #110, #111, #112`.
- Failure cap: durable per-issue attempt count only when there is no stronger
  completion signal.

Avoid dependent issues in one chain unless the completion check verifies that
the dependency has actually merged. Open PRs on separate branches do not make
their changes visible to later worktrees based on `main`.

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
