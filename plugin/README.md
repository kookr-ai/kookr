# Kookr Toolkit — Claude Code Plugin

Skills and review subagents shipped with [Kookr](https://github.com/kookr-ai/kookr) for use with Claude Code in any project.

## Install

```
claude
> /plugin marketplace add kookr-ai/kookr
> /plugin install kookr-toolkit@kookr
```

After installation, the toolkit is available in every Claude Code session on your machine.

## Update

```
> /plugin marketplace update kookr
```

## What's included

**Code patterns:** `typescript-type-safety`, `error-handling-patterns`, `async-flow-control`, `dependency-injection-patterns`, `domain-driven-design`, `monorepo-architecture`, `requirements-engineering`, `state-machine-workflow-patterns`, `process-lifecycle-patterns`, `realtime-state-sync`, `event-driven-messaging-patterns`, `logging-design-patterns`, `shell-subprocess-safety`, `safe-refactoring`, `testing-patterns`, `playwright-e2e-patterns`, `websocket-dashboard`.

**Workflow:** `git-commit-discipline`, `tdd-workflow`, `token-efficiency`, `agent-efficiency-retrofit`, `claude-code-metrics-analysis`, `hook-driven-workflow-enforcement`, `e2e-agent-testing`, `github-issue-workflow`, `github-labels` (kookr-ai/kookr issue and PR label taxonomy), `github-trending-repos`, `placement-picker` (decide where a new rule, skill, hook, or memory belongs), `ui-mockup-variants` (offer design mockup variants before implementing any UI change), `adversarial-swarm-analysis` (cast conflicting expert roles, run them blind and in parallel, attack their consensus, synthesize a verdict that keeps the disagreement).

**Writing and design review:** `clear-technical-writing` (docstrings, comments, PR bodies, and docs a cold reader can follow), `rfc-iterative-review` (draft an RFC, run parallel critic subagents, iterate over rounds), `mbse-system-modeling` (generate or update multi-level architecture documentation), `architecture-drift-signals` (score structural health from file-size, layering, and dependency-graph signals), `requirements-engineering`.

**Autonomous loops and merge safety:** `autonomous-review-loop` (bounded implement-and-correct cycles with durable accounting), `autonomous-watch-loop` (long-lived poll-and-act janitor tasks), `self-continuation-task` (sequential task chains where each run spawns the next), `independent-merge-review` (fresh-context reviewer verdict required before an autonomous self-merge).

**Reflection:** `self-reflect` (root-cause a mistake, then implement a structural fix), `task-feedback-reflect` (act on a thumbs-up/down on a completed task), `task-snapshot-reflect` (analyze a live or finished task from an immutable snapshot).

**Claude Code configuration:** `claude-code-hooks` (all hook event types, payloads, and matchers), `claude-code-permissions` (permission modes, rule syntax, and settings precedence).

**Kookr operations:** Kookr-specific skills that are useful from any working
directory, such as task spawning, task supervision, CLI/API workflows, and
`playbook-authoring` (write or revise a Kookr playbook and its scheduling). These
belong in the plugin because it is the distributed toolkit surface: Kookr
injects it into spawned agents regardless of cwd, and regular Claude Code
sessions can also see it when the plugin is installed or synced locally.

**OSS contribution:** `oss-fork-manager`, `oss-pr-{critic,distill,plan,threshold}`, `pr-review-triage`, `pr-contribution-excellence` (bundled with per-repo distilled patterns under `repo/`), `find-best-reviewers`, `rust-lang-rust-{tests,pre-push}`.

**Playbooks (`plugin/playbooks/`):** ready-to-run task templates Kookr can launch on a schedule or on demand — architecture upkeep (`architecture-health-check`, `architecture-doc-sync`, `architecture-refactor-rfc`, `architecture-refactor-phase`, `pre-refactor-assessment`, `api-consistency-audit`, `doc-implementation-gap-analysis`), issue and backlog flow (`issue-triage`, `repository-idea-scout`, `issue-proposal-refinement`, `implement-github-issue`, `parallel-issue-batch`, `umbrella-decompose`), OSS contribution (`oss-contribution-pipeline`, `oss-bug-triage`, `oss-bug-fix`, `oss-bug-pr`, `oss-pr-lessons`), and merge/verification safety (`independent-verification-lane`, `pr-merge-rebase-watchdog`, `incident-close-out-gate`, `test-quality-improvement`, `session-self-reflect`, `capitalize-wisdom`). See [Playbooks Reference](../docs/reference/playbooks.md) for the file format.

**Reviewer specialists (`plugin/reviewer-specialists/`):** narrow prompt templates (`conventions-specialist`, `correctness-specialist`, `deadcode-specialist`, `test-specialist`, `docs-drift-specialist`, `a11y-specialist`) consumed by the bundled `pre-pr-review` skill.

**OSS contribution hooks (not in the marketplace plugin):** the PreToolUse / PostToolUse hooks (`pr-workflow-gate`, `oss-stale-scout-gate`, `oss-contribution-gate`, `oss-contribution-gate-posttool`) live in the Kookr repo's `hooks/` and `scripts/` dirs, not under `plugin/`, because they require explicit user-global hook installation and support runtimes where plugin hooks are not injected. Clone the Kookr repo and run the install scripts (see next section) to wire them.

**Reviewer distillation experiment:** `reviewer-distillation-{judge,mutate,predict,prepare,select,meta}`.

**Codex PR analysis:** `codex-pr-{critic,distill,plan,threshold}`.

**Review subagents (19):** `ambition-amplifier`, `api-surface-auditor`, `architecture-drift-detector`, `architecture-smell-scanner`, `assumption-archaeologist`, `boundary-critic`, `clear-writing-reviewer`, `delivery-pragmatist`, `dependency-graph-analyzer`, `design-experimenter`, `design-minimalist`, `failure-mode-analyst`, `macos-compat-reviewer`, `module-interface-auditor`, `operability-reviewer`, `socratic-challenger`, `state-machine-verifier`, `test-fixer`, `test-quality-reviewer`.

## One-time setup for the OSS extension

A few skills (`oss-pr-distill`, `codex-pr-distill`, `reviewer-distillation-predict`) and the `oss-contribute` playbook read companion files from `~/.claude/skills/pr-contribution-excellence/` and `~/.claude/reviewer-specialists/`. These paths are not auto-populated by the marketplace install. From a Kookr checkout:

```
git clone https://github.com/kookr-ai/kookr.git
bash kookr/scripts/install-hooks.sh
```

`install-hooks.sh` symlinks:

- `~/.claude/skills/pr-contribution-excellence` → `<kookr>/plugin/skills/pr-contribution-excellence`
- `~/.claude/reviewer-specialists` → `<kookr>/plugin/reviewer-specialists`
- `~/.claude/hooks/{pr-workflow-gate,oss-stale-scout-gate,oss-contribution-gate,post-merge-keyword-scan}.sh` → `<kookr>/hooks/*`

and registers each hook in `~/.claude/settings.json`. Run `bash kookr/scripts/install-oss-tracking-hook.sh` to also wire the `oss-contribution-gate-posttool.sh` tracking hook. See [`docs/hooks-setup.md`](../docs/hooks-setup.md) for the full hook table, scope-list semantics, and uninstall recipe.

## Maintainer dev workflow

Skills are in `<kookr>/plugin/skills/`, agents in `<kookr>/plugin/agents/`. To iterate on the plugin from the Kookr source tree:

```
claude --plugin-dir ~/git/kookr/plugin
> /reload-plugins   # picks up edits without restart
```

Kookr's `ClaudeCodeAdapter` already injects `--plugin-dir` automatically for every spawned Claude Code agent, so any Kookr-spawned task sees the toolkit regardless of the consumer's plugin install state. Non-spawned Claude Code sessions can also use the same skills when the plugin is installed from the marketplace or synced into the user's Claude Code skill/plugin directories.

Content under `plugin/` is the canonical distributed toolkit content. It may
reach agents through Kookr's `--plugin-dir` injection, Claude Code plugin
installation, or local sync/symlink setup. It may contain both general-purpose
engineering guidance and Kookr-specific operational guidance when that guidance
is useful outside the Kookr source repository.

The project-scope `.claude/skills/` and `.claude/agents/` directories are for
skills and agents whose natural cwd is the Kookr repository itself, such as
editing Kookr source, tests, hooks, release scripts, or repo-local architecture
docs. Do not keep Kookr runtime-operation skills there if agents need them while
working in other repositories.

## Versioning

`plugin.json#version` is bumped on every PR that changes bundled plugin content under `plugin/**` except `plugin/.claude-plugin/plugin.json` itself (skills, agents, hooks, playbooks, reviewer specialists, README, etc.). Without a version bump, installed-plugin users would not receive updates. The repo's pre-push hook enforces the bump.

## License

Apache-2.0 — see [the Kookr repo](https://github.com/kookr-ai/kookr).
