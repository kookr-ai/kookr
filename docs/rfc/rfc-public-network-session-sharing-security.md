# RFC: Secure Public Network Task Sharing

## Status

Draft (v3 - product-scope revision)
Date: 2026-05-18
Author: Jean Ibarz (with Codex)

---

## Problem

Local session sharing, terminal streaming, and guarded input now work well
enough for dogfood. The target product is broader than "make a public terminal
link safe":

1. Jean should be able to share a running Kookr task with someone he knows
   over a public network.
2. The recipient should receive a notification in their own Kookr, accept or
   refuse the share, and then see the shared task inside their normal Kookr
   task list/terminal area.
3. The shared task should feel native, but be visually distinct from local
   tasks: marked as shared, showing who shared it, and showing which actions
   are available.
4. Communication should be encrypted and secure across public interfaces.
5. Anonymous browser links must still work for people who do not have Kookr
   installed.

The security model must therefore support two different surfaces:

- **Contact Share**: Kookr-to-Kookr sharing between known people/devices. This
  is the secure default and should support encrypted inbox notification,
  accept/refuse, native shared-task UI, and eventually controlled interaction.
- **Guest Link**: anonymous browser sharing for people without Kookr installed.
  This remains useful, but it is lower assurance: no durable identity, weaker
  notification, and more conservative capabilities.

Existing RFCs already provide the base:

- `rfc-collaborative-remote-sessions.md` keeps the local node authoritative
  for process lifecycle, terminal sessions, policy revalidation, and local
  safety.
- `rfc-easy-connection-sharing.md` defines the current share/invitation model,
  `RemoteTaskProjectionV1`, grant requests, and view-only link flow.
- `rfc-self-hosted-public-relay.md` hardens the public relay deployment,
  persistence, Caddy/TLS path, lockouts, diagnostics, and long-lived share
  story.

## Empirical Checkpoint

Round-1 review raised one load-bearing question: does the current
implementation prevent terminal bytes from reaching the relay until a specific
share has an approved `terminalView` grant?

Evidence from code:

- `src/remote/session-stream-publisher.ts` gates publication only on
  `KOOKR_RELAY_TRUSTED === 'true'`, then subscribes to every live backend
  session and publishes `terminal.bytes`.
- `src/server/index.ts` constructs `createSessionStreamPublisher` when the
  remote runtime exists; it does not pass invitation, contact, or grant state
  into the publisher.
- `relay/server.ts` gates member delivery and replay with
  `authAllowsTerminalStream`, `resolveTerminalSubscription`, and projection
  checks. That protects viewers, but the relay has already received the bytes.
- Existing relay tests prove a member without `terminalView` cannot receive
  terminal bytes, but they do not prove node publication is grant-scoped.

Conclusion: current code has good **delivery gating** but insufficient
**publication gating** for public sharing. Secure public sharing must add a
node-side allowlist so no terminal bytes leave the owner machine unless there
is active demand from an authorized contact/device or guest member.

## Recommendation

Build both sharing modes, but sequence them differently:

1. **Keep Guest Link view-only by default.** Anonymous browser links should
   keep working for people without Kookr installed. They initially expose only
   the safe task projection. Terminal viewing is a later explicit escalation.
2. **Make Contact Share the secure default.** A contact has a verified public
   identity key and one or more device keys. The relay stores and routes
   encrypted envelopes; it should not learn share contents beyond routing
   metadata.
3. **Add a shared-task inbox.** A recipient's Kookr receives an encrypted share
   invitation, shows a notification, and records an explicit accept/refuse
   decision.
4. **Render accepted shares as native shared tasks.** Accepted shares appear in
   the recipient's Kookr task list and terminal panel, clearly marked as
   `Shared from <contact>` and never confused with local tasks.
5. **Gate terminal publication at the owner node.** `KOOKR_RELAY_TRUSTED=true`
   is not sufficient. The owner node publishes terminal bytes only while an
   authorized contact/device or guest link is actively subscribed to that
   specific session and grant.
6. **Use live-only terminal viewing first.** No public replay in the first
   terminal-viewing release. Reconnect receives the current projection and new
   future bytes only.
