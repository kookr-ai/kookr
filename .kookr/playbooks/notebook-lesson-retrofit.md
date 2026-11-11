---
name: Notebook Lesson Retrofit Review
description: Read what the agent-notebook lessons say, find the ones a hook, command, skill or agent-definition rule could make unnecessary, verify each proposal against what already exists, and report which entries can be retired — both for new proposals and for earlier ones that have since shipped. Never removes or edits a notebook entry.
tags: [workflow, analysis, memory]
cwd: $HOME/git/kookr
parameters:
  - name: umbrellaRepo
    description: "Repository that holds the retrofit umbrella issue (owner/repo)."
    required: false
    default: "kookr-ai/kookr"
    type: text
  - name: fileIssues
    description: "no = write the report only. umbrella = also update (or create) the umbrella issue. leaves = also file one issue per verified single-PR change."
    required: false
    default: "no"
    type: select
    options:
      - label: "no (report only)"
        value: "no"
      - label: "umbrella (update the umbrella issue)"
        value: "umbrella"
      - label: "leaves (umbrella plus leaf issues)"
        value: "leaves"
  - name: minVotes
    description: "A single entry is a candidate when its score is at least this. A lesson repeated in two or more shelves is always a candidate."
    required: false
    default: "5"
    type: text
  - name: reportsDir
    description: "Directory that holds this playbook's reports, entry maps and shelf snapshots. Blank = ~/.kookr/reports."
    required: false
    default: ""
    type: text
checklist:
  - Took a snapshot of every shelf and diffed it against the previous run's snapshot and entry map
  - For every earlier leaf that is now closed, verified the fix on the fetched default branch, checked it is live on this host, and listed the entries that are ready to retire
  - Every new proposal was checked against existing hooks, skills, agent definitions, playbooks and scripts on a fetched remote ref, with a positive control for each "nothing covers this"
  - Every cited entry id was validated by script against the snapshot
  - Wrote the report, the entry map and the snapshot to the reports directory
  - Ran no mutating nb command other than the end-of-task retrospective, and put no lesson text and no private-repository name in a public issue
---

## Objective

Agents write a notebook lesson when something trips them up. A lesson with many
votes, or one that several shelves hold in different words, marks a problem the
tooling could remove so that nobody has to remember it: a hook that enforces the
rule, a command that does the step, a skill or agent definition that states it,
or a fix to the quirk itself.

This playbook reads the **content** of the lessons, proposes such changes, and
keeps a map from each change to the entries it makes unnecessary. It also closes
the loop: when an earlier proposal has shipped, it says which entries can now be
retired.

It does not look at how `nb` is used (error rates, surfacing metrics) or at
store hygiene (duplicates, eviction). Those belong to
`agent-notebook-reflection.md` and `nb-janitor.md`. If you notice such a problem,
give it one line in the report and move on.

## Hard rules

This task may run unattended. Do not ask questions; decide and report.

1. **The store is read-only.** Never run `nb rm`, `nb move`, `nb merge`,
   `nb split` or `nb describe`, and never edit a shelf file. The only writes
   allowed are the end-of-task retrospective votes and at most one `nb add`.
   Retiring entries is the operator's step; you list the commands.
2. **Never read code from the current directory to decide what exists.** The
   checkout you start in may be hundreds of commits behind. For every repository
   you check, find its default branch
   (`gh repo view <owner>/<repo> --json defaultBranchRef -q .defaultBranchRef.name`),
   run `git fetch origin`, and read through the remote ref
   (`git show origin/<default>:<path>`, `git grep <pattern> origin/<default> -- <paths>`).
   To run something, extract the files into a temp directory with `git show`,
   or use `git worktree add --detach <tmpdir> origin/<default>` and remove it
   afterwards. Never switch or reset an existing checkout.
3. **A negative needs a positive control.** Before writing "nothing covers
   this", run the same search for something you know exists and confirm it is
   found. Do not pipe a search through `head` and then conclude from what is
   missing. Search case-insensitively.
4. **Private repositories stay out of public issues.** A shelf named
   `<situation>@<owner>-<repo>` carries the repository name. For each slug, run
   `gh repo view <owner>/<repo> --json visibility`. Entries from a private
   repository's shelf, and findings about that repository, go in the local
   report only. `<owner>-<repo>` does not always split one way, and some old
   shelves carry no owner: if no split resolves, or the lookup fails for any
   reason, treat the shelf as private.
