# Kookr Environment Variables

This is the canonical reference for `KOOKR_*` variables read or injected by
Kookr at runtime. For a starter local configuration, copy `.env.example` and
uncomment only the values you need.

## Server And Data

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_PORT` | `4800` | Integer port, 1-65535 | HTTP and WebSocket port. Also selects the data directory: `~/.kookr` on port 4800, `~/.kookr-<port>` on other ports. |
| `KOOKR_HOST` | `127.0.0.1` | Hostname or IP address | Bind address for the HTTP/WebSocket server. Binding to a non-loopback host (a LAN IP or `0.0.0.0`) activates the API-token gate below. |
| `KOOKR_API_TOKEN` | unset | Secret string | Bearer token required on **every** API request (including GETs) and WebSocket upgrades **when `KOOKR_HOST` is non-loopback**. Loopback binds (`127.0.0.1`/`::1`/`localhost`) ignore it and stay token-free. Non-browser clients (the `kookr spawn` / `kookr status` CLIs) send it as `Authorization: Bearer <token>` and read it from the process environment (so it must be **exported** in the shell — they do not load `.env`). The browser dashboard authenticates differently: it exchanges a one-time token (carried in the share/handoff URL **fragment**, `#token=<token>`) for an `HttpOnly` session cookie via `POST /api/auth/session`, and the cookie then rides automatically on HTTP fetches and the WebSocket handshake (no token in any WS URL — the legacy `?token=` query parameter was removed). This closed issue #708. If a non-loopback bind has no token and `KOOKR_ALLOW_NON_LOOPBACK=true`, one is auto-generated and printed at startup. |
| `KOOKR_ALLOW_NON_LOOPBACK` | unset | `true` to enable | Explicit opt-out of the non-loopback fail-closed guard. When `KOOKR_HOST` is non-loopback and `KOOKR_API_TOKEN` is unset: `true` auto-generates an API token (printed at startup) and enforces it; unset/other refuses to start. Has no effect on a loopback bind. |
| `KOOKR_TRUSTED_TUNNEL` | unset | `true` to assert | Operator assertion that a non-loopback bind sits behind a mesh-encrypted tunnel (Tailscale / WireGuard). The browser session cookie is `Secure` only over HTTPS; a `Secure` cookie is never sent over plain HTTP, so on a non-loopback **plain-HTTP** bind the cookie exchange (`POST /api/auth/session`) is **refused** unless `KOOKR_TRUSTED_TUNNEL=true`, in which case a non-`Secure` cookie is issued over the asserted tunnel. Prefer fronting the dashboard with HTTPS (e.g. **Tailscale Serve**), which keeps `Secure` on and needs no flag. **Trusted, not validated** — do not set it on a routable public bind; doing so would ship a non-`Secure` cookie on an unencrypted path. Has no effect on a loopback bind. See [Read-Only Shared View Setup](shared-view-setup.md). |
| `KOOKR_REQUEST_BODY_LIMIT_BYTES` | `1000000` | Positive integer bytes | Maximum JSON request body size accepted by the dashboard server API routes. Oversized requests return HTTP 413 before route handlers parse the body. |
| `KOOKR_DEV_HOST` | unset (Vite dev server binds dual-stack) | Hostname or IP address | Bind address for the Vite frontend dev server (`pnpm dev`, `pnpm dev:frontend`). Default leaves Vite reachable on both `127.0.0.1:5173` and `[::1]:5173`. Set to `0.0.0.0` for LAN access, or to a specific IP to restrict the bind. |
| `KOOKR_HEALTH_URL` | `http://127.0.0.1:${KOOKR_PORT}/api/health` | HTTP URL | Health endpoint used by `scripts/prod-restart.sh` while waiting for startup. |
| `KOOKR_STARTUP_TIMEOUT_SECONDS` | `720` | Positive integer seconds | Maximum wait for production restart health checks. |
| `KOOKR_STARTUP_CHECK_INTERVAL_SECONDS` | `2` | Positive integer seconds | Poll interval for production restart health checks. |
| `KOOKR_PROD_DIR` | Auto-resolved `../kookr-prod` | Absolute or relative path | Overrides the production worktree used by `scripts/prod-update.sh` and deployment routes. |
| `KOOKR_ENV_ROOT_DIR` | Auto-resolved Kookr main checkout when `prod-update.sh` runs from `kookr-prod`; otherwise current checkout | Absolute or relative path | Overrides the checkout whose `.env` is symlinked into the production worktree by `scripts/prod-update.sh`. |

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
| `KOOKR_PLUGIN_DIR` | Auto-resolved `<kookr>/plugin` | Absolute or relative path, or empty string | Overrides the toolkit plugin directory injected into spawned Claude Code sessions. Set to an empty string to disable injection. |
| `KOOKR_BYPASS_ALL_PERMISSIONS` | unset | `true` to enable | Launches spawned agents with permission-bypass flags. See "Operational Risk" below before enabling. |

