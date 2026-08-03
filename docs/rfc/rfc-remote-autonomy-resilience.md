# RFC: Remote Autonomy & Operational Resilience

**Status:** Draft (v2 — post failure-mode + minimalist review)
**Date:** 2026-08-03
**Author:** Jean Ibarz (with Grok Build)
**Related:** `rfc-overnight-throughput-closed-loop.md` (#1963–#1969), #1526 capacity/dead-man, #1715 pipeline starvation, #1724 resource watchdog, #1935 hungSuspect TTL, continuous-progress watchdog RFC, Lucy Discord bot surface

---

## Problem

Jean cannot babysit Kookr during most working hours. Remote intervention is limited to occasional Discord via Lucy (narrow command surface). Hardware/host failures have **no remote recovery path** — if the machine is wedged, disk full, OOM, or dtach fleet broken, tasks stop progressing until someone is physically present.

Observed during 2026-08-03 live monitoring (post overnight-throughput PR1–4 deploy):

| Observation | Implication for unattended ops |
|---|---|
| Lucy parallel batch correctly `blocked-empty` (18 open issues, **all** umbrella/automation-blocked; eligibleCount=0) | Product loop can be healthy-and-idle; needs refill, not panic |
| Starvation path worked: `pipeline_starvation_decision` → `scout_spawn` with `kickBatchWhenScoutCompletes=true` and `batchKickEnabled=true` | Closed loop is real; still depends on agents launching and completing |
| Open idea-scout issues can disappear from the “implementable” pool (closed/merged/covered) while umbrellas remain forever | Backlog **looks** full but is non-actionable; autonomy stalls without scout quality |
| Kookr batch spawned implementer children while Lucy starved | Cross-repo is useful; capacity should prefer repos with eligible work |
| `hungSuspect: 1` on health while terminalBackend `ok` | Phantom capacity still possible; remote operator cannot easily free slots |
| `resourceWatchdog` **disabled** in prod | Host pressure does not auto-investigate |
| `lesson-spool` drain `written=0 failed=10` in server log | Silent subsystem failure without Discord/operator page |
| Schedule `dispatch_failed` overnight (quota, prompt-ack) historically | Producer schedules fail without remote redispatch |
| Relay process can predate rebuild (restart warned) | Stale control-plane components after deploy |
| Human offline → no one to `pnpm prod:restart`, free disk, clear hung tasks, re-enable flags | **MTTR is unbounded** for host-class failures |

The overnight-throughput work fixed **product pipeline starvation**. This RFC addresses **operational autonomy**: keep the *system* progressing (or safely degraded + recoverable) when Jean is absent or hardware-limited.

### Operator constraint (non-negotiable)

1. **Daytime:** rarely available to watch dashboard or SSH.
2. **Remote channel:** Discord → Lucy only, limited commands, not a full ops console.
3. **Hardware incidents:** Jean often **cannot** restore the host; recovery must be automated or deferred safely without data loss.
4. **Goal:** maximize hours of unattended useful work; minimize “dead until Jean is home.”

---

## Goals

1. **Self-heal common software failures** without a human (hung tasks, stale schedules, agent launch flake, full disk *log* growth, wedged scheduler).
2. **Degrade loudly and safely** when self-heal is impossible (hardware, auth expiry, all agents quota-dead) via Discord digest + durable on-disk status.
3. **Expand remote control** via Lucy so common recoveries are one Discord command (restart kookr, enable kick flag, cancel hung, status).
4. **Preserve capacity truth** so free slots mean real capacity.
5. **Prefer work that ships** when one repo is umbrella-only — cross-repo fill without thrashing.
6. **Keep control-plane recovery off the flaky agent path** where possible (in-process timers, not “spawn agent to restart server”).

## Non-Goals

- Full multi-host HA / multi-machine failover (v1 is single Linux host).
- Replacing Lucy product mission with pure ops bot (ops is an **add-on** surface).
- Auto cloud spend / plan upgrades.
- Silent auto-`prod:update` on every main commit without lag policy (dangerous; see below).
- Guaranteeing progress during power loss / disk death (only best-effort + boot recovery).

---

## Design principles

1. **Two planes:** *product work* (agents, playbooks) vs *ops control plane* (in-process healers, health, Discord). Healers must not depend on Grok prompt-ack to free a hung slot.
2. **Host plane before remote mutate** — if Node is dead, Discord commands cannot help; systemd/ready watchdog first.
3. **Outbound digests without Lucy** — pages use Kookr signal-delivery / Discord webhook; Lucy is **inbound-only** for commands.
4. **Evidence before heal** — restarts require consecutive failed readiness + cooldown.
5. **Jean offline profile** — assume 8–12h unattended windows as normal.
6. **Build on shipped pieces** — pipeline starvation loop, schedule dead-man, hungSuspect TTL (#1935), resource watchdog (#1724, currently off), existing Discord webhook path.
7. **Discord mutate is high privilege** — allowlist, admin token, schedule allowlist, rate limits, audit (see WS3 security).

---

## Smallest useful ship (SUS) — definition of done for v1

SUS is complete when, **without** new Lucy mutate commands:

1. Host **restart-on-ready-fail** (or documented systemd `Restart=on-failure` proven live) with cooldown.
2. HungSuspect TTL reclaim **on** in prod and residual hung has a known reason (live monitor saw hungSuspect climb to 4 during multi-scout load).
3. Schedule dead-man + pipeline starvation + ready-fail streaks **page Discord** via signal-delivery (prove with dry-run/forced edge).
4. One-page recovery card for Jean (SSH steps when hardware is up).
5. Read-only `!kookr status` / ready (or equivalent) optional if Discord outbound already covers digests.

**Out of SUS / other RFCs:** cross-repo fill, backlog umbrella hygiene, auto-deploy, runtime kick toggle, full healer registry.

---

## Failure mode inventory (own or defer)

| Mode | Auto action | Discord | Human-only |
|---|---|---|---|
| Ready fail / process crash | systemd restart + host timer 1/h | boot/back digest | — |
| hungSuspect residual | existing TTL reclaim (#1935); fix false-negatives | page if reclaim fails N times | free-hung later |
| Product empty (umbrellas only) | starvation scout + batch kick (shipped) | page on episode | — |
| Auth/session expiry | **detect** on health ≤15m; pause producers | page | re-login |
| dtach fleet broken | detect terminalBackend; one backend restart/h | page | physical/SSH |
| Lucy bot down | optional heartbeat miss | **webhook** “no Lucy 2h” | restart Lucy |
| Discord outage | write `ops-status.json` only | — | wait |
| Launch dead, ready green | dispatch_failed streak page | page | auth/quota |
| Disk critical (logs) | alert; prune only via existing maintenance budget | page | worktree disk |
| safeMode / kill-switch stuck on | surface on status | page | clear |
| Multi-host HA | **defer** | — | — |

---

## Workstreams

### WS1 — Host plane (survive without Discord)

1. Prove/enable systemd user unit `Restart=on-failure` for kookr.
2. `kookr-host-watchdog` timer: `/api/ready` fail for N minutes → restart **once per hour** max; refuse during drain/deploy window if detectable.
3. Boot digest via **webhook**: sha, recovered tasks, disk free, relay age vs artifact.

### WS2 — In-process healers (no framework)

**Do not invent a healer registry.** Prefer enable + observe existing:

| Concern | Existing owner | Gap to close |
|---|---|---|
| hungSuspect | #1935 TTL sweep | Prod residual (monitor saw 1→4 under load); Discord if unreclaimed |
| Schedule thrash | dead-man | Bridge fire edge to Discord if missing |
| Pipeline empty | #1715 + batch kick | Digests when scout armed / kick fired |
| Disk | maintenance prune + alerts | Alert-only first; no auto-prune worktrees |
| Lesson-spool | spool drain | Discord once on consecutive fail |

New code only for true gaps (e.g. schedule zombie cancel with session liveness proof).

### WS3 — Lucy remote ops (inbound only)

**Outbound:** signal-delivery / Discord webhook (not Lucy).  
**Inbound:** Lucy → `x-kookr-admin-token` admin API only.

| Phase | Commands |
|---|---|
| First | `!kookr status`, `!kookr ready` |
| Later | `!kookr free-hung` (wrapper over existing reclaim exemptions) |
| Later | `!kookr run <name>` **allowlist only** (e.g. `lucy-batch`, `kookr-batch`, `lucy-scout`, `kookr-scout`) |
| Defer | free-form cancel prefix, kick toggle, deploy |

#### WS3 security (SHALL)

1. Discord **user allowlist** + fixed **guild + channel** IDs for mutate.
2. Mutate refuses if ready≠200, kill-switch on (except status), free capacity 0 for `run`, cooldown fingerprint.
3. Cancel (if ever): full UUID or ≥12 hex unique match only + confirm step.
4. Audit `{discordUserId, command, argsHash, result}` → `~/.kookr/ops-audit.jsonl`.
5. No shell argv; no free-form schedule IDs; no `!kookr deploy` until security proven.

### WS4 — Observability for absent Jean

1. Edge-triggered Discord pages for: ready fail, dead-man, pipeline starvation episode, hung unreclaimed, dispatch_failed streak, auth_error streak.
2. Optional daily digest via webhook (PRs, empties, kicks, capacity).
3. Health already exposes `pipelineStarvation` — keep; no dual `opsHeal` framework required for v1.

### WS5 — Deferred to other RFCs / later

| Item | Why deferred |
|---|---|
| Cross-repo auto-fill | Product steering; overnight-throughput |
| Umbrella backlog sort / auto-close | Product backlog |
| Runtime settings-store kick flag | Env sticky-on enough |
| Auto-deploy / `!kookr deploy` | High risk; Jean deploys when home |
| Launch errorClass + rotation | Overnight PR5 residual; alert streak first |
| Healer “registry” abstraction | YAGNI |

---

## Phased delivery (reordered)

### Phase 0 — Observe + outbound Discord (1–2 days) — **SUS core**

- Prove webhook pages for dead-man / starvation / ready
- Document recovery card + systemd restart
- Optional read-only Lucy status

### Phase 1 — Host watchdog (1–2 days) — **SUS core**

- Ready-fail restart with cooldown
- Boot digest

### Phase 2 — Hung + residual software heal (2–3 days)

- Verify hung TTL reclaim; fix residual under multi-scout load
- Lesson-spool fail page
- Auth-expiry detection on health

### Phase 3 — Lucy mutate (only if needed)

- free-hung + allowlisted run with full WS3 security

### Phase 4+ — Product fill / launch taxonomy

- Link overnight-throughput; not blocking SUS

---

## Success metrics (unattended windows)

| Metric | Target |
|---|---|
| Hours ready=200 + working (or honest idle empty) during Jean offline | maximize |
| Unplanned multi-hour dead (ready failing, **no** self-restart attempt) | 0 for software causes |
| Hours free≥3 + eligible work + zero implementer | ≤1h (product loop; overnight RFC) |
| Discord page latency on critical edges | ≤15m |
| False auto-restart storms | 0 (cooldown) |
| Remote mutate commands in v1 | **minimize** (status first; mutate only if auto-heal fails) |

---

## Risks

| Risk | Mitigation |
|---|---|
| Auto-restart data corruption | Only restart on ready fail; drain mode first when possible |
| Discord bot as attack surface | Operator allowlist; constant-time admin token; rate limit |
| Cross-repo thrash | Shared admission + one kick/repo cooldown |
| Over-eager prune | Dry-run first; byte caps; exclude critical state |
| Agent-dependent healers | Forbid playbook-only recovery for hung/capacity |

---

## Open questions

1. Should ops flags live in settings-store, SQLite, or keep env + restart for v1?
2. Lucy vs pure kookr webhook bot for digests (Lucy already has Discord)?
3. Auto-deploy lag threshold if ever enabled?
4. Multi-host later: is this machine primary forever?

---

## Evidence from live run (2026-08-03)

### What worked

- Manual schedule run-now for Lucy + Kookr batches launched sessions.
- Product empty detection + starvation scout spawn + `kickBatchWhenScoutCompletes=true`.
- Concurrent empty class ignored sibling NO-OPs earlier.
- Kookr batch acquired implementer children (work progressing on kookr).

### What hurt unattended confidence

- Lucy open set was **100% non-eligible umbrellas** → no PRs until scout refill completes and kick runs.
- hungSuspect residual without automatic free-hung.
- resourceWatchdog off.
- No Discord page of “Lucy starved; scout e42592ca running; kick armed.”
- Jean would not know without opening dashboard.

### Idea scouts launched for backlog generation

Three focused repository-idea-scout runs (publish-safe, full-day) with extraInstruction aimed at this RFC’s themes:

| Repo | Schedule | Task id (prefix) | Focus |
|---|---|---|---|
| jeanibarz/lucy | Twice-Daily Idea Scout | `573dafdb` | Remote operability, Discord control, Lucy↔kookr, MTTR |
| kookr-ai/kookr | Nightly Idea Scout | `a30dacdd` | Autonomy, self-heal, hung/capacity, launch reliability |
| jeanibarz/knowledge-base-mcp-server | Nightly Idea Scout (enabled for run) | `93447012` | Ops memory / runbooks for agents |

Also running: starvation refill scout `e42592ca` (lucy), pre-existing kookr scout `a5a0163c`, kookr parallel batch `d92c9dcb` with children.

---

## Critic feedback incorporated

### Round 1 (2026-08-03)

Critics: `failure-mode-analyst`, `design-minimalist`.

| Finding | Disposition |
|---|---|
| Lucy mutate = high-privilege; one-line security model | **Incorporated** — WS3 security SHALL block; mutate deferred after host plane |
| Host plane after Discord inverted for MTTR | **Incorporated** — phase reorder: host watchdog before mutate |
| Scope packs product (WS5/6/7/9) into ops RFC | **Incorporated** — SUS + deferred table; link overnight-throughput |
| Digests via Lucy = second SPOF | **Incorporated** — outbound webhook; Lucy inbound-only |
| Healer registry YAGNI | **Incorporated** — enable existing sweeps |
| Auth expiry / dtach / Lucy-down missing | **Incorporated** — failure mode inventory |
| Success metric “≥4 commands” drives bloat | **Incorporated** — minimize mutate |

---

## Appendix A — Recommended immediate ops (no code)

1. Keep `KOOKR_PIPELINE_BATCH_KICK=1` (**done** 2026-08-03).
2. Enable `KOOKR_RESOURCE_WATCHDOG=1` after #1724 caveats.
3. Prove Discord webhook receives dead-man + starvation edges.
4. Ensure systemd `Restart=on-failure` for kookr user unit.
5. Label or close evergreen umbrellas so open-count ≈ implementable-count.
6. After reliability idea-scouts finish, review issued issues before implementing blindly.