7. **Defer public mutation.** Terminal input, permission approval, launch,
   stop, and other mutation need a later RFC. A contact identity system is a
   prerequisite, but identity alone is not enough for mutation.

## Sharing Modes

### Contact Share

Contact Share is for "someone I know who also has Kookr."

Properties:

- recipient is a Kookr identity, not a display name;
- contact identity is verified during pairing, ideally by QR code, passkey, or
  out-of-band fingerprint comparison;
- each Kookr device has a device key under that contact identity;
- share invite, accept/refuse, grants, and shared-task metadata are encrypted
  to the recipient device(s);
- recipient receives a Kookr notification and can accept/refuse in their own
  Kookr UI;
- accepted share appears as a `SharedTask` alongside local tasks;
- shared task remains remote-owned: the recipient views or interacts with the
  owner's task through grants; it is not a local agent process.

### Guest Link

Guest Link is for "someone who does not have Kookr installed."

Properties:

- recipient opens a browser URL;
- identity is an unverified guest label plus possession of a link/password;
- initial capability is `view` only;
- terminal viewing, if enabled later, requires owner approval after join;
- no public terminal input or permission approval;
- URL fragment carries any browser-side secret so the relay does not receive
  it in the navigation request;
- the security claim is weaker than Contact Share because the guest browser
  executes code served by the relay. A malicious relay can alter that code
  unless a future signed/static guest client is introduced.

## Non-Goals

- No public terminal input in this RFC.
- No public permission approval in this RFC.
- No remote launch, stop, delete, workspace cleanup, or permission bypass.
- No claim that anonymous browser links prove identity.
- No durable terminal-byte storage at the relay.
- No local execution of the shared task on the recipient machine.
- No replacement for private-network owner remote control.

## Requirements

### Security

1. **R1. Protected public channels.** Browser-to-relay, Kookr-to-relay, and
   relay-to-Kookr traffic uses HTTPS/WSS outside loopback. Public sharing is
   unavailable if `KOOKR_RELAY_PUBLIC_ORIGIN` is not `https://`.
2. **R2. Contact identity.** Contact Share requires verified contact identity
   and device keys before a share can be addressed to that recipient.
3. **R3. Encrypted Contact Share envelopes and streams.** Relay-persisted
   invite, accept/refuse, grant, and shared-task metadata envelopes are
   encrypted to sender/recipient device keys. Contact Share terminal frames are
   also encrypted end-to-end to the approved recipient device. Relay may see
   routing metadata but not task contents, terminal bytes, or accept/refuse
   plaintext.
4. **R4. Guest Link capability limits.** Guest links are view-only by default.
   Guest terminal viewing is explicit, live-only, and owner-approved. Guest
   mutation is not supported.
5. **R5. Node-side publication gate.** No `terminal.bytes` leaves the owner
   node until an active publication rule exists for a contact device or guest
   member, the rule is scoped to the exact session, and the recipient is
   currently subscribed.
6. **R6. Demand-driven publication.** Publication stops when the last
   authorized viewer disconnects, after a short bounded grace period. For
   Contact Share, demand is proven by recipient-device signed heartbeats to the
   owner node, not by relay-reported WebSocket presence alone.
7. **R7. Member/device-scoped grants.** `terminalView` is scoped to the
   specific contact device or guest member session, not just to an invitation
   shared by multiple people.
8. **R8. Immutable session binding.** Request, approval UI, policy sync, and
   publication rule bind the same `sessionId + sessionEpoch`. Approval fails
   if the shared projection changes before installation.
9. **R9. Live-only public terminal viewing.** First public terminal viewing
   release has no shared replay. Per-connection queues are bounded and dropped
   on disconnect.
10. **R10. Active revocation.** Revoking a share, revoking `terminalView`,
    downgrading relay posture, toggling a kill switch, or using revoke-all
    stops publication, closes streams, and clears queued frames.
11. **R11. Mutation default-deny at relay and node.** Public mutation messages
    are rejected at the relay and again at the node if a malicious or buggy
    relay forwards them.
