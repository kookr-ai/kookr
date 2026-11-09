# RFC: opencode worker containers: A2A, scaling, shared layered memory

**Status:** Draft v4 (post review rounds 1-2 and consensus attack; awaiting independent review)
**Date:** 2026-11-09
**Author:** Jean Ibarz (with Claude)

---

## Summary

Add a second **launch mode** to the existing `opencode` agent type: instead of
a TUI in a dtach terminal on the host, Kookr starts one hardened container per
task running `opencode serve` plus the community A2A wrapper
(`opencode-a2a`). Kookr drives it over A2A (`message:send`, `tasks/get`,
`tasks/cancel`), keeps the existing hook plugin (it runs inside the server),
and gives workers a shared, layered, single-writer memory (project > domain >
global) built on the existing `nb` notebooks. Phase A is Docker on this one
host, no Kubernetes. Phase B (kagent BYO, Agent Sandbox, agentgateway) is an
appendix with the cheap test that would justify it. It stays behind
`KOOKR_OPENCODE_ENABLED`, plus a second opt-in `KOOKR_OPENCODE_CONTAINERS=1`.
The mode is resolved once at launch and persisted on the task; there is **no
silent fallback** to host TUI mode (that would drop the isolation guarantee).

Evidence (all hermetic, mock provider, temp state; reproducible from
`docs/rfc/evidence/prototype-opencode-worker/` (moves to `deploy/opencode-worker/` in Slice 1)):
[spike 1 hooks under serve](evidence/opencode-containers-spike1-serve-hooks.md),
[spike 2 container + A2A](evidence/opencode-containers-spike2-a2a-container.md),
[spike 3 shared memory](evidence/opencode-containers-spike3-shared-memory.md).

## Problem

1. Host TUI workers cost 0.6-1.2 GB each, share the host filesystem and the
   operator's credentials, and cannot be limited beyond a heap cap.
2. There is no network-addressable worker: no A2A, so no peer agents and no path
   to a second host.
3. Worker memory is per profile on one host path; N workers cannot safely
   write to the same notebooks and a worker can read every shelf.
4. Hermes' A2A has known gaps: tasks lost on restart, `cancel` only flips a
   flag (tool subprocess keeps running), stream drop marks the task FAILED.

## Requirements

- R1 Hooks, usage accounting, deliverable gate, stop re-prompt and resume keep
  working for container workers (parity with the TUI mode).
- R2 Cancel must actually stop tool execution; task state must survive a
  container restart.
- R3 Per-worker isolation: non-root, no capabilities, read-only root, memory,
  CPU and pid caps, tmpfs scratch; secrets only via 0600 files, never env, never baked.
- R4 Shared memory: one writer, no lost lessons under concurrent writers,
  project > domain > global precedence with size caps, no cross-project
  read or write. Reuse `nb`; no new memory format.
- R5 Supervision parity: Kookr can launch, observe, message, stop, reap, and
  recover a container worker with the same task lifecycle.
- R6 Rollback: flag off restores today's behaviour with no data migration.
- R7 Do not preclude Phase B: A2A-speaking image, config as files/env only,
  no host-only paths in the worker contract.

## Findings that shape the design (Spikes 1-3)

