---
name: Umbrella Decompose
description: Turn ONE open, human-sanctioned umbrella issue into a small set of sized leaf issues (each with scope + acceptance criteria) that flow through normal vetting — never inventing new top-level scope and never executing the leaves.
repo-tags: [github]
tags: [workflow]
checklist:
  - Selected exactly ONE open, human-sanctioned umbrella; recorded why it qualifies
  - Every filed leaf stays within the umbrella's already-approved scope (no new top-level scope invented)
  - Every filed leaf carries a clear Scope and Acceptance criteria section
  - Leaves are linked back to the parent umbrella and left for normal vetting (no implementation, no auto-execution)
  - Reported the umbrella chosen, the leaves filed (numbers + titles), and any umbrellas skipped with reasons
---

# Umbrella Decompose

You are a **supply refinery**, not a coder. Your entire job this run is to take
**one** open, human-sanctioned umbrella issue and file a **small, bounded set of
sized leaf issues** that deepen the vetted work supply. You do **not** implement
anything, you do **not** invent new scope, and you do **not** start the leaves —
they enter the repository's normal vetting/triage path like any other issue.

This exists because a harness with idle capacity and an empty queue has **no
vetted work to consume**, while approved umbrellas sit undecomposed. You convert
already-approved umbrella scope into actionable leaves. That is the only lever
you pull.

## Target repository

Operate on the repository for this working directory. Resolve it once:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Use that `owner/repo` (call it `$REPO`) for every `gh` command below. If it does
not resolve (no GitHub remote), stop and report that the refinery has no target
repository — do not guess.

## Phase 1 — Find candidate umbrellas

List open issues and identify **umbrella** issues — issues that describe a
multi-part workstream rather than a single unit of work. Scan enough to choose
well:

```bash
gh issue list --repo "$REPO" --state open --limit 100 \
  --json number,title,author,labels,body,createdAt
```

An issue is an **umbrella candidate** when it is umbrella-*shaped*:

- Its title or body frames a workstream, epic, or theme (e.g. "Umbrella:", "Epic:",
  "Meta:", a phased plan, or a checklist of sub-work), **and**
- It is open, **and**
- It plausibly contains **more than one** independently-shippable unit of work.

## Phase 2 — Human-sanctioned gate (hard filter)

Decompose **only** umbrellas that are **human-sanctioned**. Keep a candidate only
if ALL of these hold — otherwise skip it and record the reason:

1. **Human-authored by a maintainer.** The author is a human maintainer/owner of
   the repo, not a bot or automation account (skip authors ending in `[bot]` or
   that are obviously service accounts). When unsure whether the author is a
   maintainer, check `gh api repos/$REPO/collaborators/<login>/permission` — a
   `push`/`maintain`/`admin` permission counts as sanctioned.
2. **Not rejected or parked-for-discussion.** Skip anything labeled to indicate
   it is not approved to proceed — e.g. `wontfix`, `invalid`, `duplicate`,
   `needs-discussion`, `question`, `on-hold`, `blocked`, `discussion`. (A label
   that only blocks *automated execution* — e.g. `automation-blocked` — does
   **not** disqualify decomposition: filing leaves is safe and is exactly the
   vetting step such umbrellas need.)
3. **Not already fully decomposed.** If the umbrella's checklist is already fully
   covered by existing open/closed child issues, there is nothing to refine —
   skip it.

If **no** candidate passes this gate, file nothing and report "no eligible
umbrella this run". That is a valid, expected outcome — never manufacture scope
to have something to do.

## Phase 3 — Select exactly ONE umbrella

From the sanctioned candidates, pick the single best one to decompose this run.
Prefer the umbrella with the most **undecomposed, ready-to-scope** surface: clear
approved intent, obvious independent leaves, and the least existing coverage.
Decompose **one and only one** umbrella per run — this keeps each run bounded.

Record, in one or two sentences, **why** this umbrella qualifies as
human-sanctioned and why you chose it over the others.

## Phase 4 — Derive leaves (stay inside approved scope)

Read the chosen umbrella closely. Break it into **3–8 leaf issues**, each a
single, independently-shippable unit of work. Hard rules:

- **No new top-level scope.** Every leaf must trace directly to something the
  umbrella already describes or clearly implies. If an idea is genuinely new
  scope not covered by the umbrella, it does **not** belong in this run — leave
  it out. You are decomposing approved work, not proposing new work.
- **Right-sized.** Each leaf should be a focused change a single task can land —
  not a mini-umbrella, not a one-line triviality. If a leaf still feels like a
  workstream, it is too big; if several leaves are the same change, merge them.
- **De-duplicate.** Before filing, check the umbrella's existing children and open
  issues (`gh issue list`/`gh search issues`) so you never file a leaf that
  already exists. Reference the existing issue instead.

## Phase 5 — File the leaves (reader-first, no execution)

For each leaf, create an issue with a body that a reviewer can act on without
re-reading the umbrella. Use this structure exactly:

```markdown
## Context

Part of #<umbrella-number> (<umbrella title>). <One sentence on where this leaf
fits in the umbrella.>

## Scope

<What this issue covers — and explicitly what it does NOT. Precise enough that a
reviewer can tell when it is done and that it stays inside the umbrella's
approved scope.>

## Acceptance criteria

- [ ] <Concrete, checkable outcome>
- [ ] <...>

## Out of scope / notes

<Anything intentionally deferred, plus links to sibling leaves if relevant.>
```

File it:

```bash
gh issue create --repo "$REPO" \
  --title "<concise leaf title>" \
  --body "<the body above>"
```

Then thread it back to the umbrella so the vetting path sees the relationship —
leave a comment on the umbrella linking each filed leaf, or (if the repo uses a
task list in the umbrella body) add the new issue references to it.

**Do not**:

- implement, branch, or open a PR for any leaf,
- mark a leaf as ready-to-run, assign it, or spawn work on it,
- close or re-scope the umbrella.

Filed leaves are **proposals entering normal vetting** — the repository's
existing triage decides what runs. Your run ends at "filed and linked".

## Phase 6 — Report

Summarize for the operator:

- The umbrella chosen (`#number`, title) and one line on why it is human-sanctioned.
- The leaves filed: each `#number` + title.
- Umbrellas considered but skipped, each with a one-line reason (fails the
  sanctioned gate, already decomposed, no independent leaves, etc.).
- If nothing was filed, say so plainly and why.
