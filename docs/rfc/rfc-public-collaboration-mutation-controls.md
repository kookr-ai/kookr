# RFC: Public Collaboration Mutation Controls

## Status

Draft (v3 - post-round-2 revision)
Date: 2026-05-19
Author: Jean Ibarz (with Codex)

---

## Problem

`rfc-public-network-session-sharing-security.md` made public sharing view-first:
Contact Share can create verified shared tasks, Guest Link remains lower
assurance, terminal viewing is live-only and node-publication-gated, and all
public mutation is rejected at relay and node.

The next product question is not only "can a collaborator type into my
terminal?" Public collaboration includes proposals, annotations, grant
requests, terminal input, permission-prompt responses, launch, stop, and
owner-reviewed actions. Those operations have different risk levels and should
not share one vague "mutation" path.

This RFC defines the collaboration and mutation control model for future
implementation. It intentionally ships no public mutation implementation.

## Recommendation

Separate public collaboration into two protocol families:

1. **Collaboration requests** are non-mutating owner-review items. They include
   comments, terminal-input proposals, grant requests, attention markers, and
   stop requests. Contact Share and Guest Link may both use this family after
   rate limits, inert rendering, and redaction tests exist.
2. **Direct mutation frames** can alter the owner task without a per-action
   owner review. They include direct terminal input, permission responses,
   direct stop, and launch from owner-approved templates. Direct mutation is
   Contact Share only, verified-device only, and unavailable until its specific
   future gate passes.

The owner node is the sole authority for applying mutations. The relay is
defense in depth: it authenticates, rate-limits, routes, rejects malformed or
unsupported frames, and enforces hosted kill switches, but it cannot grant
mutation authority. The frontend is never authoritative; it renders owner-node
state and sends owner intents back to the owner node.

## Non-Goals

- No public mutation implementation in the issue that adds this RFC.
- No Guest Link direct terminal input, permission approval, launch, or direct
  stop.
- No collaborator permission approval in the first mutation release; deny-only
  can be considered before approval.
- No arbitrary remote launch. Launch requires a separate future implementation
  gate and owner-approved templates.
- No relay persistence of raw terminal input, proposal text, permission prompt
  contents, command payloads, secrets, or agent output.
- No remote permission bypass. Collaborator approval, when eventually allowed,
  cannot exceed what the local owner could approve.
- No local execution on the collaborator machine.

## Identity Assurance

| Surface | Principal | Allowed in v1 collaboration | Direct mutation eligibility |
|---|---|---|---|
| Contact Share | verified contact device with device key | comments, proposals, attention markers, grant requests, stop requests | eligible only after explicit owner grant and capability-specific gate |
| Guest Link | browser member session plus link/password possession | comments, attention markers, owner-reviewed proposals after abuse controls | not eligible |
| Relay | relay identity and posture document | route and reject | never eligible |
| Frontend | local browser state | display and owner intent capture | never eligible |

Guest Link remains proposal-only unless a later RFC defines a relay-independent
guest client integrity milestone, such as a static signed client bundle,
pinned hash/SRI, strict CSP, version attestation, and UX that explains the
remaining lower assurance.

## Owner-Node Authority Boundary

Future implementation should introduce one owner-side collaboration/mutation
service. That service owns:

- proposal/review queue state;
- grant ledger and revocation tombstones;
- mutation-frame verification and replay state;
- permission-prompt classification and prompt-binding decisions;
- owner-node audit records;
- final apply/deny decisions.

Adapters expose narrow local ports such as "write input to this session",
"respond to this permission prompt", "stop this task", or "launch this
template." Adapters must not know about contacts, guests, shares, grant
versions, relay posture, or collaborator policy. `SessionStreamPublisher`
remains read-side publication gating; direct terminal input may consult
terminal-view grant state through a query, but input authorization lives in the
mutation service.

## Collaboration Requests

Collaboration requests are inert until the owner applies or resolves them:

```ts
type PublicCollaborationRequest = {
  schemaVersion: 'public-collaboration-request.v1';
  requestId: string;
  shareId: string;
  principal:
    | { kind: 'contact-device'; contactId: string; deviceId: string }
    | { kind: 'guest-member'; invitationId: string; memberSessionId: string };
  kind:
    | 'terminal-input.proposal'
    | 'task.annotation'
    | 'terminal.attention'
    | 'grant.request'
    | 'task.stop.request';
  target:
    | { kind: 'task'; taskId: string }
    | { kind: 'terminal-range'; sessionId: string; sessionEpoch: number; startSeq: number; endSeq: number }
    | { kind: 'terminal-subject'; sessionId: string; sessionEpoch: number; subjectId: string };
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  payloadCiphertext: string;
  payloadDigest: string;
  auth:
    | { kind: 'contact-device-signature'; signature: string }
    | { kind: 'guest-session-mac'; mac: string };
};
```

Contact Share requests use the contact device signature. Guest Link requests
use a short-lived session MAC key minted by the owner node after join and
delivered through relay-blind material such as a URL fragment, password-derived
handshake, or encrypted owner-to-browser response that the relay cannot read.
The owner node stores only a keyed verifier and verifies the MAC before
creating an owner-review item. Relay-owned guest session authentication is
routing identity only; it is not owner-node attribution and cannot satisfy
request authentication by itself.

Request payload privacy:

- Requests that contain user text, terminal proposals, comments, annotations,
  or stop reasons use `payloadCiphertext` encrypted to the owner node.
- The relay may transiently route ciphertext and metadata but must not see or
  persist plaintext request payloads.
- Metadata-only requests may carry an empty encrypted payload, but not
  plaintext user content.
- `payloadDigest` follows the same keyed/AEAD-authenticated digest rule as
  direct mutation frames so low-entropy proposal text is not guessable from
  diagnostics.

Owner review item lifecycle:

```text
received -> visible -> applying -> ownerApplied | ownerEditedAndApplied |
applyFailed | ownerRejected | expired | muted | senderBlocked | shareRevoked
```

Rules:

- Relay may route requests but must not persist plaintext proposal content.
- Owner UI renders proposal and annotation text as inert text; terminal control
  sequences and markup are escaped.
- Applying a proposal uses the existing local owner input path and records that
  the owner applied collaborator-proposed content.
- Guest proposals are rate-limited and may be disabled per share.
- Grant requests never grant anything by themselves; they create owner-review
  items.
- Stop requests do not stop a task until the owner applies them. Direct stop is
  a future Contact Share mutation gate.
- Applying a proposal re-checks share lifecycle, target task/session epoch,
  owner-node storage health, and local adapter availability before writing.
- `applyFailed` is visible to the owner and collaborator when disclosure is
  safe, and never retries automatically.

Request replay and abuse controls:

- Owner-node receive time is authoritative for request expiry.
- Request idempotency scope is `(shareId, principal, kind, target,
  idempotencyKey)`.
- Same idempotency key and same payload digest returns the existing review
  item or its terminal lifecycle state.
- Same idempotency key and different payload digest is a security rejection.
- Request dedupe, mute/block, and per-share disable state must survive
  owner-node restart.
- Review-item creation and request dedupe are persisted atomically. If the
  owner node cannot persist both, it rejects the request without showing a
  partial review item.
- Guest request controls include maximum payload size, maximum pending items
  per member and per share, per-minute quotas, persistent mute/block, and
  rejection when owner-node storage cannot persist the review item.

## Direct Mutation Capabilities

Direct mutation capabilities are future-gated and Contact Share only:

```ts
type DirectMutationCapability =
  | 'terminalInput.direct'
  | 'permission.deny'
  | 'permission.approve'
  | 'task.stop.direct'
  | 'task.launch.template';
```

Capability status:

- `terminalInput.direct`: future gate after proposal mode, owner pause, input
  leases, byte policy, revocation-at-write-boundary, and rollback tests.
- `permission.deny`: candidate first permission capability because denial is
  safer than approval, still prompt-bound and audited.
- `permission.approve`: future gate after permission taxonomy, provider
  classifier, prompt-binding, owner override, and audit-failure tests.
