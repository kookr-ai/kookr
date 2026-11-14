# Playbook chains

A **playbook chain** runs one playbook several times in a row — "run the
research playbook 6 times" or "keep running it for 8 hours" — with Kookr, not
the agent, responsible for starting each next run. Every run (an *iteration*)
is an ordinary task with its own worktree, PR, cost and card, linked to the
previous one through `parentTaskId`. Design: [RFC](../rfc/rfc-playbook-chains.md).

This replaces the self-continuation pattern for the simple case of repeating
the same playbook. With self-continuation the agent must remember, at the end
of a long run, to spawn its successor; when it forgets, the chain stops. A
chain does not depend on anything the agent remembers.

## Starting a chain

- **Dashboard:** in the Playbooks tab, pick a playbook and fill in the
  **Repeat** row — *Iterations*, *For hours*, or both. Leave both empty for a
  normal single run.
- **CLI:** `kookr chain start agentic-capability-research.md -C ~/git/local-research-agent --hours 6`
  (see [cli.md](cli.md#kookr-chain)).
- **HTTP:** `POST /api/playbook-chains` (see [api.md](api.md)).

Limits: up to 200 iterations, up to 7 days. When both are given, the first
limit reached ends the chain. A chain bounded only by time stops after 50
iterations at most.

## What happens between iterations

Every 15 seconds the chain service looks at each chain's newest task:

- **Still running:** nothing happens. The time limit never kills a running
  iteration; it only prevents the next one.
- **Finished:** the service checks, in order: a stop request, the iteration
  count, the time limit, the 50-iteration ceiling for time-only chains, and the
  runaway breaker. If none applies, it launches the next iteration with the
  same playbook, parameters, working directory and agent. The playbook file is
  re-read, so edits apply from the next iteration.

An iteration finishes when its task reaches a terminal status, however that
happens: the agent completes the task, the operator completes it, or restart
recovery closes it. When the agent raises `completion-ready`, the chain service
closes the task itself at the first sweep where the signal is at least 30
seconds old and the agent's turn has ended (and in any case once the signal is
10 minutes old), without waiting for Kookr's usual review window or an open PR.

If the server's startup recovery fails, chains stay on hold (nothing new is
launched) until the next clean restart, so a task recovery should have resumed
is never skipped.

**Idle backstop.** If the agent simply stops without closing its task — it
finished but forgot, or it is waiting for an answer nobody will give — the
service closes it after it has been idle at its prompt for 5 minutes with
nothing of its own still running (no background shells or crons, no
outstanding subagents, provider not paused, no `AskUserQuestion` open). This is
a normal way for an iteration to end; it only counts as unhealthy when the agent
stalled within 2 minutes of starting.

Chain tasks are also launched `unattended`, so interactive tools fail fast
instead of waiting all night.

## What the agent sees

Each iteration's prompt starts with a short notice: its position, the limits,
an instruction **not** to spawn a successor itself, and how to end the chain
early (`kookr chain stop --reason "..."`). The notice is informational: the
chain continues even if the agent ignores it.

## Stopping

- **Stop chain** button on the chain's current task, or
  `kookr chain stop [<taskId>]`: the current iteration finishes, then no more
  are launched.
- Cancelling the current task ends the chain immediately
  (`iteration cancelled`).
- The chain's current task cannot be deleted, and "clear completed" skips it,
  until the next iteration has launched or the chain has ended: it holds the
  chain's state, and deleting it would silently lose the chain. Stop the chain
  (or cancel the task) first if you want it gone.
- SAFE MODE holds a chain (the next iteration waits) without ending it. A
  per-project automation pause does **not**: it targets unsolicited automation
  such as schedules, while a chain is a run the operator started explicitly in
  that project.

## Indicators

Each task in a chain shows a badge:

| Badge | Meaning |
| --- | --- |
| `⛓ 3/10` | Iteration 3 of 10 |
| `⛓ #3 · 2h 14m left` | Iteration 3 of a time-bounded chain |
| `⛓ 3/10 · stopping` | A stop was requested; this is the last iteration |
| `⛓ 3/10 · ended: all iterations ran` | The chain is over; hover for details |

## Why a chain ends

| Reason | Meaning |
| --- | --- |
| `iterations_reached` | The iteration count was reached. |
| `deadline_reached` | The time limit had passed when an iteration finished. |
| `safety_cap` | A time-only chain reached 50 iterations. |
| `stopped` | The operator or the agent asked it to stop. |
| `iteration_cancelled` | The operator cancelled or manually stopped the current iteration. |
| `runaway` | Three unhealthy iterations in a row: each failed, was killed by a watchdog, ran under 2 minutes, or stalled within 2 minutes and had to be closed by the idle backstop. |
| `launch_failed` | The next iteration could not be launched three times in a row (for example the playbook was deleted), or the third unhealthy iteration in a row never started. The attempt counter is kept in memory, so a restart allows a few more tries. |

The reason and its detail are kept on the chain's last task. Server-log lines
are prefixed `[playbook-chain]`.

## Writing playbooks for chains

- Keep progress in durable state the next iteration can read (a ledger file,
  GitHub issues), because each iteration starts from a fresh context. The
  `agentic-capability-research` playbook already does this with its
  `_questions.jsonl` ledger.
- Do not tell the agent to spawn a successor; Kookr does it.
- Iterations advance when the task ends, not when its PR merges. A playbook
  whose next iteration needs merged code should merge within the iteration.
