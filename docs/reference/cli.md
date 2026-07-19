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
| `--criteria` | text | unset | Acceptance criteria sent with the task request. This value is argv-exposed; use prompt files or stdin for hook-sensitive text. |
| `--dedupe` | `warn`, `block`, or `skip` | `warn` | Active duplicate-prompt handling. `warn` prompts interactively and blocks in non-interactive shells, `block` exits with code 5, and `skip` creates the task intentionally while suppressing duplicate-cluster findings. |
| `--wait` | optional seconds via `--wait=<seconds>` | false | Poll until the spawned task raises `completion-ready` or reaches a terminal state. |
| `--parent-task-id` | task id | `KOOKR_TASK_ID` when set | Explicit parent task to link in the dashboard. Mutually exclusive with `--no-parent-task`. |
| `--no-parent-task` | none | false | Launch detached and ignore `KOOKR_TASK_ID`. Mutually exclusive with `--parent-task-id`. |
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

Auto-close on completion signal:

```bash
kookr spawn --auto-close-on-signal "implement issue #42 then signal completion-ready"
kookr spawn --no-auto-close-on-signal "..."   # opt out of an inherited policy
```

With `--auto-close-on-signal`, the task auto-completes after its `kookr signal completion-ready` signal has been pending for one hour, instead of waiting indefinitely for manual review — freeing an active slot so queued tasks can run. If the flag is omitted, the new task **inherits the policy of its parent task** (the `parentTaskId` linkage, which `kookr spawn` sets from `KOOKR_TASK_ID` by default). That makes the policy propagate automatically down a self-continuation chain. Pass `--no-auto-close-on-signal` to opt a successor out of an inherited policy. See [auto-close-on-signal](./auto-close-on-signal.md).

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
playbook, or inherited from a parent task), a `completion-ready` signal starts a
one-hour auto-close grace period. If the task is still in progress after that,
Kookr completes it and frees its active slot. Only signal when work is truly
finished — under auto-close the task can close later without another prompt. See
[auto-close-on-signal](./auto-close-on-signal.md).

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

- `0` when the signal is raised.
- `2` for usage errors, including an unknown signal kind, a missing task id,
  bad flags, or an invalid `KOOKR_PORT`.
- `3` when no Kookr server is reachable. This is advisory so agents can keep
  finishing their work when the dashboard is unavailable.
- `4` when the server rejects the signal, for example because the task id is
  unknown or terminal.

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

`kookr spawn`, `kookr ralph`, and their compatible aliases use stable exit codes for scripts:

| Exit code | Name | Meaning | Commands |
| --- | --- | --- | --- |
| exit 0 | Success | The command completed successfully. | `kookr spawn`, `kookr ralph` |
| exit 2 | User error | Invalid arguments, missing required input, or another local usage error. | `kookr spawn`, `kookr ralph` |
| exit 3 | No server | No Kookr server was reachable, or default-port discovery found multiple possible instances. | `kookr spawn`, `kookr ralph` |
| exit 4 | Server error | The server rejected the request or returned an unexpected failure. | `kookr spawn`, `kookr ralph` |
| exit 5 | Duplicate blocked | Task creation was blocked by duplicate-prompt handling, such as `--dedupe=block` or non-interactive `--dedupe=warn`. | `kookr spawn` |
| exit 6 | Wait timeout | `kookr spawn --wait=<seconds>` timed out before the task reached `completion-ready` or a terminal state. | `kookr spawn` |

The deprecated `kookr-spawn` and `kookr-ralph` aliases return the same codes as their `kookr <subcommand>` forms.

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

Prune aged completed-task hook logs from a Kookr data directory:

```bash
kookr maintenance prune --dry-run
kookr maintenance prune --max-age-days 14 --dir ~/.kookr-4801
kookr maintenance prune --json
```

The command operates directly on disk and does not require the Kookr server to be running. By default it targets `~/.kookr`, or `~/.kookr-<port>` when `KOOKR_PORT` is set to a non-default numeric port. Pass `--dir` to target a specific data directory, especially for instances launched with `KOOKR_PORT=auto`.

Options:

- `--dry-run` - print the prune plan without deleting files.
- `--max-age-days <n>` - prune eligible artifacts older than `n` days; the default is 30.
- `--dir <path>` - use an explicit Kookr data directory.
- `--json` - print the prune result as JSON.

The prune is intentionally conservative. It removes only hook-event logs under `<dataDir>/hooks/*.jsonl` — including rotated `<session>.jsonl.N` generations (issue #1433) — that belong to terminal tasks older than the age threshold, plus aged orphan hook logs. It preserves task history, crash-recovery data, activity ledgers, interaction logs, contribution history, and other stores whose mapping or audit value is ambiguous.

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
pnpm doctor          # diagnose local setup problems
```
