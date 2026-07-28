# CLI Reference

Kookr exposes one public command-line entry point, `kookr`, with subcommands for launching tasks and inspecting a running instance.

Install them globally from a checkout:

```bash
pnpm build
pnpm link --global
```

If you linked Kookr before these commands existed, run `pnpm link --global` again. pnpm records bin symlinks at link time.

The standalone aliases `kookr-spawn`, `kookr-status`, and `kookr-ralph` still work for compatibility, but they are deprecated. Prefer the `kookr <subcommand>` forms below.

## Top-Level Flags

Print the installed package version:

```bash
kookr --version
kookr -v
```

Print root command help:

```bash
kookr --help
kookr -h
```

## Shell Completion

Print a static shell completion script:

```bash
source <(kookr completion bash)
```

```zsh
kookr completion zsh > "${fpath[1]}/_kookr"
```

The completion scripts cover the public `kookr` dispatcher commands, Ralph and maintenance subcommands, and command flags. They do not call the running Kookr server or complete dynamic task IDs.

## `kookr spawn`

Create a Kookr task from your current shell:

```bash
cd ~/git/my-project
kookr spawn "review the diff since origin/main and write a summary"
kookr spawn --json "review the diff since origin/main and write a summary"
```

The task uses `$PWD` as its working directory and appears in the dashboard immediately. Output starts with `task_id=<uuid>` for scripting.

Prompt sources:

```bash
kookr spawn "fix the auth bug"
cat prompt.md | kookr spawn
kookr spawn --prompt-file /tmp/prompt.md
```

