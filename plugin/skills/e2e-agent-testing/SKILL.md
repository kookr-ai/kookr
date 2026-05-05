---
name: e2e-agent-testing
description: Strategy for mocking Claude Code agents in E2E tests with canary validation against real behavior.
keywords: e2e, mock, agent, claude code, haiku, canary test, FakeTerminalManager, hook event, end-to-end, integration, cost
related: testing-patterns, playwright-e2e-patterns
---

# E2E Agent Testing Strategy

## When to Use

- Writing or modifying E2E tests that involve Claude Code agents
- Deciding whether to mock agent behavior or use a real agent
- Adding new hook event types or changing the event contract
- Reviewing test cost and speed trade-offs

## Core Principle: Mock by Default, Verify with Canary

**Most E2E tests should mock Claude Code** using `FakeTerminalManager` and event injection. One opt-in **canary test** validates that mocks match real Claude Code behavior. If Claude Code changes its hook event format, the canary test breaks first, the mock fixtures get updated, and all other tests stay accurate.

```
┌─────────────────────────────────────────────────────┐
│  e2e/canary.spec.ts (CANARY=1, real Claude + Haiku) │
│  Validates: mock event shapes match real behavior    │
│  Runs: locally before merge (PR checklist item)       │
└──────────────────────┬──────────────────────────────┘
                       │ if drift detected, update ↓
┌──────────────────────▼──────────────────────────────┐
│  e2e/fixtures/mock-events.ts                         │
│  Source of truth for mock hook events                 │
│  Used by: all E2E tests + unit tests                 │
└──────────────────────┬──────────────────────────────┘
                       │ imported by ↓
┌──────────────────────▼──────────────────────────────┐
│  e2e/kookr.spec.ts (fast, no real Claude)           │
│  Uses: FakeTerminalManager + inject-event endpoint   │
│  Runs: every PR, every push                          │
└─────────────────────────────────────────────────────┘
```

## Decision Table

| Scenario | Approach | Why |
|---|---|---|
| UI behavior (triage, launch, rename, keyboard) | Mock (FakeTerminalManager + event injection) | No real agent needed; fast, deterministic |
| Anomaly detection (needs_input, permission_blocked) | Mock (inject specific hook events) | Tests detection logic, not Claude Code |
| Hook event parsing correctness | Unit test (hook-parser.test.ts) | Pure function, no I/O |
| Hook event **shape** still matches real Claude Code | Canary test (real Claude + Haiku) | Catches contract drift |
| Full agent lifecycle (launch, work, complete) | Mock for CI; canary for validation | Real agents are slow and cost money |

## How It Works

### 1. FakeTerminalManager (existing)

All E2E and most integration tests use `FakeTerminalManager` instead of real tmux. It's an in-memory implementation of the `TerminalManager` interface that records calls without launching real processes.

- Location: `src/adapters/fake-terminal-manager.ts`
- Used by: `e2e/test-server.ts`, most `src/**/*.test.ts` files

### 2. Event Injection (existing)

The E2E test server exposes `POST /api/test/inject-event` to feed hook events directly into the `ClaudeCodeAdapter`, bypassing the hook file watcher. This lets tests simulate any agent behavior sequence.

```typescript
// Inject a Stop event (triggers needs_input anomaly)
await request.post(`${BASE}/api/test/inject-event`, {
  data: { tmuxName, event: mockStop() },
});
```

### 3. Mock Event Fixtures (new)

`e2e/fixtures/mock-events.ts` provides typed builders for every hook event type, plus shape metadata used by the canary test.

```typescript
import { mockSessionStart, mockStop, mockPreToolUse } from './fixtures/mock-events';

// Use in E2E tests
await injectEvent(request, tmuxName, mockSessionStart());
await injectEvent(request, tmuxName, mockStop({ last_assistant_message: 'Custom message' }));
```

### 4. Canary Test (new)

`e2e/canary.spec.ts` launches a real Claude Code instance with **Haiku model** (cheapest, fastest), captures the hook events it emits, and validates them against the mock fixture shapes.

```bash
# Run canary test (requires tmux + Claude Code CLI + API key)
CANARY=1 npx playwright test e2e/canary.spec.ts

# Cost: ~$0.001 per run (Haiku, trivial task)
# Duration: ~10-30 seconds
```

**When to run it:**
- Locally before merging any PR (enforced via PR template checklist)
- After upgrading the Claude Code CLI
- When hook event parsing breaks unexpectedly

```bash
CANARY=1 npx playwright test e2e/canary.spec.ts
```

Requires: tmux, `claude` CLI, `ANTHROPIC_API_KEY` in env.

**What it validates:**
- Every real event has `session_id`, `transcript_path`, `cwd`, `hook_event_name`
- Tool events have `tool_name`
- Stop events have `stop_hook_active`
- All real events parse through `parseHookEvent()` without errors
- Event type set matches what our mocks cover

## Writing New E2E Tests

When adding a new E2E test:

1. **Use `FakeTerminalManager`** — the test server already does this
2. **Use mock event builders** from `e2e/fixtures/mock-events.ts`
3. **Inject events** via `/api/test/inject-event` to simulate agent behavior
4. **Never launch real Claude Code** in standard E2E tests

```typescript
// Good: mock-based E2E test
test('new anomaly type appears as finding', async ({ page, request }) => {
  await launchViaUI(page, 'Task', '/test/project');
  const tmuxName = await getLatestTmuxName(request);
  await injectEvent(request, tmuxName, mockSessionStart());
  await injectEvent(request, tmuxName, mockStop());
  await expect(page.locator('.finding-card')).toBeVisible();
});
```

## When to Use Real Claude Code (Haiku)

Only in explicitly opt-in tests:
- Canary tests validating mock accuracy
- Integration tests verifying the full launch-to-hook pipeline
- Always use `--model haiku` to minimize cost
- Always gate behind `CANARY=1` environment variable
- Set generous timeouts (60s+) — real agents are slow

## Handling Mock Drift

When the canary test fails:

1. Read the canary test output to see which fields changed
2. Update `e2e/fixtures/mock-events.ts` to match the new shape
3. Update `src/core/hook-parser.ts` if the parsing contract changed
4. Re-run all E2E tests to confirm they pass with updated mocks
5. Commit the fixture update with a clear message about the contract change

## See Also

- `e2e/fixtures/mock-events.ts` — Mock event builders
- `e2e/canary.spec.ts` — Canary validation test
- `e2e/test-server.ts` — E2E server with FakeTerminalManager
- `src/adapters/fake-terminal-manager.ts` — In-memory terminal mock
- `src/core/hook-parser.ts` — Hook event parsing contract
- [[testing-patterns]] — General testing strategy
- [[playwright-e2e-patterns]] — Playwright-specific patterns
