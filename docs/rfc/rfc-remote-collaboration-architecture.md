# RFC: Transport-Neutral Remote Collaboration Architecture

## Status

Draft (v3 - post-round-2 revision)
Date: 2026-05-21
Author: Jean Ibarz (with Codex)

---

## Problem

Kookr already has several pieces of remote collaboration:

- a relay process that routes node, member, projection, terminal, policy, and
  contact-share messages;
- dashboard APIs to create and revoke guest task shares;
- guest-link task projections, share tickets, grant requests, and terminal
  publication gating;
- contact-share contracts for verified contacts, encrypted envelopes, inbox
  items, and native shared tasks;
- a remote command handler that evaluates grants before applying terminal
  input, permission approval, launch, stop-like actions, and task actions;
- self-hosted and hosted relay operational gates.

The missing product architecture is a coherent way to support both:

1. **private trusted collaboration** between Jean and family or friends over
   Tailscale, WireGuard, SSH tunnel, LAN, or corporate VPN; and
2. **commercial/enterprise deployment** where a company may require SSO,
   audit, network policy, self-hosting, hosted relay, or Cloudflare/Tailscale
   style zero-trust access.

The current code and RFCs are relay-centric because the first remote features
needed a rendezvous server and browser guest links. That is not wrong, but it
risks binding the product model to one transport. The product goal is not
"use Tailscale" or "use a public relay." The product goal is:

> A trusted person can view, request, and eventually control a specific Kookr
> task running on another person's machine, with clear owner approval,
> revocation, and audit. The network path should be replaceable.

## Recommendation

Architect toward a transport-neutral collaboration model, but ship it in a
small first slice:

```text
Accepted first slice:
  privateNetwork profile
  verified contact/device pairing
  view-only shared task updates
  dedicated collaboration listener
  no terminal viewing
  no direct control
  no relay migration
  no hosted relay dependency
```

Longer term, self-hosted relay, hosted relay, terminal viewing, proposals, and
direct control should use the same identity/grant concepts. They are not part
of the first implementation slice.

The enduring product model is:

```text
Identity -> Trust -> Share -> Grant -> Projection -> Optional Control -> Audit
```

The replaceable network paths are:

```text
Private mesh / LAN / SSH tunnel / corporate VPN / Cloudflare Access
Self-hosted relay
Hosted Kookr relay
```

## Existing State

### Implemented Building Blocks

**Relay and connection management.** `relay/server.ts` provides node
registration, node WebSocket, member WebSocket, invitation lifecycle, share
tickets, policy sync, contact-share envelope routing, terminal delivery, hosted
relay gates, metrics, and state persistence. `src/server/relay-connection-manager.ts`
adds runtime pairing, stored credentials, hosted pairing, rotate, disconnect,
forget, validation, and local setup diagnosis.

**Guest task sharing.** `src/server/routes/share-routes.ts` exposes local
dashboard routes for guest-link task-share create/list/revoke and grant-request
resolution. It is mounted even in local-only mode and returns
`relay-not-configured` instead of loading the remote runtime.

**Task share service.** `src/server/task-share-service.ts` tracks owner-facing
share state, publishes safe task projections, publishes session projections
only when terminal grants exist, revokes publication scopes on share revoke or
expiry, and installs guest-member terminal publication rules only after an
approved member-scoped terminal request.

**Terminal publication gate.** `src/remote/session-stream-publisher.ts`
subscribes to local backend sessions only when `KOOKR_RELAY_TRUSTED=true`, but
publishes terminal bytes only for metadata returned by
`TerminalPublicationGate`. `src/remote/terminal-publication-gate.ts` requires a
session-bound rule plus fresh demand proof before a terminal byte leaves the
owner node for that principal.

**Contact Share prototype.** `src/shared/contracts/contact-share.ts`,
`src/core/contact-share.ts`, and
`src/server/routes/contact-share-routes.ts` define contacts, device keys,
envelopes, inbox items, accepted shared tasks, and local APIs. The route layer
currently uses placeholder opaque secrets and local read-model mutation; it is
not yet a complete cryptographic contact system or cross-node inbox protocol.

**Remote command guard.** `src/server/remote-command-handler.ts` evaluates
grant IDs against policy cache, task/session subjects, live session state, and
unsafe local permission mode before applying remote commands. This is the
right shape for future control: the owner node remains authoritative even when
a transport routes a command.

