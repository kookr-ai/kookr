# Production Server Service

Kookr ships a systemd user unit template for operators who want the production
server to start at login, survive host reboots with lingering enabled, and come
back after crashes. This is Linux/systemd only. macOS launchd support is out of
scope for this template.

The unit starts the server directly with `node dist/server/start.js`. It does
not run `pnpm prod:restart`, because that script has its own pid-file process
manager. When the unit is active, `scripts/prod-restart.sh` detects it and
delegates to `systemctl --user restart kookr.service` instead of killing the
port process itself.

## Install

Build or update the production worktree first:

```bash
pnpm prod:update
```

Install the user unit:

```bash
mkdir -p ~/.config/systemd/user ~/.config/kookr
cp deploy/server/kookr.service ~/.config/systemd/user/kookr.service
systemctl --user daemon-reload
systemctl --user enable --now kookr.service
```

The template assumes the production worktree is at `%h/git/kookr-prod`, which
matches the default `pnpm prod:setup` and `pnpm prod:update` layout. If your
production checkout lives somewhere else, edit `WorkingDirectory=` in
`~/.config/systemd/user/kookr.service` before enabling the unit.

Optional environment overrides can live in `~/.config/kookr/kookr.env`:

```bash
KOOKR_PORT=4800
KOOKR_HOST=127.0.0.1
```

Do not put shell syntax such as `export` in this file. systemd environment
files use `KEY=value` lines.

## Allocator Tuning (glibc)

The unit sets two glibc malloc knobs in the launch environment:

```ini
Environment=MALLOC_ARENA_MAX=2
Environment=MALLOC_TRIM_THRESHOLD_=131072
```

