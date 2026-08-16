# Operator offline recovery card

Short checklist for host-class failures when you return to a machine running unattended Kookr (or only have brief SSH / Discord). Commands assume the production-style instance on port `4800` (`../kookr-prod`, via `pnpm prod:update` / `pnpm prod:restart`). Adjust `KOOKR_PORT` / base URL if yours differs.

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

If curl hangs or takes hundreds of milliseconds: `kookr doctor --json` `ops.http-latency` WARNs when ready exceeds 500ms or health exceeds 2s (or either times out / 5xx). Sibling doctor probes that skip on timeout are not a clean bill of health.

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
print("finishedAwaitingAckTtlReclaim", h.get("finishedAwaitingAckTtlReclaim"))
'

# Per-task view (dashboard or API)
curl -sS http://127.0.0.1:4800/api/tasks | python3 -c '
import json,sys
tasks=json.load(sys.stdin)
print("inProgress", sum(1 for t in tasks if t.get("status")=="inProgress"))
'
```

### Reading `hungSuspectTtlReclaim` skip reasons (issue #2045)

`hungSuspectTtlReclaim` is process-lifetime cumulative (zeros on every restart):

| Field | Meaning |
| --- | --- |
| `reclaimedTotal` / `reclaimSucceeded` | Soft-terminates that freed a hungSuspect slot |
| `reclaimAttempted` | Candidates selected past TTL (includes terminate races that failed) |
| `skippedUnderTtl` | HungSuspect but silence age still &lt; `hungSuspectTtlMinutes` (default 25m) |
| `skippedOpenPrFailsafe` | Open/unknown PR hold — stranded-PR exemption, intentional |
| `skippedNoLiveness` | No watchdog liveness timestamps (never invent silence-since-epoch) |
| `skippedExemptAnomaly` | Legacy (#2045). After #2072 always 0 on new processes — past-TTL silence reclaims long-silent `needs_input` / `permission_blocked` (stuckReason already labels them `hung_suspect`) |
| `skippedProviderPaused` | Billing/quota pause (#1667) hold-for-resume |
| `lastCandidatesConsidered` | HungSuspect candidates on the most recent sweep pass |
| `lastOutcomes` | Last pass: `{ taskId, outcome, silentForMs? }[]` (#2072 task-id audit) |
| `lastAttemptedTaskIds` | Last pass: task ids selected for terminate |

If `reclaimedTotal=0` while `capacity.byClass.hungSuspect≥2`:

1. **Dominant `skippedUnderTtl` soon after restart** — **expected** for the first full TTL window after boot. Pane silence is re-baselined at process registration so long-tool agents are not reclaimed from hook-only pre-restart silence (#2045). If under-TTL still dominates for hours after `serverStartedAt` is older than TTL, something is still refreshing liveness (or agents keep getting re-registered).
2. **Dominant `skippedOpenPrFailsafe`** — check whether those tasks really hold open PRs; fail-safe treats *unknown* like a hold. Not widened by #2072.
3. **Dominant `skippedNoLiveness`** — watchdog never registered the agent after resume; investigate session recovery.
4. **Dominant `skippedProviderPaused`** — billing/quota hold; do not force-reclaim without a separate invariant.
5. **`lastOutcomes` / `lastAttemptedTaskIds`** — map each hungSuspect candidate to selected vs skip reason with task id (#2072). When non-exempt (past TTL, no PR hold, not provider-paused), `reclaimAttempted` must advance.
6. **Residual page** — Discord/operator `hung:residual` (#1993) pages when residual stays high after a full reclaim window.

Do **not** treat a brief `reclaimedTotal=0` co-occurring with `daemon_uptime_reset` as a reclaim bug — counters and residual-alerter episode state reset with the process, and under-TTL skips dominate until multi-channel silence is observed. See [low-downtime redeploy](../runbooks/low-downtime-redeploy.md#hungsuspect-ttl-reclaim-across-redeploy).

If residual stays high after TTL reclaim windows: complete or cancel clearly dead tasks, check Discord/operator signals for `hung:residual` (when enabled), avoid spawning more work until free slots return.

### Reading `finishedAwaitingAckTtlReclaim` skip reasons (issue #2084)

`finishedAwaitingAckTtlReclaim` is process-lifetime cumulative (zeros on every restart) — same convention as hungSuspect. Strict-path skip counters explain residual FAA when `reclaimedTotal` is flat while `capacity.byClass.finishedAwaitingAck` stays high (open-PR fail-safe is often dominant after #1884/#2070).

| Field | Meaning |
| --- | --- |
| `reclaimedTotal` / `reclaimSucceeded` | Strict TTL force-completes that freed an FAA slot |
| `reclaimAttempted` | Candidates selected past TTL (includes complete races that failed) |
| `skippedUnderTtl` | `completion_ready` younger than FAA TTL (`finishedAwaitingAckTtlMinutes`, default 15m) |
| `skippedOpenPrFailsafe` | Open/unknown PR hold — fail-safe leave alone; dominant residual when PR refs unfetched |
| `skippedBadRaisedAt` | Missing/unparseable `pendingSignal.raisedAt` (cannot age; fail-safe leave alone) |
| `lastCandidatesConsidered` | FAA candidates on the most recent strict selection pass |
| `lastOutcomes` | Last pass: `{ taskId, outcome, ageMs? }[]` |
| `lastAttemptedTaskIds` | Last pass: task ids selected for reclaim |
| `autoCompletedTotal` / `autoCompleteDeferredTotal` | Meta/playbook FAA path (#2070) + TOCTOU deferrals |

If `reclaimedTotal` is flat while FAA occupancy is high:

1. **Dominant `skippedOpenPrFailsafe`** — check whether those tasks really hold open PRs; unknown/unfetched refs are treated like a hold on the strict path. Meta auto-complete (#2070) may still drain *allowlisted* meta/playbook tasks under the relaxed fail-safe — non-allowlisted implementers stay held.
2. **Dominant `skippedUnderTtl`** — expected soon after restart or for fresh completion_ready signals; wait for the FAA TTL window.
3. **Dominant `skippedBadRaisedAt`** — corrupted/missing signal timestamps; investigate the raising path rather than force-reclaiming.
4. **`lastOutcomes` / `lastAttemptedTaskIds`** — map each FAA candidate to selected vs skip reason with task id.
5. **Residual page** — Discord/operator `faa:residual` (#2077) pages when residual stays ≥ bound for a full stale window after reclaim without decreasing. Page-only (no extra force-completes). Clear when FAA returns to 0.

If residual stays high after TTL reclaim windows: ack/complete/cancel clearly dead FAA tasks, check Discord/operator signals for `faa:residual` (when enabled), avoid spawning more work until free slots return. Episode state for the residual alerter is process memory — a restart resets the wait window (same as `hung:residual`).

## 3a. Fail-closed schedule pauses (issue #2426)

`#2353` parks a schedule after consecutive failures (the bootstrap-critical merge watchdog is exempt and never parks — see the unattended-recovery runbook §3b, `#2530`). Health lists those parks; Discord now pages when **three or more** stay parked so an offline operator does not wait on the 14KB health blob.

