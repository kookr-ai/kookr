---
name: codex-pr-lessons
group: codex-pr-lessons
description: Phases of the codex-pr-lessons playbook (plan, critic, threshold, distill) — learn from closed openai/codex PRs and distill contribution patterns
keywords: codex, pr, lessons, plan, critic, threshold, distill, batch, patterns
related: [pr-contribution-excellence]
---

# Codex PR lessons

The `codex-pr-lessons` playbook studies closed pull requests in `openai/codex`, five at a time, records what each one teaches, and distills the notes into contribution patterns once enough have piled up. This skill holds the instructions for each phase of that loop.

Read only the file for the phase you are running.

| Phase | When it runs | Read |
|---|---|---|
| Plan | At the start of each iteration: load state, pick the next batch of 5 PRs | [references/plan.md](references/plan.md) |
| Critic | For each PR in the batch: read it in full and record its quality signals | [references/critic.md](references/critic.md) |
| Threshold | After the batch is recorded: decide whether to distill (`DISTILL` or `SKIP`) | [references/threshold.md](references/threshold.md) |
| Distill | Only when the threshold phase returns `DISTILL`: compress raw notes into patterns | [references/distill.md](references/distill.md) |

The record phase between critic and threshold (append the observations, update `state.json`) is a separate project skill in the Kookr repository, `kookr-codex-pr-state`.

## Shared state

All phases read and write the same files, which live outside any repository so every worktree sees them:

- `~/.claude/codex-pr-lessons/state.json`: processed and skipped PR numbers, pagination cursor, totals. Read it first, write it last.
- `~/.claude/codex-pr-lessons/learnings-raw.md`: per-PR observations, appended each batch and reset after a distillation.
- `~/.claude/codex-pr-lessons/learnings-distilled.md`: the distillation log.
- `~/.claude/skills/pr-contribution-excellence/`: where distilled patterns land (general rules in `SKILL.md`, codex-specific ones in `repo/openai-codex.md`).
