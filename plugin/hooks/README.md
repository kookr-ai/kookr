# Kookr Toolkit Hooks

Plugin hooks are registered through `plugin/hooks/hooks.json`, not through the
plugin manifest. Claude Code loads these hooks when the toolkit is supplied via
`--plugin-dir`.

## Registered Hooks

`reflect-memory-frontmatter-gate.sh` blocks unsafe memory writes from reflection
workflows when the frontmatter marks the entry as behavioral feedback. It is
registered for `Write`, `Edit`, and `MultiEdit` events.

## Skill Load Counter

`skill-load-counter.sh` is an append-only telemetry hook registered for
`PreToolUse` with matcher `Skill`. On every skill invocation it appends
`{"skill": "<name>", "ts": "<utc>"}` to `~/.claude/kookr-skill-load-log.jsonl`
(override the path with `KOOKR_SKILL_LOAD_LOG`; disable with
`KOOKR_SKILL_LOAD_COUNTER_SKIP=1`). It never blocks the invocation: every
failure path (missing jq, malformed payload, unwritable log) exits 0 silently.
The data informs which skills actually get used when scoping quality passes
(RFC plugin-skill-improvements, Phases 2-3).

## Shared Chrome Notice

Claude in Chrome (the browser extension behind the `mcp__claude-in-chrome__*`
tools) drives the operator's real Chrome profile, and several agents can use it
at once. Tabs are mostly safe: the extension gives each Claude Code session a
private tab group that other sessions cannot see, although subagents share
their parent session's group. The risk is everything else the profile shares:
sign-ins, the server-side state of the accounts behind them, and the downloads
folder. Modal dialogs (JavaScript alerts and confirmations) are a hazard too,
because one left open can stop the extension from responding.

`shared-chrome-notice.sh` is registered for `PostToolUse` with matcher
`mcp__claude-in-chrome__.*`. The first time an agent uses a Chrome tool, the
hook adds a short notice to that agent's context. The notice says: work only in
your own tabs, never log out or clear site data, change only the account data
your task needs, identify downloads by exact name, avoid triggering dialogs,
and stop and report to the operator if the task needs something forbidden.
Later Chrome calls by the same agent stay silent.

A subagent shares its parent's `session_id` but has its own context, so the
hook tracks every (`session_id`, `agent_id`) pair separately. It records which
agents were told with one marker directory per pair under
`${TMPDIR:-/tmp}/kookr-shared-chrome-notice-<uid>/` (override with
`KOOKR_SHARED_CHROME_NOTICE_DIR`; disable with
`KOOKR_SHARED_CHROME_NOTICE_SKIP=1`). Markers are never deleted by the hook;
the OS clears them with the temp directory. It requires `jq`; without it the
hook does nothing. It never blocks the tool call: every failure path exits 0
with no output.

Known limitation: the notice is shown once per agent. If `/compact` drops it
from the conversation summary, the agent is not told again, because compaction
keeps the same session and agent ids.

## Placement Gate

`placement-gate.sh` is an advisory `PreToolUse` hook for new skills and agents.
It performs deterministic path checks only:

- In the Kookr repo, new `.claude/skills/<name>/` files warn unless `<name>`
  starts with `kookr-`.
- In the Kookr repo, new `plugin/skills/kookr-*/` files warn because the
  `kookr-toolkit:` namespace already identifies distributed runtime skills.
- New `.claude/skills/<name>/` files warn when `plugin/skills/<name>/` already
  exists.
- In the Kookr repo, new `plugin/agents/kookr-*.md` files warn for the same
  namespace reason. Other repositories are not subject to Kookr's naming rule.
- In the Kookr repo, new `.claude/agents/<name>.md` files warn unless `<name>`
  starts with `kookr-`.

The gate ignores `node_modules/`, `dist/`, `build/`, `target/`, `.next/`,
`.svelte-kit/`, and Kookr-managed `.claude/worktrees/` paths.

By default the hook warns and allows the tool call. To make warnings block in a
repo, create `.kookr-placement-gate-strict` at the main checkout root. The hook
resolves this marker through `git rev-parse --git-common-dir`, so one marker
covers linked worktrees. For a deliberate one-off bypass, set
`KOOKR_PLACEMENT_GATE_SKIP=1` on the tool call environment.