| # | Finding | Consequence |
| --- | --- | --- |
| F1 | The Kookr plugin loads inside the opencode *server*; under `serve` all hooks fire (SessionStart + stdout context, UserPromptSubmit, Pre/PostToolUse, Stop exit-2 re-prompt via `ctx.client`), usage is in message `tokens`. | No new hook mechanism. One `serve` process = one Kookr task (plugin state, SessionStart and the gate counters are per server). |
| F2 | `opencode-a2a` 1.4.0 (A2A 1.0, SQLite task store, bearer auth) works in a read-only container; card public, API 401 without token. | Use it pinned by hash; do not write our own wrapper. |
| F3 | `tasks:cancel` calls opencode `session.abort`; a running `sleep 120` tool was gone in under 2 s. | R2 met for cancel. |
| F4 | Task store survives `docker rm` + new container on the same `/data` volume. | R2 met for restart. |
| F5 | With a streaming client attached, cancel returned `CANCELED` but a later GET showed `FAILED` (1 run). | Kookr always reads final state after the stream closes and treats `CANCELED`-then-`FAILED` as cancelled when it issued the cancel. Report upstream. |
| F6 | Unseeded cold start: first message 12.7 s, 830 MiB (plugin deps installed at boot into tmpfs, needs network). Seeded at image build: 1.7 s, ~400 MiB. | Seed baked and symlinked read-only. |
| F7 | 4 and 8 containers: ~0.4 GB each, linear, all healthy in 9-11 s, 8 parallel first messages in 3.1 s (one earlier run 35 s, not reproduced). | RAM is not the limit on a 31 GB host; disk and provider rate limits are. |
| F8 | One of 4 parallel starts hung: the entrypoint health `curl` had no timeout. Fixed. | Supervisor must also enforce a readiness timeout (see Failure modes). |
| F10 | **Verified in round 1:** a git *worktree* mounted into the container is not a repository (its `.git` file points at a host path); a per-task `git clone --local` mounted at `/work` commits normally. | Workers get a per-task clone, not a worktree (Design 2). |
| F11 | **Verified in round 1:** the Spike-2 entrypoint used `wait -n`, which dash lacks, so it did not exit when the wrapper died. Fixed with a poll loop; killing either child now stops the container (exit 1). | Entrypoint is tested per child death (Slice 1 gate). |
| F9 | Memory spike: single writer + per-project read-only view: 30 concurrent writes from 2 writers all present, 60 concurrent reads 0 torn, projB worker sees 0 projA data, bad token 401. | Memory design below. |

Hermes figures to beat (known, not re-measured here): ~2-2.6 GB per container,
3 GB cap. Measured opencode container: ~0.4 GB idle with the mock provider.
**Not measured:** real-model task RSS (the mock never reads large files or
runs test suites). The TUI reference measured 0.6-1.2 GB under real tasks, so
plan capacity with 1.2 GB per container until the first real-model run
(Slice 4) replaces the number.

## Design

### 1. Worker image (`docs/rfc/evidence/prototype-opencode-worker/` (moves to `deploy/opencode-worker/` in Slice 1))

Debian slim (python 3.12 + node binary copied), digest-pinned bases; opencode
1.19.5 from a lockfile with sha512 integrity; `opencode-a2a==1.4.0` with
`--require-hashes`; `nb` 0.7.0; plugin deps seeded at build. Nothing
task-specific is baked: `/cfg` (read-only: `opencode.json`, `plugins/kookr.js`,
`AGENTS.md`, composed by the existing home composer), `/work` (the task's git
per-task git clone, rw), `/data` (bind mount: opencode sqlite + A2A task store),
`/memory` (the project view, ro). Entrypoint: `opencode serve` on
127.0.0.1 with a generated password, A2A wrapper on `:8000` with a bearer
token; both secrets read from 0600 files in `/run/secrets` (never env, never baked). Exits if either child dies.

### 2. Container runtime: a sibling adapter, not a branch

**Boundaries (review: boundary-critic).** Container mode is a different runtime
kind, so it is a separate `OpenCodeContainerAdapter` (same `AgentType`
`opencode`, same profiles, same task metadata), chosen by a **launch-policy
resolver** outside the adapters: it reads `KOOKR_OPENCODE_CONTAINERS`, persists
`metadata.opencodeLaunchMode = tui|container` on the task, and every
relaunch/resume obeys the persisted value. The code both adapters need (home
composition, task-data dir and ownership marker, usage sum from the opencode DB,
session-id storage) is extracted from `opencode-adapter.ts` into a shared
"opencode session preparer"; the TUI adapter is refactored onto it in Slice 2
with no behaviour change. Collaborators behind ports (all fakeable in tests):
`DockerRunner`, `A2aClient` (owns the F5 workaround), `ContainerReconciler`.

**Launch.**
1. Compose the session dir as today (config, plugin, profile `AGENTS.md`, layered
   memory pack built host-side, see 3), mounted read-only at `/cfg`.
2. **Git**: `git clone --local` of the target repo into a per-task dir mounted
   at `/work` (F10). The worker commits locally; the deliverable (local commit,
   never a push) is fetched by Kookr from that clone. Pushing from inside is not
   offered: no credentials are mounted.
