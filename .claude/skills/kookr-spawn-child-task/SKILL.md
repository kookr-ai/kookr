---
name: kookr-spawn-child-task
description: Create a new Kookr task from within an agent session via the HTTP API
keywords: task, spawn, child, subtask, delegate, kookr, api, POST /api/tasks, curl, data-binary, hook false-positive
---

# Spawn Child Task

When you need to delegate follow-up work to a separate Kookr task (e.g., "this needs a separate PR", "fix that in a new task"), use the Kookr HTTP API to create a child task.

## When to use

- The user asks you to handle something "in a new task" or "separately"
- You identify follow-up work that should be tracked independently
- A refactor, fix, or investigation is outside the scope of your current task

## Scope discipline — the child does ONE thing

A child task must have a single, narrowly-defined job. If the overall work has multiple phases — evaluate → decide → adjust → evaluate again — orchestrate those phases **from the parent**: spawn one child for one evaluation, wait for its result, adjust state in the parent based on the result, then spawn the next child.

**Do not encode iteration or orchestration logic inside the child prompt.** In particular:

- Do not ask the child to re-run a subagent N times with a file that the child itself is supposed to rewrite between runs. File-based prompt reloads across Agent subagent invocations are not reliably picked up within a single child session — the second invocation may see the same prompt the first one saw.
- Do not ask the child to "iterate until the metric passes". That bundles three responsibilities (evaluate, judge, adjust) that should live with the decision authority (the parent) rather than the evaluation worker (the child).
- Do not ask the child to open PRs based on its own output unless the parent has no useful role in that decision. If the parent needs to approve, review, or reshape what the child produced, the child returns findings and the parent opens the PR.

The calibration question: *"After this child returns, does the parent need to make any judgement call before the next action?"* If yes, keep the next action in the parent. Split the work into `spawn → return → parent decides → spawn next`, not one fat child that tries to do both sides.

Symptom of getting this wrong: you stop the child mid-session because it's looping on a decision it wasn't equipped to make.

## Worktree isolation (mandatory)

Every spawned task MUST work in a git worktree, never directly on `main` or by switching branches in the main checkout. The prompt MUST instruct the agent to create a worktree and work inside it.

**Add this to every prompt:**

> Before starting any work, create a git worktree on a feature branch and work inside it. Do NOT commit to main or switch branches in the main checkout.
> ```
> git worktree add ../kookr-<short-name> -b <feature-branch> main
> ```
> All commits and changes must happen inside the worktree. When creating a PR, push from the worktree.

This prevents tasks from polluting the main checkout, conflicting with each other, or breaking the dev environment.

## How to spawn a child task

### Prefer injected Kookr context

When this skill runs inside a Kookr-managed agent session, prefer the injected environment variables instead of tmux/process discovery:

- `KOOKR_TASK_ID` — use as `parentTaskId`
- `KOOKR_PARENT_TASK_ID` — present when the current task is itself a child
- `KOOKR_API_BASE_URL` — base URL for the active local Kookr server (for example `http://127.0.0.1:4800`)
- `KOOKR_GIT_COMMON_DIR` — shared `.git` directory for the active worktree

This avoids brittle tmux inspection and local port probing under restricted permission modes.

Use `curl` to call the Kookr API. The server runs on `localhost` at the port shown in your environment (default: `4800` for production, `4801` for dev).

