import type { LaunchDependency } from '../shared/contracts/playbook.js';
import type { LaunchDependencyState, TaskLaunchAdmissionDependency } from '../shared/contracts/task.js';

export interface LaunchDependencyCircuitSnapshot {
  dependency: string;
  state: LaunchDependencyState;
  lastChangedAt: number;
  reason?: string;
}

export interface LaunchDependencyProbe {
  token: string;
  dependencies: string[];
}

export type LaunchDependencyAdmissionDecision =
  | {
      admit: true;
      probe?: LaunchDependencyProbe;
    }
  | {
      admit: false;
      reason: 'dependency_degraded' | 'half_open_probe_busy';
      dependencies: TaskLaunchAdmissionDependency[];
    };

interface CircuitEntry {
  state: LaunchDependencyState;
  lastChangedAt: number;
  reason?: string;
  probeToken?: string;
}

/**
 * Per-dependency admission state for launches that explicitly require an
 * external service.
 *
 * The circuit only treats a non-`unknown` preflight failure as confirmation of
 * degradation. A timeout or collection failure is retained as `unknown` and
 * is fail-open only when no confirmed degraded/half-open state already exists:
 * missing health data cannot erase stronger evidence or bypass a live probe.
 * A clean preflight after degradation is recovery evidence, but it first moves
 * the dependency to `half_open`; one bounded probe must launch successfully
 * before the dependency is considered healthy again.
 */
export class LaunchDependencyAdmission {
  private readonly entries = new Map<string, CircuitEntry>();
  private probeSequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Fold one dependency-preflight result into the circuit. Dependencies with
   * no finding are healthy evidence; a finding with category `unknown` stays
   * distinguishable from a confirmed degraded dependency.
   */
  observe(
    dependencies: readonly LaunchDependency[] | undefined,
    findings: readonly { dependency: string; category: string; summary?: string }[],
  ): void {
    for (const dependency of uniqueDependencies(dependencies)) {
      const relevant = findings.filter((finding) => finding.dependency === dependency);
      const entry = this.entry(dependency);
      if (relevant.length === 0) {
        if (entry.state === 'degraded') {
          this.transition(entry, 'half_open');
        } else if (entry.state !== 'half_open') {
          this.transition(entry, 'healthy');
        }
        entry.reason = undefined;
        continue;
      }

      const confirmed = relevant.find((finding) => finding.category !== 'unknown');
      if (confirmed) {
        entry.reason = confirmed.summary;
        this.transition(entry, 'degraded');
      } else {
        entry.reason = relevant[0]?.summary;
        // A concurrent health collection must not erase the claim held by an
        // in-flight half-open probe. Clearing that token would let a second
        // launch bypass the single-probe gate while the first provider launch
        // is still running. Keep the circuit half-open until the probe settles.
        if (entry.state === 'healthy' || entry.state === 'unknown') {
          this.transition(entry, 'unknown');
        }
      }
    }
  }

  /** Decide whether a launch may consume a worker slot. */
  evaluate(dependencies: readonly LaunchDependency[] | undefined): LaunchDependencyAdmissionDecision {
    const states = uniqueDependencies(dependencies).map((dependency) => this.snapshotEntry(dependency));
    const degraded = states.filter((snapshot) => snapshot.state === 'degraded');
    if (degraded.length > 0) {
      return {
        admit: false,
        reason: 'dependency_degraded',
        dependencies: degraded.map(toAdmissionDependency),
      };
    }

    const halfOpen = states.filter((snapshot) => snapshot.state === 'half_open');
    const busy = halfOpen.filter((snapshot) => this.entries.get(snapshot.dependency)?.probeToken !== undefined);
    if (busy.length > 0) {
      return {
        admit: false,
        reason: 'half_open_probe_busy',
        dependencies: busy.map((snapshot) => ({
          ...toAdmissionDependency(snapshot),
          reason: 'A recovery probe is already in flight',
        })),
      };
    }

    if (halfOpen.length === 0) return { admit: true };

    const token = `launch-dependency-probe-${++this.probeSequence}`;
    for (const snapshot of halfOpen) {
      this.entries.get(snapshot.dependency)!.probeToken = token;
    }
    return {
      admit: true,
      probe: { token, dependencies: halfOpen.map((snapshot) => snapshot.dependency) },
    };
  }

