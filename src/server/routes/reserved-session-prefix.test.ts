import { describe, test, expect } from 'vitest';
import { isReservedObservedSessionId } from './diagnostics-routes.js';
import { OBSERVED_SESSION_PREFIX } from '../observed-activity-store.js';
import { REPLAY_SESSION_PREFIX } from '../hook-ingestion.js';

/**
 * The public `POST /api/hook-event/:sessionId` route (unauthenticated on
 * loopback) must reject the Hermes observed namespace so the lane cannot be
 * driven through it (jeanibarz/hermes-fleet#15, RFC §Design defense-in-depth).
 * Replay sessions, by contrast, are DESIGNED to flow through that route.
 */
describe('isReservedObservedSessionId', () => {
  test('rejects the Hermes observed prefix', () => {
    expect(isReservedObservedSessionId(`${OBSERVED_SESSION_PREFIX}alpha`)).toBe(true);
  });
  test('does NOT reject replay sessions (they legitimately use the hook route)', () => {
    expect(isReservedObservedSessionId(`${REPLAY_SESSION_PREFIX}x`)).toBe(false);
  });
  test('allows an ordinary live session id', () => {
    expect(isReservedObservedSessionId('kookr-main-abc123')).toBe(false);
    expect(isReservedObservedSessionId('claude-session-42')).toBe(false);
  });
});