For Bash tool calls, the hook inspects only literal writes using `cat >`,
`cat >>`, `printf ... >`, `echo ... >`, `tee`, `tee -a`, `cp`, and `mv`. It
does not try to evaluate variables, interpreter-internal writes, `dd of=`, or
Codex `apply_patch`. The push-time `hooks/skill-placement-gate.sh` remains the
cross-runtime final catch-net for the Kookr repo.

Claude Code loads plugin hooks via `--plugin-dir`, and Kookr's Codex fork now
loads both plugin skills and plugin hooks from that path. (Earlier revisions
noted the Codex fork loaded skills but not hooks; that gap is closed.) The
OSS-extension enforcement hooks nonetheless keep a user-global install (see
`docs/hooks-setup.md`) so they also fire for non-agent `gh pr create` — a plain
terminal or CI context, where no plugin is loaded at all.

## Bash Wait Nudge

`bash-wait-nudge.sh` is a `PreToolUse` hook on `Bash` that only nudges, never
blocks. It adds a short suggestion to the agent's context in four cases:

- a `while`/`until` loop that calls `pgrep -f`. The loop's own shell matches the
  pattern, so the loop never ends. The nudge points to `kookr-wait.sh`.
- a test or gate command (`pnpm test`, `vitest`, `scripts/verify.sh`, ...)
  piped into `tail` or `head` with no `tee`, `pipefail` or `PIPESTATUS`. That
  throws away the full log and hides the exit code. The nudge suggests
  `cmd 2>&1 | tee "$LOG" | tail -40; echo "exit=${PIPESTATUS[0]}"`.
  `git push` counts as a gate command: it runs the pre-push tests, and a cut
  log hides the name of the test that failed.
- `pkill -f PATTERN`. The agent's own shell has PATTERN in its command line,
  so pkill kills that shell too. The nudge suggests killing by PID, or
  stopping a background task by its id.
- `gh issue view N --comments` (or its short form `-c`) without `--json`.
  When its output is not a terminal it prints only the comments, and nothing
  for an issue without comments. The nudge suggests `gh issue view N --json title,body,comments`.

Safe forms stay silent. Set `KOOKR_BASH_WAIT_NUDGE_SKIP=1` to turn it off.

`kookr-wait.sh` is the safe wait primitive: `kookr-wait.sh --pid PID` or
`kookr-wait.sh --file MARKER` with an explicit `--timeout` (default 600 s,
exit 124 on timeout). For a job you start, write its exit code to a marker:
`( cmd >"$LOG" 2>&1; echo $? >"$LOG.exit" ) &` then
`kookr-wait.sh --file "$LOG.exit"`. Run it via
`${CLAUDE_PLUGIN_ROOT}/hooks/kookr-wait.sh`.

## Merge Retarget Guard

