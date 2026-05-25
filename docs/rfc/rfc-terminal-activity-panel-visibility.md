# RFC: Terminal And Activity Panel Visibility

## Status

**Draft (v4 - post-round-3 revision)** (2026-05-25)

---

## Problem

The task detail view gives Kookr users two high-value surfaces:

- the structured Activity/GitHub pane, with hook events, tool groups, findings,
  GitHub context, and diff entry points;
- the Terminal/Diff pane, with raw agent output, terminal input, and opened
  diffs.

On wide screens, `DetailPanel.tsx` renders those panes side by side. On narrow
detail layouts, it uses tabs. A separate terminal focus mode already exists on
desktop; it is toggled from the top bar, persisted in `localStorage`, hides
secondary dashboard chrome, hides the left detail pane, and gives the terminal
the available width.

That helps terminal-heavy work, but it is one-sided. Users who want to inspect
the structured activity log still share the detail width with the terminal.
Users who accidentally enter terminal focus mode can restore Activity only by
knowing that the small top-bar `>_` button is the global focus toggle. Kookr
therefore supports "both" and "terminal-only" in practice, but not
"activity-only" and not a discoverable local restore path.

## Current Behavior

Relevant implementation points on current `main`:

- `src/frontend/components/DetailPanel.tsx` owns the task detail split.
- `ActivityPanel` and `GitHubPanel` render in `.detail-split-left`.
- `TerminalPanel` and `DiffPane` render in `.detail-split-right`.
- `TerminalPanel` stays mounted while Diff is selected so xterm state and the
  WebSocket connection survive Terminal/Diff tab changes.
- `computeTerminalVisible()` tells `TerminalPanel` whether it is visually
  selected for fit/refresh behavior.
- `narrowTab` owns narrow detail tabs: `activity`, `terminal`, `github`.
- `terminalFocusMode` lives in the Zustand triage navigation slice and persists
  under `kookr-terminal-focus-mode`.
- `App.tsx` derives `terminalFocusActive = terminalFocusMode &&
  !isMobileViewport`, so app-shell chrome hiding is already an App-level
  decision, not a `DetailPanel` decision.
- `App.tsx` currently forces `narrowTab` to `activity` when mobile viewport is
  active and terminal focus was persisted.
- `TerminalPanel` registers global terminal send while mounted. The current
  registration is not guarded by its `visible` prop.
- There is no pre-hydration storage reader for terminal focus; `critical.css`
  is static.
- Existing E2E coverage includes terminal viewport budgets, terminal focus
  mode, mobile terminal tab geometry, and Activity/Diff/Terminal switching.

One code comment points at `docs/rfc/rfc-activity-panel-ux.md`, but that file
is not present in the current checkout. This RFC should not rely on that
missing document.

## Empirical Checkpoint

Round 1 review raised several load-bearing claims. Code inspection confirmed:

- Desktop terminal focus already has two concepts: persisted store state and
  `App.tsx`-derived desktop chrome suppression.
- Mobile and narrow detail behavior are not the same breakpoint. App mobile is
  `<=768px`; detail tabs appear at `<=1200px`.
- Hidden-but-mounted terminal is not automatically inert today because global
  terminal send is registered while the WebSocket is open.
- Terminal refit after `display:none` is already load-bearing:
  `TerminalPanel` refits and refreshes on `visible=true`.
- Static critical CSS cannot eliminate a first-paint split/sidebar flash for
  stored focus state without adding new boot-time script. This RFC does not add
  that script.

## Goals

1. Keep the current side-by-side Activity/GitHub + Terminal/Diff layout as the
   default.
2. Let users hide only the terminal pane so Activity/GitHub takes full detail
   width.
3. Let users hide only the Activity/GitHub pane so Terminal/Diff takes full
   detail width.
4. Let users restore a hidden pane from visible local pane chrome.
5. Preserve left-pane selection, right-pane selection, active diff state, and
   terminal scrollback/connection across visibility changes.
6. Persist the user's preferred panel mode across reloads.
7. Keep narrow/mobile behavior owned by the existing tab model.

## Non-Goals

- Do not redesign the full dashboard layout.
- Do not add drag-to-resize in this RFC.
- Do not add server-side user preferences.
- Do not persist separate visibility per task or per project in V1.
- Do not add a new default keyboard shortcut for activity-only mode.
- Do not change terminal sharing, remote collaborator permissions, or terminal
  control gates.