## Kookr-Injected Agent Context

These variables are written into spawned agent environments. They are normally
not user configuration knobs.

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_TASK_ID` | Injected per task | Task id string | Identifies the current Kookr task. Hooks and child-task workflows use it for correlation. |
| `KOOKR_PARENT_TASK_ID` | Injected only for child tasks | Task id string | Identifies the parent task for nested agent work. |
| `KOOKR_API_BASE_URL` | `http://127.0.0.1:<server port>` when known | HTTP URL | Lets agents and CLIs call back to the active Kookr instance. |
| `KOOKR_GIT_COMMON_DIR` | Injected when cwd is a Git worktree | Absolute path | Points at the shared Git common directory for worktree-aware workflows. |

## CLI Tools

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_API_BASE_URL` | Auto-detect 4800/4801 when unset | HTTP URL | `kookr spawn` and `kookr ralph` use this URL directly and skip port probing. |
| `KOOKR_PORT` | Auto-detect 4800/4801 for CLI tools | Integer port, 1-65535 | Forces `kookr status`, `kookr spawn`, or `kookr ralph` to talk to one local instance. |
| `KOOKR_SPAWN_MAX_PROMPT_BYTES` | `1048576` | Positive integer bytes | Maximum prompt size accepted from `kookr spawn` stdin or `--prompt-file`. |
| `KOOKR_SPAWN_CONNECT_RETRIES` | `3` | Integer `1` through `10` | Number of `kookr spawn` connectivity sweeps before reporting no server. |

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

## Recovery And Scheduling

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_AUTO_RELAUNCH` | enabled | `false` to disable | Disables startup crash recovery and automatic relaunch/resume of tasks marked completed by reconciliation. |
| `KOOKR_AUTO_CATCHUP` | unset | Any non-empty value | Opts in to automatic schedule catch-up on scheduler startup. By default, missed startup runs are recorded in the execution ledger and can be launched manually with Run Now. |
| `KOOKR_NO_CATCHUP` | unset | Any non-empty value | Legacy kill switch for startup catch-up. Takes precedence over `KOOKR_AUTO_CATCHUP`; future cron ticks still run. |

