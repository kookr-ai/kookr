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
| Three or more schedules stay fail-closed paused; Discord pages `schedules:paused:residual` | `schedules.schedulesPausedByFailure` | Diagnose each loop, then `kookr schedule enable <id>` — **do not auto-resume** — [fail-closed schedule pauses](#3a-fail-closed-schedule-pauses) |
| Multi-hour / multi-day "prod smoke" paging or artifact stuck in alert | `prodSmokeTick` (+ on-disk alert JSON) | **Symptom only** — inspect fields; do not re-run smoke on the health path — [smoke tick](#4-prod-smoke-tick-symptom-only) |
| Host pressure (dtach orphans, swap) with no auto-investigation | `resourceWatchdog.enabled == false` | Enable `KOOKR_RESOURCE_WATCHDOG=1` and restart — [resource watchdog](#5-enable-resource-watchdog) |
| `staleProcesses.dtach.count` high while `sessionReaper` orphans stay ~0 | `staleProcesses.dtach` vs `sessionReaper` (+ `hostStaleDtachReaper`) | Host-stale class — **not** a broken session reaper; prefer host-stale reaper + optional resource watchdog — [host-stale dtach](#6-host-stale-dtach-vs-taskstore--session-reaper) |
| Ready or health slower than the doctor budget, or the probe times out | `kookr doctor` `ops.http-latency` | Treat the WARN as the hung-HTTP signal — ready budget 500ms, health 2s; do not trust sibling probes that skip on timeout — [HTTP latency](#0a-http-latency-doctor-warn) |
| Ready fails after restart | `GET /api/ready` body `checks` | Fix named subsystem, then re-probe (offline card §1) |
| Discord silent after a real edge | `~/.kookr/ops-status.json` | Read durable card (no secrets); fix webhook later — [offline card](./offline-recovery-card.md) §6 |

Stable field names only — avoid inventing aliases. When a block is **omitted**
from `/api/health`, treat it as disabled / unavailable for that build or env.

---

## 0a. HTTP latency (doctor WARN)

Unattended diagnosis starts with `kookr doctor`. Sibling live probes abort
`GET /api/health` at 500ms and **skip** (ok) on timeout, so a wedged HTTP
surface can make the report look fine. `ops.http-latency` is the first-class
signal: it times `GET /api/ready` (500ms abort and WARN budget) then
`GET /api/health` (2s abort and WARN budget). Timeout, elapsed over budget, or
5xx → advisory WARN with elapsed ms. Health is skipped when ready already
timed out so doctor does not hang twice.

```bash
kookr doctor --json 2>/dev/null \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print([c for c in r.get("checks",[]) if c.get("id")=="ops.http-latency"])'
```

This check never fails required doctor status. Use `--strict` if an unattended
gate should exit non-zero on the WARN.

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

## 3a. Fail-closed schedule pauses

**Symptom.** Unattended schedules stop firing and stay stopped. Health lists
them under `schedules.schedulesPausedByFailure` (issue #2353). Discord pages
`schedules:paused:residual` once **three or more** are parked (issue #2426).
Nothing auto-resumes them — that is the point of fail-closed pause.

**Health fields:**

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
print("schedulesPausedByFailure", (h.get("schedules") or {}).get("schedulesPausedByFailure"))
PY
```

**Actions (ordered):**

1. Read the page body (or the health array): each row has `name`,
   `consecutiveFailures`, and `kookr schedule enable <id>`.
2. Diagnose the loop (last error, recent tasks) **before** re-enabling.
   Re-enabling a still-broken belt just re-pauses it.
3. Re-enable one schedule at a time. The recovered page fires only when the
   paused count returns to **0**. Re-pages at most once per hour while the
   count stays ≥ 3.
4. Do **not** write a script that enables every id on the page. Operator
   re-enable is the only resume path.

Episode state is process memory. A restart can re-page immediately if ≥3
schedules are still parked.

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
show `resourceWatchdog.pressureWhileDisabled: true` (issue #2039). By default
(`KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE` on) soft-bound pressure also triggers a
rate-limited investigation spawn without continuous sampling (issue #2354);
set `KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0` for page-only, or
`KOOKR_RESOURCE_WATCHDOG=1` for continuous monitoring.

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

## 6. Host-stale dtach (vs TaskStore / session reaper)

**Symptom (issue #2349).** `staleProcesses.dtach.count` is high (often ≥ soft
bound 20) while `sessionReaper.lastOrphanCount` / `lastTerminalLeakCount` stay
near zero and `totalSessionsReaped` does not climb. Doctor may WARN on
`ops.host-stale-dtach` (`host_stale_dtach_mismatch`).

**Count semantics (issue #2383).** `staleProcesses.dtach.count` is **masters
only** (`dtach -n` / `-N` under `kookr-dtach`). Live `dtach -a` attach clients
are excluded so a healthy fleet near `maxActiveTasks` does not false-trip the
soft bound. If you still see count ≥ 20 with reaper orphans ~0, treat it as
real host-stale pressure, not normal attach occupancy.

**Do not assume the session reaper is broken.** These are process-table masters
**outside** the session reaper’s live-session / TaskStore inventory — usually
missing sockets after a hard kill or crashed server generation. The #1720
session reaper only reaps backend-reported live sessions; host-stale masters are
a different class (see also [offline-recovery-card.md](./offline-recovery-card.md)
§5).

**Diagnosis (health fields only):**

```bash
python3 - <<'PY'
import json
h=json.load(open("/tmp/kookr-health.json"))
dtach=(h.get("staleProcesses") or {}).get("dtach") or {}
reaper=h.get("sessionReaper") or {}
print("staleProcesses.dtach.count", dtach.get("count"))
print("sessionReaper.lastOrphanCount", reaper.get("lastOrphanCount"))
print("sessionReaper.lastTerminalLeakCount", reaper.get("lastTerminalLeakCount"))
print("sessionReaper.totalSessionsReaped", reaper.get("totalSessionsReaped"))
print("hostStaleDtachReaper", h.get("hostStaleDtachReaper"))
print("resourceWatchdog.enabled", (h.get("resourceWatchdog") or {}).get("enabled"))
PY
```

Interpret mismatch: if `staleProcesses.dtach.count` is elevated while reaper
orphan gauges stay ~0, treat as **host-stale class** — not session-reaper
failure. Prefer `hostStaleDtachReaper` counters next; enable resource watchdog
(section 5) when you want briefed auto-investigation.

**What the host-stale reaper does (issues #2356, #2384).** A bounded periodic
sweep (default every 5 minutes, plus ~45s after boot) plans candidates with the
pure `planHostStaleDtachReap` policy:

1. Never select a master whose session id is still live-attached.
2. Never select a master whose socket file still exists.
3. Skip unknown age / too-young (teardown-race floor, default 60s).
4. **Always select** `missing_socket_aged` masters (not live, socket gone,
   past min age) even when host-wide dtach count is under the soft bound
   (#2384). Soft bound is reserved for any future more-aggressive classes.
5. Rate-limit to max N reaps per sweep (default 5).
6. Kill path is `killProcessTree` (SIGTERM → grace → SIGKILL) on **selected
   pids only** — no unbounded `kill -9` of unknown processes.

**Health field** (cheap last-sweep counters; never a `/proc` scan on this path):
`hostStaleDtachReaper` on `GET /api/health`.

Key counters: `lastHostStaleDtachReaped`, `lastReapedAlways`,
`lastReapedUnderPressure`, `skippedLiveAttached`, `skippedUnderBound`,
`skippedRateLimited`, `totalHostStaleDtachReaped`, `lastDtachCount`,
`lastUnderPressure`, `dryRun`.

**Operator knobs** (see [environment-variables.md](./environment-variables.md)):

| Env | Role |
| --- | --- |
| `KOOKR_HOST_STALE_DTACH_REAP` | Master enable (on by default; `0`/`off` disables) |
| `KOOKR_HOST_STALE_DTACH_REAP_DRY_RUN=1` | Observe would-reap decisions without signalling |
| `KOOKR_HOST_STALE_DTACH_REAP_SOFT_BOUND` | Reserved for future pressure-gated classes (default 20); `missing_socket_aged` always selects (#2384) |
| `KOOKR_HOST_STALE_DTACH_REAP_MAX_PER_SWEEP` | Rate limit (default 5) |
| `KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES=0` | Disable the timer |

**Actions (ordered):**

1. Confirm the mismatch on health / `kookr doctor` (`ops.host-stale-dtach`)
   using the field names above — do **not** treat flat session-reaper orphans as
   a reaper outage.
2. Prefer letting the automatic host-stale reaper clear pressure when enabled
   and not dry-run. Watch `hostStaleDtachReaper.lastHostStaleDtachReaped` /
   `totalHostStaleDtachReaped` advance across sweeps.
3. If continuous investigation is wanted and `resourceWatchdog.enabled` is
   false, enable `KOOKR_RESOURCE_WATCHDOG=1` and restart (section 5) — that path
   briefs an investigation task; it does not replace the host-stale reaper.
4. `missing_socket_aged` always selects even under the soft bound (#2384).
   `skippedUnderBound` only rises for future pressure-gated classes; if
   `lastEligibleCount` is high but `lastHostStaleDtachReaped` stays 0, check
   `skippedRateLimited` / `skippedLiveAttached` / dry-run first.
5. If `skippedLiveAttached` is high, do **not** kill those pids — they are still
   backend live sessions; use the session reaper / task terminal path instead.
6. For a safe observation pass before kills: set
   `KOOKR_HOST_STALE_DTACH_REAP_DRY_RUN=1`, restart, re-read
   `hostStaleDtachReaper` (`dryRun`, `lastHostStaleDtachReaped`, skip counters),
   then clear dry-run.

This reaper is **not** a substitute for enabling the resource watchdog (section
5) when you want briefed investigation tasks — it only reclaims host-stale
dtach masters under the documented selection policy.

---

## Related

| Doc | Use when |
| --- | --- |
| [offline-recovery-card.md](./offline-recovery-card.md) | Brief SSH return: ready, disk free, hung residual, host-stale dtach, Discord smoke, reboot |
| [backpressure.md](./backpressure.md) | 429/503 admission codes, disk-critical semantics |
| [data-directory.md](./data-directory.md) | `ops-status.json`, layout under `~/.kookr` |
| [environment-variables.md](./environment-variables.md) | Watchdog, host-stale reaper, smoke tick, admission floors |
| [low-downtime-redeploy.md](../runbooks/low-downtime-redeploy.md) | Redeploy + hungSuspect TTL across restarts |
| [api.md](./api.md) | Full `/api/health` / `/api/ready` contract |

No webhook URLs, tokens, or private paths belong in this runbook. Keep edits
tied to stable health field names (`safeMode`, `capacity.byClass.hungSuspect`,
`hungSuspectTtlReclaim`, `prodSmokeTick`, `resourceWatchdog`,
`hostStaleDtachReaper`, `staleProcesses`, `sessionReaper`,
`schedules.schedulesPausedByFailure`,
`data_directory_disk_critical`).
