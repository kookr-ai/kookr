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

### Missing python3

`node-pty` compiles from source through `node-gyp`, which requires `python3`. `build-essential` does **not** include it. If `pnpm install` fails inside `node-gyp` with `Could not find any Python installation`, install it:

```bash
sudo apt-get install -y python3   # Debian/Ubuntu
xcode-select --install            # macOS (ships python3)
```

### pnpm warns about ignored build scripts

Current `pnpm-workspace.yaml` allow-lists required build dependencies (`onlyBuiltDependencies`). If you see a warning such as `Ignored build scripts: protobufjs@7.5.x` or `@google/genai@2.x`, run:

```bash
pnpm install
```

If the warning persists, check that your checkout is current.

### `The "pnpm" field in package.json is no longer read by pnpm`

This warning comes from **pnpm 11+**, which moved settings out of `package.json` into `pnpm-workspace.yaml` (where this repo now keeps them). On a current checkout it is harmless. It usually means your global pnpm is newer than the version this repo pins (`packageManager: pnpm@10.x`). The reliable fix is to let the pinned version run via Corepack:

```bash
corepack enable          # uses the pnpm version pinned in package.json
```

Alternatively, install a matching pnpm: `npm install -g pnpm@10`.

### Duplicate lines in `pnpm-lock.yaml` (e.g. `semver@7.8.4: {}` twice)

A mismatched pnpm version rewriting the committed lockfile can produce duplicate keys that block install/update. Don't hand-edit the lockfile. Use the pinned pnpm (`corepack enable`) and restore the committed lockfile:

```bash
git checkout -- pnpm-lock.yaml
corepack enable
pnpm install --frozen-lockfile
```

## App Starts But Browser Is Blank

In development, use the Vite frontend URL:

```text
http://localhost:5173
```

The backend runs on `4801` in dev mode, but the browser app is served by Vite on `5173`.

## Dashboard Looks Blank Or Stale Under A Large Fleet

**Symptom:** The WebSocket stays connected, but the dashboard stops refreshing or looks empty/stale when many agents or tasks are live. It can look like a reconnect bug even though the socket is healthy.

**Cause:** Outbound `snapshot` and `coordinator.snapshot` frames are guarded by a hard size policy. Defaults (source of truth — not env-tunable today):

| Threshold | Default | Behavior |
| --- | --- | --- |
| Warn | 2 MiB (`2 * 1024 * 1024`) | Frame is still sent; server logs a warning |
| Drop | 8 MiB (`8 * 1024 * 1024`) | Frame is **not** sent; client keeps its last good snapshot |

Constants live in `src/server/bootstrap/create-realtime-services.ts` as `SNAPSHOT_PAYLOAD_WARN_BYTES` / `SNAPSHOT_PAYLOAD_MAX_BYTES` (exported as `DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS`). Drop/warn logic is in `src/server/snapshot-payload-size-policy.ts` (`shouldSendSerializedSnapshotFrame`).

**Log strings to search** (server stderr / process logs):

```text
[websocket] outbound snapshot payload exceeds warning threshold
[websocket] outbound snapshot payload exceeds hard cap; dropping frame
```

A drop log includes `payloadType`, `scopeKey`, `bytes`, `maxBytes`, and `warnBytes`.

**Mitigation:**

1. Reduce concurrent live agents (finish or stop idle sessions).
2. Clear finished / terminated tasks the dashboard still includes in the fleet snapshot.
3. Prefer project-scoped views when you only need a subset of the fleet (smaller scoped snapshots).
4. Confirm the drop log before chasing reconnect or Vite proxy issues — a dropped frame leaves the client on its last received snapshot with no separate UI banner for this guard.

