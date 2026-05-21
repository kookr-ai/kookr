# RFC: Contact Share Relay Adapter Evaluation

## Status

Draft (v2 - post-round-1 revision)
Date: 2026-05-21
Author: Jean Ibarz (with Codex)

---

## Problem

Private-network Contact Share now has enough of the product model to be useful:
verified contact/device pairing, a dedicated collaboration listener, view-only
share invites, grants, revocation tombstones, safe task projections, and local
metadata audit. The next tempting step is to move Contact Share onto a relay so
two Kookr users do not need Tailscale, WireGuard, LAN reachability, or an SSH
tunnel.

That migration should not start by wiring the existing private-network routes
through `relay/server.ts`. Contact Share has a different trust shape from
Guest Link:

- Contact Share is identity-bearing Kookr-to-Kookr collaboration.
- Invite, decision, projection, and future terminal/control metadata should be
  encrypted to verified devices.
- The owner node remains authoritative for Contact Share grants, revocation,
  projection publication, and future command side effects.
- The relay or tunnel should route envelopes, not become the product owner.

Issue #544 asks for the relay-adapter evaluation after the private-network
slices, before implementation. This RFC records that evaluation and defines
the gates a future relay-backed path must satisfy before code migration starts.

## Recommendation

Do **not** migrate Contact Share to a hosted or self-hosted relay yet. Keep the
current private-network Contact Share path as the production dogfood path until
its view-only behavior is proven with real users and route-surface isolation.

Prepare for a relay-backed path by documenting transport-neutral envelope,
ledger, health, replay, and rollback requirements. Do **not** extract a runtime
`TransportAdapter` interface yet. Extract shared message/ledger contracts
first; introduce a runtime adapter only when the private-network path and a
relay-backed mailbox have a real shared call site.

The first relay-backed implementation should target **self-hosted relay**.
Hosted relay support is a separate epic, not a later flag flip in the same PR
series.

Recommended sequence:

1. Stabilize private-network Contact Share.
2. Extract transport-neutral message and ledger vocabulary for invite,
   decision, revocation, projection update/removal, delivery receipt, health,
   replay rejection, and adapter failure reasons.
3. Add local durable outbox/inbox processing and replay defense above any
   transport.
4. Prove the private-network path still behaves the same through parity tests.
5. Add a self-hosted relay encrypted mailbox.
6. Add a self-hosted relay client at the envelope exchange boundary.
7. Promote hosted relay only after hosted account, tenant, kill-switch, rate
   limit, audit-export, synthetic-probe, and incident-response gates exist.

## Requirements

### Product

1. Contact Share SHALL keep the same product model across transports:
   verified contact/device -> share invite -> explicit decision -> grant ->
   safe projection -> revocation/audit.
2. Relay-backed Contact Share SHALL appear as native `shared:*` tasks, not as
   browser guest links.
3. Private-network sharing SHALL remain supported after a relay-backed path
   ships.
4. The owner and recipient UIs SHALL explain transport-specific blocked states:
   peer unreachable, route surface unsafe, relay disconnected, capability
   missing, mailbox unavailable, envelope expired, policy blocked, tenant
   disabled, hosted relay unavailable, rate limited, clock skew, and kill
   switch active.

### Security

5. Network reachability SHALL NOT imply authorization.
6. Contact Share relay traffic SHALL use verified device identity before any
   share, grant, projection, terminal, or command content is accepted.
7. Relay-backed Contact Share SHALL use encrypted envelopes. The relay MAY see
   sensitive routing metadata required for delivery, but MUST NOT see task
   labels, prompts, terminal bytes, command text, grant decisions, or plaintext
   share contents.
8. Relay-visible routing metadata SHALL be minimized and treated as sensitive:
   prefer opaque relay routing IDs over stable contact/device IDs, redact logs,
   bound retention, and expose support-safe correlation IDs instead of raw
   identifiers.
9. Every envelope SHALL include replay-defense fields: message ID, sender
   route identity, recipient route identity, issued-at, expires-at, nonce, and
   policy version or ledger epoch when applicable.
10. Owner and recipient nodes SHALL persist enough message history to reject
    duplicate, stale, expired, wrong-recipient, and downgraded-policy
    envelopes.
11. Revocation tombstones SHALL be checked before every projection update and
    before every future terminal/control side effect, independent of transport.
12. Guest Link and Contact Share grants SHALL remain isolated even when the
    same relay carries both.
