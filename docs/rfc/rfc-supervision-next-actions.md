# RFC: Supervision Next Actions and Follow-Up Surface

**Status:** Draft (v3 — post round-2 convergence)
**Date:** 2026-05-09
**Author:** Jean Ibarz (with Codex)

---

## Problem

The latest session reflection report shows that Kookr is becoming more autonomous, but the user still has to provide small lifecycle nudges at task boundaries.

The measured window was `2026-05-05T17-58-30-327Z` through `2026-05-09T02-29-24-882Z`:

- 30 supervision sessions.
- 239 launched agents.
- 132 completed tasks.
- 5 user interventions.
- 0 empty sessions.
- 0 skipped findings.
- 0 snooze storms.
- 7 mass-launch sessions with 10+ launched agents.

The intervention rate is good. The remaining friction is more specific: Kookr often does not make the next workflow state obvious after a task stops, a PR is created, or a loop iteration finishes.

Examples from the reflection run:

- The repeated-instruction analyzer found `proceed` 18 times across 13 sessions since 2026-05-05.
- User messages included "merged, continue", "it is merged, what's next?", "ok proceed", and "create PR".
- Large batches such as `2026-05-07T00-06-11-757Z` launched 33 agents with 0 user inputs, but the dashboard has no compact follow-up surface for terminal tasks that still need attention.

Round-1 and round-2 review narrowed this RFC. The original draft tried to solve next actions, GitHub readiness, batch rollups, Ralph prompt slimming, and runtime-verification workflow at once. V3 makes PR 1 intentionally small: a deterministic next-action classifier based only on task status and current anomaly class, plus a visible Follow-up surface for terminal rows that are not truly done. PR/GitHub, Ralph, and batch intelligence are follow-up slices.

This means PR 1 is not the complete solution to "merged, what's next?" It is the foundation: introduce the read model and UI surface without overclaiming. PR 2 adds explicit external references and GitHub-aware follow-up.

## Empirical Checkpoint

The design-experimenter verified the load-bearing repo facts before v2/v3:

- `AgentState` currently exposes `playbookId` but not `parentTaskId` or `childTaskIds`; the underlying `Task` model has parent/child fields.
- `createSnapshotMessage()` and `getSnapshotAgentsForClient()` currently depend on `monitor.getSnapshot()` only. They do not accept `GitHubStateStore` or a `getTaskGitHubState` accessor.
- GitHub state is sent separately as `githubUpdate`; it is not embedded in the snapshot.
- `CompletionDigest` can include PR URLs only if `prUrls` are passed, but the production completion path calls `generateCompletionDigest(preEvents)` without `prUrls`.
- `App.tsx` puts all terminal tasks (`completed`, `cancelled`, `terminated`) in the Completed pane, which is collapsed independently of active findings.

These facts drive the V1 scope: do not depend on GitHub state in PR 1, do not mutate `Monitor`/raw `AgentState`, and do not rely on `parentTaskId` for frontend-only batch grouping.

## Goals

- Make routine terminal follow-up visible without changing task lifecycle.
- Keep V1 small enough for one implementation PR.
- Keep core monitoring separate from workflow recommendation policy.
- Avoid overclaiming. Unknown, cancelled, terminated, or inconsistent terminal state should classify as `inspect`.
- Create a stable wire and UI surface for later GitHub/Ralph/batch-aware actions.

## Non-Goals

- Do not classify PR/CI/review/merge readiness in PR 1.
- Do not infer external references from transcripts, completion digest text, branch names, or tool output in PR 1.
- Do not redesign or reclassify Ralph loops in PR 1.
- Do not shorten Ralph runtime prompts in this RFC.
- Do not add a durable batch entity.
- Do not add a new `TaskStatus`.
- Do not use an LLM for next-action derivation.
- Do not update skills or hooks for runtime verification in this RFC.

## Requirements

