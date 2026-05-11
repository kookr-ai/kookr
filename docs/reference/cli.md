# CLI Reference

Kookr includes small command-line tools for launching tasks and inspecting a running instance.

Install them globally from a checkout:

```bash
pnpm build
pnpm link --global
```

If you linked Kookr before these binaries existed, run `pnpm link --global` again. pnpm records bin symlinks at link time.

## `kookr-spawn`

Create a Kookr task from your current shell:

```bash
cd ~/git/my-project
kookr-spawn "review the diff since origin/main and write a summary"
```

The task uses `$PWD` as its working directory and appears in the dashboard immediately. Output starts with `task_id=<uuid>` for scripting.

Prompt sources:

```bash
kookr-spawn "fix the auth bug"
cat prompt.md | kookr-spawn --autonomous
kookr-spawn --prompt-file /tmp/prompt.md
```

`--prompt-file` is the safest form inside Claude Code sessions because hooks inspect the bash command line, not the file contents.

## Hook-Safe Prompts

Claude Code PreToolUse hooks may block commands whose argv contains strings such as `gh pr create`, `git push --force`, or `rm -rf`.

Hook-safe:

```bash
kookr-spawn --prompt-file /tmp/prompt.md
cat /tmp/prompt.md | kookr-spawn
```

Not hook-safe:

```bash
kookr-spawn "please gh pr create for this branch"
kookr-spawn --criteria "ensure gh pr create succeeds"
```

## Server Discovery

`kookr-spawn` discovers the active Kookr instance with this precedence:

1. `KOOKR_API_BASE_URL`
2. `KOOKR_PORT`
3. Probe local ports `4800` and `4801`

If both default ports respond and no explicit target is set, the command exits with an ambiguity error.

## `kookr-status`

Print a read-only snapshot of the running Kookr instance:

```bash
kookr-status
pnpm status
```

The command reads `/api/snapshot` and `/api/health`, then reports server uptime, build version, and per-agent severity counts.

## `kookr`

The `kookr` binary is the package entry point. Most local development still uses `pnpm dev`, `pnpm start`, or the focused helper commands above.

## Related Commands

```bash
pnpm dev             # backend on 4801 and Vite frontend on 5173
pnpm prod:update     # update, build, restart, and health-check ../kookr-prod
pnpm prod:restart    # restart the production-style instance without rebuilding
pnpm doctor          # diagnose local setup problems
```
