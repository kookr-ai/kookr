# RFC: Collaborative Remote Sessions

**Status:** Draft (v7 - local-only safety verification)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Codex and Claude)

---

## Problem

Kookr is currently a local supervisor dashboard. A single Node.js backend owns
managed dtach sessions, serves the React dashboard, pushes state over a JSON
WebSocket, and exposes an xterm.js terminal stream through `SessionBridge`.
This works well when the developer is at the machine running Kookr, but it
does not support collaborative operation:

1. Jean may start Kookr on a desktop machine, then want to inspect or steer it
   from a phone.
2. Family or collaborators may need to join from other machines, watch the same
   running agent output, and send the next message.
3. Multiple connected users should see the same live stream for a session, not
   separate terminal captures with divergent timing or missing bytes. They also
   need visible collaboration semantics: who is watching, who has control, and
   who sent each command.
4. Speech features are unevenly available. A desktop may run bundled Docker
   STT/TTS because it has memory/GPU headroom. A phone may already have native
   STT/TTS and should not depend on the desktop's heavyweight local models.

The architecture must keep Kookr's current default security posture: local-only
unless the operator explicitly opts into remote collaboration.

## Requirements

These requirements describe the target architecture. The smaller V1 slice is
defined separately below.

### Functional

1. **R1. Session discovery.** An authenticated user can see which Kookr nodes
   are online and which tasks/sessions they expose.
2. **R2. Shared live viewing.** Multiple clients connected to the same session
   receive the same terminal byte stream in the same order.
3. **R3. Controlled input.** Shared terminal input is guarded by an explicit
   controller lease: many users may observe, but at most one remote operator
   may write to a session at a time.
4. **R4. Reconnect.** A reconnecting client receives a current session snapshot
   plus recent terminal replay before live streaming resumes.
5. **R5. Mobile access.** The architecture works from phone browsers without
   requiring inbound ports on the desktop running agents. Mobile clients
   receive block alerts via Web Push so they do not need to hold an open tab.
6. **R6. Multi-user collaboration.** A session owner can invite specific users
   and assign read-only or operator permissions.
7. **R7. Device capability discovery.** Clients and nodes advertise available
   local capabilities such as microphone capture, STT, TTS, notifications, and
   clipboard support.

### Security

8. **R8. Off by default.** Remote collaboration is disabled unless configured.
9. **R9. Outbound node connection.** A local Kookr node does not require router
   port forwarding; it connects outbound to a coordination relay.
10. **R10. Least authority by action.** Viewing, commenting, terminal input,
    launch, stop/delete, workspace cleanup, and permission approval are
    distinct grants. No remote role receives the existing local WebSocket
    command union wholesale.
11. **R11. Explicit session sharing.** A node must not expose all sessions to
    all authenticated users by default. Sharing is per node, project, task, or
    session according to policy.
12. **R12. Auditable commands.** Every remote command records actor, node,
    task/session, action, authorization decision, timestamp, request id, source
    client, and delivery result.
13. **R13. Secret minimization.** Relay logs and durable storage must avoid
    persisting terminal bytes or prompts unless explicitly configured for
    replay/debugging, because agent streams may contain secrets.
14. **R14. Plaintext-relay consent gate.** Phases that stream terminal bytes
    through the relay (Phase 3+) are blocked at the node unless the operator
    has explicitly set `KOOKR_RELAY_TRUSTED=true`. Sharing a session with a
    non-owner identity also requires a one-time UI acknowledgement that the
    relay host can observe terminal bytes.

### Operational

15. **R15. Local source of truth.** The machine running the agents remains the
    authority for process lifecycle, dtach sockets, hook files, transcripts,
    and task persistence.
16. **R16. Local authorization gate.** The local node revalidates every
    relay-originated command against local policy. Relay authentication is not
    sufficient authority to mutate a node.
17. **R17. Relay degradation.** If the relay is unavailable, local Kookr keeps
    working. Remote clients lose collaboration until the node reconnects.
18. **R18. Ordering.** Terminal bytes, user inputs, and task state updates have
    monotonic sequence numbers per session so clients can detect gaps. Remote
    commands include `commandId`, `actorId`, `baseRevision`, and idempotency
    key. Field semantics, scopes, and validation owners are specified in
    "Coordination primitives" below.
19. **R19. Backpressure.** Slow remote clients do not stall the local agent
    process or local dashboard.
20. **R20. No relay-side agent execution in V1.** The relay does not run coding
    agents, shell commands, hooks, STT, or TTS in the first version.
21. **R21. No offline terminal input queue.** If the node or session is offline,
    the relay may queue safe intents such as comments or notifications, but not
    raw terminal bytes or permission decisions.
22. **R22. Protocol version negotiation.** Node and relay exchange a
    `hello` handshake declaring `protocolVersion` and supported features
    before any other message. Mismatched versions degrade to the smaller
    intersection or refuse the session with a structured error; they do not
    silently drop messages.
23. **R23. Local-only operation is a first-class supported configuration.**
    A Kookr install with no `KOOKR_RELAY_URL` set MUST behave
    functionally identically to today's Kookr across every phase 0a–7. No
    remote-collaboration module may run code paths in local-only mode
    beyond inert imports. Every phase carries a mandatory **local-only
    smoke test** as an acceptance gate (see Migration Plan). This is a
    requirement, not an aspiration: a phase that fails the local-only
    smoke test does not ship.
24. **R24. Local-only configuration footprint is bounded.** A user who
    never enables remote collaboration MUST NOT be required to learn,
    set, or maintain any `KOOKR_RELAY_*`, `KOOKR_PUSH_*`,
    `KOOKR_AUDIT_*` environment variable beyond the defaults. Defaults
    MUST be safe for a local-only install. Any new env var added by a
    remote-feature phase MUST be opt-in: absent the variable, the node
    behaves as if remote collaboration is disabled.

## Current Architecture Constraints

The existing architecture has two separate real-time planes:

- **Control plane:** JSON `ServerMessage` / `ClientMessage` over the dashboard
  WebSocket. This carries snapshots, alerts, task lifecycle, suggestions,
  project summaries, workspace actions, and configuration changes.
- **Terminal plane:** `SessionBridge` streams raw terminal bytes between
  xterm.js and `TerminalBackend`. The current bridge replays
  `backend.captureBytes(sessionId)`, subscribes to `backend.onData(sessionId)`,
  and forwards inbound bytes to `backend.write(sessionId, bytes)`.

That split is useful and should survive the remote architecture. The relay
should not parse terminal bytes, infer session state from terminal text, or
replace the local `TerminalBackend`. It should authenticate users, broker
discovery, multiplex streams, serialize remote input, and provide short replay.

Three current assumptions must not leak into the remote design:

- The current HTTP routes and WebSockets are localhost-trusted. They do not
  model human identity, invitations, roles, or per-action authorization.
- `/ws/terminal/:session` treats a session id as enough to attach. Session ids
  must not become bearer credentials in a remote deployment.
- `TerminalBackend.write` serializes bytes, but byte ordering is not the same
  as collaboration semantics. Remote operation needs an explicit controller
  lease and audit trail above the write mutex.

## Architecture Options

### Option A: Expose the Local Kookr Server Directly

Run Kookr on the desktop and expose `localhost:4800` through VPN, Tailscale,
ngrok, Caddy, or router port forwarding.

**Pros**

- Minimal code change.
- Keeps the current backend/frontend model intact.
- Good enough for a single trusted user on a private VPN.

**Cons**

- Authentication and authorization are bolted onto a server that was designed
  for localhost.
- Sharing policy is all-or-nothing unless the local server grows multi-tenant
  identity everywhere.
- Inbound connectivity is fragile on home networks and mobile use.
- Harder to support multiple Kookr nodes under one account.

**Verdict:** acceptable as an operator workaround, not the product
architecture. Still useful as a hardening baseline: before any relay work,
Kookr should learn connection identity, action audit, event ids, and a local
single-controller policy.

### Option B: Remote Coordination Relay + Outbound Kookr Nodes

Deploy a small remote service, likely via Docker Compose, that acts as the
identity, discovery, relay, and collaboration layer. Each local Kookr instance
connects outbound to it and registers a node manifest. Browsers and phones
connect to the relay, not directly to the desktop.

```
Phone / browser clients
        |
        | HTTPS / WSS
        v
Remote Kookr Relay
  - auth and invitations
  - node/session directory
  - stream fanout and replay
  - command broker and audit
        ^
        | outbound WSS tunnel
        |
Local Kookr Node on desktop
  - TaskStore / Monitor / hooks
  - LocalDtachBackend
  - SessionBridge equivalent
  - optional local STT/TTS
        |
        v
Claude Code / Codex sessions
```

**Pros**

- No inbound ports on local desktops.
- Clean separation: relay owns collaboration; local node owns processes.
- Supports multiple devices and multiple remote users naturally.
- Can support multiple Kookr nodes per account later.
- Fits current `SessionBridge` fanout and task snapshot boundaries.

**Cons**

- Requires a new authenticated service and tunnel protocol.
- Relay becomes security-sensitive infrastructure.
- Replay and audit need careful retention defaults to avoid secret leakage.
- Offline relay means remote collaboration is down, even though local Kookr
  still works.

**Verdict:** recommended target architecture. The first production slice should
be read-only remote dashboard plus alerts; shared terminal input comes after
sequenced events, local authorization, audit, and controller leases exist.

### Option C: Fully Remote Hosted Kookr

Move agent execution to the remote server. Users connect to a hosted Kookr
instance that runs all agents in containers or remote workspaces.

**Pros**

- Simple collaboration model: everything is already on the server.
- Easier global availability and persistence.
- Mobile clients are just clients.

**Cons**

- Breaks Kookr's local-first premise.
- Requires remote access to source trees, credentials, local files, GitHub CLI
  auth, Claude/Codex auth, and desktop-specific tools.
- Harder to reuse existing dtach/session recovery code.
- Expensive and risky for personal machines and private repos.

**Verdict:** out of scope for V1; possible long-term hosted product line.

### Option D: Peer-to-Peer Session Sharing

Use WebRTC or a mesh overlay between clients and the desktop node, with a small
signaling server for discovery.

**Pros**

- Relay sees less data if streams are end-to-end encrypted.
- Potentially lower latency for nearby peers.
- Avoids central stream bandwidth costs.

**Cons**

- NAT traversal, mobile network behavior, TURN fallback, and reconnection add
  substantial complexity.
- Multi-viewer replay and audit still need a coordination service.
- The trust model is harder to explain than a normal HTTPS relay.

**Verdict:** defer. Useful later if relay bandwidth or privacy requirements
justify it.

## Decision

Adopt **Option B: Remote Coordination Relay + Outbound Kookr Nodes**.

The relay is a collaboration control plane. It does not run agents and it does
not become the canonical task store. A local node remains the source of truth
for task state, terminal sessions, hook processing, transcripts, crash recovery,
and local-only integrations.

The decision is about the end-state architecture, not V1 scope. V1 should not
attempt full collaborative terminal control. The safe sequence is:

1. local hardening for identity, audit, event ids, and one active terminal
   writer;
2. remote read-only dashboard with push notifications over an outbound node
   connection;
3. opt-in terminal viewing;
4. bounded supervised actions (skip/snooze/mark-done/preset-reply/permission
   approve) with local node authorization, split into a safe sub-phase before
   allowlisted launch;
5. shared terminal control through controller leases;
6. speech capability advertisement and routing;
7. broader multi-user collaboration and multi-node account UX.

## Local-Only Safety Contract

Kookr ships today as a single-user local supervisor. The collaborative
relay is opt-in. The phases in this RFC must not regress the local-only
experience — that is the install everyone runs, including the author.

### CI prerequisites (built BEFORE Phase 0a ships)

The per-phase smoke gate is meaningless unless its test surface exists.
The following must be merged before Phase 0a:

1. **`pnpm test:smoke` script and CI job.** A new GitHub Actions job in
   `.github/workflows/ci.yml` that runs the smoke test (see below) on
   every PR touching `src/`. Path-filtered. Required-to-merge.
2. **Module-load purity test** (`src/remote/__tests__/load-purity.test.ts`).
   Imports every `src/remote/*` module in isolation and asserts:
   no filesystem writes, no network sockets opened, no `process.on`
   handler registrations, no `setInterval`/`setTimeout` scheduled, no
   `require.cache` side effects beyond the module itself. A remote
   module that violates this test fails CI even if it passes the
   behavioral smoke test.
3. **ESLint `no-restricted-imports` rule** in `.eslintrc.cjs`:
   - Files under `src/server/**`, `src/core/**`, `src/adapters/**`,
     `src/frontend/**` MUST NOT import from `src/remote/**` *unless*
     the import is `import type` only.
   - `src/server/index.ts` is the sole exception, allowed to use
     dynamic `import()` inside the `KOOKR_RELAY_URL` branch (see
     "Code-path isolation" below).
   - Severity: `error`. Lints on every commit.
4. **`~/.kookr/` filesystem-diff smoke step.** The smoke test snapshots
   the contents of `~/.kookr/` before starting Kookr and again after
   the 8-step run; only the pre-existing files plus
   `~/.kookr/tasks.json` may have changed. Any new file (especially
   `audit.jsonl`, `audit.db`, `policy-cache.json`, `node-epoch`) when
   `KOOKR_RELAY_URL` is unset is a failed gate.
5. **`SessionBridge` golden-output fixture** in
   `src/server/__tests__/session-bridge.byte-equality.test.ts`. Uses
   the existing `FakeTerminalBackend` with a fixed scripted byte
   sequence; produces a deterministic golden file. Phase 3's
   acceptance gate compares against it byte-for-byte.

Without these five, Phase 0a's gate is process theater. They are
described as test/infra additions to the existing Kookr repo, not as
new modules in `src/remote/*`.

### The local-only smoke test (mandatory per phase)

The smoke test runs Kookr with **`KOOKR_RELAY_URL` unset**,
**`KOOKR_FAKE_TERMINAL=false`** (real PTY, not the test fake), and
**`KOOKR_USE_FAKE_AGENT=false`** (real agent, scripted prompt). It
asserts:

1. Server starts and serves the dashboard on localhost. **No startup
   log line matches `level=error`** from any of: ralph-loop service,
   schedule runner, achievement watcher, ledger watcher, telemetry
   writer, supervisor watch loop, project drawer hydration, OSS
   source watcher.