- Do not solve pre-hydration first-paint flash for stored terminal focus.

## Recommendation

Introduce one browser-local panel preference:

```ts
type DetailPaneMode = 'split' | 'left' | 'right';
```

Names mean pane visibility:

- `split`: show both panes;
- `right`: show the Terminal/Diff pane only;
- `left`: show the Activity/GitHub pane only.

The preference lives in the existing triage navigation slice. `App.tsx` owns
viewport-derived layout state and should extend its existing resize listener to
track both `isMobileViewport` and `wideDetailActive`.

`DetailPanel` receives `detailPaneMode` and `wideDetailActive`, derives its
local effective mode, and renders panes from that. `DetailPanel` does not
decide whether project sidebar, project drawer, or top-level dashboard chrome
is hidden.

The effective wide-detail state must use the existing detail breakpoint, not
only the app mobile breakpoint:

```ts
const wideDetailActive =
  window.innerWidth > NARROW_DETAIL_BREAKPOINT_PX;
const terminalFocusActive =
  detailPaneMode === 'right' && wideDetailActive;
```

The current implementation uses `!isMobileViewport` for terminal focus. This
RFC intentionally changes that for the `769-1200px` range so the existing
detail tab model remains visible there. The top-bar terminal focus button
should be hidden below the detail breakpoint; this avoids a visible control that
persists a mode with no immediate pane effect.

`split` is the default. The selected mode persists globally per browser via
`localStorage`, matching the current terminal focus scope. This is intentional:
users are choosing a working posture, not per-task content state.

## Chrome And Breakpoints

Kookr currently has two relevant breakpoints:

| Viewport | Existing behavior | RFC behavior |
|---|---|---|
| `>1200px` | Side-by-side detail split; top-bar terminal focus visible | Apply `detailPaneMode` to pane visibility |
| `769-1200px` | Detail tabs visible; terminal focus currently can still suppress the split | Keep tab model; hide top-bar terminal focus; do not hide panes or app chrome through `detailPaneMode` |
| `<=768px` | Mobile dashboard tabs; compact top bar hides terminal focus button | Keep mobile tabs; do not hide panes through `detailPaneMode` |

App chrome table for `>1200px`:

| Mode | Detail panes | Project sidebar/drawer | Coordinator strip + dependency editor | Top-bar terminal focus pressed |
|---|---|---|---|---|
| `split` | both | visible as today | visible as today | false |
| `right` | right pane only | hidden, preserving current terminal focus behavior | hidden, preserving current terminal focus behavior | true |
| `left` | left pane only | visible as today | visible as today | false |

For `<=1200px`, tabs are the visible mechanism. Stored `detailPaneMode` is not
erased by viewport changes. It becomes effective again when the viewport returns
to wide desktop.

## Controls And Transitions

Use existing controls where they already match the job.

| Control | `split` | `right` | `left` | Persists |
|---|---|---|---|---|
| Top-bar Terminal focus | `right` | `split` | `right` | yes |
| Terminal/Diff header "Hide terminal/diff pane" | `left` | n/a | n/a | yes |
| Visible right-pane header "Show Activity/GitHub pane" | n/a | `split` | n/a | yes |
| Visible left-pane header "Show terminal/diff pane" | n/a | n/a | `split` | yes |
| Left-pane Activity/GitHub tabs | switch `leftPane` only | not visible | switch `leftPane` only | no mode change |
| Right-pane Terminal/Diff tabs | switch `rightPane` only | switch `rightPane` only | hidden | no mode change |
| Narrow detail tabs | switch `narrowTab` only | switch `narrowTab` only | switch `narrowTab` only | no mode change |
| Viewport resize | no state mutation | no state mutation | no state mutation | no state mutation |

Button state is intentionally simple:

- the top-bar terminal focus button is rendered only when `wideDetailActive`;
- its visual active state and `aria-pressed` both reflect
  `detailPaneMode === 'right'`;
- app/sidebar chrome hiding reflects `terminalFocusActive`.

Viewport changes do not mutate `detailPaneMode`. When crossing from wide
detail into the tabbed detail layout, App performs a non-persisted tab handoff:

| Stored mode on breakpoint entry | Narrow tab handoff |
|---|---|
| `split` | preserve current `narrowTab` |
| `right` | select `terminal` |
| `left` | select `github` if `leftPane === 'github'` and GitHub data exists; otherwise select `activity` |

