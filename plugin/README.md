# Kookr Toolkit — Claude Code Plugin

Skills and review subagents extracted from [Kookr](https://github.com/kookr-ai/kookr) for use with Claude Code in any project.

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

**Workflow:** `git-commit-discipline`, `tdd-workflow`, `token-efficiency`, `claude-code-metrics-analysis`, `hook-driven-workflow-enforcement`, `e2e-agent-testing`, `github-issue-workflow`, `github-trending-repos`.

**OSS contribution:** `oss-fork-manager`, `oss-pr-{critic,distill,plan,threshold}`, `pr-review-triage`, `pr-contribution-excellence`, `find-best-reviewers`, `rust-lang-rust-{tests,pre-push}`.

**Reviewer distillation experiment:** `reviewer-distillation-{judge,mutate,predict,prepare,select,meta}`.

**Codex PR analysis:** `codex-pr-{critic,distill,plan,threshold}`.

**Review subagents (15):** `api-surface-auditor`, `architecture-drift-detector`, `architecture-smell-scanner`, `boundary-critic`, `delivery-pragmatist`, `dependency-graph-analyzer`, `design-experimenter`, `design-minimalist`, `failure-mode-analyst`, `module-interface-auditor`, `operability-reviewer`, `socratic-challenger`, `state-machine-verifier`, `test-fixer`, `test-quality-reviewer`.

## Maintainer dev workflow

Skills are in `<kookr>/plugin/skills/`, agents in `<kookr>/plugin/agents/`. To iterate on the plugin from the Kookr source tree:

```
claude --plugin-dir ~/git/kookr/plugin
> /reload-plugins   # picks up edits without restart
```

Kookr's `ClaudeCodeAdapter` already injects `--plugin-dir` automatically for every spawned Claude Code agent, so any Kookr-spawned task sees the toolkit regardless of the consumer's plugin install state.

Content under `plugin/` must stay portable for developers who install the toolkit outside the Kookr repo. Do not add Kookr runtime variables, local Kookr state paths, or Kookr development commands here, even behind fallback guards. Kookr-aware personal playbooks belong in the user playbook tier; Kookr project-only skills, agents, and playbooks belong in the repo's project-scope directories.

## Versioning

`plugin.json#version` is bumped on every PR that changes `plugin/skills/**` or `plugin/agents/**`. Without a version bump, installed-plugin users would not receive updates. The repo's pre-push hook enforces the bump.

## License

Apache-2.0 — see [the Kookr repo](https://github.com/kookr-ai/kookr).
