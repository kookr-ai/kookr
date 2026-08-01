# Kookr Environment Variables

This is the canonical reference for `KOOKR_*` variables read or injected by
Kookr at runtime. For a starter local configuration, copy `.env.example` and
uncomment only the values you need.

## Server And Data

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_PORT` | `4800` | Integer port, 1-65535 | HTTP and WebSocket port. Also selects the data directory: `~/.kookr` on port 4800, `~/.kookr-<port>` on other ports. |
| `KOOKR_HOST` | `127.0.0.1` | Hostname or IP address | Bind address for the HTTP/WebSocket server. Binding to a non-loopback host (a LAN IP or `0.0.0.0`) activates the API-token gate below. |
| `KOOKR_API_TOKEN` | unset | Secret string | Bearer token required on **every** API request (including GETs) and WebSocket upgrades **when `KOOKR_HOST` is non-loopback**. Loopback binds (`127.0.0.1`/`::1`/`localhost`) ignore it and stay token-free. Non-browser clients (the `kookr spawn` / `kookr status` CLIs) send it as `Authorization: Bearer <token>` and read it from the process environment (so it must be **exported** in the shell — they do not load `.env`). Operator-provided tokens on non-loopback binds must be at least 24 characters unless `KOOKR_ALLOW_WEAK_API_TOKEN=true` is set. The browser dashboard authenticates differently: it exchanges a one-time token (carried in the share/handoff URL **fragment**, `#token=<token>`) for an `HttpOnly` session cookie via `POST /api/auth/session`, and the cookie then rides automatically on HTTP fetches and the WebSocket handshake (no token in any WS URL — the legacy `?token=` query parameter was removed). This closed issue #708. If a non-loopback bind has no token and `KOOKR_ALLOW_NON_LOOPBACK=true`, one is auto-generated and printed at startup. |
| `KOOKR_ALLOW_NON_LOOPBACK` | unset | `true` to enable | Explicit opt-out of the non-loopback fail-closed guard. When `KOOKR_HOST` is non-loopback and `KOOKR_API_TOKEN` is unset: `true` auto-generates an API token (printed at startup) and enforces it; unset/other refuses to start. Has no effect on a loopback bind. |
| `KOOKR_ALLOW_WEAK_API_TOKEN` | unset | `true` to enable | Emergency escape hatch for operator-provided API tokens shorter than 24 characters on non-loopback binds. Set only for a deliberate temporary compatibility window; Kookr logs a warning and still enforces the provided token. Has no effect on loopback binds or on auto-generated tokens. |
| `KOOKR_ADMIN_TOKEN` | unset | Secret string | Optional admin token accepted via `x-kookr-admin-token` for [`/api/admin/*` runtime-control routes](api.md#admin--runtime-control) from non-loopback callers. Loopback admin requests are trusted without this token. |
| `KOOKR_SUPERVISOR_TOKEN` | unset | Secret string | Optional bearer token accepted via `Authorization: Bearer <token>` for the [supervisor mutating endpoints](api.md#actor-attribution-and-the-supervisor-token) (`POST /api/tasks/:id/complete`, `POST /api/tasks/abort`, `POST /api/tasks/completion-ready/ack-all`). Unlike `KOOKR_ADMIN_TOKEN`, there is **no loopback bypass** — the token is required even from localhost. Unset (default) leaves those routes open, unchanged from prior behavior; `GET` routes are never gated. |
| `KOOKR_DISABLE_ORIGIN_GATE` | unset | `true` to disable | Emergency escape hatch for the loopback browser-origin gate. By default, loopback binds stay token-free for local clients but reject browser-origin-crossing mutating API requests and WebSocket upgrades. Set only when an unusual local wrapper sends a mismatched `Origin`/`Sec-Fetch-Site`; headerless CLI, curl, and hook requests do not need this. Has no effect on non-loopback API-token enforcement. |
| `KOOKR_TRUSTED_TUNNEL` | unset | `true` to assert | Operator assertion that a non-loopback bind sits behind a mesh-encrypted tunnel (Tailscale / WireGuard). The browser session cookie is `Secure` only over HTTPS; a `Secure` cookie is never sent over plain HTTP, so on a non-loopback **plain-HTTP** bind the cookie exchange (`POST /api/auth/session`) is **refused** unless `KOOKR_TRUSTED_TUNNEL=true`, in which case a non-`Secure` cookie is issued over the asserted tunnel. Prefer fronting the dashboard with HTTPS (e.g. **Tailscale Serve**), which keeps `Secure` on and needs no flag. **Trusted, not validated** — do not set it on a routable public bind; doing so would ship a non-`Secure` cookie on an unencrypted path. Has no effect on a loopback bind. See [Read-Only Shared View Setup](shared-view-setup.md). |
| `KOOKR_REQUEST_BODY_LIMIT_BYTES` | `1000000` | Positive integer bytes | Maximum JSON request body size accepted by the dashboard server API routes. Oversized requests return HTTP 413 before route handlers parse the body. |
| `KOOKR_DEV_HOST` | unset (Vite dev server binds dual-stack) | Hostname or IP address | Bind address for the Vite frontend dev server (`pnpm dev`, `pnpm dev:frontend`). Default leaves Vite reachable on both `127.0.0.1:5173` and `[::1]:5173`. Set to `0.0.0.0` for LAN access, or to a specific IP to restrict the bind. |
| `KOOKR_HEALTH_URL` | `http://127.0.0.1:${KOOKR_PORT}/api/health` | HTTP URL | Liveness endpoint (always 200 once the listener is bound). Still useful for operator probes; the deploy gate prefers `KOOKR_READY_URL`. |
| `KOOKR_READY_URL` | `http://127.0.0.1:${KOOKR_PORT}/api/ready` | HTTP URL | Readiness endpoint used by `scripts/prod-restart.sh` as the deploy gate and the correct probe for a process supervisor of the **engine** (issues #1721, #1707). Returns 503 with `checks.startup.reason=startup-in-progress` until post-listen recovery finishes, or with `checks.schedulerTick` not-ready when the schedule-runner tick is stale beyond two tick intervals; 200 when ready for work. Do **not** point an engine supervisor at the detached relay's `/ready` — that path has no schedule-runner visibility. |
| `KOOKR_STARTUP_TIMEOUT_SECONDS` | `1800` | Positive integer seconds | Maximum wait for production restart readiness checks (issue #1721; raised from 720 after a ~10.5 min recovery on a 727-task instance raced the old default). |
| `KOOKR_STARTUP_CHECK_INTERVAL_SECONDS` | `2` | Positive integer seconds | Poll interval for production restart readiness checks. |
| `KOOKR_HEALTH_CURL_MAX_TIME_SECONDS` | `10` | Positive integer seconds | Per-probe `curl --max-time` bound for the restart readiness gate (issue #1553). Without it, one hung probe defeats `KOOKR_STARTUP_TIMEOUT_SECONDS` — the deadline is only re-checked between probes. |
| `KOOKR_LOG_FORMAT` | unset, human-readable lines | unset or `json` | Selects server logger output format for logger-backed call sites. The default preserves human-readable `[subsystem] message` lines. Set `json` to emit one JSON object per line with `ts`, `level`, `subsystem`, `msg`, and `fields`. |
| `KOOKR_LOG_TASK_SAVE_METRICS` | unset | `1` to enable | Logs each task-state save with serialized byte count / dirty-row counts and duration. Intended for short dogfooding measurements of task-state write amplification; leave unset for normal operation. |
| `KOOKR_TASK_STORE` | `sqlite` | `sqlite` (default) or `json` | Selects the durable task-state backend (issue #1755). Default `sqlite` stores each task as a row in `{dataDir}/tasks.sqlite` (WAL) and flushes only dirty rows on save — the fix for the 42 MB rewrite-on-save OOM path. On first boot when `tasks.json` exists and the DB does not, Kookr imports once and renames the JSON to `tasks.json.pre-sqlite-<timestamp>` (never deletes). Set to `json` to force the legacy whole-file `tasks.json` path (rollback / emergency). |
| `KOOKR_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS` | `1500` | Non-negative number of ms (`0` disables) | Event-loop-delay p95 threshold above which non-critical full-snapshot rebuilds are shed to protect the event loop under saturation (issue #1818). When the sampled `eventLoopDelayP95` exceeds this many milliseconds, a non-critical full-snapshot rebuild is skipped (fail-open: skipped when the sample is missing/non-finite). `0` disables shedding entirely; blank/invalid values fall back to the default, and negatives are clamped to `0`. |
| `KOOKR_PROD_DIR` | Auto-resolved `../kookr-prod` | Absolute or relative path | Overrides the production worktree used by `scripts/prod-update.sh` and deployment routes. |
| `KOOKR_ENV_ROOT_DIR` | Auto-resolved Kookr main checkout when `prod-update.sh` runs from `kookr-prod`; otherwise current checkout | Absolute or relative path | Overrides the checkout whose `.env` is symlinked into the production worktree by `scripts/prod-update.sh`. |
| `KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` | unset (off) | Positive number of hours | Enables a server-side scheduled data-directory prune (the same conservative sweep as `kookr maintenance prune`): removes aged hook logs, aged orphan/terminal activity-ledger files, rotated `server.log.N` generations, and aged `playbook-state` run directories. Off by default; unset, `0`, or non-positive keeps it disabled. The first sweep runs one interval after startup (never at boot), reclaimed bytes are logged, and a failing sweep is logged without crashing the server. |
| `KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS` | unset (off) | Positive number of hours | Enables a server-side scheduled relay-orphan sweep (issue #1723): reaps leaked `relay/server.ts` processes whose task worktree no longer exists (a relay stranded after a test worktree was deleted), the backstop for the die-with-parent watchdog. Off by default; unset, `0`, or non-positive keeps it disabled. Production-safe — a live relay's working directory always exists, so it is never selected; each reap logs pid/age/RSS, and a failing sweep is logged without crashing the server. |
| `KOOKR_PROD_SMOKE_TICK` | on for port 4800, off otherwise | `1`/`true` to enable, `0`/`false`/`off`/`no` to disable | Controls the hourly in-process prod smoke tick (issue #1593): runs the same bounded checks as the post-deploy smoke suite (`/api/ready` + `/api/health` response bounds, `/api/tasks?limit=1` latency, adapter version-probe sanity) against the live instance on a schedule, and files/updates a single operational alert artifact (`{dataDir}/prod-smoke-tick-alert.json`) on failure so a wedge that develops while the server runs is caught within an hour instead of sitting undetected. Enabled by default only on the canonical prod port (`4800`) so a fresh deploy is protected with no operational change; dev servers and the unit-test suite stay silent (the suite sets this to `0` via `vitest.config.ts`). No agent is spawned for the happy path. |
| `KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES` | `60` | Positive number of minutes | Cadence of the prod smoke tick above. A non-positive value disables the tick entirely (equivalent to `KOOKR_PROD_SMOKE_TICK=0`). |
| `KOOKR_DEPLOY_LAG_DETECTOR` | on for port 4800, off otherwise | `1`/`true` to enable, `0`/`false`/`off`/`no` to disable | Controls the deploy-lag detector (issue #1594): compares each monitored prod's running SHA against `origin/main` on a schedule and files/updates a single operational alert artifact (`{dataDir}/deploy-lag-alert.json`) when merged commits sit undeployed past the threshold, naming the pending commits (short SHA + subject). The kookr target is always monitored (running SHA from build-info, diffed against the server checkout's `origin/main`); the lucy target is added only when both `KOOKR_DEPLOY_LAG_LUCY_STATUS_URL` and `KOOKR_DEPLOY_LAG_LUCY_REPO` are set. It only alerts — it never triggers a deploy (`prod:update` stays operator-triggered). Enabled by default only on the canonical prod port (`4800`); dev servers and the unit-test suite stay silent (the suite sets this to `0` via `vitest.config.ts`). No agent is spawned. |
| `KOOKR_DEPLOY_LAG_INTERVAL_MINUTES` | `60` | Positive number of minutes | Cadence of the deploy-lag detector above. A non-positive value disables the detector entirely (equivalent to `KOOKR_DEPLOY_LAG_DETECTOR=0`). |
| `KOOKR_DEPLOY_LAG_THRESHOLD_HOURS` | `6` | Positive number of hours | Age past which an undeployed merged commit raises a deploy-lag alert. A freshly merged commit younger than this threshold raises no alert. |
| `KOOKR_DEPLOY_LAG_LUCY_STATUS_URL` | unset (lucy not monitored) | URL of lucy's status surface | The live status endpoint whose JSON body exposes lucy's running `GIT_SHA`. Required (together with `KOOKR_DEPLOY_LAG_LUCY_REPO`) to monitor lucy for deploy lag. |
| `KOOKR_DEPLOY_LAG_LUCY_REPO` | unset (lucy not monitored) | Absolute or relative path | Local lucy clone carrying the `origin/main` ref, used to resolve lucy's pending commits. Required (together with `KOOKR_DEPLOY_LAG_LUCY_STATUS_URL`) to monitor lucy for deploy lag. |
| `KOOKR_LESSON_SPOOL` | on | `0` to disable | Controls the lesson-write spool recovery loop (issue #1519): periodic `kb` health probes, idempotent drain of `~/.kookr/playbook-state/lesson-write-spool/`, and a 2h prolonged-degradation operational alert. Set to `0` to disable the background service (agent-side PATH shim and `kookr lesson *` CLI still work). The unit-test suite sets this to `0` via `vitest.config.ts` so tests do not shell out to `kb doctor`. See [lesson-write-spool](lesson-write-spool.md). |
| `KOOKR_LESSON_DECISION_GATE` | on | `0` / `false` / `off` / `no` to disable | When on (default), `POST /api/tasks/:id/signal` with `kind=completion_ready` is rejected (`409 lesson_decision_required`) unless the task's hook trail shows a lesson write (`kb remember` / `kookr lesson remember`) or an explicit `No generic KB lesson:` skip. Fail-open for tasks with zero sessions. See [lesson-decision-gate](lesson-decision-gate.md). |
| `KOOKR_EFFORT_SPLIT_MIN` | `0.05` (5%) | 0–1 fraction or 0–100 percent | Floor of the secondary-repo (kookr) share band for `kookr effort-split` (issue #1718). Pair with `KOOKR_EFFORT_SPLIT_MAX`. Defaults reconstruct the 20% ± 15pt band. |
| `KOOKR_EFFORT_SPLIT_MAX` | `0.35` (35%) | 0–1 fraction or 0–100 percent | Ceiling of the secondary-repo (kookr) share band for `kookr effort-split` (issue #1718). Pair with `KOOKR_EFFORT_SPLIT_MIN`. |
| `KOOKR_EFFORT_SPLIT_TARGET` | `0.20` (20%) | 0–1 fraction or 0–100 percent | Alternative to min/max: secondary-repo target share. Used with `KOOKR_EFFORT_SPLIT_DEVIATION_PTS`. |
| `KOOKR_EFFORT_SPLIT_DEVIATION_PTS` | `0.15` (15pt) | 0–1 fraction or 0–100 percent | Allowed absolute deviation from `KOOKR_EFFORT_SPLIT_TARGET` (default 15pt → band 5%–35%). |
| `KOOKR_SIGNAL_OUTBOX` | on | `0` to disable | Controls the agent signal outbox drain loop (issue #1541): boot + periodic (30s) flush of `~/.kookr/playbook-state/signal-outbox/` into the local TaskStore. Set to `0` to disable the background service (`kookr signal` still write-behinds offline signals and still exits 0). The unit-test suite sets this to `0` via `vitest.config.ts`. See [signal-outbox](signal-outbox.md). |
| `KOOKR_SIGNAL_OUTBOX_DIR` | `~/.kookr/playbook-state/signal-outbox` | Absolute or relative path | Override the durable signal outbox directory (issue #1541). |
| `KOOKR_RETRO_VERIFY_QUEUE_DIR` | `~/.kookr/playbook-state/retro-verify-queue` | Absolute or relative path | Override the durable retro-verify queue directory (issues #1689, #1703) — merges made while CI was signal-absent are enqueued here (SHA + PR + reason) and re-verified when capacity recovers. Queue depth is the `ci_blind_debt` metric exposed on `GET /api/health`, `kookr status`, `kookr retro-verify status`, and `kookr emission metrics` (daily-report path). Depth above the emission threshold withholds new feature-issue filings until `kookr retro-verify drain` clears the debt. |
| `KOOKR_ENV_BLOCKER_HEARTBEAT_MS` | `3600000` (1 hour) | Non-negative integer ms | Interval of the environment-blocker re-escalation heartbeat sweep (issue #1702). Each tick re-escalates `requiresHuman` blockers whose staleness TTL (default 24h) has elapsed, so a blocker only a human can clear keeps surfacing to the owner-read control-room feed with its running cost. `0` disables the sweep. The TTL — not this tick — governs re-escalation cadence; the tick only bounds how promptly a newly-stale blocker is noticed. |
| `KOOKR_TASK_TAIL_RETENTION_DAYS` | `7` | Positive number of days | How long completed-task terminal tails are kept under `{dataDir}/task-tails/` after capture (default 7 days). Used by `GET /api/tasks/:id/tail` and as a fallback for `GET /api/capture/:sessionId` so Lucy’s `peek_kookr_task_output` still works after session cleanup. See [rfc-task-tail-retrieval](../rfc/rfc-task-tail-retrieval.md). |
| `KOOKR_TASK_TAIL_DIR` | `{dataDir}/task-tails` | Absolute or relative path | Override the on-disk directory for durable terminal tails. |
| `KOOKR_TASK_TAIL_MAX_BYTES` | `262144` (256 KiB) | Positive integer bytes | Maximum UTF-8 bytes retained per task tail (suffix-truncated from the live ring capture). |
| `KOOKR_TASK_TAIL_PURGE_INTERVAL_MS` | `3600000` (1 hour) | Non-negative integer ms | Background purge tick for expired tails. `0` disables the timer (lazy expiry on read still applies). |
| `KOOKR_REAP_ORPHAN_SESSIONS` | on | `false` to disable | Controls the orphan/terminal-task session reaper (issue #1720): at boot and on every periodic liveness tick, terminates (TERM → grace → KILL) dtach sessions that either have no owning task at all, or whose owning task already reached a terminal status while the session's process tree stayed resident — the exact leak that accumulated 41 orphan sessions (~5.5 GB RSS+swap) and OOM-killed prod on 2026-07-30. Also gates the boot-only stale-`dtach -a`-attach-client sweep. Every reap is logged to `audit.jsonl` (`session.reap` / `session.reapStaleAttacher`) and surfaced (cheaply, from cached counters) on `GET /api/health`'s `sessionReaper` block. |
| `KOOKR_REAP_ORPHAN_AGE_MS` | `86400000` (24h) | Non-negative integer ms | Minimum age an UNOWNED session must reach before the reaper above terminates it — avoids racing a mid-launch session (#1537 item 2). |
| `KOOKR_RESOURCE_WATCHDOG` | unset (disabled) | `1`/`true`/`yes`/`on` to enable | Master enable for the resource watchdog actuator (issue #1724). When on, a periodic host sampler watches swap %, MemAvailable, `/proc/vmstat` `oom_kill` deltas, per-agent-family process counts, and orphan-session counts; on pressure it spawns a briefed, unattended investigation task (or a meta-reflection task after the 24h spawn budget). **Off by default** — a new actuator; flip on after review. Spawns go through the normal launch path (capacity/backpressure + reserved-slot posture for actor `kookr`). State: `{dataDir}/resource-watchdog.state.json`. Audit: `{dataDir}/resource-watchdog-audit.jsonl`. Health: `GET /api/health` → `resourceWatchdog` block (cached sampler state only — never a `/proc` scan on the request path). |
| `KOOKR_RESOURCE_WATCHDOG_INTERVAL_MS` | `60000` | Integer ≥ 1000 ms | Sample cadence for the resource watchdog. |
| `KOOKR_RESOURCE_WATCHDOG_SWAP_PERCENT` | `50` | Non-negative number; `0` disables | Swap used % at/above which the watchdog triggers. |
| `KOOKR_RESOURCE_WATCHDOG_MEM_AVAILABLE_MB` | `512` | Non-negative number MiB; `0` disables | MemAvailable floor (MiB) at/below which the watchdog triggers. |
| `KOOKR_RESOURCE_WATCHDOG_PROCESS_CEILING` | `40` | Non-negative integer; `0` disables | Per-agent-family process count (claude / grok / codex) at/above which the watchdog triggers. |
| `KOOKR_RESOURCE_WATCHDOG_ORPHAN_CEILING` | `5` | Non-negative integer; `0` disables | Orphan session count (from the session reaper's last sweep) at/above which the watchdog triggers. |
| `KOOKR_RESOURCE_WATCHDOG_THROTTLE_MS` | `1800000` (30 min) | Non-negative integer ms | Minimum gap between investigation/meta spawns. Persisted across restarts. |
| `KOOKR_RESOURCE_WATCHDOG_SPAWN_BUDGET_24H` | `4` | Integer ≥ 1 | Rolling-24h spawn budget. When prior spawns in the window already meet this count, the next trigger spawns a *meta-reflection* task instead of another investigation. |
| `KOOKR_RESOURCE_WATCHDOG_SPAWN_BUDGET_WINDOW_MS` | `86400000` (24h) | Integer ≥ 60000 ms | Length of the rolling window used by `KOOKR_RESOURCE_WATCHDOG_SPAWN_BUDGET_24H`. |
| `KOOKR_RESOURCE_WATCHDOG_CWD` | server CWD | Absolute directory path | Working directory for the spawned investigation/meta task. |
| `KOOKR_REAP_TERMINAL_TASK_GRACE_MS` | `60000` (60s) | Non-negative integer ms | Minimum time a session whose OWNING TASK already reached a terminal status must sit before the reaper terminates it. Deliberately much shorter than the orphan threshold — the owning task is already known to be done; the grace only avoids double-signalling a session `completeTask`'s own fire-and-forget cleanup is still stopping. |
| `KOOKR_RING_FLEET_BUDGET_BYTES` | `33554432` (32 MiB) | Non-negative integer bytes; `0` disables | Fleet-wide sum of live session ring buffer capacities (issue #1779). Each active session still allocates a full 1 MiB ring; when the sum of capacities exceeds this budget, least-recently-active rings shrink to 64 KiB (full scrollback is still flushed to disk first). Active sessions expand back to 1 MiB when the fleet has room. Surfaces on `GET /api/health` → `terminalBackend.ringFleet*` and Prometheus (`kookr_ring_fleet_*`). Set to `0` to keep every ring at full size (pre-#1779 behaviour). |

### Read-Only Shared View

The [Read-Only Shared View](shared-view-setup.md) (hand a collaborator a scoped,
read-only dashboard link over a private network) has **no dedicated environment
variables** — it reuses the bind/auth/transport knobs above:

- **Bind + activation:** `KOOKR_HOST` non-loopback turns on the API-token gate,
  which also activates the owner share routes (`/api/share/viewers`); on a
  loopback bind the feature is inert. `KOOKR_API_TOKEN` / `KOOKR_ALLOW_NON_LOOPBACK`
  satisfy the gate (CLI clients use the token; browsers use the session cookie).
- **Cookie transport posture:** `KOOKR_TRUSTED_TUNNEL` controls whether the
  browser session cookie may be issued over plain HTTP (see its row above and the
  setup guide).
- **Cookie + CSRF are automatic, not configurable.** The `HttpOnly; SameSite=Strict;
  Path=/` session cookie and the per-session double-submit CSRF nonce
  (`X-Kookr-CSRF`) are managed by the server (`POST /api/auth/session`); the CSRF
  HMAC secret is generated fresh per process. There is nothing to set.

> Live viewer admission is currently a **preview** — links can be minted, listed,
> and revoked, but the wiring that admits a viewer cookie onto the live data
> streams is deferred. See the setup guide for the current status.

## Agent Launch

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_AGENT_BIN` | `claude` | Executable path or command name | Overrides the Claude Code binary used for new `claude-code` tasks. |
| `KOOKR_CODEX_BIN` | `codex` | Executable path or command name | Overrides the Codex CLI binary used for new `codex-cli` tasks. |
| `KOOKR_CODEX_MODEL` | `gpt-5.6-sol` | Model identifier | Model passed as `-c model="<id>"` for Kookr-fork `codex-cli` launches. Defaults to Sol. Set to `gpt-5.6-luna` (or another fork-supported model id) to opt into a different default. An explicit `ultra` effort always escalates to `gpt-5.6-sol` regardless of this value. Stock (non-fork) Codex binaries ignore this setting. |
| `KOOKR_GROK_BIN` | `grok` | Executable path or command name | Overrides the Grok Build binary used for new `grok-build` tasks (issue #1339). If set but unreachable, startup is fatal; if the default `grok` is missing from PATH, `grok-build` is simply not registered (excluded from the picker and round-robin). |
| `KOOKR_GROK_MODEL` | `grok-4.5` | Model identifier | Model passed to `grok --model` for `grok-build` tasks. Defaults to the requalified POC-A model (the original `grok-build` model is no longer served by the chat proxy). |
| `KOOKR_GROK_BUILD_DISABLE_NEW_LAUNCHES` | unset | `true` to halt | New-launch kill switch: refuses new `grok-build` launches (incident response), without a restart. Existing sessions are unaffected. |
| `KOOKR_GROK_COMPAT_MANIFEST` | In-repo reviewed manifest | Absolute path | Overrides the path to the reviewed `grok-build-compatibility.v1` manifest used for advisory build qualification (unqualified builds launch with a supervision warning). |
| `KOOKR_PLUGIN_DIR` | Auto-resolved `<kookr>/plugin` | Absolute or relative path, or empty string | Overrides the toolkit plugin directory injected into spawned Claude Code sessions. Set to an empty string to disable injection. |
| `KOOKR_BYPASS_ALL_PERMISSIONS` | unset | `true` to enable | Launches spawned agents with permission-bypass flags. See "Operational Risk" below before enabling. |
| `KOOKR_PROTECTED_BRANCHES` | `main,master,develop,dev` | Comma-separated branch names | Replaces the branch allowlist that requires explicit confirmation for user-initiated worktree cleanup and blocks automatic cleanup. |

## Kookr-Injected Agent Context

These variables are written into spawned agent environments. They are normally
not user configuration knobs.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_TASK_ID` | Injected per task | Task id string | Identifies the current Kookr task. Hooks and child-task workflows use it for correlation. |
| `KOOKR_PARENT_TASK_ID` | Injected only for child tasks | Task id string | Identifies the parent task for nested agent work. |
| `KOOKR_LAUNCH_PROVENANCE` | Injected per task | `schedule` \| `parent` \| `manual` \| `unknown` | The task's immutable launch provenance (issue #1583). Lets headless playbooks branch on how they were launched — e.g. the parallel-issue-batch playbook treats `schedule`/`parent` as headless and reports-and-exits on an empty backlog instead of stranding on `AskUserQuestion` (issue #1714). |
| `KOOKR_UNATTENDED` | Injected only for unattended tasks | `1` when set | Marks an unattended/autonomous run (issue #1562) where nobody is watching to answer a prompt. Headless playbooks treat it the same as `schedule`/`parent` provenance (issue #1714). |
| `KOOKR_API_BASE_URL` | `http://127.0.0.1:<server port>` when known | HTTP URL | Lets agents and CLIs call back to the active Kookr instance. |
| `KOOKR_GIT_COMMON_DIR` | Injected when cwd is a Git worktree | Absolute path | Points at the shared Git common directory for worktree-aware workflows. |
| `KOOKR_AGENT_ID` | Not injected yet (reserved) | Session id string | Optional session-id hint read by `kookr issue claim` to stamp the claiming session (RFC rfc-issue-ownership-lock). Harmless when unset; adapters may inject it in a later phase. |

## CLI Tools

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_API_BASE_URL` | Auto-detect 4800/4801 when unset | HTTP URL | `kookr spawn` and `kookr ralph` use this URL directly and skip port probing. |
| `KOOKR_PORT` | Auto-detect 4800/4801 for CLI tools | Integer port, 1-65535 | Forces `kookr status`, `kookr spawn`, or `kookr ralph` to talk to one local instance. |
| `KOOKR_ISSUE_CLAIMS` | `off` | `1`/`true`/`on` to enable | Feature flag for the issue-ownership claim registry (RFC rfc-issue-ownership-lock). Read once at startup — restart to change; the boot log prints the resolved value. Off: no registry, claim routes 404 (clients proceed as pre-lock), release calls no-op. |
| `KOOKR_SPAWN_MAX_PROMPT_BYTES` | `1048576` | Positive integer bytes | Maximum prompt size accepted from `kookr spawn` stdin or `--prompt-file`. |
| `KOOKR_SPAWN_CONNECT_RETRIES` | `3` | Integer `1` through `10` | Number of `kookr spawn` connectivity sweeps before reporting no server. |
| `KOOKR_SPAWN_AUTO_IDEMPOTENCY` | unset (off) | `1`/`true`/`yes`/`on` to enable | Default for `kookr spawn --auto-idempotency`: when no `--idempotency-key` is given, derive a key (`auto-<hash>`) from prompt+cwd+criteria+agent so a client-timeout retry of the identical spawn replays instead of stranding a duplicate (bounded by the server's rolling 24h idempotency TTL). Only helps stable-prompt retries; regenerated-prompt retries need an explicit `--idempotency-key`. `--no-auto-idempotency` overrides it per-invocation; no effect under `--dedupe=skip`. |
| `KOOKR_MERGE_REQUIRE_REVIEW` | `1` (on) | `0`/`false` to disable | Independent merge-review gate for `pnpm merge` (`scripts/kookr-merge.sh`, issue #1717). When on (default), the wrapper refuses to merge (exit 4) unless the PR carries a fresh-context reviewer verdict of `pass` for the current head — see the `independent-merge-review` skill — or the `review-skipped-timeout` label (applied when the reviewer exceeds the 10-minute latency budget). Set to `0` only for a human-driven manual merge, never for an autonomous self-merge. |

## Terminal Backend

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_BACKEND` | unset, treated as `dtach` | unset or `dtach` | Compatibility guard only. Any other value hard-fails startup because the tmux backend was removed. |
| `KOOKR_DTACH_SOCK_DIR` | `/tmp/kookr-dtach/$(id -u)` | Directory path | Overrides the dtach socket root used by `scripts/rollback-dtach.sh`. |

## Terminal Streaming

These variables tune live PTY-output forwarding from `SessionBridge` to browser
terminal sockets. The defaults are intended for normal local use; change them
only when diagnosing slow viewers or unusually high terminal-output volume.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_SESSION_BRIDGE_OUTPUT_BATCH_MS` | `5` | Positive integer milliseconds | Live PTY-output coalescing window. Chunks received within this window are concatenated into one binary WebSocket frame. Replay bytes are unaffected. |
| `KOOKR_SESSION_BRIDGE_BACKPRESSURE_RETRY_MS` | `25` | Positive integer milliseconds | Retry cadence while a browser socket remains above the soft buffered-output threshold. |
| `KOOKR_SESSION_BRIDGE_BACKPRESSURE_SOFT_BYTES` | `1048576` | Positive integer bytes | If `ws.bufferedAmount` is above this value, live PTY output stays queued for that socket instead of sending another frame. |
| `KOOKR_SESSION_BRIDGE_OWNER_BACKPRESSURE_HARD_BYTES` | `67108864` | Positive integer bytes | Hard queued-plus-buffered ceiling for owner terminal sockets. Above this, the bridge closes the socket so the client can reconnect and replay from the backend ring buffer. |
| `KOOKR_SESSION_BRIDGE_VIEWER_BACKPRESSURE_HARD_BYTES` | `16777216` | Positive integer bytes | Hard queued-plus-buffered ceiling for read-only viewer terminal sockets. Viewers use a lower ceiling so slow remote readers cannot retain unbounded server memory. |
| `KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS` | `400` | Non-negative integer milliseconds (`0` disables the wait) | How long an owner terminal bridge waits for the browser's first FitAddon `resize` control frame before deciding whether to replay the ring buffer. Prevents painting 200-col absolute-position TUI history into a narrower xterm. |
| `KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS` | `80` | Non-negative integer milliseconds (`0` applies immediately) | Coalesces subsequent browser resize control frames so FitAddon/layout thrash does not WINCH-storm agent TUIs. |
| `KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS` | `40` | Non-negative integer milliseconds | Pause between the two WINCH steps (`cols-1` → `cols`) used as a last-resort live repaint when the bridge skips dense absolute-position ring replay (Grok Build) and both `captureCurrentFrame` and `reconnectTransport` fail to yield a frame. Preferred recovery is a non-destructive multi-attach snapshot (`LocalDtachBackend.captureCurrentFrame`), then reconnect attach-replay. |

## Recovery And Scheduling

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_AUTO_RELAUNCH` | enabled | `false` to disable | Disables startup crash recovery and automatic relaunch/resume of tasks marked completed by reconciliation. |
| `KOOKR_AUTO_CATCHUP` | unset | Any non-empty value | Opts in to automatic schedule catch-up on scheduler startup. By default, missed startup runs are recorded in the execution ledger and can be launched manually with Run Now. |
| `KOOKR_NO_CATCHUP` | unset | Any non-empty value | Legacy kill switch for startup catch-up. Takes precedence over `KOOKR_AUTO_CATCHUP`; future cron ticks still run. |
| `KOOKR_WORKTREE_RECLAIM_CRON` | unset (off) | 5-field cron expression | Enables an unattended, scheduled worktree reclaim (issue #1578). Each run regenerates the candidate list fresh, removes only `merged`/`patch_equivalent` worktrees (via `canSweepRemove`), removes the path while KEEPING the branch, hard-excludes `kookr-prod` / `.kookr-protected` / protected-branch worktrees, and appends an audit trail to `~/.kookr/audit.jsonl`. Off by default; unset or an invalid expression keeps it disabled. |
| `KOOKR_WORKTREE_RECLAIM_DRY_RUN` | unset (live) | `1`/`true`/`yes`/`on` | When the reclaim schedule is enabled, forces dry-run mode: candidates are classified and logged (`would_remove`) but nothing is removed. |

## Context Window

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_CONTEXT_ADVISORY_ENABLED` | unset | `1` to enable | Enables context-window hook advisories. |
| `KOOKR_CONTEXT_ADVISORY_DISABLED` | unset | `1` to disable | Kill switch for context-window hook advisories. Takes precedence over enablement. |

## Hook Event Log

Read by `bin/kookr-hook-writer.js` at hook time to bound per-session hook JSONL growth (issue #1433). Historically the live `HookFileWatcher` re-read the whole active file on every append (O(file size) per event), which starved ingestion under load; as of the #1612 incremental-read fix it stat-first skips and range-reads only appended bytes. Rotation still caps active-file size and bounds startup/replay cost while preserving append-only JSONL semantics; rotated segments are named `<session>.jsonl.N` and cleaned up by `kookr maintenance` once the owning task is terminal and aged.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_HOOK_MAX_BYTES` | `33554432` | Integer bytes; `<= 0` disables rotation | Size cap for the active per-session hook JSONL file. When appending a record would push the file past this cap, the writer rotates it to `<session>.jsonl.1` (shifting older generations up) and starts a fresh file. A single record larger than the cap is still written intact to its own fresh generation. |
| `KOOKR_HOOK_ROTATE_KEEP` | `4` | Non-negative integer | Number of rotated hook-log generations (`.1` … `.N`) retained per session before the oldest is deleted, bounding total on-disk hook history to roughly `(keep + 1) × KOOKR_HOOK_MAX_BYTES` per session. `0` keeps no rotated history (hard truncate on rotation). |

## Agent Signal Nudge

See `docs/rfc/rfc-agent-signal-surface.md`.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_NUDGE_DISABLED` | unset | `1`/`true` to disable | Kill switch for the Stop-hook completion nudge. Read by `bin/kookr-stop-nudge.js` at hook time and propagated into spawned-agent env so new tasks honor it. In-flight tasks can also be disabled by creating the runtime marker file `/dev/shm/.kookr-nudge-disabled`. |
| `KOOKR_NUDGE_MIN_TASK_AGE_MS` | `45000` | Non-negative integer ms | Minimum task age before the Stop-hook nudge may fire, so a trivial first stop early in a task does not spend the once-per-task nudge. |

## LLM Provider

These variables select and configure the LLM provider behind Kookr's AI
features (task naming, response suggestions, and Telegram remote-chat
rephrase). They are **independent of the local speech STT/TTS models** in the
"Speech IO" section below — `KOOKR_LLM_PROVIDER` never affects voice
transcription or synthesis.

Provider API keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `REQUESTY_API_KEY`) use vendor-native names and can be
paired with Kookr-scoped keys where listed. With no provider key set, AI
features stay disabled and Kookr falls back to truncated prompt names.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_LLM_PROVIDER` | `auto` | `openrouter`, `requesty`, `baseten`, `groq`, `gemini`, `anthropic`, `auto` | Selects the LLM provider. `auto` chains every configured provider for fallback in order `GROQ > GEMINI > ANTHROPIC > OPENROUTER`; Requesty and Baseten are explicit-only and are not included in `auto`. An explicit value uses only that provider. An unrecognized value warns and falls back to `auto`. |
| `GROQ_API_KEY` | unset | Groq API key | Enables the Groq provider (Llama 4 Scout, free tier). |
| `GEMINI_API_KEY` | unset | Google AI API key | Enables the Gemini provider (Gemini 3 Flash, free tier). |
| `ANTHROPIC_API_KEY` | unset | Anthropic API key | Enables the Anthropic provider (Claude Haiku). |
| `KOOKR_OPENROUTER_API_KEY` | unset | OpenRouter API key | Enables the OpenRouter provider. Preferred over `OPENROUTER_API_KEY` so a separate OpenRouter credit limit can be scoped to Kookr. |
| `OPENROUTER_API_KEY` | unset | OpenRouter API key | Fallback OpenRouter key for simple single-key setups. Used only when `KOOKR_OPENROUTER_API_KEY` is unset. |
| `KOOKR_REQUESTY_API_KEY` | unset | Requesty API key | Enables the Requesty provider when `KOOKR_LLM_PROVIDER=requesty`. Preferred over `REQUESTY_API_KEY` so a separate Requesty credit limit can be scoped to Kookr. |
| `REQUESTY_API_KEY` | unset | Requesty API key | Fallback Requesty key for simple single-key setups. Used only when `KOOKR_LLM_PROVIDER=requesty` and `KOOKR_REQUESTY_API_KEY` is unset. |
| `KOOKR_LLM_MODEL` | `deepseek/deepseek-v4-flash` | OpenRouter model id | Overrides the OpenRouter model. Applies to the OpenRouter provider only; Groq/Gemini/Anthropic keep their built-in defaults. |
| `KOOKR_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL | Overrides the OpenRouter chat-completions base URL (e.g. for a proxy). OpenRouter provider only. |
| `KOOKR_LLM_HTTP_REFERER` | unset | URL | Optional `HTTP-Referer` app-attribution header sent on OpenRouter requests. |
| `KOOKR_LLM_APP_TITLE` | `Kookr` | String | Optional `X-Title` app-attribution header sent on OpenRouter requests. |
| `KOOKR_LLM_TIMEOUT_MS` | `20000` | Positive integer milliseconds | Explicit OpenRouter request timeout, used verbatim. OpenRouter provider only. When unset (or non-numeric/non-positive), a caller timeout below `20000` is floored up to it. Groq/Gemini/Anthropic use a fixed ~10s budget. |
| `KOOKR_REQUESTY_MODEL` | `openai/gpt-4o-mini` | Requesty model or policy id | Overrides the Requesty model. Requesty model ids use provider prefixes, e.g. `openai/gpt-4o-mini`. Applies only when `KOOKR_LLM_PROVIDER=requesty`. |
| `KOOKR_BASETEN_API_KEY` | unset | Baseten API key | Enables the Baseten provider when `KOOKR_LLM_PROVIDER=baseten`. Preferred over `BASETEN_API_KEY` so a separate Baseten credential can be scoped to Kookr. |
| `BASETEN_API_KEY` | unset | Baseten API key | Fallback Baseten key for simple single-key setups. Used only when `KOOKR_LLM_PROVIDER=baseten` and `KOOKR_BASETEN_API_KEY` is unset. |
| `KOOKR_BASETEN_MODEL` | `nvidia/Nemotron-120B-A12B` | Baseten model id | Overrides the Baseten model. Applies only when `KOOKR_LLM_PROVIDER=baseten`. |
| `KOOKR_BASETEN_BASE_URL` | `https://inference.baseten.co/v1` | OpenAI-compatible base URL | Overrides the Baseten chat-completions base URL. Baseten provider only. |

## Remote Chat Trigger

Remote chat is off by default. Set the Telegram token, allowed user IDs, and
allowed project paths to opt in. `KOOKR_REMOTE_CHAT_DISABLED=1` is a panic
switch that prevents startup of the integration even when other variables are
set.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_TELEGRAM_BOT_TOKEN` | unset | Telegram bot token | Enables the Telegram remote-chat integration when allowlists are also configured. |
| `KOOKR_TELEGRAM_ALLOWED_USERS` | unset | Comma-separated numeric Telegram user IDs | Restricts inbound Telegram messages to explicitly allowed users. Empty allowlist refuses startup. |
| `KOOKR_REMOTE_CHAT_PROJECTS` | unset | Comma-separated absolute project paths | Restricts remotely spawned tasks to these project paths. Empty allowlist refuses startup. |
| `KOOKR_REMOTE_CHAT_DRY_RUN` | unset | `1` to enable | Parses and validates inbound Telegram messages, but replies without launching a task. |
| `KOOKR_REMOTE_CHAT_ALLOW_CODEX` | unset | `1` to enable | Allows authorized Telegram users to select Codex CLI via `/agent codex`, `/task --agent codex ...`, or structured rephrase metadata. When unset, Telegram-spawned Codex tasks are rejected before confirmation and again at the launch-service trust boundary. |
| `KOOKR_REMOTE_CHAT_DASHBOARD_URL` | unset | HTTP or HTTPS origin, e.g. `https://kookr.example.com` | Overrides the dashboard URL used in Telegram spawn confirmations, permission block alerts, and task outcome notifications. Set this when Telegram links must open from a phone. When unset, Kookr derives a local URL from `KOOKR_HOST`/`KOOKR_PORT` and warns if the server binds `0.0.0.0` because the fallback becomes `http://localhost:<port>`. |
| `KOOKR_REMOTE_CHAT_DISABLED` | unset | `1` to disable | Panic switch for the Telegram remote-chat integration. Takes precedence over the bot token. |
| `KOOKR_TELEGRAM_API_URL` | Telegram API default | HTTP URL | Overrides the Telegram API base URL. Used by tests and local fakes. |
| `KOOKR_STT_WHISPER_URL` | unset | HTTP URL of the local faster-whisper-server (e.g. `http://127.0.0.1:8010`) | Enables Telegram audio transcription for voice, uploaded audio, video notes, and audio documents. When unset, audio messages are dropped with the `dropped_audio_disabled` audit kind and the user is told audio is unsupported. The server must expose the OpenAI-compatible `POST /v1/audio/transcriptions` endpoint and is reached over plain HTTP — bind it to localhost only. |

## Outbound Finding Webhook

Outbound webhooks are off by default. Set `KOOKR_WEBHOOK_URL` to POST each new
attention finding to a generic JSON receiver. The webhook URL is operator-supplied
local configuration; do not store shared secrets in checked-in `.env` files.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_WEBHOOK_URL` | unset | HTTP or HTTPS URL | Enables generic outbound JSON POST notifications when findings enter the active attention queue. |
| `KOOKR_WEBHOOK_MIN_SEVERITY` | `info` | `info`, `warning`, `critical` | Sends only findings at or above the configured severity. Invalid values fall back to `info` with a warning. |
| `KOOKR_WEBHOOK_SECRET` | unset | Secret string, or comma-separated secrets for rotation | Adds `X-Kookr-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` to outbound finding webhook POSTs. Kookr signs with the first configured secret; receivers should verify against any accepted secret during rotation. |

Delivery behavior is part of the receiver contract. Kookr uses
`DEFAULT_MAX_ATTEMPTS` and `DEFAULT_INITIAL_RETRY_DELAY_MS` for 3 attempts with
1s, then 2s, exponential backoff; each POST attempt times out after
`DEFAULT_REQUEST_TIMEOUT_MS` (10s). Network errors, timeouts, 3xx responses, and
5xx responses retry until the attempt budget is exhausted. Any 4xx response is
permanent and stops retrying immediately. Redirects are not followed
(`redirect: 'manual'`). After a successful delivery, duplicates are suppressed
by `agentId:fingerprint` until the finding resolves. After permanent failure,
the key is released and re-delivery is held for
`DEFAULT_FAILURE_COOLDOWN_MS` (30s). Receivers should still make `fingerprint`
idempotent. Outcome counters appear on `GET /metrics` as
`kookr_webhook_deliveries_total{outcome=…}`. Full contract:
[Outbound Finding Webhooks](../configuration.md#outbound-finding-webhooks).

The JSON body a receiver must parse — the `kookr.finding.webhook.v1` field
contract with an example — is documented in
[Payload body schema](../configuration.md#payload-body-schema).

## Operator Signal Delivery

Operator-signal delivery is off by default (issue #1716). kookr has plenty of
*detection* — the deploy-lag detector, prod-smoke tick, and liveness checks all
compute alert conditions — but before this bridge those conditions produced no
operator-visible notification. When a channel is configured, emitters spool
signals into `~/.kookr/playbook-state/operator-signals/` and a background service
pushes new alert/clear signals to Discord and/or Telegram (dedup by signal file
name, batched to ≤1 message/min, restart-safe). Deploy-lag and prod-smoke
fire/recover transitions are bridged automatically; the `kookr signal-emit` CLI
lets scheduled monitors spool transition and liveness signals too.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_DISCORD_WEBHOOK_URL` | unset | Discord incoming-webhook URL | Enables Discord delivery of operator signals. Operator-supplied local config; do not commit shared secrets. |
| `KOOKR_SIGNAL_TELEGRAM_CHAT_ID` | unset | Numeric Telegram chat ID | Enables Telegram delivery of operator signals to this chat (reuses `KOOKR_TELEGRAM_BOT_TOKEN`). Independent of the inbound remote-chat allowlist. |
| `KOOKR_SIGNAL_DELIVERY_DRY_RUN` | unset | `1` to enable | Formats and logs each batch but never POSTs. Entries are still marked delivered so the log does not loop. |
| `KOOKR_SIGNAL_DELIVERY_POLL_MS` | `15000` | Positive integer (ms) | Poll cadence for tailing the operator-signal outbox. |
| `KOOKR_SIGNAL_DELIVERY_MIN_SEND_MS` | `60000` | Positive integer (ms) | Minimum spacing between outbound messages; each eligible tick drains all pending signals into one batched message. |
| `KOOKR_OPERATOR_SIGNAL_DIR` | `~/.kookr/playbook-state/operator-signals` | Absolute or relative path | Override the operator-signal outbox directory. |

## Relay

Hosted relay is inert until the operational gate is explicitly enabled; see
`docs/reference/hosted-relay-operations.md`. For user-operated public relays,
see `docs/reference/self-hosted-relay-runbook.md`.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_HOSTED_RELAY_URL` | `https://share.kookr.dev` | HTTPS URL | Hosted relay URL shown as the default Settings pairing target when gates are met. |
| `KOOKR_HOSTED_RELAY_ENABLED` | unset | `true`, `1`, or `yes` | Enables hosted relay as a product path candidate. Does not make it default unless ops gates are also met. |
| `KOOKR_HOSTED_RELAY_OPS_GATES_MET` | unset | `true`, `1`, or `yes` | Marks deployment, TLS/domain, account/device auth, retention, rate-limit, emergency, metrics, tenant isolation, privacy notice, paging/escalation, synthetic probe, per-tenant kill switch, and metadata-only evidence gates as satisfied. |
| `KOOKR_HOSTED_RELAY_MODE` / `KOOKR_RELAY_MODE` | `available` | `available`, `maintenance`, `emergencyDisabled` | Controls hosted relay availability. Maintenance and emergency modes refuse new pairings/shares without stopping local Kookr. |
| `KOOKR_HOSTED_RELAY_OWNER` | unset | Text label | Deployment owner surfaced in hosted relay status. |
| `KOOKR_HOSTED_RELAY_ENVIRONMENT` | unset | `local`, `staging`, `production`, or text label | Hosted relay environment label surfaced in status. |
| `KOOKR_HOSTED_RELAY_TLS_EXPIRES_AT` | unset | ISO timestamp | TLS certificate expiry surfaced by `/health` and hosted relay status. |
| `KOOKR_HOSTED_RELAY_RETENTION_DAYS` | `30` | Positive integer days | Metadata retention window for hosted relay operations. |
| `KOOKR_RELAY_ACCOUNT_TOKEN` | unset | Secret bearer token | Enables account-authenticated hosted node pairing through `/relay/account/nodes`. Never returned in status responses. |
| `KOOKR_RELAY_ACCOUNT_ID` | `hosted-owner` | Account id string | Owner id assigned to nodes paired through account auth. |
| `KOOKR_RELAY_INCIDENT_ESCALATION_URL` | unset | HTTPS URL or internal escalation target | Documents the paging/escalation target required before hosted relay terminal viewing is production-enabled. |
| `KOOKR_RELAY_BIND_HOST` | `0.0.0.0` for this release | Hostname or IP address | Bind host for the relay binary. Self-hosted public deployments should set `127.0.0.1` and put Caddy in front. Non-loopback binds warn unless acknowledged. |
| `KOOKR_RELAY_ALLOW_INSECURE_BIND` | unset | `1` | Acknowledges the current-release warning when intentionally binding the relay to a non-loopback host. |
| `KOOKR_RELAY_TRUSTED_PROXY` | `1` when bound to loopback | `0` or `1` | Controls whether the relay trusts a loopback reverse proxy's `X-Forwarded-For` client IP for rate limits and lockouts. |
| `KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_COUNT` | unset | Non-negative integer | Opt-in cap for local remote-command audit archive segments (`audit.*.jsonl`). When set, Kookr prunes older command-only rotated segments after journal compaction while preserving the current active audit, snapshot, current rotation, and any archive containing task lifecycle or other non-command audit rows. Unset preserves existing unbounded archive retention for forensics. |
| `KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_AGE_DAYS` | unset | Non-negative number of days | Opt-in age cap for local remote-command audit archive segments. Command-only segments older than this are pruned after journal compaction, except the segment produced by the current rotation. Archives containing task lifecycle or other non-command audit rows are preserved. Unset disables age pruning. |
| `KOOKR_RELAY_PUBLIC_ORIGIN` | unset | HTTPS URL | Public relay origin used by self-hosted deployments and health/operator docs. |
| `KOOKR_RELAY_STATE_DB_PATH` | `relay-state.sqlite` for the standalone relay binary | SQLite file path | Enables durable relay state for node registrations, hashed node tokens, invitations, share verifiers, and per-share lockout counters. |
| `KOOKR_RELAY_REQUEST_BODY_LIMIT_BYTES` | `1000000` | Positive integer bytes | Maximum JSON request body size accepted by the relay. |
| `KOOKR_RELAY_METADATA_RETENTION_DAYS` | `30` | Positive integer days | Self-hosted relay metadata retention setting; keep aligned with backup/ops policy. |
| `KOOKR_RELAY_METADATA_AUDIT_CAP` | `5000` | Positive integer | In-memory ring capacity for `/relay/admin/metadata-audit` rows. Oldest rows are dropped when the cap is exceeded so the long-lived relay cannot grow without bound. The admin response reports `cap`, `retained`, `droppedCount`, and `truncated`. |
| `KOOKR_RELAY_SHARE_MAX_TTL_MS` | `86400000` | Positive integer ms, clamped to 31 days | Operator opt-in ceiling for task-share links. Unset keeps the 24h default; values above 31 days are reduced to the hard cap. |
| `KOOKR_RELAY_METRICS_WINDOW_MS` | `300000` | Positive integer ms | Recent metrics window used by relay alerts so rate-limit/security alerts can clear. |
| `KOOKR_RELAY_SHARE_CREATE_LIMIT_PER_MINUTE` | `20` | Positive integer | Per-node share creation limit. Hits appear in relay metrics and alerts. |
| `KOOKR_RELAY_ACCOUNT_PAIR_LIMIT_PER_MINUTE` | `10` | Positive integer | Per-account hosted node pairing limit. |
| `KOOKR_RELAY_HEARTBEAT_ALERT_MS` | `60000` | Positive integer ms | Alert threshold for stale node heartbeat age. |
| `KOOKR_RELAY_5XX_ALERT_THRESHOLD` | `1` | Positive integer | Alert threshold for relay 5xx responses. |

## Speech IO

Speech-to-text and text-to-speech are a separate concern from the "LLM
Provider" section above: they configure local voice models and are unaffected
by `KOOKR_LLM_PROVIDER` or any LLM provider key.

Bundled STT and TTS run via Docker Compose. The default STT config targets an NVIDIA GPU with the NVIDIA Container Toolkit; switch to the CPU-fallback values below (and remove the GPU device reservation in `stt/docker-compose.yml`) to run on CPU.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_STT` | unset | `true` to enable | Starts bundled speech-to-text services when no `KOOKR_STT_URL` is provided. |
| `KOOKR_STT_URL` | unset | WebSocket URL | Uses an external speech-to-text service and skips bundled startup. |
| `KOOKR_STT_PORT` | `8003` | Integer port | Port for the bundled speech-to-text service. Also injected into the STT child process. |
| `KOOKR_STT_HEALTH_TIMEOUT_S` | `600` | Positive number of seconds | Maximum time to wait for the bundled speech-to-text service health check. Increase for slow first-run Whisper model downloads. |
| `KOOKR_STT_DEVICE` | `auto` | `auto`, `cpu`, `gpu` | Inference device for the bundled STT stack. `auto` probes `docker info` for an nvidia runtime and resolves to `gpu` (CUDA Whisper image, `large-v3`, float16 + GPU device reservation) or `cpu` (CPU Whisper image, `base`, int8). Set explicitly to override the auto choice. |
| `WHISPER_IMAGE` | per-device default | Container image reference | Override the Whisper sidecar image. Defaults: `fedirz/faster-whisper-server:latest-cuda` on GPU, `fedirz/faster-whisper-server:latest-cpu` on CPU. |
| `WHISPER_MODEL` | per-device default | Faster-Whisper model id (`tiny`, `base`, `small`, `medium`, `large-v3`, ...) | Override the Whisper model. Defaults: `large-v3` on GPU (~3 GB first-run download), `base` on CPU (~150 MB). |
| `WHISPER_DEVICE` | per-device default | `cuda` or `cpu` | Override the Whisper inference device. Defaults: `cuda` on GPU, `cpu` on CPU. |
| `WHISPER_COMPUTE_TYPE` | per-device default | `float16`, `int8`, `int8_float16`, ... | Override Whisper inference precision. Defaults: `float16` on GPU, `int8` on CPU. |
| `KOOKR_TTS` | unset | `true` to enable | Starts bundled text-to-speech services when no `KOOKR_TTS_URL` is provided. |
| `KOOKR_TTS_URL` | unset | HTTP/WebSocket URL expected by the client | Uses an external text-to-speech service and skips bundled startup. |
| `KOOKR_TTS_PORT` | `8004` | Integer port | Port for the bundled text-to-speech service. Also injected into the TTS child process. |
| `KOOKR_TTS_DEVICE` | `auto` | `auto`, `cpu`, `gpu` | Inference device for the bundled TTS stack. `auto` probes `docker info` for an nvidia runtime and applies the GPU compose override when available; set explicitly to force CPU or GPU. |
| `TTS_VOICE` | `/app/voices/matilda.mp3` | Built-in voice name or path inside the `kookr-tts` container | Default voice used by the bundled TTS service. Built-in voices: `alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`. Bundled/custom voices are copied from `tts/voices/` into the image at build time and can be referenced as `/app/voices/<name>.<ext>`. Bundled startup probes this configured voice before advertising TTS as enabled. |
| `TTS_MAX_TEXT_LENGTH` | `5000` | Positive integer character count | Maximum accepted text length for `/synthesize`; longer requests return HTTP 413 before model invocation. Read by the Python TTS sidecar. |
| `TTS_MODEL_TEMPERATURE` | `0.7` | Positive float | Pocket TTS sampling temperature at model load (`temp=`). Higher values increase voice variation; lower values sound more deterministic. Read by the Python TTS sidecar (`tts/src/server.py`), not the TypeScript process. |
| `TTS_MODEL_LSD_STEPS` | `1` | Positive integer | Pocket TTS latent spectral decode steps (`lsd_decode_steps=`). More steps can improve quality at the cost of latency. Read by the Python TTS sidecar at model load. |
| `TTS_MODEL_EOS_THRESHOLD` | `-4.0` | Float | Pocket TTS end-of-speech threshold (`eos_threshold=`). Controls when the model stops generating audio. Read by the Python TTS sidecar at model load. |
| `TTS_MODEL_NOISE_CLAMP` | unset | Float, or empty to leave unset | Optional Pocket TTS noise clamp (`noise_clamp=`). When unset or empty, the model uses its built-in default (`None`). Forwarded from the host by the bundled Docker Compose configuration and read by the Python TTS sidecar at model load. |

## Diagnostics And Budgeting

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_BUDGET_WARN_USD` | `25` | Number in USD, `0` disables | Global fallback for the per-task reactive token-cost warning threshold; a project's **Cost warning (USD)** setting takes precedence. Critical alerts fire at twice the effective value. Invalid or blank values use the default; `0` disables alerts when no project override is set. |
| `KOOKR_ALERT_CPU_PERCENT` | `0` (disabled) | Non-negative number (percent), `0` disables | Host CPU usage threshold for operational alerts on the already-sampled resource feed. Fires one `warning` alert when CPU stays at or above this for `KOOKR_ALERT_SUSTAIN_SAMPLES` consecutive samples, and one `info` alert on recovery. Negative or invalid values are treated as `0`. |
| `KOOKR_ALERT_MEMORY_PERCENT` | `0` (disabled) | Non-negative number (percent), `0` disables | Host memory-used threshold for operational alerts, evaluated like `KOOKR_ALERT_CPU_PERCENT`. |
| `KOOKR_ALERT_EVENT_LOOP_DELAY_MS` | `0` (disabled) | Non-negative number (milliseconds), `0` disables | Server event-loop delay (p95) threshold for operational alerts, evaluated like `KOOKR_ALERT_CPU_PERCENT`. |
| `KOOKR_ALERT_PROCESS_RSS_BYTES` | `3221225472` (3 GiB) | Non-negative number (bytes), `0` disables | Kookr supervisor process resident-set-size (RSS) threshold for operational alerts, evaluated like `KOOKR_ALERT_CPU_PERCENT`. Unlike host `KOOKR_ALERT_MEMORY_PERCENT`, this surfaces the Kookr process itself "fattening" (e.g. retained snapshots/hook state) before the host is near OOM. Defaults to `3` GiB (issue #1612) so the alert fires ~900 MB below the observed ~3.9 GB heap OOM ceiling, giving an operator lead time to restart before HTTP starvation. Set to `0` to disable, or raise it for hosts with a larger heap budget. The `warning` alert carries remediation hints (inspect `/api/diagnostics/hook-ingestion` and the active task count, run `kookr maintenance prune --dry-run`, clear finished tasks). |
| `KOOKR_ALERT_DATA_DIR_FREE_PERCENT` | `5` | Non-negative number (percent), `0` disables | Free-space floor for the filesystem containing the Kookr data directory (`~/.kookr` or `~/.kookr-<port>`). Fires one `warning` alert when free space stays at or below this percent for `KOOKR_ALERT_SUSTAIN_SAMPLES` consecutive samples, and one `info` alert after all enabled free-space floors recover. |
| `KOOKR_ALERT_DATA_DIR_FREE_BYTES` | `2147483648` | Non-negative number (bytes), `0` disables | Absolute free-space floor for the Kookr data-directory filesystem, evaluated together with `KOOKR_ALERT_DATA_DIR_FREE_PERCENT`; breaching either enabled floor triggers the same low-disk-space rule. |
| `KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS` | `30000` | Non-negative number (milliseconds), `0` disables | Circuit-breaker OPEN duration threshold. Fires one advisory `warning` alert when a breaker remains OPEN for at least this long, and one `info` alert when it recovers to HALF_OPEN or CLOSED. |
| `KOOKR_ALERT_SUSTAIN_SAMPLES` | `3` | Integer `>= 1` | Consecutive breaching resource samples required before sampled-resource operational alerts fire (edge-triggered; clears on the first sample back below threshold). Circuit-breaker alerts use `KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS` instead. Samples are taken roughly every 2 seconds. Invalid or blank values use the default. |
| `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS` | `1000` | Non-negative number (milliseconds), `0` disables | Load-based admission threshold for `POST /api/tasks` (issue #1590). When the already-sampled server event-loop delay p95 (the same signal `KOOKR_ALERT_EVENT_LOOP_DELAY_MS` watches, refreshed ~every 2s) is at or above this, a spawn POST is shed with **HTTP 503** + a `Retry-After` header **before** the body is parsed or any task is created — so a saturated event loop fast-fails instead of hanging into a client timeout. Orthogonal to the depth-based `maxPendingTasks` 429 (see [backpressure](./backpressure.md)). The default sits far above steady-state p95 (single-digit ms) so it does not fire in normal operation; `0` disables the gate; unset/blank uses the default. A **negative or non-numeric** value is rejected by startup config-preflight (fatal — the server refuses to start), not silently ignored. Fails **open** (admits) whenever the p95 sample is unavailable. |
| `KOOKR_ADMISSION_RETRY_AFTER_SECONDS` | `2` | Integer `>= 1` (seconds) | `Retry-After` hint sent on the load-based 503 above. Unset/blank uses the default; a **non-integer or `< 1`** value is rejected by startup config-preflight (fatal). |
| `KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS` | `1500` | Non-negative number (milliseconds), `0` disables | Dashboard WS snapshot-fan-out load-shed threshold (issue #1725). Reuses the SAME sampled server event-loop delay p95 as `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS` (no second `monitorEventLoopDelay`). When the sampled p95 stays at or above this for `KOOKR_WS_LOAD_SHED_SUSTAIN_TICKS` consecutive resource-status ticks, the dashboard broadcaster stops serializing and fanning out full snapshots — the expensive outbound work that saturated the loop in the 2026-07-31 incident (2.2 MB × 300+ sockets) — and sends a tiny `wsBackpressureNotice` frame instead, until `KOOKR_WS_LOAD_SHED_RECOVER_TICKS` consecutive ticks land back under threshold. `0` disables shedding entirely. Non-snapshot broadcasts (alerts, `update`, etc.) are unaffected — they're cheap and were never the saturating work. |
| `KOOKR_WS_LOAD_SHED_SUSTAIN_TICKS` | `3` | Integer `>= 1` | Consecutive over-threshold resource-status ticks (~2s apart) required before `KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS` engages. Invalid/blank values use the default. |
| `KOOKR_WS_LOAD_SHED_RECOVER_TICKS` | `3` | Integer `>= 1` | Consecutive under-threshold resource-status ticks required before load-shed mode disengages and full snapshot fan-out resumes. Symmetric with the sustain count by design so a delay bouncing around the threshold can't flap the gate every tick. |
| `KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS` | `1500` | Non-negative number (milliseconds), `0` disables | Non-critical background timer pause threshold (issue #1785). Reuses the SAME sampled server event-loop delay p95 as `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS` / `KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS` (no second `monitorEventLoopDelay`). When the latest sample is **strictly greater** than this value, the next GitHub scanner state-fetch / repo-health tick and other non-critical lifecycle intervals (maintenance prune, relay-orphan sweep, prod-smoke tick, deploy-lag detector) skip their body so the loop can serve terminal I/O. Critical loops (token scan, watchdog, liveness, save, snooze, quota) are never paused. Resume is automatic when a later sample falls back to ≤ threshold. `0` disables pausing. Invalid/blank values use the default; negatives clamp to `0`. Fails **open** (never pauses) when the sample is missing or non-finite. Pause counts surface on `GET /api/health` (`nonCriticalTimerPause.pausedTicksTotal`) and `/metrics` (`kookr_non_critical_timer_pauses_total`) without a secret env flag. |
| `KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS` | `5` | Non-negative integer, `0` disables | Consecutive dashboard-**snapshot** broadcasts (the `coordinator.snapshot` sibling frame and ordinary `update`/`alert`/`projectSummaries` deltas do NOT count toward this — only the periodic snapshot cadence does) a socket may sit above the soft `bufferedAmount` backpressure threshold (#1424) before it is disconnected outright (issue #1725). A socket that merely drains slowly resumes within a broadcast or two; one that stays over soft on every single snapshot broadcast is not draining at all and would otherwise sit forever silently missing every snapshot without ever tripping the (much higher) hard cap. A socket that drains before reaching this count gets a compact `wsBackpressureNotice(resyncNeeded)` frame instead of silently resuming, since it may have missed coalesced snapshots while skipped. `0` disables this specific mechanism (soft-skip-only, pre-#1725 semantics) — a mid-incident kill switch distinct from the always-on hard `bufferedAmount` cap. Invalid/blank/negative values fall back to the default. |
| `KOOKR_WS_LIVENESS_SWEEP_ENABLED` | `true` (enabled) | `1`/`true`/`on`/`yes` or `0`/`false`/`off`/`no` | Dead-socket ping/pong liveness reaping on the dashboard/terminal connection registry's existing revocation-sweep tick (issue #1725). Each tick, every registered socket that is already non-OPEN (stuck mid-close — the 227+ CLOSE-WAIT pileup in the 2026-07-31 incident) or that failed to `pong` a previous `ping` within one whole tick is `terminate()`d and dropped, independent of broadcast cadence — so a saturated event loop delaying a socket's own `close` handler cannot leave it registered (and still counted in fan-out) indefinitely. Set to a falsy value to opt out (rollback knob); invalid/blank values use the default. |
| `KOOKR_MAX_HOST_LOAD_PER_CPU` | `0` (disabled) | Non-negative number (load-per-core), `0` disables | CPU-aware task-admission threshold (issue #1630): the 1-minute host load average per logical CPU (`os.loadavg()[0] / os.cpus().length`) at/above which a `POST /api/tasks` launch is rejected with **HTTP 429** code `host_load_admission`, before any task record is created — so a burst of compile/test-heavy tasks cannot saturate the shared host and starve the supervisor event loop (`maxActiveTasks` bounds task *count*, not aggregate *CPU*). Complementary to the event-loop 503 gate (`KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS`, #1590): host load is a **leading** signal, event-loop lag the **lagging** one. Read once at startup. Unlike the depth 429s it can fire even below `maxActiveTasks`; schedule-fired launches are exempt. A sensible starting point on a busy shared host is ~0.9–1.0. Negative/blank/non-numeric values are treated as `0`. Fails **open** — a non-finite load sample or non-positive CPU count admits the launch. See [backpressure §6](./backpressure.md). |
| `KOOKR_MEMORY_LEDGER` | unset (disabled) | `1`/`true`/`yes`/`on` to enable | Opt-in periodic memory ledger (issue #1612). When enabled, logs a structured `[mem-ledger]` line carrying process memory (rss/heap/external/arrayBuffers, MB) plus per-subsystem retention counts (monitor windows, hook-ingestion buffers, hook-watcher read volume). A soak uses this to bisect the dominant RSS retainer with evidence: a flat heap while RSS climbs confirms allocator churn; the subsystem counts localize a retained leak. Off by default so it costs nothing in normal operation. See [production-server-service.md § Allocator Tuning (glibc)](production-server-service.md#allocator-tuning-glibc) for the glibc arena/trim knobs applied in response to exactly that finding (issue #1753). |
| `KOOKR_MEMORY_LEDGER_INTERVAL_MS` | `60000` | Integer `>= 1000` (milliseconds) | Cadence of the `KOOKR_MEMORY_LEDGER` line. Blank, non-finite, or sub-1000 values fall back to the 60s default. |
| `KOOKR_AUTO_REFLECT_DISABLE` | unset | `1` to disable | Kill switch for task-feedback reflection spawning. |
| `KOOKR_FINDING_REVIEW_ENABLED` | unset | `true` to enable | Enables local/admin finding-evidence review diagnostics. Required before manual model review or the background sampler can call the LLM. |
| `KOOKR_FINDING_TRANSCRIPT_CONTEXT` | unset | `true` or `1` to enable | Attaches the last assistant text message from the registered transcript JSONL to `needs_input` and `stale_agent` findings. Reads only a bounded transcript tail and leaves findings unchanged when unset. |
| `KOOKR_FINDING_REVIEW_DAILY_COST_CENTS` | `0` | Non-negative integer cents | Daily cost budget for finding-evidence model reviews. `0` keeps model calls disabled. |
| `KOOKR_FINDING_REVIEW_MAX_CANDIDATES` | `5` | Positive integer | Maximum candidates reviewed by one manual finding-evidence review request. |
| `KOOKR_FINDING_REVIEW_TIMEOUT_MS` | `15000` | Positive integer milliseconds | Timeout for each finding-evidence review model call. |
| `KOOKR_FINDING_REVIEW_TOKEN` | unset | Secret string | Optional CSRF token required in `x-kookr-finding-review-token` for finding-evidence review mutation routes. |
| `KOOKR_FINDING_REVIEW_ADMIN_TOKEN` | unset | Secret string | Optional bearer-style admin token accepted in `x-kookr-admin-token` for non-loopback finding-evidence diagnostics access. |
| `KOOKR_FINDING_REVIEW_SAMPLER_ENABLED` | unset | `true` to enable | Starts the M2 background sampler. It remains inert unless `KOOKR_FINDING_REVIEW_ENABLED=true`, an LLM provider is configured, and the daily cost budget is positive. |
| `KOOKR_FINDING_REVIEW_SAMPLER_INTERVAL_MS` | `900000` | Positive integer milliseconds | Background sampler interval. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MIN_AGE_MS` | `30000` | Non-negative integer milliseconds | Minimum candidate age before the sampler may enqueue it. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MIN_OBSERVATIONS` | `2` | Positive integer | Minimum observation count before the sampler may enqueue a candidate. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_INTERVAL` | `3` | Positive integer | Maximum queued candidates the sampler may attempt in one interval. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_DETECTOR` | `1` | Positive integer | Per-detector attempt cap for one sampler interval, preventing one noisy detector from consuming the interval. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MAX_TOKENS_PER_CANDIDATE` | `2000` | Positive integer tokens | Per-candidate estimated token cap before review. |
| `KOOKR_FINDING_REVIEW_SAMPLER_DAILY_TOKEN_BUDGET` | `20000` | Positive integer tokens | Daily token budget for background finding-evidence reviews. |
| `KOOKR_FINDING_REVIEW_SAMPLER_LEASE_MS` | `300000` | Positive integer milliseconds | Lease and stale lock window for sampler queue processing. |
| `KOOKR_FINDING_REVIEW_SAMPLER_MAX_ATTEMPTS` | `3` | Positive integer | Maximum review attempts before a queue entry becomes terminal. |
| `KOOKR_FINDING_REVIEW_SAMPLER_RETRY_BASE_MS` | `60000` | Positive integer milliseconds | Base delay for exponential retry backoff. |
| `KOOKR_FINDING_REVIEW_SAMPLER_CANDIDATE_READ_LIMIT` | `50` | Positive integer | Number of audit candidates read from the monitor per sampler pass. |

Disk-pressure sampling uses Node's filesystem statistics for the directory that
contains Kookr state. If the runtime does not support that API, or the data
directory cannot be read, Kookr reports the disk fields as `null` and marks the
sample unavailable. Operational alert rules fail open for missing samples: a
low-disk alert will not fire on absent data, and an already-firing alert will
not clear until a later readable sample shows recovery. Kookr does not
auto-prune or throttle writes; use `kookr maintenance prune --dry-run --dir <dataDir>`
to inspect conservative cleanup candidates.

## Hooks And Contribution Tracking

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_HOOKS_DIR` | `~/.kookr` | Directory path | Overrides where the stale-scout hook stores its contribution ledger and hook error log. |
| `KOOKR_TASK_ID` | unset outside Kookr-spawned sessions | Task id string | Lets hooks include the active Kookr task id in ledger or event payloads. |
| `KOOKR_API_BASE_URL` | `http://localhost:4800` in hook fallback paths | HTTP URL | Used by contribution-tracking hooks to POST events to the Kookr server. |

## Operational Risk

These variables intentionally remove safeguards or disable recovery/diagnostics.
Use them only for controlled local sessions.

| Variable | Risk |
| --- | --- |
| `KOOKR_BYPASS_ALL_PERMISSIONS=true` | Removes agent permission prompts. Claude Code gets `--dangerously-skip-permissions`; Codex CLI gets `--dangerously-bypass-approvals-and-sandbox`. |
| `KOOKR_BACKEND` set to anything except `dtach` | Prevents startup. Remove stale `KOOKR_BACKEND=tmux` entries instead of expecting rollback behavior. |
| `KOOKR_AUTO_RELAUNCH=false` | Disables crash recovery, so tasks that died while the server was down will not be resumed automatically. |
| `KOOKR_CONTEXT_ADVISORY_DISABLED=1` | Suppresses context-window advisories even if the feature is enabled. |
| `KOOKR_AUTO_REFLECT_DISABLE=1` | Suppresses feedback-reflection tasks that would otherwise analyze completed work. |
