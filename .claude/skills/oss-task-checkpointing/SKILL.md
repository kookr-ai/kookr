---
name: oss-task-checkpointing
description: Persistent checkpoint protocol for long Kookr tasks. Survives context compaction, agent crash, host reboot, and handoff to a new task on the same branch. Used by Kookr's v5 proactive cycle (see docs/poc/004 + 005) — `KOOKR_CHECKPOINT_DIR` is injected at launch and Kookr auto-triggers checkpoint writes when context fills up.
keywords: checkpoint, oss, contribution, long task, persistent state, compaction, memory reset, recon, handoff, resume, wip, context window, session boundary, grafana, n8n, rust, upstream, kookr, branch, git
---

# Task Checkpointing

This skill describes Kookr's v5 checkpoint protocol. It applies to any long-running task — OSS contributions are the most common case but it also works for internal feature branches, multi-day refactors, and any work that may cross a `/compact` boundary or be picked up by a new task days later.

## When this skill fires

The skill is invoked in two scenarios. Both are driven by Kookr, not by you.

### Scenario A — fresh session resume

Every time a Kookr-managed agent session starts (a new task, a relaunch after crash, a session resumed after `/compact`), the system prompt contains an instruction to read `$KOOKR_CHECKPOINT_DIR/CHECKPOINT.md` if that variable is set and the file exists. **Your very first action in any new session must be to `Read` that file.**

If the file exists, treat it as authoritative state from previous work on this branch. It contains:
- Current verdict / hypothesis
- What's been tried and ruled out
- Next concrete actions
- A pointer to `repro.sh` (if any) which brings the local environment back up

If the file doesn't exist or `KOOKR_CHECKPOINT_DIR` is unset, this is a fresh task — proceed normally.

### Scenario B — Kookr-driven update (proactive cycle)

When the per-turn context fill crosses the configured threshold (default 75%), Kookr injects a user message into the session asking you to update `CHECKPOINT.md` with the current state. The message looks like:

> Context window is at NN% of the model limit. Before I run /compact, please update $KOOKR_CHECKPOINT_DIR/CHECKPOINT.md with the current verdict, evidence, and next actions. After your reply I will run /compact for you, then a fresh turn will read CHECKPOINT.md back automatically.

When you receive this message:

1. Use `Write` to refresh `$KOOKR_CHECKPOINT_DIR/CHECKPOINT.md` with the current state.
2. Reply briefly confirming the write.
3. Kookr will automatically send `/compact` after your reply finishes.
4. After compaction, the system prompt instruction fires again on the next turn and you re-read the checkpoint with fresh context.

You do not need to remember to run `/compact` yourself — Kookr does it. You also do not need to remember to re-read the checkpoint after compaction — the system prompt handles it.

## Storage layout

Kookr provisions a per-`(repo, branch)` directory at launch and exports its path via the `KOOKR_CHECKPOINT_DIR` environment variable. The directory is keyed on the git common dir + current branch, so two tasks days apart on the same branch share the same checkpoint.

```
$KOOKR_CHECKPOINT_DIR/
├── CHECKPOINT.md       # Mandatory — the only file you must keep current
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

Run `$KOOKR_CHECKPOINT_DIR/repro.sh` (if it exists). Otherwise the steps to bring up the local env are: …
```

Keep the file under ~32 KB. Move historical detail into `artifacts/history-YYYY-MM-DD.md` if it grows.

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

If a `repro.sh` exists at `$KOOKR_CHECKPOINT_DIR/repro.sh`, your second action on resume (after reading CHECKPOINT.md) should be to run it — it's the agent's protocol for verifying the claimed environment is still real. If the script fails, the checkpoint is stale; rewrite it with the corrected state and escalate to the user before acting on the old verdict.

## Limitations of this approach

- **Subagents don't write checkpoints.** A subagent inherits `KOOKR_CHECKPOINT_DIR` from its parent but should only `Read` the checkpoint, never `Write` it. Only the top-level session writes.
- **Concurrent same-branch tasks.** If two tasks run on the same branch at the same time and both fire the cycle, the last write wins. Avoid this if you can.
- **Codex CLI intra-session resume.** v1's load instruction goes via the system prompt (Claude Code) or a prompt prefix (Codex CLI). The Codex prefix is summarized away by `/compact`; intra-session post-compact resume on Codex CLI is a known v1 gap. Inter-session resume on Codex CLI works fine because each new task gets a fresh prompt prefix.

## Related references

- `docs/poc/004-checkpoint-hook-feasibility.md` — empirical proof that hook-feedback steering and agent-side `/compact` invocation do **not** work
- `docs/poc/005-checkpoint-cycle-mechanics.md` — empirical proof that Kookr-side `tmux send-keys "/compact"`, the `token-tracker.ts` formula, and system-prompt survival across `/compact` all work
- `src/core/checkpoint-cycler.ts` — Kookr's state machine that drives the cycle
- `src/server/checkpoint-path.ts` — branch-keyed storage layout
- `src/core/token-tracker.ts` — `computeContextFillFromTranscript` is the metric that fires the cycle