12. **R12. Secret minimization.** Relay logs, diagnostics, and audit records
    never include terminal bytes, share passwords, member tokens, node tokens,
    raw command payloads, or plaintext encrypted-envelope contents.
13. **R13. Public posture fail-closed.** If relay posture is missing, stale,
    failing, or from an unexpected relay identity/build/config profile, the
    node disables terminal publication and stops existing streams.
14. **R14. Shared-task authorization boundary.** `SharedTask` IDs are rejected
    by every local-task mutation path: API routes, WebSocket commands,
    keyboard shortcuts, context menus, bulk actions, and terminal input paths.
    Visual hiding is not an authorization control.

### Product

15. **R15. Native shared-task surface.** Accepted Contact Shares appear inside
    the recipient's Kookr as shared tasks, not as external web pages.
16. **R16. Clear local/shared distinction.** Shared tasks show source contact,
    remote node label, capability badges, and a `Shared` marker anywhere a
    local task would show local ownership or local action controls.
17. **R17. Accept/refuse flow.** A recipient can accept, refuse, mute, or block
    a sender from the notification/inbox. Refuse is communicated back to the
    sender without exposing more recipient state than necessary.
18. **R18. Anonymous link preserved.** The owner can still create a Guest Link
    for people without Kookr installed.
19. **R19. Inspectable status.** Owner and recipient UIs explain why a share or
    terminal stream is blocked: relay posture, trust flag, missing approval,
    contact verification, feature negotiation, policy sync, node offline,
    insecure transport, kill switch, or revocation pending.
20. **R20. Notification privacy.** OS-level notifications use redacted copy by
    default. Full task labels appear only inside unlocked Kookr UI after
    decrypting the Contact Share envelope.

### Operational

21. **R21. Local-only unchanged.** With `KOOKR_RELAY_URL` unset, local terminal
    display, local terminal input, and local permission approval follow today's
    paths without relay posture checks or additional files.
22. **R22. Mixed-version fail-closed.** Relay refuses terminal viewing for
    nodes that do not advertise `terminal-publication-gate.v1`; nodes refuse
    terminal publication when the relay does not advertise compatible
    scoped-delivery support.
23. **R23. Rollback bounded.** Operators can disable terminal viewing within a
    defined SLO. Relay immediately tears down streams and rejects/drops further
    `terminal.bytes`; node receives a control-frame or short-poll invalidation.
24. **R24. Evidence without payloads.** Metadata audit can reconstruct who had
    access to which shared task/session and when, without storing terminal
    payloads.

## User Experience

### Contact Share Sender Flow

1. Owner clicks **Share** on a task.
2. Share dialog offers:
   - **Send to Kookr contact**
   - **Create guest link**
3. Owner chooses a verified contact, sees the exact task/session being shared,
   selects initial capability `view`, and sends.
4. The sender sees state:
   - `sent`
   - `delivered`
   - `accepted`
   - `refused`
   - `expired`
   - `revoked`
5. If the recipient requests terminal viewing, owner approves or denies for
   that recipient device and session.

### Contact Share Recipient Flow

1. Recipient Kookr receives an encrypted inbox envelope through the relay.
2. Kookr shows a notification:

   ```text
   Jean shared "Fix auth regression" with you
   [Accept] [Refuse]
   ```

3. On accept, a shared task appears in the normal task list:

   ```text
   Shared · Jean · Fix auth regression
   ```

4. Opening it shows a familiar task detail/terminal layout with a persistent
   shared banner:

   ```text
   Shared from Jean's Desktop
   View-only · Remote task · Actions limited by Jean
   ```

5. The recipient can request terminal viewing if not already granted. The UI
   never presents local-only actions as available unless the share grant
   supports them.

### Guest Link Flow

1. Owner clicks **Create guest link**.
2. Owner gets share ID/password or a fragment-secret URL.
3. Guest opens in a browser and sees the safe task projection.
4. Guest may request terminal viewing if the owner enabled requests.
5. Owner approval is required before any terminal bytes leave the owner node.
6. Guest never gets terminal input or permission approval in this RFC.

## Threat Model

Scope: Kookr nodes connected outbound to a relay reachable from the public
internet, plus anonymous browser guests. Local compromise of the owner's
workstation is out of scope except where Kookr can reduce blast radius after
relay abuse.