- `task.stop.direct`: future gate after lifecycle binding and owner-visible
  emergency controls.
- `task.launch.template`: future gate after collaborative playbook-template
  design, budget caps, variable validation, worktree policy, and share-back
  semantics.

No direct mutation capability is enabled by default.

## Direct Mutation Frame Contract

When a future gate enables direct mutation, frames must be signed, sequenced,
fresh, and grant-version-bound:

```ts
type PublicDirectMutationFrame = {
  schemaVersion: 'public-direct-mutation-frame.v1';
  frameId: string;
  shareId: string;
  grantVersion: number;
  principal: { kind: 'contact-device'; contactId: string; deviceId: string };
  capability: DirectMutationCapability;
  target:
    | { kind: 'terminal'; sessionId: string; sessionEpoch: number; subjectId: string }
    | { kind: 'permission-prompt'; promptId: string; sessionId: string; sessionEpoch: number }
    | { kind: 'task'; taskId: string; lifecycleVersion: number }
    | { kind: 'launch-template'; templateId: string; templateDigest: string };
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  payloadCiphertext: string;
  payloadDigest: string;
  deviceSignature: string;
};
```

Cryptographic requirements:

- `deviceSignature` covers the canonical frame excluding `deviceSignature`.
- `payloadDigest` is a keyed digest or AEAD-authenticated digest, not a
  plaintext hash suitable for guessing low-entropy payloads.
- Contact Share mutation payloads are encrypted to the owner node/device. If a
  capability cannot meet this, the capability is unavailable.
- Security-bearing metadata is AEAD associated data: share ID, principal,
  capability, target, grant version, sequence, expiry, and payload digest.
- Acceptance tests mutate each signed field after signing and require
  rejection.

Owner-node validation order:

1. Authenticate envelope/session and verify frame signature.
2. Check relay posture, owner-node kill switch, grant scope, grant version,
   target, expiry, and future `issuedAt` skew.
3. Check idempotency atomically before sequence rejection: same key plus same
   digest returns the stored result, same key plus different digest rejects,
   and only new idempotency keys advance sequence validation.
4. Decrypt payload.
5. Validate plaintext payload policy for the capability.
6. Persist redacted owner-node audit and replay/idempotency attempt state
   atomically as `accepted`.
7. Transition to `applyStarted`, then re-check grant version and kill switch at
   the final apply boundary.
8. Apply through a local adapter port and persist the terminal attempt state.

## Freshness, Replay, And Restart Safety

- Owner-node receive time is authoritative.
- Frames issued more than 10 seconds in the future are rejected.
- Default maximum lifetime is 30 seconds for direct terminal input and 2
  minutes for permission, stop, and launch frames.
- Sequence is tracked per `(shareId, contactId, deviceId, capability, target)`.
- Idempotency scope is `(shareId, principal, capability, target,
  idempotencyKey)`.
- Same idempotency key and same payload digest returns the prior result.
- Same idempotency key and different payload digest is a security rejection.
- Lower sequence with a new idempotency key is rejected.
- Stored direct-mutation attempt state is explicit:
  `accepted`, `applyStarted`, `applied`, `applyFailed`,
  `abortedByRevocation`, or `crashRecoveryRequired`.
- `accepted` means authorization and replay state are durable but adapter apply
  has not started; retry may continue only after re-checking grant version and
  kill switch.
- `applyStarted` means the adapter boundary may have observed the action.
  Retry after owner-node restart fails closed as `crashRecoveryRequired` unless
  the adapter can prove the action did not apply.
- `applied`, `applyFailed`, and `abortedByRevocation` are terminal and return
  the stored result on retry.
- Audit and replay/idempotency state are written in one owner-node transaction
  or equivalent write-ahead record. If atomic persistence is unavailable,
  high-risk direct mutation is disabled.
- Grant versions are monotonic per grant scope. Expired and revoked grant
  versions leave tombstones retained beyond the maximum frame lifetime and
  expected relay retry window.
