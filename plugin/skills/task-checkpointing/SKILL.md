---
name: task-checkpointing
description: Persistent checkpoint protocol for long-running tasks. Survives context compaction, agent crash, host reboot, and handoff to a new task on the same branch. Caller (Kookr is the dominant one — see docs/poc/004 + 005) injects `TASK_CHECKPOINT_DIR` at launch and auto-triggers checkpoint writes when context fills up. Use for OSS bug fix-and-verify workflows (e.g., side-by-side video proof), multi-day refactors, or any task that may cross a `/compact` boundary.
keywords: checkpoint, oss, contribution, long task, persistent state, compaction, memory reset, recon, handoff, resume, wip, context window, session boundary, grafana, n8n, rust, upstream, kookr, branch, git
---

# Task Checkpointing

This skill describes the long-task checkpoint protocol. Kookr is the dominant caller (see `docs/poc/004` + `005`); any other caller that sets `TASK_CHECKPOINT_DIR` and follows the same lifecycle can use the same protocol. It applies to any long-running task — OSS contributions are the canonical case (e.g., bug fix-and-verify with side-by-side video proof), but it also works for internal feature branches, multi-day refactors, and any work that may cross a `/compact` boundary or be picked up by a new task days later.

## When this skill fires

The skill is invoked in two scenarios. Both are driven by Kookr, not by you.

### Scenario A — fresh session resume

Every time a managed agent session starts (a new task, a relaunch after crash, a session resumed after `/compact`), the system prompt contains an instruction to read checkpoint state if `TASK_CHECKPOINT_DIR` is set. **Your very first action in any new session must be to read the checkpoint.**

Read order:

1. If `$TASK_CHECKPOINT_DIR/CHECKPOINT.json` exists and validates as `semantic-checkpoint.v1`, read it first. It is the durable machine-readable handoff contract.
2. If `CHECKPOINT.json` is missing or invalid, warn about the invalid/missing JSON and fall back to `$TASK_CHECKPOINT_DIR/CHECKPOINT.md`.
3. If neither file exists or `TASK_CHECKPOINT_DIR` is unset, this is a fresh task — proceed normally.

If a checkpoint exists, treat it as authoritative state from previous work on this branch. It contains:
- Current verdict / hypothesis
- What's been tried and ruled out
- Next concrete actions
- A pointer to `repro.sh` (if any) which brings the local environment back up

### Scenario B — Kookr-driven update (proactive cycle)

When the per-turn context fill crosses the configured threshold (default 75%), Kookr injects a user message into the session asking you to update both `CHECKPOINT.md` and `CHECKPOINT.json` with the current state. The message looks like:

> Context window is at NN% of the model limit. Before I run /compact, please update $TASK_CHECKPOINT_DIR/CHECKPOINT.md with the current verdict, evidence, and next actions, and update $TASK_CHECKPOINT_DIR/CHECKPOINT.json using schema_version "semantic-checkpoint.v1" with task_id, repo, worktree, branch, verdict, decisions, evidence, files_changed, tests_run, open_risks, next_actions, and memory_write_candidates. After your reply I will run /compact for you, then a fresh turn will read CHECKPOINT.json first when valid and fall back to CHECKPOINT.md automatically.

When you receive this message:

1. Use `Write` to refresh `$TASK_CHECKPOINT_DIR/CHECKPOINT.md` with the current human-readable state.
2. Use `Write` to refresh `$TASK_CHECKPOINT_DIR/CHECKPOINT.json` with valid `semantic-checkpoint.v1` JSON.
3. Reply briefly confirming the write.
4. Kookr will automatically send `/compact` after your reply finishes.
5. After compaction, the system prompt instruction fires again on the next turn and you re-read the checkpoint with fresh context.

You do not need to remember to run `/compact` yourself — Kookr does it. You also do not need to remember to re-read the checkpoint after compaction — the system prompt handles it.

## Storage layout

The caller provisions a per-`(repo, branch)` directory at launch and exports its path via the `TASK_CHECKPOINT_DIR` environment variable. (Kookr keys the directory on the git common dir + current branch, so two tasks days apart on the same branch share the same checkpoint.)

```
$TASK_CHECKPOINT_DIR/
├── CHECKPOINT.md       # Human-readable checkpoint
├── CHECKPOINT.json     # semantic-checkpoint.v1 structured checkpoint
├── repro.sh            # Optional but strongly recommended — atomic re-runnable env setup
├── git-state.json      # Optional — { worktree, branch, sha } snapshot
└── artifacts/          # Optional — videos, log files, probe output
```