`merge-retarget-guard.sh` is a `PreToolUse` hook on `Bash` that blocks a
pull-request merge which would skip the integration branch (issue #3803). It
acts only when the repository of the command's working directory names an
integration branch in `.kookr/delivery-gate.json` on `origin/main`; anywhere
else it allows everything. There it denies:

- `pnpm merge` (also `pnpm -s merge`, `pnpm -C <dir> merge`, `npm run merge`) in
  a checkout whose `scripts/kookr-merge.sh` has no retarget step;
- `bash <path>/kookr-merge.sh` when that script has no retarget step;
- bare `gh pr merge` and `gh api --method PUT .../pulls/<n>/merge` when the pull
  request's base is `main`, or when its base cannot be read.

The working directory starts at the event's `cwd` and follows `cd`, `pushd` and
`pnpm -C`, so `cd /old/checkout && pnpm -s merge 42` is caught. Words inside
quotes and heredocs are not commands, so a commit message that mentions
`pnpm merge` passes. The denial names the one correct command,
`kookr merge <PR> --repo <owner/name>`, which always runs the merge wrapper of
the deployed production checkout. `kookr merge` itself is always allowed.

## Closes Keyword Guard

`closes-keyword-guard.sh` is a `PreToolUse` hook on `Bash` (issue #4185) that
checks the body of a `gh pr create` or `gh pr edit` for a closing reference
GitHub will ignore. GitHub closes an issue on merge only when a closing keyword
(`close`, `fix`, `resolve` and their forms, followed by `#N` or
`owner/repo#N`) is written as plain text. Inside inline code or a fenced code
block it is ignored, and an inline `(#N)` reference closes nothing.

- A closing keyword that appears only inside code is denied. The denial prints
  the bare form to write instead. When the branch names an issue
  (`issue-<N>`), only that issue's keyword is checked, so a quoted `git log`
  line about another issue passes.
- When the branch names an issue and the body mentions `#N` only as `(#N)`, the
  command is allowed and the agent gets a warning that suggests `Closes #N`.

The scanned text is every heredoc body in the command, the quoted value of
`--body`/`-b`, and the `--body-file`/`-F` file when it already exists (a
relative path is looked up in the `--head` branch's worktree, then in the
directory the command runs in, following `cd`). The title and chained
commands are not scanned. The check used to live in the user-level
`hooks/pr-workflow-gate.sh` (issue #3642); it moved here because Kookr starts
its agents with `--setting-sources ''`, which skips user-level hooks but still
loads plugin hooks from `--plugin-dir`. It fails open: a crash or a missing
`node` allows the command, and a crash is logged to `~/.kookr/hook-errors.log`.

## Pull-Request Delivery Note

`pr-create-delivery-note.sh` is a `PostToolUse` hook on `Bash` (issue #3913).
`gh pr create` prints only the new pull request's URL, so an agent opening a
pull request against `main` in a repository that merges through an integration
branch is not told that this is expected, and may change the base or merge with
`gh`. After such a `gh pr create`, the hook adds one note to the agent's
context: the pull request is open against `main`, which is expected;
`kookr merge <PR> --repo <owner/name>` will retarget it to the integration
branch and merge it there; the train then runs the full suite and moves `main`,
and comments on the pull request; do not change the base and do not merge with
`gh`. A pull request opened against the integration branch directly gets a note
that this works but is not needed.

It says nothing when the repository has no integration branch
(`.kookr/delivery-gate.json` on `origin/main`), when `--repo` names another
repository, when the base is any other branch (a stacked pull request), or when
the output holds no pull-request URL (a failed create, `--web`). It reuses the
word splitter of `merge-retarget-guard.mjs`, so a commit message that mentions
`gh pr create` is not a pull request. It never blocks: it always exits 0, and a
crash or a missing `node` prints nothing.

## Rm Dynamic Path Guard

`rm-dynamic-path-guard.sh` is a `PreToolUse` hook on `Bash` that denies a
recursive `rm` whose target is computed by the shell (issue #3867). Claude Code
cannot see where such a path points, so it asks a human for permission even in
`bypassPermissions` mode. In an unattended task nobody answers: on 15 Nov 2026
two review agents cleaning up a temp directory with
`rm -rf "$(cat <scratchpad>/mutdir)"` waited 76 and 52 minutes. A hook denial
reaches the agent at once, so it retries instead of waiting.

It denies `rm` at command position (also `/bin/rm`, `sudo rm`, and after `&&`,
`;`, `|`, `do` or `then`) when it has a recursive flag (`-r`, `-R`, a cluster
such as `-rf`, or `--recursive`) and a target containing a variable or a
command substitution: `rm -rf "$(cat f)"`, ``rm -rf `cat f` ``, `rm -rf "$DIR"`,
`rm -r -- $X`. The denial tells the agent to print the path first and delete it
by its literal path, or to empty a directory with
`find /literal/dir -mindepth 1 -delete`.

Allowed: literal targets (`rm -rf /tmp/x/scratchpad/mutdir`), non-recursive
`rm "$f"`, `git rm -r dir`, a variable in a redirect (`2>>"$LOG"`) or a
here-string (`<<< "$x"`), and text that only mentions such a command (inside
quotes, a commit message, a grep pattern, a heredoc body, or a `#` comment with
no `;`, `&`, `|`, `(` or `)` before the `rm`). It reuses the word splitter of
`merge-retarget-guard.mjs`.

Known limits: it does not look inside `bash -c`, `eval`, `xargs rm` or
`find -exec rm`. The command is always also split without comment handling,
so a comment with an operator before the `rm` is read as a command and denied:
`# cleanup; rm -rf "$D"`, `x=1 # a | rm -r $D`. The splitter drops quoting, so
a single-quoted or escaped `$` (`rm -rf '$DIR'`) counts as a variable and is
denied. It never runs a
subprocess, and it fails open: a crash allows the command and is logged to
`~/.kookr/hook-errors.log`.

## Delivery-Step Stop Guard

`delivery-step-stop.sh` (Stop) stops an agent from ending its turn while the
task still owns an actionable delivery step. Ownership evidence is an open PR
from the checked-out branch. It blocks once, with a specific instruction, when:

- the last test/gate command in the transcript failed (red test, PR open);
- (merge-authority tasks only) the PR has no independent review verdict, or the verdict is `block`, or the
  head moved since the `pass` verdict (the agent launches the review itself);
- the PR has a fresh `pass` verdict and the task holds merge authority, as
  `taskHasMergeAuthority` decides (run `kookr merge`).

It stays silent for tasks without merge authority (they stop at an open PR; only the red-test nudge applies) and on repos documenting review as advisory,
when the Stop event reports `background_tasks` / `session_crons` (the agent is
parked on its own work, as in `needs_input:stop`), outside a Kookr task
(`KOOKR_TASK_ID` unset), and on the re-run after a block (`stop_hook_active`).
Every error path allows the stop. Opt out with `KOOKR_DELIVERY_STOP_SKIP=1`.

## Chain Handoff Stop Guard

`chain-handoff-stop.sh` (Stop) stops a self-continuation chain task from ending
its turn with no successor and no recorded stop reason (issue #3678). A chain
task that did this broke its chain with eligible issues still open, and the
task looked like a crash. The hook blocks, with an instruction, when the task:

- is a self-continuation task: playbook parameter `selfContinuation=true`, or a
  prompt carrying `- self-continuation: true`, the rendered
  ``**Self-continuation** — `true` `` toggle, or the continuation-envelope header
  at the start of a line;
- is not a playbook-chain iteration (Kookr launches the next one itself) and not
  an active Ralph loop;
- has no child task and has raised no completion signal.

The instruction covers the three cases: finish an unfinished unit instead of
ending the turn, spawn the successor with `kookr spawn -C <repository checkout>
... --parent-task-id "$KOOKR_TASK_ID"`, or record the stop reason with
`kookr signal completion-ready --note "chain end: <reason>"`. If the agent already
spawned a successor without `--parent-task-id`, it records that child with
`kookr signal completion-ready --note "successor <task id> spawned"` instead of
spawning a second one.

It does not use `stop_hook_active`, because the stop that ends the unit often
comes right after another Stop hook blocked. Instead it blocks at most 3 times
per task (a counter file under the temp directory). Once the task has handed
off (a child task or a signal seen), later stops are allowed even if an operator
message clears the signal. A task not flagged `unattended: true` whose last
message ends on a question (its last line ends in `?`, or that line is
followed only by a short option list; a summary bullet ending in `?` or an
offer such as "Want me to continue with the next issue?" does not count,
issue #4089) is allowed to stop without spending a block, since an operator may be there to
answer (issue #4047); a task flagged unattended is still blocked. Known limits:
any child task counts as the successor, and an unflagged task that asks without
a question mark still uses up the blocks. It stays silent when the
agent is parked on background work and outside a Kookr task. Every error path
allows the stop. Opt out with `KOOKR_CHAIN_HANDOFF_STOP_SKIP=1`.

## Git Add All Guard

`git-add-all-guard.sh` is a `PreToolUse` hook on `Bash` that, in a Kookr task
(`KOOKR_TASK_ID` set), denies a `git add` that stages the whole tree (issue
#3654): `git add -A`, `git add --all` and `git add .`. These stage every
untracked file, so output a test run or a script left in the worktree lands in
the commit; it happened with end-to-end run output, a scratch PR-body file and
pytest fixture output. The denial tells the agent to stage the paths it changed
by name (`git add path/a path/b`), or `git add -u` for tracked files.

It also denies the same forms spelled differently: `-A` inside a flag cluster
(`-fA`), `git add -- .`, `./`, `:/`, `git -C dir add -A`, and an `-A` whose only
paths are exclusions (`git add -A ':!data'`). Redirections are not
paths, so `git add -A 2>&1` and `git add --all >/dev/null` are denied too. Allowed: named paths, `-A` with a
named directory (`git add -A src/new-dir/`), `-u`, `-p`, `-i`, `--renormalize` and dry runs
(`-n`), and text that only mentions the command (a commit message, a quoted
string). It reuses the word splitter of `merge-retarget-guard.mjs` and does not
look inside `bash -c` or `eval`. Off outside a Kookr task and with
`KOOKR_GIT_ADD_ALL_GUARD_SKIP=1`. It fails open: a crash or a missing `node`
allows the command, and a crash is logged to `~/.kookr/hook-errors.log`.

## Worktree Dependency Hint

`worktree-deps-hint.sh` is a `PostToolUse` hook on `Bash` (issue #3652). After
`git worktree add`, when the new worktree has a JavaScript lockfile but no
`node_modules`, it adds one note to the agent's context with the exact install
command for that worktree, for example
`cd /path/to/repo-feat && npm ci`. Lockfiles: `pnpm-lock.yaml` gives
`pnpm install --frozen-lockfile`; `yarn.lock` gives `yarn install --immutable`
(Yarn 2+, `.yarnrc.yml` present) or `yarn install --frozen-lockfile`;
`package-lock.json` and `npm-shrinkwrap.json` give `npm ci`. Other ecosystems
are out of scope.

It only prints the command and never runs the install: an install can take
minutes, would hold the tool call in the foreground, and could race an install
the agent starts itself. The worktree path is read from the command (following
`cd`, `git -C` and the options of `git worktree add`), and the result is
checked on disk: no note unless the directory exists with a `.git` file, a
lockfile and no `node_modules`, so a failed add says nothing. It never blocks:
it always exits 0, and a crash or a missing `node` prints nothing. Off with
`KOOKR_WORKTREE_DEPS_HINT_SKIP=1`.

## Upstream Lag Notice

`upstream-lag-notice.sh` is a `SessionStart` hook (issue #3653). Agents branch
from `origin/main`, but they read code in the checkout they start in, and a
local `main` that lags or has diverged has ended up quoted as evidence in
issues, reviews and subagent briefs. When the session's checkout is behind its
remote default branch, the hook adds one line to the agent's context with the
count and the advice to read code from the remote ref
(`git show origin/main:<path>`) or from a fresh worktree.

The default branch is `origin/HEAD`, else `origin/main`, else `origin/master`.
The hook fetches it first, with a timeout of 1.5 seconds
(`KOOKR_UPSTREAM_LAG_FETCH_TIMEOUT_MS`), so with the network down it adds
under two seconds to the session start; hooks.json also gives it a hard
5-second timeout. The fetch never prompts: HTTPS prompts are off and ssh runs
with `BatchMode=yes` (unless you set your own ssh command), so a passphrase or
host-key question fails the fetch instead of reaching the terminal. When the
fetch fails or times out, it still compares against
the remote-tracking ref from the last fetch and says "at least N commits
behind ... as of the last fetch". That ref can only be older than the remote,
so the count can only be too low, never a false warning. (Issue #3653 asked
for silence when the network is down; on a loaded host a fetch often takes
longer than the timeout, and silence there would hide most real lags.)

It is silent outside a git checkout, without an `origin` remote or its
remote-tracking ref, when `HEAD` already contains the branch, and on a
compaction (`source: compact`), since the session was already told. It never
blocks: it always exits 0, and a crash or a missing `node` or `git` prints
nothing. Off with `KOOKR_UPSTREAM_LAG_SKIP=1`.