- Accepted sequence, idempotency, grant, and tombstone state must survive
  owner-node restart. If durable replay state is unavailable after restart,
  public mutation fails closed until a fresh relay/session handshake and grant
  sync complete.

## Terminal Input Safety

### Proposal Mode

Proposal mode is the first shippable terminal collaboration path. The
collaborator proposes input; owner review applies, edits, rejects, mutes, or
blocks it. Guest Link can participate only in proposal mode and only after
abuse controls and inert rendering tests exist.

### Direct Mode

Direct mode is Contact Share only and needs a later implementation gate:

- active terminal-view grant for the same contact device and terminal subject;
- single-writer input lease per terminal subject;
- request-control, owner preemption, lease timeout, and downgrade-to-propose;
- default line mode; raw mode requires separate explicit grant;
- byte allowlist by mode: printable UTF-8, CR/LF, and backspace in line mode;
  bracketed paste only in paste mode; raw control sequences only in raw mode;
- NUL and unsupported escape sequences rejected;
- maximum bytes per frame, per paste, and per minute;
- owner confirmation for paste above threshold, which converts that paste to a
  proposal item;
- owner UI showing active direct-input principal and remaining budget;
- final grant-version and kill-switch check immediately before terminal
  backend `write()`;
- automatic downgrade to proposal mode only for benign input-policy failures
  while storage is healthy, the share remains active, and relay posture remains
  valid;
- rejection, not downgrade, on revocation, owner/relay kill switch, relay
  posture failure, audit persistence failure, or storage failure.

## Permission-Prompt Binding

Permission prompts are structured authorization objects, not terminal bytes.

Permission class taxonomy:

- `read-only-inspection`: reads already visible local project state.
- `workspace-write`: modifies files or task state.
- `process-execution`: runs commands or tools.
- `network`: reaches external services.
- `secret-or-credential`: accesses tokens, credentials, SSH/GPG material, or
  private config.
- `deployment-or-publish`: deploys, publishes packages, pushes protected
  branches, changes production, or sends irreversible external effects.
- `unknown`: provider/action cannot be classified.

Default policy:

- `permission.deny` may be considered first for verified Contact Share
  devices after prompt-binding tests pass.
- `permission.approve` defaults to owner-only.
- `unknown`, `secret-or-credential`, `deployment-or-publish`, permission
  bypass, spending-limit changes, repository deletion, and destructive cleanup
  are owner-only.
- Unknown providers, unknown actions, missing classifier metadata, or
  non-canonical arguments fail closed.

Prompt binding includes prompt ID, provider, normalized tool/action name,
canonical arguments, arguments keyed digest, resolved cwd policy,
environment-impact class, permission class, classifier version,
canonicalization version, prompt creation time, session ID, and session epoch.

Prompt state machine:

```text
pending -> ownerApproved | ownerDenied | collaboratorDenied |
collaboratorApproved | expired | revoked | auditFailed
```

Owner denial and revocation are terminal and win races. Prompt resolution is a
compare-and-swap on owner-node state ordered by persisted owner-node decision
time. Owner approval wins over collaborator denial if both race and the owner
approval persists first. Expiration wins over later collaborator responses.
All collaborator responses require audit-before-apply; audit persistence
failure transitions high-risk collaborator responses to `auditFailed` and does
not apply approval.

## Launch And Stop

Launch is not part of the first implementation. A future launch design should
use collaborative playbook templates rather than arbitrary prompt execution.
Template requirements include:

- fixed or policy-constrained worktree/cwd;
- provider allowlist;
- prompt variable schemas with type, length, character-set, path-normalization,
  and rendering-escape rules;
- issue/PR binding where relevant;
- budget cap and visible expected spend;
- default share-back policy minted by the owner node after launch, never by the
  collaborator;
- completion/review policy;
- no collaborator-controlled environment variables, permission-bypass flags,
  model flags, or arbitrary shell.

Stop remains `task.stop.request` until a future direct-stop gate defines
lifecycle binding, owner-visible emergency controls, and race tests. Delayed
direct stop must never terminate a recreated task with a newer lifecycle
version.

