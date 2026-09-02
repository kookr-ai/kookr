import { describe, expect, test } from 'vitest';
import {
  classifySessionHealth,
  detectCoordinatedStall,
} from './session-health.js';
import type { SessionHealthInput } from './session-health.js';

const NOW = 100_000;
const RESTART_EPOCH = 90_000;

function input(overrides: Partial<SessionHealthInput> = {}): SessionHealthInput {
  return {
    sessionId: 'session-1',
    now: NOW,
    restartEpoch: RESTART_EPOCH,
    taskStatus: 'inProgress',
    turnState: 'running',
    pty: { ringHead: 42, lastByteAt: 95_000 },
    hooks: { lastEventAt: 95_000 },
    transcript: { present: true, lastRecordAt: 95_000 },
    backend: {
      socketPresent: true,
      identityVerified: true,
      masterPid: 101,
      agentPid: 202,
      attachChildAlive: true,
      attachGeneration: 3,
      reattachCount: 1,
      lastAttachAt: 94_000,
    },
    browser: {
      bridgeOpen: false,
      lastOpenAt: null,
      lastReplayAt: null,
      lastLiveByteAt: null,
    },
    ...overrides,
  };
}

describe('session health classification', () => {
  test('TS-HEALTH-001 classifies fresh independent progress as healthy-working', () => {
    const health = classifySessionHealth(input());

    expect(health.classification).toBe('healthy-working');
    expect(health.signals.pty).toMatchObject({ state: 'fresh', lastProgressAt: new Date(95_000).toISOString() });
    expect(health.signals.hooks.state).toBe('fresh');
    expect(health.signals.transcript.state).toBe('fresh');
    expect(health.backend.attachGeneration).toBe(3);
    expect(health.restartEpoch).toBe(new Date(RESTART_EPOCH).toISOString());
  });

  test('TS-HEALTH-002 keeps completed turns healthy-idle despite terminal silence', () => {
    const health = classifySessionHealth(input({
      turnState: 'completed_turn',
      pty: { ringHead: 42, lastByteAt: 10_000 },
      hooks: { lastEventAt: 10_000 },
      transcript: { present: true, lastRecordAt: 10_000 },
    }));

    expect(health.classification).toBe('healthy-idle');
    expect(health.evidence.join(' ')).toContain('completed_turn');
  });

  test('TS-HEALTH-003 distinguishes a live socket with frozen PTY progress from a lost session', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 42, lastByteAt: 10_000 },
      hooks: { lastEventAt: 95_000 },
      transcript: { present: true, lastRecordAt: 95_000 },
    }));

    expect(health.classification).toBe('terminal-attach-stalled');
    expect(health.backend.transportState).toBe('verified');
    expect(health.backend.attachState).toBe('alive');
  });

  test('does not treat a persisted pre-restart ring timestamp as fresh PTY progress', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 42, lastByteAt: 80_000 },
      hooks: { lastEventAt: 95_000 },
      transcript: { present: true, lastRecordAt: 95_000 },
    }));

    expect(health.signals.pty.state).toBe('unknown');
    expect(health.classification).toBe('terminal-attach-stalled');
    expect(health.evidence.join(' ')).toContain('predates');
  });

  test('TS-HEALTH-004 distinguishes a dead dtach socket as session-lost', () => {
    const health = classifySessionHealth(input({
      backend: {
        socketPresent: false,
        identityVerified: false,
        masterPid: null,
        agentPid: null,
        attachChildAlive: false,
        attachGeneration: 3,
        reattachCount: 2,
        lastAttachAt: 94_000,
      },
    }));

    expect(health.classification).toBe('session-lost');
    expect(health.evidence.join(' ')).toContain('socket');
  });

  test('does not hide a dead transport behind a completed-turn label', () => {
    const health = classifySessionHealth(input({
      turnState: 'completed_turn',
      backend: {
        socketPresent: false,
        identityVerified: false,
        masterPid: null,
        agentPid: null,
        attachChildAlive: false,
        attachGeneration: 3,
        reattachCount: 2,
        lastAttachAt: 94_000,
      },
    }));

    expect(health.classification).toBe('session-lost');
  });

  test('does not hide a dead attach child behind a completed-turn label', () => {
    const health = classifySessionHealth(input({
      turnState: 'completed_turn',
      backend: {
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: false,
        attachGeneration: 3,
        reattachCount: 2,
        lastAttachAt: 94_000,
      },
    }));

    expect(health.classification).toBe('terminal-attach-stalled');
  });

  test('uses health-unknown when live backend state is unavailable', () => {
    const health = classifySessionHealth(input({
      turnState: undefined,
      backend: {
        socketPresent: null,
        identityVerified: null,
        masterPid: null,
        agentPid: null,
        attachChildAlive: null,
        attachGeneration: 0,
        reattachCount: 0,
        lastAttachAt: null,
      },
      pty: { ringHead: 0, lastByteAt: null },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
    }));

    expect(health.classification).toBe('health-unknown');
    expect(health.signals.pty.state).toBe('missing');
  });

  test('does not call a fully silent live session provider-stalled without provider evidence', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 0, lastByteAt: null },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
    }));

    expect(health.classification).toBe('health-unknown');
  });

  test('does not call an idle session healthy when every independent signal is unavailable', () => {
    const health = classifySessionHealth(input({
      taskStatus: 'completed',
      turnState: 'completed_turn',
      pty: { ringHead: 0, lastByteAt: null },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
      backend: {
        socketPresent: null,
        identityVerified: null,
        masterPid: null,
        agentPid: null,
        attachChildAlive: null,
        attachGeneration: 0,
        reattachCount: 0,
        lastAttachAt: null,
      },
    }));

    expect(health.classification).toBe('health-unknown');
  });

  test('classifies active transport repair separately from a lost session', () => {
    const health = classifySessionHealth(input({
      backend: {
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: false,
        recoveryInProgress: true,
        attachGeneration: 4,
        reattachCount: 2,
        lastAttachAt: 99_000,
      },
    }));

    expect(health.classification).toBe('recovery-in-progress');
    expect(health.backend.recoveryInProgress).toBe(true);
  });

  test('classifies a live socket with a dead attach child as terminal-attach-stalled', () => {
    const health = classifySessionHealth(input({
      backend: {
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: false,
        recoveryInProgress: false,
        attachGeneration: 4,
        reattachCount: 2,
        lastAttachAt: 99_000,
      },
      pty: { ringHead: 42, lastByteAt: 10_000 },
      hooks: { lastEventAt: 95_000 },
      transcript: { present: true, lastRecordAt: 95_000 },
    }));

    expect(health.classification).toBe('terminal-attach-stalled');
    expect(health.evidence.join(' ')).toContain('attach child');
  });

  test('classifies provider silence separately when the transport is live', () => {
    const health = classifySessionHealth(input({
      restartEpoch: 0,
      pty: { ringHead: 42, lastByteAt: 10_000 },
      hooks: { lastEventAt: 10_000 },
      transcript: { present: true, lastRecordAt: 10_000 },
    }));

    expect(health.classification).toBe('provider-or-agent-stalled');
  });

  test('does not treat replayed ring data as fresh browser liveness', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 99, lastByteAt: 99_000 },
      hooks: { lastEventAt: 99_000 },
      transcript: { present: true, lastRecordAt: 99_000 },
      browser: {
        bridgeOpen: true,
        lastOpenAt: 80_000,
        lastReplayAt: 80_000,
        lastLiveByteAt: null,
      },
    }));

    expect(health.browser.replayedOnly).toBe(true);
    expect(health.browser.freshBytesAfterReplay).toBe(false);
    expect(health.classification).toBe('browser-bridge-stalled');
  });

  test('classifies an open browser bridge as browser-bridge-stalled when PTY is fresh', () => {
    const health = classifySessionHealth(input({
      browser: {
        bridgeOpen: true,
        lastOpenAt: 80_000,
        lastReplayAt: 80_001,
        lastLiveByteAt: 80_002,
      },
    }));

    expect(health.classification).toBe('browser-bridge-stalled');
    expect(health.browser.freshBytesAfterReplay).toBe(true);
  });
});

