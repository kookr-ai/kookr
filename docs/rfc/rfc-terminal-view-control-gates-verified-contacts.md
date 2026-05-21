# RFC: Terminal View And Control Gates For Verified Contacts

## Status

Draft (v1)
Date: 2026-05-21
Author: Jean Ibarz (with Codex)

---

## Problem

Private-network Contact Share now has a narrow, useful shape: verified
contact/device pairing, view-only task sharing, safe task projections,
revocation tombstones, local diagnostics, and metadata audit. That baseline is
intentionally not terminal sharing and not remote control.

Issue #545 asks for the follow-up design before terminal or control work
begins. The risk is that "verified contact" becomes an implicit permission to
watch terminal bytes, send terminal input, approve permission prompts, stop
tasks, or submit commands. Those are different authority levels from viewing a
safe task projection. Agent terminals may contain secrets, credentials,
private repo content, half-written prompts, shell state, and permission
dialogs that can mutate the owner's machine.

This RFC defines the gates that must exist before any verified-contact
terminal viewing or control implementation starts.

## Recommendation

Keep **view-only task sharing** separate from **terminal viewing** and
**control**. A verified contact/device is necessary for terminal or control
capabilities, but it is not sufficient. Each capability requires:

- an explicit owner grant for a specific task/session subject;
- time-bounded scope;
- local owner-node authorization at every use;
- revocation checked at publication and apply boundaries;
- metadata-only audit;
- owner-visible emergency stop;
- capability-specific tests and rollout gates.

Adopt a separate **trusted operator tier** for direct control. Do not require
enterprise policy primitives for personal verified-contact terminal viewing,
terminal-input proposals, or owner-reviewed requests. Enterprise policy is a
later overlay for organizations that need SSO, managed device posture,
centralized audit export, break-glass policy, or tenant-wide kill switches.

Recommended capability sequence:

1. `viewTask` remains the only Contact Share capability in the current slice.
2. `terminal.view.live` adds live terminal viewing only, with owner demand
   proof and no replay persistence by default.
3. `terminal.input.proposal` adds collaborator text proposals that the owner
   reviews and applies locally.
4. `terminal.input.direct` becomes available only to trusted operators after
   input leases, byte policy, and emergency stop gates pass.
5. `task.stop.request` adds owner-reviewed stop requests.
6. `task.stop.direct` becomes available only after lifecycle binding and
   emergency stop recovery tests pass.
7. `remoteCommand.submit` remains blocked until command taxonomy, template or
   allowlist constraints, idempotency, replay defense, and abuse tests pass.
8. `permission.deny` may be evaluated before `permission.approve`.
   `permission.approve` is blocked until prompt binding and provider-specific
   permission taxonomy exist.

## Non-Goals

- No terminal viewing or direct control implementation in the issue that adds
  this RFC.
- No expansion of current view-only Contact Share grants.
- No Guest Link direct control.
- No relay-side authority to grant terminal or control access.
- No offline queue for raw terminal bytes, permission decisions, stop, launch,
  or command execution.
- No arbitrary remote shell or project filesystem access.
- No remote permission bypass. A collaborator cannot exceed what the local
  owner could approve.

## Capability Model

Capabilities are intentionally narrow:

```ts
type VerifiedContactCapability =
  | 'viewTask'
  | 'terminal.view.live'
  | 'terminal.input.proposal'
  | 'terminal.input.direct'
  | 'permission.deny'
  | 'permission.approve'
  | 'task.stop.request'
  | 'task.stop.direct'
  | 'remoteCommand.submit';
```

Capability families:

| Family | Examples | Authority level |
|---|---|---|
| View-only task sharing | `viewTask` | Safe projection only; no terminal bytes or mutation |
| Terminal observation | `terminal.view.live` | Sensitive read access; no writes |
| Owner-reviewed requests | `terminal.input.proposal`, `task.stop.request` | Inert until owner applies |
| Direct terminal control | `terminal.input.direct` | Writes bytes to a live agent session |
| Permission control | `permission.deny`, `permission.approve` | Mutates provider permission flow |
| Task/command control | `task.stop.direct`, `remoteCommand.submit` | Mutates task lifecycle or command surface |