Kookr has read/write/bash permission allowlist entries for this directory. You can use `Write`, `Edit`, or `Bash` freely inside it.

## CHECKPOINT.md schema

A useful CHECKPOINT.md is short, structured, and trustworthy. The agent that walks in cold tomorrow needs to know "where am I, and what's the next runnable action."

```markdown
# {Task title}

**Status (YYYY-MM-DD HH:MM):** {one sentence: where this is right now}
**PR:** https://github.com/.../pull/N (OPEN | DRAFT | CLOSED | MERGED) — optional, fill if there is one
**Branch:** $(git branch --show-current)
**HEAD sha:** $(git rev-parse --short HEAD)
**Worktree:** {absolute path}

## Verdict (one-liner)

{What you currently believe is true about the bug, fix, or feature. Update as understanding evolves.}

## Evidence

- {Concrete artifacts: test results, log lines, DOM probes, exact line numbers}

## Next actions

1. {Concrete next step — runnable, not aspirational}
2. {...}
3. {...}

## Reproducing from zero

Run `$TASK_CHECKPOINT_DIR/repro.sh` (if it exists). Otherwise the steps to bring up the local env are: …
```

Keep the file under ~32 KB. Move historical detail into `artifacts/history-YYYY-MM-DD.md` if it grows.

## CHECKPOINT.json schema

`CHECKPOINT.json` is the machine-readable companion to `CHECKPOINT.md`. Keep it compact, valid JSON, and aligned with the Markdown checkpoint.

```json
{
  "schema_version": "semantic-checkpoint.v1",
  "task_id": "string",
  "repo": "owner/name",
  "worktree": "path",
  "branch": "string",
  "verdict": "in_progress|blocked|stalled|complete",
  "decisions": [],
  "evidence": [],
  "files_changed": [],
  "tests_run": [],
  "open_risks": [],
  "next_actions": [],
  "memory_write_candidates": []
}
```

The canonical schema is `docs/schemas/semantic-checkpoint.v1.json`. Kookr validates the top-level shape when launching/resuming. Invalid JSON is a warning, not a task blocker; Kookr falls back to `CHECKPOINT.md`.

## When NOT to checkpoint

- Trivial tasks ("read this file and tell me what it does"). The cycle won't fire — context never fills up. No checkpoint needed.
- Conversation-scoped TODOs. Use the in-conversation task list (TaskCreate) for those.
- Information already derivable from the code or git history. Don't restate `git log`.

## When checkpointing matters most

- OSS contributions that require a long local build to reproduce
- Multi-day investigations (start today, get review feedback in 2 days, continue tomorrow)
- Tasks that record video evidence or other external artifacts
- Anything where losing 30 minutes of environmental setup would be painful

## Reproducing from zero on resume

If a `repro.sh` exists at `$TASK_CHECKPOINT_DIR/repro.sh`, your second action on resume (after reading the checkpoint) should be to run it — it's the agent's protocol for verifying the claimed environment is still real. If the script fails, the checkpoint is stale; rewrite both checkpoint files with the corrected state and escalate to the user before acting on the old verdict.

## Limitations of this approach

- **Subagents don't write checkpoints.** A subagent inherits `TASK_CHECKPOINT_DIR` from its parent but should only `Read` the checkpoint, never `Write` it. Only the top-level session writes.
- **Concurrent same-branch tasks.** If two tasks run on the same branch at the same time and both fire the cycle, the last write wins. Avoid this if you can.
- **Codex CLI intra-session resume.** v1's load instruction goes via the system prompt (Claude Code) or a prompt prefix (Codex CLI). The Codex prefix is summarized away by `/compact`; intra-session post-compact resume on Codex CLI is a known v1 gap. Inter-session resume on Codex CLI works fine because each new task gets a fresh prompt prefix.

## Related references

- `docs/poc/004-checkpoint-hook-feasibility.md` — empirical proof that hook-feedback steering and agent-side `/compact` invocation do **not** work
- `docs/poc/005-checkpoint-cycle-mechanics.md` — empirical proof that Kookr-side `tmux send-keys "/compact"`, the `token-tracker.ts` formula, and system-prompt survival across `/compact` all work
- `src/core/checkpoint-cycler.ts` — Kookr's state machine that drives the cycle
- `src/core/checkpoint-path.ts` — branch-keyed storage layout and semantic checkpoint reader
- `src/core/token-tracker.ts` — `computeContextFillFromTranscript` is the metric that fires the cycle
