# RFC: Easy Connection Sharing

## Status

**Draft (v3 - post-round-2 revision)** (2026-05-16)

---

## Problem

The collaborative remote sessions protocol exists, but the operator workflow is
still infrastructure-shaped:

1. Start or deploy a relay.
2. Create relay admin/client tokens.
3. Register a node through an admin API.
4. Copy the node token into the Kookr process environment.
5. Restart Kookr with `KOOKR_RELAY_URL`, `KOOKR_RELAY_TOKEN`, and related flags.
6. Create an invitation through another relay API or relay admin panel.
7. Send the resulting URL to the collaborator.

That is acceptable for protocol validation. It is not the product experience.
The user expectation is closer to TeamViewer or a video-call invite:

- the owner clicks **Share**;
- Kookr shows a short ID/password or a link;
- the collaborator enters those values and connects;
- the owner can revoke access immediately.

Users should decide what to share and for how long. They should not need to
understand relay bootstrap credentials, environment variables, or production
restarts for a one-off viewing session.

## Relationship To Existing Remote Sessions RFC

This RFC layers a product flow on top of
`docs/rfc/rfc-collaborative-remote-sessions.md`. It does not replace that RFC.

Preserved boundaries:

- Existing relay/node WSS protocol remains the transport.
- Existing invitations are the starting point for share lifecycle.
- Existing grants remain the authorization vocabulary.
- Existing node-side command revalidation remains the safety boundary.
- Local-only remains the default. With no relay configured and no explicit
  share action, remote modules remain inert.

## Goals

1. A collaborator can connect with a short code/password or one link.
2. The first shippable slice proves the full loop: create, join, view, revoke.
3. The V1 share is narrowly scoped: **current task, view-only**.
4. Sharing is explicit, time-boxed, single-accept by default, and revocable.
5. The owner sees connection state and active remote viewers.
6. Later phases remove relay setup friction without weakening the local-only
   default or node-side safety model.

## Non-Goals

- No collaborator mutation capabilities in V1: no terminal input, launch,
  stop, permission approval, or agent prompt injection.
- No project-wide or whole-node sharing in V1.
- No unattended permanent remote control.
- No raw localhost exposure or remote shell.
- No relay-side agent execution.
- No hosted `share.kookr.dev` dependency in the first dogfood slice.
- No WebRTC/P2P transport in V1.
- No end-to-end encrypted terminal stream in this RFC.

## Recommendation

Ship this in deliberately small layers:

1. **Phase A0:** configured-relay, view-only current-task Share UI using the
   existing invitation lifecycle.
2. **Phase B:** runtime relay connection manager for already-issued node
   credentials, so Kookr can connect/disconnect without a process restart.
3. **Phase B1:** safe node-registration pairing for self-hosted/custom relays.
4. **Phase C:** TeamViewer-style share ID/password as an evolution of
   invitations.
5. **Phase D:** hosted relay product path, with account/auth/ops gates.
6. **Phase E:** mutating collaborator grants with explicit owner confirmation.

The TeamViewer-like UX is the target. The fastest safe path is not to build
every piece at once; it is to make the current invitation machinery usable from
the dashboard first, then remove one infrastructure step per phase.

## V1 User Experience

### Owner Flow - Phase A0

Precondition: Kookr is already connected to a relay through the current
`KOOKR_RELAY_URL` and `KOOKR_RELAY_TOKEN` environment configuration.

The task detail surface gains a **Share** button. If no relay is connected, the
button opens a disabled state explaining that Phase A0 requires a preconfigured
relay. Settings linking appears only after Phase B adds an in-app connection
manager.

Clicking **Share** opens a modal:

```text
Share this task

View-only access
Expires in: 10 minutes / 1 hour / today

[Create share link]
```

The local node asks the relay to create an invitation for the current task with
grant `view` only. The relay remains the sole writer of invitation records,
grant IDs, and `policyVersion`. It then shows:

```text
Share link:
https://<relay>/relay/join#inviteToken=...

Waiting for viewer...
```

The owner can revoke the invitation from the same modal. Phase A0 shows only a
coarse state:

```text
waiting
viewer connected
revoked
expired
```

### Collaborator Flow - Phase A0

The collaborator opens the link, enters a display name, and sees the shared
task view. The UI labels the collaborator as an **unverified guest**. Display
names are convenience labels, not identity proof.

V1 view-only means a safe task projection, not the full local dashboard:

- task title or short label;
- task status;
- high-level findings/needs-input state;
- no terminal bytes by default;
- no paths, raw prompts, transcripts, diffs, command output, or environment
  data unless a later phase explicitly adds a projection rule.

Guest display names are untrusted text. They are length-limited, rendered as
text only, stripped of control/bidi characters, and never styled as trusted
identity. Owner-facing copy says "unverified guest".

## Share Subject And Projection Rules

V1 supports one subject:

```ts
type ShareSubject =
  | { kind: 'task'; nodeId: NodeId; taskId: TaskId };
```

The local node owns projection. The relay never derives task state from
terminal bytes and never receives more fields than the node publishes for that
grant. Phase A0 defines a single wire DTO:

```ts
type RemoteTaskProjectionV1 = {
  schemaVersion: 'remote-task-projection.v1';
  nodeId: NodeId;
  taskId: TaskId;
  taskLabel: string; // allowlisted characters, max 80 chars
  status: 'pending' | 'open' | 'inProgress' | 'needsInput' | 'completed' | 'failed' | 'cancelled';
  hasFinding: boolean;
  needsInput: boolean;
  updatedAt: string;
};
```

`RemoteTaskProjectionV1` is the only remote view contract in A0. The relay
transports it opaquely; the remote client renders only this DTO. It must not
reuse raw local dashboard task models or components that expect raw task data.

Future phases may add `session`, `project`, and `node` subjects, but each must
define an explicit projection table before implementation.

## Design

### 1. Evolve Invitations, Do Not Fork The Lifecycle

The current relay `InvitationStore` already has the security-critical lifecycle:

- hashed invitation tokens;
- single-use acceptance;
- member tokens;
- grants;
- expiry;
- revocation;
- policy versioning;
- active grant sync to nodes.

Therefore Phase A0 uses existing invitation APIs. Phase C evolves invitation
records rather than adding a parallel `ShareTicket` store.

Phase A0 adds a node-scoped relay operation, not an admin-token dependency in
the local dashboard:

```ts
type CreateNodeInvitationRequest = {
  nodeId: NodeId;
  subject: { kind: 'task'; nodeId: NodeId; taskId: TaskId };
  grants: ['view'];
  ttlMs: number;
};
```

The request is authenticated by the node's existing relay connection or node
token and may create/revoke invitations only for that same `nodeId`. The local
dashboard never imports relay store code directly and never receives the relay
admin token.

Phase C invitation extension:

```ts
type InvitationRecord = ExistingInvitationRecord & {
  shareId?: string;              // human code: "482-913"
  passwordVerifier?: string;     // hash/verifier only
  failedAcceptCount?: number;
  lockedUntil?: string;
  redactedShareLabel?: string;   // for diagnostics, never full secret
};
```

The accepted result remains a member token scoped to the invitation's grant.
Revocation remains keyed by `invitationId`/`grantId` and propagates through the
existing policy sync path.

For A0, one invitation may be accepted once. The resulting member token may
reconnect while the invitation is unexpired and unrevoked, but the owner UI only
shows the coarse `viewer connected` state. Multi-device member management is
deferred to Phase C/D.

### 2. Code/Password Shape - Phase C

The Phase C join page supports both:

```text
Share ID: 482 913
Password: cobalt mint 7
```

and:

```text
https://share.kookr.dev/join/482-913#cobalt-mint-7
```

Properties:

- Share ID is a sensitive routing identifier. Logs and diagnostics show only a
  redacted form such as `482-***`.
- Password has at least 40 bits of entropy for short-lived view-only shares.
- Default expiry is 10 minutes.
- Tickets are single-accept by default.
- Relay locks the ticket after a small number of failed attempts and rate-limits
  by share ID and remote address.
- The join page reads the URL fragment, stores the password only in memory, and
  immediately calls `history.replaceState` before loading telemetry or error
  reporting.

The code/password proves possession of a short-lived secret. It does not prove
real-world identity and does not grant mutation authority.

### 3. Runtime Relay Connection Manager - Phase B

Current remote node startup happens at server boot when `KOOKR_RELAY_URL` is set.
Phase B adds a runtime manager for **existing credentials**:

```ts
type RemoteConnectionHealth = {
  state:
    | 'notConfigured'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'degraded'
    | 'authFailed'
    | 'relayUnavailable'
    | 'revokePending';
  lastTransitionAt: string;
  relayUrl?: string;
  nodeIdHash?: string;
  lastHeartbeatAt?: string;
  lastErrorCode?: string;
  retryAfterMs?: number;
  activeShares: number;
};
```

