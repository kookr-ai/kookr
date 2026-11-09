# RFC: opencode worker containers: A2A, scaling, shared layered memory

**Status:** Draft v1 (spike-backed, pre-implementation)
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

Evidence (all hermetic, mock provider, temp state; reproducible from
`deploy/opencode-worker/`):
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
  CPU and pid caps, tmpfs scratch; secrets only via env/files, never baked.
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
| F9 | Memory spike: single writer + per-project read-only view: 30 concurrent writes from 2 writers all present, 60 concurrent reads 0 torn, projB worker sees 0 projA data, bad token 401. | Memory design below. |

Hermes figures to beat (known, not re-measured here): ~2-2.6 GB per container,
3 GB cap. Measured opencode container: ~0.4 GB idle with the mock provider.
**Not measured:** real-model task RSS (the mock never reads large files or
runs test suites). The TUI reference measured 0.6-1.2 GB under real tasks, so
plan capacity with 1.2 GB per container until the first real-model run
(Slice 4) replaces the number.

## Design

### 1. Worker image (`deploy/opencode-worker/`)

Debian slim (python 3.12 + node binary copied), digest-pinned bases; opencode
1.19.5 from a lockfile with sha512 integrity; `opencode-a2a==1.4.0` with
`--require-hashes`; `nb` 0.7.0; plugin deps seeded at build. Nothing
task-specific is baked: `/cfg` (read-only: `opencode.json`, `plugins/kookr.js`,
`AGENTS.md`, composed by the existing home composer), `/work` (the task's git
worktree, rw), `/data` (volume: opencode sqlite + A2A task store),
`/memory` (the project view, ro). Entrypoint: `opencode serve` on
127.0.0.1 with a generated password, A2A wrapper on `:8000` with a bearer
token; both secrets passed by env at `docker run`. Exits if either child dies.

### 2. Launch mode in `OpenCodeAdapter`

`launch()` gains a branch when the task's launch options select the container
mode (`KOOKR_OPENCODE_CONTAINERS=1` and a per-task choice, default the flag):

1. Compose the session dir as today (config, plugin, profile `AGENTS.md`,
   layered memory pack); mount it read-only at `/cfg`.
2. `docker run -d --name kookr-oc-<taskId8>-<launchToken>` with the hardening
   flags from spike 2, labels `kookr.task=<id>`, `kookr.launch=<token>`,
   a per-task `/data` volume (the existing per-task data dir becomes a bind
   mount, so retention sweep and resume keep their semantics), the worktree at
   `/work`, a per-task ledger dir mounted rw at `/kookr-spool` (the plugin's
   hook command appends there; the host ingests with the existing
   `kookr-hook-writer` path).
3. Readiness: poll the agent card with a 60 s ceiling; fail launch (and
   `docker rm -f` by the label-checked name) on timeout.
4. Deliver the prompt with A2A `message:send` (`returnImmediately: true`) and
   record the A2A `taskId`/`contextId` in task metadata.
5. A thin **supervisor terminal session** (the dtach session Kookr already
   expects) runs `docker logs -f` for that container, so the existing
   capture/peek, attach and "session is alive" machinery keeps working
   unchanged; `kookr peek` for container tasks reads the opencode DB under
   the bind-mounted data dir exactly as today.

Messages to a running worker: A2A `message:send` on the same `contextId`.
Stop: A2A `tasks/cancel`, wait up to 5 s, then `docker stop -t 10`, then
`docker rm`; then the usual stop path (usage sum from the DB, session id
storage, data retention). Reap/recovery: on server start, list containers by
label `kookr.task`, adopt those whose task is non-terminal (resume the
supervisor session), remove those whose task is terminal or unknown **only if
the name starts with `kookr-oc-` and the label matches** (never by pattern
alone).

No change to `AgentType`, profiles, the deliverable gate, or hook ingestion.
Where a TUI-mode behaviour has no container equivalent (bracketed paste,
attach for typing) the container task is documented as non-interactive
(attach is log view only).

### 3. Shared layered memory

Exactly the spike 3 design, productised:

- **`memory-writer`**: the only rw owner of the notebook store. Bearer token
  per worker fixes `{actor, project, role}`; target shelf is always
  `<role>@<project>`. A single queue serialises `nb add`/`vote`/`rm`; every
  request is audited; after a write it republishes `views/<project>/` by
  per-file atomic rename. Runs as a Kookr-supervised container (or a host
  process when the operator prefers) on a private docker network.
- **Isolation**: a worker mounts only `views/<its project>` read-only; it never
  sees another project's shelves. Domain and global shelves are copied into
  each view (they are by definition cross-project).
- **Layering at SessionStart**: the composer uses the existing
  `capShelfListing` (keeps top-scored *and* newest lessons) per layer:
  project 4 KB, domain 2 KB, global 1 KB, header "earlier layer wins".
  Precedence is ordering plus an instruction, not enforcement (stated
  honestly in the docs).
- **Stale reads** are by design: lessons written during a session reach other
  workers at their next SessionStart.
- **Promotion** project -> domain -> global is a curator action (operator or
  orchestrator token with a wider scope), never a worker action.
- Voting/retro and `nb rm` also go through the writer (a verb per mutation);
  workers get a `nb` shim that calls the writer. Spike 3 proved only `add`.

### 4. Scaling on this host

Limits enforced by Kookr, not by hope: a container count cap
(`KOOKR_OPENCODE_CONTAINERS_MAX`, default 6), the existing resource watchdog
(host RAM/disk), launch refusal below 5 % disk (existing), and per-container
`--memory`, `--cpus 2`, `--pids-limit`. Planning numbers: 0.4 GB (mock) to
1.2 GB (assumed real) per container; image 1.36 GB shared across all
containers; each task adds its worktree plus a small `/data` volume. With
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
| Kookr server restarts | Adopt by label; the supervisor session is recreated; A2A task state is in the container's volume. |
| Docker daemon down | `docker` probe in preflight: container mode is not registered (adapter falls back to TUI mode if allowed by flag policy) and a startup warning names the reason. |
| Cancel race (F5) | Read state after stream close; our own cancel wins. |
| Provider outage / 429 | Same provider-transient retry path as TUI mode (the A2A task reports the failure; the stored launch replays). |
| Memory writer down | Worker boots with the last view (stale but valid); lesson writes fail open with a logged warning; hook never blocks stop. |
| Worker writes junk lessons | Bounded by nb limits, per-token project scope and the audit log; curator can `rm`. |
| Disk pressure | Existing launch refusal; container mode adds image/volume GC for `kookr.task`-labelled objects only, explicit-name based. |
| Leaked secret | Env-only, never in image; the gate/PR flow is unchanged. Worker egress is unrestricted in Phase A (documented gap, see Open questions). |

### 6. Rollback

Unset `KOOKR_OPENCODE_CONTAINERS` (or `KOOKR_OPENCODE_ENABLED`): new launches
use TUI mode. No schema change: container tasks use the same task metadata
(`opencodeSessionId`) and the same data dir. `docker rm -f` of labelled
containers and removing `views/` and the writer leaves the notebook store
untouched (the store is the source of truth; views are derived).

## Files to change (per slice)

- Slice 1: `deploy/opencode-worker/**` (Dockerfile, entrypoint, locks), docs,
  a CI-free local build script; image build check test. No Kookr runtime change.
- Slice 2: `src/adapters/opencode-container-*.ts` (docker runner port, A2A
  client, supervisor session), adapter branch, preflight, reap/adopt, tests
  with a fake docker port and a fake A2A server.
- Slice 3: `memory-writer` productised (TS, tests), layered composer reusing
  `capShelfListing`, writer-backed `nb` shim, `docs/reference`.
- Slice 4: live gate (hermetic) with real provider key: 1 task, then 4 and 8
  concurrent; capacity numbers into the reference doc; default cap decision.
- Docs: `docs/reference/opencode-agent.md` section, runbook update.

## Non-goals

Kubernetes, kagent, Agent Sandbox, agentgateway, multi-host, serving
untrusted tenants, replacing TUI mode, an A2A server of our own, a new memory
format, egress filtering (Phase A).

## Alternatives considered

- **Hermes-style container** (2-2.6 GB, in-memory tasks): rejected; measured
  worse on every dimension that matters here.
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

(To be filled per review round.)
