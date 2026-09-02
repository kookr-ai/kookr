---
name: github-labels
description: GitHub label taxonomy for kookr-ai/kookr. Use when creating issues, PRs, or triaging work to apply correct labels.
user_invocable: false
related: github-issue-workflow
---

# GitHub Labels — kookr-ai/kookr

When creating or updating issues and PRs, apply labels from the categories below. Every issue/PR should have at least one **type** label and one **area** label. Add **priority** and **phase** labels when known.

## Label taxonomy

### Type (pick one — what kind of work is this?)

| Label | When to use |
|---|---|
| `bug` | Something is broken or behaving incorrectly |
| `type: feature` | New user-facing capability or behavior |
| `enhancement` | Improvement to existing functionality |
| `type: refactor` | Code restructuring with no behavior change |
| `type: test` | Adding or improving tests (unit, integration, E2E) |
| `type: chore` | Build system, CI, tooling, dependency updates |
| `type: design` | ADR, RFC, or architecture proposal |
| `type: spike` | Research, proof-of-concept, or exploration |
| `type: security` | Security vulnerability, fix, or hardening |
| `type: performance` | Performance regression or optimization |
| `documentation` | Docs-only changes (README, feature specs, guides) |

### Priority (pick one — how urgent?)

| Label | When to use |
|---|---|
| `priority: critical` | Blocks release or causes data loss — drop everything |
| `priority: high` | Important, resolve in current work cycle |
| `priority: medium` | Normal priority, scheduled for near-term |
| `priority: low` | Nice to have, no time pressure |

### Status (pick one — current state)

| Label | When to use |
|---|---|
| `status: needs triage` | New issue, not yet prioritized or assigned |
| `status: in progress` | Actively being worked on |
| `status: blocked` | Waiting on external dependency or decision |
| `status: needs review` | PR or design ready for review |
| `status: stale` | No activity for 30+ days, needs re-evaluation |

### Area (pick all that apply — which parts of the codebase?)

| Label | Scope |
|---|---|
| `area: core` | `src/core/` — types, parsers, task store, anomaly detection, attention queue |
| `area: adapters` | `src/adapters/` — terminal manager interface, tmux impl, Claude Code adapter |
| `area: server` | `src/server/` — HTTP (Hono), WebSocket, hook file watcher, reconciliation |
| `area: frontend` | `src/frontend/` — React SPA, components, Zustand store, WebSocket hook |
| `area: cli` | CLI entry point, command parsing, `npx kookr` startup |
| `area: supervisor` | Supervisor agent logic: anomaly detection, explanations, attention routing |
| `area: e2e` | `e2e/` — Playwright E2E tests and canary validation |

### Phase (pick one if applicable — roadmap alignment)

| Label | Milestone |
|---|---|
| `phase: 1` | Foundation + Managed Terminal Sessions |
| `phase: 2` | GUI + Multi-Agent |
| `phase: 3` | The Loop (V1 Complete) |
| `phase: 4` | V2: Multi-agent-type support + polish |

### Workflow (add when relevant)

| Label | When to use |
|---|---|
| `breaking change` | Introduces an incompatible API or behavior change |
| `needs adr` | Requires an Architecture Decision Record before starting work |
| `needs rfc` | Requires an RFC before starting work |
| `tech debt` | Known shortcut or quality issue to address later |
| `dependencies` | Dependency updates (Dependabot, manual upgrades) |
| `ci/cd` | CI pipeline, GitHub Actions, deployment configuration |
| `dx` | Developer experience improvement (tooling, ergonomics) |
| `good first issue` | Accessible for newcomers to the project |
| `help wanted` | Extra attention or external contributions welcome |
| `duplicate` | Already tracked in another issue |
| `wontfix` | Intentionally not going to be addressed |

## Decision rules

1. **Every issue/PR gets a type label.** If unsure between `bug` and `enhancement`, ask: "Did it used to work?" Yes = `bug`. No = `enhancement` or `type: feature`.
2. **Every issue/PR gets at least one area label.** Cross-cutting changes get multiple area labels.
3. **Use `type: design` + `needs adr`** for proposals that change architecture decisions.
4. **Use `type: spike`** for time-boxed investigation that may not produce shippable code.
5. **`priority: critical`** should be rare — reserve for data loss, security incidents, or release blockers.
6. **Phase labels** connect work to the roadmap. Apply when the issue clearly belongs to a specific phase.
7. **`status: needs triage`** is the default for new issues. Remove it once priority and assignment are set.
8. **`breaking change`** requires a note in the PR description explaining the migration path.

## Applying labels via CLI

```bash
# On issues
gh api repos/kookr-ai/kookr/issues/{number}/labels -X POST --input - <<< '{"labels":["bug","area: core","priority: high"]}'

# On PRs (PRs are issues in the GitHub API)
gh api repos/kookr-ai/kookr/issues/{number}/labels -X POST --input - <<< '{"labels":["type: feature","area: frontend","phase: 2"]}'
```
