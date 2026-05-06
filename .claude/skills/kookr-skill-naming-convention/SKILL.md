---
name: kookr-skill-naming-convention
description: Where Kookr skills live (.claude/skills/ vs plugin/skills/) and how to name them. Kookr-internal skills MUST be prefixed `kookr-`; project-agnostic skills go in plugin/skills/ unprefixed. Use this skill before creating, renaming, or promoting a skill.
keywords: skill, naming, convention, plugin, kookr, prefix, promote, marketplace, manifest, organization
related: oss-task-checkpointing, rfc-iterative-review
---

# Kookr skill naming + placement convention

## When to use

- Creating a new skill in the Kookr repo.
- Promoting a skill from `.claude/skills/` to `plugin/skills/` (or the reverse).
- Renaming an existing skill that violates the convention below.
- Reviewing a PR that adds or renames a skill.

## The two locations

```
~/git/kookr/
├── .claude/skills/      ← KOOKR-INTERNAL: only loaded when working inside the kookr repo itself
└── plugin/skills/       ← PUBLISHED PLUGIN: shipped via the kookr-toolkit marketplace plugin to every project that installs it
```

A skill in `.claude/skills/` is invisible to other projects — it only loads when Claude Code is opened inside `$HOME/git/kookr/`. Anything that should be reusable across all projects MUST live in `plugin/skills/`.

## The naming rule

| Location | Name pattern | Example |
|---|---|---|
| `.claude/skills/` (kookr-internal) | **must start with `kookr-`** | `kookr-shadow-detection`, `kookr-supervise-tasks` |
| `plugin/skills/` (published) | **must NOT start with `kookr-`** (unless the skill is genuinely about Kookr itself, which is rare and a code smell — most published skills should be domain-named) | `architecture-drift-signals`, `oss-task-checkpointing` |

The `kookr-` prefix exists for one reason: when a Kookr-internal skill leaks into a `~/.claude/plugins/marketplaces/kookr/.claude/skills/` mirror or shows up in `/skills` output in another project, the prefix makes it obvious this skill is about Kookr internals — not generally applicable. If the prefix isn't there, a user from another project might trigger the skill expecting it to apply to their codebase, then waste minutes discovering it's about Kookr's terminal backend.

## How to decide if a skill should be kookr-internal vs published

A skill is **kookr-internal** (must live in `.claude/skills/kookr-*`) if its body references one or more of:

- Kookr-specific code paths (`bin/kookr-*`, `src/`, dashboard endpoints, anomaly-detector internals).
- Kookr-specific data sources (`~/.kookr/tasks.json`, `~/.kookr/hooks/*.jsonl`, `~/.kookr/contribution-ledger.jsonl`).
- Kookr-specific concepts that wouldn't translate (playbooks, shadow detection, supervisor sessions, dtach backend).
- The `oss-gate` CLI or other Kookr-installed binaries.

A skill is **publishable** (must live in `plugin/skills/` without the `kookr-` prefix) if its body is about:

- A general code pattern (TypeScript types, dependency injection, DDD, etc.).
- A general workflow (RFC drafting, OSS contribution recon, PR review).
- A general meta-skill (self-reflection, architecture-drift detection, MBSE modeling).
- Any pattern that another project could apply by reading the SKILL.md without needing to know what Kookr is.

## Promotion workflow (kookr-internal → published)

1. Audit the SKILL.md for Kookr-specific references. Anything that fails the "publishable" test above must be either generalized or removed.
2. If the skill has scripts, audit those too — a script that reads `~/.kookr/...` is kookr-internal even if the SKILL.md isn't.
3. `git mv .claude/skills/kookr-<slug> plugin/skills/<slug>` (drop the `kookr-` prefix on promotion).
4. Update the `name:` field in the SKILL.md frontmatter to match the new directory name.
5. Update any `related:` references in OTHER skills' frontmatter that pointed at the old name.
6. Bump `plugin/.claude-plugin/plugin.json` version (patch bump for additive promotion).
7. Open a PR titled `feat: promote <skill> to plugin`.

## Demotion workflow (published → kookr-internal)

Rare. Only do this if a published skill turns out to be Kookr-coupled in a way that can't be cleanly removed.

1. `git mv plugin/skills/<slug> .claude/skills/kookr-<slug>`.
2. Add the `kookr-` prefix to the `name:` field.
3. Update `related:` cross-references.
4. Bump plugin version (patch bump).
5. Open a PR titled `chore: demote <skill> to kookr-internal — <reason>`.

## When in doubt

Default to kookr-internal (`.claude/skills/kookr-<name>/`). It's cheaper to promote a skill later (when the generic pattern becomes obvious) than to demote one (which forces every existing user to either delete the now-irrelevant skill or carry it forever).

## Anti-patterns to call out in review

- **`plugin/skills/kookr-foo/`** — wrong directory for a Kookr-prefixed skill. Either drop the prefix (skill is generic enough to publish) or move to `.claude/skills/kookr-foo/` (skill is Kookr-internal and shouldn't be published).
- **`.claude/skills/foo/`** without the `kookr-` prefix — either the skill is genuinely generic (move to `plugin/skills/foo/`) or it's Kookr-internal and needs the prefix.
- **A "generic" skill that has `~/.kookr/...` paths in its body** — it isn't generic. Promote only after the paths are abstracted out.
- **Renaming a published skill without bumping the plugin version** — breaks every project that referenced the old name.