describe('health-unknown reason codes and next-check hints (issue #2793)', () => {
  test('TS-HEALTH-009 attaches no-independent-signals + reattach when nothing is observed', () => {
    const health = classifySessionHealth(input({
      turnState: undefined,
      backend: {
        socketPresent: null,
        identityVerified: null,
        masterPid: null,
        agentPid: null,
        attachChildAlive: null,
        attachGeneration: 0,
        reattachCount: 0,
        lastAttachAt: null,
      },
      pty: { ringHead: 0, lastByteAt: null },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
    }));

    expect(health.classification).toBe('health-unknown');
    expect(health.unknownDetail).toEqual({
      reason: 'no-independent-signals',
      nextCheck: 'reattach',
      signalAgesMs: { pty: null, hooks: null, transcript: null },
    });
  });

  test('attaches backend-attach-unavailable + reattach when only attach health is unknown', () => {
    const health = classifySessionHealth(input({
      backend: {
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: null,
        attachGeneration: 3,
        reattachCount: 1,
        lastAttachAt: 94_000,
      },
    }));

    expect(health.classification).toBe('health-unknown');
    expect(health.unknownDetail?.reason).toBe('backend-attach-unavailable');
    expect(health.unknownDetail?.nextCheck).toBe('reattach');
    // Independent signals are still fresh (age 5_000ms) even though attach is unknown.
    expect(health.unknownDetail?.signalAgesMs).toEqual({ pty: 5_000, hooks: 5_000, transcript: 5_000 });
  });

  test('attaches turn-state-unknown + wait when transport is verified but the turn is unknown', () => {
    const health = classifySessionHealth(input({ turnState: 'unknown' }));

    expect(health.classification).toBe('health-unknown');
    expect(health.unknownDetail?.reason).toBe('turn-state-unknown');
    expect(health.unknownDetail?.nextCheck).toBe('wait');
  });

  test('attaches provider-signals-unavailable + inspect-hooks when the hook/transcript pipeline is silent', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 0, lastByteAt: null },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
    }));

    expect(health.classification).toBe('health-unknown');
    expect(health.unknownDetail?.reason).toBe('provider-signals-unavailable');
    expect(health.unknownDetail?.nextCheck).toBe('inspect-hooks');
  });

  test('reports per-signal ages independently when only some signals are present', () => {
    const health = classifySessionHealth(input({
      pty: { ringHead: 7, lastByteAt: 95_000 },
      hooks: { lastEventAt: null },
      transcript: { present: false, lastRecordAt: null },
    }));

    expect(health.classification).toBe('health-unknown');
    expect(health.unknownDetail?.reason).toBe('provider-signals-unavailable');
    // pty advanced 5_000ms ago; hooks/transcript never reported.
    expect(health.unknownDetail?.signalAgesMs).toEqual({ pty: 5_000, hooks: null, transcript: null });
  });

  test('omits unknownDetail entirely for non-unknown classifications', () => {
    expect(classifySessionHealth(input()).unknownDetail).toBeUndefined();
    expect(classifySessionHealth(input({ turnState: 'completed_turn' })).unknownDetail).toBeUndefined();
  });
});

