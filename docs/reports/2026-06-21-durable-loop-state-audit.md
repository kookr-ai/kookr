# Autonomous Loop Durable-State Audit

**Date:** 2026-06-21
**Issue:** [#1088](https://github.com/kookr-ai/kookr/issues/1088) - *Migrate autonomous loops from conversation-memory recovery to durable state files* (RFC *Agent-Workflow Efficiency & Correctness Improvements* v4, item 5).
**Companion:** [#1089](https://github.com/kookr-ai/kookr/issues/1089) (item 6, subagent output-shape audit).

## Result

No non-excluded autonomous loop in the current tree still recovers state from prior conversation memory.

The implementable migration list is therefore empty for this issue:

```text
conversation-memory loops requiring migration: 0
```

All loop candidates below already reconstruct progress from durable external state, local state files, or persisted Kookr task state. No conversation fallback was removed, so the requested dual-write transition is not applicable in this unit.

## Scope

Included:

- Loopable playbooks and self-continuation patterns that can run across multiple agent runtimes.
- Kookr runtime surfaces that relaunch or continue looped playbooks.
- Adjacent batch workflows that look loop-like because they select the next unit from a cursor or state file.

Excluded by the issue's own dependency constraint:

- Ralph-family GitHub issue implementation loop: `plugin/playbooks/implement-github-issue.md`.

The excluded playbook is already state-oriented in the current tree: it names GitHub issue/PR state, issue-claim leases, `.batch-stop`, and engine-level `task.ralphLoop.burnedOutTargets` as its durable state. This audit still leaves it out of the migration decision because #1088 explicitly excludes the Ralph-family issue loop until its dependent work ships.

## Named Loop List

| Loop / workflow | Path | Durable state source | Conversation-memory recovery? | Migration disposition |
| --- | --- | --- | --- | --- |
| Self-continuation task chain | `plugin/skills/self-continuation-task/SKILL.md` | GitHub issue/PR state, explicit queue files, API rows, successor prompt cursor | No. The skill says continuation comes from external state and a fresh task prompt, not prior conversation. | No code change. Already durable. |
| Looped playbook launcher | `src/server/use-cases/looped-playbook-launch.ts` | Persisted `task.ralphLoop` plus playbook-defined durable state. Runtime prompt tells each iteration to read durable state first. | No. It launches a fresh runtime and injects durable-state instructions. | No code change. Already durable. |
| Ralph cycler | `src/core/ralph-cycler.ts`, `src/shared/contracts/ralph.ts` | `task.ralphLoop` fields, per-target stall rows, cumulative iteration counters, `ralph-iterations.jsonl` | No. State advances through persisted task fields and iteration logs. | No code change. Already durable. |
| Autonomous Evolution | `.kookr/playbooks/autonomous-evolution.md` | `champion.json`, `evolution-trials.jsonl`, `evolution-summary.md`, `.evolution-stop`, `ralph-iterations.jsonl` | No. The playbook explicitly reconstructs from files and says not to use conversation memory. | No code change. Already durable. |
| Parallel Issue Batch | `plugin/playbooks/parallel-issue-batch.md` | `~/.kookr/playbook-state/parallel-issue-batch/.../{state.md,candidates.json,selection.json,children.json,monitor.md,prompts/}` plus GitHub PR/issue state | No. It reconstructs prior batches from those files and GitHub before selecting replacements. | No code change. Already durable. |
| Reviewer Distillation | `.kookr/playbooks/reviewer-distillation.md` | `~/.claude/<repoSlug>-reviewer-distillation/state.json` plus context, review, prediction, score, aggregate, and mutation files | No. The iteration cursor and processed PRs live in `state.json`; subagents exchange data through files. | No code change. Already durable. |
| Codex PR Lessons | `.kookr/playbooks/codex-pr-lessons.md` | `~/.claude/codex-pr-lessons/state.json`, `learnings-raw.md`, distilled output files | No. The cursor and processed/skipped PR lists are persisted. | No code change. Already durable. |
| LangChain PR Lessons | `.kookr/playbooks/langchain-pr-lessons.md` | `~/.claude/langchain-pr-lessons/state.json`, `learnings-raw.md`, distilled output files | No. The cursor and processed/skipped PR lists are persisted. | No code change. Already durable. |
| OSS PR Lessons | `plugin/playbooks/oss-pr-lessons.md` | `~/.claude/<repoSlug>-pr-lessons/state.json`, `learnings-raw.md`, distilled output files | No. The cursor and processed/skipped PR lists are persisted. | No code change. Already durable. |
| Session Self-Reflection | `plugin/playbooks/session-self-reflect.md` | `~/.claude/session-reflections/state.json`, archived reports, generated reflection report | No. The analyzed session list and cumulative stats are persisted. | No code change. Already durable. |

## Non-loop Conversation Resume Surface

`src/server/crash-recovery.ts` can relaunch a crashed Claude Code session with `--resume <id> --fork-session`, continuing the prior conversation when a provider session id is persisted; a stale cached transcript path falls back to session-id-only resume instead of a fresh launch. That path is intentionally crash recovery for an individual interactive task, not an autonomous loop selector. It also has guards for spawned tasks that finished cleanly so self-continuation chains are not re-run from transcript context.

Because #1088 targets autonomous loops that recover queue/progress state from conversation, this crash-recovery surface is not part of the migration list.

## Dual-Write Decision

No loop in scope was migrated from conversation-memory recovery to a state file in this PR. The existing durable state files remain the only recovery source for the named loops, so there is no old conversation path to keep during a transition window and no removal step to defer.

Future changes that introduce a new autonomous loop should make the durable state explicit in the first PR, using one of these carriers:

- GitHub issue/PR state for issue chains.
- A local `state.json` or append-only JSONL log outside the target repo for playbook batches.
- Persisted Kookr `task.ralphLoop` fields plus a playbook-owned stop file for Ralph loops.
