# RFC: Capability-Gated Playbook Parameters

## Status

**Draft (v4 — post-review revision, ready for user review)**

**Date:** 2026-05-19
**Author:** Jean Ibarz (with Claude)
**Issue:** [#506](https://github.com/kookr-ai/kookr/issues/506)
**Implementation branch:** `rfc/capability-gated-params`

---

## Problem

Playbook launch-form parameters render unconditionally. A parameter is shown
with the same affordances whether or not it can do anything on the host the
agent will run on.

The motivating case is a parameter that is only meaningful when the `kb` CLI is
installed — e.g. a `useKnowledgeBase` selector on `repository-idea-scout`. When
`kb` is absent, an `auto`/`off` selector is noise: both values produce
identical behavior. The user is asked to make a choice that cannot matter.

More generally, a playbook can declare `dependencies: [kb]` (advisory host
capabilities — see [`rfc-launch-dependency-incidents.md`](./rfc-launch-dependency-incidents.md)),
and a parameter may only be meaningful when one of those dependencies is
present. Today there is no link between a parameter and a dependency, and the
launch form has no host-capability state to react to.

**Honest framing — this is a low-urgency cosmetic problem with a narrow
beneficiary.** It was deferred from #505. A well-designed gated parameter
already self-degrades: an `auto` value behaves as `off` when the capability is
missing, so *nothing breaks* and *no agent run produces a wrong result*. #505
shipped a one-line description clarification instead of the parameter, and as
of this RFC there are **zero** `gatedBy` parameters in the codebase.

The beneficiary is specifically the user who *does not* have the capability:
they are the only one who sees an inert control. A user who has `kb` installed
sees no change at all. The win is therefore narrow — it removes a UX papercut
(a control that silently does nothing) for the subset of users least likely to
care about a `kb`-related parameter in the first place. That narrowness is the
core reason this RFC recommends deferring the build (see
[Recommendation](#recommendation)). The residual harm the mechanism addresses,
stated precisely:

1. A static description can say "needs `kb`"; it cannot say "`kb` is not
   installed *on this host*." Only a probe can.
2. A fully interactive multi-option selector still lets a user pick a value
   that silently does nothing, with no signal that their choice was inert.

This RFC therefore has two jobs: (1) decide *whether and when* to build the
mechanism, and (2) specify it concretely enough that, when the trigger fires,
implementation is a single small PR.

## Empirical Grounding

Round-1 critics raised a load-bearing claim: the cost of probing `kb` at
form-open time. The choice between progressive rendering and a blocking probe
hinges on it. Measured on the development host (2026-05-19, `kb` v0.2.2, index
present and healthy):

| Probe | Wall time | Notes |
|-------|-----------|-------|
| `kb --version` (×3) | **~0.5–0.6 s** | Node process startup dominates; output `0.2.2`. |
| `kb doctor --format=json` | **~1.8 s** | Internal `took_ms: 1249`; runs index/backend health checks. |
| Missing-binary spawn (`ENOENT`) | **~0.26 s** | Failure is detected fast. |

Findings that reshaped the design:

- **The probe is fast.** A presence check via `kb --version` is sub-second. The
  v1 draft's progressive-rendering machinery (a separate `hostCapabilities` WS
  message, store reset on every `listPlaybooks`, a `cwd`-echo staleness guard,
  request-id correlation, and mid-edit collapse reconciliation) was designed
  for a slow probe. It is **removed** — a sub-second probe can be awaited
  inside the playbook-list response.
- **`kb doctor` is the wrong probe for presence.** It is ~3× slower because it
  runs health checks. Presence only needs `ENOENT`-or-not, so the probe uses
  `kb --version`.

**Measurement limits — what was NOT verified** (`failure-mode-analyst`,
`socratic-challenger`): the measurements are one host, one run set, with `kb`
*healthy*. The feature targets the *absent* or *degraded* host. `ENOENT` was
measured directly (~0.26 s — fast). A *degraded* `kb` (locked or corrupt index,
cold cache) was not measured; `kb --version` should be index-independent, but
that is unverified. See [Open questions](#open-questions). The probe timeout
(`KB_PRESENCE_TIMEOUT_MS`, below) is the hard bound that caps the unmeasured
worst case.

A `kb`-grounded prior-art search was not run: the development host has `kb`
healthy, so a search would not exercise the absent path this RFC is about.

## Goals

- Let a playbook parameter declare it is only meaningful when a given launch
  dependency is present.
- Let the launch form reflect host-capability state: when a gated parameter's
  dependency is **absent**, make that visible at the parameter, before launch.
- Reuse the existing `dependencies` vocabulary and the existing `kb` tooling;
  do not invent a parallel capability system.
- Preserve discoverability: a user who *could* install the capability must
  still see the parameter exists.
- Probe only when the discovered catalog actually contains a gated parameter.

## Non-Goals

- **No server-side enforcement.** `gatedBy` is a form-rendering hint only. The
  launch service does not validate or rewrite gated parameter values, and
  `gatedBy` does not influence the launch-time advisory preflight (see
  [`gatedBy` and `dependencies` are independent](#gatedby-and-dependencies-are-independent)).
- **No conditional-visibility expression engine.** No `visibleWhen`, no boolean
  expressions over parameters. `gatedBy: <dependency>` is the whole surface.
- **No accurate capability state for remote-session targets** in v1. The probe
  runs on the Kookr server host. See [Remote sessions](#remote-sessions).
- **No new dependency types.** `LAUNCH_DEPENDENCIES` stays `['kb']`.
- **No change to the launch-time advisory preflight.** The post-submit advisory
  preflight in `launch-service.ts`, driven by a playbook's `dependencies`, is
  untouched. This RFC adds an independent presence probe at playbook-list time.
- **No `gatedBy` health-gating.** The probe gates on *presence*, never on index
  health — see [Presence, not health](#the-capability-signal--presence-not-health).
- **No `GET /api/playbooks` change.** That HTTP route also lists playbooks but
  has no launch-form consumer today, so it does not carry `capabilities`. If a
  form-rendering consumer of the HTTP route ever appears, route it through the
  same `preparePlaybookList` use-case; until then it is explicitly out of scope.

## Recommendation

**Adopt this design as the ready blueprint; do not implement until a real
consumer exists.**

There is no `gatedBy` parameter to gate. Building now would ship dead code: a
contract field nothing sets, a probe that never runs (the catalog's `gatedBy`
union is always empty), and form branches never taken. That is a YAGNI
violation.

**Trigger to build.** The trigger is a *proposal*, not a writable field
(`socratic-challenger`): a PR or issue proposing a playbook whose parameter
warrants `gatedBy` — one where self-degradation alone is judged insufficient.
The contributor does not need a pre-existing `gatedBy` field to make the
proposal; they describe the parameter in prose. The maintainer judges *at
proposal review* whether self-degradation is genuinely insufficient. If
accepted, the mechanism (this RFC) and the first consuming parameter land
**together** — one PR, or a mechanism PR immediately followed by the consumer
under the same author and review. The mechanism never merges without a
consumer, and the consumer's intent is judged before any code is written.

**Build-trigger precondition** (`socratic-challenger`): before building, verify
that the first consumer's agent runs on a host that shares `kb` resolution with
the Kookr server process. The probe measures *server-process* `kb` presence
(see [What the probe actually measures](#what-the-probe-actually-measures)).
Concretely, the build-trigger PR confirms both: (a) `kb` resolves on the Kookr
server process `PATH`, and (b) the agent adapter launches agents inheriting
that same `PATH` (not a divergent login shell, a worktree-relative `bin/`, or a
shell alias). If either fails for the first consumer, the probe will return a
confident wrong `absent` and the feature actively misleads — that consumer is
**not** a fit for `gatedBy` and should stay description-only.

This corrects the issue's "*second* capability-gated parameter" trigger. That
phrasing counted the never-shipped `useKnowledgeBase` parameter as the first;
the real count is zero.

**Discoverability and the closure clock** (`ambition-amplifier`,
`socratic-challenger`). A future author might reach for description-only
treatment simply because they never learn `gatedBy` is a designed option. To
break that circularity *without* building speculatively: accepting this RFC
SHALL include a one-line pointer to it in the playbook-authoring documentation
— a doc-only change, decoupled from the build. That pointer both advertises
`gatedBy` as a ready option and starts a well-defined clock: if 12 months pass
from the pointer landing with no `gatedBy` proposal, that is the signal that
self-degradation plus a good description is sufficient, and #506 is closed as
won't-do.

**On specifying without a consumer** (`socratic-challenger`): a blueprint
written without a concrete consumer risks specifying the wrong thing. The
mitigation is that the blueprint is deliberately small — one contract field,
one probe, one form branch — so the consuming PR can adjust it cheaply. The
implementation PR SHALL treat this RFC as a starting point and re-validate each
decision against the actual first consumer, not as a frozen spec.

The rest of this RFC is the design held ready.

## Requirements

- **R1.** A playbook parameter SHALL be able to declare a single launch
  dependency it is gated by, via an optional `gatedBy` field.
- **R2.** When a gated parameter's dependency is **absent** on the Kookr server
  host and the parameter has a default, the launch form SHALL render that
  parameter with its label and a visible annotation naming the missing
  dependency, and SHALL NOT render an interactive input control; the parameter
  submits its default value. A gated parameter with no default SHALL instead
  render its normal control plus the annotation (there is no safe value to pin
  to).
- **R3.** The form SHALL NOT hide a gated parameter outright — its label and
  annotation remain visible. Discoverability of the capability is preserved
  even when it is unavailable.
- **R4.** Host-capability state SHALL be probed on the Kookr server host and
  delivered to the client on the existing `playbooks` message. The frontend
  SHALL NOT shell out.
- **R5.** When no playbook in the discovered catalog declares any `gatedBy`
  parameter, the system SHALL run no capability probe.
- **R6.** The capability probe SHALL be bounded and resolve-only — it never
  rejects. When it cannot determine presence (timeout, permission error,
  non-executable binary, or any non-`ENOENT` failure), the dependency's
  capability SHALL be **omitted** from the `playbooks` message; the form SHALL
  treat an omitted capability as fail-**open** — the gated parameter renders
  interactively, as if the dependency were present. A wrongly-shown parameter
  is noise; a wrongly-collapsed parameter overrides the user's intended
  behavior.
- **R7.** `gatedBy` SHALL be a pure client-side rendering hint. Neither the
  launch service nor the launch-time advisory preflight SHALL read, validate,
  or rewrite anything based on it.
- **R8.** A `gatedBy` value SHALL be validated at parse time against
  `LAUNCH_DEPENDENCIES`. An unknown value SHALL be a fatal parse error,
  consistent with how `dependencies` entries are already validated.

## Design

### Why the value matters only when the capability is present

`socratic-challenger` asked the design to "pick a lane": if gated parameters
self-degrade, does their value matter or not? It is conditional, and that
resolves cleanly:

- **`kb` absent** — the parameter's value is *moot*. `auto` ≡ `off`. Removing
  the inert control removes a meaningless choice. This is the cosmetic win.
- **`kb` present** — the parameter's value *matters*. Picking `off` instead of
  `auto` genuinely changes the agent run. The form must stay interactive.
- **`kb` unknown** (probe could not determine) — the value *might* matter. Fail
  open: a wrongly-collapsed parameter would silently override the user's
  intended behavior on a host where the capability actually works. R6 is
  therefore not arbitrary caution; it protects user intent in the case where
  the value is load-bearing.

In the unknown case the form stays fully interactive with **no annotation**.
This is a deliberate v1 choice (`socratic-challenger` noted it re-creates, for
that case, the silent-inert-control problem #506 is about): an `undefined`
probe result is rare — it requires a timeout, a permission error, or a broken
binary — and a tentative "could not verify `kb`" note risks confusing more
users than it helps, since most readers cannot act on "unverified." A softer
advisory note for the unknown case is recorded as a possible refinement in
[Open questions](#open-questions).

### The capability signal — presence, not health

The probe answers one question: *would this parameter do anything at all?* —
not *is `kb` healthy?*

```ts
// src/shared/contracts/messages.ts — beside the `playbooks` message
export type HostCapability = 'available' | 'absent';
```

- **`available`** — a `kb` executable on the server `PATH` spawned and ran (any
  exit code). The parameter stays interactive *even if `kb`'s index is empty or
  degraded*: the agent still attempts KB use and gets the existing launch-time
  advisory degradation path, so the parameter is still meaningful. Gating on
  health would over-collapse and hide a parameter that works.
- **`absent`** — no `kb` binary on the server `PATH` (spawn fails with
  `ENOENT`).
- *Unknown* is **not** a member of the type. It is encoded as the dependency
  key being **omitted** from the capabilities map. The form treats an omitted
  key as fail-open. This keeps the type two-valued.

`HostCapability` lives in `messages.ts`, not `playbook.ts`: it is a runtime
host observation carried by a WS message, not part of the static playbook
authoring schema (`boundary-critic`).

### Server: the presence probe

`probeKbPresence` is added in a new module, `src/server/launch-capability-probe.ts`,
**not** in `launch-dependency-runner.ts`. That file already owns launch-time
*health* probing (`kb doctor`, post-submit); a form-time *presence* probe is a
different lifecycle point, a different command, and a different caller. Putting
the two spawn patterns in one file degrades its cohesion (`boundary-critic`).

The probe does **not** reuse the existing `execFileBounded` helper: that helper
rejects *only* on `ENOENT` and **resolves** on every other failure (timeout,
`EACCES`, non-zero exit), which would silently classify a broken or hung binary
as `available` (`ambition-amplifier`, `boundary-critic`). The probe needs
explicit error-code classification:

```ts
import { execFile } from 'node:child_process';

const KB_PRESENCE_TIMEOUT_MS = 1_500; // kb --version measured ~0.5s; 3× headroom, caps list delay

/** Resolve-only (R6): never rejects. */
export function probeKbPresence(): Promise<HostCapability | undefined> {
  return new Promise((resolve) => {
    execFile(
      'kb', ['--version'],
      { timeout: KB_PRESENCE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error) => {
        if (!error) return resolve('available');               // ran, exit 0
        const e = error as NodeJS.ErrnoException;
        if (e.killed) return resolve(undefined);               // timed out → unknown (check first)
        if (e.code === 'ENOENT') return resolve('absent');     // not on PATH
        if (e.code === 'EACCES' || e.code === 'ENOEXEC')
          return resolve(undefined);                           // broken binary → unknown
        // Any other error — a numeric non-zero exit code, or an unenumerated
        // OS error — means *some* `kb` ran. Fail open: 'available'.
        return resolve('available');
      },
    );
  });
}
```

Notes: `e.killed` is checked **before** `e.code` because a timeout is the more
dangerous misclassification and a timed-out spawn does not carry
`code: 'ENOENT'`. `maxBuffer` is set explicitly (mirroring `execFileBounded`) so
a flooding binary surfaces as a handled error rather than an unbounded read.
`kb --version` is the [empirically](#empirical-grounding) chosen presence
command; `KB_PRESENCE_TIMEOUT_MS` is 1.5 s — 3× the measured ~0.5 s, generous
for a cold or loaded host, and the hard cap on how long a slow `kb` can delay
the playbook list.

### Server: the playbook-list use-case

Probe orchestration is a use-case concern, not WS-dispatch logic
(`boundary-critic`). Add `src/server/use-cases/playbook-list.ts`:

```ts
// Exhaustive over LaunchDependency: adding a member to the union without
// wiring a probe here is a compile error (failure-mode-analyst).
const CAPABILITY_PROBES: Record<LaunchDependency, () => Promise<HostCapability | undefined>> = {
  kb: probeKbPresence,
};

export async function preparePlaybookList(cwd: string): Promise<{
  playbooks: Playbook[];
  capabilities?: Partial<Record<LaunchDependency, HostCapability>>;
}> {
  const playbooks = await discoverPlaybooks(cwd);

  // R5: probe only the dependencies that some discovered parameter gates on.
  const gatedDeps = new Set<LaunchDependency>();
  for (const pb of playbooks)
    for (const p of pb.parameters)
      if (p.gatedBy) gatedDeps.add(p.gatedBy);
  if (gatedDeps.size === 0) return { playbooks };

  const capabilities: Partial<Record<LaunchDependency, HostCapability>> = {};
  await Promise.all([...gatedDeps].map(async (dep) => {
    const status = await CAPABILITY_PROBES[dep]();   // probes are resolve-only (R6)
    if (status) capabilities[dep] = status;          // omit unknown → fail open
  }));
  return { playbooks, capabilities };
}
```

Because `probeKbPresence` is resolve-only by contract (R6), `preparePlaybookList`
cannot reject *because of the probe* — no defensive `try/catch` around the
probe is needed, and adding one would be theater around a call that cannot fail
(`failure-mode-analyst`). The only rejection source is `discoverPlaybooks`. This
RFC does **not** change `discoverPlaybooks`'s failure behavior: a rejection
propagates out of `preparePlaybookList` exactly as it propagates out of the WS
handler today — *provided* the optional handler `try/catch` below is not added.
Adding that `try/catch` is a deliberate, separate change.

The `listPlaybooks` WS handler has no `try/catch` today (unlike `launchPlaybook`)
— a pre-existing gap, flagged here but neither caused nor owned by this RFC. The
implementation PR *may* close it by mirroring `launchPlaybook`'s error handling;
doing so is independent of capability gating.

`Promise.all` over `gatedDeps` keeps probe fan-out parallel rather than serial —
relevant only if a second `LAUNCH_DEPENDENCIES` member is ever added.

### Server: WS handler

`src/server/ws-handlers/playbook-handler.ts`, `listPlaybooks` case, becomes a
thin dispatcher:

```ts
const { playbooks, capabilities } = await preparePlaybookList(msg.cwd);
this.deps.send({ type: 'playbooks', cwd: msg.cwd, playbooks, capabilities });
```

### Why bundle into `playbooks` instead of a separate message

The v1 draft used a separate, later `hostCapabilities` message so the list
could render before the probe finished. The [empirical probe](#empirical-grounding)
shows the probe is sub-second; at that cost a separate message is not worth its
carrying cost — a new protocol message, a new store action, a store reset on
every `listPlaybooks`, a `cwd`-echo guard, request-id correlation, and a
mid-edit collapse race. Bundling the result onto the `playbooks` message
deletes all of that:

- **One render, always correct.** The form is never shown before capabilities
  are known, so there is no late collapse and no discarded mid-edit value.
- **No reset logic.** `capabilities` is replaced wholesale with each `playbooks`
  message, exactly like `playbooks` itself.
- **No separate staleness machinery.** Capability state shares the playbook
  list's lifetime — see [Staleness](#staleness).

The cost is latency: when the catalog contains a gated playbook, the
`playbooks` message waits for the probe — typically ~0.5 s, capped at
`KB_PRESENCE_TIMEOUT_MS` (1.5 s). A slow or hung `kb` makes 1.5 s the steady
state for that catalog, delaying the *entire* list (gated and non-gated
playbooks alike). This is the honest worst case. It is bounded, and by R5 it
applies only to catalogs that actually contain a gated playbook — every catalog
today is unaffected.

### Staleness

`LaunchTaskDialog` skips `listPlaybooks` when its 30-second playbook cache is
fresh. There are **two** such freshness (`isFresh`) checks in that component;
both reuse cached `playbooks` and would reuse cached `capabilities`, and both
must carry the rule below (`failure-mode-analyst`).

A cached **`absent`** is the only capability state whose staleness harms the
user: a user who installs `kb` specifically to use a gated parameter and
reopens the dialog would otherwise face a dead, non-interactive control for up
to 30 s (`socratic-challenger`). The freshness check is therefore extended with
one clause: **a cache entry whose `capabilities` contains any `absent` is
treated as stale**, forcing `listPlaybooks` — and thus a re-probe — on the next
dialog open. The re-probe is the same ~0.5 s presence check.

A stale **`available`** (the user *removed* `kb`) is harmless — it degrades to
today's interactive-but-inert control — and may remain cached for the normal
30 s. Net effect: a wrong `absent` never survives past one dialog reopen, and a
wrong `available` is no worse than today. This is one clause in an existing
condition, not new staleness machinery.

### `gatedBy` and `dependencies` are independent

`gatedBy` is **not** folded into the playbook's `dependencies` set. An earlier
revision proposed that fold to guarantee the form and the launch-time advisory
"agree"; it was removed because it silently opted a playbook into a ~1.8 s
`kb doctor` launch-time preflight it had not declared, contradicting R7 and the
"no change to the launch-time advisory preflight" Non-Goal (`failure-mode-analyst`,
`socratic-challenger`).

They are independent opt-ins and do not need to agree, because they answer
different questions at different times:

- `dependencies: [kb]` → the launch-time advisory probes `kb` *health* after
  submission and may attach a degradation note to the agent session.
- `gatedBy: kb` on a parameter → the form probes `kb` *presence* at list time
  and removes an inert control.

A playbook may reasonably want one without the other. The form makes no claim
about the advisory; it states only "this parameter has no effect because `kb`
is absent," which is true regardless of whether `dependencies` is declared. An
author who wants both behaviors declares both; the authoring documentation
should recommend that pairing, but the parser does not enforce it.

### Contract

`src/shared/contracts/playbook.ts`:

```ts
export interface PlaybookParameter {
  // ...existing fields...
  /** Launch dependency this parameter is meaningful only when present.
   *  Pure form-rendering hint; not enforced server-side. */
  gatedBy?: LaunchDependency;
}
```

`src/shared/contracts/messages.ts` — `HostCapability` (above) plus an optional
field on the `playbooks` message:

```ts
| { type: 'playbooks'; cwd: string; playbooks: Playbook[];
    capabilities?: Partial<Record<LaunchDependency, HostCapability>> }
```

`Partial<Record<LaunchDependency, HostCapability>>` is keyed off the canonical
`LaunchDependency` union deliberately: a second `LAUNCH_DEPENDENCIES` member
widens the map automatically, with no field-shape change. (`design-minimalist`
suggested `{ kb?: HostCapability }`; rejected — that hardcodes a member name
the codebase already abstracts behind the union.)

### Parser

`src/core/playbook-parser.ts` reads `gatedBy` from each parameter's
frontmatter inside `parseParameters`. `parseParameters` currently ignores
unknown frontmatter fields silently; this adds a new explicit validation: the
`gatedBy` string is checked against the `LAUNCH_DEPENDENCIES` allowlist (the
same set `parseLaunchDependencies` validates against), and an unknown value
raises a fatal `PlaybookParseError` — consistent with how unknown `dependencies`
entries are already rejected. No `dependencies` fold, no cross-field warning.

### Frontend

- Store: the WS dispatcher (`src/frontend/hooks/useWebSocket.ts`, `case
  'playbooks'`) unpacks `{ playbooks, cwd, capabilities }` from the message;
  `handlePlaybooks` gains an optional third `capabilities` argument and stores
  it beside `playbooks`. No new action, no reset (the map is replaced with each
  message).
- `PlaybookParameterForm.tsx` reads `capabilities` from the store via
  `useKookrStore` — the same way it already reads `projectSummaries` — so no
  prop-drilling through `LaunchTaskDialog` is added. For each parameter:

  ```ts
  const status = param.gatedBy ? capabilities?.[param.gatedBy] : undefined;
  const collapsed = status === 'absent' && param.default != null;
  ```

  - **`collapsed`** — render the parameter's label and a muted annotation under
    it, e.g. `` `kb` not detected on host — this parameter has no effect. ``,
    and **no interactive control**. The submitted value resolves to
    `param.default`. Rendering only the annotation (rather than a disabled
    `<select>` still showing, say, the `auto` option) avoids foregrounding an
    option label that contradicts the annotation (`socratic-challenger`).
  - **`status === 'absent'` but no `default`** — render the normal control plus
    the muted annotation, so the user still learns the dependency is missing.
  - otherwise (`available` or omitted) — render exactly as today.

  `resolveParameterSource` is untouched: capability state is field
  *enablement*, not option *data*.

### What the probe actually measures

`probeKbPresence` runs `kb --version` in the **Kookr server process**, via
`execFile` (no shell). It reports whether *that process* sees a `kb` executable
on its `PATH`. This is correct for a launch whose agent runs on the same host
with the same environment — the common local case. It is **not** a guarantee
about the agent's environment in general. Divergence causes:

- a launched agent may run with a different `PATH` (login shell vs. server
  environment, a worktree-relative `bin/`; this repo itself carries a `bin/kb`
  symlink);
- `kb` may be a shell **alias or function** — `execFile` does not run a shell,
  so aliases and functions are never resolved, and such a `kb` probes `absent`
  even on the same host;
- a remote-session launch runs on a different host entirely.

`gatedBy` is therefore a **server-host heuristic**. R6 fail-open covers the case
where the probe *cannot run*. The residual risk is a *confident wrong `absent`*
— the server lacks `kb`, the agent environment has it — which removes a control
the user would have wanted. The [build-trigger precondition](#recommendation)
exists precisely to keep the first consumer out of that case.

### Why a separate probe from the launch-time advisory

`socratic-challenger` asked why the form needs its own probe when the
launch-time advisory already shells `kb`. Because they run at different
lifecycle points and answer different questions:

- the advisory runs `kb doctor` (*health*) **after** form submission — it
  cannot shape a form the user has already filled in;
- the form needs `kb` **presence** **at list time**, before the user sees the
  parameter.

There is no synchronization burden between them: one is presence, one is
health; neither consumes the other's result. The double-probe (form-open
presence + launch-time health) is two short server-side spawns at distinct
moments; it is accepted as-is. No caching or de-duplication is specified —
adding it would be premature optimization for a sub-second call.

### Remote sessions

`probeKbPresence` runs on the Kookr server host; for a launch targeting a
remote session host its result says nothing true. v1 scope: gate only when the
launch target is the server host. A remote-session launch renders gated
parameters interactively with no annotation (capabilities omitted → fail open).

A v2 remote probe is a clean extension — the remote command handler was split
out in commit `46f29865`, so running `kb --version` over the remote channel is
the same `ENOENT`-or-not check on a different exec path. It is kept out of v1
because v1 is a held-ready blueprint with no consumer; expanding it before one
local consumer exists is speculative. If the *first* consumer is a
remote-targeting playbook, the build-trigger PR should treat the v2 remote
probe as in-scope for that PR rather than shipping a locally-only mechanism
that is inert for its own first consumer (`ambition-amplifier`).

## Files to change

| File | Change |
|------|--------|
| `src/shared/contracts/playbook.ts` | Add `gatedBy?: LaunchDependency` to `PlaybookParameter`. |
| `src/shared/contracts/messages.ts` | Add `HostCapability` type; add optional `capabilities` to the `playbooks` message. |
| `src/core/playbook-parser.ts` | In `parseParameters`, parse `gatedBy`; fatal-validate against `LAUNCH_DEPENDENCIES`. |
| `src/server/launch-capability-probe.ts` *(new)* | `probeKbPresence` (`kb --version`, `KB_PRESENCE_TIMEOUT_MS`, resolve-only). |
| `src/server/use-cases/playbook-list.ts` *(new)* | `preparePlaybookList(cwd)`: discover, compute `gatedBy` union, probe (parallel, fail-open), assemble. |
| `src/server/ws-handlers/playbook-handler.ts` | `listPlaybooks` calls `preparePlaybookList`; send `capabilities` on `playbooks`. |
| `src/frontend/hooks/useWebSocket.ts` | `case 'playbooks'`: pass `msg.capabilities` as the third argument to `handlePlaybooks`. |
| `src/frontend/store/store-types.ts`, `slices/transport-session-slice.ts` | `handlePlaybooks` accepts + stores optional `capabilities`. |
| `src/frontend/components/LaunchTaskDialog.tsx` | Both `isFresh` checks treat a cached `absent` capability as stale (re-probe on reopen). |
| `src/frontend/components/PlaybookParameterForm.tsx` | Read `capabilities` from the store; collapse / annotate gated parameters. |
| Playbook-authoring docs | One-line pointer to this RFC / #506 (added on RFC acceptance, decoupled from the build). |

Tests: parser (`gatedBy` valid; unknown → fatal); `probeKbPresence` (`ENOENT` →
`absent`; exit 0 → `available`; non-zero exit → `available`; timeout/`killed` →
`undefined`; `EACCES` → `undefined`); `preparePlaybookList` (no gated playbook →
no probe, no `capabilities`; gated playbook + `absent` probe → `capabilities`
populated; `undefined` probe → key omitted); `PlaybookParameterForm` (collapsed
to annotation-only; annotated-but-interactive when no default; interactive when
`available` or omitted).

## Edge cases

- **No gated parameter in the catalog** — `gatedDeps` is empty; no probe runs.
  Every current catalog takes this path; the `playbooks` message carries no
  `capabilities`. (The handler does iterate playbook parameters to compute the
  empty union — negligible, but not literally zero work.)
- **Probe times out / hits a permission or exec error** — capability omitted;
  gated parameters render interactively (R6 fail-open). No annotation.
- **An unrelated executable named `kb` is on `PATH`** — it spawns and the probe
  returns `available`. The probe verifies *a binary named `kb` ran*, not that
  it is the real `kb`. This is fail-open-consistent: a wrongly-`available`
  parameter is interactive noise, no worse than today.
- **`kb` installed but its index is empty/degraded** — `available`; the
  parameter stays interactive. Form-gating is presence-only.
- **Reopen within 30 s after installing `kb`** — a cached `absent` is treated as
  stale, so the dialog re-probes; the gated parameter becomes interactive on
  the next open. See [Staleness](#staleness).
- **`gatedBy` references a value not in `LAUNCH_DEPENDENCIES`** — fatal parse
  error; the playbook does not load. Same severity as a bad `dependencies`
  entry.
- **`required` gated parameter with no `default`** — cannot be collapsed (no pin
  target); rendered with its normal control plus the "not detected" annotation.
  An authoring smell: a gated parameter should be optional with a self-degrading
  default. Documented, not enforced.
- **Probe-host ≠ agent-host** (worktree-relative `bin/kb`, divergent `PATH`,
  `kb` as a shell alias, remote target) — see
  [What the probe actually measures](#what-the-probe-actually-measures) and the
  [build-trigger precondition](#recommendation).
- **Second `LAUNCH_DEPENDENCIES` member added later** — the `CAPABILITY_PROBES`
  record is exhaustive over `LaunchDependency`, so adding a member without
  wiring its probe is a compile error.

## Open questions

- **Degraded-`kb` probe latency is unmeasured.** `kb --version` was timed only
  on a healthy host. If `kb`'s startup path ever touches a locked or corrupt
  index, `--version` could approach the 1.5 s timeout. The build-trigger PR
  SHALL re-measure `kb --version` against a degraded index and confirm the
  timeout is adequate (or adjust it). The timeout caps the worst case
  regardless, so this affects tuning, not correctness.
- **Soft note for the unknown case.** v1 shows no annotation when the probe
  result is `undefined` (interactive, silent). Whether a tentative "could not
  verify `kb`" note would help or merely add noise is left for the first
  consumer's UX review to decide against a real form.
- **`listPlaybooks` handler error handling.** Whether to add a `try/catch` to
  the `listPlaybooks` handler (mirroring `launchPlaybook`) is a pre-existing
  question independent of this RFC; the build-trigger PR may resolve it or
  leave it.

## Alternatives considered

### Convention over mechanism — require gated parameters to self-degrade

Mandate that any environment-sensitive parameter defaults to a self-degrading
value and document it in the description. Build no form mechanism. This is what
#505 did. **Accepted as the interim answer; rejected as the long-term one.** It
is *why* this RFC defers implementation. Its two gaps — a static description
cannot say "not on *this* host," and an interactive selector still lets the
user pick an inert value — are exactly what the mechanism closes, and exactly
the judgment call that constitutes the build trigger.

### Separate `hostCapabilities` WS message with progressive rendering

The v1 draft. Rejected after the [empirical probe](#empirical-grounding): a
~0.5 s probe does not need progressive rendering, and the separate message
drags in a store reset, a `cwd`-echo guard, request-id correlation, and a
mid-edit collapse race — all carrying cost for no user-visible benefit over a
bundled, awaited result.

### Probe on per-playbook-form-open instead of at list time

Probe only when the user opens a *specific* gated playbook's form. Rejected: it
reintroduces progressive rendering — render, then probe, then reconcile —
bringing back late-collapse and discarded-edit problems for no latency win,
since the list-time probe runs at all only when the catalog contains a gated
playbook.

### Fold `gatedBy` into the playbook's `dependencies` set

Considered to keep the form and the launch-time advisory consistent. Rejected:
it silently opts a playbook into a ~1.8 s `kb doctor` launch-time preflight,
contradicting R7 and a Non-Goal — see
[`gatedBy` and `dependencies` are independent](#gatedby-and-dependencies-are-independent).

### Reuse the launch-time advisory's presence detection

`kb doctor` already detects a missing binary. Rejected as a *replacement* for
the form-time probe: the advisory runs after submission and cannot shape the
form — see [Why a separate probe](#why-a-separate-probe-from-the-launch-time-advisory).

### Generalized `visibleWhen` expression engine

A conditional-visibility expression language over parameters and host state.
Rejected as over-engineering — one dependency, a presence test. `gatedBy`
covers the need with no parser, evaluator, or precedence rules.

### `gatedBy` as an array (multi-dependency AND-gating)

Make `gatedBy` accept `LaunchDependency | LaunchDependency[]` now, to avoid a
breaking schema change later. Rejected as YAGNI: `LAUNCH_DEPENDENCIES` has one
member, so an array can never hold two distinct dependencies. The
scalar→`scalar | array` widening is backward-compatible and can be done in the
same PR that introduces a second dependency.

### New dynamic parameter `source: kb-availability`

Collapse the options via a new dynamic source feeding `resolveParameterSource`.
Rejected: `source` is about option *data*; gating is about field *enablement*.
Overloading `source` muddies a clean seam and would not deliver the disabled
state or the annotation.

### Hide unavailable gated parameters

Rejected per the issue: hiding kills discoverability for users who could
install the capability. Keeping the label and annotation visible (R3) preserves
it.

### Build the mechanism now

Rejected — YAGNI. Zero `gatedBy` parameters means the contract field, probe,
and form branches are all dead on arrival. The design is held ready instead.

## Critic feedback incorporated

This RFC was revised over three rounds of parallel critic review
(`boundary-critic`, `failure-mode-analyst`, `design-minimalist`,
`socratic-challenger`; `ambition-amplifier` in rounds 1–2) plus a mandatory
empirical checkpoint.

**Empirical checkpoint** (2026-05-19): measured `kb --version` (~0.5 s),
`kb doctor` (~1.8 s), `ENOENT` spawn (~0.26 s). The load-bearing "is the probe
slow?" assumption was **falsified** — the probe is fast. The RFC was
restructured: the separate `hostCapabilities` message and all
progressive-rendering machinery were removed in favor of a bundled, awaited
`capabilities` field on the `playbooks` message.

**Round 1.** `boundary-critic` — probe orchestration moved out of the WS
handler into a `preparePlaybookList` use-case; parser validation made fatal and
consistent with `dependencies`. `failure-mode-analyst` — the false "runs on the
host the agent will run on" claim corrected with a "What the probe actually
measures" section. `design-minimalist` — the three-state capability type lost
its never-distinguished `unknown` member; the separate WS message, store reset,
and helper indirections cut. `socratic-challenger` — the
fail-open-vs-self-degradation tension resolved; the Problem section made honest
about the cosmetic, narrow value. `ambition-amplifier` — TTL cache dropped; the
circular-dependency risk in the trigger addressed.

**Round 2.** `ambition-amplifier` / `boundary-critic` — found a real bug: the
v2 probe reused `execFileBounded`, which rejects only on `ENOENT` and resolves
on all other failures, so a hung or broken `kb` would be misclassified
`available`. The probe was rewritten with explicit error-code classification,
resolve-only. `failure-mode-analyst` / `socratic-challenger` — found that
folding `gatedBy` into `dependencies` silently added a `kb doctor` launch-time
preflight, contradicting R7 and a Non-Goal; the fold was removed.
`failure-mode-analyst` — the v2 `try/catch` wrapped the one call that could not
throw; corrected. `boundary-critic` — `HostCapability` moved to `messages.ts`.

**Round 3.** `failure-mode-analyst` — the "Files to change" table omitted
`useWebSocket.ts`, the one frontend call site that actually consumes the new
field (a literal implementation would have shipped a no-op); it is now listed.
Also: `maxBuffer` added to the probe; `e.killed` checked before `e.code`;
`PlaybookParameterForm` capability access specified (store, not prop); both
`LaunchTaskDialog` `isFresh` checks named; `discoverPlaybooks` failure wording
de-conflicted; shell alias/function added as a probe-divergence cause.
`boundary-critic` — `probeKbPresence` moved to its own
`launch-capability-probe.ts` rather than degrading `launch-dependency-runner.ts`
cohesion; parser wiring made precise. `socratic-challenger` — collapse now
renders annotation-only (not a disabled control showing a misleading option
label); a cached `absent` is treated as stale so the engaged user is not stuck
with a dead control for 30 s; the build trigger reworked as a *proposal* judged
before code exists; the authoring-docs pointer decoupled from the build so the
closure clock is well-defined even if the build is deferred indefinitely; the
silent-on-`unknown` choice documented with a refinement noted in Open Questions.
`design-minimalist` — confirmed the design is minimal.

**Rejected critic suggestions.** `design-minimalist` (rounds 2–3) suggested
inlining `preparePlaybookList` into the handler, using `{ kb?: HostCapability }`
instead of the union-keyed record, and inlining `CAPABILITY_PROBES` to a direct
`if (dep === 'kb')`. All three rejected with reasons: probe-trigger policy is
worth isolating from WS dispatch and is independently testable; keying off the
`LaunchDependency` union is the single-source-of-truth pattern, not speculative
scaffolding; and a bare `if`/`switch` over `LaunchDependency` does **not**
produce a compile error when the union grows (the existing
`runLaunchDependencyPreflights` switch would silently no-op a new member),
whereas `Record<LaunchDependency, …>` does — so the one-line record is the
cheapest real forcing function, siding here with `failure-mode-analyst`'s
round-2 finding over `design-minimalist`'s round-3 cut.

**Adversarial pair (`ambition-amplifier` vs `design-minimalist`).** Round 1
produced two scope collisions, both resolved by siding with `design-minimalist`:
(1) *remote probing* — kept v2-only, because v1 is a held-ready blueprint with
no consumer and a remote-exec round-trip is speculative before one local
consumer exists (with the caveat now added that a remote-first consumer pulls
v2 into the build-trigger PR); (2) *`gatedBy` array* — kept scalar, because a
one-member `LAUNCH_DEPENDENCIES` makes a multi-element array impossible to
populate and the widening is backward-compatible later. Rounds 2–3 produced no
new collision on a shared scope item.

**Invocation log.**
- `ambition-amplifier` 2026-05-19 (round 1): novel finding — the build-trigger
  circular-dependency risk and the `gatedBy` scalar→array migration trap.
- `ambition-amplifier` 2026-05-19 (round 2): novel finding — the
  `execFileBounded` reject-vs-resolve contract gap that would misclassify a
  broken `kb` as `available`.
