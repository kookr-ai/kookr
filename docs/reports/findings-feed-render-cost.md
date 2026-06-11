# Findings Feed Render Cost Under Finding Floods

Date: 2026-06-11

## Fixture Shape

The flood fixture targets the expensive path in `FindingsPanel`: grouped findings that are expanded and therefore create one `FindingCard` per agent.

- Root-cause group: 1 root finding with 60 related findings. This group is expanded by default because the root finding carries the actionable summary.
- Duplicate anomaly group: 60 findings with the same anomaly type. This group is collapsed by default, but can be expanded by the user or by selecting a finding in the group.
- Selected finding preservation: a selected related finding outside the first 25 entries remains rendered so keyboard/navigation state does not point at an invisible card.

The focused regression test uses those fixtures because a flat list of same-type findings is already grouped by anomaly type, while root-cause related findings were previously rendered eagerly.

## Baseline Risk

Before this change, an expanded finding group mapped every member directly into the DOM. A root-cause flood of 1 root plus 60 related findings rendered 61 full cards on initial paint; a 500-related-finding flood would render 501 full cards. Each card can subscribe to store state, compute presentation fields, host action buttons, and mount optional speech/feedback controls.

That means the dashboard could spend the most render work exactly when the supervisor is reporting a flood. Server-side coalescing and payload-size work reduce message pressure, but they do not bound the client-side card count once a large finding set reaches the panel.

## Chosen Minimal Fix

The panel now caps expanded finding-group bodies to 25 cards by default:

- Root-cause related findings render the root card plus the first 25 related cards.
- Duplicate anomaly groups render the first 25 cards after expansion.
- If the currently selected finding is outside the first 25, it is appended to the rendered subset so focus and selected-card behavior remain visible.
- A native `button` lets the user intentionally render all members of that group.
- `FindingCard`, root-cause groups, and duplicate groups are memoized, and broad store subscriptions in the hot finding row/group path were narrowed to the specific store fields used.

This keeps the normal flood surface bounded without adding dependencies, changing shared contracts, or introducing virtualization.

## Alternatives Deferred

- Virtualization: likely useful if profiling later shows raw DOM size is still dominant after the cap, but it has higher keyboard/focus and CSS risk.
- Global pagination: broader UX change because it affects triage order across unrelated finding groups.
- Server-side truncation: would hide information before the user asks for it and overlaps with separate payload-bound work.

## Local Verification Target

`src/frontend/components/FindingsPanel.performance.test.tsx` locks the budget:

- Root-cause fixture with 60 related findings renders 26 related cards when the selected finding is outside the first 25, plus the root card.
- Duplicate group fixture renders 25 cards after expansion, then 60 only after the show-all button is activated.