`viewTask` must remain useful without any terminal/control capability. UI,
API, and storage must avoid representing "shared task" as a bundle that
implicitly includes terminal access.

## Trust Tiers

Verified contacts are identity-bearing, but direct control needs a stronger
owner decision. Use these tiers:

| Tier | Principal | Allowed capabilities |
|---|---|---|
| Verified viewer | verified contact device | `viewTask`; eligible for `terminal.view.live` after explicit grant |
| Verified requester | verified contact device | viewer capabilities plus proposals and owner-reviewed requests |
| Trusted operator | verified contact device plus owner operator grant | direct terminal input, direct stop, and later constrained remote commands |
| Enterprise managed operator | trusted operator plus tenant/device policy | same direct capabilities, constrained by org policy overlay |

The **trusted operator** tier is a separate trust tier, not an enterprise-only
primitive. Personal users should be able to grant a family member or trusted
collaborator temporary control without deploying SSO. Enterprise policy
primitives are still required before commercial multi-user deployment because
they add central revocation, audit export, managed device posture, and
tenant-wide kill switches.

Guest Link remains below these tiers. Guest members may submit owner-reviewed
requests only after separate abuse controls; they are not eligible for direct
mutation.

## Grant Contract

Every terminal/control grant is subject-bound, time-bound, and version-bound:

```ts
type ContactCapabilityGrant = {
  schemaVersion: 'contact-capability-grant.v1';
  grantId: string;
  contactId: string;
  deviceId: string;
  trustTier: 'verifiedViewer' | 'verifiedRequester' | 'trustedOperator';
  capabilities: VerifiedContactCapability[];
  subject:
    | { kind: 'task'; taskId: string; taskRevision: number }
    | { kind: 'session'; taskId: string; sessionId: string; sessionEpoch: number };
  issuedAt: string;
  expiresAt: string;
  maxIdleMs: number;
  grantVersion: number;
  ownerApprovalId: string;
  reason?: string;
};
```

Rules:

- Default grant lifetime is short. Direct control should default to minutes,
  not days.
- Grants expire on task completion, task cancellation, session epoch change,
  device revocation, share revocation, emergency stop, or owner kill switch.
- A grant cannot be widened in place. Adding capabilities or extending expiry
  creates a new owner approval and grant version.
- Revocation tombstones are durable and checked before every terminal
  publication and before every mutation apply.
- Owner-node receive time is authoritative for expiry and skew checks.

## Owner Approval

Owner approval is required for every terminal/control grant.

Minimum approval UI requirements:

- names the contact and device fingerprint;
- names the task/session subject;
- lists exact capabilities;
- shows expiry and idle timeout;
- explains whether terminal bytes may contain secrets;
- provides approve, deny, and approve-with-shorter-time options;
- records a metadata-only audit event for approve, deny, expiry, and revoke.

Approval must be repeatable after restart. If owner-node storage cannot
persist the approval and grant atomically, the approval fails closed.

Direct control grants require an additional "trusted operator" confirmation
that is distinct from terminal viewing. The UI must not allow a single click
to escalate from view-only task sharing to direct terminal input.

## Terminal Viewing Gate

`terminal.view.live` can ship only after these gates pass:

- verified contact/device authentication for every subscription;
- explicit owner grant bound to task/session and expiry;
- session epoch binding so stale views do not attach to a restarted session;
- demand proof: terminal bytes publish only while an authorized viewer has an
  active subscription;
- owner-node final authorization before subscribing to the local terminal
  backend;
- terminal frames encrypted and authenticated to the verified recipient device
  key, with relays, tunnels, and intermediate transports seeing ciphertext
  only;
- relay or transport metadata redaction;
- no durable persistence of terminal bytes by default;
- revocation immediately stops publication and clears viewer replay buffers;
- local dashboard terminal access remains unchanged when collaboration flags
  are disabled.

The terminal stream must remain separate from safe task projections. A shared
task can update normally while terminal viewing is disabled, expired, or
revoked.