## Audit, Privacy, And Redaction

Split audit by boundary:

- **Owner-node audit** may contain owner-local attribution mappings that let
  the owner answer which verified device caused an event.
- **Relay diagnostics** contain only opaque routing IDs, coarse rejection
  reason classes, rate-limit counters, and correlation IDs.
- **Evidence exports** are redacted by default and contain no owner-local
  contact names unless the owner explicitly exports them.

Minimum owner-node audit fields:

- correlation ID;
- share ID;
- pseudonymous contact/device or guest member ID;
- local-only attribution pointer;
- request/frame kind and capability;
- target kind and target digest;
- session ID and session epoch where relevant;
- grant version;
- frame/request ID, sequence, issued/accepted/rejected timestamps;
- decision result and rejection reason class;
- byte counts and keyed payload digest, not payload text;
- permission prompt digest and class, not full arguments;
- owner override, revoke, or kill-switch reason;
- posture version and kill-switch state.

Logs, diagnostics, telemetry, and relay storage must not contain raw terminal
input, proposal plaintext, permission prompt contents, command payloads,
secrets, member tokens, device private keys, or plaintext encrypted envelopes.

## Revocation, Owner Override, And Rollback

Relay kill switches stop relay routing. Owner-node kill switches and revocation
tombstones are independently persisted and authoritative for local acceptance.
Owner nodes fail closed on missing, stale, wrong-identity, or kill-switched
signed relay posture, but local-only behavior remains separate.

Revocation sequence:

1. Owner node persists a grant tombstone or higher grant version.
2. Owner node stops accepting new frames for the old version.
3. Owner node rejects already-authorized frames at final apply boundaries.
4. Relay receives a control frame or short-poll invalidation and stops routing.
5. Collaborator UI receives a redacted or encrypted revocation result.

If revocation persistence fails, the owner node enters in-memory fail-closed
mode for that share and surfaces an incident state. If that state cannot be
persisted either, the owner node disables public mutation process-wide until
storage recovers.

Recovery from fail-closed requires all of the following:

- durable storage health restored;
- grant tombstones, replay/idempotency state, and request dedupe state loaded
  or resynchronized;
- fresh signed relay posture and session handshake;
- owner-node incident state acknowledged or cleared by policy.

Rollback SLOs:

- owner-node kill switch rejects new direct mutation frames within 1 second;
- relay kill switch rejects new routed mutation frames within 1 second;
- direct terminal input queues are drained or invalidated within 2 seconds;
- in-flight terminal backend writes perform a final grant-version check before
  writing;
- view-only sharing and terminal viewing survive mutation rollback where safe.

## Threat Model

| # | Threat | Mitigation |
|---|---|---|
| M1 | Guest proposals become direct mutation | Separate request protocol; Guest direct mutation rejected at relay and node. |
| M2 | Relay fabricates collaborator input | Contact direct mutation requires verified device signature and owner-node grant. |
| M3 | Delayed input lands in restarted session | Frames bind `sessionId + sessionEpoch`, expire quickly, and re-check at write boundary. |
| M4 | Permission approval answers a different prompt | Prompt binding includes prompt ID, provider, class, canonical args digest, session, and epoch. |
| M5 | Revoked grant resurrects through retry | Monotonic grant versions, tombstones, durable replay state, and idempotency checks. |
| M6 | Guest label impersonates contact | UI and audit distinguish verified contact devices from unverified guest sessions. |
| M7 | Proposal text injects UI or terminal controls | Owner UI renders proposals inertly and escapes control sequences. |
| M8 | Audit redaction prevents incident response | Owner-local attribution mapping is retained separately from redacted exports. |
| M9 | Two collaborators interleave terminal bytes | Direct input requires a single-writer input lease. |
| M10 | Launch template enables arbitrary remote execution | Launch is future-gated and template variables are schema-constrained. |
| M11 | Mutation stays enabled during relay incident | Signed posture and relay/owner kill switches fail closed. |
| M12 | Frontend disabled controls are mistaken for enforcement | Owner-node state transitions enforce pause/revoke before UI reports success. |