The terminal focus keyboard shortcut follows the same breakpoint rule as the
button: below the detail breakpoint it is ignored for panel mode changes.

There is intentionally no Activity-header "Hide Activity" button in V1. The
existing top-bar terminal focus control remains the terminal-only entry point,
which avoids duplicate controls that do the same thing. The right pane gets the
new "Hide terminal/diff pane" button because activity-only is the missing
feature.

Restore controls live in the surviving pane header. Completed digest and empty
states do not render the split; in those states, panel mode is ignored visually
and the top-bar terminal focus button remains the reset path for `right`.
This is acceptable because no panel is hidden while the split is absent.

## Pane Semantics

### Left Pane

The `left` mode means "left pane only", not literal Activity-only. If
`leftPane === 'github'` and GitHub data exists, GitHub takes the full detail
width. Restore labels should say "Show terminal/diff pane" so they stay true
when the left pane is GitHub.

### Right Pane

The `right` mode means "right pane only", not literal Terminal-only. If a
Diff is active and selected, the Diff pane takes the full detail width. Restore
labels should say "Show Activity/GitHub pane" so they stay true when the right
pane is Diff.

Mode changes SHALL NOT mutate `rightPane` or `activeDiff`. This intentionally
changes the current terminal-focus effect that forces `rightPane` to
`terminal`; right-only mode preserves Diff when Diff is selected.

The top-bar label remains "Terminal focus" in V1 because its established entry
point is terminal-oriented and its shortcut is already documented. It is visible
only for wide detail layouts. Its pressed state means
`detailPaneMode === 'right'`; app chrome hiding still uses
`terminalFocusActive`.

### Terminal Lifecycle And Inertness

V1 SHALL keep `TerminalPanel` mounted when `left` mode hides the right pane.
It SHALL pass `visible=false` while hidden. This preserves scrollback, WebSocket
connection, and xterm state across hide/restore.

Because mounted-hidden terminal is currently still operational, every
`TerminalPanel visible={false}` state MUST make terminal UI inert, regardless of
why it is hidden (`left` mode, Diff selected, or a non-terminal narrow tab):

- global terminal send must report failure while `visible=false` and must not
  write bytes; callers must branch on that failure and must not advance task
  selection or trigger send-coupled side effects;
- terminal key input must not write while hidden;
- terminal search and context menu should close when the terminal becomes
  hidden;
- terminal focus zone should clear if it pointed at the terminal;
- restoring the terminal must trigger fit/refresh on the next layout tick.

Activity and anomaly routing continue while the terminal is hidden. If a
`needs_input`, permission, or terminal-related finding arrives while activity
mode is active, normal Kookr notifications/toasts/chimes still surface it. V1
does not need an unread terminal byte counter.

## Persistence

Storage:

- New key: `kookr-detail-panel-mode`.
- Accepted values: `split`, `right`, `left`.
- Legacy key: `kookr-terminal-focus-mode`.
- Persistence is best-effort; mode changes still work in memory if storage
  throws.

Load precedence:

1. A valid new key wins.
2. An invalid new key falls back to `split` and is cleaned up best-effort.
3. If the new key is absent and legacy key is `1`, load `right`, write the
   new key, and remove the legacy key only after the new write succeeds.
4. Other legacy values are ignored and removed best-effort.

Migration should be transactional: if writing the new key fails, keep the legacy
key so the next reload can retry the migration. A concise dev-console warning
is sufficient for invalid stored values and failed writes in V1. Debug-bundle
preference diagnostics are deferred.

## Accessibility

- Hide and restore buttons must be keyboard reachable on wide desktop.
- Buttons must have exact accessible labels:
  - `Hide terminal/diff pane`
  - `Show terminal/diff pane`
  - `Show Activity/GitHub pane`
- Existing tabs keep their current accessible names: `Activity`, `GitHub (...)`,
  `Terminal`, `Diff`.
- One-shot hide/restore buttons should not use `aria-pressed`.
- The top-bar terminal focus button is hidden below the detail breakpoint and,
  when visible, keeps `aria-pressed={detailPaneMode === 'right'}`.
- Hidden panes must leave the accessibility tree through `display: none`,
  `hidden`, or equivalent.
