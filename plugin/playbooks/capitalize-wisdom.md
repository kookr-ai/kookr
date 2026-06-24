---
name: Capitalize Wisdom
description: Distill the domain-general, transferable knowledge/wisdom acquired during an experiment program or rich work session and persist it durably to the knowledge base via the kb CLI — so future work in any project or domain benefits
checklist:
  - Confirmed there is generalizable wisdom worth capitalizing (not just project facts or a one-off correction)
  - Grounded the reflection in real artifacts (commit history, reflection logs, experiment/decision records) — not written from memory
  - Verified load-bearing claims before enshrining them; marked inference vs evidence
  - Distilled each lesson to a domain-general principle (principle + why + concrete illustration + how-to-apply)
  - Routed each lesson to the right durable home (kb shelf for knowledge; CLAUDE.md/skill/hook for behavioral rules)
  - Created a new kb shelf with a README when the wisdom is a coherent new domain
  - Wrote one note per principle via kb remember and confirmed action=create
  - Reindexed safely in the background and verified with a diversity canary + a new-shelf hit query
  - Reported what was captured, where, and which claims are unverified inferences
---

## Objective

After a body of work that produced **generalizable insight** — an experiment
program, a long investigation, a debugging marathon, a research session — capture
the **domain-general, transferable wisdom** and persist it to the knowledge base so
the next agent (here, or on an unrelated task in a different domain) inherits it.

This playbook is **generative** — it captures NEW wisdom. It is distinct from its
two siblings; pick the right one:

- `self-reflect` (skill) — **corrective**: a specific mistake/correction → a
  structural fix (hook / skill / CLAUDE.md). Use when the user corrected you.
- `session-self-reflect` (playbook) — **operational**: analyze Kookr supervision
  sessions for friction/correction patterns → a friction report.
- **this playbook** — **knowledge capitalization**: distill what you LEARNED into
  durable, reusable knowledge notes. Use at the end of an experiment arc or any
  session where you acquired wisdom that would help future-you in other contexts.

The core discipline: **do not capitalize a wrong conclusion.** The value of a
captured lesson is exactly its truth × generality. Verifying validity before
enshrining is the whole point — a confident, wrong, general-sounding lesson is
worse than capturing nothing.

## Phase 0: Is there wisdom worth capitalizing?

Trigger when the work produced a lesson that is BOTH non-obvious AND transferable.
Good candidates: methodology that proved out (or failed), a measurement/validity
insight, a recurring failure mode and its fix, an environment/tooling truth.

STOP (use a different home, not this playbook) if the takeaway is:
- A project-specific fact (a run id, a champion name, a file path) → that is
  project history; it belongs in commit messages / decision records.
- A one-off behavioral correction → use `self-reflect`.
- Already documented in CLAUDE.md, a skill, or the kb → update that, don't dup.

Smell test (borrowed from `agent-task-lessons`): if the lesson can only be stated
by naming "this task / this file / this PR", it is not wisdom yet — generalize it
or drop it.

## Phase 1: Ground the reflection in real artifacts — never write from memory

Generic advice written from vibes is worthless; the value is in lessons
**attributable to actual outcomes**. Read the evidence before writing a word:

- Commit history / PR titles for the arc (what was tried, in what order, what
  promoted vs held vs was falsified).
- Reflection logs, experiment reports, decision records, RFCs.
- The failures specifically — a falsified hypothesis usually teaches more than a
  win, and tells you which axis is exhausted.

**Verify load-bearing claims.** Before a claim becomes a permanent note, confirm
it against the source (re-read the report, re-run the check, eyeball the data).
This is the meta-lesson the whole playbook exists to enforce: validate results and
rule out artifacts BEFORE drawing a conclusion. Note honestly which claims are
verified evidence and which are your own inference/extrapolation.

## Phase 2: Distill to domain-GENERAL principles

For each lesson, strip the project specifics and ask: **would this help on an
unrelated problem in a different field?** If not, it is project history, not wisdom.