## Requirements

### Security

1. Collaboration requests and direct mutation frames are separate protocols.
2. Guest Link direct mutation is rejected by default at relay and node.
3. Contact Share direct mutation requires verified contact identity and device
   keys.
4. Direct mutation frames are signed, sequenced, expiring, grant-version-bound,
   and payload-encrypted to the owner node/device.
5. Direct terminal and permission mutations bind `sessionId + sessionEpoch`.
6. Permission responses bind prompt ID, provider, permission class, canonical
   arguments digest, prompt creation time, session ID, and session epoch.
7. Owner-node authorization is required before any public mutation is applied.
8. Owner denial, revoke, pause, and kill switch override collaborator actions.
9. Audit persistence failure fails closed for high-risk direct mutation.
10. Relay logs, node logs, evidence exports, and diagnostics redact payloads.

### Product

11. Owner has a first-class review queue for proposals, annotations, attention
    markers, grant requests, and stop requests.
12. UI clearly distinguishes verified Contact Share requests, verified Contact
    Share direct mutation, and unverified Guest Link requests.
13. Owner can see, pause, downgrade, revoke, mute, or block collaborator
    activity.
14. Collaborators see whether an action is proposed, pending owner review,
    applied, edited-and-applied, rejected, expired, muted, revoked, or blocked.
15. Shared-task surfaces never show local-only controls unless the share grant
    actually supports the action.

### Operational

16. Hosted relay has global and per-tenant public-mutation kill switches.
17. Synthetic probes cover request routing, direct-mutation rejection, Contact
    Share signature validation, prompt binding, revocation, rollback, restart,
    and audit redaction before hosted enablement.
18. Mixed-version rollout is reject-by-default: old relays reject mutation
    frames and owner nodes refuse relays without fresh signed
    `public-collaboration-request.v1` / `public-direct-mutation-frame.v1`
    posture support.
19. With no relay configured, local terminal input, permission approval, launch,
    and stop remain unchanged. With a relay configured but public mutation
    disabled, view-only and terminal-viewing paths remain available according
    to their own gates.
20. No direct public mutation capability is enabled by default after deployment.

## Acceptance Tests And Drills

1. **Protocol split.** Guest Link request frames cannot be parsed or upgraded
   as direct mutation frames.
2. **Guest direct mutation denial.** Guest attempts for direct terminal input,
   permission response, launch, and direct stop are rejected at relay and node.
3. **Guest proposal inertness.** Guest proposal text is not persisted plaintext
   at the relay, renders inertly in owner UI, and cannot inject terminal
   controls or markup.
4. **Owner review lifecycle.** Proposal, annotation, grant request, attention
   marker, and stop request move through exact states `received`, `visible`,
   `applying`, `ownerApplied`, `ownerEditedAndApplied`, `applyFailed`,
   `ownerRejected`, `expired`, `muted`, `senderBlocked`, and `shareRevoked`
   with transition guards.
5. **Contact signature coverage.** Mutating any signed field after signing
   rejects a Contact Share direct mutation frame.
6. **Grant scope.** A grant for Alice/device A cannot be used by Alice/device
   B, Bob/device A, another share, another task, or another session epoch.
7. **Freshness and idempotency.** Expired frames, future-issued frames, old
   sequences, old grant versions, duplicate idempotency keys with different
   digests, collaboration request replays, and replay after restart are
   rejected.
8. **Terminal write-boundary revoke.** Revocation after authorization but
   before terminal backend `write()` prevents the write.
9. **Input lease.** Two direct-input collaborators cannot interleave bytes into
   the same terminal subject.
10. **Prompt binding.** Permission approval for prompt A cannot answer prompt B,
    the same prompt with changed canonical arguments, an unknown provider, or a
    prompt after local expiration; classifier/canonicalization version changes
    invalidate old responses.
11. **Owner override race.** Owner denial or revoke wins over in-flight
    collaborator approval, including when audit persistence fails.
