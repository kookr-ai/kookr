# Auto-Close on Completion Signal

`autoCloseOnSignal` is a per-task policy that makes a task **complete itself**
after its agent's `completion_ready` signal has been pending for a configurable
delay (**default 30 minutes**) — instead of staying open indefinitely until a
human clicks **Complete**.

The delay is the **Auto-close delay** setting (Settings → General,
`autoCloseCompletionReadyDelayMin`, range 1–1440 minutes). The liveness sweeper
reads it live, so a change takes effect on the next tick without a restart. It
governs only the auto-close grace window; the manual-review banner for
non-opted-in tasks is unaffected.

## TTL escalation for non-opted-in tasks (issue #1526)

Tasks that did **not** opt in (`autoCloseOnSignal` unset/false — including
`ask-first` delivery) used to hold their concurrency slot indefinitely once
`completion_ready` was pending: the sweep's close policy required
`autoCloseOnSignal === true`, so nothing ever released them without a human.
The 2026-07-24 incident wedged all 12 slots exactly this way.

They now have a bounded lifetime too: when a pending `completion_ready` signal
is older than the **Completion-ready TTL** setting
(`completionReadyTtlMinutes`, default 120, range 5–10080), the sweep completes
the task anyway — regardless of delivery authorization — with
`closeReason: 'ttl_escalation'`. Each TTL escalation (unlike an opted-in close)
writes an `audit.jsonl` row (actor `system:completion-ready-ttl`) and
broadcasts an info alert.

The two thresholds are gated independently: opted-in tasks close after the
Auto-close delay only, and a TTL set below that delay does not accelerate them.

The sweep drains gently: at most 2 auto-closes per batch, at most one batch per
60 seconds — so a backlog of finished tasks releases its slots over minutes
rather than tearing down every session at once.

## Delivery-aware auto-completion (issue #1560)

Autonomous implement-tasks routinely **deliver** — open and merge their PR —
and then hang for hours in the post-merge tail: the branch-delete push triggers
the heavy pre-push gate, CI-rerun loops run unbounded, or the agent waits on
input nobody will give. These tasks had `autoCloseOnSignal` but never raised a
`completion_ready` signal, so nothing closed them until the hung-task reaper
eventually recorded `terminated` — masking a successful delivery as failure
(umbrella #1545; prod tasks faf7902b / 3a7039c5).

The liveness tick now closes that gap. For a running task that **opted into
`autoCloseOnSignal`**, whose **own PR is merged**, and which has **not** raised a
completion signal, once the **post-merge cleanup budget** is exceeded Kookr:

1. raises a `completion_ready` signal through the #1541 signal outbox (durable
   spool write, applied as `source: 'outbox'`), and
2. runs the normal completion lifecycle (`completeTask`) — stamping
   `completionPath: 'outbox_drained'` and generating a digest that **names the
   merged PR number**.