3. **Hooks run in the container.** The hook scripts the plugin calls
   (`kookr-opencode-gate.js`, `nb-inject`, `nb-retro`, `kookr-stop-nudge`) are
   mounted read-only at `/kookr-hooks` from the Kookr install and run by the
   image's node; the plugin's hook command appends events to a per-task ledger
   file in `/kookr-spool` (rw, one dir per task), never to `localhost`. The host
   ingests that file with the existing writer path, **keyed by `taskId` +
   launch token** (not a terminal name) so adopt after a restart keeps event
   identity. Slice 1/2 gate: the gate's exit-2 re-prompt is exercised inside a
   container end to end.
4. `docker run -d --name kookr-oc-<taskId8>-<token>` with the Spike-2 hardening
   flags, `--memory 2g` by default (tmpfs counts against it), `--cpus 2`,
   `--pids-limit 512`, `--log-opt max-size=10m max-file=3`, labels
   `kookr.task`, `kookr.launch`, `kookr.instance=<this server's id>`, a
   per-task data **bind mount** (the existing task-data dir, so retention sweep,
   resume and `peek` keep working; one place, no named volume), publish `:8000`
   on **127.0.0.1 only**, one private docker network per worker (only the memory
   writer is attached to it, so workers cannot reach each other).
5. **Secrets** (A2A bearer token, opencode password, provider key) are written
   0600 to a per-task secrets dir mounted at `/run/secrets` and read by the
   entrypoint, not passed via env (`docker inspect` and `env` would leak them). The secrets
   dir lives under the task's private runtime dir, which is excluded from task snapshots
   and archives and deleted on stop and at reconcile.
   Kookr keeps the token and the published port in the task's private metadata
   so an adopted container stays controllable after a Kookr restart (tested).
6. **Readiness** = `HEALTHCHECK` (opencode `/global/health` and the wrapper) **and**
   an observed `SessionStart` + canary ack in the ledger, 60 s ceiling, with
   distinct failure reasons (`image_missing`, `docker_down`, `health_timeout`,
   `plugin_not_loaded`, `a2a_unauth`). On failure `docker rm -f` by the
   label-checked name.
7. Prompt delivery: A2A `message:send` (`returnImmediately: true`); record
   `taskId`/`contextId`.

**Input and control.** Container sessions declare `deliveryChannel: 'a2a'`:
`sendInput` goes to A2A `message:send` on the same context; `sendKeystroke`
throws a typed `Unsupported`. Every existing `sendInput` caller (nudges, UI) is
audited in Slice 2. **Stop** = A2A `tasks/cancel`, then opencode
`session.abort` if the task already reads terminal (a Stop-hook re-prompt runs
a turn after the wrapper marked its task `COMPLETED`; this must be tested in the
Slice 2 gate), then `docker stop -t 10`, `docker rm`; then the usual stop path.
A2A task state is advisory: **truth for "done/working" is the hook ledger plus
the container state**, never the A2A task alone.

**One liveness authority.** The container is the single source of truth. The
`docker logs -f` supervisor session, if the existing machinery needs a session at
all, is a derived, disposable view recreated on demand (Slice 2 first
confirms whether a session-less task is possible; if so the shim is cut). A
per-task probe loop (30 s) records `docker inspect` (State, OOMKilled,
ExitCode, RestartCount), A2A `tasks/get`, ledger recency and ingest lag, and
cgroup memory; the watchdog's container-mode rules are defined on those inputs,
not on pane freezing.

**Reconcile, not just adopt.** A periodic reconciler (and once at start) lists
`docker ps -a` by label **and `kookr.instance` == this server** (another Kookr
on the same daemon is never touched). Non-terminal task: adopt. Terminal task:
stop+remove after retention. Unknown task: **quarantine** (stop, keep) for 24 h,
then remove, only for names starting `kookr-oc-` with matching labels; every action
is written to a durable log. `kookr containers ls` shows task, state, age, orphan?.

**Per-task read-model** (one record, shown in `kookr status/peek` and UI):
`{launchMode, kookrState, containerState, a2aState, lastHookAt, lastProbeAt,
ingestLagMs, restarts, oomKilled, memBytes, diskBytes, imageDigest, launchToken,
memoryViewVersion, divergence}`.

