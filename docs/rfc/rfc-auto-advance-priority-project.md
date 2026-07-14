# RFC: Auto-Advance to Next Priority Project

**Status:** Draft (v3 — post round-2 revision, ready for user review)
**Date:** 2026-05-24
**Author:** Jean Ibarz (with Claude)

---

## Problem

Power users running 10+ kookr projects in parallel waste time navigating between projects to find what needs their attention. Today the user manually selects a project from the sidebar and stays there until they decide to switch. There is no programmatic concept of "the project that most needs me right now," so even when the current project goes quiet, the user has to scan the sidebar and click another project themselves.

The user-facing need:

> "When no agents need help on a project, it would be cool if you were transported to the next project that's the most important after it."

The cost of *not* having this is silent: time spent looking for work rather than doing it, and decision fatigue from re-scanning project state every few minutes. The cost of the wrong design is loud: a view that yanks focus while the user is mid-thought, or that jumps based on a "priority" heuristic the user doesn't trust.

## Empirical Checkpoint

Three load-bearing claims from round 1 critics were verified against the current code in `/home/jean/git/kookr-rfc-auto-advance/`:

- `selectProject()` in `src/frontend/store/slices/project-sidebar-slice.ts:96–138` already calls `selectAgent(findings[0].agentId)` whenever the target project has any active findings. This means a naive `tick() → selectProject(target)` immediately establishes selection on a finding in the new project, which under a selection-based engagement guard self-disables the mode after the first switch. The cascade-engagement bug is real and is the most important v2 change.
- The dashboard's six dialog flags (`showLaunch`, `showSettings`, `showSnooze`, `showSchedules`, `showShortcuts`, `showCostComparison`) are React-local `useState` in `src/frontend/App.tsx:81–92`. They are not in the Zustand store, so a store-side "suppress tick while dialog open" guard cannot be implemented as a selector without first lifting the state. The v1 proposal of a `dialogOpen` selector was unimplementable as written.
- `SettingsDialog.tsx:30` defines `SettingsFocusField` as an exhaustive union (`'maxActiveTasks' | 'relayConnection'`). Adding a deep-link target from the pill would require extending this union and the `FOCUS_FIELD_TAB` record. v2 cuts the deep-link entirely (see Design §7), making this moot.
- `e2e/battle-helpers.ts injectAgentMessage` and surrounding helpers hard-code `cwd: '/test/project'`. There is no multi-project E2E primitive today; a multi-project auto-advance E2E test is new fixture work, not a reuse. v2 scopes E2E down to a single Playwright scenario built on a new helper.
- `TelemetryEventType` in `src/shared/contracts/telemetry.ts` is an exhaustive discriminated union; `'auto_advance_overridden'` is already a member (line 3). New event types (`'auto_advance_switch'`, `'auto_advance_enabled'`, `'auto_advance_disabled'`) MUST be added to that union or the `track()` call will not type-check. v3 adds `telemetry.ts` to the Files to change list.
- The DnD hook at `src/frontend/hooks/useDnd.ts:116,153` is the established precedent for module-load side effects: it guards `addEventListener` with `typeof window !== 'undefined'` and exports a `__resetDndForTests()` escape hatch. v3 mirrors this pattern for the auto-advance subscribe and storage listener.
- `transport-session-slice.ts:selectedAgentUpdateAfterServerState` (lines 33–55 and call sites at 92, 117) writes `selectedAgentId` without going through `selectAgent()`. It is the only non-action path that mutates the selection. v3 adds this slice to the file list so the path also sets `selectedAgentSource: 'manual'`.
- `App.tsx:175,187–205` shows `handleLaunchManualTask` and `handleRunPlaybook` depend on `selectedProjectSummary` in their `useCallback` dep arrays. However, the dialog they open passes `launchProjectContext`, which is a React `useState` value captured at dialog-open time (`setLaunchProjectContext(selectedProjectSummary)` is called *inside* the callback before the dialog opens). Auto-advance firing while the dialog is open does NOT corrupt the dialog's project context: the snapshot is captured at click-time, not read live during submission. This is one of the modal-safety claims the round-1 RFC made without citation; v3 cites it.

These facts drive the v3 design: do not auto-select an agent on auto-switch, do not gate on dialog state, do not ship Settings deep-linking, do not promise broad E2E coverage in v1, follow the DnD precedent for module-load cleanup, and cover both selection write paths.

## Goals

- Provide an opt-in mode that automatically switches the active project to the highest-priority project with at least one active finding, so the user spends time triaging rather than navigating.
- Make the mode's on/off state continuously visible in the dashboard chrome, so the user always knows whether their view might shift under them.
- Use the user's existing pinned-and-ordered sidebar as the priority source. Do not invent a new "priority" mental model.
- Guard against focus stealing: never switch away while the user is engaged with a manually selected agent on the current project, either through an active finding or focused terminal/reply input.
- Make the trigger explicit and small: one classifier function, one engagement predicate, one subscriber callback.
- Ship in a single PR. Opt-in feature → no staging or feature flag needed.

## Non-Goals

