# Design note: the reading pane's Changes and Pull request tabs

Status: Implemented (slices 1 to 3)
Date: 2026-11-16
Issue: #4024 (item 4), from #3561 variant B ("terminal, changes and pull request become tabs")

## Problem

The reading pane has three tabs today: Conversation, Terminal and "GitHub (n)".
Two things from variant B are missing:

- **There is no list of what a task changed.** The only diff view is the
  per-edit diff: clicking an Edit or Write row in the conversation opens one
  tool call's patch in the terminal pane, behind a Terminal / Diff switch. To
  see everything a task changed, the operator opens a terminal and runs
  `git diff`, or waits for the pull request.
- **The GitHub tab is named after the service, not the thing.** It lists every
  PR and issue the task mentioned, under a count that does not say what it
  counts.

## Where the per-task change list comes from

Two sources exist, and they answer different questions:

| Source | What it shows | When it exists |
|---|---|---|
| The task's worktree (`git diff` against the base) | Everything the task changed so far, committed or not, including new files | While the worktree exists: the whole time the task runs, and after it ends until the worktree is removed |
| The task's pull request (`gh api …/pulls/N/files`) | What was pushed and is under review | From the first push; outlives the worktree |

**The Changes tab reads the worktree.** It is the only source that shows work
in progress, which is when the operator most wants to look. The pull request's
file list is the fallback once the worktree is gone (slice 3).

### Choosing the base

The diff is `git diff <merge-base>` against the working tree, plus untracked
files that `.gitignore` does not exclude. The merge base has to be the branch
the task forked from, or the list fills with other people's commits. Branches
in this repository are cut from `origin/staging` or from `origin/main`, and
`staging` is often far ahead of `main`. A diff against the wrong one lists
dozens of files the task never touched. The server picks the base this way:

- **The candidates** are `origin/main`, `origin/staging` and `origin/master`,
  plus the task's own pull request base when it has one (a pull request whose
  head branch is the worktree's current branch, `baseBranch` from the GitHub
  state store, as `origin/<baseBranch>`). A PR that the task only mentioned
  does not count.
- **The nearest one wins:** the candidate with the fewest commits between its
  merge base and `HEAD`. On a tie the pull request base wins, then the order
  above.
- **The pull request base never overrides a nearer candidate.** In this
  repository a pull request opens against `main` and is moved to `staging`
  only when it merges, while the branch was cut from `staging`. Trusting the
  PR base would list every unpromoted staging commit for the whole life of
  the pull request. It still matters for a repository whose pull requests
  target another branch (a `release` branch, say) and as the tie-breaker.

The tab names the base it used ("against origin/staging"), so a wrong guess is
visible instead of silent.

### What the server returns

- `GET /api/tasks/:id/changes` returns the list: the base ref, the branch, and
  per file the path, the status (added, modified, deleted, renamed) and the
  added and removed line counts. Binary files are marked and carry no counts.
- `GET /api/tasks/:id/changes/file?path=<path>` returns one file's patch, as
  hunks in the shape the existing diff view already renders.

Both read the task's directory from the task store, never from the request.
The file route only answers for a path that is in the computed list, so it
cannot be used to read other files. Git runs with array arguments (no shell),
`--no-ext-diff --no-textconv`, `GIT_OPTIONAL_LOCKS=0`, a timeout and an output
cap; a patch over the cap comes back as "too large" instead of a truncated
diff.

Git runs only when the operator opens the tab, presses Refresh or opens a
file's diff, never on a timer: the host already runs many workers, and a diff is cheap only when
nobody runs it in a loop. For the same reason the tab is labelled "Changes"
without a count: a count would mean running git for every task the operator
selects, not only for the tab they open. The file count and the line totals
are in the tab's header line instead.

### When there is nothing to show

The tab shows one plain line instead of an empty list:

| Case | What the tab says |
|---|---|
| The task has no working directory recorded | No working directory is recorded for this task. |
| The directory is gone (worktree removed), and the task has no own pull request | This task's worktree was removed, and no pull request of its own is known. |
| The directory is gone, and GitHub did not answer for the pull request's files | This task's worktree was removed, and GitHub did not answer for its pull request's files. Press Refresh to try again. |
| The directory is not a git repository | This task does not run in a git repository. |
| No base branch can be found | No base branch to compare against (no origin/main, origin/staging or origin/master). |
| The branch has no changes yet | No changes against origin/staging on `<branch>`. |

