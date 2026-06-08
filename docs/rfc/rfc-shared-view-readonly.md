# RFC: Read-Only Shared View Over a Private Network

## Status

Draft (v4 — post-round-3 revision; converged)
Date: 2026-06-08
Author: Jean Ibarz (with Claude)

---

## Problem

Kookr's dashboard is a single-owner, single-privilege surface. A connecting
client is either on loopback (no auth) or presents the one API token, and that
token grants **full control**: launch, stop, terminal input, permission
approval, task edits. There is no way to let a second, trusted person *watch*
the dashboard without also handing them the keys to the running agents.

The concrete goal:

> A trusted person (e.g. the owner's brother) can open a browser on a shared
> private network (Tailscale / WireGuard / LAN) and see a **live, read-only**
> view of either **one project** or the **whole dashboard** — task cards,
> prompts, criteria, findings, chat, and live terminal output — and can never
> mutate anything. The owner can create and revoke this access at will.

This RFC is deliberately **private-network direct**: no public relay, no VPS,
no hosted rendezvous. The network boundary is the tailnet. The owner binds the
dashboard to a non-loopback host reachable only on that private network, and
hands the viewer a scoped, read-only credential.

### Two blocking auth gaps exist *today* on non-loopback binds

Round-1/2 review verified the current `src/server/auth.ts`. The existing
non-loopback story is itself broken in two ways:

1. **The HTTP read surface is wide open.** `createApiAuthMiddleware` exempts
   `SAFE_METHODS` (GET/HEAD/OPTIONS) from the token check entirely. On a
   non-loopback bind, `GET /api/snapshot`, `/api/projects`, `/api/files/raw`,
   etc. return full data to **anyone who can reach the port** — no token. This
   RFC treats closing that hole as foundational (R7).
2. **The browser never sends the token on the WS (#708).** The WS upgrade is
   token-gated, but the browser WS client
   (`src/frontend/hooks/useWebSocket.ts:104`) builds the URL from
   `window.location` with no credential. Page loads, reads leak, live stream is
   dead.

### The broadcast is a whole-world snapshot, not deltas

`broadcastToAll` (`src/server/bootstrap/create-realtime-services.ts`) builds
**one** `createSnapshotMessage` (a whole-world projection: all agents/tasks,
project summaries, coordinator state, total spend, task relations,
achievements), serializes it **once**, and sends that blob to every socket in
`clients`. There are no per-project deltas. **Project-scoped viewing requires
building a separately scoped snapshot per viewer connection.** This is the
central architectural fact the design is built around.

### Two socket populations, not one

Verified in round 2: dashboard sockets go into `clients`
(`ws-connection-handler.ts`), but **terminal sockets live in a separate
`terminalWss` / `activeBridges` registry** (`start-http-and-websockets.ts`) and
never enter `clients`. Any "drop the viewer's sockets" mechanism (revocation)
must enumerate **both** pools or it silently leaks the most sensitive stream.

### Why existing remote-share infrastructure does not already solve this

Kookr's relay/contact-share stack (`relay/server.ts`, `share-routes.ts`,
`contact-share.ts`, `remote-share.ts`) is built around a relay rendezvous and a
minimal redacted projection (`RemoteTaskProjectionV1`: label, status,
hasFinding, needsInput). It is not a live mirror and is the wrong shape for a
direct LAN browser. This RFC adds a **direct viewer path on the dashboard
server**, reusing transport-neutral primitives and the **existing
`CollaborationAuditLog`** (`src/server/collaboration-audit-log.ts`). See
*Alternatives considered* for the rejected relay / second-process / env-token
options.

---

## Requirements

**R1 — Viewer credential.** The owner can mint one or more read-only *viewer
grants*, separate from the owner token: id, secret token, label, scope, optional
expiry, revoked flag.

**R2 — Scope.** A grant's scope is `all` (whole-dashboard) or a set of
`projectId`s. A project-scoped viewer must never receive *any* data — task,
agent, terminal, project metadata, **or whole-world aggregate** (total spend,
cross-scope relations, achievements, GitHub refs, file contents) — that reveals
projects outside its scope, **on any channel** (WS snapshot, terminal stream, or
HTTP GET).

**R3 — Strictly read-only, fail-closed.** A viewer can never cause a mutation.
Every mutating HTTP route and every inbound WS message — including handlers that
run before the message router — is denied for a viewer, default-deny.

**R4 — Full live mirror within scope.** Task cards + status, prompts, criteria,
findings, chat, and live terminal/agent output streams, all live, all
read-only.

**R5 — Immediate revocation.** On revoke, the viewer's live sockets — **both
dashboard and terminal** — are dropped within ≤ one revocation-sweep interval
(default 10 s), and further requests are rejected at once.

**R6 — Browser auth on non-loopback.** The viewer's (and owner's) browser
authenticates HTTP **and** WS on a non-loopback bind via a cookie exchange,
closing #708, without editing every fetch call site and without putting a token
in any WS query string.