- Do not change the manual `selectProject()` UX. Manual selection still wins and pauses any auto-switch consideration until the user takes the next "release" gesture.
- Do not introduce a new project-priority concept. Pinned + sidebar order is the priority source.
- Do not implement auto-advance for mobile in v1. Mobile uses a tab-based layout and a project switch reshuffles two tabs at once, which is more disruptive than the desktop sidebar shift. v1 hides the pill entirely on mobile via CSS breakpoint — no inert control is shipped.
- Do not implement an "idle detection" engagement model. Engagement is based on manual selection plus an active finding or focused terminal/reply input, with explicit release events, per Design §3.
- Do not auto-advance to a project that has only *healthy* tasks. The mode is for attention routing; healthy projects don't need attention.
- Do not page or notify outside the dashboard.
- Do not ship a configurable settle delay in v1. Hardcoded 2000 ms. Configurability is a v2 add only if real users report 2000 ms is wrong.
- Do not ship a Settings panel section in v1. The pill itself is the only configuration surface.
- Do not ship a `dialogOpen` suppression guard. See Edge cases for the rationale and the modals that need a separate fix if any prove unsafe.

## Requirements

- The user SHALL be able to toggle Auto-Advance on or off with `Alt+F`, and the shortcut SHALL appear in the ShortcutsHelp panel under Navigation.
- The dashboard SHALL display the Auto-Advance on/off state in the TopBar via a `FollowPill` placed adjacent to the existing `DndPill`.
- When the user enables Auto-Advance, the dashboard SHALL evaluate the priority queue and switch to the highest-priority eligible project, after a 2000 ms settle delay. If the current project is already the highest-priority eligible project, the switch is a no-op.
- When Auto-Advance is on and the priority queue's head changes (because a new finding appeared on a higher-priority project, OR because the current project lost all findings and the head fell through to another project), the dashboard SHALL switch to the new head, after a 2000 ms settle delay, UNLESS the user is currently engaged with a manually selected agent on the currently-selected project. Engagement is held by an active finding or by focus in the terminal or reply input.
- An auto-advance switch SHALL change `selectedProject` only. It SHALL NOT auto-select an agent in the destination project. The switch SHALL still invoke the existing `selectAgent(null)` side-effect cleanup so `respondAllAgentIds`, `leftPane`, and `narrowTab` are reset to their default values. (See Design §4 for why and how.)
- The user's engagement SHALL be defined as: `selectedAgentId` is set, `selectedAgentSource === 'manual'`, and the selected agent exists with either `isActiveFinding()` true or `focusZone !== 'none'`. Engagement SHALL be released when:
  - the user uses next-finding (Alt+N), next-task (Alt+J), previous-task (Alt+K);
  - the user presses Esc to deselect;
  - the user manually selects a different project;
  - focus leaves the terminal or reply input;
  - the engaged agent's `isActiveFinding()` flips to false (anomaly cleared, snoozed, suppressed, terminal status) while no focus zone is held;
  - the user snoozes, completes, or cancels the agent.
- Priority order SHALL be: pinned projects in their sidebar order (top of pinned list = highest priority), followed by unpinned projects in their sidebar order.
- The Auto-Advance on/off state SHALL persist across page reloads via `localStorage` key `kookr-auto-advance-mode`, and SHALL synchronize across open tabs via the `storage` window event.
- Auto-Advance SHALL emit a telemetry event on every actual switch via the existing `track()` infrastructure: `{ type: 'auto_advance_switch', from, to, cause, settleMs }`. No persistent log buffer is shipped in v1.
- The `FollowPill` SHALL expose a small popover (on caret click) showing: current mode state, current "why it isn't switching" reason if not switching, and the last switch (`from → to · cause · time ago`). The popover is the user-facing audit surface in v1; there is no Settings panel.
- The `FollowPill` SHALL NOT render on mobile viewports.
- Auto-Advance evaluation SHALL be implemented as a single Zustand `subscribe()` outside React, with an early return when `autoAdvanceEnabled === false`. Users with the feature off SHALL incur zero per-update React render cost. The subscribe SHALL be attached only when `typeof window !== 'undefined'` (SSR / Node test safety).
- The slice SHALL export `__resetAutoAdvanceForTests()` that removes the subscribe, the storage listener, and any pending settle timer. The DnD precedent at `src/frontend/hooks/useDnd.ts:153` is the pattern.
- The settle timer's fire-time re-evaluation SHALL re-check `autoAdvanceEnabled === true` in addition to the queue head and engagement guard. A toggle-off mid-settle SHALL cancel the switch.
- `tick()` SHALL be wrapped in a try/catch. On error the slice SHALL set `autoAdvanceError: { message, firstSeenTs }`. The popover SHALL render the error with "first seen Ns ago" so the user can distinguish a transient blip from a persistent fault. `autoAdvanceError` SHALL be cleared on the next successful `tick()` completion. The slice SHALL continue evaluating on subsequent updates without disabling the mode.
- `lastTickReason` SHALL be written only when `tick()` reaches an actual decision point (`no_eligible_project`, `already_top`, `engaged`, `settling`, `scheduled`). It SHALL NOT be overwritten when the subscriber's pre-tick early-exit guards fire (mode off, not hydrated, unrelated update). This prevents popover flicker on every store update.
- The `FollowPill` popover SHALL render display strings, not raw enum values: `engaged` → the existing "You have a finding selected" copy (also used when terminal/reply-input focus holds engagement); `already_top` → "Already on the highest-priority project"; `no_eligible_project` → "No project has active findings"; `settling` → "Switching in ~2s…"; `scheduled` → "Scheduled".

## Design

### 1. Priority queue