Write each note in this shape:
- **Principle** — one general sentence (the headline).
- **Why it matters** — the cost it prevents / the value it adds.
- **Concrete illustration** — an anonymized instance ("an experiment promoted a
  change, then it failed to replicate"), enough to make it real without leaking
  project trivia.
- **How to apply** — an executable rule, usually starting with a verb.

Keep the set sharp: one principle per note, merge overlaps, prefer few strong
notes over many weak ones. Separate evidence from inference explicitly.

## Phase 3: Route each lesson to the right durable home

**Use the `kb` CLI for knowledge. Do NOT use Claude Code's built-in file-based
memory** — in this environment it is RETIRED and a PreToolUse hook blocks writes
to `.claude/projects/*/memory/`. If you feel the urge to "save a memory," that
urge is the bug.

Distinguish what you are persisting (walk `placement-picker` if unsure):

| What it is | Where it goes |
|---|---|
| General methodology / process / research wisdom | a `kb` methodology shelf (e.g. `experiment-methodology`) |
| A fact about the machine / tools / local stack | `kb` shelf `operating-environment` |
| A narrow agent mistake in Mistake/Why/Better shape | `kb` shelf `agent-task-lessons` |
| Domain literature notes | the relevant topic `kb` shelf |
| A **behavioral rule** (how the agent must act) | CLAUDE.md / a skill / a hook — NOT kb, NOT memory (use `self-reflect`) |

Pick the shelf with `kb list`. **Create a new shelf** when the wisdom is a coherent
domain not served by an existing one — do not jam unrelated wisdom into a topic
shelf:

```bash
mkdir -p ~/knowledge_bases/<shelf-name>
# write a README.md describing: scope, what belongs, what does NOT, entry format
```

A focused shelf with a clear README keeps semantic search sharp and tells the next
agent where new notes belong.

## Phase 4: Write the notes via `kb remember`

One note per principle:

```bash
cat <<'EOF' | kb remember --kb=<shelf> --title="<headline>" --stdin --yes
# <headline>
...note body (Principle / Why / Illustration / How to apply)...
EOF
```

- Confirm the response shows `"action": "create"` (or `append`).
- The similarity preflight is ON by default and prevents near-duplicates — keep it
  on for existing shelves. Pass `--no-check-similar` ONLY for the first writes to a
  brand-new, unindexed shelf (its index does not exist yet).
- Do not pass `--refresh` per-note; batch the indexing in Phase 5.

## Phase 5: Make it searchable + verify — SAFELY

New notes are on disk but not yet in the FAISS index until you reindex. The
reindex has two real footguns — handle both.

1. **Snapshot the active index as a rollback anchor:**
   ```bash
   IDX=~/knowledge_bases/.faiss/models/ollama__nomic-embed-text-latest
   readlink "$IDX/index"   # e.g. index.v22  — remember this
   ```

2. **Run the reindex in the BACKGROUND** — it can take many minutes; a foreground
   tool timeout will SIGTERM it mid-build. Stay outside the LRA cron window
   (06:00–10:30 UTC) or pass `--force`:
   ```bash
   KB_CONTEXTUAL_RETRIEVAL=on LOG_LEVEL=error kb reindex --with-context --kb=<shelf>
   ```
   (`--with-context` is required.) The symlink swap is atomic at the very end, so a
   killed build leaves the OLD complete index in place — recoverable, but it means
   your notes simply are not indexed until a clean run finishes.

3. **After it completes, run TWO verifications:**
   - **Diversity canary** — a broad cross-domain query must still return MULTIPLE
     distinct shelves. If it collapses to a single shelf, a scoped reindex
     repointed the global index symlink to a PARTIAL index — every other query is
     now silently wrong.
     ```bash
     kb search "language model reasoning memory retrieval agent" --format=json --k=6
     # confirm the hits span several different shelves
     ```
   - **New-shelf hit** — a natural-language query that should match your notes
     actually returns them.
   - If the canary collapsed, repoint the symlink back to the complete version:
     `rm "$IDX/index" && ln -s index.v<complete> "$IDX/index"`, then re-verify.

## Phase 6: Report

Summarize for the user: what wisdom was captured, the shelf(s) and note titles,
whether a new shelf was created, and explicitly flag any claims recorded as
unverified inference rather than evidence. Do not auto-edit CLAUDE.md or skills —
that is `self-reflect`'s job; this playbook only writes knowledge.

## Rules

- **Evidence-grounded or not at all.** Every lesson traces to a real outcome.
  Verify load-bearing claims first; capitalizing a wrong conclusion is worse than
  capturing nothing.
- **General-only.** If a note names a specific file/PR/run, generalize it or drop
  it. The only allowed "this" is "this kind of situation."
- **Knowledge → kb; behavioral rules → CLAUDE.md/skill/hook.** Never the built-in
  file memory.
- **One principle per note.** Keep shelves sharp; merge duplicates; prefer few
  strong notes.
- **Mark inference vs evidence** in the note and the report.
- **Never start a reindex you cannot let finish** — background it, and always run
  the diversity canary afterward before trusting the index.