The manager is lazy-loaded only after an explicit Share or remote-settings
action. `share-routes.ts` may be mounted in local-only mode, but top-level code
must depend only on pure shared contracts. Remote behavior remains behind
dynamic imports to preserve local-only purity.

Credential storage:

- path: `~/.kookr/remote/node-token`;
- permissions: `0600`;
- UI actions: connect, disconnect, rotate, forget credentials;
- explicit errors: `token_missing`, `token_invalid`, `token_unreadable`,
  `relay_rejected_token`, `relay_unreachable`.

### 4. Pairing Trust Boundary - Phase B1

Clicking Share must not become an unauthenticated node-token minting endpoint.

Phase B1 may support self-hosted pairing through one of these authenticated
mechanisms:

1. configured relay admin token on the local machine;
2. owner account login against a hosted relay;
3. short-lived pairing code created from the relay admin console;
4. explicit `KOOKR_RELAY_INSECURE_DEV=1` for local development only.

The RFC rejects anonymous pairing against a public relay. A hosted relay cannot
mint durable node credentials just because an arbitrary local process asks.

### 5. Relay UI Boundary

Separate surfaces:

- relay join page: code/password or invite-token exchange only;
- remote client app: consumes the relay protocol and shared frontend contracts;
- relay server: transport, invitation policy, member tokens, rate limits,
  revocation, audit.

The relay server must not become a second implementation of the Kookr dashboard.
Any task rendering should use shared remote-client components/contracts or a
minimal projection renderer.

### 6. Revocation State Machine

Revocation is a protocol operation, not just a WebSocket close.

State flow:

```text
revoking -> locallyRevoked -> relayAcked -> subscriptionsClosed -> complete
```

Rules:

- The relay remains the sole policy writer.
- The local node owns a `pendingRevokeDenySet` overlay for immediate local
  enforcement while relay policy catches up.
- The local node locally invalidates the grant immediately when the owner clicks
  revoke, even if the relay is unreachable.
- The relay rejects new commands for a revoked grant as soon as it writes the
  revoked tombstone.
- Every command in mutating phases carries `grantId` and `policyVersion`; the
  node rejects stale, expired, locally revoked, or lease-invalid commands.
- Every A0 projection subscription is checked against the local deny overlay and
  relay grant state before each snapshot/delta send. Local revoke synchronously
  invalidates active view subscriptions before relay acknowledgement.
- If relay cleanup fails, Kookr shows `revokePending` and retries until the
  relay acknowledges or the share expires.
- Clients treat disconnect as derived state, not proof of revocation.

Phase A0 does not support mutating commands, but this state machine still
matters for stream/view authorization and later phases.

### 7. Hosted Relay - Phase D

Hosted relay is the eventual product default, not the first implementation
default.

Before `share.kookr.dev` becomes the default, it needs a separate operational
gate:

- deployment owner and environment plan;
- TLS/domain management;
- account/device authentication;
- node pairing auth;
- data retention policy;
- rate-limit and abuse controls;
- emergency disable/maintenance mode;
- metrics and alerts:
  - tickets created/accepted/revoked/expired;
  - accept failures by reason;
  - rate-limit hits;
  - active node/client WebSockets;
  - node heartbeat age;
  - revoke propagation latency;
  - policy sync failures;
  - 5xx rate.

Until those exist, dogfooding uses a custom relay.

### 8. Diagnostics And Audit

Phase A0 records structured local and relay events for:

- invitation/share created;
- accept success/failure;
- revoke requested;
- revoke acknowledged;
- expiry;
- rate-limit lockout.

Fields:

```ts
type ShareAuditEvent = {
  source: 'node' | 'relay' | 'client';
  requestId: string;
  invitationId: string;
  grantId?: string;
  shareIdRedacted?: string;
  nodeIdHash: string;
  actorIdHash?: string;
  grantSet: string[];
  outcome: 'allowed' | 'denied' | 'failed';
  reasonCode?: string;
  remoteAddressHash?: string;
  timestamp: string;
};
```

The relay emits accept/rate-limit/remote-address events. The node emits
projection, local revoke, and deny-overlay events. They share `requestId` and
`invitationId`; neither side pretends to know facts only observed by the other.

Diagnostic bundle, redacted:

- app version;
- relay host;
- connection health state;
- node ID hash;
- redacted share ID;
- ticket/invitation status;
- WebSocket close code;
- last error code;
- observed clock skew if known;
- correlation/request ID;
- last 20 relevant event names, not raw payloads.

No passwords, full join URLs, terminal bytes, prompts, transcripts, or raw paths
are included.

## Migration Plan

### Phase A0: Configured-Relay View-Only Share UI

Precondition: relay already configured through env vars.

Scope:

- Share button on current task.
- Add a node-scoped relay endpoint/operation to create and revoke `view`
  invitations for the same `nodeId`.
- Show share link using URL fragment token delivery, not query-string tokens.
- Show coarse share state: waiting, viewer connected, revoked, expired.
- Revoke invitation.
- Safe task projection only.

Acceptance gates:

- With `KOOKR_RELAY_URL`/`KOOKR_RELAY_TOKEN` already set, owner can create a
  view-only current-task share from the dashboard.
- Second browser can join, see the safe task projection, and disconnect on
  revoke.
- Share creation/revoke endpoints use non-GET methods, strict Origin/Host
  validation, and a local UI nonce/CSRF token; cross-origin browser requests
  cannot create or revoke shares.
- Invite/member tokens are never delivered in query strings; relay responses set
  `Referrer-Policy: no-referrer`; no telemetry runs before fragment scrubbing.
- Existing env-configured relay startup still works.
- With relay unset and Kookr restarted, local-only behavior is unchanged.
- Import-purity check passes: local-only mode does not load remote runtime
  modules beyond pure contracts.
- Rollback gate: disabling the local A0 UI does not leave active shares usable
  beyond expiry, and dogfood relay cleanup/revoke-all is documented.

PR-sized checkpoints:

1. Relay/local backend: node-scoped create/revoke for current-node task shares,
   auth, Origin/CSRF guards, and tests.
2. Projection/subscription: `RemoteTaskProjectionV1`, stream grant checks, coarse
   connected state, revoke/expiry behavior.
3. Dashboard UI/dogfood: Share modal, disabled preconfigured-relay state, browser
   E2E path.

### Phase B: Runtime Relay Connection Manager

Scope:

- Start/stop remote node client at runtime for existing credentials.
- Persist credential status and health state.
- Settings UI for connect/disconnect/forget.

Acceptance gates:

- No duplicate node clients after repeated connect/disconnect.
- Restart with stored credentials reconnects.
- Invalid token produces `authFailed` with redacted diagnostic.
- All Phase A0 share tests pass unchanged under both env-configured startup and
  stored-credential startup.
- Local-only restart after forgetting credentials behaves exactly local-only.

### Phase B1: Safe Pairing For Custom Relays

Scope:

- Authenticated pairing endpoint or configured-admin-token flow.
- Persist new node token with `0600`.
- Rotate/delete token from UI.

Acceptance gates:

- Anonymous pairing against a public relay is impossible.
- Token deletion prevents reconnect.
- Token rotation invalidates the old token.

### Phase C: Share ID / Password

Scope:

- Extend invitations with `shareId`, `passwordVerifier`, attempts, lockout.
- Add join page for ID/password.
- Continue mapping accepted shares to existing member tokens.

Acceptance gates:

- Collaborator joins from another browser with only ID/password.
- Ticket is single-accept by default.
- Failed guesses lock the ticket/rate-limit the source.
- Fragment password is scrubbed with `history.replaceState`.
- Revoke and expiry close active subscriptions.

### Phase D: Hosted Relay

Scope:

- Hosted relay operations and account auth.
- Hosted relay appears as the normal default in Settings.

Acceptance gates:

- Operational gates in "Hosted Relay" are met.
- Maintenance mode produces clear local UI.
- Emergency disable prevents new shares without breaking local Kookr.

### Phase E: Mutating Grants

Scope:

- Terminal input, launch, stop, permission approval.
- Owner confirmation after guest joins.
- Downgrade UI.
- Audit and command revalidation tests.

Acceptance gates:

- A leaked code/password cannot mutate anything before local owner approval.
- Permission approval and launch are blocked when local bypass-all-permissions
  or equivalent unsafe mode is active unless the owner performs a separate
  local-only confirmation.
- Guest comments are untrusted content: sanitized for UI, not injected into
  agent prompts without explicit owner action.

## First Dogfood Run

The first useful dogfood is deliberately not the final TeamViewer UX:

1. Run a custom relay with explicit admin token, client token, and node
   registration. Insecure-dev mode is allowed only on localhost dogfood.
