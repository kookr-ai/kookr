# RFC: Delegating Kookr Work to the Hermes Fleet over A2A

**Status:** Accepted for slice 1-triage (value test passed; v5 — operator named the first use cases (v4); a focused delivery review of v4 is incorporated (v5). Sections marked *v4*/*v5* were edited after the full panel rounds)
**Date:** 2026-11-07
**Author:** Jean Ibarz (with Claude)
**Related:** `rfc-hermes-observed-activity-bridge.md` (the one-way Hermes→Kookr observation lane, shipped), jeanibarz/hermes-fleet#15, `rfc-self-improving-agent-fleet-evidence.md`

---

## Problem

Kookr can already *see* the Hermes fleet (the observed-activity lane) but cannot *use* it.
The operator's goal is a supervisor/worker pattern: a Kookr task hands a bounded job to a
Hermes worker, the worker does the work in its sandbox, and the result returns to the
supervisor. Hermes fleet ships its half: sandboxed Docker agents, each serving the A2A
protocol, with a working `hx.sh bridge <agent> "<task>"`. Kookr has **no client for it**.

Three facts shape the design:

1. **Kookr's agent abstraction does not fit.** `AgentAdapter` is terminal-session shaped
   (`launch` returns a terminal session id used as the dtach socket and WebSocket attach
   route; `stop` kills that terminal; `captureDisplay` reads the screen).
2. **Hermes does not behave as its README implies** (see *Measured behaviour*): cancel does
   not stop work, a dropped streaming request fails the task, task state is lost on restart,
   the card advertises an unusable address, and the default deployment has no isolation
   between workers or from Kookr.
3. **Nothing bounds how deep or wide delegation can grow.** Kookr has no spawn-depth limit,
   and a Hermes agent exposes `a2a_call`/`a2a_orchestrate` and a `delegation` toolset.

## Measured behaviour (two probe rounds, 2026-11-07)

Scratch agents only (`hx-probe-1..4`; the operator's `hx-alpha/beta/worker` were not used),
15 model calls in total, cleaned up and verified. Hermes 0.22.7. Where the README or the
first draft of this RFC disagreed, these results win.

| Question | Observed | Consequence |
|---|---|---|
| Who mints the A2A task id? | The worker. `message/send` returns it only at the end; the id is discoverable meanwhile with `tasks/list {contextId}` (a client-supplied `contextId` is echoed; `messageId` is not). `tasks/get` takes only the task id. | One Kookr-minted `contextId` per delegation; recover the id with `tasks/list`. |
| **A dropped `message/stream`** | **Fatal.** Hermes writes an SSE keepalive every 5 s; a failed write finalizes the task `FAILED "[client disconnected]"` within ~5 s while the agent keeps running; its result is discarded and unrecoverable. | **Do not dispatch with `message/stream`.** A Kookr restart would kill every in-flight job. |
| A dropped `message/send` | Harmless. The task keeps `WORKING` and ends `COMPLETED` with its result. | Dispatch with `message/send`. |
| `tasks/subscribe` | Re-attaches to a running task and streams the result; dropping it does not finalize the task. | The reconnect path after a Kookr restart. |
| `tasks/list` | Filters `contextId` and `status`; `pageSize` 1–100 (default 50); returns `nextPageToken`, `totalSize`. | Recovery is exact and cheap. |
| Reply timeout | `A2A_REPLY_TIMEOUT`, default **300 s**. At the deadline the task becomes `FAILED "[agent did not reply in time]"`, **the agent keeps running**, and its result is dropped. `hx.sh` cannot set the variable. An orphan watchdog fails stale `WORKING` tasks. | Kookr's deadline must be below the worker's reply timeout; default jobs are capped at ~5 min. |
| `tasks/cancel` | Flips state to `CANCELED` only; the tool subprocess and the model loop keep running and keep spending. | Cancel is bookkeeping. |
| Task state across a worker restart | **Lost.** `tasks/get` → `-32001`, `tasks/list` empty. | Resume works across a *Kookr* restart, never a *Hermes* restart. |
| Retention | At most 500 terminal tasks, oldest evicted. | A completed result can disappear on a busy worker; `-32001` is ambiguous (restart or eviction). |
| Unknown id vs unreachable | Unknown id: HTTP 200 + JSON-RPC `-32001`. Unreachable: transport error. | Distinguishable. |
| Concurrency | **Parallel** on one agent. | `maxInFlight` is a load choice, not a Hermes limit. |
| Task states seen | `SUBMITTED, WORKING, COMPLETED, CANCELED, INPUT_REQUIRED, REJECTED`, plus `FAILED` (reply timeout, client disconnect, dispatch failure, agent failure). `INPUT_REQUIRED` is triggered by a literal reply prefix, so a worker that read hostile content can be pushed into it. | Map all of them; treat `needs_input` text as untrusted. |
| Text rewriting | Outbound replies pass through `redact_outbound` (e-mail addresses → `[redacted-email]`, credential patterns scrubbed). | Results are post-redaction; byte-exact payloads (patches) are unsafe without a hash/encoding. |
| Reachability | A worker reaches **peer workers** (same network, one shared bearer token across the fleet, taken from a fixed default in the launcher script at the time of testing). A worker also reaches **Kookr's API** through `host.docker.internal:4800` (Docker Desktop's host proxy), and `GET /api/tasks` answered with no credentials. | The default deployment provided no leaf isolation, and any container on Docker Desktop can reach services bound to the host's loopback (including Kookr's unauthenticated loopback API). |
| Agent card | Tools are listed even when disabled; `url` is a Docker-DNS name unusable from the host. | Never gate on the card; use configured URLs. |
| Files on a mounted workspace | Created as uid:gid `10000:10000`; host `git clean -fdx` hits `EACCES`; `hx.sh up --workspace` runs `chmod -R 0777` on the directory it is given (this recursively altered ~72 000 files under `/tmp` when a probe passed `/tmp` by mistake; the dtach directory was restored to `0700`). | Kookr must not run git cleanup on worker-writable trees; `hx.sh` needs a guard. |

**Operational findings outside this RFC's code (addressed in hermes-fleet#22):** the launcher's default shared token and its all-interfaces port publishing have been removed; the Kookr-API reachability from containers (P4) remains open and is an enable-gate item.

## Decision: the first use cases (v4, resolved by the operator)

The review converged on *how* to delegate safely, and the consensus attack found that nobody
had established *what* to delegate. The operator's answer: **issue triage, issue
implementation, and testing-quality audits of projects with improvement suggestions.**

What that changes:

- **All three need the repository.** Text-only jobs with no workspace (the v3 slice 1) serve
  none of them. Slice 1 is therefore re-scoped to **analysis delegations over a read-only
  workspace** (triage and test audit), which return text or a structured verdict.
- **Implementation is the file-touching case** and moves to its own slice and RFC (patch
  return, hardened apply, review gate). It is not dropped; it is sequenced after the
  read-only slice proves the plumbing.
- **The supervisor performs every privileged action.** A worker produces a *proposal* (a
  triage verdict, an audit report, a patch). Kookr, which holds GitHub and git credentials,
  applies labels, posts comments, creates branches and opens PRs through the existing gates.
  A worker never holds a GitHub credential and never merges.
- **The natural integration point is the existing playbooks** (`implement-github-issue`,
  `parallel-issue-batch`, the triage flows): a playbook step calls `kookr delegate` instead
  of doing the analysis itself.
- **Jobs differ in length.** Triage is short (fits the default 5-minute reply timeout); a
  test-quality audit and an implementation are not. v5 therefore splits the first slice: triage
  ships first with no P3 dependency; audit waits for P3, a per-worker reply-timeout
  attestation and the delivery-shape decision (Alternative 9).
- **Read-and-reason only.** A read-only snapshot means an audit cannot run tests or a build; its
  value claim is limited to what static reading can establish.

**Value test — done (2026-11-07).** Whether Hermes (DeepSeek) produces triage and audit output worth routing to was measured before any build, with criteria fixed in advance, on open issues of three repositories and one test-quality audit, against a Claude baseline, judged blind. Result: both criteria groups pass (see `rfc-kookr-hermes-delegation-value-test.md`), so slice 1 may start. The test sent repository content to the operator's configured model provider with the operator's explicit authorization.

## Requirements

- **R1 — Delegate.** A running Kookr task can submit a job to a Hermes worker and receive the
  result. The Hermes credential lives server-side; an agent running under the same OS user
  could still read it, which is stated as the single-operator trust assumption (§8).
- **R2 — Supervisor stays in charge.** Kookr owns admission, deadlines and the outcome
  record. Worker output is untrusted data, never an authority.
- **R3 — Many workers, no head-of-line blocking.** A busy worker does not block a second
  job: jobs spread across workers, and each worker runs several concurrently up to a cap.
- **R4 — Bounded recursion.** A delegated worker is a leaf. This is **enforced by the
  deployment** (prerequisites P1, P2, P4 and P7) and **attested by the operator**; Kookr cannot verify
  it. Until the prerequisites hold, the feature must not be enabled in production.
- **R5 — Honest after restarts.** A Kookr restart loses no job; a Hermes restart ends the job
  with a truthful reason; a corrupt store never silently reads as "no jobs".
- **R6 — Isolated and reversible.** Off by default; no change to the Task/Adapter/ledger
  model in slice 1; revert recipes per slice.
- **R7 — Diagnosable.** Every terminal state carries a cause; the operator can list
  delegations from the CLI before any UI exists.
- **Non-goals:** a mesh of workers; Kookr starting or scaling containers; a queue;
  code-changing delegations in slices 1-3 (issue implementation is slice 4 and needs its own RFC, see *Constraints for code-changing delegations* below); cost accounting; monitor UI in v1; non-Hermes A2A backends.

## Design

### 1. Module layout: one directory, one owner

All of v1 lives in `src/server/delegation/`: `service.ts` (the only mutator of delegation
state), `a2a-client.ts`, `store.ts`, `routes.ts`, `registry.ts`. The first draft split this
across `core/`, `server/` and two `integrations/` directories behind two ports; review
(boundary vs minimalist) resolved to one directory with no ports until a second backend
exists. The boundaries that matter are kept without the indirection:

- `a2a-client.ts` is the **only** file that knows A2A vocabulary. It returns normalized
  outcomes (`accepted`, `completed`, `needs_input`, `worker_failed`, `rejected`, `not_found`,
  `unreachable`, `auth`); `-32001`, `INPUT_REQUIRED` and `FAILED` are mapped there. The
  fake A2A HTTP server used in tests is the seam.
- `registry.ts` owns **worker registration**: a pure `validateWorkerRegistry(config)` that
  enforces distinct tokens, rejects any token shared by more than one worker and any token on a built-in denylist of known weak defaults (stored as hashes, so no credential value appears in the repository), requires an explicit
  `operatorAttestedLeaf: true`, and requires operator-supplied URLs; plus a pure
  `pickWorker(records, workers)` (least in-flight, tag filter). `service.ts` receives only
  validated configuration.
- Health is service state, derived from delegation records and dispatch outcomes; the
  client never reports it upward as authoritative.
- Nothing in `core/` imports delegation. Slice 2 adds the only outward hook as a narrow
  port (see Slices).

### 2. The record

`Delegation`: `id`, `schemaVersion`, `parentTaskId`, `workerId`, `contextId`,
`a2aTaskId?`, `state`, `failureReason?`, `detail?`, `submittedAt`, `deadlineAt`,
`lastWorkerContactAt`, `result?`. It is **not** a `Task` and **not** an `AgentAdapter`.
States: `dispatching → working → completed`, or terminal `failed | cancelled | timed_out`.
`failureReason`: `worker_unreachable`, `worker_lost`, `worker_failed`, `rejected`,
`needs_input`, `invalid_result`, `error`; `detail` carries the specifics (every worker-originated string is
wrapped as untrusted). `pool_busy` and `pool_unavailable` are **synchronous API errors**,
never persisted. Transition history is logged, not stored.

### 3. Dispatch and recovery (corrected by the probes)

1. Kookr mints a `contextId` that embeds a Kookr instance id and a uuid, performs a
   **serialized, awaited, atomic** write (temp file, fsync, rename) of the `dispatching`
   record, then sends `message/send` carrying that `contextId`. A single writer serializes
   all store updates so concurrent awaits cannot lose each other.
2. Shortly after dispatch Kookr resolves the worker's task id with `tasks/list {contextId}`
   and persists it. The held `message/send` response, when it arrives, carries the result.
3. **Kookr restart (or any dropped connection):** for each non-terminal record, look up the
   task by `contextId`. Terminal → collect the result from `tasks/get`. `WORKING` → re-attach
   with `tasks/subscribe` (or poll `tasks/get`). Not found:
   - transport error → retry with backoff for a grace window, then `failed/worker_unreachable`;
   - found nothing on a reachable worker → `failed/worker_lost` with detail
     `restarted_or_evicted`. It is **not** "safe to retry": the worker's tools may already have
     had side effects, so a retry always mints a new `contextId` and is the caller's choice.
4. **Hermes restart:** state is gone → `failed/worker_lost`. No resume is claimed.
5. **Hermes `FAILED`:** `failed/worker_failed` with the worker's text as detail. The record
   states that the **work may still be running** (reply timeout and client-disconnect both
   leave the agent running).
6. **Deadline:** Kookr's `deadlineAt` must be below the worker's `A2A_REPLY_TIMEOUT`
   (prerequisite P3). Otherwise the worker fails the task first and Kookr reports
   `worker_failed`, which is truthful. Default job ceiling is therefore ~5 minutes until P3.
7. **Store failure:** an absent file is normal (first boot, or after an ordered disable). A
   file that fails to parse or has an unknown `schemaVersion` **disables delegation** with a
   typed error naming the file; the operator inspects or removes it. It never reads as an
   empty store. A tolerant reader ignores unknown fields so slices stay revertible.
8. All time logic uses Kookr's clock; the worker's `status.timestamp` is regenerated on each
   read and is never used.

### 4. Workers and scheduling (the "second Hermes" question)

Workers are operator-configured: `name`, **URL (never the card's)**, token *reference*,
optional tags, `maxInFlight` (default 2; a load choice, since Hermes runs jobs in parallel).
Kookr does not start or stop containers.

- A new delegation goes to the usable worker with the fewest in-flight jobs. If every usable
  worker is at its cap the API returns `pool_busy` with a retry hint; if none is usable,
  `pool_unavailable`. There is no queue in v1.
- Passive health in slice 1: a transport error marks the worker `unreachable` for a short
  period in memory and `pickWorker` skips it. An active probe, circuit breaker and `draining`
  arrive in slice 2.
- **Leaked work is counted.** A job that ended `timed_out`, `cancelled` or `worker_failed`
  may still be running on the worker, so it keeps counting against that worker's
  `maxInFlight` until the deadline plus a grace period passes, otherwise cancel/retry loops
  oversubscribe a worker invisibly.
- Adding capacity is the operator's `hx.sh up`; an automatic scale hook is deferred.

### 5. Caller interface

`POST /api/delegations` returns an id; `GET /api/delegations/:id` reports state. The HTTP API
is asynchronous only. The CLI:

- `kookr delegate --kind <triage|test_audit> --project <id> [--issue <n>] [--key <k>]` submits a *typed* request (free text is rejected: the server assembles the prompt, §10) and waits by polling for at most ~100 s per invocation
  (an agent's shell tool times out around 120 s). If the job is still running it prints the
  id and `still working — run: kookr delegate wait <id>`. `--timeout` means *stop waiting*,
  never *cancel*. If the parent never collects, the delegation still completes and stays
  readable until retention.
- `wait <id>`, `status <id>`, `list [--parent <id>]` are the other verbs in slice 1. `cancel`
  and `workers` arrive in slice 2.
- **Idempotency is owned by the service, not the CLI.** A caller may pass a key; a request
  matching a **non-terminal** delegation with the same `(parent, key)` returns that
  delegation, checked and inserted atomically. Terminal failures permit a fresh dispatch, so
  a retry after `timed_out` or `pool_busy` works. Re-delegating after a parent is relaunched
  under a new task id is a known duplicate risk in v1 and is revisited in slice 2.
- Results are capped at 64 KB and returned inside a delimited, labelled block. A reply over the cap is `failed/invalid_result` (a truncated structured verdict is never applied).
- **Disabled is observable, not a 404.** The `/api/delegations` routes are always registered; when delegation is off or unusable every request returns HTTP 503 `{error: "delegation_disabled", reason}` with `reason` one of `flag_off`, `no_config`, `invalid_config`, `store_corrupt`, `not_accepting`. No worker is contacted and no state is read in that case. Startup logs the decision (never secrets).

### 6. Slice-1 invariants (explicit)

Write-ahead record; restart reconcile (§3.3); deadline timer; global `maxDelegations` and
per-worker `maxInFlight` caps; result cap and envelope; flag gating; `schemaVersion` with a
tolerant reader; passive health; leaked-work accounting; the registry validation of §1; and
the ordered-disable procedure. Slice 1 has a config setting `acceptingNewDelegations` (default
true, re-read on every submit): set it to false and new submits get `delegation_disabled`
(`not_accepting`) while in-flight delegations keep running to a terminal state (each has a
deadline; there is no `cancel` until slice 2); wait until `kookr delegate list` shows none
non-terminal, then unset the flag and keep or archive the state file. Deleting the state file
with jobs in flight orphans them.

### 7. Observability before any UI

Structured log lines for every transition, reconcile result and worker-health change, keyed
by delegation, task, worker and A2A ids (never the token or a result body). `status` shows the
state, reason, last worker contact and age. Gauges, counters, retention and the runbook
(stuck delegation, unreachable worker, `pool_busy`, orphaned Hermes job, restart mid-job,
corrupt store) are slice 2. Until then the store keeps at most N terminal records.

### 8. Trust model and security

- The Hermes token is re-read from a secret file per request (so rotation works) and the
  distinct-token check runs on every read. It is never placed in task environments, logs or
  diagnostics. **Stated assumption:** agents run as the same OS user as the server and could
  read that file; on a loopback bind the Kookr API has no authentication and `parentTaskId` is
  self-declared. This is the same single-operator trust model as `kookr spawn` today. Rotating
  a token on the Hermes side needs a worker restart, which fails in-flight jobs.
- The global and per-worker caps are abuse limits for a cooperative agent, not a security
  boundary.
- Every worker-originated string (result, `needs_input` question, error detail, status
  output) is treated as untrusted data, length-capped and delimited. Delimiting does not
  protect the parent LLM, which has host shell access; that prompt-injection residual risk is
  accepted and stated.
- **Leaf isolation is a deployment responsibility, and today it does not exist** (see
  *Measured behaviour*). Kookr does not attempt to infer it from the agent card.
- Accepted residual risk: a worker with web and code-execution tools holding a mounted repo
  can exfiltrate it after prompt injection. Since v4 *every* delegation has repository access and
  reads third-party issue text, so this is the default case (not an exception) and P4 is in the enable gate.
- Flag: `KOOKR_HERMES_DELEGATION=1` plus at least one attested worker; either missing ⇒ the
  API answers `delegation_disabled` (§5) and does nothing else.

### 9. Cross-repo prerequisites (hermes-fleet) and the enable gate

These are not Kookr code; each needs a hermes-fleet issue and an owner. The first merge of
slice 1 does not require them; **enabling the flag in production or on a shared host does**.

| # | Prerequisite | Why (measured) | Needed for |
|---|---|---|---|
| P1 | Distinct per-agent bearer token; no shared default *(done in hermes-fleet#22)* | One shared default token across the fleet | enabling slice 1 |
| P2 | Publish only on loopback (`-p 127.0.0.1:PORT:9900`) *(done in hermes-fleet#22)* | The launcher published on all interfaces, and an unpublished worker is unreachable from the host; so each worker Kookr uses needs an explicit loopback-only published port | enabling slice 1 |
| P3 | Pass `A2A_REPLY_TIMEOUT` through `hx.sh up` | `hx.sh` cannot set it; default 300 s | jobs longer than ~5 min |
| P4 | Block worker→Kookr (`host.docker.internal`) and worker→worker traffic | Both measured reachable; the Kookr API is unauthenticated | enabling slice 1 (leaf rule) |
| P5 | Refuse `--workspace` paths outside a dedicated directory; stop `chmod -R 0777` | A mistaken path altered ~72 000 files | any file-touching worker |
| P6 | A worker-side per-job turn/budget cap | Cancel and timeout leave work running | bounding leaked spend |
| P7 *(v4)* | A **read-only** workspace mount option (`--workspace-ro`) for a snapshots root (Kookr creates per-commit snapshot directories under it, §10) | `hx.sh --workspace` mounts read-write; analysis jobs must not be able to modify the repo | slice 1 (triage, audit) |

**Enable gate (checklist, all must hold before the flag is set in production or on a shared host):** P1, P2, P4
and P7 done (P3 as well before the audit kind is enabled); a named owner for snapshot creation
and cleanup, with `baseSha` recorded on every delegation; each worker's `operatorAttestedLeaf` set by someone who has read the deployment; a live
smoke test against two scratch agents with distinct tokens passes (fake-server tests built
from recorded shapes will not catch drift); the slice-1 watchdog test (Open question 1)
passes.

### 10. Slice-1 contract (v5): jobs, checkouts, results, and applying them

**Typed submit body.** `POST /api/delegations` takes `{kind, projectId, issueRef?, key?}` with
`kind ∈ {triage, test_audit}`, not free text. The **server** assembles the prompt from a
versioned template (`promptVersion` is stored on the record). For `triage` Kookr itself fetches
the issue (title, labels, body, and a bounded number of comments) with its own GitHub
credentials and embeds it; the worker never fetches anything and never holds a GitHub
credential. A size cap applies to the embedded issue text.

**Checkout lifecycle: Kookr owns immutable per-commit snapshots.** A worker's mount is fixed
when its container starts, but the *contents* of a mounted directory can change. So the
operator mounts one **snapshots root** read-only (P7); Kookr creates
`<root>/<projectId>/<commit-sha>/` on demand (tracked files only, copied from the project's
canonical checkout, no `.git` pointer escaping the mount) and gives the worker the
in-container path in the prompt. A snapshot is never modified after creation, so there are no
torn reads; a new commit gets a new directory; a directory is removed when no non-terminal
delegation references it. The commit is stored as `baseSha`, which ties every result to the code
it was produced against. (`hx.sh up --workspace` recursively `chmod 0777`s whatever it is given;
pointing it at the Kookr-owned snapshots root is acceptable, pointing it at a real checkout is
not — P5.)

**Registry additions.** Each worker declares the `projects` it may serve (a project is served by
any worker that lists it, so several workers can share one snapshots root and R3 holds),
`workspaceMode: ro` (operator-attested, like `operatorAttestedLeaf`), and `replyTimeoutSec`
(operator-attested value of its `A2A_REPLY_TIMEOUT`). Kookr sets
`deadlineAt = min(kind default, replyTimeoutSec − margin)`; it cannot read the worker's value.
`pickWorker` filters on project, then least in-flight. Changing a worker's mount means
recreating its container, which fails its in-flight jobs, so the rollout order is: recreate the
worker, then register it.

**Record additions** (added now, while `schemaVersion` is 1 and there is no data): `kind`,
`projectId`, `baseSha`, `promptVersion`.

**Long-job transport.** Triage fits a held `message/send`. For anything longer than a few
minutes the service does not rely on the held response: it resolves the task id with
`tasks/list {contextId}` and collects the result with `tasks/get` polling or `tasks/subscribe`
(both measured safe), so an HTTP-client header timeout on the held request cannot masquerade as a
worker failure.

**Result contract.** One versioned JSON schema per `kind` (triage verdict; audit findings),
validated in `service.ts` (not in `a2a-client.ts`). A reply that is not valid or does not match
the schema is `failed/invalid_result`; it is never repaired or partially applied. Hermes's
outbound redaction can rewrite e-mail addresses and credential-shaped strings, so findings cite
file paths and line numbers rather than rely on free-form quoted text, and every cited path is
checked against the snapshot before the result is accepted.

**Applying a result (supervisor side effects).** The worker reads untrusted issue text, so its
verdict is untrusted input to the effect step as well as to the parent LLM:
- labels come only from a **per-repository allow-list**; anything else is dropped and logged;
- comment text is posted as data inside a labelled block with a length cap and `@`-mentions
  neutralised;
- every posted comment or label carries a hidden marker with the delegation id, so a retry after
  a crash between "verdict collected" and "effect recorded" detects an existing effect instead of
  duplicating it;
- the effect is performed by Kookr or the playbook, never by the worker.

**Playbook hook.** The triage playbook step calls `kookr delegate` when delegation is enabled and
healthy; on `delegation_disabled`, `pool_busy`, `pool_unavailable`, or **any delegation outcome
other than `completed`** (every failure reason, `timed_out`, `cancelled`) or any API error, it
falls back to doing the triage itself (delegation is an optimisation, never a dependency). Revert order: remove the playbook step first, then run the
ordered disable.

## Files to change (by slice)

| Slice | Files |
|---|---|
| 1a | `src/server/delegation/{service,a2a-client,store,routes,registry}.ts`, `src/shared/contracts/delegation.ts` only if a second TypeScript consumer appears (otherwise types live beside the writer), `config.ts`, `.env.example`, bootstrap wiring under `src/server/bootstrap/`, fake-A2A-server test fixture |
| 1a (modules) | `src/server/delegation/{snapshots,prompts,results}.ts` (snapshot lifecycle, versioned prompt templates, per-kind result schemas) |
| 1b (apply) | `src/server/delegation/apply.ts` (allow-listed effect step with an idempotency marker) |
| 1b | `bin/kookr-delegate.js` + `kookr` dispatcher, the triage playbook step with its fallback, docs (`api.md`, `environment-variables.md`, `architecture.md`) |
| 2a | `src/core/ports/task-terminal-notifier.ts`, one optional fire-and-forget try/catch-wrapped dependency called from the terminal path in `agent-lifecycle.ts` (callbacks, not an event bus — none exists), periodic parent-liveness sweep |
| 2b | worker probe/breaker, `draining`, `workers` and `cancel` verbs, gauges and counters, retention, runbook, an architecture-boundary rule that `delegation/` is imported only from bootstrap |
| 3 | `delegations.snapshot` message + schema + frontend slice, task/project scoped (unlike the owner-only lane pattern) |

## Edge cases

- **Worker busy / none usable:** `pool_busy` / `pool_unavailable`, synchronous, never silent.
- **Kookr killed between persisting the record and learning the task id:** recovered with
  `tasks/list {contextId}`; a miss on a reachable worker is `worker_lost`, not "retry safely".
- **A retry:** always a new `contextId`; two tasks sharing a context would receive each
  other's replies (Hermes resolves oldest-pending per context).
- **Worker asks a question / is pushed into `INPUT_REQUIRED`:** terminal `needs_input`, text
  untrusted.
- **Result exceeds the cap or fails its schema:** `failed/invalid_result`; never repaired, truncated-and-applied, or executed.
- **Eviction:** `-32001` reports `restarted_or_evicted`; it is not proof the worker restarted.
- **Parent ends first:** in v1 the delegation runs to its deadline (documented); slice 2a
  cancels as bookkeeping and the leaked work still counts against the worker.
- **Two jobs on one worker touching files:** out of scope; v1 workers have a read-only snapshot mount, so jobs cannot write.
- **Token duplicated by a later rotation:** the distinct-token check runs on every read.
- **Store corrupt:** delegation disabled with a typed error naming the file.

## Alternatives considered

1. **A launchable `AgentAdapter` for `hermes-fleet`.** Needs a fake terminal and a hook
   pipeline Hermes does not emit. Rejected.
2. **Run `hx.sh bridge` / the Hermes MCP tool from the agent's own shell (zero Kookr code).**
   The honest baseline. It makes the agent hold the Hermes credential and gives Kookr no
   record, limits, restart handling or untrusted-result envelope. The proxy exists for those;
   if they are not wanted, this baseline is enough.
3. **`message/stream` dispatch.** Rejected by measurement: a dropped connection fails the task.
4. **Kookr starts containers per delegation.** Cleanest isolation, but Kookr would own Docker
   and model credentials. Deferred.
5. **Hermes pulls from a Kookr queue.** Inverts supervisor/worker. Rejected.
6. **Delegation as a Task with a "no process" kind.** Pollutes counts, stuck detection and the
   ledger. Rejected.
7. **Two core ports and four directories.** Rejected for v1 as unneeded indirection with a
   single backend (minimalist); the A2A-vocabulary and registration boundaries are kept by
   file ownership instead (boundary critic).
8. **Per-worker worktrees committed by Kookr.** Rejected: executes worker-planted hooks on the
   host and trips over uid-10000 files.
9. **Completion-callback (push) delivery instead of a blocking `wait`.** Not rejected on
   merit; deferred. It trades the parent-blocking and relaunch problems for a new mechanism
   (spawn/resume a task on completion) and a richer idempotency story. The consensus attack
   noted Alternative 5 was dismissed on a label ("inverts supervisor/worker") when this
   related shape — Kookr still dispatches and supervises, only delivery is asynchronous — was
   never weighed. The first use cases are now known (see *Decision*); it is evaluated before slice 1-audit starts.

## Constraints for code-changing delegations (future RFC, not this one)

Not designed here. A future RFC must satisfy at least: the worker returns a base64 patch with
a hash (reply redaction corrupts raw text); Kookr applies it in a Kookr-owned scratch tree
with an **allowlist** of path prefixes per delegation (a denylist fails open: `.claude/`,
`.mcp.json`, `CLAUDE.md`, `package.json` scripts, test files and `scripts/kookr-merge.sh` all
lead to host execution or a subverted gate), git global/system config isolated
(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, hooks and filters disabled), gitlinks,
mode changes and symlinks rejected, reviewer-run tests sandboxed, one job per workspace, a
defined base ref, and P5 resolved on the Hermes side.

## Slices (each independently revertible)

0. **Contract experiments — done** (*Measured behaviour*). Not probed: push notifications,
   behaviour under real model load, the orphan watchdog beyond source.
1. **Analysis delegations over a read-only snapshot** *(v5: split by job length)*.
   - **1-triage (ships first):** short jobs that fit the default reply timeout; blocking `wait`
     is enough; no P3 dependency.
     - **1a (API):** service, store, A2A client, registry (workers ↔ projects, attested
       `workspaceMode`/`replyTimeoutSec`), snapshots, prompts, result schema,
       routes, wiring, behind the flag; fake-server tests plus the live two-agent smoke test as
       the exit criterion.
     - **1b (CLI + apply + playbook):** `delegate`, `wait`, `status`, `list --parent`, the
       allow-listed apply step, and the triage playbook step with its fallback.
   - **1-audit (after 1-triage):** long jobs. Needs P3 (the attested `replyTimeoutSec` field is
     already in 1a), `tasks/get`/`tasks/subscribe` collection, and the delivery-shape decision
     (blocking `wait` vs completion callback, Alternative 9). If a callback is chosen it pulls in
     the slice-2a notifier and parent-liveness sweep, so that decision is made before 1-audit
     starts, not during it.
   *Revert (applies to the whole of slice 1):* remove the playbook step, run the ordered disable, then remove the additive modules
   and the snapshot directories (nothing references them once no delegation is non-terminal);
   in-flight Hermes jobs keep running until they finish or the worker is restarted.
2. **Safety and health.**
   - **2a:** `TaskTerminalNotifier` port, the lifecycle hook, parent-liveness sweep,
     cancel-on-parent-end, and an explicit decision on relaunch (re-parent via lineage vs
     cancel). The only change in `core/`. *Revert:* remove the optional dependency.
   - **2b:** probe, breaker, `draining`, `workers`/`cancel`, metrics, retention, runbook.
3. **Monitor rows** with task/project scoping; de-duplication against the observed lane is
   deferred (both may show a job; the delegation record is authoritative). *Revert:* drop the
   message type and the client slice together, or ship a client that ignores unknown types.
4. **Issue implementation** *(v4: promoted from deferred)*: patch return, hardened apply,
   review-gate integration. Needs its own RFC, P5, and the constraints list above (*Constraints for code-changing delegations*); depends on
   slice 1 proving the plumbing and on the value test.
5. **Deferred:** bounded queue, scale hook, per-task launch credentials, correlation id in
   observed pulses.

## Open questions

0. **Value test (gating) — passed 2026-11-07.** Recorded in `rfc-kookr-hermes-delegation-value-test.md`: Hermes preferred on 9/10 triage items (usefulness 4.6 vs 3.9), audit precision 0.89 vs 0.50; both pre-registered groups pass, so slice 1 may start.
1. Does a parent blocked in `kookr delegate wait` trip the stuck/idle watchdog? A slice-1
   acceptance test; if it does, `wait` needs a heartbeat output or a watchdog exemption.
2. Does a worker-side budget cap (P6) reliably bound a cancelled or timed-out job's spend?
3. Push notifications versus polling/`tasks/subscribe` for long jobs.
4. Delegations are task-bound: project-scoped for share viewers? Decided in slice 3.
5. Relaunch semantics for delegations (slice 2a).

## Critic feedback incorporated

**Round 1** (boundary-critic, failure-mode-analyst, design-minimalist, operability-reviewer,
delivery-pragmatist) plus `design-experimenter` probe round 1. **Round 2** (failure-mode-analyst,
boundary-critic, delivery-pragmatist, design-minimalist) plus `design-experimenter` probe round 2.

Intent-preservation check: the operator's load-bearing asks are a Kookr→Hermes supervisor/worker
pattern over A2A and several Hermes workers so a busy one does not block a second job. Both are
kept. The minimalist's single-worker advice was rejected in round 1 and again in round 2
(multi-worker is a stated goal and ~20 lines because Hermes runs jobs in parallel); its cuts to
queue, UI, worktrees, health taxonomy, history, extra verbs and the cancel/probe machinery were
accepted for slice 1.

- *Incorporated, round 1:* single lifecycle owner; leaf rule moved to deployment + attestation;
  git handoff removed; `contextId` + `tasks/list` recovery; truthful cancel/restart; write-ahead
  persistence; failure reasons; worker health; async-only API; `input-required`/`rejected`
  mapping; per-slice revert recipes; honest zero-code baseline.
- *Incorporated, round 2:* **dispatch switched from `message/stream` to `message/send`**
  (failure-mode F1, confirmed by probe: a dropped stream fails the task); Hermes `FAILED` /
  reply timeout mapped and the deadline ordering stated (F2); `tasks/list` capabilities
  corrected, open question dropped (F3); "no match ⇒ safe to retry" removed, retries mint a
  new `contextId` (F4); `-32001` ambiguity (F5); idempotency moved into the service and limited
  to non-terminal delegations (F6, boundary F4, minimalist); leaked-work accounting (F7);
  corrupt-store recovery simplified to disable-with-error plus serialized atomic writes and a
  schema version (F8, minimalist); reachability probed — **workers can reach the Kookr API and
  each other**, so prerequisites P1–P6 and an enable gate were added (F9, delivery F1);
  token-file trust assumption stated (F10); untrusted-text envelope extended to all
  worker-originated fields (F11); slice-4 patch design replaced by a constraints list with an
  allowlist and isolated git config (F13, delivery F6); slice-2 hook seam named honestly —
  callbacks, not an event bus — and split from the health work (F14, delivery F3, boundary F2);
  slice 1 invariants listed and 1a/1b split (delivery F2, F7); watchdog question made a slice-1
  acceptance gate (delivery F5); A2A vocabulary confined to `a2a-client.ts` and registration
  validation owned by one pure function (boundary F3, F5); ports and extra directories dropped
  in favour of one directory (minimalist, over the boundary critic's port design — recorded as
  a deliberate choice, to be revisited at a second backend).
- *Rejected / deferred with reason:* per-task launch credentials (follow-up; matches `kookr
  spawn`'s trust model, stated); observed-lane de-duplication (avoids coupling the stores);
  queue (no contention observed); push notifications; restart-time `tasks/list` prefix scan
  after store loss (disable-with-error is simpler and safe for a single operator).
- `design-experimenter` 2026-11-07 (two rounds): falsified the first draft's cancel, restart,
  card-address, ownership/reset and card-based peer-check premises; confirmed disconnect
  tolerance **only for `message/send`/`tasks/subscribe`**, which corrected the round-1 probe
  that had used a blocking call.
- `general-purpose` 2026-11-07: consensus-attack — **finding**: the panel never validated the
  use case (text-only, ≤5 min, result into a live parent) against the alternatives a Claude
  subagent or `hx.sh bridge` already provides, and never weighed push delivery. Triaged once:
  incorporated as the *Decision* section and Alternative 9; no further review round, per
  the one-attack bound. It is a product question for the operator, not a design defect.
- *v5 (focused delivery review of v4, incorporated):* slice 1 split into triage and audit; P7
  and P3 added to the enable gate; immutable per-commit snapshots owned by Kookr with `baseSha`;
  worker↔project mapping and attested `workspaceMode`/`replyTimeoutSec` in the registry;
  typed submit body with a server-assembled, versioned prompt; per-kind result schema,
  `invalid_result`, and path verification; allow-listed, marker-idempotent effect step; long-job
  transport via `tasks/get`/`tasks/subscribe`; playbook fallback and revert order; stale
  "text-only" statements reconciled; the value test is now an explicit gate.
- *v4:* the operator answered the decision gate (triage, implementation, test-quality audits); slice 1 was re-scoped to read-only-workspace analysis, implementation promoted to slice 4 with its own RFC, supervisor-performs-side-effects stated as a principle, P7 added, and the value test recorded. These edits were then covered by the focused delivery review incorporated in v5 above (not by a full critic-panel round).
- `ambition-amplifier`, `assumption-archaeologist`: not invoked.
- Adversarial pair (design-minimalist vs boundary-critic) disagreed on ports: the author sided
  with the minimalist for v1 because the architecture-boundary checker already forbids the
  dependency that matters (core→server) and nothing in v1 lives in core.
