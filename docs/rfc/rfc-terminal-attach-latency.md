# RFC: Terminal Attach & Task-Switch Latency

**Status:** Draft (v4 — consensus-attack revision; ready for human review)
**Date:** 2026-08-03
**Author:** Jean Ibarz (with Grok)
**Related:** ADR-009, ADR-014, **PR #1927 (merged 2026-08-03)**,
`docs/rfc/rfc-terminal-activity-panel-visibility.md`,
evidence: `docs/rfc/rfc-terminal-attach-latency-evidence.md`

---

## Problem

Multi-agent triage requires fast **attention switches**. Selecting a task must
show that agent’s live terminal. Operators report **1–several seconds** to a
useful view.

**Sub-second attach is a hard product objective** for both:

| Path | Meaning |
|------|---------|
| **Warm** | Session already retained client-side and/or server has a fresh current-frame seed |
| **Cold** | First attach with no client retention — including sessions never opened in this browser session |

Warm-only optimization is incomplete: operators often open many tasks once.

### Framing honesty (product metric)

“Attention switch feels slow” is **not automatically identical** to
“`selectionToFirstPaintMs` for terminal viewport paint.”

Attach paint is a **high-value proxy** and is the main technical object of this
RFC, but Phase 0 must also check:

1. After #1927, on **real sequential triage** (not only scripted concurrent cold
   absolute), is cold first-viewport paint still multi-second?  
2. When operators say “useful view,” do they mean **current PTY cells**, or
   **Activity/anomaly context**, or **scrollback that contains the error**?  
3. Would **lazy terminal attach** (attach only when terminal pane focused) or
   **default multi-view retention** change felt latency more than shaving cold
   reconstruct?

If attach paint is already sub-second after #1927 while felt lag remains,
prioritize product-model options (lazy attach, multi-view, activity-first
select) over SessionScreen/VTE. Class attach SLOs remain valid engineering
targets; they are not the only possible definition of success.

### Facts (code + merge state)

| Fact | Status |
|------|--------|
| PR #1927 seed cache, 50 ms resize wait, no-blank, attach telemetry | **Merged** on `main` (`06430142`) |
| Reconstruct process-wide concurrency = 1, `maxMs = 50` | Verified; busy → `null` → recovery |
| Recovery path | Secondary dtach ≥800 ms + **always Ctrl+L** ≥450 ms for owners |
| Pre-#1927 client | `clear` + `reset` on open (blank by design) |
| #1927 client telemetry report | **Blended** first-paint percentiles only — **not** warm/cold × strategy |
| Server `terminal_bridge_timing` | Has `strategy`, `seedCacheHit` in **logs** only |

**Implication:** multi-second paths are real (waits, recovery, full-ring, blank UX).
**Class-stratified** attach p95 is still **not operable** for go/no-go until
measurement is fixed (Phase 0.0 below).

### Structural defect

`SessionBridge` is a per-WS view that also owns reconstruct policy and inputful
recovery. Under concurrent absolute opens and future multi-view, that is the
wrong owner.

---

## Goals

### Latency SLOs (stratified only)

Metric: first useful paint of **current viewport**
(`selectionToFirstPaintMs` joined to strategy / warm labels).

| Class | Target p95 | Notes |
|-------|------------|-------|
| Warm | ≤ 150 ms (stretch 50) | Retained view or seed hit + paint |
| Cold absolute happy path | ≤ 500 ms | No recovery |
| Cold streaming (Claude/Codex) | ≤ 800 ms | Viewport-first, not full 1 MiB |
| Recovery strategies | rate &lt; 1%; that class p95 ≤ 1.5 s | Prefer eliminate inputful recovery |

**Blended `subSecondRate` is secondary only.** Go/no-go uses stratified slices.

### Product decisions (closed)

