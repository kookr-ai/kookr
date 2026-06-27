# CLI Reference

Kookr exposes one public command-line entry point, `kookr`, with subcommands for launching tasks and inspecting a running instance.

Install them globally from a checkout:

```bash
pnpm build
pnpm link --global
```

If you linked Kookr before these commands existed, run `pnpm link --global` again. pnpm records bin symlinks at link time.

The standalone aliases `kookr-spawn`, `kookr-status`, and `kookr-ralph` still work for compatibility, but they are deprecated. Prefer the `kookr <subcommand>` forms below.

## `kookr spawn`

Create a Kookr task from your current shell:

```bash
cd ~/git/my-project
kookr spawn "review the diff since origin/main and write a summary"
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
| `-a`, `--agent` | `claude-code` or `codex-cli` | Server default | Agent type to launch for this task. |
| `--effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | Server per-agent setting, then agent CLI default | Reasoning effort override for this task. `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex-cli` accepts `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. |
| `--criteria` | text | unset | Acceptance criteria sent with the task request. This value is argv-exposed; use prompt files or stdin for hook-sensitive text. |
| `--dedupe` | `warn`, `block`, or `skip` | `warn` | Active duplicate-prompt handling. `warn` prompts interactively and blocks in non-interactive shells, `block` exits with code 5, and `skip` creates the task intentionally while suppressing duplicate-cluster findings. |
| `--parent-task-id` | task id | `KOOKR_TASK_ID` when set | Explicit parent task to link in the dashboard. Mutually exclusive with `--no-parent-task`. |
| `--no-parent-task` | none | false | Launch detached and ignore `KOOKR_TASK_ID`. Mutually exclusive with `--parent-task-id`. |
| `-f`, `--prompt-file` | path | unset | Read the prompt from a file instead of positional argv or stdin. |
| `-h`, `--help` | none | false | Print command help and exit. |

Duplicate prompt handling:

```bash
kookr spawn --dedupe=warn "fix the auth bug"   # default: prompt on active duplicate; blocks when non-interactive
kookr spawn --dedupe=block "fix the auth bug"  # exit 5 on active duplicate
kookr spawn --dedupe=skip "fix the auth bug"   # create intentionally and suppress duplicate-cluster findings
```

In interactive `warn` mode, `show diff` prints the stored active prompt against the requested prompt before asking again.

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

## Server Discovery

`kookr spawn` discovers the active Kookr instance with this precedence:

1. `KOOKR_API_BASE_URL`
2. `KOOKR_PORT`
3. Probe local ports `4800` and `4801`

If both default ports respond and no explicit target is set, the command exits with an ambiguity error.

## Exit Codes

`kookr spawn`, `kookr ralph`, and their compatible aliases use stable exit codes for scripts:

| Exit code | Name | Meaning | Commands |
| --- | --- | --- | --- |
| exit 0 | Success | The command completed successfully. | `kookr spawn`, `kookr ralph` |
| exit 2 | User error | Invalid arguments, missing required input, or another local usage error. | `kookr spawn`, `kookr ralph` |
| exit 3 | No server | No Kookr server was reachable, or default-port discovery found multiple possible instances. | `kookr spawn`, `kookr ralph` |
| exit 4 | Server error | The server rejected the request or returned an unexpected failure. | `kookr spawn`, `kookr ralph` |
| exit 5 | Duplicate blocked | Task creation was blocked by duplicate-prompt handling, such as `--dedupe=block` or non-interactive `--dedupe=warn`. | `kookr spawn` |

The deprecated `kookr-spawn` and `kookr-ralph` aliases return the same codes as their `kookr <subcommand>` forms.

## `kookr status`

Print a read-only snapshot of the running Kookr instance:

```bash
kookr status
pnpm status
```

The command reads `/api/snapshot` and `/api/health`, then reports server uptime, build version, and per-agent severity counts.

## `kookr ralph`

Inspect or control a Ralph loop:

```bash
kookr ralph status <taskId>
kookr ralph pause <taskId>
kookr ralph resume <taskId>
kookr ralph cancel <taskId>
```

If a loop appears stopped after a crash, relaunching the same playbook may show a duplicate-loop conflict or a **Replace with new** recovery dialog. See [Ralph Loop Stopped Or Shows "Replace With New"](../troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new) before editing local state by hand.

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

It parses the JSONL with the same `splitHookRecords` the production watcher uses and pushes each record through `POST /api/hook-event/:sessionId`. Every record is replayed against a dedicated **synthetic** session whose id starts with `kookr-replay-` (the prefix is prepended automatically). Ingestion derives `origin: 'replay'` from that prefix, so replayed records are tagged replay-not-live and are scoped to a session that can never be mistaken for — or collide with — a live agent's state.

Options:

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
