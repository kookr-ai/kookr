# RFC: Project-Targeted Playbook Launches

## Status

**Implemented (v4)**

**Date:** 2026-05-09
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr's dashboard currently overloads one `cwd` for two different responsibilities:

1. **Playbook source cwd**: the repo that contains `.kookr/playbooks/*.md`.
2. **Task target cwd**: the repo where the launched agent should do work.

That works when playbooks are local to the active repository. It breaks for Kookr-owned operational playbooks that should run against an arbitrary tracked project.

Playwright reproduction on 2026-05-09:

- Opened production Kookr at `http://localhost:4800`.
- Selected project `jeanibarz/knowledge-base-mcp-server`.
- Clicked `Run playbook...`.
- Selected `Test Quality Improvement`.
- The playbook detail showed `Running in: ~/git/kookr`, not `~/git/knowledge-base-mcp-server`.
- Clicking `Change...` switched the dialog back to the Manual tab and discarded the selected playbook detail.
- The target repository has no `.kookr/playbooks/`, so changing the dialog cwd to the target repo cannot list Kookr's playbooks.

I started an equivalent task through the browser same-origin API as a workaround. It launched successfully in `~/git/knowledge-base-mcp-server`, but the workaround loses playbook identity, usage tracking, and first-class project-targeted launch semantics.

## Empirical Grounding

Round-1 exploration found:

- `ProjectConfig.localPath` already exists and is documented as the stored local checkout path for project-drawer launch prefill.
- `ProjectSummary.localPath` already mirrors that value to the frontend.
- `App.tsx` ignores `selectedProjectSummary.localPath` and only calls `deriveProjectCwd(agents, selectedProjectSummary.project)`.
- `deriveProjectCwd` only scans currently visible agents. If no agent for that project has a cwd, it returns `null`.
- `LaunchTaskDialog` falls from missing `projectCwd` to draft cwd, recent paths, then `serverCwd`, which is how the project drawer can end up on `~/git/kookr`.
- `PlaybookBrowser` only uses `projectContext` to pre-fill parameters whose source is `tracked-projects`; it does not bind runtime cwd.
- `preparePlaybookLaunch` reads the playbook from `input.cwd/.kookr/playbooks` and launches in `playbook.cwd ?? input.cwd`.
- `source: tracked-projects` derives `projectId`, not execution cwd. This can stamp a task under one project while running it in another.

There is therefore a small immediate bug and a deeper boundary flaw. The immediate bug is ignoring `ProjectSummary.localPath`. The durable fix is splitting catalog source from task target.

## Requirements

- **R1.** The playbook launch path SHALL distinguish `playbookSourceCwd` from `taskTargetCwd`.
- **R2.** Project-drawer `Run playbook...` SHALL list Kookr catalog playbooks from the server/Kookr cwd when the selected project has no `.kookr/playbooks/`.
- **R3.** Project-drawer playbook launches SHALL default the task target cwd from `ProjectSummary.localPath`, then the existing agent-derived cwd helper, then unresolved empty state. They SHALL NOT fall back to draft cwd, MRU cwd, or server cwd for the target project.
- **R4.** The user SHALL be able to change the task target cwd from the playbook detail without losing the selected playbook or parameter values.
- **R5.** The playbook detail SHALL show both source and target when they differ.
- **R6.** A project-drawer launch SHALL include the selected project id. The server SHALL only apply it when it matches server-derived evidence from the target cwd or a `tracked-projects` parameter. Otherwise the launch is rejected with an actionable error. Project-drawer launches fail closed; they never continue as unstamped launches when a requested project id conflicts.
- **R7.** Existing local playbook launches SHALL remain backward-compatible: old clients that send only `cwd` get `playbookSourceCwd = taskTargetCwd = cwd`.
- **R8.** Looped playbook launches SHALL use the same source/target semantics as standard playbook launches.
- **R9.** For v1, playbook frontmatter `cwd:` always pins execution target. If a launch explicitly supplies a different `taskTargetCwd`, the server rejects after canonical path comparison. Legacy launches that send only `cwd` behave as today: `cwd:` overrides the legacy cwd without conflict.
- **R10.** Runtime client-message validation SHALL accept both legacy and split source/target shapes.
- **R11.** Regression coverage SHALL prove the reproduced project-drawer flow: source remains Kookr, target becomes the selected repo, selected playbook/params survive target edits, and the resulting task is stamped to the selected project.