Assets:

- **Task projection**: task label, status, findings flags, timestamps.
- **Terminal bytes**: raw output from coding agents.
- **Contact identity keys and device keys**.
- **Encrypted share envelopes**.
- **Guest share ticket**.
- **Node/member/device tokens**.
- **Terminal-view grant**.
- **Metadata audit records**.

| # | Threat | Mitigation |
|---|---|---|
| T1 | Relay reads Contact Share contents | E2EE envelopes for contact invites, accept/refuse, grants, shared-task metadata, and Contact Share terminal frames. |
| T2 | Copied Guest Link leaks terminal access | Guest link starts `view` only; terminal viewing requires owner approval after join. |
| T3 | Relay receives bytes for unapproved sessions | Node-side, demand-driven publication rules scoped to member/device/session. |
| T4 | Owner approves Alice but Bob inherits access | `terminalView` is member/device-scoped; second member requires separate approval. |
| T5 | Shared task is mistaken for local task | Persistent `Shared from <contact>` marker, source contact, remote node label, and capability badges. |
| T6 | Recipient accepts a stale or swapped session | Invite and approval bind immutable `sessionId + sessionEpoch`; approval fails on projection change. |
| T7 | Malicious relay fabricates approval | Node installs publication rules only from local owner approval ledger or owner-signed approval event, not relay policy alone. |
| T8 | Viewer disconnects but relay keeps receiving bytes | Demand-driven publication stops when no authorized viewer remains. |
| T9 | Public relay misconfigured | Posture/verifier fail closed; node disables terminal publication. |
| T10 | Mixed-version node publishes globally | Relay rejects terminal bytes from nodes without `terminal-publication-gate.v1`; rollout is reject-by-default. |
| T11 | Public mutation sneaks through relay | Mutation rejected at both relay and node. |
| T12 | Guest browser E2EE overclaimed | Guest Link is documented as lower assurance because relay-served JS can be malicious unless a future signed/static guest client ships. |
| T13 | Relay fabricates viewer presence after approval | Contact Share demand requires recipient-device signed heartbeats consumed by the owner node. |
| T14 | Shared task uses local task shortcut/API path | SharedTask is a separate ID namespace and every local mutation path rejects it. |

## Boundary Model

```text
Contact recipient Kookr
  - owns contact/device private keys
  - decrypts inbox and shared-task envelopes
  - renders accepted shares as SharedTask entries
  - requests capabilities through encrypted envelopes

Anonymous browser guest
  - holds fragment/password capability
  - receives only guest-safe projection by default
  - may request terminalView, never mutation

Relay
  - routes encrypted Contact Share envelopes
  - serves Guest Link browser UI
  - authenticates WebSockets and member sessions
  - enforces transport, origin, nonce, size, rate, coarse grant checks
  - never stores terminal bytes durably

Owner node
  - owns task/session state and terminal publication
  - owns local owner approval ledger
  - publishes terminal bytes only for active scoped rules
  - treats relay posture as an input, not proof of safety
```

## Design

### 1. Identity And Contacts

Each Kookr install has a stable local node identity and one or more device
keys. Contact pairing creates a verified mapping:

```ts
type KookrContact = {
  contactId: string;
  displayName: string;
  verifiedFingerprint: string;
  devices: Array<{
    deviceId: string;
    publicKey: string;
    label?: string;
    lastSeenAt?: string;
  }>;
  trustState: 'verified' | 'rotated-unverified' | 'blocked';
};
```

Pairing can be QR-code, one-time code, or out-of-band fingerprint comparison.
The relay is not allowed to mint contact trust. If a device key rotates, shares
to that device pause until the user accepts the new fingerprint.

### 2. Encrypted Share Inbox

Contact Share uses encrypted envelopes:

```ts
type ContactShareEnvelope = {
  schemaVersion: 'contact-share-envelope.v1';
  envelopeId: string;
  shareId: string;
  decisionVersion: number;
  previousEnvelopeId?: string;
  senderContactId: string;
  recipientContactId: string;
  recipientDeviceId: string;
  kind: 'share.invite' | 'share.accept' | 'share.refuse' | 'share.revoke' | 'grant.request' | 'grant.resolve' | 'shared-task.update';
  createdAt: string;
  expiresAt?: string;
  ciphertext: string;
  senderSignature: string;
};
```

