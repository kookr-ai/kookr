import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHealthService } from './session-health-service.js';
import { SessionHealthTracker } from '../core/session-health.js';

describe('SessionHealthService', () => {
  test('TS-HEALTH-006 builds diagnostics from task, watchdog, transcript, backend, and bridge signals without exposing paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-health-service-'));
    try {
      const transcriptPath = join(dir, 'private-transcript.jsonl');
      writeFileSync(transcriptPath, '{"type":"assistant"}\n', { mode: 0o600 });
      utimesSync(transcriptPath, 95, 95);

      const browser = new SessionHealthTracker();
      browser.recordBridgeOpened('session-1', 96_000);
      browser.recordBridgeReplay('session-1', 96_001);
      browser.recordBridgeLiveBytes('session-1', 96_002);

      const service = new SessionHealthService({
        now: () => 100_000,
        restartEpoch: 90_000,
        listSessions: () => [{
          sessionId: 'session-1',
          taskStatus: 'inProgress',
          turnState: 'running',
          transcriptPath,
        }],
        getWatchdogState: () => ({ lastEventAt: 95_000 }),
        getBackendDiagnostics: () => ({
          sessionId: 'session-1',
          socketPresent: true,
          identityVerified: true,
          masterPid: 101,
          agentPid: 202,
          attachChildAlive: true,
          recoveryInProgress: false,
          attachGeneration: 4,
          reattachCount: 2,
          ringHead: 44,
          lastByteAt: 95_000,
          lastAttachAt: 94_000,
        }),
        browser,
      });

      const diagnostics = service.getDiagnostics();

      expect(diagnostics.schemaVersion).toBe('session-health.v1');
      expect(diagnostics.sessions).toHaveLength(1);
      expect(diagnostics.sessions[0]).toMatchObject({
        sessionId: 'session-1',
        classification: 'healthy-working',
        backend: { transportState: 'verified', attachState: 'alive', attachGeneration: 4, reattachCount: 2 },
        browser: { freshBytesAfterReplay: true, replayedOnly: false },
      });
      expect(service.getSessionHealth('session-1', 'blocked')?.classification).toBe('provider-or-agent-stalled');
      const serialized = JSON.stringify(diagnostics);
      expect(serialized).not.toContain('private-transcript.jsonl');
      expect(serialized).not.toContain('masterPid');
      expect(serialized).not.toContain('agentPid');
      expect(serialized).not.toContain('identityVerified');
      expect(serialized).not.toContain('attachChildAlive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('projects one coordinated root finding onto each participating session', () => {
    const browser = new SessionHealthTracker();
    const sessions = [
      { sessionId: 'attach-1', taskStatus: 'inProgress' as const, turnState: 'running' as const },
      { sessionId: 'attach-2', taskStatus: 'inProgress' as const, turnState: 'running' as const },
      { sessionId: 'idle', taskStatus: 'inProgress' as const, turnState: 'completed_turn' as const },
    ];
    const lastByteAt: Record<string, number> = { 'attach-1': 10_000, 'attach-2': 12_000, idle: 1_000 };
    const service = new SessionHealthService({
      now: () => 100_000,
      restartEpoch: 90_000,
      listSessions: () => sessions,
      getWatchdogState: (sessionId) => ({ lastEventAt: sessionId === 'idle' ? 1_000 : 99_000 }),
      getBackendDiagnostics: (sessionId) => ({
        sessionId,
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: true,
        recoveryInProgress: false,
        attachGeneration: 1,
        reattachCount: 0,
        ringHead: 1,
        lastByteAt: lastByteAt[sessionId] ?? null,
        lastAttachAt: 94_000,
      }),
      browser,
    });

    const diagnostics = service.getDiagnostics();

    expect(diagnostics.coordinatedStall).toMatchObject({
      rootCause: 'coordinated-terminal-path-stall',
      sessionIds: ['attach-1', 'attach-2'],
      postRestart: false,
    });
    expect(diagnostics.sessions.find((session) => session.sessionId === 'attach-1')?.coordinatedStall).toEqual(
      diagnostics.coordinatedStall,
    );
    expect(diagnostics.sessions.find((session) => session.sessionId === 'idle')?.coordinatedStall).toBeUndefined();
    expect(service.getSessionHealth('attach-1', 'running')?.coordinatedStall).toEqual(diagnostics.coordinatedStall);
  });
});
