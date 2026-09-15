import { describe, expect, it } from 'vitest';
import type { TaskLaunchAdmission } from '../shared/contracts/task.js';
import type { SessionInfo } from './session-read-model.js';
import type { Task } from './task-read-model.js';
import {
  isNoSlotDependencyAdmission,
  isSameTaskLaunchAdmission,
  probeFromAdmissionDecision,
  taskAdmissionForDeniedDecision,
  taskAdmissionForFailedProbe,
  taskAdmissionForProbe,
  taskAdmissionForProbeCapacityWait,
  taskOwnsLiveProbeSession,
} from './launch-dependency-task-admission.js';

const AT = '2026-09-15T12:00:00.000Z';
const LATER = '2026-09-15T12:01:00.000Z';
const SESSION_ID = 'kookr-probe-session-1';

const degradedDependency = {
  dependency: 'kb',
  state: 'degraded' as const,
  reason: 'KB provider is unavailable',
};

const deniedDegraded = {
  admit: false as const,
  reason: 'dependency_degraded' as const,
  dependencies: [degradedDependency],
};

const deniedBusy = {
  admit: false as const,
  reason: 'half_open_probe_busy' as const,
  dependencies: [{
    dependency: 'kb',
    state: 'half_open' as const,
    reason: 'A recovery probe is already in flight',
  }],
};

const admittedProbe = {
  admit: true as const,
  probe: { token: 'launch-dependency-probe-1', dependencies: ['kb'] },
};

const admittedMultiProbe = {
  admit: true as const,
  probe: { token: 'launch-dependency-probe-2', dependencies: ['kb', 'other'] },
};

const admittedWithoutProbe = { admit: true as const };

const parkedDegraded: TaskLaunchAdmission = {
  status: 'parked',
  reason: 'dependency_degraded',
  dependencies: [degradedDependency],
  parkedAt: AT,
};

const parkedBusy: TaskLaunchAdmission = {
  status: 'parked',
  reason: 'half_open_probe_busy',
  dependencies: deniedBusy.dependencies,
  parkedAt: AT,
};

const parkedCapacityWait: TaskLaunchAdmission = {
  status: 'parked',
  reason: 'half_open_waiting_for_capacity',
  dependencies: [{
    dependency: 'kb',
    state: 'half_open',
    reason: 'Recovery probe waits for an available worker slot',
  }],
  parkedAt: AT,
};

const probingWithSession: TaskLaunchAdmission = {
  status: 'probing',
  reason: 'half_open_probe_in_flight',
  dependencies: [{
    dependency: 'kb',
    state: 'half_open',
    reason: 'Bounded recovery probe is in flight',
  }],
  startedAt: AT,
  sessionId: SESSION_ID,
};

const probingWithoutSession: TaskLaunchAdmission = {
  status: 'probing',
  reason: 'half_open_probe_in_flight',
  dependencies: probingWithSession.dependencies,
  startedAt: AT,
};

function session(overrides: Partial<SessionInfo> & Pick<SessionInfo, 'tmuxSession'>): SessionInfo {
  return {
    agentType: 'claude',
    cwd: '/tmp',
    createdAt: new Date(AT),
    ...overrides,
  };
}

type ProbeOwner = Pick<Task, 'status' | 'launchAdmission' | 'sessions'>;

describe('taskAdmissionForDeniedDecision', () => {
  it.each([
    ['dependency_degraded', deniedDegraded],
    ['half_open_probe_busy', deniedBusy],
  ] as const)('parks a %s denial with the decision reason and parkedAt', (_label, decision) => {
    expect(taskAdmissionForDeniedDecision(decision, AT)).toEqual({
      status: 'parked',
      reason: decision.reason,
      dependencies: decision.dependencies,
      parkedAt: AT,
    });
  });

  it('copies dependency objects so later mutation of the decision does not rewrite the marker', () => {
    const live = {
      admit: false as const,
      reason: 'dependency_degraded' as const,
      dependencies: [{ ...degradedDependency }],
    };
    const marker = taskAdmissionForDeniedDecision(live, AT);
    live.dependencies[0]!.reason = 'mutated after mapping';
    expect(marker.dependencies[0]?.reason).toBe('KB provider is unavailable');
    expect(marker.dependencies[0]).not.toBe(live.dependencies[0]);
  });
});

describe('taskAdmissionForProbe', () => {
  it('maps an admitted probe to probing with half_open dependencies', () => {
    expect(taskAdmissionForProbe(admittedProbe, AT)).toEqual({
      status: 'probing',
      reason: 'half_open_probe_in_flight',
      dependencies: [{
        dependency: 'kb',
        state: 'half_open',
        reason: 'Bounded recovery probe is in flight',
      }],
      startedAt: AT,
    });
  });

  it('maps every claimed probe dependency, not only the first', () => {
    expect(taskAdmissionForProbe(admittedMultiProbe, AT).dependencies).toEqual([
      {
        dependency: 'kb',
        state: 'half_open',
        reason: 'Bounded recovery probe is in flight',
      },
      {
        dependency: 'other',
        state: 'half_open',
        reason: 'Bounded recovery probe is in flight',
      },
    ]);
  });

  it('includes sessionId only when a non-empty session id is provided', () => {
    expect(taskAdmissionForProbe(admittedProbe, AT, SESSION_ID)).toEqual({
      ...taskAdmissionForProbe(admittedProbe, AT),
      sessionId: SESSION_ID,
    });
    expect(taskAdmissionForProbe(admittedProbe, AT, '')).not.toHaveProperty('sessionId');
    expect(taskAdmissionForProbe(admittedProbe, AT)).not.toHaveProperty('sessionId');
  });

  it('throws when the admitted decision has no claimed probe', () => {
    expect(() => taskAdmissionForProbe(admittedWithoutProbe, AT)).toThrow(
      'Cannot create probe admission state without a claimed probe',
    );
  });
});