The relay stores and routes this envelope but does not decrypt it. The
plaintext includes task label, owner node label, subject, grant set, and
display metadata. Terminal bytes are not stored in envelopes.

Envelope state is causal and idempotent:

- `shareId` names the durable share across invite, accept/refuse, revoke, and
  updates.
- `decisionVersion` is monotonic per `(shareId, recipientDeviceId)`.
- duplicate envelopes with the same `(shareId, recipientDeviceId,
  decisionVersion, kind)` are idempotent;
- older versions are ignored;
- `refuse`, `revoke`, and `block` create tombstones that later delayed
  `accept` envelopes cannot resurrect;
- when two recipient devices make conflicting decisions, refuse/block wins for
  that device, while sender-side lifecycle records per-device state and derives
  aggregate state from those records.

### 3. Shared Task Projection

Accepted Contact Shares become `SharedTask` records in the recipient Kookr:

```ts
type SharedTask = {
  kind: 'shared-task';
  sharedTaskId: string;
  ownerContactId: string;
  ownerDisplayName: string;
  ownerNodeLabel?: string;
  remoteTaskId: string;
  terminalSubject?: {
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    projectionId?: string;
    sessionAlias?: 'primary';
  };
  localDisplayLabel: string;
  lifecycle: 'pending' | 'accepted' | 'refused' | 'revoked' | 'expired';
  grants: Array<'view' | 'terminalView'>;
  source: 'contact-share';
  remoteStatus: RemoteTaskProjectionStatus;
  updatedAt: string;
};
```

The shared task appears in the normal task list and task detail routing, but
with guarded actions. It is not stored as a local `Task` that can be completed,
deleted, relaunched, or written to like a local agent process.

Lifecycle ownership:

- sender node is authoritative for `sent`, `revoked`, `expired`, and remote
  task/session updates;
- recipient device is authoritative for its own `accepted`, `refused`, `muted`,
  and `blocked` decision envelopes;
- relay is a mailbox only and cannot invent lifecycle transitions;
- recipient Kookr derives local display lifecycle from verified envelopes and
  never from relay plaintext state.

### 4. Guest Link Projection

Guest Link keeps the current browser projection path, with stricter language:

- `RemoteTaskProjectionV1` remains the default guest contract.
- Guest labels are untrusted text.
- Guest terminal viewing uses the same publication gate as Contact Share, but
  the grant principal is a guest member session rather than a verified contact
  device.
- Guest terminal-view approval is bound to a short-lived browser session
  cookie/device ID minted after join, not to the reusable URL fragment. Reloads
  may resume only while that session is alive; copying the original URL after
  approval does not copy terminal-view approval.
- If the fragment, clipboard, extension state, or browser profile is suspected
  leaked, owner rotates the Guest Link; terminal-view grants are invalidated
  with the old member sessions.
- Guest Link cannot participate in the encrypted Kookr inbox unless the guest
  installs/pairs Kookr and converts to Contact Share.

### 5. Terminal Publication Rules

`SessionStreamPublisher` must stop being "all sessions if trusted" for public
mode. Publication is scoped by recipient and demand:

```ts
type TerminalPublicationRule = {
  publicationScopeId: string;
  principal:
    | { kind: 'contact-device'; contactId: string; deviceId: string }
    | { kind: 'guest-member'; invitationId: string; memberSessionId: string; deviceId: string };
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  approvedAt: string;
  policyVersion: PolicyVersion;
  minSeqExclusive: Seq;
  streamEncryption:
    | { kind: 'contact-e2ee'; recipientDeviceId: string; streamKeyId: string }
    | { kind: 'guest-transport'; memberSessionId: string };
  demandProof:
    | { kind: 'recipient-signed-heartbeat'; heartbeatKeyId: string; expiresAt: string }
    | { kind: 'guest-relay-presence'; expiresAt: string };
  expiresAt?: string;
};
```