5. **No lesson text in a public issue.** The store is local to the operator's
   machine. Public issues carry shelf name, entry id, score and action only.
6. **Change no configuration.** Host config, schedules, hooks and settings are
   reported, never edited.

## Context

- `nb list` prints every shelf; `nb show <shelf>` prints its entries as
  `<id>  [<score>]  <text>`. The id is the first six-character token.
- Reports live in `{{reportsDir}}` (blank means `~/.kookr/reports`). Each run
  writes three files named `notebook-retrofit-<stamp>`: `.md` (the full report,
  with lesson text), `.map.tsv` (one row per mapped entry: finding, shelf, id,
  status, score, visibility, text) and `.shelves.txt` (the snapshot). The stamp
  is today's date, with `-run2`, `-run3`, … added when that date already has
  files. A run never overwrites an earlier run's files: they are the baseline
  the next run diffs against.
- The umbrella issue in `{{umbrellaRepo}}` carries the marker
  `<!-- kookr:notebook-retrofit-umbrella -->` in its body. Find it with
  `gh issue list --repo {{umbrellaRepo}} --state all --search "kookr:notebook-retrofit-umbrella in:body"`.
  It lists the findings, the leaf issues, and the entries each one retires.
- Entry statuses: `full` (remove once the change is live), `partial` (the change
  covers part of the lesson; shorten it), `now` (already covered; remove),
  `recheck` (looks fixed, not reproduced), `move` (belongs on another shelf),
  `decide` (the operator chooses), `junk` (not a lesson), `investigate` (the
  finding itself is unverified; keep the entry).
- Shell variables do not survive from one command call to the next. Phase 1
  prints the three file paths; use those literal paths in later commands. The
  snippets are bash.

## Phases

### Phase 1 — Snapshot the store

```bash
REPORTS="{{reportsDir}}"; REPORTS="${REPORTS:-$HOME/.kookr/reports}"; REPORTS="${REPORTS/#\~/$HOME}"
mkdir -p "$REPORTS"
STAMP=$(date +%F); n=1
while ls "$REPORTS/notebook-retrofit-$STAMP".* >/dev/null 2>&1; do
  n=$((n+1)); STAMP="$(date +%F)-run$n"
done
SNAP="$REPORTS/notebook-retrofit-$STAMP.shelves.txt"
nb list --limit 1000 | awk 'NR>1 {print $1}' | while read -r shelf; do
  out=$(nb show "$shelf" 2>/dev/null) || continue
  printf '=== SHELF: %s\n%s\n\n' "$shelf" "$(printf '%s\n' "$out" | grep -v '^# vote by id')"
done > "$SNAP"
grep -c '^=== SHELF: ' "$SNAP"; grep -cE '^[0-9a-f]{6}  \[' "$SNAP"
printf 'SNAP=%s\nMAP=%s\nREPORT=%s\n' "$SNAP" "$REPORTS/notebook-retrofit-$STAMP.map.tsv" "$REPORTS/notebook-retrofit-$STAMP.md"
```

Check the two counts against `nb list` (shelf count, and the sum of its lesson
counts). If they differ, fix the snapshot before going on.

### Phase 2 — Load the previous run

The previous run is the stamp, other than this run's, that has **both** a
`.map.tsv` and a `.shelves.txt` in the reports directory and whose map was
modified most recently (`ls -t "$REPORTS"/notebook-retrofit-*.map.tsv`). Use
that map and that snapshot as a pair. Ignore a snapshot that has no map: it is
left over from a run that did not finish, and diffing against it hides entries
for good. Also find the umbrella issue.

- **No earlier run:** read the whole snapshot in Phase 4.
- **Earlier run exists:** compute three sets by `(shelf, id)`: entries that are
  new since the earlier snapshot, entries whose score rose by five or more, and
  mapped entries that have disappeared (already retired, evicted, or edited).
  Phase 4 reads only the first two sets, plus any unmapped entry at or above
  `{{minVotes}}`.

### Phase 3 — Close the loop on earlier leaves

For each leaf in the umbrella's task list:

1. `gh issue view <number> --repo <owner/repo> --json state,stateReason,title,url,closedByPullRequestsReferences`.
   Always pass `--repo`: leaves live in several repositories, and a bare number
   resolves against the working directory's repository, where the same number
   is a different issue. Check the title matches the leaf.
2. If it is open, record that and go on.
3. If it is closed as completed, verify the change on the fetched default branch
   of its repository: find the hook, command, rule or test the leaf's acceptance
   criteria name, and run the cheapest check that shows it works (rule 2 says
   how to get the files). A closed issue is not proof.
