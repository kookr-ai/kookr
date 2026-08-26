import type {
  LaunchDependencyAdmissionDecision,
  LaunchDependencyProbe,
} from './launch-dependency-admission.js';
import type { TaskLaunchAdmission } from '../shared/contracts/task.js';
import type { Task } from './task-read-model.js';
import { isTerminalStatus } from './task-status.js';

type AdmittedDecision = Extract<LaunchDependencyAdmissionDecision, { admit: true }>;
type DeniedDecision = Extract<LaunchDependencyAdmissionDecision, { admit: false }>;

export function taskAdmissionForDeniedDecision(
  decision: DeniedDecision,
  at: string,
): TaskLaunchAdmission {
  return {
    status: 'parked',
    reason: decision.reason,
    dependencies: decision.dependencies.map((dependency) => ({ ...dependency })),
    // This is also the timestamp of the evidence that caused the current
    // denial. Refresh it on every recheck so restart reconciliation can order
    // a newer confirmed failure against an older live recovery probe.
    parkedAt: at,
  };
}

export function taskAdmissionForProbe(
  decision: AdmittedDecision,
  at: string,
  sessionId?: string,
): TaskLaunchAdmission {
  const probe = requireProbe(decision);
  return {
    status: 'probing',
    reason: 'half_open_probe_in_flight',
    dependencies: probe.dependencies.map((dependency) => ({
      dependency,
      state: 'half_open',
      reason: 'Bounded recovery probe is in flight',
    })),
    startedAt: at,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function taskAdmissionForFailedProbe(
  decision: AdmittedDecision,
  at: string,
): TaskLaunchAdmission {
  const probe = requireProbe(decision);
  return {
    status: 'parked',
    reason: 'dependency_degraded',
    dependencies: probe.dependencies.map((dependency) => ({
      dependency,
      state: 'degraded',
      reason: 'Recovery probe failed',
    })),
    parkedAt: at,
  };
}

export function taskAdmissionForProbeCapacityWait(
  decision: AdmittedDecision,
  at: string,
): TaskLaunchAdmission | undefined {
  if (!decision.probe) return undefined;
  return {
    status: 'parked',
    reason: 'half_open_waiting_for_capacity',
    dependencies: decision.probe.dependencies.map((dependency) => ({
      dependency,
      state: 'half_open',
      reason: 'Recovery probe waits for an available worker slot',
    })),
    parkedAt: at,
  };
}

export function isNoSlotDependencyAdmission(
  admission: TaskLaunchAdmission | undefined,
): admission is Extract<TaskLaunchAdmission, { status: 'parked' }> {
  return admission?.status === 'parked'
    && admission.reason !== 'half_open_waiting_for_capacity';
}

export function probeFromAdmissionDecision(
  decision: LaunchDependencyAdmissionDecision | undefined,
): LaunchDependencyProbe | undefined {
  return decision?.admit ? decision.probe : undefined;
}

/** Compare the durable identity fields of an admission marker. */
export function isSameTaskLaunchAdmission(
  current: TaskLaunchAdmission | undefined,
  expected: TaskLaunchAdmission | undefined,
): boolean {
  if (!current || !expected) return current === expected;
  if (current.status !== expected.status) return false;
  if (current.status === 'probing' && expected.status === 'probing') {
    return current.sessionId === expected.sessionId && current.startedAt === expected.startedAt;
  }
  if (current.status === 'parked' && expected.status === 'parked') {
    return current.reason === expected.reason && current.parkedAt === expected.parkedAt;
  }
  return false;
}

/**
 * True when the task still owns the exact live worker created by a successful
 * half-open probe. Callers re-check this after every persistence await before
 * clearing the durable marker or closing the circuit: a concurrent terminal
 * transition may have retained that marker as physical-cleanup ownership.
 */
export function taskOwnsLiveProbeSession(
  task: Pick<Task, 'status' | 'launchAdmission' | 'sessions'> | undefined,
  expected: TaskLaunchAdmission | undefined,
): boolean {
  if (!task || isTerminalStatus(task.status)) return false;
  if (!isSameTaskLaunchAdmission(task.launchAdmission, expected)) return false;
  if (expected?.status !== 'probing' || !expected.sessionId) return false;
  return task.sessions.some(
    (session) => session.tmuxSession === expected.sessionId
      && session.lastStatus !== 'completed'
      && session.lastStatus !== 'aborted',
  );
}

function requireProbe(decision: AdmittedDecision): LaunchDependencyProbe {
  if (!decision.probe) throw new Error('Cannot create probe admission state without a claimed probe');
  return decision.probe;
}