**R7 — Non-loopback requires a credential on every method; viewers get data
only through scoped channels.** On a non-loopback bind, **all** API requests
(including GET) require a valid owner or viewer credential (static SPA assets
exempt). Additionally, a **viewer** is denied (403) on all API data routes by
default — viewer data flows **only** through the scope-filtered WS snapshot and
scope-checked terminal streams. File-browse and other data GETs are owner-only.

**R8 — Owner control surface.** Create, list, revoke grants; copy a handoff URL.

**R9 — No regression on loopback.** Loopback (`127.0.0.1`) owner behavior is
unchanged: no tokens, no cookies, no viewer machinery in the hot path.

**R10 — Operable and audited.** Grant create/revoke/use/evict events are written
to the existing `CollaborationAuditLog`; auth rejections are logged with a
reason; the revocation sweep and live viewer roster are observable at runtime.

---

## Non-Goals

- Any viewer write path. Strictly read-only.
- Public relay / VPS / hosted rendezvous. Private network only.
- Multi-tenant accounts, SSO, org management, or ACLs finer than project
  granularity.
- E2E encryption beyond the transport (Tailscale/WireGuard/TLS).
- Redacting secrets from terminal output. Full-mirror **intentionally** shows
  terminal streams within scope; the owner accepts a viewer sees what the
  terminal shows. (A per-grant "hide terminals" toggle is a cheap future add but
  is out of this iteration since the owner chose a full mirror.)

---

## Transport security posture (decided)

The stated deployment is plain `http://<tailnet-ip>:<port>` over Tailscale /
WireGuard, where the **transport is already encrypted by the mesh** — the same
model the codebase already encodes as `transportSecurity:
'authenticated-secure-tunnel'` (`src/server/collaboration-config.ts:152`).

A `Secure` cookie is **not sent by browsers over plain HTTP**, so a naive
`Secure` flag silently breaks the whole exchange on the target deployment. Decision:

- The session cookie is always `HttpOnly; SameSite=Strict; Path=/`.
- `Secure` is set **iff** the request arrived over HTTPS.
- Dropping `Secure` is permitted **only** when the operator asserts a secure
  tunnel: `KOOKR_TRUSTED_TUNNEL=true` (or an HTTPS origin). On a non-loopback
  bind **without** HTTPS and **without** `KOOKR_TRUSTED_TUNNEL`, the server
  **refuses to start the viewer feature** and logs why (fail-closed — do not
  silently ship a non-`Secure` cookie on an unasserted network).
- Recommended path documented in setup: **Tailscale Serve** to get HTTPS, which
  keeps `Secure` on and needs no flag.

---

## Design

### Identity model

```ts
type Scope = { kind: 'all' } | { kind: 'projects'; projectIds: string[] }  // projectIds sorted+deduped (canonical)
type Actor =
  | { kind: 'owner' }
  | { kind: 'viewer'; grantId: string; scope: Scope }
```

- Loopback ⇒ `owner` (hot path untouched, R9).
- Owner token/cookie ⇒ `owner`. Viewer token/cookie ⇒ `viewer` + scope.
- No/invalid credential on non-loopback ⇒ rejected (fail-closed).

`Actor` is the single source of truth for enforcement and filtering. A one-line
doc comment in `auth.ts` records the boundary with the relay-path `OwnerIdentity`
(they are deliberately not unified).

> **Adversarial-pair note (design-minimalist vs ambition-amplifier).** Minimalist
> wanted a flat `viewerScope` and project-scope deferred; amplifier wanted the
> scope contract specified now. Resolution: a small typed union (clarity at the
> WS choke points) + specify the scoped-rebuild mechanism and field-scrub list
> now, but implement project-scope *evaluation* in Phase 2; Phase 1 ships
> whole-dashboard only.

### Viewer grant store

`${KOOKR_DIR}/share-grants.json` — using the resolved **per-port** `KOOKR_DIR`
(never a hard-coded `~/.kookr`), atomic write like `task-persistence.ts`:

```ts
interface ViewerGrant {
  id: string; tokenHash: string;  // sha-256(token); raw token shown once
  label: string; scope: Scope;
  createdAt: string; expiresAt?: string;  // default never; revocation is primary control
  revokedAt?: string;
}
```

Tokens hashed (sha-256), constant-time-compared, never logged raw. `lastSeenAt`
is not persisted (no hot-path write); live presence comes from the in-memory
connection registry.

### Auth resolution (`src/server/auth.ts`)

- `resolveActor(config, { host, method, headers, cookies, query }): Actor | null`.
  Loopback ⇒ owner. Else credential from `Authorization: Bearer` → **session
  cookie** → (HTTP only) nothing else; classify owner vs viewer; else `null`.
  Every rejection emits a structured log `{ event:'auth_rejected', reason:
  'revoked'|'expired'|'bad_token'|'cookie_missing'|'no_credential', remoteAddr,
  grantId? }` (R10).