- After a user clicks "Hide terminal/diff pane", focus moves to the visible
  "Show terminal/diff pane" restore button.
- After top-bar terminal focus is enabled, focus keeps the existing behavior:
  move to the stable top-bar terminal focus trigger.

## Animation

Use a snap layout change in V1. Animated width transitions complicate terminal
resize timing, make geometry assertions flakier, and provide little value for a
dense supervision tool.

## Implementation Outline

Expected files:

- `src/frontend/store/store-types.ts`
- `src/frontend/store/slices/triage-navigation-slice.ts`
- `src/frontend/store/useStore.test.ts`
- `src/frontend/App.tsx`
- `src/frontend/components/TopBar.tsx`
- `src/frontend/components/DetailPanel.tsx`
- `src/frontend/components/DetailPanel.density.test.ts`
- `src/frontend/components/TerminalPanel.tsx`
- `src/frontend/components/TerminalPanel.test.ts`
- `src/frontend/styles.css`
- focused E2E coverage under `e2e/`

Safe sequencing for one PR:

1. Add `DetailPaneMode`, load/save/migration helpers, and derived
   `terminalFocusMode` compatibility with store tests for default, persistence,
   invalid values, storage failures, and legacy migration.
2. Update `App` and `TopBar` to derive terminal focus from
   `detailPaneMode === 'right' && wideDetailActive`, track
   `wideDetailActive` reactively, and hide the terminal focus button below the
   detail breakpoint. Add App/TopBar tests for `1000px -> 1301px -> 1000px`.
3. Make `TerminalPanel visible=false` inert in every existing hidden case, with
   TerminalPanel tests before E2E coverage.
4. Add right-pane hide and restore controls in `DetailPanel`.
5. Add `left` mode layout while keeping the right pane and `TerminalPanel`
   mounted hidden, with component tests for split/right/left modes.
6. Update CSS with single-pane classes; preserve existing `.terminal-focus`
   classes where they still describe the derived terminal focus state.
7. Add focused E2E coverage last.

If implementation reveals repeated non-trivial layout logic, extract a pure
helper such as `deriveDetailPanelLayout()`. Do not add that abstraction unless
the component diff needs it.

## Testing Plan

Unit/component tests:

- Store defaults to `split`.
- Store persists `right` and `left`.
- Store migrates `kookr-terminal-focus-mode=1` to `right`.
- Store handles invalid new key and storage failures.
- Terminal visibility logic returns false when the right pane is hidden.
- `DetailPanel` default renders both panes on wide desktop.
- `DetailPanel` right mode hides the left pane and exposes local restore.
- `DetailPanel` left mode hides the right pane, keeps the terminal mounted,
  passes `visible=false`, and exposes local restore.
- Hiding terminal while Diff is selected preserves and restores Diff.
- Entering right mode while Diff is selected preserves full-width Diff.
- Activity-only keeps secondary detail chrome visible; terminal-only hides it.
- `TerminalPanel` unregisters or guards global send while `visible=false` for
  left mode, Diff-selected mode, and narrow non-terminal tabs.

E2E tests:

- One workflow covers default both panes, hide terminal, restore terminal, hide
  Activity/GitHub via top-bar terminal focus, and restore Activity/GitHub.
- One reload check proves persisted `left` mode hides the right pane on
  wide desktop.
- One terminal restore assertion verifies the visible xterm viewport has
  nonzero geometry and existing output after hide/restore.

Existing terminal viewport budget and Activity/Diff tests remain regression
coverage. New geometry assertions should wait for stable xterm dimensions and
avoid exact-pixel snapshots.

## Edge Cases

- **Active diff while right pane is hidden:** preserve `activeDiff` and
  `rightPane`; restore reveals the same right-pane content.
- **GitHub selected while entering left mode:** preserve `leftPane`; the
  full-width left pane may be GitHub.
- **Selected agent changes:** keep existing behavior that clears stale diff
  state and returns the right pane to Terminal.
- **Completed task digest:** digest replaces both panes; panel mode has no
  visible effect until a split-rendering task is selected.
- **No selected task:** existing empty state remains unchanged.
- **Viewport resize:** does not mutate persisted mode; effective layout follows
  the breakpoint table, and entering tabbed detail layout performs only the
  non-persisted tab handoff listed above.
- **Malformed stored mode:** fall back to `split`, clean up best-effort, and
  warn in the dev console.

## Alternatives Considered