## Context Window

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_CONTEXT_ADVISORY_ENABLED` | unset | `1` to enable | Enables context-window hook advisories. |
| `KOOKR_CONTEXT_ADVISORY_DISABLED` | unset | `1` to disable | Kill switch for context-window hook advisories. Takes precedence over enablement. |

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
| `KOOKR_LLM_PROVIDER` | `auto` | `openrouter`, `requesty`, `groq`, `gemini`, `anthropic`, `auto` | Selects the LLM provider. `auto` chains every configured provider for fallback in order `GROQ > GEMINI > ANTHROPIC > OPENROUTER`; Requesty is explicit-only and is not included in `auto`. An explicit value uses only that provider. An unrecognized value warns and falls back to `auto`. |
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
| `KOOKR_REMOTE_CHAT_DASHBOARD_URL` | unset | HTTP or HTTPS origin, e.g. `https://kookr.example.com` | Overrides the dashboard URL used in Telegram spawn confirmations and permission block alerts. Set this when Telegram links must open from a phone. When unset, Kookr derives a local URL from `KOOKR_HOST`/`KOOKR_PORT` and warns if the server binds `0.0.0.0` because the fallback becomes `http://localhost:<port>`. |
| `KOOKR_REMOTE_CHAT_DISABLED` | unset | `1` to disable | Panic switch for the Telegram remote-chat integration. Takes precedence over the bot token. |
| `KOOKR_TELEGRAM_API_URL` | Telegram API default | HTTP URL | Overrides the Telegram API base URL. Used by tests and local fakes. |
| `KOOKR_STT_WHISPER_URL` | unset | HTTP URL of the local faster-whisper-server (e.g. `http://127.0.0.1:8010`) | Enables Telegram audio transcription for voice, uploaded audio, video notes, and audio documents. When unset, audio messages are dropped with the `dropped_audio_disabled` audit kind and the user is told audio is unsupported. The server must expose the OpenAI-compatible `POST /v1/audio/transcriptions` endpoint and is reached over plain HTTP — bind it to localhost only. |

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
| `KOOKR_RELAY_PUBLIC_ORIGIN` | unset | HTTPS URL | Public relay origin used by self-hosted deployments and health/operator docs. |
| `KOOKR_RELAY_STATE_DB_PATH` | `relay-state.sqlite` for the standalone relay binary | SQLite file path | Enables durable relay state for node registrations, hashed node tokens, invitations, share verifiers, and per-share lockout counters. |
| `KOOKR_RELAY_REQUEST_BODY_LIMIT_BYTES` | `1000000` | Positive integer bytes | Maximum JSON request body size accepted by the relay. |
| `KOOKR_RELAY_METADATA_RETENTION_DAYS` | `30` | Positive integer days | Self-hosted relay metadata retention setting; keep aligned with backup/ops policy. |
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

## Diagnostics And Budgeting

| Variable | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `KOOKR_BUDGET_WARN_USD` | `25` | Number in USD, `0` disables | Per-task reactive token-cost warning threshold. Critical alerts fire at twice this value. Invalid or blank values use the default. |
| `KOOKR_ALERT_CPU_PERCENT` | `0` (disabled) | Non-negative number (percent), `0` disables | Host CPU usage threshold for operational alerts on the already-sampled resource feed. Fires one `warning` alert when CPU stays at or above this for `KOOKR_ALERT_SUSTAIN_SAMPLES` consecutive samples, and one `info` alert on recovery. Negative or invalid values are treated as `0`. |
| `KOOKR_ALERT_MEMORY_PERCENT` | `0` (disabled) | Non-negative number (percent), `0` disables | Host memory-used threshold for operational alerts, evaluated like `KOOKR_ALERT_CPU_PERCENT`. |
| `KOOKR_ALERT_EVENT_LOOP_DELAY_MS` | `0` (disabled) | Non-negative number (milliseconds), `0` disables | Server event-loop delay (p95) threshold for operational alerts, evaluated like `KOOKR_ALERT_CPU_PERCENT`. |
| `KOOKR_ALERT_SUSTAIN_SAMPLES` | `3` | Integer `>= 1` | Consecutive breaching resource samples required before any operational alert fires (edge-triggered; clears on the first sample back below threshold). Samples are taken roughly every 2 seconds. Invalid or blank values use the default. |
| `KOOKR_AUTO_REFLECT_DISABLE` | unset | `1` to disable | Kill switch for task-feedback reflection spawning. |
| `KOOKR_FINDING_REVIEW_ENABLED` | unset | `true` to enable | Enables local/admin finding-evidence review diagnostics. Required before manual model review or the background sampler can call the LLM. |
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