13. The first relay-backed Contact Share adapter SHALL advertise only the
    transport-visible Contact Share mailbox capability and schema versions it
    supports. The relay enforces schema/capability allowlists, size, expiry,
    quota, and routing constraints only; it does not inspect encrypted payload
    kinds. The node rejects terminal/control payload kinds after decrypting and
    validating the envelope. Terminal/control routing remains blocked until
    session epoch binding, demand proof, node-side publication gates, and
    command-side authorization tests exist.

### Operational

14. A relay-backed path SHALL degrade collaboration only. Local Kookr tasks,
    terminal input, and local dashboard behavior remain available when the
    relay is offline.
15. Relay-backed Contact Share SHALL be feature-flagged separately from
    private-network Contact Share and Guest Link sharing. The self-hosted flag
    defaults off.
16. Rollback SHALL stop new relay-backed shares, choose an explicit traffic
    mode for receive/ack/revocation handling, pause or drain outbound retry
    queues according to mode, preserve local contacts, grants, tombstones,
    queues, cursors, and audit, keep private-network sharing available, and
    leave guest-link behavior unchanged.
17. Hosted relay SHALL remain disabled for Contact Share until account scoping,
    tenant isolation, hosted kill switches, rate limits, metadata audit export,
    support diagnostics, synthetic probes, and incident-response posture are
    implemented and tested.

## No-Go Gates Before Relay Work

No relay-backed Contact Share implementation should start until the
private-network baseline passes these gates:

- two real Kookr nodes, with separate profiles, complete invite, accept,
  projection update, revoke, expiry, duplicate delivery, and fresh restart on
  both sides;
- collaboration listener route-surface tests prove peers cannot reach
  dashboard routes, local task mutation, settings, filesystem/debug surfaces,
  diagnostics, deploy routes, static frontend assets, normal WebSocket routes,
  terminal WebSocket routes, guest-link share routes, relay-connection routes,
  or relay admin operations;
- local-only restart remains unchanged with all collaboration flags disabled;
- unverified devices cannot accept shares or receive projections;
- revoked grants cannot be resurrected by delayed accept, delayed projection
  update, restart, or replay;
- `shared:*` tasks are rejected by all local mutation paths;
- diagnostics cover unreachable peer, identity mismatch, unverified device,
  expired share, revoked share, audit unavailable, feature disabled, and route
  surface unsafe;
- metadata audit explains accepted and denied actions without task labels,
  prompts, terminal bytes, command text, tokens, raw peer URLs, or plaintext
  envelope payloads;
- rollback preserves contacts, grants, tombstones, queues, cursors, and audit.

## Message Requirements

The stable abstraction is the envelope and ledger vocabulary, not a large
transport class hierarchy. A future relay-backed path should first define
contracts for:

- envelope header;
- encrypted payload families: invite, decision, revocation, projection update,
  and projection removal;
- delivery receipt with a support-safe correlation ID;
- transport health vocabulary;
- replay rejection reason;
- adapter failure reason;
- local inbox/outbox processing state.

Do not freeze route names or a runtime adapter method set in this evaluation
RFC. A future implementation may expose direct peer delivery and relay-mailbox
delivery through different code paths until there is evidence that a shared
runtime interface removes real duplication.

The cryptographic boundary is:

- a collaboration message codec or crypto service above transport performs
  encryption and decryption;
- adapters receive ciphertext and routing metadata only;
- relays receive ciphertext and routing metadata only;
- Contact Share domain services receive plaintext payloads only after identity,
  recipient, replay, expiry, and policy-version checks pass.

Use one cryptographic envelope format: plaintext routing header, authenticated
associated data, encrypted payload. If projection updates need a per-share
stream key, decide that before implementation rather than layering ad hoc
`projectionCiphertext` inside an already encrypted envelope.

## Ownership Boundaries

### Contact Share Grant Authority

The owner node owns Contact Share grant authority:

- contact/device trust;
- share creation and revocation;
- Contact Share grant ledger and policy version or ledger epoch;
- task projection generation;
- local audit append;
- final authorization at every side-effect boundary.

The recipient node owns:

- recipient-side contact trust;
- accept/decline decisions;
- inbox state and shared-task read model;
- duplicate/replay rejection;
- local audit append;
- rendering shared tasks as remote-owned, not local mutable tasks.

### Guest Link Compatibility Boundary

Guest Link remains a separate relay-owned policy model. Existing guest-link
invitation, member, and policy storage must not become Contact Share authority
just because both use relay infrastructure. A future relay-backed Contact
Share implementation must keep separate principal namespaces, grant namespaces,
audit event types, and route authorization.

### Transport Boundary

The transport layer owns:

- reaching a direct peer or relay mailbox;
- normalized health and delivery errors;
- transport credentials needed to reach that route;
- remote mailbox acknowledgement or deletion after local durable processing;
- no local retry scheduling, no local inbox durability, no grant semantics, no
  tunnel deployment policy.