## Owner-Reviewed Requests

Owner-reviewed requests are the preferred first control surface:

- `terminal.input.proposal` creates an inert review item containing proposed
  text.
- `task.stop.request` creates an inert review item asking the owner to stop a
  task.
- Future `grant.request` may ask for additional capability, but cannot grant
  itself.

The owner node applies proposals through the existing local owner path. Audit
must distinguish "owner typed this" from "owner applied collaborator proposal."

Request controls:

- payload encrypted to the owner node;
- terminal control sequences rendered inert in review UI;
- persistent idempotency and dedupe;
- per-share and per-device rate limits;
- mute/block controls;
- expiry by owner-node receive time;
- no automatic retry after apply failure.

## Direct Control Gate

`terminal.input.direct` is the first high-risk direct mutation gate. It can
ship only after all of these exist:

- trusted-operator tier and separate owner confirmation;
- an active same-subject `terminal.view.live` grant for the same
  contact/device/session;
- single active controller lease per session;
- visible owner pause/resume state for the lease;
- byte policy for paste size, binary/control bytes, bracketed paste, and
  multiline input;
- session epoch and grant-version binding on every frame;
- idempotent frame handling and replay rejection;
- owner-node audit state persisted before final apply;
- revocation, expiry, emergency stop, and owner pause rechecked immediately
  before `TerminalBackend.write`;
- local adapter errors surfaced to both owner and operator without retrying
  unsafe bytes automatically;
- rollback flag that disables new direct-control grants and rejects direct
  frames while preserving view-only sharing.

Direct terminal input is never queued while the node or session is offline.

## Task Stop Gate

`task.stop.direct` is a separate task-control gate, not a terminal-input
variant. It can ship only after these exist:

- trusted-operator tier and separate owner confirmation for direct stop;
- task lifecycle version and session epoch binding, when the task has a live
  session;
- final owner-node authorization immediately before applying the stop;
- stale task, stale session, already-terminal task, and wrong-subject
  rejection;
- grant-version, expiry, revocation, owner kill switch, and emergency stop
  checks at receive time and immediately before apply;
- idempotent result handling so duplicate stop frames return the same terminal
  attempt state without stopping a newer task/session;
- owner-visible audit state persisted before stop is applied;
- rollback flag that disables new direct-stop grants and rejects direct-stop
  frames while preserving view-only sharing and owner-reviewed stop requests.

Direct stop is never queued while the node or task is offline. If the task is
already terminal, the node records a no-op terminal result only when the frame
is otherwise authorized for that exact task lifecycle version.

## Permission And Remote Command Gates

Permission control and command submission are separate from terminal input.

`permission.deny` may be the first permission action because denial is safer,
but it still needs:

- prompt identity bound to session epoch;
- provider and prompt taxonomy;
- owner-visible audit;
- replay rejection;
- final prompt-liveness check at apply time.

`permission.approve` is blocked until:

- provider-specific permission prompts have stable machine-readable IDs;
- keyed prompt digest, provider/tool identifiers, redacted structured
  command/path scope, and risk class are captured in audit; raw prompt text
  and full arguments are not stored;
- collaborator approval cannot exceed local owner policy;
- unsafe local permission mode is detected and fails closed;
- tests mutate every prompt-binding field and require rejection.

`remoteCommand.submit` is blocked until commands are not arbitrary shell text.
Future designs may use owner-approved templates, constrained playbooks,
allowlisted action IDs, or typed commands. The gate requires:

- command taxonomy and schema;
- target subject binding;
- idempotency keys;
- replay rejection;
- dry-run or preview where applicable;
- budget and workspace policy;
- abuse tests for command injection, stale target, revoked grant, duplicate
  submit, and oversized payload.

## Audit, Revocation, And Emergency Stop

Audit is metadata-only. It must not store terminal bytes, prompts, command
payloads, secrets, raw access tokens, or plaintext encrypted request payloads.

Audit events must cover:

- grant requested, approved, denied, expired, and revoked;
- terminal view subscription accepted and denied;
- terminal publication stopped by expiry, revoke, emergency stop, or owner
  pause;