A pure function `autoAdvanceQueue(state)` returns the ordered list of candidate projects. It reads:

- `visibleProjectSummaries` (already sidebar-ordered)
- `projectSidebarPrefs.pinned` (the pinned set)
- `agents` (to filter by `isActiveFinding`)

```ts
function autoAdvanceQueue(state: {
  visibleProjectSummaries: ProjectSummary[];
  projectSidebarPrefs: { pinned: string[] };
  agents: AgentState[];
}): string[] {
  const pinnedSet = new Set(state.projectSidebarPrefs.pinned);
  const hasFinding = new Set(
    state.agents.filter(isActiveFinding).map((a) => a.projectId),
  );
  const eligible = state.visibleProjectSummaries
    .map((p) => p.project)
    .filter((projectId) => hasFinding.has(projectId));
  const pinnedFirst = eligible.filter((id) => pinnedSet.has(id));
  const rest = eligible.filter((id) => !pinnedSet.has(id));
  return [...pinnedFirst, ...rest];
}
```

**Worked example.** Sidebar layout (top to bottom):

| Pinned | Project           | Active findings |
|:------:|-------------------|:---------------:|
| yes    | `org/api`         | 0               |
| yes    | `org/web`         | 2               |
| yes    | `org/infra`       | 1               |
| no     | `org/docs`        | 5               |
| no     | `org/scripts`     | 1               |

`autoAdvanceQueue` returns `['org/web', 'org/infra', 'org/docs', 'org/scripts']`. `org/docs` having 5 findings does NOT promote it above any pinned project: pinned + sidebar order is the priority source.

### 2. Subscriber and trigger

Implemented as a Zustand `subscribe()` set up once at store creation, NOT a React `useEffect([agents])`:

```ts
// In createAutoAdvanceSlice, after slice initialization:
const unsubscribe = useKookrStore.subscribe((state, prevState) => {
  if (!state.autoAdvanceEnabled) return;                  // zero-cost when OFF
  if (!state.agentsHydrated || !state.projectSummariesHydrated) return;
  if (
    state.agents === prevState.agents &&
    state.selectedAgentId === prevState.selectedAgentId &&
    state.selectedProject === prevState.selectedProject &&
    state.autoAdvanceEnabled === prevState.autoAdvanceEnabled &&
    state.focusZone === prevState.focusZone
  ) {
    return;                                                // unrelated update
  }
  tick(state);
});
```

`tick(state)` evaluates the guard chain. On each call it produces one of these outcomes, all of which are recorded in the in-memory `lastTickReason` field for popover display:

| outcome              | next step                                                |
|----------------------|----------------------------------------------------------|
| `no_eligible_project`| no-op; mode remains ON                                   |
| `already_top`        | no-op                                                    |
| `engaged`            | no-op (user has an engaged agent selected or focused)    |
| `settling`           | timer already pending; recompute on fire                 |
| `scheduled`          | start 2000 ms timer; fire after delay re-checks guard    |

