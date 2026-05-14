---
name: placement-picker
description: >
  Decide where to place a new rule, skill, hook, KB entry, or context artifact —
  user CLAUDE.md vs project CLAUDE.md vs plugin skill vs project skill vs hook
  vs memory vs knowledge base. Use whenever you need to persist anything and
  are choosing among 12 surfaces, especially before saving a feedback memory
  or adding a CLAUDE.md rule.
keywords: >
  where to save, where does this go, placement, which CLAUDE.md, plugin skill,
  project skill, persist rule, save rule, store rule, hook or skill, memory
  or skill, which scope, user scope, project scope, placement decision, where
  to put, save this, where should this go, where do I add, scope, persistence
related: self-reflect, task-feedback-reflect, kookr-codex-claude-compatibility
---

# Placement Picker

Routes a new rule, skill, hook, KB entry, or context artifact to the correct surface among 12 placement options. The canonical body for placement decisions in repos using the kookr-toolkit plugin; pointer stubs in `<repo>/CLAUDE.md`, `~/.claude/CLAUDE.md`, `self-reflect`, and `task-feedback-reflect` all defer to this skill.

## When to load this skill

Any time you're about to persist something — a behavioral rule, a workflow correction, a piece of context, a new playbook, a guard, a piece of domain knowledge — and you're unsure which surface gets it.

**Especially trigger this skill when** you're tempted to save a feedback memory. The system-prompt `# auto memory` section actively trains you toward memory as a default. For Kookr-related work this is wrong: Codex CLI cannot read Claude Code's memory system, so anything memory-saved is invisible to half the runtime.

## Surface inventory

The 12 placement surfaces, with their runtime visibility and shipping mechanism:

| # | Surface | Path | Claude Code | Codex CLI | Plugin-shipped | Propagation |
|---|---|---|---|---|---|---|
| 1 | User CLAUDE.md | `~/.claude/CLAUDE.md` | yes | yes | no | next session |
| 2 | Project CLAUDE.md | `<repo>/CLAUDE.md` | yes | yes | with repo | next session |
| 3 | Project memory | `~/.claude/projects/<slug>/memory/*.md` | yes | **NO** | no | immediate |
| 4 | User skill | `~/.claude/skills/<name>/SKILL.md` | yes | yes | no | next session |
| 5 | Project skill | `<repo>/.claude/skills/<name>/SKILL.md` | yes | yes | with repo | next session |
| 6 | Plugin skill | `<repo>/plugin/skills/<name>/SKILL.md` | yes (`--plugin-dir`) | yes (dir-symlink overlay) | **yes** | on plugin update |
| 7 | User hook | `~/.claude/hooks/*.sh` + settings.json | yes | partial | no | next session |
| 8 | Project hook | `<repo>/hooks/*.sh` + install script | yes | partial | no — must install | one-shot |
| 9 | Plugin hook | `<repo>/plugin/hooks/*.sh` + `plugin/hooks/hooks.json` | yes | partial (Codex emits PreToolUse only on Bash) | **yes** | on plugin update |
| 10 | Knowledge base | `~/knowledge_bases/<kb>/` via `kb` CLI | via Bash | via Bash | no | immediate |
| 11 | Project agent | `<repo>/.claude/agents/*.md` | yes (NOT in bypass mode) | yes | with repo | next session |
| 12 | Plugin agent | `<repo>/plugin/agents/*.md` | yes | yes | yes | on plugin update |

**Codex visibility note**: Codex emits `PreToolUse` only for `Bash` (per PoC 003 §Gap 6). File-op hooks on `Write`/`Edit` paths don't fire on Codex. Plan accordingly when picking a hook surface.

## Decision tree