- `createApiAuthMiddleware` (actor-aware):
  - **Removes the non-loopback safe-method bypass** (R7): `null` actor ⇒ 401 for
    *any* API method.
  - `viewer` + non-safe method ⇒ 403.
  - **`viewer` + any API data route ⇒ 403** (R7). A viewer's *only* permitted
    HTTP endpoint is `POST /api/auth/session`; **all** data-bearing routes,
    including `GET /api/health` (which leaks a global task count + attached
    session names — round-3 Issue 3), are owner-only. Viewer data arrives via
    the scoped WS channel only.
  - `owner` ⇒ pass. Loopback ⇒ bypass (R9).
  - Attaches actor via `c.set('actor', actor)` — requires adding a typed
    `Variables` param to the `Hono` instance (prerequisite; `c.set/get` unused
    today).
- **Unauthenticated allow-list** (no credential, even on non-loopback), matched
  on **pathname only** (no allow-listed route may carry a side-effecting query
  param — round-3 Issue 4): static SPA assets (an explicit asset allow-list
  evaluated **before** the middleware, never a catch-all that could shadow
  `/api`), `POST /api/auth/session`, and `GET /api/ready` (the liveness probe is
  unauthenticated by design — `diagnostics-routes.ts` — and must stay reachable
  without a credential; round-3 Issue 2).
- **Single scope-policy source (round-3 boundary).** Both the HTTP viewer
  deny-list and the WS `buildScopedSnapshot` derive from one
  `ViewerDataPolicy` co-located with the `Scope` type — e.g.
  `isViewerAllowedRoute(path)` and `isProjectInScope(scope, projectId)` — so the
  two enforcement loci cannot drift (a newly added data route is owner-only by
  default).
