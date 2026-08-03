# RFC: Fast production restart (sidecars outlive the process)

**Status:** Draft (v5 — post consensus attack; framing hardened; ready for user review)
**Date:** 2026-08-03
**Author:** Jean Ibarz (with Grok)

**Evidence pack:** `docs/rfc/rfc-fast-prod-restart-evidence.md` (treat as claims to verify).

---

## Problem

Operators expect bouncing the production Kookr Node process to feel like restarting a local daemon. On a speech-enabled maintainer machine (`KOOKR_STT=true`, `KOOKR_TTS=true`), routine restart wall time is often on the order of **a minute or more** (script exit can be longer when recovery dominates).

That is not “Node is slow.” Warm `/api/health` is usually hundreds of milliseconds (sometimes multi-second under load); cold module load is hundreds of milliseconds; loading hundreds of tasks from SQLite is tens of milliseconds. At least two large costs exist, and they must not be collapsed **or ordered by assertion alone**:

1. **Bundled STT/TTS Docker lifecycle is coupled to the Kookr process.** On SIGTERM, shutdown runs `docker compose down` for STT then TTS **before** releasing `:4800` (intentional race fix). On start, `main()` **awaits** STT health then TTS health **before** `createKookrServer` / listen. Recreating the GPU STT stack alone was measured at **~122 s** to health after a compose recreate; TTS ~**10 s**. STT still always passes `--build` on `up`.
2. **`pnpm prod:restart` deploy success is gated on `/api/ready` via `probe_ready_for_deploy` (issue #1721), not on `/api/health`.** Listen-early already landed: deferred recovery runs after bind, and the script waits until ready is no longer `startup-in-progress` (default timeout **1800 s**). Post-deploy smoke then runs by default.

So “restart is slow” can mean any of:

| Clock | Meaning | Typical drivers |
|---|---|---|
| **M1** Process liveness | `GET /api/health` / listener up | Speech compose down/up if coupled; then Node + `createKookrServer` |
| **M2** Deploy ready | `probe_ready_for_deploy` on `/api/ready` | M1 **plus** deferred recovery |
| **M3** Speech warm | containers not cold-started | Compose down/up + model load |
| **M4** Script exit | M2 + optional smoke | Smoke suite after gate |

**Causal claim (hypothesis until pre-change baseline):** speech Docker teardown/cold-start is a **proven multi-minute tax on M1/M3** when containers are recreated (~122 s STT measured). Whether it is the **majority of operator wall clock for `pnpm prod:restart` (M2+smoke)** on today’s corpus is **not yet measured** — recovery alone justified raising the deploy gate timeout from 720s → 1800s on a ~727-task instance. This RFC still ships the speech decoupling (necessary, high-confidence win for M1/M3) but **must not declare “restart feels fast” solely because speech is fixed**.

**This RFC’s product fix is speech coupling (warm M1/M3).** It does **not** claim that fixing sidecars alone makes **`pnpm prod:restart` exit quickly** on a large task corpus (M2). It requires **phase timings** and a **pre-change full wall-clock baseline** so operators and implementers see which clock dominates before and after.

`pnpm prod:update` also pays install + full build — a **separate** cost. Split timings must make build vs restart vs recovery vs smoke obvious.

---

## Goals

1. **Eliminate multi-minute GPU speech teardown/cold-start from routine process restart** when sidecars are already healthy and speech config is unchanged (**M3**: container `Id`/`StartedAt` stable).
2. **Put process liveness (M1) in the warm-Node regime on that path.** Target after P1: **p95 ≤ 3 s** SIGTERM→first `/api/health` 200 when sidecars pre-healthy — **as a hypothesis to confirm with R12 measurement**, not a marketing claim pre-baseline. Report measured p50; do not invent ≤500 ms.
3. **Keep deploy-ready semantics honest (M2):** `pnpm prod:restart` still waits on `/api/ready` / recovery; print phase timings including a **dominant-phase** line.
4. **Ship a real GPU reclaim path** (`pnpm prod:stop --with-sidecars`) with compose/flag parity to start.
5. **Prefer existing managers and scripts** — no second orchestration stack, no blue-green in v1.

---

## Non-goals

- Sub-second **script exit** (M2) on large corpora — recovery is a follow-up if residual M2 remains multi-minute after P1 (measure, then decide).
- Sub-second `pnpm prod:update` including build.
- Listen-before-speech / mutable speech capability (**P2**) — only if measured post-P1 residual warm speech wait matters.
- Blue-green / socket activation / SO_REUSEPORT.
- Relay lifecycle redesign; STT/TTS model/image quality changes.
- systemd required; in-process orphan sweeper; multi-instance namespaced speech ports (document single-owner of 8003/8004).
- Dual lifecycle env modes for “emergency re-couple on every SIGTERM” (see Design — detach is code default; rollback is git revert).
- Making speech critical on `/api/ready`.

---

## Success criteria (P1 must)

- Warm-sidecar routine restart: STT/TTS container `Id`/`StartedAt` **unchanged**.
- Unit tests: healthy reuse path ⇒ **zero** `docker`/`compose` invocations; SIGTERM path ⇒ **no** `compose down`.
- STT: no unconditional `--build`; rebuild only when build inputs changed (TTS-style stamp) or image missing.
- Reuse predicate: see **R11** (must match **live Whisper health semantics**, not Parakeet field names); multi-try before any compose mutate.
- `pnpm prod:stop --with-sidecars` removes the **same** containers start created (GPU overlay parity); plain `prod:stop` leaves sidecars and prints a one-line GPU hint.
- `prod-restart.sh` phase timings: port free, first health (M1), deploy-ready (M2), smoke end; plus **dominant phase** summary.
- R12 PR evidence (hard gate, including **pre-change**): (1) full phase breakdown of current `pnpm prod:restart` before behavior change (stop / M1 / M2 / smoke + container StartedAt), (2) post-change **second** warm restart with stable `StartedAt`, (3) speech-off or URL-mode control for residual M1 floor, (4) residual **M2** duration reported. If pre-change shows recovery ≫ speech, P1 still ships for M1/M3 but the PR must open or link a recovery follow-up as the next operator-facing priority — not leave “optional forever.”
- Docs: restart no longer frees GPU by default; cold path (sidecars missing) may still be multi-minute pre-listen — unchanged and explicit.
- First post-upgrade restart may still pay one cold hit if the **old** binary downs containers before the new one starts — call out in PR notes.

---

## Requirements

- **R1.** Routine SIGTERM SHALL NOT `compose down` bundled STT/TTS (code default detach).
- **R2.** Healthy reuse SHALL NOT invoke any compose mutation; unhealthy path uses multi-try health (see Design) before `up`.
- **R3.** STT SHALL NOT unconditional `--build`; use TTS-style build-stamp (or equivalent) for rebuild triggers.
- **R4.** Deploy gate remains `probe_ready_for_deploy` on `/api/ready` (#1721). Early poll interval ≤ 200 ms (or backoff) as part of timing work.
- **R5.** Phase timings + dominant-phase line on `prod:restart`.
- **R6.** `pnpm prod:stop` stops Node; **`--with-sidecars` required** to free GPU. Always print hint when sidecars left running. Stop order: **Node first, then sidecars**.
- **R7.** Detach is **code default** in the server (do not call manager stop on SIGTERM). No sticky env required for the happy path. systemd / pid-file paths both get detach because behavior is in process code, not script export. (Script may still document that unit files must not assume containers die with the service.)
- **R8.** Logs: reused / started (reason=…) / skipped-external; on reuse log backend/status and inspect-derived model if checked.
- **R9.** Linux required for success claim; macOS follow-up unless proven same PR.
- **R10.** No new proxy/mesh/multi-port public surface.
- **R11.** Reuse identity (empirically constrained — live prod `GET :8003/health` on Whisper path returns e.g. `status:ok`, `backend:whisper`, `model_loaded:false`, `model_name:parakeet-tdt-0.6b-v3`). Therefore P1 **MUST NOT** treat `model_loaded === true` as required, and **MUST NOT** compare `model_name` to `WHISPER_MODEL` (that field is Parakeet `MODEL_VERSION`, not the Whisper model). P1 reuse predicate:
  1. HTTP success + JSON parse + `status === 'ok'` (or equivalent ok signal).
  2. If `backend` present, it must match expected bundled backend (e.g. `whisper` when that is the compose path).
  3. **Model/config identity for Whisper:** prefer `docker inspect` on the whisper service container env (e.g. `WHISPER_MODEL` / image) vs desired env; if inspect is unavailable, **docs-only** for model/device/port changes (`prod:stop --with-sidecars` then start) and log clearly that health-only reuse does not verify Whisper model. Optional follow-up (not blocking P1): fix STT `/health` to report the active Whisper model and a real ready bit — then tighten predicate.
  4. Multi-try before mutate; log distinct reasons: flaky / unparseable / identity-mismatch / missing.
  5. TTS: HTTP ok + parseable JSON only (payload is minimal `{"status":"ok"}` today).
- **R12.** Real `kookr-prod` evidence as in Success criteria (including residual M2 + speech-off control).
- **R13.** Failed cold start that never becomes healthy SHALL still `compose down` (failed-start cleanup) — detach must not turn `stop()` into a universal no-op for that path.
- **R14.** `prod:stop --with-sidecars` SHALL use the **same compose project identity** as managers (shared helper or small Node entrypoint), not a third hand-maintained bash recipe. Fallback: `docker stop/rm` fixed names `kookr-stt`, `kookr-stt-whisper`, `kookr-tts` only if compose parity cannot be shared in v1 — prefer shared helper.

---

## Design

### v1 scope = P1 only

| In P1 | Out of P1 |
|---|---|
| Detach on SIGTERM | P2 listen-before-speech |
| Probe-before-up + multi-try + light identity | Full fingerprint hash framework |
| Drop STT `--build` + TTS-style stamp | Blue-green |
| `prod:stop --with-sidecars` | Orphan sweeper timer |
| Phase timings + dominant phase | Recovery performance rewrite |
| Docs + R12 measurements | Multi-instance port namespaces |

Deferred one-liners (not design sketches): **P2** = bind before cold speech attach only if measured; **recovery RFC** = if residual M2 multi-minute after P1; **packaging** = optional external URL / systemd examples in docs when someone asks.

### Policy ladder (single control plane)

Ordered, exclusive intents:

1. **Failed-start cleanup** → always `compose down` (manager start timeout path).
2. **`prod:stop --with-sidecars`** → stop Node → then compose down (operator GPU free).
3. **Routine SIGTERM / `prod:restart` / systemd restart** → **detach** (never down sidecars).
4. **Rollback** → **git revert** of the PR (not a sticky “stop on every exit” env mode that reintroduces the historical race).

There is **no** supported dual mode that re-couples speech teardown to every process exit in v1. That removes R7 force-export complexity (round-2 minimalist) while still meeting “sticky env cannot re-couple” because the code path simply never downs on SIGTERM.

### Option analysis (short)

| Option | Verdict |
|---|---|
| A. Sidecars outlive process | **Chosen** |
| B. Always external URL | Supported control / packaging path |
| C. Bind before speech only | Deferred P2; insufficient alone if still downing containers |
| D. Blue-green | Deferred |
| E. Poll-only | Micro-fix inside timings |
| F. Full fingerprint subsystem | Rejected; light health identity only |

### P1 mechanics

#### Shutdown

```text
SIGTERM:
  lifecycleAc.abort()
  // do NOT call sttManager.stop() / ttsManager.stop()
  server.close()
  exit(0)
```

Managers keep a real `stop()` = `compose down` for failed-start and for a **shared teardown entrypoint** used by `prod:stop --with-sidecars`.

#### Start (bundled)

```text
if external URL: use it
else if bundled:
  for attempt in 1..N (short backoff; default N=3, ~100–200ms — tune if false-mutate appears):
    if reuse predicate (R11) OK:
      log reusing (log backend/status; log inspect model if checked)
      return manager  // zero docker calls
  // only after multi-try failure:
  compose up -d  // --build only if stamp says rebuild / image missing
  // if containers exist but identity mismatched, prefer compose up that
  // forces recreate (document/verify on host compose); if up fails on
  // name conflict, down then up once
  wait health
  on timeout: stop() + throw
```

TTS reuse: **no** synthesis probe.

#### STT build policy

Mirror TTS: stamp file / input hash over Dockerfile + relevant context; `--build` only when hash changes or image absent.

#### `prod:stop`

```text
pnpm prod:stop                 # stop Node on KOOKR_PORT; print GPU hint
pnpm prod:stop --with-sidecars # Node first, then shared sidecar teardown
```

Resolve `APP_DIR` like restart (`kookr-prod` / systemd cwd). Prefer `node …/stop-sidecars` importing the same compose flag builder as managers.

#### `prod-restart.sh`

- Keep ready gate (#1721).
- Phase timings + dominant phase.
- Fix stale comment that claims listen-only-after-full-recovery (implementation PR).
- Do not invent stop-on-exit env for restart.

#### Historical race

Default detach ⇒ race gone (no concurrent down+up on restart). `prod:stop --with-sidecars` is serial by operator intent.

#### Operator contract

- Restart/update leave speech containers running.
- Free GPU: `pnpm prod:stop --with-sidecars`. Plain `prod:stop` always prints a GPU-still-running hint.
- Speech config change (model/device/image/ports): `prod:stop --with-sidecars` then start (unless inspect-based identity covers the field and forces recreate).
- One bundled-speech owner of default ports; dual instance → URL mode or disable speech on one side. On conflict/port squatter: fail loud (do not silently “reuse” unknown HTTP 200 without parseable expected health shape).
- **`prod:stop --with-sidecars` only tears down bundled stacks when this instance would have owned them** (bundled mode / same APP_DIR project). If only external URLs are configured, do **not** clobber foreign containers unless an explicit `--force-sidecars` is added later (default: skip compose down + warn).
- **Docker `restart: unless-stopped`:** after detach, sidecars can return on Docker/host reboot without Kookr. That is accepted for P1 (warm speech survives reboots); reclaim remains `prod:stop --with-sidecars`. Document so operators are not surprised by GPU use with Kookr down.

#### Delivery atomicity (round-3 delivery-pragmatist)

**One PR (preferred), two commits max:**

1. Optional: phase timings + baseline capture.
2. **Atomic must-land-together:** shutdown detach + manager reuse/stamp + `prod:stop` shared teardown + unit tests + docs.

Do **not** merge detach without zero-compose reuse, or detach+reuse without `prod:stop --with-sidecars`. R12 after deploy: measure **second** warm restart (first may still be old-binary cold hit).

#### Cold path honesty

If sidecars are down (first boot of day, after stop-with-sidecars, Docker restart), M1 may still wait on full STT/TTS cold start **before listen** in v1. That is **explicitly unchanged**. P1 optimizes the **warm** routine restart path.

---

## Files to change

| File | Change |
|---|---|
| `src/server/shutdown.ts` | Do not call manager stop on SIGTERM |
| `src/server/stt-manager.ts` | multi-try + identity reuse; stamp; no hot `--build`; failed-start down |
| `src/server/tts-manager.ts` | multi-try reuse; skip synthesis probe on reuse |
| Shared compose helper or `stop-sidecars` entry | prod:stop parity |
| Manager unit tests | zero docker on reuse; no down on detach; mismatch → up path |
| `scripts/prod-restart.sh` | phase timings; poll; fix stale comment |
| `scripts/prod-stop.sh` + `package.json` | new command |
| Docs: configuration + troubleshooting (+ env-ref one-liner) | GPU ownership contract |

---

## Edge cases

| Case | Behavior |
|---|---|
| Flaky single health fail | multi-try before mutate |
| Healthy wrong Whisper model | inspect env mismatch → recreate; if no inspect, docs require stop-with-sidecars |
| Port returns non-JSON 200 | not identity OK → up path or error |
| systemd restart | detach via code default |
| First upgrade after merge | old binary may down once |
| Dual instance STT=true | document; fail/degrade on conflict |
| `prod:stop` while Node still holding URLs | Node first invariant |
| Large recovery after fast M1 | M2 slow; timings show it; out of scope to fix here |

---

## Alternatives considered

| Alternative | Why not v1 |
|---|---|
| Gate deploy on `/api/health` again | Undoes #1721 |
| Claim sub-second `prod:restart` via speech alone | False on recovery-bound M2 |
| Full fingerprint subsystem | YAGNI vs light health identity |
| Dual env lifecycle mode | Reintroduces race class; rollback = revert |
| P2 in same PR | Not needed for warm path |
| External-URL-only | Breaks one-flag UX; keep as control |
| Blue-green | Overkill after warm M1 |

---

## Open questions (closed for v1)

| # | Decision |
|---|---|
| prod:stop default | **Require `--with-sidecars`**; always hint when GPU left running |
| health identity | **R11 as rewritten in v4** — do not use Parakeet `model_name`/`model_loaded` against Whisper; inspect-or-docs for model config |
| residual M2 | **Measure in R12**; open recovery follow-up only if still multi-minute; **P1 is still done** if M1/M3 succeed and M2 residual is reported |
| smoke narrative | **Stays on by default**; own timing phase; docs say script exit ≠ M1 |
| p95 ≤ 3s M1 | **Hypothesis** — R12 reports actuals; miss does not reopen speech scope if speech-off control shows same floor |
| Docker reboot auto-start sidecars | **Accepted** for P1; document |

---

## Implementation plan (after approval)

1. Optional commit: phase timings + pre-change baseline.
2. **Atomic PR body:** shutdown detach + managers (multi-try, R11 predicate, STT stamp) + shared teardown + `prod:stop` + tests + docs. Do not half-merge.
3. Deploy to `kookr-prod`; R12 **second** warm restart + speech-off control + residual M2.
4. Follow-ups only if measured: recovery RFC (M2), P2 (cold speech pre-listen), STT health contract fix (honest Whisper model/ready fields).

---

## Critic feedback incorporated

### Round 1 (2026-08-03)

**Panel:** boundary-critic, failure-mode-analyst, design-minimalist, socratic-challenger, ambition-amplifier (N=5).

| Critic | Disposition |
|---|---|
| boundary-critic | **Used:** gate=`/api/ready`; metric split; failed-start vs detach; `prod:stop` owner. **Rejected for v1:** mandatory ComposeSidecarLifecycle module (shared helper only for teardown flags). |
| failure-mode-analyst | **Used:** drop false p50≤500ms; fingerprint cut; evidence pack rewrite; orphan contract; zero-compose tests. |
| design-minimalist | **Used:** v1=P1 only; no policy enum if simply not calling stop. |
| socratic-challenger | **Used:** M1–M4 clocks; smoke phase; #1721 context; P1 without P2. |
| ambition-amplifier | **Used:** GPU reclaim as product surface; honest budgets; split timings. **Rejected:** blue-green, sweeper, multi-instance namespaces. |
| design-experimenter | **CONFIRMED** gate, 1800s, speech-before-server, shutdown-down, STT `--build`. |

**Ambition vs minimalist (R1):** minimalist on scope (P1 only); amplifier on metrics honesty + teardown surface.

### Round 2 (2026-08-03)

**Panel:** boundary-critic, failure-mode-analyst, design-minimalist, socratic-challenger, ambition-amplifier (N=5).

| Critic | Disposition |
|---|---|
| boundary-critic | **Used:** policy ladder; teardown mechanism parity (R14); Node-then-sidecars; R7 reframed as code default not child export only. |
| failure-mode-analyst | **Used:** multi-try before compose mutate; richer reuse predicate; systemd covered by code default; prod:stop compose parity; close Q1/Q2. |
| design-minimalist | **Used:** delete dual-mode `STOP_ON_EXIT` env + force-export story; cut P1.5 soft-scope; shrink P2/P3/P4 design body. **Partial reject from ambition:** STT stamp kept as P1 must; naive model_name check later corrected in v4. |
| socratic-challenger | **Used:** cold-path honesty; operator clock vs M1; residual floor control in R12; stop mechanics; config drift. |
| ambition-amplifier | **Used:** STT build-stamp as P1 must; light identity check as P1 must; residual M2 measurement in acceptance. **Agreed smaller:** P2, blue-green, sweeper, multi-instance. |

**Ambition vs minimalist (R2):** agreed delete dual-mode env; disagreed on stamp/identity — **kept stamp as P1 must**; identity rewritten in R3/v4 after live health falsified naive `model_name` check.

### Round 3 (2026-08-03)

**Panel:** boundary-critic, failure-mode-analyst, design-minimalist, socratic-challenger, delivery-pragmatist (N=5; ambition skipped — no new deferred-feature list).

| Critic | Disposition |
|---|---|
| boundary-critic | **Converged** — no substantive findings; minor: single shared teardown path, pin GPU flags at stop (incorporated in R14 / operator contract). |
| failure-mode-analyst | **Used (critical):** live Whisper health falsifies R11 `model_name`/`model_loaded` — **rewrote R11** with live sample + inspect-or-docs. **Used:** multi-try reasons; teardown flag parity; external URL stop must not clobber. |
| design-minimalist | **Converged** — minimal enough; implement without policy enum / dual recipes. |
| socratic-challenger | **Used:** R11 rewrite; reboot/`unless-stopped` contract; P1 done even if M2 residual; stop external-URL safety; 3s as hypothesis. |
| delivery-pragmatist | **Used:** atomic PR rule (detach+reuse+prod:stop together); R12 second-restart protocol; rollback notes. |

**design-experimenter (live recheck during R3 triage):** `curl :8003/health` → `model_loaded:false`, `model_name:parakeet-tdt-0.6b-v3`, `backend:whisper` while service is healthy — confirms F1/F2.

**Intent preservation check:** User asked for best design options toward fast/sub-second restart. v4 still targets warm M1/M3, refuses false M2 claims, and keeps measured follow-ups for recovery/P2. Identity correction prevents shipping a “fix” that forces recreate every restart.

### Early convergence

Round 3 produced one critical empirical fix (R11) and delivery atomicity — both folded into v4. No further critic rounds after v5 framing fix.

### Consensus attack (2026-08-03)

**general-purpose:** consensus-attack — **finding (framing)**  

Shared assumption: speech is the *primary* cause of operator-facing multi-minute restart; recovery is a separable residual.  

Scenario: P1 succeeds on M1/M3 while M2 remains ~10 minutes; operator still waits; RFC marks P1 “done.”  

Avoided question: on one full timed `prod:restart`, what share is speech vs recovery vs smoke — and if recovery dominates, why is speech the primary product RFC rather than a prerequisite slice?

**Disposition: used in v5** — causal claim labeled hypothesis; pre-change full baseline is a hard R12 gate; if recovery dominates pre-change, PR must open/link recovery follow-up as next operator priority. Detach design unchanged (still correct for M1/M3). Did **not** pivot the RFC into a recovery rewrite without measurement (that would reverse the “measure then decide” rule).

**Intent preservation check:** User asked for best design options toward fast restart. v5 keeps speech-decoupling as the implementable win, refuses false “script is fast” claims, and forces the missing full-profile measurement so the next step (speech-only vs recovery-first) is evidence-based rather than framed-in.

---

## Meta-analysis readiness

Trace: `docs/rfc/meta/rfc-fast-prod-restart.critic-trace.jsonl`.