| ID | Decision |
|----|----------|
| D-P1 | **Viewport-first:** full scrollback is on-demand or settings opt-in “always history.” |
| D-P2 | **Multi-view retained terminals** are a *product option* for warm UX, **not** a success criterion of this RFC. Success = class SLOs. Multi-view ships only if warm residual fails after seed/no-blank — or Jean prioritizes VS Code-like tabs as product. |
| D-P3 | **Session-scoped current frame** (someone owns `getSeed(sessionId)`) is the architectural answer when cold absolute / multi-client recovery needs it — introduced as a **thin owner first**, grown only if needed. |
| D-P4 | **Measurement gates coding order and can kill scope.** Residual-class failure opens a named option; green SLOs → stop (F). |

### Non-goals

- Replacing agent CLIs; remote-desktop fidelity  
- WAN SLOs without a remote transport design  
- Deleting dtach for style  
- Landing a large “terminal platform” without residual-class evidence  

---

## Requirements

- **R1** Stratified telemetry and success (warm/cold × agentType × strategy).  
- **R2** First paint = current viewport; history optional (D-P1).  
- **R3** No false blank; **SHALL** show pending-session chrome and **block terminal send** until attach established for the new session (wrong-agent mitigation).  
- **R4** Operable diagnostics (not log-grep-only).  
- **R5** Caps on always-on work; governor only when continuous model exists.  
- **R6** Heavy options remain in the catalog; rejection needs evidence.  
- **R7** Inputful recovery is **session single-flight**, never viewer-triggered; **no automatic Ctrl+L when a non-empty frame snapshot already exists**.  
- **R8** Reconstruct must not default concurrent absolute attaches to busy→Ctrl+L.

---

## Design space (catalog — not a forced build list)

### A Server current-frame

| ID | Idea |
|----|------|
| A1 | Throttled seed refresh (reconstruct-based) while dirty |
| A2 | Seed on launch/recovery only |
| A3 | Prepare/prefetch on select (shared seed owner) |
| A4 | Disk seed with rings (post-restart only) |

### B Client views