## Non-Goals

- No filesystem browser.
- No generalized project checkout discovery endpoint in v1.
- No `$HOME/git/<repo>` candidate probing in v1.
- No schedule semantics change in v1.
- No playbook asset system for source-relative files.
- No broad rewrite of existing OSS playbooks.

## Design

### Contract

Extend playbook launches with optional split fields while preserving `cwd`:

```ts
type LaunchPlaybookMessage = {
  type: 'launchPlaybook';
  playbookPath: string;
  cwd?: string;                 // legacy: source and target
  playbookSourceCwd?: string;   // where .kookr/playbooks lives
  taskTargetCwd?: string;       // where the agent should run
  projectId?: string;           // selected project metadata hint
  parameterValues: Record<string, string>;
  agentType?: AgentType;
};
```

`PlaybookHandler` normalizes protocol compatibility at the boundary:

```ts
type NormalizedPlaybookLaunchRequest = {
  playbookSourceCwd: string;
  taskTargetCwd: string;
  taskTargetCwdExplicit: boolean;
  playbookPath: string;
  parameterValues: Record<string, string>;
  requestedProjectId?: string;
  agentType?: AgentType;
};
```

Core/server use cases receive only the normalized shape. They do not know about legacy `cwd`.

`taskTargetCwdExplicit` is required to preserve backward compatibility. It is `true` only when the client sent `taskTargetCwd`. It is `false` when target was inferred from legacy `cwd`.

### Frontend Flow

`App.tsx` decides launch intent:

- normal `+ Launch`: one cwd, current behavior.
- project drawer `Run playbook...`: Kookr/server cwd is the playbook source; selected project's local checkout is the target when known.

Project-drawer target default:

```ts
const target =
  selectedProjectSummary.localPath ??
  deriveProjectCwd(agents, selectedProjectSummary.project) ??
  '';
```

This is intentionally narrow. `ProjectSummary.localPath` is already present; v1 does not need a new resolver abstraction.

`LaunchTaskDialog` owns both source and target state in playbook mode:

- `playbookSourceCwd`
- `taskTargetCwd`

Manual mode keeps the existing single cwd.

`PlaybookBrowser` receives:

```ts
playbookSourceCwd: string;
taskTargetCwd: string;
projectContext?: ProjectSummary;
onTaskTargetCwdChange(next: string): void;
```

The detail view shows:

- `Playbook source: kookr` / `~/git/kookr`
- `Target: knowledge-base-mcp-server` / `~/git/knowledge-base-mcp-server`

`Change...` toggles an inline target-cwd input in the detail view. It does not switch to Manual and does not clear `selected`, `paramValues`, conflict state, or loop mode.

If a project-drawer launch has no target cwd, the detail view shows the selected project and a target-required message, and disables both `Launch Playbook` and `Launch Looped` until the user enters a target.

### Server Flow

`preparePlaybookLaunch` becomes a small orchestration use case over internal helpers:

- `normalizePlaybookLaunchRequest` lives in the WS/HTTP boundary.
- `resolveEffectiveTargetCwd(playbook, taskTargetCwd)` handles `cwd:` and canonical conflict checks.
- `resolveLaunchProjectId(...)` validates requested project attribution.

Launch preparation:

1. Read playbook from `playbookSourceCwd/.kookr/playbooks/<playbookPath>`.
2. Parse and interpolate the playbook.
3. Compute `effectiveTargetCwd = playbook.cwd ?? taskTargetCwd`.
4. If `playbook.cwd` and an explicit `taskTargetCwd` are both present and differ after expansion and canonicalization, reject. If `taskTargetCwd` was inferred from legacy `cwd`, preserve existing behavior and let `playbook.cwd` pin execution.
5. Check `effectiveTargetCwd` exists.
6. Normalize prompt file references relative to `effectiveTargetCwd`.
7. Resolve project id:
   - If a `tracked-projects` parameter is present, derive from that parameter.
   - If `requestedProjectId` is present, accept it only if it matches the parameter-derived id or a project identity derived from `effectiveTargetCwd`.
   - If no explicit/parameter id is present, derive from `effectiveTargetCwd` as today.
   - If explicit ids conflict, reject rather than silently stamping the wrong project.
8. Launch with `cwd = effectiveTargetCwd`.

`effectiveTargetCwd` remains the task's runtime cwd. `playbookId` remains the catalog identity.