No change to `AgentType`, profiles, or the gate's semantics. Container tasks are
non-interactive (attach is log view only; documented).


### 2a. Round-2 additions to Design 2 (v3)

**Workload fit (consensus-attack finding; the review had assumed a container is a useful place to work).**
A worker must build and test the repo, so the base image alone (git, node, python, opencode, nb) is not enough.
Decision: **toolchain layers**. `opencode-worker` stays repo-neutral; a repo supplies a thin derived image
(`FROM opencode-worker@sha256:...` + node, pnpm, whatever its checks need; Kookr's own is
`deploy/opencode-worker/toolchains/kookr.Dockerfile`). Dependencies are not baked: the clone gets
`pnpm install --offline --frozen-lockfile` against the host pnpm store mounted **read-only**
(copy-import into `/work/node_modules`, the only writable place), so no network is needed for installs and
the image stays task-neutral; the per-task disk cost of `node_modules` is measured in S2d and counted in the
capacity numbers. Phase A keeps egress open (provider + registry), so a missing store entry degrades to a
network install, not a failure. A profile is container-eligible only if its toolchain image exists and its
declared checks resolve inside it; otherwise the launch is refused with `toolchain_missing`. Not baked and not
offered: `gh`/push credentials (deliverable is a local commit). The S2d live gate adds a real task, not a
smoke: the existing fix-a-failing-test fixture runs `pnpm test` in the container and its result (tests run,
commit, gate passed) is compared with the TUI run of the same fixture.
Alternative recorded (open question 5): keep workers on the host and sandbox only tool execution; rejected
for Phase A because it does not give per-task resource caps, A2A addressability or a Phase B path, but it
becomes the fallback if the toolchain-layer cost or fidelity gap is too high.

**Hook commands are rewritten for the container (blocking finding, verified in
`opencode-kookr-hooks.ts`: commands embed absolute host paths and the plugin
treats any exit other than 2 as pass, so a missing path = exit 127 = the gate
silently lets every worker stop).** In container mode the composer takes a path
map: node = `/usr/local/bin/node`, hooks = `/kookr-hooks/...`, and
`KOOKR_PR_LINT_CMD` must resolve inside the image; if it does not, the launch is **refused** (never silently dropped: a gate that quietly weakens defeats its purpose).
The hooks dir is a **per-task immutable copy** made at launch (not a bind of the live
install), so a Kookr upgrade mid-task cannot swap hooks under a worker; the
node and hooks versions are recorded on the task. Fail closed: the plugin's
container-mode runner treats exit 126/127 or a spawn error of a *gate* command as a
block ("hook broken") and emits a `hook_broken` ledger event (-> `hooks_blind`),
and the entrypoint self-tests every hook command's executable before reporting
healthy. Slice gate: with a hook path deliberately missing, the worker is blocked
and the task is flagged (the case that would actually happen).

