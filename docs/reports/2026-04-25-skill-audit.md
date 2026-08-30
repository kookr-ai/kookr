# Skill Classification Audit — 2026-04-25

Run as part of the implementation PR for `rfc-share-claude-resources-cross-project.md`. Classifies every entry in `.claude/skills/` and `.claude/agents/` as either:

- **PROJECT** — references Kookr-internal commands, paths, or env vars; stays in `<kookr>/.claude/`. Loaded via project-scope when cwd is the Kookr repo.
- **TOOLKIT** — no Kookr-internal references; moves to `<kookr>/plugin/` and ships via the `kookr-toolkit` plugin to all consumers.

## Audit signals

A file is classified PROJECT if any of these patterns match its content:

```
KOOKR_[A-Z_]+
~/\.kookr/
/home/[^/]+/git/kookr
\.hooks/(pre-push|post-push)
pnpm (prod|dev|start:dev|build:server|check:|prod:update|codex:|setup|rebuild)
```

Plus a manual review of any file that mentions "Kookr" by name to determine whether the reference describes Kookr internals or just describes the toolkit's origin.

`pnpm test` and `pnpm typecheck` (generic in any TypeScript project) are NOT disqualifying.

## Results — Skills

### PROJECT (26 skills)

| Skill | Disqualifying reference |
|---|---|
| `architecture-drift-signals` | "Kookr's documented layer order" — Kookr-specific architecture description |
| `claude-code-hooks` | Has a "Kookr Integration Pattern" section |
| `claude-code-permissions` | Has a "Kookr Worker Permissions" section |
| `codex-claude-compatibility` | `pnpm codex:rebuild`, references Kookr fork build path |
| `codex-pr-state` | "Kookr's dashboard reads this field" |
| `demo-recording` | `KOOKR_TTS`, `KOOKR_TTS_URL`, `$HOME/git/kookr` |
| `kookr-playbooks` | About `.kookr/playbooks/` directory and the dashboard UI |
| `kookr-terminal-backend` | `KOOKR_BACKEND` env var |
| `mbse-system-modeling` | Hardcoded `$HOME/git/kookr` path argument in embedded scripts |
| `oss-contribution-gate` | `KOOKR_TASK_ID`, `~/.kookr/` ledger paths |
| `oss-dashboard-verify` | `~/.kookr/` paths, Kookr API |
| `oss-issue-scout` (skill) | `KOOKR_API_BASE_URL`, `~/.kookr/oss-attempts.json` |
| `oss-pr-state` | "Kookr's dashboard reads this field" |
| `oss-repo-recon` | `~/.kookr/` recon-state paths |
| `oss-task-checkpointing` | `KOOKR_CHECKPOINT_DIR` |
| `post-push` | `pnpm build:server`, `pnpm check:e2e` |
| `pr-lifecycle` | `pnpm build:server`, Kookr-specific PR workflow |
| `pre-pr-review` | `.hooks/pre-push`, `pnpm build:server` |
| `pre-push` | `.hooks/pre-push`, `pnpm build:server`, `pnpm check:e2e` |
| `rfc-iterative-review` | "Kookr task prompt", `kookr-rfc-<slug>` worktree convention |
| `self-reflect` | `pnpm test`, `pnpm typecheck`, `~/.kookr/` referenced in embedded script |
| `session-reflect` | `~/.kookr/` session paths |
| `shadow-detection` | Kookr's stuck-detection internals |
| `spawn-child-task` | `KOOKR_API_BASE_URL`, `KOOKR_PARENT_TASK_ID`, `KOOKR_GIT_COMMON_DIR` |
| `supervise-kookr-tasks` | `pnpm build:server`, supervises Kookr task lifecycle |
| `github-labels` | Hardcoded label taxonomy for `kookr-ai/kookr` |

### TOOLKIT (44 skills)