> **Follow-up (#2887):** Playbook-backed tasks now persist `PlaybookSourceIdentity`
> (`id`, `scope`, `sourceCwd`, and `sourceDigest`). History-based actions use
> that identity to avoid binding to a same-ID resource from another scope or a
> modified file at the same path.

### Looped Playbooks

`POST /api/playbooks/ralph-loop` and replace-loop routes accept the same split fields:

```ts
{
  cwd?: string;
  playbookSourceCwd?: string;
  taskTargetCwd?: string;
  projectId?: string;
  playbookPath: string;
  parameterValues: Record<string, string>;
}
```

They share the same normalization helper as WebSocket `launchPlaybook`. No duplicate source/target logic.

`src/server/routes/task-routes.ts` is part of this change: the route layer currently requires `body.cwd` before reaching the looped playbook use case, so it must accept split fields before validation. Replace-loop routes must use the normalized target cwd for duplicate-key comparison, not the playbook source cwd.

### `cwd:` Semantics

For v1:

- `cwd:` in playbook frontmatter means "this playbook pins the execution target."
- During catalog listing, `cwd:` also scopes visibility to the same repository identity; alternate checkouts and worktrees of that repository remain eligible.
- Project-drawer target override is illegal when `cwd:` resolves to a different canonical path.
- Legacy launch with only `cwd` is not treated as a target override; `cwd:` keeps existing precedence.
- This is intentionally conservative. A future RFC may add explicit metadata such as `target: selected-project`, but v1 does not infer that from comments or UI entry point.

`Test Quality Improvement` has no `cwd:`, so it can be project-targeted once source/target are split.

### Target Verification

V1 uses existing data and avoids path guessing:

- `ProjectSummary.localPath` is a previously stamped Kookr hint, not proof. The server validates project attribution before applying `requestedProjectId`.
- If a project-drawer launch supplies `requestedProjectId` and the target cwd is stale or points to the wrong remote, the launch is rejected. Non-project launches without `requestedProjectId` may still launch without a project stamp when identity cannot be derived.
- No `$HOME/git` candidate probing ships in v1, because existence is not identity and browser-side probing is impossible.

## Files To Change

- `src/shared/contracts/messages.ts` / `src/shared/protocol.ts`: extend `launchPlaybook` and looped playbook request types.
- `src/shared/contracts/client-message-schema.ts`: accept legacy and split playbook launch shapes.
- `src/frontend/App.tsx`: pass Kookr/server source cwd plus `selectedProjectSummary.localPath ?? deriveProjectCwd(...) ?? ''` target cwd for project-drawer playbook launches.
- `src/frontend/components/LaunchTaskDialog.tsx`: keep separate source/target state in playbook mode.
- `src/frontend/components/PlaybookBrowser.tsx`: display/edit target cwd in detail view; send split fields for standard and looped launches.
- `src/server/ws-handlers/playbook-handler.ts`: normalize old/new message shapes.
- `src/server/use-cases/playbook-launch.ts`: read from source cwd, launch in target cwd, validate project id.
- `src/server/use-cases/looped-playbook-launch.ts`: share the same normalization and target resolution.
- `src/server/routes/task-routes.ts`: accept split fields for looped playbook and replace-loop routes before route-level validation.
- Tests:
  - `client-message-schema.test.ts` or equivalent schema test: split `launchPlaybook` without `cwd` and legacy `launchPlaybook` with only `cwd`.
  - `LaunchTaskDialog.project-cwd.test.ts`
  - `PlaybookBrowser` launch message tests
  - `playbook-launch.test.ts`
  - `looped-playbook-launch.test.ts`
  - route-level tests for `POST /api/playbooks/ralph-loop` and replace-loop with split fields and legacy `cwd`
  - project-drawer integration test for `Test Quality Improvement` targeting a non-Kookr repo.

## Edge Cases

- **No target cwd.** Project-drawer playbook detail disables launch and asks for a target cwd.
- **Target repo lacks `.kookr/playbooks`.** Works because source remains Kookr.
- **Playbook pins `cwd:`.** Server rejects target override after canonical comparison.
- **User changes target cwd after selecting a playbook.** Selected playbook, parameters, and loop mode remain intact.
- **Tracked-project parameter also exists.** Parameter-derived project id and requested project id must match.
- **Recent-path draft points to Kookr.** Ignored for project-drawer target cwd.
- **`ProjectSummary.localPath` stale.** Project-drawer launch rejects when requested project id does not validate against the effective target.
- **Looped launch.** Uses the same source and target fields.
- **Prompt file references.** Relative references are interpreted relative to the task target in v1. Source-relative playbook assets are out of scope.

## Acceptance Tests

1. Project drawer for `github.com/jeanibarz/knowledge-base-mcp-server` with `localPath=~/git/knowledge-base-mcp-server` opens Playbooks with source `~/git/kookr` and target `~/git/knowledge-base-mcp-server`.
2. Selecting `Test Quality Improvement` shows both source and target and sends `playbookSourceCwd=~/git/kookr`, `taskTargetCwd=~/git/knowledge-base-mcp-server`, and `projectId=github.com/jeanibarz/knowledge-base-mcp-server`.
3. The launched task has runtime cwd `~/git/knowledge-base-mcp-server`, `playbookId=test-quality-improvement.md`, and `projectId=github.com/jeanibarz/knowledge-base-mcp-server`.
4. Editing target cwd in the selected playbook detail preserves selected playbook and parameter values.
5. A playbook with frontmatter `cwd: /tmp/a` rejects launch when `taskTargetCwd=/tmp/b`.
6. Looped playbook launch sends and honors the same source/target split, including `projectId`.
7. Replace-loop sends and honors the same source/target split; duplicate-loop keys compare target cwd, not source cwd.
8. Legacy `launchPlaybook` with only `cwd` behaves exactly as before, including `cwd:` frontmatter precedence.
9. Split `launchPlaybook` without `cwd` passes runtime schema validation; legacy `launchPlaybook` with only `cwd` also passes.
10. Explicit `projectId` conflicting with target cwd identity or tracked-project parameter is rejected.

## Alternatives Considered

### Minimal LocalPath-Only Patch

Change `App.tsx` to prefer `selectedProjectSummary.localPath ?? deriveProjectCwd(...)`.

This fixes one visible symptom when the target has its own `.kookr/playbooks` or when the desired playbook also exists in the target. It does not fix Kookr catalog playbooks targeting repos with no playbook catalog, and it still overloads one cwd for source and target.

### Add `repoFullName` to `Test Quality Improvement`

This makes the prompt mention a repository, but it does not run tests in that repository's checkout. Prompt-only targeting is insufficient for filesystem/test-suite playbooks.

### Copy Kookr Playbooks Into Every Target Repo

This preserves the current single-cwd model but spreads Kookr operational files into unrelated repositories and creates version drift.

### Full Server-Side Project Cwd Resolver

A resolver endpoint that checks config, agents, candidates, filesystem existence, and remotes is likely useful later. It is deliberately deferred. V1 already has `ProjectSummary.localPath` for the reproduced case, and candidate probing needs more security and identity design.

## Critic Feedback Incorporated

- `design-minimalist 2026-05-09`: narrowed v1 to source/target split plus existing `ProjectSummary.localPath`; removed `$HOME/git` candidate probing and resolver abstraction from v1.
- `socratic-challenger 2026-05-09`: made project-target mode require a real target, added looped playbook parity, clarified `cwd:` semantics, and sharpened acceptance tests.
- `failure-mode-analyst 2026-05-09`: added server-side project id validation, canonical `cwd:` conflict comparison, schema compatibility, stale localPath risks, and looped route coverage.
- `boundary-critic 2026-05-09`: moved compatibility normalization to handler boundary, kept target state owned by `LaunchTaskDialog`, and split server helper responsibilities.
- `explorer 2026-05-09`: incorporated evidence that `ProjectSummary.localPath` already exists but is ignored, and that `source: tracked-projects` affects project id only, not runtime cwd.
- `boundary/failure round-2 2026-05-09`: preserved legacy `cwd:` behavior with `taskTargetCwdExplicit`, made project-drawer project-id conflicts fail closed, and added payload assertions for project id.
- `implementation-pragmatist round-2 2026-05-09`: added `task-routes.ts` to the file list, route-level tests for looped and replace-loop launches, and runtime schema positive tests for both legacy and split messages.

## Open Questions

- Should a later RFC add explicit playbook frontmatter like `target: selected-project` to hide nonsensical catalog playbooks from project drawers?
- Resolved by #2887: schedules use the same split source/target model, and tasks persist the full playbook source identity.