A task that runs in a shared checkout instead of its own worktree gets the
checkout's diff, which can include other work; the header shows the branch so
this is visible.

## What each tab shows

**Changes** (new, slice 1). A header line with the base, the branch, the file
count and the total `+added −removed`, and a Refresh button. Below it, one row
per file: status letter, path (directory dimmed, file name bright) and line
counts. Clicking a row opens that file's diff in place, under the row; clicking
again closes it (variant A below). The tab shows for every task, in the tabbed
layout and in Split view's left pane; an agent with no task has none.

**Pull request** (renamed from "GitHub (n)", slice 3). The task's own pull
request first, as a summary: title, state, checks, review decision, unresolved
threads and the branch → base line. Other PRs and issues the task mentioned
follow under a "Mentioned" heading, one line per PR. The tab is titled "Pull
request" ("Pull requests (n)" for several), and a task with no PR of its own
gets a tab titled "Mentioned (n)" with only that list.

GitHub does not record which task opened a pull request, so one rule decides,
shared by the dashboard and the server (`src/shared/task-own-pull-requests.ts`):

- A PR cited in the task's prompt is never its own.
- When PRs are on the task's branch, those are its own, and no other.
- Otherwise, a PR the agent mentioned is its own when it was opened at or
  after the task was created. The branch alone cannot rule a PR out: it is
  the branch of the session's directory, which can be the checkout the task
  was launched in when the agent pushed from a worktree it created itself.

**The pull request fallback** (slice 3). When the worktree is gone (or no
directory was recorded) and the task has an own pull request that is not
closed, the Changes tab lists that PR's files from
`gh api repos/O/R/pulls/N/files` instead (the most recently opened PR when
there are several). The header says "from pull request #N (the worktree was
removed)", and a file GitHub gives no patch for (binary, or a very large
diff) says so. GitHub is asked only on tab open, Refresh or opening a file;
the list is kept for 60 seconds so opening several files asks once, and
Refresh asks again. The file route still answers only for a path in that
list.

**Per-edit diffs** (slice 2). Clicking an Edit or Write row in the conversation
opens that one edit's patch at the top of the Changes tab, instead of in the
terminal pane, so the terminal pane's Terminal / Diff switch is gone. The
file's row in the list below is marked "opened edit" (matched through the
`repoRoot` the list carries); an edit outside the repository, or with the
list unavailable, still shows its patch. Escape or the card's close button
returns to the tab the edit was opened from and gives focus back to the row
that opened it; in Split view the left pane switches to Changes and back. An
agent with no task gets a Changes tab only while an edit is open. Keeping the
edit as a card above the list, rather than inside its row, means the same
view works when the file has no row.

A completed task with a completion digest shows the digest instead of the
tabs; that does not change here.

## Variants

Three layouts for the two tabs were mocked from the dashboard's real colour
tokens and published for the operator (linked from #4024):

- **A · Inline accordion:** the file list is the tab; a file's diff opens under
  its row. Works at every pane width and in Split view.
- **B · List and diff side by side:** file list on the left, diff on the
  right. Best on a wide pane; at 500–700 px the diff gets about 350 px.
- **C · Drill-in:** the list fills the tab; a file opens full width with a back
  arrow and previous / next buttons. Best on a narrow pane, one more click per
  file.

Recommended: **A**. The reading pane is 500–970 px wide (the #4024 width
table), which leaves B's diff column too narrow on most windows, and A keeps
the list in view while reading a diff, which C does not. The operator chose
**A** (answered on Telegram, relayed on #4024).

## Slices

1. **Change list and Changes tab** (#4063): the two routes, the tab in the
   tabbed layout and in Split view's left pane, Refresh, the empty states.
2. **Per-edit diffs open in the Changes tab:** route conversation diff clicks
   there and remove the terminal pane's Terminal / Diff switch.
3. **Pull request tab:** rename "GitHub (n)", put the task's own PR first, and
   fall back to the PR's file list in Changes when the worktree is gone.