**Why.** On glibc (Linux, e.g. 2.35) the server RSS was observed to sawtooth
between roughly 2.3 GB and 4.1 GB, climbing toward the 4 GB old-space OOM
ceiling. Offline measurement (issue #1753) showed the resident task graph and
the other suspected structures account for only ~170 MB — ~7% of the ~2.6 GB
post-GC RSS floor. The rest is retained/fragmented allocator memory: glibc
spins up multiple per-thread arenas under allocation bursts (the snapshot-clone
churn) and does not return freed pages to the OS, so RSS ratchets up.

- `MALLOC_ARENA_MAX=2` caps the number of malloc arenas. Fewer arenas means less
  per-thread free-list fragmentation and is the biggest lever on the sawtooth
  amplitude. The Node.js default lets glibc create up to `8 × nproc` arenas.
- `MALLOC_TRIM_THRESHOLD_=131072` pins the trim threshold at 128 KiB, disabling
  glibc's dynamic growth of the top-pad. This makes `free()` return large freed
  blocks to the OS sooner, lowering the post-GC RSS floor.

These are read once at glibc initialization, so they must be present in the
process's launch environment — they cannot be applied at runtime. Both are
low-risk, fully reversible env knobs: remove the two lines and
`systemctl --user daemon-reload && systemctl --user restart kookr.service` to
revert. On the systemd path they can be overridden per-host by setting
`MALLOC_ARENA_MAX` / `MALLOC_TRIM_THRESHOLD_` in `~/.config/kookr/kookr.env`,
which `EnvironmentFile=` applies after these defaults. The
`scripts/prod-restart.sh` pid-file fallback path (used only when systemd is not
managing the unit) exports the same defaults for parity; there it honors any
value already present in the launching shell's environment rather than
`kookr.env`.

Verifying the effect without live-prod probing is limited: the `server.log`
ops-alerts sampler already records `process_rss`, so a before/after comparison
of the RSS floor and sawtooth peaks across a restart is the intended check.
Expected direction: a lower and flatter RSS floor. A native periodic
`malloc_trim(0)` (which needs a compiled addon) is tracked as an optional
follow-up, not part of this change.

## Watchdog (Hang Recovery)

The unit runs the server as a `Type=notify` service with a systemd watchdog
(issue #2491):

```ini
Type=notify
NotifyAccess=all
WatchdogSec=30
```

**Why.** The server is a bare `node` process. When its event loop wedges — a
runaway synchronous section, a deadlock — HTTP goes dark but the process stays
alive, so `Restart=on-failure` never fires: a hung server looks healthy to
systemd. Hang recovery has to live outside the event loop. The watchdog provides
exactly that. The server pings `WATCHDOG=1` from its liveness tick, which fires
every 5s, throttled to send at most once per half-deadline (~15s). The ping is
sent on every timer delivery — a delivered timer callback *is* the liveness
signal — independent of how long the tick's own work takes, so a slow-but-alive
tick never looks wedged. If the loop wedges it stops delivering timers, the pings
stop, and after `WatchdogSec` (30s) systemd kills the unit. A watchdog timeout
counts as a failure, so the existing `Restart=on-failure` restarts it.

`WatchdogSec=30` is deliberately generous — a long GC pause or a slow reconcile
must not bounce a healthy server. The ping cadence (deadline ÷ 2 = 15s) leaves
margin for a missed tick before the deadline is reached.

This is the layer below the [readiness probe](#readiness-probe-engine-not-relay):
`GET /api/ready` catches subsystems that fail while the loop still runs (a dead
schedule tick, a non-writable data dir); the watchdog catches the case a probe
cannot — a wedged event loop that can no longer answer HTTP at all.

**How the ping is sent.** `Type=notify` makes systemd export `NOTIFY_SOCKET`
(and `WATCHDOG_USEC`) into the service. The server sends the `READY=1` and
`WATCHDOG=1` datagrams via the `systemd-notify` helper, because Node core cannot
open the `AF_UNIX` `SOCK_DGRAM` socket sd_notify uses. That helper runs as a
child process, not the main PID, so `NotifyAccess=all` is required for systemd to
accept its notifications.

**No effect off systemd.** The notifier is inert unless `NOTIFY_SOCKET` is set.
Running the server directly (`node dist/server/start.js`) or through the
`scripts/prod-restart.sh` pid-file/nohup fallback sends no notifications and
behaves exactly as before — only the `Type=notify` unit arms the watchdog.

To tune the deadline per host, override it with a drop-in rather than editing the
template:

```bash
systemctl --user edit kookr.service
# [Service]
# WatchdogSec=60
```

## Start At Boot

User units normally start when the user logs in. To let the service start after
a reboot before an interactive login, enable lingering:

```bash
loginctl enable-linger "$USER"
systemctl --user enable --now kookr.service
```

On WSL2, systemd must also be enabled in `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

After changing `wsl.conf`, shut down and restart the distribution from Windows:

```powershell
wsl.exe --shutdown
```

## Operate

Check service state and logs:

```bash
systemctl --user status kookr.service
journalctl --user -u kookr.service -f
```

Restart through systemd when the unit is active:

```bash
systemctl --user restart kookr.service
```

`pnpm prod:update` remains the build-and-deploy command. After the build, its
restart step calls `scripts/prod-restart.sh`; when `kookr.service` is active,
the script delegates to the same `systemctl --user restart kookr.service`
command and waits for `/api/ready` (see below).

`pnpm prod:restart` behaves the same way. If the unit is inactive or systemd is
unavailable, the script falls back to the existing pid-file and port-kill
restart flow.

### Low-downtime redeploy

For intentional restarts, clocks (API blackout vs deploy-ready), client
contracts (spawn / signal / dashboard / schedules), and residual same-port
blackout after speech-detach P1, follow the operator runbook:

**[Low-downtime redeploy](../runbooks/low-downtime-redeploy.md)**

Summary: API blackout goals are **ideal &lt;1s / max &lt;5s** (port free → first
`/api/health` 200). Long M2 recovery does **not** mean the API is dark after
M1. Sequential stop/start on one port can still produce a multi-second blackout;
blue-green remains deferred (see the RFC linked from the runbook).

For short-lived runtime tuning without a restart, use the admin runtime-control
API documented in [API Reference](api.md#admin--runtime-control). It covers
temporary log-level changes with TTL auto-revert, operational alert threshold
updates, operational alert history, and drain/resume. Loopback requests are
trusted; non-loopback callers must pass normal owner API authentication and
provide `x-kookr-admin-token` matching `KOOKR_ADMIN_TOKEN`.

To return to script-managed operation:

```bash
systemctl --user disable --now kookr.service
pnpm prod:restart
```

## Readiness Probe (engine, not relay)

Process supervisors and deploy gates for the **engine** (this unit /
`node dist/server/start.js`) MUST probe:

```text
GET http://127.0.0.1:4800/api/ready
```

Do **not** point an engine supervisor at the detached relay readiness endpoint
(`GET /ready` on the relay process — historically also called `/readyz`). Relay
readiness only checks `dbReachable` + `emergencyDisabled` and has zero
visibility into the schedule-runner; a supervisor pointed there is false-green
when the scheduler tick dies (issue #1707 / #1699 WS0).

`GET /api/ready` returns:

- **200** `{ "ready": true, "checks": { … } }` when every *critical* subsystem
  is ready (startup complete, terminal backend not in `error`, not draining,
  persistence writable, schedule-runner tick fresh). Non-critical checks such
  as `hookIngestion` lag (issue #1870) or `schedulesPaused` (issue #2427)
  may report `ready:false` without changing the overall verdict or HTTP status.
- **503** `{ "ready": false, "checks": { … } }` when any critical check fails.
  The `schedulerTick` check (issue #1707) flips not-ready when
  `lastTickCompletedAt` is older than two schedule-runner tick intervals
  (~2 minutes at the default 60s cadence), so a dead tick loop is visible to a
  process supervisor within a couple of minutes.

`/api/health` remains a soft always-200 operator surface; do not use it as a
restart gate.

## When HTTP Is Dark (hang recovery)

`Restart=on-failure` in the unit **does not recover a hang.** It fires only when
the process *exits* with a failure status (a crash, an unhandled rejection that
kills the process, an OOM kill). A wedged server is different: the process is
still alive and still holding the listen socket, but its event loop no longer
makes progress, so nothing exits and systemd never restarts it. The malloc knobs
above reduce the OOM pressure that *causes* some crashes; they do nothing for a
loop that is stuck.

Do not begin hang triage with `curl .../api/health`. `/api/health` is a soft
surface: it returns `200` by design even while a *critical* subsystem is degraded
(that state is what `/api/ready` reports as `503`), and it is served from an
in-process stale-while-revalidate cache, so during partial degradation or the
moments before a loop fully wedges it can hand back a stale `200` from the cached
body. A green `/api/health` therefore does **not** prove the loop is healthy. (A
*fully* wedged single-threaded loop serves nothing at all — `/api/health`
included — so there the symptom is a timeout, not a green check; the cache cannot
heal a fully wedged loop, only the stampede-before-wedge window.) Start from the
process supervisor instead:

1. **Is the unit still "running"?** A hang looks `active (running)` here — that is
   the point. This step is only to rule out a plain crash-loop or a clean exit.

   ```bash
   systemctl --user status kookr.service
   journalctl --user -u kookr.service --since '-10min' --no-pager
   ```

2. **Probe the live readiness endpoint, with a timeout.** `/api/ready` is
   uncached and answered on the event loop, so a wedged loop cannot return it.
   The `--max-time` is what turns a hang into a detectable failure — without it
   `curl` blocks with the loop.

   ```bash
   curl -fsS --max-time 5 http://127.0.0.1:4800/api/ready
   ```

   - Times out / no response → HTTP is dark; the loop is wedged. Go to step 4.
   - `503` with a `checks` body → not a hang; a *critical* subsystem is down.
     Read the failing check and treat it as a normal degradation, not a wedge.
   - `200` → the loop is live; the symptom is elsewhere (client, network, a slow
     but not dead subsystem).

3. **Or let the doctor time it for you.** `kookr doctor` runs the same probe
   under a latency budget (`GET /api/ready` at 500 ms, then `GET /api/health` at
   2 s) and reports `ops.http-latency`; a timeout or multi-second response is the
   hung-HTTP signature.

   ```bash
   kookr doctor
   ```

4. **Recover a confirmed wedge.** `Restart=` will not do this for you — restart
   the unit by hand:

   ```bash
   systemctl --user restart kookr.service
   curl -fsS --max-time 5 http://127.0.0.1:4800/api/ready
   ```

   If even `systemctl --user restart` will not bring it down, escalate to
   `systemctl --user kill --signal=SIGKILL kookr.service` and let the unit start
   a fresh process.

**Reading the last-good state without touching HTTP.** The server writes a
durable ops card to `~/.kookr/ops-status.json` on every `ready → degraded`
transition (issue #1995). It is an on-disk file, so `cat` reads it even while the
loop is wedged and HTTP is dark — no request reaches the stuck event loop:

```bash
cat ~/.kookr/ops-status.json
```

It records a ring of the most recent critical edges — including the
`ready → degraded` transition and its operator-facing detail — plus fields
sampled at write time: serving SHA, hung-suspect count, data-directory free
space, and SAFE MODE status. That is what an operator (or Lucy over Discord)
needs to see when the server itself will not answer.

A companion on-disk surface is the **last-good `/api/health` snapshot**
(`~/.kookr/last-good-health.json`, issues #2495 / #2561): the server mirrors a redacted,
size-capped, owner-only (`0o600`) copy of the full health body after each successful assembly, so
unlike `ops-status.json`'s edge ring it carries the *whole* last-good body plus
an mtime. `kookr ops digest --offline` reads it directly — and a plain
`kookr ops digest` auto-degrades to it when HTTP is dark, printing how stale the
snapshot is instead of only reporting no-server:

```bash
kookr ops digest --offline
cat ~/.kookr/last-good-health.json
```

**Automating the restart.** The shipped unit turns a wedge into an automatic
restart: it runs `Type=notify` with `WatchdogSec=30` (issue #2491, see
[Watchdog (Hang Recovery)](#watchdog-hang-recovery)). The server pings systemd
from its event loop every ~15s, so a wedged loop misses the ping and systemd
kills and restarts the process on its own after 30s. Manual step 4 above is now
only for recovering *immediately* rather than waiting out the deadline, or for
hosts where the watchdog is unavailable (no `NOTIFY_SOCKET` — the pid-file/nohup
path, or a non-systemd host).

## Verify

After installing the unit, verify the basic lifecycle:

```bash
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/ready
systemctl --user kill --signal=SIGKILL kookr.service
sleep 10
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/ready
```

For reboot validation, reboot the host or restart WSL2, then check:

```bash
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/ready
```
