# RFC: First-Run Onboarding Tour

## Status

**Draft (v5 — post round-3 + convergence check, ready for user review)**

**Date:** 2026-05-05
**Author:** Jean Ibarz (with Claude)

---

## Problem

A first-time visitor to the Kookr dashboard sees a dense, multi-pane UI with concepts that have no equivalent in any other tool: a supervisor agent, findings, anomaly routing, attention queue, dtach-backed terminal sessions, playbooks, achievements. The TopBar exposes seven affordances within the first 200px of width (logo, version, queue, capacity gauge, OSS view, schedules, settings, launch). None of them explain *what Kookr is for* or *what to do first*. The README explains it, but the user does not have the README open while looking at the app.

The current onboarding gap shows up in two places:

- New users (e.g., the YC video reviewer, OSS contributors trying the toolkit, Jean's collaborators) report that they do not know which icon does what or what the "+ Launch" button will spawn.
- The `?` button only documents keyboard shortcuts. There is no equivalent surface for "what is this app".

The application has no first-run experience and no help-center entry beyond keyboard shortcuts.

This RFC proposes a small first-run tour that runs once per browser, can be dismissed, and remains discoverable afterwards.

## Requirements

- The tour must appear automatically on the first dashboard load for a given browser, and not on subsequent loads after the user has seen it.
- A user who dismissed it (intentionally or by accident) must be able to re-open it from the existing `?` Help surface without searching docs or opening Settings.
- The tour content must explain at minimum: what Kookr is (a supervisor, not a coder), the four-pane layout, how to launch a task, and where findings come from.
- The tour must work without a backend round-trip — pure frontend, single browser-local persistence.
- The tour must not block the rest of the UI from rendering or receiving WebSocket updates while it is shown.
- The tour must support keyboard navigation: `Esc` closes, `Enter`/`→` advances, `←` goes back. Autofocus on the primary advance button on open and on slide change.
- The tour must be testable with Vitest (logic, persistence, mount behavior) and at least one Playwright assertion that the modal appears on a fresh storage state.

## Non-goals

- No element-anchored spotlight overlays *driven by a library*.
- No backend persistence.
- No analytics/telemetry on tour completion.
- No locale/translation support.
- No interactive sample tasks, demo data, or sandboxed mode while the tour is open.
- No content-versioning *mechanism*. Storage key carries the version: `kookr:onboarding:seen-v1`. Material rewrite bumps to `-v2`. Discipline rule kept by deliberate choice (round-3 socratic #5: a content-hash key would invalidate on every typo fix; the version is "did this rewrite materially change what users see," which is a judgment call, not a hash).
- No focus-trap implementation.
- No mobile-specific re-open path. Kookr is desktop-first; the `?` button is hidden in compact mode and Card 5 is dissolved (round-3 delivery #4 + socratic #4) so the mobile gap is acknowledged not papered over.
- No naive-participant validation gate as a hard *Requirements* item. v3 added it; round-3 design-minimalist + failure-mode + socratic flagged it as unenforced vibes. Moved to **Process commitments** below — separated from RFC requirements.

## Design

### High-level shape

`OnboardingTour.tsx` is a paged modal — a slide deck of **4 cards** (round-3 socratic #4 dissolved Card 5). Each card has title, body (~2-4 sentences), and navigation: `Back`, `Next`, `Skip tour`, dot indicators. The final card's primary button is `Done`.

Cards (locked sequence; reordering means a key bump):

1. **Welcome to Kookr** — what Kookr is: a smart attention router for multiple AI coding agents. It does not write code; it watches your agents and tells you which one to look at next. *Card 1 footer line:* "You can re-open this tour from the `?` Help button at the top right anytime."
2. **The four panes** — a single inlined SVG (`src/frontend/components/OnboardingLayoutDiagram.tsx`, an SVG-as-React-component, not an `<img>`) labels sidebar, terminal, detail, top bar. While this card is active, the live pane containers gain a pulsing outline ring.
3. **Launching an agent** — explains that the `+ Launch` button (or `Alt+L`) spawns a Claude Code or Codex CLI session in a managed dtach terminal. Outline ring on the `+ Launch` button while active. (Card 5's `Alt+L` mention folded in.)
4. **Findings and routing** — when the supervisor detects a stuck loop, repeated error, permission block, or budget burn, it surfaces a finding. The dashboard routes you to the most urgent one. Outline ring on the FindingsPanel.

The modal reuses the existing `dialog-overlay` / dialog container CSS pattern. `useEscapeToClose` is the escape-key hook. Closing via any vector (Esc, Skip, Done, backdrop click) calls `markSeen()` and unmounts. Backdrop click is isolated via `pointer-events` + `stopPropagation` (round-2 finding) — Playwright spec asserts no LaunchDialog opens after a backdrop click on Card 3.

### State management — pub-sub store, not a hook (round-3 boundary + design-minimalist + socratic #1)

V3's `useOnboarding` hook with a module-level subscriber Set was over-engineered. The two callers have asymmetric needs:

- `OnboardingTour` (rendered always by `App.tsx`) needs to *read* the open state.
- `ShortcutsHelp` needs to *dispatch* an open event. It never reads.

So no shared state is needed. v4 ships a tiny external store and uses `useSyncExternalStore` (round-3 boundary explicit suggestion) for read-side React 18 tearing safety:

```ts
// src/frontend/store/onboarding-store.ts

import { shouldShow as persistedShouldShow, markSeen } from './onboarding-status.js';

let openState = false;
const listeners = new Set<() => void>();

function emit(): void { listeners.forEach((l) => l()); }

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot(): boolean {
  return openState;
}

export function open(): void {
  if (openState) return;
  openState = true;
  emit();
}

export function close(): void {
  if (!openState) return;
  openState = false;
  markSeen();
  emit();
}

export function maybeOpenForFirstRun(): void {
  if (persistedShouldShow()) open();
}
```

`OnboardingTour` calls `useSyncExternalStore(subscribe, getSnapshot)` to read `openState` and re-renders coherently across React 18 concurrent passes. `ShortcutsHelp` imports `open` and calls it. `App.tsx` calls `maybeOpenForFirstRun()` once on mount. Three free functions, no hook, no Set-of-setters.

### Persistence

`src/frontend/store/onboarding-status.ts` — two-tier (localStorage → in-memory). `markSeen` wraps the write in try/catch for late quota exhaustion:

```ts
const KEY = 'kookr:onboarding:seen-v1';

let inMemorySeen = false;

const storage: Storage | null = (() => {
  try {
    const probe = '__kookr_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch { return null; }
})();

export function shouldShow(): boolean {
  if (storage) return storage.getItem(KEY) !== 'true';
  return !inMemorySeen;
}

export function markSeen(): void {
  if (storage) {
    try { storage.setItem(KEY, 'true'); }
    catch { inMemorySeen = true; }
  } else {
    inMemorySeen = true;
  }
}

export function reset(): void {
  if (storage) { try { storage.removeItem(KEY); } catch { /* ignore */ } }
  inMemorySeen = false;
}
```

The IIFE picks the storage tier *once at module load*. Tests use `vi.resetModules()` per test for module-singleton isolation.

**Existing-user interrupt on first deploy.** Convergence-check failure-mode + design-minimalist independently flagged that v4's `bootstrapForExistingUsers` heuristic was permanent runtime code (and untested-edge-case-prone) for a one-time deploy event. v5 cuts the function and accepts the trade-off: existing dashboard users will see the tour once on the first page-load after this lands. Click cost: one button (Skip or Done). This is judged proportionate to a 10-line localStorage scan that lives forever and has false-positive paths (e.g., stale `kookr:*` keys from a previous origin).

**Kill-switch.** Convergence-check flagged `ONBOARDING_TOUR_ENABLED = true` as a constant misnamed as a kill-switch — it requires a code change + rebuild + deploy either way. v5 cuts it. If a post-ship regression needs disabling, the equivalent action is a one-line patch in `shouldShow()` to return `false`. Same operational cost, fewer named concepts.

### Class-based spotlight

Body-class + per-element class (round-2 design-minimalist's flatter pattern, kept):

- While tour is open and on a card with `targetClass`, `document.body.classList.toggle('kookr-tour-active-<targetClass>', true)`.
- Each tour-target affordance has a stable className like `kookr-tour-target-launch` on its root element. **Class names are scoped with `kookr-` prefix** to avoid collision with future tours (round-3 failure-mode finding 3).
- CSS:

```css
body.kookr-tour-active-launch .kookr-tour-target-launch {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 6px;
  animation: kookr-tour-pulse 2s ease-in-out infinite;
}
```

Cleanup uses `useLayoutEffect` (round-2 finding 6).

The expected class names live in **one exported constant** — `OnboardingTour.tsx`'s `TOUR_TARGET_CLASSES` — and the contract test imports from there. This is the "single source of truth" that round-3 boundary wanted. Removing or renaming a class on a target component is caught by the contract test.

**Multiple matches accepted.** A `kookr-tour-target-launch` may appear on both desktop TopBar and mobile drawer. The ring renders on every match. The contract test asserts `>= 1` matches per active card (round-3 boundary + failure-mode + socratic #7 — v3 said "exactly one" which contradicted the design). No console.warn for zero matches; the contract test is the enforcement (round-3 design-minimalist).

### Re-open path

`ShortcutsHelp.tsx` keeps its filename. Header text changes to "Help & Shortcuts". A top section is added:

```
Take the product tour →

──────────────────────

Keyboard shortcuts

  Navigation
    Alt+N   Jump to next finding by severity
    ...
```

The CTA imports `open` from `onboarding-store.ts` and calls it, then closes the help dialog. No prop threading. No SettingsDialog Help section.

The `?` TopBar button tooltip changes to "Help" (`title` and `aria-label`). Round-3 delivery: any existing Playwright selector targeting `getByRole('button', { name: 'Keyboard shortcuts' })` must be updated in the same PR. Search `tests/e2e/` for the old label as part of implementation.

### FindingsPanel empty-state copy (round-3 failure-mode #6 + socratic #3 refinement)

V3 proposed referencing "+ Launch" by name in FindingsPanel copy, which would silently stale if the button label or hotkey ever changes. Round-3 failure-mode + socratic flagged the cross-component knowledge leak.

v4 keeps the empty-state copy fix but rephrases to remove the cross-component reference:

Existing: `"No agents running. Click + Launch to start one."`
v4: `"No agents running yet — launch one to begin."`

This is condition-correct (the gate is `findings.length === 0 && totalAgents === 0` — round-3 delivery confirmed), tour-friendly because Card 4's ring then highlights a meaningful empty area with a neutral prompt, and free of cross-component label dependencies.

### Mount logic

`App.tsx` calls `maybeOpenForFirstRun()` once via `useEffect(() => { maybeOpenForFirstRun(); }, [])`. It always renders `<OnboardingTour />` (the component reads `getSnapshot()` and renders nothing when closed).

A `useLayoutEffect` in `OnboardingTour` synchronizes the `body.kookr-tour-active-<X>` class with the current card's `targetClass` and removes all `kookr-tour-active-*` classes on unmount.

### Edge cases re-examined post round-3

- **`markSeen` late-write throws** (round-3 failure-mode finding 2): wrapped in try/catch with in-memory fallback. New test asserts close-handler still flips state when storage write fails post-init.
- **Existing-user interrupt on deploy day** (round-3 delivery): explicitly accepted as a one-button cost (Skip), v4's bootstrap heuristic cut in v5.
- **No kill-switch** (round-3 delivery): explicitly accepted; a one-line patch is the equivalent action.
- **Singleton subscription complexity** (round-3 boundary + design-minimalist): replaced by external store + `useSyncExternalStore`.
- **Contract test self-contradiction** (round-3 boundary + failure-mode + socratic): relaxed to `>= 1`.
- **Class-name namespace collision** (round-3 failure-mode #3): all class names prefixed with `kookr-`.
- **Cross-component label drift** (round-3 failure-mode #6 + socratic #3): copy reworded.
- **Card 5 was a one-sentence card** (round-3 socratic #4): dissolved into Card 1 footer + Card 3 mention of `Alt+L`.
- **Atomicity** (round-3 delivery #3): `onboarding-store.ts` + `App.tsx` call to `maybeOpenForFirstRun` + `ShortcutsHelp.tsx` import of `open` must land in one PR. Stated explicitly in Files to change.
- **Mobile compact mode**: `?` button hidden, Card 5 dissolved so the gap is no longer load-bearing. Mobile-specific re-open is out of scope per Non-goals.
- **SVG embedding** (round-3 delivery #6): SVG inlined as React component, not `<img src>`. Vitest jsdom and Playwright both work without a static-file pipeline.
- **HMR resets `inMemorySeen`**: dev-only, accepted.
- **React strict-mode double-mount**: storage reads are idempotent; `markSeen` is user-triggered.
- **WSL2 / per-origin localStorage** (prod 4800 vs dev 4801): documented, accepted.
- **Browser autofill / extension overlays**: Esc still closes; not catastrophic.
- **Two tabs, first-run state**: both show, first to close writes seen, second unaffected.
- **Replay double-click**: `open()` is idempotent (early return when already open).

## Files to change

These three files form an atomicity unit and **must land in the same PR** (round-3 delivery #3): `onboarding-store.ts`, `App.tsx`, `ShortcutsHelp.tsx`. Cherry-picking any one breaks the replay flow silently.

- Add `src/frontend/components/OnboardingTour.tsx`
- Add `src/frontend/components/OnboardingTour.test.tsx` — covers: card rendering, transitions, every close vector calls `markSeen` exactly once, body-class toggle on card change, contract test imports `TOUR_TARGET_CLASSES` and asserts `>= 1` match per active card in the live App tree.
- Add `src/frontend/components/OnboardingLayoutDiagram.tsx` — SVG inlined as React component for Card 2.
- Add `src/frontend/store/onboarding-status.ts`
- Add `src/frontend/store/onboarding-status.test.ts` — covers: missing key, value `"true"`, write-failure fallback, `markSeen` throws after init falls through to in-memory. Uses `vi.resetModules()` per test.
- Add `src/frontend/store/onboarding-store.ts`
- Add `src/frontend/store/onboarding-store.test.ts` — covers: `subscribe`/`getSnapshot`/`open`/`close` pub-sub, idempotent `open` and `close`, `maybeOpenForFirstRun` opens iff `shouldShow()` is true.
- Modify `src/frontend/App.tsx` — call `maybeOpenForFirstRun()` in mount effect, render `<OnboardingTour />` always.
- Modify `src/frontend/components/ShortcutsHelp.tsx` — header text "Help & Shortcuts", new top section with "Take the product tour" CTA that imports `open` from store and closes the help dialog.
- Modify `src/frontend/components/FindingsPanel.tsx` — reword empty-state to `"No agents running yet — launch one to begin."`, add `kookr-tour-target-findings` className to root.
- Add `kookr-tour-target-*` className to four pane containers and the `+ Launch` button across `TopBar.tsx`, `ProjectSidebar.tsx`, `TerminalPanel.tsx`, `DetailPanel.tsx`, `FindingsPanel.tsx`.
- Modify `src/frontend/components/TopBar.tsx` — `?` button `title` and `aria-label` "Keyboard shortcuts" → "Help".
- Modify `src/frontend/styles.css` — tour modal classes, `body.kookr-tour-active-*` outline rules, `kookr-tour-pulse` keyframes.
- Search `tests/e2e/` and `src/frontend/` for any selector targeting `Keyboard shortcuts` on the help button; update to `Help` (round-3 delivery low). Same-PR change.
- Add `tests/e2e/onboarding-tour.spec.ts` — Playwright: clean storage shows tour, Skip dismisses, reload doesn't re-show, `?` → Take the product tour re-shows, Esc closes, focus inside modal at open, backdrop click on Card 3 doesn't open LaunchDialog.

No backend, protocol, or shared-types changes.

## Test plan

- `onboarding-status.test.ts` — persistence, late-write fallback. `vi.resetModules()` per test.
- `onboarding-store.test.ts` — pub-sub, idempotency, `maybeOpenForFirstRun`.
- `OnboardingTour.test.tsx` — component rendering, transitions, close vectors, body-class toggle, **contract test** importing `TOUR_TARGET_CLASSES` and asserting `>= 1` match per active card in the live App tree.
- Playwright `tests/e2e/onboarding-tour.spec.ts` — fresh storage shows tour, Skip dismisses, reload doesn't re-show, `?` → "Take the product tour" re-shows, Esc closes, focus inside modal at open, backdrop click on Card 3 closes without spawning Launch.

The contract test is **load-bearing** (round-2 + round-3 boundary). It runs against the rendered `App` tree at the default test viewport and is named in the PR review checklist.

## Process commitments (separated from Requirements)

- **Naive-participant validation before V2 work.** Before any V2 onboarding feature (interactive demo task, post-first-finding nudge, empty-state card) is prioritized, at least one person unfamiliar with Kookr is walked through the shipped tour and their confusion points logged in a dated note in `docs/research/onboarding-naive-walkthrough-<date>.md`. Round-3 socratic + failure-mode flagged this as unenforceable — true. It is documented here as a process intent, not a code-enforceable gate.

## Alternatives considered

### Element-anchored library tour

Rejected — library brittleness, dependency cost. CSS class spotlight gives 70% of value at zero dependency.

### Inline tooltips, no modal

Rejected — fragments narrative, requires affordance discovery first.

### Dedicated `/welcome` route

Rejected — SPA has no router.

### Backend-tracked first-run flag

Rejected — no user identity, would force a round-trip on every dashboard mount.

### Empty-state card on cold dashboard *as a replacement*

Rejected — empty-state has room for one or two sentences, not multi-section explainer. v4 ships a 1-line empty-state copy refresh in FindingsPanel as a complement, not a replacement.

### Just edit `?` dialog's first paragraph

Rejected — brief explicitly requires automatic appearance on first launch.

### Two re-open paths

Rejected — Settings Help section is invented discoverability, not solved discoverability.

### Persistence as class with `completed`/`dismissed` + version field

Rejected (was v1) — over-engineered for two states with identical behavior.

### sessionStorage tier in fallback chain

Rejected (was v2) — solves no real user's problem.

### Rename `ShortcutsHelp.tsx` → `HelpDialog.tsx`

Rejected (was v2) — cosmetic churn.

### `useOnboarding` hook with subscriber Set

Rejected (was v3) — hand-rolled multi-subscriber sync prone to React 18 tearing; only one true subscriber. Replaced by external store + `useSyncExternalStore`.

### Card 5 ("Help and shortcuts")

Rejected (was v1-v3) — one-sentence content (round-3 socratic #4). Folded into Card 1 footer + Card 3 hotkey mention.

### Naive-participant validation as Requirement

Rejected (was v3) — unenforced vibes (round-3 multiple critics). Moved to Process commitments.

### Hash-derived storage key version

Rejected (round-3 socratic #5) — would invalidate on every typo fix. Kept `seen-v1` with deliberate discipline rule; "material rewrite" is a judgment, not a hash.

### console.warn for zero target matches

Rejected (round-3 design-minimalist + failure-mode) — contract test catches the same issue, warn would fire during HMR and partial-tree tests.

## Critic Feedback Incorporated

Three rounds, five critics each (boundary, failure-mode, design-minimalist, socratic, ambition-amplifier in rounds 1-2 / delivery-pragmatist in round 3).

**Round 1** absorbed: `useOnboarding` hook for ownership consolidation; rename `ShortcutsHelp` → `HelpDialog` (later reverted in round 2); free-function persistence; single `seen` boolean (replaced `completed`/`dismissed`); no version mechanism; no focus trap; sessionStorage fallback (later cut in round 2); CSS spotlight; one SVG; single re-open path; "Got it" close button (later renamed "Done" in round 2).

**Round 2** absorbed: hook directly consumable (no prop threading); `vi.resetModules()` for module-singleton tests; body-class + per-element class (flatter than `data-tour-active`); storage key carries version (`seen-v1`); `useLayoutEffect` cleanup; pointer-events backdrop isolation; conditional-target ring is best-effort; corrected replay-then-reload reasoning; cut sessionStorage tier; cut rename; reverted Got it→Done; added FindingsPanel empty-state copy; added naive-participant acceptance criterion; rewrote spotlight as flatter contract.

**Round 3** absorbed in v4:
- **Boundary**: replace hand-rolled subscriber Set with `useSyncExternalStore`-compatible store; export `TOUR_TARGET_CLASSES` constant for contract test; `ShortcutsHelp` keeps name but re-open mechanism stops being prop-threaded; contract test gets a real owner.
- **Failure-mode**: `markSeen` wraps write in try/catch; `kookr-` prefix all class names; contract test relaxed to `>= 1`; rephrased FindingsPanel copy to remove `+ Launch` reference.
- **Design-minimalist**: cut subscriber Set; cut console.warn; cut Card 5; left V2 deferred items intact.
- **Socratic**: dissolved Card 5 (#4); rephrased FindingsPanel copy (#3); kept `seen-v1` discipline rule with explicit acknowledgment (#5); moved naive-participant from Requirements to Process commitments (#2).
- **Delivery-pragmatist**: existing-user interrupt accepted as one-button cost (cut bootstrap heuristic after convergence-check pushback) (#2); no kill-switch — one-line patch is the equivalent (cut constant after convergence-check pushback) (#1); atomicity stated explicitly (#3); SVG inlined as React component (#6); update existing Playwright selectors for `?` button label change in same PR (low).
- **Convergence check** (after v4): cut `bootstrapForExistingUsers` and `ONBOARDING_TOUR_ENABLED` per agreement between failure-mode and design-minimalist. Both were permanent runtime code for one-shot operational concerns; the equivalent actions (accept one-time interrupt, one-line patch) carry the same cost without the named concepts.

### Adversarial-pair resolution: ambition-amplifier vs design-minimalist (round 1-2)

Already resolved in v3, no new pair conflict in round 3 (ambition not invoked per skill rule). Items resolved earlier: interactive demo task (sided minimalist — defer), CSS spotlight (sided ambition — accept), single SVG (sided ambition — accept), sessionStorage tier (sided minimalist — cut), useOnboarding shape (sided boundary's specific suggestion — eventually replaced with `useSyncExternalStore` store), FindingsPanel empty-state copy (sided ambition — fold in).

### Invocation log

- ambition-amplifier 2026-05-05: round 1, novel finding (CSS spotlight middle ground, one SVG, FindingsPanel empty-state copy fix).
- ambition-amplifier 2026-05-05: round 2, novel finding (naive-participant acceptance criterion).
- ambition-amplifier round 3: skipped per skill rule (rounds 1-2 only unless new "deferred" or "future work" items added; v3 added no new V2 items beyond round-1/2 catalog).

## Open questions / V2

- **Interactive demo task during the tour.** Synthetic no-op task that produces a real-looking finding mid-tour, making Card 4's abstraction concrete. Needs separate RFC.
- **Post-first-finding contextual nudge.** Second trigger fired the first time the user's first task produces its first finding.
- **Empty-state card** (distinct from the empty-state copy folded into v4). Richer cold-dashboard card with CTA button.
