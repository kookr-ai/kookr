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
  as `hookIngestion` lag (issue #1870) may report `ready:false` without
  changing the overall verdict or HTTP status.
- **503** `{ "ready": false, "checks": { … } }` when any critical check fails.
  The `schedulerTick` check (issue #1707) flips not-ready when
  `lastTickCompletedAt` is older than two schedule-runner tick intervals
  (~2 minutes at the default 60s cadence), so a dead tick loop is visible to a
  process supervisor within a couple of minutes.

`/api/health` remains a soft always-200 operator surface; do not use it as a
restart gate.

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