2. A new task can be launched from the dashboard (Claude or Codex).
3. The terminal stream renders end-to-end (output bytes appear in
   xterm.js) **via the real `SessionBridge` against a real
   `LocalDtachBackend`**.
4. Direct typing into the local terminal is accepted and forwarded
   without any controller-lease arbitration.
5. A permission prompt produced by the agent is rendered locally and
   the operator can approve it locally through the existing local
   resolver path (no detour through `permission-broker.ts`).
6. The task-completion chime fires on task completion.
7. **STT path (skipped if `KOOKR_STT=false`)**: when `KOOKR_STT=true`,
   the local STT WebSocket reaches `ready` state and produces draft
   text in the dashboard. `sttEnabled` and `sttUrl` fields are present
   on `SnapshotMessage`.
8. **TTS path (skipped if `KOOKR_TTS=false`)**: TTS pronounces a
   block-alert sample without errors.
9. **No new files appear under `~/.kookr/`** beyond the pre-existing
   inventory (see prerequisite 4).
10. **Module-load purity** (prerequisite 2) passed as a precondition
    of the same CI job.
11. The server can be stopped and restarted; the existing task list
    reappears. Crash recovery does not call into `policy-cache.ts`,
    `command-journal.ts`, or any `src/remote/*` module.

A phase that does not pass the local-only smoke test does not ship.
Phases 0a, 3, and 6 carry additional phase-specific gates (see Migration
Plan).

### Author canary period

Smoke-test green is necessary but not sufficient. Each phase has a
**canary period** during which the phase code is running on the
author's own daily-driver Kookr install with no relay configured,
before the phase is declared shipped. Recommended canary windows:

- Phase 0a: ≥ 5 days (highest local-only blast radius).
- Phase 3: ≥ 5 days (`SessionBridge` refactor).
- Phase 6: ≥ 5 days (STT/TTS migration).
- Other phases: ≥ 2 days.

A canary period that surfaces any local-only regression resets the
clock and re-opens the phase for fixes.

### Code-path isolation

Remote-collaboration modules (everything under `src/remote/`, the
`relay/` directory, and Web Push subscription management) MUST NOT be
imported into local-only execution paths beyond `import type`. The
loader rules:

- **Dynamic import only.** `src/server/index.ts` calls
  `await import('./remote/node-client.js')` *inside* the
  `if (process.env.KOOKR_RELAY_URL)` branch. No top-level
  `import { NodeClient } from './remote/...'` in any non-remote file.
  Top-level imports execute module code at process start, before the
  env-var check runs.
- **No top-level side effects in `src/remote/*`.** No SQLite handle
  opened, no listener registered, no LRU primed at module load.
  Enforced by `load-purity.test.ts`.
- **`TerminalBackend.write` is not modified.** Phase 5's lease check
  is in a `src/server/remote-input-adapter.ts` *wrapper* that calls
  `controller-lease.ts` and then `TerminalBackend.write`. Local
  keystrokes never traverse the lease wrapper; they call
  `TerminalBackend.write` directly as they do today.
- **`permission-broker.ts` is sidecar, not wrapper.** The existing
  local permission resolver continues to handle local prompts; the
  broker is a *separate* code path activated only when a
  relay-originated `permissionApprove` arrives. Phase 4a's structural
  rule: the existing local resolver's call sites are not modified.
- **`session-stream-publisher.ts` is a separate subscriber.** The
  publisher subscribes to `TerminalBackend.onData` alongside the
  existing `SessionBridge` local subscribers. Local clients keep
  using `SessionBridge` unchanged; the publisher is constructed only
  when the remote-node client is active.
- **`KOOKR_RELAY_FEATURES` and all other `KOOKR_RELAY_*` /
  `KOOKR_PUSH_*` env-var parsing happens inside the dynamically
  imported remote module**, not in a central config loader. A
  local-only install does not read these variables.
- **`policy-cache.ts` is never populated in local-only.** Grant checks
  for local operations short-circuit on "owner is local" before any
  cache lookup. The short-circuit is a single named function
  `isOwnerLocal()` in `src/server/auth.ts`; the broker, command
  pipeline, and any future grant consumer call this function first.
- **`serverRevision` is not emitted on `SnapshotMessage` in
  local-only mode.** The optional field is added to the type, but the
  server only populates it when the remote-node client is active.

### CLI command-history aggregation (Phase 4a+)

`kookr command outcome <commandId>` is a Phase 4a CLI that must work
for both local-only and relay-active installs. The CLI lives in
`src/cli/` (not `src/remote/`) and queries both stores:

1. First, the existing `src/core/interaction-log.ts` (local commands).
2. Then, `~/.kookr/audit.jsonl` (remote commands, if present).
3. Aggregates results and returns a unified outcome list.

A local-only user who runs `kookr command outcome` sees their local
commands, not an empty result. The CLI never imports from
`src/remote/*` at runtime; it reads the audit journal file directly.

### Defaults and configuration footprint

Every `KOOKR_RELAY_*`, `KOOKR_PUSH_*`, and `KOOKR_AUDIT_*` environment
variable defaults to "remote disabled, no-op." Local-only operators do
not need to set any new variable. The first time `KOOKR_RELAY_URL` is
set, the node prints a one-line message indicating which features are
now enabled; absent the variable, no such message appears.

### `tasks.json` and on-disk schema (forward+backward+cycle)

`tasks.json`, `~/.kookr/interaction-log.jsonl`, and any other local
on-disk state remain readable across phase up/downgrades. The migration
test per phase exercises three paths:

1. **Forward**: install Phase N, run, install Phase N+1, run smoke test.
2. **Backward**: install Phase N+1, run, install Phase N, run smoke test.
3. **Cycle**: install Phase N, run, upgrade to N+1, run, downgrade to
   N, run, re-upgrade to N+1, run smoke test. Catches any
   "Phase N+1 assumes monotonic forward progress" bug.

The cycle test exercises the `interaction-log.jsonl` shape (not just
`tasks.json`) and the audit-journal-file presence/absence transitions.

### Relay-tainted state cleanup

A user who briefly enables `KOOKR_RELAY_URL`, then unsets it, may have
on-disk state from the remote-active period (audit journal entries,
populated policy cache, idempotency tuples). The contract:

- The next local-only start MUST succeed cleanly, with no reconnect
  attempt, no scary error logs, and no behavior difference from a
  never-enabled install.
- `kookr local-only doctor` (a new CLI in `src/cli/`) inspects
  `~/.kookr/`, reports any remote-tainted files, and offers to
  archive them to `~/.kookr/archive-<timestamp>/` so they no longer
  affect operation. The doctor never deletes files automatically.
- The smoke test's `relay-tainted-cleanup` step exercises this path:
  set `KOOKR_RELAY_URL` to a stub relay, start, stop, unset, restart
  with `KOOKR_RELAY_URL` unset, run the 11-step smoke; all assertions
  must pass.

### Browser bundle cache mismatch

The dashboard SPA is cached aggressively in the browser. Phase
up/downgrades can produce a fresh bundle running against a
stale-shape server (or vice versa). The contract:

- The dashboard frontend tolerates `SnapshotMessage` fields it does
  not recognize (silent ignore) and tolerates fields it expects but
  does not receive (graceful fallback to "feature not available"
  state).
- The Phase 6 STT migration includes a `bundle-cache-mismatch` test
  in `src/frontend/__tests__/`: a Phase-6 bundle is loaded against
  a Phase-5 mock server (no `SpeechCapability` descriptors emitted)
  and the dashboard's STT panel falls back to the legacy
  `sttEnabled`/`sttUrl` path without error. Same in reverse.

### STT/TTS legacy fields

The `sttEnabled` and `sttUrl` fields on `SnapshotMessage` are
**preserved unchanged through Phase 5**. Phase 6 introduces the typed
`SpeechCapability` descriptors in parallel; **the legacy fields and the
new descriptors coexist for at least two minor releases** before the
legacy fields are removed. Local-only STT users see no behavior change
until they explicitly migrate their dashboard frontend. The legacy
fields' deprecation is gated on a concrete bilingual test:

**Bilingual STT parity test** (Phase 6 acceptance gate). The test:
1. Starts the server with `KOOKR_STT=true`.
2. **Strips `sttEnabled` and `sttUrl`** from every `SnapshotMessage`
   sent to the test client.
3. Verifies the test client (running the Phase 6 frontend bundle) can
   drive the local STT WebSocket to `ready` state using only the new
   `SpeechCapability` descriptors and produce draft text.

Legacy fields are removed only when this test passes for two
consecutive minor releases. Without this, "parity" is qualitative and
the legacy fields could be removed before the new path is proven.

## V1 Scope

V1 is deliberately narrow: **single owner, one local node, read-only remote
visibility with mobile push for block alerts**. It includes:

- outbound local-node connection to the relay;
- node presence;
- remote-safe task list and task state;
- findings and block alerts;
- Web Push delivery to the owner's phone for block alerts;
- coarse task detail metadata safe enough to leave the node.

V1 explicitly excludes terminal byte streams, remote input, permission
approval, invitations, multi-user roles, speech capability routing, and
multi-node account UX. Those are later phases.

## Coordination Primitives

The relay/node split introduces several monotonic counters and identifiers.
Their scopes, owners, and validation rules are specified here so they have a
single source of truth and so the relay and node implementations cannot
silently disagree.

### Identifiers and counters

| Name | Scope | Sole writer | Semantics |
|---|---|---|---|
| `nodeId` | global, opaque | local node (first run) | Stable across restarts and software upgrades. Persisted to `~/.kookr/node-id`. Regenerated only when the file is deleted; relay treats a new `nodeId` from the same credential as a new registration. |
| `nodeEpoch` | per `nodeId` | local node | Advances on every node process start. **Persist-before-use**: the new `nodeEpoch` is fsync'd to `~/.kookr/node-epoch` *before* the node emits any outbound message tagged with that epoch. A crash between increment and persist replays the previous epoch and re-increments on next start, never colliding with an epoch the relay has already observed. If the persist fails (`EROFS`, `ENOSPC`, etc.), the node enters `nodeMode: 'degraded'`: it continues serving the local browser UI but refuses to emit any outbound (relay-facing) message until the persist path is recovered. The startup log includes `event: 'node.degraded', reason: 'epoch-persist-failed'` so operators see the cause. Forces relay to require fresh snapshot before accepting commands. |
| `sessionId` | per node | local node | Opaque session identifier. |
| `sessionEpoch` | per `sessionId` | local node | Advances when the local PTY is recreated for the same `sessionId`. |
| `serverRevision` | per `(nodeId, sessionId)` | local node | Monotonic counter for control-plane state updates on a session. Carried in `RemoteControlEvent` for snapshots and deltas. Optional on local-only `SnapshotMessage`; clients ignore when absent. |
| `seq` | per `(nodeId, sessionId, sessionEpoch)` | local node | Monotonic counter for terminal byte chunks. Resets on `sessionEpoch` bump. |
| `policyVersion` | per `(ownerId, sessionSharePolicy.subjectKey)` | **relay only** | Increments on grant creation, modification, or revocation. Node holds a pull-replica cache, never increments locally. |
| `grantId` | per grant | relay | Opaque, stable for the lifetime of the grant. |
| `commandId` | per command | issuing client | Opaque, unique across the actor's lifetime. |
| `idempotencyKey` | per intent | issuing client | See "Idempotency" below. |
| `leaseId` | per controller lease | local node | Bound to `(sessionId, sessionEpoch)`; invalidated automatically on epoch bump. |
| `permissionRequestId` | per pending local prompt | local node | Bound to `(sessionId, sessionEpoch)`; expires with the prompt. |

### Idempotency

Idempotency key tuple: `(nodeId, nodeEpoch, sessionId, sessionEpoch, grantId, idempotencyKey)`.
Two commands with the same tuple are treated as duplicates; the node returns
the original result regardless of `commandId`. The `grantId` is included so a
revoked-and-re-issued grant cannot collide with the previous grant's
in-flight commands.

**Client retry contract.** Clients MUST keep `idempotencyKey` stable across
all retries of the same logical intent, even when minting a fresh
`commandId`. The node deduplicates by the tuple above, not by `commandId`,
so a `commandId` retry with the same `idempotencyKey` is safe; a retry
with a *different* `idempotencyKey` is treated as a new intent and may
double-execute. Client libraries surface this rule as: "retry → keep
key; new attempt → new key."

Retention: the node retains the idempotency tuple → result mapping for
**24 hours** or until the relevant `sessionEpoch` advances, whichever is
shorter. Cache is persisted alongside the audit log so it survives node
restarts within the same `nodeEpoch`; it is purged on epoch bump so a
crash-recovered node cannot replay stale acks against new state.

Ack-loss recovery: clients that do not receive an ack within `maxAgeMs` may
re-submit with the **same** `idempotencyKey`; this is safe. Re-submitting with
a different `idempotencyKey` is unsafe and may double-execute. Clients that
want to query the outcome instead may call:

```ts
interface CommandOutcomeQuery {
  commandId: CommandId;
  nodeId: NodeId; // required for relay routing; node-local CLI call omits
}

type CommandOutcome =
  | 'accepted'                 // execute audit row present, result success
  | 'rejected'                  // execute audit row present, result failure
  | 'rejected-pre-audit'       // pre-audit validation reject (invalid grant,
                                // stale baseRevision, malformed payload).
                                // **Deterministic** — retrying with the same
                                // request shape will fail the same way; the
                                // client must refresh its view (new
                                // baseRevision, fresh grant) before retrying.
  | 'unknown-intent-only'      // intent row present, result row absent
                                // (node crashed between intent and execute,
                                // OR record was purged from the live cache
                                // but no result was ever observed) —
                                // **do not auto-retry**
  | 'unknown-never-seen'       // no audit trace found; safe to retry with
                                // same idempotencyKey
  | 'node-offline';            // relay cannot reach node; caller chooses
                                // whether to retry on reconnect
```