- proposal received, owner-applied, owner-edited-and-applied, rejected,
  expired, muted, or blocked;
- direct mutation accepted, rejected, apply-started, applied, apply-failed,
  superseded by revoke, and blocked by emergency stop;
- permission and remote-command attempts once those gates exist.

Emergency stop requirements:

- owner can stop all terminal/control publication for a task immediately;
- owner can revoke a contact device globally;
- owner can disable all terminal/control capabilities while preserving
  view-only task sharing if desired;
- emergency stop creates durable tombstones before reporting success;
- in-flight direct frames recheck tombstones before final apply;
- restart preserves emergency stop state;
- diagnostics explain blocked state without revealing terminal content.

## Tests And Rollout Gates

No terminal/control implementation may ship without tests named in its design
PR. Minimum gates:

### Terminal Viewing

- unit tests for grant expiry, session epoch mismatch, revoked grant, revoked
  device, wrong contact/device, and demand-proof absence;
- integration test proving terminal bytes are not published without an active
  authorized subscription;
- integration test proving revocation stops an active stream;
- restart test proving stale grants do not resurrect terminal publication;
- route-surface test proving collaboration peers cannot reach normal dashboard
  WebSocket or local terminal WebSocket routes;
- local-only smoke test with collaboration flags disabled.

### Owner-Reviewed Requests

- unit tests for encrypted payload requirement, idempotency, duplicate request
  handling, conflicting idempotency digest, expiry, mute/block, and payload
  size limits;
- UI or component tests proving proposal text is inert and control sequences
  are escaped;
- integration test proving owner-applied proposal uses the local owner input
  path and records collaborator attribution.

### Direct Control

- unit tests for lease acquisition/release, single-controller enforcement,
  pause/resume, grant-version mismatch, session epoch mismatch, expiry,
  revocation, emergency stop, replay, and idempotency;
- integration test proving final authorization is rechecked immediately before
  terminal write;
- integration test proving no offline queue for direct bytes;
- restart test proving active leases do not silently resume after crash;
- abuse tests for large paste, binary bytes, control sequences, stale frame,
  wrong subject, and revoked device.

### Direct Task Stop

- unit tests for task lifecycle mismatch, session epoch mismatch,
  already-terminal tasks, wrong subject, revoked grant, revoked device,
  expiry, emergency stop, owner kill switch, replay, and idempotency;
- integration test proving final authorization is rechecked immediately before
  stopping the task/session;
- integration test proving no offline queue for direct stop;
- restart test proving direct-stop grants and terminal no-op results do not
  resurrect stopped or already-terminal tasks;
- rollback test proving direct stop is disabled while view-only sharing and
  owner-reviewed stop requests remain available.

### Permission And Command Control

- prompt-binding tests for every signed/associated field;
- provider taxonomy tests for supported permission surfaces;
- unsafe-permission-mode fail-closed test;
- command-schema tests for injection, wrong target, stale target, replay,
  duplicate idempotency key, expiry, revoked grant, and oversized payload;
- audit-redaction tests.

Rollout gates:

1. Hidden feature flag with local-only smoke passing.
2. Dogfood on two private-network nodes with one verified contact.
3. Read-only terminal viewing only.
4. Proposal mode only.
5. Trusted-operator direct input for local private-network contacts only.
6. Self-hosted relay transport after relay envelope gates pass.
7. Hosted relay only after enterprise posture gates exist.

## Acceptance Criteria Mapping

- **View-only task sharing remains separate from terminal/control
  capabilities.** `viewTask`, terminal viewing, requests, and direct control
  are separate capabilities with separate grants.
- **Terminal/control work does not begin without consent, audit, revocation,
  and abuse handling.** Each capability family has approval, expiry,
  revocation, audit, emergency stop, replay, idempotency, and abuse gates.
- **The follow-up design names tests and rollout gates before
  implementation.** The RFC names minimum tests and staged rollout gates for
  terminal viewing, owner-reviewed requests, direct terminal control, direct
  task stop, permission actions, and remote commands.
