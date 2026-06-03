---
name: kookr-skill-naming-convention
description: Where Kookr skills and agents live (.claude vs plugin) and how to name them. Repo-local Kookr work lives in .claude/ with `kookr-`; Kookr-distributed and general reusable skills live in plugin/. Use this skill before creating, renaming, or promoting a skill or agent.
keywords: skill, agent, naming, convention, plugin, kookr, prefix, promote, marketplace, manifest, organization, subagent
related: rfc-iterative-review
---

# Kookr skill + agent naming + placement convention

## When to use

- Creating a new skill or agent in the Kookr repo.
- Promoting a skill/agent from `.claude/` to `plugin/` (or the reverse).
- Renaming an existing artifact that violates the convention below.
- Reviewing a PR that adds or renames a skill or agent.

## The two locations

```
~/git/kookr/
├── .claude/
│   ├── skills/          ← KOOKR REPO-LOCAL skills: dirs MUST start with `kookr-`
│   └── agents/          ← KOOKR REPO-LOCAL agents: files MUST start with `kookr-`
└── plugin/
    ├── skills/          ← DISTRIBUTED skills for Kookr-spawned agents in any cwd
    └── agents/          ← DISTRIBUTED agents for Kookr-spawned agents in any cwd
```

`.claude/` artifacts are invisible to other projects — they only load when Claude
Code is opened inside `$HOME/git/kookr/`. Use this tier only for skills and
agents whose natural working directory is the Kookr repository itself: editing
Kookr source, maintaining Kookr tests, or inspecting Kookr repo-local state.

`plugin/` is the distributed Kookr Toolkit. Kookr injects it into spawned agents
regardless of their cwd, so it is the right home for both:

- Kookr-specific operational skills that agents need while working in other
  repositories, such as spawning, supervising, or coordinating Kookr tasks.
- General-purpose engineering skills that are useful beyond Kookr.

The `hooks/skill-placement-gate.sh` script (called from `.hooks/pre-push`) enforces every rule below on push. CI does not duplicate it; the hook is the single enforcement boundary.

## The naming rule

| Location | Name pattern | Example |
|---|---|---|
| `.claude/skills/` (Kookr repo-local) | **must start with `kookr-`** | `kookr-shadow-detection`, `kookr-pre-push` |
| `.claude/agents/` (Kookr repo-local) | **must start with `kookr-`** | `kookr-oss-issue-scout.md` |
| `plugin/skills/` (distributed toolkit) | `kookr-*` for Kookr-domain skills; unprefixed for general skills | `kookr-cli`, `architecture-drift-signals` |
| `plugin/agents/` (distributed toolkit) | `kookr-*` allowed for Kookr-domain agents; unprefixed for general agents | `kookr-task-supervisor.md`, `boundary-critic.md` |

The `kookr-` prefix means "this skill or agent is about Kookr as a product or
runtime." That can be true in either tier. The directory decides visibility:
repo-local Kookr maintenance goes in `.claude/`; Kookr runtime operations that
agents need from any repository go in `plugin/`.

## How to decide if a skill should be kookr-internal vs published

A skill is **Kookr repo-local** (must live in `.claude/skills/kookr-*`) if it is
only meaningful while the agent's cwd is the Kookr repository, for example:

- Editing Kookr source files, tests, hooks, build scripts, or dashboard internals.
- Maintaining Kookr repo-local release, pre-push, placement, or architecture
  conventions.
- Inspecting implementation details that only exist in the Kookr checkout.

A skill is **distributed** (must live in `plugin/skills/`) if it is useful to a
Kookr-spawned agent outside the Kookr repository, including:

- Kookr operational workflows, such as spawning child tasks, supervising task
  chains, or using Kookr CLI/API commands while working in another repo.
- General code patterns, workflows, and meta-skills that are not specific to
  Kookr source maintenance.

## Promotion workflow (repo-local → distributed)

1. Audit whether the skill is tied to the Kookr repo cwd. If not, it belongs in
   `plugin/`.
2. If the skill has scripts, audit whether they require the Kookr source tree as
   cwd. Runtime paths such as the Kookr daemon API or `kookr-spawn` can be valid
   distributed behavior.
3. `git mv .claude/skills/kookr-<slug> plugin/skills/<slug>`. Keep the
   `kookr-` prefix when the skill is about Kookr runtime operations; drop it only
   when the promoted skill is genuinely general-purpose.
4. Update the `name:` field in the SKILL.md frontmatter to match the new
   directory name.
5. Update any `related:` references in OTHER skills' frontmatter that pointed at the old name.
6. Bump `plugin/.claude-plugin/plugin.json` version (patch bump for additive promotion).
7. Open a PR titled `feat: promote <skill> to plugin`.

## Demotion workflow (published → kookr-internal)

Rare. Only do this if a distributed skill turns out to require working inside
the Kookr repository rather than using Kookr from another repo.

1. `git mv plugin/skills/<slug> .claude/skills/kookr-<slug>`.
2. Add the `kookr-` prefix to the `name:` field.
3. Update `related:` cross-references.
4. Bump plugin version (patch bump).
5. Open a PR titled `chore: demote <skill> to kookr-internal — <reason>`.

## When in doubt

Default to asking whether the agent needs this while its cwd is outside
`~/git/kookr`. If yes, use `plugin/`. If no, use `.claude/skills/kookr-*`.

## Anti-patterns to call out in review

- **`.claude/skills/foo/`** without the `kookr-` prefix — repo-local Kookr
  skills must be visibly Kookr-specific.
- **A Kookr runtime skill kept in `.claude/skills/` even though agents need it
  outside the Kookr repo** — move it to `plugin/skills/`, usually keeping the
  `kookr-` prefix.
- **A distributed skill that assumes the Kookr source checkout as cwd** — either
  move it back to `.claude/skills/kookr-*` or rewrite it to operate from any cwd.
- **Renaming a published skill without bumping the plugin version** — breaks every project that referenced the old name.
- **Unqualified `subagent_type` references inside a skill body** — calling `Agent` with a bare agent name does NOT resolve for plugin-namespaced agents. The qualified `kookr-toolkit:<name>` form is required. The placement gate rejects bare names on push.
- **Project-scope agents without the `kookr-` prefix** — bypass-mode strips `--setting-sources` and these would silently disappear. The gate enforces the prefix; kookr-prefixed agents are permitted because they're only useful inside the kookr repo anyway.