To make `unknown-never-seen` safe (it must mean "no side effect ever
happened"), the node MUST write a minimal pre-audit reject row for
deterministic validation failures (invalid grant, stale baseRevision,
malformed payload). Without that row, a deterministic reject would look
identical to "never seen" and clients would loop. The pre-audit row
records the rejection reason and the idempotency tuple but does not
record request payload content.

The relay's `command.getOutcome` proxies to the node when the node is
online. The node-local CLI (`kookr command outcome <commandId>`) queries
the audit log directly and never returns `node-offline`. Clients that
receive `unknown-never-seen` may safely re-submit with the same key;
clients that receive `unknown-intent-only` or `unknown-purged` must
surface the ambiguity to the operator rather than retry.

### `baseRevision` vs `lastSeenSeq`

These two freshness fields belong to different planes and have different
validators:

- `baseRevision` belongs to the control plane. It is the caller's last
  observed `serverRevision` for the target session. Validated by the node's
  command handler against task state. A stale `baseRevision` produces
  `error.staleControlPlane` with the current `serverRevision` echoed back so
  the client can refresh and retry.
- `lastSeenSeq` belongs to the terminal plane. It is the caller's last
  observed terminal `seq` for the target session. Validated by the node's
  session-stream component against terminal state. A stale `lastSeenSeq` does
  not block low-risk commands; it produces `warning.staleTerminalView` for
  high-risk commands (raw terminal input, permission approve) so the client
  can confirm the operator saw the latest bytes.

The two checks are independent and may produce different verdicts on the same
command. The node's command pipeline runs them in order (control first,
terminal second) and surfaces the first rejection.

### Control-plane / terminal-plane merge contract

Both planes deliver to the same client. Their ordering is reconciled by
**wall-clock `ts` on the node** as a tie-breaker only. The contract is:

- `RemoteControlEvent.serverRevision` is monotonic per session.
- `TerminalStreamEvent.seq` is monotonic per `(session, sessionEpoch)`.
- Within a session, a control event with `kind: 'lease.changed'` is delivered
  to the relay **before** any terminal byte that depends on the new lease
  state. Clients may treat the control event as a happens-before barrier.
- Snapshots replay both planes by sending the latest `serverRevision` and the
  current `seq` cursor; the client resumes either plane from those cursors.

### Session epoch bump propagation

When the local PTY for `sessionId` is recreated (e.g., on dtach reattach
after process crash), the node performs the following atomic transition:

1. Increment `sessionEpoch` and fsync the new value.
2. Emit a single `RemoteControlEvent { kind: 'session.epoch-changed' }`
   with the new `sessionEpoch`, current `serverRevision`, and a list of
   resources invalidated (`leases`, `permissionRequests`, `idempotencyKeys`).
3. The terminal stream resumes at `seq: 1` for the new epoch.

The single broadcast event is an **optimization**, not a requirement.
If the event is dropped (network gap), any subsequent message — control
or terminal — that carries a higher `sessionEpoch` than the client's
current value is itself a trigger for epoch-bump handling: the client
discards its replay buffer, requests a snapshot, and disables input
until the snapshot arrives. The explicit event lets clients flush in
one round-trip rather than discovering invalidation per-resource;
implementations must still tolerate its loss. Clients that submit
commands stamped with the old `sessionEpoch` receive
`error.staleSessionEpoch` with the current epoch echoed back.

### PolicySync

Share policies live on the relay. The node holds a read-through cache. The
relay is the sole writer of `policyVersion`. Sync protocol:

1. On node connect or reconnect, relay sends `policy.sync` with the full set
   of grants targeting this `nodeId` and the current `policyVersion` per
   `subjectKey`.
2. On any grant create/modify/revoke, relay sends `policy.delta` with the
   incremented `policyVersion` to the node, before forwarding any command
   that references the new version.
3. The node acks each `policy.delta` with `policy.delta.ack` carrying the
   accepted version. The relay queues commands referencing
   `policyVersion: N+1` in a `command-held-pending-policy-ack` state for at
   most **2 seconds** while waiting for the node's ack. After 2s the relay
   rejects the held command with `error.policyVersionPending` so the
   client's `maxAgeMs` does not silently expire. Clients re-submit with a
   fresh `commandId` and the new `policyVersion` once their state is
   refreshed.
4. If the node receives a command referencing a `policyVersion` it has not
   acked, the node rejects with `error.unknownPolicyVersion` and requests a
   resync. The relay must not retry the command until resync completes.
5. On revocation, relay sends `policy.revoke` (keyed by `grantId`, not by
   `policyVersion` — the node correlates by `grantId` regardless of which
   version its cache currently holds), followed by `policy.delta` with the
   incremented version. Node terminates active subscriptions and cancels
   any controller leases held under the revoked grant within 5 seconds.

**Revoked-grant tombstone set.** The node persists a tombstone set of
revoked `grantId`s independent of the live grant cache. This survives
restarts and PolicySync resyncs. When a `policy.revoke` arrives for a
`grantId` the node has never seen (e.g., after a panic-clear cache wipe,
or after a missed `policy.delta`), the node still records the tombstone
and acks `applied-tombstone-only`. Subsequent `policy.delta` messages that
would re-introduce a tombstoned grant are rejected; the relay must mint a
new `grantId` if it intends to re-issue access. Tombstones are pruned only
on owner-initiated explicit reset (`kookr policy reset`), never silently.

**Ordering: in-flight command vs revocation.** Commands authorized at
`policyVersion: N` and forwarded to the node may arrive after a
`policy.revoke` for a grant they reference. The semantics are
**freshness-wins**: the node rejects the in-flight command with
`error.grantRevoked` if the revoke arrived first, even though the command
was authorized when issued. This avoids a fresh-revoke being honored
inconsistently across the relay (which already removed the grant) and the
node (which would execute).

**Audit reconciliation on freshness-wins reject.** The relay's metadata
audit row for the forwarded command starts in `forwarded` state. On
receiving the node's `command.outcome { rejected, reason: 'grantRevoked' }`
ack, the relay **appends** a terminal-outcome row referencing the original
`commandId` so the audit chain is closed. The relay's audit is
append-only; the terminal-outcome row is a separate append, not an
update. Reconciliation tooling joins by `commandId` to produce the full
lifecycle.

The node never increments `policyVersion`. Local-only revocations
(operator runs `kookr revoke-all` at the CLI) become a relay-side revocation
request that the relay then applies and propagates.

### Typed scope hierarchy

Replace the bare `subjectId: string` with a discriminated union:

```ts
type ShareSubject =
  | { kind: 'node'; nodeId: string }
  | { kind: 'project'; nodeId: string; projectId: string }
  | { kind: 'task'; nodeId: string; taskId: string }
  | { kind: 'session'; nodeId: string; sessionId: string };
```

Scope precedence is a closed enum: `session > task > project > node`.
Narrower-scope grants override broader-scope grants for the same action.
Both relay admission and node revalidation use this enum; no string
comparison.

### Protocol version handshake

Before any other message:

```ts
interface NodeHello {
  type: 'node.hello';
  nodeId: string;
  protocolVersion: number;
  supportedFeatures: string[];
  softwareVersion: string;
}

interface RelayHello {
  type: 'relay.hello';
  outcome: 'accepted' | 'downgraded' | 'refused';
  acceptedVersion: number;
  enabledFeatures: string[]; // intersection of node-supported and relay-supported
  disabledFeatures?: string[]; // features the node asked for but relay refuses
  refusalReason?: 'unsupported-version' | 'credential-revoked' | 'feature-incompatible';
}
```

Handshake flow: the node sends `node.hello` first; the relay replies
with exactly one `relay.hello` carrying `outcome`. All transient states
are implementation detail; the only outcomes a caller observes are the
three `outcome` variants. Any non-`relay.hello` message received before
the `relay.hello`, or a connection close before it arrives, is treated as
`refused` for backoff purposes. No control or stream traffic flows before
the `relay.hello` is processed.

Phase 1 ships at `protocolVersion: 1`. Each subsequent phase that adds
new wire-format obligations bumps `protocolVersion` by 1; phases that
only add new `RemoteControlEvent.kind` variants (which are
backward-compatible — unknown kinds are logged-and-ignored) do not
require a bump.

### Audit ordering (write-ahead)

The node uses a two-phase audit pattern for any state-mutating remote
command:

1. **intent**: append `auditEntry{ state: 'intent', commandId, ... }` and
   fsync.
2. **execute**: call `TerminalBackend.writeSequence(...)` or the relevant
   handler.
3. **result**: append `auditEntry{ state: 'result', commandId, outcome }`.

On node restart, intent rows without a result are recovered as
`outcome: 'unknown'`. The relay's metadata audit log carries the same
`commandId` and can be cross-referenced. `command.getOutcome` returns
`unknown` for such commands; clients must not auto-retry intent-only
commands.

## Design

### 1. Deployment Units

#### Local Kookr Node

The existing Kookr server gains an optional `remote-node` client:

- connects outbound to `KOOKR_RELAY_URL`;
- authenticates with a node token or device credential;
- registers node metadata: node id, display name, software version, public base
  URL if any, and feature flags;
- publishes remote-safe projections only, computed by the local node for the
  effective share scope; unshared tasks, raw repo paths, full prompts, hook
  payloads, transcript content, and environment data are omitted before leaving
  the node;
- later phases publish terminal byte chunks for explicitly shared sessions;
- later phases receive relay-originated commands, revalidate them against local
  policy, and only then write approved input to `TerminalBackend`.

The local dashboard continues to connect directly to the local server and does
not require the relay.

Node credentials are scoped to one tenant and one node registration. The relay
binds owner/account identity during provisioning; the node manifest cannot
self-assert `ownerId` as authority. Credentials are revocable, rotatable, and
never accepted for human UI login. Revocation closes active node WSS
connections and invalidates outstanding commands for that node epoch.

`nodeId` is persisted to `~/.kookr/node-id` at first run and is stable across
software upgrades and disk-preserving reinstalls. Disk loss requires
re-registration. Two co-located Kookr installs with the same `nodeId` are a
configuration error; the relay rejects the second registration with the same
credential.

#### Remote Relay

The relay is a small Node.js service, deployable with Docker Compose:

- HTTPS/WSS endpoint for web and mobile clients;
- WSS endpoint for Kookr nodes;
- user authentication and, in later phases, session invitations;
- node/session directory;
- Web Push fanout for block alerts (Phase 2);
- later phases add per-session stream fanout, short replay buffer, command
  broker, and metadata audit log;
- tracks per-session ephemeral state for in-flight `permissionRequestId`s
  (Phase 4) and for active controller leases (Phase 5); both are evicted on
  node-disconnect or epoch change.

The first relay slice needs storage for node registration, owner identity,
device credentials, presence, Web Push subscriptions, and protocol version
negotiation state. Later phases can add share policies, invitations, and
audit records. Terminal byte replay should default to in-memory bounded
buffers, not durable database rows.

The relay must not expose the current local `ClientMessage` union directly.
Messages such as `launch`, `directReply`, `permissionChoice`, `stop`,
`deleteTask`, `workspace:*`, and `clearCompleted` need separate remote command
types with separate authorization checks. The local node stamps and verifies
the command source server-side; it never trusts a caller-supplied "remote" or
"ui" source field.

**Minimum infrastructure for Phase 1.** An operator running the relay needs:

- a domain name with valid TLS (Let's Encrypt, Caddy, Traefik, or equivalent);
- the relay docker-compose stack;
- a node-token issued via `kookr relay init`;
- an OAuth provider or password store for human login; the V1 reference
  configuration uses GitHub OAuth.

`kookr relay init` runs against the relay's admin endpoint, authenticates
the operator, registers a new node entry, and prints:

```
$ kookr relay init --relay https://relay.example.com
Authenticating as owner@example.com... done.
Registered node: kookr-node-3f2c
Node token: kookr_tok_v1_aB...zQ (printed once; copy to secure storage)

Add to your node's environment:
  KOOKR_RELAY_URL=https://relay.example.com
  KOOKR_RELAY_TOKEN=kookr_tok_v1_aB...zQ
  KOOKR_RELAY_TRUSTED=true  # required for Phase 3+ terminal viewing
```

The relay stores only the token's hash (e.g., `argon2id`); the token
itself is never persisted server-side after issuance and cannot be
recovered. Rotation is `kookr relay rotate-token <nodeId>`. The relay
records `relay-trust-acknowledged: { ts, relayTlsFingerprint }` on the
node when `KOOKR_RELAY_TRUSTED=true` is first observed; on a TLS
fingerprint change (relay redeployed or migrated), the node logs a WARN
and refuses Phase 3+ streaming until the operator runs
`kookr relay trust accept` to re-acknowledge.

A local-only relay (without public TLS) is a supported development mode
but explicitly not the supported production target. The relay refuses
non-TLS remote connections.

#### Clients

Clients are browser applications served by the relay or by the local node:

- desktop browser;
- smartphone browser;
- later: native wrapper or Telegram-style lightweight remote client.

Clients advertise capabilities after login. These capabilities describe the
device, not the task session:

```json
{
  "type": "client.capabilities",
  "audioInput": "browser",
  "stt": ["browser-native"],
  "tts": ["browser-native"],
  "notifications": ["web-push"],
  "terminal": ["xterm"]
}
```

### 2. Session Sharing Model

V1 has no multi-user sharing. It only needs an owner-bound node credential and,
optionally, an owner-created read-only viewer token for personal mobile access.

For phases 1–6, the grant vocabulary is an **open string union** with a
small set of currently-known tokens; unknown tokens validate as deny by
default. This lets Phase 7 add grant types without re-versioning the
protocol envelope:

```ts
type ShareGrant = string; // open
type KnownGrant = 'view' | 'write' | 'admin'; // exhaustive for V1–6
```

The relay and node both maintain a `KnownGrant` switch that exhaustively
handles `view | write | admin`; any other string is treated as
`deny`. Phase 7 widens `KnownGrant` to include the collaborator set
(`comment`, `terminalInput`, `launch`, `stop`, `permissionApprove`) — a
mixed-version relay/node still functions because unknown tokens are
denied rather than crashing the switch. The richer collaborator-oriented
grant set lives in the Phase 7 appendix below.

Authorization is default-deny. Expired grants are ignored. Denies override
allows. Narrower scope overrides broader scope per the typed hierarchy in
"Coordination primitives".

Default invitation role (Phase 7+) is `view`. Permission approval is never
implied by terminal input; it is a separate, time-boxed grant because it can
approve file writes, shell commands, `gh` operations, or other high-impact
agent actions.

Invite acceptance binds the invite to an authenticated user account and device.
Invite links are single-use by default, expire within a bounded TTL, are stored
only as keyed hashes, and cannot be exchanged directly for node/session access
without completing login. Accepting an invite creates a grant record with
`inviteId`, `issuerId`, `acceptedByUserId`, `acceptedClientId`, `subject`
(typed), `grants`, `expiresAt`, and `policyVersion`. Revocation increments the
policy version, terminates active subscriptions, cancels controller leases,
and causes the node to reject later commands using the revoked grant.

The full Phase 7 type — `SessionSharePolicy` with members, deny lists, and
broad-scope inheritance — is defined in **Appendix A: Phase 7 sharing
types**, not in the V1 protocol contract.

### 3. Remote Protocol Shape

Use two logical channels over authenticated WSS:

1. **Node control channel:** handshake, registration, heartbeat, snapshots,
   state deltas, command broker traffic, lease changes, permission events,
   policy sync.
2. **Session stream channel:** terminal byte chunks, replay requests, resize
   events, and stream replay metadata.

V1 + Phase 2 control events:

```ts
interface RemoteControlEvent {
  nodeId: string;
  nodeEpoch: string;
  serverRevision: number;
  ts: string;
  kind: 'snapshot' | 'state.delta';
  payload: unknown;
}
```

Phase 3+ extends `kind` with `'terminal.attached'` and `'terminal.detached'`.
Phase 4+ adds `'lease.changed'`, `'command.ack'`, `'command.outcome'`,
`'permission.requested'`, `'permission.resolved'`, `'policy.delta'`. Phases
add only the variants they implement; clients that do not know a kind log and
ignore.

Terminal events (Phase 3+):

```ts
interface TerminalStreamEvent {
  nodeId: string;
  nodeEpoch: string;
  sessionId: string;
  sessionEpoch: string;
  seq: number;
  ts: string;
  kind: 'terminal.bytes' | 'terminal.resize' | 'terminal.replay-gap';
  payload: unknown;
}
```

Sequence numbers, scopes, freshness fields, and merge rules are specified in
"Coordination primitives".

The relay may pre-check and broker commands, but the node is authoritative for
lease validity, `baseRevision`, terminal context freshness, idempotency,
`policyVersion`, and final write acceptance. The relay broadcasts the node's
ack/result; it does not decide final delivery order.

### 4. Terminal Stream Fanout

The local node should expose a stream source similar to `SessionBridge`, but
without binding it to one WebSocket client:

- subscribe to `TerminalBackend.onData(sessionId)`;
- assign a monotonically increasing `seq` per `(session, sessionEpoch)`;
- push byte chunks to the relay;
- keep the existing local ring buffer for local replay;
- optionally keep a separate remote replay buffer sized by bytes and time.

The node owns canonical terminal sequence and ring replay. The relay may keep a
bounded in-memory mirror for fanout and reconnect. On gaps, the relay asks the
node for replay by sequence. If neither has the range, clients receive a
visible stream-gap marker. Terminal state is then untrusted and input remains
disabled until the node provides a current reset/snapshot or the user accepts
the current live-only view.

The relay fans out the exact same chunks to all subscribed clients. If a client
is slow, the relay drops that client after its outbound queue exceeds a bounded
threshold and lets it reconnect from replay.

### 5. Controller Lease and Input Serialization

Remote terminal input is not enabled until the session has a controller lease.

**Client-visible lease state set** (closed enum, broadcast via `lease.changed`):

| State | Meaning |
|---|---|
| `none` | No lease held; remote writes disabled |
| `acquiring` | Acquire request in flight |
| `held-local` | Local GUI holds the lease |
| `held-remote` | A remote operator holds the lease |
| `held-uncertain` | Lease was `held-remote`, but the relay-to-node WSS is unhealthy; clients MUST disable the input box and show a "controller connection uncertain" banner. The **node's authoritative view is still `held-remote`** until the heartbeat budget expires (15s default); the relay surfaces `held-uncertain` to clients while it cannot confirm node liveness. |
| `held-presumed-lost` | Client-only state. A client that has been in `held-uncertain` for more than `2 × heartbeatInterval + 5s` (35s default) presumes its lease lost and transitions visually to `held-presumed-lost`. Input remains disabled. The true terminal state arrives via `lease.changed { newState: 'revoked' }` on relay reconnect. |
| `revoked` | Lease ended (owner override, policy revoke, sessionEpoch bump, or heartbeat timeout). Terminal state. |

`releasing` is an internal node state during graceful release and is not
broadcast to clients; consumers observe the resulting `none` directly.

Transitions and rules:

- zero or one remote controller per session;
- owner can revoke or take over (transition: `held-*` → `revoked`, emit
  `lease.changed { newState: 'revoked', reason: 'owner-override' }`);
- **end-to-end heartbeat** acked by the node itself, not terminated at
  the relay; default interval is **15 seconds**, chosen to survive mobile
  NAT timeouts (~30s on most carriers) without burning battery. Missing
  one heartbeat moves the relay's client-facing view to `held-uncertain`;
  missing two consecutive heartbeats (≥30s without ack) is treated by the
  node as lease timeout — node transitions to `revoked` locally and
  broadcasts `lease.changed { newState: 'revoked', reason: 'heartbeat-timeout' }`
  on next relay reconnect;
- on node-relay WSS disconnect: node revokes outstanding leases locally
  *and* the relay surfaces `held-uncertain` to clients. On reconnect, the
  relay broadcasts `lease.changed { newState: 'revoked', reason: 'node-disconnect' }`
  for every lease bound to the previous `nodeEpoch`. These two states
  (node-revoked / client-uncertain) are not contradictory: they describe
  the same underlying event from two observers with different latency.
- **Owner-override during the 15s heartbeat gray zone.** If the node has
  not yet revoked the lease (less than 30s since last heartbeat) and the
  owner issues an override, the override **does not race** with a delayed
  controller-holder command. The node's local lease state is the single
  arbiter: the override transitions the lease to `revoked` and emits
  `lease.changed`. Any prior command from the former holder arriving after
  the override is rejected with `error.leaseRevoked`. Commands in flight
  are not preserved across an override.
- local GUI writes acquire or renew a local controller lease;
- remote writes are rejected while local input is active or within a configured
  idle window;
- arbitrary external `dtach` attaches cannot be reliably arbitrated; if such
  attach detection exists and is active, or if attach state is unknown, remote
  terminal input falls back to read-only;
- raw keystroke streaming is out of scope for V1.

When remote terminal input is enabled (Phase 5), it remains semantic submitted
messages rather than arbitrary bytes. The full `SubmitMessageRequest` and
`AuthorizedRemoteCommand` types are defined in **Appendix B: Phase 5 input
contract**.

Phase 4 ships a narrower forward write — `presetReply` — which uses a small
fixed-shape request:

```ts
interface PresetReplyRequest {
  type: 'preset-reply';
  sessionId: string;
  sessionEpoch: string;
  commandId: string;
  idempotencyKey: string;
  presetId: 'continue' | 'yes' | 'no' | 'skip';
  baseRevision: number;
  maxAgeMs: number;
}
```

The node maintains the canonical mapping from `presetId` to a normalized
text string; the relay never carries the text. The Phase 4 surface is
deliberately limited: it proves the auth/lease/audit chain on a small,
predictable mutation without unlocking arbitrary remote input.

Clients never provide `actorId`, `clientId`, grants, source, or authorization
result on any command. The relay derives them from authenticated state, and
the node rejects caller-supplied identity fields.

Delivery flow (applies to `presetReply`, `permissionApprove`, and the Phase 5
`SubmitMessageRequest`):

1. Client sends the request with the relevant freshness fields, `commandId`,
   and `idempotencyKey`.
2. Relay checks role and policy, then appends a metadata audit row.
3. Relay forwards an `AuthorizedRemoteCommand` envelope (defined in
   Appendix B) carrying the original request payload.
4. Node revalidates local grant, lease (where applicable), node/session epoch,
   `policyVersion`, idempotency, `baseRevision`, and max age.
5. Node writes a write-ahead audit `intent` row.
6. Node executes the action (preset text written via
   `TerminalBackend.writeSequence`, permission resolved via the local prompt
   resolver, etc.).
7. Node writes audit `result` row.
8. Node acks success/failure on the control channel.
9. Relay broadcasts the ack/result to clients.

Only one input request per session is in flight from relay to node at a time.
This avoids two collaborators interleaving bytes into one terminal prompt.

The relay may queue comments, share requests, and notifications while a node is
offline. It must not queue terminal bytes, permission approvals, preset
replies, or stop/delete commands while the node is offline; those commands
are only meaningful against the node's current local state. Queued non-command
intents carry `expiresAt`, `createdAgainstPolicyVersion`, and target epoch
when applicable; they are revalidated at delivery time, never convert into
command/input/approval, and are dropped on revocation or incompatible epoch.

### 6. Identity and Authorization

Minimum identity model:

- users authenticate to the relay;
- each local node belongs to an owner user;
- each node has a revocable device credential;
- owners invite members by email, username, or one-time invite link;
- every API and WSS message is authorized against relay policy and then
  revalidated by the local node;
- node credentials cannot log into the human UI;
- human session tokens cannot impersonate nodes.

The system models three identities separately:

- human user identity;
- relay tenant/account identity;
- desktop node/device identity.

For Jean-plus-family self-hosted relays, **the human-user identity and the
relay-tenant identity collapse to one in practice** — they are kept as
distinct concepts in the schema so that a future multi-tenant hosted relay
(Option C) can separate them without a data migration. Tenant-scoped storage
keys use `ownerId` consistently; no V1 flow requires a tenant that is not
identical to a single human owner.

Invitations are scoped to node plus task/project/session (via typed
`ShareSubject`), high-entropy, revocable, optionally single-use, and
time-limited. Invite tokens are hashed at rest and never logged.

The local node is the final authorization authority for commands that mutate
local state. Relay policy is an admission check, not sufficient authority. The
node maintains a local share-policy cache populated only via the PolicySync
protocol (see "Coordination primitives"). The relay may only forward commands
that reference an existing grant; it cannot create effective local grants
without a `policy.delta` accepted by the node. The node rejects commands whose
grant, scope, expiry, lease, node epoch, session epoch, or `policyVersion` do
not match local state.

Grant examples (Phase 1–6 grants in the narrow union):

| Grant | Can view | Can send input | Can launch/stop | Can approve permissions | Can invite |
|---|---:|---:|---:|---:|---:|
| `view` | yes | no | no | no | no |
| `write` | yes | yes, with lease (Phase 5); preset reply (Phase 4) | no | yes (Phase 4, owner only) | no |
| `admin` | yes | yes | owner only (Phase 4b); non-owner Phase 7 | yes | yes (Phase 7) |

The Phase 7 collaborator grant set (`comment`, separate `terminalInput`,
`launch`, `stop`, `permissionApprove`) is defined in Appendix A and only
loaded when multi-user invitations ship.

**Open Question 1 closed:** Phase 4 supervised actions are restricted to
owner-only mutations (`presetReply`, `permissionApprove`, skip/snooze/mark-done,
allowlisted launch). Non-owner mutation surfaces (collaborator preset replies,
collaborator permission approve under a two-person rule) require the multi-user
invitation system and ship in Phase 7. This decision means Phase 4 ships
without invitations.

The relay must treat terminal streams as sensitive. Default retention is:

- durable audit of metadata only: actor, action, target, timestamp, result;
- in-memory terminal replay buffer only;
- optional encrypted debug capture behind an explicit setting.

**Plaintext-relay consent (R14).** Phase 3+ terminal viewing requires the
operator to set `KOOKR_RELAY_TRUSTED=true` on the node; otherwise the node
refuses to publish terminal streams even if a grant exists. **This flag is
a consent record, not a runtime trust check.** It records that the
operator has acknowledged, at the time of setting, that the relay host
can observe terminal bytes. It does *not* re-evaluate trust if the relay
host is later compromised; that detection is the operator's
responsibility. The flag exists so a brand-new install cannot accidentally
stream terminal contents through a relay before the operator has read
the warning. In addition, sharing a session with any identity that is not
the owner triggers a one-time UI consent screen on the share creator's
client (per `{ownerId, shareTargetUserId, relayHostFingerprint}`)
explicitly stating that the relay host can observe terminal bytes; the
share is not activated until acknowledged, and the acknowledgement is
re-prompted if the relay's TLS-certificate fingerprint changes (host
migration). Third-party or untrusted relay deployment requires a separate
end-to-end encrypted stream design where the relay can fan out ciphertext
but cannot inspect terminal bytes.

**Web Push payload contents.** Push notifications travel through the
operating-system push service (Apple Push Notification service / Firebase
Cloud Messaging) and may be visible on a locked lock screen. Block-alert
payloads are deliberately minimal and use an **allowlist redactor**
rather than a denylist of "common secret patterns" (denylists are
famously incomplete for token shapes). The `taskShortLabel` field is
produced by:

1. Take the task title.
2. Drop any character not in `[A-Za-z0-9 .,!?-]`.
3. Truncate to 64 code points.
4. If the resulting label is shorter than 4 chars after step 3, fall
   back to `Task <first 8 chars of taskId>`.

The redactor policy is **versioned** (`redactor.v1`) and the version is
recorded in the audit log; any change to the allowlist bumps the version
so historical pushes are traceable. Push payloads carry: `nodeDisplayName`
(operator-set, never user-input), `taskShortLabel` (allowlisted),
`alertKind` (`blocked | permission-requested | findings`), `alertId`
(opaque). The relay client fetches detail over authenticated HTTPS once
the user unlocks the device. Operators can disable push entirely with
`KOOKR_PUSH_DISABLED=true`.

The desktop node writes an append-only audit log following the write-ahead
pattern in "Coordination primitives" for every invite, accept, revoke,
connect, terminal attach, remote command, permission decision, and admin
change. Payloads are redacted before audit/storage, not just before UI
display. Local audit retention defaults to 90 days with daily rotation; the
operator can configure longer retention via `KOOKR_AUDIT_RETENTION_DAYS`.