```
Q1: What KIND of artifact is this?
  (a) RULE / WORKFLOW STEP  — "do X before Y", "never use Z", "always run W"
  (b) CONTEXT — "who Jean is", "why we did X", "where bug tracker lives"
  (c) REUSABLE PROCEDURE — multi-step playbook
  (d) DETERMINISTIC GUARD — wrong behavior is shell-detectable
  (e) DOMAIN KNOWLEDGE — "how llama.cpp behaves", "WSL gotcha"

Q2: Who needs to follow / see it?
  (s1) ME on this machine, across all projects
  (s2) Every agent on this machine in THIS repo
  (s3) Every kookr-toolkit user, across every repo
  (s4) THIS repo's internal workflows only (kookr-prefix in kookr repo)

Q3: Must it be visible to Codex CLI?
  Default to YES unless you've confirmed every consumer is Claude Code only.
  In Kookr-related work, treat as YES by default — Codex agents run kookr
  tasks too. The only "no" answers are pure Claude-Code-only utilities.
```

## Routing matrix

| Kind \ Scope | (s1) me, all projects | (s2) this repo only | (s3) kookr-toolkit users, all repos | (s4) this repo's internal |
|---|---|---|---|---|
| (a) Rule | **User CLAUDE.md** | **Project CLAUDE.md** | **Plugin skill** with rule-shaped frontmatter | `<repo>/.claude/skills/<prefix>-<n>/` + project CLAUDE.md pointer |
| (b) Context (cross-runtime needed — Q3=yes) | User CLAUDE.md | Project CLAUDE.md | n/a (rare) | Project CLAUDE.md |
| (b) Context (Claude-Code-only fine — Q3=no) | Project memory | Project memory | n/a | Project memory |
| (c) Procedure | User skill | Project skill | **Plugin skill** | `<repo>/.claude/skills/<prefix>-<n>/` |
| (d) Guard | User hook | Project hook | **Plugin hook** (`plugin/hooks/*.sh` + `plugin/hooks/hooks.json`) | Project hook |
| (e) Domain knowledge | **KB** (`~/knowledge_bases/<kb>/`) via `kb remember` | Project KB / repo docs | n/a | Repo docs |

**Most-often-wrong cell**: **(a) Rule + (s3) all kookr-toolkit users**. Agents default to memory because of the auto-memory pull. The correct answer is a plugin skill. If you find yourself about to save a feedback memory for a behavioral rule that any kookr-toolkit user might encounter, stop — pick a plugin skill instead.

## Calibration question (rules / procedures / guards only)

For kinds (a), (c), (d), ask:

> *"Will this artifact still apply on Codex CLI tomorrow, in a kookr-toolkit-user's repo, on a different machine?"*

If any "no" → reduce scope. The picker's job is to find the LARGEST scope at which all three answers are "yes".

The calibration question does NOT apply to (b) context or (e) domain knowledge — those are often legitimately machine-local.

## Worked examples

### 1. "Agents should always run `pnpm typecheck` before pushing"

- Q1: (a) Rule
- Q2: who needs to follow? In kookr-related work it's any agent on any repo with TS tooling — (s3) kookr-toolkit users, all repos.
- Q3: yes — Codex agents also push.
- **→ Plugin skill** (or, if scoped to one repo only, Project CLAUDE.md). Memory is wrong: invisible to Codex.

### 2. "Jean is the project owner, prefers minimal code"

- Q1: (b) Context — about the user, not a workflow rule.
- Q2: (s1) me on this machine, across projects.
- Q3: this question matters: if you want Codex agents to see this too, route to user CLAUDE.md. If Claude-Code-only is fine, route to project memory.
- **→ User CLAUDE.md** (cross-runtime) **OR project memory** (Claude-Code-only acceptable).

### 3. "When generating a video, verify the artifact actually contains what was requested"

