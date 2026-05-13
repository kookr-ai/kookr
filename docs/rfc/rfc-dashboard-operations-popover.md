# RFC: Dashboard Operations Popover

**Status:** Draft (implemented prototype)
**Date:** 2026-05-12
**Author:** Jean Ibarz (with Codex)

---

## Problem

The findings column currently renders `DetectionStatsPanel` and `CircuitBreakerPanel` after the core task lists. These sections are operational diagnostics, not primary triage content. Even when collapsed, they consume visual attention in the main workspace and make the dashboard read like a monitoring console instead of an attention router.

The main dashboard should prioritize: projects, active findings, task detail, terminal output, and launch controls. Detection statistics and circuit breaker state should remain available, but behind a discrete top-right control.

## Requirements

- Detection stats and circuit breaker state SHALL be removed from the main findings column.
- The information SHALL remain reachable from the top-right dashboard controls.
- The entry point SHALL be compact and icon-first, with a tooltip and accessible label.
- The control SHALL show a small attention marker only when circuit breakers are tripped or self-diagnostics report findings.
- The popover SHALL preserve existing diagnostic capabilities, including self-diagnostic run and circuit breaker rearm.
- The design SHALL work on desktop and mobile without covering the top bar controls.
- The implementation SHALL avoid new backend APIs.

## Design

Add a `Diagnostics` icon button to the top bar action cluster, near other utility controls. Clicking it opens an operations popover aligned to the top-right of the viewport. The popover contains the existing detection stats and circuit breaker panels, expanded by default because the user explicitly asked to inspect them.

The existing panel components stay responsible for their own data and actions:

- `DetectionStatsPanel` still fetches `/api/anomaly-stats` and renders the self-diagnostic section.
- `CircuitBreakerPanel` still reads circuit breaker snapshots from the frontend store and sends `rearmCircuitBreaker`.

The new wrapper is only presentation:

- `OperationsPanel` composes the two panels and provides a compact header and close button.
- `TopBar` owns the diagnostics icon button and its attention dot.
- `App` owns popover open/close state so the panel can receive the WebSocket `send` function.

## Files To Change

- `src/frontend/App.tsx`
- `src/frontend/components/TopBar.tsx`
- `src/frontend/components/OperationsPanel.tsx`
- `src/frontend/components/DetectionStatsPanel.tsx`
- `src/frontend/components/CircuitBreakerPanel.tsx`
- `src/frontend/components/FindingsPanel.tsx`
- `src/frontend/styles.css`

## Edge Cases

- No anomaly stats yet: the popover shows an explicit empty/loading state instead of silently rendering a blank panel.
- No circuit breaker snapshots yet: the popover shows an explicit empty state.
- Mobile top bar wraps to two rows: the popover shifts lower and spans the viewport width with margins.
- Outside click or Escape closes the popover.
- Clicking the diagnostics button again toggles the popover.

## Alternatives Considered

- Move both sections into Settings: rejected because rearming circuit breakers and checking diagnostics are operational actions, not configuration.
- Put the sections in the status bar: rejected because they would still compete with primary status and narrow-screen layout.
- Use a full modal: rejected because these diagnostics are secondary and should be quick to inspect while keeping dashboard context visible.

## Review Notes

The normal RFC review skill asks for critic subagents and a stop for user approval before implementation. This task explicitly asked for design plus implementation in one pass, and this session only permits subagents when the user explicitly requests delegation. I used a focused self-review instead:

- Boundary check: the panels keep their existing data ownership; the new wrapper is presentation only.
- Minimality check: no backend API or store redesign is introduced.
- Failure-mode check: empty states, mobile placement, outside click, and Escape close are covered.