4. Then check the change is **live on this host**, not only merged: a plugin or
   CLI change must be in the installed plugin or package the host actually runs,
   and a published tool must be at a version that contains it. If it is merged
   but not live, list its entries under "merged, not yet live" and print no
   commands for them.
5. For a leaf that is verified and live, list its entries from the map:
   - `full` and `now` entries that still exist in today's snapshot: print the
     exact command, `nb rm <shelf> <id> --reason obsolete`.
   - `partial` entries: print the current text and a proposed shorter text that
     keeps only what the change does not cover.
   - `recheck`, `move`, `decide`, `junk` and `investigate` entries are not tied
     to a leaf; carry them forward under "Operator clean-up".
6. For a leaf closed as not planned or as a duplicate, mark its entries "stay"
   (for a duplicate, follow the issue it points to instead).

Put the result in the report under "Ready to retire". Do not run the commands.

### Phase 4 — Find candidates

Read the entries selected in Phase 2 and sort each into one bucket:

| Bucket | Meaning | What follows |
|---|---|---|
| Mechanical | A step or check a script can do or enforce | Hook, command, or gate |
| Misunderstanding | The same wrong belief about a tool or workflow | Skill, playbook wording, error message, or a feature |
| Repository fact | True of one repository only | That repository's instructions, or a fix to the quirk |
| Reviewer craft | A stable rule of judgement with many votes | The agent definition or reviewer specialist that owns it |
| Leave | One-off heuristics, code facts, design judgement | Nothing; this is what the notebook is for |

Then group across shelves. The same lesson written in several shelves, for
several repositories, is the strongest signal; one highly voted entry is the
next. A candidate is a group, or a single entry at or above `{{minVotes}}`, in
one of the first four buckets. Most entries end in "Leave"; that is expected.

### Phase 5 — Verify each candidate against what exists

For each candidate, name the repository and surface the change would touch,
then look for something that already does it. Check all of these that apply:

- plugin hooks and `plugin/hooks/hooks.json`; the repository's `hooks/`,
  `.hooks/pre-push` and `.claude/settings.json`;
- user-level hooks and instructions: `~/.claude/settings.json`,
  `~/.claude/hooks/`, `~/.claude/CLAUDE.md`;
- the target repository's `CLAUDE.md` and `AGENTS.md`;
- plugin skills, agents, reviewer specialists and playbooks; `.kookr/playbooks/`;
- scripts and package scripts in the target repository;
- open and closed issues in the target repository (search per candidate).

Give every candidate one verdict:

- **New:** nothing covers it. Write the change in two or three sentences.
- **Exists as prose, still recurring:** a rule is written down and the lesson
  keeps being recorded. Say so; the proposal is to enforce or automate it.
- **Exists and works:** the lesson repeats what a tool already prints or does.
  No change; mark the entries `now` or `recheck`.
- **Already fixed:** the quirk is gone on the default branch. Mark `now` when
  you reproduced that, `recheck` when you only read it.
- **Needs a design:** the change is real but not one pull request. Keep it on
  the umbrella without a leaf.

Reproduce when it is cheap (run the command, read the error). When a number
drives a finding, look at its trend, not only a 30-day total: a rate that
dropped last week is not a current problem. Record for each finding how it was
checked: "on the fetched default branch", "reproduced", or "from lesson text
only". Never mark an entry `full` on lesson text alone.

### Phase 6 — Build and validate the map