```bash
curl -sS http://127.0.0.1:4800/api/health | python3 -c '
import json,sys
h=json.load(sys.stdin)
print("schedulesPausedByFailure", (h.get("schedules") or {}).get("schedulesPausedByFailure"))
'
kookr doctor --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
print([c for c in d.get("checks", []) if c.get("id")=="ops.schedules-paused-by-failure"])
'
```

- Discord/operator key: `schedules:paused:residual` (signal `op:schedules:paused:residual:alert`).
- Page-only. **Do not** treat the page as a resume. After diagnosing the loop, batch-recover all cascade-origin holds in one command: `kookr schedule enable --held-by cascade` (idempotent; leaves genuine operator holds untouched; safe per issue #2517). Or resume one at a time with `kookr schedule enable <id>`.
- The page re-raises with rising urgency by episode age (warning → critical HIGH at ≥6h → critical SEVERE at ≥12h, issue #2531); each re-raise embeds the batch command.
- Recovered page (`op:schedules:paused:residual:clear`) fires only when the paused count returns to 0 — running the batch command is what clears it (recovery = ack).
- Episode state is process memory — a restart can re-page immediately if ≥3 are still parked, and resets the escalation age clock.

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

## 5. Host-stale dtach vs session reaper (issue #2349)

**Symptom.** Host dtach process count is high while the session reaper reports almost no orphans — often misread as “reaper is broken.”

```bash
curl -sS http://127.0.0.1:4800/api/health | python3 -c '
import json,sys
h=json.load(sys.stdin)
dtach=(h.get("staleProcesses") or {}).get("dtach") or {}
reaper=h.get("sessionReaper") or {}
host=h.get("hostStaleDtachReaper") or {}
print("staleProcesses.dtach.count", dtach.get("count"))
print("sessionReaper.lastOrphanCount", reaper.get("lastOrphanCount"))
print("sessionReaper.lastTerminalLeakCount", reaper.get("lastTerminalLeakCount"))
print("sessionReaper.totalSessionsReaped", reaper.get("totalSessionsReaped"))
print("hostStaleDtachReaper", {k: host.get(k) for k in (
  "enabled","lastDtachCount","lastUnderPressure",
  "lastHostStaleDtachReaped","lastReapedAlways","lastReapedUnderPressure",
  "skippedLiveAttached","skippedUnderBound","dryRun",
)})
print("resourceWatchdog.enabled", (h.get("resourceWatchdog") or {}).get("enabled"))
'

# Doctor advisory (code host_stale_dtach_mismatch) when host excess ≥ soft bound
kookr doctor --json 2>/dev/null | python3 -c '
import json,sys
r=json.load(sys.stdin)
for c in r.get("checks",[]):
  if c.get("id")=="ops.host-stale-dtach":
    print(c.get("status"), c.get("summary")); print(c.get("recommendedAction") or "")
'
```

**How to read the mismatch**

| Observation | Meaning | Action |
| --- | --- | --- |
| High `staleProcesses.dtach.count`, low `sessionReaper.lastOrphanCount` + `lastTerminalLeakCount` | Host-stale class: process-table **masters only** (`dtach -n`; attach clients excluded — #2383) **outside** TaskStore / live-session inventory | **Not** a broken session reaper — #1720 only sees backend live sessions |
| Doctor WARN `ops.host-stale-dtach` / `host_stale_dtach_mismatch` | Host excess ≥ soft bound (default 20) | Prefer `hostStaleDtachReaper` counters; enable continuous investigation via `KOOKR_RESOURCE_WATCHDOG=1` if off |
| Rising `lastHostStaleDtachReaped` / `lastReapedAlways` | Host-stale reaper reaping `missing_socket_aged` (always-select, #2384) | Wait for sweeps; use dry-run only when deliberately observing |
| High `skippedLiveAttached` | Those pids are still live-attached sessions | Do **not** kill; use task/session terminal paths |

**Do not** invent kill logic from doctor, assume `sessionReaper` is broken, or reboot solely because dtach count is high with orphan gauges near zero. Full procedure: [unattended-recovery-runbook.md](./unattended-recovery-runbook.md) §6.

## 6. Discord webhook smoke test

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

## 7. When to reboot the host

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

- Symptom → health field → action (SAFE MODE, disk-critical, hung residual, smoke tick, resource watchdog, host-stale dtach): [unattended-recovery-runbook.md](./unattended-recovery-runbook.md)
- Deploy / blackout probe recipe: [api-blackout-probe.md](./api-blackout-probe.md) (when present)
- Health fields and capacity: `GET /api/health`, `GET /api/ready`
- Resource watchdog / doctor: `kookr doctor`, env reference
- RFC: remote autonomy & operational resilience (tracking issue / RFC in `docs/rfc/`)