describe('taskAdmissionForFailedProbe', () => {
  it('parks a failed probe as dependency_degraded with degraded dependencies', () => {
    expect(taskAdmissionForFailedProbe(admittedProbe, AT)).toEqual({
      status: 'parked',
      reason: 'dependency_degraded',
      dependencies: [{
        dependency: 'kb',
        state: 'degraded',
        reason: 'Recovery probe failed',
      }],
      parkedAt: AT,
    });
  });

  it('maps every claimed probe dependency as degraded, not only the first', () => {
    expect(taskAdmissionForFailedProbe(admittedMultiProbe, AT).dependencies).toEqual([
      {
        dependency: 'kb',
        state: 'degraded',
        reason: 'Recovery probe failed',
      },
      {
        dependency: 'other',
        state: 'degraded',
        reason: 'Recovery probe failed',
      },
    ]);
  });

  it('throws when the admitted decision has no claimed probe', () => {
    expect(() => taskAdmissionForFailedProbe(admittedWithoutProbe, AT)).toThrow(
      'Cannot create probe admission state without a claimed probe',
    );
  });
});

describe('taskAdmissionForProbeCapacityWait', () => {
  it('parks an admitted probe as half_open_waiting_for_capacity', () => {
    expect(taskAdmissionForProbeCapacityWait(admittedProbe, AT)).toEqual({
      status: 'parked',
      reason: 'half_open_waiting_for_capacity',
      dependencies: [{
        dependency: 'kb',
        state: 'half_open',
        reason: 'Recovery probe waits for an available worker slot',
      }],
      parkedAt: AT,
    });
  });

  it('maps every claimed probe dependency while waiting for capacity', () => {
    expect(taskAdmissionForProbeCapacityWait(admittedMultiProbe, AT)?.dependencies).toEqual([
      {
        dependency: 'kb',
        state: 'half_open',
        reason: 'Recovery probe waits for an available worker slot',
      },
      {
        dependency: 'other',
        state: 'half_open',
        reason: 'Recovery probe waits for an available worker slot',
      },
    ]);
  });

  it('returns undefined when the admitted decision has no probe', () => {
    expect(taskAdmissionForProbeCapacityWait(admittedWithoutProbe, AT)).toBeUndefined();
  });
});

describe('isNoSlotDependencyAdmission', () => {
  // Current predicate: parked, but not waiting for a worker slot.
  // Capacity-wait is parked yet still eligible for a slot; do not rename here.
  it.each([
    { label: 'parked dependency_degraded → true', admission: parkedDegraded, expected: true },
    { label: 'parked half_open_probe_busy → true', admission: parkedBusy, expected: true },
    { label: 'parked half_open_waiting_for_capacity → false', admission: parkedCapacityWait, expected: false },
    { label: 'probing with session → false', admission: probingWithSession, expected: false },
    { label: 'probing without session → false', admission: probingWithoutSession, expected: false },
    { label: 'undefined admission → false', admission: undefined, expected: false },
  ])('$label', ({ admission, expected }) => {
    expect(isNoSlotDependencyAdmission(admission)).toBe(expected);
  });
});

describe('probeFromAdmissionDecision', () => {
  it.each([
    ['admitted with probe', admittedProbe, admittedProbe.probe],
    ['admitted without probe', admittedWithoutProbe, undefined],
    ['denied degraded', deniedDegraded, undefined],
    ['undefined decision', undefined, undefined],
  ] as const)('%s returns the claimed probe or undefined', (_label, decision, expected) => {
    expect(probeFromAdmissionDecision(decision)).toEqual(expected);
  });
});

