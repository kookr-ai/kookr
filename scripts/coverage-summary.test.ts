import { describe, expect, it } from 'vitest';

import { firstMatchingLayer } from './coverage-summary.js';

describe('firstMatchingLayer — Hooks risk layer', () => {
  it('attributes server hook-watcher to Hooks', () => {
    const layer = firstMatchingLayer(
      '/repo/src/server/hook-watcher.ts',
    );
    expect(layer?.name).toBe('Hooks');
  });

  it('attributes core hook-events to Hooks', () => {
    const layer = firstMatchingLayer(
      '/repo/src/core/hook-events.ts',
    );
    expect(layer?.name).toBe('Hooks');
  });

  it('does not attribute React frontend hooks to Hooks', () => {
    const layer = firstMatchingLayer(
      '/repo/src/frontend/hooks/useDnd.ts',
    );
    expect(layer?.name).not.toBe('Hooks');
    expect(layer).toBeUndefined();
  });

  it('does not attribute other frontend hooks under /hooks/ to Hooks', () => {
    const paths = [
      '/repo/src/frontend/hooks/useWebSocket.ts',
      '/repo/src/frontend/hooks/useNotifications.ts',
      '/repo/src/frontend/hooks/useSTT.ts',
    ];
    for (const path of paths) {
      expect(firstMatchingLayer(path)?.name).not.toBe('Hooks');
    }
  });
});

describe('firstMatchingLayer — other risk layers still pin', () => {
  it('attributes ws-handlers to WebSocket state before Process lifecycle', () => {
    // lifecycle-handler lives under ws-handlers; WebSocket state must win
    // (first-match precedence — see comment on LAYERS in coverage-summary.ts).
    const layer = firstMatchingLayer(
      '/repo/src/server/ws-handlers/lifecycle-handler.ts',
    );
    expect(layer?.name).toBe('WebSocket state');
  });

  it('attributes session-bridge to Terminal sessions', () => {
    const layer = firstMatchingLayer(
      '/repo/src/server/session-bridge.ts',
    );
    expect(layer?.name).toBe('Terminal sessions');
  });

  it('attributes launch-service to Orchestration', () => {
    const layer = firstMatchingLayer(
      '/repo/src/server/launch-service.ts',
    );
    expect(layer?.name).toBe('Orchestration');
  });

  it('attributes crash-recovery to Process lifecycle', () => {
    const layer = firstMatchingLayer(
      '/repo/src/server/crash-recovery.ts',
    );
    expect(layer?.name).toBe('Process lifecycle');
  });
});