Write the map to the MAP path Phase 1 printed (never to another run's file),
carrying forward every earlier row
that is still valid and adding the new ones. Then validate every `(shelf, id)`
pair against the snapshot:

```bash
SNAP=<the SNAP path Phase 1 printed>; MAP=<the MAP path Phase 1 printed>
[ -s "$SNAP" ] && [ -s "$MAP" ] || { echo "snapshot or map is missing or empty"; exit 1; }
awk -F'\t' 'FILENAME==ARGV[1] { if ($0 ~ /^=== SHELF: /) sh=substr($0,12);
                                 else if ($0 ~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]  \[/) k[sh" "substr($0,1,6)]=1;
                                 next }
            { n++; if (!(($2" "$3) in k)) { print "MISSING: " $2 " " $3; bad++ } }
            END { print n+0 " rows, " bad+0 " missing"; exit (bad>0 || n==0) }' "$SNAP" "$MAP"
```

The command exits non-zero when a row is missing or when it checked nothing; a
run that reports "0 rows" has validated nothing.

A missing row that was valid in the earlier snapshot means the entry was
retired or evicted: drop it from the map and count it in the report. Any other
missing row is your error; fix it. Re-run the command until it exits 0.

### Phase 7 — Write the report

Write the report to the REPORT path Phase 1 printed (never to another run's
file), in this order:

1. Counts: entries read, entries mapped, new since the last run.
2. **Ready to retire** (from Phase 3), with the commands; then **Merged, not
   yet live**, without commands; then **Operator clean-up**.
3. New findings, ranked by the votes on the entries each one retires. For each:
   where, evidence, change, how it was checked, and the entry table.
4. Corrections to earlier findings (anything Phase 5 showed was wrong or stale).
5. Private-repository findings.
6. What was not checked.

Write plainly: lead each finding with the problem a user or agent meets, define
any term a new reader would not know, and state uncertainty once, where it applies.

### Phase 8 — Issues

The `fileIssues` value for this run is `{{fileIssues}}`. Run this phase only
when that value is exactly `umbrella` or `leaves`. Any other value, including
`yes` or a blank, means report only: skip the phase.

- **`umbrella` and `leaves`:** update the umbrella in place. Add new findings,
  tick leaves verified in Phase 3, and correct stale findings. Keep the marker
  comment as the first line, keep the body under 60,000 characters (move the
  detail of finished findings into a comment on the issue), and after the edit
  read the body back (`gh issue view <n> --repo {{umbrellaRepo}} --json body -q .body`)
  and confirm the marker is still its first line. Do not re-run the search to
  check an edit: the search index lags. If the marker search found only a
  closed umbrella, do not create another and do not edit it; report that and
  file nothing. If it found none at all, create one with the marker comment and
  the `automation-blocked` label, so no issue batch tries to implement it.
- **`leaves` only:** for each **New** or **Exists as prose** finding that is one
  pull request and was checked on the default branch or reproduced, search the
  target repository for a duplicate, then file a leaf: a first line
  "Part of <umbrella>", then Problem, Scope, Acceptance criteria, Evidence, and
  the entry ids it retires. Add the leaf to the umbrella's task list.
- A leaf that changes what every agent session does (a new blocking or
  session-start hook) gets the `automation-blocked` label and a line saying the
  operator must remove it to release the work. If the target repository has no
  such label, do not file the leaf; keep it on the umbrella, marked held.
- Check each label by exact name before using it:
  `gh label list --repo <owner/repo> --search <name> --json name -q '.[].name' | grep -Fx <name>`
  (the search is fuzzy, and a bare `gh label list` shows only the first 30).
  Apply rules 4 and 5.

### Phase 9 — Retrospective and summary

Run the notebook retrospective. You opened every shelf as data, so vote only
for lessons that guided how you did this task (vote by id), and add at most one
new lesson of 200 characters or fewer. Then end with a summary the operator can act on without opening
the report: the entries ready to retire with their commands, the top new
findings, the corrections, and the report path.

## Idempotency rules

1. One umbrella. Find it by its marker, open or closed. Update it if it is open; if it is closed, file nothing. Never create a second.
2. Never file a leaf for a finding that already has one, open or closed. The
   umbrella's task list and a per-finding issue search are both checked.
3. The map is carried forward, not rebuilt. A finding keeps its key across runs.
4. Report files are never overwritten. A second run on the same day writes
   `-run2` files and diffs against the first run's.
5. A run that finds nothing new and nothing ready to retire is a valid result.
   Say so in two lines.

## Anti-patterns

- **Trusting the working directory.** The first run of this analysis read hooks
  and skills from a checkout 416 commits behind and had to redo its checks.
- **Concluding from a truncated or case-sensitive search.** Two "nothing covers
  this" claims in the first run were wrong for this reason.
- **Proposing what exists.** The janitor, the reflection playbook, the layered
  memory work, user-level hooks and the review skill each already covered
  something the first draft proposed. Check Phase 5's whole list.
- **Reporting a 30-day total as a current problem.** A failure rate quoted from
  the 30-day window had already fallen from 40% to 8% in the last four days.
- **Calling a lesson obsolete because another lesson says so.** Verify in the
  repository, or mark `recheck`.
- **Marking judgement as mechanical.** A reviewer heuristic about one bug shape
  is not a hook. When in doubt, leave it.
- **Removing entries.** Even when a fix is verified, the playbook only lists
  the commands.