- Kookr SHALL expose a finite next-action read model for browser snapshots and update messages.
- V1 SHALL derive next actions only from normalized task status and current anomaly class.
- V1 SHALL NOT require GitHub state to be embedded in snapshot messages.
- V1 SHALL NOT add `nextAction` to `Monitor.getSnapshot()` raw `AgentState`.
- V1 SHALL render terminal tasks with non-`done` next actions in a visible Follow-up surface, not only inside the collapsed Completed section.
- V1 SHALL preserve the existing task lifecycle statuses.
- V1 SHALL include table-driven tests for the classifier, client projection, and focused frontend rendering.

## Design

### 1. Split the model by responsibility

Keep wire types in shared contracts. Keep classification policy in core. Keep labels in frontend.

New shared contract file:

```ts
// src/shared/contracts/task-next-action.ts
export type TaskNextActionKind =
  | 'inspect'
  | 'respond'
  | 'fix_required'
  | 'waiting'
  | 'done';

export type TaskNextActionReason =
  | 'terminal_with_active_anomaly'
  | 'needs_user_response'
  | 'actionable_error'
  | 'pending_launch'
  | 'running_no_known_blocker'
  | 'completed_no_known_followup'
  | 'cancelled_or_terminated'
  | 'inconsistent_state';

export interface TaskNextActionSnapshot {
  kind: TaskNextActionKind;
  reason: TaskNextActionReason;
}
```

Core classifier:

```ts
// src/core/task-next-action.ts
import type {
  TaskNextActionReason,
  TaskNextActionSnapshot,
} from '../shared/contracts/task-next-action.js';

export type NormalizedTaskStatus =
  | 'none'
  | 'pending'
  | 'open'
  | 'inProgress'
  | 'completed'
  | 'cancelled'
  | 'terminated';

export type NormalizedAnomalyClass =
  | 'none'
  | 'needs_response'
  | 'actionable_error'
  | 'other';

export interface TaskNextActionInput {
  taskStatus: NormalizedTaskStatus;
  anomalyClass: NormalizedAnomalyClass;
}

export function deriveTaskNextAction(input: TaskNextActionInput): TaskNextActionSnapshot;
```

Frontend maps `{ kind, reason }` to short labels and tooltips. Core does not own UI copy, timestamps, or GitHub/Ralph state.

### 2. Add a client projection type

Do not add `nextAction` to `AgentState` in `src/core/monitor.ts`. `Monitor` remains the raw event/anomaly/session owner.

Add a client-facing type:

```ts
// src/shared/contracts/messages.ts or nearby
export type ClientAgentState = AgentState & {
  nextAction?: TaskNextActionSnapshot;
};
```

Then update wire messages:

```ts
export type SnapshotMessage = {
  type: 'snapshot';
  agents: ClientAgentState[];
  // ...
};

export type ServerMessage =
  | SnapshotMessage
  | { type: 'update'; agentId: string; state: ClientAgentState }
  // ...
```

Round-2 boundary review caught an important detail: both initial snapshots and later single-agent `update` messages must use the same projection. Otherwise the UI could receive `nextAction` on the first snapshot and lose it on the next live update.

Add one helper and use it everywhere browser-bound agent state is emitted:

```ts
export function projectAgentForClient(agent: AgentState): ClientAgentState {
  const projected = {
    ...agent,
    events: agent.events.map(projectEventForClient),
  };
  return {
    ...projected,
    nextAction: deriveTaskNextAction(toTaskNextActionInput(projected)),
  };
}
```

`getSnapshotAgentsForClient()` maps through `projectAgentForClient()`. The WebSocket update path uses the same helper for `{ type: 'update' }`.

### 3. Normalize only facts PR 1 can compute deterministically

PR 1 does not try to normalize liveness freshness, GitHub state, external references, Ralph child state, or batch lineage. The input mapper uses only fields already present on the agent row:

| Source fact | Normalized fact |
|---|---|
| `taskStatus === undefined` | `taskStatus: 'none'` |
| `taskStatus` is one of known task statuses | same normalized value |
| `anomaly === null` | `anomalyClass: 'none'` |
| `anomaly.type` is `needs_input` or `permission_blocked` | `anomalyClass: 'needs_response'` |
| `anomaly.severity` is `critical` | `anomalyClass: 'actionable_error'` |
| `anomaly.type` is `merge_conflict`, `api_error`, `budget_exceeded`, or `repeated_error` | `anomalyClass: 'actionable_error'` |
| any other anomaly | `anomalyClass: 'other'` |

No string scanning of completion digest in PR 1. No PR URL detection in PR 1. No `hasLiveSession` in PR 1. No Ralph-specific input in PR 1.

### 4. Ordered guard list

The classifier is an ordered guard list. First match wins.

```text
1. terminal task + any anomaly -> inspect / terminal_with_active_anomaly
2. anomalyClass needs_response -> respond / needs_user_response
3. anomalyClass actionable_error -> fix_required / actionable_error
4. pending task -> waiting / pending_launch
5. open or inProgress task -> waiting / running_no_known_blocker
6. completed task with no anomaly -> done / completed_no_known_followup
7. cancelled or terminated task -> inspect / cancelled_or_terminated
8. fallback -> inspect / inconsistent_state
```

This deliberately does not output `merge_ready`, `wait_for_ci`, `review_required`, `verify_closure`, `start_next_iteration`, or `clean_up`. Those require stronger domain facts than PR 1 owns.

Frontend labels:

| Kind/reason | Label |
|---|---|
| `respond` / `needs_user_response` | Needs response |
| `fix_required` / `actionable_error` | Fix required |
| `waiting` / `running_no_known_blocker` | Running |
| `waiting` / `pending_launch` | Pending |
| `inspect` / `terminal_with_active_anomaly` | Inspect |
| `inspect` / `cancelled_or_terminated` | Inspect |
| `done` / `completed_no_known_followup` | Done |
| fallback `inspect` | Inspect |

### 5. Follow-up surface

The first visible UI change should make terminal non-done work hard to miss.

Exact frontend derivation:

```ts
const isTerminal = (s: TaskStatus | undefined): boolean =>
  s !== undefined && isTerminalStatus(s);

const followUp = filteredAgents.filter((a) =>
  isTerminal(a.taskStatus) && a.nextAction?.kind !== 'done'
);

const completed = filteredAgents.filter((a) =>
  isTerminal(a.taskStatus) && a.nextAction?.kind === 'done'
);
```

Keep the existing `globalFinishedCount` and `globalTerminatedCount` unfiltered. Clear-completed still sweeps globally; the Follow-up split is presentation-only.

The Follow-up group should render above Completed and below active Findings/Snoozed/Healthy. Active findings remain in the existing Findings group. This preserves attention routing while preventing terminal-but-not-done rows from being hidden in a collapsed Completed section.

Open question for implementation: if `nextAction` is missing during hydration, treat terminal rows as Follow-up or Completed? The safer V1 fallback is Follow-up for terminal rows until the projected state arrives, because it avoids hiding unresolved terminal state.

## Follow-Up Designs

### PR 2 — explicit external references and GitHub-aware follow-up

PR 2 handles the actual "merged, what's next?" class more directly.

Required first step: introduce a reliable external-reference read model instead of scanning arbitrary text.

Possible shape:

```ts
export interface TaskExternalReference {
  type: 'pr' | 'issue';
  url: string;
  source: 'github_scanner' | 'completion_digest' | 'hook_event';
  confidence: 'structured' | 'heuristic';
  detectedAt: string;
}
```

Then add GitHub-aware classification with strict non-overclaiming:

- `merge_ready` only if GitHub provides explicit mergeability/branch-protection readiness.
- draft PR, closed-unmerged PR, mergeability unknown, stale checks, or superseded PR -> `inspect`.
- running checks -> `waiting`.
- failing checks or changes requested -> `fix_required`.

GitHub state should enter snapshot projection through a narrow accessor such as `getTaskGitHubState(taskId)`, not by passing `GitHubStateStore` everywhere.

### PR 3 — batch rollups

