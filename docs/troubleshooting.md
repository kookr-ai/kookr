# Troubleshooting

Start with:

```bash
pnpm run doctor
```

The doctor checks Node and pnpm versions, build tools, the dtach binary, Docker for voice features, GPU availability, and whether common ports are free.

## Install Fails

### Missing build tools

`node-pty` and the vendored `dtach` binary need native build tools.

Ubuntu / Debian:

```bash
sudo apt-get install -y build-essential git
```

macOS:

```bash
xcode-select --install
```

### pnpm warns about ignored build scripts

Current `package.json` allow-lists required build dependencies. If you see a warning such as `Ignored build scripts: protobufjs@7.5.x` or `@google/genai@2.x`, run:

```bash
pnpm install
```

If the warning persists, check that your checkout is current.

## App Starts But Browser Is Blank

In development, use the Vite frontend URL:

```text
http://localhost:5173
```

The backend runs on `4801` in dev mode, but the browser app is served by Vite on `5173`.

## Send A Bug Report

Use the bug-report button in the dashboard top bar. Kookr shows the complete JSON payload before download; attach that JSON file when reporting the issue.

Include:

- What you expected to happen.
- What actually happened.
- The approximate local time when it happened.
- Whether you were connected locally, over LAN, or through a remote/share session.

The V1 bundle is intentionally redacted by default. It does not include raw prompts, terminal output, hook logs, transcripts, screenshots, or full local paths.

## Terminal Panel Feels Too Small

Use the dense-supervision controls before resizing your browser:

1. Press `Alt+T` on desktop to enter terminal focus mode.
2. Press `Alt+P` if the project sidebar is still visible and you want it hidden.
3. On narrow desktop windows, select the **Terminal** detail tab.
4. On mobile, use the **Task** tab; terminal focus mode is intentionally desktop-only.
5. Press `?` for the current shortcut list.

See [Dense Supervision Workflow](user-guide.md#dense-supervision-workflow) for the full operator loop.

## Port Conflicts

Defaults:

- `4800`: production-style Kookr server
- `4801`: dev backend
- `5173`: Vite frontend
- `8003`: bundled STT
- `8004`: bundled TTS

Set `KOOKR_PORT` or stop the conflicting process. `pnpm doctor` reports common conflicts.

## dtach Problems

Kookr requires the dtach backend. The old tmux backend has been removed.

`pnpm dev` and `pnpm start` build the vendored dtach binary on demand, so you should not normally need to run `pnpm build:dtach` directly. If the auto-build fails (typically missing `cc`/`make`/`git`), install the build toolchain first — see [Getting Started](getting-started.md#prerequisites) — and the next `pnpm dev` will pick it up.

To force a rebuild from a clean state:

```bash
pnpm build:dtach --force
```

If `KOOKR_BACKEND=tmux` exists in your environment or `.env`, remove it. Any value except `dtach` now fails startup.

## Claude Code Or Codex Does Not Launch

Confirm the agent binary exists:

```bash
which claude
which codex
```

Override paths if needed:

```bash
KOOKR_AGENT_BIN=/path/to/claude
KOOKR_CODEX_BIN=/path/to/codex
```

Kookr's Codex adapter defaults to `codex` on `PATH`; the local fork is maintained separately at `~/git/codex`.

## Ralph Loop Stopped Or Shows "Replace With New"

After a Kookr server crash, OS restart, WSL shutdown, or agent runtime crash, a Ralph loop can look like it is still active even though the underlying agent is no longer making progress. Common symptoms:

- Relaunching the same playbook reports `409 matching looped playbook task already exists`.
- The launch flow shows a **Replace with new** dialog for an existing loop.
- The old task is still visible, but the terminal and Ralph iteration log have no recent activity.

This happens because Kookr preserves loop state across restarts so healthy dtach-backed sessions can continue. On startup, Kookr probes each running Ralph loop for a live terminal session. If the probe confirms a live session, the loop is preserved. If not, the loop is marked failed with `exitReason: 'kookr_crash'`. Some crash shapes still leave the dtach session alive while the agent child has exited, so Kookr cannot prove at startup that the loop is dead; those cases reach the duplicate-loop recovery flow instead.

To recover:

1. If the **Replace with new** dialog appears, first check whether the existing loop has recent activity. Choose **Open the running loop** when it is still working and you want to keep its context.
2. Choose **Replace with new** when the loop is stale after a crash. Kookr cancels the old task and starts a fresh loop with the same playbook, cwd, and parameters. The new agent does not inherit the old conversation.
3. If you are using the API directly, the equivalent recovery endpoint is `POST /api/tasks/:taskId/ralph-loop/replace-with-new`. Use it only for the task that caused the duplicate-loop conflict; Kookr validates that the replacement request still matches the old playbook key.
4. If replacement fails repeatedly, capture a bug report before changing local state. Wiping `~/.kookr/tasks.json` or the whole `~/.kookr/` directory is a last resort because it removes task history, loop state, and persisted supervision context.

For the underlying recovery model, see [System Architecture](architecture.md#the-supervisor-agent) and [RFC: Ralph loop crash-restart](rfc/rfc-ralph-loop-crash-restart-recovery.md).

## Optional Voice Services Do Not Start

Voice features require Docker only when using the bundled services.

Check:

```bash
docker info
```

For first-run STT, model download can take several minutes. Increase:

```bash
KOOKR_STT_HEALTH_TIMEOUT_S=900
```

Force CPU mode if GPU auto-detection is misconfigured:

```bash
KOOKR_STT_DEVICE=cpu
```

## Production-Style Instance Looks Stale

`pnpm prod:update` updates the sibling `../kookr-prod` worktree, builds it, restarts the server, and health-checks it.

Use:

```bash
pnpm prod:update
```

For configuration-only changes:

```bash
pnpm prod:restart
```

## Agent Prompt Is Blocked By Hooks

When launching from inside Claude Code, hooks inspect the bash command line. Use a prompt file or stdin so sensitive command text is not in argv:

```bash
kookr spawn --prompt-file /tmp/prompt.md
cat /tmp/prompt.md | kookr spawn
```

See [CLI Reference](reference/cli.md).

## Need More Detail

- [Configuration](configuration.md)
- [Environment Variables](reference/environment-variables.md)
- [Hooks Setup](hooks-setup.md)
- [Architecture](architecture.md)