**Always POST from a temp file in `/tmp/` (or `$TMPDIR`), and write the file with the `Write` tool — never a bash heredoc, never inline `-d '...'`.** See [Gotcha: hook false-positives on command-line payloads](#gotcha-hook-false-positives-on-command-line-payloads) for why. The file MUST live outside the workspace so it never becomes a dirty git file.

### Two-step pattern: Write, then curl

**Step 1 — use the `Write` tool** to create `/tmp/spawn-task-<something>.json`. The tool's payload does NOT pass through bash, so Bash PreToolUse hooks never see the content. This is the only mechanism that is safe when the prompt contains hook-triggering substrings like `gh pr create`, `git push --force`, or `rm -rf`.

Example Write call:

```
Write(
  file_path: "/tmp/spawn-task-myjob.json",
  content: "{\n  \"prompt\": \"Before starting any work, create a git worktree on a feature branch and work inside it:\\n  git worktree add ../kookr-<short-name> -b <feature-branch> main\\nAll commits must happen inside the worktree.\\n\\n<actual task description here>\",\n  \"cwd\": \"/absolute/path/to/working/directory\",\n  \"criteria\": \"Optional: acceptance criteria for the new task\",\n  \"parentTaskId\": \"<KOOKR_TASK_ID value>\"\n}"
)
```

Substitute `parentTaskId` by inlining the actual `$KOOKR_TASK_ID` value when you write the file — do NOT leave a placeholder and try to `sed` it in via bash, because `sed` will itself tell the hook about the payload string.

**Step 2 — bash curl from the file:**

```bash
curl -sS -X POST "${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}/api/tasks" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/spawn-task-myjob.json
rm -f /tmp/spawn-task-myjob.json
```

The bash command here contains only the file path, not the payload — hooks are happy.

### Required fields

| Field    | Type   | Description |
|----------|--------|-------------|
| `prompt` | string | What the new agent should do. Be specific — it starts fresh. |
| `cwd`    | string | Absolute path to the working directory for the new task. |

### Optional fields

| Field          | Type   | Description |
|----------------|--------|-------------|
| `criteria`     | string | Acceptance criteria (definition of done). |
| `parentTaskId` | string | UUID of the parent task, for traceability in the dashboard. |

### Response

On success (HTTP 201), you get back the created task:

```json
{
  "id": "uuid-of-new-task",
  "prompt": "...",
  "cwd": "...",
  "parentTaskId": "parent-uuid",
  "status": "inProgress",
  "sessions": [{ "tmuxSession": "kookr-abc123", ... }],
  ...
}
```

On error (HTTP 400/404/500), you get:

```json
{ "error": "description of what went wrong" }
```

## Tips

- **Include full context in the prompt.** The child agent has no access to your conversation history.
- **Use your current task ID as `parentTaskId`** so the dashboard shows the relationship.
- **Set `cwd` to the appropriate directory** — often your own cwd, but it could differ for cross-repo work.
- The child task launches immediately and appears in the Kookr dashboard.
- **Temp files go in `/tmp/` only** — never write the spawn payload anywhere inside the repo tree, or it will show up as a dirty file and may be accidentally committed.

## Gotcha: hook false-positives on command-line payloads

Kookr ships `PreToolUse` hooks that match `Bash` commands by substring. For example, `pr-workflow-gate.sh` matches `\bgh\s+pr\s+create\b` and blocks the command if the pre-PR review state file is missing. These hooks scan the **entire command text**, not just the invoked binary.

**The problem:** if you POST a task prompt with `curl -d '{...}'` and the JSON payload contains the literal string `gh pr create` (or any other hook-triggering substring), the outer `curl` gets blocked even though it is not creating a PR. The hook cannot tell the difference between a real invocation and a literal mention inside a JSON body.

Other strings that will trip hooks in this project: `gh pr create`, `gh pr edit`, `gh pr merge`, `rm -rf`, `git reset --hard`, `git push --force`. If your task prompt describes ANY of these commands as text (e.g. instructions to the child agent on how to run them), inline `-d` will fail.

**The fix — make this your default pattern, not a workaround:** write the JSON to `/tmp/spawn-task-<name>.json` **via the `Write` tool**, then POST with `curl --data-binary @/tmp/spawn-task-<name>.json`. Only the Write-tool-then-curl pattern keeps the payload off the bash command line — the Write tool's content is sent to the tool runtime directly, bypassing the Bash PreToolUse hook entirely.

**Heredoc is NOT safe.** `cat > /tmp/foo.json <<'JSON' … JSON` looks like it sends the content to a file via stdin, but Claude Code's Bash tool forwards the full command text (including the heredoc body) to every PreToolUse hook. A hook that matches `gh pr create` by substring will see and block the heredoc body just as if you had used `-d '{"prompt": "gh pr create"}'`. The empirical signature of this failure: the hook blocks your `cat > /tmp/foo.json <<EOF` command with a message about `gh pr create` even though your command is clearly a file-write, not a PR creation.

**Why `/tmp/` specifically:**

- **Outside the workspace** — a file at `.claude/worktrees/*/spawn.json` or `./payload.json` becomes a dirty git file and can be accidentally committed. `/tmp/` is invisible to git.
- **Auto-cleaned** — `/tmp/` is cleared on reboot so orphaned payloads don't accumulate.
- **World-writable and always available** — works in every Linux/macOS environment regardless of the session's permission mode.

Use `$TMPDIR` instead of hardcoded `/tmp/` if you want to respect the system temp directory override. Give the file a descriptive name (e.g. `/tmp/spawn-task-eval-a11y.json`) rather than `$$`-based PIDs, since the `Write` tool is invoked from Claude and doesn't have a shell PID.

Delete the temp file after the `curl` succeeds if you are worried about cruft:

```bash
rm -f /tmp/spawn-task-<name>.json
```

## Example

Step 1 — `Write` tool call (invoked separately, not via bash):

```
Write(
  file_path: "/tmp/spawn-task-fix-readme.json",
  content: <<JSON body with actual KOOKR_TASK_ID inlined>>
)
```

Step 2 — bash:

```bash
curl -sS -X POST "${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}/api/tasks" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/spawn-task-$$.json
rm -f /tmp/spawn-task-$$.json
```