`async-flow-control`, `claude-code-metrics-analysis`, `codex-pr-critic`, `codex-pr-distill`, `codex-pr-plan`, `codex-pr-threshold`, `dependency-injection-patterns`, `domain-driven-design`, `e2e-agent-testing`, `error-handling-patterns`, `event-driven-messaging-patterns`, `find-best-reviewers`, `git-commit-discipline`, `github-issue-workflow`, `github-trending-repos`, `hook-driven-workflow-enforcement`, `logging-design-patterns`, `monorepo-architecture`, `oss-fork-manager`, `oss-pr-critic`, `oss-pr-distill`, `oss-pr-plan`, `oss-pr-threshold`, `playwright-e2e-patterns`, `pr-review-triage`, `process-lifecycle-patterns`, `realtime-state-sync`, `requirements-engineering`, `reviewer-distillation-judge`, `reviewer-distillation-meta`, `reviewer-distillation-mutate`, `reviewer-distillation-predict`, `reviewer-distillation-prepare`, `reviewer-distillation-select`, `rust-lang-rust-pre-push`, `rust-lang-rust-tests`, `safe-refactoring`, `shell-subprocess-safety`, `state-machine-workflow-patterns`, `tdd-workflow`, `testing-patterns`, `token-efficiency`, `typescript-type-safety`, `websocket-dashboard`.

## Results — Agents

### PROJECT (1 agent)

| Agent | Disqualifying reference |
|---|---|
| `oss-issue-scout` | `~/.kookr/oss-attempts.json`, `~/.claude/{slug}-recon/contributions.json` (the latter is user-scope conventional, not Kookr-internal — but combined with the first, classify PROJECT). The corresponding _skill_ is also PROJECT. |

### TOOLKIT (15 agents)

`api-surface-auditor`, `architecture-drift-detector`, `architecture-smell-scanner`, `boundary-critic`, `delivery-pragmatist`, `dependency-graph-analyzer`, `design-experimenter`, `design-minimalist`, `failure-mode-analyst`, `module-interface-auditor`, `operability-reviewer`, `socratic-challenger`, `state-machine-verifier`, `test-fixer`, `test-quality-reviewer`.

All 15 use only `name`, `description`, `model` frontmatter — no `hooks`, `mcpServers`, `permissionMode`, `tools` fields that would be rejected by Claude Code's plugin agent validator.

## Summary

| Tier | Skills | Agents | Total |
|---|---|---|---|
| PROJECT (`<kookr>/.claude/`) | 26 | 1 | 27 |
| TOOLKIT (`<kookr>/plugin/`) | 44 | 15 | 59 |
| **Total** | **70** | **16** | **86** |

(`oss-issue-scout` exists both as a skill and as an agent; both are PROJECT — counted once in each row.)

> **2026-08-30 follow-up:** `kookr-playbooks` was promoted and renamed to
> `playbook-authoring` under `plugin/skills/` because playbook and scheduled
> orchestration guidance is needed outside the Kookr source checkout. The
> classifications and counts above remain the original 2026-04-25 snapshot.

## Sanitization candidates (future)

Three skills are PROJECT only because they have small Kookr-specific sections that could be sanitized to enable promotion in a follow-up:

1. **`claude-code-hooks`** — the body is general except for one "Kookr Integration Pattern" section. Splitting the section out (or renaming to "Example: Kookr") would make the skill toolkit-eligible.
2. **`claude-code-permissions`** — same pattern as above; one "Kookr Worker Permissions" example section.
3. **`oss-pr-state` / `codex-pr-state`** — both reference "Kookr's dashboard" once. Removing or generalizing that line would make them toolkit-eligible.

Not done in this PR. Tracked as companion work.

## Method

```bash
for skill in .claude/skills/*/; do
  name=$(basename "$skill")
  match=$(rg -l --no-messages \
    'KOOKR_[A-Z_]+|~/\.kookr/|/home/[^/]+/git/kookr|\.hooks/(pre-push|post-push)|pnpm (prod|dev|start:dev|build:server|check:|prod:update|codex:|setup|rebuild)' \
    "$skill" 2>/dev/null | head -1)
  [[ -n "$match" ]] && echo "PROJECT $name" || echo "TOOLKIT $name"
done
```

Plus a manual review pass for files mentioning "Kookr" by name (without disqualifying patterns) to decide whether the reference is descriptive or constraining.
