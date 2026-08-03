# Operator offline recovery card

Short checklist for host-class failures when you return to a machine running unattended Kookr (or only have brief SSH / Discord). Commands assume the production-style instance on port `4800` (`../kookr-prod` / `pnpm prod:*`). Adjust `KOOKR_PORT` / base URL if yours differs.

## 1. Process supervisors: ready, not just health

`/api/health` is dashboard-friendly (often 200 even when degraded). Engine supervisors should use **`/api/ready`**.

```bash
# Expect HTTP 200 when the engine is safe to supervise launches
curl -sS -o /tmp/kookr-ready.json -w '%{http_code}\n' http://127.0.0.1:4800/api/ready
python3 -m json.tool /tmp/kookr-ready.json | head -80

# Full health snapshot (capacity, resourceWatchdog, hungSuspect, …)
curl -sS http://127.0.0.1:4800/api/health | python3 -m json.tool | head -120
```

If `/api/ready` fails: fix the failing subsystem named in the body (scheduler tick, persistence writability, terminal backend, etc.), then re-probe. Do not assume “dashboard loads” means ready.

## 2. Disk free (data directory)

ENOSPC under `~/.kookr` (or `KOOKR_DIR`) kills launches and JSONL writers.

```bash
# Default data dir
df -h ~/.kookr
du -sh ~/.kookr/* 2>/dev/null | sort -h | tail -20

# Health may surface disk / data-directory alerts when the resource sampler is on
curl -sS http://127.0.0.1:4800/api/health \
  | python3 -c 'import json,sys; h=json.load(sys.stdin); print({k:h.get(k) for k in h if "disk" in k.lower() or "resource" in k.lower() or "alert" in k.lower()})'
```

If free space is critical: stop new launches (`kookr drain` if available), prune hooks/transcripts via maintenance, rotate `~/.kookr/server.log`, free unrelated disk, then resume.

## 3. hungSuspect residual (capacity waste)

Slots held by hung-suspect tasks block the active-task cap.

```bash
curl -sS http://127.0.0.1:4800/api/health | python3 -c '
import json,sys
h=json.load(sys.stdin)
cap=h.get("capacity") or {}
print("capacity", cap)
print("hungSuspectCapacityFinding", h.get("hungSuspectCapacityFinding"))
print("hungSuspectTtlReclaim", h.get("hungSuspectTtlReclaim"))
'

# Per-task view (dashboard or API)
curl -sS http://127.0.0.1:4800/api/tasks | python3 -c '
import json,sys
tasks=json.load(sys.stdin)
print("inProgress", sum(1 for t in tasks if t.get("status")=="inProgress"))
'
```

If residual stays high after TTL reclaim windows: complete or cancel clearly dead tasks, check Discord/operator signals for `hung:residual` (when enabled), avoid spawning more work until free slots return.

## 4. Resource watchdog env

When the resource watchdog is disabled, host pressure (CPU/mem) may not gate launches.

```bash
# Doctor should WARN when the watchdog is off (issue #1988)
kookr doctor --json 2>/dev/null | python3 -m json.tool | head -80
# or from a checkout:
# pnpm run doctor

curl -sS http://127.0.0.1:4800/api/health | python3 -c '
import json,sys
h=json.load(sys.stdin)
print("resourceWatchdog", h.get("resourceWatchdog"))
'
```

Re-enable per current env docs (`docs/reference/environment-variables.md` — resource watchdog keys). Restart the prod instance after changing env: `pnpm prod:restart` from the main checkout (with changes deployed), or your systemd unit.

## 5. Discord webhook smoke test

If remote paging is configured, verify the webhook still works (operator offline recovery often depends on it).

```bash
# Prefer the project’s documented signal path when present:
kookr signal --help 2>/dev/null | head -40

# Manual webhook POST only if you know the URL from your private env
# (never commit webhook URLs). Example shape:
# curl -sS -X POST "$DISCORD_WEBHOOK_URL" \
#   -H 'Content-Type: application/json' \
#   -d '{"content":"kookr offline-recovery card smoke test"}'
```

Confirm you receive the message in the ops channel. If silent: check env vars, Discord app permissions, and recent operational-alert sink logs under `~/.kookr/`.

## 6. When to reboot the host

Reboot only after the card above fails to restore a **ready** engine and you still see:

- kernel OOM / unrecoverable disk full at root filesystem
- unkillable stuck process trees owning ports 4800/dtach sockets after `pnpm prod:restart` / `kookr drain` + stop
- hardware/NIC failures (no SSH stability)

Prefer: drain → stop server cleanly → free disk → restart prod worktree → ready probe → only then reboot.

```bash
# Low-downtime-ish restart path (prod worktree)
cd ~/git/kookr && pnpm prod:restart
# then
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4800/api/ready
```

## Related

- Deploy / blackout probe recipe: [api-blackout-probe.md](./api-blackout-probe.md) (when present)
- Health fields and capacity: `GET /api/health`, `GET /api/ready`
- Resource watchdog / doctor: `kookr doctor`, env reference
- RFC: remote autonomy & operational resilience (tracking issue / RFC in `docs/rfc/`)