  /** Complete a half-open probe and close or re-open its dependency circuit. */
  completeProbe(probe: LaunchDependencyProbe | undefined, healthy: boolean): void {
    if (!probe) return;
    for (const dependency of probe.dependencies) {
      const entry = this.entries.get(dependency);
      if (!entry || entry.probeToken !== probe.token) continue;
      entry.probeToken = undefined;
      entry.reason = healthy ? undefined : 'Recovery probe failed';
      this.transition(entry, healthy ? 'healthy' : 'degraded');
    }
  }

  /** True only while this exact probe still owns every dependency token. */
  isProbeActive(probe: LaunchDependencyProbe | undefined): boolean {
    if (!probe || probe.dependencies.length === 0) return false;
    return probe.dependencies.every((dependency) => {
      const entry = this.entries.get(dependency);
      return entry?.state === 'half_open' && entry.probeToken === probe.token;
    });
  }

  /** Release a claimed probe when the task was queued or rejected pre-launch. */
  releaseProbe(probe: LaunchDependencyProbe | undefined): void {
    if (!probe) return;
    for (const dependency of probe.dependencies) {
      const entry = this.entries.get(dependency);
      if (entry?.probeToken === probe.token) entry.probeToken = undefined;
    }
  }

  /**
   * Restore the degraded side of a persisted parked launch after a process
   * restart. The next clean preflight must pass through half-open and claim
   * one bounded recovery probe instead of treating the fresh in-memory
   * circuit as healthy.
   */
  restoreParked(dependencies: readonly TaskLaunchAdmissionDependency[]): void {
    for (const dependency of dependencies) {
      const entry = this.entry(dependency.dependency);
      entry.state = 'degraded';
      entry.lastChangedAt = this.now();
      entry.reason = dependency.reason ?? 'Dependency was parked before restart';
      entry.probeToken = undefined;
    }
  }

  /**
   * Restore an interrupted probe as busy while startup reaps its expected
   * terminal. Clean concurrent evidence must not admit a replacement probe
   * until that physical worker has been proven absent.
   */
  restoreInterruptedProbe(
    dependencies: readonly TaskLaunchAdmissionDependency[],
    ownerToken: string,
  ): void {
    for (const dependency of dependencies) {
      const entry = this.entry(dependency.dependency);
      entry.state = 'half_open';
      entry.lastChangedAt = this.now();
      entry.reason = 'Interrupted recovery probe cleanup is in progress';
      entry.probeToken = `startup-recovery:${ownerToken}`;
    }
  }

  /**
   * Restore success evidence for a recovery probe whose attached session was
   * reconciled as live after restart. Call this after replaying parked task
   * markers. A confirmed degradation at or after the probe began supersedes
   * that old probe, matching the runtime token rule that ignores stale success;
   * probe-busy waiters carry no confirmed timestamp and cannot override it.
   */
  restoreSuccessfulProbe(
    dependencies: readonly string[],
    probeStartedAt: number,
    latestConfirmedAtByDependency: ReadonlyMap<string, number>,
  ): void {
    for (const dependency of new Set(dependencies)) {
      const latestConfirmedAt = latestConfirmedAtByDependency.get(dependency);
      if (latestConfirmedAt !== undefined && latestConfirmedAt >= probeStartedAt) continue;
      const entry = this.entry(dependency);
      entry.state = 'healthy';
      entry.lastChangedAt = this.now();
      entry.reason = undefined;
      entry.probeToken = undefined;
    }
  }

  snapshot(): LaunchDependencyCircuitSnapshot[] {
    return Array.from(this.entries.keys())
      .sort()
      .map((dependency) => this.snapshotEntry(dependency));
  }

  private entry(dependency: string): CircuitEntry {
    const existing = this.entries.get(dependency);
    if (existing) return existing;
    const created: CircuitEntry = { state: 'healthy', lastChangedAt: this.now() };
    this.entries.set(dependency, created);
    return created;
  }

  private snapshotEntry(dependency: string): LaunchDependencyCircuitSnapshot {
    const entry = this.entry(dependency);
    return {
      dependency,
      state: entry.state,
      lastChangedAt: entry.lastChangedAt,
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
  }

  private transition(entry: CircuitEntry, state: LaunchDependencyState): void {
    if (entry.state === state) return;
    entry.state = state;
    entry.lastChangedAt = this.now();
    if (state !== 'half_open') entry.probeToken = undefined;
  }
}

function uniqueDependencies(dependencies: readonly LaunchDependency[] | undefined): string[] {
  return [...new Set(dependencies ?? [])];
}

function toAdmissionDependency(snapshot: LaunchDependencyCircuitSnapshot): TaskLaunchAdmissionDependency {
  return {
    dependency: snapshot.dependency,
    state: snapshot.state,
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
  };
}
