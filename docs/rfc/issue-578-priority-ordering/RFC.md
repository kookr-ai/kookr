# RFC: Project And Agent Priority Ordering

## Status

**Draft (v2 - post round-1)**

## Date

2026-05-24

## Author

Jean Ibarz (with Codex)

---

## Problem

Kookr helps a developer decide where to look next, but the dashboard still lacks an explicit user-declared priority signal. Projects are partly orderable today through the sidebar's pinned and dragged order, but that affordance reads as sidebar organization rather than attention priority. Agents/tasks have no equivalent signal at all.

The result is ambiguous routing when several projects and agents are active. Kookr can say which agent is blocked, but the user cannot tell Kookr that one release-blocking project should appear before an experimental repo, or that one running agent is the one to watch first when urgency otherwise ties.

This RFC designs a small priority model that is easy to set, visible in the main dashboard, and reusable by #579's cross-project auto-advance.

## Requirements

- Users SHALL be able to set project priority from the project sidebar without opening documentation.
- Users SHALL be able to reorder project priority with drag-and-drop and keyboard-accessible menu actions.
- Project priority SHALL be visible without opening Settings.
- Users SHALL be able to mark an agent/task high priority from the findings/agent list.
- Agent priority SHALL be visible in the main findings/agent list.
- Priority SHALL affect project and agent ordering while preserving safety-critical routing: active findings still appear before healthy work, and higher anomaly severity still wins inside findings.
- Priority choices SHALL persist across browser reloads and server restarts.
- Existing users SHALL get stable defaults with no migration prompt.
- #579 SHALL be able to read the next project from the same project priority order.

## Non-Goals

- No arbitrary numeric score, float, or five-level priority scale.
- No separate full-screen priority planner.
- No priority scheduling of agent execution or launch capacity.
- No automatic priority inference from GitHub labels, issue numbers, or branch names.
- No cross-project auto-advance in this issue; #579 implements that behavior after this schema lands.
- No mobile-specific drag-and-drop replacement. Existing context/menu actions remain the accessible fallback.

## Design

### High-level model

Use two simple concepts:

1. **Project priority order** is the persisted visible project sidebar order. Existing pinned projects stay pinned; pinning is not re-labeled as a separate high-priority tier in this issue.
2. **Agent priority** is a persisted task-level boolean: `priority: "high"` when elevated, absent when normal.

This deliberately avoids a second project ordering model. The app already has project sidebar persistence at `/api/projects/sidebar`, local recovery state, drag-to-reorder, context-menu move actions, hidden projects, pinned projects, and a sidebar manager. The missing work is to make that existing order read as "priority" and to compose it into task sorting.

### Project priority UX

Keep the current sidebar mechanics, but make the priority meaning clearer at the ordering affordance:

- Keep the organizer as "Organize projects" because the dialog still handles tracking, hidden rows, and offline recovery.
- Add priority wording to the visible-project section in `ProjectSidebarManager`: "Visible priority order".
- Keep context-menu pin/unpin copy unchanged. This avoids silently changing existing users' mental model of pinned projects.
- Keep the current drag-to-reorder and keyboard context-menu move actions as the primary project-priority controls.

Sort behavior:

- `computeProjectSummaries` keeps its server-side default sort: findings, active agents, alphabetical. This remains a display default only, not an implicit project-priority source.
- A shared pure helper derives project priority ranks from current project summaries and `ProjectSidebarState`/prefs. It skips hidden and offline/catalog-only rows and ranks only explicit persisted sidebar order. Projects without explicit order remain unranked so dynamic finding counts do not become priority signals.
- Frontend display and #579 use the helper, not raw React/Zustand state, so priority semantics are named and reusable.

### Backward compatibility

Existing sidebar state remains valid. Existing pinned projects stay at the top because that is already how the sidebar renders, but the PR does not rename pinned projects to high-priority projects or write a migration. Hidden projects remain hidden from sidebar-driven priority navigation; users can restore them from the organizer.

### Agent priority UX

Each non-terminal task row in the main findings/agent list gets a compact priority toggle:

- Finding card action: `Priority` / `Normal`.
- Healthy, pending, and snoozed rows expose the same control where row actions already exist.
- Completed rows display an existing high-priority badge if present, but do not expose a toggle because changing priority after completion has no routing effect.
- High-priority rows show a `High priority` badge near the task name or status line.

The control sends:

```ts
{ type: 'setTaskPriority', taskId: string, priority: 'high' | 'normal' }
```

Server handling is routed through `LifecycleHandler` so the existing shared-task mutation guard applies. `priority: "normal"` is command-only and removes the persisted field. Missing/deleted tasks throw through the existing message error path; no optimistic frontend update is required.

### Agent sorting

Priority composes as a tiebreaker, not as an override. One shared frontend helper should be used by both row display and keyboard navigation so order cannot drift.

- Findings stay before healthy/pending/completed lists.
- Coordinator chip ordering remains first where it already applies.
- Findings sort by anomaly severity first, then high-priority flag, then project priority rank, then `startedAt`, then `taskId`/`agentId`.
- Healthy and pending rows sort by high-priority flag, then project priority rank, then `startedAt`, then `taskId`/`agentId`.
- Snoozed and completed rows keep their existing ordering. Priority remains visible but does not reorder them.

This preserves Kookr's core promise: urgent blocked work is still routed first, while user priority decides ties and normal-work order.

### Persistence and wire contract

Project priority persistence uses the existing project sidebar schema:

