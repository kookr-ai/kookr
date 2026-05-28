import type { APIRequestContext } from '@playwright/test';

/**
 * Reset all server-side test state via the centralized `/api/test/reset`
 * endpoint (see e2e/test-server.ts). Call this in `beforeEach`/at the top of
 * a test to start from a clean project/workspace/task state.
 *
 * This is the single shared implementation; specs should import it from here
 * rather than redefining a local copy.
 */
export async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}