- `resolveUpgradeIdentity(config, req): Actor | null` for WS — **parses the
  Cookie header** (today's upgrade path reads only header/query). The legacy
  `?token=` **query branch on the WS upgrade is removed** so no token rides in a
  WS URL (header-bearer stays for CLI, which does not do WS upgrades).
  `isAuthorizedUpgrade` is kept as a one-line shim for reversible migration.

### Browser auth: fragment → HttpOnly cookie exchange (closes #708 + R6)

1. Handoff URL carries the raw token in the **fragment**:
   `https://<host>:<port>/#token=<raw>` (fragment never leaves the browser).
2. SPA loads (assets, no credential), reads `location.hash`, `POST`s the token
   to `POST /api/auth/session`. The endpoint **validates the token, checks
   `Origin`/`Sec-Fetch-Site: same-origin` (login-CSRF / session-fixation
   defense — see Threat model F5), sets the cookie** (posture above), returns a
   **per-session CSRF nonce** in the body, and the SPA clears the fragment.
   `/api/auth/session` is the only route exempt from the actor gate but is
   **not** exempt from the Origin check.
3. The browser then sends the cookie automatically on **HTTP fetches and the WS
   upgrade** — no edit to the ~52 existing `fetch()` call sites, no token in any
   WS query string. `useWebSocket.ts` needs no token logic.
4. The owner's own non-loopback browser uses the identical flow (owner token) —
   the #708 fix for the owner too.

CSRF: owner mutations carry the per-session `X-Kookr-CSRF` nonce (double-submit;
the nonce is **per-session in the session response**, not a per-process global).
Viewers cannot mutate regardless (R3); the Origin check on `/api/auth/session`
closes session-fixation.

### Connection registry + viewer-aware fan-out (boundary-clean split)

Two small modules, not one god-object:

- **`ViewerConnectionRegistry`** is the **sole writer/owner** of the authoritative
  `Map<WebSocket, Actor>` for **both** dashboard sockets and terminal sockets
  (each terminal socket registered with its `Actor` + `sessionName` at upgrade).
  `handleWsConnection` is passed the **registry (a `SocketRegistrar` interface),
  not the raw `clients` set** — it calls `register`/`unregister` rather than
  `clients.add/delete`, eliminating the three-party mutable ownership of the set
  (round-3 boundary Issue 2). API: `register(ws, actor, kind, meta?)`,
  `unregister(ws)`, `findByGrant(grantId)`, `getOpenDashboardSockets():
  WebSocket[]` (returns a **snapshot copy**, not a live iterator, so the
  broadcaster's fan-out can't race the sweep's concurrent deletes — round-3
  coupling), `size()`, `closeAll()`, `stopSweep()`, and the **revocation sweep**
  (interval, default 10 s, each tick try/catch-isolated; exposes
  `sweepTickCount` + `lastSweepAt`). The sweep drops any dashboard **or
  terminal** socket whose grant is revoked/expired, and **re-checks terminal
  scope each tick** (closes the reassignment TOCTOU). Shutdown order is explicit:
  `stopSweep()` → `closeAll()` → `httpServer.close()` (round-3 Low). Shutdown
  (`index.ts:1171`) and `getDashboardClientCount` (`index.ts:1055`) go through
  the registry, so `clients` no longer escapes. (The registry deliberately
  co-locates the map, terminal metadata, and sweep as one *connection-lifecycle*
  concern; if the sweep later needs its own policy it can be extracted — noted,
  not done now.)
- **`ViewerAwareBroadcaster`** is pure transport: it iterates the registry's
  dashboard-socket snapshot and, per connection, sends the right bytes. It does
  **not**
  import snapshot deps. It is constructed with an injected
  **`buildScopedSnapshot(scope: Scope) => SnapshotMessage`** factory (wired at
  bootstrap from `createSnapshotMessage`), preserving dependency direction
  (transport → injected domain fn, not transport → all stores). Per tick it
  builds/serializes the `all` snapshot once (owners + `all`-viewers) and one
  scoped snapshot per **distinct canonical scope key** among connected viewers
  (memoized). In Phase 1 only `all` exists, so it serializes once — no behavior
  change for the ~15–20 existing `broadcastToAll` call sites (signature
  preserved).

`buildScopedSnapshot` is the **single owner** of WS scope filtering; the initial
burst (below) calls the same injected factory — **not** a direct
`createSnapshotMessage` import (today `ws-connection-handler.ts` imports it
directly; that wiring must move to the injected factory or the single-owner
guarantee breaks silently — round-3 wiring risk). Together with the
`ViewerDataPolicy` shared by the HTTP deny-list, there is one scope source of
truth across both channels.

### WS read-only enforcement (`ws-connection-handler.ts`)

The gate sits at the **very top of `ws.on('message')`**, after schema parse but
**before** the inline `achievement:reset` / `achievement:setEnabled` handlers
and before `MessageRouter.handleMessageSafe` (round-2 F2: those inline handlers
mutate and must not be bypassed). It is a **positive allow-list**
(`ALLOWED_VIEWER_INBOUND = { heartbeat, ping }` — confirmed to exist as
`ClientMessage` variants, else the set is empty and viewers simply send
nothing): any other type, **including unknown/future types**, is rejected for a
viewer with a structured error and no state change. Default-deny by
construction; a newly added mutation type is denied without touching the gate.

### Outbound scope filtering — `buildScopedSnapshot` (Phase 2)

For a `projects` scope, the factory scrubs **every** whole-world sub-projection,
default-deny (a field not classified scope-safe is omitted):

- `agents`/tasks → only current `projectId` ∈ scope; **unassigned tasks
  (no `projectId`) hidden** from `projects` viewers, shown to `all`.
- `projectSummaries` → in-scope only.
- `taskRelations` → drop any edge touching an out-of-scope task (so existence
  of the far task does not leak).
- `totalSpendUsd` / aggregates → recompute over in-scope tasks or omit.
- `coordinator`, `achievementCounters`, GitHub refs
  (`githubStateStore.getTaskIdsWithReferences()` iterates all tasks), quota,
  resource/circuit-breaker status → omit unless explicitly scope-safe.
- **Free-text scrub:** `agentId`/`sessionName` strings embedded in in-scope
  chat/findings text are not relied on as secrets — the terminal scope check
  (below) is the real boundary — but the design note records that session names
  are capabilities, not secrets (round-2 F8).

### Initial-connection burst (consolidated)

`handleWsConnection` currently sends the snapshot **plus** four direct `ws.send`
calls (project summaries, GitHub state, quota, resource status). These are
consolidated behind a **single actor-aware initial-burst builder** that calls
`buildScopedSnapshot(actor.scope)` — one choke point, same scope logic as the
tick path.

### Terminal stream fan-out (`/ws/terminal/:sessionName`)

- On upgrade, resolve the actor (cookie). The handler is injected with
  **`isActorAllowedTerminalSession(actor, sessionName) => boolean`** (owns the
  whole check — lookup *and* scope comparison — so the upgrade handler holds
  zero scope logic; boundary round 2). Out-of-scope ⇒ 403, logged
  `{ grantId, sessionName, reason:'out-of-scope' }`.
- The socket is **registered with the registry** (actor + sessionName) so the
  sweep can drop/re-check it (R5, F1).
- **Output-only is enforced inside the bridge, not by omitting a callback.**
  Round-3 verified that the PTY-write path is hardwired in `SessionBridge.start()`
  (`session-bridge.ts:131` registers `ws.on('message')` → `writeInput`, plus
  `resize`/`paste` control frames) and identically in `FakeTerminalBridge`; the
  injected `onInput`/`onKeystroke` args are activity *notifications*, not the
  write path. So "don't register the callback" does **nothing** — a literal v3
  implementation would ship a viewer-**writable** PTY (a full mutation path,
  re-opening R3). The fix: a `readOnly` constructor flag on
  `SessionBridge`/`FakeTerminalBridge` that **skips registering the inbound
  `ws.on('message')` handler entirely** (no write, no resize, no paste). Viewer
  terminal sockets are constructed read-only; input frames are dropped before
  the bridge sees them. Both bridge files are named in *Files to change*.

### Owner control surface (R8) + observability (R10)

- Owner-only, CSRF-guarded: `POST /api/share/viewers` (create → raw token +
  handoff URL once), `GET /api/share/viewers` (list; per-connection roster from
  the registry: `connectedAt`, `remoteAddr`, `scopeEffective`; no raw tokens),
  `POST /api/share/viewers/:id/revoke`.
- **Phase 1 guard:** the create route accepts only `scope: all`; additionally a
  `projects`-scoped grant at WS upgrade is **rejected** (503 + log) while Phase 2
  is unshipped — no silent over-delivery of an `all` snapshot to a `projects`
  grant (operability).
- **Audit (R10):** `viewer-grant.created|revoked|session-established|sweep-evicted`
  appended to the existing `CollaborationAuditLog` (the `grantId` field already
  exists on `CollaborationAuditEvent`).
- **Health:** `/api/health` gains a `viewerBroadcaster` block
  `{ sweepIntervalMs, lastSweepAt, sweepTickCount, connectedViewerCount,
  grantStoreWritable }` so a dead sweep is visible.
- Phase 3 UX: read-only banner; client mutation-control suppression with a
  viewer-facing message on 403; Share dialog scope picker + expiry.

### Revocation (R5)

Silent viewers send no inbound messages, so revocation is the registry's
**interval sweep** (default 10 s, error-isolated per tick), dropping both socket
kinds by `grantId`. HTTP/WS auth rejects revoked/expired credentials immediately
on the next request. Distinct `sweep-evicted` (revoke) vs expiry are logged
separately.

---

## Files to change

New:

- `src/core/viewer-grants.ts` — grant store at `${KOOKR_DIR}/share-grants.json`.
- `src/server/viewer-connection-registry.ts` — socket↔actor map (dashboard +
  terminal), revocation sweep, health counters.
- `src/server/viewer-broadcaster.ts` — pure-transport fan-out over the registry,
  injected `buildScopedSnapshot`.
- `src/server/routes/viewer-share-routes.ts` — owner CRUD (CSRF-guarded, audited).
- `src/server/auth-session.ts` — `POST /api/auth/session` (Origin-checked cookie
  exchange + per-session CSRF nonce).
- `src/frontend/auth-session.ts` — fragment token → session POST → clear
  fragment; hold CSRF nonce for mutating fetches.
- `src/frontend/components/ShareViewerDialog.tsx`, `ReadOnlyBanner.tsx` (Phase 3).
- `docs/reference/shared-view-setup.md` — Tailscale Serve (HTTPS) / WireGuard +
  bind + `KOOKR_TRUSTED_TUNNEL` + share walkthrough.

Changed:

- `src/server/auth.ts` — `Actor`/`Scope`, `resolveActor`,
  `resolveUpgradeIdentity` (+ shim, **cookie parse, remove WS `?token=`**),
  actor-aware middleware (**remove safe-method bypass; viewer GET deny-list;**
  static-asset exemption), structured rejection logs.
- `src/server/routes.ts` — Hono `Variables`; set actor; mount session +
  viewer-share routes; CSRF guard; viewer GET allow-list.
- `src/server/bootstrap/create-realtime-services.ts` — registry + broadcaster
  replace bare `clients` fan-out.
- `src/server/bootstrap/start-http-and-websockets.ts` — `resolveUpgradeIdentity`
  on `/ws` and terminal; register sockets in the registry; terminal
  `isActorAllowedTerminalSession`; construct viewer terminal bridges `readOnly`.
- `src/server/session-bridge.ts` and `src/server/fake-terminal-bridge.ts` — add
  a `readOnly` flag that skips registering the inbound `ws.on('message')`
  write/resize/paste handler (the real output-only mechanism — round-3 blocker).
- `src/server/ws-connection-handler.ts` — receive the registry
  (`SocketRegistrar`) instead of the raw `clients` set; top-of-handler read-only
  allow-list gate (before inline `achievement:*`); consolidated actor-aware
  initial burst calling the injected `buildScopedSnapshot`.
- `src/server/viewer-data-policy.ts` (with `Scope`) — `isViewerAllowedRoute` +
  `isProjectInScope`, the single scope-policy source for both channels.
- `src/server/use-cases/get-snapshot.ts` — optional `scope` on
  `createSnapshotMessage`/`getSnapshotAgentsForClient`/`getProjectSummaries`;
  used by the injected `buildScopedSnapshot` (Phase 2).
- `src/server/index.ts` — shutdown + client-count via the registry (no escaped
  `clients`).
- `src/server/routes/diagnostics-routes.ts` — `viewerBroadcaster` health block.
- `src/server/collaboration-audit-log.ts` usage — viewer-grant events.
- `src/frontend/hooks/useWebSocket.ts` — no token logic (cookie on handshake);
  clear stale store state on session switch (avoid prior-session data flash).
- `docs/reference/environment-variables.md` — viewer-share, bind,
  `KOOKR_TRUSTED_TUNNEL`, cookie/CSRF.

---

## Edge cases

- **Revoked viewer mid-terminal** — sweep enumerates terminal sockets too (F1).
- **Task reassigned out of scope while terminal open** — sweep re-checks
  terminal scope each tick and closes (F8 TOCTOU).
- **Inline `achievement:*` from a viewer** — blocked by the top-of-handler gate
  (F2).
- **Project-scoped viewer hits a data GET** — 403 by the viewer GET deny-list
  (F3); viewer data flows only via WS.
- **`Secure` cookie on http tailnet** — posture decision: `Secure` iff HTTPS;
  else require `KOOKR_TRUSTED_TUNNEL` or refuse to start the feature.
- **Cross-origin `POST /api/auth/session`** — rejected by Origin check (F5).
- **Cookie missing `Path`** — pinned `Path=/` so it is sent on `/ws` and `/api/*`.
- **Sweep tick throws** — per-tick try/catch; loop survives (F11).
- **Two same-canonical-scope viewers** — one memoized rebuild; `['A','B']` and
  `['B','A']` canonicalize to the same key.
- **Two tabs same origin** — HttpOnly cookie per-origin; last session wins;
  documented (use a separate profile); SPA clears stale store on session switch.
- **Unassigned tasks / cross-scope relation edges / aggregates** — scrubbed
  default-deny in `buildScopedSnapshot`.
- **Port-instance isolation** — grants keyed to `${KOOKR_DIR}`.
- **Phase 1 + projects grant** — rejected at create and at upgrade; no silent
  over-delivery.

---

## Threat model

- **Trust level.** Viewer is trusted-but-least-privilege.
- **Network boundary.** The tailnet (mesh-encrypted). Not public. The credential
  scopes *what* and enforces *read-only* inside it.
- **Read-surface hole (closed).** R7: every API method needs a credential, and
  viewers are denied all data GETs (data only via scoped WS/terminal).
- **Read-only fail-open paths (closed in v3).** Terminal revocation (F1),
  pre-router inline mutations (F2), unscoped data GET / file-read (F3) are each
  addressed above.
- **Session fixation / login CSRF (F5).** `/api/auth/session` enforces a
  same-origin `Origin`/`Sec-Fetch-Site` check; the CSRF nonce is per-session.
- **WS token leak (F4).** Cookie on the handshake; the `?token=` WS branch is
  removed.
- **Token compromise.** Leaked viewer token ⇒ scoped read-only only, revocable
  within a sweep interval, no mutation, no cross-scope escalation. HttpOnly
  cookie not JS-readable (XSS can't exfiltrate). Raw token only in the one-time
  fragment.
- **Terminal output exposure.** Within-scope terminal streams are shown; secrets
  printed there are visible — accepted, documented.
- **Terminal write path (closed in v4).** Viewer terminal bridges are
  constructed `readOnly`, skipping the inbound `ws.on('message')` write handler
  in `SessionBridge`/`FakeTerminalBridge` — input frames cannot reach the PTY.
- **`KOOKR_TRUSTED_TUNNEL` is trusted, not validated.** It is an operator
  assertion that the bind sits behind a mesh-encrypted tunnel; the server does
  not verify the bind is non-public. Do **not** set it on a routable public bind
  — doing so ships a non-`Secure` cookie on an unencrypted path.
- **Read-only is server-enforced.** Client suppression is cosmetic.

---

## Phasing

- **Phase 1 — Foundation + non-loopback auth + whole-dashboard mirror.**
  Actor model + `resolveActor` (+ shim), R7 read-auth hole closed + viewer GET
  deny-list, cookie exchange with transport posture + Origin check (#708/R6/F4/
  F5), `ViewerConnectionRegistry` (dashboard **and** terminal) + error-isolated
  revocation sweep (F1/F11), top-of-handler default-deny inbound gate (F2),
  `ViewerAwareBroadcaster` (serialize-once, `all` only), grant store, owner
  create/list/revoke + audit + health + minimal UI, Phase-1 projects-scope
  guard. Whole-dashboard read-only mirror, end to end, fail-closed.
- **Phase 2 — Project scope.** `buildScopedSnapshot` with the full sub-projection
  scrub-list; per-connection memoized scoped rebuild in the broadcaster;
  consolidated scoped initial burst; terminal `isActorAllowedTerminalSession` +
  per-tick re-check (F8).
- **Phase 3 — UX + docs.** Read-only banner, mutation-control suppression +
  403 feedback, Share dialog scope picker + expiry, setup walkthrough.

If whole-dashboard proves sufficient, Phase 2/3 can be dropped and Phase 1
stands as a complete feature (minimalist). The scoped-rebuild mechanism and
scrub-list are specified now so Phase 1 builds the correct foundation
(amplifier).

---

## Tests and acceptance gates

- **R7:** non-loopback `GET /api/snapshot` no credential ⇒ 401; static asset and
  `GET /api/ready` ⇒ 200 with no credential; **viewer** GET `/api/files/raw`,
  `/api/snapshot`, `/api/task-relations`, **`/api/health`** ⇒ 403; viewer
  receives data only via WS.
- **Auth/cookie:** loopback⇒owner; owner/viewer classification;
  revoked/expired/bad⇒null; constant-time compare; shim parity; fragment→cookie
  sets HttpOnly/SameSite/Path=/ and (HTTPS) Secure; **cookie sent on `/ws` and
  `/api/snapshot`**; WS authenticates via **Cookie** (no `?token=`).
- **CSRF/fixation:** cross-origin `POST /api/auth/session` ⇒ rejected; per-session
  nonce; owner mutation without `X-Kookr-CSRF` ⇒ rejected.
- **Read-only (F2):** viewer `achievement:reset`/`setEnabled` ⇒ rejected, no
  state change; every known mutating WS inbound ⇒ rejected; **unknown** type ⇒
  rejected (positive allow-list).
- **Terminal write (round-3 blocker):** a viewer terminal socket sending an
  input/`resize`/`paste` frame ⇒ **no byte reaches the PTY** (bridge built
  `readOnly`); owner terminal input still works.
- **Revocation (F1/R5):** revoke ⇒ **dashboard and terminal** sockets dropped
  within one sweep; next request rejected; sweep tick throwing doesn't kill
  future sweeps (F11).
- **Scope (Phase 2):** scoped snapshot excludes out-of-scope tasks/agents/
  summaries/relations/aggregates; unassigned hidden; out-of-scope terminal
  upgrade ⇒ 403; reassignment closes open terminal next tick (F8); two
  same-scope viewers ⇒ one rebuild.
- **Transport posture:** non-loopback, no HTTPS, no `KOOKR_TRUSTED_TUNNEL` ⇒
  feature refuses to start with a clear log.
- **Observability:** `/api/health.viewerBroadcaster` reflects sweep liveness;
  grant lifecycle audit events written.
- **Loopback regression:** owner on `127.0.0.1` unchanged, no credential.

---

## Alternatives considered

- **Extend the relay / contact-share path.** Rejected: relay rendezvous +
  minimal redacted projection, not a live mirror; wrong shape for a LAN browser.
- **A separate read-only server process** (`KOOKR_READ_ONLY=true`). Rejected:
  live terminal mirroring needs the in-process `SessionBridge` objects (a second
  process reading `tasks.json` can't stream live terminals — violates R4); a
  whole-server read-only mode can't express per-project scope or per-viewer
  revocation (R2/R5).
- **A single shared `KOOKR_VIEWER_TOKEN` env var.** Rejected: no per-project
  scope, no single-viewer revocation, no multiple viewers (R1/R2/R5).
- **Token in the WS query string.** Rejected: leaks into proxy/access logs and
  forces editing every WS URL. Cookie exchange avoids both.
- **`Secure` cookie unconditionally.** Rejected: silently breaks on plain-http
  tailnet (the target). Conditional `Secure` + tunnel assertion instead.
- **Per-task shares.** Rejected: finer than requested; `projectId` is already on
  tasks.
- **Scope-filter every GET data route.** Rejected vs. simply denying viewers all
  data GETs and serving them only via the scoped WS channel — fewer choke
  points, fail-closed (F3).

---

## Open questions

- Rate-limit / lockout on `POST /api/auth/session` token attempts to blunt
  on-tailnet brute force — leaning yes, small.
- Memoized scoped-rebuild cost under many *distinct* scopes — expected small
  (few viewers); benchmark in Phase 2.

---

## Critic feedback incorporated

Round 1 (2026-06-08) — boundary-critic, design-minimalist, socratic-challenger,
ambition-amplifier, delivery-pragmatist. Round 2 (2026-06-08) —
failure-mode-analyst, boundary-critic, operability-reviewer.

Empirical checkpoint: the load-bearing claims (GET read hole, whole-world
snapshot, disjoint terminal/`clients` pools, inline pre-router mutation
handlers, no cookie parsing on WS upgrade, `Secure`-over-http) are all *static
code-structure facts* verified by direct read of `auth.ts`,
`create-realtime-services.ts`, `ws-connection-handler.ts`,
`start-http-and-websockets.ts`, `file-routes.ts`, and `collaboration-config.ts`
— no runtime probe was required to falsify or confirm them.

Round 1:
- **boundary-critic** — closed the safe-method read hole (R7); replaced
  "tag deltas" with a registry+broadcaster owning the socket↔actor map;
  consolidated the initial burst; CSRF on owner routes; `Actor`/`OwnerIdentity`
  boundary; terminal scope via injection.
- **socratic-challenger** — surfaced the whole-world-snapshot reality, the GET
  hole, the WS-query token leak (→ cookie), and silent-viewer revocation (→
  sweep); prompted the "second read-only process" rejection.
- **design-minimalist** — dropped persisted `lastSeenAt`; expiry default decided
  (never); Phase 1 UI minimized; scope evaluation deferred to Phase 2; cleartext
  token rejected (hashing is cheap).
- **ambition-amplifier** — scoped-rebuild mechanism + field-scrub list specified
  now; revocation mechanism committed (interval sweep).
- **delivery-pragmatist** — `isAuthorizedUpgrade` shim; cookie exchange dissolves
  the 52-fetch migration; registry established in Phase 1 as the Phase-2 hook;
  grants keyed to `${KOOKR_DIR}`; Hono `Variables` prerequisite.

Round 2:
- **failure-mode-analyst** — F1 terminal-socket revocation bypass (sweep now
  enumerates both pools + per-tick re-check); F2 pre-router inline mutations
  (gate moved to top-of-handler, positive allow-list); F3 unscoped GET/file-read
  (viewer data-GET deny-list, file routes owner-only); F4 WS cookie parsing +
  remove `?token=`; F5 session-fixation/login CSRF (Origin check on session
  endpoint); F6 per-session CSRF nonce; F8 terminal name/TOCTOU (per-tick
  re-check, names = capabilities); F11 sweep error isolation.
- **boundary-critic (r2)** — split the god-object into
  `ViewerConnectionRegistry` (ownership + sweep) and a pure-transport
  `ViewerAwareBroadcaster` taking an injected `buildScopedSnapshot` factory
  (preserves dependency direction); `isActorAllowedTerminalSession` owns the
  whole terminal check; canonical scope-key ordering; registry owns `clients`
  (shutdown/count no longer escape); single scope-filter owner
  (`buildScopedSnapshot`, used by both tick and initial burst).
- **operability-reviewer** — transport-security posture section (the
  `Secure`-over-http blocker, with `KOOKR_TRUSTED_TUNNEL` + Tailscale Serve);
  revocation-sweep health (`sweepTickCount`/`lastSweepAt` on `/api/health`);
  live viewer roster with `remoteAddr`/`scopeEffective`; distinct
  auth-failure/eviction reasons; audit via existing `CollaborationAuditLog`;
  Phase-1 projects-scope guard.

Round 3 (2026-06-08) — failure-mode-analyst, boundary-critic (focused closure
verification). Both confirmed F1–F5/F8/F11, the Secure-cookie posture, and the
GET deny-list architecture as sound, and found small localized residuals (no
architectural rework):
- **failure-mode-analyst (r3)** — **blocker:** "terminal output-only" was
  factually unachievable (the PTY-write path is hardwired in `SessionBridge`/
  `FakeTerminalBridge`, not in the omitted callback) → `readOnly` bridge flag
  that skips the inbound `ws.on('message')` handler; `/api/ready` restored to the
  unauthenticated probe allow-list; `/api/health` dropped from the viewer
  allow-list (it leaks a global task count + session names) → viewer's only HTTP
  endpoint is `POST /api/auth/session`; allow-list matched on pathname only;
  threat-model note that `KOOKR_TRUSTED_TUNNEL` is trusted-not-validated.
- **boundary-critic (r3)** — single `ViewerDataPolicy` source shared by the HTTP
  deny-list and `buildScopedSnapshot` (the two scope loci cannot drift);
  `handleWsConnection` takes the registry (`SocketRegistrar`), not the raw
  `clients` set (no three-party mutable ownership); registry exposes a
  **snapshot-copy** of dashboard sockets to the broadcaster (no iterate-vs-sweep
  race); explicit shutdown ordering; initial burst must call the injected
  factory, not import `createSnapshotMessage` directly.

Invocation log: ambition-amplifier 2026-06-08: novel finding (specify scope
contract + revocation mechanism now). Adversarial-pair resolution documented
inline in *Identity model*.

Convergence note: round 2 surfaced critical fail-open paths (F1–F3) + a
deployment blocker; round 3 surfaced one code-fact blocker (terminal write path)
+ small boundary/operability residuals — all now incorporated. Across round 3 no
architectural change was needed (only localized mechanism corrections), which is
the convergence signal. The architecture — `ViewerConnectionRegistry`
(dual-pool, error-isolated sweep) + injected-factory `ViewerAwareBroadcaster` +
fragment→HttpOnly-cookie exchange + `ViewerDataPolicy` (single scope source) +
`readOnly` terminal bridges + conditional-`Secure` transport posture — is
stable. Stopping at 3 rounds.
