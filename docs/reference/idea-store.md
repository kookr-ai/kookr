# Idea store (`kookr idea`)

Agents often finish a task knowing that something should change: a skill that
gave a wrong command, a check that let a mistake through, a missing flag on a
tool. Before the idea store, such an idea ended as a notebook lesson about the
workaround, or as a GitHub issue filed on a single sighting. The idea store
(issue #4250) keeps these ideas in one place, counts how often agents hit the
same thing, and lets the notebook retrofit curator promote the ones that recur.

The design follows the improvement-suggestion system of aegis-core, minus its
database: a duplicate becomes a vote, a low score falls out, and a high score
is promoted.

## Where it lives

The store is [agent-notebook](agent-notebook.md) in a folder of its own:
`~/.kookr/ideas`, or `KOOKR_IDEAS_DIR`. It is never mixed with the lesson
notebooks in `~/.kookr/notebooks`, so the session-start notebook index, the
janitor and the lesson counts never see it.

| | Lesson notebooks | Idea store |
|---|---|---|
| Holds | What to remember next time | What should change |
| Folder | `~/.kookr/notebooks` (`NB_DIR`) | `~/.kookr/ideas` (`KOOKR_IDEAS_DIR`) |
| Line cap | 200 characters | 400 characters |
| Shelves | `<situation>[@<slug>]` | one per repository slug |
| Shown at session start | yes (the index) | no |
| Leaves the store by | eviction, or the operator's `nb rm` | eviction, or the curator after promotion |

`kookr idea` runs Kookr's `bin/nb.js` with `NB_DIR`, `NB_MAX_CHARS=400` and
`NB_MAX_LINES=50` set for that folder. If the folder is a git repository, every
change is committed, as for the notebooks.

## How agents use it

At the end of a Kookr task, the notebook retrospective hook adds one line about
ideas. An agent that has an idea runs:

```bash
kookr idea show                         # the repository's 10 best-scored ideas
kookr idea vote <id> +1                 # the same thing was already recorded
kookr idea add "<what is wrong or missing> -> <proposed change>"
```

- `add` refuses an idea without `->`, so every idea names both the problem and
  the change.
- Adding an idea that is already recorded word for word votes +1 for it.
  agent-notebook alone skips such a duplicate without voting.
- Reworded duplicates are left to the agent, who reads `kookr idea show` before
  adding. agent-notebook's trigram similarity check is too weak for reworded
  ideas.
- A full shelf (50 ideas) evicts its lowest-scored idea to admit a new one.

The idea text does not carry a task id: that would make every line unique and
no duplicate would ever become a vote. Kookr sets `NB_SESSION` to the task id,
and agent-notebook's usage log in the ideas folder records the session of every
add and vote, so the curator can count how many different tasks support an
idea.

## How ideas are promoted

The [notebook lesson retrofit](notebook-lesson-retrofit-schedule.md) playbook
reads the store on every run:

1. It snapshots each idea with its score and the number of different tasks that
   added it or voted it up.
2. An idea with a score of at least `ideaMinScore` (default 3) and support from
   two or more tasks is a candidate. It is checked against the repository's
   default branch like any lesson candidate.
3. When the run files leaf issues (`fileIssues=leaves`), a promotable idea
   becomes a leaf issue under the retrofit umbrella, written from the verified
   evidence, and is then removed with
   `kookr idea rm --shelf <shelf> <id> --reason promoted --note <issue URL>`.
   An idea that is already handled is removed with `--reason obsolete`. At most
   three idea leaves are filed per run.
4. In report-only runs, the report lists those commands instead.

## Commands

See [`kookr idea`](cli.md#kookr-idea) for the full syntax. To look at the store
directly: `kookr idea list`, `kookr idea doctor`, `kookr idea path`.
