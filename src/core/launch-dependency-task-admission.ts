import type {
  LaunchDependencyAdmissionDecision,
  LaunchDependencyProbe,
} from './launch-dependency-admission.js';
import type { TaskLaunchAdmission } from '../shared/contracts/task.js';

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

function requireProbe(decision: AdmittedDecision): LaunchDependencyProbe {
  if (!decision.probe) throw new Error('Cannot create probe admission state without a claimed probe');
  return decision.probe;
}