```ts
interface ProjectSidebarState {
  version: 1;
  ordered: string[];
  pinned: string[];
  hidden: string[];
  catalog: Record<string, ProjectSidebarCatalogEntry>;
}
```

No schema change is required for project priority. Project priority is derived from the visible sidebar order; `pinned` remains a sidebar organization field that only matters because it already affects that visible order.

Agent priority adds one optional persisted/state field:

```ts
interface Task {
  priority?: 'high';
}

interface AgentState {
  priority?: 'high';
}
```

Only elevated tasks are persisted. Missing priority means normal, keeping existing `tasks.json` files valid. The client command accepts `priority: 'normal'` only as a clear operation.

`TaskStore.setTaskPriority(taskId, priority)` owns mutation. It sets `priority = 'high'`, deletes the field for normal, updates `updatedAt`, and returns a cloned task snapshot. `Monitor.getSnapshot()` projects `priority` for live, pending, and terminal synthetic entries.

### Discoverability

Discovery should happen in the UI where the user already scans for work:

- The organizer's visible-project section is explicitly labeled "Visible priority order".
- The project context menu already exposes drag/keyboard move actions, and the manager labels their outcome as priority order.
- The first time a high-priority agent badge appears, no separate explanation is needed; the badge and row order make the behavior inspectable.
- The onboarding tour already covers shortcuts and layout. Do not add another modal step in this PR; the priority controls are visible in their primary surfaces.

## Files To Change

- `docs/rfc/issue-578-priority-ordering/RFC.md`
- `src/shared/contracts/task.ts`
- `src/shared/contracts/agent-state.ts`
- `src/shared/contracts/messages.ts`
- `src/shared/contracts/client-message-schema.ts`
- `src/core/task-read-model.ts`
- `src/core/tasks.ts`
- `src/core/monitor.ts`
- `src/server/ws.ts`
- `src/server/ws-handlers/lifecycle-handler.ts`
- `src/frontend/agent-buckets.ts`
- `src/frontend/agent-priority-order.ts`
- `src/frontend/store/slices/triage-navigation-slice.ts`
- `src/frontend/store/project-sidebar-prefs.ts`
- `src/frontend/components/ProjectSidebar.tsx`
- `src/frontend/components/ProjectSidebarManager.tsx`
- `src/frontend/components/FindingsPanel.tsx`
- Tests:
  - legacy `tasks.json` without priority loads
  - high priority persists and normal priority removes the field
  - client message schema accepts only `high | normal`
  - monitor snapshot copies priority for live, pending, and terminal tasks
  - critical normal finding beats warning high finding
  - same-severity high priority beats normal priority
  - healthy/pending priority and project rank order rows
  - unordered projects do not inherit dynamic summary order as priority
  - keyboard navigation matches visible ordering
  - shared-task priority mutation is rejected without mutation
  - shared-task priority mutation succeeds for local tasks and clears on normal
  - sidebar label changes preserve existing pinned/ordered state

## Edge Cases

- A high-priority healthy agent should not jump ahead of an active finding.
- A warning finding marked high priority should not jump ahead of a critical finding.
- If two high-priority agents are in different projects, project priority order breaks the tie.
- If the selected project is filtered, agent sorting only considers agents in that filtered project.
- Existing tasks without `priority` remain normal and serialize unchanged unless the user toggles them.
- Shared/contact tasks cannot be locally mutated; the existing lifecycle shared-task guard applies to `setTaskPriority`.
- If sidebar state is unavailable, project priority falls back to current server summary order.
- Hidden projects are not considered by project-priority navigation until shown again.
- Priority changes keep selection by `agentId`/`taskId`; keyboard navigation resumes from the selected task's new position.
- Pending priority affects display only. Launch promotion remains FIFO in this issue.
- The dashboard should avoid priority-order jumps before project-sidebar hydration by using the current visible order and then reconciling once; #579 can add stricter server-side hydration rules if needed.

## Alternatives Considered

### Numeric Project And Agent Scores

Rejected. Numeric scoring is hard to visualize and invites false precision. The user asked for easy setting and discovery; drag order plus a high-priority section maps directly to what the dashboard already shows.

### Separate Priority Settings Page

Rejected. It would be discoverable only after the user already knows the feature exists. Sidebar and row-level controls keep the setting at the point of use.

### Store Project Priority In Project Config

Rejected for this issue. `ProjectConfigStore` is server-owned project metadata, but the dashboard already has a dedicated persisted sidebar state with ordering, pinning, hidden rows, catalog recovery, local migration, and a REST endpoint. Duplicating order in `project-configs.json` would create two project order sources.

### Treat Pinned Projects As A High Priority Tier

Rejected after round-1 review. It would silently reinterpret existing pinned projects and make a display preference carry routing semantics. The accepted v2 scope uses visible sidebar order as the project priority sequence and leaves pinning semantics unchanged.

### Let Priority Override Severity

Rejected. Kookr should not bury critical failures because a user marked another task high priority. Priority is a tiebreaker beneath anomaly severity.

## Critic Feedback Incorporated

- Design-minimalist: kept pin/unpin semantics unchanged, removed completed-row mutation, and dropped snoozed/completed priority sorting.
- Boundary review: added a named project-priority helper, clarified the `setTaskPriority` command boundary, and kept #579 from depending on React state.
- Failure-mode review: specified stable tie-breakers, live/pending/terminal snapshot projection, normal-as-delete persistence, and visible failure behavior.
- Delivery review: narrowed scope to main findings/agent list rows and added concrete tests.
- Socratic review: clarified existing pinned-project behavior, command-only `normal`, selected-row behavior after reorder, and accessibility of visible labels.