12. **Audit redaction and attribution.** Relay diagnostics and evidence exports
    omit payloads and local names; owner-local audit can map a verified device
    to the action.
13. **Launch confinement.** Future launch templates reject attempts to alter
    cwd, provider, environment, permission flags, prompt text outside allowed
    variables, or share-back grants.
14. **Stop lifecycle binding.** Future direct stop cannot terminate a recreated
    task with a newer lifecycle version.
15. **Posture fail-closed.** Missing, stale, wrong-identity, or kill-switched
    relay posture disables public mutation while preserving unrelated local
    behavior.
16. **Rollback drill.** Global and per-tenant kill switches reject new mutation
    frames within 1 second and invalidate queued direct input within 2 seconds.
    Recovery requires restored durable state, fresh posture, and explicit
    incident clearance.
17. **Local-only smoke.** With no relay configured, existing local terminal
    input, permission approval, launch, and stop behavior is unchanged.
18. **UI distinction.** Verified contact requests, verified contact direct
    mutation, and guest requests have distinct visible states.

## Phasing

### Phase M0 - Rejection Baseline And Review Queue Contract

- Add contracts for `PublicCollaborationRequest` and direct mutation rejection.
- Add relay/node rejection tests for every direct mutation capability.
- Add owner-review queue state model and inert rendering tests.
- Add request dedupe/replay, guest MAC ownership, payload-size, pending-item,
  quota, mute/block, and storage-failure tests.
- Add redacted audit schema for attempted direct mutation and collaboration
  requests.

### Phase M1 - Owner-Reviewed Collaboration

- Enable Contact Share proposals, annotations, attention markers, grant
  requests, and stop requests.
- Enable Guest Link comments/attention markers and, if abuse controls pass,
  owner-reviewed terminal-input proposals.
- Owner applies proposals through existing local paths.

### Candidate Future Gate - Contact Direct Terminal Input

- Require terminal-view grant, single-writer input lease, byte allowlist,
  owner pause, budget visibility, write-boundary revocation, restart tests,
  and rollback drill.

### Candidate Future Gate - Permission Response

- Start with deny-only.
- Require provider classifier, canonical prompt binding, owner override,
  audit-failure tests, and explicit approval taxonomy before any collaborator
  approval.

### Candidate Future Gate - Launch And Direct Stop

- Launch requires collaborative playbook-template design.
- Direct stop requires lifecycle binding and owner-visible emergency controls.

### Candidate Future Gate - Guest Direct Mutation

- Out of scope unless a later RFC defines relay-independent guest client
  integrity. Until then, Guest Link remains request/proposal-only.

## Files To Change In A Future Implementation

- `src/remote/share-contract.ts` - collaboration request, direct mutation
  frame, grant, replay, and audit DTOs.
- Owner-node collaboration/mutation service - review queue, grant ledger,
  revocation tombstones, replay/idempotency state, prompt binding, and audit.
- Server WebSocket/API ingress - thin schema/envelope parsing and forwarding to
  the owner-side service; routes must not own grant, replay, prompt-binding, or
  revocation policy.
- Adapter boundaries - narrow local ports for input, permission response, stop,
  and launch without collaborator policy leakage.
- Shared-task frontend views - review queue, proposal application, active
  collaborator controls, blocked reasons, and verified/unverified state.
- `relay/server.ts` - request routing, schema rejection, rate limits, posture,
  diagnostics redaction, and kill-switch enforcement.
- Relay, remote, server, and Playwright tests - acceptance tests listed above.
- Hosted relay ops docs and probes - mutation readiness, rollback, restart,
  and audit redaction drills.

## Alternatives Considered

### A. One Universal Mutation Frame

Rejected. Guest requests, owner-reviewed proposals, direct terminal input,
permission responses, launch, and stop have different authority. One frame type
would blur non-mutating requests with direct mutation.

### B. Let Any Terminal Viewer Type

Rejected. Terminal viewing approval does not prove command authority. Typing
can mutate repositories, approve tools indirectly, leak secrets, and consume
budget.

### C. Allow Guest Link Direct Input With Warnings

