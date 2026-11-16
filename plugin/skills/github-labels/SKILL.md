---
name: github-labels
group: oss-contribution
description: Which GitHub labels to apply on kookr-ai/kookr issues and PRs, and how to check a repository's real label set first. Use when creating issues, PRs, or triaging work.
user_invocable: false
related: github-issue-workflow
---

# GitHub Labels — kookr-ai/kookr

Apply only labels that already exist on the repository. A label name that does
not exist makes `gh issue create --label` / `gh pr create --label` fail, and the
REST labels endpoint silently creates a new, undocumented label instead. Do not
invent a taxonomy (`type: chore`, `status: blocked`, `phase: 2`, ...) and do not
create labels to make one fit.

## Step 1 — check the real label set

This skill ships in the `kookr-toolkit` plugin and runs in other repositories
too. The tables below describe kookr-ai/kookr only; they say nothing about any
other repository. Before applying a label, list what the target repository
actually has:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# The repo carries hundreds of generated idea:<n> join keys; hide them.
gh label list --repo "$REPO" --limit 1000 --json name,description \
  -q '.[] | select(.name | test("^idea[:-]") | not) | "\(.name)\t\(.description)"'
```

If a label you want is not in that output, leave it off. Labels are optional;
a wrong one is worse than none.

## Step 2 — pick labels (kookr-ai/kookr)

Checked against `gh label list` on 2026-11-15. Every label named here exists on
kookr-ai/kookr; re-run Step 1 if something looks missing.

### Kind of work (usually one)

| Label | When to use |
|---|---|
| `bug` | Something is broken or behaves incorrectly ("did it used to work?" yes) |
| `enhancement` | New capability or improvement to existing behavior — the default for feature work |
| `documentation` | Docs-only change |
| `architecture` | Architecture health: boundaries, coupling, structural drift |
| `question` | A question, not a work item |

### Backlog gating (issues)

| Label | When to use |
|---|---|
| `blocked` | Waiting on a human decision or an external dependency |
| `automation-blocked` | Not implementable by an autonomous agent until a human decides or rewrites it; issue-draining automation skips these |
| `invariant-gate` | Needs an invariant spec before it may be drained (#1568) |

### Initiative / milestone tracking (issues)

| Label | When to use |
|---|---|
| `public-launch` | Prerequisites and improvements for opening the repo to the public |
| `required` | Must be addressed before its milestone can ship |
| `optional` | Nice to have; can be deferred or closed without blocking |
| `remote-collaboration` | Remote collaboration architecture work |
| `autonomous-evolution` | Follow-up slices of the autonomous evolution playbook (RFC #1061) |

### Merge and CI workflow (PRs)

| Label | When to use |
|---|---|
| `local-verified` | CI never executed (Actions budget block) and the local gate passed; `kookr merge` requires it plus a local-gate comment bound to the head SHA |
| `macos` | Runs the macOS CI job on this PR — add it for changes to shell scripts, hooks, or other platform-sensitive code |
| `merge-conflict` | Set by the merge watchdog when it cannot auto-resolve a base conflict |
| `review-skipped-timeout` | Telemetry only: the independent review timed out; it never waives the review gate |

### Set by automation — do not apply by hand

| Label | Set by |
|---|---|
| `idea-scout`, `idea:<n>` | The Repository Idea Scout playbook (provenance and conversion join keys) |
| `review-followup` | The `independent-merge-review` skill: the one issue per PR holding the defects its review left for later (#3903) |
| `dependencies`, `javascript`, `python`, `github_actions` | Dependabot |

### Rarely used

These exist but are applied to only a handful of issues and PRs. Use them when
they clearly fit; nothing depends on them being present.

- Area: `area: core`, `area: server`, `area: frontend`, `area: cli`, `area: adapters`
- Priority: `priority: high`, `priority: medium` (no low or critical priority label exists)
- Type: `type: feature`, `type: refactor`, `type: test`, `type: security`, `type: performance`
- Other: `status: needs review`, `dx`
- GitHub defaults: `good first issue`, `help wanted`, `duplicate`, `invalid`, `wontfix`

## Applying labels via CLI

```bash
# At creation time (fails loudly if a label does not exist)
gh issue create --repo "$REPO" --title "..." --body "..." --label bug
gh pr create --title "..." --body "..." --label documentation

# Afterwards
gh issue edit 123 --repo "$REPO" --add-label "enhancement"
gh pr edit 456 --repo "$REPO" --add-label "local-verified"
```

Prefer `gh issue edit` / `gh pr edit --add-label` over
`gh api repos/<owner>/<repo>/issues/<n>/labels -X POST`: the `gh` subcommands
reject an unknown label, while the API call creates it.