Audit records are written for both allowed and denied attempts. They include
`auditId`, `requestId`, `commandId`, `actorId`, `clientId`, `nodeId`,
`nodeEpoch`, `sessionId`, `sessionEpoch`, `action`, `grantId`,
`policyVersion`, `leaseId`, `baseRevision`, authorization result, denial
reason, delivery result, timestamp, and payload metadata. Terminal input audit
stores byte length, content type, and HMAC/hash only, not raw bytes. Permission
audit stores request hash and redacted request summary, not full prompt or
terminal output.

Remote permission decisions are valid only for a specific active local
permission request. The node emits `permission.requested` with
`permissionRequestId`, `requestHash`, task/session id, session epoch, tool or
action name, normalized command/path summary, risk class, prompt timestamp,
allowed suggestion ids, `baseRevision`, and expiry. Remote approvals reference
`permissionRequestId + suggestionId`. The node recomputes the request hash
and rejects stale, mismatched, replayed, wildcard, offline, or already-resolved
decisions. `permissionApprove` does not authorize "approve all",
permission-rule edits, bypass flags, or future prompts unless a separate
explicit grant is added later.

**Permission request terminal states.** Every `permission.requested` emits
exactly one `permission.resolved` event whose `reason` field is:

| Reason | Meaning |
|---|---|
| `approved` | Operator approved a specific suggestion id |
| `denied` | Operator denied the request |
| `expired` | Prompt expired before any decision |
| `cancelled-by-agent` | Agent cancelled the prompt (process restart, agent timeout); audit trail preserves the no-decision state |
| `cancelled-by-panic` | Local panic switch denied the prompt; audit distinguishes this from operator-denial |
| `cancelled-by-epoch` | `sessionEpoch` bump invalidated the prompt before resolution |

Clients render `cancelled-by-*` as a distinct visual state from
`approved`/`denied` so the operator can see why a prompt disappeared.

**Permission UI ordering rule.** Clients must render a pending
`permission.requested` event as a focused, modal-style decision per request,
not as an unordered or auto-reorderable list. If multiple permission requests
are pending on the same session, the client surfaces them in receive order
and disables the approve control on a request whose `permissionRequestId` is
not the topmost one until the operator explicitly expands it. This is a
contract on every Kookr-built client; third-party clients that violate it are
considered non-conforming.

**Panic switch behavior.** The local panic switch (operator-invoked,
`SIGUSR2` or `kookr panic`) is a local-emergency mode that does not
require relay reachability. It performs the following atomic transition:

1. Set `nodeMode: 'panic'`.
2. Deny all in-flight relay-originated commands with `error.panicSwitch`.
3. Terminate active controller leases (transition to `revoked` with
   reason `panic`).
4. Resolve all pending `permission.requested` events as
   `cancelled-by-panic` (agent sees denial, not hang).
5. **Wipe the relay-derived share-policy cache.** All relay-granted
   grants are forgotten; subsequent relay commands must re-traverse
   PolicySync from scratch before being accepted. **Owner-local
   operations bypass the share-policy cache entirely** (the owner is an
   implicit identity, not a granted one), so the panic-wipe does not
   lock the owner out of their own node — local browser access, local
   CLI, and direct dashboard operations remain functional during and
   after panic. The revoked-grant tombstone set is preserved across the
   wipe.
6. Close the outbound relay WSS.
7. Emit a local audit row `audit.panic` with timestamp and operator
   identity.

The panic switch never reaches the relay. On next reconnect (operator
exits panic mode via `kookr panic clear`), the node enters
`nodeMode: 'normal'` and the handshake triggers a full PolicySync.
Grants that were revoked at the relay during the panic window are not
restored. The cache wipe is the explicit emergency-isolate path for
"the relay is misbehaving" scenarios where the operator does not want
to trust the relay's policy assertions on reconnect.

### 7. Device Capabilities, STT, and TTS

Audio is a client/node capability, not a session ownership concern. V1 does
not route audio or advertise speech capabilities through the relay. Clients
may use local browser speech-to-text as a private draft input outside the
relay protocol. Collaborative capability discovery is **Phase 6**.

V1–Phase 5 minimum: the local Kookr server's existing `sttEnabled` and
`sttUrl` fields stay on the local control channel only. They are not exposed
to the relay. Phase 6 introduces the device-and-node-indexed capability
descriptors (Appendix C) and a documented deprecation point for the legacy
single-user fields.

The full Phase 6 type machinery — `SpeechCapability` discriminated union,
`capabilitiesByDevice` / `capabilitiesByNode` indexing, capability lifecycle
events, and STT-draft revocation handling — is defined in **Appendix C:
Phase 6 capability advertisement**, not in the V1 protocol contract.

Routing intent for Phase 6:

- Raw microphone audio stays on the capturing device by default.
- Phase 6 allows only `same-device` and `local-node-ui-only` routing; relay
  clients cannot invoke node-local STT/TTS unless a later RFC defines
  consent, auth, and audio transport.
- If cross-device audio routing is ever allowed, it requires visible
  per-route consent and must not be enabled by a broad session share.
- No raw audio is persisted by default.
- Logs store status, duration, byte counts, and transcript provenance, not
  raw audio.
- A speech-generated text submission is labeled with provenance source
  device, STT capability, model when known, and whether the user edited it
  before sending. Provenance is carried in a separate `commandMetadata`
  field on the Phase 5 `SubmitMessageRequest`, not inside terminal byte
  payload.
- STT output is never auto-submitted. It is editable draft text and loses
  submit eligibility if the device session or capability expires or is
  revoked. Phase 6 specifies a `capability.revoked` event that the client
  must surface to in-flight drafts.

### 8. State and Persistence Boundaries

Local node persists:

- tasks and sessions (`tasks.json`);
- hook files and transcripts;
- local interaction log;
- local remote-command audit log (90-day default rotation);
- idempotency cache (24h or until session-epoch change);
- share-policy cache (replicated from relay via PolicySync);
- dtach socket lifecycle;
- crash recovery state including write-ahead audit intent rows.

Relay persists:

- users;
- node registrations (one row per active credential; stale rows GC'd when
  a credential is revoked or has had no presence for 30 days);
- device credentials;
- invitations;
- share policies (sole writer of `policyVersion`);
- metadata audit log;
- metadata-only command request/ack log;
- Web Push subscriptions per user/device;
- optional per-client last-seen sequence metadata;
- optional recent node/session presence.

Relay does not persist by default:

- terminal byte streams;
- durable terminal replay payloads;
- full prompts;
- transcript JSONL;
- agent hook payloads;
- local repo paths beyond display labels and stable project ids.

`tasks.json` remains a single-node local materialized view. It should not become
a multi-writer collaboration database. The collaboration boundary is an
append-only command/event log with idempotency keys and cursor replay; the local
node applies approved commands into its existing task/session model.

Durable replay metadata never implies retained terminal payload. Replay buffers
are ephemeral mirrors keyed by node epoch and session epoch.

### Canonical log locations

The "append-only command/event log" described as the collaboration
boundary lives on the **node**, not the relay. Specifically:

- **Node write-ahead audit log** (`~/.kookr/audit.jsonl`, rotated daily,
  90-day default retention): canonical record of every authorized
  command's intent and result rows. This is the source of truth for
  forensic queries via `kookr command outcome`.
- **Relay metadata audit log**: a separate, narrower record of what the
  relay observed and forwarded. Used for cross-machine reconciliation
  when the node's audit is unavailable (disk loss, panic-mode reconnect
  window). The relay's audit retention is configurable but defaults to
  longer than the node's so post-incident review can survive node-side
  data loss.
- These two logs are not replicas of each other. Reconciliation is a
  manual forensic procedure that matches `commandId` across both logs;
  it is not a runtime correctness primitive.

**Schema evolution and rollback.** Each phase adds tables/columns
additively; existing fields are not repurposed. Relay schema migrations are
forward-only and the relay rejects connections from a node running a
`protocolVersion` it cannot serve via the handshake. **Phases are
forward-only by default**: rolling back from phase N+1 to phase N requires
either (a) the older release tolerating unknown columns (the default
contract for relay schema), or (b) a documented data migration that strips
the newer feature's records. Operators are expected to roll back the node
before the relay where possible, because the node's local state is small
and bounded.

### 9. Operability

The protocol's failure modes are only as useful as the instruments an
operator has to detect them. Each phase ships the following observability
surface:

**Health and status endpoints.**

- `GET /health` on the relay: `{ status: 'ok' | 'degraded', dbReachable,
  tlsExpiresAt, version }`.
- `GET /relay/admin/nodes` on the relay: per-node
  `{ nodeId, connected, lastSeen, protocolVersion, policySyncVersion,
  policySyncStatus: 'synced' | 'syncing' | 'lagging', activeLeases,
  pendingPermissions }`. Requires admin auth.
- `GET /api/node/status` on the local node: `{ relayConnected,
  protocolVersion, lastPolicyAck: { version, ts }, idempotencyCacheEntries,
  activeLeases, pendingPermissions, nodeEpoch, nodeMode, features: { enabled,
  disabled } }`. Available locally without relay.

**Operator CLI surfaces.**

- `kookr command outcome <commandId>`: query the local node's audit log
  directly without a relay round-trip. Returns the full intent + result
  rows. Accepts `--since` for bulk queries. Essential for post-incident
  forensics when the relay is down.
- `kookr relay status`: prints the local node's view of relay
  connectivity, last `policy.delta.ack`, current backoff, active feature
  set, and `nodeMode`.
- `kookr panic` / `kookr panic clear`: invoke and clear local panic mode
  (see "Panic switch behavior" in §6).
- `kookr push test <deviceId>`: send a synthetic block-alert push to a
  specific subscription; reports delivery result and error class.

**Structured logging schema.** Relay and node both emit Pino JSON with a
shared correlation contract: every log line tied to a remote command
includes `commandId`, `nodeId`, `nodeEpoch`, `sessionId`, `sessionEpoch`,
`actorId`, `clientId`. Connection-lifecycle lines include `nodeId`,
`protocolVersion`. Push-delivery lines include `pushSubscriptionId`,
`deliveryResult`. At process start each side emits a single startup line
`{ event: 'startup', features: { enabled, disabled }, protocolVersion,
nodeEpoch, nodeMode }` so a misconfigured `KOOKR_RELAY_FEATURES` deny-list
is visible immediately.

**Metric categories (per phase).**

| Metric | First emitted in | Purpose |
|---|---|---|
| `relay.ws.connections` (gauge) | Phase 1 | Operator capacity / liveness |
| `node.relay.connected` (gauge) | Phase 1 | Per-node liveness |
| `policy.sync.lag.versions` (gauge) | Phase 4a | Detect stuck PolicySync |
| `command.outcome{result}` (counter) | Phase 4a | Accept/reject/unknown ratios |
| `idempotency.cache.size` (gauge) | Phase 4a | Memory pressure detection |
| `audit.intent.no.result` (counter) | Phase 4a | Crash-window detection |
| `lease.transitions{from,to}` (counter) | Phase 5 | Lease pathology detection |
| `lease.heartbeat.miss` (counter) | Phase 5 | Network health proxy |
| `push.delivery{result}` (counter) | Phase 2 | Push channel health |
| `stream.client.dropped{reason}` (counter) | Phase 3 | Backpressure visibility |

**Idempotency cache bounds.** The cache is hard-capped at
**100k entries** per node; on cap, the oldest entries are evicted
(LRU). Eviction emits `idempotency.evicted` counter. At typical command
rates (a few per minute) the 24h TTL is the binding constraint, not the
cap; the cap exists only to bound memory in pathological cases.

**Audit log rotation.** The node uses size-and-time-based rotation:
daily roll, max 50MB per file. Rotated files remain queryable by
`kookr command outcome --since`. The relay's metadata audit retention
policy is configurable; the implementation chooses the storage backend
and partition strategy.

**Local dashboard relay indicator.** The TopBar surfaces three relay
states: connected-and-synced, connected-but-lagging-or-panic, and
disconnected. The exact visual rendering (colors, hover copy) is a UI
implementation decision; the contract is that the three logical states
are distinguishable and that the indicator's reason is operator-visible.

**Panic switch recovery runbook (high level — full ops runbook lives in
`docs/runbooks/`):**

1. Operator runs `kookr panic` → node enters `nodeMode: 'panic'`,
   policy cache wiped, WSS closed.
2. Operator inspects local audit (`kookr audit recent`) for the
   suspicious commands.
3. If incident is real: operator runs `kookr relay revoke-token`
   *before* exiting panic mode so the existing credential cannot be
   reused on reconnect.
4. Operator runs `kookr panic clear` → node reconnects, full
   PolicySync happens, pending `permission.requested` UI on remote
   clients shows `cancelled-by-panic` resolutions.
5. Operator's relay admin UI surfaces orphan in-flight records from
   the panic window; operator marks them reconciled.

### 10. Failure Modes

