# Auto-Close on Completion Signal

`autoCloseOnSignal` is a per-task policy that makes a task **complete itself**
the moment its agent raises a `completion_ready` signal — instead of staying open
until a human reviews it and clicks **Complete**.

## Why it exists

Kookr caps the number of concurrently running tasks (`MAX_ACTIVE_TASKS`, default
`10`). A task counts against that cap while its launch is in flight (a short-lived reservation) and for as long as it is `inProgress` — which
includes the window *after* the agent has finished its work but before anyone has
manually completed it. In automated, long-running workflows (self-continuation
chains, batch issue implementation), finished-but-unreviewed tasks accumulate and
eventually fill every slot, so newly launched tasks are queued (`pending`) and
the chain stalls.

`autoCloseOnSignal` removes the human step from that path: the agent declares
"done," and Kookr immediately completes the task and promotes the next queued one.

## The completion signal

The signal itself is the existing agent → user channel (see
[CLI: `kookr signal`](./cli.md)):

```bash
kookr signal completion-ready --note "PR #123 merged"
```

- **Without** `autoCloseOnSignal`: the signal only *surfaces* — the dashboard
  shows a banner and emphasizes the **Complete** button. The task stays open; the
  user decides. This is the default, unchanged behavior.
- **With** `autoCloseOnSignal`: the same signal **completes the task
  immediately**, runs the normal completion lifecycle (stops sessions, cleans up
  worktrees, generates the completion digest), and promotes the next pending task.

> **Signal only when work is truly finished.** Under `autoCloseOnSignal` the
> signal closes the task right away, so signalling mid-work aborts it. The Stop
> nudge hook already reminds agents to signal only when the task is fully
> complete.

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
  ends the **current iteration** (the loop owns the task-level lifecycle and
  decides whether to continue) rather than completing the whole task. This matches
  the existing manual-complete semantics for Ralph tasks. Ralph playbooks should
  write a Phase 9 verdict, not rely on the signal.
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