Rules are installed only from the owner node's local approval ledger or an
owner-signed approval event. Relay policy sync alone is not enough. The
publisher emits frames tagged with `publicationScopeId`, `policyVersion`, and
`sessionEpoch`; the relay routes by scope, not by session alone.

Publication starts only when at least one authorized viewer proves demand. For
Contact Share, the recipient device sends signed heartbeats that the owner node
verifies; relay presence alone cannot keep publication alive. For Guest Link,
relay presence is accepted as lower-assurance demand because the relay already
serves the guest browser UI and the mode is explicitly lower assurance.

Publication stops when demand proof expires or the last viewer disconnects,
after a short bounded grace period. Pre-approval buffered bytes are excluded
by `minSeqExclusive`.

Contact Share terminal frames are encrypted at the owner node to the approved
recipient device stream key before being sent to the relay. Guest Link terminal
frames are protected by HTTPS/WSS transport only unless a future signed/static
guest client enables stronger browser-side cryptography.

### 6. Live-Only Terminal Viewing

First public terminal viewing release is live-only for both Contact Share and
Guest Link:

- no public `afterSeq` replay;
- no shared terminal replay buffer;
- no delivery of bytes produced before approval;
- bounded per-connection queue only;
- disconnect drops queued bytes;
- reconnect receives current projection and future bytes only.

Replay can be designed later for Contact Share using encrypted per-recipient
buffers. Guest replay should remain disabled until there is a separate privacy
review.

### 7. Public Posture And Web Hardening

Posture has two parts:

1. Relay-declared readiness: version, public origin, feature set, kill-switch
   state, durable-state availability, generated timestamp.
2. Verifier evidence: HTTPS, headers, `Cache-Control: no-store`, WebSocket bad
   origin rejection, nonce rejection, payload cap rejection, compression
   disabled, and token redaction in logs.

Node behavior:

- fail closed on stale/missing/failing posture;
- fail closed on unexpected relay identity/profile;
- stop publication immediately on kill-switch control frame;
- expose terminal readiness and blocking reasons to owner UI.

### 8. Revocation, Rollback, And Incident Response

Revocation is persistence-before-success. If the owner node cannot persist the
revocation/tombstone, it disables public terminal publication and surfaces an
incident state.

Rollback requirements:

- relay kill switch tears down streams immediately;
- relay rejects/drops `terminal.bytes` after kill-switch activation;
- node receives push invalidation or polls quickly enough to meet a bounded
  stop SLO;
- view-only shares and Contact Share inbox records survive rollback;
- metadata evidence remains exportable.

Minimum metadata audit fields:

- correlation ID;
- relay instance and node identity;
- pseudonymous contact/member/session IDs;
- publication scope ID;
- policy/grant version;
- posture identity;
- first/last timestamps;
- byte counts and seq ranges, not payloads;
- revocation/kill-switch reason and ack state.

### 9. Notifications

Contact Share notifications are delivered to Kookr devices, not just browser
push subscriptions:

- relay stores encrypted inbox envelope;
- recipient node/device syncs inbox over WSS;
- recipient Kookr shows a redacted local notification and in-app inbox item;
- Web Push may be used as a wake-up hint, carrying only redacted metadata.

Default OS notification text is redacted:

```text
New Kookr share from Jean
Open Kookr to review
```

Full task labels are displayed only inside unlocked Kookr UI after decrypting
the envelope. Users may opt into richer local notifications per device.

Guest Link notifications are limited:

- owner copies/sends the link out of band;
- guest browser may opt into web push after joining, but that is guest-local
  convenience, not verified identity.

### 10. Mutation Deferred

Public terminal input and public permission approval require a separate RFC.
That RFC must settle identity assurance, command safety, audit redaction,
freshness, permission-prompt binding, owner override, and whether Contact
Share gets stronger capabilities than Guest Link. Until then, all public
mutation messages are rejected at both relay and node.

## Tests And Acceptance Gates

1. **Contact envelope confidentiality.** Relay persistence contains encrypted
   envelopes only; plaintext task labels and accept/refuse details are absent.
