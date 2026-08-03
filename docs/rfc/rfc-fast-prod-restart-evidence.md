# Evidence pack — RFC: Fast production restart

**Status:** evidence to check, not settled fact. Critics should re-verify load-bearing claims against the cited sources.

**Assembled:** 2026-08-03  
**Revised:** 2026-08-03 (post round-1 — corrected deploy gate vs health; timeout; smoke)  
**Scope:** Why `pnpm prod:restart` / the restart half of `pnpm prod:update` feels like ~1 minute (or more), and which costs are speech vs recovery vs script.

**Tree under review:** worktree `kookr-rfc-fast-prod-restart` tracking `origin/main` (not an older feature branch). Round-1 critics found the first pack mixed an older mental model (`/api/health` gate, 720s timeout) with current main.

---

## Pipeline map (current `origin/main`)

```
pnpm prod:update
  └─ scripts/prod-update.sh
       ├─ git fetch / switch detach origin/main (kookr-prod)
       ├─ pnpm install
       ├─ pnpm build                         ← UPDATE cost (not restart downtime)
       └─ scripts/prod-restart.sh
            ├─ (optional) systemd: systemctl --user restart kookr.service
            └─ default path:
                 ├─ stop_existing_server()
                 │    └─ SIGTERM → createShutdownHandler (src/server/shutdown.ts)
                 │         ├─ lifecycleAc.abort()
                 │         ├─ sttManager.stop()  → docker compose down   (BLOCKS)
                 │         ├─ ttsManager.stop()  → docker compose down   (BLOCKS)
                 │         └─ server.close() → port frees → exit
                 ├─ start_server() → node dist/server/start.js
                 │    └─ main() (src/server/start.ts)
                 │         ├─ await startSTT() if KOOKR_STT && !KOOKR_STT_URL   (BLOCKS)
                 │         ├─ await startTTS() if KOOKR_TTS && !KOOKR_TTS_URL   (BLOCKS)
                 │         ├─ await createKookrServer(...)   (stores, reconcile, routes, …)
                 │         │    └─ listen → markListening
                 │         │    └─ deferred recovery phase (StartupReadiness)
                 │         └─ markReady when recovery complete
                 ├─ wait_for_health()  **name is historical**
                 │    └─ probe_ready_for_deploy(READY_URL=/api/ready)   ← DEPLOY GATE (#1721)
                 │         success: HTTP 200, OR HTTP 503 without body "startup-in-progress"
                 │         default timeout: 1800s (raised from 720 after ~727-task recovery)
                 ├─ run_post_restart_checks()  ready nag + relay drift (non-fatal)
                 └─ run_post_deploy_smoke()    default ON (KOOKR_POST_DEPLOY_SMOKE=1)
```

### Three different “restart” clocks (do not collapse)

| Metric | Probe | What it measures |
|---|---|---|
| **M1 Process liveness** | TCP accept / `GET /api/health` 200 | Node is serving something |
| **M2 Deploy ready** | `probe_ready_for_deploy` on `GET /api/ready` | Deferred recovery finished (or non-startup 503) — **what `pnpm prod:restart` waits on** |
| **M3 Speech warm** | container `StartedAt`/`Id` stable + optional `/api/health/stt|tts` | GPU speech stack not cold-started |