`--prompt-file` is the safest form inside Claude Code sessions because hooks inspect the bash command line, not the file contents.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `-C`, `--cwd` | path | Current shell directory | Working directory for the task. Relative paths are resolved from the invoking process's cwd. |
| `-a`, `--agent` | `claude-code`, `codex-cli`, or `grok-build` | Server default | Agent type to launch for this task. |
| `--effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` | Kookr per-agent setting; Codex defaults to GPT-5.6 Sol with no effort override | Reasoning effort override for this task. `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex-cli` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; `grok-build` does not support effort — omit `--effort` (the server rejects any value). |
| `--model` | known Claude model id (e.g. `claude-fable-5`) | Agent CLI / env default | Pin the model for this task (#1518). `claude-code` accepts known Claude ids and dated suffixes; `codex-cli` / `grok-build` reject `--model` (use `KOOKR_CODEX_MODEL` / `KOOKR_GROK_MODEL`). Server returns 400 for invalid values — no silent fallback. |
| `--criteria` | text | unset | Acceptance criteria sent with the task request. This value is argv-exposed; use prompt files or stdin for hook-sensitive text. |
| `--dedupe` | `warn`, `block`, or `skip` | `warn` | Active duplicate-prompt handling. `warn` prompts interactively and blocks in non-interactive shells, `block` exits with code 5, and `skip` creates the task intentionally while suppressing duplicate-cluster findings. |
| `--idempotency-key` | opaque string, ≤200 chars | unset | Retry key (issue #1526). Re-running `kookr spawn` with the SAME key returns the task an earlier attempt with that key already created, instead of launching a second one. |
| `--auto-idempotency` / `--no-auto-idempotency` | none | off (env-controlled) | When no `--idempotency-key` is given, derive one (`auto-<hash>`) from prompt+cwd+criteria+agent so a client-timeout retry of the **identical** spawn replays instead of stranding a duplicate (bounded by the server's rolling 24h idempotency TTL — no calendar component). Only helps retries whose prompt is stable; if your retry regenerates the prompt (embedded random suffix, timestamp), pass an explicit `--idempotency-key` that encodes the logical intent instead. Also enabled by `KOOKR_SPAWN_AUTO_IDEMPOTENCY=1`; `--no-auto-idempotency` forces it off. No effect under `--dedupe=skip`; an explicit `--idempotency-key` always wins. |
| `--wait` | optional seconds via `--wait=<seconds>` | false | Poll until the spawned task raises `completion-ready` or reaches a terminal state. |
| `--parent-task-id` | task id | `KOOKR_TASK_ID` when set | Explicit parent task to link in the dashboard. Mutually exclusive with `--no-parent-task`. |
| `--no-parent-task` | none | false | Launch detached and ignore `KOOKR_TASK_ID`. Mutually exclusive with `--parent-task-id`. |
| `--unattended` | none | false | Mark the task autonomous: the spawned agent's settings deny interactive tools (`AskUserQuestion` and equivalents) so a blocking call fails fast and flags the task **operator-needed** instead of hanging with nobody to answer (issue #1562). |
| `-f`, `--prompt-file` | path | unset | Read the prompt from a file instead of positional argv or stdin. |
| `-h`, `--help` | none | false | Print command help and exit. |

Wait for readiness:

```bash
kookr spawn --wait --prompt-file /tmp/prompt.md
kookr spawn --wait=600 "implement the issue and signal completion-ready"
```

`--wait` keeps the initial `task_id=<uuid>` output, then polls the existing read APIs (`/api/snapshot` for task state, `/api/tasks` for the pending completion signal) until the task raises `completion-ready` or reaches a terminal state. `--wait=<seconds>` bounds the wait. A `completion-ready` signal or `completed` task exits 0. `cancelled` and `terminated` unblock the wait and exit 4. A timeout exits 6.

Duplicate prompt handling:

```bash
kookr spawn --dedupe=warn "fix the auth bug"   # default: prompt on active duplicate; blocks when non-interactive
kookr spawn --dedupe=block "fix the auth bug"  # exit 5 on active duplicate
kookr spawn --dedupe=skip "fix the auth bug"   # create intentionally and suppress duplicate-cluster findings
```

In interactive `warn` mode, `show diff` prints the stored active prompt against the requested prompt before asking again.

In `--json` mode, duplicate `warn` prompts are treated as non-interactive and return `DUPLICATE_BLOCKED` instead of asking for confirmation. Use `--dedupe=skip --json` when automation intentionally wants to keep a duplicate.

Idempotent retries (issue #1526):

```bash
kookr spawn --idempotency-key "kookr-ai/kookr#1526@batch-1" "implement the issue"
```

`--dedupe` compares prompt **content** (prompt + cwd + agent); it is defeated
when the prompt varies between attempts — for example a spawn helper that
embeds a fresh random branch suffix on every call. `--idempotency-key`
instead identifies the logical **request**: re-running the exact same
`kookr spawn --idempotency-key <key> ...` invocation (e.g. after a client
timeout against an overloaded server that had already created the task)
returns the SAME task instead of creating a duplicate, regardless of prompt
content. A terminal task that never actually ran (e.g. queued at capacity,
then reaped before it ever launched) is not replayed — the retry launches
fresh instead; a terminal task that did run (completed or was terminated
after starting an agent) is still replayed. The response prints `↺ Task
already exists (idempotent replay)` instead of `✓ Task created`, exits `0`,
and (in `--json` mode) sets `details.idempotentReplay: true`. Reservations
live in a TTL-bounded ledger on the server (24h). Durability is best-effort,
not absolute: a crash strictly between task-creation and the ledger write can
lose that one reservation, and a ledger persist failure is logged
server-side without failing the request — see [`POST /api/tasks` body
fields](./api.md#post-apitasks-body-fields) for the full server-side
contract and caveats.

Auto-close on completion signal:

```bash
kookr spawn --auto-close-on-signal "implement issue #42 then signal completion-ready"
kookr spawn --no-auto-close-on-signal "..."   # opt out of an inherited policy
```

With `--auto-close-on-signal`, the task auto-completes after its `kookr signal completion-ready` signal has been pending for the configured Auto-close delay (the `autoCloseCompletionReadyDelayMin` setting, default 30 minutes), instead of waiting indefinitely for manual review — freeing an active slot so queued tasks can run. If the flag is omitted, the new task **inherits the policy of its parent task** (the `parentTaskId` linkage, which `kookr spawn` sets from `KOOKR_TASK_ID` by default). That makes the policy propagate automatically down a self-continuation chain. Pass `--no-auto-close-on-signal` to opt a successor out of an inherited policy. See [auto-close-on-signal](./auto-close-on-signal.md).

## Hook-Safe Prompts

Claude Code PreToolUse hooks may block commands whose argv contains strings such as `gh pr create`, `git push --force`, or `rm -rf`.

Hook-safe:

```bash
kookr spawn --prompt-file /tmp/prompt.md
cat /tmp/prompt.md | kookr spawn
```

Not hook-safe:

```bash
kookr spawn "please gh pr create for this branch"
kookr spawn --criteria "ensure gh pr create succeeds"
```

## Dense Supervision From The Shell

For multi-agent sessions, keep long prompts and command-heavy task descriptions in files:

```bash
kookr spawn --prompt-file /tmp/prompt.md
```

This keeps the shell command short, avoids hook false positives, and leaves the dashboard as the main supervision surface. After spawning several tasks, use `kookr status` for a quick terminal snapshot and use the dashboard's dense-supervision controls for routing: `Alt+N` for the next finding, `Alt+T` for desktop terminal focus mode, `Alt+P` for the project sidebar, and `?` for the full shortcut list.

## `kookr signal`

Raise a non-blocking agent -> user signal for the current Kookr task:

```bash
kookr signal completion-ready
kookr signal completion-ready --note "tests green, PR opened"
kookr signal completion-ready --task-id <taskId>
```

The `completion-ready` signal tells Kookr that the agent believes the task is
ready for the user to complete. By default it does not complete or stop the task
by itself; the user still decides what to do in the dashboard.

**Exception — auto-close.** If the task was launched with the `autoCloseOnSignal`
policy (via `kookr spawn --auto-close-on-signal`, an `autoCloseOnSignal: true`
playbook, or inherited from a parent task), a `completion-ready` signal starts
the configured auto-close grace period (the **Auto-close delay** setting, default
30 minutes). If the task is still in progress after that,
Kookr completes it and frees its active slot. Only signal when work is truly
finished — under auto-close the task can close later without another prompt. See
[auto-close-on-signal](./auto-close-on-signal.md).

**Durability (issue #1541).** Every signal is write-behined to a local outbox
(`~/.kookr/playbook-state/signal-outbox/`) *before* the HTTP attempt, with a
client-generated `signalId` for server-side dedup. If the daemon is restarting
or unreachable the command still exits `0` (signal spooled); a background drain
delivers it after reconnect. See [signal-outbox](./signal-outbox.md).

Kinds:

- `completion-ready` - tell the user this task appears ready to complete.

Options:

- `--note <text>` - attach optional context. The server best-effort redacts
  secrets and visibly truncates over-limit notes.
- `--task-id <uuid>` - target a specific task. Defaults to `KOOKR_TASK_ID`,
  which Kookr injects into managed agent sessions.

Hook scripts can use the command after their own readiness checks:

```bash
if pnpm test; then
  kookr signal completion-ready --note "tests passed"
fi
```

Target selection uses the same local-server discovery as `kookr spawn`: first
`KOOKR_API_BASE_URL`, then `KOOKR_PORT`, then local ports `4800` and `4801`.

Exit behavior:

- `0` when the signal is raised **or** durably spooled because the daemon was
  unreachable (JSON envelope uses `code: "SPOOLED"` in the offline case).
- `2` for usage errors, including an unknown signal kind, a missing task id,
  bad flags, or an invalid `KOOKR_PORT`.
- `4` when the server permanently rejects the signal: unknown/terminal task id,
  **or** missing post-task lesson decision (`lesson_decision_required`, issue
  #1538). Permanent failures are dropped from the outbox. For the lesson gate
  the CLI prints the server hint and asks you to run `kb remember …` or
  `printf 'No generic KB lesson: %s\n' '<reason>'` before re-signaling; JSON
  mode reports `code: "LESSON_DECISION_REQUIRED"`.

**Lesson decision (required before completion-ready).** Agents must leave either
a `kb remember` write or an explicit skip marker in the Bash hook trail before
signaling. See [lesson-decision-gate](./lesson-decision-gate.md).

## `kookr lesson`

Operator CLI for the durable lesson-write spool (issue #1519) and the lesson
yield metric (issue #1538):

```bash
kookr lesson status [--json] [--dir PATH]
kookr lesson drain  [--json] [--dir PATH] [--dry-run]
kookr lesson remember --title=<title> [--kb=agent-task-lessons] --stdin --yes
kookr lesson yield    [--json] [--days N] [--kookr-dir PATH]
```

- `status` / `drain` / `remember` — spool health, replay, and write-behind when
  KB is degraded. See [lesson-write-spool](./lesson-write-spool.md).
- `yield` — scan recent completed tasks' hook logs and print the lesson-yield
  rate (`(wrote-lesson + explicit-skip) / completed`). Same metric as
  `GET /api/diagnostics/lesson-yield?days=N` and the `lessonYield` block on
  `GET /api/health`. See [lesson-decision-gate](./lesson-decision-gate.md).

## `kookr issue`

Claim, release, or inspect GitHub-issue ownership (RFC `rfc-issue-ownership-lock`; the server side is flag-gated behind `KOOKR_ISSUE_CLAIMS`).

```bash
kookr issue claim <number> [--repo <owner/repo>] [--force] [--json]
kookr issue release <number> [--repo <owner/repo>] [--json]
kookr issue owner <number> [--repo <owner/repo>] [--json]
kookr issue list [--json]
```

`--repo` is optional; the server resolves the issue's home repo from the caller's cwd (fork-aware — a fork checkout with no `--repo` fails closed). `--task-id` sets the claiming task id (default `KOOKR_TASK_ID`; required for claim/release). `--force` is an operator override that takes over a held claim. `KOOKR_AGENT_ID`, when set, is sent as the claiming session id.

Exit codes (specific to `kookr issue`): `0` you own it — also returned when the server does not support issue claims yet (HTTP 404: proceed as pre-lock); `2` user error; `3` no server reachable (fail closed — do not start work on the issue); `4` server rejected the request (unknown/terminal task, release by a non-owner); `6` claim held by another live task — pick a different issue, or `--force` as an operator.

## Server Discovery

`kookr spawn` and `kookr signal` discover the active Kookr instance with this precedence:

1. `KOOKR_API_BASE_URL`
2. `KOOKR_PORT`
3. Probe local ports `4800` and `4801`

If both default ports respond and no explicit target is set, the command exits with an ambiguity error.

## JSON Output

`kookr spawn`, `kookr status`, `kookr ralph`, and their deprecated standalone aliases accept `--json`. JSON mode prints exactly one envelope to stdout and suppresses human-oriented output:

```json
{
  "ok": true,
  "code": "OK",
  "message": "Task created",
  "details": {}
}
```

The envelope fields are:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` for successful command outcomes, `false` for failures. |
| `code` | string | Stable symbolic result code, such as `OK`, `USER_ERROR`, `NO_SERVER`, `SERVER_ERROR`, or `DUPLICATE_BLOCKED`. |
| `message` | string | Short human-readable summary of the outcome. |
| `details` | object | Command-specific structured data. |

`kookr status` exits `1` for invalid ports, unreachable servers, and unexpected responses; in JSON mode its `code` distinguishes `USER_ERROR`, `NO_SERVER`, and `SERVER_ERROR` while preserving that numeric behavior. When `kookr status --fail-on <severity>` finds an active finding at or above the threshold, it exits `5` and JSON mode returns `code: "FINDINGS_PRESENT"`.

Examples:

```bash
kookr spawn --json --prompt-file /tmp/prompt.md
kookr status --json
kookr ralph status <taskId> --json
```

## Exit Codes

Exit codes are stable for scripts, but **not all verbs share one table**. Branch on the command family below — treating every `2` as “user error” is wrong for `kookr pr-checklist`.

### `kookr spawn` / `kookr ralph` (and deprecated aliases)

| Exit code | Name | Meaning | Commands |
| --- | --- | --- | --- |
| exit 0 | Success | The command completed successfully. | `kookr spawn`, `kookr ralph` |
| exit 2 | User error | Invalid arguments, missing required input, or another local usage error. | `kookr spawn`, `kookr ralph` |
| exit 3 | No server | No Kookr server was reachable, or default-port discovery found multiple possible instances. | `kookr spawn`, `kookr ralph` |
| exit 4 | Server error | The server rejected the request or returned an unexpected failure. | `kookr spawn`, `kookr ralph` |
| exit 5 | Duplicate blocked | Task creation was blocked by duplicate-prompt handling, such as `--dedupe=block` or non-interactive `--dedupe=warn`. | `kookr spawn` |
| exit 6 | Wait timeout | `kookr spawn --wait=<seconds>` timed out before the task reached `completion-ready` or a terminal state. | `kookr spawn` |

The deprecated `kookr-spawn` and `kookr-ralph` aliases return the same codes as their `kookr <subcommand>` forms.

### `kookr doctor`

| Exit code | Meaning |
| --- | --- |
| exit 0 | All required checks passed (`ok` may still include advisory `warn` checks). |
| exit 1 | One or more required checks failed (`ok: false` in the JSON report). |
| exit 2 | Usage error (missing `--json`, unknown flag, or help-only path when help is not requested). |

### `kookr logs`

| Exit code | Meaning |
| --- | --- |
| exit 0 | Records printed, or the task exists but has no hook activity yet. |
| exit 1 | Argument matches neither a known task nor an existing hook log. |
| exit 2 | Usage error (unknown option, non-positive `--lines`, missing/extra args). |

### `kookr maintenance` (`prune` / `backup`)

| Exit code | Meaning |
| --- | --- |
| exit 0 | Prune or backup succeeded. |
| exit 1 | Operation failed (e.g. data directory unreadable, backup archive already exists). |
| exit 2 | Usage error (unknown flag, missing verb, invalid option values). |

### `kookr pr-checklist` (sysexits-style — **do not reuse the spawn/ralph meaning of 2**)

| Exit code | Meaning |
| --- | --- |
| exit 0 | Pass (verify succeeded, or doctor completed). |
| exit **2** | **Verification failure** (checklist findings or fail-closed repo-input error) — **not** a usage error. |
| exit 64 | Usage error (bad arguments, unknown subcommand). |
| exit 70 | Kookr-internal fault (the only class a local hook may treat as fail-open). |

Callers that wire `kookr pr-checklist verify` into CI must treat exit `2` as “gate failed — fix the PR”, not “retry with better args”.

## `kookr status`

Print a read-only snapshot of the running Kookr instance:

```bash
kookr status
kookr status --fail-on critical
kookr status --json
pnpm status
```

The command reads `/api/snapshot` and `/api/health`, then reports server uptime, build version, and per-agent severity counts.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | false | Print one machine-readable JSON envelope to stdout. |
| `--fail-on` | `critical`, `warning`, `info`, or `none` | `none` | Exit `5` when active findings meet or exceed the requested severity. `critical` fails only on critical findings; `warning` fails on warning or critical; `info` fails on any known active finding. |
| `-h`, `--help` | none | false | Print command help and exit. |

Exit behavior:

- `0` when the status snapshot is read successfully and no `--fail-on` threshold is met.
- `1` for invalid `KOOKR_PORT`, unreachable servers, or unexpected server responses.
- `2` for usage errors such as an unknown argument or invalid `--fail-on` value.
- `5` when `--fail-on` is set and active findings meet or exceed the requested severity.

## `kookr doctor`

Run machine-readable launch preflight checks — the CI/bootstrap counterpart to the human-readable shell report from `pnpm doctor` (see [Related Commands](#related-commands)).

```bash
kookr doctor --json
```

`--json` is **required**. Without it the command prints a short usage note pointing at `pnpm doctor` and exits `2`. Use this form in scripts and CI; use `pnpm doctor` for an interactive human report.

JSON envelope shape:

```json
{
  "ok": true,
  "status": "ok",
  "generatedAt": "2026-06-21T07:30:00.000Z",
  "checks": [
    {
      "id": "runtime.node",
      "label": "Node.js",
      "category": "runtime",
      "status": "ok",
      "required": true,
      "summary": "v24.11.1 satisfies >= 22"
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` when no required check has `status: "fail"`. Advisory `warn` checks still allow `ok: true`. |
| `status` | `"ok"` \| `"warn"` \| `"fail"` | Aggregate severity across all checks (`fail` > `warn` > `ok`). |
| `generatedAt` | ISO-8601 string | Report timestamp. |
| `checks` | array | Individual checks (see table below). |

Each check object has `id`, `label`, `category`, `status` (`ok` / `warn` / `fail`), `required`, `summary`, and optional `detail` / `recommendedAction`.

### Check ids

Stable `checks[].id` values on a healthy machine:

| Check id | Category | Required | What it verifies |
| --- | --- | --- | --- |
| `runtime.node` | runtime | yes | Node.js ≥ 22 on `PATH` |
| `runtime.pnpm` | runtime | yes | pnpm ≥ 10 on `PATH` |
| `runtime.git` | runtime | yes | `git` available |
| `runtime.dtach` | runtime | yes | Vendored `vendor/dtach/dtach` executable, or system `dtach` on `PATH` |
| `github.gh-auth` | github | no | `gh auth status` succeeds (advisory warn when not configured) |
| `launch.kb` | launch-dependency | no | `kb doctor --format=json` and a smoke `kb search` both succeed |
| `agent.claude` | agent | yes if `KOOKR_AGENT_BIN` set; else advisory | Claude Code binary (`KOOKR_AGENT_BIN` or `claude`) |
| `agent.codex` | agent | yes if `KOOKR_CODEX_BIN` set; else advisory | Codex CLI binary (`KOOKR_CODEX_BIN` or `codex`) |
| `agent.codex-plugin-dir` | agent | no | Codex advertises `--plugin-dir` (only emitted when `agent.codex` is `ok`) |

When the KB path fails, the single KB row is replaced by a more specific id:

| Check id | When it appears |
| --- | --- |
| `launch.kb-doctor` | `kb doctor --format=json` failed or is unavailable |
| `launch.kb-search` | `kb doctor` passed but the smoke search failed |

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--json` | none | required | Print one machine-readable JSON report to stdout. |
| `-h`, `--help` | none | false | Print command help and exit `0`. |

Exit behavior:

- `0` when all required checks pass (`ok: true`; advisory warnings allowed).
- `1` when one or more required checks fail (`ok: false`).
- `2` for usage errors, including missing `--json` or an unknown argument.

## `kookr logs`

Tail a task's recent hook-event activity from the shell — the read-side
counterpart to the hook *write* path (`bin/kookr-hook-writer.js`) and the
*replay* path (`scripts/replay-hooks.ts`). It answers "what is this task doing?"
without opening the dashboard or booting a server:

```bash
kookr logs <taskId>
kookr logs <taskId> -n 50
kookr logs <taskId> --json
kookr logs <taskId> --dir ~/.kookr-4801
```

`kookr logs` operates directly on the on-disk data directory (like
`kookr maintenance`). It resolves the data directory the same way, looks the
task up in `tasks.json`, reads each of its sessions' persisted hook JSONL under
`<dataDir>/hooks/<session>.jsonl` — including any rotated `<session>.jsonl.N`
generations the writer's size cap split off (issue #1433), stitched in
chronological order — parses records with the same framing parser the production
ingestion route uses, and prints the most recent records (newest last). Known secret formats in event payloads are redacted on the read
path, since output may be pasted into bug reports.

`<taskId>` is a Kookr task id (from the dashboard, or the `task_id=` line printed
by `kookr spawn`). A session / hook-log id (e.g. `kookr-020f33cb`) is also
accepted as a direct fallback when it does not match a known task.

Options:

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `-n`, `--lines` | positive integer | `20` | Show the last N records across the task's sessions. |
| `--json` | none | false | Print one machine-readable JSON envelope (`taskId`, `dataDir`, `hookLogs`, `totalRecords`, `records[]`) instead of the human summary. |
| `--dir` | path | resolved from `KOOKR_PORT` | Read from an explicit data directory (e.g. a dev instance's `~/.kookr-4801`). |
| `-h`, `--help` | none | false | Print command help and exit. |

Exit behavior:

- `0` when records are printed, or the task exists but has no hook activity yet.
- `1` when the argument matches neither a known task nor an existing hook log.
- `2` for usage errors such as an unknown option or a non-positive `--lines`.

## `kookr command outcome`

Inspect recorded local and remote outcomes for terminal commands:

```bash
kookr command outcome
kookr command outcome <commandId>
```

The command reads local interaction logs and the remote command journal from the
Kookr data directory, then prints one JSON object per line. Without an argument,
it prints every recorded outcome in timestamp order. With a `commandId`, it
prints only matching records.

Output records include fields such as `source`, `commandId`, `action`,
`outcome`, `timestamp`, `agentId`, and `taskId` when those values are available.
If a specific `commandId` has no local or remote records, the command prints:

```json
{"commandId":"<commandId>","outcome":"unknown-never-seen"}
```

Exit behavior:

- `0` when the query completes, including the `unknown-never-seen` case.

## `kookr ralph`

Inspect or control a Ralph loop:

```bash
kookr ralph status <taskId> [--json]
kookr ralph pause <taskId> [--json]
kookr ralph resume <taskId> [--json]
kookr ralph cancel <taskId> [--json]
```

If a loop appears stopped after a crash, relaunching the same playbook may show a duplicate-loop conflict or a **Replace with new** recovery dialog. See [Ralph Loop Stopped Or Shows "Replace With New"](../troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new) before editing local state by hand.

## `kookr drain` / `kookr resume`

Control operator drain mode on a running local Kookr instance:

```bash
kookr drain
kookr drain status
kookr resume
```

Drain mode refuses new task launches while already-running agents continue. Use it before maintenance restarts or deploys when you want the current work to settle without accepting more launches. `kookr resume` re-opens launches after the maintenance window.

`kookr drain status` is read-only. `kookr drain` and `kookr resume` POST to the server admin endpoints and print the resulting state, including the number of running tasks when the server reports it.

Target selection:

- `KOOKR_PORT=<port>` targets a specific local instance on `127.0.0.1`.
- When `KOOKR_PORT` is unset, Kookr probes ports `4800` then `4801`.
- If `KOOKR_ADMIN_TOKEN` is set, the CLI forwards it in the admin-token header.

Exit behavior:

- `0` when the request succeeds, including an already-draining or already-accepting state.
- `1` when the target server cannot be reached, rejects admin auth, or returns another non-2xx response.
- `2` for usage errors such as an unknown drain verb.

## `kookr maintenance prune`

Prune aged completed-task artifacts (hook logs, activity ledgers, rotated `server.log.N`, and `playbook-state` run directories) from a Kookr data directory:

```bash
kookr maintenance prune --dry-run
kookr maintenance prune --max-age-days 14 --dir ~/.kookr-4801
kookr maintenance prune --playbook-keep-last 5
kookr maintenance prune --json
```

The command operates directly on disk and does not require the Kookr server to be running. By default it targets `~/.kookr`, or `~/.kookr-<port>` when `KOOKR_PORT` is set to a non-default numeric port. Pass `--dir` to target a specific data directory, especially for instances launched with `KOOKR_PORT=auto`.

Options:

- `--dry-run` - print the prune plan without deleting files.
- `--max-age-days <n>` - prune eligible artifacts older than `n` days; the default is 30.
- `--playbook-max-age-days <n>` - age threshold (days) for `playbook-state` run directories; defaults to `--max-age-days`.
- `--playbook-keep-last <k>` - always keep the newest `k` runs per playbook regardless of age; the default is 0 (age-only).
- `--dir <path>` - use an explicit Kookr data directory.
- `--json` - print the prune result as JSON.

The prune is intentionally conservative. It removes hook-event logs under `<dataDir>/hooks/*.jsonl` — including rotated `<session>.jsonl.N` generations (issue #1433) — activity ledgers under `<dataDir>/activity/*.jsonl(.1)`, and `playbook-state/<playbook>/<runKey>` run directories, in every case only for terminal tasks older than the age threshold plus aged orphans, plus aged numbered `server.log.N` generations. A live/in-progress session's artifacts and an active task's playbook run are never eligible. It preserves task history, crash-recovery data, interaction logs, contribution history, and other stores whose mapping or audit value is ambiguous. The same sweep can run automatically on a server-side timer via `KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` (off by default).

Kookr's operational disk-pressure alert points operators here when the
filesystem containing the data directory stays below the configured free-space
floors. Run `kookr maintenance prune --dry-run --dir <dataDir>` first to inspect
what Kookr can safely remove. The alert does not auto-prune, throttle writes, or
create a separate persistence store; if filesystem statistics are unavailable
or unreadable, the sampled disk fields are reported as absent and the alert rule
waits for readable samples.

Exit behavior:

- `0` when planning or pruning succeeds.
- `1` when the prune fails, for example because the target data directory cannot be read.
- `2` for usage errors such as an unknown flag, missing `prune` verb, or invalid `--max-age-days`.

## `kookr maintenance backup`

Create a timestamped gzip-compressed tarball of a Kookr data directory:

```bash
kookr maintenance backup
kookr maintenance backup --dir ~/.kookr-4801 --out ~/kookr-backups
kookr maintenance backup --json
```

The command operates directly on disk and does not require the Kookr server to
be running. By default it targets `~/.kookr`, or `~/.kookr-<port>` when
`KOOKR_PORT` is set to a non-default numeric port. Pass `--dir` for an explicit
data directory, especially for instances launched with `KOOKR_PORT=auto`.

By default backups are written under `~/kookr-backups`. Pass `--out <path>` to
choose another output directory. The file name is
`kookr-backup-<UTC_TIMESTAMP>.tar.gz`, for example
`kookr-backup-20260613T140506Z.tar.gz`.

Archive layout:

- `kookr-backup-manifest.json` - schema version, creation time, source data
  directory, crash-consistency contract, entry list, total source bytes, and
  exclusions.
- `data/` - the backed-up data directory contents, preserving regular files,
  directories, and symlinks.

If the output directory is inside the data directory, it is excluded from the
archive so older backup tarballs are not recursively backed up. Unsupported
special files, such as sockets or device nodes, are skipped and listed in the
manifest exclusions.

Crash-consistency contract: a backup taken while Kookr is running is
crash-consistent, not a cross-store transaction. Restoring it is equivalent to
recovering after `kill -9` while the server was writing: Kookr's per-store
atomic-write and boot-repair logic must recover each store, but files are not
guaranteed to share one exact timestamp boundary. For a byte-stable copy of a
quiet data directory, drain or stop Kookr before running the backup.

Restore remains manual: stop Kookr, extract the tarball, and copy `data/.` into
the target data directory before restarting. Do not restore over a running
server.

Options:

- `--dir <path>` - use an explicit Kookr data directory.
- `--out <path>` - write the timestamped tarball to this output directory.
- `--json` - print the backup result and manifest as JSON.

Exit behavior:

- `0` when the backup succeeds.
- `1` when the backup fails, for example because the target data directory
  cannot be read or the output archive already exists.
- `2` for usage errors such as an unknown flag or missing `--out` path.

## `kookr pr-checklist`

Machine-verify a repository's anti-drift PR checklist against the working-tree
diff. Deterministic and AI-free — the local pre-`gh pr create` gate and a
CI-friendly verifier for the same contract. See
[PR Checklist Contract](../rfc/rfc-pr-checklist-contract.md).

```bash
kookr pr-checklist verify [--pr-body <file|->] [--base <ref>] [--json]
kookr pr-checklist verify --from-command <raw gh pr create …> [--run-commands none]
kookr pr-checklist verify --explain
kookr pr-checklist doctor [--json]
```

### `verify`

Collect changed paths against `--base` (default `main`) and check structural
rules plus optional PR-body attestation boxes.

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--pr-body` | path or `-` | unset | PR body to check attestation boxes against (`-` reads stdin). Omit for structural checks only (typical local preflight; CI supplies the body). Mutually exclusive with `--from-command`. |
| `--from-command` | raw shell string | unset | Derive body + base from a raw `gh pr create …` command (used by the local hook). A `--fill` / `$(…)` / stdin body is unverifiable — attestation is skipped locally and CI stays authoritative (never a silent pass). |
| `--run-commands` | `none` or `ci` | `none` | `none` runs no repo commands. `ci` is reserved and currently rejected. |
| `--base` | git ref | `main` | Diff base branch (`--from-command`'s base wins when present). |
| `--json` | none | false | Emit one machine-readable JSON report to stdout. |
| `--explain` | none | false | Print the resolved built-in checklist rules as JSON and exit `0`. |
| `-h`, `--help` | none | false | Print command help and exit `0`. |

### `doctor`

Report the local hook's recent fail-open / degrade rate from the on-disk degrade
log. Use this when you need to know whether the anti-drift PR gate has silently
stopped gating (fail-open history), not for launch preflight — that is
[`kookr doctor --json`](#kookr-doctor).

```bash
kookr pr-checklist doctor
kookr pr-checklist doctor --json
```

With `--json`, prints a summary object (`status`, `logPath`, `total`, `last24h`,
`last7d`, `malformedLines`, `recent`). Without `--json`, prints a short human
report. Exit is always `0` when the log can be read (including “no events”);
unreadable log path → `70`.

### Exit codes

Sysexits-style — **not** the spawn/ralph table. Exit `2` means **verification
failed**, not bad arguments:

| Exit code | Meaning |
| --- | --- |
| `0` | Pass |
| `2` | Verification failure (findings, or a fail-closed repo-input error) |
| `64` | Usage error |
| `70` | Kookr-internal fault (only this class may be treated as fail-open by a hook) |

## `kookr push test`

Send a synthetic relay push notification to a registered device:

```bash
KOOKR_RELAY_URL=http://127.0.0.1:8080 kookr push test device-local-dev
```

Use this when validating relay push configuration for a device that already has a push subscription. The command POSTs to the relay's admin push-test endpoint with the supplied `deviceId`.

Environment:

- `KOOKR_RELAY_URL` - required relay base URL.
- `KOOKR_RELAY_ADMIN_TOKEN` - optional bearer token for relays that require admin auth.

Exit behavior:

- `0` when the relay accepts the test request; the CLI prints the relay result and any returned status code or error string.
- `1` when the relay returns a non-2xx response or the request fails.
- `2` for usage errors, including missing `KOOKR_RELAY_URL` or a missing/extra argument.

## `kookr`

The `kookr` binary is the package entry point. Most local development still uses `pnpm dev`, `pnpm start`, or the focused helper commands above.

## Replay Hook Events

`scripts/replay-hooks.ts` feeds a recorded hook-event JSONL file — a captured real session or a crafted fixture — into a running dev instance so you can deterministically reproduce a detector firing without spinning up a real agent and recreating conditions by hand.

```bash
# Replay a captured session's hook log into the running dev instance
node --import tsx scripts/replay-hooks.ts ~/.kookr/hooks/kookr-task-abc.jsonl

# Replay a fixture into a named session, pacing 50ms between records
node --import tsx scripts/replay-hooks.ts fixture.jsonl --session repro-660 --delay-ms 50

# Parse + classify records without sending anything
node --import tsx scripts/replay-hooks.ts fixture.jsonl --dry-run
```

It parses the JSONL with the same `splitHookRequestBody` the production HTTP route uses and pushes each record through `POST /api/hook-event/:sessionId`. Every record is replayed against a dedicated **synthetic** session whose id starts with `kookr-replay-` (the prefix is prepended automatically). Ingestion derives `origin: 'replay'` from that prefix, so replayed records are tagged replay-not-live and are scoped to a session that can never be mistaken for — or collide with — a live agent's state.

### Built-in scenario catalog

For detector development you usually don't need a captured log — a curated set of named scenarios maps a detector case to a fixture, the path it exercises, and the anomaly to expect. The catalog lives in `src/__fixtures__/replay-scenarios.json`.

```bash
# List every built-in scenario (name, fixture, purpose, expected finding)
node --import tsx scripts/replay-hooks.ts --list-scenarios

# Replay a named scenario instead of a file path
node --import tsx scripts/replay-hooks.ts --scenario billing-stop

# Dry-run a scenario (parses without a running instance — CI-friendly)
node --import tsx scripts/replay-hooks.ts --scenario tool-failure --dry-run
```

Scenarios include `idle-prompt`, `permission-request`, `tool-failure`, `billing-stop`, `task-notification`, and `codex-mcp-startup`. To add one, drop a fixture in `src/__fixtures__/` and append an entry (`name`, `fixture`, `purpose`, `expected`) to the manifest; `scripts/replay-hooks.test.ts` validates the manifest and dry-runs every scenario in CI without a server.

Options:

- `--scenario <name>` — replay a named built-in scenario (see `--list-scenarios`); mutually exclusive with a file argument
- `--list-scenarios` — print the built-in scenario catalog and exit
- `--session <id>` — target session id (forced into a `kookr-replay-` session)
- `--base-url <url>` — target instance; defaults to `KOOKR_API_BASE_URL`, then `KOOKR_PORT`, then a probe of ports `4800`/`4801`
- `--delay-ms <n>` — fixed delay between records (default `0`)
- `--limit <n>` — replay only the first N records
- `--dry-run` — parse and classify records (`parsed`/`unknown`/`malformed`) and print a summary without POSTing

## Related Commands

```bash
pnpm dev             # backend on 4801 and Vite frontend on 5173
pnpm prod:update     # update, build, restart, and health-check ../kookr-prod
pnpm prod:restart    # restart the production-style instance without rebuilding
pnpm doctor          # human-readable shell report (scripts/doctor.sh)
kookr doctor --json  # machine-readable launch preflight (CI/bootstrap) — see `kookr doctor`
```