2. **Contact accept/refuse.** Recipient Kookr notification appears, accept
   creates a `SharedTask`, refuse does not.
3. **Shared-task UI distinction.** Shared task cannot be mistaken for local:
   source contact, remote node label, shared marker, and capability badges are
   present in list and detail views.
4. **Shared-task command rejection.** Every local-task mutation API, WebSocket
   command, shortcut, context menu, and bulk action rejects `SharedTask` IDs.
5. **Guest link preserved.** Anonymous browser guest can still join and see
   the safe task projection without Kookr installed.
6. **Node publication gate.** With trusted relay env but no active scoped
   rule, backend bytes produce no node-to-relay `terminal.bytes`.
7. **Device/member scoped grant.** Approving Alice/device A does not grant Bob
   or Alice/device B terminal viewing.
8. **Demand-driven publication.** Viewer disconnect or expired contact
   heartbeat suspends publication after the configured grace period.
9. **Contact stream E2EE.** Relay-visible Contact Share terminal frames are
   ciphertext; recipient device decrypts them; wrong device key fails.
10. **Immutable session binding.** Approval fails if `sessionId/sessionEpoch`
   changed since the request.
11. **Pre-approval watermark.** Bytes produced before approval are not
   published to the relay.
12. **Accept/refuse causality.** Duplicate, delayed, and cross-device
   accept/refuse envelopes do not resurrect refused/revoked shares.
13. **Guest approval is session-bound.** Copying a Guest Link after terminal
   approval does not copy terminal-view access to a new browser session.
14. **Notification privacy.** OS/Web Push notification payloads contain
   redacted metadata only by default.
15. **Revocation fail-closed.** Persistence failure during revoke disables
    public terminal publication.
16. **Mixed-version fail-closed.** Relay rejects terminal bytes from nodes
    without `terminal-publication-gate.v1`; nodes refuse relays without scoped
    delivery support.
17. **Mutation denial.** Public mutation frames forwarded by a malicious relay
    are rejected by the node.
18. **WebSocket security.** Missing auth, bad origin, missing nonce, expired
    nonce, oversized payload, compression, and unknown message type fail.
19. **Rollback drill.** Kill switch tears down active streams within SLO,
    view-only shares survive, and evidence export works.
20. **Local-only smoke.** With `KOOKR_RELAY_URL` unset, local terminal display,
    input, and permission approval remain unchanged.

## Phasing

### Phase 0 - Product Policy And UI Model

- Split Share UI into **Send to Kookr contact** and **Create guest link**.
- Document Contact Share as the secure default and Guest Link as lower
  assurance.
- Add shared-task visual model and copy.
- Keep mutation disabled.

### Phase 1 - Contacts And Encrypted Inbox

- Add contact identity/device keys and pairing.
- Add encrypted relay inbox envelopes.
- Add notification, accept/refuse, mute/block.
- Add `SharedTask` read model in the recipient UI.

### Phase 2 - Guest Link Hardening

- Preserve existing anonymous view-only link.
- Add security headers, WebSocket hardening, posture checks, and link copy that
  explains guest limitations.
- Keep Guest Link terminal viewing disabled until Phase 4.

### Phase 3 - Node Publication Gate

- Add `terminal-publication-gate.v1`.
- Add scoped publication rules, owner approval ledger, watermarks, and
  demand-driven publication with contact-device signed heartbeats.
- Add mixed-version fail-closed rollout: relay reject-by-default first, then
  node gate, then UI approval.

### Phase 4 - Live Terminal Viewing

- Enable live-only terminal viewing for Contact Share first.
- Encrypt Contact Share terminal frames end-to-end to the recipient device.
- Enable Guest Link terminal viewing only after owner consent copy and Guest
  Link tests pass.
- Add revocation, rollback, quotas, metrics, and metadata audit.

### Phase 5 - Hosted Relay Gate

- Enable hosted relay terminal viewing only after tenant isolation checks,
  privacy notice, paging, synthetic probes, per-tenant kill switch, log
  redaction verification, and incident escalation are in place.

### Phase 6 - Mutation RFC

Write a separate RFC for public terminal input, permission approval, launch,
stop, and collaborator mutation.

## Alternatives Considered

