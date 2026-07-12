// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SessionHealthPanel } from './SessionHealthPanel.js';
import type { SessionHealthDiagnostics } from '../../shared/protocol.js';

let root: Root | null = null;
let container: HTMLDivElement;

function response(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const report: SessionHealthDiagnostics = {
    schemaVersion: 'session-health.v1',
    generatedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
    restartEpoch: new Date('2026-05-24T09:59:00Z').toISOString(),
    sessions: [{
      sessionId: 'session-1',
      schemaVersion: 'session-health.v1',
      generatedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
      restartEpoch: new Date('2026-05-24T09:59:00Z').toISOString(),
      classification: 'terminal-attach-stalled',
      task: { status: 'inProgress', turnState: 'running' },
      signals: {
        pty: { state: 'stale', lastProgressAt: new Date('2026-05-24T09:00:00Z').toISOString(), ageMs: 3_600_000, ringHead: 10 },
        hooks: { state: 'fresh', lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(), ageMs: 30_000 },
        transcript: { state: 'fresh', lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(), ageMs: 30_000, present: true },
      },
      backend: {
        transportState: 'verified',
        attachState: 'alive',
        recoveryInProgress: false,
        attachGeneration: 3,
        reattachCount: 1,
        lastAttachAt: new Date('2026-05-24T09:58:00Z').toISOString(),
      },
      browser: { bridgeOpen: false, lastOpenAt: null, lastReplayAt: null, lastLiveByteAt: null, freshBytesAfterReplay: false, replayedOnly: false },
      progress: { lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(), stallAgeMs: 30_000 },
      evidence: ['PTY/ring progress is stale while hooks and transcript are fresh'],
    }],
    coordinatedStall: null,
  };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(report))));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionHealthPanel', () => {
  test('renders a compact signal timeline, classification, and evidence', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(SessionHealthPanel));
    });
    await flush();

    expect(container.textContent).toContain('Session Health');
    expect(container.textContent).toContain('session-1');
    expect(container.textContent).toContain('Terminal Attach Stalled');
    expect(container.textContent).toContain('PTY');
    expect(container.textContent).toContain('Hooks');
    expect(container.textContent).toContain('Transcript');
    expect(container.textContent).toContain('Generation ×3');
    expect(container.textContent).toContain('PTY/ring progress is stale');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/diagnostics/session-health');
  });

  test('fails soft when the endpoint returns a malformed snapshot', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      schemaVersion: 'session-health.v1',
      generatedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
      restartEpoch: new Date('2026-05-24T09:59:00Z').toISOString(),
      sessions: [{ sessionId: 'missing-fields', classification: 'healthy-working' }],
      coordinatedStall: null,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(SessionHealthPanel));
    });
    await flush();

    expect(container.textContent).toContain('Session health is unavailable.');
  });
});
