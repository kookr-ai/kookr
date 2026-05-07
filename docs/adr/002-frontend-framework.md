# ADR-002: Frontend Framework

## Status

**Accepted** (2026-03-24, by Jean Ibarz)

## Context

Kookr's frontend is a core differentiator — it's the ADE (Agentic Development Environment) GUI that developers interact with daily. Requirements:

1. **Real-time updates** — Agent status changes must reflect instantly (< 2s)
2. **Two-panel layout** — Findings (left), terminal + response input (right)
3. **WebSocket integration** — Bidirectional communication with backend
4. **Robustness** — Must scale in complexity without becoming fragile
5. **AI-developable** — AI coding agents will help build and maintain the frontend
6. **Desktop packaging support** — Must work with Tauri or Electron if desktop app is chosen
7. **Testing** — Must support Playwright E2E testing

## Options

### Option A: React + Vite

**Pros:**
- Largest ecosystem — component libraries, state management options, community resources
- AI coding agents are most familiar with React (most training data)
- Excellent TypeScript support
- Mature testing patterns
- Works with Electron and Tauri
- Huge pool of developers

**Cons:**
- More boilerplate than alternatives
- Requires choosing and integrating state management (Zustand, Jotai, Redux)
- Virtual DOM adds overhead compared to compiled frameworks
- Common pitfall: over-engineering with too many abstractions

### Option B: Svelte 5 (with SvelteKit)

**Pros:**
- Compiled — no virtual DOM runtime, excellent performance
- Less boilerplate — reactive by default
- Smaller bundle size
- Simpler mental model — less framework to learn
- Built-in state management (runes in Svelte 5)

**Cons:**
- Smaller ecosystem than React
- AI agents have less training data on Svelte 5 (runes are relatively new)
- Fewer off-the-shelf component libraries
- Smaller developer pool for hiring/community plugins

### Option C: Vue 3 + Composition API

**Pros:**
- Good balance of maturity and developer experience
- Reactive by default (similar to Svelte)
- Large ecosystem, good component libraries
- Excellent TypeScript support via `<script setup lang="ts">`

**Cons:**
- Smaller ecosystem than React
- Less AI familiarity than React
- Options API vs Composition API split can cause confusion

### Option D: SolidJS

**Pros:**
- Best runtime performance (fine-grained reactivity, no Virtual DOM)
- React-like API — easy to learn for React developers
- Very small bundle

**Cons:**
- Smallest ecosystem of all options
- Least AI familiarity
- Fewer production references
- Smaller community for plugin development

## Decision

**React + Vite.** Accepted by Jean Ibarz on 2026-03-24.

### Rationale

The decision came down to React vs. Svelte 5. Both are viable for Kookr's needs, but React wins on the factors that matter most for this project:

1. **AI-developability is the decisive factor.** Kookr is built with heavy AI agent assistance. React has overwhelmingly more representation in AI training data, which means fewer mistakes, better code generation, and faster iteration throughout V1 and beyond. This is a compound advantage.

2. **Kookr's frontend is simple.** A dashboard with ~5-10 components and WebSocket-driven updates at human-readable rates. Svelte's compiled performance advantage is irrelevant at this scale — React's Virtual DOM overhead won't be noticeable.

3. **WebSocket + real-time state is well-trodden in React.** Zustand + a WebSocket hook is a ~30-line pattern with abundant examples and battle-tested precedent.

4. **Component library depth.** If Kookr needs a terminal emulator component (xterm.js), resizable panels, or tree views, React has mature, maintained options. Svelte's ecosystem is thinner for specialized components.

5. **Low-risk choice.** The gap analysis noted this is a low-risk decision — either framework works. React is the safer bet for a project that prioritizes shipping speed over framework elegance.

### Stack choices

| Concern | Choice | Why |
|---------|--------|-----|
| Framework | React 19 | Ecosystem, AI familiarity |
| Build tool | Vite | Fast, standard for React projects |
| State management | Zustand | Minimal boilerplate, works well with WebSocket patterns |
| Styling | CSS Modules or Tailwind (decide at Phase 2 start) | Avoid premature choice — both work fine |
| Testing | Playwright (E2E), Vitest + React Testing Library (unit) | Already decided in project setup |

## Consequences

- Leverage the massive React ecosystem for rapid development
- AI agents will be most effective at writing and modifying frontend code
- Risk of over-engineering — must enforce simplicity discipline (few components, flat structure, no premature abstractions)
- Zustand chosen for state management to avoid Redux/MobX complexity
- Svelte 5's performance advantage and conciseness are acknowledged trade-offs — acceptable given Kookr's simple UI needs

## GUI Layout Decision (2026-03-24)

**[Proposal 33 — Supervisor-First Triage](../spikes/gui-proposals/33-supervisor-first-triage.html)** selected as the implementation target after evaluating 27 HTML prototypes across 3 iterations of a generate/critique loop.

**Key layout decisions:**
- **Supervisor-first framing:** The left panel shows supervisor findings (anomalies) ordered by urgency — not a flat agent list. Healthy agents are collapsed into a compact section. This matches Kookr's core value proposition: the supervisor's explanations are the product.
- **Terminal as main content:** The right panel shows an interactive xterm.js terminal bridged to the agent's dtach session (ADR-014; originally tmux per ADR-007). The terminal is always visible when an agent is selected — no conversation column needed since agent context is provided by the supervisor's findings panel.
- **Respond-and-advance loop:** "Send & Next" as the primary action. Queue dots in the top bar track triage progress. Sent-confirmation overlay shows advancement.
- **Inline quick-reply on finding cards:** For fast triage without needing to drill into the detail panel.

See `docs/spikes/gui-proposals/` for the full set of evaluated prototypes. (The original `critique-1.md` / `critique-2.md` scoring criteria files have been removed; the scoring matrix from those documents informed the evaluation below.)
