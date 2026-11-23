# Idea store (`kookr idea`)

Agents often finish a task having seen something that should be simpler: a
module nothing imports, the same rule written in two skills, an error that is
swallowed, a doc that names a flag that no longer exists. Before the idea store,
such an observation ended as a notebook lesson about the workaround, or was
lost. The idea store (issue #4250) keeps these ideas in one place, counts how
many tasks hit the same thing, and lets the notebook retrofit curator turn the
ideas that recur into issues.

It collects **simplifications only**: changes that delete, merge, shorten,
split, correct or harden something that exists. There is no category for new
features, on purpose: the store exists to push the codebase toward less, not
more. A fact the next agent should remember (an environment quirk, a command
to run first) is a notebook lesson, not an idea.

The design follows the improvement-suggestion system of aegis-core, an earlier
agent platform, where a repeated suggestion counted as a vote and well-voted
suggestions were promoted; this version keeps ideas in agent-notebook shelves
instead of a database.

## Where it lives

The store is [agent-notebook](agent-notebook.md) in a folder of its own:
`~/.kookr/ideas`, or `KOOKR_IDEAS_DIR`. It is never mixed with the lesson
notebooks in `~/.kookr/notebooks`, so the session-start notebook index, the
janitor and the lesson counts never see it.

| | Lesson notebooks | Idea store |
|---|---|---|
| Holds | What to remember next time | What should become simpler |
| Folder | `~/.kookr/notebooks` (`NB_DIR`) | `~/.kookr/ideas` (`KOOKR_IDEAS_DIR`) |
| Line | a lesson, up to 200 characters | `<file or command>: <problem> -> <change> (keeps: <behaviour>)`, up to 400 |
| Shelves | `<situation>[@<slug>]` | `<category>@<repo-slug>`, 50 lines each |
| Shown at session start | yes (the index) | no |
| Leaves the store by | eviction, or the operator's `nb rm` | eviction, or the curator after promotion |

The 400-character line length belongs to the folder, not to `kookr idea`: the
folder holds `.nb.json` with `{ "maxChars": 400 }`, which agent-notebook 0.12.0
and later read on every `nb` command run on that folder and prefer over
`NB_MAX_CHARS`. So a plain `NB_DIR=~/.kookr/ideas nb doctor`, the janitor or a
script uses the same length as `kookr idea`, and `nb config` on the folder shows
`maxChars=400 (.nb.json)`. Shelves keep nb's default of 50 lines; nothing pins
`NB_MAX_LINES` for ideas, because two callers of one folder with different line
caps would evict ideas on the next add.

`kookr idea` runs Kookr's `bin/nb.js` with only `NB_DIR` set to the folder.
Before its first `nb` call it creates the folder and `.nb.json` if they are
missing. It never overwrites an existing `.nb.json`: if the file sets another
`maxChars`, or is not valid JSON, `kookr idea` prints a warning on stderr on
every run and `nb` uses what the file says (or 200 when the file is unusable).
To restore the ideas length, write `{"maxChars": 400}` to the file.

If the folder is a git repository, every change is committed, as for the
notebooks. `kookr idea` commits `.nb.json` itself while it is untracked (the
`nb` wrapper commits only the files an `nb` call changed), and warns if a
`.gitignore` ignores it.

## Categories

The category is chosen by what the change after `->` does. When two fit, the
first one listed wins.

| Category | The problem | The change |
|---|---|---|
| `guidance` | A skill, doc, `CLAUDE.md` rule, comment or `--help` text is wrong, stale or redundant | Correct, shorten or delete it |
| `dead` | Code, a flag, file, script or config that nothing uses | Delete it |
| `duplicate` | The same logic, rule or data in two or more places | Merge it into one |
| `overbuilt` | An abstraction, indirection, option or layer more complex than the job | Inline or collapse it |
| `tangled` | A module or function with mixed responsibilities, or code in the wrong layer | Split or move it |
| `unused` | A feature, command, option or UI element that works but is rarely used or confusing | Remove or unify it |
| `fragile` | A swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result | Make it fail loudly and simply |
| `tests` | A tautological, duplicated, flaky or slow test, or one tied to implementation details | Delete, merge or rewrite it |

Each category is its own shelf, so a busy category cannot evict the ideas of a
rare one. `kookr idea show` reads all of a repository's shelves together.

The `(keeps: ...)` part names the behaviour that must survive the change. It is
what makes a deletion safe to promote: the curator checks that a test covers it
before the deletion is planned.

## How agents use it

The end-of-task completion reminder (`bin/kookr-stop-nudge.js`, shown to the
main agent of a Kookr task, never to a subagent) asks, before the completion
signal, whether the task hit something that should be deleted, merged,
simplified or corrected, and points at `kookr idea --help`. Most tasks have
nothing to record, and the text says so.

```bash
kookr idea add --category dead \
  "src/sync/legacy-bridge.ts: imported nowhere since the queue rewrite -> delete it and its test (keeps: sync through src/sync/queue.ts)"
```

Agents write their idea from what the task hit, without browsing the store
first. Reading a list before deciding turns a vote into recognition of
whatever is listed: notebook lessons collect about 1,075 upvotes for every 7
downvotes. Instead, `add` does the matching:

- It refuses an idea without a known category, `->` or `(keeps:`.
- If the repository already has an idea about the same file or command, or one
  worded much the same (character-trigram similarity of 0.4 or more), it
  records nothing and lists those ideas. The agent votes for one with
  `kookr idea vote <id> +1 --because "<what in this task hit it>"`, or re-runs
  the add with `--new`.
- An identical idea becomes a +1 vote for the existing line.
- A task can add one new idea.

## Who supports an idea

The idea text carries no task id, because a text unique to one task would
never match as a duplicate. Instead:

- agent-notebook's usage log (`.nb-usage.log` in the ideas folder) records the
  session of every add; Kookr sets `NB_SESSION` to the task id;
- `kookr idea vote +1` needs `--because`, and appends the task, the idea and
  the reason to `.votes.tsv`. Re-adding an identical idea is logged there too.

The curator counts a task as supporting an idea when the task added it or voted
for it with a reason. Plain upvotes do not count.

## How ideas are promoted

The [notebook lesson retrofit](notebook-lesson-retrofit-schedule.md) playbook
reads the store on every run:

1. It snapshots every idea with its score and the number of tasks that support
   it.
2. An idea with a score of at least `ideaMinScore` (default 3) and support from
   two or more tasks is a candidate. Ideas about the same file or command and
   the same problem are combined.
3. Each candidate is checked by its category on the repository's default
   branch: for example a `dead` idea needs a search that finds no use outside
   its own tests, and an `unused` idea needs usage evidence and becomes a
   decision for the operator, not an implementation task.
4. When the run files leaf issues (`fileIssues=leaves`), a promotable idea
   becomes a leaf issue under the retrofit umbrella, written from the verified
   evidence, and is then removed with
   `kookr idea rm --repo <repo> <id> --reason other --note "promoted: <issue URL>"`.
   An idea that is already handled is removed with `--reason obsolete`. At most
   three idea leaves are filed per run.
5. In report-only runs, the report lists those commands instead.

## Commands

See [`kookr idea`](cli.md#kookr-idea) for the full syntax. To look at the store
directly: `kookr idea show`, `kookr idea list`, `kookr idea doctor`,
`kookr idea path`.