Script exit time ≈ time-to-M2 (+ smoke if enabled). Speech coupling inflates time-to-M1 (and thus M2) when containers are torn down. Recovery can inflate M2 even when M1 is already fast (issue #1721 listen-early).

### Ownership today

| Concern | Owner | Notes |
|---|---|---|
| Deploy orchestration | `scripts/prod-update.sh` | build + restart |
| Process stop/start/deploy gate | `scripts/prod-restart.sh` | gate = `/api/ready` via `probe_ready_for_deploy` |
| Graceful SIGTERM | `src/server/shutdown.ts` | **stops STT/TTS before** closing HTTP (race fix) |
| Bundled STT | `src/server/stt-manager.ts` | `up -d --build`; stop = `compose down` |
| Bundled TTS | `src/server/tts-manager.ts` | build-stamp aware `up`; stop = compose down |
| External speech | `start.ts` + env | `KOOKR_STT_URL` / `KOOKR_TTS_URL` skip managers |
| Startup readiness | `StartupReadiness` + diagnostics | `/api/ready` critical while `startup-in-progress` |
| Deferred recovery | `startup-recovery.ts` | after listen (already landed #1721) |

### Historical race

`shutdown.ts`: containers stopped **before** HTTP close so restart scripts cannot launch a new process that starts containers while the old process is still tearing them down.

---

## Telemetry / measurements

### A. Host samples (2026-08-03, speech-enabled maintainer prod)

Taken against live `kookr-prod` on port 4800 (and Docker sidecars). Approximate.

| Claim | Observation |
|---|---|
| Warm `/api/health` latency | order of hundreds of ms under load (samples ~340–430 ms; smoke under load up to ~1.6 s); ready samples ~44–316 ms when stable |
| Node entry graph load | ~400 ms (then EADDRINUSE when requiring start.js against live port) |
| SQLite count ~788 tasks | ~15 ms (36 MB `tasks.sqlite`) |
| Adapter `--version` | claude ~223 ms, codex ~25 ms, grok ~33 ms |
| Warm STT/TTS `/health` | ~1–3 ms each |
| Shell `compose up -d` while containers running | **Recreated** STT+TTS (~4s / ~3s wall for compose) |
| Post-recreate TTS ready | ~10 s |
| Post-recreate STT ready | **~122 s** to HTTP 200 |
| Last log shape (feat branch sample) | STT → TTS → adapters → tasks → listen → deferred recovery |
| Last shutdown shape | SIGTERM → stop STT → stop TTS → Server closed |

### B. Code facts on `origin/main` (re-verified round-1)

| Claim | Observation |
|---|---|
| Deploy gate | `probe_ready_for_deploy` against `READY_URL` (`/api/ready`), **not** `/api/health` |
| Gate success rules | 200 OK, or 503 **without** `startup-in-progress` in body |
| Startup timeout default | **1800 s** (`KOOKR_STARTUP_TIMEOUT_SECONDS`) — comment cites multi-minute recovery on ~727 tasks racing old 720s default |
| Health poll interval default | `KOOKR_STARTUP_CHECK_INTERVAL_SECONDS` default **2** |
| Post-deploy smoke | **on by default** (`KOOKR_POST_DEPLOY_SMOKE` default 1) after gate |
| Listen vs recovery | Recovery is **after** listen; speech still **before** `createKookrServer` |
| `prod:stop` script | **Does not exist** in package.json (only restart/update/logs) |

### C. Live STT health shape (2026-08-03, Whisper path) — critical for reuse predicate

```json
{"status":"ok","model_loaded":false,"model_name":"parakeet-tdt-0.6b-v3","backend":"whisper","device":"gpu","runtime_backend":"wasm","runtime_device":"cpu",...}
```

Implication: `model_name` is Parakeet `MODEL_VERSION`, not `WHISPER_MODEL`; `model_loaded` is false while speech is healthy. Any reuse rule requiring `model_loaded` or `model_name === WHISPER_MODEL` is **wrong** for this stack.

### D. Explicit gaps (not yet measured on main)

- Full instrumented `pnpm prod:restart` wall clock broken into: SIGTERM→port free, process start→listen, listen→ready, ready→smoke end.
- Recovery duration on current task corpus after a warm restart with speech already detached (hypothetical P1).
- Restart with `KOOKR_STT_URL`+`KOOKR_TTS_URL` (control: no compose) for residual floor.
- macOS timings.

---

## Source pointers

| Claim | Path |
|---|---|
| Update = install + build + restart | `scripts/prod-update.sh` |
| Deploy gate = ready probe | `scripts/prod-restart.sh` — `probe_ready_for_deploy`, `wait_for_health` (~L324–430) |
| Timeout 1800 + recovery comment | `scripts/prod-restart.sh` ~L21–24 |
| Smoke after gate | `scripts/prod-restart.sh` `run_post_deploy_smoke` |
| Stop containers before HTTP close | `src/server/shutdown.ts` L56–65 |
| STT/TTS before server | `src/server/start.ts` STT/TTS block before `createKookrServer` |
| STT always `--build` | `src/server/stt-manager.ts` `up -d --build` |
| STT/TTS stop = compose down | managers `stop*` helpers |
| External URL skip | `start.ts` + `docs/reference/environment-variables.md` |

---

## Load-bearing implications (for design)

1. **Speech detach+reuse** can make **M1** fast and remove multi-minute GPU cold starts from the critical path.
2. **M2 can still be multi-minute** after speech is fixed if deferred recovery dominates — that is a **separate** problem from this RFC’s core coupling fix, and must not be silently claimed as “solved by sidecars.”
3. Operators experience **script exit** (M2 + smoke), not a manual health curl. Success criteria must name which clock.
4. `compose up` is **not** free even without `--build` when it recreates.
