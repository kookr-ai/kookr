# API Blackout Probe

Operator recipe for measuring how long the production-style Kookr API is
unreachable during an intentional restart (`pnpm prod:restart` /
`pnpm prod:update`).

## Why

Redeploys briefly drop the HTTP listener. Without a local measurement recipe,
the **ideal <1s / max <5s** claim is not operator-verifiable, and
orchestrators can treat planned restarts as outages. Backend literature often
probes downtime at **~10ms** intervals; this recipe matches that cadence.

This probe is **measurement-only**. Absolute times are machine-dependent
(host load, speech cold-start, systemd vs script path). Do **not** gate CI on
`blackout_ms` unless a check is explicitly marked optional.

## Built-in metric vs external probe

| Source | What it measures | When |
| --- | --- | --- |
| `pnpm prod:restart` stderr (`apiBlackoutSeconds`) | Port free → first `/api/health` 200 | Every restart (issue #1972) |
| `GET /api/deploy/status` → `lastRestart.apiBlackoutSeconds` | Same, persisted | After a successful restart |
| **`scripts/measure-api-blackout.sh`** (this doc) | Independent 10ms curl loop of `/api/health` | On demand, from a second terminal |

Use the external probe when you want a second opinion, a higher sample rate than
the restart script's phase timers, or a measurement while something other than
`prod-restart.sh` recycles the process (manual kill, systemd restart).

## Quick start

Two terminals from the **dev checkout** (the tree that owns `scripts/` and
`pnpm prod:*`):

```bash
# Terminal A — start the probe first (exits after one blackout)
scripts/measure-api-blackout.sh --once

# Terminal B — restart the production-style instance
pnpm prod:restart
```

Example output on Terminal A:

```text
# measure-api-blackout: probing http://127.0.0.1:4800/api/health every 10ms
# targets: ideal <1000ms, max <5000ms (not CI gates)
# start a restart in another terminal (e.g. pnpm prod:restart)
# DOWN at 1722700000123 (was up)
blackout_ms=842  down_at_ms=1722700000123  up_at_ms=1722700001965
# done: 1 blackout event(s)
```

Interpret:

- **ideal:** `blackout_ms` < 1000
- **max (SLO):** `blackout_ms` < 5000
- Values above 5000 print a non-fatal `# WARN` on stderr (same spirit as
  `prod-restart.sh`).

## Script reference

```bash
scripts/measure-api-blackout.sh --help
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--url URL` | `http://127.0.0.1:${KOOKR_PORT:-4800}/api/health` | Probe target |
| `--interval-ms N` | `10` | Sleep between probes |
| `--timeout-s N` | `0` (unlimited) | Wall-clock stop |
| `--max-events N` | `0` (unlimited) | Stop after N blackouts |
| `--once` | off | Same as `--max-events 1` |
| `--fail-threshold N` | `2` | Consecutive failed probes before counting DOWN (debounce) |
| `-h`, `--help` | — | Usage text |

Machine-readable result lines:

```text
blackout_ms=<int>  down_at_ms=<epoch_ms>  up_at_ms=<epoch_ms>
```

## What counts as blackout

The probe treats the API as **up** when `curl -fsS` against `/api/health`
succeeds (HTTP 2xx). Connection refused, timeout, or HTTP error ⇒ **down**.

Notes:

- **Drain mode** still serves `/api/health` with 200 while the process is
  alive; blackout is only the window after the listener is gone.
- This is **liveness**, not full readiness. `prod-restart` also waits for
  `/api/ready` (M2) and smoke; those phases are separate from API blackout.
- Default production-style port is **4800**. Override with `KOOKR_PORT` or
  `--url`.

## Related

- `pnpm prod:restart` / `pnpm prod:update` — operator restart entrypoints
- [Troubleshooting — production-style restart metrics](../troubleshooting.md#production-style-instance-looks-stale)
- [API — `GET /api/deploy/status` `lastRestart`](api.md)
- [Production server systemd unit](production-server-service.md)
- Issues: #1984 (this recipe), #1972 (built-in `apiBlackoutSeconds`), #1721
  (listen-early + ready gate)
