---
name: placement-picker
description: >
  Decide where to place a new rule, skill, hook, KB entry, agent, CLAUDE.md
  rule, memory, or context artifact. Use when choosing among user, project,
  plugin, hook, memory, and knowledge-base surfaces, especially before saving a
  behavioral rule or feedback memory.
keywords: >
  where to save, where does this go, placement, which CLAUDE.md, plugin skill,
  project skill, persist rule, save rule, store rule, hook or skill, memory or
  skill, which scope, user scope, project scope, placement decision, where to
  put, save this, where should this go, where do I add, scope, persistence
related: self-reflect, task-feedback-reflect
---

# Placement Picker

Use this before persisting rules, workflow corrections, skills, hooks, agents,
knowledge, or context. The goal is to put the artifact where every intended
agent can see it, without duplicating the same rule across multiple surfaces.

## Surface Inventory

| # | Surface | Path | Audience | Claude Code | Codex CLI | Plugin-shipped |
|---|---|---|---|---|---|---|
| 1 | User CLAUDE.md | `~/.claude/CLAUDE.md` | this machine, all projects | yes | yes | no |
| 2 | Project CLAUDE.md | `<repo>/CLAUDE.md` | this repo | yes | yes | with repo |
| 3 | Project memory | `~/.claude/projects/<slug>/memory/*.md` | Claude Code in this project | yes | no | no |
| 4 | User skills | `~/.claude/skills/<name>/SKILL.md` | this machine, all projects | yes | yes | no |
| 5 | Project skills | `<repo>/.claude/skills/<name>/SKILL.md` | this repo | yes | yes | with repo |
| 6 | Plugin skills | `<repo>/plugin/skills/<name>/SKILL.md` | toolkit users in every repo | yes | yes | yes |
| 7 | User hooks | `~/.claude/hooks/*.sh` + settings | this machine | yes | partial | no |
| 8 | Project hooks | `<repo>/hooks/*.sh`, `<repo>/.hooks/*` | this repo after install | yes | partial | no |
| 9 | Plugin hooks | `<repo>/plugin/hooks/*.sh` + `plugin/hooks/hooks.json` | toolkit users | yes | no via current Kookr Codex `--plugin-dir` | yes |
| 10 | Knowledge base | `~/knowledge_bases/<kb-name>/` | this machine | via shell | via shell | no |
| 11 | Project agents | `<repo>/.claude/agents/*.md` | this repo | yes | yes | with repo |
| 12 | Plugin agents | `<repo>/plugin/agents/*.md` | toolkit users | yes | yes | yes |

## Decision Tree

Q1: What kind of artifact is this?

| Kind | Meaning |
|---|---|
| (a) Rule | "do X before Y", "never use Z", "always run W" |
| (b) Context | who, why, project history, stakeholder facts |
| (c) Procedure | repeatable multi-step workflow |
| (d) Guard | deterministic shell-detectable wrong behavior |
| (e) Domain knowledge | reusable external or operational knowledge |

Q2: Who needs to see or follow it?

| Scope | Meaning |
|---|---|
| (s1) Me, all projects | personal workflow across this machine |
| (s2) This repo | every agent working in this repository |
| (s3) Toolkit users | every `kookr-toolkit` user, across repos |
| (s4) This repo's internals | repo-specific workflow surface; in Kookr, use `kookr-` prefix |

Q3: Must Codex CLI see it? Default to yes for rules, procedures, and guards.
Memory and current plugin hooks are the main "no" answers.

## Routing Matrix

| Kind / Scope | (s1) me, all projects | (s2) this repo | (s3) toolkit users | (s4) repo internals |
|---|---|---|---|---|
| (a) Rule | user CLAUDE.md | project CLAUDE.md | plugin skill with rule-shaped frontmatter | `.claude/skills/<prefix>-<name>/` + CLAUDE.md pointer |
| (b) Context, cross-runtime | user CLAUDE.md | project CLAUDE.md | usually n/a | project CLAUDE.md |
| (b) Context, Claude-Code-only acceptable | project memory | project memory | n/a | project memory |
| (c) Procedure | user skill | project skill | plugin skill | `.claude/skills/<prefix>-<name>/` |
| (d) Guard | user hook | project hook | plugin hook + `plugin/hooks/hooks.json` | project hook |
| (e) Domain knowledge | KB via `kb remember` | repo docs or project KB | usually n/a | repo docs |

For Kookr itself, (s4) skill and agent names use the `kookr-` prefix. Published
plugin skills and agents must not use that prefix.

## Calibration

For rules, procedures, and guards, ask:

> Will this still work on Codex CLI tomorrow, in a toolkit user's repo, on a
> different machine?

If any part is "no", reduce the scope or choose a more visible surface. Do not
use Claude Code memory for behavioral rules; memory is for context about who and
why, not instructions about how to work.

## Worked Examples

- A universal preference like "always show the PR URL when done" belongs in
  user CLAUDE.md.
- A project-specific deployment command belongs in project CLAUDE.md or a
  project-internal skill.
- A repeatable debugging workflow for any TypeScript project belongs in a
  plugin skill.
- A shell-detectable mistake, such as adding a `kookr-` skill under
  `plugin/skills/`, belongs in a hook.
- A machine-specific note about where a daemon stores state belongs in the
  knowledge base.
- A project-history fact like "this RFC was accepted after the May 2026 probe"
  belongs in memory or repo docs, depending on whether Codex also needs it.

## Anti-Patterns

- Saving a behavioral rule as memory because it is quick.
- Duplicating the same picker body in CLAUDE.md and multiple skills.
- Putting Kookr-internal instructions in a published plugin skill.
- Putting general-purpose toolkit guidance under `.claude/skills/kookr-*`.
- Adding semantic body-text heuristics to hooks when a path-only check would be
  deterministic.

## Fallbacks

If you are in a repo that consumes the toolkit but cannot edit `plugin/`, use the
nearest visible local surface and make the limitation explicit:

- plugin skill unavailable: use project or user skill, then upstream the generic
  pattern later.
- plugin hook unavailable: use project hook or pre-push check.
- memory would be invisible to Codex: use CLAUDE.md or a skill instead.

For skill and agent naming details, defer to the Kookr skill/agent distribution
rules. For runtime hook coverage details, defer to the Codex compatibility POCs.
