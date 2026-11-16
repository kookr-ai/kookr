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
blocks. It adds a short suggestion to the agent's context in two cases:

- a `while`/`until` loop that calls `pgrep -f`. The loop's own shell matches the
  pattern, so the loop never ends. The nudge points to `kookr-wait.sh`.
- a test or gate command (`pnpm test`, `vitest`, `scripts/verify.sh`, ...)
  piped into `tail` or `head` with no `tee`, `pipefail` or `PIPESTATUS`. That
  throws away the full log and hides the exit code. The nudge suggests
  `cmd 2>&1 | tee "$LOG" | tail -40; echo "exit=${PIPESTATUS[0]}"`.

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