2. Configure one Kookr node with current env vars:
   `KOOKR_RELAY_URL`, `KOOKR_RELAY_TOKEN`, and, if terminal viewing is tested
   later, `KOOKR_RELAY_TRUSTED=true`.
3. Open a current task.
4. Click **Share**.
5. Join from a second browser or phone.
6. Verify `RemoteTaskProjectionV1` and coarse connected state.
7. Revoke.
8. Confirm the second browser disconnects.
9. Unset relay env vars, restart Kookr, and verify local-only behavior.

This answers the product question "does a Share button make collaboration feel
simple?" before investing in hosted relay, runtime pairing, or mutating grants.

## Testing Plan

Phase-specific tests are listed in the migration plan. Cross-cutting tests:

- leaked link second accept is rejected;
- brute-force lockout and unknown-share enumeration throttling;
- stale command or stream subscribe after revoke is rejected;
- relay offline during revoke leaves local grant invalidated and retry pending;
- node/relay clock skew around expiry;
- guest display-name spoofing copy says "unverified guest";
- join URL fragment scrubbing;
- diagnostic bundle redaction;
- cross-origin localhost requests cannot create/revoke shares;
- A0 projection subscriptions stop after local revoke before relay ack;
- member token reconnect semantics match the RFC;
- local-only smoke and import-purity on every phase.

## Alternatives Considered

### Improve Current Setup Documentation

Rejected. Documentation can help dogfooding, but it does not create the desired
product flow.

### Build Full TeamViewer UX In One Phase

Rejected. It combines hosted relay, runtime pairing, code/password tickets,
viewing, mutating grants, audit, and operations. The safer path is to validate
one loop first and remove infrastructure steps incrementally.

### Stable Kookr ID Plus Rotating Password

Deferred. A stable public device ID is useful for unattended access, but it is
more enumerable and implies a long-lived remote-access product. V1 uses
ephemeral shares.

### Magic Link Only

Rejected as the only flow. Links are convenient, but code/password is easier to
read over voice chat or type from another device. The link remains a shortcut.

### Peer-To-Peer WebRTC

Deferred. It may reduce relay visibility into terminal bytes later, but it adds
NAT traversal, ICE/TURN operations, and a second transport before the UX is
proven.

## Open Questions

1. Is Phase A0's safe task projection enough to be useful, or should terminal
   viewing be the second dogfood slice?
2. Should every guest require owner confirmation, even for view-only current
   task shares?
3. What exact wordlist/generator should implement the 40-bit password phrase?
4. Should Phase C allow one accepted guest plus multiple tabs, or exactly one
   WebSocket connection per ticket?

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-16: incorporated. V1 narrowed to configured-relay,
  view-only current-task sharing; mutating grants, hosted relay, runtime
  pairing, project/node scopes, and durable audit UI moved to later phases.
- `failure-mode-analyst` 2026-05-16: incorporated. Added safe projection,
  single-accept default, revocation state machine, share ID redaction, fragment
  scrubbing, brute-force lockout, unverified guest copy, and failure tests.
- `boundary-critic` 2026-05-16: incorporated. Added pairing trust boundary,
  clarified invitation evolution instead of parallel tickets, split relay join
  page from remote client app, and preserved local-only lazy-load boundaries.
- `operability-reviewer` 2026-05-16: incorporated. Added
  `RemoteConnectionHealth`, credential lifecycle, hosted relay operations gate,
  diagnostic bundle, metrics, and revoke-pending behavior.
- `delivery-pragmatist` 2026-05-16: incorporated. Reworked migration into A0/B/B1/C/D/E,
  added per-phase gates, and wrote an explicit first dogfood run.
- Empirical validation checkpoint 2026-05-16: local code inspection confirmed
  existing `InvitationStore` covers hashed tokens, single-use acceptance, member
  tokens, grants, expiry, revocation, and active/revoked policy sync; relay node
  registration is currently admin-token protected; remote node startup is
  currently boot-time `KOOKR_RELAY_URL` based.
- Round 2 2026-05-16: incorporated. Narrowed A0 further to coarse connected
  state, removed activity summary from projection, added
  `RemoteTaskProjectionV1`, node-scoped invitation operation, fragment token
  delivery, CSRF/origin guard, view-subscription revoke checks, explicit
  reconnect semantics, and PR-sized A0 checkpoints. Deferred full diagnostics
  and mutating command revocation requirements to later phases.