Batch rollups need explicit lineage. Current `AgentState` does not expose `parentTaskId`, and fuzzy grouping by playbook/project/time can group unrelated work.

Follow-up design:

- Prefer server-derived rollups where `TaskStore` has parent/child lineage.
- Or add minimal projected lineage fields such as `parentTaskId` to the client projection and derive rollups in a tested helper.
- Do not use fuzzy same-playbook/time-window grouping until Kookr has `launchBatchId` or equivalent identity.

### PR 4 — Ralph follow-up and prompt slimming

PR 1 treats Ralph like ordinary task/anomaly/status rows. Ralph-specific action labels require more facts.

Follow-up design:

- Compute `hasLiveOwnerSession`, `hasRunningChildren`, and latest iteration terminal facts in server projection.
- Classify mismatches as `inspect` with a concrete reason.
- Only after that state is reliable should Kookr shorten the Ralph runtime preamble.

## Files to Change

V1:

- `src/shared/contracts/task-next-action.ts` — wire enum/reason/snapshot types.
- `src/core/task-next-action.ts` — normalized input type and ordered guard classifier.
- `src/core/task-next-action.test.ts` — table-driven classifier coverage.
- `src/shared/contracts/messages.ts` — `ClientAgentState`, snapshot/update message type changes.
- `src/shared/protocol.ts` — export new shared types if needed.
- `src/server/use-cases/get-snapshot.ts` — `projectAgentForClient()` and snapshot projection.
- `src/server/ws.ts` or whichever update path emits `{ type: 'update' }` — use the same projection helper.
- `src/server/use-cases/get-snapshot.test.ts` and/or WebSocket tests — snapshot and update messages include next action; raw snapshot remains unchanged.
- `src/frontend/App.tsx` — derive Follow-up and Completed as disjoint terminal groups.
- `src/frontend/components/FindingsPanel.tsx` — render Follow-up group and compact row labels.
- Focused frontend test for row/group rendering.

Not V1:

- `src/core/monitor.ts` raw `AgentState` mutation.
- GitHub `merge_ready` classification.
- External-reference extraction.
- Batch rollups.
- Ralph-specific classifier input.
- Ralph prompt changes.
- Skill/hook workflow updates.

## Edge Cases

### Terminal task with active anomaly

Classify as `inspect`. A terminal task and active anomaly together indicate stale queue state, bad cleanup, or a race. Do not ask the user to respond as if the task were live.

### Cancelled or terminated task

Classify as `inspect` in V1. A later cleanup model can distinguish "cancelled intentionally and no cleanup needed" from "terminated and needs recovery".

### Completed task with hidden PR follow-up

PR 1 may still classify it as `done` if no structured external reference exists. That is an accepted limitation of the minimal V1. PR 2 exists specifically to close this gap.

### Missing `nextAction` during hydration

The frontend should fail visible. A terminal row without `nextAction` should not be buried in Completed until the client projection arrives.

### No task id

If an agent row has no task id, classify from anomaly and task status only. Fallback is `inspect`.

## Alternatives Considered

### Add more specific action kinds in V1

Rejected after design-minimalist and state-machine review. Specific labels such as `merge_ready`, `wait_for_ci`, and `start_next_iteration` imply stronger domain knowledge than V1 can safely derive.

### Put nextAction directly on `AgentState`

Rejected after boundary review. `Monitor` owns event/anomaly/session state. Next-action policy belongs in the browser-facing projection.

### Frontend-only batch rollups

Rejected for V1. Current snapshot agents do not expose parent lineage, and fuzzy grouping is not trustworthy enough for health summaries.

### Completion digest drives PR follow-up

Rejected for V1. Production completion digest generation does not reliably receive PR URLs. A later `TaskExternalReference` model should own external references explicitly.

## Testing Plan

### PR 1 tests

- Table-driven classifier tests for:
  - terminal + anomaly -> `inspect`;
  - `needs_input` / `permission_blocked` -> `respond`;
  - critical/error anomaly -> `fix_required`;
  - pending -> `waiting`;
  - open/inProgress with no anomaly -> `waiting`;
  - completed with no anomaly -> `done`;
  - cancelled/terminated -> `inspect`;
  - unknown/no task status fallback -> `inspect`.
