---
name: notebook-role-reuse
description: >
  Spawn an agent so it REUSES an existing Agent Notebook role — loading that
  role's accumulated lessons at the start and writing new ones back to the same
  notebook before it returns. Use whenever you spawn a general-purpose (or named)
  subagent to do domain work other agents have done before: code review, repo
  mapping, patching, reproduction, design critique, and so on. Also use when you
  want the orchestrator to discover emergent roles and reuse them.
keywords: nb, agent notebook, role, reuse, spawn subagent, lessons, memory, nb roles, nb show, nb add, emergent role
related: [pre-pr-review, self-continuation-task]
---

# Reusing an Agent Notebook role across spawned agents

An Agent Notebook role is a bounded, voted store of one-line lessons kept in one
file, `~/.kookr/notebooks/<role>.md` (git-backed; every write is auto-committed).
**Role resolution is exact-string** — there is no fuzzy matching and no fallback.
So "reuse a role" means exactly one thing: spawn the agent with the **exact
existing role name** in its prompt, plus the show/add ritual. Pass the real
string and the new agent inherits every past lesson and adds to the same file;
pass a near-miss (`code-reviewer` for `code-review`) and you silently create a
new, empty orphan notebook.

A subagent gets **no** automatic notebook injection (no `NB_ROLE`, no
SessionStart hook fires for it). The role reaches it **only** through the prompt
you write. That is the whole mechanism — and it means the orchestrator, which
knows the task, is the right place to choose the role.

## Prerequisite: the `nb` CLI

Everything here needs the `nb` command on PATH. Check it:

```bash
nb --version   # prints: nb (agent-notebook)
```

- **Inside kookr** it is already bundled — `pnpm install` pulls the
  `agent-notebook` dependency, and launched agents get `nb` on their PATH
  automatically (the shim pins the store to `~/.kookr/notebooks` and git-backs
  every write). You install nothing.
- **Anywhere else** — a fresh machine, or a repo that only installed the
  kookr-toolkit plugin — install the public package once:

  ```bash
  npm install -g agent-notebook   # puts `nb` on your PATH
  ```

  The store defaults to `~/.agent-notebook/notebooks`; set `NB_DIR` to relocate it.

If `nb` is absent the ritual is **fail-open**: `nb show` simply errors and the
agent proceeds with no memory, so a notebook step never blocks the task.
Installing `nb` is what turns the memory on.

## 1. Pick an existing role — don't reinvent

List what already exists, richest first, and reuse one of these names verbatim:

```bash
nb roles
```

```
agent-notebook roles — 17 in /home/you/.kookr/notebooks
  change-verifier                 25 lessons
  code-review@owner-repo           4 lessons
  patch-author@owner-repo          3 lessons
  …
```

Choose by **task shape**, not by the subagent's self-image: a boundary review of
a diff is `code-review`, not a new `boundary-review`. Only invent a new role when
no existing one fits the *kind of work* — emergent roles are welcome, but check
`nb roles` first so you reuse instead of duplicating.

**Scope rule.** Resolution is exact, and `code-review` and `code-review@owner-repo`
are different files. Pick one per spawn:
- repo-specific lessons → `<role>@<owner>-<repo>` (derive the slug from the
  orchestrator's own `NB_ROLE`, which is `orchestrator@<owner>-<repo>`)
- portable, cross-repo lessons → the bare `<role>`

## 2. Put the ritual in the spawn prompt

Drop this block into the prompt of any domain agent you spawn, filling in the one
role you chose:

```
You work under Agent Notebook role **<ROLE>**.
1. Start: run `nb show <ROLE>` and apply its lessons (it may be empty — fine).
2. <the actual task>
3. Before you return: `nb vote <ROLE> "<id>" +1` the lessons you used, and
   `nb add <ROLE> "<one reusable lesson, ≤200 chars>"` if you confirmed something
   a future agent in this role would want. Do this BEFORE composing your final
   message — the agent that spawned you only sees your last message, so the
   notebook write must already be done when you return.
```

For a **named** agent (e.g. `patch-author`) the role is fixed by its definition,
so you need only confirm the scope suffix. For a **general-purpose** agent doing
domain work, name the role explicitly. For throwaway work (a one-shot search),
attach no role at all — not everything deserves a notebook.

## 3. Why "before you return" matters

The parent receives only the subagent's final message. If the agent writes its
lessons *after* it has reported — or you try to make the parent write them — the
write never happens or lands at the wrong altitude. Keep the write inside the
subagent's own run, ahead of its final message. (Do **not** force this with a
blocking `SubagentStop` hook: that replaces the findings the parent needs with
maintenance chatter.)

## Anti-patterns

- **Reinventing a role** because you didn't run `nb roles` first — creates an
  empty near-duplicate that splits lessons across two files.
- **Scope mismatch** — writing a repo-specific lesson to the bare `<role>` (or a
  portable one to `<role>@repo`), so the agent that needs it looks in the other
  file and sees nothing.
- **Bare `nb add`** — the role is a required argument; there is no implicit
  "current role" for a subagent.
- **Notebook on throwaway work** — a one-grep agent has no reusable lesson;
  skip the ritual rather than add noise that the 200-line cap will evict.