The local node owns durable retry lifecycle:

- outbox persistence;
- scheduling, backoff, jitter, and max age;
- cursor/checkpoint persistence;
- crash recovery;
- deciding when an envelope is durably processed and safe to acknowledge.

### Relay Boundary

The relay may validate node identity, tenant/account membership, message size,
expiry, addressability, cursor authorization, rate limits, mailbox quotas, and
retention. It must not validate contact trust, grant existence, invite state,
task authorization, policy-version semantics, or revocation beyond mailbox
retention/deletion rules.

## Retry, Replay, And Processing

The retry and replay model is local-node owned:

- outbound envelopes are durably queued before any transport send;
- retries use exponential backoff with jitter and a bounded max age no later
  than `expiresAt`;
- duplicate delivery is expected and harmless because the recipient rejects
  repeated messages and stale ledger epochs;
- a relay restart or offline tunnel may delay delivery, but must not cause a
  grant to resurrect after a tombstone;
- replay retention must be at least max envelope TTL plus relay retention plus
  clock-skew allowance, unless a key or device epoch invalidates old envelopes
  sooner.

Inbound processing needs an explicit state machine:

```text
received -> validated -> applied -> remotely-acked
```

Local durable state moves first. Remote mailbox acknowledgement happens only
after the inbox/read model/audit/tombstone effects are durably applied. Crash
recovery tests must cover crashes after each transition: a crash after apply
but before ack may redeliver but must not duplicate side effects; a crash
before apply must not lose the envelope.

Sequence and priority rules:

- sequence numbers must be scoped to a stream that avoids cross-share
  head-of-line blocking, or revocation must bypass normal projection ordering;
- revocation is a high-priority, collapseable control envelope and is retried
  ahead of projection updates;
- queued projection updates that arrive before a revocation must not render
  after the tombstone is known.

Device revocation increments a contact/device epoch, invalidates outbound
queues targeting the revoked device, and forces future invites/projections to
target only current verified devices. Relay mailbox fetch, stream,
acknowledgement credentials, route identities, and durable cursors must be
bound to the same device epoch so a stale device cannot keep fetching or
acknowledging already-addressed mailbox contents after revocation or
credential rotation.

## Health, Diagnostics, And Metrics

Use a concrete health vocabulary before implementation:

```text
ok
disabled
misconfigured
authFailed
capabilityMissing
relayOffline
mailboxUnavailable
storageDegraded
backlogHigh
rateLimited
clockSkew
tenantDisabled
killSwitchActive
routeSurfaceUnsafe
```

Health reports should include `checkedAt`, transport kind, relay origin when
applicable, capability version, last successful receive time, and backlog count
or age. Diagnostics must separate owner UI, recipient UI, relay operator view,
and support-safe export. All diagnostic surfaces use correlation IDs and
metadata-only reasons, not plaintext labels, prompts, invite contents, tokens,
raw device IDs, terminal bytes, command text, or decrypted payloads.

Contact Share mailbox metrics:

- envelopes accepted, delivered, acked, expired, purged, and rejected by
  reason;
- per-recipient backlog age;
- retry queue depth;
- receive cursor lag;
- ack latency;
- storage write failures;
- schema/capability rejection counts;
- rate-limit and quota rejection counts.

## Transport Comparison

| Transport | Strengths | Weaknesses | Recommendation |
|---|---|---|---|
| Cloudflare Tunnel / Access | Good enterprise fit, HTTPS and identity policy can be delegated to an existing provider, no inbound port on owner machine. | Adds a third-party control plane, provider-specific diagnostics, and policy drift outside Kookr. It still exposes a peer HTTP surface unless Kookr keeps the dedicated listener narrow. | Support as a private-network setup posture first. Do not make it the canonical Contact Share transport. |
| SSH tunnel | Minimal infrastructure, strong for one-off trusted peers, loopback HTTP can be acceptable through the tunnel. | Poor product UX for non-technical recipients, brittle reconnect, no built-in inbox/push semantics, hard to support commercially. | Keep as a supported private-network setup, not a relay-adapter target. |
| Self-hosted relay | Best next relay step for privacy-sensitive users and for testing relay semantics without hosted multi-tenant risk. Can reuse the hardened relay runbook and state persistence. | User operates TLS, process health, backups, upgrades, and incident response. Support burden moves to diagnostics/runbook quality. | First relay adapter target after private-network stabilizes. Require encrypted inbox, replay defense, capability checks, persistence, and posture checks. |
| Hosted Kookr relay | Best eventual product UX: no network setup, inbox delivery can work across NAT, support can diagnose server-side failures. | Highest security and operational burden: tenant isolation, abuse controls, kill switches, audit export, account scoping, support access, and incident response must be correct before contact metadata routes through it. | Separate future epic. Enable only after hosted relay gates are implemented and tested. |

