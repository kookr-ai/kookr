# Proposal 33 — Gap Report

Visual comparison of the running app (`http://localhost:5173/`) against the reference mockup (`gui-proposals/33-supervisor-first-triage.html`), performed 2026-03-24.

**Approach:** Spec-driven development + TDD. For each gap:
1. Update `docs/requirements.md` with testable acceptance criteria
2. Write failing tests
3. Implement until tests pass

---

## Checklist Legend

- [ ] Req — Requirements updated in `docs/requirements.md` with acceptance criteria
- [ ] Test — Failing tests written (Vitest / Playwright)
- [ ] Code — Implementation complete, tests pass

---

## GAP-01: Task names show hash IDs instead of human-readable names

**Severity:** High — the single biggest readability gap.

**Mockup:** "Fix auth token refresh", "Refactor cache layer", "Add pagination to /users"
**Current:** Raw `agentId` hashes like `kookr-d8dd56ae` everywhere — finding cards, healthy rows, detail header, response placeholder.

**Root cause:** `FindingsPanel.tsx:67`, `FindingsPanel.tsx:131`, `DetailPanel.tsx:110`, `DetailPanel.tsx:159` all render `agent.agentId`. The task store holds `prompt` and `cwd` but the frontend `AgentState` doesn't carry a resolved display name.

**Requirement ref:** R1.3 (Show Agent Metadata — `partial`)

- [x] Req — R1.3 updated: display name from task prompt (≤60 chars, word-boundary truncation), fallback to agentId
- [x] Test — `monitor.test.ts`: 3 tests (metadata linked, truncation, no-task fallback). `useStore.test.ts`: 2 tests (snapshot/update preserve metadata). `ws.test.ts`: 2 tests (snapshot/broadcastUpdate include metadata).
- [x] Code — `AgentState` extended with `taskName`, `cwd`, `agentType`, `startedAt`. `Monitor.getSnapshot()` enriches from TaskStore. Frontend renders `taskName ?? agentId` in FindingsPanel, DetailPanel, response placeholder.

---

## GAP-02: No duration or cost metadata displayed

**Severity:** High — the mockup uses time/cost at every level to convey urgency.

**Mockup shows:**
- Top bar: `$1.68` total cost
- Finding cards: `18m · $0.42` per agent
- Detail header: `18m  $0.42`
- Status bar: `5 tasks · 2 findings · $1.68`

**Current:** None of these are shown anywhere.

**Root cause:** `AgentState` has no `startedAt` or `cost` fields. Task store has `createdAt` but it's not surfaced to the frontend. Cost tracking is deferred (R2.5).

**Requirement ref:** R1.3 (Show Agent Metadata — `partial`). Cost is R2.5 (deferred) — duration is not.

- [x] Req — R1.3 updated: duration shown in finding card header, detail header, healthy rows. Computed from session `createdAt`, formatted as `Xm` / `Xh Ym`.
- [x] Test — Covered by GAP-01 tests (`startedAt` field flows through Monitor → WS → Store).
- [x] Code — `startedAt` (ISO 8601) added to `AgentState`. `formatDuration()` renders in FindingsPanel (card header + healthy rows) and DetailPanel (header). Cost deferred (R2.5).

---

## GAP-03: Detail header shows wrong actions and missing metadata

**Severity:** Medium — reduces usefulness of the detail view.

**Mockup:** `claude-code  ~/git/webapp  18m  $0.42  Attach  Stop`
**Current:** `Re-launch  Skip  Snooze` — no agent type, no cwd, no duration, no Attach/Stop.

**Root cause:** `DetailPanel.tsx:108-117` only renders Re-launch, Skip, Snooze. Agent type and cwd are in the task store but not wired to AgentState.

**Requirement ref:** R1.3 (metadata), R4.2 (Stop — `partial`), R4.6 (Attach — `todo`)

- [x] Req — R4.2 updated to `done`: Stop button sends `stop` message via WS. R4.6 updated to `partial`: Attach button in detail header. R1.3 metadata already done in GAP-01/02.
- [x] Test — `ws.test.ts`: stop message kills agent session. `presentation.test.ts`: `getAttachCommand` returns tmux command.
- [x] Code — `stop` added to `ClientMessage` union. `MessageRouter` handles stop via `adapter.stop()`. DetailPanel header shows Attach + Stop (replaces Re-launch/Skip/Snooze). `getAttachCommand()` in `presentation.ts`.

---

## GAP-04: Healthy agents lack task name and duration

**Severity:** Medium — healthy rows are unrecognizable as hash IDs.

**Mockup:** `● Add pagination to /users — 12m` with green/grey dot for running/done.
**Current:** `● kookr-d8dd56ae` — just hash ID, all dots green, no duration.

**Root cause:** `FindingsPanel.tsx:124-133` renders `agent.agentId` with hardcoded `running` class.

**Requirement ref:** R1.3 (metadata in all agent displays)

- [x] Req — R1.3 extended: healthy agent rows show task name + duration (already done in GAP-01/02). Dot color: green=running, grey=completed (last event is `stop`).
- [x] Test — `presentation.test.ts`: 3 tests for `healthyDotClass` (no events → running, last tool_use → running, last stop → done).
- [x] Code — `healthyDotClass()` in `presentation.ts` determines dot CSS class from events. FindingsPanel uses it for dynamic dot color.

---

## GAP-05: Terminal panel missing Attach button

**Severity:** Low — the detail header Attach (GAP-03) covers the same action.

**Mockup:** Terminal header has an `Attach` button.
**Current:** Terminal header has no button.

**Requirement ref:** R4.6 (Attach to Agent Terminal — `todo`)