| Failure | Expected behavior |
|---|---|
| Relay down | Local Kookr remains usable; remote clients disconnect. Node retries outbound connection with backoff. |
| Host offline | Relay marks the whole node offline. Clients see stale presence only. No terminal commands are queued. |
| Kookr process down but host reachable later | Node reconnect creates a new node epoch; relay requires fresh snapshot before accepting commands. Idempotency cache is purged on epoch bump. |
| Agent session gone | Node reports session terminal/dead state based on local reconciliation. Relay rejects writes to that session. |
| Local node offline | Relay marks node/session stale and rejects new inputs. Clients see last known presence only. |
| Client reconnects | Relay sends snapshot, then replay from the requested sequence if available. If not available, client shows "stream gap" and starts from current bytes. |
| Two operators submit at once | Controller lease rejects the second writer unless owner override is used. |
| Node receives duplicate input | Idempotency tuple prevents duplicate writes; original result returned. |
| Slow client | Relay drops the slow stream subscription, preserving node and other clients. |
| Policy version drift (relay ahead) | Node rejects with `error.unknownPolicyVersion`; relay halts forwarding of commands at that version and runs resync. |
| Policy version drift (node ahead, e.g. local CLI revoke) | Local CLI revoke is forwarded to relay as a revocation request; relay applies it and propagates via `policy.delta`. Direct node-only revocation is rejected as a contract violation. |
| Relay-to-node WSS dies, client-to-relay healthy | Lease state goes to `held-uncertain` for clients within one heartbeat (input disabled); after 35s clients self-transition to `held-presumed-lost`. Node revokes leases locally. On reconnect, relay broadcasts `lease.changed { newState: 'revoked', reason: 'node-disconnect' }`. |
| Node crashes between intent and result audit rows | On restart, write-ahead audit recovers the intent row with `outcome: 'unknown'`. `command.getOutcome` returns `unknown`. Clients do not auto-retry. |
| Permission request expires while user is reading | Node emits `permission.resolved` with reason `expired`; client UI shows expiration explicitly rather than silently failing the next approve. |
| Multiple clients approve same permission request | First valid decision wins; others receive `permission.resolved` with the winning result. No two-person rule in V1 surfaces. |
| Stale node registration after disk loss | Operator must re-issue credential via `kookr relay init`; relay rejects new `nodeId` from old credential. |
| Owner connects from second desktop while first holds local controller lease | Locality is per-node; the second desktop is "remote" relative to the first node. Same controller-lease rules apply. |
| Ack-loss on a command that succeeded | Client may re-submit with the same `idempotencyKey` (safe) or call `command.getOutcome` (safer). Different `idempotencyKey` is unsafe and may double-execute. |
| Panic switch fires with in-flight permission approve | Node treats in-flight approvals as deny; agent sees a denial, not a hang. Outbound relay WSS closes. |
| Capability revoked mid-recording (Phase 6) | `capability.revoked` event surfaces to the client; in-flight draft is preserved but marked invalid; user may re-record with another capability. |
| Phase-N → Phase-(N-1) rollback after audit records reference new fields | Older relay/node tolerates unknown columns (additive schema). Data migration script in the rollback runbook strips newer feature records when needed. |
| Relay compromised - confidentiality | Attacker may observe plaintext shared terminal streams and metadata visible to the relay. Mitigations: `KOOKR_RELAY_TRUSTED` gate, plaintext-relay consent screen, metadata-only durable retention, short replay buffers, and future E2EE design for untrusted relays. |
| Relay compromised - integrity | Attacker may forge or suppress stream bytes, mislead clients about control state, hide revocations, replay old commands, or attempt command injection. Mitigations: local node command allowlist, node-side policy/epoch/lease validation, write-ahead audit, command idempotency, local dashboard relay indicator, local panic switch, lease invalidation on relay credential rotation, and optional client-signed high-impact commands in a later phase. |
| Relay compromised - availability | Attacker may disconnect clients or nodes. Mitigation: local Kookr remains usable, and disabling `KOOKR_RELAY_URL` or using the panic switch returns to local-only mode. |
| Session epoch bump | Node emits a single `session.epoch-changed` event listing invalidated resources (leases, permission requests, idempotency keys). Clients flush stale state in one round-trip. Commands stamped with old `sessionEpoch` rejected with `error.staleSessionEpoch`. |
| Handshake version downgrade | Relay responds `relay.hello { outcome: 'downgraded', acceptedVersion }`. Node operates at the lower version with the feature intersection. WARN log lists dropped features. |
| Policy version drift, command in flight when revoke fires | Freshness-wins: node rejects in-flight command with `error.grantRevoked` even though command was authorized at issue. Relay propagates revocation to clients. |
| Command outcome unknown (intent-only) | `command.getOutcome` returns `unknown-intent-only`; client surfaces ambiguity to operator rather than retrying. Forensic reconciliation via `kookr command outcome --since`. |
| Command outcome unknown (never seen) | `command.getOutcome` returns `unknown-never-seen`; client may safely retry with same `idempotencyKey`. |
| Panic mode entered | Local cache wiped, in-flight permissions resolve as `cancelled-by-panic`, leases revoked. On `kookr panic clear`, handshake triggers full PolicySync. |

## Files to Change

Module surfaces are split by concern rather than concentrated in one
`protocol.ts`. The first implementation slice:

- `src/remote/ids.ts` - branded identifier types (`NodeId`, `SessionId`,
  `CommandId`, `GrantId`, `LeaseId`, `PermissionRequestId`,
  `CapabilityId`, `DeviceId`) backed by branded string types. Defined
  once; reused everywhere.
- `src/remote/handshake.ts` - `NodeHello`, `RelayHello`, feature-flag
  vocabulary, handshake state machine types.
- `src/remote/control-events.ts` - `RemoteControlEvent` and its phase-tagged
  `kind` union. `AuthorizedRemoteCommand<P>` envelope (used from Phase 4a,
  not Phase 5 — moved out of Appendix B for this reason).
- `src/remote/stream-events.ts` - `TerminalStreamEvent` (Phase 3+ only;
  empty stub at Phase 1).
- `src/remote/policy-sync.ts` - `policy.sync`, `policy.delta`,
  `policy.delta.ack`, `policy.revoke` message shapes.
- `src/remote/policy-cache.ts` - **data structure**: holds the synced
  grant set, exposes `getGrants(subject)`, no evaluation logic. Imports
  from `policy-sync.ts`. Phase 1.
- `src/remote/node-client.ts` - optional outbound connection from local
  Kookr to relay; owns the handshake and reconnect backoff.
- `relay/` or `apps/relay/` - remote service if the project accepts a
  second deployable unit.
- `docs/adr/<NNN>-collaborative-remote-sessions.md` - final accepted
  decision.

Phase 2 (push and projections):

- `src/remote/push.ts` - Web Push subscription management and block-alert
  delivery.
- `relay/src/push/` - server-side VAPID provisioning and fanout.

Later phase files, created only when that phase starts:

- `src/remote/session-stream-publisher.ts` (Phase 3) - local adapter from
  `TerminalBackend.onData` to sequenced stream events.
- `src/remote/command-pipeline.ts` (Phase 4a) - shared
  `RemoteCommandHandler<Req, Res>` interface and
  `executeWithPipeline(handler, cmd, journal, idempotencyCache)` that
  centralizes validate → audit-intent → execute → audit-result → ack.
  Phase 4 handlers implement this interface rather than duplicating the
  pipeline.
- `src/remote/preset-reply.ts` (Phase 4a) - `RemoteCommandHandler` for
  preset-text dispatch. Exports the canonical `presetId → text` mapping
  as a public constant so clients can display the text before sending.
- `src/remote/permission-broker.ts` (Phase 4a) - `RemoteCommandHandler`
  for relay-routable permission request/resolve plumbing on top of the
  existing local resolver.
- `src/remote/command-journal.ts` (Phase 4a) - **unified** append-only
  audit log plus epoch-keyed idempotency cache (the two share storage
  per the "Idempotency" section). Replaces the separate
  `audit-log.ts` / `idempotency-cache.ts` files proposed in v3 to make
  the storage coupling explicit rather than a prose guarantee.
- `src/remote/share-policy.ts` (Phase 4a) - **evaluator**: pure function
  `evaluateGrant(cache: PolicyCache, subject: ShareSubject, action: Action): GrantDecision`.
  Imports `policy-cache.ts`; nothing goes the other way.
- `src/remote/launch-broker.ts` (Phase 4b) - `RemoteCommandHandler` for
  allowlisted launch path.
- `src/remote/controller-lease.ts` (Phase 5) - single-writer lease state for
  terminal input.

Existing files likely touched later:

- `src/server/index.ts` - start optional node client from env.
- `src/server/session-bridge.ts` - extract reusable stream publisher concepts
  without changing local behavior (Phase 3).
- `src/shared/contracts/messages.ts` - mark `sttEnabled` / `sttUrl` as
  local-only fields; do not propagate to relay. Add optional `serverRevision`
  to `SnapshotMessage` (clients ignore when absent).
- `src/server/tts-manager.ts` and `src/server/stt-manager.ts` - expose
  capability descriptors when Phase 6 ships, not remote audio transport.
- `src/server/ws-connection-handler.ts` and `src/server/session-bridge.ts` -
  local hardening for connection ids, audit hooks, and single-controller input
  before remote input is enabled.

## Edge Cases

- A collaborator sends input while the owner is typing locally. The node
  rejects remote writes unless the collaborator holds the controller lease and
  local direct typing is not active.
- A terminal program disables echo. Clients still receive `input.delivered`
  metadata even if the PTY does not echo the bytes.
- A session prints credentials. Relay replay buffers are memory-only and short
  by default; users should explicitly choose durable stream capture.
- A user loses access while connected. Relay revocation terminates active
  subscriptions and rejects further input.
- A node reconnects with older software. Relay negotiates protocol versions
  via the `hello` handshake and disables unsupported features, or refuses
  with a structured error.
- A phone has no browser STT. It can still type; no remote model is required.
- A phone has native STT. STT text stays a local draft until the user submits
  it through the normal command path.
- Two local Kookr instances register the same machine name. `nodeId`, not
  display name, is authoritative; same `nodeId` on different credentials is
  a configuration error and is rejected.