## Implementation Order

This is the recommended PR order after the no-go gates pass.

### 1. Contracts-Only PR

Add envelope header, encrypted payload-family contracts, delivery receipt,
transport health enum, replay rejection reason, and adapter failure reason. No
runtime adapter. No `relay/server.ts` change.

Acceptance tests: schema validation, unknown payload deny, unknown schema deny,
policy-version downgrade deny, and header/payload binding tamper rejection.

### 2. Local Durable Queue And Replay PR

Add outbound queue, inbound processing state, seen-message store, stream or
epoch tracking, tombstone-aware rejection, and durable cursor/checkpoint
storage.

Acceptance tests: duplicate message, out-of-order projection plus later
revocation, expired envelope, wrong recipient, stale policy, crash after each
inbox transition, restart reload, and replay after retention pruning.

### 3. Private-Network Parity PR

Use the shared envelope/ledger vocabulary for private-network delivery while
keeping the listener explicit.

Acceptance tests: all private-network gates, local-only smoke, and contract
tests that run the same invite/decision/revoke/projection cases against the
old explicit path and the new shared vocabulary.

### 4. Relay Mailbox Server PR

Add encrypted mailbox submit, fetch or stream, and acknowledgement behavior to
the self-hosted relay. Route names are intentionally deferred to that PR. The
relay validates only routing/operational metadata and never parses plaintext
payload semantics.

Acceptance tests: persisted mailbox envelopes, acknowledgements, node routing
identity, rate-limit counters, retention metadata, bounded retention,
ack-idempotency, recipient isolation, cursor authorization, quota enforcement,
and restart survival. This PR depends on the relay persistence and hardening
work from `rfc-self-hosted-public-relay.md`.

### 5. Self-Hosted Relay Client PR

Add the first actual relay-backed client at the envelope exchange boundary.
Feature flag: `collaboration.selfHostedRelayContactShare`, default off. Do not
add hosted feature flags, hosted UI affordances, or a hosted default path in
this PR series.

Before enabling, the node verifies relay capabilities: Contact Share mailbox,
envelope schema version, max envelope size, retention policy, ack support, and
self-hosted/hosted mode. It must fail closed with `capabilityMissing` rather
than entering a reconnect loop.

Acceptance tests: private-network and relay-backed contract parity, relay
offline degradation, rollback modes preserve revocation/tombstone/ack handling
unless full isolation is explicitly selected, rollback disables selected
receive loops and retry sends without damaging contacts/grants/tombstones/
queues/audit, relay backup/restore does not resurrect access, and diagnostic
output remains payload-free.

### 6. Diagnostics And Rollback PR

Surface the health states and metrics above. Add metadata-only debug export,
relay-operator lookup by support-safe correlation ID, and a documented rollback
drill.

Rollback modes:

- `disable-new`: reject new relay-backed shares but keep existing receive/ack
  and revocation flows active;
- `drain-existing`: stop new sends, process pending inbound envelopes, and
  continue revocation/ack traffic;
- `purge-relay-mailbox`: delete relay mailbox state for a node or tenant after
  local tombstones are durable;
- `freeze-shared-tasks`: mark relay-backed shared tasks as transport-disabled
  rather than revoked;
- `isolate`: stop all relay traffic immediately. This mode is reserved for
  suspected compromise and must surface that stale remote views may persist
  until local tombstones or mailbox purge evidence is available.

Invariant: revocation, tombstone, and acknowledgement handling remains
available in every rollback mode except `isolate`. If a mode disables those
flows, it must document stale-access consequences and the evidence needed
before re-enable.

## Hosted Relay Promotion Gates

Hosted relay Contact Share is a separate future epic. It remains unavailable
until all of these are true:

- each node registration is scoped to an account/tenant;
- contacts cannot route envelopes across tenants unless policy permits it;
- support diagnostics expose only metadata necessary to debug delivery;
- Contact Share kill switches exist globally, per tenant, per node, and per
  contact/device;
- maintenance mode can stop new shares while allowing revocation and ack flows;
- abuse/rate limits, mailbox quotas, cursor authorization, and retry
  amplification controls are enforced and visible;
- audit export can prove who had access to which share metadata without
  payload plaintext;
- incident-response procedures cover compromised node credential, suspected
  cross-tenant route, relay DB corruption, envelope backlog surge, abusive
  sender, leaked routing metadata, bad deploy/protocol mismatch, tenant
  disable, Contact Share global disable, and retention purge;