- Q1: (a) Rule (workflow correction).
- Q2: applies to any agent on any project producing artifacts — (s1) all my projects, or (s3) all kookr-toolkit users? If the rule is universal enough, (s3). If kookr-specific, (s2) project CLAUDE.md.
- Q3: yes.
- **→ Plugin skill** (if (s3)) **OR project CLAUDE.md** (if (s2)). [This was the actual decision behind PR #345 "Keep the deliverable inspectable" — it landed in project CLAUDE.md because the rule was grounded in kookr-specific incidents.]

### 4. "Run reviewer-specialist subagents in parallel before declaring a PR ready"

- Q1: (c) Reusable procedure — a multi-step playbook.
- Q2: (s3) all kookr-toolkit users — every PR in any repo using the plugin.
- Q3: yes.
- **→ Plugin skill** (this is the `pre-pr-review` skill, already shipped at `plugin/skills/pre-pr-review/`).

### 5. "Refuse to push if a per-branch review marker file is missing"

- Q1: (d) Deterministic guard — shell-detectable.
- Q2: (s2) this repo's pushes. Other repos may not have this gate.
- Q3: yes.
- **→ Project-scoped git pre-push hook**, wired via `git config core.hooksPath` to a checked-in directory and installed via the host repo's own install script. Path-specific examples live in the host repo's own docs, not in this plugin skill.

### 6. "WSL on Windows 11 with `llama-server` IQ3_XXS quants causes warmup hangs"

- Q1: (e) Domain knowledge — about how a tool actually behaves.
- Q2: (s1) me on this machine — this is a per-machine truth.
- Q3: doesn't apply (knowledge, not rule).
- **→ Knowledge base** (`~/knowledge_bases/operating-environment/`) via `kb remember`. NOT memory: memory is for project context, KB is for tool/environment knowledge.

## Anti-patterns

- **Saving a behavioral rule as memory.** The system-prompt auto-memory pull is strong, but for any kookr-related rule (anything Codex agents might need to follow) memory is invisible to half the runtime. Pick CLAUDE.md, skill, or hook.
- **Putting kookr-specific content in user CLAUDE.md.** Cross-project pollution. If only kookr-toolkit users need this rule, it belongs in a plugin skill. If only the kookr repo needs it, project CLAUDE.md.
- **Enforcement hook in `<repo>/hooks/` when it should ship to all kookr-toolkit users.** Project hooks require per-repo install. Plugin hooks propagate automatically. If the rule is for kookr-toolkit users in any repo, use `plugin/hooks/`.
- **Duplicating skill content between `.claude/skills/` and `plugin/skills/`.** User-scope skills shadow plugin-scope on collision. The `placement-gate` hook (Check 3) warns on this; `skill-placement-gate.sh` blocks it at push time.
- **Heuristic body-text matching to detect "behavioral rule" in memory writes.** Brittle (every prose paragraph triggers); the v1 of this RFC's gate tried it and was rejected by round-1 critics. Use the structural `metadata.type` frontmatter signal instead (owned by `reflect-memory-frontmatter-gate.sh`).

## Surface-not-available fallback

If you're a kookr-toolkit user without a writable `plugin/` tree (you have the plugin installed but don't have permission to publish skills to it), the routing for (s3) cells degrades as follows:

- **(a) Rule + (s3)** → next-best is `~/.claude/CLAUDE.md` (covers s1 on this machine; lose cross-user reach).
- **(c) Procedure + (s3)** → next-best is `~/.claude/skills/<name>/SKILL.md` (covers s1 on this machine).
- **(d) Guard + (s3)** → next-best is `~/.claude/hooks/*.sh` + `~/.claude/settings.json` registration (covers s1 on this machine).

For team-wide (s3) reach without write access to kookr-toolkit, you need your own plugin (forked from kookr-toolkit or independently authored).

## Enforcement

The `placement-gate` plugin hook (in `plugin/hooks/`) fires at PreToolUse time to warn on path-prefix violations (advisory by default; strict-mode via `<repo>/.kookr-placement-gate-strict` sentinel file). For repos that ship their own tree-scanner gate (run from `<repo>/hooks/` at push time), that gate remains the catch-net for things the plugin hook misses (e.g. Codex `apply_patch` which emits no PreToolUse). Memory-frontmatter content is enforced separately by the sibling `reflect-memory-frontmatter-gate.sh` plugin hook.

## Related

- `kookr-toolkit:self-reflect` — uses this picker during Step 3 (propose remediation) of the reflection workflow.
- `kookr-toolkit:task-feedback-reflect` — uses this picker for thumbs-up/down feedback persistence.
- `kookr-toolkit:kookr-codex-claude-compatibility` — documents runtime-visibility constraints that drive the cross-runtime calibration question.
- `docs/rfc/rfc-skill-agent-distribution.md` — skill/agent-specific placement rules (defer to it for those specifics).
- `docs/rfc/rfc-unified-placement-picker.md` — the design RFC for this skill (review history, alternatives, decisions).