**Deployment posture.** `docs/reference/self-hosted-relay-runbook.md` defines
a hardened public VPS relay behind Caddy/TLS. It explicitly says that if the
only remote viewer is the operator, WireGuard, Tailscale, or SSH port
forwarding is preferred because they avoid a public application surface.

### Gaps

1. **Private-network mode lacks product affordances.** A user can use
   Tailscale or SSH tunnels outside Kookr, but Kookr does not make that a
   supported setup profile with diagnostics, pairing, and copyable setup steps.
2. **Contact Share is not yet real identity.** Contacts have public-key-shaped
   fields and verified fingerprints, but pairing, key proof, key rotation,
   envelope encryption/decryption, and remote inbox delivery are not complete.
3. **Shared tasks are read-model local state, not live remote tasks.** Accepted
   Contact Shares can appear as `shared:*` tasks, but they do not yet receive
   continuous remote task updates over a private-network route.
4. **The local server surface is too broad for peer access.** The normal Kookr
   dashboard/server exposes local task, settings, and mutation routes. A
   private-network peer must not get that whole surface just because it can
   reach an IP/port. Empirical check: `src/server/routes.ts` mounts
   diagnostics, settings, task, project, schedule, deploy, contact-share,
   share, relay-connection, and recovery routes on the same app; WebSocket
   upgrades are handled before Hono routing in the HTTP bootstrap path.
5. **Authorization concepts are reusable but not centralized.** Existing
   relay grants and the remote command handler are useful, but Contact Share,
   guest links, and future private-network control need a shared principal,
   subject, grant, tombstone, and decision vocabulary.

## Accepted Implementation Slice

The accepted first implementation slice is deliberately narrow:

### Slice 1A - Profile, Listener, Pairing

1. Add a `privateNetwork` connection profile.
2. Add a dedicated collaboration listener that serves only collaboration
   bootstrap/peer routes.
3. Add one-device manual fingerprint pairing.
4. Persist verified contact/device trust.
5. Add minimal diagnostics, feature flags, rollback, and metadata audit for
   profile/pairing.

### Slice 1B - View-Only Invite/Accept

6. Send and accept a view-only Contact Share invitation over the private
   collaboration listener.
7. Persist `viewTask` grants and revocation tombstones.

### Slice 1C - Shared Task Updates

8. Render accepted remote task updates as native `shared:*` tasks.
9. Add live update transport for safe task projections only.

No Phase 1 work should touch `relay/server.ts`, remote command application,
terminal publication, permission approval, launch, stop, or hosted relay.

## Non-Goals

- No terminal viewing in the first private-network slice.
- No direct terminal input, permission approval, launch, stop, delete, or
  remote workspace mutation.
- No public hosted relay implementation.
- No enterprise SSO implementation.
- No bundled Tailscale, WireGuard, Cloudflare, or VPN agent.
- No replacement for existing guest-link relay sharing.
- No local execution migration of a running agent process from one machine to
  another.

## Requirements

### Phase 1 Product

1. Kookr SHALL expose a `privateNetwork` connection profile.
2. A profile SHALL contain a label, peer URL, network hint, transport-security
   mode, expected peer identity fingerprint, and last health state.
3. Kookr SHALL support "share with verified contact" separately from "create
   guest link."
4. Kookr SHALL render accepted Contact Shares as native but visually distinct
   `shared:*` tasks.
5. Phase 1 diagnostics SHALL explain: not configured, unreachable peer,
   identity mismatch, unverified device, expired share, revoked share,
   audit unavailable, and feature disabled.

### Phase 1 Security

6. Network reachability SHALL NOT imply task authorization.
7. Private-network collaboration MUST use a dedicated collaboration listener
   in Phase 1. The normal dashboard server on `KOOKR_PORT` MUST NOT become the
   peer collaboration surface.
8. The dedicated listener MUST serve only collaboration bootstrap, health,
   inbox, decision, and safe projection routes.
9. Peer traffic MUST NOT reach dashboard, local task mutation, settings,
   filesystem, debug, static frontend, WebSocket terminal, guest-link share,
   relay-connection, deploy, diagnostics, schedule, project, or relay-admin
   routes.