- hosted synthetic probes cover invite, accept, projection update, revocation,
  envelope expiry, rate limit, tenant kill switch, cross-tenant denial, and
  rollback.

## Edge Cases

- **Duplicate invite delivery:** recipient accepts once; later duplicate
  delivery is acknowledged as already processed and audited as duplicate.
- **Decision races revocation:** owner tombstone wins. A late accept is denied
  even if the transport delivered the invite before revocation.
- **Relay restart:** unexpired encrypted envelopes survive restart on
  self-hosted/hosted relay; private-network transport has no mailbox and uses
  the sender retry queue when reachable.
- **Relay restore:** duplicate delivery after restore is acceptable; missing
  unacked envelopes require sender retry; revocation tombstones remain
  authoritative on nodes; restore must not resurrect access.
- **Device revocation:** queued envelopes to a revoked device are invalidated
  by contact/device epoch and are no longer encrypted to that device. Mailbox
  fetch, stream, acknowledgement, route identity, and cursor authority reject
  stale device epochs after revocation or credential rotation.
- **Mixed versions:** node and relay negotiate Contact Share mailbox
  capability, schema version, max message size, retention, and ack semantics;
  old-relay/new-node and new-relay/old-node diagnostics must report
  `capabilityMissing` or `unsupportedVersion`, not generic disconnect.
- **Transport downgrade:** enterprise or profile policy may allow private
  network but forbid hosted relay. Transport health must never become
  authorization state, and adapters must not relax configured policy.

## Alternatives Considered

### Start With Hosted Relay

Rejected for now. It gives the best end-user setup story, but it couples the
first relay-backed Contact Share implementation to multi-tenant isolation,
support access, abuse controls, hosted kill switches, and incident response.
Those are product-critical but not needed to validate the adapter protocol.

### Start With Self-Hosted Relay

Accepted as the first relay adapter target after private-network stabilizes.
It exercises mailbox, retry, replay, encrypted-envelope, and relay-restart
semantics while keeping tenant scope under one operator.

### Treat Cloudflare Tunnel As The Adapter

Rejected as the canonical adapter. Cloudflare is useful deployment posture, but
it is not a Kookr collaboration transport. Kookr still needs device identity,
grant ledgers, revocation, replay defense, and audit above the tunnel.

### Keep Only SSH Tunnels

Rejected as the long-term product path. SSH tunnels are useful for technical
users and dogfood, but they do not provide inbox delivery, non-technical setup,
or enterprise supportability.

### Extract A Generic Collaboration Transport Immediately

Rejected. The current RFCs already warn against abstraction before two real
implementations share call sites. Extract shared envelope and ledger contracts
first; extract a runtime interface only when the relay adapter exists and
removes real duplication.

## Open Questions

1. Should projection updates use one envelope key per message, or should the
   owner/recipient derive a per-share stream key after invite acceptance?
2. How much routing metadata may a hosted relay retain for support diagnostics
   without violating the Contact Share privacy claim?
3. What exact clock-skew budget should envelope expiry and diagnostics use?
4. What UI label should distinguish transport state from authorization state
   without making users debug protocol internals?

## Critic Feedback Incorporated

- design-minimalist 2026-05-21: removed the premature concrete
  `TransportAdapter` interface, moved SSH/Cloudflare to setup postures, and
  kept runtime adapter extraction deferred until two implementations share a
  real call site.
- delivery-pragmatist 2026-05-21: added no-go gates, PR sequencing,
  private-network parity tests, self-hosted relay restart dependencies, and a
  hard rule that hosted relay is a separate epic.
- failure-mode-analyst 2026-05-21: added inbox processing states, ack
  semantics, revocation priority, device epoch invalidation, routing metadata
  sensitivity, capability negotiation, replay-retention alignment, rollback
  modes, and terminal/control deny gates.
- boundary-critic 2026-05-21: clarified Contact Share versus Guest Link grant
  authority, narrowed relay/transport ownership, moved retry and cursor
  durability to the local node, and assigned crypto to a codec above
  transport.
- operability-reviewer 2026-05-21: added health vocabulary, metrics,
  diagnostics by actor, staged self-hosted enablement, Contact Share kill
  switches, hosted incident-response gates, and synthetic hosted probes.
- round-2 reviewers 2026-05-21: clarified that the relay enforces only
  transport-visible capability/schema constraints while nodes reject encrypted
  terminal/control payloads, resolved rollback traffic-mode ambiguity, and
  bound mailbox fetch/ack/cursor authority to contact/device epochs.