### Keep Terminal Focus Boolean And Add Activity Focus Boolean

Rejected. Two booleans create impossible states (`terminalFocus` and
`activityFocus` both true) and spread conflict resolution through the UI. A
single enum gives the mode an exhaustive type.

### Add An Activity Header "Hide Activity" Button

Rejected for V1. It duplicates the existing top-bar terminal focus action and
creates two mental models for the same terminal-only state. The new local
restore button in right mode fixes discoverability without adding a second
entry point.

### Per-Task Or Per-Project Persistence

Rejected for V1. Per-task state sounds precise but becomes surprising when a
user switches tasks and the layout changes under them. Current terminal focus
is global browser-local state; this RFC keeps that mental model.

### Session-Local Activity Mode

Rejected because the task acceptance criteria require persistence across reload
at the RFC's chosen scope. Browser-local global persistence is the smallest
scope consistent with the current terminal focus model.

### Drag-To-Collapse Splitter

Deferred. Drag-to-collapse could support arbitrary ratios, but it is larger
than the requested three states and would need careful terminal resize, hit
target, persistence, and mobile design. The enum mode can coexist with a future
splitter.

### Keyboard Shortcut For Activity-Only Mode

Deferred. The existing terminal shortcut is valuable because terminal focus is
a fast operational move. Activity-only mode should first prove its value via
visible controls before adding another default shortcut.

## Open Questions

- Should the top-bar label eventually become "Panel focus"? Recommendation:
  not in V1; keep the existing terminal-oriented command stable.
- Should a later version add an unread terminal byte indicator while the right
  pane is hidden? Recommendation: evaluate after V1; findings already surface
  operationally important states.
- Should Kookr add boot-time storage classing to avoid first-paint terminal
  focus flash? Recommendation: defer unless reload tests show unacceptable
  churn.
- Should debug bundles include UI preference diagnostics? Recommendation:
  defer until there is evidence that dev-console warnings are insufficient for
  support.

## Critic Feedback Incorporated

- Round 1 `boundary-critic` 2026-05-25: separated pane mode ownership from
  `App.tsx`-derived terminal focus chrome, added breakpoint/chrome tables, and
  clarified that `DetailPanel` does not own project/sidebar visibility.
- Round 1 `design-minimalist` 2026-05-25: removed the duplicate Activity-header
  hide entry point, reduced E2E scope, made layout-helper extraction optional,
  and kept mobile/narrow tabs as the existing mechanism.
- Round 1 `failure-mode-analyst` 2026-05-25: made hidden terminal mounted but
  inert, added exact accessible labels, preserved left/right pane semantics,
  and added hidden-Diff/GitHub edge cases.
- Round 1 `socratic-challenger` 2026-05-25: added transition tables, breakpoint
  semantics, chrome visibility semantics, and digest/empty-state behavior.
- Round 1 `operability-reviewer` 2026-05-25: specified terminal lifecycle,
  persistence diagnostics, viewport-change state behavior, and terminal
  restore readiness checks.
- Round 1 `delivery-pragmatist` 2026-05-25: split implementation sequencing
  into compatibility, App/TopBar migration, layout controls, hidden-terminal
  inertness, CSS, and tests.
- Design experimenter 2026-05-25: confirmed the App mobile breakpoint and
  DetailPanel narrow breakpoint differ, so the RFC now gates terminal-focus
  chrome on `>1200px` wide-detail state instead of `!isMobileViewport`.
- Round 2 critics 2026-05-25: resolved top-bar pressed-state ambiguity by
  hiding the button below the detail breakpoint and using
  `detailPaneMode === 'right'` for `aria-pressed`; added explicit
  local effective mode ownership in `DetailPanel`; made legacy migration
  transactional; added non-persisted tab handoff on resize; keyed terminal
  inertness to every `visible=false` case; and deferred debug-bundle preference
  diagnostics to keep V1 smaller.
- Round 3 critics 2026-05-25: renamed stored mode values to pane names
  (`split`/`left`/`right`), clarified that `DetailPanel` derives local
  effective mode from `detailPaneMode` plus `wideDetailActive`, required the
  terminal shortcut to follow the same wide-detail gate as the button, required
  hidden send callers to avoid send-coupled side effects, moved hidden-terminal
  inertness before new hide paths in the implementation sequence, and added a
  Diff-preservation test for right mode.
