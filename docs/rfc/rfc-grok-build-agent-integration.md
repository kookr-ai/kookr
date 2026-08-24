# RFC: Grok Build Agent Integration

**Status:** Accepted (v4 — post-review)
**Date:** 2026-07-11
**Author:** Jean Ibarz (with Codex)

---

## Summary

Kookr should add xAI's official proprietary Grok Build CLI as a third managed
agent through a dedicated `GrokBuildAdapter`. Kookr should not fork either the
official binary or the unrelated community `superagent-ai/grok-cli` harness at
this stage.

The integration begins with a small, evidence-producing viability POC for one
basic supervised Grok session. Broader Claude-compatibility probes follow only
after that vertical slice passes. Only capabilities proven by real Grok Build
sessions graduate into Kookr's production contract. The first production slice
uses the existing interactive dtach, hook ingestion, adapter registry, and
plugin injection mechanisms. ACP is retained as a later structured-control
option, not introduced in the first slice.

## Context

xAI released Grok 4.5 on 2026-07-08 and made it the default model in its official
Grok Build coding agent. The official CLI is distributed as the proprietary
`@xai-official/grok` binary and invoked as `grok`. It supports interactive,
headless, and Agent Client Protocol (ACP) operation.

The release materially changes the build-versus-fork decision. Grok Build's
published interface already claims:

- Claude Code compatibility for `CLAUDE.md`, `.claude/rules/`, marketplaces,
  plugins, skills, agents, hooks, and MCP servers;
- `AGENTS.md` discovery;
- plugin injection through `--plugin-dir`;
- parallel subagents and worktrees;
- named/resumable sessions and streaming JSON output;
- model and reasoning-effort selection;
- Claude-compatible aliases for overlapping command-line flags; and
- ACP over JSON-RPC through `grok agent stdio`.

Primary sources:

- [Introducing Grok 4.5](https://x.ai/news/grok-4-5)
- [Grok Build overview](https://docs.x.ai/build/overview)
- [Skills, Plugins & Marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- [CLI reference](https://docs.x.ai/build/cli/reference)
- [Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Enterprise Deployments](https://docs.x.ai/build/enterprise)
- [Grok Build changelog](https://x.ai/build/changelog)
- [Community grok-cli](https://github.com/superagent-ai/grok-cli)

These are recent vendor claims from a fast-moving beta. They are hypotheses for
the POC, not accepted compatibility facts.

## Problem

Kookr currently supervises Claude Code and a forked Codex CLI. Adding Grok 4.5
must preserve Kookr's defining behavior:

1. Run a real interactive coding agent in a Kookr-owned dtach session.
2. Route developer input through the existing terminal bridge.
3. Receive structured lifecycle and tool events without parsing terminal text.
4. Load Kookr's project instructions and toolkit plugin consistently.
5. Observe subagents without confusing their events with the parent session.
6. Recover or accurately terminate sessions after process/server failure.
7. Expose model cost, usage, permissions, and capability limitations honestly.

The official CLI cannot be patched. Its compatibility statements are broader
than the exact contracts Kookr relies upon, especially hook payload schemas,
hook injection, subagent identity, model mappings, and transcript stability.

## Goals

- Establish the official Grok Build CLI as the preferred Grok harness.
- Prove compatibility using real events, session files, and terminal behavior.
- Add a thin adapter using existing Kookr abstractions.
- Keep unsupported capabilities explicit and capability-gated.
- Preserve Kookr Toolkit discovery without copying skills into `.grok/`.
- Pin and preflight the proprietary binary so upstream churn fails clearly.
- Leave an evidence trail that makes a later fork decision objective.

## Non-goals

- Reimplementing Grok Build or its system prompt.
- Forking `superagent-ai/grok-cli` preemptively.
- Making ACP Kookr's general agent transport in the first production slice.
- Normalizing every Grok-native feature into Claude semantics.
- Supporting externally launched Grok sessions.
- Guaranteeing Grok 4.5 availability in regions where xAI does not offer it.
- Changing Kookr's task/session lifecycle or terminal backend.

## Requirements

### Functional

1. Kookr SHALL represent Grok Build as its own stable agent type.
2. Kookr SHALL launch the configured Grok binary in the selected cwd inside a
   managed dtach session.
3. Kookr SHALL inject the Kookr Toolkit plugin using a capability-probed
   `--plugin-dir` path.
4. Kookr SHALL verify repository instructions, plugin skills, monitoring hooks,
   and each later POC-B surface before claiming compatibility for that surface.
5. Kookr SHALL ingest only empirically validated hook events and normalize them
   into the existing `AgentEvent` union.
6. Kookr SHALL distinguish parent-session and child/subagent events.
7. Kookr SHALL support byte-level interactive input and permission responses.
8. Kookr SHALL map configured reasoning effort only when the installed binary
   advertises a compatible flag/value.
9. Kookr SHALL report unavailable or incompatible binaries through adapter
   preflight rather than silently falling back to another agent.
10. Kookr SHALL preserve user hooks and configuration; its monitoring hooks must
    be additive.

### Safety and operability

1. The integration SHALL NOT parse rendered terminal output for anomaly events.
2. The adapter SHALL initially allowlist an exact tested Grok Build build ID and
   platform. An unknown build may run only inside the isolated POC runner, never
   as an ordinary managed task.
3. Auto-update checks SHALL be disabled for Kookr-managed sessions where the CLI
   supports that setting.
4. Permission bypass SHALL be an explicit opt-in mapped independently from the
   sandbox profile; aliases alone are insufficient evidence of equal semantics.
5. Authentication secrets SHALL be supplied through inherited/explicit
   environment or the CLI's credential store and SHALL NOT be persisted in task
   metadata or hook logs.
6. The UI and health endpoint SHALL expose capability gaps that affect
   supervision as `supported`, `unsupported`, or `unknown`, with a reason and
   evidence build ID rather than provider event names.
7. POC fixtures SHALL redact prompts, source contents, credentials, and user
   paths before being committed.

## Target Architecture Versus First Slice

### Target architecture

Grok Build is a peer of Claude Code and Codex CLI behind `AgentAdapter`. The
adapter owns Grok-specific launch arguments, capability probing, hook settings,
session metadata, and event normalization. The existing routing adapter,
terminal backend, monitor, task store, and frontend remain provider-neutral.

ACP may later become an additional structured control/telemetry channel if it
provides stronger session and completion semantics than hooks alone. Adopting ACP
across all harnesses would require a separate RFC.

### First mergeable slice

The first mergeable artifact is documentation and a repeatable **POC-A**, not a
production agent selector. POC-A answers only: "Can Kookr safely supervise one
basic Grok task?" It records what one exact Grok Build build does on Linux for:

- resolved binary identity and local CLI capabilities;
- interactive dtach readiness and byte-level input;
- project `CLAUDE.md` and `AGENTS.md` discovery;
- injected Toolkit plugin discovery and one explicit skill invocation;
- additive launch-scoped monitoring hooks for session start, one tool
  start/result/failure path, permission blocking, and turn/session outcome; and
- normal stop, abnormal exit, and owned process-tree cleanup.

**POC-B** is a separate follow-up compatibility matrix for subagents, plan mode,
resume, model aliases, wider skill invocation, transcript/usage/cost, MCP
discovery, macOS, and upgrade behavior. Production implementation starts only
after POC-A resolves the hard gates below. POC-B capabilities may graduate
independently and must not block the constrained first slice unless Grok cannot
disable an unobservable feature.

## Design

### 1. Capability POC

Add a POC document under `docs/poc/` and a disposable probe fixture/script that
runs against a user-installed official binary. The probe must never install the
binary through an unreviewed `curl | bash` path. Installation is an operator
prerequisite; the POC records the resolved path, `grok --version` (or the
version command advertised by that exact build), platform, date,
authentication mode category, selected model, package/build ID, binary digest,
probe revision, and plugin revision.

The probe creates a synthetic temporary repository and two synthetic Grok homes:
one hermetic schema probe and one controlled composition probe containing
synthetic user hooks/config at documented precedence levels. It never reads the
operator's real project/user hooks or MCP servers. It provides:

- independent `CLAUDE.md` and `AGENTS.md` sentinel runs from a non-Kookr cwd;
- one injected plugin skill with a unique sentinel output;
- launch-scoped diagnostic hooks for POC-A events; and
- a bounded prompt that performs a harmless tool call, encounters a permission
  boundary, and exits.

The probe uses synthetic canary credentials and source only. It writes raw output
to an owned `0700` temporary directory with bounded size and automatic deletion;
retention requires explicit operator opt-in. Committed fixtures are constructed
from an allowlist of fields rather than blacklist-redacting real output. The POC
commits payload examples, reproduction commands, and explicit pass/fail
conclusions. It enforces wall-clock, tool-round, token/cost, and process-tree
ceilings.

#### POC-A hard production gates

| Gate | Minimum evidence | If it fails |
|---|---|---|
| Additive hook injection | Kookr and user hooks both execute | Try plugin hook packaging or isolated config composition; do not overwrite user config |
| Minimum supervision | Stable Kookr/provider correlation; tool start and result/failure; permission block; process exit; structured outcome | Do not ship production monitoring |
| Permission visibility | A blocking permission produces a reliable structured signal | Do not ship the first slice; terminal visibility alone is not sufficient |
| Toolkit discovery | One injected plugin skill resolves explicitly from arbitrary cwd | Block production integration |
| Instruction discovery | `CLAUDE.md` and `AGENTS.md` sentinels are independently followed in separate runs | Block production integration |
| Interactive dtach | Readiness, prompt, approval, and reply work through byte writes | Evaluate `--no-alt-screen`; otherwise evaluate ACP before shipping |
| Stable outcome | A proven semantic success outcome plus clean process end is `completed`; all other combinations follow the truth table below | Never infer success from process exit or a turn-level Stop alone |
| Child control | Subagents are enforceably disabled for slice 1, or child identity/correlation is proven | Block production integration; suppressing child events is unsafe |
| Process ownership | Stop/kill drains the owned process tree, including MCP/subagent children | Block production integration |

There are no waiverable POC-A gates. POC-B features may remain unsupported and
are shown as such. A later product decision can change a hard gate only by
revising this RFC with an explicit degraded-supervision contract.

#### Outcome truth table

POC-A must identify which structured Grok field/event, if any, represents a
terminal successful session outcome rather than a turn stop. Until proven, the
result is `unknown`.

| Structured semantic outcome | Process end | Kookr classification |
|---|---|---|
| Explicit terminal success | Clean exit after bounded late-event drain | `completed` |
| Explicit failure/cancel | Any exit | `terminated` (with failure/cancel reason) |
| Missing or ambiguous | Clean exit | `unknown` / task terminated without success acknowledgment |
| Any | Nonzero exit or signal | `terminated`; process evidence overrides success |
| Success arrives after nonzero/signal | Nonzero exit or signal | `terminated` and contradictory-evidence diagnostic |
| No process end before timeout | Still alive/unreachable | existing liveness/reconciliation rules; never completed |

The adapter waits a bounded POC-determined drain interval for late lifecycle
events. Turn-level `Stop` may signal attention but never proves task completion.

### 2. Grok Build adapter

After the POC passes its mandatory gates, add `GrokBuildAdapter` implementing the
existing `AgentAdapter` contract.

Suggested configuration:

```text
KOOKR_GROK_BIN=grok
KOOKR_GROK_MODEL=grok-4.5
```

The binary option starts from the existing Claude/Codex local preflight pattern,
but exact identity requires a focused extension: the current `PreflightResult`
and probe helper return the configured command rather than a canonical path and
extract only a numeric version. Implementation must resolve PATH/realpath,
stat/hash the executable, capture the exact advertised build ID, and execute that
same path.
Model selection belongs in Kookr's per-agent settings rather than being
hard-coded in the adapter. If xAI changes the recommended coding model, Kookr
can update its default without renaming the agent type.

Adding the agent type also requires replacing the current binary Claude-versus-
Codex effort fallback with an exhaustive per-agent map/switch. Grok exposes a
custom effort control and forwards it to `--reasoning-effort`; exact accepted
values remain harness-authoritative until the CLI provides a stable enumeration.

Expected launch shape, entirely hypothetical until exact-build root and
subcommand help is captured by POC-A:

```text
grok
  --cwd <task cwd>
  --plugin-dir <resolved Kookr plugin>
  --model <configured model>
  --reasoning-effort <harness-native effort>
  [permission flags]
  [resume/session flags]
```

Each shown flag is individually qualified; if `--cwd` is absent, Kookr sets the
backend process cwd rather than emulating the flag. Root-help substring matching
alone is insufficient: qualification checks relevant subcommand help,
stdout/stderr, and machine-readable output where available.

The initial prompt uses the same reliable post-start delivery mechanism as the
other interactive adapters only after a structured or otherwise unambiguous
ready-state probe. It must abort rather than type into authentication, update,
or other unexpected startup UI. The POC covers large/unicode/bracketed-paste
input and acknowledgment correlation. Long prompts must not be placed on argv.

The adapter is a coordinator over focused pure helpers where they reduce actual
duplication: launch argument/config construction and Grok hook decoding. Session
artifact reading remains absent until POC-B proves a stable format. Reuse
existing launch context, plugin path, hook writer, parentage, input, and binary
probe helpers by composition; do not subclass `ClaudeCodeAdapter` and do not
create a new provider framework speculatively.

### 3. Binary identity, readiness, and compatibility

Do not overload Kookr's startup `preflight` with account or network state. Split
three concerns:

1. **Installed agent information:** startup-local resolved canonical path,
   executable status, ownership/permissions, exact build ID, platform, and
   digest. This check performs no auth, plugin, project, MCP, or network work.
2. **Reviewed compatibility evidence:** one schema-validated,
   Grok-specific `grok-build-compatibility.v1` manifest for an exact
   build/platform/plugin/probe revision. It contains build ID, digest, platform
   tuple, gate results, fixture references, and review status. It is the sole
   runtime source for `tested`, `unknown`, or `known-incompatible`; unknown may
   run only in the isolated POC runner.
3. **Launch readiness:** bounded launch-time auth/model/region/provider errors.
   Classify only documented machine-readable codes; otherwise preserve sanitized
   stderr under a generic provider-unavailable diagnostic.

The exact resolved binary used for identity checks is the one executed. Recheck
its identity immediately before launch to prevent PATH replacement or auto-update
TOCTOU. `inspect --json` is allowed only in the explicit sandboxed POC fixture,
never routine startup/health/task-cwd preflight, because discovery may load
plugins, hooks, MCP declarations, or network-backed configuration.

The first slice does not introduce a broad capability taxonomy. It adds only the
minimum generic supervision status consumed by availability, task detail, and
health diagnostics: `supported | unsupported | unknown`, reason, and evidence
build ID. Exact feature fields are added only for a proven POC gap and a current
consumer.

The manifest is intentionally local, repo-reviewed, and Grok-specific. It is not
a signed registry, remote distribution mechanism, or provider-neutral
conformance platform. CI schema-validates it and verifies that adapter
qualification derives from it rather than a duplicate hard-coded allowlist.

### 4. Hooks and normalization

Keep distributed `plugin/` solely for general-purpose toolkit skills and agents.
Kookr monitoring is an internal runtime concern and must not be added to Toolkit
hooks seen by ordinary plugin consumers. Prefer a separate generated,
launch-scoped internal instrumentation plugin when Grok accepts multiple plugin
directories. Otherwise use generated per-session config composition proven by
the POC. Never edit `~/.grok/config.toml` or project `.grok/` as a launch side
effect.

The hook writer sends events through an unguessable launch envelope containing
Kookr task/session nonce and adapter identity into an owned, restrictive
per-session path. It enforces no-follow/open ownership, maximum event and file
sizes, framing/locking, bounded nonblocking writes, timeout, rotation/quota, and
malformed-event isolation. Redaction occurs before durable diagnostics. Hooks
must fail open within a strict timeout for monitoring-only events so a dead
Kookr writer or full disk cannot freeze the coding agent; policy-enforcement
hooks remain a separate explicit contract.

The Grok adapter owns parsing, deduplication, late-event quarantine, and
normalization; shared monitor code sees only `AgentEvent`. Concurrent and resumed
sessions are namespaced by the Kookr session nonce even when vendor IDs repeat.
Unknown events are recorded as bounded unsupported diagnostics, not guessed into
an existing event type.

If xAI's payload is Claude-compatible, reuse pure parsing helpers rather than
subclassing `ClaudeCodeAdapter`. The concrete adapters must remain peers because
their launch, capability, session, authentication, and upgrade policies differ.

### 5. Skills, plugins, and model mappings

The adapter injects Kookr's existing `plugin/` directory and relies on Grok's
documented Claude compatibility. Kookr does not create a third copy of toolkit
content under `.grok/`.

The POC must test separately:

- automatic skill selection;
- unqualified natural-language skill requests;
- qualified slash commands;
- qualified `subagent_type` references;
- Claude-named models in imported agent definitions; and
- an explicit mapping from supported Claude aliases to Grok model identifiers.

Slice 1 uses the configured parent Grok model and disables custom-model subagent
definitions. POC-B tests aliases. If translation is later required, a pure
Grok-only resolver may use an explicit allowlist; an omitted child model inherits
the parent, while an unknown explicit alias is rejected with an actionable
diagnostic. It never mutates plugin sources or global/project Grok config, and
silent fallback is forbidden.

### 6. Sessions, resume, transcripts, usage, and cost

Grok documents named sessions, resume/continue flags, storage under
`~/.grok/sessions`, export, streaming JSON, and ACP updates. The POC determines
which source is stable enough for each need:

- hooks remain authoritative for live anomaly events;
- adapter/process state remains authoritative for terminal liveness;
- a documented structured session artifact may provide freshness and usage;
- streaming JSON is considered only if it can coexist with the interactive
  product; and
- ACP is evaluated after the interactive slice.

Kookr must not assume Grok session files match Claude transcript JSONL. Until
token counts and prices are observed reliably, the UI displays usage as
unavailable rather than estimating from terminal text. Pricing must be
configuration/versioned data, not embedded in the parser.

### 7. Authentication, region, privacy, and updates

Support API-key and cached/device authentication only as documented by the
installed CLI. Startup preflight distinguishes only binary absent, unsupported
build, and local probe failure. Launch readiness reports specific auth/model/
region/provider states only when stable machine-readable codes exist; otherwise
it reports a sanitized generic launch failure. It never initiates interactive
login or a paid/network probe merely to render settings or health.

As of this RFC's date, xAI states that Grok 4.5 is not yet available in the EU
and expects availability in mid-July. Region availability is therefore an
operational prerequisite, not an adapter error to work around.

Kookr-managed sessions disable background auto-update checks when supported and
execute an exact resolved binary path. Operators upgrade deliberately, run the
compatibility probe, and review a new exact-build entry. The RFC does not require
Kookr to redistribute the proprietary binary or build a package manager.

Child processes receive an allowlisted environment rather than the full Kookr
server environment. The allowlist includes task context and the selected auth
mechanism, not unrelated provider/GitHub/deployment credentials. Canary-secret
tests cover hook, session, crash, and diagnostic artifacts.

## Files Expected to Change During Implementation

The POC determines the exact set. Expected areas are:

- `docs/poc/` — compatibility evidence and redacted fixtures;
- `docs/poc/` or a nearby schema-owned data path — the reviewed
  `grok-build-compatibility.v1` manifest and schema;
- `src/shared/contracts/agent-types.ts` — new stable agent type and effort model;
- `src/adapters/grok-build-adapter.ts` and tests;
- `src/adapters/agent-adapter.ts` — generic capabilities only if required;
- adapter registration/server bootstrap and environment configuration;
- task launch API/settings and frontend agent selector;
- hook normalization and fixture tests;
- transcript/usage integration only if proven;
- `.env.example`, configuration docs, features, architecture, and system models;
- an internal launch-time instrumentation template under the Grok adapter
  surface (for example `src/adapters/grok-build-instrumentation/`) only if that
  is the validated hook mechanism; never distributed `plugin/hooks`.

Any change under `plugin/` must remain general-purpose and must bump the plugin
version. Grok-specific Kookr launch behavior stays under Kookr-internal source.

## Rollout Plan

### Phase 0A — Basic-supervision evidence

Run POC-A against an exact official build on a recorded Linux distro, kernel,
architecture, libc, locale, terminal/dtach version, auth category, and model.
Publish the hard-gate decisions. macOS and untested Linux combinations remain
explicitly unsupported.

### Phase 0B — Incremental compatibility evidence

After POC-A passes, probe subagents, plan mode, semantic resume, model aliases,
wider skill/agent invocation, transcripts/usage/cost, MCP discovery, macOS, and
one deliberate upgrade. Each result can unlock an independent capability; it is
not bundled into the basic adapter.

### Phase 1 — Experimental adapter

Register the adapter unconditionally but render it disabled with actionable
availability when the binary/build is absent or unqualified. An experimental
feature flag and local kill switch govern new launches. Support interactive
launch, input, process-tree stop, verified hooks, toolkit injection, fixed
configured model, and explicit supervision status. Do not enable resume,
subagents, custom child models, or usage surfaces that POC-B has not proven.

### Phase 2 — Dogfood and hardening

Run representative Kookr tasks and measure:

- missing, duplicate, or out-of-order hooks;
- false missing-hook/stuck findings;
- parent/child routing accuracy;
- terminal input and permission response reliability;
- normal completion versus crashes;
- restart/reconciliation and resume behavior;
- usage/cost completeness; and
- breakage across one deliberate CLI upgrade.

### Phase 3 — General availability

Remove the experimental label only after the acceptance thresholds below pass on
each claimed Linux/macOS platform. Publish exact tested builds, authentication
modes, known hook gaps, rollback instructions, and behavior for already-running
sessions when new launches are disabled.

### Phase 4 — Optional ACP evaluation

Evaluate ACP as a structured control or telemetry channel. Any change that
replaces interactive dtach or generalizes ACP across adapters requires its own
design review.

## Acceptance Criteria

### Issue 1: POC-A

- A pinned official Grok Build version is tested with reproducible commands.
- The result covers every POC-A hard gate.
- Redacted hook payloads document supported event schemas and ordering.
- Toolkit plugin, both instruction families, one explicit skill, and monitoring
  hook injection are exercised from a non-Kookr cwd.
- Interactive dtach readiness/input, permissions, stop, abnormal kill, and
  process-tree cleanup are observed using real sessions.
- The POC recommends proceed, constrained proceed, ACP investigation, or stop.

### Issue 2: Experimental backend adapter

- Depends on an approved POC-A gate record.
- Implements local identity/preflight, launch readiness, interactive launch and
  input, process-tree stop, verified event normalization, instruction/toolkit
  injection, feature flag/kill switch, and focused tests.
- Excludes frontend selection, semantic resume, subagents, custom child models,
  transcript usage, and ACP.

### Issue 3: Selector, documentation, and dogfood hardening

- `grok-build` is represented through `AgentAdapter` and registered normally.
- Binary/build failures are actionable availability/preflight results;
  auth/model/region/provider failures are actionable launch-readiness
  diagnostics.
- Mandatory structured events reach existing Kookr monitoring without terminal
  parsing.
- User configuration and hooks are preserved.
- Unsupported features are disabled or visibly reported.
- Unit/integration tests cover launch arguments, capability probes, event
  normalization, malformed payloads, input, stop, and resume policy.
- Documentation states supported platforms, versions, permissions, privacy,
  regional availability, and known gaps.
- A real dogfood run demonstrates launch, tool activity, subagent policy,
  attention routing, developer response, and termination.

### Issue 4+: POC-B capabilities and macOS

- Each capability has its own evidence and implementation acceptance criteria.
- macOS cannot be declared supported until the POC-A core suite passes there.

### Quantitative GA thresholds

- Zero cross-session attribution errors across at least 20 concurrent-session
  scripted runs.
- Zero lost or duplicate POC-A hard-gate lifecycle events across at least 50
  single-session runs; out-of-order events must reconcile deterministically.
- Permission-block detection succeeds in 20/20 scripted permission boundaries.
- Initial prompt delivery and developer reply succeed in 50/50 runs including
  unicode, large input, and an unexpected startup-screen negative test.
- Normal completion versus killed/crashed outcome is classified correctly in
  30/30 scripted runs.
- Stop drains the owned process tree in 20/20 runs with synthetic child/MCP
  processes.
- Malformed, oversized, forged-session, newline, partial-write, full-disk, and
  canary-secret fixtures never cross-route, block the agent beyond the hook
  timeout, or persist secret values.
- One deliberate upgrade to another reviewed build passes all claimed
  capabilities before that build is allowlisted.

## Alternatives Considered

### Fork the community `superagent-ai/grok-cli`

Rejected for now. It is an MIT-licensed independent Grok API harness, not the
source of xAI's official CLI. Adopting it would make Kookr responsible for
Claude compatibility, context engineering, tool behavior, upgrade tracking,
hooks, plugin semantics, and model/harness regressions before the official
surface has been shown inadequate.

Reconsider only if the POC identifies a mandatory blocker, xAI does not expose a
supported extension point, ACP cannot solve it, and the community harness passes
a separate maintenance/security assessment.

### Build a Kookr-native Grok API agent loop

Rejected. This duplicates a coding harness, violates the reuse-first principle,
and makes model quality inseparable from Kookr's own prompt/tool implementation.

### Run Grok 4.5 through another generic harness

Deferred as a fallback experiment. OpenCode, Hermes, or another open harness may
be useful for model benchmarking, but would not validate official Grok Build
behavior or automatically satisfy Kookr's Claude-compatible plugin contract.

### Start with headless mode

Rejected for the first production slice because Kookr exposes a live interactive
terminal and routes developer replies into a persistent agent. Headless mode is
valuable for probes and automation, not a drop-in replacement for that UX.

### Start with ACP

Deferred. ACP is promising and structurally cleaner, but starting there would
combine a new agent with a new control transport. The interactive adapter limits
the initial change to one axis and preserves current product behavior.

## Failure Modes and Mitigations

| Failure | Mitigation |
|---|---|
| Vendor compatibility differs from documentation | Pinned-version empirical POC and fixtures |
| Upstream auto-update breaks hooks | Disable auto-update, version preflight, compatibility suite |
| User and Kookr hooks conflict | Additive plugin/config composition; never overwrite user files |
| Child events pollute parent anomaly state | Proven IDs, capability gate, or disable/suppress subagents |
| Permission bypass also weakens sandbox unexpectedly | Treat permission and sandbox controls separately and test both |
| Proprietary session format changes | Keep hooks/process liveness authoritative; parse only documented/proven fields |
| Region/model unavailable | Actionable launch-readiness diagnostic; no network/account startup preflight |
| Auth secret enters diagnostics | Redaction tests and no secret persistence in task/hook state |
| TUI alternate screen is unreliable through dtach | Test `--no-alt-screen`, then evaluate ACP if required |
| Model alias silently selects the wrong model | Explicit mapping policy and diagnostics |
| xAI service or subscription limits stop sessions | Normalize provider errors and preserve terminal/session evidence |
| Forged, replayed, or cross-session hook event | Launch nonce, restrictive endpoint/path, bounds, dedup, and late-event quarantine |
| Monitoring hook hangs or disk fills | Bounded nonblocking fail-open writer, timeout, quotas, and health telemetry |
| Top-level process exits while children survive | Owned process group/tree drain with escalation and orphan checks |
| PATH binary changes after qualification | Execute canonical path and verify build identity immediately before launch |
| Server environment leaks unrelated secrets | Allowlisted child environment and canary-secret artifact tests |
| Initial bytes land in login/update UI | Ready-state gate, acknowledgment correlation, and abort on unexpected screen |

## Open Questions for the POC

1. Are Grok hook event names, matchers, stdin payloads, blocking behavior, and
   exit semantics identical enough to reuse Claude parsing helpers?
2. Can required hooks be injected entirely through `--plugin-dir` while
   preserving user/plugin hooks?
3. What stable identifier links parent, subagent, hook, terminal, and persisted
   Grok sessions?
4. How does Grok map Claude model names in imported agent definitions, and can
   Kookr configure that mapping without rewriting plugin files?
5. Does `--dangerously-skip-permissions` have the same combined permission and
   sandbox behavior as Claude, or only act as a CLI alias?
6. Which structured source exposes token usage, cost, context consumption, and
   completion reason in interactive mode?
7. Does resume preserve cwd, plugin state, hook state, and model selection after
   Kookr/server restart?
8. Which CLI versions and authentication modes are usable in the EU when the POC
   runs?
9. Can macOS provide the same sandbox and hook guarantees as Linux?

## Decision Rules After the POC

- **Proceed with the official adapter** when all mandatory gates pass.
- **Proceed with constraints** when optional capabilities fail and Kookr can
  disable or report them honestly without compromising supervision.
- **Evaluate ACP** when interactive terminal control or structured session
  correlation is the only mandatory blocker.
- **Stop** when instructions/toolkit discovery or core lifecycle monitoring
  cannot be made reliable through supported surfaces.
- **Consider an open harness/fork** only after documenting the blocker, upstream
  response, ACP result, maintenance owner, security model, and benchmark plan.

## Critic Feedback Incorporated

### Round 1 — 2026-07-11

- `boundary-critic`: separated local startup preflight, reviewed compatibility
  evidence, and launch readiness; moved monitoring out of the distributed
  Toolkit plugin; clarified adapter/helper and future ACP authority boundaries.
- `failure-mode-analyst`: added event-ingestion isolation, hook timeout/bounds,
  environment minimization, process-tree ownership, exact binary identity,
  synthetic fixture privacy, readiness races, rollout kill switch, and objective
  GA thresholds.
- `design-minimalist`: split the omnibus POC into POC-A basic supervision and
  incremental POC-B capabilities; removed speculative broad capability/runtime
  probe machinery and split production delivery into smaller issues.
- `socratic-challenger`: made all POC-A gates hard, defined the minimum
  supervision/outcome contract, separated dtach reattachment from semantic
  resume, and chose the safe first-slice model-alias policy.
- `ambition-amplifier 2026-07-11: novel finding` — proposed a provider-neutral
  conformance platform, committed compatibility registry, and official/open
  harness bake-off.
- Adversarial decision: the RFC follows `design-minimalist` for the first slice
  because a Grok-specific go/no-go probe must precede platformization. It retains
  the amplifier's durable binary/build evidence, but defers a general conformance
  suite and harness bake-off until at least two provider integrations need them.

Rejected or deferred:

- A provider-neutral conformance runner and open-harness comparative benchmark
  are strategically useful but out of scope for proving the first supervised
  Grok session.
- A signed compatibility registry is unnecessary for local-first POC-A; the
  exact reviewed manifest is sufficient. Unknown builds are restricted to the
  isolated POC runner until evidence must be reviewed and added.
- Nested/coexisting instruction precedence, plugin agents, model aliases,
  resume, MCP, usage/cost, and macOS are POC-B work rather than prerequisites
  for the constrained slice; both root instruction families are verified
  independently in POC-A.

### Empirical validation checkpoint

`design-experimenter 2026-07-11: local binary unavailable`. Read-only probes
found no `grok` executable, global `@xai-official/grok` package, cached package,
Grok home, or Grok environment configuration. Therefore every Grok-specific
flag and compatibility statement remains unconfirmed rather than falsified.

The checkpoint confirmed Kookr's reusable adapter, hook, input, plugin-path, and
local preflight infrastructure, and found two required corrections now reflected
above: current preflight does not canonicalize/fingerprint the executable, and
current effort selection would incorrectly fall back to Claude values for a new
agent type. POC-A must capture exact-build root/subcommand help before finalizing
any launch flag. No authentication, paid API call, plugin load, or file mutation
was performed.

### Round 2 — 2026-07-11

- `boundary-critic`: aligned POC-A's actual skill-only evidence with its Toolkit
  gate, corrected preflight versus launch-readiness acceptance wording, and
  narrowed instruction tests to independent file-family runs.
- `failure-mode-analyst`: independently confirmed the same two contract
  contradictions; no other load-bearing failure modes remained.
- `design-minimalist`: moved plugin-agent execution and nested/coexisting
  instruction precedence to POC-B; otherwise found the first slice converged.
- `socratic-challenger`: restricted unknown builds to the POC runner and replaced
  the unsafe clean-exit-plus-Stop rule with a semantic outcome truth table.
- `ambition-amplifier 2026-07-11: novel finding` — identified drift risk between
  prose evidence and a separately hard-coded exact-build allowlist.
- Adversarial decision: the minimalist's POC boundary remains authoritative, but
  the amplifier's narrow Grok-specific compatibility manifest is accepted
  because it removes duplicate qualification state without creating a general
  provider platform.

### Round 3 — 2026-07-11

- `boundary-critic`: removed two stale phrases that still assigned region/model
  failures to startup preflight and implied an unrestricted local build
  override.
- `failure-mode-analyst`: no substantive findings.
- `design-minimalist`: no substantive findings.
- `socratic-challenger`: no substantive findings.
- Round 3 converged; `ambition-amplifier` was skipped as prescribed because no
  new deferred/future-work scope was introduced.

## Meta-analysis Readiness

Critic invocations and substantive findings are recorded in
`docs/rfc/meta/rfc-grok-build-agent-integration.critic-trace.jsonl` using
`critic-trace.v1`. The trace includes all three rounds, no-finding invocations,
rejected/deferred findings, and the empirical checkpoint; it is ready for later
aggregate analysis after implementation outcomes exist.
