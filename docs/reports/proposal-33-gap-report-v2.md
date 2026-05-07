# Proposal 33 — Gap Report v2

E2E validation of the running app (`http://localhost:5173/`) against the reference mockup (`docs/spikes/gui-proposals/33-supervisor-first-triage.html`), performed 2026-03-25 via Playwright.

**Context:** All 9 gaps from the original gap report are closed. This report captures remaining visual/behavioral gaps found during E2E testing.

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

## GAP-10: Status bar shortcut hints diverge from mockup

**Severity:** Low — cosmetic mismatch.

**Mockup:** `Ctrl+N next finding · Ctrl+Enter send & next · Ctrl+T toggle terminal`
**Current:** `Ctrl+N next finding · Ctrl+Enter send & next · Ctrl+L launch`

**Root cause:** `StatusBar.tsx:13` hardcodes `Ctrl+L launch` instead of `Ctrl+T toggle terminal`. The status bar hints should match the response area hints which already include Tab, Ctrl+T, and Ctrl+L.

**Requirement ref:** R5.4 (Keyboard Shortcuts — `done`, but status bar hints incomplete)

- [x] Req — R5.4 already covers all shortcuts. Status bar is a display concern.
- [x] Test — Visual validation (no pure logic to test).
- [x] Code — `StatusBar.tsx` updated to show Tab skip, Ctrl+T terminal, Ctrl+L launch matching response area hints.

---

## GAP-11: Completed healthy agents show duration instead of "done" label

**Severity:** Low — reduces clarity for finished tasks.

**Mockup:** `● Update README badges — done` (grey dot + "done" text)
**Current:** `● Update README badges — 1h 27m` (grey dot + duration)

**Root cause:** `FindingsPanel.tsx` healthy rows always render `formatDuration(agent.startedAt)`. When an agent's last event is `stop` (no anomaly), it should show "done" instead of the duration.

**Requirement ref:** R1.3 (Show Agent Metadata)

- [x] Req — R1.3 already covers metadata display. "done" label is a presentation refinement.
- [x] Test — `presentation.test.ts`: 3 tests for `healthyStatusLabel` (last stop → "done", last tool_use → duration, empty → duration).
- [x] Code — `healthyStatusLabel()` in `presentation.ts`. FindingsPanel healthy rows use it instead of raw `formatDuration`.

---

## GAP-12: Vite WS proxy uses wrong protocol

**Severity:** High — WebSocket connection fails on first page load in dev mode.

**Mockup:** N/A (infrastructure issue)
**Current:** `vite.config.ts` proxy for `/ws` targets `ws://127.0.0.1:4800` but Vite's http-proxy expects `http://` for WS upgrade proxying. Connection fails with ECONNRESET/EPIPE.

**Root cause:** `vite.config.ts:15` — `target: 'ws://127.0.0.1:4800'` should be `target: 'http://127.0.0.1:4800'`.

**Requirement ref:** R5.5 (Real-time Updates)

- [x] Req — N/A (bug fix, no spec change needed)
- [x] Test — Manual E2E validation confirms WS connects after fix.
- [x] Code — Fixed in `vite.config.ts`: changed `ws://` to `http://` in proxy target.

---

## GAP-13: Top bar missing findings count when findings exist

**Severity:** Low — information already shown in findings panel header and status bar.

**Mockup:** Top bar right side shows `2 findings · 3 healthy · $1.68 · + Launch`
**Current:** Top bar shows findings count only when > 0, but omits the count label entirely when there are 0 findings, making the bar feel sparse.

**Root cause:** `TopBar.tsx:41-45` conditionally renders findings stat. The mockup always shows both counts. Additionally, the top bar lacks the `$cost` stat (deferred R2.5).

**Requirement ref:** R5.3 (Status Bar — covers top bar too)

- [x] Req — R5.3 already covers status display. Always-visible counts is a refinement.
- [x] Test — Visual validation (no pure logic to test).
- [x] Code — `TopBar.tsx` findings stat now always rendered (not conditionally hidden). Uses `warn` class only when > 0.

---

## GAP-14: Conversation column empty for healthy agents with no hook events

**Severity:** Medium — healthy agents show a blank conversation area when selected.

**Mockup:** Detail panel always shows agent conversation history with tool calls.
**Current:** Healthy agents that haven't triggered any hook events show an empty conversation column. This is expected since hook events only flow through anomaly detection, but the empty space looks broken.

**Root cause:** `AgentState.events` is empty for agents that haven't produced hook events yet (or whose events haven't been captured). No placeholder or status message is shown.

**Requirement ref:** R5.2 (Agent Detail Panel)

- [x] Req — R5.2 updated: conversation column shows placeholder when agent has no hook events.
- [x] Test — Visual validation (render-only change, no pure logic).
- [x] Code — `DetailPanel.tsx` renders `.conversation-empty` placeholder when `agent.events.length === 0`. CSS styled.

---

## Priority Order

| Order | Gap | Impact | Effort |
|-------|-----|--------|--------|
| 1 | GAP-12 | High | Done — already fixed |
| 2 | GAP-14 | Medium | Low — single placeholder div |
| 3 | GAP-10 | Low | Trivial — update string |
| 4 | GAP-11 | Low | Low — pure function + render change |
| 5 | GAP-13 | Low | Trivial — remove conditional |

---

## Progress Summary

| Gap | Description | Req | Test | Code |
|-----|-------------|-----|------|------|
| GAP-10 | Status bar shortcut hints | [x] | [x] | [x] |
| GAP-11 | Completed agents show "done" | [x] | [x] | [x] |
| GAP-12 | Vite WS proxy protocol fix | [x] | [x] | [x] |
| GAP-13 | Top bar always show counts | [x] | [x] | [x] |
| GAP-14 | Empty conversation placeholder | [x] | [x] | [x] |

**5 of 5 gaps closed. 15 of 15 checklist items done.**