- Normalization tests for anomaly classes.
- Client projection tests:
  - snapshot agents include `nextAction`;
  - update messages include `nextAction`;
  - raw `Monitor.getSnapshot()` callers remain unchanged.
- Frontend test:
  - terminal non-`done` row appears in Follow-up;
  - terminal `done` row appears in Completed;
  - Follow-up and Completed are disjoint;
  - global finished/terminated counts remain unfiltered.
- Payload test: `nextAction` contains only enum/reason fields, not event or GitHub data.

### Follow-up PR tests

- External-reference extraction tests with structured source/confidence.
- GitHub reducer tests for draft, closed-unmerged, mergeability unknown, running checks, failed checks, review-needed, merged.
- Batch rollup tests using explicit parent/child lineage.
- Ralph-specific tests once live owner/child facts are exposed.

## Implementation Slices

### PR 1 — Minimal next-action surface

Implement the classifier, shared wire type, client projection for snapshots and updates, Follow-up group, and row labels. No GitHub-aware merge readiness. No external-reference extraction. No batch rollup. No Ralph-specific state.

### PR 2 — Explicit external references and GitHub-aware follow-up

Add reliable external references and integrate known GitHub state with strict mergeability rules.

### PR 3 — Batch rollups

Add server-derived or explicitly lineage-backed rollups. Avoid fuzzy grouping until Kookr has `launchBatchId` or equivalent identity.

### PR 4 — Ralph follow-up and prompt slimming

Expose enough loop/session facts to classify Ralph states reliably. Only then shorten the runtime preamble.

## Open Questions

- Should missing `nextAction` on terminal rows always route to Follow-up, or should the UI wait for hydration before rendering terminal groups?
- Should PR 2 store `TaskExternalReference` on the task record, in `GitHubStateStore`, or as a separate read model?
- What existing update path(s) emit single-agent `update` messages and need to use `projectAgentForClient()`?

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-09 round 1: incorporated smaller V1 scope, reduced action kinds, removed V1 batch rollups, removed V1 GitHub merge-state classification, and moved Ralph prompt slimming/runtime verification out of V1.
- `state-machine-verifier` 2026-05-09 round 1: incorporated normalized classifier input, ordered guards, stricter terminal handling, and table-driven tests.
- `failure-mode-analyst` 2026-05-09 round 1: incorporated conservative handling for terminal anomalies, no inferred merge readiness, and external-reference uncertainty as a follow-up.
- `boundary-critic` 2026-05-09 round 1: incorporated projection-only placement, no raw `AgentState` mutation, no direct full-`AgentState` classifier input, and explicit lineage caveat for batch rollups.
- `delivery-pragmatist` 2026-05-09 round 1: incorporated no-GitHub PR 1 scope, Follow-up surface for terminal non-`done` tasks, and PR-specific acceptance matrices.
- `design-experimenter` 2026-05-09: verified snapshot/GitHub/AgentState/completion-digest assumptions; corrected the RFC to reflect that production completion digests do not receive PR URLs today and terminal tasks are all placed in Completed.
- `design-minimalist` 2026-05-09 round 2: removed unused `ready_for_user`, removed Ralph-specific PR 1 input, and moved external-reference detection out of PR 1.
- `failure-mode-analyst` 2026-05-09 round 2: added terminal anomaly and terminal-row stale-surface handling; explicitly acknowledged that PR 1 does not solve PR-producing tasks without structured external references.
- `boundary-critic` 2026-05-09 round 2: added one client projection helper for both snapshots and updates, moved wire types to `src/shared/contracts`, and removed Ralph live-owner/child facts from PR 1.
- `state-machine/delivery` 2026-05-09 round 2: added concrete frontend derivation for Follow-up vs Completed, narrowed normalization to deterministic fields, and deferred liveness/Ralph mismatch classification.