**Git and deliverable extraction.** `git clone --local --no-hardlinks` (the
default hardlinks objects, so a worker with uid 1000 could corrupt the host
repo). Kookr never runs git *in* the clone as a trusted repo: the deliverable gate
runs inside the container; the host extracts the result with
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git fetch <clone>
HEAD:refs/kookr/opencode/<taskId>` into the source repo (no clone-local hooks or
fsmonitor are ever executed on the host; repo-local config is not consulted by
`upload-pack` for hooks), and reads `PR_BODY.md`/`REVIEW.md` as plain files.
Opening the PR from that ref is the existing caller/orchestrator step (the
profile's deliverable is "a local commit, never a push"; unchanged). Slice gate:
commit in container -> ref on host -> host repo `git fsck` clean, with a worker
that tampers with its object files and its `.git/config`.

**uid/gid.** The container runs as the host user's numeric uid:gid
(`--user $(id -u):$(id -g)`, HOME on tmpfs), so the 0600 secrets, the data dir and
the clone work for any host user; tested with uid != 1000.

**Dispatch.** `AdapterRegistry` is keyed by `AgentType` with no task context, so a
second `opencode` adapter would overwrite the first. Decision: register ONE
`OpenCodeRoutingAdapter` under `opencode` (routing wrappers already exist:
preflight skips them) that delegates every call to the TUI or container adapter by
the task's persisted `opencodeLaunchMode`. The routing adapter is the only
mode-aware code. The tmux-name stays an opaque session handle (container adapter
maps handle -> container); the derived `docker logs` session is kept in 2d (smaller
change) and revisited only if it proves flaky.

**Ownership.** Session preparer = compose config/plugin/AGENTS.md + task-data dir and
marker + usage sum + session-id storage only; hook ingestion and sweep stay out.
The reconciler owns container and network objects only; the existing
`sweepTaskData` owns the data dir. Watchdog container-mode rules are a separate
strategy, not branches in the pane-freeze rules. The spool ledger format is a
small shared port between the in-container plugin and the host ingest.

**Reconciler/probe semantics.** Launch writes an *intent record* (task, token,
instance, time) before `docker run`; containers younger than 120 s or with an open
intent are never quarantined. The instance id is a UUID persisted once in
`~/.kookr/instance-id` (created if absent, never regenerated; copying it to
another install is documented as unsupported). Reconcile every 60 s; terminal
retention 24 h; quarantine 24 h; per-worker networks are labelled and reconciled
like containers; the durable log is `~/.kookr/container-reconcile.jsonl`
(`lastReconcileAt` and a failure counter appear in the read-model). Probes have a
5 s timeout; 3 missed probes set health `unknown`, never `healthy`.

Health enum: `healthy | degraded | failed | unknown`. `divergence`:
`none | a2a_ahead_of_ledger | container_dead_task_live | task_terminal_container_live
| probe_stale`. Precedence: container state > ledger > A2A. `hooks_blind` = canary
missing or `ingestLagMs > 120 s` while the container runs; recoverable when lag clears.
`stop_unconfirmed` (with reason) is recorded when `docker stop` fails or times out.
The read-model also carries `memoryWriterState` and `memoryViewAgeS`, and the plugin
counts failed memory writes into the ledger.

**Mode semantics.** Relaunching a task whose persisted mode is `container` with
the flag off is refused with a clear error (the operator may start a fresh TUI task
explicitly); flag off means no *new* container tasks. Code revert with live
containers is covered because Slice 2b (reconciler) ships first and a documented
`kookr containers prune --instance` command removes labelled objects.

### 3. Shared layered memory

Spike-3 design, tightened after review:

- **Layering is composed host-side in TypeScript** (`composeLayeredPack` in
  `opencode-shelf-memory.ts`, reusing `capShelfListing`: top-scored plus newest),
  PROJECT 4 KB > DOMAIN 2 KB > GLOBAL 1 KB, written into the worker's
  `AGENTS.md` at launch. The spike's `layered-pack.mjs` is a prototype and is
  not shipped. Precedence is ordering plus an instruction, not enforcement.
  The pack records a `memoryViewVersion` on the task.
- **`memory-writer`** is the only rw owner of the notebook store, split into
  `scope-policy` (token -> `{actor, project, role}`; target shelf is always
  `<role>@<project>`), `write-queue` and `view-publisher`. Hardening from the
  failure-mode review: errors are isolated **per queue item** (a failing audit or
  publish never wedges the chain), a write acknowledges success once `nb add`
  committed (view publish failure is retried, not reported as a failed lesson),
  `nb` timeout > its 12 s lock wait, tokens are a **runtime registry** (admin
  endpoint with a separate admin token: add at launch, revoke at task end), and
  `/health` + `/metrics` (queue depth, accepted/rejected, last publish, view
  version, dropped writes per worker).
- **Isolation**: a worker mounts only `views/<its project>` read-only and sits
  on its own network with the writer. Fail-open: writer down -> worker uses its
  start-of-session pack and lesson writes log a warning.
- **Other writers**: operator and host-side workers still `nb add` directly into
  the store. The writer republishes all views on start and every 5 min so these
  are picked up; the RFC states plainly that the store has one *managed* writer
  for container workers, not a global lock on the filesystem.
- **Stale reads** by design (next SessionStart). **Promotion** project -> domain
  -> global is a curator verb with its own token scope. Votes, `nb rm`, retro
  go through writer verbs (Slice 3; spike proved only `add`).
- Honest limit: nb evicts at 50 entries per shelf; the writer logs the evicted
  lesson in the audit entry so a loss is recoverable.
- **Simplest alternative kept in reserve** (design-minimalist): bind-mount the
  project shelf rw and domain/global ro and rely on nb's lock; cheaper but no
  audit, no per-worker identity, and a worker can rewrite its whole project shelf.

### 4. Scaling on this host

Limits enforced by Kookr, not by hope: a container count cap
(`KOOKR_OPENCODE_CONTAINERS_MAX`, hard default 4 until Slice 4 measures a real-model number), the existing resource watchdog
(host RAM/disk), launch refusal below 5 % disk (existing), and per-container
`--memory`, `--cpus 2`, `--pids-limit`. Planning numbers: 0.4 GB (mock) to
1.2 GB (assumed real) per container; image 1.36 GB shared across all
containers; each task adds its clone plus a small `/data` dir. With
31 GB RAM the RAM-bound ceiling is far above 8; the binding constraints are
disk (~26 GB free; images and per-task data) and provider rate limits.
Measured: 4 and 8 containers healthy (Spike 2). The Slice 4 gate repeats 4 then
8 with the real provider and records peak RSS, disk and p95 launch time; the
default cap is raised only from that measurement.

### 5. Failure modes

| Failure | Behaviour |
| --- | --- |
| Container fails readiness (60 s) | Launch fails, container removed by label-checked name, task stays launchable. |
| opencode or wrapper dies in the container | Entrypoint exits; supervisor session ends; Kookr's normal dead-worker path (reap/relaunch) applies; `/data` volume keeps session and A2A state so a relaunch resumes the same opencode session. |
| Kookr server restarts | Reconciler adopts own-instance containers; token+port come from private task metadata; A2A state is in the bind-mounted data dir. Stopped containers are found with `docker ps -a`. |
| Wrapper dies but opencode lives (or the reverse) | Entrypoint exits non-zero (F11, tested per child); container state `exited` is the liveness truth. |
| Hook ingest dead or spool unwritable | Canary at SessionStart; ingest lag gauge; task flag `hooks_blind` distinct from `hung_suspect`. |
| Second Kookr on the same Docker daemon | Reconciler only touches `kookr.instance == self`. |
| Flag turned off with containers running | No new containers; running ones are adopted until terminal, then reaped. |
| Docker daemon down (start or mid-run) | Preflight: container launches are refused with `docker_down` (**no silent TUI fallback**; the operator may relaunch with TUI explicitly). Mid-run: tasks flagged `runtime_unreachable`, not dead; no relaunch storm. |
| Cancel race (F5) | Read state after stream close; our own cancel wins. |
| Provider outage / 429 | Same provider-transient retry path as TUI mode (the A2A task reports the failure; the stored launch replays). |
| Memory writer down | Worker boots with the last view (stale but valid); lesson writes fail open with a logged warning; hook never blocks stop. |
| Worker writes junk lessons | Bounded by nb limits, per-token project scope and the audit log; curator can `rm`. |
| Disk pressure | Existing launch refusal; container mode adds image/volume GC for `kookr.task`-labelled objects only, explicit-name based. |
| Leaked secret | 0600 files in `/run/secrets`, never baked into the image; the gate/PR flow is unchanged. Worker egress is unrestricted in Phase A (documented gap, see Open questions); secrets live in 0600 files, not env. |

### 6. Rollback

Unset `KOOKR_OPENCODE_CONTAINERS` (or `KOOKR_OPENCODE_ENABLED`): new launches
use TUI mode. No schema change: container tasks use the same task metadata
(`opencodeSessionId`) and the same data dir. `docker rm -f` of labelled
containers and removing `views/` and the writer leaves the notebook store
untouched (the store is the source of truth; views are derived).

## Slices (each behind the flags, each revertible alone)

Hermetic checks (fake docker, fake A2A) run in the normal PR gate (full suite, tsc,
cycles, docs verifiers, plugin.json bump if `plugin/` changes). Live checks (real
image, real provider, N-times repeats) are an operator-run script under `scripts/`
whose output is recorded in the PR; they are not part of the PR gate and are not
claimed as such.

- **S1 image**: move the prototype to `deploy/opencode-worker/**` (incl. the Kookr toolchain layer) (Dockerfile, hardened entrypoint with
  `/run/secrets`, HEALTHCHECK, log prefixes, distinct exit codes, hook self-test),
  build script, per-child-death test. No Kookr runtime change.
- **S2a**: extract the session preparer from `opencode-adapter.ts` and add the
  launch-policy resolver (always `tui`), characterization tests pinning TUI
  behaviour. No container code.
- **S2b**: ports (`DockerRunner`, `A2aClient`), `ContainerReconciler`, read-model,
  `kookr containers ls/prune`; tested against fakes; inert until a container exists
  (ships the sweeper first).
- **S2c**: hook spool ingest keyed by taskId + launch token (shared ingest port);
  TUI events unchanged and tested.
- **S2d**: `OpenCodeRoutingAdapter` + `OpenCodeContainerAdapter` launch/stop/
  `sendInput`, clone/extract, hook path map, behind `KOOKR_OPENCODE_CONTAINERS`,
  cap 1, static memory pack, no writer. Live script: 10x cancel (incl. `setsid`/
  `nohup`/background tools and cancel during a model call), `kill -9` opencode,
  Stop re-prompt through A2A, host reading the bind-mounted DB, adopt after Kookr
  restart, hook-missing blocks, fsck-clean tamper test, uid != 1000, **one real-model
  smoke that decides wrapper vs plain-REST** before S3.
- **S3 memory**: productised writer (own flag), `composeLayeredPack` in TS, writer
  verbs for vote/rm/retro, worker `nb` shim (image rebuild + pin bump), docs.
- **S4 capacity**: real-model 4 then 8 concurrent run, record peak RSS, disk, p95
  launch; raise the cap default from the measurement; reference doc and runbook.

## Non-goals

Kubernetes, kagent, Agent Sandbox, agentgateway, multi-host, serving
untrusted tenants, replacing TUI mode, an A2A server of our own, a new memory
format, egress filtering (Phase A).

## Alternatives considered

- **Hermes-style container** (2-2.6 GB, in-memory tasks): rejected; its known figures
  (not re-measured here) are worse on every dimension that matters here.
- **`opencode acp` (stdio) behind our own thin bridge**: no HTTP/A2A surface,
  we would own the protocol; the wrapper already exists and is pinned.
- **Direct `opencode serve` REST (no A2A)** : works (F1) and is simpler, but
  forfeits A2A peer interop and the Phase B path; the wrapper adds ~90 MB.
  Kept as the fallback if `opencode-a2a` proves unfit in Slice 4.
- **Multiple sessions per container**: rejected; plugin gate state and
  SessionStart are per server and the wrapper documents one pair as one trust
  boundary.
- **Mounting the whole notebook store read-only**: rejected; every worker
  could read every project's lessons.
- **A database for memory**: rejected; `nb` files + single writer meet R4.

## Open questions

1. Egress policy: should containers be limited to the provider's host? Needs a
   proxy or a docker network with an allowlist; not required for Phase A trust
   (single operator) but must be decided before untrusted prompts.
2. Real-model RSS and the right default cap (Slice 4).
3. `opencode-a2a` 1.4.0 bug F5 and its SQLite store upgrades: pin, vendor a
   patch, or report upstream.
4. Upgrade path: a new opencode pin changes the image digest and the plugin
   API; the version check and the image tag must move together.

5. Toolchain fit: disk and fidelity cost of per-repo toolchain layers and `node_modules` per clone (S2d measures); host-sandboxed tool execution as the fallback.

## Appendix B: Phase B (do not build now)

Only when a second host or untrusted tenants appear. Components and fit:

- **kagent BYO agent**: our worker image already speaks A2A, so it can be
  registered as a BYO Agent CRD; the controller proxies A2A. kagent's memory
  is per-agent pgvector and not shareable across agents, so keep our
  `memory-writer` as the shared layer (do not adopt kagent memory).
- **kubernetes-sigs/agent-sandbox** (Sandbox / SandboxTemplate / SandboxClaim,
  warm pools, scale-to-zero, gVisor/Kata, v1alpha1): replaces `docker run` with
  a SandboxClaim; our entrypoint/config-as-files contract is already what a
  template needs. v1alpha1 means API churn risk.
- **agentgateway**: optional A2A/MCP policy proxy in front of the workers,
  also the natural egress/authorization point (open question 1).
- **Kagenti** (SPIFFE/Istio): skipped as too heavy.

Cheap test that would justify Phase B (run on kind or k3d in under a day):
(1) apply the worker image as a BYO Agent and send A2A `message:send` through the
kagent controller; (2) create a SandboxTemplate from the image and claim 8
sandboxes from a warm pool; measure claim-to-ready (target < 5 s warm vs
~3 s for `docker run` here), cancel semantics through the proxy, and whether
`/data` persistence maps to a PVC. Justification threshold: a second host is
actually needed (disk or provider-concurrency limits hit on this host in
Slice 4), or an untrusted-tenant requirement exists. If neither, stay on
Phase A.

## Critic feedback incorporated

### Round 1 (boundary-critic, failure-mode-analyst, operability-reviewer, design-minimalist), 2026-11-09

Empirical checkpoint (done by the author, 4 probes): dash `wait -n` unsupported, entrypoint fixed and per-child death tested (F11); worktree `.git` breaks git in a container, per-task clone works (F10). The rest of failure-mode's claims are accepted as code-reading findings and become Slice 2 gate tests.

Incorporated: sibling adapter + session preparer + launch-policy resolver (boundary F1, F7); delivery-channel capability and typed Unsupported (F2); container as single liveness authority, supervisor session derived (F3); hooks keyed by taskId+token and run in-container from a mounted hooks dir (F4, failure #2); layering in TS reusing `capShelfListing` (F5); writer split and hardened, runtime tokens, health/metrics (F6, failure #7/#8, operability #8); git clone strategy (failure #1); A2A state advisory + re-prompt test (failure #3); instance label, `-a`, quarantine, periodic reconcile (failure #5, operability #4); secrets via files, loopback publish, network per worker (failure #6/#10); no fail-open to TUI (failure #9, minimalist #4); HEALTHCHECK + ledger canary readiness, probe loop, read-model, log rotation, per-task disk, flag-off behaviour (operability #1-3,5,6,9, failure #12); repeated, wider cancel/kill tests as the Slice 2 gate (failure #11); cap hard default 4 (minimalist #5).

Rejected with reason: **cut the A2A wrapper and the writer service** (design-minimalist #1, #2). The operator decided A2A support and a single-writer shared memory are goals of this stream, and the wrapper is what closes the Hermes gaps (F2-F4). Mitigation: the plain-REST path (F1) stays a documented fallback if `opencode-a2a` proves unfit in Slice 2/4, and the file-lock variant is recorded in Design 3 as the cheap alternative. Per the adversarial-pair rule: sided with the operator mandate over design-minimalist on these two items, and with design-minimalist on the policy stacking, hard cap, and cutting the supervisor shim unless proven needed. Deferred: image/volume GC beyond label-based reconcile; per-worker egress allowlist (open question 1).

### Round 2 (boundary-critic, failure-mode-analyst, operability-reviewer, delivery-pragmatist), 2026-11-09

Empirical checkpoint: verified in source that hook commands embed host absolute paths and that only exit 2 blocks (the failure-mode analyst's gate-bypass finding is real).
Incorporated: all of section 2a (hook path map + fail-closed + self-test; no-hardlinks clone and host-side fetch with isolated git config; host uid; routing adapter for dispatch; ownership of sweep vs reconciler; intent record and grace; instance id; network reconcile; probe/health/divergence semantics; mode semantics) and the delivery-pragmatist's S2a-d split with live checks separated from the PR gate; the real-model smoke that decides wrapper vs REST moved into S2d. Contradictions (worktree vs clone, env vs files) fixed.
Rejected: none this round.

### Consensus attack, 2026-11-09 (general-purpose, runs once)

general-purpose 2026-11-09: consensus-attack — **finding**: the panel assumed a container is a useful place to do the work; nothing said how the repo's toolchain/deps get in, and a dropped lint command would have weakened the gate silently. Incorporated (one revision, no further round): toolchain layers, offline pnpm store, `toolchain_missing` refusal, lint-unresolvable = refuse, a real-task S2d gate compared with TUI, open question 5 with the host-sandbox fallback. It was not routed to more debate; the S2d gate is the empirical test.

Intent preservation check: operator asked for A2A + scaling + shared layered memory with Phase A = no Kubernetes; v2 keeps all three and Phase B only as an appendix.