Rejected. Warnings do not change the assurance model. A Guest Link is copyable
and the relay serves the browser code.

### D. Treat Permission Approval As Terminal Input

Rejected. Permission prompts are structured authorization events with prompt
IDs, canonical arguments, provider-specific classes, and owner override races.

### E. Relay-Enforced Mutation Policy

Rejected as the authority boundary. Relay checks are useful defense in depth,
but the owner node owns the task, terminal, prompt, local policy, and final
decision.

### F. Arbitrary Remote Launch

Rejected. Public launch must be template/playbook-based so the owner controls
project, provider, prompt shape, worktree policy, budget, and safety flags.

## Open Questions

1. Should Guest Link terminal-input proposals ship in M1, or should Guest Link
   start with comments and attention markers only?
2. Should direct terminal input default to line mode forever, or can raw mode be
   justified for verified contacts after a separate explicit grant?
3. Which permission classes, if any, should move from deny-only to collaborator
   approval in a later implementation?
4. What default budget cap should apply to collaborator-triggered work?
5. How long should owner-local attribution mappings be retained before
   privacy-driven pruning?

## Critic Feedback Incorporated

- Initial phase-6 draft 2026-05-19: separated Contact Share mutation from
  Guest Link requests, made Guest direct mutation out of scope for v1, added
  signed freshness-bound mutation frames, permission-prompt binding, owner
  override, audit redaction, acceptance tests, and rollback drills.
- Round 1 / boundary-critic 2026-05-19: incorporated. Split collaboration
  requests from direct mutation, named owner-node authority boundary, kept
  adapters and session publication out of collaborator policy, separated relay
  diagnostics from owner-node audit, and clarified frontend non-authority.
- Round 1 / failure-mode-analyst 2026-05-19: incorporated. Added signature
  coverage, binary Contact Share encryption requirement, durable replay state,
  idempotency algorithm, restart fail-closed behavior, write-boundary
  revocation, canonical prompt binding, inert guest proposal rendering, and
  concrete rollback SLOs.
- Round 1 / design-minimalist 2026-05-19: incorporated. Made owner-reviewed
  collaboration the normative first surface, demoted direct input, permission
  approval, launch, and direct stop to candidate future gates, removed
  `previousFrameDigest`, and avoided a universal mutation frame.
- Round 1 / socratic-challenger 2026-05-19: incorporated. Resolved ambiguous
  stop/request taxonomy, guest authentication, digest sensitivity, encryption
  scope, idempotency retention, permission classifier ownership, prompt state
  machine, launch variable validation, incident fail-closed behavior, and local
  versus relay-configured behavior.
- Round 1 / ambition-amplifier 2026-05-19: incorporated. Made the owner review
  queue, annotations, attention markers, Guest Link request path, budget
  visibility, input leases, permission taxonomy, and guest-integrity milestone
  first-class design points while preserving direct mutation safety gates.
- Round 2 / boundary-critic 2026-05-19: incorporated. Clarified that guest
  request MACs are owner-node minted and verified, and that server ingress is
  thin parsing/routing rather than an authority boundary.
- Round 2 / failure-mode-analyst 2026-05-19: incorporated. Added request-path
  replay/idempotency, encrypted request payloads, guest abuse limits, atomic
  audit/replay persistence, and classifier/canonicalization version binding.
- Round 2 / design-minimalist 2026-05-19: incorporated. Kept M0 to contracts,
  state models, rejection tests, and inert rendering; left full UX/persistence
  work to M1 and future gates.
- Round 2 / state-machine-verifier 2026-05-19: incorporated. Added applying
  and apply-failure states, direct mutation attempt states, idempotency-before-
  sequence ordering, prompt-race precedence, and fail-closed recovery guards.
- Pre-PR correctness review 2026-05-19: incorporated. Limited direct-input
  downgrade to benign policy failures, made revocation/posture/audit/storage
  failures reject fail-closed, clarified relay-blind guest MAC delivery, and
  aligned lifecycle acceptance-test state names with the normative lifecycle.