### A. Anonymous Links Only

Rejected. Anonymous links are still required, but they cannot provide verified
identity, encrypted Kookr-to-Kookr inbox semantics, or a native shared-task
experience inside the recipient's Kookr.

### B. Contact Share Only

Rejected. People without Kookr installed still need to view shared tasks in a
browser. Guest Link remains the compatibility path.

### C. Relay-Trusted Plaintext For All Sharing

Rejected for Contact Share. Known-contact sharing should encrypt invite and
shared-task metadata so the relay is a router, not a collaborator. Guest Link
has weaker guarantees because the browser client is relay-served.

### D. Enable Public Terminal Input Once Contacts Exist

Rejected for this RFC. Contact identity is necessary but not sufficient for
safe mutation. Command safety, permission-prompt binding, audit, freshness,
and owner override need separate design.

### E. Short Replay Immediately

Rejected. Replay expands the privacy and authorization surface. Live-only is
the first secure terminal-viewing step.

## External Guidance Used

- OWASP WebSocket Security Cheat Sheet: origin/auth checks, message validation,
  max payload, rate limiting, and WebSocket-specific monitoring.
- NIST SP 800-63B: authenticated protected channels, replay resistance,
  session monitoring, reauthentication considerations, and privacy-aware
  retention.
- MDN Web Security: sensitive data needs explicit application-level web
  protections in addition to browser features.
- Caddy Automatic HTTPS docs: public deployment should rely on managed HTTPS
  with persistent certificate storage.

## Files To Change

- `src/remote/session-stream-publisher.ts` - scoped, demand-driven publication
  allowlist and public live-only mode.
- `src/remote/share-contract.ts` - Contact Share, Guest Link, shared-task,
  envelope, and publication-rule DTOs.
- `src/server/task-share-service.ts` - share mode selection, owner approval
  ledger, revocation persistence.
- `src/frontend/components/TaskShareModal.tsx` - contact/guest choice,
  accept/refuse state, terminal-view requests, Guest Link warnings.
- `src/frontend/*` task-list/detail components - shared-task rendering and
  local/shared distinction.
- `relay/server.ts` - encrypted inbox routing, scoped terminal delivery,
  posture, WebSocket hardening, kill switch.
- `relay/src/push/*` and `src/remote/push.ts` - redacted wake-up notifications
  for Contact Share inbox items.
- `relay/__tests__/*`, `src/remote/__tests__/*`, `src/frontend/*test*` -
  envelope, accept/refuse, shared-task UI, publication, revocation, and
  guest-link tests.
- `deploy/relay/` and hosted relay ops docs - verifier and rollback commands.

## Open Questions

1. Which pairing UX should v1 use: QR code, one-time code, fingerprint compare,
   or passkey-backed account?
2. Should Contact Share terminal metadata be encrypted per recipient device or
   per contact with device fanout?
3. How much metadata may the relay retain for offline encrypted inbox delivery?
4. Should Guest Link terminal viewing ever use browser-side content encryption,
   given the relay serves the JavaScript?
5. What visual treatment best distinguishes shared tasks without making them
   feel second-class?

## Critic Feedback Incorporated

- Round 1 / design-minimalist 2026-05-18: incorporated. Public mutation moved
  to a separate future RFC.
- Round 1 / boundary-critic 2026-05-18: incorporated. Added explicit
  browser/relay/node boundaries and node-owned publication authority.
- Round 1 / failure-mode-analyst 2026-05-18: incorporated. Added scoped grants,
  demand-driven publication, immutable session binding, watermarks, and
  revocation fail-closed behavior.
- Round 1 / socratic-challenger 2026-05-18: incorporated. Added empirical
  checkpoint and clarified node-to-relay publication gating.
- Round 1 / operability-reviewer 2026-05-18: incorporated. Added mixed-version
  fail-closed, bounded rollback, evidence schema, and rollback drill gates.
- Product revision 2026-05-18: incorporated user requirement that known-contact
  Kookr-to-Kookr sharing with notification/accept/refuse/native shared-task UI
  is the primary secure path, while anonymous Guest Link remains supported for
  people without Kookr installed.