- [x] Req — R4.6 updated to `partial`: Attach button in terminal panel header, detail header, and finding cards.
- [x] Test — Covered by `getAttachCommand` test in `presentation.test.ts`.
- [x] Code — `TerminalPanel.tsx` terminal header has Attach button that copies tmux command to clipboard. CSS `.terminal-btn` styled.

---

## GAP-06: No "Sent" confirmation overlay

**Severity:** Low — polish UX feature for the respond-and-advance flow.

**Mockup:** Green checkmark overlay: "Hint sent to Fix auth token refresh / Advancing to: Refactor cache layer..." shown for ~1.5s after Send & Next.

**Current:** Response is sent silently; user must notice the selection change.

**Requirement ref:** New — not in current requirements.

- [x] Req — R3.8 added: brief confirmation overlay after Send & Next, shows agent name, auto-dismisses after 1.5s.
- [x] Test — `useStore.test.ts`: 3 tests for `sentOverlay` (defaults null, showSentOverlay sets, clearSentOverlay clears).
- [x] Code — `SentOverlay.tsx` component with auto-dismiss timer. `sentOverlay` state + actions in store. DetailPanel triggers overlay on send. CSS `.sent-overlay` with green checkmark.

---

## GAP-07: No repeat-pill on repeated tool calls

**Severity:** Medium — this is a key visual signal that makes stuck loops obvious.

**Mockup:** `Bash: npm test [x8]` — amber pill showing repetition count.
**Current:** Events rendered individually with no repetition detection.

**Requirement ref:** R1.2 (Show Current Activity — `partial`). Extends the "display what the agent is doing" requirement.

- [x] Req — R1.2 updated: consecutive identical tool calls collapsed into single entry with amber repeat count pill.
- [x] Test — `presentation.test.ts`: 6 tests for `collapseEvents` (empty, non-repeated, 5 identical → x5, different tools, break on non-tool, 8 identical → x8).
- [x] Code — `collapseEvents()` in `presentation.ts`. DetailPanel renders collapsed events with `<span class="repeat-pill">x{count}</span>`. CSS `.repeat-pill` styled amber.

---

## GAP-08: Keyboard shortcuts diverge from mockup

**Severity:** Low — some shortcuts are already implemented but differ from mockup.

**Mockup shortcuts:**
- `Ctrl+Enter` — send & next
- `Tab` — skip
- `Ctrl+T` — toggle terminal
- `Ctrl+N` — next finding

**Current shortcuts:**
- `Ctrl+Enter` — send & next (matches)
- `Ctrl+N` — next finding (matches)
- `Ctrl+L` — launch (not in mockup)
- No `Tab` skip, no `Ctrl+T` terminal toggle

**Requirement ref:** R5.4 (Keyboard Shortcuts — `todo`)

- [x] Req — R5.4 updated to `done`: full shortcut table — Ctrl+Enter, Ctrl+N, Tab (skip), Ctrl+T (toggle terminal), Ctrl+L (launch).
- [x] Test — `useStore.test.ts`: 2 tests for `terminalVisible` (default true, toggleTerminal toggles).
- [x] Code — `terminalVisible` + `toggleTerminal` added to store. App.tsx handles Tab→skip and Ctrl+T→toggleTerminal. DetailPanel conditionally renders terminal. Shortcut hints updated.

---

## GAP-09: Finding card missing "Attach" action button

**Severity:** Low — covered by GAP-03/GAP-05, but the mockup also has it inline on cards.

**Mockup:** Stuck Loop card has `Skip | Snooze 5m | Attach`.
**Current:** Only `Skip | Snooze 5m`.

**Requirement ref:** R4.6 (Attach to Agent Terminal — `todo`)

- [x] Req — R4.6 already covers Attach in finding cards (updated in GAP-05).
- [x] Test — Covered by `getAttachCommand` test in `presentation.test.ts`.
- [x] Code — Attach button added to FindingCard actions in `FindingsPanel.tsx`. Copies tmux command to clipboard.

---

## Priority Order (suggested)

| Order | Gap | Impact | Effort |
|-------|-----|--------|--------|
| 1 | GAP-01 | High | Medium — requires wiring task metadata through WS |
| 2 | GAP-02 | High | Medium — add `startedAt`, live timer |
| 3 | GAP-04 | Medium | Low — follows directly from GAP-01 data |
| 4 | GAP-07 | Medium | Low — pure frontend event collapsing |
| 5 | GAP-03 | Medium | Medium — multiple new fields + actions |
| 6 | GAP-05 | Low | Trivial — single button |
| 7 | GAP-09 | Low | Trivial — single button |
| 8 | GAP-08 | Low | Low — event handlers + CSS |
| 9 | GAP-06 | Low | Low — overlay component + timeout |

---

## Progress Summary

| Gap | Description | Req | Test | Code |
|-----|-------------|-----|------|------|
| GAP-01 | Task names instead of hash IDs | [x] | [x] | [x] |
| GAP-02 | Duration metadata everywhere | [x] | [x] | [x] |
| GAP-03 | Detail header metadata + actions | [x] | [x] | [x] |
| GAP-04 | Healthy rows: name + duration | [x] | [x] | [x] |
| GAP-05 | Terminal Attach button | [x] | [x] | [x] |
| GAP-06 | Sent confirmation overlay | [x] | [x] | [x] |
| GAP-07 | Repeat-pill on tool calls | [x] | [x] | [x] |
| GAP-08 | Keyboard shortcuts alignment | [x] | [x] | [x] |
| GAP-09 | Finding card Attach button | [x] | [x] | [x] |

**9 of 9 gaps closed. 27 of 27 checklist items done.**
