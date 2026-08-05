# Unattended recovery runbook

Operator map from **symptom → health field → action** when Kookr runs unattended
and Discord (or any remote page channel) is the only contact path. Complements
the short host checklist in [offline-recovery-card.md](./offline-recovery-card.md).

**Portable base URL.** Set once; every example below uses it (no hardcoded host
or secrets):

```bash
export KOOKR_API_BASE_URL="${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}"
# Data dir for on-disk artifacts (prod default; override if KOOKR_DIR is set)
export KOOKR_DIR="${KOOKR_DIR:-$HOME/.kookr}"
```

Always prefer **`GET /api/ready`** for "is the engine safe to supervise?" —
`GET /api/health` is usually HTTP 200 even when individual blocks are degraded
or alerting.

```bash
curl -sS -o /tmp/kookr-ready.json -w 'ready HTTP %{http_code}\n' \
  "$KOOKR_API_BASE_URL/api/ready"
curl -sS -o /tmp/kookr-health.json -w 'health HTTP %{http_code}\n' \
  "$KOOKR_API_BASE_URL/api/health"
```

---

## Symptom → field → action (quick matrix)

| Symptom | Health / artifact field | First action |
| --- | --- | --- |
| Schedules / autonomous spawns stopped; manual launches still work | `safeMode.engaged` | Confirm intentional; **disengage** when incident over (see [SAFE MODE](#1-safe-mode-engage--disengage)) |
| Need to stop schedule fires during an incident | `safeMode.engaged == false` | **Engage** SAFE MODE via settings (not drain — drain blocks *all* launches) |
| New launches HTTP **503** with `data_directory_disk_critical` | admission / free space under `KOOKR_DIR` | Free disk; reclaim/reap still allowed; see [disk-critical](#2-disk-critical-admission) |
| Active cap full; little free capacity while agents look idle | `capacity.byClass.hungSuspect` | Read `hungSuspectTtlReclaim`; wait TTL or cancel dead tasks — [hung residual](#3-hung-residual) |
| Active cap full; many completion_ready holds, oldest FAA age large | `capacity.byClass.finishedAwaitingAck` | Read `finishedAwaitingAckTtlReclaim` skip reasons (#2084); Discord may page `faa:residual` (#2077) — [hung residual](#3-hung-residual) (FAA sibling) |
| Multi-hour / multi-day "prod smoke" paging or artifact stuck in alert | `prodSmokeTick` (+ on-disk alert JSON) | **Symptom only** — inspect fields; do not re-run smoke on the health path — [smoke tick](#4-prod-smoke-tick-symptom-only) |
| Host pressure (dtach orphans, swap) with no auto-investigation | `resourceWatchdog.enabled == false` | Enable `KOOKR_RESOURCE_WATCHDOG=1` and restart — [resource watchdog](#5-enable-resource-watchdog) |
| Ready fails after restart | `GET /api/ready` body `checks` | Fix named subsystem, then re-probe (offline card §1) |
| Discord silent after a real edge | `~/.kookr/ops-status.json` | Read durable card (no secrets); fix webhook later — [offline card](./offline-recovery-card.md) §5 |

Stable field names only — avoid inventing aliases. When a block is **omitted**
from `/api/health`, treat it as disabled / unavailable for that build or env.

---

## 1. SAFE MODE (engage / disengage)

**What it is.** Settings kill-switch (`automationKillSwitch`). When engaged,
**autonomous** actuation is halted (schedule fires / schedule-sourced launches).
Manual launches (API / UI / CLI / websocket / remote) remain accepted. Distinct
from **drain mode** (`kookr drain`), which refuses *all* new launches.

**Health field:**

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
print("safeMode", h.get("safeMode"))
PY
```

Shape: `{ "engaged": false }` or `{ "engaged": true, "since": "<ISO>" }`.

**On-disk companion:** edge-triggered `ops-status.json` records `safe_mode_engage`
(issue #1995) plus `smoke_tick_fire` / `smoke_tick_clear` (issue #2032; fire
detail = failingChecks names only). Read-only fields only:

```bash
python3 -m json.tool "${KOOKR_DIR}/ops-status.json" 2>/dev/null | head -80
```

### Engage

`PUT /api/settings` validates a **full settings document**. Read-modify-write:

```bash
curl -fsS "$KOOKR_API_BASE_URL/api/settings" -o /tmp/kookr-settings.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/tmp/kookr-settings.json")
s = json.loads(p.read_text())
# Drop response-only keys that are not settings fields
for k in ("loadedFromDefaults", "warnings"):
    s.pop(k, None)
s["automationKillSwitch"] = True
p.write_text(json.dumps(s))
PY
curl -fsS -X PUT "$KOOKR_API_BASE_URL/api/settings" \
  -H 'Content-Type: application/json' \
  -H 'X-Kookr-Actor: operator' \
  --data-binary @/tmp/kookr-settings.json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); print({k:s.get(k) for k in ("automationKillSwitch","safeModeSince")})'
```

Expect `automationKillSwitch: true` and a non-null `safeModeSince`. Confirm:

```bash
curl -fsS "$KOOKR_API_BASE_URL/api/health" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("safeMode"))'
```

### Disengage

Same read-modify-write with `automationKillSwitch: false` (server clears
`safeModeSince`):

```bash
curl -fsS "$KOOKR_API_BASE_URL/api/settings" -o /tmp/kookr-settings.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/tmp/kookr-settings.json")
s = json.loads(p.read_text())
for k in ("loadedFromDefaults", "warnings"):
    s.pop(k, None)
s["automationKillSwitch"] = False
p.write_text(json.dumps(s))
PY
curl -fsS -X PUT "$KOOKR_API_BASE_URL/api/settings" \
  -H 'Content-Type: application/json' \
  -H 'X-Kookr-Actor: operator' \
  --data-binary @/tmp/kookr-settings.json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); print({k:s.get(k) for k in ("automationKillSwitch","safeModeSince")})'
```

Expect `safeMode: { engaged: false }` on the next health probe.

**Do not** set `safeModeSince` by hand — the server owns transition bookkeeping.

---

## 2. Disk-critical admission

**Symptom.** `POST /api/tasks` returns **HTTP 503** with
`code` / `reason` **`data_directory_disk_critical`** (and usually `Retry-After`).
Reclaim / reap / soft-terminate paths stay open — only **new** task creation is
shed (issue #1992).

**Related knobs** (see [environment-variables.md](./environment-variables.md)):

| Env | Role |
| --- | --- |
| `KOOKR_ALERT_DATA_DIR_FREE_PERCENT` / `_BYTES` | Alert floors (default percent floor `5`) |
| `KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT` / `_BYTES` | Optional admission overrides (else reuse alert floors) |
| `KOOKR_ADMISSION_DATA_DIR_SUSTAIN_SAMPLES` | Consecutive low samples before shed |
| Both floors at `0` | Disables disk admission |

**Actions:**

```bash
df -h "$KOOKR_DIR"
du -sh "$KOOKR_DIR"/* 2>/dev/null | sort -h | tail -20

# Optional: host free-space sample when the resource sampler is on
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
# Prefer stable top-level keys; resource samples may also live under nested host blocks
keys=[k for k in h if "disk" in k.lower() or "resource" in k.lower()]
print({k:h.get(k) for k in keys})
print("resourceWatchdog", h.get("resourceWatchdog"))
PY
```

1. Stop adding work if needed (`kookr drain` for *all* launches, or SAFE MODE for
   schedules only).
2. Free space under `$KOOKR_DIR` (old hooks/transcripts, rotated `server.log`,
   stale worktrees via dashboard/sweep — never delete foreign paths blindly).
3. Re-try a benign spawn or wait for sustain samples to clear; admission fails
   **open** when disk samples are missing.

Full admission semantics: [backpressure.md](./backpressure.md) §5b.

---

## 3. Hung residual

**Symptom.** Capacity feels full while little real work runs:
`capacity.byClass.hungSuspect` stays high; Discord may page `hung:residual`
after a reclaim window (issue #1993). Sibling: high
`capacity.byClass.finishedAwaitingAck` may page `faa:residual` after a
reclaim window (issue #2077) — page-only, no extra force-completes.

**Health fields:**

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
cap=h.get("capacity") or {}
print("capacity.byClass", cap.get("byClass"))
print("capacity.free", cap.get("free"), "active", cap.get("active"))
print("hungSuspectTtlReclaim", h.get("hungSuspectTtlReclaim"))
print("hungSuspectCapacityFinding", h.get("hungSuspectCapacityFinding"))
print("finishedAwaitingAckTtlReclaim", h.get("finishedAwaitingAckTtlReclaim"))
PY
```

**Actions (ordered):**

1. **Read TTL reclaim counters** before force-killing tasks. After a restart,
   `reclaimedTotal=0` with dominant `skippedUnderTtl` is **expected** until
   multi-channel silence ages past `hungSuspectTtlMinutes` (default 25m). See
   [offline-recovery-card.md](./offline-recovery-card.md) §3 for skip-reason
   table (issue #2045). Same pattern for FAA residual: flat
   `finishedAwaitingAckTtlReclaim.reclaimedTotal` with high
   `capacity.byClass.finishedAwaitingAck` → read skip dominance (often
   `skippedOpenPrFailsafe` when PR refs are unfetched; issue #2084).
2. If residual stays high for a full TTL window: complete/cancel clearly dead
   tasks; investigate `skippedOpenPrFailsafe` / `skippedNoLiveness` /
   `skippedProviderPaused` / `lastOutcomes` before manual intervention (after
   #2072, past-TTL silence reclaims long-silent needs_input; open-PR and
   provider-pause remain hard bars). For FAA, map
   `finishedAwaitingAckTtlReclaim.lastOutcomes` the same way; check Discord
   for `faa:residual` / `op:faa:residual:alert` when residual stays ≥ bound
   for the stale window without decreasing.
3. Avoid new general-source spawns until `capacity.free` recovers (reserved slots
   may still accept `kookr`-sourced launches depending on settings).

---

## 4. Prod smoke tick (symptom only)

**What it is.** Hourly in-process smoke (issue #1593) writes a durable alert
artifact and projects it onto health as `prodSmokeTick` (issue #2031). The health
handler **never re-runs** smoke checks — treat the block as a **symptom readout**.

**Health field** (omitted when the tick is disabled, e.g. non-prod ports):

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
print(json.dumps(h.get("prodSmokeTick"), indent=2, default=str))
PY
```

Typical shape:

```json
{
  "schemaVersion": "prod-smoke-tick.v1",
  "status": "ok | alert | unknown",
  "consecutiveFailures": 0,
  "failingChecks": [],
  "generatedAt": "...",
  "firstFailedAt": "..."
}
```

**On-disk artifact (symptom only):**

```bash
# Default path under the data directory
python3 -m json.tool "${KOOKR_DIR}/prod-smoke-tick-alert.json" 2>/dev/null | head -80
```

**How to interpret (do not "fix" smoke by curling health harder):**

| Observation | Meaning | Action |
| --- | --- | --- |
| `status: "ok"` | Last tick passed | None |
| `status: "alert"`, short `consecutiveFailures` | Transient wedge | Re-check after the next hour; correlate with deploy |
| `status: "alert"`, large `consecutiveFailures`, old `firstFailedAt` | Multi-day false positive or real stuck check | Inspect `failingChecks` (e.g. `version-probe`); fix root cause (adapter binary, network, wrong SHA) — **not** by deleting the artifact alone |
| Block **absent** | Tick disabled (`KOOKR_PROD_SMOKE_TICK` off / non-4800 default) | Expected on dev; on prod port 4800 investigate env |

Env: `KOOKR_PROD_SMOKE_TICK` in [environment-variables.md](./environment-variables.md).

---

## 5. Enable resource watchdog

**Symptom.** Host pressure (high dtach/orphan counts, swap, OOM growth) with no
auto-investigation task. Doctor warns on `ops.resource-watchdog`. Health may
show `resourceWatchdog.pressureWhileDisabled: true` (visibility only — issue
#2039; does **not** auto-enable).

**Health field:**

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
print(json.dumps(h.get("resourceWatchdog"), indent=2, default=str))
PY
```

Key fields: `enabled`, `lastDecision` (`disabled` when off), `pressureWhileDisabled`,
`pressureWhileDisabledReason`, spawn/throttle counters.

**Enable** (off by default — deliberate actuator):

1. Set in the **production** process environment (systemd unit, `../kookr-prod`
   env, or shell wrapper — **not** a dashboard toggle):

   ```bash
   # Example only — put this in the unit/env file that starts prod Kookr
   export KOOKR_RESOURCE_WATCHDOG=1
   ```

2. Restart the prod instance so the sampler starts:

   ```bash
   # From the main Kookr checkout that owns prod scripts
   cd ~/git/kookr && pnpm prod:restart
   # or: systemctl --user restart kookr   # if you use the unit
   ```

3. Verify:

   ```bash
   curl -fsS "$KOOKR_API_BASE_URL/api/health" \
     | python3 -c 'import json,sys; w=json.load(sys.stdin).get("resourceWatchdog") or {}; print("enabled", w.get("enabled"), "lastDecision", w.get("lastDecision"))'
   kookr doctor --json 2>/dev/null \
     | python3 -c 'import json,sys; r=json.load(sys.stdin); print([c for c in r.get("checks",r) if "watchdog" in str(c).lower()][:5])' \
     || true
   ```

State / audit (no secrets required to read):

- `{KOOKR_DIR}/resource-watchdog.state.json`
- `{KOOKR_DIR}/resource-watchdog-audit.jsonl`

Spawns use the normal launch path (capacity + reserved slots). Throttle: at most
one investigation spawn per ~30 minutes; after the 24h budget a meta-reflection
task may replace another investigation. Details:
[environment-variables.md](./environment-variables.md) (`KOOKR_RESOURCE_WATCHDOG`),
[architecture.md](../architecture.md) resource-watchdog note.

---

## Related

| Doc | Use when |
| --- | --- |
| [offline-recovery-card.md](./offline-recovery-card.md) | Brief SSH return: ready, disk free, hung residual, Discord smoke, reboot |
| [backpressure.md](./backpressure.md) | 429/503 admission codes, disk-critical semantics |
| [data-directory.md](./data-directory.md) | `ops-status.json`, layout under `~/.kookr` |
| [environment-variables.md](./environment-variables.md) | Watchdog, smoke tick, admission floors |
| [low-downtime-redeploy.md](../runbooks/low-downtime-redeploy.md) | Redeploy + hungSuspect TTL across restarts |
| [api.md](./api.md) | Full `/api/health` / `/api/ready` contract |

No webhook URLs, tokens, or private paths belong in this runbook. Keep edits
tied to stable health field names (`safeMode`, `capacity.byClass.hungSuspect`,
`hungSuspectTtlReclaim`, `prodSmokeTick`, `resourceWatchdog`,
`data_directory_disk_critical`).
