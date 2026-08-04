# Runbook: Low-Downtime Redeploy

Operator guide for intentional production-style restarts (`pnpm prod:update` /
`pnpm prod:restart`) so orchestrators treat them as **planned maintenance**, not
outages.

**Audience:** operators and agent orchestrators watching the instance on port
`4800` (`../kookr-prod`).

**Related shipped work:** drain/resume ([#659](https://github.com/kookr-ai/kookr/issues/659)),
listen-early + deploy ready gate (PR [#1747](https://github.com/kookr-ai/kookr/pull/1747) /
[#1721](https://github.com/kookr-ai/kookr/issues/1721)), speech sidecar detach P1
(PR [#1950](https://github.com/kookr-ai/kookr/pull/1950)), restart phase timings /
`apiBlackoutSeconds` ([#1972](https://github.com/kookr-ai/kookr/issues/1972)),
pre-stop drain ([#1971](https://github.com/kookr-ai/kookr/issues/1971)).

RFC design and non-goals:
[`docs/rfc/rfc-fast-prod-restart.md`](../rfc/rfc-fast-prod-restart.md).

---

## Goals (API blackout SLO)

| Goal | Target | What it measures |
| --- | --- | --- |
| **Ideal** | **&lt;1s** | Listener gap: port free → first `GET /api/health` 200 |
| **Maximum (SLO)** | **&lt;5s** | Same clock; `prod-restart.sh` prints a non-fatal `WARN` when exceeded |

These are **goals / operator SLOs**, not CI gates and not guarantees on every
host. Absolute times depend on host load, cold vs warm speech, and
systemd vs pid-file path. Measure with the built-in `apiBlackoutSeconds` line
or [API Blackout Probe](../reference/api-blackout-probe.md).

**Do not** treat multi-minute `pnpm prod:restart` **script exit** as “API is
dark.” Script wall clock is dominated by **M2** (deploy-ready / recovery) and
optional smoke after the listener is already back — see [Clocks](#clocks).

---

## Clocks

| Clock | Meaning | Probe / source | Typical after speech-detach P1 |
| --- | --- | --- | --- |
| **API blackout** | No listener on the port | Port free → first `/api/health` 200 (`apiBlackoutSeconds`) | **Ideal &lt;1s, SLO max &lt;5s** on warm path |
| **M1** process liveness | HTTP is up | First `/api/health` 200 | Same window as blackout end; warm Node regime when sidecars reuse |
| **M2** deploy-ready | Safe to treat deploy as finished | `probe_ready_for_deploy` on `/api/ready` (not `startup-in-progress`) | **Can still be long** (minutes on large task corpora) while **API is already live** after M1 |
| **M3** speech warm | STT/TTS containers not cold-started | Container `Id`/`StartedAt` stable | Detach + reuse (PR #1950); cold path still multi-minute **pre-listen** |
| **M4** script exit | Operator command returns | M2 + optional smoke | Often ≫ API blackout; not an outage signal |

**Critical distinction:** After listen-early (PR #1747), the process **binds and
serves `/api/health` before deferred recovery finishes**. Long M2 means “not
fully recovered / not deploy-ready yet,” **not** “API is dark.” Orchestrators
must not open incident issues solely because `prod:restart` has not exited or
`/api/ready` is still 503 with `startup-in-progress`.

---

## Current downtime reality (same-port sequential restart)

Kookr production-style deploy is still **stop then start on the same port**.
There is **no** blue-green, dual listener, or SO_REUSEPORT handoff in v1
([RFC non-goals](../rfc/rfc-fast-prod-restart.md#non-goals)).

| What speech-detach P1 (PR #1950) fixed | What it did **not** fix |
| --- | --- |
| Multi-minute GPU speech teardown/cold-start on **warm** routine restart | Same-port sequential blackout (multi-second still possible under load) |
| Sidecars outlive the Node process (detach on SIGTERM) | Sub-second **script exit** (M2 recovery still allowed to dominate) |
| Phase timings + dominant-phase line on restart | Sub-second blackout as a hard guarantee |

**Residual blackout:** between the old process releasing `:4800` and the new
process accepting connections, clients see connection refused / failed fetches.
On a healthy warm path the target is still **&lt;1s ideal / &lt;5s max**. Host
pressure, cold speech (sidecars missing), or a slow bind can push blackout into
**multiple seconds** without implying a product regression beyond the SLO WARN.

**Path to true &lt;1s / near-zero blackout:** dual-instance / blue-green (or
equivalent listener handoff) — explicitly **deferred** by the fast-prod-restart
RFC. Do not expand that scope from this runbook; open a design track only if
measured blackout consistently exceeds the SLO and operators need a harder bar.

---

## Default procedure

### Happy path (recommended): `pnpm prod:update` / `pnpm prod:restart`

From the **dev checkout** (scripts live here; prod code in `../kookr-prod`):

```bash
# Full deploy: fetch + build + restart + ready gate + smoke
pnpm prod:update

# Restart only (e.g. after .env change), same restart script
pnpm prod:restart
```

What the restart script already does:

1. **Best-effort pre-stop drain** — `POST /api/admin/drain` so in-flight
   spawns get `503` + `code: "draining"` instead of only `ECONNREFUSED`
   ([#1971](https://github.com/kookr-ai/kookr/issues/1971)). Opt out:
   `KOOKR_RESTART_SKIP_DRAIN=1`.
2. **Stop** the old process (systemd restart when `kookr.service` is active,
   else SIGTERM / port reclaim).
3. **Start** `node dist/server/start.js` in the prod worktree.
4. **M1** wait for `/api/health` 200.
5. **M2** wait for deploy-ready on `/api/ready` (issue #1721 / PR #1747;
   default timeout `KOOKR_STARTUP_TIMEOUT_SECONDS=1800`).
6. Optional **smoke**, then print phase timings + `apiBlackoutSeconds`.

**Drain is in-memory and dies with the process.** A successful restart clears
drain automatically — **no `kookr resume` is required** after `prod:restart` /
`prod:update` unless you entered drain manually and the process is still the
same one.

When `kookr.service` is active, see
[Production Server Service](../reference/production-server-service.md).

### Manual drain window (long maintenance)

Use when you need running agents to settle **before** stop, or when you will
keep the process up while refusing new work:

```bash
kookr drain          # refuse new launches; running agents continue
# … wait for critical tasks, or proceed when ready …
pnpm prod:restart    # or prod:update; pre-stop drain is redundant but harmless
# After restart: process is accepting again (in-memory drain cleared).

# If you drained and decided NOT to restart yet:
kookr resume
```

Details: [`kookr drain` / `kookr resume`](../reference/cli.md#kookr-drain--kookr-resume),
API admin routes in [API reference](../reference/api.md#admin--runtime-control).

### Verify after deploy

```bash
curl -fsS http://127.0.0.1:4800/api/health   # liveness (M1)
curl -fsS http://127.0.0.1:4800/api/ready    # deploy-ready (M2)
# Optional: lastRestart.apiBlackoutSeconds from a successful prior restart
curl -fsS http://127.0.0.1:4800/api/deploy/status | python3 -m json.tool | head -80
```

Independent blackout measurement:
[API Blackout Probe](../reference/api-blackout-probe.md).

---

## Client contracts during redeploy (orchestrator policy)

Summarized so agents **do not invent incident work** for intentional restarts.
Authoritative deep dives stay linked; this table is the redeploy contract.

| Surface | Expected behavior during / around redeploy | Recommended agent policy |
| --- | --- | --- |
| **Spawn** (`kookr spawn` / `POST /api/tasks`) | **Drain:** HTTP **503** + `code: "draining"` while accepting is false ([#659](https://github.com/kookr-ai/kookr/issues/659)). **Blackout:** connection error / timeout while the port is free. After M1, listener returns; full readiness may still be recovering. | Retry with backoff for **≤60s** total. Prefer idempotency keys ([spawn contract](../reference/spawn-contract.md)). **Do not** open GitHub issues or “Kookr is down” tasks for a single refused launch during a known deploy window. |
| **Signal** (`kookr signal`) | Write-behind outbox before HTTP; offline/restart ⇒ exit **0** spooled; server drains outbox after boot ([#1541](https://github.com/kookr-ai/kookr/issues/1541), [signal-outbox](../reference/signal-outbox.md)). | Treat spool success as success. Do not burn a turn “investigating” a missing immediate ack. |
| **Drain / ready 503** | `/api/ready` is 503 while draining or `startup-in-progress`. `/api/health` often stays 200 in drain (liveness ≠ ready). | Use ready only as **deploy gate / supervisor cordon**, not as “page the human.” |
| **Dashboard** | WebSocket drops; `ConnectionBanner` shows **Redeploying** when deploy is in flight (“API should return within a few seconds”), else generic reconnect. Terminal panel reconnects and replays ring buffer. On dashboard **Deploy** (`POST /api/deploy/trigger`), a `deployLifecycle` `{ phase: "starting" }` frame is broadcast first so open tabs set the sticky deploy flag before the blackout ([#1980](https://github.com/kookr-ai/kookr/issues/1980)). | Expected UX. Do not file “dashboard disconnected” bugs for a planned `prod:update`. |
| **Schedules** | Fires suppressed while draining; execution outcome **`skipped_draining`** / reason `draining` ([#659](https://github.com/kookr-ai/kookr/issues/659)). Next tick after accept resumes normal fire. | Missed fire during drain is intentional. Do not open “schedule broken” issues for a single skipped_draining during redeploy. |
| **hungSuspect TTL reclaim** | Process-lifetime counters (`hungSuspectTtlReclaim.*` on `/api/health`) and residual-alerter episode state **reset to 0** on every restart. Session `lastEventAt` is restored for *watchdog staleness* (hook channel), but pane silence is re-baselined at registration so multi-channel reclaim does not invent pre-restart pane quiet ([#2045](https://github.com/kookr-ai/kookr/issues/2045)). Open-PR fail-safe still holds. | `reclaimedTotal=0` + dominant `skippedUnderTtl` for one full TTL after `daemon_uptime_reset` is **expected**. Read skip-reason fields before filing “reclaim broken.” See [offline recovery card §3](../reference/offline-recovery-card.md#3-hungsuspect-residual-capacity-waste). |

### hungSuspect TTL reclaim across redeploy

Intentional `pnpm prod:update` / `prod:restart` (and the `daemon_uptime_reset` sentinel that follows) interact with reclaim as follows:

1. **Counters reset.** `reclaimedTotal`, skip totals, and `lastCandidatesConsidered` are in-process only — a fresh server always starts at zero. Comparing “reclaimedTotal stayed 0 for hours across redeploys” without accounting for restarts is a false signal.
2. **Multi-channel silence restarts pane at registration.** Reclaim silence is `max(hook, pane, token)`. Startup restores `lastEventAt` for tick() staleness, but `lastPaneChangeAt` starts at registration time so a long tool whose hooks were quiet while its pane still advanced is not soft-terminated on the first post-boot liveness tick. After a full `hungSuspectTtlMinutes` of observed multi-channel silence in the new process (and subject to open-PR / exempt-anomaly / provider-pause fail-safes), reclaim proceeds.
3. **Fresh agents** (no persisted `lastEventAt`) start all silence clocks at registration the same way.
4. **Residual page wait resets.** The `hung:residual` alerter’s “high without decreasing” timer is also process memory; after redeploy it re-arms for a full stale window before Discord pages again.

**Operator policy:** After a planned redeploy, wait at least one `hungSuspectTtlMinutes` window (default 25m) *or* inspect skip-reason dominance before treating residual hungSuspect as a reclaim defect. Prefer `hungSuspectTtlReclaim.skipped*` over occupancy alone. Dominant `skippedUnderTtl` right after boot is safety, not a broken reclaim loop.

**Global orchestrator rule:** If you see brief spawn failures, spooled signals,
dashboard reconnect, or `skipped_draining` **during or within ~60s of** a
`pnpm prod:update` / `prod:restart` / systemd restart of `kookr.service`, treat
it as **planned**. Retry ≤60s; do **not** spawn investigation children or file
outage issues unless blackout or unavailability **exceeds ~5 minutes** without
`/api/health` recovery (then use
[offline recovery card](../reference/offline-recovery-card.md)).

---

## When to use manual drain vs trust the script

| Situation | Action |
| --- | --- |
| Routine code deploy | `pnpm prod:update` only (built-in pre-stop drain) |
| Config-only bounce | `pnpm prod:restart` |
| Want launches stopped while agents finish **before** kill | `kookr drain` → wait → `pnpm prod:restart` |
| Long maintenance **without** restart yet | `kookr drain` … work … `kookr resume` |
| Free GPU / tear down speech | `pnpm prod:stop --with-sidecars` (not a low-downtime redeploy) |
| Skip pre-stop drain (debug) | `KOOKR_RESTART_SKIP_DRAIN=1 pnpm prod:restart` |

---

## Speech sidecars (P1 operator contract)

- Routine restart **does not** `compose down` bundled STT/TTS (PR #1950).
- GPU stays in use after plain `pnpm prod:stop`; reclaim with
  `pnpm prod:stop --with-sidecars`.
- Cold path (sidecars missing / first boot) may still wait multi-minute **before**
  listen — unchanged and expected.
- First restart after upgrading onto the detach binary may still pay one cold
  hit if the **old** binary downs containers on exit.

---

## What not to do

- Do **not** treat M2 multi-minute recovery as an API outage after M1 is green.
- Do **not** point process supervisors at relay `/ready` for the engine — use
  engine `GET /api/ready` ([production-server-service](../reference/production-server-service.md#readiness-probe-engine-not-relay)).
- Do **not** assume sub-second blackout without blue-green (deferred).
- Do **not** run `pnpm prod:update` from batch/playbook agents unless the task
  explicitly owns deploy (self-batch schedule forbids it by default).

---

## `deployLifecycle` coverage

| Path | Emits `deployLifecycle` `{ phase: "starting" }` on live WebSockets? |
| --- | --- |
| Dashboard Deploy / `POST /api/deploy/trigger` | **Yes** — broadcast runs after validation and **before** `prod-update` is spawned so open tabs can set the sticky deploy flag while still connected ([#1980](https://github.com/kookr-ai/kookr/issues/1980)). |
| `pnpm prod:update` / `pnpm prod:restart` / `scripts/prod-restart.sh` from a shell (no trigger) | **No** — there is no pre-exit WebSocket event on the script path. Rely on sticky client flag if a prior trigger set it, status poll, or orchestrator knowledge of the planned restart. Optional pre-stop hook later. |
| systemd restart of `kookr.service` | **No** — same gap as script-path restart. |

Older dashboard clients ignore unknown WebSocket `type` values safely (no
`default` branch in the client switch). New clients set `deploying` via
`setDeploying(true)` → sessionStorage sticky intent → ConnectionBanner
“Redeploying” copy.

---

## Related docs

| Doc | Why |
| --- | --- |
| [Production Server Service](../reference/production-server-service.md) | systemd unit + `/api/ready` probe |
| [API Blackout Probe](../reference/api-blackout-probe.md) | Measure blackout independently |
| [Deploy Convergence](../reference/deploy-convergence.md) | Dashboard deploy button vs CLI |
| [CLI — drain / resume](../reference/cli.md#kookr-drain--kookr-resume) | Manual drain |
| [CLI — Redeploy resilience](../reference/cli.md#redeploy-resilience) | Client surface summary |
| [Spawn contract](../reference/spawn-contract.md) | Retry / idempotency |
| [Signal outbox](../reference/signal-outbox.md) | Spooled signals |
| [Offline recovery card](../reference/offline-recovery-card.md) | Host-class failures (not planned redeploy) |
| [Troubleshooting — production-style](../troubleshooting.md#production-style-instance-looks-stale) | Commands + phase timings |
| [RFC: Fast production restart](../rfc/rfc-fast-prod-restart.md) | Design, non-goals, M1–M4 |

Issues closed by the product-facing doc slice: #1977 (this runbook), #1978
(client contracts), #1981 (residual same-port blackout).