10. Cleartext HTTP is allowed only for loopback endpoints created by an
    explicit SSH tunnel. Non-loopback private-network peers MUST use HTTPS or
    an authenticated secure tunnel. Kookr MUST NOT send pairing secrets,
    grants, terminal data, or commands before peer identity verification
    completes.
11. First-contact pairing bootstrap endpoints MAY be unauthenticated only for
    public-key, nonce, commitment, expiry, and display-label exchange. They
    MUST NOT expose shares, grants, task projections, terminal data, commands,
    local settings, or local task state. All post-pairing peer routes require
    verified device authentication before dispatch.
12. Phase 1 Contact Share SHALL require a persisted device key and manual
    fingerprint verification before a share can be accepted.
13. Phase 1 grants SHALL be limited to `viewTask`.
14. Revocation SHALL stop future projection updates for that share and create
    a persisted tombstone before reporting success.
15. Guest Link and Contact Share grants SHALL remain isolated even when they
    target the same task.

### Phase Gates

16. No phase may ship to users until it has:
    - feature flag;
    - effective configuration/diagnostic inspection;
    - audit event coverage for accepted and denied actions in that phase;
    - rollback procedure;
    - phase-specific tests.
17. Hosted relay support for Contact Share SHALL remain disabled until tenant
    isolation, account scoping, hosted kill switches, rate limits, audit
    export, and support diagnostics are implemented and tested.

## Design

### 1. Private-Network Connection Profile

Add a durable profile model:

```ts
type PrivateNetworkConnectionProfile = {
  schemaVersion: 'private-network-profile.v1';
  profileId: string;
  label: string;
  peerBaseUrl: string;
  networkHint: 'tailscale' | 'wireguard' | 'ssh-tunnel' | 'lan' | 'corp-vpn' | 'other';
  transportSecurity: 'https-required' | 'loopback-tunnel-only' | 'authenticated-secure-tunnel';
  expectedPeerFingerprint?: string;
  lastHealth?: CollaborationProfileHealth;
  createdAt: string;
  updatedAt: string;
};
```

This profile is product/settings state owned by the local server. It does not
provision the network. It tells Kookr where a trusted peer should be reachable
and what security posture is expected.

`peerBaseUrl` points at the dedicated collaboration listener, not the normal
dashboard server. A private-network setup that exposes `KOOKR_PORT` directly
is invalid unless a reverse proxy or tunnel exposes only the dedicated
collaboration listener and denies the normal dashboard/API/WebSocket surface.

The collaboration listener can live in the same Node.js process as Kookr, but
it must use a separate HTTP server/app and port so route isolation is enforced
by construction, not by hoping peers call the right path. It has no static
frontend, no local dashboard API, no terminal WebSocket, and no task mutation
routes.

### 2. Dedicated Collaboration Listener

Add Phase 1 routes on the dedicated listener:

```text
GET  /api/collaboration/health
POST /api/collaboration/pairing/offers
POST /api/collaboration/pairing/accept
POST /api/collaboration/contact-share/invites
POST /api/collaboration/contact-share/decisions
GET  /api/collaboration/shared-task-updates
```

The listener has its own authentication middleware and must not reuse local
dashboard CSRF as the peer security model. CSRF protects a browser-local
dashboard. Peer collaboration needs bootstrap pairing tokens and, after
verification, device signatures.

The listener returns safe DTOs only. It must not expose local task mutation
routes, raw task records, settings, filesystem paths, environment variables,
terminal bytes, debug state, static dashboard assets, WebSocket terminal
routes, or relay admin operations.

Slice 1A acceptance tests must start a normal Kookr server and a collaboration
listener, then prove that the collaboration listener rejects or lacks:

- `POST /api/tasks`;
- `DELETE /api/tasks/:id`;
- `PUT /api/settings`;
- `GET /api/diagnostics/*`;
- `POST /api/share/task`;
- `/ws`;
- `/ws/terminal/*`;
- static dashboard paths.

### 3. Pairing Bootstrap Versus Authenticated Peer Traffic

First-contact pairing is the only unauthenticated collaboration surface.
Bootstrap endpoints may exchange:

- ephemeral pairing ID;
- public identity/device keys;
- nonce/commitment material;
- expiry timestamp;
- display labels rendered as untrusted text.

They must not expose:

- task IDs or task labels;
- shares or grants;
- task projections;
- terminal data;
- commands;
- permission prompts;
- local settings or diagnostics beyond listener health.

After both users manually verify the fingerprint and persist the device,
all non-bootstrap routes require a signed request from the verified device.
Requests from unverified devices return `unverifiedDevice` and do not reach
share/projection handlers.

### 4. Minimal Contact Identity

Phase 1 identity is intentionally small:

```ts
type ContactIdentity = {
  contactId: string;
  displayName: string;
  verifiedFingerprint: string;
  trustState: 'verified' | 'blocked';
  devices: ContactDeviceIdentity[];
};

type ContactDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  label?: string;
  verifiedAt: string;
};
```

Pairing flow:

1. initiator creates a pairing offer with a short expiry;
2. recipient accepts from its own Kookr;
3. both sides show a fingerprint;
4. user verifies the fingerprint out of band;
5. both sides persist the contact/device as verified.

Phase 1 does not need QR code, multi-device rotation UX, or recovery flows.
Those are required before terminal control, but not before view-only dogfood.

Identity storage must be separate from the Contact Share read model. Use a
`ContactIdentityStore` or `DeviceTrustStore`; Contact Share consumes verified
principals from that store and does not own trust state.

Future key rotation rule:

> Device key rotation MUST require a rotation statement signed by the previous
> device key and the new device key. If the previous key is unavailable,
> recovery creates a new unverified device/contact path. Active grants and
> terminal publication rules for a rotated device are suspended until
> reverified.

### 5. Phase 1 Share And Grant Model

Phase 1 supports one grant:

```ts
type Phase1CollaborationGrant = 'viewTask';
```

Persist grants as records, not just capability strings:

```ts
type CollaborationPrincipal =
  | { kind: 'contact-device'; contactId: string; deviceId: string };

type CollaborationSubject =
  | { kind: 'task'; taskId: string };

type CollaborationGrantRecord = {
  grantId: string;
  principal: CollaborationPrincipal;
  subject: CollaborationSubject;
  capabilities: Phase1CollaborationGrant[];
  policyVersion: number;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
};
```

Authorization evaluates exactly one authenticated principal at a time. It must
not union grants across guest links, contacts, devices, or transports. UI may
show overlapping shares, but the grant evaluator keeps them separate.

Guest-link principals, session subjects, terminal grants, and command grants
remain future/relay concerns. Future control capabilities such as
`viewTerminal`, `sendTerminalInput`, `approvePermission`,
`launchFromTemplate`, and `stopTask` remain deferred. When they are added,
every command must carry the grant ID, capability, session epoch, and policy
version it was authorized under.

### 6. Revocation And Ordering

Revocation is an ordering boundary, not only a UI state.

For Phase 1:

- revocation writes a durable tombstone with the next `policyVersion`;
- projection publishing checks the tombstone before sending every update;
- accepting a share after tombstone or expiry is denied;
- restarted nodes load tombstones before resuming collaboration routes.

For future control:

- every command must carry `grantId`, capability, `sessionEpoch`, and
  `policyVersion`;
- the owner node must re-check that tuple at the final write boundary
  immediately before side effects;
- commands racing with or following a revocation tombstone are denied, even if
  previously accepted by a transport or relay.

### 7. Envelope Replay And Idempotency

Every collaboration envelope must include:

```ts
type CollaborationEnvelopeHeader = {
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  contactId: string;
  shareId?: string;
  grantId?: string;
  issuedAt: string;
  expiresAt: string;
  senderSequence: number;
  nonce: string;
  policyVersion?: number;
};
```

Owner and recipient nodes persist recently seen message IDs/sequences and
reject stale, duplicate, expired, wrong-recipient, or downgraded-policy
envelopes. This is required even for private-network mode because a trusted
network path does not protect against buggy clients, replay from local storage,
or future relay inbox delivery.

### 8. Decision-Only Authorizer

Do not introduce a god service.

Phase 1 adds a narrow `ContactShareAuthorizer` or
`CollaborationAuthorizer` that returns decisions for pairing, share creation,
share acceptance, projection reads, and share revocation.

It does not own transport, contacts, share storage, audit writing, terminal
publication, or command application. Effectful services call it before
mutating state.

Future decomposition:

- `ContactIdentityStore` / `DeviceTrustStore`;
- `ShareStore`;
- `GrantLedger`;
- `EnterprisePolicyEvaluator`;
- `TerminalPublicationCoordinator`;
- `CommandApplicationService`;
- `CollaborationAuditLog`.

Before any new contact-control capability ships, every mutation apply path,
including legacy relay messages, must call the shared authorizer/policy path.
Translation adapters deny unknown grants, missing policy version, missing
session epoch, or unmapped principals. Compatibility tests must prove legacy
relay commands and private-network commands produce identical authorization
decisions for the same principal/subject/capability.

### 9. Minimal Phase 1 Audit

Phase 1 audit is local, metadata-only, and debugging-oriented:

```ts
type CollaborationAuditEvent = {
  schemaVersion: 'collaboration-audit.v1';
  auditEventId: string;
  ts: string;
  ownerNodeId: string;
  actor: CollaborationPrincipal | { kind: 'local-owner' };
  profileId?: string;
  transportKind: 'privateNetwork' | 'selfHostedRelay' | 'hostedRelay' | 'local';
  event:
    | 'contact.paired'
    | 'share.sent'
    | 'share.accepted'
    | 'share.refused'
    | 'share.revoked'
    | 'peer.disconnected'
    | 'policy.denied';
  taskId?: string;
  shareId?: string;
  grantId?: string;
  policyVersion?: number;
  decision?: 'allowed' | 'denied';
  reason?: string;
};
```

Audit events use an allowlisted schema with opaque task/session/share IDs by
default. Human-readable task names, prompts, command text, peer URLs,
environment values, and error payloads are redacted or separately opt-in.

Enterprise audit hardening is future work: append-only rotation, integrity
chaining/signing, export, retention policy, and fail-closed behavior when
`requireAuditLog=true`.

### 10. Diagnostics Contract

Phase 1 diagnostics produce a single profile health view:

```ts
type CollaborationProfileHealth =
  | { state: 'notConfigured' }
  | { state: 'disabled'; reason: string }
  | { state: 'unreachable'; checkedAt: string; detail?: string }
  | { state: 'identityMismatch'; checkedAt: string }
  | { state: 'unverifiedDevice'; checkedAt: string }
  | { state: 'auditUnavailable'; checkedAt: string }
  | { state: 'ok'; checkedAt: string; peerNodeLabel?: string };
```

Checks:

- peer reachability;
- expected fingerprint match;
- active feature flag;
- route allowlist/auth middleware enabled;
- audit append works;
- clock skew below a configured threshold;
- last successful envelope timestamp.

Future relay diagnostics may add `relayDisconnected`, `policyBlocked`,
`tenantDisabled`, `hostedRelayUnavailable`, and `terminalGateMissing`.

### 11. Feature Flags And Rollback

Phase flags:

```text
collaboration.profiles
collaboration.listener
collaboration.privateNetwork
collaboration.contactShareViewOnly
collaboration.terminalView        # future
collaboration.proposals           # future
collaboration.directControl       # future
collaboration.hostedRelay         # future
```

Rollback for Phase 1:

1. disable `collaboration.privateNetwork` or
   `collaboration.contactShareViewOnly`;
2. reject new `/api/collaboration/*` requests except health/status;
3. stop background peer subscriptions;
4. preserve stored profiles, contacts, grants, tombstones, and audit;
5. mark shared tasks unavailable rather than deleting them;
6. leave existing guest-link relay behavior unchanged.

## Future Work

### Self-Hosted Relay Adapter

Relay-backed Contact Share should eventually use the same principal, grant,
envelope replay, and audit concepts. Runtime transport adapters should live
under `src/remote/`, not own product profiles, and not evaluate grants.
Product profiles remain server/settings state.

Do not extract a generic `CollaborationTransport` interface until there are at
least two real implementations sharing call sites. Phase 1 can use explicit
private-network client/server calls.

### Hosted Relay

Hosted relay remains disabled until:

- tenant isolation is tested;
- account scoping exists;
- hosted kill switches exist;
- rate limits exist;
- metadata audit export exists;
- support diagnostics exist;
- incident response posture is documented.

### Terminal Viewing

Terminal viewing for verified contacts requires:

- contact-device demand proofs;
- owner approval per task/session by default;
- terminal frames encrypted to recipient device keys;
- live-only delivery first;
- no replay unless separately approved;
- fresh demand proof after owner restart.

### Proposal-Based Collaboration

Before direct control, add non-mutating owner-reviewed proposals:

- input proposal;
- attention marker;
- stop request;
- permission deny suggestion;
- annotation/comment.

Owner applies or rejects proposals locally. Guest links may participate only
after abuse controls and size/rate limits.

### Direct Control

Direct control is Contact Share only and future-gated:

- direct terminal input requires explicit owner grant;
- direct input uses leases, pause/kill switch, per-session approval, and
  revocation-at-write-boundary tests;
- permission deny may ship before permission approve;
- permission approve requires prompt binding and provider-specific safety;
- arbitrary remote launch remains out of scope until launch templates and
  budget caps exist.

### Enterprise Policy

Enterprise policy is future work, but must have lifecycle semantics before it
ships:

```ts
type CollaborationPolicy = {
  schemaVersion: 'collaboration-policy.v1';
  policyId: string;
  issuer: string;
  version: number;
  issuedAt: string;
  expiresAt?: string;
  signature?: string;
  source: 'local' | 'managed';
  enforcementMode: 'failClosed' | 'localOverrideAllowed';
  guestLinks: 'disabled' | 'viewOnly' | 'terminalViewWithOwnerApproval';
  contactShare: 'disabled' | 'viewOnly' | 'terminalView' | 'controlledActions';
  directTerminalInput: 'disabled' | 'ownerApprovedPerSession' | 'trustedContacts';
  permissionApproval: 'disabled' | 'denyOnly' | 'ownerApprovedPerPrompt' | 'trustedContacts';
  allowedTransports: Array<'privateNetwork' | 'selfHostedRelay' | 'hostedRelay'>;
  requireVerifiedContactForControl: boolean;
  requireAuditLog: boolean;
};
```

When enterprise policy is configured, collaboration features fail closed if
policy cannot be loaded, verified, or audited. Local user config may further
restrict enterprise policy but must not relax it.

## Phase 1 Files To Change

Likely new files:

- `src/shared/contracts/collaboration-profile.ts`
- `src/shared/contracts/collaboration-audit.ts`
- `src/server/collaboration-profile-store.ts`
- `src/server/contact-identity-store.ts`
- `src/server/contact-share-authorizer.ts`
- `src/server/collaboration-audit-log.ts`
- `src/server/collaboration-listener.ts`
- `src/server/routes/collaboration-routes.ts`
- `src/server/routes/collaboration-settings-routes.ts`

Likely changed files:

- `src/server/index.ts`
- `src/server/routes.ts`
- `src/server/bootstrap/start-http-and-websockets.ts`
- `src/shared/contracts/contact-share.ts`
- `src/core/contact-share.ts`
- `src/server/routes/contact-share-routes.ts`
- `src/frontend/components/SettingsDialog.tsx`
- `src/frontend/components/TaskShareModal.tsx`
- shared-task frontend rendering surfaces

Explicitly out of Phase 1:

- `relay/server.ts`
- `src/server/remote-command-handler.ts`
- `src/remote/session-stream-publisher.ts`
- `src/remote/terminal-publication-gate.ts`
- hosted relay operations
- permission approval and launch code

## Test Plan

Slice 1A tests:

- local-only mode does not load remote runtime modules;
- collaboration listener does not start when the feature flag is disabled;
- collaboration listener lacks dashboard/task/settings/debug/share/static
  frontend/WebSocket routes;
- normal dashboard server is not used as `peerBaseUrl`;
- bootstrap pairing endpoints exchange only public keys, nonces, commitments,
  expiry, and display labels;
- post-pairing routes reject requests without verified device signatures
  before handler dispatch;
- loopback HTTP is accepted only for explicit tunnel mode;
- non-loopback cleartext profile is rejected unless carried by an authenticated
  secure tunnel mode;
- pairing persists contact/device trust and expected fingerprint;
- identity mismatch blocks share acceptance;

Slice 1B tests:

- view-only share sends and accepts;
- revocation tombstone blocks future projection updates;
- guest-link and Contact Share grants do not union;
- audit append failure surfaces `auditUnavailable`;

Slice 1C tests:

- accepted share renders as `shared:*`;
- two local Kookr servers exchange safe task projections through collaboration
  listener only, with no relay runtime loaded;
- shared-task updates stop after expiry or revocation;
- rollback disables new peer requests but preserves stored state.

Future control tests:

- every command action maps to exactly one capability;
- every command re-checks grant ID, session epoch, policy version, and
  tombstone at final write boundary;
- owner restart invalidates terminal publication and direct-control leases;
- stale, duplicate, expired, wrong-recipient, and downgraded-policy envelopes
  are rejected.

## Alternatives Considered

### Pick Tailscale Only

Rejected. It is the right dogfood path, but enterprises may already use
Cloudflare, Zscaler, corporate VPN, or self-hosted relay. Kookr should not
force one network vendor.

### Pick Hosted Relay Only

Rejected. This gives the cleanest onboarding but makes Kookr Cloud part of the
trust boundary before the product has proven its collaboration model. It also
blocks privacy-sensitive users and enterprises that require customer-controlled
infrastructure.

### Keep Guest Links As The Main Model

Rejected. Guest links are useful, but they are lower assurance and browser
based. The family/friends and enterprise goals both need durable identities,
verified devices, native shared tasks, and eventual controlled actions.

### Build The Generic Transport Abstraction First

Rejected for Phase 1. It is likely useful after private-network and relay
Contact Share both exist. Before that, it risks abstraction without evidence.

### Use The Whole Local Kookr Server As The Peer API

Rejected. Private-network reachability must not expose dashboard, settings,
local mutation, filesystem, debug, or relay-admin routes. Phase 1 uses only a
narrow authenticated `/api/collaboration/*` route group.

## Edge Cases

- A private-network peer URL changes after Tailscale re-auth or machine
  rebuild.
- Two contacts share the same display name.
- A contact rotates or loses a device key while a share is active.
- A shared task expires while the recipient is viewing it.
- Owner revokes while a projection update is in flight.
- Private-network connection is reachable but the peer's Kookr identity key no
  longer matches.
- Guest link and Contact Share point to the same task with different grants.
- A shared task ID accidentally reaches a local task mutation route.
- Owner node restarts and must reload grant tombstones before serving peer
  routes.
- Recipient accepts a share after the owner task completed or was deleted.
- Multiple devices for the same contact exist after future multi-device work.

## Open Questions

1. Is manual fingerprint verification sufficient for Phase 1 dogfood, or
   should the first implementation include QR code pairing?
2. Should Kookr generate its identity key at first startup, or only when
   Sharing is enabled?
3. What retention period should Phase 1 audit use before enterprise policy
   exists?
4. Which network hints should the UI show first: Tailscale, SSH tunnel, and
   custom URL only, or also WireGuard/LAN/corporate VPN?
5. Should shared-task updates use server-sent events or WebSocket in Phase 1?

## Critic Feedback Incorporated

- Round 1 boundary critic: made private-network peer access a narrow
  `/api/collaboration/*` route boundary, moved runtime transport abstraction
  out of Phase 1, separated identity storage from Contact Share read state,
  and replaced the god service with decision-only authorizer plus effectful
  stores/services.
- Round 1 failure-mode analyst: added cleartext transport limits, revocation
  tombstones and final write-boundary rules, envelope replay/idempotency
  requirements, key-rotation safety rules, principal-isolated grant records,
  and future enterprise policy provenance/fail-closed semantics.
- Round 1 design minimalist: narrowed the accepted implementation slice to
  private-network, verified-contact, view-only sharing; moved relay adapter,
  terminal view, proposals, direct control, and enterprise hardening to future
  work.
- Round 1 operability reviewer: moved minimum diagnostics, audit, feature
  flags, rollback, durable state, and tests into Phase 1; kept hosted relay
  disabled until tenant isolation and operational gates are implemented.
- Round 2 boundary/failure-mode critic: replaced the normal-server route-group
  recommendation with a dedicated collaboration listener, and separated
  unauthenticated first-contact bootstrap from verified-device peer traffic.
- Round 2 delivery/minimalist critic: split the first implementation into
  1A profile/listener/pairing, 1B view-only invite/accept, and 1C live shared
  task updates; narrowed Phase 1 grant/principal/subject types to
  contact-device + task + `viewTask`.