Related but different: per-socket `bufferedAmount` backpressure and event-loop load-shed (`wsBackpressureNotice`) — see [Architecture](architecture.md#backend--frontend-websocket) and the `KOOKR_WS_*` vars in [Environment Variables](reference/environment-variables.md). Those protect fan-out saturation; the size policy protects a single oversized JSON frame.

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

### `dtach socket did not appear for session kookr-xxxxxxxx`

Launching a task fails with this error when the dtach master could not start.

- **Linux:** Kookr spawns the master with `setsid -f`. If `setsid` is missing (it lives in `util-linux`), install it: `sudo apt-get install -y util-linux`. `pnpm doctor` now checks for it.
- **macOS:** Kookr no longer uses `setsid` on macOS (it is Linux-only and was the historical cause of this error) — it spawns `dtach` directly and relies on the OS to detach the session. If you are on an older Kookr build, update; you do **not** need to hand-compile a `setsid` port. You also do **not** need to `brew install dtach` — the vendored binary is built automatically by `pnpm install`.

If it still fails, run `vendor/dtach/dtach --help` to confirm the binary works, then check that `/tmp/kookr-dtach/` is writable.

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

## Task Launch Parked By A Dependency Preflight

Some tasks declare runtime **dependencies** — for example, a knowledge-base
lookup needs the `kb` CLI and a healthy index. Before such a task starts, Kookr
runs a **dependency preflight** ([`src/core/launch-dependency-preflight.ts`](../src/core/launch-dependency-preflight.ts))
and parks the task if a dependency is confirmed degraded. This is deliberate:
starting a KB-dependent agent against a broken or empty index wastes a run and
produces misleading output, while preserving the original launch intent for
automatic recovery.

A parked launch remains `pending`, consumes no worker slot, and shows the
dependency reason in the dashboard diagnostics:

```text
Parked "<prompt excerpt>" — required dependency is degraded; no worker slot was consumed.
Dependency: kb
Failure mode: <category>
Detail: <what kb doctor reported>
Recommended action: <what to do>
```

The WebSocket alert uses the same information in compact form, for example
`Dependencies: kb=degraded (KB provider is unavailable).` A half-open retry
that is already occupied is reported as `half_open_probe_busy` instead of a
new provider failure. After a server restart, this busy state also protects an
interrupted probe while Kookr reaps its exact expected terminal. This also
appears immediately when a failed direct, promoted, or crash-recovery probe
created a session but physical stop rejected: Kookr retains the exact session
marker and ownership instead of re-parking or starting a replacement. Resolve
the backend cleanup error, or let reconciliation/restart prove that exact
session absent; the gate then permits one new bounded probe.

A hard timeout can win before the adapter reports creation. In that state the
task remains `probing` with the preallocated session id and may have no session
row yet. The late callback links and reaps that exact id; reconciliation then
settles the marker. A terminal task clears the marker immediately when the
owning failure path proves the exact session stopped and settles the circuit;
it retains the fence only while cleanup, creation, or circuit ownership remains
unresolved. Do not infer liveness from a retained marker or delete the record;
explicit/bulk cleanup waits for reconciliation to clear unresolved ownership.

The `kb` preflight runs `kb doctor --format=json` and sorts the result into one
of the failure modes below. The **failure mode** tells you *what* is wrong; the
recovery tells you how to clear it.

| Failure mode | What it means | Recovery |
| --- | --- | --- |
| `server_reachability` | The KB backend (embedding server / index service) is down, refusing connections, or timing out. | Start the KB backend (e.g. `ollama serve`, or your configured index service) or fix its URL, then re-run `kb doctor --format=json`. |
| `provider_api` | The embedding **provider** or its API is misconfigured or unavailable — missing API key, provider/model not running. | Start or reconfigure the embedding provider/API the KB index uses (pull the model, set the API key, point at the right endpoint). |
| `empty_index_data` | The CLI is healthy but there is **nothing to search** — no ingested chunks, an empty index, or no knowledge bases registered. | Ingest or refresh the knowledge-base index before launching the KB-dependent task. |
| `configuration` | The `kb` CLI itself is misconfigured — missing from `PATH`, no active model selected, bad config. | Fix the KB CLI configuration, model selection, or `PATH`, then re-run `kb doctor --format=json`. |
| `query_runtime_failure` | The doctor check passed, but the bounded search smoke test failed in the query path. | Run a small `kb search`, then repair the query/index runtime before launching the KB-dependent task. |
| `unknown` | The preflight failed but the output didn't match a known signature, or `kb doctor` returned unparseable JSON. | Run `kb doctor --format=json` manually and address the reported failure, or check the CLI version. |

### Continue now, or fix first?

Confirmed dependency degradation is an **admission gate**, not an advisory
warning — the task is created and queued, but there is no "continue anyway"
button that starts a worker against the unhealthy dependency. Your two options:

1. **Fix the dependency** (recommended): apply the recovery for the reported
   failure mode; Kookr will re-run the bounded preflight and promote the parked
   task after recovery evidence.
2. **Launch a task that doesn't declare the dependency**: the preflight only runs
   for dependencies the task actually declares, so an unrelated `kb` outage won't
   block tasks that don't use the knowledge base.

If health collection itself times out or cannot be classified, the dependency
state is `unknown` and Kookr fails open only when no stronger degraded or
half-open evidence exists. This state is distinct from confirmed degradation
so a transient diagnostic outage neither pauses the fleet by itself nor erases
an existing gate.

`kb doctor --format=json` is the same probe the preflight runs — use it to
reproduce a failure and confirm a fix:

```bash
kb doctor --format=json
```

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

To stop the production Node process without tearing down speech containers:

```bash
pnpm prod:stop
```

To stop Node **and** free GPU / remove bundled STT/TTS containers:

```bash
pnpm prod:stop --with-sidecars
```

Routine restart no longer frees the GPU. If `nvidia-smi` still shows Whisper /
TTS after you stopped Kookr, that is expected until you run stop with
`--with-sidecars`. After speech model/device/image changes, use
`pnpm prod:stop --with-sidecars` before the next start.

`pnpm prod:restart` prints phase timings (port free, M1 `/api/health`, M2
`/api/ready`, smoke), **apiBlackoutSeconds** (port free → first health 200;
ideal <1s, SLO max 5s), and a dominant-phase line so you can see whether wait
time is speech cold-start vs deferred recovery vs smoke. Blackout >5s prints a
non-fatal `WARN` on stderr. On success the script also writes
`last-restart-metrics.json` under the data dir; `GET /api/deploy/status`
exposes that as optional `lastRestart` (including `apiBlackoutSeconds`).

To independently verify blackout with a 10ms curl loop (measurement-only, not a
CI gate), run `scripts/measure-api-blackout.sh --once` in a second terminal
while restarting. Full recipe: [API Blackout Probe](reference/api-blackout-probe.md).

Warm restart best-effort POSTs `/api/admin/drain` before SIGTERM so launches in
the pre-kill window get 503/draining instead of only ECONNREFUSED. Drain is
in-memory and cleared by process exit — no post-restart resume is required.
Opt out with `KOOKR_RESTART_SKIP_DRAIN=1`.

After the port is free, the script waits for `~/.kookr/server.pid` (the
single-writer lock) to be released before it starts the next process. A leftover
lock from a process that has already closed the listen socket was the #2501
`exited before becoming healthy` failure. If restart still dies that way, check
`server.log` for `[single-writer] another Kookr server` and inspect
`~/.kookr/server.pid` (delete only if that pid is gone).

Operator runbook (procedure, API blackout vs M2 clocks, client contracts,
residual same-port blackout after speech-detach P1):
[Low-downtime redeploy](runbooks/low-downtime-redeploy.md).

If a long-lived production or scratch worktree disappears when its task
completes, protect it with the root-level `.kookr-protected` marker. See
[Protecting A Worktree From Automatic Cleanup](user-guide.md#protecting-a-worktree-from-automatic-cleanup)
for the marker format and removal guidance.

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