| ID | Idea |
|----|------|
| B1 | No-blank (#1927) + pending chrome + send gate (**now**) |
| B2 | LRU multi-xterm (product) — only if warm residual |
| B3 | Bitmap snapshot (visual only) |
| B4 | Eager xterm chunk load |
| B5 | **Lazy attach:** do not open `/ws/terminal` until terminal pane is focused / visible; select task may show Activity only first |
| B6 | **Activity-first select:** selection does not imply terminal attach; explicit “open terminal” or hotkey |

### C Transport / protocol

| ID | Idea |
|----|------|
| C1 | Multiplex on dashboard `/ws` (scope gate reuse) |
| C2 | LRU of N terminal sockets |
| C3 | Resize wait 0 when size known |
| C4 | Viewport-first attach (seed / last N KB first; history optional) |

### D Materialization

| ID | Idea |
|----|------|
| D0 | **Session seed owner** — thin `getSeed` / `setSeed` / single-flight recovery (minimal session-scoped truth) |
| D1-vte | Continuous live screen via maintained VT (`@xterm/headless` or WASM/native VTE) |
| D1-home | Home-grown incremental VT (last resort) |
| D2 | Secondary dtach primary (reject — too slow) |
| D4 | Fix reconstruct concurrency + recovery semantics |

### E Heavy

| ID | Idea | Trigger |
|----|------|---------|
| E1 | Native shell (Tauri/Electron) | Product pivot |
| E3 | Native terminal service | Event-loop proof after web path |
| E4 | Replace dtach | Cannot meet O(ms) current-frame capability |
| E5 | Replace xterm renderer | Parse dominates after C4 |

### F Measure-only

Ship measurement + small fixes; stop when class SLOs hold.

---

## Target architecture (when residual classes need it)

Not “build all of this next”; the shape when cold absolute / multi-client / warm
retention force structure:

```
LocalDtachBackend (bytes, ring, attach)
        │
        ▼
SessionSeedOwner / SessionScreen   // session-scoped; single writer for seed + recovery
        │
        ├── prepare (A3) — same owner
        └── SessionBridge — WS view only (framing, backpressure, user input)
                │
                ▼
        Client: one panel + optional Map of retained terms (B2)
                transport detail: multi-WS or multiplex when N>1 live
```

**Rules**

1. Canonical live path and seed generation stay on the session owner; bridges
   do not dual-subscribe to raw `onData` for seed policy.  
2. Recovery: only the session owner may inject Ctrl+L / secondary attach;
   single-flight; skip Ctrl+L if snapshot non-empty.  
3. User PTY writes and recovery writes share a **session write arbiter**.  
4. #1927 cache becomes a facade over the owner or is deleted — never a peer
   truth store.  
5. Protocol frames (when C4 history exists) live in `src/shared` contracts.  
6. ADR-014 amendment required if continuous server VT (D1-vte) lands — different
   product path than “replace the ring with headless.”

---

## Phased plan

### Phase 0.0 — Make Phase 0 operable (**first code after this RFC**)

#1927 is merged; the gap is **measurement**, not seed cache.

**Ship**

1. **`attachId`** (or equivalent) on client first paint and server
   `terminal_bridge_timing` (or bridge→client control frame with strategy).  
2. Client event fields: `clientWarm`, `serverStrategy` (or join), `seedCacheHit`,
   `agentType`, phase ms if available, `recoveryUsed`.  
3. `GET /api/telemetry/report` (or `/api/diagnostics/terminal-attach`):
   p50/p95 by **warm|cold × agentType × strategy**; recovery rate;
   expose reconstruct `busySkipped` / `budgetExceeded` (close open Q).  
4. **Pending-session chrome + terminal send blocked** until new session attach
   established (R3) — hotfix on #1927 baseline, not buried later.  
5. Optional: B4 eager xterm prefetch.

**Exit:** an operator can answer “class SLOs?” from one endpoint without log
forensics.

### Phase 0 — Measure (48 h+) **with load recipe + dogfood**

- Natural **sequential** triage traffic (primary product path).  
- Scripted concurrent cold absolute opens (N≥2…8) so busySkip→recovery is
  exercised (stress, not only natural).  
- Baselines: recovery rate, busySkipped, stratified p95.  
- Min sample sizes per class (e.g. ≥50 cold absolute, ≥50 cold stream) before
  kill decisions.  
- **Dogfood note:** does operator still describe lag when attach paint is
  already &lt;500 ms? If yes, open B5/B6/B2 product work, not only server VT.

**Kill / open-scope table (rewrites scope, not just order)**

| If residual is… | Enter scope | Do **not** force |
|-----------------|-------------|------------------|
| All classes meet SLOs | **F** — stop | SessionScreen, B2, C1 |
| Cold stream / 1 MiB | **C4** (viewport-first send) | D1-vte |
| Cold absolute / busySkip / recovery | **D4 + thin D0 seed owner** | Multi-view |
| Warm after seed hits | **B2** (+ C2/C1) | Continuous VTE |
| First-open chunk | **B4** | — |
| Blank UX / wrong-agent | Phase 0.0 chrome (already) | — |
| Felt lag with fast paint (dogfood) | **B5/B6 and/or B2 product model** | Server VTE |
| Streaming paint fast but not useful (need history) | **C4 history 1b / always-history setting** | Treat N KB viewport as done |
| Event-loop after thin stack | E3 | Premature rewrite |
| No O(ms) frame without hostile attach | E4 spike | — |

### Phase 0.5 — Reconstruct concurrency & recovery semantics (**concrete, not OR**)

**Design choice (default):**

- **Per-session reconstruct queue** (depth 1–2): never global busy→`null`→Ctrl+L
  as the default concurrent outcome.  
- Process-wide **CPU budget** still limits simultaneous walks (e.g. 1–2 in
  flight globally) but waiters get **queued reconstruct**, not silent skip.  
- Max queue wait: fail soft to last seed / last frame / empty with
  **no automatic Ctrl+L**; operator can retry.  
- **Change recovery:** if `captureCurrentFrame` returns non-empty snapshot,
  **do not** inject Ctrl+L.  
- Session single-flight for any remaining inputful recovery.  
- Expose busy/queue/recovery on diagnostics (Phase 0.0).

**Exit:** concurrent cold absolute load test shows busySkip≈0,
recovery rate collapsing, no Ctrl+L on non-empty snapshot.

### Phase 1 — Viewport-first attach (C4)

**Independent of SessionScreen.**

- Attach default: seed if any; else absolute reconstruct once; else streaming
  **last viewport / last N KB** with **specified** cut algorithm + property
  tests (mid-CSI, UTF-8, empty, wrap).  
- **Not** default full 1 MiB.  
- Full history: Phase **1b** (`request-history`) or setting “always history.”  
- Protocol version / compat mode so partial deploys don’t brick clients.  
- Feature flag: force full-ring for rollback.

**Exit (does not require SessionScreen):** cold stream p95 ≤ 800 ms;
absolute happy path ≤ 500 ms when seed or single reconstruct succeeds.

Optional **1a:** A3 prepare-on-select via #1927/`getSeed` owner if cold still
misses.

### Phase 2 — Session seed owner → optional continuous VTE

**2a (thin D0):** session-scoped owner wrapping seed cache + single-flight
recovery + `getSeed`; bridges call owner only; supersede #1927 dual store.  

**2b (only if 2a + C4 + 0.5 miss cold absolute or multi-client correctness):**
continuous D1-vte spike (RSS, fidelity, poison); ADR-014 amendment; governor
caps; optional oracle after real smash incidents.

**Feature flag:** force legacy bridge path.

**Exit:** cold absolute p95 ≤ 300 ms with warm seed model; recovery &lt; 1%.

### Phase 3 — Multi-view (B2) **only if** warm residual (or product priority)

- Simple client model first: `Map<sessionId, {term, socket?}>` + LRU — split
  modules only if size demands.  
- Transport in **same delivery** if N sockets hurt (C2 first; C1 if needed).  
- **Hard dependency:** Phase 2a recovery ownership before multi-view, so N views
  do not N-recover.  
- Flag: N=1 disables multi-view.

### Phase 4 — Heavy (triggered)

Unchanged triggers: event-loop proof → E3; no O(ms) frame capability → E4;
desktop product → E1; parse after C4 → E5.

---

## Rollback & shippability

| Phase | Rollback |
|-------|----------|
| 0.0 metrics / chrome | Revert PR; low risk |
| 0.5 concurrency / Ctrl+L change | Env flags for reconstruct policy |
| 1 C4 | Server setting force full-ring; protocol compat |
| 2 Session owner / VTE | Force-legacy bridge flag |
| 3 multi-view | N=1 flag; ignore multiplex |

Each phase should be **main-mergeable** behind flags.

---

## Operability requirements (SHALL)

1. Stratified attach report (Phase 0.0).  
2. Live reconstruct stats + recovery audit (sessionId, reason, duration,
   inputful yes/no).  
3. Seed age / generation when Session owner exists.  
4. Phase 0 procedure: endpoint + load script + min samples + kill table.  
5. Wrong-agent safety: `terminal_input_blocked_pending_attach` counter.

---

## Edge cases (selected)

- Concurrent Grok open → must not Ctrl+L storm (0.5).  
- Stale seed vs live → generation; pending chrome.  
- Viewer blank on reconstruct fail → no inputful recovery; live wait or message.  
- Governor shed → client notified; may use ring-only with absolute caution.  
- First dashboard open → split metrics (B4).  
- Share/relay scope unchanged on multiplex.

---

## Alternatives considered

| Alternative | Verdict |
|-------------|---------|
| #1927 forever | Insufficient if residual classes fail; fine if Phase 0 greens all |
| Prefetch-only forever | Incomplete without concurrency/recovery fix |
| Full SessionScreen+VTE+B2+C1 as mandatory ladder | Overbuild; catalogued, residual-gated |
| Lead language/native rewrite | Does not remove waits/protocol; Phase 4 only |
| Secondary dtach as primary | Too slow |
| Blended subSecondRate go/no-go | Rejected |

---

## Open questions

1. Default multi-view N if Phase 3 opens (proposal 8)?  
2. Remote/share SLO class?  
3. VTE candidate shortlist for 2b spike?  
4. Settings copy for “always load full scrollback”?  

---

## Success metrics

- Stratified class p95 meet Goals  
- Recovery rate &lt; 1%; busySkip≈0 under concurrent load test  
- No wrong-agent input regression (blocked-send counter)  
- Blended subSecondRate optional vanity only  

---

## Critic feedback incorporated

### Round 1 (2026-08-03)

Panel: boundary-critic, failure-mode-analyst, design-minimalist,
socratic-challenger, ambition-amplifier.

Incorporated: Session-scoped owner, recovery off view, ADR-014 honesty,
stratified metrics, concurrent reconstruct, kill criteria, closed scrollback
decision, VTE preferred over naive home-grown continuous VT, multi-view not
the only cold fix.

**Ambition vs minimalist (round 1):** measurement gates order; product catalog
keeps heavy vehicles.

### Round 2 (2026-08-03)

Panel: boundary-critic, failure-mode-analyst, delivery-pragmatist,
operability-reviewer, design-minimalist.

| Agent | Incorporation |
|-------|----------------|
| boundary | Live path/write arbiter; governor placement; 0.5 not permanent second owner |
| failure-mode | Stratified join keys; concurrent load recipe; concrete 0.5; no Ctrl+L on non-empty snapshot; content vs latency; #1927 merged |
| delivery | Phase 0.0 first; pending chrome now; Phase 1 exit without SessionScreen; hard-seq multi-view after seed owner; flags/rollback; split 2a/2b |
| operability | Attach diagnostics requirements; recovery audit; readiness |
| design-minimalist | **End-state is residual-gated hypothesis**, not forced build list; success = class SLOs; thin D0 before VTE; multi-view optional product |

**Ambition vs minimalist (round 2):** Agreed with minimalist that **RFC success
is stratified SLOs**, not “landed the full terminal platform.” Agreed with
ambition that **session-scoped seed/recovery ownership and real VT remain the
correct structural answers when residual classes demand them** — not discarded
as “too heavy,” only **not pre-built**.

### Empirical checkpoint

- Reconstruct concurrency=1, maxMs=50, Ctrl+L recovery, main blank-on-switch
  (pre-#1927): verified.  
- #1927 **merged**; blended report only: verified.  
- Concurrent busySkip→recovery: structural (code), not yet quantified in
  production attach histograms.

### Intent preservation

User: full option space including heavy refactor/rewrite; do not stick to dirty
hacks to avoid heavy choices. v4 keeps E\* and SessionScreen/VTE/multi-view in
the catalog with honest triggers; forbids soft-pedaling them as “never,” and
forbids building them without residual-class evidence. Also records that
**product model** (lazy attach, multi-view default) is a first-class lever, not
only server attach optimization.

---

## Consensus attack

**general-purpose 2026-08-03:** Framing blind spot found and incorporated.

- **Assumption:** “Fast attention switch” ≡ stratified terminal first-viewport
  paint, with cold co-equal to warm as hard SLO.  
- **Failure scenario:** Phase 0–1 green on attach paint while operator still
  waits on wrong-agent chrome, useless streaming viewport without history, or
  attaches on every select when Activity would suffice → F-stop with complaint
  intact.  
- **Avoided question:** After #1927 on sequential triage, is cold attach paint
  still multi-second *and* the same event operators mean by “useful view”?  

**Response in v4:** Framing honesty section; B5/B6 product options; Phase 0
dogfood gate; kill-table rows for felt lag and streaming usefulness. Attach
SLOs remain engineering targets; they no longer silently define the whole
product problem.
