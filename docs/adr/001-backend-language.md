# ADR-001: Backend Language

## Status

**Accepted** (2026-03-23, by Jean Ibarz)

## Context

Kookr needs a backend that handles:
- Spawning and monitoring local agent processes (Claude Code, Codex CLI, etc.)
- WebSocket + REST API for frontend communication
- Plugin loading and sandboxed execution
- Session state persistence
- Real-time event processing

The two primary candidates are **TypeScript (Node.js)** and **Python**. The `.gitignore` in the repo is Node.js-oriented, suggesting an initial leaning toward TypeScript.

Key decision drivers:
1. **Preventing mistakes at scale** — the project explicitly values frameworks that prevent mistakes as complexity grows
2. **Single-language stack** — sharing types between frontend and backend reduces integration errors
3. **AI-friendly code** — AI coding agents have strong familiarity with both languages
4. **Process management** — the backend must manage multiple child processes efficiently
5. **Plugin ecosystem** — plugins should be easy to write for the community

## Options

### Option A: TypeScript (Node.js)

**Pros:**
- Single language across frontend and backend — shared type definitions, shared tooling
- Strict type system catches errors at compile time
- Excellent async I/O model matches the event-driven nature of agent monitoring
- Strong monorepo tooling (Turborepo, pnpm workspaces)
- `child_process` module is mature for process management
- Largest single-language ecosystem for web applications

**Cons:**
- Weaker AI/ML ecosystem if supervisor needs ML-based prioritization
- Some process management patterns are simpler in Python
- Community of AI tool developers may be more Python-native

### Option B: Python

**Pros:**
- Dominant AI/ML ecosystem — useful if prioritization uses ML models
- FastAPI is excellent for building APIs with auto-generated docs
- Many AI tools and SDKs are Python-first
- `asyncio` + `subprocess` handle agent process management well

**Cons:**
- Requires maintaining two languages (Python backend + JS/TS frontend)
- Type checking is optional (mypy) — easier to introduce type errors
- Async ecosystem is fragmented (sync vs async libraries)
- Sharing types between frontend and backend requires code generation or manual sync

### Option C: TypeScript backend + Python plugin support

**Pros:**
- Gets the single-language advantage for core development
- Plugin authors can use Python if preferred
- Best of both worlds

**Cons:**
- Cross-language plugin hosting adds complexity
- Two runtimes to manage

## Decision

**TypeScript (Option A)** — Full TypeScript stack for both backend and frontend.

Rationale: Single-language stack maximizes type sharing, reduces context-switching, and aligns with the project's goal of preventing mistakes as complexity grows. The AI/ML ecosystem gap is acceptable since the supervisor's prioritization logic is rule-based, not ML-based.

## Consequences

- Frontend and backend share type definitions, reducing integration bugs
- Monorepo with shared packages becomes natural (pnpm workspaces or Turborepo)
- Plugin authors use TypeScript/JavaScript
- Team must be comfortable with Node.js process management patterns
- All tooling (linting, testing, building) is unified around the JS/TS ecosystem