The settle timer is a module-level closure managed by the slice initializer (a single `let pendingTimer: ReturnType<typeof setTimeout> | null`). At fire time, the slice **recomputes** the queue from current store state and re-checks the guard. This protects against drag-during-settle and stale-anomaly races (failure-mode #8 and #10): the schedule-time target is never trusted; only the fire-time state matters.

### 3. Engagement guard

```ts
function engagedWithAgent(state: {
  selectedAgentId: string | null;
  selectedAgentSource: 'manual' | 'auto-advance';
  focusZone: 'terminal' | 'response-input' | 'none';
  agents: AgentState[];
}): boolean {
  if (!state.selectedAgentId) return false;
  if (state.selectedAgentSource !== 'manual') return false;
  const agent = state.agents.find((a) => a.agentId === state.selectedAgentId);
  if (!agent) return false;
  return state.focusZone !== 'none' || isActiveFinding(agent);
}
```

The fields `selectedAgentSource` and `focusZone` define engagement. `selectedAgentSource` is the cascade-engagement fix (Empirical Checkpoint, finding 1); `focusZone` preserves a manually selected healthy agent while the user types into its terminal or reply input. Type is `'manual' | 'auto-advance'` (no `null` third state — when `selectedAgentId` is null, the engagement guard short-circuits before reading the source). Default is `'manual'`.

Invariant (enforced by convention + a slice-internal helper):

- Any call path that sets `selectedAgentId` from a user action (Esc, Alt+N/J/K, manual project select, sidebar click, mobile tab tap, settings reset, terminal-action keys, **server-driven eviction via `selectedAgentUpdateAfterServerState`**) sets `selectedAgentSource = 'manual'`.
- The auto-advance branch — the only call site that should not establish engagement — sets `selectedAgentSource = 'auto-advance'`.

To make this less footgun-y, every write to `selectedAgentId` in the codebase goes through a shared `applySelection({ agentId, source })` helper exported by the auto-advance slice. The two call paths that write `selectedAgentId` today (`triage-navigation-slice.ts`'s `selectAgent`/`nextBottleneck`/`nextTask`/`previousTask` and `transport-session-slice.ts`'s `selectedAgentUpdateAfterServerState`) are refactored to call `applySelection({ agentId, source: 'manual' })`. The auto-advance path calls `applySelection({ agentId: null, source: 'auto-advance' })`. Adding a new selection call site without going through `applySelection` is a code-review smell; a follow-up RFC may convert this convention into a type-level enforcement (e.g., making `selectedAgentId` a private store field).

Release events (the full set):

| Event                                                          | Engagement released? |
|----------------------------------------------------------------|:--------------------:|
| `selectAgent(null)` (Esc)                                      | yes                  |
| `selectAgent(other)` from a user gesture                       | yes                  |
| `nextBottleneck()` (Alt+N)                                     | yes                  |
| `nextTask()` / `previousTask()` (Alt+J / K)                    | yes                  |
| Focus leaves terminal or reply input                            | yes, if no finding remains |
| Engaged agent's `isActiveFinding()` flips to false             | yes — predicate goes false |
| Engaged agent's `anomaly` clears (reply, fix, server-side)     | yes — same as above  |
| Snooze / complete / cancel of the engaged agent                | yes — predicate goes false |
| Manual `selectProject()`                                       | yes                  |
| User opens a modal / context-menu / clicks the sidebar         | no — selection unchanged |
| User Cmd-Tabs to another browser tab                           | no — selection unchanged |
| Auto-advance switches the project                              | new selection is `auto-advance`-sourced → no engagement |

**Reply-Enter row removed from v1.** Round 1 surfaced that the slice cannot directly observe an Enter key in the reply input; the only signal is the anomaly clearing server-side. The release model is therefore state-derived: when the anomaly clears while no focus zone is held, the engagement predicate flips. If the terminal or reply input remains focused, blur or a gesture-based release is still required. A heavy bottleneck whose anomaly does *not* clear after a reply will likewise keep the engagement guard active until the user takes one of the gesture-based release actions (Esc, Alt+N/J/K, etc.). This is documented in the popover help text.

**Known v1 loophole:** a user who opens a finding and walks away from the keyboard remains "engaged" indefinitely. Auto-Advance will not switch out of that project. Focus-based engagement is released on blur, but an active finding remains engaged until its explicit release event. This is documented and accepted for v1 in favor of predictability. An idle-based release is deferred.

### 4. Auto-switch must not establish engagement

The fix for the cascade-engagement bug (Empirical Checkpoint, finding 1) has two acceptable shapes; v3 picks (a) for minimal diff:

- **(a) Add a `source` option to `selectProject`.** Extend the existing `selectProject(project)` signature to `selectProject(project, options?: { source?: 'manual' | 'auto-advance' })`. When `source === 'auto-advance'`:
  - Skip the agent auto-select block at `project-sidebar-slice.ts:115–137` (the highest-severity finding scan and healthy fallback).
  - Still invoke `selectAgent(null)` (which the existing line 137 does as a no-finding fallback) to clear `respondAllAgentIds`, `leftPane`, and `narrowTab`. **Skipping this call strands stale side state** — caught in round-2 review.
  - `selectAgent(null)` goes through `applySelection({ agentId: null, source: 'auto-advance' })` per Design §3.
- **(b) A separate `selectProjectFromAutoAdvance(project)` action.** Discarded: duplicates logic and risks drift.

The user lands on the destination project's findings panel with no agent selected, the panes/tabs reset to their defaults, and chooses what to triage. This matches the user's stated intent: auto-advance to the *project*, not to a specific finding.

### 5. Mode persistence and cross-tab sync

```ts
// store-types.ts adds:
autoAdvanceEnabled: boolean;
selectedAgentSource: 'manual' | 'auto-advance';
lastTickReason: TickReason | null;
lastAutoSwitch: { from: string | null; to: string; cause: SwitchCause; ts: number } | null;
autoAdvanceError: { message: string; firstSeenTs: number } | null;
toggleAutoAdvance(): void;
applySelection(input: { agentId: string | null; source: 'manual' | 'auto-advance' }): void;
```

`lastTickReason` is slimmed to the bare enum per round-2 design-minimalist (the `ts`/`queueHead` fields were YAGNI; the popover only renders the kind). `autoAdvanceError` carries a `firstSeenTs` so the popover can show "first seen Ns ago" and the user can tell transient from persistent (round-2 operability).

Storage keys:

- `kookr-auto-advance-mode` — `'1'` (on) or absent (off).

Cross-tab sync: the slice attaches `window.addEventListener('storage', ...)` on initialization, guarded by `typeof window !== 'undefined'`. When another tab writes `kookr-auto-advance-mode`, the listener updates the in-memory `autoAdvanceEnabled` to match. This addresses failure-mode #6: toggling in one tab is reflected in all open tabs. The settle timer's fire-time guard re-checks `autoAdvanceEnabled === true`, so a mid-settle cross-tab toggle-off cancels the in-flight switch (round-2 failure-mode race).

### 6. Keyboard shortcut

`Alt+F` ("Follow") enables/disables Auto-Advance. Rationale for `F`:

- All other Alt-letter shortcuts (A, J, K, L, M, N, P, R, S, Z) are taken (per `ShortcutsHelp.tsx:11–59` plus `Alt+P` for project sidebar at `App.tsx:293`).
- `F` is mnemonic ("Follow priority").
- Pairs naturally with `Alt+J/K` triage navigation on the left hand.

The handler lives in the existing `handleKeyDown` block in `App.tsx:208–360`.

### 7. Status indicator: `FollowPill`

A new `FollowPill` component renders in the TopBar `topbar-right` cluster, immediately left of `DndPill`. It mirrors `DndPill`'s structure for visual consistency:

- A toggle button with a filled (●) or hollow (○) dot icon and the label `FOLLOW`. (Not "AUTO"; round-1 critic flagged ambiguity, and "FOLLOW" matches the Alt+F mnemonic.)
- `aria-pressed` reflects state. The tooltip describes current state plus interaction with DND ("Follow + DND: project still switches; alerts stay silenced").
- A caret button opens a popover containing:
  - Toggle row (also accessible from the pill click).
  - "Why am I not switching?" line — display-string mapping of `lastTickReason`: "You have a finding selected" (engaged), "Already on the highest-priority project" (already_top), "No project has active findings" (no_eligible_project), "Switching in ~2s…" (settling), "no decisions yet" (null).
  - "Last switch" line — `from → to · cause · 14s ago`, or "no switches yet."
  - Error line if `autoAdvanceError` is non-null: "Internal error — first seen Ns ago. Will resume on next state change."
- On mobile (CSS breakpoint), the pill is hidden entirely. No inert control ships.

There is no transient toast on switch in v1. The popover is the audit surface; the pill's filled dot + the new project visible in the sidebar are the moment-of-switch signal. Cutting the toast removes a third overlapping surface.

### 8. Activation behavior

When the user toggles the mode ON:

1. Persist to `localStorage` and update in-memory state.
2. Emit `auto_advance_enabled` telemetry.
3. Manually invoke `tick(currentState)` once. The guard chain runs identically to any other tick. If a switch is scheduled, the 2000 ms timer starts and fires once. If the user is engaged at fire time, the timer's re-check no-ops and the mode waits for the next state update.

This resolves the v1 contradiction between "activation always starts a timer" and "scheduled only if guard passes." Activation enqueues a tick; the tick decides; the timer is scheduled only if the tick scheduled it.

### 9. Hydration semantics

`tick()` returns early unless both `state.agentsHydrated === true` and `state.projectSummariesHydrated === true`. Both flags already exist in the store. First evaluation happens automatically when the subscriber observes the second of these flags flipping to true with the mode ON. There is no separate "first render" hook needed.

## Files to change

- `src/frontend/store/slices/auto-advance-slice.ts` (NEW) — owns the new state fields, `toggleAutoAdvance`, `applySelection` helper, colocated `autoAdvanceQueue` and `engagedWithAgent` (no separate pure-functions file per round-1 design-minimalist guidance), `tick()` evaluator, settle-timer closure, the `useKookrStore.subscribe()` callback, the `storage` window event listener, and `__resetAutoAdvanceForTests` per `src/frontend/hooks/useDnd.ts:116,153` precedent. All side effects guarded by `typeof window !== 'undefined'`.
- `src/frontend/store/store-types.ts` — add the new fields and the `applySelection`/`toggleAutoAdvance` actions to `KookrStore`.
- `src/frontend/store/useStore.ts` — register the new slice.
- `src/frontend/store/slices/project-sidebar-slice.ts` — extend `selectProject` signature with `options?: { source?: 'manual' | 'auto-advance' }`. When `'auto-advance'`, skip the agent auto-select block (lines 115–137 today) but still call `selectAgent(null)` to clear `respondAllAgentIds`/`leftPane`/`narrowTab`. All existing call sites remain unchanged and default to `'manual'`.
- `src/frontend/store/slices/triage-navigation-slice.ts` — `selectAgent`, `nextBottleneck`, `nextTask`, `previousTask` route their `selectedAgentId` writes through `applySelection({ agentId, source: 'manual' })`.
- `src/frontend/store/slices/transport-session-slice.ts` — `selectedAgentUpdateAfterServerState` routes the `selectedAgentId: nextActionableFindingId(...)` and `selectedAgentId: null` writes through `applySelection({ agentId, source: 'manual' })`. Added to file list per round-2 delivery-pragmatist (selection write path coverage).
- `src/shared/contracts/telemetry.ts` — add `'auto_advance_switch' | 'auto_advance_enabled' | 'auto_advance_disabled'` to the `TelemetryEventType` union. (Existing `'auto_advance_overridden'` member is reused if it semantically matches the disable-on-manual-override flow; otherwise it stays untouched.)
- `src/frontend/App.tsx` — add `Alt+F` handler. No new `useEffect` for tick wiring (it lives in the slice's subscribe).
- `src/frontend/components/TopBar.tsx` — render `<FollowPill />` in the right cluster.
- `src/frontend/components/FollowPill.tsx` (NEW) — mirrors `DndPill.tsx` structure; popover content per Design §7; renders display strings, not raw enum values.
- `src/frontend/components/ShortcutsHelp.tsx` — add `Alt+F` row under Navigation.
- `src/frontend/styles.css` (or equivalent) — `.follow-pill*` classes paralleling `.dnd-pill*`; mobile-hiding media query.
- `src/frontend/store/slices/auto-advance-slice.test.ts` (NEW) — see Testing approach.

Files *not* changed: `Settings.tsx` (no Auto-Advance section), `SettingsDialog.tsx` (no `SettingsFocusField` extension), no separate `auto-advance.ts` pure module.

## Edge cases

- **No project has any active finding.** `tick()` records `no_eligible_project`, no-op.
- **The only-eligible project IS the current project.** `tick()` records `already_top`, no-op.
- **A higher-priority project gains a finding while user is engaged.** `tick()` records `engaged`, no-op. When engagement is released by blur or another release event, the next `tick()` re-evaluates and may schedule.
- **User manually selects a different project while a switch is settling.** The selectedProject change wakes the subscriber; `tick()` recomputes from new state; the pending timer is discarded (its fire-time re-check would correctly produce `already_top` or recompute), but we also clear it eagerly on `selectedProject` change for predictability.
- **Sidebar order changes (drag/reorder) while a switch is settling.** The schedule-time target is not stored; the fire-time `autoAdvanceQueue()[0]` is recomputed. The new top wins.
- **Stale anomaly on the scheduled target.** The fire-time re-check runs `autoAdvanceQueue()` and confirms `target` is still the head. If the target lost its findings between schedule and fire, the recomputed head wins (or `no_eligible_project` if none remain).
- **Currently-selected project hidden/unpinned by user.** Existing hide logic clears `selectedProject`. The subscriber observes the change and `tick()` evaluates from the cleared state.
- **A finding clears on the currently-selected project but other findings remain on it.** No auto-switch fires (current project is still in the eligible set; depending on its priority position, it may remain the head).
- **The user is on a project with no findings and a finding appears on a higher-priority project.** No engagement, no current-project gravity. Switch fires after settle. Central happy path.
- **Two findings arrive on different higher-priority projects simultaneously.** `autoAdvanceQueue()[0]` is deterministic. Higher-priority wins.
- **The mode is enabled but the user has no projects.** `tick()` records `no_eligible_project` (queue is empty). Pill remains togglable; the popover says "no eligible projects."
- **Page reload while mode is ON.** Slice initializer reads `localStorage` and sets `autoAdvanceEnabled: true`. The subscriber waits for `agentsHydrated && projectSummariesHydrated` to both be true. On the first qualifying update, `tick()` runs once and may schedule a switch. The user sees a 2 s pause then a switch to the priority head — predictable on reload.
- **DND is on.** DND silences notifications, not selection. Auto-Advance still runs and switches; DND just suppresses alerts. The pill tooltip documents this interaction explicitly so the user is not surprised. (DND-pauses-auto-advance is rejected: it would couple two opt-in modes with different scopes.)
- **Modal open at switch time.** A switch fires under the modal. The modal's local React state is unaffected. Audit (Empirical Checkpoint, finding 5): the Launch dialog's `projectContext` prop receives `launchProjectContext`, a React `useState` value set inside `handleLaunchManualTask`/`handleRunPlaybook` *before* the dialog opens (`App.tsx:175,187–205,757`). `handleLaunchManualTask` reads `selectedProjectSummary` live, but only at click time when the dialog is *opening*; the dialog body sees the snapshot. Snooze, Settings, Schedules, CostComparison, and ShortcutsHelp don't read `selectedProject` after opening. If a future modal introduces a live subscription, it gets a targeted fix; the global v1 suppression guard was unimplementable per Empirical Checkpoint finding 2.
- **Settle = 0?** Not configurable in v1. Hardcoded 2000 ms.
- **`tick()` throws.** Wrapped in try/catch. The error is captured to `autoAdvanceError` and displayed in the popover. The subscriber continues to run on subsequent updates.
- **Cross-tab toggle.** `storage` event listener updates in-memory state; the subscriber observes the flip on next update.
- **StrictMode double-mount.** The subscribe is set up once at module load (outside any component). StrictMode's double-effect does not apply. The settling-timer closure is single-instance.

## Alternatives considered

- **One-shot Alt+F shortcut (no mode, no pill, no state).** Rejected per user-frozen requirement: the user explicitly asked for a mode with on/off toggle and a visible status indicator. The on-demand shortcut alternative is a possible companion in v2 if the persistent mode proves friction-y.
- **Idle-based engagement release.** Mark engagement as released after N seconds of no keyboard/mouse, even if `selectedAgentId` is still a finding. Rejected for v1: adds an idle-detection layer, configurable threshold, and event-listener lifecycle. The walk-away loophole is documented and accepted. v2 candidate.
- **Priority by finding-count.** Rejected per user-frozen requirement: pinned + sidebar order is the priority source.
- **Priority by oldest finding age.** Rejected for the same reason; deferred as a possible v2 tiebreaker among unpinned projects.
- **Auto-advance on healthy → next.** Rejected: the mode is for attention routing.
- **Notification banner instead of selection change.** Rejected: removes the click, which is the point.
- **Per-project numeric priority weights.** Rejected: introduces UI the user did not ask for.
- **Run on mobile in v1.** Rejected as scope risk; deferred. v1 hides the pill on mobile rather than shipping a deliberately inert control.
- **Configurable settle delay in v1.** Rejected per round-1 design-minimalist guidance: the user offered "2s?" tentatively. v1 hardcodes 2000 ms; configurability is added only if real users report 2 s is wrong.
- **Settings panel section with audit log.** Rejected per round-1 design-minimalist guidance. The pill popover is the v1 audit surface.
- **Toast on every switch.** Rejected: the popover + the visibly-changed sidebar position make the switch obvious. Three audit surfaces (toast + popover + telemetry) for one feature is excessive.
- **Global `dialogOpen` suppression guard.** Rejected — architecturally impossible without lifting six React `useState` flags to Zustand. Existing modals capture their context at open time, so the audit shows the guard is unnecessary. If a future modal regresses, that modal gets a targeted fix.
- **Auto-select a finding in the destination project after auto-switch.** Rejected — it produces the cascade self-disable bug (Empirical Checkpoint, finding 1) and contradicts the user's intent of "transport to the project that needs me." Letting the user pick which finding to engage with is correct.

## Rollout plan

- Single PR. No feature flag, no staged rollout: the mode is off by default and gated behind a keyboard shortcut + a pill click.
- The PR includes the slice with colocated pure functions, the project-sidebar-slice signature extension, the triage-navigation-slice source-tagging, the FollowPill component, the Alt+F handler, the ShortcutsHelp entry, the CSS, the telemetry hook, and the unit/integration test file.
- No migration. The new `localStorage` key defaults to off.
- The PR description SHOULD include a note that DND and Auto-Advance are intentionally independent.

## Testing approach

Unit tests (single new test file: `auto-advance-slice.test.ts`). Use `__resetAutoAdvanceForTests()` in `beforeEach` / `afterEach` to avoid module-load listener leaks across tests.

- `autoAdvanceQueue`: pinned-first ordering; pinned ordering matches sidebar order; unpinned ordered by sidebar; eligibility filter excludes projects with no `isActiveFinding`.
- `engagedWithAgent`: selection null → false; selection of healthy agent without focus → false; focused terminal and reply-input selection of a healthy agent → true; selection of finding agent with `source: 'manual'` → true; selection of finding agent with `source: 'auto-advance'` → false (cascade-engagement non-regression); selection of snoozed/suppressed/terminal agent without focus → false.
- `tick()` outcomes for each guard: `no_eligible_project`, `already_top`, `engaged`, `settling`, `scheduled`. Each row asserts the resulting `lastTickReason`.
- `lastTickReason` is NOT overwritten when the pre-tick early-exit fires (mode off, not hydrated, unrelated update).
- Settling timer is cancelled when `selectedProject` changes during settle.
- Settling timer is cancelled when `autoAdvanceEnabled` flips to false during settle (covers cross-tab mid-settle race).
- Re-firing `tick()` while a timer is pending does not double-schedule.
- Fire-time queue recomputation: schedule with target A, mutate state so target is now B, advance the timer, assert switch goes to B.
- Fire-time `autoAdvanceEnabled` re-check: schedule, toggle off mid-settle, advance timer, assert no switch.
- Cross-tab `storage` event: dispatch a `storage` event for `kookr-auto-advance-mode='1'` → in-memory `autoAdvanceEnabled` becomes true.
- Hydration gating: tick is a no-op until both `agentsHydrated` and `projectSummariesHydrated` are true.
- `tick()` error path: forced throw → `autoAdvanceError` set with `firstSeenTs`; recurring throw with same message does not bump `firstSeenTs`; recovery clears the error.
- Telemetry event emitted exactly once per actual switch; `auto_advance_enabled` and `auto_advance_disabled` emitted on toggle.
- Auto-advance side-effect cleanup: switch from a project where `respondAllAgentIds` and `leftPane !== 'activity'` are set → after switch, both are reset (covers round-2 stranded-side-effect bug).
- `applySelection` invariant: every selection write produces a consistent `selectedAgentId`/`selectedAgentSource` pair.

Integration test (small): toggling the pill flips `autoAdvanceEnabled` in the store and the subscriber starts evaluating.

E2E (Playwright): one scenario only in v1. Toggle the pill via `Alt+F`, confirm it changes state and persists across reload. Multi-project switch coverage is deferred until a multi-project E2E fixture exists (Empirical Checkpoint, finding 4).

## Open questions for review

- Should `tick()` impose a small grace period (e.g., 500 ms) before treating an engaged-agent's anomaly clearing as a release event, so the user can read the "anomaly cleared" message before any auto-switch? Current design: release is immediate.
- Should the cross-tab `storage` listener also synchronize the popover's `lastAutoSwitch` and `lastTickReason`, or are those naturally per-tab? Current design: per-tab.
- Should `FollowPill` show a small pulsing dot during the settle window (between `scheduled` and `switched`)? Round-1 operability-reviewer flagged this as v2-acceptable; v1 omits it.

## Critic feedback incorporated (Round 1)

The round was 5 critics in parallel: design-minimalist, failure-mode-analyst, socratic-challenger, delivery-pragmatist, operability-reviewer.

**Adversarial pair resolution.** design-minimalist (cut everything not load-bearing) vs the safety/operability/delivery cluster (add safety and visibility). On the points where they conflicted directly:

- *Settings panel + ring buffer + configurable delay.* design-minimalist won: cut. operability's concern about durable audit is addressed by `lastTickReason` + `lastAutoSwitch` in the pill popover, which is in-memory only — accepted gap, smaller than a Settings section.
- *Telemetry event.* design-minimalist wanted to cut; operability wanted to keep. Kept. The infrastructure already exists (`track()`), the cost is one line, and it answers "why did it jump?" for users with telemetry visibility.
- *Toast on switch.* design-minimalist kept; operability wanted a cause field. Both cut in v2 — the popover absorbs the audit role; the sidebar position change is the moment-of-switch signal.
- *Dialog suppression guard.* design-minimalist wanted to cut; delivery-pragmatist proved it was architecturally impossible. Cut. Audit confirms current modals are safe.
- *Separate pure-functions file, caret-dropdown complexity, mobile inert pill.* design-minimalist won on all three.

**Failure-mode-analyst findings.** All four critical findings addressed: cascade self-disable (Design §4, `selectedAgentSource`), cross-tab desync (Design §5, `storage` event listener), hydration semantics (Design §9, explicit flag gating), reply-Enter release lie (removed from §3 release table, documented in popover help). Drag-during-settle and stale-anomaly fixed by fire-time queue recomputation (Design §2). Activation contradiction with state machine resolved (Design §8). StrictMode timer leak prevented by module-load subscribe (no React lifecycle).

**Socratic-challenger findings.** "Next AFTER it" interpretation: user-frozen requirement specifies highest priority; documented in Alternatives. "Jumping away while current project still needs help": correct per user-frozen requirement #4, the user explicitly asked for switch on higher-priority finding arrival. "Could it just be a one-shot shortcut": user-frozen requirement mandates a mode with visible status; documented in Alternatives. "FOLLOW vs AUTO label" → adopted FOLLOW. "Configurable 2s over-anchored on parenthetical" → cut configurability. "Dialog suppression with `?` shortcut" → cut. "Mobile inert pill" → cut, hide entirely. "Three audit surfaces" → cut toast, kept popover + telemetry.

**Delivery-pragmatist findings.** Dialog-guard architectural impossibility → confirmed empirically, cut. Hot-path regression → adopted Zustand `subscribe()` with early return when OFF, zero per-update React render cost (Design §2). Timer ownership → resolved as module-level closure, not React ref. SettingsFocusField extension → moot now that the deep-link is cut. E2E multi-project fixture → v1 ships a single Playwright scenario; multi-project deferred. CSS file → added to Files to change.

**Operability-reviewer findings.** No-op visibility → `lastTickReason` shown in popover with the full reason set. Cause in toast → toast cut; cause shown in popover's "Last switch" line instead. Durable log → in-memory only in v1 (operability flagged this as a "v1 small cost," but design-minimalist's pushback won; the gap is documented). Settle-pending indicator → deferred to v2 per reviewer's own classification. Error catch → adopted (Design §2, Requirements). Ops-panel diagnostic tab → deferred to v2.

## Critic feedback incorporated (Round 2)

The round was 4 critics in parallel: design-minimalist, failure-mode-analyst, delivery-pragmatist, operability-reviewer. Socratic-challenger was skipped — round-1 surfaced no question of intent that v2 didn't address.

**Adversarial pair resolution.** design-minimalist (round 2) called convergence and proposed two tight trims; failure-mode-analyst and delivery-pragmatist proposed real correctness fixes; operability-reviewer proposed two real diagnostic fixes. No direct conflicts emerged this round — minimalist's trims (drop `null` from `selectedAgentSource`, drop `ts`/`queueHead` from `lastTickReason`) are orthogonal to the safety/operability adds. Both adopted.

**Failure-mode-analyst findings.** Stranded `respondAllAgentIds`/`leftPane`/`narrowTab` after auto-switch (v2 bypassed `selectAgent(null)`) → fixed in Design §4 by keeping the `selectAgent(null)` call. `selectedAgentSource` discipline footgun → addressed via `applySelection` helper (Design §3) routing all selection writes through one entry point. Mid-tick cross-tab toggle race → addressed by fire-time `autoAdvanceEnabled` re-check (Design §5, Requirements). Persistent-error log spam → addressed by `firstSeenTs` and error de-dup on identical messages (Requirements + test). Module-load `storage` listener test isolation → addressed by `__resetAutoAdvanceForTests()` per DnD precedent (Empirical Checkpoint finding 6). Modal audit not actually proven → cited explicitly in Empirical Checkpoint finding 5 (Launch dialog uses `useState` snapshot at click time).

**Delivery-pragmatist findings.** `TelemetryEventType` union extension required → `telemetry.ts` added to Files to change. `selectedAgentUpdateAfterServerState` not in file list → `transport-session-slice.ts` added. `__resetAutoAdvanceForTests` per DnD precedent → adopted (Empirical Checkpoint finding 6, Requirements). `selectProject` call-site default behavior → confirmed safe via the optional-parameter default. Launch callback live-rebind risk → resolved per the dialog-uses-useState-snapshot audit (Edge cases). E2E scope → confirmed single Playwright scenario in v1 (Testing approach).

**Operability-reviewer findings.** `autoAdvanceError` stickiness → fixed with `firstSeenTs` + clear-on-success + de-dup on identical messages (Requirements + test). `lastTickReason` flicker → fixed by writing only at decision points, never on pre-tick early-exit (Requirements + test). Display-string mapping in popover → made explicit (Requirements, Design §7). Single-slot history → kept (per design-minimalist v1 pushback; documented gap for v2). Caret discoverability → accepted as v2 polish.

**design-minimalist findings (round 2).** Drop `null` from `selectedAgentSource` → adopted; type is now `'manual' | 'auto-advance'` with `'manual'` default. Drop `ts` and `queueHead` from `lastTickReason` → adopted; type is now `TickReason | null`. Cross-tab `storage` sync proposed for cut → REJECTED; failure-mode-analyst round 1 flagged tab desync as a critical user-trust bug; the listener is one `addEventListener` line and one test row, and the cost of regressing the round-1 finding outweighs the trim.

## Stopping criterion

This RFC stops at v3 (round 2 done) per the task brief specifying 2 critic rounds. Round 2 produced 8 substantive items, all incorporated in v3; round 3 would likely find polish but no architectural blockers. The user reviews v3 before any implementation.
