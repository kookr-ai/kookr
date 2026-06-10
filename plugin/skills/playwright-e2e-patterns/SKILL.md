---
name: playwright-e2e-patterns
description: Playwright E2E testing patterns. Use when playwright, E2E test, toBeVisible, route mock, modal, flaky test, or selector issues.
keywords: playwright, e2e, toBeVisible, route-mock, modal, flaky-test, firefox, selector, data-testid, storageState, serial
related: testing-patterns
---

# Playwright E2E Testing Patterns

E2E testing patterns for the Kookr dashboard.

## Quick Commands

```bash
npx playwright test                          # All tests (config at repo root, testDir ./e2e)
npx playwright test e2e/canary.spec.ts       # Specific file
npx playwright test --headed                 # See browser
npx playwright test --debug                  # Inspector
```

## Quick Reference

| Problem | Cause | Fix |
|---------|-------|-----|
| Clicks wrong modal | Generic `.modal` selector | Use `[data-modal="name"]` or `data-testid` |
| Mock doesn't work | Set up after navigation | Mock BEFORE `page.goto()` |
| Broad mock catches specific routes | Pattern too wide | Register specific routes first |
| Assertion fails on async content | Content loads after render | Use `toBeVisible({ timeout })` or `waitForResponse()` |
| Welcome modal blocks clicks | First-visit modal | Set localStorage via `addInitScript()` |
| Firefox-only failures | Timing differences | Use specific selectors + explicit waits |
| Serial tests conflict | Browser projects run parallel | Use `workers: 1` |
| Count is 0 but elements exist | Feature changed DOM structure | Inspect actual DOM with `innerHTML()` |
| WS message silently dropped | WS not connected when sent | Wait for connection indicator before sending |
| State leaks between tests | Reset endpoint incomplete | Clear ALL stateful subsystems in reset |

## Selector Strategy

Prefer `data-testid`, role-based (`getByRole('button', { name: 'Submit' })`). Avoid CSS classes (`.modal`, `.button`). Be specific: `[data-modal="delete-confirmation"]` not `.modal`.

## Route Mocking

Mock BEFORE navigation:
```typescript
await page.route('**/api/v1/tasks', route => route.fulfill({ json: mockTasks }));
await page.goto('http://localhost:30080');
```

Specific routes first:
```typescript
await page.route('**/api/v1/tasks/123', route => route.fulfill({ json: specificTask }));
await page.route('**/api/v1/tasks', route => route.fulfill({ json: taskList }));
```

Fallthrough pattern:
```typescript
await page.route('**/api/v1/**', route => {
  const url = route.request().url();
  if (url.includes('/tasks')) route.fulfill({ json: mockTasks });
  else if (url.includes('/workflows')) route.fulfill({ json: mockWorkflows });
  else route.continue();
});
```

## Welcome Modal Handling

```typescript
// Set localStorage before navigation
await page.addInitScript(() => localStorage.setItem('aegis_welcome_dismissed', 'true'));
await page.goto('/');

// Or use storageState
test.use({
  storageState: { cookies: [], origins: [{ origin: 'http://localhost:30080', localStorage: [{ name: 'aegis_welcome_dismissed', value: 'true' }] }] }
});

// Or dismiss if present
const modal = page.locator('[data-modal="welcome"]');
if (await modal.isVisible({ timeout: 1000 })) await modal.getByRole('button', { name: 'Close' }).click();
```

## Waiting for Dynamic Content

```typescript
await page.goto('http://localhost:30080');
await page.waitForResponse('**/api/v1/tasks');
await expect(page.locator('.task-item')).toHaveCount(5);
await expect(page.locator('.task-item').first()).toBeVisible({ timeout: 10000 });
```

## Debugging Failing Assertions

When a DOM assertion (`toHaveCount`, `toBeVisible`) fails, **don't increase the timeout first**. Follow this sequence:

1. **Inspect the actual DOM** — `await page.locator('.parent').innerHTML()` or `page.evaluate(() => document.body.innerHTML)`. A count of 0 could mean "not arrived yet" OR "rendered as a different element."
2. **Check server state** — `await request.get('/api/state')` to confirm the data exists server-side. If the server has the data but the DOM doesn't, it's a client delivery or rendering issue.
3. **Check for feature interactions** — grouping, filtering, collapsing, project selection can all replace expected elements with different ones. Same data, different DOM structure.
4. **Add intermediate assertions in loops** — when creating N items in a loop and asserting count at the end, assert after each iteration to find the exact step where things diverge.
5. **Only then consider timeouts** — if server state is correct AND the DOM structure matches expectations, a timeout increase may be warranted.

## WebSocket-Dependent Tests

When tests trigger server actions via REST and then assert on DOM that updates via WebSocket:

- **Wait for WS connection** before any WS-dependent action — check for a connection indicator element (e.g., `.health-dot-connected`)
- **After page reload** (`page.goto('/')`), the WS reconnects asynchronously — wait for the connection indicator, not just the page content
- **REST returns ≠ client received** — `injectEvent` returning `{ ok: true }` means the server processed it and called `ws.send()`, but the browser may not have received/rendered it yet
- **Assert intermediate state** — after each inject, wait for the corresponding DOM change before injecting the next event

## Test Isolation

Reset endpoints must clear ALL stateful subsystems, not just the obvious ones:
- Monitor (agents)
- Queue (anomalies, snoozed entries)
- Task store
- Watchdog state
- Terminal sessions
- Hook watchers

Missing any subsystem causes state leakage between tests — symptoms appear as unexpected counts, stale data, or "impossible" states.

## Best Practices

- Mock API responses for predictable state
- Run `workers: 1` if tests modify shared state
- Test Chromium, Firefox, WebKit; Firefox needs more explicit waits
- Debug: `page.on('console', msg => console.log(msg.text()))`
- Screenshot on failure: `testInfo.status !== 'passed' && page.screenshot()`
- Breakpoint: `await page.pause()`

## See Also

vitest-bun-mocking, e2e-test-troubleshooting, api-route-patterns
