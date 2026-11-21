# Claude accounts and account switching

Kookr can run Claude Code tasks on more than one Claude subscription, and can
move a task from one subscription to another while it runs. Use it when one
host has access to several plans (a personal Max plan and a team plan, say) and
a usage limit on one of them should not stop the work.

## How it works

Claude Code reads an OAuth token from the `CLAUDE_CODE_OAUTH_TOKEN` environment
variable and prefers it over the login stored in `~/.claude/.credentials.json`.
`claude setup-token` prints such a long-lived token for the account you are
signed in to in the browser.

Kookr keeps named tokens in a registry and gives a task's agent the token of
the account the task is on. Everything else stays shared: settings, plugins,
and the `~/.claude/projects` transcripts. Because the conversation is a local
transcript, a task moved to another account continues the same conversation
with `claude --resume`.

The account named `host` is the host's own `claude login`: no token is
injected. It always exists and it is the default, so a host that never adds an
account behaves exactly as before.

## Adding accounts

On any machine with a browser, sign in to the subscription you want and run
`claude setup-token`. Then, on the Kookr host:

```bash
claude setup-token | kookr account add work     # pipe the output in, or
kookr account add personal                      # paste the token when asked
kookr account test work                         # one tiny request on that account
kookr account list
```

`kookr account add` reads the token from stdin, never from the command line,
and finds it inside the full `setup-token` output. `kookr account list` never
prints a token, only its last four characters. Running `add` again with an
existing name replaces its token.

The registry is `~/.kookr/claude-accounts.json`, readable by your user only
(mode `0600`). It is shared by every Kookr instance of that user (prod on 4800
and dev on 4801), like `~/.claude` is. `KOOKR_CLAUDE_ACCOUNTS_FILE` moves it.

## Choosing the account for new tasks

```bash
kookr account default work                 # new tasks run on "work"
kookr spawn --account personal "Fix #123"  # this task runs on "personal"
kookr account default host                 # back to the host login
```

A task is pinned to an account at its first launch (the `--account` it was
spawned with, else the default at that moment), stored as
`metadata.claudeAccount`. Changing the default later does not move tasks that
already started; crash recovery, queue promotion and Reopen all relaunch a task
on its pinned account.

## Switching a task

```bash
kookr account switch <taskId> personal
```

- **Running task:** Kookr stops its agent and relaunches it in place on the new
  account, continuing its conversation. The task keeps its worktree, branch,
  issue claims and parent; it is never cancelled. The agent is told the process
  was restarted and to re-check its state, and an agent that was waiting for an
  answer is told to ask again. If no slot is free the task waits in the queue
  and the command says so. The resume request of a queued task is held in
  server memory, as for Reopen: if the server restarts before the task
  relaunches, it starts fresh from its prompt.
- **Task not running** (pending, finished, reaped): only the pin changes. The
  next launch, for example `kookr reopen`, uses the new account.

A switch is refused for a task that is not Claude Code, for an active Ralph
loop (every iteration starts fresh, so there is no conversation to move), and
for a running task that has not recorded a conversation yet or whose
transcript is gone (relaunching it would start over from the prompt). Each switch writes a
`task.claudeAccountSwitch` row to `audit.jsonl`.

The server side is `POST /api/tasks/:id/claude-account`; see the
[API reference](api.md#post-apitasksidclaude-account).

## Usage limits and the quota gate

Kookr's plan-quota admission gate (and the quota shown in the dashboard) reads
the usage of the host login only. A launch on another account is therefore not
refused or rotated to another agent because the host account is exhausted.
Kookr does not read the usage of other accounts; Claude Code reports a usage
limit on the account a task runs on in the usual way, and the task shows as
provider-paused. Switching it to another account is the way out.

When new tasks default to another account, the soft-quota orchestration pause
no longer reads the host's usage either: `GET /api/orchestration/status`
reports the quota sample as unsupported. One place still compares against the
host account: the timers that reclaim a provider-paused task use the host's
reset times. For a task on another account they can hold or release it at the
wrong moment, but never past the usual hard limit (2 hours by default).

## Limits and safety

- Removing an account (`kookr account remove`) does not touch running agents,
  but a task pinned to it will not launch again until it is switched. Kookr
  never falls back to the host login on its own, because that would spend a
  subscription you did not choose.
- A launch on a registered account blanks `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` for that agent: Claude Code ranks both above the OAuth
  token, so an API key in the server's environment would otherwise be billed
  instead of the chosen subscription.
- Subagents of a task run inside its Claude Code process and use its account.
  A child task spawned with `kookr spawn` is a new task and gets the default
  account unless it passes `--account`.
- Tokens live in the registry file and in the environment of the agent process
  that uses them. They are not written to `tasks.json`, logs or API responses.
- Only Claude Code tasks have accounts. Codex, Grok Build and opencode are
  unaffected.

## What has been tested

Verified on Claude Code 2.1.330: the environment token overrides the stored
login, and a bogus one fails with a 401 rather than falling back to it; an
empty `ANTHROPIC_API_KEY` counts as unset. In a live run, a task launched on an
account whose token was invalid got past the host quota gate, failed with a
401, and was switched to `host`. It relaunched in place with
`claude --resume`, kept its conversation (it still knew a word given only in
its first prompt) and finished. Resuming a conversation that already has
assistant turns under a second real subscription has not been tested.