- Lease holder's network is high-latency. Other clients see `controller: X
  (uncertain)` once the next heartbeat misses its deadline, rather than a
  steady `controlling` state that no longer reflects reality.
- Owner accepts a permission request that has expired between display and
  tap. Node rejects with `error.permissionExpired` and surfaces the
  expiration to all clients showing the same prompt.

## Alternatives Considered

The architecture options above are the primary alternatives. The key rejected
ideas are:

- Make the relay a remote agent runner in V1.
- Treat terminal bytes as the source of truth for task state.
- Persist all terminal streams in the relay by default.
- Forward microphone audio through the relay as a first-class session stream.
- Let every authenticated user see every session on a node.
- Queue raw terminal input while the node is offline.
- Treat the relay as final authorization authority.
- Allow the node to be the writer of `policyVersion`.

## Migration Plan

1. **Phase 0a — Local hardening.** Add connection ids, monotonic
   `serverRevision` per session as an **optional** field on existing
   `SnapshotMessage`, write-ahead audit scaffolding (initialized only
   when `KOOKR_RELAY_URL` is set — see "Local-Only Safety Contract"),
   and replayable task/alert projections. No relay connection. Behavior
   change for the local browser must be a no-op.

   **Acceptance preconditions** (this phase has the highest local-only
   blast radius — three gates apply):
   - Existing `SnapshotMessage` parser tolerates unknown fields
     (`passthrough` / non-strict). If the parser is strict, loosen it
     as a separate prior commit so the new optional `serverRevision`
     does not throw on browsers that haven't yet refreshed.
   - The `serverRevision` field is emitted **only** when the
     remote-node client is active; in local-only mode, snapshots are
     bit-identical to today.
   - **Local-only smoke test passes** (R23) including the STT and TTS
     paths. This is the canary phase; if it fails, the rest of the
     plan does not start.
2. **Phase 1 — Read-only relay skeleton.** Local node connects outbound via
   `node.hello`/`relay.hello` handshake only when `KOOKR_RELAY_URL` is
   set. Relay implements registration, presence, node directory, and
   TLS termination per the "Minimum infrastructure for Phase 1"
   guidance. No terminal stream, no remote input, no push yet.

   **Acceptance gates** (both must pass):
   - **Two-node isolation fixture**
     (`pnpm test:e2e:relay --fixture=two-nodes`) passes: (a) every
     outbound event from node A includes `nodeId: A`; (b) the relay's
     per-tenant subscription routes node-A events only to clients
     subscribed to A; (c) a client subscribed only to node B receives
     zero events tagged with node A across the test window;
     (d) commands forwarded to node B never reach node A's audit log.
   - **Local-only smoke test passes** (R23). The node binary now
     contains relay code; the smoke test verifies that with
     `KOOKR_RELAY_URL` unset, no relay code runs and existing local
     behavior is unchanged.

   The two-node fixture *tests multi-node infrastructure*, not the V1
   user surface (which remains single-owner, single-node). The fixture
   gives the architecture's per-node isolation invariant a continuous
   test surface; the operator-facing UX stays single-node until Phase 7.
3. **Phase 2 — Read-only task dashboard + Web Push.** Expand task detail
   metadata and reconnect/replay for task and alert projections. Ship
   Web Push: VAPID key provisioning on the relay, per-device push
   subscription management, and a block-alert push payload that opens
   the relay client to the alert detail. Still no terminal byte stream.
   **Acceptance gate**: local-only smoke test passes (R23) — Web Push
   subscription endpoints exist in the relay binary only; when no relay
   is configured, no push code runs.
4. **Phase 3 — Opt-in terminal viewing.** Add one session stream, bounded
   replay, gap detection, the `KOOKR_RELAY_TRUSTED` gate (which gates
   only *remote* terminal viewing — local terminal viewing via
   `SessionBridge` is unaffected and requires no env var), and the
   plaintext-relay consent screen. No remote input.

   **Acceptance gates** (this phase refactors a working component —
   two gates apply):
   - The `SessionBridge` extraction is **behavior-preserving** for
     local clients: a frozen byte-equality test compares the local
     terminal byte stream produced before and after the refactor for
     a fixed agent script. Mismatch blocks the phase.
   - **Local-only smoke test passes** (R23). Specifically, the
     terminal-stream smoke step must pass with `KOOKR_RELAY_TRUSTED`
     unset and `KOOKR_RELAY_URL` unset — the gate is purely a
     remote-side constraint.
5. **Phase 4a — Safe supervised actions + remote permission approval.** Add
   audit records (write-ahead), local authorization cache, command
   idempotency (epoch-keyed), PolicySync, and the narrow command surface:
   `presetReply`, `permissionApprove`, skip, snooze, mark-done. All
   restricted to owner identity. Every command has actor, `commandId`,
   `baseRevision`, idempotency key, audit entry, and local node
   authorization. `command.getOutcome` is implemented.

   **Acceptance gate**: local-only smoke test passes (R23) including
   the **local permission-approval path** — when no relay is
   configured, permission prompts continue to resolve through the
   existing local resolver with no detour through the new
   `permission-broker.ts` or audit journal.

   **Why Phase 4a vs Phase 4b is a meaningful split** — the boundary is
   **gated-resume vs cold-start at the Kookr layer**, not "no new state
   ever results." Phase 4a commands *resume an already-running, already-
   gated local process* whose next step is awaiting input (a pending
   `permissionRequestId`, a task waiting for a preset reply, a block alert
   waiting for skip/snooze). The Kookr layer does not spawn new agent
   processes, mint new grants, or create new workspaces; it unblocks
   state the agent itself has already exposed locally. Phase 4b commands
   *initiate new processes from the Kookr layer* (launch an agent, create
   workspace via launch's allowlisted command set). The downstream
   effect of an approved `permissionApprove` may include new files
   written by the agent — but those are agent-mediated, gated by local
   policy that pre-exists the remote approval. The split is a threat-model
   boundary at the Kookr command layer, not a feature-cut convenience.

6. **Phase 4b — Allowlisted launch.** Add the `launch` command surface with
   an explicit allowlist (project + agent + max-concurrency limits).
   **Acceptance precondition (measurable):** Phase 4a has been deployed
   in production for ≥ 30 days with all of: `audit.intent.no.result`
   counter < 1 per 1000 commands, zero `unknown-intent-only` outcomes
   returned to clients in the trailing 7 days, and no
   `policy.delta.ack` lag events > 5s. The 30-day clock starts when 4a
   is enabled; resets on any audit-completeness regression.
   Independently rollback-able from 4a.
   **Phase 4b also gates on the local-only smoke test passing (R23)**:
   when no relay is configured, the `launch-broker.ts` code does not
   run; local launch via the existing dashboard flow is unchanged.

7. **Phase 5 — Shared terminal control.** Add explicit controller leases,
   owner override, end-to-end heartbeat (15s default), timeout, delivery
   acks, and complete audit. First phase where remote raw-ish terminal
   input (semantic submitted messages, not keystrokes) is allowed.
   Operator-level kill switch: `KOOKR_RELAY_FEATURES` accepts a
   comma-separated deny-list of feature tokens. The vocabulary is
   defined in `handshake.ts` and surfaced via
   `NodeHello.supportedFeatures`; current tokens are `terminal-input`,
   `terminal-stream`, `launch`, `preset-reply`, `permission-approve`,
   `push-alerts`. On startup the node logs the active and disabled
   feature set, and warns if any deny-list token does not match a
   known feature.

   **Acceptance gate**: local-only smoke test passes (R23). Local
   terminal typing must continue to flow directly through
   `TerminalBackend` with no controller-lease arbitration when no
   relay is configured.
8. **Phase 6 — Speech capabilities.** Advertise client/node STT/TTS
   capability descriptors per Appendix C and route speech-generated
   text through the normal command path. Independent of Phase 7.

   **Local-only safety is the critical concern for this phase** —
   local STT/TTS is in active use today. The migration is strictly
   parallel-fields, not a swap:
   - The legacy `sttEnabled` and `sttUrl` (and equivalent TTS) fields
     on `SnapshotMessage` remain unchanged and continue to be emitted
     by the local server when `KOOKR_STT=true` / `KOOKR_TTS=true`.
   - The new `SpeechCapability` descriptors are emitted **in addition**
     for at least two minor releases.
   - Removal of the legacy fields is gated on the new descriptors
     reaching local-STT feature parity *measured by the local-only
     smoke test*, not on a release-date target. If the new descriptors
     cannot drive the local STT path end-to-end, the legacy fields
     stay.
   - The dashboard frontend may consume either path; switching to the
     new descriptors is a separate, independently testable change.

   **Acceptance gates** (two):
   - **Local-only smoke test passes** (R23), including the STT and
     TTS steps, exercising the legacy fields. A regression on local
     STT blocks the phase.
   - A **parallel-fields-coexist test** verifies that with both legacy
     and new fields present, the dashboard ignores neither and the
     local STT path continues to function.
9. **Phase 7 — Multi-user and multi-node collaboration.** Add richer
   presence, comments, the Phase 7 grant union (Appendix A), invitations,
   revocation UI, two-person permission flows where configured, and
   account-level node switching.

   **Acceptance gate**: local-only smoke test passes (R23). A
   single-owner install without invitations must operate exactly as in
   Phase 4–6.

Phases 6 and 7 are independent and may ship in either order; Phase 6 does
not gate Phase 7.

Each phase must preserve local-only Kookr operation when the relay is
disabled. Each phase has an automated test surface: Phase 1 has the
two-node isolation fixture; Phase 4a has an end-to-end audit-completeness
test; Phase 5 has a controller-lease split-brain test against a simulated
relay-to-node disconnect.

## Related Work

`docs/rfc/rfc-remote-chat-trigger.md` covers NAT-safe remote task creation via
Telegram-style long polling. It is related because it validates outbound-only
remote access, allowlists, dry-run, and block-alert thinking. It is not a
dependency for the collaboration relay; the relay should prove read-only value
before adding remote mutation.

## Open Questions

1. Should untrusted third-party relays require E2EE before terminal viewing, or
   is the `KOOKR_RELAY_TRUSTED`-gated plaintext relay mode acceptable
   indefinitely for family/self-hosted use? (V1 answer: gated plaintext is
   acceptable for self-hosted; E2EE is required if Kookr ever ships a hosted
   relay.)
2. Should share policy default to per-session only, or allow project-wide
   sharing from the start? (Leaning per-session; project-wide added only when
   a concrete UX requires it.)
3. Is the relay allowed to inspect terminal bytes for notifications, or must it
   remain a blind fanout service? (Default: blind. Notifications are emitted
   by the node and the relay only routes Web Push delivery.)
4. Should smartphone STT be treated as trusted local text input, or should the
   UI label speech-generated input differently before submission? (Phase 6
   answer: speech-generated input carries provenance metadata that the
   submitting UI surfaces visibly before send.)
5. What is the minimum acceptable auth stack for a family deployment: static
   invite tokens, OAuth/OIDC, or passkeys? (Reference configuration is GitHub
   OAuth; passkeys are a later enhancement.)

(Open Question 1 from v2 — "remote launch yes/no" — is now closed: owner-only
in Phase 4b; non-owner collaborator launch is Phase 7.)

## Critic Feedback Incorporated

- Initial topology review 2026-05-13: compared local exposure, relay, local
  collaboration manager, cloud-hosted sessions, and event-sourced terminal
  collaboration. Incorporated the finding that existing byte serialization is
  not enough; the terminal-control phase needs many-viewer / one-controller
  semantics.
- Security/auth review 2026-05-13: incorporated local-node final
  authorization, separate grants for dangerous actions, invitation
  constraints, metadata-only audit defaults, and the rule that the current
  local WebSocket command union must not be exposed wholesale through the
  relay.
- Device-local audio review 2026-05-13: changed STT/TTS from session-level
  services to per-device and per-node capabilities. Added privacy routing:
  raw audio stays local by default and speech produces draft text that flows
  through the normal command path only after user submission.
- Operability/migration review 2026-05-13: changed rollout from "remote input
  early" to a staged sequence: event hygiene, read-only relay, read-only task
  dashboard, opt-in terminal viewing, supervised actions, then shared
  terminal control. Added node epochs, reconnect cursors, no offline
  terminal queue, and `tasks.json` as local materialized view rather than
  collaborative database.
- Round 2 boundary review 2026-05-13: added the "Coordination primitives"
  section as a single source of truth for `nodeId`, `nodeEpoch`,
  `sessionEpoch`, `serverRevision`, `seq`, `policyVersion`, `grantId`,
  `commandId`, `idempotencyKey`, `leaseId`, `permissionRequestId`. Introduced
  the typed `ShareSubject` hierarchy. Defined the PolicySync protocol with
  the relay as sole writer of `policyVersion` and a documented
  resync-on-reconnect rule. Separated `baseRevision` (control-plane check)
  from `lastSeenSeq` (terminal-plane check) into distinct validators.
  Acknowledged relay-side ephemeral state for `permissionRequestId` and
  controller leases.
- Round 2 failure-mode review 2026-05-13: pinned down idempotency tuple,
  retention, and epoch-binding. Specified end-to-end node-acked lease
  heartbeat and `lease.invalidated` broadcast. Specified `nodeId` derivation
  and disk-loss path. Added write-ahead audit (intent → execute → result)
  and the `command.getOutcome` ack-loss recovery path. Added a permission
  UI ordering contract and explicit panic-switch semantics for in-flight
  permission approvals. Added rollback and schema-evolution rules and a
  forward-only baseline with documented migration scripts for exceptions.
- Round 2 minimalism review 2026-05-13: collapsed `ShareGrant` to
  `view | write | admin` for Phases 1–6; moved the full
  `SessionSharePolicy` (`members[]`, `deny[]`, `includeFutureSessions`,
  `comment` / `launch` / separate `terminalInput` / `permissionApprove`)
  into **Appendix A**. Moved the full `SpeechCapability` discriminated
  union and the `CollaborationCapabilities` indexed type into
  **Appendix C**. Moved the full `SubmitMessageRequest` and
  `AuthorizedRemoteCommand` types into **Appendix B**. Dropped
  `streamId` from `TerminalStreamEvent`. Narrowed `RemoteControlEvent.kind`
  to the variants each phase actually ships. Collapsed the human-user and
  relay-tenant identities for self-hosted V1, retaining the conceptual
  distinction for a future multi-tenant hosted relay.
- Round 2 ambition review 2026-05-13: pulled remote permission approval
  into Phase 4a (single-owner; does not require multi-user invitations).
  Pulled a narrow `presetReply` write path into Phase 4a using a fixed-shape
  request rather than arbitrary text. Pulled Web Push block alerts into
  Phase 2 (was "optional later"). Added the `KOOKR_RELAY_TRUSTED` env gate
  and the plaintext-relay consent screen as a deployment-level decision
  rather than only RFC text. Closed Open Question 1 (remote launch is
  owner-only in Phase 4b; collaborator launch is Phase 7). Added the
  two-node isolation test as a Phase 1 acceptance gate.
- Round 2 delivery review 2026-05-13: made `serverRevision` an optional
  field on `SnapshotMessage` so Phase 0a is additive. Specified the
  `node.hello`/`relay.hello` protocol handshake. Split Phase 4 into
  Phase 4a (safe supervised actions + permission approve + preset reply)
  and Phase 4b (allowlisted launch) so 4b can roll back independently.
  Added a "Minimum infrastructure for Phase 1" section so the demo slice
  is actually demoable. Added `KOOKR_RELAY_FEATURES` as a Phase 5
  operator-level kill switch.

**Adversarial pair resolution (ambition-amplifier vs design-minimalist).**
Ambition-amplifier argued the deferred capability (terminal input) was the
load-bearing user value and should ship earlier in some form;
design-minimalist argued that input-related types belong in a Phase 5
appendix because V1 has no remote input. **Author resolution: both.**
Phase 4a ships a *narrow* write surface (`presetReply` with a fixed-shape
request and a node-side text mapping) that proves the auth/lease/audit
chain on a small daily-use mutation, satisfying the ambition concern
without unlocking arbitrary terminal input. The full
`SubmitMessageRequest` type stays in **Appendix B (Phase 5)** so the V1
contract is not weighed down. The `AuthorizedRemoteCommand<P>` envelope
moved out of Appendix B into `control-events.ts` at Phase 4a because
the `presetReply` path needs it; only the `SubmitMessageRequest` payload
is genuinely Phase-5-only.

- Round 3 socratic + state-machine review 2026-05-13: closed several
  documented-but-contradictory or undefined states. Rewrote the
  controller-lease section as a closed state enum (`none`, `acquiring`,
  `held-local`, `held-remote`, `held-uncertain`, `releasing`, `revoked`)
  and reconciled the apparent contradiction between "node revokes
  locally on disconnect" and "clients see uncertain" by clarifying
  they describe the same event from two latency horizons. Added the
  handshake downgrade path (`outcome: 'accepted' | 'downgraded' |
  'refused'` on `RelayHello`). Added a single `session.epoch-changed`
  broadcast event so clients flush stale state in one round-trip.
  Specified relay queue behavior during PolicySync ack wait
  (`command-held-pending-policy-ack`, 2s max, then
  `error.policyVersionPending`). Differentiated `command.getOutcome`
  return values into `accepted | rejected | unknown-intent-only |
  unknown-never-seen | unknown-purged | node-offline` so callers can
  judge retry safety. Specified freshness-wins semantics for
  in-flight commands crossing `policy.revoke`. Specified
  `nodeEpoch` persist-before-use. Added `permission.resolved.reason`
  with `approved | denied | expired | cancelled-by-agent |
  cancelled-by-panic | cancelled-by-epoch` so audit trails
  distinguish operator denial from panic-forced denial. Specified the
  Phase 4a vs Phase 4b boundary as a threat-model boundary (existing
  state vs minted new state), not just a feature-cut convenience.
  Clarified that `KOOKR_RELAY_TRUSTED` is a consent record at flag-set
  time, not a runtime trust check. Specified Web Push payload
  redaction (`taskShortLabel`, node-side projection only).
  Specified panic-switch local-emergency mode wipes the share-policy
  cache so the relay's policy is re-traversed on reconnect. Defined a
  default lease heartbeat (15s) and the timeout budget (≥30s = two
  misses = local revoke). Named the canonical write-ahead audit log
  location (node) and the relay's metadata audit as forensic
  cross-check. Concretized the Phase-1 two-node isolation test as
  four named assertions runnable via
  `pnpm test:e2e:relay --fixture=two-nodes`.
- Round 3 operability review 2026-05-13: added a top-level
  Operability section enumerating health/status endpoints
  (`GET /health`, `/relay/admin/nodes`, `/api/node/status`),
  operator CLI surfaces (`kookr command outcome`, `kookr relay
  status`, `kookr panic`/`panic clear`, `kookr push test`),
  structured-log correlation contract, metric categories per phase,
  idempotency-cache bounds (100k hard cap, LRU eviction), audit log
  rotation mechanism (daily roll, 50MB cap, queryable via
  `--since`), local dashboard relay indicator state machine, and a
  high-level panic-recovery runbook.
- Round 3 module-interface review 2026-05-13: split the proposed
  `protocol.ts` into `handshake.ts`, `control-events.ts`,
  `stream-events.ts`, `policy-sync.ts`, and `ids.ts` so each
  consumer takes a narrow dependency. Introduced branded identifier
  types in `ids.ts`. Resolved the `policy-cache.ts`
  (data structure) vs `share-policy.ts` (pure evaluator) boundary.
  Merged `audit-log.ts` + `idempotency-cache.ts` into a single
  `command-journal.ts` to make the shared-storage coupling explicit.
  Introduced a shared `RemoteCommandHandler<Req, Res>` interface in
  `command-pipeline.ts` so `preset-reply`, `permission-broker`, and
  `launch-broker` cannot diverge on the audit/idempotency/ack
  pipeline. Made `ShareGrant` an open string union with a separate
  exhaustive `KnownGrant` switch so Phase 7 grant additions do not
  require a protocol-envelope version bump. Folded
  `CapabilityRevokedEvent` into `RemoteControlEvent.kind =
  'capability.revoked'` and stated the rule that all node-to-client
  signaling events use the control channel. Made
  `PresetReplyRequest.presetId → text` mapping a public constant in
  `preset-reply.ts` so clients can preview the text. Defined a
  `KOOKR_RELAY_FEATURES` token vocabulary in `handshake.ts` so a
  typo'd deny-list emits a WARN on startup. Specified the
  `CommandOutcomeQuery` / `CommandOutcome` signature including
  `node-offline` as a distinct return value.

- Round 4 regression + convergence review 2026-05-13
  (design-minimalist, failure-mode-analyst, socratic-challenger,
  boundary-critic). Cleanup: removed `unknown-purged` from
  `CommandOutcome` (merged with `unknown-intent-only`); removed
  `releasing` from the client-visible lease enum (now node-internal);
  replaced the named handshake state machine with one paragraph + the
  `outcome` union; trimmed Operability §9 from prescriptive UI/db spec
  to logical-state contracts; removed the duplicate
  `KOOKR_RELAY_FEATURES` token enumeration. Correctness additions:
  required `idempotencyKey` to be stable across `commandId` retries
  and added `grantId` to the idempotency tuple so revoked-and-re-issued
  grants cannot collide; added `rejected-pre-audit` outcome so
  deterministic validation failures do not loop through retries; added
  a revoked-grant **tombstone set** on the node so `policy.revoke` for
  unknown `grantId`s is recorded (and re-introductions rejected);
  switched Web Push payload redaction from a denylist of "common secret
  patterns" to a **versioned allowlist** (`[A-Za-z0-9 .,!?-]{0,64}`);
  specified `nodeEpoch` persist-failure handling
  (`nodeMode: 'degraded'`, local UI still served, outbound refused);
  specified that owner-local operations bypass the share-policy cache
  so panic-mode does not lock the owner out; mandated input-disabled
  during `held-uncertain`; added `held-presumed-lost` client-only state
  after 35s of uncertainty; added owner-override arbitration rule for
  the 15s heartbeat gray zone; required the relay's metadata audit to
  **append** a terminal-outcome row on every node-side reject so audit
  chains close; reframed Phase 4a/4b boundary as **gated-resume vs
  cold-start at the Kookr command layer** (replacing the looser
  "references existing state" wording so future scope arguments cannot
  drift through it). Spec/build-blocker fixes: stated Phase 1 ships at
  `protocolVersion: 1` and specified `kookr relay init` output and
  rotation; added a Phase 0a precondition that the existing snapshot
  parser tolerates unknown fields; replaced Phase 4b's "ships when
  stable" gate with a measurable precondition; specified that
  `KOOKR_RELAY_TRUSTED` records the relay's TLS fingerprint at
  acknowledgement time and re-prompts when the fingerprint changes;
  Failure Modes table updated to use the new lease vocabulary
  (`held-uncertain`, `lease.changed { revoked }`). Boundary notes:
  named the rule that `ids.ts` must remain runtime-import-free from
  sibling modules; left the `command-journal.ts` merger as a principle
  rather than a file mandate; deferred several Phase-4a internal module
  names to implementation.

- Local-only safety hardening 2026-05-14 (author-initiated, prompted
  by an end-user concern that the staged rollout could regress an
  already-shipping local-only Kookr install). Added requirements R23
  ("local-only is a first-class supported configuration; per-phase
  smoke test gate") and R24 ("local-only config footprint is
  bounded"). Added a dedicated "Local-Only Safety Contract" section
  enumerating: the mandatory local-only smoke test (8 steps including
  STT/TTS paths); a code-path-isolation rule that prohibits
  `src/remote/*` runtime code from running in local-only mode beyond
  inert imports; a configuration-defaults rule that no new
  `KOOKR_RELAY_*` / `KOOKR_PUSH_*` / `KOOKR_AUDIT_*` variable is
  required for local-only operation; a `tasks.json` schema
  round-trip rule across phase up/downgrades; and a **strict
  parallel-fields contract for STT/TTS deprecation** (legacy
  `sttEnabled` / `sttUrl` fields preserved through Phase 5 and beyond,
  removal gated on the new `SpeechCapability` descriptors reaching
  local-STT feature parity in the smoke test, not on a release-date
  target). Threaded the smoke-test acceptance gate into every phase
  entry in the Migration Plan. Added extra preconditions to Phases 0a,
  3, and 6 (the highest local-only-blast-radius phases): Phase 0a
  emits the new `serverRevision` only when the remote-node client is
  active; Phase 3 includes a byte-equality test before/after the
  `SessionBridge` refactor; Phase 6 includes a parallel-fields-coexist
  test. Clarified that the Phase-1 two-node fixture tests multi-node
  infrastructure isolation, not the V1 single-owner user surface.

- Local-only safety verification 2026-05-14 (delivery-pragmatist,
  failure-mode-analyst, boundary-critic, all focused on whether the
  v6 contract was enforceable in practice). All three critics agreed
  the contract named the right invariants but relied on **behavioral
  tests where structural enforcement was needed**. v7 closes the gap:
  - Added a **CI prerequisites** subsection enumerating five
    deliverables that must be merged *before* Phase 0a ships:
    (1) `pnpm test:smoke` script and CI job;
    (2) a `module-load purity` test asserting `src/remote/*` modules
    open no files, register no listeners, schedule no timers at
    import-time; (3) an ESLint `no-restricted-imports` rule forbidding
    non-`import-type` imports from `src/remote/**` outside the dynamic-
    import branch in `src/server/index.ts`; (4) a `~/.kookr/`
    filesystem-diff assertion baked into the smoke test;
    (5) a `SessionBridge` byte-equality golden fixture using the
    existing `FakeTerminalBackend`.
  - Expanded the smoke test from 8 to 11 steps to cover the actual
    Kookr feature set: explicit no-error startup assertion for ralph
    loop / schedule runner / achievement watcher / telemetry writer /
    supervisor / project drawer / OSS source watcher; chime fires on
    task completion; `~/.kookr/` diff assertion; module-load purity as
    a precondition. Required the smoke test to use `KOOKR_FAKE_TERMINAL=false`
    and `KOOKR_USE_FAKE_AGENT=false` (real PTY, real agent).
  - Pinned the structural shapes the v6 contract had left ambiguous:
    **dynamic import only** for `src/remote/*` from `src/server/*`;
    `TerminalBackend.write` is unmodified (Phase 5 lease check lives
    in `src/server/remote-input-adapter.ts`, a wrapper); the Phase 4a
    permission broker is **sidecar, not wrapper** — the existing local
    resolver's call sites are not modified, and a single named
    `isOwnerLocal()` predicate in `src/server/auth.ts` is the
    chokepoint for owner-bypass; `session-stream-publisher.ts`
    subscribes alongside `SessionBridge`, not in front of it;
    `KOOKR_RELAY_*` / `KOOKR_PUSH_*` parsing happens inside the
    dynamically-imported remote module, never in a central config
    loader; `serverRevision` is **not emitted** on local-only
    snapshots (was previously "optional and ignored").
  - Added an **author canary period** per phase (5 days for Phases 0a,
    3, 6; 2 days for others) requiring real local-only use on the
    author's daily-driver install before the phase is declared shipped.
  - Added a `kookr command outcome` aggregation rule: the CLI lives
    in `src/cli/` (not `src/remote/`) and reads both
    `interaction-log.ts` (local commands) and `audit.jsonl` (remote
    commands); a local-only user querying outcome sees their local
    commands. Closes the bifurcated-history UX gap.
  - Expanded the `tasks.json` round-trip test from forward-only to a
    **three-path test**: forward, backward, and cycle (Phase N → N+1
    → N → N+1). The cycle test catches "Phase N+1 assumes monotonic
    forward progress" bugs and covers the `interaction-log.jsonl`
    shape, not just `tasks.json`.
  - Added a **relay-tainted state cleanup** contract: next local-only
    start after a temporary relay-active period must succeed cleanly;
    a new `kookr local-only doctor` CLI inspects `~/.kookr/`, reports
    relay-tainted files, and offers to archive (never delete) them;
    smoke test exercises this path.
  - Added a **browser bundle cache mismatch** contract: Phase 6
    includes a `bundle-cache-mismatch` frontend test verifying a
    Phase-6 bundle against a Phase-5-shape server (and vice versa)
    falls back to the legacy STT path without error.
  - Replaced Phase 6's qualitative "feature parity" with a concrete
    **bilingual STT parity test**: server strips `sttEnabled`/
    `sttUrl` from snapshots, dashboard drives local STT through
    `SpeechCapability` descriptors only; legacy fields removed after
    this test passes for two consecutive minor releases. Without the
    test, "parity" was unfalsifiable.

**Convergence note.** v7 codifies the structural enforcement that v6
lacked. The author has stopped iterating on architecture and now
treats the local-only safety surface (CI prerequisites + canary
period) as the gating work that precedes Phase 0a implementation.

---

## Appendix A: Phase 7 sharing types

Loaded when multi-user invitations ship. Not part of the V1–Phase 6
protocol contract.

```ts
type Phase7Grant =
  | 'view'
  | 'comment'
  | 'terminalInput'
  | 'launch'
  | 'stop'
  | 'permissionApprove'
  | 'admin';

interface SessionSharePolicy {
  subject: ShareSubject; // typed; see Coordination primitives
  policyVersion: number;
  createdBy: string;
  createdAt: string;
  includeFutureSessions?: boolean;
  members: Array<{
    userId: string;
    grants: Phase7Grant[];
    deny?: Phase7Grant[];
    expiresAt?: string;
  }>;
}
```

`includeFutureSessions` only takes effect when a Phase-7 policy engine
evaluates new session creation against an existing project- or node-scope
policy.

## Appendix B: Phase 5 input contract

Loaded when shared terminal control ships. The
`AuthorizedRemoteCommand<P>` envelope shape moved out of this appendix
into `src/remote/control-events.ts` because it is used from Phase 4a
onward; only `SubmitMessageRequest` is genuinely Phase-5-only.

```ts
interface SubmitMessageRequest {
  type: 'submit-message';
  sessionId: string;
  sessionEpoch: string;
  leaseId: string;
  commandId: string;
  idempotencyKey: string;
  text: string;
  appendNewline: boolean;
  baseRevision: number;
  lastSeenSeq: number;
  inputContextId?: string; // node-issued, identifies the prompt frame the
                           // operator was responding to; node revalidates
                           // it has not advanced past the frame
  maxAgeMs: number;
  commandMetadata?: {
    provenance?: 'typed' | 'stt-draft' | 'paste';
    sttCapabilityId?: string;
    edited?: boolean;
  };
}

interface AuthorizedRemoteCommand<P> {
  actorId: string;  // relay-derived
  clientId: string; // relay-derived
  commandId: string;
  nodeId: string;
  nodeEpoch: string;
  sessionId: string;
  sessionEpoch: string;
  grantsChecked: ShareGrant[];
  policyVersion: number;
  grantId: string;
  leaseId?: string;
  baseRevision: number;
  lastSeenSeq?: number;
  idempotencyKey: string;
  payload: P;
}
```

The Phase 4 `PresetReplyRequest` is wrapped in the same
`AuthorizedRemoteCommand` envelope; `leaseId` is omitted for the preset
path because preset reply does not require a controller lease.

## Appendix C: Phase 6 capability advertisement

Loaded when speech capabilities ship.

```ts
type SpeechCapability =
  | {
      kind: 'stt';
      deviceId: string;
      deviceSessionId: string;
      capabilityId: string;
      displayName: string;
      nodeId?: string;
      locality: 'browser' | 'node-local';
      scope: 'same-device' | 'local-node-ui-only' | 'remote-routable';
      protocol?: 'web-speech' | 'kookr-stt-ws';
      maxSeconds?: number;
      maxBytes?: number;
      advertisedAt: string;
      expiresAt: string;
      readiness: 'ready' | 'starting' | 'unavailable';
      privacy: 'local-only' | 'consent-required';
    }
  | {
      kind: 'tts';
      deviceId: string;
      deviceSessionId: string;
      capabilityId: string;
      displayName: string;
      nodeId?: string;
      locality: 'browser' | 'node-local';
      scope: 'same-device' | 'local-node-ui-only' | 'remote-routable';
      voices?: string[];
      advertisedAt: string;
      expiresAt: string;
      readiness: 'ready' | 'starting' | 'unavailable';
      privacy: 'local-only' | 'consent-required';
    }
  | {
      kind: 'mic-capture' | 'playback' | 'notification' | 'chime';
      deviceId: string;
      deviceSessionId: string;
      capabilityId: string;
      displayName: string;
      advertisedAt: string;
      expiresAt: string;
      readiness: 'ready' | 'unavailable';
    };

interface CollaborationCapabilities {
  capabilitiesByDevice: Record<string, SpeechCapability[]>;
  capabilitiesByNode: Record<string, SpeechCapability[]>;
}

// Capability revocation travels as a RemoteControlEvent kind variant,
// not a top-level type, for consistency with lease.changed and
// permission.resolved (one event channel, phase-tagged variants):
interface RemoteControlEvent_Phase6_kinds {
  kind: 'capability.revoked';
  payload: {
    capabilityId: CapabilityId;
    deviceId: DeviceId;
    reason: 'expired' | 'device-disconnected' | 'node-revoked' | 'user-revoked';
  };
}
```

The `capabilitiesByNode` index is consulted only when multi-node UX (Phase
7) is also live; Phase-6-only deployments may omit it. The deprecation
point for the legacy `sttEnabled` / `sttUrl` fields in the local
`SnapshotMessage` is at Phase 6 ship time: those fields are then marked
`deprecated` in the schema and removed two minor releases later, with a
node-side warning if they are still consumed.

**Rule for new events:** any node-to-client signaling event travels as a
`RemoteControlEvent` `kind` variant. The only top-level event type is
`TerminalStreamEvent`, which has its own channel for backpressure and
seq-numbering reasons.
