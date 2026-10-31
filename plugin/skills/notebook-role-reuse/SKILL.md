---
name: notebook-role-reuse
description: >
  Spawn an agent so it REUSES an existing Agent Notebook shelf (a "role" in the
  nb CLI's own terms) — loading that shelf's accumulated lessons at the start and
  writing new ones back to the same notebook before it returns. Use whenever you
  spawn a general-purpose (or named) subagent to do domain work other agents have
  done before: code review, repo mapping, patching, reproduction, design critique,
  and so on. Also use when you want the orchestrator to discover existing shelves
  and reuse them.
keywords: nb, agent notebook, shelf, role, reuse, spawn subagent, lessons, memory, nb list, nb roles, nb show, nb add, emergent shelf
related: [pre-pr-review, self-continuation-task]
---

# Reusing an Agent Notebook shelf across spawned agents

A shelf is a bounded, voted store of one-line lessons kept in one file,
`~/.kookr/notebooks/<shelf>.md` (git-backed; every write is auto-committed). The
`nb` CLI calls a shelf a *role* — its argument is `<role>` — so the two words mean
the same thing here; this skill says "shelf" for the grouping and uses the
literal CLI commands as-is.

**Shelf names are exact strings** — there is no fuzzy matching and no fallback.
So "reuse a shelf" means exactly one thing: spawn the agent with the **exact
existing shelf name** in its prompt, plus the show/add ritual. Pass the real
string and the new agent inherits every past lesson and adds to the same file;
pass a near-miss (`code-reviewer` for `code-review`) and you silently create a
new, empty orphan notebook.

A subagent gets **no** automatic notebook injection — no SessionStart index hook
fires for it. The shelf reaches it **only** through the prompt you write. That is
the whole mechanism — and it means the orchestrator, which knows the task, is the
right place to choose the shelf.

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

## 1. Pick an existing shelf — don't reinvent

List what already exists — the index shows each shelf with a one-line "open me
when…" description — and reuse one of these names verbatim:

```bash
nb list
```

```
agent-notebook notebooks — 17 in /home/you/.kookr/notebooks
  change-verifier           25  open before claiming a change is done
  code-review@owner-repo     4  review a diff in this repo
  patch-author@owner-repo    3  write a minimal fix against a repro
  …
```

(`nb ls` and `nb roles` are aliases of `nb list` — same index, same output.)

Choose by **task shape**, not by the subagent's self-image: a boundary review of
a diff is `code-review`, not a new `boundary-review`. Only invent a new shelf when
no existing one fits the *kind of work* — new shelves are welcome, but read the
index first so you reuse instead of duplicating.

**Describe a shelf you create.** The index an agent reads to choose a shelf shows
each shelf's one-line *description* — the "open me when…" trigger. A brand-new
shelf is born without one, so it shows up in the index as `(auto)` (its top
lesson stands in) and is hard to choose deliberately. The moment you create a new
shelf, give it a trigger:

```bash
nb describe <new-shelf> "<the situation in which a future agent should open this shelf>"
```

Keep it a situation ("reviewing a diff for logic bugs"), not a summary of its
lessons. This is what keeps the index selectable as it grows.

**Scope rule.** Resolution is exact, and `code-review` and `code-review@owner-repo`
are different files. Pick one per spawn:
- repo-specific lessons → `<shelf>@<owner>-<repo>` (use `KOOKR_REPO_SLUG` as the
  `@` suffix — it is already `<owner>-<repo>`)
- portable, cross-repo lessons → the unscoped `<shelf>`

## 2. Put the ritual in the spawn prompt

Drop this block into the prompt of any domain agent you spawn, filling in the one
shelf you chose:

```
You work with Agent Notebook shelf **<SHELF>**.
1. Start: run `nb show <SHELF>` and apply its lessons (it may be empty — fine).
2. <the actual task>
3. Before you return: `nb vote <SHELF> "<id>" +1` the lessons you used, and
   `nb add <SHELF> "<one reusable lesson, ideally ≤120 chars, hard cap 200>"` if you confirmed something
   a future agent on this shelf would want. Do this BEFORE composing your final
   message — the agent that spawned you only sees your last message, so the
   notebook write must already be done when you return.
```

For a **named** agent (e.g. `patch-author`) the shelf is fixed by its definition,
so you need only confirm the scope suffix. For a **general-purpose** agent doing
domain work, name the shelf explicitly. For throwaway work (a one-shot search),
attach no shelf at all — not everything deserves a notebook.

## 3. Why "before you return" matters

The parent receives only the subagent's final message. If the agent writes its
lessons *after* it has reported — or you try to make the parent write them — the
write never happens or lands at the wrong altitude. Keep the write inside the
subagent's own run, ahead of its final message. (Do **not** force this with a
blocking `SubagentStop` hook: that replaces the findings the parent needs with
maintenance chatter.)

## Anti-patterns

- **Reinventing a shelf** because you didn't read `nb list` first — creates an
  empty near-duplicate that splits lessons across two files.
- **Scope mismatch** — writing a repo-specific lesson to the bare `<shelf>` (or a
  portable one to `<shelf>@repo`), so the agent that needs it looks in the other
  file and sees nothing.
- **Bare `nb add`** — the shelf is a required argument; there is no implicit
  "current shelf" for a subagent.
- **Notebook on throwaway work** — a one-grep agent has no reusable lesson;
  skip the ritual rather than add noise that the 50-line cap will evict.