describe('isSameTaskLaunchAdmission', () => {
  it('treats matching undefined markers as the same identity', () => {
    expect(isSameTaskLaunchAdmission(undefined, undefined)).toBe(true);
  });

  it.each([
    ['current missing', undefined, parkedDegraded],
    ['expected missing', parkedDegraded, undefined],
  ] as const)('is false when %s', (_label, current, expected) => {
    expect(isSameTaskLaunchAdmission(current, expected)).toBe(false);
  });

  it('compares probing identity on sessionId and startedAt only', () => {
    const sameIdentityDifferentPayload: TaskLaunchAdmission = {
      ...probingWithSession,
      dependencies: [{ dependency: 'other', state: 'half_open', reason: 'unrelated' }],
    };
    expect(isSameTaskLaunchAdmission(probingWithSession, sameIdentityDifferentPayload)).toBe(true);
    expect(isSameTaskLaunchAdmission(probingWithSession, {
      ...probingWithSession,
      sessionId: 'other-session',
    })).toBe(false);
    expect(isSameTaskLaunchAdmission(probingWithSession, {
      ...probingWithSession,
      startedAt: LATER,
    })).toBe(false);
    expect(isSameTaskLaunchAdmission(probingWithoutSession, {
      ...probingWithoutSession,
      startedAt: AT,
    })).toBe(true);
    expect(isSameTaskLaunchAdmission(probingWithoutSession, probingWithSession)).toBe(false);
  });

  it('compares parked identity on reason and parkedAt only', () => {
    const sameIdentityDifferentPayload: TaskLaunchAdmission = {
      ...parkedDegraded,
      dependencies: [{ dependency: 'other', state: 'degraded', reason: 'unrelated' }],
    };
    expect(isSameTaskLaunchAdmission(parkedDegraded, sameIdentityDifferentPayload)).toBe(true);
    expect(isSameTaskLaunchAdmission(parkedDegraded, {
      ...parkedDegraded,
      parkedAt: LATER,
    })).toBe(false);
    expect(isSameTaskLaunchAdmission(parkedDegraded, parkedBusy)).toBe(false);
    expect(isSameTaskLaunchAdmission(parkedDegraded, parkedCapacityWait)).toBe(false);
  });

  it('is false across parked vs probing even when timestamps match', () => {
    expect(isSameTaskLaunchAdmission(parkedDegraded, probingWithSession)).toBe(false);
    expect(isSameTaskLaunchAdmission(probingWithSession, parkedDegraded)).toBe(false);
  });
});

describe('taskOwnsLiveProbeSession', () => {
  const liveTask: ProbeOwner = {
    status: 'inProgress',
    launchAdmission: probingWithSession,
    sessions: [session({ tmuxSession: SESSION_ID, lastStatus: 'running' })],
  };

  it('is true only when a non-terminal task still owns the matching live probe session', () => {
    expect(taskOwnsLiveProbeSession(liveTask, probingWithSession)).toBe(true);
  });

  it.each([
    ['undefined task', undefined],
    ['completed', { ...liveTask, status: 'completed' as const }],
    ['terminated', { ...liveTask, status: 'terminated' as const }],
    ['cancelled', { ...liveTask, status: 'cancelled' as const }],
  ] as const)('is false for %s', (_label, subject) => {
    expect(taskOwnsLiveProbeSession(subject, probingWithSession)).toBe(false);
  });

  it.each(['open', 'pending', 'inProgress'] as const)(
    'can be true on active status %s when the live session id matches',
    (status) => {
      expect(taskOwnsLiveProbeSession({ ...liveTask, status }, probingWithSession)).toBe(true);
    },
  );

  it('is false when the persisted admission identity drifted after an await', () => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      launchAdmission: { ...probingWithSession, startedAt: LATER },
    }, probingWithSession)).toBe(false);
  });

  it('is false when expected is parked, probing without sessionId, or missing', () => {
    expect(taskOwnsLiveProbeSession(liveTask, parkedDegraded)).toBe(false);
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      launchAdmission: probingWithoutSession,
    }, probingWithoutSession)).toBe(false);
    expect(taskOwnsLiveProbeSession(liveTask, undefined)).toBe(false);
  });

  it.each([
    ['different session id', session({ tmuxSession: 'other-session', lastStatus: 'running' })],
    ['completed session', session({ tmuxSession: SESSION_ID, lastStatus: 'completed' })],
    ['aborted session', session({ tmuxSession: SESSION_ID, lastStatus: 'aborted' })],
  ] as const)('is false for %s', (_label, probeSession) => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      sessions: [probeSession],
    }, probingWithSession)).toBe(false);
  });

  it.each([
    ['starting', 'starting' as const],
    ['running', 'running' as const],
    ['stuck', 'stuck' as const],
    ['errored', 'errored' as const],
    ['snoozed', 'snoozed' as const],
    ['unset lastStatus', undefined],
  ] as const)('treats %s as a live probe session', (_label, lastStatus) => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      sessions: [session({ tmuxSession: SESSION_ID, lastStatus })],
    }, probingWithSession)).toBe(true);
  });

  it('is true when a prior aborted sibling exists alongside the matching live probe', () => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      sessions: [
        session({ tmuxSession: 'predecessor', lastStatus: 'aborted' }),
        session({ tmuxSession: SESSION_ID, lastStatus: 'running' }),
      ],
    }, probingWithSession)).toBe(true);
  });

  it('is false when the matching session is completed even if another session is live', () => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      sessions: [
        session({ tmuxSession: SESSION_ID, lastStatus: 'completed' }),
        session({ tmuxSession: 'other-session', lastStatus: 'running' }),
      ],
    }, probingWithSession)).toBe(false);
  });

  it('is false when the task has no sessions yet', () => {
    expect(taskOwnsLiveProbeSession({
      ...liveTask,
      sessions: [],
    }, probingWithSession)).toBe(false);
  });
});