describe('coordinated session stalls', () => {
  test('TS-HEALTH-005 emits one root finding for independent stalls in a narrow window', () => {
    const sessions = [
      classifySessionHealth(input({ sessionId: 'session-1', restartEpoch: 0, pty: { ringHead: 1, lastByteAt: 10_000 }, hooks: { lastEventAt: 10_000 }, transcript: { present: true, lastRecordAt: 10_000 } })),
      classifySessionHealth(input({ sessionId: 'session-2', restartEpoch: 0, pty: { ringHead: 2, lastByteAt: 12_000 }, hooks: { lastEventAt: 12_000 }, transcript: { present: true, lastRecordAt: 12_000 } })),
      classifySessionHealth(input({ sessionId: 'idle', restartEpoch: 0, turnState: 'completed_turn', pty: { ringHead: 3, lastByteAt: 1_000 }, hooks: { lastEventAt: 1_000 }, transcript: { present: true, lastRecordAt: 1_000 } })),
    ].map((session) => ({ ...session, restartEpoch: new Date(RESTART_EPOCH).toISOString() }));

    const finding = detectCoordinatedStall(sessions);

    expect(finding).toMatchObject({
      sessionIds: ['session-1', 'session-2'],
      windowMs: 2_000,
      restartEpoch: new Date(RESTART_EPOCH).toISOString(),
      postRestart: false,
    });
    expect(finding?.rootCause).toBe('coordinated-provider-stall');
  });

  test('coordinates terminal-attach stalls using PTY progress even when hooks are fresh', () => {
    const sessions = [
      classifySessionHealth(input({
        sessionId: 'attach-1',
        pty: { ringHead: 1, lastByteAt: 10_000 },
        hooks: { lastEventAt: 99_000 },
        transcript: { present: true, lastRecordAt: 99_000 },
      })),
      classifySessionHealth(input({
        sessionId: 'attach-2',
        pty: { ringHead: 2, lastByteAt: 12_000 },
        hooks: { lastEventAt: 99_000 },
        transcript: { present: true, lastRecordAt: 99_000 },
      })),
    ];

    expect(sessions.every((session) => session.classification === 'terminal-attach-stalled')).toBe(true);
    expect(detectCoordinatedStall(sessions)).toMatchObject({
      sessionIds: ['attach-1', 'attach-2'],
      rootCause: 'coordinated-terminal-path-stall',
      windowMs: 2_000,
      postRestart: false,
    });
  });

  test('does not group one stalled session or an idle session', () => {
    const stalled = classifySessionHealth(input({
      pty: { ringHead: 1, lastByteAt: 10_000 },
      hooks: { lastEventAt: 10_000 },
      transcript: { present: true, lastRecordAt: 10_000 },
    }));

    expect(detectCoordinatedStall([stalled])).toBeNull();
    expect(detectCoordinatedStall([
      stalled,
      classifySessionHealth(input({ sessionId: 'idle', turnState: 'completed_turn' })),
    ])).toBeNull();
  });
});
