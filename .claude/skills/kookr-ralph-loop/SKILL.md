---
name: kookr-ralph-loop
description: Start, observe, pause, resume, or cancel Kookr's first-class Ralph iteration loops for task-scoped repeated agent work
keywords: ralph, ralph loop, use Ralph loop in Kookr, iteration loop, loop prompt, stop predicate, kookr ralph, task loop
related: kookr-playbooks, kookr-supervise-tasks
---

# Kookr Ralph Loop

Use this skill when the user asks to use, start, attach, supervise, pause, resume, cancel, or inspect a Ralph loop in Kookr. Ralph loops are Kookr-managed task loops: Kookr re-injects the same prompt after each agent `Stop` event until a stop condition fires.

For the full operator playbook, see `.kookr/playbooks/ralph-loop.md`.

## When to Use

Use a Ralph loop when:

- The task benefits from repeated attempts with the same instruction, such as iterative cleanup, exploration, test-fix cycles, or work that can be judged by a simple predicate.
- There is a clear hard iteration cap.
- There is a concrete stop signal, such as a shell predicate, zero-diff convergence, a cost cap, or manual cancellation.
- The agent can persist progress in files so each iteration knows what remains.

Do not use a Ralph loop when:

- The user needs a one-off answer, design discussion, or approval-gated decision.
- The next step depends on fresh human judgment after each iteration.
- The prompt is likely to perform destructive operations without review.
- There is no bounded cap or observable stop condition.
- The standalone `ralph-wiggum@*` Claude Code plugin is enabled; Kookr's API refuses to start a loop when it detects that plugin because both controllers would react to the same `Stop` events.

## Basic Flow

1. Launch or identify the task that should be looped.

   Existing tasks can be found in the dashboard or from the API:

   ```bash
   curl http://localhost:4800/api/tasks
   ```

   To launch a new task first:

   ```bash
   curl -X POST http://localhost:4800/api/tasks \
     -H 'Content-Type: application/json' \
     -d '{"prompt": "Initial bootstrap", "cwd": "/path/to/workdir"}'
   ```

2. Attach the Ralph loop with a bounded configuration.

   ```bash
   curl -X POST http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop \
     -H 'Content-Type: application/json' \
     -d '{
       "prompt": "Read CHECKPOINT.md, do the next small unit of work, update CHECKPOINT.md, then stop.",
       "iterationCap": 10,
       "stopPredicate": "grep -q \"<promise>DONE</promise>\" CHECKPOINT.md",
       "zeroDiffConvergence": { "consecutiveIterations": 3 },
       "costCapUsd": 10
     }'
   ```

   `iterationCap` is the hard ceiling. Treat `costCapUsd` as a best-effort guard because it depends on reported cost data.

3. Observe the loop.

   In the dashboard, use the task card badge and the task detail Ralph panel. The panel reads the bounded iteration model exposed by:

   ```bash
   curl http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/iterations
   ```

   The backing audit file lives at `<task-cwd>/ralph-iterations.jsonl`.

4. Pause, resume, or cancel when needed.

   Use the dashboard controls beside the Ralph badge, or the CLI:

   ```bash
   kookr ralph status <TASK_ID>
   kookr ralph pause <TASK_ID>
   kookr ralph resume <TASK_ID>
   kookr ralph cancel <TASK_ID>
   ```

   Set `KOOKR_API_BASE_URL` or `KOOKR_PORT` when targeting a non-default Kookr instance.

## API Details

- `POST /api/tasks/:id/ralph-loop` attaches a loop.
- `GET /api/tasks/:id/ralph-loop/iterations` reads recent iteration history.
- `POST /api/tasks/:id/ralph-loop/pause` pauses after the current iteration.
- `POST /api/tasks/:id/ralph-loop/resume` resumes only if the live agent session still exists.
- `DELETE /api/tasks/:id/ralph-loop` cancels the loop and leaves the agent session alive.

Common attach failures:

- `404` means the task ID does not exist.
- `409 task already has an active Ralph loop` means use the existing loop or cancel it first.
- `409 standalone ralph-wiggum plugin detected` means disable the standalone plugin before attaching Kookr's loop.
- `400` means the prompt or stop configuration is invalid.

## Prompt Pattern

Good loop prompts are short, stateful, and bounded:

```text
Read CHECKPOINT.md. If it contains <promise>DONE</promise>, stop.
Otherwise, complete exactly one small unit of work, update CHECKPOINT.md
with evidence and the next action, then stop.
```

Pair that with a predicate such as:

```bash
grep -q "<promise>DONE</promise>" CHECKPOINT.md
```

Keep the predicate fast; Kookr records predicate timeouts and continues the loop.