There is no parallel completion surface: the signal rides the existing outbox /
`autoCloseOnSignal` machinery and completion goes through the same `completeTask`
the auto-close sweep uses. Because a merged PR is definitive delivery evidence,
the raise is applied directly rather than through the lesson-decision-gated
outbox drain (#1608), which would otherwise drop a hung agent's signal.

**Attribution is the task's own PR.** Delivery counts only a merged PR
**discovered from the agent's own activity** — a PR the task opened during its
run. A merged PR merely **referenced in the task prompt** (e.g. a prompt "port
the fix from PR #1500") is excluded (`detectedFrom === 'prompt'`), so a live task
that mentions an already-merged PR is never force-completed.

**Only opted-in tasks.** This path fires only for tasks with
`autoCloseOnSignal` — the same population the signal path serves. An ask-first /
human-review task (no `autoCloseOnSignal`) is left to the existing
completion-ready TTL escalation instead, preserving its human-review gate.

The budget is the **Post-merge cleanup budget** setting
(`postMergeCleanupBudgetMinutes`, default **10 minutes**, range 1–120), read live
each tick. Its clock starts when the sweep first observes the merge, so a
just-delivered task always gets one full budget window of cleanup. A simulated
post-merge hang self-completes within ~15 minutes (10 min budget + polling
slack) — well before the hung-task reaper's hours-long threshold, which stays
the backstop. The sweep drains gently (≤2 completions per batch, ≥60 s between
batches), matching the completion-ready auto-close sweep.

## Why it exists

Kookr caps the number of concurrently running tasks (`MAX_ACTIVE_TASKS`, default
`10`). A task counts against that cap while its launch is in flight (a short-lived reservation) and for as long as it is `inProgress` — which
includes the window *after* the agent has finished its work but before anyone has
manually completed it. In automated, long-running workflows (self-continuation
chains, batch issue implementation), finished-but-unreviewed tasks accumulate and
eventually fill every slot, so newly launched tasks are queued (`pending`) and
the chain stalls.

`autoCloseOnSignal` bounds that human-review window: the agent declares "done,"
Kookr keeps the signal visible for the configured Auto-close delay (default 30
minutes), then completes the task and promotes the next queued one if nobody
acted first.

**Dense self-continuation chains need an immediate complete.** The auto-close
grace is a backup for interactive/human-review workflows. Chains that spawn a
successor every few minutes must free the parent slot **as soon as the child is
confirmed** — typically `POST /api/tasks/:id/complete` after
`completion-ready` — or several finished parents stay `inProgress` at once and
the active-task cap fills. See the `self-continuation-task` skill section
"Releasing the Task Slot (immediate close; auto-close is backup only)".

## The completion signal

The signal itself is the existing agent → user channel (see
[CLI: `kookr signal`](./cli.md)):

```bash
kookr signal completion-ready --note "PR #123 merged"
```

- **Without** `autoCloseOnSignal`: the signal only *surfaces* — the dashboard
  shows a banner and emphasizes the **Complete** button. The task stays open; the
  user decides. This is the default, unchanged behavior.
- **With** `autoCloseOnSignal`: the same signal starts the **auto-close grace
  period** (the configured Auto-close delay, default 30 minutes). If the task is
  still in progress after the delay, Kookr runs the normal completion lifecycle
  (stops sessions, applies the saved worktree-cleanup setting, generates the
  completion digest), and promotes the next pending task.

> **Signal only when work is truly finished.** Under `autoCloseOnSignal` the
> signal starts the close timer, so signalling mid-work can still close the task
> later if nobody intervenes. The Stop nudge hook already reminds agents to
> signal only when the task is fully complete.

## Enabling it

There are three ways to set the policy at launch. All set the same per-task
boolean, stored on the task record.

### 1. Playbook frontmatter

```yaml
---
name: Implement GitHub Issue
autoCloseOnSignal: true
---
```

Every task launched from the playbook gets the policy. This is how the bundled
**Implement GitHub Issue** playbook (`plugin/playbooks/implement-github-issue.md`)
ships it. See [Playbooks Reference](./playbooks.md).

### 2. `kookr spawn` flag

```bash
kookr spawn --auto-close-on-signal "implement issue #42, then signal completion-ready"
```

### 3. HTTP API

`POST /api/tasks` accepts an `autoCloseOnSignal` boolean in the request body. See
[API Reference](./api.md).

## Inheritance (the important part)

A task launched with `autoCloseOnSignal` **propagates the policy to any successor
spawned with its task id as `parentTaskId`** — automatically, on the server.

This matters because self-continuation chains are deliberately *memory-free*: task
N+1 starts cold and cannot read task N's transcript or arguments. Relying on the
agent to remember and re-pass a flag in every successor launch would be fragile.
Instead, inheritance reads the parent's policy from durable task state, so the
whole chain keeps the behavior with **no per-successor configuration**.

### Resolution rules

When a task is created, its effective policy is resolved as follows:

1. **Explicit value wins.** If the launch sets `autoCloseOnSignal` (to `true`
   *or* `false`), that value is used verbatim.
2. **Otherwise inherit from the parent.** If `autoCloseOnSignal` is unset and the
   task has a `parentTaskId`, it inherits the parent's policy.
3. **Otherwise off.** No explicit value and no (auto-close) parent ⇒ the policy is
   off.

Inheritance follows the **parent pointer**, which is one hop. Because each task in
a chain spawns the next with itself as parent, and each successor inherits, the
policy effectively flows down the entire chain — every link copies the resolved
value onto its own record, so a grandchild inherits from its (already-inheriting)
parent.

### Opting a successor out

To stop the policy at a specific successor, set it explicitly to `false`:

```bash
kookr spawn --no-auto-close-on-signal "..."
```

An explicit `false` is honored over the inherited `true` (rule 1). It does **not**
re-enable downstream: a successor of that opted-out task inherits `false`.

### Inheritance examples

```
A (--auto-close-on-signal)        → autoCloseOnSignal = true   (explicit)
└─ B (spawned by A, no flag)      → true                       (inherited from A)
   └─ C (spawned by B, no flag)   → true                       (inherited from B)
      └─ D (--no-auto-close...)   → false                      (explicit override)
         └─ E (spawned by D)      → false                      (inherited from D)
```

```
P (no flag, no parent)            → false
└─ Q (--auto-close-on-signal)     → true                       (explicit; parent off)
```

## Behavior details

- **Ralph loops.** A `completion_ready` signal on a task with an active Ralph loop
  is not swept by delayed auto-close; the signal stays visible for the
  Ralph-aware lifecycle path. Ralph playbooks should write a Phase 9 verdict,
  not rely on the signal.
- **Not yet in progress.** If a task somehow signals before it is `inProgress`,
  auto-close is skipped; the signal is still recorded so the manual-review banner
  appears as a fallback.
- **Failures are non-fatal.** If completion fails for any reason, the agent's
  `kookr signal` call still succeeds (the signal is recorded). The agent is never
  blamed for a server-side completion error.
- **Terminal tasks.** Signalling a task that is already terminal is rejected
  (HTTP 409), exactly as before.

## Related

- [CLI Reference](./cli.md) — `kookr spawn`, `kookr signal`
- [Playbooks Reference](./playbooks.md) — frontmatter fields
- [API Reference](./api.md) — `POST /api/tasks`, `POST /api/tasks/:id/signal`
- `plugin/skills/self-continuation-task/SKILL.md` — chain authoring guidance
